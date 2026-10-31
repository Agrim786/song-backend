import type { Job } from "bullmq";
import type { PreviewJobData } from "../../shared/queues.js";
import type { FileStorage } from "../../shared/storage/storage.js";
import type { Catalog } from "../templates/catalog.js";
import type { PreviewRepo } from "./previews.repo.js";
import { stitchPreview } from "./stitch.js";

export function createPreviewProcessor(catalog: Catalog, storage: FileStorage, previews: PreviewRepo) {
  return async (job: Job<PreviewJobData>) => {
    const { previewId, templateId, recordingKey } = job.data;
    const tpl = catalog.get(templateId);
    const audio = await stitchPreview(catalog.audioPath(tpl), await storage.get(recordingKey), tpl);
    const key = `previews/${previewId}.mp3`;
    await storage.put(key, audio, "audio/mpeg");
    await previews.markReady(previewId, storage.url(key));
  };
}
