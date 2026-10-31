const MAX_LEN = 40;

export interface NormalizedName {
  // Exactly what gets sung (Devanagari stays Devanagari, Latin gets Title Case).
  lyric: string;
  // What we dedupe and cache on. Spelling-insensitive for Latin case only;
  // native-script spelling is the real key (the app confirms it before generating).
  key: string;
}

// Only letters, combining marks, spaces, hyphen and apostrophe survive. That also
// blocks lyric injection like "[Verse]" or "{whisper}" from reaching the provider.
export function normalizeName(raw: string): NormalizedName | null {
  const cleaned = raw
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || [...cleaned].length > MAX_LEN) return null;
  const isLatin = /^[\p{Script=Latin}\s'-]+$/u.test(cleaned);
  const lyric = isLatin ? cleaned.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase()) : cleaned;
  return { lyric, key: lyric.toLowerCase() };
}
