import { z } from "zod";

// All configuration is validated once at boot so a bad deploy fails loudly
// instead of misbehaving under load.
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    PUBLIC_BASE_URL: z.string().default("http://localhost:8080"),
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    CORS_ORIGINS: z.string().default("*"),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),

    TEMPLATES_DIR: z.string().default("./templates"),
    // Where the app downloads template audio to start the intro at tap. Defaults to
    // this API's /files/templates; set to the CDN when templates are uploaded there.
    TEMPLATES_PUBLIC_BASE_URL: z.string().optional(),

    SINGING_PROVIDER: z.enum(["elevenlabs", "mock"]).default("mock"),
    ELEVENLABS_API_KEY: z.string().optional(),
    PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    CLIP_CONTEXT_MS: z.coerce.number().int().min(50).default(1000),
    // Slot-busy seconds per song (provider + stitching) until real ones are measured.
    // 2.2 = measured with 5-name batches (jobs of ~8-9 s for 5 songs).
    SECONDS_PER_SONG_ESTIMATE: z.coerce.number().positive().default(2.2),
    // Names per provider call when the line is long (provider max is 5 for 2-slot templates).
    MAX_NAMES_PER_CALL: z.coerce.number().int().min(1).max(10).default(5),

    MOCK_LATENCY_MS: z.coerce.number().int().min(0).default(3300),
    MOCK_LATENCY_PER_EXTRA_SECTION_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(475),
    MOCK_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    MOCK_FAIL_RATE: z.coerce.number().min(0).max(1).default(0),

    STT_PROVIDER: z.enum(["elevenlabs", "sarvam", "mock"]).default("mock"),
    SARVAM_API_KEY: z.string().optional(),
    STT_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(60),

    SPIKE_ETA_SECONDS: z.coerce.number().min(0).default(30),
    // Above this wait the app stops showing a countdown and says "come back in a bit".
    LATER_AFTER_SECONDS: z.coerce.number().min(1).default(60),

    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    LOCAL_STORAGE_DIR: z.string().default("./data/files"),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default("auto"),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_PUBLIC_BASE_URL: z.string().optional(),

    RATE_LIMIT_SONGS_PER_MIN: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_READS_PER_MIN: z.coerce.number().int().min(1).default(240),
    RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().min(1).default(20_000),
    LOADTEST_TOKEN: z.string().optional(),

    WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9100),
  })
  .superRefine((e, ctx) => {
    const need = (cond: boolean, key: string, why: string) => {
      if (cond) ctx.addIssue({ code: "custom", path: [key], message: why });
    };
    need(
      e.SINGING_PROVIDER === "elevenlabs" && !e.ELEVENLABS_API_KEY,
      "ELEVENLABS_API_KEY",
      "required when SINGING_PROVIDER=elevenlabs",
    );
    need(
      e.STT_PROVIDER === "sarvam" && !e.SARVAM_API_KEY,
      "SARVAM_API_KEY",
      "required when STT_PROVIDER=sarvam",
    );
    need(
      e.STT_PROVIDER === "elevenlabs" && !e.ELEVENLABS_API_KEY,
      "ELEVENLABS_API_KEY",
      "required when STT_PROVIDER=elevenlabs",
    );
    need(
      e.STORAGE_DRIVER === "s3" && !(e.S3_BUCKET && e.S3_PUBLIC_BASE_URL),
      "S3_BUCKET",
      "S3_BUCKET and S3_PUBLIC_BASE_URL required when STORAGE_DRIVER=s3",
    );
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  // Treat empty strings in .env as "not set" so optional keys stay optional.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== ""),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    console.error(
      "Invalid configuration:\n" +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();
