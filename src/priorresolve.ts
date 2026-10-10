// Resolving the bot's own threads for findings a follow-up round verified
// FIXED.
//
// A follow-up round verifies every open prior finding at the new head and
// reports each one's status in its findings record's `prior` array (stored
// in `prior_finding_checks`). Ping-pong resolves a thread only when the
// author replies in it, so a finding fixed by a push with no reply would
// otherwise keep its thread open, and the reviewed repo's merge rule (every
// conversation resolved) would leave a human to resolve the bot's threads.
//
// So when a round's findings record lands, the daemon resolves the bot's own
// root comment of every prior finding that round reported `fixed` or
// `obsolete` (the code it was anchored on is gone) — through the adapter's one
// resolve path, `resolveOwnReviewThread`, which reads the thread first and
// resolves only a thread whose root the bot authored, refuses a `[check this]`
// or `[deferred]` thread (both human-only to resolve; `[check this]` is
// CLAUDE.md rule 10), and goes through the MutationGate (suppressed in
// dry-run like every other kind).
// `open`, `unverifiable`, `conceded` and `settled` are left alone: an open one
// still holds, and the last two are ping-pong's and the ledger's.
//
// Which comment is a finding's: the outcome capture's settled link
// (`finding_comments`) for that posting, else the findings
// record's own `thread_id`. A finding re-posted across rounds (a carried
// chain) has a thread per posting; the round reported its latest ref, and the
// earlier postings' threads are resolved with it when the round's prior list
// sidecar names them (`earlier_refs`). A thread with no known comment is
// logged, never guessed.
//
// Total and quiet: every resolve is its own try, every outcome an event
// (`prior_thread_resolved` / `prior_thread_resolve_skipped` /
// `prior_thread_resolve_failed`), and nothing here wakes anyone or holds a
// round. It never unresolves anything and never touches another identity's
// thread.

import { readFileSync } from "node:fs";
import type { GitHubAdapter } from "./github.js";
import type { StateStore } from "./state.js";

/** The prior statuses whose thread the bot resolves. */
export const RESOLVABLE_PRIOR_STATUSES: ReadonlySet<string> = new Set(["fixed", "obsolete"]);

/** One thread to resolve: the finding it belongs to and its root comment. */
export interface PriorThread {
  round_no: number;
  finding_key: string;
  status: string;
  comment_id: number;
}

/** A finding's root comments: the outcome capture's settled link for that
 * posting, else the findings record's `thread_id`. */
function commentIdsOf(
  store: StateStore,
  pr: number,
  roundNo: number,
  findingKey: string,
): number[] {
  const ids = new Set<number>();
  const hasLinks = store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'finding_comments'")
    .get();
  if (hasLinks) {
    for (const r of store.db
      .prepare(
        "SELECT comment_id FROM finding_comments WHERE pr = ? AND round_no = ? AND finding_key = ?",
      )
      .all(pr, roundNo, findingKey) as Array<{ comment_id: number }>)
      ids.add(r.comment_id);
  }
  if (ids.size === 0) {
    for (const r of store.db
      .prepare(
        "SELECT thread_id FROM round_findings WHERE pr = ? AND round_no = ? AND finding_key = ? AND thread_id IS NOT NULL",
      )
      .all(pr, roundNo, findingKey) as Array<{ thread_id: number }>)
      ids.add(r.thread_id);
  }
  return [...ids];
}

/** The earlier postings of each listed finding, from the round's prior-list
 * sidecar (`{findings:[{ref, earlier_refs}]}`); empty when unreadable. */
export function earlierRefsFromSidecar(text: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!text) return out;
  try {
    const parsed = JSON.parse(text) as { findings?: Array<{ ref?: unknown; earlier_refs?: unknown }> };
    for (const f of parsed.findings ?? []) {
      if (typeof f.ref !== "string" || !Array.isArray(f.earlier_refs)) continue;
      out.set(
        f.ref,
        f.earlier_refs.filter((r): r is string => typeof r === "string"),
      );
    }
  } catch {
    /* an unreadable sidecar resolves the latest posting's thread only */
  }
  return out;
}

const parseRef = (ref: string): { round_no: number; finding_key: string } | null => {
  const at = ref.indexOf(":");
  if (at <= 0) return null;
  const round = Number.parseInt(ref.slice(0, at), 10);
  return Number.isInteger(round) ? { round_no: round, finding_key: ref.slice(at + 1) } : null;
};

