import type { Redis } from "ioredis";
import { keys } from "../../shared/keys.js";
import type { Queues } from "../../shared/queues.js";

const CACHE_MS = 1000;

interface Snapshot {
  at: number;
  backlog: number;
  secondsPerSong: number;
}

// Queue ETA = backlog x measured seconds-per-song / provider slots. The backlog
// is read from Redis at most once a second, because at spike rates every request
// asks. Songs this process queued since that read are added on top: a load test
// showed 5,000 users arriving inside one cache window were all told "0 s", so the
// spike picker and the previews never switched on.
export class EtaEstimator {
  private snap: Snapshot | null = null;
  private refreshing: Promise<Snapshot> | null = null;
  private queuedSinceSnap = 0;

  constructor(
    private readonly queues: Queues,
    private readonly redis: Redis,
    private readonly slots: number,
    private readonly fallbackSecondsPerSong: number,
  ) {}

  // Called right after this process adds a new sing job.
  noteQueued() {
    this.queuedSinceSnap++;
  }

  async estimate() {
    const snap = this.snap && Date.now() - this.snap.at < CACHE_MS ? this.snap : await this.refresh();
    const backlog = snap.backlog + this.queuedSinceSnap;
    return { etaSeconds: Math.ceil((backlog * snap.secondsPerSong) / this.slots), backlog, secondsPerSong: snap.secondsPerSong };
  }

  async etaSeconds() {
    return (await this.estimate()).etaSeconds;
  }

  // One Redis read per expiry, shared by every request waiting on it.
  private refresh(): Promise<Snapshot> {
    this.refreshing ??= (async () => {
      try {
        const before = this.queuedSinceSnap;
        const [counts, ewma] = await Promise.all([
          this.queues.sing.getJobCounts("waiting", "prioritized", "active", "delayed"),
          this.redis.get(keys.singSecondsEwma()),
        ]);
        // Jobs noted before the read are inside `counts` now. Ones noted during it
        // may be counted twice until the next read: a small overestimate is the
        // safe side (a preview too many, never a spike missed).
        this.queuedSinceSnap -= before;
        this.snap = {
          at: Date.now(),
          backlog: Object.values(counts).reduce((a, b) => a + b, 0),
          secondsPerSong: Number(ewma) || this.fallbackSecondsPerSong,
        };
        return this.snap;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

// Exponential moving average of real generation time, written by the worker.
export async function recordSongSeconds(redis: Redis, seconds: number) {
  const prev = Number(await redis.get(keys.singSecondsEwma()));
  const next = prev ? prev * 0.8 + seconds * 0.2 : seconds;
  await redis.set(keys.singSecondsEwma(), next.toFixed(3));
}
