import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env, supportedLangs } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { normalizeName } from "./normalize.js";
import type { FileStorage } from "../../shared/storage/storage.js";
import { sttAllowed } from "./stt/stt.limiter.js";
import type { RecordingRepo } from "./recordings.repo.js";
import type { SpeechToText } from "./stt/stt.js";

// A name is ~1-3 s of audio; 1 MB is generous and stops abuse.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1_000_000, files: 1 } });
const fields = z.object({ lang: z.string(), mockName: z.string().max(80).optional() });

export function recordingRoutes(redis: Redis, storage: FileStorage, recordings: RecordingRepo, stt: SpeechToText) {
  const r = Router();

  r.post("/names/transcribe", upload.single("audio"), async (req, res) => {
    const { lang, mockName } = fields.parse(req.body);
    if (!supportedLangs.includes(lang)) throw new AppError(400, "unsupported_language", "Unsupported lang");
    const file = req.file;
    if (!file || !file.mimetype.startsWith("audio/")) throw new AppError(400, "no_audio", "Send the recording as multipart field 'audio'");

    const recordingId = randomUUID();
    const key = `recordings/${recordingId}`;
    await storage.put(key, file.buffer, file.mimetype);
    await recordings.save(recordingId, key, lang);

    let heard: string | null = null;
    if (await sttAllowed(redis, env.STT_MAX_PER_MINUTE)) {
      heard = await stt.transcribe(file.buffer, file.mimetype, lang, mockName);
    }
    const name = heard ? normalizeName(heard) : null;
    // The app shows "Did we hear <name>?" and lets the user edit before generating.
    res.json({ recordingId, name: name?.lyric ?? null, needsTyping: !name });
  });

  return r;
}
