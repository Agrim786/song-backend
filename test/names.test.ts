import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeName } from "../src/modules/names/normalize.js";
import { nameKeyOf } from "../src/modules/songs/songs.ids.js";

test("latin names: case-insensitive key, Title Case lyric", () => {
  assert.deepEqual(normalizeName("  rAHUL  "), {
    lyric: "Rahul",
    key: "rahul",
  });
  assert.equal(
    nameKeyOf("hi", normalizeName("RAHUL")!.key),
    nameKeyOf("hi", normalizeName("rahul")!.key),
  );
});

test("devanagari stays as-is and nukta forms unify", () => {
  // ज़ as one precomposed char vs ज + nukta must be the same cache key.
  assert.equal(
    normalizeName("\u095Bोया")!.key,
    normalizeName("\u091C\u093Cोया")!.key,
  );
  assert.equal(normalizeName("ध्रुव")!.lyric, "ध्रुव");
});

test("lyric injection characters are stripped, junk rejected", () => {
  assert.equal(
    normalizeName("[Verse] Rahul {whisper}")!.lyric,
    "Verse Rahul Whisper",
  );
  assert.equal(normalizeName("1234 !!!"), null);
  assert.equal(normalizeName("a".repeat(41)), null);
});

test("blocklist: catches variants and splits, never blocks real names that contain a short word", async () => {
  const { isBlockedName } = await import("../src/modules/names/blocklist.js");
  const key = (s: string) => normalizeName(s)!.key;
  for (const bad of [
    "Pehenchod",
    "Behen Chod",
    "bhen-chod",
    "Madarchod",
    "Chutiya",
  ])
    assert.equal(isBlockedName(key(bad)), true, bad);
  for (const ok of [
    "Priya",
    "Gandhi",
    "Chodavarapu",
    "Randi",
    "Dikshit",
    "Shital",
  ])
    assert.equal(isBlockedName(key(ok)), false, ok);
});
