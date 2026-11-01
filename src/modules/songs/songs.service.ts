import type { Redis } from "ioredis";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { keys } from "../../shared/keys.js";
import { PRIORITY_BASE, type Queues, type SingJobData } from "../../shared/queues.js";
import { songRequests, songsRequeued } from "../../shared/metrics.js";
import { isBlockedName } from "../names/blocklist.js";
import { normalizeName } from "../names/normalize.js";
import type { Catalog } from "../templates/catalog.js";
import { pickTemplate } from "../templates/picker.js";
import type { EtaEstimator } from "./eta.js";
import { nameKeyOf, songIdOf } from "./songs.ids.js";
import type { SongRepo } from "./songs.repo.js";
import type { CreateSongBody } from "./songs.schema.js";

const IDEMPOTENCY_TTL_S = 24 * 3600;
// A song claimed by a worker normally finishes in seconds; one still "processing"
// after this long lost its worker for good and is put back in line.
const STUCK_PROCESSING_MS = 10 * 60_000;

// What the app shows while waiting:
//   none:  song is ready (or failed), nothing to wait for
//   short: show "Composing your song..." while the intro plays; poll again soon
//   later: line is long; no countdown, "come back in a bit, it'll be here"
export type Wait = "none" | "short" | "later";

export interface SongView {
  songId: string;
  status: string;
  templateId: string;
  url?: string;
  wait: Wait;
  etaSeconds?: number;
  pollAfterSeconds?: number;
  // The app plays the template at once (same file for everyone, cached) and swaps
  // in the sung song before the music reaches nameAtMs.
  // durationMs + nameSpots let the app draw the song's shape (where the name is sung).
  intro?: { templateUrl: string; nameAtMs: number; durationMs: number; nameSpots: { startMs: number; endMs: number }[] };
  // The name as it is sung (cleaned up, e.g. "Priya"), and the song's style.
  name: string;
  genre?: string;
  // The line being sung with the user's name in it, in the song's own script
  // (e.g. "O Rahul, dil kahe tera naam"). The app shows it as the song's title.
  lyric?: string;
}

export class SongService {
  constructor(
    private readonly redis: Redis,
    private readonly catalog: Catalog,
    private readonly songs: SongRepo,
    private readonly queues: Queues,
    private readonly eta: EtaEstimator,
  ) {}

  async create(body: CreateSongBody, idempotencyKey?: string) {
    // A retried tap returns the original answer instead of creating new work.
    if (idempotencyKey) {
      const prior = await this.redis.get(keys.idempotency(idempotencyKey));
      if (prior) {
        const { songId } = JSON.parse(prior) as { songId: string };
        return { ...(await this.view(songId)), replayed: true };
      }
    }

    const langs = this.catalog.langs();
    if (!langs.includes(body.lang)) throw new AppError(400, "unsupported_language", `lang must be one of ${langs.join(", ")}`);
    const name = normalizeName(body.name);
    if (!name) throw new AppError(400, "invalid_name", "Name must be 1-40 letters");
    if (isBlockedName(name.key)) throw new AppError(422, "name_not_allowed", "This name can't be used");

    const nameKey = nameKeyOf(body.lang, name.key);
    const { template, reason } = await pickTemplate(
      {
        catalog: this.catalog,
        readyTemplateRefs: (lang, key) => this.songs.readyTemplateRefs(lang, key),
        etaSeconds: () => this.eta.etaSeconds(),
        spikeEtaSeconds: env.SPIKE_ETA_SECONDS,
      },
      { lang: body.lang, nameKey },
    ).catch((e: Error) => {
      throw new AppError(400, "no_template", e.message);
    });

    const songId = songIdOf(template, body.lang, nameKey);
    const { outcome, waiters, updatedAt } = await this.songs.createOrJoin(songId, { templateId: template.id, lang: body.lang, name: name.lyric, nameKey });
    songRequests.inc({ outcome: outcome === "ready" ? "cache_hit" : outcome === "created" || outcome === "retry" ? "queued" : "joined", pick: reason });

    const job: SingJobData = { songId, templateId: template.id };
    if (outcome === "created" || outcome === "retry") {
      await this.queue(job);
      this.eta.noteQueued();
    } else if (outcome === "queued") {
      await this.checkJob(job, waiters);
    } else if (outcome === "processing" && Date.now() - updatedAt > STUCK_PROCESSING_MS) {
      songsRequeued.inc({ reason: "stuck_processing" });
      await this.queue(job);
    }

    if (idempotencyKey) {
      await this.redis.set(keys.idempotency(idempotencyKey), JSON.stringify({ songId }), "EX", IDEMPOTENCY_TTL_S, "NX");
    }
    return { ...(await this.view(songId)), pick: reason, replayed: false };
  }

