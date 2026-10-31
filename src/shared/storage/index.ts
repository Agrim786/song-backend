import { env } from "../../config/env.js";
import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";
import type { FileStorage } from "./storage.js";

export function createStorage(): FileStorage {
  if (env.STORAGE_DRIVER === "s3") {
    return new S3Storage(env.S3_BUCKET!, env.S3_PUBLIC_BASE_URL!, {
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }
  return new LocalStorage(env.LOCAL_STORAGE_DIR, env.PUBLIC_BASE_URL);
}
