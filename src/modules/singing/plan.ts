import type { Template } from "../templates/catalog.js";

// ElevenLabs Music v2 composition-plan shapes (inpainting).
export interface GenerationChunk {
  text: string;
  duration_ms: number;
  positive_styles: string[];
  negative_styles: string[];
  context_adherence: "low" | "medium" | "high";
}
export interface ReferenceChunk {
  song_id: string;
  range: { start_ms: number; end_ms: number };
}
export interface CompositionPlan {
  chunks: Array<GenerationChunk | ReferenceChunk>;
}

// Where each slot lives inside the returned clip.
export interface SlotLayout {
  tplStartMs: number;
  tplEndMs: number;
  ctxMs: number;
  clipOffsetMs: number;
}

export interface Piece {
  src: "template" | "clip";
  startMs: number;
  endMs: number;
}

// Clip mode: per slot we request [context before] + [name, newly sung] + [context after].
// Billing follows returned audio length, so this costs ~45% of a full-song render (measured).
export function buildClipPlan(t: Template, lyricName: string, ctxMs: number) {
  const chunks: CompositionPlan["chunks"] = [];
  const layouts: SlotLayout[] = [];
  let cursor = 0;
  for (const s of t.slots) {
    chunks.push({ song_id: t.providerSongId, range: { start_ms: s.startMs - ctxMs, end_ms: s.startMs } });
    chunks.push({
      text: s.text.replaceAll("{name}", lyricName),
      duration_ms: s.endMs - s.startMs,
      positive_styles: s.styles,
      negative_styles: s.negativeStyles,
      context_adherence: "high",
    });
    chunks.push({ song_id: t.providerSongId, range: { start_ms: s.endMs, end_ms: s.endMs + ctxMs } });
    layouts.push({ tplStartMs: s.startMs, tplEndMs: s.endMs, ctxMs, clipOffsetMs: cursor });
    cursor += ctxMs + (s.endMs - s.startMs) + ctxMs;
  }
  return { plan: { chunks } satisfies CompositionPlan, layouts, clipDurationMs: cursor };
}

// Cut points sit in the middle of each context window, where template and clip
// carry the same music, so the crossfade is inaudible. Output length == template length.
export function splicePieces(layouts: SlotLayout[], templateDurationMs: number): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const l of layouts) {
    const half = l.ctxMs / 2;
    const slotMs = l.tplEndMs - l.tplStartMs;
    pieces.push({ src: "template", startMs: cursor, endMs: l.tplStartMs - half });
    pieces.push({ src: "clip", startMs: l.clipOffsetMs + half, endMs: l.clipOffsetMs + l.ctxMs + slotMs + half });
    cursor = l.tplEndMs + half;
  }
  pieces.push({ src: "template", startMs: cursor, endMs: templateDurationMs });
  return pieces;
}
