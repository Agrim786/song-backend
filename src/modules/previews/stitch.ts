import { ffmpeg } from "../../shared/ffmpeg.js";
import { withTempDir } from "../../shared/tempfile.js";
import type { Template } from "../templates/catalog.js";

const FMT = "aformat=sample_rates=48000:channel_layouts=stereo";

// Duck the music under each slot and lay the user's own recording on top.
export async function stitchPreview(templatePath: string, recording: Buffer, t: Template): Promise<Buffer> {
  return withTempDir(async (_dir, put) => {
    const recPath = await put("rec.bin", recording);
    const n = t.slots.length;
    const duck = t.slots.map((s) => `between(t,${s.startMs / 1000},${s.endMs / 1000})`).join("+");
    const filters = [
      `[0:a]${FMT},volume=0.35:enable='${duck}'[bed]`,
      `[1:a]${FMT},silenceremove=start_periods=1:start_threshold=-40dB,highpass=f=80,loudnorm=I=-14:TP=-1.5,asplit=${n}${t.slots.map((_, i) => `[r${i}]`).join("")}`,
      ...t.slots.map((s, i) => `[r${i}]atrim=0:${(s.endMs - s.startMs) / 1000},asetpts=PTS-STARTPTS,adelay=${s.startMs}|${s.startMs}[d${i}]`),
      `[bed]${t.slots.map((_, i) => `[d${i}]`).join("")}amix=inputs=${n + 1}:duration=first:normalize=0[out]`,
    ];
    return ffmpeg(["-i", templatePath, "-i", recPath, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "160k", "-f", "mp3", "pipe:1"]);
  });
}
