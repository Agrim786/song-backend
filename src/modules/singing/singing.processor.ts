import { type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { env } from "../../config/env.js";
import { ProviderRateLimitedError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { SingJobData } from "../../shared/queues.js";
import { providerCalls, providerLatency } from "../../shared/metrics.js";
import { recordSongSeconds } from "../songs/eta.js";
import type { SongRepo } from "../songs/songs.repo.js";
import type { FileStorage } from "../../shared/storage/storage.js";
import { type Catalog, templateRef } from "../templates/catalog.js";
import type { CircuitBreaker } from "./breaker.js";
import { buildClipPlan, splicePieces } from "./plan.js";
import type { SingingProvider } from "./providers/provider.js";
import { stitchClip } from "./stitch.js";

interface Deps {
  redis: Redis;
  catalog: Catalog;
  songs: SongRepo;
  storage: FileStorage;
  provider: SingingProvider;
  breaker: CircuitBreaker;
  getWorker: () => Worker<SingJobData>;
}

export function createSingProcessor(d: Deps) {
  return async (job: Job<SingJobData>) => {
    const { songId, templateId, lang, nameKey, lyricName } = job.data;
    const tpl = d.catalog.get(templateId);
    await d.songs.markProcessing(songId);

    const { plan, layouts } = buildClipPlan(tpl, lyricName, env.CLIP_CONTEXT_MS);
    const started = performance.now();
    let clip: Buffer;
    try {
      clip = await d.breaker.run(() => d.provider.sing(plan, tpl.modelId));
      providerCalls.inc({ provider: d.provider.name, result: "ok" });
    } catch (e) {
      if (e instanceof ProviderRateLimitedError) {
        // Pause this queue and put the job back without spending a retry attempt.
        providerCalls.inc({ provider: d.provider.name, result: "rate_limited" });
        await d.getWorker().rateLimit(e.retryAfterMs);
        throw Worker.RateLimitError();
      }
      providerCalls.inc({ provider: d.provider.name, result: "error" });
      throw e;
    }
    const seconds = (performance.now() - started) / 1000;
    providerLatency.observe({ provider: d.provider.name }, seconds);

    const song = await stitchClip(d.catalog.audioPath(tpl), clip, splicePieces(layouts, tpl.durationMs));
    const key = `songs/${songId}.mp3`;
    await d.storage.put(key, song, "audio/mpeg", { immutable: true });
    await d.songs.markReady(songId, d.storage.url(key), lang, nameKey, templateRef(tpl));
    await recordSongSeconds(d.redis, seconds);
    logger.info({ songId, templateId, seconds: Number(seconds.toFixed(2)) }, "song ready");
  };
}
