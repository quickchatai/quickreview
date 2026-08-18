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
import { migrationGate, passTier, selectLenses } from "./heuristics.js";
import type { DispatchAnnouncer } from "./slack/announce.js";
import { applyEvent, setPrGates } from "./statemachine.js";
import type { PrStateRow, StateStore } from "./state.js";
import type { PassPlanEntry, PassTier, RoundOrder, RoundType, SessionHooks } from "./types.js";

/** The slice of GitHubAdapter dispatch needs — all mutations are gated inside
 * the adapter, so this module never touches GitHub directly. */
export interface DispatchAdapter {
  listPrFiles(n: number): Promise<PrFileEntry[]>;
  /** Read-only; dispatch needs `base_ref` to keep the base branch fresh. */
  getPr(n: number): Promise<{ base_ref: string }>;
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
  /**
   * Fetch the PR head + its base branch and materialise the worktree, before
   * the round order is built. Returns what is actually on disk. Optional: the
   * stub-wired daemon core and unit tests have no git, and fall back to the PR
   * row's sha with no base facts.
   */
  prepareWorktree?: (
    pr: number,
    baseRef: string,
  ) => Promise<{ head_sha: string; base_ref: string; base_sha: string; merge_base: string }>;
  /** Slack announcer (S4). Optional: absent ⇒ no Slack at all, which
   * is what the stub-wired daemon core and every non-Slack test see. */
  announce?: DispatchAnnouncer;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export function defaultWorktree(pr: number): string {
  return `wt/pr-${pr}`;
}

/** PR size at the reviewed head, summed over the files API response. */
export function diffstatOf(files: PrFileEntry[]): { additions: number; deletions: number; changed_files: number } {
  return {
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    changed_files: files.length,
  };
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

/** Every pass the system knows: the lenses selectLenses can emit plus the
 * always-appended validator. addable_lenses derives from this set (∪ the
 * configured risk passes, which today are a subset of it). */
export const ALL_PASSES: readonly string[] = [
  "pass-baseline",
  "pass-ui",
  "pass-contracts",
  "pass-data-safety",
  "pass-security",
  "pass-statelessness",
  "pass-prod-risk",
  "pass-delivery",
  "pass-validate",
];

/** Tier ladder, ascending. raisable_to lists the higher rungs only — a session
 * may raise a pass, never lower it. */
const TIER_ORDER: readonly PassTier[] = ["terra-med", "sol-med", "sol-high"];

function raisableFrom(lens: string, tier: PassTier): string[] {
  return TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1).map((t) => `${lens}--${t}`);
}

/** Deterministic per-round pass plan (agent = `${lens}--${tier}`):
 * - risk passes are always "sol-high", single variant, not raisable;
 * - pass-validate is pinned to cfg.models.validate_tier, not raisable;
 * - every other selected lens gets the passTier() tier and may be raised to
 *   any higher tier's variant (ascending order).
 * addable_lenses = every known pass not already in the plan. */
export function buildPassPlan(
  cfg: Config,
  files: PrFileEntry[],
): { pass_plan: PassPlanEntry[]; addable_lenses: string[] } {
  const defaultTier = passTier(files, {
    migrationGate: migrationGate(files),
    smallDiffLines: cfg.models.small_diff_lines,
  });
  const risk = new Set(cfg.models.risk_passes);
  const lenses = [...selectLenses(files), "pass-validate"];
  const pass_plan = lenses.map((lens): PassPlanEntry => {
    const pinned = lens === "pass-validate" || risk.has(lens);
    const tier: PassTier = lens === "pass-validate" ? cfg.models.validate_tier : risk.has(lens) ? "sol-high" : defaultTier;
    return { lens, agent: `${lens}--${tier}`, tier, raisable_to: pinned ? [] : raisableFrom(lens, tier) };
  });
  const selected = new Set(lenses);
  const addable_lenses = [...new Set([...ALL_PASSES, ...cfg.models.risk_passes])].filter((l) => !selected.has(l));
  return { pass_plan, addable_lenses };
}

/** Build the round order for one PR — pure once the files list is in hand. */
export function buildRoundOrder(args: {
  cfg: Config;
  row: PrStateRow;
  files: PrFileEntry[];
  roundId: number;
  roundNo: number;
  roundType: RoundType;
  worktree: string;
  settledDigest: string;
  issuedAt: string;
  /** Facts established by preparing the worktree. Absent only for callers with
   * no worktree seam (the stub-wired daemon core and unit tests), which fall
   * back to the PR row's sha and an unknown base. */
  tree?: { head_sha: string; base_ref: string; base_sha: string; merge_base: string };
}): RoundOrder {
  const { pass_plan, addable_lenses } = buildPassPlan(args.cfg, args.files);
  return {
    pr: args.row.number,
    title: args.row.title,
    round_id: args.roundId,
    round_no: args.roundNo,
    round_type: args.roundType,
    // Kept for compatibility with the rounds table / event log: always the
    // pass_plan's lens names in plan order.
    lenses: pass_plan.map((p) => p.lens),
    pass_plan,
    addable_lenses,
    migration_gate: migrationGate(args.files),
    head_sha: args.tree?.head_sha || args.row.head_sha,
    base_ref: args.tree?.base_ref ?? "",
    base_sha: args.tree?.base_sha ?? "",
    merge_base: args.tree?.merge_base ?? "",
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
      // Backfilled (imported) rounds are excluded: a historical review must
      // never flip a still-open PR's next live round to "re-review", whose
      // template references a settled digest that never existed (§2.1).
      const priorRounds = store.priorRoundCount(row.number);
      const roundType = roundTypeFor(row, priorRounds);
      const consumed = await consumeTriggers(deps, row.number);

      // The branch this PR targets. Only used to keep the base fresh in the
      // clone; a failed read degrades to "no base facts", never a failed round.
      let baseRef = "";
      try {
        baseRef = (await deps.adapter.getPr(row.number)).base_ref;
      } catch (err) {
        log(`dispatch: base ref lookup failed on #${row.number}`, err);
      }

      const files = await deps.adapter.listPrFiles(row.number);
      const gate = migrationGate(files);
      const lenses = [...selectLenses(files), "pass-validate"];

      // Diffstat comes free off the files list dispatch already fetched — no
      // extra GitHub call in the hot path. trigger_ts is copied off pr_state
      // here because the `dispatched` transition clears it moments later.
      const diffstat = diffstatOf(files);
      const roundId = store.startRound(row.number, roundType, lenses, cfg.daemon.round_deadline_min, {
        ...diffstat,
        trigger_ts: row.trigger_ts,
      });
      provisionalRoundId = roundId;
      const roundNo = (store.db.prepare("SELECT round_no FROM rounds WHERE id = ?").get(roundId) as { round_no: number })
        .round_no;

      // Prepare the tree BEFORE building the order, so the prompt cites the sha
      // the passes will actually read. The old sequence built the order from
      // `row.head_sha` (a webhook/reconcile snapshot) and only then fetched, so
      // a push landing in between made the prompt quietly wrong — passes cited
      // one sha while reading another tree, and their anchors were computed
      // against a diff the review was not about.
      const tree = deps.prepareWorktree ? await deps.prepareWorktree(row.number, baseRef) : undefined;
      if (tree && row.head_sha && tree.head_sha !== row.head_sha) {
        log(`dispatch: #${row.number} head drift ${row.head_sha} → ${tree.head_sha}`);
        store.logEvent("head_drift", row.number, {
          round_id: roundId,
          expected: row.head_sha,
          actual: tree.head_sha,
          source: "worktree_prepare",
        });
      }

      const order = buildRoundOrder({
        tree,
        cfg,
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

      setPrGates(store, row.number, gate);
      applyEvent(store, row.number, { type: "dispatched" }, {}, { botLogin: cfg.github.bot_login, now });
      store.logEvent("round_dispatched", row.number, {
        round_id: roundId,
        round_no: roundNo,
        round_type: roundType,
        lenses: order.lenses,
        migration_gate: order.migration_gate,
        head_sha: order.head_sha,
        base_ref: order.base_ref,
        base_sha: order.base_sha,
        triggers_consumed: consumed,
      });
      // Slack (S4): the PR's thread root on the first round we see, a
      // 🔄 line in-thread on later ones. The announcer swallows its own
      // failures; the try/catch here is belt-and-braces — a Slack outage must
      // never stall the pump or leave a dispatched round unrecorded.
      if (deps.announce) {
        try {
          await deps.announce.roundStarted({
            pr: row.number,
            title: row.title,
            author: row.author,
            head_sha: order.head_sha,
            round_no: roundNo,
            round_type: roundType,
            lenses: order.lenses,
            additions: diffstat.additions,
            deletions: diffstat.deletions,
            changed_files: diffstat.changed_files,
          });
        } catch (err) {
          log(`dispatch: slack announcement failed on #${row.number}`, err);
        }
      }
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
