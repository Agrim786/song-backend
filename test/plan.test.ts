import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClipPlan, splicePieces } from "../src/modules/singing/plan.js";
import type { Template } from "../src/modules/templates/catalog.js";

// Wrong offsets here would put the name in the wrong place for every user,
// silently. So the splice math is pinned down.
const tpl: Template = {
  id: "t",
  version: 1,
  lang: "hi",
  genre: "birthday",
  spike: true,
  providerSongId: "SONG",
  modelId: "music_v2_5",
  audioFile: "t.mp3",
  durationMs: 27_000,
  slots: [
    { startMs: 6000, endMs: 10_000, text: "[Hook]\nजन्मदिन मुबारक {name}!", styles: ["x"], negativeStyles: [] },
    { startMs: 18_000, endMs: 22_000, text: "[Hook]\nजन्मदिन मुबारक {name}!", styles: ["x"], negativeStyles: [] },
  ],
};

test("clip plan asks only for slots plus context, with the name in the lyric", () => {
  const { plan, clipDurationMs } = buildClipPlan(tpl, "ध्रुव", 1000);
  assert.equal(plan.chunks.length, 6);
  assert.equal(clipDurationMs, 12_000);
  assert.deepEqual(plan.chunks[0], { song_id: "SONG", range: { start_ms: 5000, end_ms: 6000 } });
  assert.equal((plan.chunks[1] as { text: string }).text, "[Hook]\nजन्मदिन मुबारक ध्रुव!");
  assert.deepEqual(plan.chunks[5], { song_id: "SONG", range: { start_ms: 22_000, end_ms: 23_000 } });
});

test("splice keeps total length and cuts mid-context", () => {
  const { layouts } = buildClipPlan(tpl, "x", 1000);
  const pieces = splicePieces(layouts, tpl.durationMs);
  const total = pieces.reduce((a, p) => a + (p.endMs - p.startMs), 0);
  assert.equal(total, tpl.durationMs);
  assert.deepEqual(pieces[0], { src: "template", startMs: 0, endMs: 5500 });
  assert.deepEqual(pieces[1], { src: "clip", startMs: 500, endMs: 5500 });
  assert.deepEqual(pieces[2], { src: "template", startMs: 10_500, endMs: 17_500 });
  assert.deepEqual(pieces[3], { src: "clip", startMs: 6500, endMs: 11_500 });
  assert.deepEqual(pieces[4], { src: "template", startMs: 22_500, endMs: 27_000 });
});
