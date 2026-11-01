import { Queue } from "bullmq";
import { bullConnection } from "./redis.js";

export const QUEUE = { sing: "sing" } as const;

// One job per song (jobId = songId), so BullMQ dedupes, retries and recovers
// crashed work per song. When a job runs, it may sing other waiting songs of the
// same template in the same provider call; their own jobs then finish as no-ops.
export interface SingJobData {
  songId: string;
  templateId: string;
  // Set on the first attempt: the songs this job claimed for one provider call.
  // Retries reuse it, so a retried batch never picks up different songs.
  batch?: string[];
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
  return { sing };
}

export type Queues = ReturnType<typeof createQueues>;
