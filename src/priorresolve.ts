import { postedFindingChains } from "@quickchatai/pi-quickreview/src/priorfindings.js";
import { markerTwins, type FindingCommentRow } from "./outcomes.js";
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
// the never-hand-to-a-human rule), and goes through the MutationGate (suppressed in
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
// round. A resolve that fails for a reason other than the adapter's own
// refusal (a GitHub 5xx, a dropped connection) is tried again twice, a few
// seconds apart, before it is recorded failed. Durable per-thread outcomes
// let a restart resume only unfinished work; an exhausted failure is terminal. It never unresolves anything and never touches another identity's
// thread.

import { ThreadResolutionRefusal } from "./thread-resolution-refusal.js";
import { readFileSync } from "node:fs";
import { parsePriorRef } from "@quickchatai/pi-quickreview/src/findingsrecord.js";
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
  if (hasLinks) {
    const comments = store.db
      .prepare("SELECT * FROM finding_comments WHERE pr=? ORDER BY comment_id")
      .all(pr) as FindingCommentRow[];
    // A captured root may not have been linked yet. Its round's durable
    // thread id still establishes that root, but only its exact marker may
    // establish twins (a positional link does not confer marker identity).
    const rooted = comments.map((comment) =>
      ids.has(comment.comment_id) &&
      comment.round_no === null &&
      comment.finding_key === null &&
      comment.marker_round === roundNo &&
      comment.marker_key === findingKey
        ? { ...comment, round_no: roundNo, finding_key: findingKey, via: "marker" as const }
        : comment,
    );
    const twins = markerTwins(rooted);
    for (const id of [...ids]) for (const twin of twins.get(id) ?? []) ids.add(twin);
  }
  return [...ids];
}

/** The earlier postings of each listed finding, from the round's prior-list
 * sidecar (`{findings:[{ref, earlier_refs}]}`); empty when unreadable, with
 * the parse error handed to `onMalformed`. */
