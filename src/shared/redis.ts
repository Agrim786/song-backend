import { Redis } from "ioredis";
import { env } from "../config/env.js";

// One app client per process for our own keys. BullMQ opens its own connections
// from the same URL, so the two never block each other.
export function createRedis(name: string): Redis {
  return new Redis(env.REDIS_URL, {
    connectionName: name,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
  });
}

export const bullConnection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null,
};
