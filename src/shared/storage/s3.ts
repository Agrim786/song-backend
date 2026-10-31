import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FileStorage } from "./storage.js";

// Works with AWS S3 and Cloudflare R2 (zero egress, good fit for audio).
export class S3Storage implements FileStorage {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    private readonly publicBaseUrl: string,
    cfg: { region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string },
  ) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: Boolean(cfg.endpoint),
      credentials: cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
    });
  }

  async put(key: string, data: Buffer, contentType: string, opts?: { immutable?: boolean }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        CacheControl: opts?.immutable ? "public, max-age=31536000, immutable" : "private, max-age=0",
      }),
    );
  }

  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`empty object ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  url(key: string) {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }
}
