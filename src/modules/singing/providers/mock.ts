import type { Redis } from "ioredis";
import { env } from "../../../config/env.js";
import {
  ProviderError,
  ProviderRateLimitedError,
} from "../../../shared/errors.js";
import { ffmpeg } from "../../../shared/ffmpeg.js";
import { keys } from "../../../shared/keys.js";
import type { Catalog } from "../../templates/catalog.js";
import type {
  CompositionPlan,
  GenerationChunk,
  ReferenceChunk,
} from "../plan.js";
import type { SingingProvider } from "./provider.js";

const FMT = "aformat=sample_rates=48000:channel_layouts=stereo";
const isRef = (c: GenerationChunk | ReferenceChunk): c is ReferenceChunk =>
  "song_id" in c;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Behaves like the real provider as measured on 1 Nov 2026: ~3.3 s for one name
// (2 sung sections), ~0.475 s more per extra sung section (5 names = 10 sections
// took ~7.1 s), a hard limit of 2 parallel calls with 429s beyond it. Returns real
// audio, so stitching load is real. Lets us load test without touching ElevenLabs.
export class MockProvider implements SingingProvider {
  readonly name = "mock";
  constructor(
    private readonly redis: Redis,
    private readonly catalog: Catalog,
  ) {}

  async sing(plan: CompositionPlan): Promise<Buffer> {
    const active = await this.redis.incr(keys.mockActive());
    await this.redis.pexpire(keys.mockActive(), 120_000);
    try {
      if (active > env.MOCK_CONCURRENCY)
        throw new ProviderRateLimitedError(1000, "mock concurrency limit");
      if (Math.random() < env.MOCK_FAIL_RATE)
        throw new ProviderError(503, "mock failure");
      const started = Date.now();
      const audio = await this.render(plan);
      const sung = plan.chunks.filter((c) => !isRef(c)).length;
      const base = env.MOCK_LATENCY_MS + env.MOCK_LATENCY_PER_EXTRA_SECTION_MS * Math.max(0, sung - 2);
      const target = base * (0.9 + Math.random() * 0.2);
      await sleep(Math.max(0, target - (Date.now() - started)));
      return audio;
    } finally {
      await this.redis.decr(keys.mockActive());
    }
  }

  private async render(plan: CompositionPlan): Promise<Buffer> {
    const args: string[] = [];
    const filters: string[] = [];
    // Generated chunks reuse the template audio at the same position (the placeholder
    // being sung), so a correct mock song sounds exactly like the template.
    let lastRef: { path: string; endMs: number } | null = null;
    plan.chunks.forEach((c, i) => {
      if (isRef(c)) {
        const t = this.catalog.byProviderSongId(c.song_id);
        if (!t) throw new ProviderError(404, `mock: unknown song ${c.song_id}`);
        lastRef = { path: this.catalog.audioPath(t), endMs: c.range.end_ms };
        args.push("-i", lastRef.path);
        filters.push(
          `[${i}:a]atrim=start=${c.range.start_ms / 1000}:end=${c.range.end_ms / 1000},asetpts=PTS-STARTPTS,${FMT}[c${i}]`,
        );
      } else {
        if (!lastRef)
          throw new ProviderError(
            400,
            "mock: plan must start with a reference chunk",
          );
        const start = lastRef.endMs / 1000;
        args.push("-i", lastRef.path);
        filters.push(
          `[${i}:a]atrim=start=${start}:end=${start + c.duration_ms / 1000},asetpts=PTS-STARTPTS,${FMT}[c${i}]`,
        );
      }
    });
    filters.push(
      `${plan.chunks.map((_, i) => `[c${i}]`).join("")}concat=n=${plan.chunks.length}:v=0:a=1[out]`,
    );
    return ffmpeg([
      ...args,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-f",
      "mp3",
      "pipe:1",
    ]);
  }
}
