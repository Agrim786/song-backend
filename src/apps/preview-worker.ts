import { availableParallelism } from "node:os";
import { Worker } from "bullmq";
import { env } from "../config/env.js";
import { createPreviewProcessor } from "../modules/previews/previews.processor.js";
import { PreviewRepo } from "../modules/previews/previews.repo.js";
import { createStorage } from "../shared/storage/index.js";
import { loadCatalog } from "../modules/templates/catalog.js";
import { QUEUE, type PreviewJobData } from "../shared/queues.js";
import { logger } from "../shared/logger.js";
import { startMetricsServer } from "../shared/metricsServer.js";
import { bullConnection, createRedis } from "../shared/redis.js";
import { onShutdown } from "../shared/shutdown.js";

// CPU-only (ffmpeg), no provider involved: scale this by adding machines.
const redis = createRedis("preview-worker");
const catalog = await loadCatalog(env.TEMPLATES_DIR, env.CLIP_CONTEXT_MS);
const previews = new PreviewRepo(redis);
const concurrency = env.PREVIEW_CONCURRENCY || availableParallelism();

const worker = new Worker<PreviewJobData>(QUEUE.preview, createPreviewProcessor(catalog, createStorage(), previews), {
  connection: bullConnection,
  concurrency,
});
worker.on("failed", (job, err) => {
  logger.warn({ previewId: job?.data.previewId, err: err.message }, "preview failed");
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void previews.markFailed(job.data.previewId);
});

const metrics = startMetricsServer(env.WORKER_METRICS_PORT + 1);
logger.info({ concurrency }, "preview worker started");

onShutdown(async () => {
  await worker.close();
  metrics.close();
  await redis.quit();
});
