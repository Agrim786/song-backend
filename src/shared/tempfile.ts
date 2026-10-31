import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Gives a scratch dir and always cleans it up, even when ffmpeg fails.
export async function withTempDir<T>(fn: (dir: string, put: (name: string, data: Buffer) => Promise<string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "song-"));
  try {
    return await fn(dir, async (name, data) => {
      const p = join(dir, name);
      await writeFile(p, data);
      return p;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
