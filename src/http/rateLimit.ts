import type { Redis } from "ioredis";
import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { env } from "../config/env.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Indian mobile users sit behind carrier NAT: thousands of real people share one
// public IP. A per-IP limit locked out 200 of 200 users from one IP in our load
// test. So the app sends a random id generated at install (X-Device-Id) and the
// per-user limits key on that. Requests without one fall back to the IP.
const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
export const clientKey = (req: Request) => {
  const id = req.get("x-device-id");
  return id && UUID.test(id) ? `dev:${id.toLowerCase()}` : ipKey(req);
};

// Counters live in Redis so the limit holds across every API instance.
function limiter(redis: Redis, prefix: string, perMinute: number, key: (req: Request) => string) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: key,
    skip: (req) => Boolean(env.LOADTEST_TOKEN) && req.get("x-loadtest-token") === env.LOADTEST_TOKEN,
    message: { error: { code: "rate_limited", message: "Too many requests, slow down" } },
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
    }),
  });
}

// Per user (device id, else IP).
export const perClientLimiter = (redis: Redis, prefix: string, perMinute: number) => limiter(redis, prefix, perMinute, clientKey);

// Backstop per IP, set high enough for a carrier NAT full of real users. Device ids
// can be faked, so this only bounds a single machine rotating them; app attestation
// (Play Integrity / App Attest) is the real fix before a public launch.
export const perIpCeiling = (redis: Redis, perMinute: number) => limiter(redis, "ip", perMinute, ipKey);
