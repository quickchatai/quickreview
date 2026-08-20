// Defect-flag auto-filer (FT-0129 §9): `#bug`-tagged memory entries become
// issue-tracker tickets automatically. Runs PC-SIDE in the TUI (the tracker
// is a local directory on the operator's machine — the VM cannot reach it),
// writes as tracker actor `qcr-tui`, and dedupes on the memory entry's
// (ts, id, block) key, stamped into each filed ticket as a `Memory-key:`
// body line. Disabled entirely when no tracker dir is configured.
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "./memory.js";

export const MEMORY_KEY_LINE = "Memory-key:";

export function memoryKey(e: MemoryEntry): string {
  return `${e.ts}|${e.id}#${e.block}`;
}

export interface AutoFiled {
  ticketId: string;
  file: string;
  key: string;
}

export interface TrackerPaths {
  /** The tracker root (…/issue-tracker/tracker). */
  root: string;
  effort: string; // "review-sandbox"
  parent: string; // map id, "FT-0026"
}

/** Keys already present in the effort's tickets — the dedup set. */
export function filedKeys(paths: TrackerPaths): Set<string> {
  const keys = new Set<string>();
  const dir = join(paths.root, "efforts", paths.effort, "tickets");
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const body = readFileSync(join(dir, f), "utf8");
    for (const m of body.matchAll(/^Memory-key: (.+)$/gm)) keys.add(m[1]!.trim());
  }
  return keys;
}

/** Claim the next free FT id via exclusive-create of `.ids/<NNNN>` (the
 * tracker's claim-is-the-lock protocol). Returns the zero-padded number. */
export function claimNextId(root: string, ticketRelPath: (n: string) => string): string {
  const idsDir = join(root, ".ids");
  const taken = readdirSync(idsDir)
    .filter((f) => /^\d{4}$/.test(f))
    .map((f) => Number(f));
  let candidate = (taken.length > 0 ? Math.max(...taken) : 0) + 1;
  for (let tries = 0; tries < 50; tries++, candidate++) {
    const n = String(candidate).padStart(4, "0");
    try {
      const fd = openSync(join(idsDir, n), "wx");
      writeFileSync(fd, `${ticketRelPath(n)}\n`);
      closeSync(fd);
      return n;
    } catch {
      /* raced by a concurrent claimer — try the next number */
    }
  }
  throw new Error("could not claim a tracker id (50 collisions)");
}

function slugify(text: string): string {
  const words = text
    .replace(/(^|\s)#[\w-]+/g, " ") // tags are not title material
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6);
  return words.join("-") || "memory-defect";
}

export function ticketBody(id: string, e: MemoryEntry, paths: TrackerPaths, nowIso: string): { name: string; content: string } {
  const firstSentence = e.text.replace(/\s+/g, " ").slice(0, 110);
  const slug = slugify(firstSentence);
  const name = `FT-${id}-${slug}.md`;
  const content = `# Auto-filed defect: ${slugify(firstSentence).replace(/-/g, " ")}

Id: FT-${id}
Effort: ${paths.effort}
Type: impl
Status: open
Role: —
Category: —
Labels: review-ops, auto-filed
Assignee: —
Blocked-by: —
Parent: ${paths.parent}
Spec: —
Branch: —
PR: —
Created: ${nowIso} by qcr-tui
Updated: ${nowIso}
Claimed: —
Closed: —

## Question

The overseer flagged an operational defect in the review system (memory
entry ${e.id} @ ${e.ts}, auto-filed by the TUI per FT-0129 §9). Diagnose,
fix, and resolve — or close as duplicate/stale with a note.

Memory-key: ${memoryKey(e)}

## Flagged entry

${e.text}
`;
  return { name, content };
}

/** File every unfiled #bug entry; returns what was filed. Never throws — a
 * broken tracker must not take down the TUI poll loop. */
export function autofileDefects(paths: TrackerPaths, defects: MemoryEntry[], nowIso: string): AutoFiled[] {
  const filed: AutoFiled[] = [];
  try {
    const seen = filedKeys(paths);
    const ticketsDir = join(paths.root, "efforts", paths.effort, "tickets");
    mkdirSync(ticketsDir, { recursive: true });
    for (const e of defects) {
      const key = memoryKey(e);
      if (seen.has(key)) continue;
      const id = claimNextId(paths.root, (n) => `efforts/${paths.effort}/tickets/${ticketBody(n, e, paths, nowIso).name}`);
      const { name, content } = ticketBody(id, e, paths, nowIso);
      writeFileSync(join(ticketsDir, name), content);
      seen.add(key);
      filed.push({ ticketId: `FT-${id}`, file: name, key });
    }
  } catch {
    /* tracker unavailable — quietly do nothing this tick */
  }
  return filed;
}
