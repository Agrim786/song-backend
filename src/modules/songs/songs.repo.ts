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
  return {'created', '1', ARGV[1]}
end
local w = redis.call('HINCRBY', KEYS[1], 'waiters', 1)
if status == 'failed' then
  redis.call('HSET', KEYS[1], 'status', 'queued', 'error', '', 'updatedAt', ARGV[1])
  return {'retry', tostring(w), ARGV[1]}
end
return {status, tostring(w), redis.call('HGET', KEYS[1], 'updatedAt') or '0'}
`;

// Atomically take this job's own song plus up to max-1 other waiting songs of the
// same template, oldest first, and mark them processing in the same step. Two
// workers can never claim the same song, and a song is never "queued" while it is
// actually being sung (which the self-heal on join relies on). Returns [] when the
// song was already claimed by another job's batch.
// Note: touches song keys not passed in KEYS, which is fine on a single Redis node
// (BullMQ already requires one) but not on Redis Cluster.
const CLAIM = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 0 then return {} end
local out = {ARGV[1]}
local max = tonumber(ARGV[2])
if max > 1 then
  local more = redis.call('ZRANGE', KEYS[1], 0, max - 2)
  for _, id in ipairs(more) do
    redis.call('ZREM', KEYS[1], id)
    table.insert(out, id)
  end
end
for _, id in ipairs(out) do
  redis.call('HSET', ARGV[3] .. id, 'status', 'processing', 'updatedAt', ARGV[4])
end
return out
`;

export type JoinOutcome = "created" | "retry" | Exclude<SongStatus, "failed">;

export class SongRepo {
  constructor(private readonly redis: Redis) {}

  async createOrJoin(songId: string, f: { templateId: string; lang: string; name: string; nameKey: string }) {
    const [outcome, waiters, updatedAt] = (await this.redis.eval(CREATE_OR_JOIN, 1, keys.song(songId), Date.now(), f.templateId, f.lang, f.name, f.nameKey)) as [JoinOutcome, string, string];
    return { outcome, waiters: Number(waiters), updatedAt: Number(updatedAt) };
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

  // Puts a song in its template's waiting set (no-op if it is already there).
  enqueue(templateId: string, songId: string) {
    return this.redis.zadd(keys.pending(templateId), "NX", Date.now(), songId);
  }

  async claim(templateId: string, songId: string, max: number): Promise<string[]> {
    return (await this.redis.eval(CLAIM, 1, keys.pending(templateId), songId, max, keys.songPrefix(), Date.now())) as string[];
  }

  // Songs still waiting to be sung, across templates: the real backlog (BullMQ also
  // holds the no-op jobs of songs that were already sung inside someone's batch).
  async pendingCount(templateIds: string[]): Promise<number> {
    const counts = await Promise.all(templateIds.map((id) => this.redis.zcard(keys.pending(id))));
    return counts.reduce((a, b) => a + b, 0);
  }

  async markReady(songId: string, url: string, lang: string, nameKey: string, tplRef: string) {
    await this.redis
      .multi()
      .hset(keys.song(songId), "status", "ready", "url", url, "updatedAt", Date.now())
      // The pool the load-aware picker reads during spikes. Holds templateRef() (id + version).
      .sadd(keys.pool(lang, nameKey), tplRef)
      .exec();
  }

  markFailed(songId: string, error: string) {
    return this.redis.hset(keys.song(songId), "status", "failed", "error", error.slice(0, 300), "updatedAt", Date.now());
  }

  readyTemplateRefs(lang: string, nameKey: string) {
    return this.redis.smembers(keys.pool(lang, nameKey));
  }
}
