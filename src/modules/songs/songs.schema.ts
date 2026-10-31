import { z } from "zod";

export const createSongBody = z.object({
  name: z.string().min(1).max(80),
  lang: z.string().min(2).max(5),
  genre: z.string().max(30).optional(),
  // From POST /v1/names/transcribe. Enables the instant own-voice preview.
  recordingId: z.uuid().optional(),
});

export type CreateSongBody = z.infer<typeof createSongBody>;
