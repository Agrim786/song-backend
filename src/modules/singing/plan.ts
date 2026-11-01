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
    chunks.push({
      song_id: t.providerSongId,
      range: { start_ms: s.startMs - ctxMs, end_ms: s.startMs },
    });
    chunks.push({
      text: s.text.replaceAll("{name}", lyricName),
      duration_ms: s.endMs - s.startMs,
      positive_styles: s.styles,
      negative_styles: s.negativeStyles,
      context_adherence: "high",
    });
    chunks.push({
      song_id: t.providerSongId,
      range: { start_ms: s.endMs, end_ms: s.endMs + ctxMs },
    });
    layouts.push({
      tplStartMs: s.startMs,
      tplEndMs: s.endMs,
      ctxMs,
      clipOffsetMs: cursor,
    });
    cursor += ctxMs + (s.endMs - s.startMs) + ctxMs;
  }
  return {
    plan: { chunks } satisfies CompositionPlan,
    layouts,
    clipDurationMs: cursor,
  };
}

// ElevenLabs rejects plans with more than 30 chunks (measured: 422 "at most 30 items").
export const MAX_PLAN_CHUNKS = 30;

// How many names fit in one provider call for this template: each slot costs
// 3 chunks (context before, the name, context after).
export const maxNamesPerCall = (t: Template) =>
  Math.max(1, Math.floor(MAX_PLAN_CHUNKS / (3 * t.slots.length)));

// Several people's names in ONE provider call, back to back. Measured on the real
// API: 5 names take ~7 s vs ~3.4 s for 1, so throughput per slot is ~2.3x, at the
// same cost per name (billing is per second of audio returned). Each person's
// layouts point into the shared clip, so splicePieces/stitchClip work unchanged.
export function buildBatchPlan(
  t: Template,
  lyricNames: string[],
  ctxMs: number,
) {
  if (lyricNames.length > maxNamesPerCall(t))
    throw new Error(
      `batch of ${lyricNames.length} exceeds ${maxNamesPerCall(t)} for ${t.id}`,
    );
  const chunks: CompositionPlan["chunks"] = [];
  const people: SlotLayout[][] = [];
  let offset = 0;
  for (const name of lyricNames) {
    const one = buildClipPlan(t, name, ctxMs);
    chunks.push(...one.plan.chunks);
    people.push(
      one.layouts.map((l) => ({ ...l, clipOffsetMs: l.clipOffsetMs + offset })),
    );
    offset += one.clipDurationMs;
  }
  return {
    plan: { chunks } satisfies CompositionPlan,
    people,
    clipDurationMs: offset,
  };
}

// Cut points sit in the middle of each context window, where template and clip
// carry the same music, so the crossfade is inaudible. Output length == template length.
export function splicePieces(
  layouts: SlotLayout[],
  templateDurationMs: number,
): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const l of layouts) {
    const half = l.ctxMs / 2;
    const slotMs = l.tplEndMs - l.tplStartMs;
    pieces.push({
      src: "template",
      startMs: cursor,
      endMs: l.tplStartMs - half,
    });
    pieces.push({
      src: "clip",
      startMs: l.clipOffsetMs + half,
      endMs: l.clipOffsetMs + l.ctxMs + slotMs + half,
    });
    cursor = l.tplEndMs + half;
  }
  pieces.push({ src: "template", startMs: cursor, endMs: templateDurationMs });
  return pieces;
}
