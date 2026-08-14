// Deterministic dispatch (spec §3). No LLM in this path: FIFO by trigger time,
// at most `daemon.max_concurrent_rounds` rounds in flight, triggers consumed at
// dispatch, lenses/gates derived from the files API by the ported heuristics.
//
// The round order (types.ts `RoundOrder`) is the daemon↔session contract; the
// prompt renderer is injected (B4 owns src/templates.ts) so this module has no
// content dependency.
import type { Config } from "./config.js";
import type { GateResult } from "./gate.js";
import type { PrFileEntry } from "./github.js";
import { escalationWorthy, migrationGate, selectLenses } from "./heuristics.js";
import { applyEvent, setPrGates } from "./statemachine.js";
import type { PrStateRow, StateStore } from "./state.js";
import type { RoundOrder, RoundType, SessionHooks } from "./types.js";

/** The slice of GitHubAdapter dispatch needs — all mutations are gated inside
 * the adapter, so this module never touches GitHub directly. */
export interface DispatchAdapter {
  listPrFiles(n: number): Promise<PrFileEntry[]>;
  addLabel(n: number, label: string): Promise<GateResult>;
  removeLabel(n: number, label: string): Promise<GateResult>;
  deleteTeamReviewRequest(n: number): Promise<GateResult>;
}

