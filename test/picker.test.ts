import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog, type Template } from "../src/modules/templates/catalog.js";
import { pickTemplate } from "../src/modules/templates/picker.js";

const mk = (id: string, spike = false): Template => ({
  id, version: 1, lang: "hi", genre: "g", spike, providerSongId: id, modelId: "m", audioFile: `${id}.mp3`, durationMs: 27_000,
  slots: [{ startMs: 6000, endMs: 10_000, text: "{name}", styles: ["x"], negativeStyles: [] }],
});
const catalog = new Catalog(".", [mk("a"), mk("b", true), mk("c"), mk("d")]);
const deps = (eta: number, ready: string[] = []) => ({
  catalog, spikeEtaSeconds: 30, random: () => 0, etaSeconds: async () => eta, readyTemplateIds: async () => ready,
});

test("calm: any template", async () => {
  assert.equal((await pickTemplate(deps(5), { lang: "hi", nameKey: "k" })).reason, "random");
});

test("busy: prefer a song that already exists for this name", async () => {
  const r = await pickTemplate(deps(120, ["c"]), { lang: "hi", nameKey: "k" });
  assert.deepEqual([r.reason, r.template.id], ["pool", "c"]);
});

test("busy and nothing cached: spike set only", async () => {
  const r = await pickTemplate(deps(120), { lang: "hi", nameKey: "k" });
  assert.deepEqual([r.reason, r.template.id], ["spike", "b"]);
});
