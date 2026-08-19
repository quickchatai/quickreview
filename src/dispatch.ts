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
import { INTENT_PASS, migrationGate, passTier, selectLenses } from "./heuristics.js";
import {
  collisionFingerprint,
  detectMigrationCollisions,
  renderMigrationCollisionComment,
  type MigrationCollision,
} from "./migrations.js";
import { VALIDATE_PASS } from "./include.js";
import { hasNewEvidence } from "./guards.js";
import { isFirstPartyDirectivePath } from "./severity.js";
import type { DispatchAnnouncer } from "./slack/announce.js";
import { applyEvent, setPrGates } from "./statemachine.js";
import type { PrStateRow, StateStore } from "./state.js";
import { higherTier, normalizeVerdict, PASS_TIER_ORDER } from "./types.js";
import type { PassPlanEntry, PassTier, RoundOrder, RoundType, SessionHooks } from "./types.js";

/** The slice of GitHubAdapter dispatch needs — all mutations are gated inside
 * the adapter, so this module never touches GitHub directly. */
export interface DispatchAdapter {
  listPrFiles(n: number): Promise<PrFileEntry[]>;
  /** Read-only; dispatch needs `base_ref` to keep the base branch fresh, and
   * `body` as pass-intent's artifact + substance-bar input. `body`
   * stays optional so legacy fakes and adapters remain valid — absent
   * body ⇒ the intent lens is simply never selected. */
  getPr(n: number): Promise<{ base_ref: string; body?: string }>;
  addLabel(n: number, label: string): Promise<GateResult>;
  removeLabel(n: number, label: string): Promise<GateResult>;
  deleteTeamReviewRequest(n: number): Promise<GateResult>;
  /** COMMENT delivery for the migration-collision pre-check — the
   * same gated `POST /pulls/<n>/reviews` the session's review uses. */
  createReview(
    n: number,
    payload: { commit_id: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string; comments?: unknown[] },
  ): Promise<GateResult>;
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
  /**
   * Every migration file present on the base branch at a commit.
   * Read-only git in the base clone, which the worktree preparation has just
   * re-fetched — so `base_sha` really is the branch's tip this round. Optional:
   * absent (stub-wired core, unit tests without git) ⇒ the collision pre-check
   * is skipped and logged, never fatal.
   */
  listBaseMigrations?: (baseSha: string) => Promise<string[]>;
  /**
   * The most recent human author of `paths` in the history reachable from
   * `sha` (WorktreeManager.lastHumanAuthor). Read-only git in the
   * base clone. Optional: absent (stub-wired core, unit tests without git) ⇒
   * the escalation mention falls back to config
   * `[review] escalation_mention_default`.
   */
  directiveAuthor?: (sha: string, paths: string[]) => Promise<{ login: string | null; name: string; email: string } | null>;
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

/**
 * Migration-number collision pre-check, run once per round after the
 * worktree is prepared and BEFORE the session is handed the order.
 *
 * A PR migration sitting on a number the base branch already took is
 * deterministic, has exactly one remedy and carries no design content — so the
 * daemon states the remedy itself, as a **COMMENT**. It is never a blocker, it
 * consumes no verdict, and it does not touch the PR's lifecycle state. The
 * write is `adapter.createReview`, i.e. the ordinary MutationGate path; in
 * dry-run it lands in state/dryrun/ like every other intent.
 *
 * Every failure here is logged and swallowed: a round must never be lost to the
 * pre-check. Returns the detected collisions for the round order/event log,
 * plus whether the check DEGRADED — i.e. this PR touches migrations and the
 * daemon could not check them (no base reader, no base sha, or the base read
 * threw). A degraded check must never be quieter than no check at all
 * (acceptance: "more reliable, never quieter"): the caller renders an
 * explicit "the pre-check did not run — check collisions yourself" note into
 * the round prompt, which is what conditionally un-muzzles pass-data-safety's
 * withdrawn finding class for exactly that round (see src/include.ts,
 * MIGRATION_NUMBERING_ADDENDUM).
 */
async function migrationPreCheck(
  deps: DispatchDeps,
  args: { pr: number; files: PrFileEntry[]; head_sha: string; base_ref: string; base_sha: string },
): Promise<{ collisions: MigrationCollision[]; degraded: boolean }> {
  const log = deps.log ?? (() => {});
  const touchesMigrations = args.files.some((f) => /(^|\/)migrations\//.test(f.filename));
  if (!deps.listBaseMigrations || !args.base_sha) {
    // Not a silent pass: the check is ~15% of all blockers and nothing else in
    // the pipeline catches the class, so a round that could not run it says so.
    if (touchesMigrations)
      deps.store.logEvent("migration_precheck_skipped", args.pr, {
        head_sha: args.head_sha,
        reason: !deps.listBaseMigrations ? "no_base_reader" : "no_base_sha",
      });
    return { collisions: [], degraded: touchesMigrations };
  }
  let collisions: MigrationCollision[];
  try {
    const baseFiles = await deps.listBaseMigrations(args.base_sha);
    collisions = detectMigrationCollisions({ files: args.files, baseFiles });
  } catch (err) {
    log(`dispatch: migration pre-check failed on #${args.pr}`, err);
    deps.store.logEvent("migration_precheck_failed", args.pr, { head_sha: args.head_sha, error: String(err) });
    return { collisions: [], degraded: touchesMigrations };
  }
  if (collisions.length === 0) return { collisions, degraded: false };
  deps.store.logEvent("migration_collision_detected", args.pr, {
    head_sha: args.head_sha,
    base_ref: args.base_ref,
    base_sha: args.base_sha,
    collisions: collisions.map((c) => ({ pr_path: c.pr_path, base_path: c.base_path, target_path: c.target_path })),
  });
  const fingerprint = collisionFingerprint(args.head_sha, collisions);
  // A staleness round re-runs at the same head and must not repost the same
  // comment. Detection still runs and is still logged; only the duplicate
  // COMMENT is suppressed.
  if (deps.store.migrationCollisionCommented(args.pr, fingerprint)) {
    log(`dispatch: #${args.pr} migration collision already commented at ${args.head_sha}`);
    return { collisions, degraded: false };
  }
  try {
    const body = renderMigrationCollisionComment({
      collisions,
      base_ref: args.base_ref,
      base_sha: args.base_sha,
    });
    const result = await deps.adapter.createReview(args.pr, {
      commit_id: args.head_sha,
      event: "COMMENT",
      body,
    });
    deps.store.logEvent("migration_collision_comment", args.pr, {
      head_sha: args.head_sha,
      fingerprint,
      executed: result.executed,
      dry_run_file: result.dryRunFile ?? null,
    });
  } catch (err) {
    // The COMMENT failed, but the collisions are real, already detected and
    // already logged — throwing them away here would leave the round's gate
    // note empty while the addendum still muzzles the lens, i.e. NOBODY
    // holding the class. The check RAN (not degraded); the comment retries on
    // the next round because the fingerprint is only marked on success.
    log(`dispatch: migration pre-check failed on #${args.pr}`, err);
    deps.store.logEvent("migration_precheck_failed", args.pr, {
      head_sha: args.head_sha,
      stage: "create_review",
      error: String(err),
    });
  }
  return { collisions, degraded: false };
}

/**
 * First-party directive detection + the deterministic escalation-mention pick
 *, run per round after the worktree is prepared. Pure path predicate
 * over the files API (`isFirstPartyDirectivePath`), plus one read-only git log
 * at the round's MERGE BASE — pre-PR history, so the PR's own commits never
 * elect the PR author as their own approver. The pick is logged
 * (`escalation_mention_selected`) with its source; every failure degrades to
 * the config fallback, never to a lost round.
 */
async function directiveEscalationFor(
  deps: DispatchDeps,
  args: { pr: number; files: PrFileEntry[]; merge_base: string; base_sha: string },
): Promise<{ files: string[]; mention: string } | undefined> {
  const log = deps.log ?? (() => {});
  const directiveFiles = args.files.filter((f) => isFirstPartyDirectivePath(f.filename)).map((f) => f.filename);
  if (directiveFiles.length === 0) return undefined;
  const fallback = deps.cfg.review.escalation_mention_default;
  const sha = args.merge_base || args.base_sha;
  let author: { login: string | null; name: string; email: string } | null = null;
  if (deps.directiveAuthor && sha) {
    try {
      author = await deps.directiveAuthor(sha, directiveFiles);
    } catch (err) {
      log(`dispatch: directive-author lookup failed on #${args.pr}`, err);
    }
  }
  const mention = author?.login ?? fallback;
  deps.store.logEvent("escalation_mention_selected", args.pr, {
    files: directiveFiles,
    mention,
    source: author?.login ? "git-log" : "config-default",
    author_name: author?.name ?? null,
    sha: sha || null,
  });
  return { files: directiveFiles, mention };
}

/** Consume both triggers at dispatch: the label and the team review request.
 * Both go through the adapter (and therefore the dry-run gate); failures are
 * logged, never fatal — the reconcile poll re-derives the truth. */
async function consumeTriggers(
  deps: DispatchDeps,
  pr: number,
  /** The no-new-evidence skip consumes the triggers without starting
   * a round, so it must not paint the PR "AI review in progress". */
  opts: { markInProgress?: boolean } = {},
): Promise<string[]> {
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
  if (opts.markInProgress !== false) {
    try {
      await deps.adapter.addLabel(pr, deps.cfg.github.in_progress_label);
    } catch (err) {
      log(`dispatch: in-progress label failed on #${pr}`, err);
    }
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
  "pass-intent",
  "pass-validate",
];

/** raisable_to lists the higher rungs only — a session may raise a pass, never
 * lower it. */
function raisableFrom(lens: string, tier: PassTier): string[] {
  return PASS_TIER_ORDER.slice(PASS_TIER_ORDER.indexOf(tier) + 1).map((t) => `${lens}--${t}`);
}

/**
 * The tier the round's validator runs at.
 *
 * `pass-validate` is the single adversarial gate: only its survivors post, so
 * it holds a veto over every lens finding in the round. A cheaper model must
 * never decide whether a more expensive model's finding is real — the
 * configured `validate_tier` is therefore a FLOOR, raised here to the
 * highest-tier lens actually planned for this round. With the shipped pin
 * (`sol-high`) the raise is a no-op; the computation is what keeps the
 * invariant true if the floor is ever lowered again.
 */
export function validatorTier(floor: PassTier, lensTiers: readonly PassTier[]): PassTier {
  return lensTiers.reduce<PassTier>((acc, t) => higherTier(acc, t), floor);
}

/** Deterministic per-round pass plan (agent = `${lens}--${tier}`):
 * - risk passes are always "sol-high", single variant, not raisable;
 * - pass-validate runs at validatorTier() — the configured floor raised to the
 *   round's highest lens tier — and is not raisable;
 * - every other selected lens gets the passTier() tier and may be raised to
 *   any higher tier's variant (ascending order).
 * addable_lenses = every known pass not already in the plan. */
export function buildPassPlan(
  cfg: Config,
  files: PrFileEntry[],
  intent?: { body?: string | null },
): { pass_plan: PassPlanEntry[]; addable_lenses: string[] } {
  const defaultTier = passTier(files, {
    migrationGate: migrationGate(files),
    smallDiffLines: cfg.models.small_diff_lines,
  });
  const risk = new Set(cfg.models.risk_passes);
  const lenses = [...selectLenses(files, intent), VALIDATE_PASS];
  // pass-intent starts at terra-med whatever the round's default:
  // reading comprehension over two short texts, not a judgment over production
  // risk. It is NOT pinned — the session may raise it like any other lens.
  const tierOf = (lens: string): PassTier =>
    risk.has(lens) ? "sol-high" : lens === INTENT_PASS ? "terra-med" : defaultTier;
  const validate = validatorTier(
    cfg.models.validate_tier,
    lenses.filter((l) => l !== VALIDATE_PASS).map(tierOf),
  );
  const pass_plan = lenses.map((lens): PassPlanEntry => {
    const pinned = lens === VALIDATE_PASS || risk.has(lens);
    const tier: PassTier = lens === VALIDATE_PASS ? validate : tierOf(lens);
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
  /** Prior VERDICTED rounds + 1 — the PR's review age. Drives the nit cap;
   * failed (cancelled/overdue) rounds advance round_no but not this. */
  reviewNo?: number;
  roundType: RoundType;
  worktree: string;
  settledDigest: string;
  issuedAt: string;
  /** Facts established by preparing the worktree. Absent only for callers with
   * no worktree seam (the stub-wired daemon core and unit tests), which fall
   * back to the PR row's sha and an unknown base. */
  tree?: { head_sha: string; base_ref: string; base_sha: string; merge_base: string };
  /** Collisions the pre-check already delivered as a COMMENT. */
  migrationCollisions?: MigrationCollision[];
  /** True when the PR touches migrations and the pre-check could NOT run —
   * the prompt must tell the session to check collisions itself. */
  migrationPrecheckDegraded?: boolean;
  /** First-party directive files + the picked escalation mention. */
  firstPartyDirectives?: { files: string[]; mention: string };
  /** The PR body as GitHub returned it: pass-intent's whole intent
   * artifact and the substance-bar input. Absent (stub-wired core, unit tests
   * without an adapter body) ⇒ the intent lens is never selected. */
  prBody?: string;
}): RoundOrder {
  const { pass_plan, addable_lenses } = buildPassPlan(args.cfg, args.files, { body: args.prBody });
  return {
    pr: args.row.number,
    title: args.row.title,
    round_id: args.roundId,
    round_no: args.roundNo,
    ...(args.reviewNo !== undefined ? { review_no: args.reviewNo } : {}),
    round_type: args.roundType,
    // Kept for compatibility with the rounds table / event log: always the
    // pass_plan's lens names in plan order.
    lenses: pass_plan.map((p) => p.lens),
    pass_plan,
    addable_lenses,
    migration_gate: migrationGate(args.files),
    migration_collisions: args.migrationCollisions ?? [],
    migration_precheck_degraded: args.migrationPrecheckDegraded ?? false,
    ...(args.firstPartyDirectives !== undefined ? { first_party_directives: args.firstPartyDirectives } : {}),
    head_sha: args.tree?.head_sha || args.row.head_sha,
    base_ref: args.tree?.base_ref ?? "",
    base_sha: args.tree?.base_sha ?? "",
    merge_base: args.tree?.merge_base ?? "",
    worktree: args.worktree,
    settled_digest: args.settledDigest,
    issued_at: args.issuedAt,
    ...(args.prBody !== undefined ? { pr_body: args.prBody } : {}),
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

      // guard 2, daemon half: a tick with nothing new to look at is a
      // no-op. The triggers are still consumed (leaving them would re-queue the
      // PR on the next reconcile, forever) and the PR returns to the state its
      // last verdict put it in — that verdict still stands.
      const mark = store.reviewedHead(row.number);
      const standing = normalizeVerdict(mark?.verdict);
      // a withholding standing at THIS head is new evidence of its
      // own. The last round decided "no blockers, approval withheld for CI",
      // and something re-queued the PR — CI going green (cigate.ts) or a
      // person. Skipping here would leave that PR waiting for a verdict that is
      // never re-attempted, which is the stuck-PR failure the gate must not
      // create.
      const withheld = store.approvalWithheld(row.number);
      const withheldHere = withheld?.head_sha === row.head_sha;
      if (cfg.guards.skip_unchanged_head && standing && !withheldHere && !hasNewEvidence(mark, row.head_sha)) {
        await consumeTriggers(deps, row.number, { markInProgress: false });
        log(`dispatch: #${row.number} skipped — no new evidence at ${row.head_sha.slice(0, 7)}`);
        store.logEvent("round_skipped_no_new_evidence", row.number, {
          head_sha: row.head_sha,
          last_verdict: standing,
          reviewed_at: mark!.reviewed_at,
        });
        applyEvent(store, row.number, { type: "verdict", verdict: standing }, {}, {
          botLogin: cfg.github.bot_login,
          now,
          reason: "no-new-evidence",
        });
        continue;
      }

      const consumed = await consumeTriggers(deps, row.number);

      // The round about to run re-decides the verdict from scratch, so the
      // withholding it might have inherited is spent. A new one is recorded if
      // this round's approval is withheld again (guards.ts guard 4).
      if (withheld) {
        store.clearApprovalWithheld(row.number);
        if (withheldHere) store.logEvent("approval_retry_dispatched", row.number, { head_sha: row.head_sha });
      }

      // The branch this PR targets (base freshness) and its body (:
      // pass-intent's artifact + substance bar) come off one getPr read. A
      // failed read degrades to "no base facts, no intent lens", never a
      // failed round.
      let baseRef = "";
      let prBody: string | undefined;
      try {
        const ref = await deps.adapter.getPr(row.number);
        baseRef = ref.base_ref;
        prBody = ref.body;
      } catch (err) {
        log(`dispatch: base ref lookup failed on #${row.number}`, err);
      }

      const files = await deps.adapter.listPrFiles(row.number);
      const gate = migrationGate(files);
      // The plan is pure and deterministic in `files` + the PR body, so
      // computing it here and again inside buildRoundOrder yields the same
      // tiers; taking the lens list off it keeps the round row and the order
      // from ever disagreeing.
      const plannedPasses = buildPassPlan(cfg, files, { body: prBody }).pass_plan;
      const lenses = plannedPasses.map((p) => p.lens);
      const validateTier = plannedPasses.find((p) => p.lens === VALIDATE_PASS)?.tier ?? cfg.models.validate_tier;

      // Diffstat comes free off the files list dispatch already fetched — no
      // extra GitHub call in the hot path. trigger_ts is copied off pr_state
      // here because the `dispatched` transition clears it moments later.
      // validate_tier is recorded so a later audit can tell which tier killed
      // which finding.
      const diffstat = diffstatOf(files);
      const roundId = store.startRound(row.number, roundType, lenses, cfg.daemon.round_deadline_min, {
        ...diffstat,
        trigger_ts: row.trigger_ts,
        validate_tier: validateTier,
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

      // Migration-number collision pre-check, before the session hears about
      // the round. It is delivered as its own COMMENT, so whatever
      // the review concludes, the renumber never rides on the verdict.
      const precheck = await migrationPreCheck(deps, {
        pr: row.number,
        files,
        head_sha: tree?.head_sha || row.head_sha,
        base_ref: tree?.base_ref ?? baseRef,
        base_sha: tree?.base_sha ?? "",
      });
      const migrationCollisions = precheck.collisions;
      // A degraded pre-check is an anomaly the overseer should see (same
      // channel verdicts.ts uses — an overseer inject, never a new path). The
      // round itself still runs: the prompt carries the "check collisions
      // yourself" note, so the class is covered either way.
      if (precheck.degraded) {
        // Durable anomaly record + the overseer wake (WAKE class,
        //) — one logAnomaly call, the store's sink writes the inject.
        store.logAnomaly(
          "migration_precheck_degraded",
          row.number,
          roundNo,
          "migration pre-check could not run (no base facts, or the base read failed); the round prompt un-muzzles the lens",
          [
            `ANOMALY (migration-precheck) — PR #${row.number} round ${roundNo}`,
            "The migration-number pre-check could not run this round (no base facts, or the base read failed) — " +
              "see the migration_precheck_skipped/failed event on this PR.",
            "The round prompt tells the session to check base-branch migration-number collisions itself, so nothing is lost — " +
              "but a recurring degraded pre-check means the base clone or worktree preparation is broken and needs a look.",
          ].join("\n"),
        );
      }

      // First-party directive edits: detect them and pick the ONE
      // teammate the escalation comment @-mentions, deterministically, before
      // the session hears about the round.
      const firstPartyDirectives = await directiveEscalationFor(deps, {
        pr: row.number,
        files,
        merge_base: tree?.merge_base ?? "",
        base_sha: tree?.base_sha ?? "",
      });

      const order = buildRoundOrder({
        tree,
        migrationCollisions,
        migrationPrecheckDegraded: precheck.degraded,
        ...(firstPartyDirectives !== undefined ? { firstPartyDirectives } : {}),
        cfg,
        row,
        files,
        roundId,
        roundNo,
        reviewNo: priorRounds + 1,
        roundType,
        worktree: worktreeFor(row.number),
        settledDigest: settledDigest(row.number),
        issuedAt: now().toISOString(),
        ...(prBody !== undefined ? { prBody } : {}),
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
        validate_tier: validateTier,
        migration_gate: order.migration_gate,
        migration_collisions: migrationCollisions.length,
        migration_precheck_degraded: precheck.degraded,
        first_party_directive_files: firstPartyDirectives?.files.length ?? 0,
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
