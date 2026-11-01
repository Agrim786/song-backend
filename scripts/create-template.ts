// Generates a song template with ElevenLabs and adds it to the catalog.
//   npx tsx --env-file=.env scripts/create-template.ts --genre love
//   npx tsx --env-file=.env scripts/create-template.ts --genre pop --spike
//   npx tsx --env-file=.env scripts/create-template.ts --genre love --dry-run   (print plan, no API call)
//   npx tsx --env-file=.env scripts/create-template.ts --lang mr --genre love --spike
//
// Each template: instrumental intro, name hook, verse, name hook, instrumental outro (27 s).
// The hooks are sung with a neutral placeholder word that fits the genre. Kept sections
// are copied exactly into every user's song, so if the placeholder leaks into the verse
// it still sounds like a normal lyric. Listen once before using a template.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface Preset {
  placeholder: string;
  // Spellings speech-to-text may return for the placeholder (Devanagari + Roman).
  aliases: string[];
  hook: string; // must contain {name}
  verse: string;
  styles: string[];
  hookStyles: string[];
}

// Presets per language, then per genre. Add a language = add its block here, then
// generate its templates; the API offers it automatically (GET /v1/languages).
// Lyrics for languages other than Hindi need a native speaker's check before launch.
// The placeholder must be a natural lyric word, never a common name: kept sections
// are copied into every song, so a leaked placeholder must still sound normal.
const PRESETS: Record<string, Record<string, Preset>> = {
  hi: {
    love: {
      placeholder: "सनम",
      aliases: ["सनम", "sanam"],
      hook: "[Hook]\nओ {name}, दिल कहे तेरा नाम",
      verse: "[Verse]\nतेरी बातों में खो जाऊँ\nहर पल तुझको ही गाऊँ",
      styles: ["romantic bollywood ballad", "soft piano", "strings", "acoustic guitar", "emotional", "slow tempo", "80 bpm", "male vocals"],
      hookStyles: ["romantic hook", "warm male vocals", "hindi vocals", "soft piano"],
    },
    pop: {
      placeholder: "यारा",
      aliases: ["यारा", "यार", "yaara", "yara", "yaar"],
      hook: "[Hook]\nहे {name}, तू है सबसे ख़ास",
      verse: "[Verse]\nचल आज ये रात हमारी है\nहर धड़कन में यारी है",
      styles: ["upbeat hindi pop", "synths", "punchy drums", "bass", "catchy", "dance", "118 bpm", "female vocals"],
      hookStyles: ["catchy pop hook", "energetic female vocals", "hindi vocals", "synths"],
    },
    bhangra: {
      placeholder: "यारा",
      aliases: ["यारा", "यार", "yaara", "yara", "yaar"],
      hook: "[Hook]\nओ {name}, नच ले आज",
      verse: "[Verse]\nढोल बजे ते दिल झूमे\nसारी दुनिया संग घूमे",
      styles: ["punjabi bhangra", "dhol", "tumbi", "high energy", "festive", "celebration", "125 bpm", "male vocals"],
      hookStyles: ["bhangra hook", "powerful male vocals", "punjabi style vocals", "dhol"],
    },
    sufi: {
      placeholder: "यारा",
      aliases: ["यारा", "यार", "yaara", "yara", "yaar"],
      hook: "[Hook]\n{name}, तू ही मेरी इबादत",
      verse: "[Verse]\nरूह में तेरा नूर बसे\nहर साँस में तू ही हँसे",
      styles: ["sufi", "harmonium", "tabla", "soulful", "spiritual", "qawwali influence", "90 bpm", "male vocals"],
      hookStyles: ["soulful sufi hook", "deep male vocals", "hindi vocals", "harmonium"],
    },
    lofi: {
      placeholder: "दोस्त",
      aliases: ["दोस्त", "dost", "dosth"],
      hook: "[Hook]\n{name}, बस तू ही तू",
      verse: "[Verse]\nधीमी सी ये शाम है\nलबों पे तेरा नाम है",
      styles: ["hindi lofi", "chill", "mellow keys", "vinyl crackle", "soft beats", "relaxed", "75 bpm", "female vocals"],
      hookStyles: ["dreamy hook", "soft female vocals", "hindi vocals", "mellow keys"],
    },
  },
  mr: {
    love: {
      placeholder: "सजणा",
      aliases: ["सजणा", "सजना", "sajana", "sajna"],
      hook: "[Hook]\nअरे {name}, तूच माझं गाणं",
      verse: "[Verse]\nतुझ्या हसण्यात हरवलो मी\nप्रत्येक क्षणी तुलाच शोधतो मी",
      styles: ["romantic marathi song", "soft piano", "strings", "acoustic guitar", "emotional", "slow tempo", "80 bpm", "male vocals"],
      hookStyles: ["romantic hook", "warm male vocals", "marathi vocals", "soft piano"],
    },
  },
  gu: {
    garba: {
      placeholder: "સાજન",
      aliases: ["સાજન", "sajan", "saajan"],
      hook: "[Hook]\nઓ {name}, તું છે ખાસ",
      verse: "[Verse]\nઢોલ વાગે ને મન નાચે\nઆજે રાત આપણી સાથે",
      styles: ["gujarati garba", "dhol", "dandiya beats", "festive", "upbeat", "120 bpm", "female vocals"],
      hookStyles: ["catchy garba hook", "energetic female vocals", "gujarati vocals", "dhol"],
    },
  },
  pa: {
    bhangra: {
      placeholder: "ਸੱਜਣਾ",
      aliases: ["ਸੱਜਣਾ", "ਸਜਣਾ", "sajjna", "sajna"],
      hook: "[Hook]\nਓ {name}, ਨੱਚ ਲੈ ਅੱਜ",
      verse: "[Verse]\nਢੋਲ ਵੱਜੇ ਤੇ ਦਿਲ ਝੂਮੇ\nਸਾਰੀ ਦੁਨੀਆ ਨਾਲ ਘੁੰਮੇ",
      styles: ["punjabi bhangra", "dhol", "tumbi", "high energy", "festive", "celebration", "125 bpm", "male vocals"],
      hookStyles: ["bhangra hook", "powerful male vocals", "punjabi vocals", "dhol"],
    },
  },
  bn: {
    love: {
      placeholder: "বন্ধু",
      aliases: ["বন্ধু", "bondhu", "bandhu"],
      hook: "[Hook]\nও {name}, তুমি আমার গান",
      verse: "[Verse]\nতোমার হাসিতে আলো জ্বলে\nমন আমার তোমায় বলে",
      styles: ["bengali romantic song", "acoustic guitar", "flute", "soft", "melodic", "85 bpm", "male vocals"],
      hookStyles: ["romantic hook", "warm male vocals", "bengali vocals", "acoustic guitar"],
    },
  },
};

