// the curated-memory import: the archived markdown file → the store.
//
// One repeatable pass that moves the memory WORTH KEEPING out of the retired
// engine's MEMORY.md and into the `MemoryStore` the engine phase stands up.
// Both ends are the seam (`store.ts`): the source is a `MemorySource` (in
// production the read-only `legacy-file.ts` reader), the destination is a
// `MemoryStore` (in production the OpenViking one). Nothing in this file knows
// either end's mechanics — that is the point, and it is why the import could
// be written before the destination existed.
//
// What crosses, and what deliberately does not:
//
//   * PINNED entries — the owner's standing instructions that live in the
//     region surviving injection truncation. They are written AND pinned in
//     the destination (the `pin` op, so the guaranteed head picks them up).
//   * `#manual` entries — the owner's own words, standing instructions even
//     when not pinned.
//   * Curated LEARNINGS — the EOD sweep's evidence-backed lesson entries
//     (`#eod-learning`, `#missed-finding`, `#false-positive`, `#refuted`,
//     `#wontfix-pattern`, `#repo-gotcha`, and the `#rejected-proposal`
//     records the sweep must keep honouring).
//   * OPEN `#bug` / `#feedback` threads — the operational-defect and
//     review-quality threads still in play. A thread carrying a closing tag
//     (`#resolved`, `#fixed`, …) has served its purpose and stays behind.
//
//   * RAW DAILY WORKING NOTES do not cross. They are recognised by absence:
//     an entry carrying none of the curated tags above is a session's
//     day-to-day scratch (what it did, what it looked at) — the noise the
//     import exists to leave behind. Recognising them positively is not
//     possible (they have no marker); recognising the curated set positively
//     is, because every curated writer tagged its entries — the EOD sweep by
//     prompt, the operator's own `add` by minting `#manual`, a machine `note`
//     by refusing untagged text at all.
//
// Best effort, NO GATE (the owner, 2026-08-20): there is no probe-parity
// check, no pass/fail bar and no abort path. Whatever imports, imports; gaps
// get fixed forward. That decision puts the whole burden of visibility on the
// LOG — so the log names every skipped entry with its reason and every failed
// write with the store's own refusal message, and the report carries the same
// data structured for a caller that wants to render it elsewhere.
//
// Re-running is safe: each written entry carries an `import-key:` derived
// from the source entry's own words, the destination is re-read immediately
// before every batch, and an entry whose key is already there is skipped
// rather than written again (identity is the creation precondition the seam
// can express; a store with native hash preconditions layers its own on top).
import { createHash } from "node:crypto";
import { chmod as nodeChmod, stat as nodeStat } from "node:fs/promises";
import {
  matchesQuery,
  normalizeTag,
  refOf,
  type MemoryEntry,
  type MemoryOp,
  type MemorySearchOptions,
  type MemorySource,
  type MemoryStore,
  type MemoryWriteResult,
} from "./store.js";

/** Tag stamped on every imported entry — the TUI's handle on this migration. */
export const IMPORT_TAG = "imported";

/** Marker carrying the identity of the source entry, parsed back on re-run. */
export const IMPORT_KEY_PREFIX = "import-key:";

/** OpenViking's batch-write caps at 256 operations; the seam applies ops one
 * at a time, so a "batch" here is the unit of re-read + pin resolution. */
export const DEFAULT_BATCH_SIZE = 256;

// ---- classification --------------------------------------------------------

/** Which category an entry lands in — its tags are preserved either way. */
export type ImportCategory = "pinned" | "standing" | "learning" | "bug" | "feedback";

/** Why an entry stayed behind. Every skipped entry gets one, and the log
 * names the entry beside it — this is the only signal that anything missed. */
export type SkipReason =
  /** No curated tag: a session's day-to-day working note. */
  | "raw-daily-note"
  /** A session compaction handoff block, not a lesson. */
  | "session-handoff"
  /** A `#bug`/`#feedback` thread already tagged closed. */
  | "closed-thread"
  /** Another source entry with the same words was already imported. */
  | "duplicate-in-source"
  /** The destination already holds this entry (previous run, or another writer). */
  | "already-imported"
  /** Nothing left after trimming. */
  | "empty";

