import { ffmpeg } from "../../shared/ffmpeg.js";
import { withTempDir } from "../../shared/tempfile.js";
import type { Piece } from "./plan.js";

const XFADE_MS = 40;
const FMT = "aformat=sample_rates=48000:channel_layouts=stereo";
const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

// Each inner piece is extended by half a crossfade on both sides so the
// crossfades overlap identical audio and total length is preserved.
export async function stitchClip(templatePath: string, clip: Buffer, pieces: Piece[]): Promise<Buffer> {
  return withTempDir(async (_dir, put) => {
    const clipPath = await put("clip.mp3", clip);
    const half = XFADE_MS / 2;
    const tplCount = pieces.filter((p) => p.src === "template").length;
    const clipCount = pieces.length - tplCount;
    const filters = [
      `[0:a]asplit=${tplCount}${Array.from({ length: tplCount }, (_, i) => `[t${i}]`).join("")}`,
      `[1:a]asplit=${clipCount}${Array.from({ length: clipCount }, (_, i) => `[k${i}]`).join("")}`,
    ];
    let ti = 0;
    let ki = 0;
    pieces.forEach((p, i) => {
      const start = p.startMs - (i > 0 ? half : 0);
      const end = p.endMs + (i < pieces.length - 1 ? half : 0);
      const input = p.src === "template" ? `t${ti++}` : `k${ki++}`;
      filters.push(`[${input}]atrim=start=${sec(start)}:end=${sec(end)},asetpts=PTS-STARTPTS,${FMT}[p${i}]`);
    });
    let last = "p0";
    for (let i = 1; i < pieces.length; i++) {
      const out = i === pieces.length - 1 ? "out" : `x${i}`;
      filters.push(`[${last}][p${i}]acrossfade=d=${XFADE_MS / 1000}:c1=tri:c2=tri[${out}]`);
      last = out;
    }
    return ffmpeg(["-i", templatePath, "-i", clipPath, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"]);
  });
}
