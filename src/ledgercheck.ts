// Daemon-side ledger freshness enforcement.
//
// The prompt mandate "rewrite your ledger at round end" did not stick: the
// 2026-08-19 audit found the end-of-round ledger write missing in 0/8
// post-deploy and skipped in 4/6 pre-deploy rounds. So the daemon now checks:
// after each verdicted round (once ledger-pin's mirror has had its chance,
// i.e. AFTER compactSession) it parses `state/ledgers/pr-<n>.md` and requires
// the header `LEDGER PR #<n> @ <round head sha>`.
//
// Stale/missing/wrong-PR ⇒ a queryable anomaly (`ledger_stale`,
// channel) AND exactly ONE re-nudge wake through `wakeOrHold` telling the
// session to ONLY rewrite its ledger — no review work, no posting, no verdict
// file. A second stale detection for the same round logs the anomaly again
// but never nudges again: the once-mark is persisted BEFORE the inject, so
// even a crashed inject can never turn into a nudge loop.
import { readFileSync } from "node:fs";
import type { StateStore } from "./state.js";
import { wakeOrHold } from "./wakes.js";

/** The mirrored snapshot's header (see extensions/ledger-pin.ts LEDGER_RE):
 * `LEDGER PR #<n> @ <sha>`. The sha is whatever the session wrote — often
 * abbreviated — so freshness accepts a ≥7-char hex prefix of the round head. */
export const LEDGER_HEADER_RE = /LEDGER\s+PR\s+#(\d+)\s*@\s*([0-9a-fA-F]+)/;

export type LedgerFreshness = "fresh" | "missing" | "unparseable" | "wrong_pr" | "stale_sha";

/** Minimum abbreviated-sha length accepted as a prefix of the round head. */
const MIN_SHA_PREFIX = 7;

/**
 * Classify a ledger snapshot against the round's PR + head. `null` content
 * means the file was missing/unreadable. Anything but "fresh" is enforced
 * identically (anomaly + capped nudge) — the distinction is for the record.
 */
export function classifyLedger(
  content: string | null,
  pr: number,
  headSha: string,
): LedgerFreshness {
  if (content === null) return "missing";
  const match = LEDGER_HEADER_RE.exec(content);
  if (!match) return "unparseable";
  if (Number(match[1]) !== pr) return "wrong_pr";
  const written = (match[2] as string).toLowerCase();
  const head = headSha.toLowerCase();
  const fresh = written === head || (written.length >= MIN_SHA_PREFIX && head.startsWith(written));
  return fresh ? "fresh" : "stale_sha";
}

/** The re-nudge wake. Explicitly bookkeeping-only: the rewrite arrives
 * OUTSIDE a round, and the session must not mistake it for review work. */
export function ledgerRewriteWake(pr: number, headSha: string): string {
  return [
    `LEDGER REFRESH — PR #${pr}`,
    `Your ledger snapshot (state/ledgers/pr-${pr}.md) is missing or stale for the round that just ended.`,
    `Rewrite ONLY your ledger block now, in this conversation, headed exactly: LEDGER PR #${pr} @ ${headSha}`,
    "Do NOT do any review work, do NOT post anything to GitHub, do NOT run passes, and do NOT write a verdict file — this is a bookkeeping rewrite only.",
  ].join("\n");
}

export interface LedgerCheckDeps {
  store: StateStore;
  /** Where the mirrored snapshot lives — sessions.ts ledgerPath(`pr-<n>`). */
  ledgerPathFor: (pr: number) => string;
  /** SessionHooks.inject — rides wakeOrHold, so a mid-round check holds. */
  inject: (pr: number, message: string) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
}

export interface LedgerCheckTarget {
  pr: number;
  /** The verdicted round, when the caller has one (round end). Null for the
   * recheck-uphold path — the once-per-round key falls back to the head. */
  roundNo: number | null;
  headSha: string;
}

export type LedgerCheckResult = "fresh" | "nudged" | "already_nudged" | "superseded";

/**
 * The enforcement step. Fresh ⇒ nothing. Otherwise: logAnomaly("ledger_stale")
 * every time, plus at most ONE nudge per round (per head on the round-less
 * recheck path). A round-keyed check that a later round has already
 * overtaken is "superseded": event only, no anomaly, no nudge. Read failures are treated as "missing" — enforcement, not
 * crash — and the caller additionally wraps this in its own safe().
 */
export async function enforceLedgerFreshness(
  deps: LedgerCheckDeps,
  target: LedgerCheckTarget,
): Promise<LedgerCheckResult> {
  const { store, log } = deps;
  const { pr, roundNo, headSha } = target;
  const path = deps.ledgerPathFor(pr);
  let content: string | null = null;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    content = null;
  }
  const freshness = classifyLedger(content, pr, headSha);
  if (freshness === "fresh") return "fresh";

  const detail = `ledger ${freshness} at ${path}: expected header "LEDGER PR #${pr} @ ${headSha}"`;
  log?.(`ledger: #${pr}${roundNo !== null ? ` round ${roundNo}` : ""} ${freshness}`, {
    path,
    head_sha: headSha,
  });

  // Superseded: the check runs on a settle delay, and by then the PR's next
  // round may already have started (a fresh-head successor is promoted at
  // verdict time). That round owns the ledger now and has its own check; a
  // rewrite wake for THIS round would be held behind it and delivered after
  // it, demanding the older head's header over the newer snapshot. Keep the
  // miss on record, nudge nothing.
  if (roundNo !== null && store.roundsFor(pr).some((r) => r.round_no > roundNo)) {
    store.logEvent("ledger_check_superseded", pr, {
      round_no: roundNo,
      head_sha: headSha,
      freshness,
    });
    return "superseded";
  }

  // Once-per-round cap: the mark is stamped BEFORE the inject, so no failure
  // mode ever nudges twice — the safety direction is "never a loop", and the
  // wake itself is best-effort on top of a durable anomaly record.
  const key = roundNo !== null ? `round-${roundNo}` : `head-${headSha}`;
  if (store.ledgerNudgeSent(pr, key)) {
    // Still stale AFTER the re-nudge: the session ignored its one nudge —
    // this grade WAKES the overseer (severity map), first-detection
    // "ledger_stale" stays quiet (the nudge itself is the response).
    store.logAnomaly("ledger_stale_unresolved", pr, roundNo, detail);
    store.logEvent("ledger_stale_repeat", pr, { round_no: roundNo, head_sha: headSha, freshness });
    return "already_nudged";
  }
  store.logAnomaly("ledger_stale", pr, roundNo, detail);
  store.recordLedgerNudge(pr, key, { round_no: roundNo, head_sha: headSha, freshness });
  await wakeOrHold(
    { store, inject: deps.inject, ...(log ? { log } : {}) },
    pr,
    ledgerRewriteWake(pr, headSha),
    "ledger_stale",
  );
  return "nudged";
}
