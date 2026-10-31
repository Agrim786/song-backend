import { existsSync, readFileSync } from "node:fs";

// Names are the only user text that reaches the song, so a small blocklist is
// enough. One entry per line, in any script; lines starting with # are comments.
const FILE = "config/blocklist.txt";

const blocked: Set<string> = existsSync(FILE)
  ? new Set(
      readFileSync(FILE, "utf8")
        .split("\n")
        .map((l) => l.trim().normalize("NFC").toLowerCase())
        .filter((l) => l && !l.startsWith("#")),
    )
  : new Set();

export function isBlockedName(key: string): boolean {
  return key.split(/[\s-]+/).some((part) => blocked.has(part)) || blocked.has(key);
}
