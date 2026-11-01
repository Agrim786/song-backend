import type { Redis } from "ioredis";
import { keys } from "../../shared/keys.js";

const CACHE_MS = 1000;
// One provider call plus stitching: the soonest any new song can be ready.
const MIN_SONG_SECONDS = 4;
// Promise a little more than the average: a song that lands early feels great, one
// that lands after its promise breaks trust (and the "short" band's intro trick).
const PROMISE_MARGIN = 1.2;

interface Snapshot {
  at: number;
  backlog: number;
  secondsPerSong: number;
}

// Queue ETA = backlog x measured seconds-per-song / provider slots. The backlog
// (songs still waiting to be sung) is read from Redis at most once a second,
// because at spike rates every request asks. Songs this process queued since that
// read are added on top: a load test showed 5,000 users arriving inside one cache
// window were all told "0 s", so the spike picker never switched on.
// Arrivals (not just queued songs) are counted, so even a sub-second burst is seen.
export class EtaEstimator {
  private snap: Snapshot | null = null;
  private refreshing: Promise<Snapshot> | null = null;
  private queuedSinceSnap = 0;

  constructor(
    private readonly backlog: () => Promise<number>,
    private readonly redis: Redis,
    private readonly slots: number,
    private readonly fallbackSecondsPerSong: number,
    // Names per provider call once there is a line (MAX_NAMES_PER_CALL).
    private readonly batchSize: number,
  ) {}

  // Called as each song request arrives (before we know if it is a cache hit, so
  // a rush is overestimated for at most a second, never missed).
  noteArrival() {
    this.queuedSinceSnap++;
  }

  async estimate() {
    const snap =
      this.snap && Date.now() - this.snap.at < CACHE_MS
        ? this.snap
        : await this.refresh();
    const backlog = snap.backlog + this.queuedSinceSnap;
    return {
      etaSeconds: Math.ceil((backlog * snap.secondsPerSong) / this.slots),
      backlog,
      secondsPerSong: snap.secondsPerSong,
    };
  }

  // Whole-line wait: drives the picker's spike mode (is the system busy?).
  async etaSeconds() {
    return (await this.estimate()).etaSeconds;
  }

  // One user's wait, from their place in line: the first people in a rush are
  // seconds away even when the line behind them is an hour long.
  // Songs finish in rounds, not one by one: each round, every slot sings a batch
  // (5 names when there is a line, 1 when there isn't), and a batch is ready only
  // when the whole job ends. So: which round is this song in, times one job.
  async etaForPosition(position: number) {
    const { secondsPerSong, backlog } = await this.estimate();
    // Batch size follows the whole line, not this song's place: with a line, even
    // the first song is sung in a batch of 5 and is ready when that batch is.
    const batch = backlog > this.slots ? this.batchSize : 1;
    const round = Math.ceil(position / (this.slots * batch));
    return Math.max(
      MIN_SONG_SECONDS,
      Math.ceil(round * batch * secondsPerSong * PROMISE_MARGIN),
    );
  }

  // One Redis read per expiry, shared by every request waiting on it.
  private refresh(): Promise<Snapshot> {
    this.refreshing ??= (async () => {
      try {
        const before = this.queuedSinceSnap;
        const [waiting, ewma] = await Promise.all([
          this.backlog(),
          this.redis.get(keys.singSecondsEwma()),
        ]);
        // Songs noted before the read are inside `waiting` now. Ones noted during it
        // may be counted twice until the next read: a small overestimate is the
        // safe side (spike mode a moment early, never a spike missed).
        this.queuedSinceSnap -= before;
        this.snap = {
          at: Date.now(),
          backlog: waiting,
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

// Exponential moving average of slot-busy seconds PER SONG (a 10 s job that sang
// and stitched 5 names records 2 s), written by the worker.
export async function recordSongSeconds(redis: Redis, seconds: number) {
  const prev = Number(await redis.get(keys.singSecondsEwma()));
  const next = prev ? prev * 0.8 + seconds * 0.2 : seconds;
  await redis.set(keys.singSecondsEwma(), next.toFixed(3));
}
