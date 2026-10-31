import type { Redis } from "ioredis";
import { keys } from "../../shared/keys.js";

// Voice recordings are personal data: kept only long enough to build a preview.
const TTL_S = 24 * 3600;

export class RecordingRepo {
  constructor(private readonly redis: Redis) {}

  async save(id: string, storageKey: string, lang: string) {
    await this.redis.multi().hset(keys.recording(id), "key", storageKey, "lang", lang).expire(keys.recording(id), TTL_S).exec();
  }

  async storageKey(id: string): Promise<string | null> {
    return (await this.redis.hget(keys.recording(id), "key")) ?? null;
  }
}
