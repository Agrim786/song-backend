import { type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { env } from "../../config/env.js";
import {
  ProviderError,
  ProviderRateLimitedError,
} from "../../shared/errors.js";
import { probeDurationMs } from "../../shared/ffmpeg.js";
import { logger } from "../../shared/logger.js";
import type { SingJobData } from "../../shared/queues.js";
import {
  namesPerCall,
  providerCalls,
  providerLatency,
} from "../../shared/metrics.js";
import { withTempDir } from "../../shared/tempfile.js";
import { recordSongSeconds } from "../songs/eta.js";
import type { SongRecord, SongRepo } from "../songs/songs.repo.js";
import type { FileStorage } from "../../shared/storage/storage.js";
import { type Catalog, templateRef } from "../templates/catalog.js";
import type { CircuitBreaker } from "./breaker.js";
import { buildBatchPlan, maxNamesPerCall, splicePieces } from "./plan.js";
import type { SingingProvider } from "./providers/provider.js";
import { stitchClip } from "./stitch.js";

// Measured: every returned clip was exactly planned length + 24 ms (MP3 padding).
// Anything far off means the offsets would put names in the wrong place: fail loudly.
const CLIP_TOLERANCE_MS = 250;

interface Deps {
  redis: Redis;
  catalog: Catalog;
  songs: SongRepo;
  storage: FileStorage;
  provider: SingingProvider;
  breaker: CircuitBreaker;
  getWorker: () => Worker<SingJobData>;
  // Songs still waiting to be sung, across all templates.
  backlog: () => Promise<number>;
}

export function createSingProcessor(d: Deps) {
  return async (job: Job<SingJobData>) => {
    const tpl = d.catalog.get(job.data.templateId);
    // Whole-job time (provider + stitching + saving): how long this slot was busy,
    // which is what decides how fast the line really moves.
    const jobStarted = performance.now();

    let batch = job.data.batch;
    if (!batch) {
      // Calm: sing just this name, because one name comes back fastest (~3.4 s,
      // inside the app's 6 s intro). Busy: fill the call with other waiting songs of
      // this template, ~2.3x the throughput per provider slot (measured).
      const busy = (await d.backlog()) > env.PROVIDER_CONCURRENCY;
      const max = busy
        ? Math.min(env.MAX_NAMES_PER_CALL, maxNamesPerCall(tpl))
        : 1;
      batch = await d.songs.claim(tpl.id, job.data.songId, max);
      // Already sung inside another job's batch: nothing left to do.
      if (!batch.length) return { skipped: true };
      // Retries and crash recovery reuse exactly this batch.
      await job.updateData({ ...job.data, batch });
    }

    const records = await Promise.all(batch.map((id) => d.songs.get(id)));
    const people = batch
      .map((id, i) => ({ id, rec: records[i] }))
      .filter((p): p is { id: string; rec: SongRecord } => Boolean(p.rec));
    if (!people.length) return { skipped: true };

    const {
      plan,
      people: layouts,
      clipDurationMs,
    } = buildBatchPlan(
      tpl,
      people.map((p) => p.rec.name),
      env.CLIP_CONTEXT_MS,
    );
    const started = performance.now();
    let clip: Buffer;
    try {
      clip = await d.breaker.run(() => d.provider.sing(plan, tpl.modelId));
      providerCalls.inc({ provider: d.provider.name, result: "ok" });
    } catch (e) {
      if (e instanceof ProviderRateLimitedError) {
        // Pause this queue and put the job back without spending a retry attempt.
        providerCalls.inc({
          provider: d.provider.name,
          result: "rate_limited",
        });
        await d.getWorker().rateLimit(e.retryAfterMs);
        throw Worker.RateLimitError();
      }
      providerCalls.inc({ provider: d.provider.name, result: "error" });
      throw e;
    }
    const seconds = (performance.now() - started) / 1000;
    providerLatency.observe({ provider: d.provider.name }, seconds);
    namesPerCall.observe(people.length);

    await withTempDir(async (_dir, put) => {
      const clipPath = await put("clip.mp3", clip);
      const got = await probeDurationMs(clipPath);
      if (Math.abs(got - clipDurationMs) > CLIP_TOLERANCE_MS) {
        throw new ProviderError(
          502,
          `clip is ${got} ms, planned ${clipDurationMs} ms`,
        );
      }
      // One person's stitch failing must not throw away everyone else's song.
      for (const [i, p] of people.entries()) {
        try {
          const song = await stitchClip(
            d.catalog.audioPath(tpl),
            clipPath,
            splicePieces(layouts[i]!, tpl.durationMs),
          );
          const key = `songs/${p.id}.mp3`;
          await d.storage.put(key, song, "audio/mpeg", { immutable: true });
          await d.songs.markReady(
            p.id,
            d.storage.url(key),
            p.rec.lang,
            p.rec.nameKey,
            templateRef(tpl),
          );
        } catch (e) {
          logger.error({ songId: p.id, err: e }, "stitch failed");
          await d.songs.markFailed(p.id, (e as Error).message);
        }
      }
    });

    // Wait-time math works per song, so a 5-name job counts as 5 songs. Measured
    // over the whole job, not just the provider call: stitching also holds the slot.
    const jobSeconds = (performance.now() - jobStarted) / 1000;
    await recordSongSeconds(d.redis, jobSeconds / people.length);
    logger.info(
      {
        templateId: tpl.id,
        names: people.length,
        providerSeconds: Number(seconds.toFixed(2)),
        jobSeconds: Number(jobSeconds.toFixed(2)),
      },
      "batch sung",
    );
    return { sung: people.length };
  };
}