export type Classification = { keep: true; category: ImportCategory } | { keep: false; reason: SkipReason };

const STANDING_TAGS = new Set(["manual"]);

const LEARNING_TAGS = new Set([
  "eod-learning",
  "learning",
  "lesson",
  "missed-finding",
  "false-positive",
  "refuted",
  "wontfix-pattern",
  "repo-gotcha",
  "rubric",
  "rejected-proposal",
]);

/** A thread that has been closed out. Exact tags — `wontfix-pattern` is a
 * LEARNING tag and must never be read as a closing `wontfix`. */
const CLOSED_TAGS = new Set(["resolved", "fixed", "closed", "done", "obsolete", "superseded"]);

const hasTag = (e: MemoryEntry, want: Set<string>): boolean => e.tags.some((t) => want.has(normalizeTag(t)));

const isTagged = (e: MemoryEntry, tag: string): boolean => e.tags.some((t) => normalizeTag(t) === tag);

/**
 * One entry's verdict. Order matters: pinned wins over everything (it decides
 * WHERE the entry lands, not just whether), then standing instructions, then
 * the open threads, then learnings.
 */
export function classify(e: MemoryEntry): Classification {
  const text = e.text.trim();
  if (text === "") return { keep: false, reason: "empty" };
  if (/^HANDOFF\b/.test(text)) return { keep: false, reason: "session-handoff" };

  const thread = isTagged(e, "bug") ? "bug" : isTagged(e, "feedback") ? "feedback" : null;
  if (thread !== null && hasTag(e, CLOSED_TAGS)) return { keep: false, reason: "closed-thread" };

  if (e.pinned) return { keep: true, category: "pinned" };
  if (hasTag(e, STANDING_TAGS)) return { keep: true, category: "standing" };
  if (thread !== null) return { keep: true, category: thread };
  if (hasTag(e, LEARNING_TAGS)) return { keep: true, category: "learning" };
  return { keep: false, reason: "raw-daily-note" };
}

// ---- identity --------------------------------------------------------------

/**
 * Identity of a source entry = its own words. NOT its (ts, id, block)
 * address: retiring an earlier block shifts later indices and pinning
 * rewrites the batch id, so an address-keyed import would re-import half the
 * file the day after someone tidied it (the auto-filer learned this the same
 * way — see `src/tui/autofile.ts`).
 */
