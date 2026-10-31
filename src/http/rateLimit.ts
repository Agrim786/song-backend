import type { Redis } from "ioredis";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { env } from "../config/env.js";

// Counters live in Redis so the limit holds across every API instance.
export function limiter(redis: Redis, prefix: string, perMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
    skip: (req) => Boolean(env.LOADTEST_TOKEN) && req.get("x-loadtest-token") === env.LOADTEST_TOKEN,
    message: { error: { code: "rate_limited", message: "Too many requests, slow down" } },
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
    }),
  });
}
