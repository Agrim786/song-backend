// Turns a template made with name_song_lab_v3.py into a catalog entry.
//   npm run import-template -- --from ../lab_v3 --id hi-birthday-01 --genre birthday --spike
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    id: { type: "string" },
    genre: { type: "string", default: "general" },
    spike: { type: "boolean", default: false },
    version: { type: "string", default: "1" },
    out: { type: "string", default: "./templates" },
  },
});
if (!values.from || !values.id) {
  console.error("usage: npm run import-template -- --from <lab dir> --id <template-id> [--genre birthday] [--spike]");
  process.exit(1);
}

interface LabSection {
  hook: boolean;
  start: number;
  end: number;
  styles: string[];
  neg?: string[];
}
interface LabTemplate {
  song_id: string;
  lang: string;
  model: string;
  total_ms: number;
  hook_text: string;
  audio_file: string;
  sections: LabSection[];
}

const lab = JSON.parse(await readFile(join(values.from, "template.json"), "utf8")) as LabTemplate;
const audioFile = `${values.id}.mp3`;
const entry = {
  id: values.id,
  version: Number(values.version),
  lang: lab.lang,
  genre: values.genre,
  spike: values.spike,
  providerSongId: lab.song_id,
  modelId: lab.model,
  audioFile,
  durationMs: lab.total_ms,
  slots: lab.sections
    .filter((s) => s.hook)
    .map((s) => ({ startMs: s.start, endMs: s.end, text: lab.hook_text, styles: s.styles, negativeStyles: s.neg ?? [] })),
};
await copyFile(join(values.from, lab.audio_file), join(values.out, audioFile));
await writeFile(join(values.out, `${values.id}.json`), JSON.stringify(entry, null, 2) + "\n");
console.log(`imported ${values.id}: ${entry.slots.length} slots, ${entry.durationMs} ms -> ${values.out}`);
