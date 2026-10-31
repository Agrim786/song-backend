import { env } from "../config/env.js";
import { PreviewRepo } from "../modules/previews/previews.repo.js";
import { PreviewService } from "../modules/previews/previews.service.js";
import { MockStt } from "../modules/names/stt/mock.js";
import { RecordingRepo } from "../modules/names/recordings.repo.js";
import { SarvamStt } from "../modules/names/stt/sarvam.js";
import { EtaEstimator } from "../modules/songs/eta.js";
import { SongRepo } from "../modules/songs/songs.repo.js";
import { SongService } from "../modules/songs/songs.service.js";
import { createStorage } from "../shared/storage/index.js";
import { loadCatalog } from "../modules/templates/catalog.js";
import { buildApp } from "../http/app.js";
import { createQueues } from "../shared/queues.js";
import { logger } from "../shared/logger.js";
import { createRedis } from "../shared/redis.js";
import { onShutdown } from "../shared/shutdown.js";

// Stateless: run as many copies as needed behind a load balancer.
const redis = createRedis("api");
const catalog = await loadCatalog(env.TEMPLATES_DIR, env.CLIP_CONTEXT_MS);
const storage = createStorage();
const queues = createQueues();
const eta = new EtaEstimator(
  queues,
  redis,
  env.PROVIDER_CONCURRENCY,
  env.SECONDS_PER_SONG_ESTIMATE,
);
const recordings = new RecordingRepo(redis);
const previews = new PreviewService(new PreviewRepo(redis), recordings, queues);
const songs = new SongService(
  redis,
  catalog,
  new SongRepo(redis),
  queues,
  eta,
  previews,
);
const stt =
  env.STT_PROVIDER === "sarvam"
    ? new SarvamStt(env.SARVAM_API_KEY!)
    : new MockStt();

const app = buildApp({
  redis,
  catalog,
  queues,
  storage,
  songs,
  previews,
  recordings,
  stt,
});
const server = app.listen(env.PORT, (err?: Error) => {
  if (err) {
    // Express 5 reports listen errors here (e.g. port already in use).
    logger.fatal({ err, port: env.PORT }, "api failed to start");
    process.exit(1);
  }
  logger.info(
    { port: env.PORT, templates: catalog.size, provider: env.SINGING_PROVIDER },
    "api listening",
  );
});
// Longer than typical load balancer idle timeouts, avoids sporadic 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

onShutdown(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await Promise.all([queues.sing.close(), queues.preview.close()]);
  await redis.quit();
});
