import { z } from "zod";

// All configuration is validated once at boot so a bad deploy fails loudly
// instead of misbehaving under load.
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    PUBLIC_BASE_URL: z.string().default("http://localhost:8080"),
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    CORS_ORIGINS: z.string().default("*"),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),

    TEMPLATES_DIR: z.string().default("./templates"),
    SUPPORTED_LANGS: z.string().default("hi,en"),

    SINGING_PROVIDER: z.enum(["elevenlabs", "mock"]).default("mock"),
    ELEVENLABS_API_KEY: z.string().optional(),
    PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    CLIP_CONTEXT_MS: z.coerce.number().int().min(50).default(1000),
    SECONDS_PER_SONG_ESTIMATE: z.coerce.number().positive().default(3.5),

    MOCK_LATENCY_MS: z.coerce.number().int().min(0).default(3500),
    MOCK_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    MOCK_FAIL_RATE: z.coerce.number().min(0).max(1).default(0),

    STT_PROVIDER: z.enum(["sarvam", "mock"]).default("mock"),
    SARVAM_API_KEY: z.string().optional(),
    STT_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(60),

    SPIKE_ETA_SECONDS: z.coerce.number().min(0).default(30),
    PREVIEW_ETA_SECONDS: z.coerce.number().min(0).default(30),

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

    PREVIEW_CONCURRENCY: z.coerce.number().int().min(0).default(0),
    WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9100),
  })
  .superRefine((e, ctx) => {
    const need = (cond: boolean, key: string, why: string) => {
      if (cond) ctx.addIssue({ code: "custom", path: [key], message: why });
    };
    need(e.SINGING_PROVIDER === "elevenlabs" && !e.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY", "required when SINGING_PROVIDER=elevenlabs");
    need(e.STT_PROVIDER === "sarvam" && !e.SARVAM_API_KEY, "SARVAM_API_KEY", "required when STT_PROVIDER=sarvam");
    need(e.STORAGE_DRIVER === "s3" && !(e.S3_BUCKET && e.S3_PUBLIC_BASE_URL), "S3_BUCKET", "S3_BUCKET and S3_PUBLIC_BASE_URL required when STORAGE_DRIVER=s3");
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  // Treat empty strings in .env as "not set" so optional keys stay optional.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid configuration:\n" + parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();
export const supportedLangs = env.SUPPORTED_LANGS.split(",").map((s) => s.trim()).filter(Boolean);
