import type { Redis } from "ioredis";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import type { Catalog } from "../templates/catalog.js";
import { normalizeName } from "./normalize.js";
import { sttAllowed } from "./stt/stt.limiter.js";
import type { SpeechToText } from "./stt/stt.js";

// A name is ~1-3 s of audio; 1 MB is generous and stops abuse. Kept in memory only:
// the recording goes to speech-to-text and is never stored.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1_000_000, files: 1 },
});
const fields = z.object({
  lang: z.string().optional(),
  mockName: z.string().max(80).optional(),
});

// The app asks for the name first and the song language after, so lang is
// optional: without it the speech-to-text provider detects the spoken language.
export function nameRoutes(redis: Redis, catalog: Catalog, stt: SpeechToText) {
  const r = Router();

  r.post("/names/transcribe", upload.single("audio"), async (req, res) => {
    const { lang, mockName } = fields.parse(req.body);
    if (lang && !catalog.langs().includes(lang))
      throw new AppError(400, "unsupported_language", "Unsupported lang");
    const file = req.file;
    if (!file || !file.mimetype.startsWith("audio/"))
      throw new AppError(
        400,
        "no_audio",
        "Send the recording as multipart field 'audio'",
      );

    let heard: string | null = null;
    if (await sttAllowed(redis, env.STT_MAX_PER_MINUTE)) {
      heard = await stt.transcribe(file.buffer, file.mimetype, lang, mockName);
    }
    const name = heard ? normalizeName(heard) : null;
    // The app shows "Did we hear <name>?" and lets the user edit before generating.
    res.json({ name: name?.lyric ?? null, needsTyping: !name });
  });

  // Languages the app should offer: exactly those with song templates.
  r.get(
    "/languages",
    (_req, res) => void res.json({ languages: catalog.langs() }),
  );

  return r;
}
