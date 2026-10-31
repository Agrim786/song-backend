import type { Redis } from "ioredis";
import { keys } from "../../shared/keys.js";

const TTL_S = 24 * 3600;

export class PreviewRepo {
  constructor(private readonly redis: Redis) {}

  async create(previewId: string, songId: string) {
    await this.redis.multi().hset(keys.preview(previewId), "status", "queued", "songId", songId).expire(keys.preview(previewId), TTL_S).exec();
  }

  async get(previewId: string) {
    const h = await this.redis.hgetall(keys.preview(previewId));
    return h.status ? { status: h.status, songId: h.songId, url: h.url || undefined } : null;
  }

  markReady(previewId: string, url: string) {
    return this.redis.hset(keys.preview(previewId), "status", "ready", "url", url);
  }

  markFailed(previewId: string) {
    return this.redis.hset(keys.preview(previewId), "status", "failed");
  }
}
