// Scores intelligibility: speech-to-text on the first name spot of each song.
// node --env-file=<.env> score.mjs <dir> [<dir> ...]
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";

const KEY = process.env.ELEVENLABS_API_KEY;
const norm = (s) => s.normalize("NFC").replace(/[^\p{L}\p{M}]/gu, "");
function lev(a, b) {
  a = [...a];
  b = [...b];
  const d = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}

async function heard(file) {
  const clip = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "6.9",
    "-t",
    "3.5",
    "-i",
    file,
    "-f",
    "mp3",
    "pipe:1",
  ]);
  const f = new FormData();
  f.append("file", new Blob([clip], { type: "audio/mpeg" }), "c.mp3");
  f.append("model_id", "scribe_v2");
  f.append("language_code", "hi");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": KEY },
    body: f,
  });
  const t = (await r.json()).text ?? "";
  // The name sits between "हे" and "तू" in this hook.
  const m = t.match(/हे\s*(.*?)\s*तू/);
  return (m ? m[1] : t).trim();
}

for (const dir of process.argv.slice(2)) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".mp3"));
  const rows = await Promise.all(
    files.map(async (f) => {
      const name = basename(f, ".mp3").replace(/^.*-/, "");
      const h = await heard(join(dir, f));
      const sim =
        1 -
        lev(norm(name), norm(h)) /
          Math.max([...norm(name)].length, [...norm(h)].length, 1);
      return { name, h, sim };
    }),
  );
  const exact = rows.filter((r) => r.sim === 1).length,
    close = rows.filter((r) => r.sim >= 0.75).length;
  const avg = rows.reduce((a, r) => a + r.sim, 0) / rows.length;
  console.log(
    `\n${basename(dir)}: exact ${exact}/${rows.length}, close ${close}/${rows.length}, avg similarity ${(avg * 100).toFixed(0)}%`,
  );
  console.log(
    "  " +
      rows
        .map(
          (r) =>
            `${r.name}→${r.h || "∅"}${r.sim === 1 ? "✓" : r.sim >= 0.75 ? "~" : "✗"}`,
        )
        .join("  "),
  );
}
