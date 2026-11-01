import { Router } from "express";
import { AppError } from "../../shared/errors.js";
import { createSongBody } from "./songs.schema.js";
import type { SongService, SongView } from "./songs.service.js";

// Tells well-behaved clients when to ask again, so waiting users don't poll every second.
const hint = (res: { set: (k: string, v: string) => unknown }, v: SongView) => {
  if (v.pollAfterSeconds) res.set("Retry-After", String(v.pollAfterSeconds));
};

export function songRoutes(songs: SongService) {
  const r = Router();

  // 200 if the song already exists (instant), 202 if it is queued.
  r.post("/songs", async (req, res) => {
    const body = createSongBody.parse(req.body);
    const idem = req.get("idempotency-key")?.slice(0, 100);
    const result = await songs.create(body, idem);
    hint(res, result);
    res.status(result.status === "ready" ? 200 : 202).json(result);
  });

  r.get("/songs/:id", async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id))
      throw new AppError(400, "bad_id", "Invalid song id");
    const view = await songs.view(req.params.id);
    hint(res, view);
    res.json(view);
  });

  return r;
}
