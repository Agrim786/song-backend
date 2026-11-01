import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FileStorage } from "./storage.js";

// Dev / single-VPS driver. In production put a CDN in front of /files.
export class LocalStorage implements FileStorage {
  private readonly root: string;
  constructor(
    root: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = resolve(root);
  }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep))
      throw new Error(`bad storage key ${key}`);
    return p;
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  url(key: string) {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/files/${key}`;
  }
}
