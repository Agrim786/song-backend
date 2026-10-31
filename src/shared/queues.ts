import { Queue } from "bullmq";
import { bullConnection } from "./redis.js";

export const QUEUE = { sing: "sing", preview: "preview" } as const;

export interface SingJobData {
  songId: string;
  templateId: string;
  lang: string;
  nameKey: string;
  lyricName: string;
}

export interface PreviewJobData {
  previewId: string;
  templateId: string;
  recordingKey: string;
}

// Lower number = served sooner. New songs start here; songs many users are
// waiting on get bumped toward 1.
export const PRIORITY_BASE = 100_000;

export function createQueues() {
  const sing = new Queue<SingJobData>(QUEUE.sing, {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: { age: 3600, count: 10_000 },
      removeOnFail: { age: 24 * 3600 },
    },
  });
  const preview = new Queue<PreviewJobData>(QUEUE.preview, {
    connection: bullConnection,
    defaultJobOptions: { attempts: 2, removeOnComplete: { age: 600 }, removeOnFail: { age: 3600 } },
  });
  return { sing, preview };
}

export type Queues = ReturnType<typeof createQueues>;
