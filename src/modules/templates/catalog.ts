import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const slotSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int(),
  // Lyric for this slot. Must contain {name}; everything else is sung as written.
  text: z.string().includes("{name}"),
  styles: z.array(z.string()).min(1),
  negativeStyles: z.array(z.string()).default([]),
});

const templateSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  // Bump when the audio changes so old cached songs are never mixed with new audio.
  version: z.number().int().min(1),
  lang: z.string(),
  genre: z.string(),
  // Part of the small set used during spikes so identical names collapse onto one job.
  spike: z.boolean().default(false),
  // Who sings it. Each style exists in both voices; the picker mixes them.
  voice: z.enum(["male", "female"]).optional(),
  providerSongId: z.string(),
  modelId: z.string().default("music_v2_5"),
  audioFile: z.string(),
  durationMs: z.number().int().positive(),
  slots: z.array(slotSchema).min(1),
});

export type Template = z.infer<typeof templateSchema>;
export type Slot = Template["slots"][number];

// How the pool remembers "this name is ready in this template". Includes the
// version so a re-recorded template never counts songs made from the old audio.
export const templateRef = (t: Pick<Template, "id" | "version">) => `${t.id}:v${t.version}`;

// Provider rule (ElevenLabs inpainting): generated chunks are 3-120 s.
const MIN_SLOT_MS = 3000;

function validateLayout(t: Template, ctxMs: number): string | null {
  let prevEnd = -Infinity;
  for (const s of t.slots) {
    if (s.endMs - s.startMs < MIN_SLOT_MS) return `slot ${s.startMs} is shorter than ${MIN_SLOT_MS}ms`;
    if (s.startMs - ctxMs < 0 || s.endMs + ctxMs > t.durationMs) return `slot ${s.startMs} has no room for ${ctxMs}ms context`;
    if (s.startMs - ctxMs < prevEnd) return `slot ${s.startMs} context overlaps the previous slot`;
    prevEnd = s.endMs + ctxMs;
  }
  return null;
}

export class Catalog {
  private readonly byId = new Map<string, Template>();
  private readonly byProvider = new Map<string, Template>();

  constructor(
    readonly dir: string,
    templates: Template[],
  ) {
    for (const t of templates) {
      this.byId.set(t.id, t);
      this.byProvider.set(t.providerSongId, t);
    }
  }

  get size() {
    return this.byId.size;
  }

  get(id: string): Template {
    const t = this.byId.get(id);
    if (!t) throw new Error(`unknown template ${id}`);
    return t;
  }

  byAudioFile(file: string): Template | undefined {
    return [...this.byId.values()].find((t) => t.audioFile === file);
  }

  tryGet(id: string): Template | undefined {
    return this.byId.get(id);
  }

  // Languages we can sing in = languages that have templates. Adding a language
  // means adding its templates, nothing else.
  langs(): string[] {
    return [...new Set([...this.byId.values()].map((t) => t.lang))].sort();
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  // The template's first name spot: the app plays the template from 0 and must have
  // the sung song by this moment for the swap to be seamless.
  firstNameAtMs(t: Template): number {
    return t.slots[0]!.startMs;
  }

  forLang(lang: string, genre?: string): Template[] {
    return [...this.byId.values()].filter((t) => t.lang === lang && (!genre || t.genre === genre));
  }

  byProviderSongId(id: string): Template | undefined {
    return this.byProvider.get(id);
  }

  audioPath(t: Template): string {
    return join(this.dir, t.audioFile);
  }
}

export async function loadCatalog(dir: string, ctxMs: number): Promise<Catalog> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const templates: Template[] = [];
  for (const f of files) {
    const parsed = templateSchema.safeParse(JSON.parse(await readFile(join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`template ${f}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const t = parsed.data;
    t.slots.sort((a, b) => a.startMs - b.startMs);
    const layoutError = validateLayout(t, ctxMs);
    if (layoutError) throw new Error(`template ${t.id}: ${layoutError}`);
    await stat(join(dir, t.audioFile)); // throws if the audio is missing
    templates.push(t);
  }
  if (!templates.length) throw new Error(`no templates in ${dir}. Run: npm run import-template`);
  return new Catalog(dir, templates);
}