export interface DispatchDeps {
  cfg: Config;
  store: StateStore;
  adapter: DispatchAdapter;
  hooks: SessionHooks;
  /** B4's template renderer, injected. Default: the order as JSON. */
  renderPrompt?: (order: RoundOrder) => string;
  /** SETTLED digest carried from the session ledger (B3/B4). */
  settledDigest?: (pr: number) => string;
  worktreeFor?: (pr: number) => string;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export function defaultWorktree(pr: number): string {
  return `wt/pr-${pr}`;
}

/** Round type: first ever round → "first"; a staleness recheck → "staleness";
 * anything else → "re-review". */
export function roundTypeFor(row: PrStateRow, priorRounds: number): RoundType {
  if (priorRounds === 0) return "first";
  if (row.stale_recheck) return "staleness";
  return "re-review";
}

/** Queued PRs in FIFO order by trigger time (nulls last, then PR number).
 * Overseer-paused PRs never dispatch. */
export function queuedInOrder(store: StateStore): PrStateRow[] {
  return store
    .allPrs()
    .filter((p) => p.state === "queued" && !p.paused)
    .sort((a, b) => {
      const at = a.trigger_ts ?? "";
      const bt = b.trigger_ts ?? "";
      if (at === bt) return a.number - b.number;
      if (!at) return 1;
      if (!bt) return -1;
      return at < bt ? -1 : 1;
    });
}

export function capacity(store: StateStore, cfg: Config): number {
  return Math.max(0, cfg.daemon.max_concurrent_rounds - store.runningRounds().length);
}

/** A consume target that is already gone (label removed in an earlier round,
 * no pending team request) comes back as a 404 — that is consumption already
 * done, not a failure. */
function alreadyConsumed(err: unknown): boolean {
  return /→ 404\b|"status":\s*"404"/.test(String(err));
}

/** Consume both triggers at dispatch: the label and the team review request.
 * Both go through the adapter (and therefore the dry-run gate); failures are
 * logged, never fatal — the reconcile poll re-derives the truth. */
async function consumeTriggers(deps: DispatchDeps, pr: number): Promise<string[]> {
  const consumed: string[] = [];
  const log = deps.log ?? (() => {});
  try {
    await deps.adapter.removeLabel(pr, deps.cfg.github.trigger_label);
    consumed.push("label");
  } catch (err) {
    if (alreadyConsumed(err)) {
      consumed.push("label");
      deps.store.logEvent("trigger_already_consumed", pr, { which: "label" });
    } else {
      log(`dispatch: label removal failed on #${pr}`, err);
      deps.store.logEvent("trigger_consume_failed", pr, { which: "label", error: String(err) });
    }
  }
  try {
    await deps.adapter.deleteTeamReviewRequest(pr);
    consumed.push("team_request");
  } catch (err) {
    if (alreadyConsumed(err)) {
      consumed.push("team_request");
      deps.store.logEvent("trigger_already_consumed", pr, { which: "team_request" });
    } else {
      log(`dispatch: team-request DELETE failed on #${pr}`, err);
      deps.store.logEvent("trigger_consume_failed", pr, { which: "team_request", error: String(err) });
    }
  }
  try {
    await deps.adapter.addLabel(pr, deps.cfg.github.in_progress_label);
  } catch (err) {
    log(`dispatch: in-progress label failed on #${pr}`, err);
  }
  return consumed;
}

/** Build the round order for one PR — pure once the files list is in hand. */
export function buildRoundOrder(args: {
  row: PrStateRow;
  files: PrFileEntry[];
  roundId: number;
  roundNo: number;
  roundType: RoundType;
  worktree: string;
  settledDigest: string;
  issuedAt: string;
}): RoundOrder {
  const { worthy, reasons } = escalationWorthy(args.files);
  const lenses = [...selectLenses(args.files), "pass-validate"];
  return {
    pr: args.row.number,
    title: args.row.title,
    round_id: args.roundId,
    round_no: args.roundNo,
    round_type: args.roundType,
    lenses,
    escalation_worthy: worthy,
    escalation_reasons: reasons,
    migration_gate: migrationGate(args.files),
    head_sha: args.row.head_sha,
    worktree: args.worktree,
    settled_digest: args.settledDigest,
    issued_at: args.issuedAt,
  };
}

// A reconcile, webhook and periodic tick may all ask for a pump at once. The
// store is the daemon-instance identity; joiners wait for the active pump and
// return no duplicate orders. This closes the race where two pumps both saw a
// queued PR/capacity slot and created two rounds for it.
const activePumps = new WeakMap<StateStore, Promise<RoundOrder[]>>();

/** One serialized dispatch pump: drain the queue up to the concurrency cap. */
export async function dispatchOnce(deps: DispatchDeps): Promise<RoundOrder[]> {
  const active = activePumps.get(deps.store);
  if (active) {
    await active;
    return [];
  }
  const pump = dispatchUnlocked(deps);
  activePumps.set(deps.store, pump);
  try {
    return await pump;
  } finally {
    if (activePumps.get(deps.store) === pump) activePumps.delete(deps.store);
  }
}

async function dispatchUnlocked(deps: DispatchDeps): Promise<RoundOrder[]> {
  const { store, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const render = deps.renderPrompt ?? ((o: RoundOrder) => JSON.stringify(o, null, 2));
  const worktreeFor = deps.worktreeFor ?? defaultWorktree;
  const settledDigest = deps.settledDigest ?? (() => "");
  const log = deps.log ?? (() => {});

  const slots = capacity(store, cfg);
  if (slots <= 0) return [];

  const dispatched: RoundOrder[] = [];
  const running = new Set(store.runningRounds().map((r) => r.pr));
  for (const row of queuedInOrder(store).slice(0, slots)) {
    // One PR = one worktree = at most one round in flight. A queued row with a
    // round still running (requeue raced the verdict) waits for the next pump —
    // two rounds sharing wt/pr-<n> fight over the git index.
    if (running.has(row.number)) {
      log(`dispatch: #${row.number} skipped — a round is already running`);
      continue;
    }
    let provisionalRoundId: number | undefined;
    try {
      const priorRounds = (
        store.db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ?").get(row.number) as { c: number }
      ).c;
      const roundType = roundTypeFor(row, priorRounds);
      const consumed = await consumeTriggers(deps, row.number);

      const files = await deps.adapter.listPrFiles(row.number);
      const { worthy } = escalationWorthy(files);
      const gate = migrationGate(files);
      const lenses = [...selectLenses(files), "pass-validate"];

      const roundId = store.startRound(row.number, roundType, lenses, cfg.daemon.round_deadline_min);
      provisionalRoundId = roundId;
      const roundNo = (store.db.prepare("SELECT round_no FROM rounds WHERE id = ?").get(roundId) as { round_no: number })
        .round_no;

      const order = buildRoundOrder({
        row,
        files,
        roundId,
        roundNo,
        roundType,
        worktree: worktreeFor(row.number),
        settledDigest: settledDigest(row.number),
        issuedAt: now().toISOString(),
      });

      // The round is provisional until the worktree/session/prompt handoff
      // completes. Publishing reviewing/running state earlier created orphan
      // rounds whenever worktree preparation failed.
      await deps.hooks.dispatchRound(order, render(order));

      setPrGates(store, row.number, worthy, gate);
      applyEvent(store, row.number, { type: "dispatched" }, {}, { botLogin: cfg.github.bot_login, now });
      store.logEvent("round_dispatched", row.number, {
        round_id: roundId,
        round_no: roundNo,
        round_type: roundType,
        lenses: order.lenses,
        escalation_worthy: order.escalation_worthy,
        migration_gate: order.migration_gate,
        triggers_consumed: consumed,
      });
      provisionalRoundId = undefined;
      dispatched.push(order);
    } catch (err) {
      // One bad PR must never stall the pump. A failed session handoff leaves
      // the PR queued for retry and consumes no round-capacity slot.
      if (provisionalRoundId !== undefined) store.discardRunningRound(provisionalRoundId);
      log(`dispatch: #${row.number} failed`, err);
      store.logEvent("dispatch_failed", row.number, { round_id: provisionalRoundId ?? null, error: String(err) });
    }
  }
  return dispatched;
}
