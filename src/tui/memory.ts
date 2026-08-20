// Memory & learning tab — the TUI's view of memory.
//
// The store itself lives behind the ONE seam (`src/memory/store.ts`)
// and its pi-memory implementation in `src/memory/pi-memory.ts`; what stays
// here is what only the TUI cares about — how the timeline is ORDERED and
// which entries the defect auto-filer picks up — plus the factory that hands
// the tab a store wired to its own ssh runner.
//
// Nothing in the TUI addresses memory by file offsets or hashes it itself:
// entries carry their own `hash`, and `refOf(entry)` turns a listed entry
// into the address of a verb (see `MemoryStore` for why every addressed op
// carries the content it expects to find).
import type { TuiConfig } from "../config.js";
import { sshPiMemoryStore } from "../memory/pi-memory.js";
import type { MemoryEntry, MemoryStore } from "../memory/store.js";
import type { SshRunner } from "./remote.js";

export { blockHash, parseMemory } from "../memory/pi-memory.js";
export { matchesQuery, normalizeTag, refOf } from "../memory/store.js";
export type { MemoryEntry, MemoryOp, MemoryRef, MemorySearchOptions, MemoryStore, MemoryWriteResult } from "../memory/store.js";

/** Newest-first ordering for the timeline: by ts desc, then file order desc.
 * Pinned entries float to the top regardless of age — mirroring their
 * top-of-file placement (the part of MEMORY.md that survives pi-memory's
 * injection truncation). */
export function timelineOrder(entries: MemoryEntry[]): MemoryEntry[] {
  const indexed = entries.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    if (a.e.pinned !== b.e.pinned) return a.e.pinned ? -1 : 1;
    if (a.e.ts !== b.e.ts) return a.e.ts < b.e.ts ? 1 : -1;
    return b.i - a.i;
  });
  return indexed.map((x) => x.e);
}

/** Operational-defect entries — the auto-filer's input (§9). */
export function defectEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => e.tags.includes("bug"));
}

/** The store the TUI runs against: memory inside the VM container, reached
 * over the TUI's own ssh runner. */
export function tuiMemoryStore(cfg: TuiConfig, ssh: SshRunner): MemoryStore {
  return sshPiMemoryStore(cfg, ssh);
}
