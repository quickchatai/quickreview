// Defect-flag auto-filer: defect-tagged memory entries become issue-tracker
// tickets automatically. Runs PC-side in the TUI (the tracker is a local
// directory on the operator's machine — the VM cannot reach it) and writes as
// tracker actor `qcr-tui`. Disabled entirely when no tracker dir is
// configured.
//
// Dedup is a tag. Filing stamps `filed=FT-NNNN` into the entry's own
// header `k=v` run — the vocabulary of `src/memory/eventtags.ts`, mirrored onto
// OpenViking's native retrieval tags by the store — so "already filed" is a
// property of the memory the filer reads, not of a ledger it keeps on the side.
// The `Memory-key:` line stamped into each ticket is the backstop: the
// tag write is a store mutation and can be refused (stale hash, store down),
// and a refused stamp must not produce a duplicate ticket on the next tick.
// Both keys are stable across pin and across the stamp itself — `memoryKey`
// normalizes exactly those two mutations away.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEventTags } from "../memory/eventtags.js";
import { claimTrackerId } from "../setup/trackersink.js";
import { refOf, type MemoryEntry, type MemoryStore } from "./memory.js";

export const MEMORY_KEY_LINE = "Memory-key:";

/** The event tag that records where a defect entry was filed. */
export const FILED_TAG = "filed";

/** Dedup key = hash of the entry's TEXT with the two tokens the system itself
 * writes removed (`#pinned`, `filed=…`), not its (ts,id,block) address:
 * retiring an entry shifts indices, pinning rewrites the text, and the filer's
 * own stamp rewrites it again — any of those would make an already-filed
 * defect look new and file a duplicate ticket. Same words = same defect. */
export function memoryKey(e: MemoryEntry): string {
  const normalized = e.text
    .replace(/(^|\s)#pinned(?=\s|$)/g, "$1")
    .replace(new RegExp(`(^|\\s)${FILED_TAG}=\\S+(?=\\s|$)`, "g"), "$1")
    .replace(/\s+/g, " ")
    .trim();
  return `sha1:${createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

/** The ticket a previous run filed this entry as, read off its own tag. */
export function filedAs(e: MemoryEntry): string | undefined {
  const value = parseEventTags(e.text)[FILED_TAG];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Insert `filed=<ticket>` into the entry's HEADER — after the leading `#tag`
 * run and any existing `k=v` tokens, before the prose. That position is the
 * whole point: `parseEventTags` scans the header only, so a tag appended to
 * the body would not be readable back (and, conversely, prose quoting
 * `filed=FT-9999` can never mint one).
 */
export function withFiledTag(text: string, ticketId: string): string {
  const tokens = text.trim().split(/(\s+)/); // separators kept, so prose spacing survives
  let insertAt = 0;
  for (let i = 0; i < tokens.length; i += 2) {
    const token = tokens[i]!;
    if (token === "") continue;
    if (token.startsWith("#") || /^[a-z][a-z0-9_-]*=[^\s]+$/.test(token)) {
      insertAt = i + 1;
      continue;
    }
    break;
  }
  const head = tokens.slice(0, insertAt).join("");
  const tail = tokens.slice(insertAt).join("");
  const stamp = `${FILED_TAG}=${ticketId}`;
  if (head.trim() === "") return tail.trim() === "" ? stamp : `${stamp} ${tail.trim()}`;
  return tail.trim() === "" ? `${head.trim()} ${stamp}` : `${head.trim()} ${stamp} ${tail.trim()}`;
}

export interface AutoFiled {
  ticketId: string;
  file: string;
  key: string;
}

export interface TrackerPaths {
  /** The tracker root (the local issue tracker's root directory). */
  root: string;
  effort: string; // "review-sandbox"
  parent: string; // the effort's map id, "FT-NNNN"
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
  return claimTrackerId(root, ticketRelPath);
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

export function ticketBody(
  id: string,
  e: MemoryEntry,
  paths: TrackerPaths,
  nowIso: string,
): { name: string; content: string } {
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
entry ${e.id} @ ${e.ts}, auto-filed by the TUI). Diagnose,
fix, and resolve — or close as duplicate/stale with a note.

Memory-key: ${memoryKey(e)}

## Flagged entry

${e.text}
`;
  return { name, content };
}

/**
 * File every unfiled defect entry; returns what was filed. Never throws — a
 * broken tracker (or an unreachable memory store) must not take down the TUI
 * poll loop.
 *
 * Two dedup guards, in this order: the entry's own `filed=` tag (checked
 * first — it needs no disk read and survives a tracker that was rebuilt), then
 * the `Memory-key:` scan over the effort's tickets. Only after the ticket is on
 * disk is the tag written back, so a crash between the two costs a re-check,
 * never a lost ticket.
 */
export async function autofileDefects(
  paths: TrackerPaths,
  defects: MemoryEntry[],
  nowIso: string,
  store?: MemoryStore,
): Promise<AutoFiled[]> {
  const filed: AutoFiled[] = [];
  const stamps: Array<{ entry: MemoryEntry; ticketId: string }> = [];
  try {
    const seen = filedKeys(paths);
    const ticketsDir = join(paths.root, "efforts", paths.effort, "tickets");
    mkdirSync(ticketsDir, { recursive: true });
    for (const e of defects) {
      if (filedAs(e) !== undefined) continue;
      const key = memoryKey(e);
      if (seen.has(key)) continue;
      const id = claimNextId(
        paths.root,
        (n) => `efforts/${paths.effort}/tickets/${ticketBody(n, e, paths, nowIso).name}`,
      );
      const { name, content } = ticketBody(id, e, paths, nowIso);
      writeFileSync(join(ticketsDir, name), content);
      seen.add(key);
      filed.push({ ticketId: `FT-${id}`, file: name, key });
      stamps.push({ entry: e, ticketId: `FT-${id}` });
    }
  } catch {
    /* tracker unavailable — quietly do nothing this tick */
  }
  // Best-effort: a refused stamp leaves the Memory-key backstop holding the
  // dedup, so the worst case is that the entry is re-checked, not re-filed.
  if (store) {
    for (const { entry, ticketId } of stamps) {
      try {
        await store.apply({
          op: "edit",
          ...refOf(entry),
          text: withFiledTag(entry.text, ticketId),
        });
      } catch {
        /* the seam resolves refusals; only a broken transport lands here */
      }
    }
  }
  return filed;
}
