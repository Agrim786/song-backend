import type { Redis } from "ioredis";
import { env, supportedLangs } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { keys } from "../../shared/keys.js";
import { PRIORITY_BASE, type Queues, type SingJobData } from "../../shared/queues.js";
import { songRequests, songsRequeued } from "../../shared/metrics.js";
import { isBlockedName } from "../names/blocklist.js";
import { normalizeName } from "../names/normalize.js";
import type { PreviewService } from "../previews/previews.service.js";
import type { Catalog } from "../templates/catalog.js";
import { pickTemplate } from "../templates/picker.js";
import type { EtaEstimator } from "./eta.js";
import { nameKeyOf, songIdOf } from "./songs.ids.js";
import type { SongRepo } from "./songs.repo.js";
import type { CreateSongBody } from "./songs.schema.js";

const IDEMPOTENCY_TTL_S = 24 * 3600;

export interface SongView {
  songId: string;
  status: string;
  url?: string;
  etaSeconds?: number;
  templateId: string;
}

export class SongService {
  constructor(
    private readonly redis: Redis,
    private readonly catalog: Catalog,
    private readonly songs: SongRepo,
    private readonly queues: Queues,
    private readonly eta: EtaEstimator,
    private readonly previews: PreviewService,
  ) {}

  async create(body: CreateSongBody, idempotencyKey?: string) {
    // A retried tap returns the original answer instead of creating new work.
    if (idempotencyKey) {
      const prior = await this.redis.get(keys.idempotency(idempotencyKey));
      if (prior) {
        const { songId, previewId } = JSON.parse(prior) as { songId: string; previewId?: string };
        return { ...(await this.view(songId)), previewId, replayed: true };
      }
    }

    if (!supportedLangs.includes(body.lang)) throw new AppError(400, "unsupported_language", `lang must be one of ${supportedLangs.join(", ")}`);
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
      { lang: body.lang, nameKey, genre: body.genre },
    ).catch((e: Error) => {
      throw new AppError(400, "no_template", e.message);
    });

    const songId = songIdOf(template, body.lang, nameKey);
    const { outcome, waiters } = await this.songs.createOrJoin(songId, { templateId: template.id, lang: body.lang, name: name.lyric, nameKey });
    songRequests.inc({ outcome: outcome === "ready" ? "cache_hit" : outcome === "created" || outcome === "retry" ? "queued" : "joined", pick: reason });

    const jobData: SingJobData = { songId, templateId: template.id, lang: body.lang, nameKey, lyricName: name.lyric };
    if (outcome === "created") {
      // jobId = songId: BullMQ also refuses duplicates, a second safety net.
      await this.queues.sing.add("sing", jobData, { jobId: songId, priority: PRIORITY_BASE });
      this.eta.noteQueued();
    } else if (outcome === "retry") {
      await this.requeue(jobData);
      this.eta.noteQueued();
    } else if (outcome === "queued" || outcome === "processing") {
      await this.checkJob(jobData, waiters);
    }

    const view = await this.view(songId);
    let previewId: string | undefined;
    if (view.status !== "ready" && body.recordingId && (view.etaSeconds ?? 0) >= env.PREVIEW_ETA_SECONDS) {
      previewId = (await this.previews.create(songId, template.id, body.recordingId)) ?? undefined;
    }

    if (idempotencyKey) {
      await this.redis.set(keys.idempotency(idempotencyKey), JSON.stringify({ songId, previewId }), "EX", IDEMPOTENCY_TTL_S, "NX");
    }
    return { ...view, genre: template.genre, pick: reason, previewId, replayed: false };
  }

  async view(songId: string): Promise<SongView> {
    const s = await this.songs.get(songId);
    if (!s) throw new AppError(404, "not_found", "Unknown song");
    const base = { songId, status: s.status, templateId: s.templateId };
    if (s.status === "ready") return { ...base, url: s.url };
    return { ...base, etaSeconds: await this.eta.etaSeconds() };
  }

  // Runs on 2, 4, 8... waiters only, so a viral name costs a handful of Redis
  // calls, not one per request. Two jobs:
  // 1. Songs many users wait on jump the queue.
  // 2. Self-healing: the song record says queued/processing but its job is gone
  //    (API crashed between create and add, or a worker died before marking the
  //    song failed, then BullMQ cleaned the job up). Without this, everyone with
  //    that name would wait on nothing forever.
  private async checkJob(data: SingJobData, waiters: number) {
    if ((waiters & (waiters - 1)) !== 0) return;
    const job = await this.queues.sing.getJob(data.songId);
    const state = job ? await job.getState() : "missing";
    if (state === "prioritized" || state === "waiting") {
      await job!.changePriority({ priority: Math.max(1, PRIORITY_BASE - waiters) }).catch(() => undefined);
    } else if (state === "missing" || state === "failed" || state === "completed" || state === "unknown") {
      // Active and delayed (retry backoff) jobs are alive; anything else is a ghost.
      songsRequeued.inc({ reason: state });
      await this.requeue(data);
    }
  }

  private async requeue(data: SingJobData) {
    await this.queues.sing.remove(data.songId).catch(() => undefined);
    await this.queues.sing.add("sing", data, { jobId: data.songId, priority: PRIORITY_BASE });
  }
}
