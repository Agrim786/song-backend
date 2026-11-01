import { Worker } from "bullmq";
import { env } from "../config/env.js";
import { SongRepo } from "../modules/songs/songs.repo.js";
import { CircuitBreaker } from "../modules/singing/breaker.js";
import { ElevenLabsProvider } from "../modules/singing/providers/elevenlabs.js";
import { MockProvider } from "../modules/singing/providers/mock.js";
import { createSingProcessor } from "../modules/singing/singing.processor.js";
import type { SingingProvider } from "../modules/singing/providers/provider.js";
import { createStorage } from "../shared/storage/index.js";
import { loadCatalog } from "../modules/templates/catalog.js";
import { QUEUE, createQueues, type SingJobData } from "../shared/queues.js";
import { logger } from "../shared/logger.js";
import { startMetricsServer } from "../shared/metricsServer.js";
import { bullConnection, createRedis } from "../shared/redis.js";
import { onShutdown } from "../shared/shutdown.js";

const redis = createRedis("sing-worker");
const catalog = await loadCatalog(env.TEMPLATES_DIR, env.CLIP_CONTEXT_MS);
const queues = createQueues();
// The provider allows N parallel generations per account. Enforce it across ALL
// worker processes, so adding workers can never trigger a 429 storm.
await queues.sing.setGlobalConcurrency(env.PROVIDER_CONCURRENCY);

const provider: SingingProvider =
  env.SINGING_PROVIDER === "elevenlabs"
    ? new ElevenLabsProvider(env.ELEVENLABS_API_KEY!)
    : new MockProvider(redis, catalog);
const songs = new SongRepo(redis);

let worker: Worker<SingJobData> | undefined;
const processor = createSingProcessor({
  redis,
  catalog,
  songs,
  storage: createStorage(),
  provider,
  breaker: new CircuitBreaker(),
  getWorker: () => worker!,
  backlog: () => songs.pendingCount(catalog.ids()),
});

worker = new Worker<SingJobData>(QUEUE.sing, processor, {
  connection: bullConnection,
  concurrency: env.PROVIDER_CONCURRENCY,
  lockDuration: 180_000,
});

worker.on("failed", (job, err) => {
  if (!job) return;
  const final = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger.warn(
    {
      songId: job.data.songId,
      batch: job.data.batch?.length,
      attempt: job.attemptsMade,
      final,
      err: err.message,
    },
    "sing job failed",
  );
  // Final failure: every song in this job's batch is marked failed; the next request
  // for any of them re-queues it (see createOrJoin).
  if (final)
    for (const id of job.data.batch ?? [job.data.songId])
      void songs.markFailed(id, err.message);
});
worker.on("error", (err) => logger.error({ err }, "worker error"));

const metrics = startMetricsServer(env.WORKER_METRICS_PORT);
logger.info(
  { provider: provider.name, slots: env.PROVIDER_CONCURRENCY },
  "sing worker started",
);

onShutdown(async () => {
  await worker!.close(); // waits for active generations to finish
  await queues.sing.close();
  metrics.close();
  await redis.quit();
});
