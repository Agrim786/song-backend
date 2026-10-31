import { randomUUID } from "node:crypto";
import type { Queues } from "../../shared/queues.js";
import { previewsTotal } from "../../shared/metrics.js";
import type { RecordingRepo } from "../names/recordings.repo.js";
import type { PreviewRepo } from "./previews.repo.js";

// The instant fallback: template + the user's own recorded name, built on our CPU
// with no provider call. Users never wait with nothing while the sung version queues.
export class PreviewService {
  constructor(
    private readonly previews: PreviewRepo,
    private readonly recordings: RecordingRepo,
    private readonly queues: Queues,
  ) {}

  async create(songId: string, templateId: string, recordingId: string): Promise<string | null> {
    const recordingKey = await this.recordings.storageKey(recordingId);
    if (!recordingKey) return null; // expired or unknown; the sung song still comes
    const previewId = randomUUID();
    await this.previews.create(previewId, songId);
    await this.queues.preview.add("preview", { previewId, templateId, recordingKey }, { jobId: previewId });
    previewsTotal.inc();
    return previewId;
  }

  get(previewId: string) {
    return this.previews.get(previewId);
  }
}