/**
 * The threads to resolve for round `checkedRound` of `pr`: every prior finding
 * it reported fixed or obsolete, with each posting's root comment. Findings
 * with no known comment are returned in `unlinked`, for the log.
 */
export function priorThreadsToResolve(
  store: StateStore,
  pr: number,
  checkedRound: number,
  earlier: Map<string, string[]> = new Map(),
): { threads: PriorThread[]; unlinked: string[] } {
  const threads: PriorThread[] = [];
  const unlinked: string[] = [];
  const seen = new Set<number>();
  for (const c of store.priorFindingChecks(pr)) {
    if (c.checked_round !== checkedRound || c.status === null) continue;
    if (!RESOLVABLE_PRIOR_STATUSES.has(c.status)) continue;
    const ref = `${c.round_no}:${c.finding_key}`;
    const postings = [
      { round_no: c.round_no, finding_key: c.finding_key },
      ...(earlier.get(ref) ?? []).map(parseRef).filter((p): p is NonNullable<typeof p> => p !== null),
    ];
    let linked = false;
    for (const p of postings) {
      for (const id of commentIdsOf(store, pr, p.round_no, p.finding_key)) {
        linked = true;
        if (seen.has(id)) continue;
        seen.add(id);
        threads.push({
          round_no: p.round_no,
          finding_key: p.finding_key,
          status: c.status,
          comment_id: id,
        });
      }
    }
    if (!linked) unlinked.push(ref);
  }
  return { threads, unlinked };
}

export interface PriorResolveDeps {
  store: StateStore;
  adapter: Pick<GitHubAdapter, "resolveOwnReviewThread">;
  /** The round's prior-list sidecar path (src/priorfindings.ts), for the
   * earlier postings of carried findings. */
  sidecarPath?: (pr: number, roundNo: number) => string;
  log?: (msg: string, extra?: unknown) => void;
}

/** Resolve the bot's own threads of every prior finding `roundNo` verified
 * fixed or obsolete. Total: never throws; each thread's outcome is an event. */
export async function resolveVerifiedPriorThreads(
  deps: PriorResolveDeps,
  pr: number,
  roundNo: number,
): Promise<{ resolved: number; skipped: number; failed: number; unlinked: number }> {
  const tally = { resolved: 0, skipped: 0, failed: 0, unlinked: 0 };
  let earlier = new Map<string, string[]>();
  if (deps.sidecarPath) {
    let text: string | undefined;
    try {
      text = readFileSync(deps.sidecarPath(pr, roundNo), "utf8");
    } catch {
      text = undefined;
    }
    earlier = earlierRefsFromSidecar(text);
  }
  let plan: ReturnType<typeof priorThreadsToResolve>;
  try {
    plan = priorThreadsToResolve(deps.store, pr, roundNo, earlier);
  } catch (err) {
    deps.log?.(`priorresolve: #${pr} round ${roundNo} threads not listed`, err);
    return tally;
  }
  tally.unlinked = plan.unlinked.length;
  if (plan.unlinked.length > 0)
    deps.store.logEvent("prior_thread_resolve_skipped", pr, {
      round_no: roundNo,
      reason: "no-known-comment",
      refs: plan.unlinked,
    });
  for (const t of plan.threads) {
    const base = {
      round_no: roundNo,
      ref: `${t.round_no}:${t.finding_key}`,
      comment_id: t.comment_id,
      status: t.status,
    };
    try {
      const r = await deps.adapter.resolveOwnReviewThread(pr, t.comment_id);
      if (r.skipped) {
        tally.skipped += 1;
        deps.store.logEvent("prior_thread_resolve_skipped", pr, { ...base, reason: r.skipped });
      } else if (r.result && r.result.executed === false) {
        // Dry-run, or a guard refused it: the gate's own record says which.
        tally.skipped += 1;
        deps.store.logEvent("prior_thread_resolve_skipped", pr, { ...base, reason: "not-executed" });
      } else {
        tally.resolved += 1;
        deps.store.logEvent("prior_thread_resolved", pr, base);
      }
    } catch (err) {
      tally.failed += 1;
      deps.store.logEvent("prior_thread_resolve_failed", pr, {
        ...base,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (plan.threads.length > 0 || plan.unlinked.length > 0)
    deps.log?.(
      `priorresolve: #${pr} round ${roundNo} — ${tally.resolved} thread(s) resolved, ${tally.skipped} skipped, ${tally.failed} failed, ${tally.unlinked} with no known comment`,
    );
  return tally;
}
