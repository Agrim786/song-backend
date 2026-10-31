import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import { pinoHttp } from "pino-http";
import { env } from "../config/env.js";
import { httpDuration, queueJobs, registry } from "../shared/metrics.js";
import type { PreviewService } from "../modules/previews/previews.service.js";
import type { RecordingRepo } from "../modules/names/recordings.repo.js";
import { recordingRoutes } from "../modules/names/names.routes.js";
import type { SpeechToText } from "../modules/names/stt/stt.js";
import { songRoutes } from "../modules/songs/songs.routes.js";
import type { SongService } from "../modules/songs/songs.service.js";
import type { FileStorage } from "../shared/storage/storage.js";
import type { Catalog } from "../modules/templates/catalog.js";
import type { Queues } from "../shared/queues.js";
import { logger } from "../shared/logger.js";
import { errorHandler, notFound } from "./errorHandler.js";
import { limiter } from "./rateLimit.js";

export interface AppDeps {
  redis: Redis;
  catalog: Catalog;
  queues: Queues;
  storage: FileStorage;
  songs: SongService;
  previews: PreviewService;
  recordings: RecordingRepo;
  stt: SpeechToText;
}

export function buildApp(d: AppDeps) {
  const app = express();
  app.set("trust proxy", env.TRUST_PROXY);
  app.disable("x-powered-by");

  app.use(pinoHttp({ logger, genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(), autoLogging: { ignore: (req) => req.url === "/healthz" || req.url === "/metrics" } }));
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS === "*" ? "*" : env.CORS_ORIGINS.split(",") }));
  app.use(express.json({ limit: "8kb" }));

  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on("finish", () => end({ method: req.method, route: req.route ? req.baseUrl + req.route.path : "unmatched", status: res.statusCode }));
    next();
  });

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));
  app.get("/readyz", async (_req, res) => {
    const redisOk = (await d.redis.ping().catch(() => null)) === "PONG";
    res.status(redisOk && d.catalog.size > 0 ? 200 : 503).json({ redis: redisOk, templates: d.catalog.size });
  });
  // Scrape from the private network only (block /metrics at the load balancer).
  app.get("/metrics", async (_req, res) => {
    for (const [name, q] of Object.entries(d.queues)) {
      const counts = await q.getJobCounts("waiting", "prioritized", "active", "delayed", "failed");
      for (const [state, n] of Object.entries(counts)) queueJobs.set({ queue: name, state }, n);
    }
    res.type(registry.contentType).send(await registry.metrics());
  });

  const writes = limiter(d.redis, "w", env.RATE_LIMIT_SONGS_PER_MIN);
  const reads = limiter(d.redis, "r", env.RATE_LIMIT_READS_PER_MIN);
  app.use("/v1", (req, res, next) => (req.method === "GET" ? reads : writes)(req, res, next));
  app.use("/v1", recordingRoutes(d.redis, d.storage, d.recordings, d.stt));
  app.use("/v1", songRoutes(d.songs, d.previews));

  if (env.STORAGE_DRIVER === "local") {
    app.use("/files/songs", express.static(`${env.LOCAL_STORAGE_DIR}/songs`, { immutable: true, maxAge: "365d" }));
    app.use("/files/previews", express.static(`${env.LOCAL_STORAGE_DIR}/previews`));
    // Recordings are never served publicly.
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