const { values } = parseArgs({
  options: {
    genre: { type: "string" },
    id: { type: "string" },
    lang: { type: "string", default: "hi" },
    spike: { type: "boolean", default: false },
    model: { type: "string", default: "music_v2_5" },
    out: { type: "string", default: "./templates" },
    "dry-run": { type: "boolean", default: false },
    "max-attempts": { type: "string", default: "4" },
    "skip-check": { type: "boolean", default: false },
  },
});
const byLang = PRESETS[values.lang!];
const found = byLang && values.genre ? byLang[values.genre] : undefined;
if (!found) {
  const options = Object.entries(PRESETS).map(([l, g]) => `--lang ${l} --genre ${Object.keys(g).join("|")}`).join("\n  ");
  console.error(`usage (one of):\n  ${options}\n  [--id hi-love-01] [--spike] [--dry-run]`);
  process.exit(1);
}
const preset: Preset = found;

const id = values.id ?? `${values.lang}-${values.genre}-01`;
// 6 s intro | 4 s hook | 8 s verse | 4 s hook | 5 s outro = 27 s. Hooks at 6-10 s and 18-22 s.
const sections = [
  { ms: 6000, hook: false, text: "[Intro]\n{instrumental}", styles: [...preset.styles.filter((s) => !s.includes("vocals")), "instrumental intro"], neg: ["vocals", "singing", "spoken words"] },
  { ms: 4000, hook: true, text: preset.hook, styles: preset.hookStyles, neg: ["whisper", "spoken word"] },
  { ms: 8000, hook: false, text: preset.verse, styles: preset.styles, neg: ["ad-libs", "background chants", "call and response", "repeating the hook"] },
  { ms: 4000, hook: true, text: preset.hook, styles: preset.hookStyles, neg: ["whisper", "spoken word"] },
  { ms: 5000, hook: false, text: "[Outro]\n{instrumental}", styles: [...preset.styles.filter((s) => !s.includes("vocals")), "instrumental"], neg: ["vocals", "singing", "spoken words"] },
];

const plan = {
  chunks: sections.map((s) => ({
    text: s.text.replaceAll("{name}", preset.placeholder),
    duration_ms: s.ms,
    positive_styles: s.styles,
    negative_styles: s.neg,
    context_adherence: "high",
  })),
};

