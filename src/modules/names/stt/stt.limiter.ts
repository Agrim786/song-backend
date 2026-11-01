import type { Redis } from "ioredis";
import { keys } from "../../../shared/keys.js";

// Speech-to-text is per user and can't be cached, so it has its own budget,
// shared by all API instances, matched to the provider's per-minute plan limit.
export async function sttAllowed(
  redis: Redis,
  maxPerMinute: number,
): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const [[, count]] = (await redis
    .multi()
    .incr(keys.sttWindow(minute))
    .expire(keys.sttWindow(minute), 120)
    .exec()) as [[null, number], unknown];
  return count <= maxPerMinute;
}
