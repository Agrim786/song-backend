import type { ErrorRequestHandler, RequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) return void res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err instanceof ZodError) return void res.status(400).json({ error: { code: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
  if (err instanceof MulterError) return void res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: { code: "bad_upload", message: err.message } });
  if (err?.type === "entity.too.large") return void res.status(413).json({ error: { code: "too_large", message: "Body too large" } });
  if (err?.type === "entity.parse.failed") return void res.status(400).json({ error: { code: "bad_json", message: "Malformed JSON" } });
  logger.error({ err, reqId: req.id }, "unhandled error");
  res.status(500).json({ error: { code: "internal", message: "Something went wrong", requestId: req.id } });
};
