import { env } from "../config/env.js";
import { MockStt } from "../modules/names/stt/mock.js";
import { ElevenLabsStt } from "../modules/names/stt/elevenlabs.js";
import { SarvamStt } from "../modules/names/stt/sarvam.js";
import type { SpeechToText } from "../modules/names/stt/stt.js";
import { EtaEstimator } from "../modules/songs/eta.js";
import { SongRepo } from "../modules/songs/songs.repo.js";
import { SongService } from "../modules/songs/songs.service.js";
import { loadCatalog } from "../modules/templates/catalog.js";
import { buildApp } from "../http/app.js";
import { createQueues } from "../shared/queues.js";
import { logger } from "../shared/logger.js";
import { createRedis } from "../shared/redis.js";
import { onShutdown } from "../shared/shutdown.js";

// Stateless: run as many copies as needed behind a load balancer.
const redis = createRedis("api");
const catalog = await loadCatalog(env.TEMPLATES_DIR, env.CLIP_CONTEXT_MS);
const queues = createQueues();
const songRepo = new SongRepo(redis);
const eta = new EtaEstimator(() => songRepo.pendingCount(catalog.ids()), redis, env.PROVIDER_CONCURRENCY, env.SECONDS_PER_SONG_ESTIMATE, env.MAX_NAMES_PER_CALL);
const songs = new SongService(redis, catalog, songRepo, queues, eta);
const stt: SpeechToText =
  env.STT_PROVIDER === "elevenlabs" ? new ElevenLabsStt(env.ELEVENLABS_API_KEY!) : env.STT_PROVIDER === "sarvam" ? new SarvamStt(env.SARVAM_API_KEY!) : new MockStt();

const app = buildApp({ redis, catalog, queues, songs, stt });
const server = app.listen(env.PORT, (err?: Error) => {
  if (err) {
    // Express 5 reports listen errors here (e.g. port already in use).
    logger.fatal({ err, port: env.PORT }, "api failed to start");
    process.exit(1);
  }
  logger.info({ port: env.PORT, templates: catalog.size, languages: catalog.langs(), provider: env.SINGING_PROVIDER }, "api listening");
});
// Longer than typical load balancer idle timeouts, avoids sporadic 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

onShutdown(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await queues.sing.close();
  await redis.quit();
});
