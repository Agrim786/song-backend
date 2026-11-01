import { type Catalog, type Template, templateRef } from "./catalog.js";

export type PickReason = "random" | "pool" | "spike";

export interface PickerDeps {
  catalog: Catalog;
  // templateRef()s ("id:vN") that already have a finished song for this name.
  readyTemplateRefs: (lang: string, nameKey: string) => Promise<string[]>;
  etaSeconds: () => Promise<number>;
  spikeEtaSeconds: number;
  random?: () => number;
}

const pickOne = <T>(items: T[], rnd: () => number): T =>
  items[Math.floor(rnd() * items.length)] as T;

// Calm: full variety. Busy: reuse a song that already exists for this name, else
// steer everyone into a small spike set so identical names share one job.
export async function pickTemplate(
  deps: PickerDeps,
  req: { lang: string; nameKey: string; genre?: string },
): Promise<{ template: Template; reason: PickReason }> {
  const rnd = deps.random ?? Math.random;
  const candidates = deps.catalog.forLang(req.lang, req.genre);
  if (!candidates.length)
    throw new Error(`no templates for ${req.lang}/${req.genre ?? "any"}`);

  if ((await deps.etaSeconds()) < deps.spikeEtaSeconds)
    return { template: pickOne(candidates, rnd), reason: "random" };

  const ready = new Set(await deps.readyTemplateRefs(req.lang, req.nameKey));
  const cached = candidates.filter((t) => ready.has(templateRef(t)));
  if (cached.length) return { template: pickOne(cached, rnd), reason: "pool" };

  const spike = candidates.filter((t) => t.spike);
  return {
    template: pickOne(spike.length ? spike : candidates.slice(0, 3), rnd),
    reason: "spike",
  };
}