let cursor = 0;
const slots: { startMs: number; endMs: number; text: string; styles: string[]; negativeStyles: string[] }[] = [];
for (const s of sections) {
  if (s.hook) slots.push({ startMs: cursor, endMs: cursor + s.ms, text: s.text, styles: s.styles, negativeStyles: s.neg });
  cursor += s.ms;
}

if (values["dry-run"]) {
  console.log(JSON.stringify({ id, plan, slots }, null, 2));
  process.exit(0);
}

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("Set ELEVENLABS_API_KEY in .env");
  process.exit(1);
}

const TOLERANCE_S = 0.3;
const norm = (t: string) => t.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
const aliases = preset.aliases.map(norm);

async function generate(seed: number): Promise<{ audio: Buffer; songId: string }> {
  const res = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: { "xi-api-key": key!, "content-type": "application/json" },
    body: JSON.stringify({ composition_plan: plan, model_id: values.model, store_for_inpainting: true, seed }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`music HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const songId = res.headers.get("song-id");
  if (!songId) throw new Error("no song-id header (not stored for inpainting)");
  return { audio: Buffer.from(await res.arrayBuffer()), songId };
}

interface Word { text: string; start: number; end: number; type: string }

// Transcribe the template with word timestamps, biased toward the placeholder.
async function transcribe(audio: Buffer): Promise<Word[]> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "template.mp3");
  form.append("model_id", "scribe_v2");
  form.append("timestamps_granularity", "word");
  form.append("language_code", values.lang!);
  for (const k of preset.aliases) form.append("keyterms", k);
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key! },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`speech-to-text HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { words?: Word[] }).words ?? [];
}

// Exact word match, so lookalikes such as "यारी" in a verse are not flagged.
// Kept sections are copied into every user's song, so the placeholder may only be
// heard inside the name slots, and must be heard in each of them.
function check(words: Word[]) {
  const hits = words.filter((w) => w.type === "word" && aliases.includes(norm(w.text)));
  const inSlot = (w: Word) => slots.findIndex((s) => w.start >= s.startMs / 1000 - TOLERANCE_S && w.end <= s.endMs / 1000 + TOLERANCE_S);
  const leaks = hits.filter((w) => inSlot(w) === -1).map((w) => `${w.text}@${w.start.toFixed(1)}s`);
  const missing = slots.filter((_, i) => !hits.some((w) => inSlot(w) === i)).map((s) => `${s.startMs / 1000}-${s.endMs / 1000}s`);
  return { leaks, missing, heard: words.filter((w) => w.type === "word").map((w) => w.text).join(" ") };
}

const maxAttempts = Number(values["max-attempts"]);
let accepted: { audio: Buffer; songId: string; seed: number; report: ReturnType<typeof check> | null } | null = null;
for (let attempt = 1; attempt <= maxAttempts && !accepted; attempt++) {
  const seed = Math.floor(Math.random() * 2_000_000_000);
  process.stdout.write(`attempt ${attempt}/${maxAttempts}: generating ${id} (seed ${seed}) ... `);
  const { audio, songId } = await generate(seed);
  if (values["skip-check"]) {
    accepted = { audio, songId, seed, report: null };
    console.log("saved (check skipped)");
    break;
  }
  const report = check(await transcribe(audio));
  if (!report.leaks.length && !report.missing.length) {
    accepted = { audio, songId, seed, report };
    console.log("clean");
  } else {
    console.log(`rejected (leaks: ${report.leaks.join(", ") || "none"}; missing in slots: ${report.missing.join(", ") || "none"})`);
    console.log(`  heard: ${report.heard.slice(0, 200)}`);
  }
}
if (!accepted) {
  console.error(`no clean take after ${maxAttempts} attempts. Try again, or change the preset (verse lyrics / placeholder).`);
  process.exit(1);
}

const audioFile = `${id}.mp3`;
await writeFile(join(values.out, audioFile), accepted.audio);
const entry = {
  id,
  version: 1,
  lang: values.lang,
  genre: values.genre,
  spike: values.spike,
  providerSongId: accepted.songId,
  modelId: values.model,
  audioFile,
  durationMs: cursor,
  slots,
};
await writeFile(join(values.out, `${id}.json`), JSON.stringify(entry, null, 2) + "\n");
console.log(`saved ${values.out}/${id}.json + ${audioFile}`);
if (accepted.report) console.log(`heard: ${accepted.report.heard.slice(0, 200)}`);
console.log(`still listen once: open ${values.out}/${audioFile}  ("${preset.placeholder}" only at 6-10s and 18-22s)`);