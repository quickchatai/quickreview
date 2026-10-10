// The archived pi-memory file (MEMORY.md), READ ONLY. It exists so the
// one-time curated import (`import.ts`) can see it; the file itself is the
// historical record, archived in place at 0444. There is no write path of any
// kind here.
//
// This is deliberately NOT a `MemoryStore`. It is a `MemorySource`: `read()`
// and nothing else. The seam has exactly ONE implementation
// (`src/openviking/store.ts`), and adding a second — even a read-only one —
// would reopen the question of which engine a caller is talking to.
//
// The markdown shape it parses is pi-memory's: write batches delimited by
// header comments `<!-- YYYY-MM-DD HH:MM:SS [id] -->`, each batch holding one
// or more blank-line-separated paragraph blocks (one lesson per block). Three
// header variants existed (plain, `last updated:` overwrite, `HANDOFF`
// compaction) and all three delimit batches — missing one would mis-attribute
// its blocks to the previous batch and hand the import the wrong provenance.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHashTags } from "./eventtags.js";
import type { MemoryEntry, MemorySource } from "./store.js";

/** Where the archived MEMORY.md sits for a process running beside pi. */
export function legacyMemoryPath(): string {
  return process.env["QCR_MEMORY_PATH"] ?? join(homedir(), ".pi", "agent", "memory", "MEMORY.md");
}

const HEADER_RE = /^<!--\s*(?:(?:last updated:|HANDOFF)\s+)?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*\[([^\]]+)\]\s*-->\s*$/;

/** sha1-12 of a block's exact text. It only fills `MemoryEntry.hash` so a
 * source entry is a well-formed entry. */
export function legacyBlockHash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/** Parse MEMORY.md into entries, file order (append order = oldest first). */
export function parseLegacyMemory(md: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let header: { ts: string; day: string; id: string } | undefined;
  let block: string[] = [];
  let blockIdx = 0;

  const flush = (): void => {
    const text = block.join("\n").trim();
    block = [];
    if (!header || text.length === 0) return;
    // `tags` stays a full-text scan: it feeds the import classifier, where
    // over-inclusion is merely noisy.
    const tags = [...text.matchAll(/(^|\s)#([\w-]+)/g)].map((m) => m[2]!);
    const links = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!);
    entries.push({
      id: header.id,
      ts: header.ts,
      day: header.day,
      block: blockIdx,
      text,
      tags,
      links,
      // `pinned` is NOT a full-text scan: it is the privileged flag, and a
      // pinned entry rides the guaranteed head of every round prompt — the
      // highest-trust position in the system. Entries quote untrusted human
      // text verbatim, so a `#pinned` written anywhere in a quoted comment
      // must not be able to promote itself there. Header-only: only the
      // leading run of `#tag` tokens counts. (The OpenViking store enforces
      // the same rule with the same helper; see tests/openviking-store.)
      pinned: parseHashTags(text).includes("pinned"),
      hash: legacyBlockHash(text),
    });
    blockIdx += 1;
  };

  for (const line of md.split("\n")) {
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      header = { ts: `${m[1]} ${m[2]}`, day: m[1]!, id: m[3]! };
      blockIdx = 0;
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    block.push(line);
  }
  flush();
  return entries;
}

/** The import's source: one archived markdown file, read on demand. An
 * unreadable file is an empty source, never a throw — the import has no abort
 * path, and "the file is already gone" is a legitimate outcome. */
export function legacyMemoryFileSource(path: string = legacyMemoryPath()): MemorySource {
  return {
    async read(): Promise<MemoryEntry[]> {
      try {
        return parseLegacyMemory(await readFile(path, "utf8"));
      } catch {
        return [];
      }
    },
  };
}
