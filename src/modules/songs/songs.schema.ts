import { z } from "zod";

// Only name + language: the system picks the song (no genre picker by design).
export const createSongBody = z.object({
  name: z.string().min(1).max(80),
  lang: z.string().min(2).max(5),
});

export type CreateSongBody = z.infer<typeof createSongBody>;
