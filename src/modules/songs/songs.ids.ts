import { sha256 } from "../../shared/hash.js";
import type { Template } from "../templates/catalog.js";

export const nameKeyOf = (lang: string, normalizedKey: string) =>
  sha256(`${lang}:${normalizedKey}`).slice(0, 24);

// Content-addressed: the same name in the same template version is the same song,
// for every user, forever. That is what makes caching and dedupe free.
export const songIdOf = (t: Template, lang: string, nameKey: string) =>
  sha256(`${t.id}:v${t.version}:${lang}:${nameKey}`).slice(0, 32);