  async view(songId: string): Promise<SongView> {
    const s = await this.songs.get(songId);
    if (!s) throw new AppError(404, "not_found", "Unknown song");
    const base = {
      songId,
      status: s.status,
      templateId: s.templateId,
      name: s.name,
      genre: this.catalog.tryGet(s.templateId)?.genre,
      intro: this.intro(s.templateId),
      lyric: this.lyric(s.templateId, s.name),
    };
    if (s.status === "ready") return { ...base, url: s.url, wait: "none" };
    // Failed: the app offers "try again", which re-queues it (see createOrJoin).
    if (s.status === "failed") return { ...base, wait: "none" };
    const etaSeconds = await this.eta.etaSeconds();
    // Never show a countdown we can't keep: past the threshold the app says
    // "come back in a bit" and checks once a minute; the song waits under its id.
    if (etaSeconds > env.LATER_AFTER_SECONDS) return { ...base, wait: "later", pollAfterSeconds: 60 };
    return { ...base, wait: "short", etaSeconds, pollAfterSeconds: Math.min(10, Math.max(2, Math.ceil(etaSeconds / 3))) };
  }

  private lyric(templateId: string, name: string): string | undefined {
    const slot = this.catalog.tryGet(templateId)?.slots[0];
    // Drop the section tag ("[Hook]") and join the lines into one.
    return slot?.text.replace(/\[[^\]]*\]/g, "").replaceAll("{name}", name).replace(/\s+/g, " ").trim();
  }

  private intro(templateId: string): SongView["intro"] {
    const t = this.catalog.tryGet(templateId);
    if (!t) return undefined;
    const base = (env.TEMPLATES_PUBLIC_BASE_URL ?? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/files/templates`).replace(/\/$/, "");
    // ?v= so a re-recorded template is never served from an old cache entry.
    return {
      templateUrl: `${base}/${t.audioFile}?v=${t.version}`,
      nameAtMs: this.catalog.firstNameAtMs(t),
      durationMs: t.durationMs,
      nameSpots: t.slots.map((sl) => ({ startMs: sl.startMs, endMs: sl.endMs })),
    };
  }

  // Runs on 2, 4, 8... waiters only, so a viral name costs a handful of Redis
  // calls, not one per request. Two jobs:
  // 1. Songs many users wait on jump the queue.
  // 2. Self-healing: the song record says queued but its job is gone (API crashed
  //    between create and add, or BullMQ cleaned up a failed job). Without this,
  //    everyone with that name would wait on nothing forever.
  private async checkJob(data: SingJobData, waiters: number) {
    if ((waiters & (waiters - 1)) !== 0) return;
    const job = await this.queues.sing.getJob(data.songId);
    const state = job ? await job.getState() : "missing";
    if (state === "prioritized" || state === "waiting") {
      await job!.changePriority({ priority: Math.max(1, PRIORITY_BASE - waiters) }).catch(() => undefined);
    } else if (state === "missing" || state === "failed" || state === "completed" || state === "unknown") {
      // Active and delayed (retry backoff) jobs are alive; anything else is a ghost.
      songsRequeued.inc({ reason: state });
      await this.queue(data);
    }
  }

  // Waiting set first, then the job: a job that runs always finds its song.
  private async queue(data: SingJobData) {
    await this.songs.enqueue(data.templateId, data.songId);
    await this.queues.sing.remove(data.songId).catch(() => undefined);
    await this.queues.sing.add("sing", data, { jobId: data.songId, priority: PRIORITY_BASE });
  }
}
