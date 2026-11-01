import { createHash } from "node:crypto";

export const sha256 = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");
