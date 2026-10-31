import type { Redis } from "ioredis";
import { keys } from "../../shared/keys.js";
import type { Queues } from "../../shared/queues.js";

const CACHE_MS = 1000;

// Queue ETA = backlog x measured seconds-per-song / provider slots. Cached for a
// second because at spike rates every request asks, and the answer barely moves.
export class EtaEstimator {
  private cached: { at: number; value: { etaSeconds: number; backlog: number; secondsPerSong: number } } | null = null;

  constructor(
    private readonly queues: Queues,
    private readonly redis: Redis,
    private readonly slots: number,
    private readonly fallbackSecondsPerSong: number,
  ) {}

  async estimate() {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const [counts, ewma] = await Promise.all([
      this.queues.sing.getJobCounts("waiting", "prioritized", "active", "delayed"),
      this.redis.get(keys.singSecondsEwma()),
    ]);
    const backlog = Object.values(counts).reduce((a, b) => a + b, 0);
    const secondsPerSong = Number(ewma) || this.fallbackSecondsPerSong;
    const value = { etaSeconds: Math.ceil((backlog * secondsPerSong) / this.slots), backlog, secondsPerSong };
    this.cached = { at: Date.now(), value };
    return value;
  }

  async etaSeconds() {
    return (await this.estimate()).etaSeconds;
  }
}

// Exponential moving average of real generation time, written by the worker.
export async function recordSongSeconds(redis: Redis, seconds: number) {
  const prev = Number(await redis.get(keys.singSecondsEwma()));
  const next = prev ? prev * 0.8 + seconds * 0.2 : seconds;
  await redis.set(keys.singSecondsEwma(), next.toFixed(3));
}
