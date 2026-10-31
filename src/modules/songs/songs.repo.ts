import type { Redis } from "ioredis";
import { keys } from "../../shared/keys.js";

export type SongStatus = "queued" | "processing" | "ready" | "failed";

export interface SongRecord {
  status: SongStatus;
  templateId: string;
  lang: string;
  name: string;
  nameKey: string;
  url?: string;
  error?: string;
  waiters: number;
  createdAt: number;
  updatedAt: number;
}

// Atomic create-or-join. Under a spike, thousands of API calls race on the same
// popular names; exactly one of them creates the job, the rest join it.
const CREATE_OR_JOIN = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then
  redis.call('HSET', KEYS[1], 'status', 'queued', 'templateId', ARGV[2], 'lang', ARGV[3], 'name', ARGV[4], 'nameKey', ARGV[5], 'waiters', 1, 'createdAt', ARGV[1], 'updatedAt', ARGV[1])
  return {'created', '1'}
end
local w = redis.call('HINCRBY', KEYS[1], 'waiters', 1)
if status == 'failed' then
  redis.call('HSET', KEYS[1], 'status', 'queued', 'error', '', 'updatedAt', ARGV[1])
  return {'retry', tostring(w)}
end
return {status, tostring(w)}
`;

export type JoinOutcome = "created" | "retry" | Exclude<SongStatus, "failed">;

export class SongRepo {
  constructor(private readonly redis: Redis) {}

  async createOrJoin(songId: string, f: { templateId: string; lang: string; name: string; nameKey: string }) {
    const [outcome, waiters] = (await this.redis.eval(CREATE_OR_JOIN, 1, keys.song(songId), Date.now(), f.templateId, f.lang, f.name, f.nameKey)) as [JoinOutcome, string];
    return { outcome, waiters: Number(waiters) };
  }

  async get(songId: string): Promise<SongRecord | null> {
    const h = await this.redis.hgetall(keys.song(songId));
    if (!h.status) return null;
    return {
      status: h.status as SongStatus,
      templateId: h.templateId ?? "",
      lang: h.lang ?? "",
      name: h.name ?? "",
      nameKey: h.nameKey ?? "",
      url: h.url || undefined,
      error: h.error || undefined,
      waiters: Number(h.waiters ?? 0),
      createdAt: Number(h.createdAt ?? 0),
      updatedAt: Number(h.updatedAt ?? 0),
    };
  }

  markProcessing(songId: string) {
    return this.redis.hset(keys.song(songId), "status", "processing", "updatedAt", Date.now());
  }

  async markReady(songId: string, url: string, lang: string, nameKey: string, templateId: string) {
    await this.redis
      .multi()
      .hset(keys.song(songId), "status", "ready", "url", url, "updatedAt", Date.now())
      // The pool the load-aware picker reads during spikes.
      .sadd(keys.pool(lang, nameKey), templateId)
      .exec();
  }

  markFailed(songId: string, error: string) {
    return this.redis.hset(keys.song(songId), "status", "failed", "error", error.slice(0, 300), "updatedAt", Date.now());
  }

  readyTemplateIds(lang: string, nameKey: string) {
    return this.redis.smembers(keys.pool(lang, nameKey));
  }
}