export function earlierRefsFromSidecar(
  text: string | undefined,
  onMalformed?: (err: unknown) => void,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!text) return out;
  try {
    const parsed = JSON.parse(text) as {
      findings?: Array<{ ref?: unknown; earlier_refs?: unknown }>;
    };
    for (const f of parsed.findings ?? []) {
      if (typeof f.ref !== "string" || !Array.isArray(f.earlier_refs)) continue;
      out.set(
        f.ref,
        f.earlier_refs.filter((r): r is string => typeof r === "string"),
      );
    }
  } catch (err) {
    // An unreadable sidecar resolves the latest posting's thread only.
    onMalformed?.(err);
  }
  return out;
}

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
  const checks = store.priorFindingChecks(pr);
  const families = postedFindingChains(store.roundFindings(pr));
  // A report decides only what came after the chain's latest posting (the
  // prior-list rule, packages/pi-plugin/src/priorfindings.ts): a posting at or after the checked
  // round re-opens the finding, and this round's fixed report no longer holds.
  const newer = (round: number, key: string) => {
    const root = families.find(`${round}:${key}`);
    return (
      (families.members.get(root) ?? []).some((m) => m.round_no >= checkedRound) ||
      checks.some(
        (c) =>
          families.find(`${c.round_no}:${c.finding_key}`) === root &&
          c.checked_round > checkedRound &&
          c.status !== null,
      )
    );
  };
  for (const c of checks) {
    if (c.checked_round !== checkedRound || c.status === null) continue;
    if (newer(c.round_no, c.finding_key)) continue;
    if (!RESOLVABLE_PRIOR_STATUSES.has(c.status)) continue;
    const ref = `${c.round_no}:${c.finding_key}`;
    const postings = [
      { round_no: c.round_no, finding_key: c.finding_key },
      ...(earlier.get(ref) ?? [])
        .map(parsePriorRef)
        .filter((p): p is NonNullable<typeof p> => p !== null),
    ];
    for (const p of postings) {
      if (newer(p.round_no, p.finding_key)) continue;
      const ids = commentIdsOf(store, pr, p.round_no, p.finding_key);
      if (ids.length === 0) unlinked.push(`${p.round_no}:${p.finding_key}`);
      for (const id of ids) {
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
  }
  return { threads, unlinked };
}

export interface PriorResolveDeps {
  store: StateStore;
  adapter: Pick<GitHubAdapter, "resolveOwnReviewThread">;
  /** The round's prior-list sidecar path (packages/pi-plugin/src/priorfindings.ts), for the
   * earlier postings of carried findings. */
  sidecarPath?: (pr: number, roundNo: number) => string;
  log?: (msg: string, extra?: unknown) => void;
  /** The waits before each retry of a failed resolve; default 2 s then 8 s. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

/** The adapter's own refusals (`resolveOwnReviewThread`): not this bot's
 * thread, or no thread at all. A retry cannot change either answer. */
function isRefusal(err: unknown): boolean {
  return err instanceof ThreadResolutionRefusal;
}

/** Retry a transient resolve failure; refusal or exhausted attempts reject
 * to the caller, which records the thread's outcome. */
async function resolveWithRetry(
  deps: PriorResolveDeps,
  pr: number,
  commentId: number,
  stillCurrent: () => boolean,
): Promise<Awaited<ReturnType<PriorResolveDeps["adapter"]["resolveOwnReviewThread"]>> | undefined> {
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    if (!stillCurrent()) return undefined;
    try {
      return await deps.adapter.resolveOwnReviewThread(pr, commentId);
    } catch (err) {
      if (attempt >= delays.length || isRefusal(err)) throw err;
      deps.log?.(`priorresolve: #${pr} thread ${commentId} resolve failed, retrying`, err);
      await sleep(delays[attempt]!);
    }
  }
}

export async function resolveVerifiedPriorThreads(
  deps: PriorResolveDeps,
  pr: number,
  roundNo: number,
): Promise<{
  resolved: number;
  skipped: number;
  failed: number;
  unlinked: number;
  readable: boolean;
}> {
  const tally = { resolved: 0, skipped: 0, failed: 0, unlinked: 0, readable: false };
  let earlier = new Map<string, string[]>();
  if (deps.sidecarPath) {
    const path = deps.sidecarPath(pr, roundNo);
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      // A round with no prior list (a full round) has no sidecar: that is
      // ordinary. Any other failure costs the earlier postings' threads.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        deps.log?.(
          `priorresolve: #${pr} round ${roundNo} sidecar ${path} unreadable — earlier postings' threads not resolved`,
          err,
        );
      text = undefined;
    }
    earlier = earlierRefsFromSidecar(text, (err) =>
      deps.log?.(
        `priorresolve: #${pr} round ${roundNo} sidecar ${path} malformed — earlier postings' threads not resolved`,
        err,
      ),
    );
  }
  let plan: ReturnType<typeof priorThreadsToResolve>;
  try {
    plan = priorThreadsToResolve(deps.store, pr, roundNo, earlier);
  } catch (err) {
    deps.log?.(`priorresolve: #${pr} round ${roundNo} threads not listed`, err);
    return tally;
  }
  tally.readable = true;
  tally.unlinked = plan.unlinked.length;
  if (plan.unlinked.length > 0)
    deps.store.logEvent("prior_thread_resolve_skipped", pr, {
      round_no: roundNo,
      reason: "no-known-comment",
      refs: plan.unlinked,
    });
  const completed = deps.store.db.prepare(`SELECT 1 FROM events WHERE pr=?
    AND kind IN ('prior_thread_resolved','prior_thread_resolve_skipped','prior_thread_resolve_failed')
    AND json_extract(payload, '$.round_no')=? AND json_extract(payload, '$.comment_id')=? LIMIT 1`);
  for (const t of plan.threads) {
    // A resumed invocation skips completed and exhausted outcomes. Retrying
    // interrupted work must never turn the finite retry policy into a loop.
    if (completed.get(pr, roundNo, t.comment_id)) {
      tally.skipped++;
      continue;
    }
    const base = {
      round_no: roundNo,
      ref: `${t.round_no}:${t.finding_key}`,
      comment_id: t.comment_id,
      status: t.status,
    };
    try {
      const r = await resolveWithRetry(deps, pr, t.comment_id, () =>
        priorThreadsToResolve(deps.store, pr, roundNo, earlier).threads.some(
          (current) => current.comment_id === t.comment_id && current.status === t.status,
        ),
      );
      if (r === undefined) {
        tally.skipped += 1;
        deps.store.logEvent("prior_thread_resolve_skipped", pr, {
          ...base,
          reason: "superseded-prior-report",
        });
      } else if (r.skipped) {
        tally.skipped += 1;
        deps.store.logEvent("prior_thread_resolve_skipped", pr, { ...base, reason: r.skipped });
      } else if (r.result && r.result.executed === false) {
        // Dry-run, or a guard refused it: the gate's own record says which.
        tally.skipped += 1;
        deps.store.logEvent("prior_thread_resolve_skipped", pr, {
          ...base,
          reason: "not-executed",
        });
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
