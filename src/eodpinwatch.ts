// The pinned-area watchdog.
//
// The EOD sweep curates the day's learnings into durable memory. One rule
// bounds it absolutely: **curation never modifies the owner's pinned standing
// instructions.** The sweep prompt states that rule, but a prompt is an
// instruction to an LLM that nothing outside can verify. This module makes it
// DETECTABLE: fingerprint the pinned area just
// before the sweep prompt goes in, fingerprint it again once the sweep has had
// its window, and raise an anomaly on any difference.
//
// Three properties are structural here, not conventions:
//
//   * THE WATCHDOG NEVER DELAYS OR BLOCKS THE SWEEP. `wrapInject` issues the
//     "before" read and returns the inner inject's promise in the same tick —
//     the snapshot is never awaited ahead of the injection, and a synchronous
//     throw out of the reader is swallowed. A memory server that is down, slow
//     or hung costs the sweep exactly nothing. (Same contract memory already
//     has on the round path, src/memory/context.ts.)
//   * IT ONLY EVER OBSERVES. Its whole output is `logAnomaly` — no memory
//     write, no GitHub mutation, no session scheduling. The wake, if the kind
//     earns one, is the ordinary `AnomalyWakePolicy` → companion-inbox path,
//     so the single-shepherd invariant (rule 9) reads unchanged.
//   * A MISSING SNAPSHOT IS "COULD NOT CHECK", NEVER "CHANGED". Every read
//     failure lands on the quiet degraded kind. The loud kind is reserved for
//     a fingerprint that actually moved.
//
// One false positive is knowingly accepted: the owner editing pins in the TUI
// during the sweep window trips the watchdog, because those writes go straight
// to the store over the operator's own ssh and the daemon never sees them.
// Subtracting them would need a PC→daemon notification path for a rare event,
// and key-confining the pinned area away from the daemon is impossible while
// the daemon must READ pins for the guaranteed round head. So the detection
// stays and the anomaly text names BOTH explanations — a human reading it is
// told, in the alert itself, that it may be their own edit and to check before
// acting. Silent-but-wrong would be worse than honest-and-occasionally-noisy.
//
// And one false negative: the "before" read is issued ahead of the injection
// but never awaited by it, so a curator write that lands before that read
// completes is part of the baseline and goes unseen. Closing it would mean
// holding the sweep on memory, which the first property forbids.

import { createHash } from "node:crypto";
import { withinBudget } from "./budget.js";
import { EOD_PINNED_WATCHDOG_WINDOW_MIN } from "./config.js";
import { zoneDateString, zonedParts, type TimerHandle } from "./eod.js";

/** The loud kind: the pinned area is not what it was when the sweep started.
 * Promoted to a WAKE class in src/anomalies.ts — "the curator may have
 * rewritten the owner's standing instructions" is human-attention grade. */
export const PINNED_MODIFIED_KIND = "eod_pinned_area_modified";

/** The quiet kind: the watchdog could not read one of its two snapshots, so
 * today's sweep simply went unverified. Deliberately NOT in WAKE_KINDS — a
 * store that is down already alerts through the round path, and "no
 * conclusion" is heartbeat-tier news. */
export const PINNED_DEGRADED_KIND = "eod_pinned_watchdog_degraded";

export const EOD_PIN_WATCH_DEFAULTS = {
  /** How long the window stays open when the digest never appears. The sweep
   * is a single companion conversation; 90 minutes is generous for it and short
   * enough that the "after" read still lands the same evening. */
  windowMin: EOD_PINNED_WATCHDOG_WINDOW_MIN,
  /** How often the digest-arrival signal is checked. Cheap `existsSync`. */
  pollMs: 60_000,
  /** Deadline on ONE pinned read. Bounds how long a window close waits on a
   * sick store; it can never bound the injection, which is not awaited on it. */
  readTimeoutMs: 5_000,
} as const;

/**
 * The slice of a memory entry the fingerprint needs — a structural subset of
 * `MemoryEntry` (src/memory/store.ts), so a caller hands over store entries
 * with no adapter and this module needs no reader of its own.
 *
 * The ADDRESS is the (ts, id, block) triple, not `id`: a batch id is shared by
 * every entry written in the same batch (see the seam's own note). Fingerprint
 * by id alone and two pinned entries from one batch would collapse into one.
 */
export interface PinnedEntryView {
  id: string;
  ts: string;
  block: number;
  hash: string;
}

