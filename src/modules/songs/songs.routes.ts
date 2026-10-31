import { Router } from "express";
import { AppError } from "../../shared/errors.js";
import type { PreviewService } from "../previews/previews.service.js";
import { createSongBody } from "./songs.schema.js";
import type { SongService } from "./songs.service.js";

export function songRoutes(songs: SongService, previews: PreviewService) {
  const r = Router();

  // 200 if the song already exists (instant), 202 if it is queued.
  r.post("/songs", async (req, res) => {
    const body = createSongBody.parse(req.body);
    const idem = req.get("idempotency-key")?.slice(0, 100);
    const result = await songs.create(body, idem);
    res.status(result.status === "ready" ? 200 : 202).json(result);
  });

  r.get("/songs/:id", async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) throw new AppError(400, "bad_id", "Invalid song id");
    res.json(await songs.view(req.params.id));
  });

  r.get("/previews/:id", async (req, res) => {
    const p = await previews.get(req.params.id);
    if (!p) throw new AppError(404, "not_found", "Unknown preview");
    res.json(p);
  });

  return r;
}