export function importKey(text: string): string {
  const normalized = stripImportHeader(text)
    .replace(/(^|\s)#pinned(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return `sha1:${createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

const HEADER_RE = new RegExp(`^#${IMPORT_TAG}\\b.*${IMPORT_KEY_PREFIX}\\S+.*\\n?`);

/** Drop the provenance header from an imported entry, so its key is computed
 * over the same words the source entry had. */
function stripImportHeader(text: string): string {
  return text.replace(HEADER_RE, "");
}

/** The key a destination entry stands for: the stamped one when it came from
 * an import, otherwise the key its own words would produce (so an entry that
 * reached the store by another route is still not duplicated). */
export function keyOfDestEntry(e: MemoryEntry): string {
  const stamped = new RegExp(`${IMPORT_KEY_PREFIX}(\\S+)`).exec(e.text);
  return stamped?.[1] ?? importKey(e.text);
}

/**
 * The text written to the destination: a one-line provenance header (leading
 * `#tag` — machine writers must open with one) followed by the source entry
 * VERBATIM, so every original tag, link and line survives and stays
 * searchable.
 */
export function importedText(e: MemoryEntry, category: ImportCategory, key: string): string {
  // "from pi-memory" is the PROVENANCE of the source entry — the engine it was
  // written in — and stays spelled that way in already-imported entries.
  const head = `#${IMPORT_TAG} #${category} ${IMPORT_KEY_PREFIX}${key} — from pi-memory ${e.ts} [${e.id}#${e.block}]`;
  return `${head}\n${e.text.trim()}`;
}

// ---- report ----------------------------------------------------------------

/** How an entry is named in the log — address plus enough words to recognise it. */
export interface EntryRef {
  key: string;
  ts: string;
  id: string;
  block: number;
  excerpt: string;
}

export interface ImportedRecord extends EntryRef {
  category: ImportCategory;
  /** The destination's answer to the write (a refusal is an answer). */
  message: string;
}

export interface SkippedRecord extends EntryRef {
  reason: SkipReason;
}

export interface PinRecord extends EntryRef {
  ok: boolean;
  /** A pin applied to an entry a previous run had written but not pinned. */
  repaired: boolean;
  message: string;
}

export interface ArchiveResult {
  ok: boolean;
  path: string;
  /** Octal mode before/after, when the archive could read them. */
  was?: string;
  now?: string;
  message: string;
}

export interface ImportReport {
  /** Entries read out of the source. */
  sourceEntries: number;
  /** Entries the destination already held when the import started. */
  destEntriesBefore: number;
  batches: number;
  imported: ImportedRecord[];
  /** Writes the destination refused or that failed — best effort, no abort. */
  failed: ImportedRecord[];
  skipped: SkippedRecord[];
  pins: PinRecord[];
  archive?: ArchiveResult;
  /** The rendered log, line by line (also streamed to `log` as it happens). */
  lines: string[];
}

const excerptOf = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}…` : flat;
};

const refFor = (e: MemoryEntry, key: string): EntryRef => ({ key, ts: e.ts, id: e.id, block: e.block, excerpt: excerptOf(e.text) });

const nameOf = (r: EntryRef): string => `${r.ts} [${r.id}#${r.block}] "${r.excerpt}"`;

// ---- the import ------------------------------------------------------------

export interface ImportOptions {
  /** Where the curated memory came from — READ ONLY (production: the archived
   * markdown file through `legacy-file.ts`). */
  source: MemorySource;
  /** Where it is going. Any `MemoryStore` — the engine's implementation is
   * none of this module's business. */
  dest: MemoryStore;
  /** Ops per batch; the destination is re-read between batches. */
  batchSize?: number;
  /** Streamed log sink (the runner passes `console.log`). */
  log?: (line: string) => void;
  /** Leaves the source file in place, read-only. Injected so this module
   * never touches a filesystem the tests did not hand it. */
  archive?: () => Promise<ArchiveResult>;
}

interface Plan {
  entry: MemoryEntry;
  category: ImportCategory;
  key: string;
  text: string;
  ref: EntryRef;
}

/**
 * The destination's entries — refusing an INCOMPLETE enumeration.
 *
 * Dedup reads absence as "not imported yet", so a listing that skipped an
 * entry it could not read would get that entry written a second time. A
 * store that can say what it could not read (`sweep()`, the OpenViking
 * implementation) is asked; one that cannot is taken at its `read()`.
 */
async function readDestFully(dest: MemoryStore): Promise<MemoryEntry[]> {
  const sweepable = dest as MemoryStore & {
    sweep?: () => Promise<{ entries: MemoryEntry[]; unread: string[] }>;
  };
  if (typeof sweepable.sweep !== "function") return dest.read();
  const { entries, unread } = await sweepable.sweep();
  if (unread.length > 0) {
    throw new Error(
      `memory import: could not read the whole destination, so it cannot tell what is already imported — ` +
        `nothing written this pass; rerun once it reads cleanly (${unread.join("; ")})`,
    );
  }
  return entries;
}

/**
 * Run the import. Never throws on a refused or failed write — every outcome
 * lands in the report and in the log. The only way this rejects is a source
 * or destination whose `read()` throws, i.e. no transport at all, or a
 * destination that reports it could not read part of itself (dedup against a
 * partial listing would duplicate what it missed).
 */
export async function importMemory(opts: ImportOptions): Promise<ImportReport> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const report: ImportReport = {
    sourceEntries: 0,
    destEntriesBefore: 0,
    batches: 0,
    imported: [],
    failed: [],
    skipped: [],
    pins: [],
    lines: [],
  };
  const say = (line: string): void => {
    report.lines.push(line);
    opts.log?.(line);
  };

  const srcEntries = await opts.source.read();
  const destEntries = await readDestFully(opts.dest);
  report.sourceEntries = srcEntries.length;
  report.destEntriesBefore = destEntries.length;

  let existing = indexByKey(destEntries);
  say(`memory import — source holds ${srcEntries.length} entries, destination holds ${destEntries.length}`);

  // ---- plan
  const plans: Plan[] = [];
  const seen = new Set<string>();
  const repins: Array<{ ref: EntryRef; entry: MemoryEntry }> = [];

  for (const e of srcEntries) {
    const verdict = classify(e);
    const key = importKey(e.text);
    const ref = refFor(e, key);
    if (!verdict.keep) {
      report.skipped.push({ ...ref, reason: verdict.reason });
      continue;
    }
    if (seen.has(key)) {
      report.skipped.push({ ...ref, reason: "duplicate-in-source" });
      continue;
    }
    seen.add(key);
    const already = existing.get(key);
    if (already) {
      report.skipped.push({ ...ref, reason: "already-imported" });
      // Repair a pin a previous run wrote but could not apply — the pinned
      // area is the whole reason those entries survive truncation.
      if (verdict.category === "pinned" && !already.pinned) repins.push({ ref, entry: already });
      continue;
    }
    plans.push({ entry: e, category: verdict.category, key, text: importedText(e, verdict.category, key), ref });
  }

  report.batches = Math.ceil(plans.length / batchSize);
  say(`plan: ${plans.length} to import (${categoryCounts(plans)}), ${report.skipped.length} skipped, ${report.batches} batch(es) of ≤${batchSize}`);

  // ---- write, batch by batch
  for (let i = 0; i < plans.length; i += batchSize) {
    const batch = plans.slice(i, i + batchSize);
    const n = Math.floor(i / batchSize) + 1;

    // Creation precondition at the seam: re-read right before writing, so an
    // entry another writer (or an interrupted earlier run) has just put there
    // is recognised instead of duplicated.
    if (i > 0) existing = indexByKey(await readDestFully(opts.dest));
    let ok = 0;
    let bad = 0;
    for (const plan of batch) {
      const already = existing.get(plan.key);
      if (already) {
        report.skipped.push({ ...plan.ref, reason: "already-imported" });
        if (plan.category === "pinned" && !already.pinned) repins.push({ ref: plan.ref, entry: already });
        continue;
      }
      const res = await applyQuietly(opts.dest, { op: "note", text: plan.text });
      const record: ImportedRecord = { ...plan.ref, category: plan.category, message: res.message };
      if (res.ok) {
        report.imported.push(record);
        ok += 1;
      } else {
        report.failed.push(record);
        bad += 1;
      }
    }
    say(`batch ${n}/${report.batches}: ${batch.length} write(s), ${ok} ok, ${bad} failed`);

    // Pinned entries need the destination's own address, so resolve them
    // against a fresh read once the batch's writes have landed.
    const pinned = batch.filter((p) => p.category === "pinned" && report.imported.some((r) => r.key === p.key));
    if (pinned.length > 0) {
      const after = indexByKey(await opts.dest.read());
      for (const plan of pinned) {
        const landed = after.get(plan.key);
        if (!landed) {
          report.pins.push({ ...plan.ref, ok: false, repaired: false, message: "written entry not found on read-back — pin not applied" });
          continue;
        }
        // The `pinned` FLAG only says the text carries the tag — an imported
        // entry inherits it from its own words. Placement in the pinned area
        // is what the guaranteed head reads, and only the `pin` op does that,
        // so a freshly written entry is always pinned explicitly.
        const res = await applyQuietly(opts.dest, { op: "pin", ...refOf(landed) });
        report.pins.push({ ...plan.ref, ok: res.ok, repaired: false, message: res.message });
      }
    }
  }

  // ---- pin repairs for entries a previous run left unpinned
  for (const r of repins) {
    const res = await applyQuietly(opts.dest, { op: "pin", ...refOf(r.entry) });
    report.pins.push({ ...r.ref, ok: res.ok, repaired: true, message: res.message });
  }

  if (opts.archive) {
    report.archive = await runArchive(opts.archive);
  }

  for (const line of renderSummary(report)) say(line);
  return report;
}

/** A store that throws instead of resolving is still just an answer here —
 * the import has no abort path. */
async function applyQuietly(store: MemoryStore, op: MemoryOp): Promise<MemoryWriteResult> {
  try {
    return await store.apply(op);
  } catch (err) {
    return { ok: false, message: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function runArchive(archive: () => Promise<ArchiveResult>): Promise<ArchiveResult> {
  try {
    return await archive();
  } catch (err) {
    return { ok: false, path: "", message: `archive failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function indexByKey(entries: MemoryEntry[]): Map<string, MemoryEntry> {
  const byKey = new Map<string, MemoryEntry>();
  for (const e of entries) {
    const key = keyOfDestEntry(e);
    // Keep the FIRST occurrence: pin rewrites move an entry to the head, and
    // an older duplicate is the one a repair should address.
    if (!byKey.has(key)) byKey.set(key, e);
  }
  return byKey;
}

function categoryCounts(plans: Plan[]): string {
  const order: ImportCategory[] = ["pinned", "standing", "learning", "bug", "feedback"];
  const counts = order.map((c) => `${c} ${plans.filter((p) => p.category === c).length}`);
  return counts.join(", ");
}

// ---- the log ---------------------------------------------------------------

/**
 * The closing half of the log: what landed, what failed, and every skipped
 * entry named under its reason. Deliberately verbose — with no gate, this
 * text and the TUI memory tab are the only evidence that something was
 * missed.
 */
export function renderSummary(report: ImportReport): string[] {
  const lines: string[] = [];
  lines.push(`imported ${report.imported.length} of ${report.imported.length + report.failed.length} attempted write(s)`);

  if (report.failed.length > 0) {
    lines.push(`failed ${report.failed.length} (left behind — best effort, fix forward):`);
    for (const f of report.failed) lines.push(`  - ${nameOf(f)} → ${f.message}`);
  }

  const pinsOk = report.pins.filter((p) => p.ok);
  if (report.pins.length > 0) {
    const repaired = report.pins.filter((p) => p.repaired && p.ok).length;
    lines.push(`pinned area: ${pinsOk.length}/${report.pins.length} ok${repaired > 0 ? ` (${repaired} repaired)` : ""}`);
    for (const p of report.pins.filter((x) => !x.ok)) lines.push(`  - pin failed: ${nameOf(p)} → ${p.message}`);
  }

  lines.push(`skipped ${report.skipped.length}:`);
  const reasons: SkipReason[] = ["raw-daily-note", "session-handoff", "closed-thread", "duplicate-in-source", "already-imported", "empty"];
  for (const reason of reasons) {
    const group = report.skipped.filter((s) => s.reason === reason);
    if (group.length === 0) continue;
    lines.push(`  ${reason} (${group.length}):`);
    for (const s of group) lines.push(`    - ${nameOf(s)}`);
  }

  if (report.archive) lines.push(`archive: ${report.archive.message}`);
  lines.push(
    `done: ${report.imported.length} imported, ${report.failed.length} failed, ${report.skipped.length} skipped — best-effort import, no gate`,
  );
  return lines;
}

/** The whole log as one blob — for a caller that wants to write it to a file. */
export function formatImportLog(report: ImportReport): string {
  return `${report.lines.join("\n")}\n`;
}

// ---- archiving the source file ---------------------------------------------

/** The two filesystem calls archiving needs, injectable for tests. */
export interface ArchiveFs {
  stat(path: string): Promise<{ mode: number }>;
  chmod(path: string, mode: number): Promise<void>;
}

const nodeArchiveFs: ArchiveFs = {
  stat: async (path) => {
    const s = await nodeStat(path);
    return { mode: s.mode };
  },
  chmod: (path, mode) => nodeChmod(path, mode),
};

const octal = (mode: number): string => `0${(mode & 0o777).toString(8)}`;

/**
 * Leave the legacy memory file exactly where it is, read-only: every write
 * bit cleared, the read bits exactly as they were (0600 → 0400, 0644 →
 * 0444; owner read always kept) — archiving takes write away and never
 * widens who else may read. It is
 * never deleted or moved: after the engine cutover it is the historical
 * record, and a stray writer finding it writable would silently fork memory.
 * Failure is reported, never thrown — the import has no abort path.
 */
export async function archiveReadOnly(path: string, fs: ArchiveFs = nodeArchiveFs): Promise<ArchiveResult> {
  try {
    const before = await fs.stat(path);
    if ((before.mode & 0o222) === 0) {
      return { ok: true, path, was: octal(before.mode), now: octal(before.mode), message: `${path} already read-only (${octal(before.mode)})` };
    }
    // Owner read is kept (added if missing): the archive is the historical
    // record, and 0200 → 0000 would lock its own owner out of reading it.
    const after = (before.mode & ~0o222 & 0o777) | 0o400;
    await fs.chmod(path, after);
    return { ok: true, path, was: octal(before.mode), now: octal(after), message: `${path} left in place, ${octal(before.mode)} → ${octal(after)} (read-only)` };
  } catch (err) {
    return { ok: false, path, message: `${path} NOT archived: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---- a destination that only records --------------------------------------

/**
 * An in-memory `MemoryStore` — the import's dry-run destination (and a handy
 * fake in tests). It models the seam faithfully enough for the import's own
 * mechanics: `note`/`add` append an entry, `pin` sets the flag and floats the
 * entry to the head, and every addressed op checks the expected hash.
 */
export interface RecordingMemoryStore extends MemoryStore {
  ops: MemoryOp[];
  entries: MemoryEntry[];
}

export function recordingMemoryStore(seed: MemoryEntry[] = []): RecordingMemoryStore {
  const entries: MemoryEntry[] = [...seed];
  const ops: MemoryOp[] = [];
  let counter = 0;

  const hash = (text: string): string => createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);

  const make = (text: string): MemoryEntry => {
    counter += 1;
    const stamp = `2026-01-01 00:00:${String(counter % 60).padStart(2, "0")}`;
    const tags = [...text.matchAll(/(^|\s)#([\w-]+)/g)].map((m) => m[2]!);
    return {
      id: `rec-${counter}`,
      ts: stamp,
      day: stamp.slice(0, 10),
      block: 0,
      text: text.trim(),
      tags,
      links: [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!),
      pinned: tags.includes("pinned"),
      hash: hash(text.trim()),
    };
  };

  const store: RecordingMemoryStore = {
    ops,
    entries,
    read: () => Promise.resolve([...entries]),
    search: (query: string, opts?: MemorySearchOptions) => {
      const hits = entries.filter((e) => matchesQuery(e, query, opts));
      const limit = opts?.limit;
      return Promise.resolve(limit !== undefined && limit >= 0 ? hits.slice(0, limit) : hits);
    },
    apply: (op: MemoryOp) => {
      ops.push(op);
      if (op.op === "add" || op.op === "note") {
        entries.push(make(op.op === "add" && !/(^|\s)#manual(\s|$)/.test(op.text) ? `#manual ${op.text}` : op.text));
        return Promise.resolve({ ok: true, message: `ok: ${op.op}` });
      }
      const at = entries.findIndex((e) => e.id === op.id && e.ts === op.ts && e.block === op.block);
      if (at < 0) return Promise.resolve({ ok: false, message: "refused: no such entry" });
      const entry = entries[at]!;
      if (entry.hash !== op.expect) return Promise.resolve({ ok: false, message: "refused: stale view" });
      if (op.op === "retire") entries.splice(at, 1);
      if (op.op === "pin") {
        const text = /(^|\s)#pinned(\s|$)/.test(entry.text) ? entry.text : `#pinned ${entry.text}`;
        entries.splice(at, 1);
        entries.unshift({ ...entry, text, tags: [...new Set(["pinned", ...entry.tags])], pinned: true, hash: hash(text) });
      }
      if (op.op === "unpin") {
        const text = entry.text.replace(/(^|\s)#pinned(?=\s|$)/g, "$1").trim();
        entries[at] = { ...entry, text, tags: entry.tags.filter((t) => t !== "pinned"), pinned: false, hash: hash(text) };
      }
      if (op.op === "edit") {
        const tags = [...op.text.matchAll(/(^|\s)#([\w-]+)/g)].map((m) => m[2]!);
        entries[at] = { ...entry, text: op.text.trim(), tags, pinned: tags.includes("pinned"), hash: hash(op.text.trim()) };
      }
      return Promise.resolve({ ok: true, message: `ok: ${op.op}` });
    },
  };
  return store;
}