/** One reading of the pinned area, reduced to what a comparison needs. */
export interface PinnedSnapshot {
  /** sha256 over the sorted `address\0hash` lines — the whole-area digest. */
  fingerprint: string;
  /** address → content hash, so a difference can be NAMED, not just detected. */
  entries: ReadonlyMap<string, string>;
  /** Wall-clock ms the read completed at. */
  at: number;
}

type ReadOutcome = { ok: true; snapshot: PinnedSnapshot } | { ok: false; reason: string };

/** What changed between two snapshots. Empty on all three ⇒ nothing moved. */
export interface PinnedDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Human-readable address of one pinned entry. */
export function pinnedAddress(e: PinnedEntryView): string {
  return `${e.ts} #${e.id} block ${e.block}`;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reduce the pinned area to a stable digest plus its address→hash map.
 *
 * Pure and order-independent: the store may return pinned entries in any
 * order and the fingerprint is unchanged. Duplicate addresses (which the store
 * should never produce) are kept and disambiguated rather than silently
 * collapsed — a watchdog that loses entries is worse than one that reports an
 * odd address.
 */
export function fingerprintPinned(entries: readonly PinnedEntryView[], at = 0): PinnedSnapshot {
  const map = new Map<string, string>();
  // Duplicates are numbered in (address, hash) order, never input order.
  const ordered = entries
    .map((e) => ({ base: pinnedAddress(e), hash: e.hash }))
    .sort((a, b) => cmp(a.base, b.base) || cmp(a.hash, b.hash));
  for (const e of ordered) {
    const base = e.base;
    let key = base;
    for (let n = 2; map.has(key); n++) key = `${base} (dup ${n})`;
    map.set(key, e.hash);
  }
  const lines = [...map.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([k, h]) => `${k}\u0000${h}`);
  return {
    fingerprint: createHash("sha256").update(lines.join("\n")).digest("hex"),
    entries: map,
    at,
  };
}

/** Compare two readings of the pinned area. */
export function diffPinned(before: PinnedSnapshot, after: PinnedSnapshot): PinnedDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, hash] of after.entries) {
    const was = before.entries.get(key);
    if (was === undefined) added.push(key);
    else if (was !== hash) changed.push(key);
  }
  for (const key of before.entries.keys()) if (!after.entries.has(key)) removed.push(key);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function diffIsEmpty(d: PinnedDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

function wallHHMM(instant: number, timeZone: string): string {
  const p = zonedParts(new Date(instant), timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function bullets(label: string, keys: string[]): string[] {
  return keys.length === 0 ? [] : [`  ${label}:`, ...keys.map((k) => `    - ${k}`)];
}

/**
 * The companion's inbox text.
 *
 * It leads with the two explanations rather than an accusation, because the
 * watchdog genuinely cannot tell them apart (see the module header). An alert
 * that asserted "the curator broke the rule" would be wrong some of the time
 * and would train its reader to distrust it.
 */
export function renderPinnedModifiedMessage(input: {
  date: string;
  diff: PinnedDiff;
  before: PinnedSnapshot;
  after: PinnedSnapshot;
  timeZone: string;
}): string {
  const { date, diff, before, after, timeZone } = input;
  const from = wallHHMM(before.at, timeZone);
  const to = wallHHMM(after.at, timeZone);
  return [
    `ANOMALY (${PINNED_MODIFIED_KIND}) — the PINNED memory area changed during the ${date} EOD sweep window.`,
    "",
    `Window: ${from}–${to} ${timeZone}, opened the moment the sweep prompt was injected.`,
    `Fingerprint: ${before.fingerprint.slice(0, 12)} → ${after.fingerprint.slice(0, 12)}`,
    ...bullets("changed", diff.changed),
    ...bullets("added", diff.added),
    ...bullets("removed", diff.removed),
    "",
    "There are TWO explanations and this watchdog cannot tell them apart:",
    "  1. The EOD curator edited, consolidated or retired pinned entries. It must",
    "     never do that — the owner's standing instructions are off-limits to",
    "     curation. If this is what happened, the listed entries may be damaged:",
    "     say so to the owner (commands/flag-owner) with the addresses above and",
    "     do not attempt to restore them yourself.",
    "  2. The owner edited pins in the TUI inside that window. That is",
    "     normal and invisible to the daemon (the TUI writes straight to the",
    "     store), and nothing is wrong.",
    "",
    "Read the listed entries before concluding anything; do not assume (1).",
  ].join("\n");
}

/** Compact one-line detail for the durable anomaly row. */
export function renderPinnedModifiedDetail(
  date: string,
  diff: PinnedDiff,
  before: PinnedSnapshot,
  after: PinnedSnapshot,
): string {
  const parts: string[] = [];
  if (diff.changed.length > 0)
    parts.push(`changed ${diff.changed.length} [${diff.changed.join("; ")}]`);
  if (diff.added.length > 0) parts.push(`added ${diff.added.length} [${diff.added.join("; ")}]`);
  if (diff.removed.length > 0)
    parts.push(`removed ${diff.removed.length} [${diff.removed.join("; ")}]`);
  return (
    `pinned area changed during the ${date} EOD sweep window: ${parts.join(", ")} ` +
    `(${before.fingerprint.slice(0, 12)} → ${after.fingerprint.slice(0, 12)}); ` +
    `either the curator touched pinned entries or the owner edited pins in the TUI during the window`
  );
}

export function renderPinnedDegradedDetail(
  date: string,
  which: "before" | "after",
  reason: string,
): string {
  return (
    `pinned-area watchdog could not read the ${which}-sweep snapshot for ${date} (${reason}) — ` +
    `the pinned area went UNVERIFIED today; no conclusion either way. The watchdog never holds the sweep: whether it was delivered is the EOD timer's to report.`
  );
}

/** What `readPinnedFromSweep` needs of the memory store: a sweep that keeps
 * the parts it could not read beside the entries (`OpenVikingStore.sweep`),
 * and a way to drop that store's sweep cache (`OpenVikingStore.invalidate`). */
export interface PinnedSweepSource {
  /** Drop any cached sweep so the next one reads storage. Production shares
   * ONE cached store with the round path, and the curator writes through the
   * pi extension straight over HTTP — its writes never invalidate that cache,
   * so without this a snapshot could be a round's pre-edit observation. */
  invalidate?(): void;
  sweep(): Promise<{
    entries: ReadonlyArray<PinnedEntryView & { pinned: boolean }>;
    unread: readonly string[];
  }>;
  /** The pinned area alone (`OpenVikingStore.pinnedSweep`) — the
   * directory the round's head reads. Preferred when present: the watchdog
   * then reads exactly what every round reads, and never the whole store. */
  pinnedSweep?(): Promise<{
    entries: ReadonlyArray<PinnedEntryView & { pinned: boolean }>;
    unread: readonly string[];
  }>;
}

/**
 * The production `readPinned`. It reads through `pinnedSweep()` (or
 * `sweep()`), never `read()`: `read()` folds a dead server or a skipped file
 * into a smaller list, and the watchdog would take that for a real pinned
 * area — reporting every pin removed when only the after-read failed, or
 * "unchanged" when both did. A read that could not see everything REJECTS,
 * which is the watchdog's own "could not check" path.
 */
export function readPinnedFromSweep(
  source: PinnedSweepSource,
): () => Promise<readonly PinnedEntryView[]> {
  return async () => {
    // Every snapshot must be storage as it is NOW, never a cached earlier read.
    source.invalidate?.();
    const { entries, unread } = source.pinnedSweep
      ? await source.pinnedSweep()
      : await source.sweep();
    if (unread.length > 0) {
      const more = unread.length > 3 ? ` (+${unread.length - 3} more)` : "";
      throw new Error(`memory store not fully readable: ${unread.slice(0, 3).join("; ")}${more}`);
    }
    return entries.filter((e) => e.pinned);
  };
}

export interface EodPinWatchDeps {
  /** The pinned entries as the store holds them right now — in practice
   * `readPinnedFromSweep(store)` over the ONE memory seam. It may reject,
   * throw synchronously or never settle; all three degrade and none of them
   * can touch the sweep. */
  readPinned: () => Promise<readonly PinnedEntryView[]>;
  /** `StateStore.logAnomaly` — the watchdog's ONLY output. */
  logAnomaly: (
    kind: string,
    pr: number | null,
    roundNo: number | null,
    detail: string,
    injectMessage?: string,
  ) => void;
  /** Same zone as the EOD timer; only used to name the day and the window. */
  timeZone: string;
  /** True once `digest/<date>.md` exists — the sweep's own completion signal,
   * which closes the window early. Omitted ⇒ the window always runs its full
   * length. */
  digestReady?: ((date: string) => boolean) | undefined;
  windowMin?: number | undefined;
  pollMs?: number | undefined;
  readTimeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
  setTimer?: ((cb: () => void, ms: number) => TimerHandle) | undefined;
  clearTimer?: ((handle: TimerHandle) => void) | undefined;
  log?: ((msg: string, extra?: unknown) => void) | undefined;
}

export interface EodPinWatch {
  /**
   * Wrap the EOD timer's `writeInbox`. The returned function opens the
   * watch window and then delegates — it adds no await ahead of the inject and
   * cannot reject on the watchdog's behalf. `date` is the day the sweep is
   * for (a drain-deferred day fires later than its own evening); the window
   * is named after it and its digest is what closes the window. Without one
   * the window takes today's date.
   */
  wrapInject(
    inner: (message: string, date?: string) => Promise<void>,
  ): (message: string, date?: string) => Promise<void>;
  /** True until the open sweep window and its closing snapshot are finished. */
  isOpen(): boolean;
  /** Resolves when the most recent window CLOSE has been judged; resolves
   * immediately when no judgement is in flight. Tests await this; production
   * never needs it. */
  settled(): Promise<void>;
  /** Drop timers on shutdown. An open window is abandoned unjudged (a restart
   * mid-sweep is not evidence of anything). */
  stop(): void;
}

interface OpenWindow {
  date: string;
  opened: number;
  /** The "before" read, already in flight before the prompt was injected. */
  before: Promise<ReadOutcome>;
  /** The digest for this date was ALREADY on disk when the window opened, so
   * its presence says nothing about THIS sweep and cannot close the window. */
  digestPreexisting: boolean;
  timer: TimerHandle | null;
}

/**
 * Arm the pinned-area watchdog.
 *
 * Nothing happens until the wrapped inject fires; between sweeps the watchdog
 * holds no timer and makes no calls.
 */
export function startEodPinWatch(deps: EodPinWatchDeps): EodPinWatch {
  const now = deps.now ?? ((): Date => new Date());
  const setT = deps.setTimer ?? ((cb: () => void, ms: number): TimerHandle => setTimeout(cb, ms));
  const clearT =
    deps.clearTimer ?? ((h: TimerHandle): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? ((): void => {});
  const windowMs = Math.max(0, (deps.windowMin ?? EOD_PIN_WATCH_DEFAULTS.windowMin) * 60_000);
  const pollMs = Math.max(1, deps.pollMs ?? EOD_PIN_WATCH_DEFAULTS.pollMs);
  const readTimeoutMs = Math.max(1, deps.readTimeoutMs ?? EOD_PIN_WATCH_DEFAULTS.readTimeoutMs);

  let win: OpenWindow | null = null;
  const closing = new Set<OpenWindow>();
  let stopped = false;
  /** The most recent close's judgement — awaited only by tests. */
  let lastJudgement: Promise<void> = Promise.resolve();

  /** One pinned read, total: every failure mode becomes `{ ok: false }`.
   *
   * The reader is invoked SYNCHRONOUSLY (not deferred through
   * `Promise.resolve().then(fn)`), because ordering is the whole point of the
   * "before" snapshot: the read is issued before the sweep prompt is
   * injected, so it starts ahead of any curator write (the injection never
   * waits for it to finish). A sync throw is caught here and degrades exactly
   * like a rejection. */
  const readSnapshot = (): Promise<ReadOutcome> => {
    let started: Promise<readonly PinnedEntryView[]>;
    try {
      started = Promise.resolve(deps.readPinned());
    } catch (err) {
      return Promise.resolve({ ok: false, reason: `error: ${String(err)}` });
    }
    return withinBudget(started, readTimeoutMs)
      .then((read): ReadOutcome => {
        if (read.kind === "budget")
          return { ok: false, reason: `timeout after ${readTimeoutMs}ms` };
        const value: unknown = read.value;
        if (!Array.isArray(value)) return { ok: false, reason: "reader returned no entry list" };
        return {
          ok: true,
          snapshot: fingerprintPinned(value as readonly PinnedEntryView[], now().getTime()),
        };
      })
      .catch((err): ReadOutcome => ({ ok: false, reason: `error: ${String(err)}` }));
  };

  const judge = async (w: OpenWindow, closedBy: string): Promise<void> => {
    // `w.before` was issued before the injection and is bounded by
    // readTimeoutMs, so awaiting it HERE cannot delay anything that matters.
    const before = await w.before;
    if (stopped) return;
    if (!before.ok) {
      log(`eod pin watch: no before-snapshot for ${w.date} — ${before.reason}`);
      deps.logAnomaly(
        PINNED_DEGRADED_KIND,
        null,
        null,
        renderPinnedDegradedDetail(w.date, "before", before.reason),
      );
      return;
    }
    const after = await readSnapshot();
    // A judgement still reading when the watchdog stops is dropped unjudged,
    // like an open window.
    if (stopped) return;
    if (!after.ok) {
      log(`eod pin watch: no after-snapshot for ${w.date} — ${after.reason}`);
      deps.logAnomaly(
        PINNED_DEGRADED_KIND,
        null,
        null,
        renderPinnedDegradedDetail(w.date, "after", after.reason),
      );
      return;
    }
    const diff = diffPinned(before.snapshot, after.snapshot);
    if (diffIsEmpty(diff)) {
      log(
        `eod pin watch: pinned area unchanged across the ${w.date} sweep (closed by ${closedBy}, ${before.snapshot.fingerprint.slice(0, 12)})`,
      );
      return;
    }
    log(`eod pin watch: PINNED AREA CHANGED across the ${w.date} sweep (closed by ${closedBy})`);
    deps.logAnomaly(
      PINNED_MODIFIED_KIND,
      null,
      null,
      renderPinnedModifiedDetail(w.date, diff, before.snapshot, after.snapshot),
      renderPinnedModifiedMessage({
        date: w.date,
        diff,
        before: before.snapshot,
        after: after.snapshot,
        timeZone: deps.timeZone,
      }),
    );
  };

  const close = (w: OpenWindow, closedBy: string): void => {
    if (win !== w) return;
    win = null;
    if (w.timer !== null) clearT(w.timer);
    w.timer = null;
    closing.add(w);
    lastJudgement = judge(w, closedBy)
      .catch((err) => log("eod pin watch: judgement failed — pinned area unverified today", err))
      .finally(() => {
        closing.delete(w);
      });
  };

  const poll = (w: OpenWindow): void => {
    if (stopped || win !== w) return;
    let digestArrived = false;
    if (!w.digestPreexisting && deps.digestReady) {
      try {
        digestArrived = deps.digestReady(w.date);
      } catch (err) {
        log("eod pin watch: digest check failed — falling back to the window timer", err);
      }
    }
    if (digestArrived) {
      close(w, "digest");
      return;
    }
    if (now().getTime() - w.opened >= windowMs) {
      close(w, "window");
      return;
    }
    w.timer = setT(() => poll(w), pollMs);
  };

  const open = (forDate?: string): void => {
    if (stopped) return;
    const previous = win;
    // A second fire while a window is open should not happen: the EOD timer
    // holds every fire while `isOpen()` (its `sweepInFlight`), drain-deferred
    // days included — judge the old one on what it has rather than losing it.
    if (previous) close(previous, "superseded");

    const at = now();
    const date =
      forDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(forDate)
        ? forDate
        : zoneDateString(at, deps.timeZone);
    let digestPreexisting = false;
    if (deps.digestReady) {
      try {
        digestPreexisting = deps.digestReady(date);
      } catch {
        digestPreexisting = false;
      }
    }
    const w: OpenWindow = {
      date,
      opened: at.getTime(),
      // Issued HERE, before the caller injects, so the read starts ahead of
      // the curator. Best effort: the injection does not wait for it, and a
      // curator write landing before the read completes would sit in the
      // "before" snapshot and go unseen.
      before: readSnapshot(),
      digestPreexisting,
      timer: null,
    };
    win = w;
    if (windowMs === 0) {
      close(w, "window");
      return;
    }
    w.timer = setT(() => poll(w), Math.min(pollMs, windowMs));
  };

  return {
    wrapInject(inner) {
      return (message: string, date?: string): Promise<void> => {
        // Everything the watchdog does at fire time is inside this try, and
        // nothing in it is awaited: the injection below runs in the same tick
        // whatever the store is doing. This is the "never delays the sweep"
        // property, and it is structural rather than a timeout.
        try {
          open(date);
        } catch (err) {
          log("eod pin watch: could not open the window — sweep proceeds unwatched", err);
        }
        return inner(message, date);
      };
    },
    isOpen: () => win !== null || closing.size > 0,
    settled: () => lastJudgement,
    stop() {
      stopped = true;
      closing.clear();
      const w = win;
      win = null;
      // A restart mid-sweep is not evidence of anything: the window is dropped
      // unjudged rather than reported as a change.
      if (w?.timer != null) clearT(w.timer);
    },
  };
}
