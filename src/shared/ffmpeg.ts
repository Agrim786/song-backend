import { spawn } from "node:child_process";

// Runs ffmpeg and returns stdout. A hard timeout stops one stuck file from
// pinning a worker slot forever.
export function ffmpeg(args: string[], timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-v", "error", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 500)}`));
    });
  });
}

// Length of an audio file in ms. Used to check the provider returned exactly the
// clip we planned: every splice offset depends on it.
export async function probeDurationMs(path: string): Promise<number> {
  const out = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let s = "";
    proc.stdout.on("data", (d: Buffer) => (s += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(s) : reject(new Error(`ffprobe exited ${code}`)),
    );
  });
  const ms = Number(out.trim()) * 1000;
  if (!Number.isFinite(ms)) throw new Error(`ffprobe: no duration for ${path}`);
  return Math.round(ms);
}
