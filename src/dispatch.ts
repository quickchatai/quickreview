// Deterministic dispatch (spec §3). No LLM in this path: FIFO by trigger time,
// at most `daemon.max_concurrent_rounds` rounds in flight, triggers consumed at
// dispatch, lenses/gates derived from the files API by the ported heuristics.
//
// before paying for a re-review round, a SYSTEM-provenance trigger
// (push / CI / staleness — `pr_state.trigger_provenance`, stamped by
// statemachine.applyEvent) is run through the delta classifier;
// an empty/trivial delta since the reviewed head consumes the trigger and
// upholds the standing verdict instead of dispatching. A human ask (fresh
// label, fresh team re-review request, author reply) always gets its round.
//
// The round order (types.ts `RoundOrder`) is the daemon↔session contract; the
// prompt renderer is injected (B4 owns src/templates.ts) so this module has no
// content dependency.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { githubCloneDir, sandboxRoot } from "./config.js";
import {
  fingerprintRoundIntegrity,
  INTEGRITY_BUDGET_MS,
  type IntegrityFingerprint,
  type RoundIntegrityOpts,
} from "./execboundary.js";
import { withinBudget } from "./budget.js";
import type { GateResult } from "./gate.js";
import type { PrFileEntry } from "./github.js";
import { coverageEligible } from "./coverage.js";
import { DJANGO_ECOSYSTEM, type Ecosystem } from "./ecosystem.js";
import { promptTargetsFor } from "./escalation.js";
import {
  INTENT_PASS,
  passTier,
  selectLenses,
  selectSubLenses,
  SWEEP_PASS,
  sweepGroups,
  BEHAVIOUR_DELTA_PASS,
  behaviourDeltaGroups,
  CODE_FILE_RE,
  TESTS_PASS,
  STYLE_PASS,
  LINT_CONFORMANCE_PASS,
  selectQualityLenses,
  QUALITY_PASSES,
  qualityReason,
} from "./heuristics.js";
import type { HeuristicsExtension } from "./heuristics.js";
import { flooredTier, lensEnabled } from "./lenstuning.js";
import type { MigrationCollision } from "./migrations.js";
import { VALIDATE_PASS } from "./include.js";
import { hasNewEvidence } from "./guards.js";
import {
  assembleRoundMemory,
  describeGaps,
  pinnedHeadState,
  MEMORY_LESS,
  roundContextQuery,
  ROUND_CONTEXT_DEFAULTS,
  type RoundMemory,
  type RoundMemorySeed,
} from "./memory/context.js";
import {
  carryWithheldMark,
  reviewedOwnership,
  classifyDelta,
  ownershipSet,
  recheckFingerprint,
  type DeltaClass,
  type DeltaList,
} from "./recheck.js";
import { roundPostingKey } from "./posting-receipt.js";
import type { RoundLessonHook, RoundSelectionResult } from "./lessonselect.js";
import {
  buildRoundDelivery,
  deliversAnything,
  deliveryCounts,
  onlyWritten,
  type RoundLessonDelivery,
} from "./memory/delivery.js";
import { findStyleGuide } from "./styleguide.js";
import { findCiLinters, lintersForFiles, type CiLinter } from "./lintconfig.js";
import { LENS_PLANNING } from "./lensplanning.js";
import { writeLessonFiles, writePassTasks } from "./passtasks.js";
import { renderGateNotes } from "./templates.js";
import { directiveVocabulary, isFirstPartyDirectivePath } from "./severity.js";
import type { DispatchAnnouncer } from "./slack/announce.js";
import { applyEvent, restoreStandingLifecycle, setPrGates } from "./statemachine.js";
import type { PrStateRow, ReviewedHeadRow, StateStore } from "./state.js";
import { snapshotMark, standingReview } from "./standing-review.js";
import { PASS_TIER_ORDER, roundPromptMarker } from "./types.js";
import { ALL_PASSES } from "./passes.js";
import { detectLoosenedAssertions, loosenedReason } from "./loosenedtests.js";
import { isDefaultPosting } from "./postingpolicy.js";
import type {
  LedgerCarry,
  PassPlanEntry,
  PassTier,
  RoundDelta,
  RoundOrder,
  RoundRecoveryContext,
  RoundType,
  SessionHooks,
} from "./types.js";
import { preparePriorFindings, type PriorFindingsList } from "./priorfindings.js";
import { deltaAsPrFiles, type PrOwnedDelta, type PrOwnedDeltaFile } from "./worktrees.js";

/** The slice of GitHubAdapter dispatch needs — all mutations are gated inside
 * the adapter, so this module never touches GitHub directly. */
export interface DispatchAdapter {
  listPrFiles(n: number): Promise<PrFileEntry[] & { truncated?: boolean }>;
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
    payload: {
      commit_id: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: unknown[];
    },
    options?: { purpose?: "migration_precheck" },
  ): Promise<GateResult>;
  /** `GET /compare/<base>...<head>` — read-only, the short-circuit's
   * delta source. Optional: an adapter without it (stub-wired core, legacy
   * fakes) simply never short-circuits — every re-trigger pays a full round,
   * exactly the prior behaviour. */
  compareFiles?(base: string, head: string): Promise<DeltaList>;
}

export interface DispatchDeps {
  cfg: Config;
  store: StateStore;
  adapter: DispatchAdapter;
  hooks: SessionHooks;
  /**
   * The profile-selected ecosystem seam: the tier-forcing migration
   * gate, the round pre-check, and the prompt's gate prose all come off it.
   * Absent ⇒ Django, the shipped legacy behavior every historical call
   * site and test means; the production assembly (wire.ts) always passes the
   * profile's selection explicitly, so a `none` profile really runs none of
   * the machinery.
   */
  ecosystem?: Ecosystem;
  /** B4's template renderer, injected. Default: the order as JSON. The second
   * argument is the round's memory seed; a renderer that ignores it
   * renders exactly the legacy prompt. */
  renderPrompt?: (order: RoundOrder, memory: RoundMemory) => string;
  /**
   * Round-memory seeding: the assembler the ONE per-round context
   * call goes through, plus its budget/deadline. Absent ⇒ every round renders
   * memory-less, which is exactly the prior behaviour — memory is a seasoning
   * on the prompt, never a precondition for a round.
   */
  memory?: RoundMemorySeed;
  /**
   * The round's lesson selection (S9a, src/lessonselect.ts). Under
   * `[memory] delivery = "shadow"` it is started once per round, AFTER the
   * round was handed to its session (seed, prompt and marker done), and
   * NEVER awaited — nothing the session sees depends on it, and starting it
   * after the seed keeps its finds out of the seed's way on the server's
   * one-thread embedder. Under `on` (S9b, `delivering()`) it is AWAITED
   * beside the seed (`select`), no lesson find sent before the seed's search
   * is, and the round's task files, lessons files and prompt are rendered
   * from it; a round discarded before its handoff is `discard`ed from the
   * ledger. Absent ⇒ nothing runs. Must not throw (a throw is logged and
   * swallowed).
   */
  lessons?: RoundLessonHook;
  /** SETTLED digest carried from the session ledger (B3/B4). When absent,
   * the digest comes from `ledgerCarry`'s SETTLED items. */
  settledDigest?: (pr: number) => string;
  /**
   * The PR's mirrored ledger, re-handed in every round order (,
   * MC-18; src/ledgercarry.ts). Production reads `state/ledgers/pr-<n>.md`
   * (daemon.ts). Total: undefined carry ⇒ the order has no `ledger_carry`
   * and renders exactly as before. Absent ⇒ no carry and an empty digest.
   */
  ledgerCarry?: (pr: number) => { carry?: LedgerCarry; settled: string };
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
  directiveAuthor?: (
    sha: string,
    paths: string[],
  ) => Promise<{ login: string | null; name: string; email: string } | null>;
  /** Hand-resolved merge files between two shas (the owner, 2026-08-19 —
   * conflict resolutions are never trivial), for the short-circuit's
   * classification. Same seam RecheckDeps carries. Absent ⇒ merges classify by
   * the ownership rule alone. */
  resolvedFilesInMerges?: (
    from: string,
    to: string,
    pr?: number,
  ) => Promise<{ files: string[]; degraded: boolean }>;
  /**
   * The PR-OWNED change between the last reviewed head and this round's head
   * (`WorktreeManager.prOwnedDelta`): the reviewed head replayed
   * onto the round's merge base and diffed against the new head. Absent
   * (stub-wired core, unit tests without git) ⇒ every later round runs in
   * full, as before — `followup_full_round {reason: "no-adapter"}`.
   */
  prOwnedDelta?: (q: {
    pr: number;
    from: string;
    to: string;
    mergeBase: string;
    baseSha?: string;
    /** The merge base the reviewed round recorded, when known. */
    fromMergeBase?: string;
  }) => Promise<PrOwnedDelta>;
  /** Pin a head a round was dispatched to review against gc (,
   * `WorktreeManager.pinReviewedHead`), so the next follow-up round can
   * replay it after a force-push. Best-effort; absent ⇒ nothing pinned. */
  pinReviewedHead?: (pr: number, sha: string) => Promise<boolean>;
  /** `<root>/state/findings` — where round findings records live, read by
   * the follow-up round's prior-findings list. Default: under the
   * sandbox root's state dir. */
  findingsDir?: string;
  /** The round's integrity baseline, taken before the
   * session hears about the round. Default: `fingerprintRoundIntegrity` —
   * real, async reads of the clone, worktree, pi home and sandbox policy
   * surface (H2). Injected only by a test whose fake clock cannot wait
   * on real file reads. */
  integrityFingerprint?: (opts: RoundIntegrityOpts) => Promise<IntegrityFingerprint>;
  /** How long the baseline may take before the round goes unchecked
   * (H2). Default INTEGRITY_BUDGET_MS. */
  integrityBudgetMs?: number;
  /**
   * Unpack the third-party sources this PR touches and return the rendered
   * note for the order (src/depsources.ts; `[review] dependency_sources`).
   * Must never throw or hang past its own budget. Absent ⇒ no note.
   */
  dependencySources?: (worktreePath: string, files: PrFileEntry[]) => Promise<string>;
  /** Slack announcer (S4). Optional: absent ⇒ no Slack at all, which
   * is what the stub-wired daemon core and every non-Slack test see. */
  announce?: DispatchAnnouncer;
  /** Profile lens-heuristics extension: the selected repo profile's
   * extra per-lens path/added-line predicates, loaded ONCE at assembly
   * (wire.ts, `loadProfileHeuristics`). Absent ⇒ the compiled-in generic
   * selection core alone. */
  heuristics?: HeuristicsExtension;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export function defaultWorktree(pr: number): string {
  return `wt/pr-${pr}`;
}

/** PR size at the reviewed head, summed over the files API response. */
export function diffstatOf(files: PrFileEntry[]): {
  additions: number;
  deletions: number;
  changed_files: number;
} {
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

/** Review rounds in flight, for the case writer (H3): rounds running
 * (a provisional one included — its seed is about to read memory) and PRs
 * QUEUED that the pump would dispatch — not paused, not held FAILED_LOUD
 * (those wait for the operator or their retry time, not for a pump tick),
 * not blocked by a FAILED session command (it waits for the supervisor's
 * recovery — which puts it back to pending, counted again, or opens the
 * FAILED_LOUD hold — or for the operator's restart-session, never for a pump
 * tick), and none while a drain holds the pump. A row skipped for a PENDING
 * or RUNNING session command or for held wakes still counts: it dispatches
 * once those drain on their own. */
export interface ReviewsInFlight {
  running: number;
  queued: number;
}

export function reviewsInFlight(store: StateStore): ReviewsInFlight {
  const running = store.runningRounds().length;
  if (store.drainState().draining) return { running, queued: 0 };
  const queued = queuedInOrder(store).filter(
    (row) =>
      !store.openReviewFailure(row.number) &&
      // The pump skips a row while ANY blocking command stands (dispatchUnlocked's
      // `blockingSessionCommand`); a failed one among them does not drain itself.
      !store.blockingSessionCommandsForPr(row.number).some((c) => c.status === "failed"),
  ).length;
  return { running, queued };
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
 * The round's ecosystem pre-check (behind the seam), run once
 * per round after the worktree is prepared and BEFORE the session is handed
 * the order.
 *
 * The behavior is the ecosystem's (`src/ecosystem.ts`): Django detects
 * migration-number collisions at the pinned base sha and posts the remedy as a
 * gated **COMMENT** — never a blocker, never a verdict — while `none` is a
 * first-class configured-off (`{ status: "off" }`): nothing runs, nothing is
 * read, nothing is logged. What stays HERE is the plumbing the seam must not
 * own: the store, the gate-backed adapter, and the mapping back onto the round
 * order's `migration_collisions` / `migration_precheck_degraded` fields. The
 * seam is total — every failure resolves to an outcome — so a round is never
 * lost to the pre-check.
 *
 * A DEGRADED check (Django only: the check exists but could not run while the
 * PR touches migrations) must never be quieter than no check at all (
 * acceptance: "more reliable, never quieter"): the caller renders an explicit
 * "the pre-check did not run — check collisions yourself" note into the round
 * prompt, which is what conditionally un-muzzles pass-data-safety's withdrawn
 * finding class for exactly that round (see src/include.ts,
 * MIGRATION_NUMBERING_ADDENDUM) — and raises the overseer anomaly. "off"
 * takes none of those paths: configured-off is not degradation.
 *
 * A WITHHELD comment (the ledger holds a collision-comment row it cannot
 * read, so a duplicate cannot be ruled out) is the other way a
 * checked round gets quieter, and it gets the same operator surface: an
 * overseer anomaly, raised ONCE per PR (`StateStore.anomalyRaised`) because
 * the torn row is torn on every round until someone repairs it, and one wake
 * per round would bury the anomalies that need reading. The event itself is
 * logged on every withheld round — only the alert is deduplicated.
 */
async function ecosystemPreCheck(
  deps: DispatchDeps,
  eco: Ecosystem,
  args: {
    round_id: number;
    pr: number;
    files: PrFileEntry[];
    head_sha: string;
    base_ref: string;
    base_sha: string;
  },
): Promise<{
  collisions: MigrationCollision[];
  degraded: boolean;
  commentWithheld: boolean;
  commentUndelivered: boolean;
}> {
  const outcome = await eco.preCheck(
    {
      logEvent: (kind, pr, payload) => deps.store.logEvent(kind, pr, payload),
      migrationCollisionCommented: (pr, fingerprint) =>
        deps.store.migrationCollisionCommented(pr, fingerprint, { live: !deps.cfg.dry_run }),
      createReview: async (pr, payload, options) => {
        // A throw after transport begins is ambiguous. Persist that BEFORE the
        // gated call, then narrow it only from the gate's returned fact. The
        // pre-fanout auto-retry class excludes ambiguous/executed rounds.
        deps.store.recordRoundPreflightPosting(args.round_id, "ambiguous");
        const result = await deps.adapter.createReview(pr, payload, options);
        deps.store.recordRoundPreflightPosting(
          args.round_id,
          result.executed ? "executed" : result.dryRunFile ? "dryrun" : "refused",
        );
        return result;
      },
      ...(deps.listBaseMigrations ? { listBaseMigrations: deps.listBaseMigrations } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    args,
  );
  return {
    collisions: outcome.status === "checked" ? outcome.collisions : [],
    degraded: outcome.status === "degraded",
    commentWithheld: outcome.status === "checked" && outcome.comment_withheld === true,
    commentUndelivered: outcome.status === "checked" && outcome.comment_undelivered === true,
  };
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
  // the vocabulary is the compiled-in default EXTENDED by
  // [review.directives] — extension only, so default behaviour is unchanged.
  const vocab = directiveVocabulary(deps.cfg.review.directives);
  const directiveFiles = args.files
    .filter((f) => isFirstPartyDirectivePath(f.filename, vocab))
    .map((f) => f.filename);
  if (directiveFiles.length === 0) return undefined;
  // an unset [review] escalation_mention_default falls back to the
  // owner's GitHub login — the config default itself stays "".
  const fallback = deps.cfg.review.escalation_mention_default || deps.cfg.owner.github_login;
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

/**
 * Seed one round's prompt with memory: the guaranteed pinned head
 * plus EXACTLY ONE budgeted context block, queried from the PR's title and
 * diff shape.
 *
 * This is the single context call per round — one call site, one
 * `assembleRoundMemory`, which itself calls `contextBlock` once. It runs after
 * the worktree is prepared and the order is built, so the context is seeded
 * from the same point the passes read.
 *
 * It cannot fail a round. `assembleRoundMemory` is total (deadline + swallowed
 * throws); the extra try/catch here is belt-and-braces for a client that
 * breaks the contract, and the outcome is identical either way: log the gap,
 * tell the memory health monitor (`seed.onSeeded`), dispatch memory-less.
 *
 * There is no per-round memory anomaly any more (S1). The old
 * `round_memory_degraded` was never a WAKE kind, so its "alert" reached
 * nobody for five weeks; the monitor (src/memory/health.ts) now owns telling
 * a person, on state transitions rather than once per round. The
 * `round_memory_seeded` event stays — it is the per-round record, and it is
 * what the monitor is fed from.
 */
async function seedRoundMemory(
  deps: DispatchDeps,
  order: RoundOrder,
  files: PrFileEntry[],
  /** Told once the round's context search was issued (S9b — the
   * lesson finds under `on` wait for it). Absent ⇒ the assembler is asked
   * exactly as before. */
  onContextSent?: () => void,
): Promise<RoundMemory> {
  const seed = deps.memory;
  if (!seed) return MEMORY_LESS;
  const log = deps.log ?? (() => {});
  const query = roundContextQuery({ title: order.title, files });
  // The session's own recall searches for the same thing (S5).
  try {
    seed.publishQuery?.(order.pr, query);
  } catch (err) {
    log(`dispatch: #${order.pr} recall hint not published (ignored)`, err);
  }
  const timeoutMs = seed.timeoutMs ?? ROUND_CONTEXT_DEFAULTS.timeoutMs;
  // H3: the seed's search waits — inside its own budget, never past
  // it — until the case writer's last batch is estimated done embedding, so
  // it is not queued behind those embeddings on the one-thread embedder.
  const activity = seed.activity;
  const quiet =
    activity && typeof activity.whenEmbedderQuiet === "function"
      ? (maxWaitMs: number) => activity.whenEmbedderQuiet!(maxWaitMs)
      : undefined;
  let mem: RoundMemory;
  try {
    mem = await assembleRoundMemory(seed.assembler, query, {
      ...(seed.maxTokens !== undefined ? { maxTokens: seed.maxTokens } : {}),
      timeoutMs,
      log,
      ...(onContextSent ? { onContextSent } : {}),
      ...(quiet ? { quiet } : {}),
      ...(seed.searchReserveMs !== undefined ? { searchReserveMs: seed.searchReserveMs } : {}),
    });
  } catch (err) {
    log(`dispatch: #${order.pr} memory seeding threw — round proceeds memory-less`, err);
    mem = {
      ...MEMORY_LESS,
      asked: true,
      query,
      max_tokens: seed.maxTokens ?? ROUND_CONTEXT_DEFAULTS.maxTokens,
      degraded: true,
      gaps: [{ part: "head", reason: `error: ${String(err)}` }],
    };
  }
  const headState = pinnedHeadState(mem);
  // The baseline for the one transition that is silent by construction: a
  // readable store whose pinned area went from populated to empty. Read
  // BEFORE this round's row is written, and only when it could matter.
  const previousHead = headState === "empty" ? deps.store.lastReadPinnedHead() : null;
  deps.store.logEvent("round_memory_seeded", order.pr, {
    round_id: order.round_id,
    round_no: order.round_no,
    query: mem.query,
    max_tokens: mem.max_tokens,
    head_state: headState,
    head_chars: mem.head.length,
    block_chars: mem.block.length,
    clamped: mem.clamped,
    degraded: mem.degraded,
    gaps: mem.gaps,
    ms: mem.ms,
    // H3: how long the search waited for the case writer's
    // embedding tail, inside `ms` (absent when no tracker is wired).
    ...(mem.quiet_wait_ms !== undefined ? { quiet_wait_ms: mem.quiet_wait_ms } : {}),
  });
  if (previousHead && previousHead.head_chars > 0) {
    // EMPTY IS NOT DEGRADED made a genuinely empty pinned area a
    // healthy answer — which is right for a fresh install and wrong for a
    // container recreated without its data volume, where the same answer
    // used to be loud. One anomaly on the transition itself restores that
    // signal deliberately; the next round's baseline is this empty row, so
    // it cannot repeat. An owner who unpinned their last standing instruction
    // sees it once too, and knows why.
    deps.store.logAnomaly(
      "pinned_head_emptied",
      order.pr,
      order.round_no,
      `the pinned area read as EMPTY with the store readable; the last seeded round (#${previousHead.pr ?? "?"} at ${previousHead.ts}) carried ${previousHead.head_chars} chars of standing instructions`,
      [
        `ANOMALY (memory) — PR #${order.pr} round ${order.round_no}`,
        `The memory store answered, and the pinned area is EMPTY. At the last seeded round (#${previousHead.pr ?? "?"}, ${previousHead.ts}) it held ${previousHead.head_chars} chars of standing instructions.`,
        "If nobody unpinned them on purpose, the store lost its data — a container recreated without its state volume looks exactly like this. " +
          "Check the openviking data directory on the state volume and the TUI's memory tab. The round was dispatched normally; this fires once, on the transition.",
      ].join("\n"),
    );
  }
  try {
    seed.onSeeded?.(mem);
  } catch (err) {
    log(`dispatch: #${order.pr} memory health observer threw (ignored)`, err);
  }
  if (mem.degraded) {
    log(`dispatch: #${order.pr} round ${order.round_no} seeded memory-less (${describeGaps(mem)})`);
  }
  return mem;
}

/**
 * Open the round's MEMORY WINDOW (F2, `RoundMemorySeed.activity`):
 * from just before the seed until the round's lesson selection has taken
 * over, the case writer starts no batch, so no case embedding is queued in
 * front of the round's own reads on the server's one-thread embedder. Returns
 * its idempotent `end`; total — a broken tracker is a no-op, never a throw.
 */
function openMemoryWindow(
  deps: DispatchDeps,
  pr: number,
  log: (msg: string, extra?: unknown) => void,
): () => void {
  const activity = deps.memory?.activity;
  if (!activity) return () => {};
  try {
    const end = activity.begin(`round #${pr}`);
    return () => {
      try {
        end();
      } catch (err) {
        log(`dispatch: #${pr} memory window not closed (ignored)`, err);
      }
    };
  } catch (err) {
    log(`dispatch: #${pr} memory window not opened (ignored)`, err);
    return () => {};
  }
}

/** `[memory] delivery = "on"` with a hook that can deliver (S9b).
 * Total: a throwing hook is "not delivering" — the S9a path. */
function lessonsDelivering(
  deps: DispatchDeps,
  log: (msg: string, extra?: unknown) => void,
): boolean {
  const hook = deps.lessons;
  if (!hook || typeof hook.select !== "function" || typeof hook.delivering !== "function")
    return false;
  try {
    return hook.delivering() === true;
  } catch (err) {
    log("dispatch: lesson delivery switch unreadable — delivering nothing (ignored)", err);
    return false;
  }
}

/** The round's selection under `on`, awaited beside the seed. Total: the
 * hook bounds it by its prefetch budget; a throw or a rejection is `null`
 * and the round renders as if nothing were selected. */
async function selectRoundLessons(
  deps: DispatchDeps,
  order: RoundOrder,
  files: PrFileEntry[],
  after: Promise<void>,
): Promise<RoundSelectionResult | null> {
  try {
    return (await deps.lessons?.select?.(order, files, { after })) ?? null;
  } catch (err) {
    (deps.log ?? (() => {}))(
      `dispatch: #${order.pr} lesson selection failed — no lessons this round (ignored)`,
      err,
    );
    return null;
  }
}

/**
 * Hand the round's delivered lessons to its prompt (S9b): write the
 * lessons files (the validator's, and each lens the session may add) and
 * return the seed carrying the delivery — or the seed untouched when nothing
 * was selected, so the prompt keeps today's bleed rule verbatim. Total: a
 * lessons file that cannot be written is simply not named in the prompt.
 */
function deliverRoundLessons(
  deps: DispatchDeps,
  input: {
    seeded: RoundMemory;
    delivery: RoundLessonDelivery | null;
    dir: string;
  },
): RoundMemory {
  const log = deps.log ?? (() => {});
  let d = input.delivery;
  if (!d || !deliversAnything(d)) return input.seeded;
  try {
    d = writeLessonFiles(input.dir, d);
  } catch (err) {
    log(`dispatch: #${d.pr} lessons files unavailable — the round names none`, err);
  }
  // A lessons file that was not written delivers nothing: neither the index
  // nor the bleed rule may claim it did.
  d = onlyWritten(d);
  return deliversAnything(d) ? { ...input.seeded, lessons: d } : input.seeded;
}

/** The `lesson_delivered` record — written once the prompt carrying the
 * delivery was handed to the session. */
function logLessonDelivery(store: StateStore, roundId: number, d: RoundLessonDelivery): void {
  const counts = deliveryCounts(d);
  store.logEvent("lesson_delivered", d.pr, {
    round_id: roundId,
    round_no: d.round_no,
    lessons: counts.lessons,
    cases: counts.cases,
    rows: d.rows.filter((r) => r.lessons.length > 0).length,
    validator: d.validator?.lessons.length ?? 0,
    validator_file: d.validator?.file !== undefined,
    addable_files: d.addable.filter((a) => a.file !== undefined).map((a) => a.lens),
  });
}

/** The short-circuit's answer for one system-provenance re-trigger. */
type ShortCircuit =
  | { skip: false }
  | {
      skip: true;
      reason: "unchanged-head" | "empty-delta" | "trivial-delta";
      class: DeltaClass;
      files: string[];
    };

/**
 * classify the delta (last reviewed head → current head) for a
 * SYSTEM-provenance re-trigger, using the ONE classifier
 * (`recheck.classifyDelta`) — never a copy. Every uncertainty resolves to
 * "run the full round": an unknown head, a missing compare seam, or a failed
 * read must never quietly swallow a review.
 */
async function classifySystemRetrigger(
  deps: DispatchDeps,
  row: PrStateRow,
  mark: ReviewedHeadRow,
): Promise<ShortCircuit> {
  const log = deps.log ?? (() => {});
  // Unknown head is always "new" — the same reading guards.hasNewEvidence takes.
  if (!row.head_sha) return { skip: false };
  if (row.head_sha === mark.head_sha) {
    // Same head. An author reply pending on the mark is a person's ask (the
    // rule guard 2 reads) → full round; anything else is the #5308 r2 case — a
    // full round whose output posting-time guard 2 would throw away.
    if (hasNewEvidence(mark, row.head_sha)) return { skip: false };
    return { skip: true, reason: "unchanged-head", class: "empty", files: [] };
  }
  if (!deps.adapter.compareFiles) return { skip: false };
  try {
    const delta = await deps.adapter.compareFiles(mark.head_sha, row.head_sha);
    // The union with the reviewed head's ownership (selfscan 8dd186e2): a
    // push reverting a reviewed file is the PR's own change, not a base merge.
    // A truncated listing leaves ownership unknown (undefined).
    const prFiles = await reviewedOwnership(
      deps.adapter,
      row.number,
      mark.head_sha,
      delta,
      ownershipSet(await deps.adapter.listPrFiles(row.number)),
    );
    let resolvedFiles: Set<string> | undefined;
    if (deps.resolvedFilesInMerges) {
      const res = await deps.resolvedFilesInMerges(mark.head_sha, row.head_sha, row.number);
      resolvedFiles = new Set(res.files);
      if (res.degraded) {
        // Same bar as recheck.ts: a degraded merge-verify keeps the delta-only
        // classification but is never silently quieter (the owner, 2026-08-19).
        deps.store.logEvent("recheck_merge_verify_degraded", row.number, {
          from: mark.head_sha,
          to: row.head_sha,
          via: "dispatch",
        });
        deps.store.logAnomaly(
          "recheck_merge_verify_degraded",
          row.number,
          null,
          `merge-verify degraded ${mark.head_sha.slice(0, 7)}→${row.head_sha.slice(0, 7)} at dispatch — delta-only classification kept`,
        );
      }
    }
    const cls = classifyDelta(delta, {
      ...(prFiles ? { prFiles } : {}),
      ...(resolvedFiles ? { resolvedFiles } : {}),
    });
    if (cls.class === "significant") return { skip: false };
    return {
      skip: true,
      reason: cls.class === "empty" ? "empty-delta" : "trivial-delta",
      class: cls.class,
      files: cls.files.map((f) => `${f.filename} (${f.reason})`),
    };
  } catch (err) {
    log(`dispatch: #${row.number} delta classification failed — full round`, err);
    deps.store.logEvent("dispatch_classifier_failed", row.number, { error: String(err) });
    return { skip: false };
  }
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
      deps.store.logEvent("trigger_consume_failed", pr, {
        which: "team_request",
        error: String(err),
      });
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

/**
 * Did a webhook move this PR while dispatch awaited GitHub? The skip paths
 * decide from the row they read, then await trigger consumption (two GitHub
 * round-trips) before settling the PR back onto its standing verdict. A push
 * or a fresh review request applied in that window updates the QUEUED row —
 * nothing records a successor for a row that is not `reviewing` — and
 * settling it would erase that newer review debt: the stale standing verdict
 * replayed, the new trigger cleared. So a moved row is left queued for the
 * next pump, which decides again from what it now says. Returns the reason,
 * or null when the row still says what the decision read.
 */
function movedDuringConsume(
  store: DispatchDeps["store"],
  row: { number: number; head_sha: string; trigger_ts: string | null },
): string | null {
  const now = store.getPr(row.number);
  if (!now) return null;
  if (now.head_sha !== row.head_sha) return "head_moved";
  if (now.trigger_ts !== row.trigger_ts) return "retriggered";
  return null;
}

function logSupersededSettlement(
  deps: DispatchDeps,
  row: { number: number; head_sha: string; trigger_ts: string | null },
  path: string,
  reason: string,
): void {
  const now = deps.store.getPr(row.number);
  deps.store.logEvent("dispatch_settlement_superseded", row.number, {
    path,
    reason,
    decided_head_sha: row.head_sha,
    decided_trigger_ts: row.trigger_ts,
    head_sha: now?.head_sha ?? null,
    trigger_ts: now?.trigger_ts ?? null,
  });
  deps.log?.(
    `dispatch: #${row.number} ${path} not settled — the PR moved while its triggers were consumed (${reason}); left queued`,
  );
}

export { ALL_PASSES } from "./passes.js";

/** raisable_to lists the higher rungs only — a session may raise a pass, never
 * lower it. */
function raisableFrom(lens: string, tier: PassTier): string[] {
  return PASS_TIER_ORDER.slice(PASS_TIER_ORDER.indexOf(tier) + 1).map((t) => `${lens}--${t}`);
}

/**
 * The tier the round's validator runs at (amended).
 *
 * raised `pass-validate` to the round's highest lens tier, because its
 * veto killed a finding outright: a cheaper model must never delete what a
 * more expensive one found. changed what a veto IS — a finding the
 * validator cannot stand behind is kept as `doubted` in the findings record
 * (never posted, shown in the TUI), not discarded — so the raise no longer
 * protects anything and is gone: the validator runs at its OWN tier, the
 * configured `validate_tier` under the profile's `min_tier` for it, whatever
 * tier or effort any lens runs at. `lensTiers` is deliberately not an input.
 */
export function validatorTier(cfg: Pick<Config, "lenses" | "models">): PassTier {
  return flooredTier(cfg.lenses, VALIDATE_PASS, cfg.models.validate_tier);
}

/**
 * The tier a lens ADDED by the session runs at (the round templates' add
 * rule): a risk pass exists only as `sol-high`; every other lens at `sol-med`,
 * or at the profile's `min_tier` for it when that is higher.
 */
export function addTierOf(cfg: Config, lens: string): PassTier {
  return cfg.models.risk_passes.includes(lens)
    ? "sol-high"
    : flooredTier(cfg.lenses, lens, "sol-med");
}

/** What `buildPassPlan` returns. */
export interface PassPlan {
  pass_plan: PassPlanEntry[];
  addable_lenses: string[];
  sweep_unswept: string[];
}

/** Deterministic per-round pass plan (agent = `${lens}--${tier}`):
 * - risk passes are always "sol-high", single variant, not raisable;
 * - pass-validate runs at validatorTier() — its own configured tier, never
 *   raised to match a lens — is not raisable, and is always last;
 * - every other selected lens gets the passTier() tier and may be raised to
 *   any higher tier's variant (ascending order).
 * addable_lenses = every known pass not already in the plan.
 *
 * The profile's per-lens tuning (`cfg.lenses`) wins over all of
 * that: a `min_tier` floors the lens's row (and so its `raisable_to`) and the
 * sweep rows; `enabled = false` removes a lens from the plan AND the addable
 * list whatever selected it — the validator included, when the round
 * has no validator row at all; `enabled = true` on a lever-gated lens switches
 * it on whatever its `[review]` lever says. */
export function buildPassPlan(
  cfg: Config,
  files: PrFileEntry[],
  intent?: { title?: string | null; body?: string | null },
  /**: whose tier-forcing gate applies. Default Django — the shipped
   * pre-seam behavior; `none` never forces sol-med off a migrations path. */
  ecosystem: Ecosystem = DJANGO_ECOSYSTEM,
  /** Profile lens-heuristics extension; absent ⇒ generic core. */
  heuristics?: HeuristicsExtension,
  /** The repo's written style guide references (src/styleguide.ts); empty or
   * absent ⇒ the style lens only on the profile's guide, if any. */
  styleGuide: readonly string[] = [],
  /** The linters and formatters a CI job of the repo runs (src/lintconfig.ts);
   * empty or absent ⇒ no lint-conformance row. */
  ciLinters: readonly CiLinter[] = [],
  /**: `tierFiles` — the files the round's default TIER is chosen
   * from, when the plan is built over fewer files than the PR (a follow-up
   * round plans from the delta, but a small fix push keeps the PR's tier and
   * its migration floor). Absent ⇒ `files`, exactly as before. */
  opts: { tierFiles?: PrFileEntry[] } = {},
): PassPlan {
  const tierBasis = opts.tierFiles ?? files;
  const defaultTier = passTier(tierBasis, {
    migrationGate: ecosystem.migrationGate(tierBasis),
    smallDiffLines: cfg.models.small_diff_lines,
  });
  const risk = new Set(cfg.models.risk_passes);
  // the profile's switch for one lens — explicit `enabled` wins,
  // otherwise the `[review]` lever that gates it (true for an ungated lens).
  const on = (lens: string, lever = true): boolean => lensEnabled(cfg.lenses, lens, lever);
  // The owner's 2026-10-03 planning decision: the plan explains WHY each
  // lens was chosen — the path-shaped lenses included, not only sub-lenses.
  const reasons0 = new Map<string, string>();
  const selected0 = selectLenses(
    files,
    intent,
    heuristics,
    {
      intentMinWords: cfg.review.intent_min_words,
      placementMinCodeFiles: cfg.review.placement_min_code_files,
      placementMinNewFileLines: cfg.review.placement_min_new_file_lines,
    },
    reasons0,
  );
  // Sub-lenses ride after the path-selected lenses, each with the reason its
  // trigger fired (benchmark 2026-09-26; `[review] sublenses`).
  const sub = selectSubLenses(files, intent).filter(
    (s) => on(s.lens, cfg.review.sublenses) && !selected0.includes(s.lens),
  );
  const whyOf = new Map<string, string>([
    ...reasons0,
    ...sub.map((s) => [s.lens, s.why] as [string, string]),
  ]);
  // existing tests are consumers of every code change, and the PR's
  // own tests are claims about the code — one lens reads both.
  // The loosened-test hint (owner decision 2026-10-03): weakened assertions
  // found deterministically in the PR's test files are handed to the lens.
  const loosened = cfg.review.loosened_test_hint ? detectLoosenedAssertions(files) : [];
  const tests =
    on(TESTS_PASS, cfg.review.tests_lens) &&
    (files.some((f) => CODE_FILE_RE.test(f.filename)) || loosened.length > 0)
      ? [TESTS_PASS]
      : [];
  // The code-quality lenses: maintainability, duplication, abstraction — never
  // style, which rides only on the repo's own written guide.
  const quality = selectQualityLenses(files, cfg.review.quality_min_added_lines).filter(
    (l) => on(l, cfg.review.quality_lenses) && !selected0.includes(l),
  );
  if (tests.length)
    whyOf.set(
      TESTS_PASS,
      "the PR changes code: existing tests are its consumers, and its own tests are claims" +
        (loosened.length ? `; and ${loosenedReason(loosened)}` : ""),
    );
  for (const l of quality) whyOf.set(l, qualityReason(files, cfg.review.quality_min_added_lines));
  // a guide the repo writes wins; the profile's drafted guide is
  // the standard only when the repo writes none.
  const profileGuide = cfg.lenses?.[STYLE_PASS]?.guide;
  const style =
    on(STYLE_PASS, cfg.review.style_lens) &&
    (styleGuide.length > 0 || profileGuide !== undefined) &&
    files.some((f) => CODE_FILE_RE.test(f.filename))
      ? [STYLE_PASS]
      : [];
  if (style.length)
    whyOf.set(
      STYLE_PASS,
      styleGuide.length > 0
        ? `the repo's written style guide: ${styleGuide.join(", ")}`
        : `this repo's profile style guide (\`${profileGuide!.file}\`, in your instructions) — the repo writes none of its own`,
    );
  // Freeze fixes 2: lint conformance only where a CI job runs a linter whose
  // rules cover a changed file — the plan names the tools and their CI files.
  const coveredLinters = lintersForFiles(
    ciLinters,
    files.filter((f) => f.status !== "removed").map((f) => f.filename),
  );
  const lint =
    on(LINT_CONFORMANCE_PASS, cfg.review.lint_conformance) && coveredLinters.length > 0
      ? [LINT_CONFORMANCE_PASS]
      : [];
  if (lint.length)
    whyOf.set(
      LINT_CONFORMANCE_PASS,
      `CI runs ${coveredLinters
        .map(
          (l) =>
            `${l.tool} (${l.ci.join(", ")}${l.configs.length ? `; config ${l.configs.join(", ")}` : ""})`,
        )
        .join("; ")} on the changed files`,
    );
  // `[review] skip_lenses` (cost tuning): a listed lens is neither planned
  // nor addable. pass-validate is refused at config parse, and is re-appended
  // unconditionally here besides.
  const skip = new Set((cfg.review.skip_lenses ?? []).filter((l) => l !== VALIDATE_PASS));
  // `enabled = false` is the last word on every lens, whatever selected it —
  // a profile-level subtraction, separate from the ADD-only heuristics.
  const lenses = [
    ...[...selected0, ...sub.map((s) => s.lens), ...tests, ...quality, ...style, ...lint].filter(
      (l) => !skip.has(l),
    ),
    VALIDATE_PASS,
  ].filter((l) => on(l));
  // `[models.pass_tiers]`: a pinned lens runs at its pinned tier on every PR,
  // whatever the diff size, and is not raisable (config refuses a pin on a
  // risk pass or on pass-validate). A profile `min_tier` still floors it.
  const pins: Readonly<Record<string, PassTier>> = cfg.models.pass_tiers ?? {};
  // pass-intent starts at terra-med whatever the round's default:
  // reading comprehension over two short texts, not a judgment over production
  // risk. It is NOT pinned — the session may raise it like any other lens.
  // A profile `min_tier` floors whatever this picks (it never lowers one).
  const tierOf = (lens: string): PassTier =>
    flooredTier(
      cfg.lenses,
      lens,
      risk.has(lens)
        ? "sol-high"
        : (pins[lens] ?? (lens === INTENT_PASS ? "terra-med" : defaultTier)),
    );
  // The sweep's rows run at the cheapest tier unless pinned (`[models.pass_tiers]`)
  // or floored by the profile.
  const sweepOn = on(SWEEP_PASS, cfg.review.sweep) && !skip.has(SWEEP_PASS);
  const sweepTier = flooredTier(cfg.lenses, SWEEP_PASS, pins[SWEEP_PASS] ?? "terra-med");
  // the validator runs at its own tier — never raised to match a
  // lens, pinned or not.
  const validate = validatorTier(cfg);
  const pass_plan = lenses.map((lens): PassPlanEntry => {
    const pinned = lens === VALIDATE_PASS || risk.has(lens) || pins[lens] !== undefined;
    const tier: PassTier = lens === VALIDATE_PASS ? validate : tierOf(lens);
    // Every planned lens says why (owner decision 2026-10-03): the signal
    // that fired, else the lens's documented planning rule.
    const why = whyOf.get(lens) ?? (lens !== VALIDATE_PASS ? LENS_PLANNING[lens]?.when : undefined);
    return {
      lens,
      agent: `${lens}--${tier}`,
      tier,
      raisable_to: pinned ? [] : raisableFrom(lens, tier),
      ...(why !== undefined ? { why } : {}),
    };
  });
  // The sweep (benchmark 2026-09-26; `[review] sweep`): one row per group of
  // changed files, at the cheapest tier — its job is attention, line by line,
  // not deep reasoning — inserted before the validator (appended when a
  // profile switched the validator off: the validator is always last or
  // absent, never followed).
  let sweep_unswept: string[] = [];
  if (sweepOn) {
    const { groups, unswept } = sweepGroups(
      files,
      cfg.review.sweep_max_groups,
      cfg.review.sweep_group_files,
      cfg.review.sweep_group_lines,
      cfg.review.sweep_wide_files,
    );
    sweep_unswept = unswept;
    const rows = groups.map((focus): PassPlanEntry => ({
      lens: SWEEP_PASS,
      agent: `${SWEEP_PASS}--${sweepTier}`,
      tier: sweepTier,
      raisable_to: pins[SWEEP_PASS] !== undefined ? [] : raisableFrom(SWEEP_PASS, sweepTier),
      why: `every changed line of ${focus.length === 1 ? focus[0] : `${focus.length} changed files`}, read one by one`,
      focus,
    }));
    const at = pass_plan.at(-1)?.lens === VALIDATE_PASS ? pass_plan.length - 1 : pass_plan.length;
    pass_plan.splice(at, 0, ...rows);
  }
  // The behaviour-delta lens (freeze fixes 2): one row per group of files the
  // PR modifies or deletes code in, at the round's tier — comparing base and
  // head is reasoning, not attention — inserted before the validator.
  if (on(BEHAVIOUR_DELTA_PASS, cfg.review.behaviour_delta) && !skip.has(BEHAVIOUR_DELTA_PASS)) {
    const { groups } = behaviourDeltaGroups(
      files,
      cfg.review.behaviour_delta_max_groups,
      cfg.review.sweep_group_lines,
    );
    const tier = tierOf(BEHAVIOUR_DELTA_PASS);
    const rows = groups.map((focus): PassPlanEntry => ({
      lens: BEHAVIOUR_DELTA_PASS,
      agent: `${BEHAVIOUR_DELTA_PASS}--${tier}`,
      tier,
      raisable_to:
        pins[BEHAVIOUR_DELTA_PASS] !== undefined ? [] : raisableFrom(BEHAVIOUR_DELTA_PASS, tier),
      why: `base behaviour is at risk in ${focus.length === 1 ? focus[0] : `${focus.length} files`}: removed or replaced guards, conditions, calls, returns or values, or existing code wrapped in a new branch`,
      focus,
    }));
    const at = pass_plan.at(-1)?.lens === VALIDATE_PASS ? pass_plan.length - 1 : pass_plan.length;
    pass_plan.splice(at, 0, ...rows);
  }
  const selected = new Set(pass_plan.map((p) => p.lens));
  const addable_lenses = [...new Set([...ALL_PASSES, ...cfg.models.risk_passes])].filter(
    (l) => !selected.has(l) && on(l) && !skip.has(l),
  );
  return { pass_plan, addable_lenses, sweep_unswept };
}

/** Why a non-first round runs as today's full re-review: every
 * doubt is a full round, never a quieter one. */
export type FollowUpFullReason =
  | "follow_up_full"
  | "no-reviewed-head"
  | "no-adapter"
  | "delta-too-large"
  | "baseline-unplanned"
  | "delta-threw"
  | "patch-write-failed"
  | Exclude<PrOwnedDelta, { ok: true }>["reason"];

/** A follow-up round's plan, decided before the round row exists. */
export interface FollowUpDecision {
  delta: Extract<PrOwnedDelta, { ok: true }>;
  /** The reviewed head the delta was computed from. */
  fromSha: string;
  deltaFiles: PrFileEntry[];
  plan: PassPlan;
  /** The pre-approval sweep's plan — the whole PR's full plan — when owed. */
  sweepPlan?: PassPlanEntry[];
  /** The full plan's files left over the per-round sweep cap — carried with
   * `sweepPlan`, so the sweep is told what it does not cover, as round 1 is. */
  sweepUnswept?: string[];
}

/**
 * Decide whether a non-first round is a FOLLOW-UP round (,
 * docs/follow-up-rounds.md), and plan it. Total: any doubt — the knob, no
 * reviewed-head mark, no git seam, a delta git could not compute, a delta
 * above `follow_up_max_delta_ratio` of the PR's diff lines, a delta plan
 * without pass-baseline — answers `{full: reason}`, and the caller runs
 * today's full re-review.
 *
 * The plan is built over the DELTA's files with the intent text arms off
 * (the title and body did not change since the last review), its tier chosen
 * from the WHOLE PR. The sweep is owed while the standing verdict is not
 * APPROVE and no full look has happened since the first round; its plan is
 * the whole PR's full plan, exactly as a full round would run it.
 */
export async function decideFollowUp(
  deps: Pick<DispatchDeps, "cfg" | "store" | "prOwnedDelta" | "heuristics">,
  args: {
    pr: number;
    markHead: string | null | undefined;
    tree: { head_sha: string; base_sha: string; merge_base: string } | undefined;
    files: PrFileEntry[];
    fullPlan: PassPlan;
    standing: string | null;
    /** An approval-withheld mark stood when this round was picked up: the
     * standing APPROVE never reached GitHub, so it is not an approval the
     * sweep may rely on (withheld approval is an approval to be). */
    approvalWithheld?: boolean;
    ecosystem: Ecosystem;
    styleGuide: readonly string[];
    ciLinters: readonly CiLinter[];
  },
): Promise<
  | { kind: "delta"; decision: FollowUpDecision }
  | { kind: "full"; reason: FollowUpFullReason; detail?: Record<string, unknown> }
> {
  const { cfg, store } = deps;
  const full = (reason: FollowUpFullReason, detail?: Record<string, unknown>) =>
    ({ kind: "full", reason, ...(detail ? { detail } : {}) }) as const;
  if ((cfg.review.follow_up ?? "delta") !== "delta") return full("follow_up_full");
  if (!args.markHead) return full("no-reviewed-head");
  if (!args.tree || !args.tree.merge_base || !deps.prOwnedDelta) return full("no-adapter");
  // The merge base the reviewed head's round recorded (the latest live round
  // dispatched to that head, a verdicted one first): a base force-pushed
  // since then is caught by `prOwnedDelta` as `base-rewound`. Unknown (a
  // round before the column) ⇒ only the base-tip check runs, as before.
  const atMark = store
    .roundsFor(args.pr)
    .filter((r) => r.backfilled === 0 && r.head_sha === args.markHead && r.merge_base)
    .sort(
      (a, b) => Number(b.verdict !== null) - Number(a.verdict !== null) || b.round_no - a.round_no,
    );
  const fromMergeBase = atMark[0]?.merge_base ?? undefined;
  let delta: PrOwnedDelta;
  try {
    delta = await deps.prOwnedDelta({
      pr: args.pr,
      from: args.markHead,
      to: args.tree.head_sha,
      mergeBase: args.tree.merge_base,
      ...(args.tree.base_sha ? { baseSha: args.tree.base_sha } : {}),
      ...(fromMergeBase ? { fromMergeBase } : {}),
    });
  } catch (err) {
    return full("delta-threw", { error: err instanceof Error ? err.message : String(err) });
  }
  if (!delta.ok) return full(delta.reason, delta.detail ? { detail: delta.detail } : undefined);
  return planFollowUp(cfg, deps.heuristics, {
    delta,
    fromSha: args.markHead,
    files: args.files,
    fullPlan: args.fullPlan,
    ecosystem: args.ecosystem,
    styleGuide: args.styleGuide,
    ciLinters: args.ciLinters,
    sweepOwed: (deltaLines) =>
      followUpSweepOwed(cfg, {
        standing: args.standing,
        approvalWithheld: args.approvalWithheld === true,
        fullLookSinceFirst: () => store.fullLookSinceFirst(args.pr),
        deltaLines,
      }),
  });
}

/**
 * Whether a follow-up round owes the pre-approval sweep, the
 * `[review] follow_up_sweep` knob aside. Before a posted approval (a withheld
 * one never reached GitHub, so it counts as none): owed until a full look has
 * happened since the first round. After a posted approval: owed only when the
 * change since it reaches `follow_up_post_approval_sweep_lines` — a large push
 * onto an approved PR is where live re-reviews found blockers outside the
 * change; a small one stays delta-only.
 */
export function followUpSweepOwed(
  cfg: Config,
  args: {
    standing: string | null;
    approvalWithheld: boolean;
    fullLookSinceFirst: () => boolean;
    deltaLines: number;
  },
): boolean {
  if (args.standing === "APPROVE" && !args.approvalWithheld) {
    const floor = cfg.review.follow_up_post_approval_sweep_lines ?? 500;
    return floor > 0 && args.deltaLines >= floor;
  }
  return !args.fullLookSinceFirst();
}

/**
 * The PURE half of `decideFollowUp`: given a computed delta, plan
 * the follow-up round — or answer `{full: reason}`. The daemon reaches it
 * through `decideFollowUp`; the bench's follow-up replay (src/bench/
 * followup.ts) calls it directly with a delta computed by the same
 * `WorktreeManager.prOwnedDelta` over its replay tree, so the two never
 * disagree about what a follow-up round plans.
 *
 * `sweepOwed` is consulted only when the `[review] follow_up_sweep` knob is on
 * and the plan stands: the daemon's answer reads the standing verdict and the
 * store; the bench's is the recorded case's.
 */
export function planFollowUp(
  cfg: Config,
  heuristics: HeuristicsExtension | undefined,
  args: {
    delta: Extract<PrOwnedDelta, { ok: true }>;
    fromSha: string;
    files: PrFileEntry[];
    fullPlan: PassPlan;
    ecosystem: Ecosystem;
    styleGuide: readonly string[];
    ciLinters: readonly CiLinter[];
    /** Handed the delta's line count. */
    sweepOwed: (deltaLines: number) => boolean;
  },
):
  | { kind: "delta"; decision: FollowUpDecision }
  | { kind: "full"; reason: FollowUpFullReason; detail?: Record<string, unknown> } {
  const { delta } = args;
  const prLines = args.files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const ratio = cfg.review.follow_up_max_delta_ratio ?? 0.6;
  if (delta.lines > ratio * prLines)
    return {
      kind: "full",
      reason: "delta-too-large",
      detail: { delta_lines: delta.lines, pr_lines: prLines, ratio },
    };
  const deltaFiles = deltaAsPrFiles(delta.files) as PrFileEntry[];
  let plan = buildPassPlan(
    cfg,
    deltaFiles,
    undefined,
    args.ecosystem,
    heuristics,
    args.styleGuide,
    args.ciLinters,
    { tierFiles: args.files },
  );
  // The migration gate and the pre-check read the WHOLE PR, and their notes
  // name pass-data-safety (a degraded pre-check un-muzzles that
  // lens, never goes quiet). A PR whose migrations sit outside the delta
  // still gets the lens the gate names: the full plan's row rides the delta
  // plan, before the validator.
  if (
    args.ecosystem.migrationGate(args.files) &&
    !plan.pass_plan.some((p) => p.lens === DATA_SAFETY_PASS)
  ) {
    const carried = args.fullPlan.pass_plan.filter((p) => p.lens === DATA_SAFETY_PASS);
    if (carried.length > 0) {
      const at = plan.pass_plan.findIndex((p) => p.lens === VALIDATE_PASS);
      const rows = [...plan.pass_plan];
      rows.splice(at < 0 ? rows.length : at, 0, ...carried);
      plan = {
        ...plan,
        pass_plan: rows,
        addable_lenses: plan.addable_lenses.filter((l) => l !== DATA_SAFETY_PASS),
      };
    }
  }
  // A small delta gets the LEAN plan (`[review] follow_up_small_delta_lines`):
  // pass-baseline reads it whole, so the per-file sweep rows add agents and
  // no coverage, and the quality and style lenses — which judged the PR in
  // round 1 — move to the addable list rather than leaving the round.
  const smallDelta = cfg.review.follow_up_small_delta_lines ?? 150;
  if (smallDelta > 0 && delta.lines <= smallDelta) plan = leanFollowUpPlan(plan);
  // pass-baseline carries every prior finding no other planned lens owns: a
  // follow-up plan without it (a profile switched it off) cannot verify them.
  if (!plan.pass_plan.some((p) => p.lens === BASELINE_PASS))
    return { kind: "full", reason: "baseline-unplanned" };
  // An owed sweep needs a plan to run: an empty full plan records nothing
  // owed rather than a sweep no round could ever satisfy.
  const sweepOwed =
    (cfg.review.follow_up_sweep ?? true) &&
    args.fullPlan.pass_plan.length > 0 &&
    args.sweepOwed(delta.lines);
  return {
    kind: "delta",
    decision: {
      delta,
      fromSha: args.fromSha,
      deltaFiles,
      plan,
      ...(sweepOwed
        ? {
            sweepPlan: args.fullPlan.pass_plan,
            ...(args.fullPlan.sweep_unswept.length > 0
              ? { sweepUnswept: args.fullPlan.sweep_unswept }
              : {}),
          }
        : {}),
    },
  };
}

const BASELINE_PASS = "pass-baseline";
const DATA_SAFETY_PASS = "pass-data-safety";

/**
 * When an owed pre-approval sweep starts. `"early"` — beside the
 * delta's discovery rows — when the prior-findings list is complete and every
 * open prior BLOCKER sits in a file the change touched: the author plausibly
 * addressed each one, so the round will likely approve, and running the sweep
 * in parallel saves the serial delta → validate → sweep → validate chain.
 * `"late"` otherwise (a blocker the change never touched still holds, so the
 * round will not approve and the sweep is not reached). Unknown — no list,
 * an incomplete one — is late, never early.
 */
export function sweepStartOf(
  list: Pick<PriorFindingsList, "findings" | "incomplete"> | null,
  deltaPaths: readonly string[],
): "early" | "late" {
  if (!list || list.incomplete.length > 0) return "late";
  const touched = new Set(deltaPaths);
  return list.findings.every((f) => !f.blocking || (f.path !== null && touched.has(f.path)))
    ? "early"
    : "late";
}

/** The lenses a lean follow-up plan offers as addable instead of planning. */
export const LEAN_ADDABLE_PASSES: readonly string[] = [...QUALITY_PASSES, STYLE_PASS];

/**
 * The LEAN follow-up plan: the plan without its per-file
 * pass-sweep rows, and with the quality and style lenses moved to
 * `addable_lenses`. Every other row — baseline, the triggered risk lenses,
 * the validator — is kept as planned. No lens leaves the round: a session
 * that sees a quality or style question in the change adds the lens.
 */
export function leanFollowUpPlan(plan: PassPlan): PassPlan {
  const moved = plan.pass_plan
    .map((p) => p.lens)
    .filter((l, i, all) => LEAN_ADDABLE_PASSES.includes(l) && all.indexOf(l) === i);
  return {
    ...plan,
    pass_plan: plan.pass_plan.filter(
      (p) => p.lens !== SWEEP_PASS && !LEAN_ADDABLE_PASSES.includes(p.lens),
    ),
    addable_lenses: [
      ...plan.addable_lenses,
      ...moved.filter((l) => !plan.addable_lenses.includes(l)),
    ],
    sweep_unswept: [],
  };
}

/** A delta's files as one git-style patch (the hunks `prOwnedDelta` read,
 * each under its file header). */
export function renderDeltaPatch(files: readonly PrOwnedDeltaFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    const oldPath = f.old_path ?? f.path;
    out.push(`diff --git a/${oldPath} b/${f.path}`);
    if (f.conflict)
      out.push(
        "# CONFLICT: the replay of the reviewed head conflicted here; the PR's own hunks follow",
      );
    if (f.binary) {
      out.push(`Binary files a/${oldPath} and b/${f.path} differ`);
      continue;
    }
    out.push(f.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`);
    out.push(f.status === "removed" ? "+++ /dev/null" : `+++ b/${f.path}`);
    if (f.patch) out.push(f.patch.endsWith("\n") ? f.patch.slice(0, -1) : f.patch);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** The order's view of a delta (types.ts `RoundDelta`). */
export function roundDeltaOf(d: FollowUpDecision, patchFile: string): RoundDelta {
  return {
    from_sha: d.fromSha,
    tree: d.delta.tree,
    lines: d.delta.lines,
    files: d.delta.files.map((f) => ({
      path: f.path,
      ...(f.old_path !== undefined ? { old_path: f.old_path } : {}),
      status: f.status,
      ranges: f.ranges.map(([a, b]) => [a, b] as [number, number]),
      ...(f.whole_file ? { whole_file: true } : {}),
      ...(f.conflict ? { conflict: true } : {}),
    })),
    patch_file: patchFile,
  };
}

/** The order the pre-approval sweep's task files render from: the
 * follow-up order minus its follow-up fields, planned with the whole PR's
 * full plan — exactly the order a full round would hand its lenses. Pure;
 * the daemon and the bench's follow-up replay render the sweep's tasks from
 * it alike. */
export function sweepOrderOf(order: RoundOrder, sweepPlan: PassPlanEntry[]): RoundOrder {
  const {
    scope: _s,
    delta: _d,
    prior_findings_note: _p,
    sweep_plan: _sp,
    sweep_plan_unswept: _su,
    sweep_task_files: _st,
    sweep_start: _ss,
    // The delta plan's facts, not the whole PR's: the sweep carries its own.
    sweep_unswept: _du,
    coverage_files: _cf,
    ...whole
  } = order;
  return {
    ...whole,
    pass_plan: sweepPlan,
    lenses: [...new Set(sweepPlan.map((p) => p.lens))],
    ...(order.sweep_plan_unswept && order.sweep_plan_unswept.length > 0
      ? { sweep_unswept: order.sweep_plan_unswept }
      : {}),
  };
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
  /** The PR's mirrored ledger; absent ⇒ no `ledger_carry`. */
  ledgerCarry?: LedgerCarry;
  issuedAt: string;
  /** Facts established by preparing the worktree. Absent only for callers with
   * no worktree seam (the stub-wired daemon core and unit tests), which fall
   * back to the PR row's sha and an unknown base. */
  tree?: { head_sha: string; base_ref: string; base_sha: string; merge_base: string };
  /** Collisions the pre-check found — delivered as a COMMENT unless
   * `migrationCollisionsUndelivered` says the COMMENT did not reach the PR. */
  migrationCollisions?: MigrationCollision[];
  /** True when the collisions' COMMENT was withheld, refused or failed: the
   * gate note then hands the remedy to the session. */
  migrationCollisionsUndelivered?: boolean;
  /** True when the PR touches migrations and the pre-check could NOT run —
   * the prompt must tell the session to check collisions itself. */
  migrationPrecheckDegraded?: boolean;
  /** First-party directive files + the picked escalation mention. */
  firstPartyDirectives?: { files: string[]; mention: string };
  /** The PR body as GitHub returned it: pass-intent's whole intent
   * artifact and the substance-bar input. Absent (stub-wired core, unit tests
   * without an adapter body) ⇒ the intent lens is never selected. */
  prBody?: string;
  /**: the round's ecosystem. Absent ⇒ Django (pre-seam behavior). */
  ecosystem?: Ecosystem;
  /** exact predecessor identity for a pre-fanout recovery successor. */
  recovery?: RoundRecoveryContext;
  /** Profile lens-heuristics extension; absent ⇒ generic core. */
  heuristics?: HeuristicsExtension;
  /** The rendered third-party-sources block (src/depsources.ts). */
  dependencyNote?: string;
  /** The repo's written style guide references (src/styleguide.ts). */
  styleGuide?: readonly string[];
  /** The linters a CI job of the repo runs (src/lintconfig.ts). */
  ciLinters?: readonly CiLinter[];
  /** The plan, already built by the caller (dispatch builds it ONCE
   * and records the same plan on the round row). Absent ⇒ built here from
   * `files`, the PR body, the style guide and the linters, as before. */
  plan?: PassPlan;
  /** A FOLLOW-UP round's facts: the delta, the prior findings note,
   * the owed sweep's plan. The coverage check then holds the round to the
   * delta's files. Absent ⇒ the order is exactly as before. */
  followUp?: {
    delta: RoundDelta;
    deltaFiles: PrFileEntry[];
    priorFindingsNote: string;
    sweepPlan?: PassPlanEntry[];
    sweepUnswept?: string[];
    sweepStart?: "early" | "late";
  };
}): RoundOrder {
  const eco = args.ecosystem ?? DJANGO_ECOSYSTEM;
  const { pass_plan, addable_lenses, sweep_unswept } =
    args.plan ??
    buildPassPlan(
      args.cfg,
      args.files,
      { title: args.row.title, body: args.prBody },
      eco,
      args.heuristics,
      args.styleGuide ?? [],
      args.ciLinters ?? [],
    );
  const headSha = args.tree?.head_sha || args.row.head_sha;
  // an addable lens the profile floors above the add rule's own
  // variant is named with its variant in the prompt.
  const addable_tiers = Object.fromEntries(
    addable_lenses
      .filter((l) => !args.cfg.models.risk_passes.includes(l))
      .map((l) => [l, addTierOf(args.cfg, l)] as const)
      .filter(([, t]) => t !== "sol-med"),
  );
  return {
    pr: args.row.number,
    title: args.row.title,
    round_id: args.roundId,
    round_no: args.roundNo,
    posting_key: roundPostingKey(args.row.number, args.roundNo, headSha),
    ...(args.reviewNo !== undefined ? { review_no: args.reviewNo } : {}),
    round_type: args.roundType,
    // Kept for compatibility with the rounds table / event log: always the
    // pass_plan's lens names in plan order (a lens with several rows — the
    // sweep — once).
    lenses: [...new Set(pass_plan.map((p) => p.lens))],
    pass_plan,
    addable_lenses,
    ...(Object.keys(addable_tiers).length > 0 ? { addable_tiers } : {}),
    ...(sweep_unswept.length > 0 ? { sweep_unswept } : {}),
    ...(args.dependencyNote ? { dependency_note: args.dependencyNote } : {}),
    ...(args.cfg.review.nits === "open" ? { nit_policy: "open" as const } : {}),
    ...(isDefaultPosting(args.cfg.posting) ? {} : { posting_policy: args.cfg.posting }),
    // `[review] render_outputs` (src/reviewrender.ts): the round renders its
    // posted review from the findings record. Absent ⇒ the session writes
    // both files itself and step 6 renders as before.
    ...(args.cfg.review?.render_outputs ? { render_outputs: true } : {}),
    // `[review] dedup_merge` (src/templates.ts renderDedupNote): only when
    // the plan has a validator to hand the groups to.
    ...(args.cfg.review?.dedup_merge && pass_plan.some((p) => p.lens === "pass-validate")
      ? { dedup_merge: true }
      : {}),
    // `[review] coverage_check` (src/coverage.ts): only when the plan has a
    // sweep to launch for the uncovered files and there is a file to hold it to.
    ...(() => {
      if (!args.cfg.review?.coverage_check || !pass_plan.some((p) => p.lens === "pass-sweep"))
        return {};
      // a follow-up round's coverage is the delta's — the rest of
      // the PR was covered by the round that reviewed it.
      const coverage_files = coverageEligible(args.followUp?.deltaFiles ?? args.files);
      return coverage_files.length > 0 ? { coverage_files } : {};
    })(),
    // `[review] validator_shards` (templates.ts renderValidatorShardNote):
    // only above 1, and only when the plan has a validator to shard.
    ...((args.cfg.review?.validator_shards ?? 1) > 1
      ? { validator_shards: args.cfg.review.validator_shards }
      : {}),
    migration_gate: eco.migrationGate(args.files),
    migration_collisions: args.migrationCollisions ?? [],
    ...(args.migrationCollisionsUndelivered && (args.migrationCollisions ?? []).length > 0
      ? { migration_collisions_undelivered: true }
      : {}),
    migration_precheck_degraded: args.migrationPrecheckDegraded ?? false,
    ...(args.firstPartyDirectives !== undefined
      ? { first_party_directives: args.firstPartyDirectives }
      : {}),
    // absent unless escalation is enabled AND session judgement is
    // on, so the default install's order (and prompt) is unchanged.
    ...((): { escalation_targets?: string[] } => {
      const targets = promptTargetsFor(args.cfg.escalation);
      return targets ? { escalation_targets: targets } : {};
    })(),
    ...(args.recovery?.target_head_sha === headSha ? { recovery: args.recovery } : {}),
    head_sha: headSha,
    base_ref: args.tree?.base_ref ?? "",
    base_sha: args.tree?.base_sha ?? "",
    merge_base: args.tree?.merge_base ?? "",
    worktree: args.worktree,
    settled_digest: args.settledDigest,
    ...(args.ledgerCarry ? { ledger_carry: args.ledgerCarry } : {}),
    issued_at: args.issuedAt,
    ...(args.prBody !== undefined ? { pr_body: args.prBody } : {}),
    ...(args.followUp
      ? {
          scope: "delta" as const,
          delta: args.followUp.delta,
          prior_findings_note: args.followUp.priorFindingsNote,
          ...(args.followUp.sweepPlan && args.followUp.sweepPlan.length > 0
            ? {
                sweep_plan: args.followUp.sweepPlan,
                sweep_start: args.followUp.sweepStart ?? "late",
                ...(args.followUp.sweepUnswept && args.followUp.sweepUnswept.length > 0
                  ? { sweep_plan_unswept: args.followUp.sweepUnswept }
                  : {}),
              }
            : {}),
        }
      : {}),
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
  const eco = deps.ecosystem ?? DJANGO_ECOSYSTEM;
  const now = deps.now ?? (() => new Date());
  const render =
    deps.renderPrompt ?? ((o: RoundOrder, _m: RoundMemory) => JSON.stringify(o, null, 2));
  const worktreeFor = deps.worktreeFor ?? defaultWorktree;
  const ledgerCarry =
    deps.ledgerCarry ?? ((): { carry?: LedgerCarry; settled: string } => ({ settled: "" }));
  const log = deps.log ?? (() => {});

  // Deploy-window drain (2026-08-25): the pump starts NOTHING while draining.
  // In-flight rounds keep running to their natural end; queued rows simply
  // wait and dispatch when the drain lifts. The refusal stays quiet at the
  // 15s tick — the drain itself is loud (status.json, qcr status, the board
  // banner, the drain_on event).
  if (store.drainState().draining) return [];

  const slots = capacity(store, cfg);
  if (slots <= 0) return [];

  const dispatched: RoundOrder[] = [];
  const running = new Set(store.runningRounds().map((r) => r.pr));
  const commandEligible = queuedInOrder(store).filter((row) => {
    const failure = store.openReviewFailure(row.number);
    if (failure) {
      const action =
        failure.next_action === "retry_wait" && failure.next_retry_at
          ? `automatic retry at ${failure.next_retry_at}`
          : "operator u required";
      log(`dispatch: #${row.number} held FAILED_LOUD (${failure.incident_id}); ${action}`);
      return false;
    }
    const active = store.blockingSessionCommand(`pr-${row.number}`);
    if (active) {
      log(`dispatch: #${row.number} skipped — session command ${active.id} is ${active.status}`);
      return false;
    }
    if (store.hasHeldWakes(row.number)) {
      log(`dispatch: #${row.number} skipped — held conversational wakes must drain first`);
      return false;
    }
    return true;
  });
  for (const row of commandEligible.slice(0, slots)) {
    // One PR = one worktree = at most one round in flight. A queued row with a
    // round still running (requeue raced the verdict) waits for the next pump —
    // two rounds sharing wt/pr-<n> fight over the git index.
    if (running.has(row.number)) {
      log(`dispatch: #${row.number} skipped — a round is already running`);
      continue;
    }
    let provisionalRoundId: number | undefined;
    // F2: the round's memory window (opened before the seed, below).
    let endMemoryWindow: () => void = () => {};
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
      //
      // The mark is read through the ONE standing-review interpretation
      //. #5409 round 18: the shell had stamped `posted_event =
      // REQUEST_CHANGES` at this head but the watcher never enriched
      // `verdict`, this code read `verdict` alone, saw null, and paid for a
      // full round whose review posting guard 2 was guaranteed to refuse.
      // Guard 2 keys on head + author reply and nothing else, so THAT is the
      // test here — provenance (a label, a team re-request, a reconcile
      // re-derivation) is a scheduling signal and never widens the posting
      // boundary. If the standing verdict cannot be read off the mark
      // (a COMMENT-only row), no round runs either — guard 2 would still
      // refuse it — but nothing is guessed: the PR lands in `tracked` with a
      // precise anomaly instead of an invented verdict.
      const mark = store.reviewedHead(row.number);
      const standingInfo = standingReview(mark);
      const standing = standingInfo.kind === "decided" ? standingInfo.verdict : null;
      // a withholding standing at THIS head is new evidence of its
      // own. The last round decided "no blockers, approval withheld for CI",
      // and something re-queued the PR — CI going green (cigate.ts) or a
      // person. Skipping here would leave that PR waiting for a verdict that is
      // never re-attempted, which is the stuck-PR failure the gate must not
      // create.
      const withheld = store.approvalWithheld(row.number);
      const withheldHere = withheld?.head_sha === row.head_sha;
      if (cfg.guards.skip_unchanged_head && !withheldHere && !hasNewEvidence(mark, row.head_sha)) {
        // Captured BEFORE the transition below clears them: current PR state
        // is not historical evidence (#5409's provenance was overwritten by
        // the failure that followed).
        const decision = {
          stage: "dispatch",
          head_sha: row.head_sha,
          trigger_ts: row.trigger_ts,
          trigger_provenance: row.trigger_provenance,
          standing_verdict: standing,
          standing_source: standingInfo.kind === "decided" ? standingInfo.source : null,
          // Kept for readers of the legacy payload shape.
          last_verdict: standing,
          reviewed_at: mark!.reviewed_at,
          mark: snapshotMark(mark!),
        };
        await consumeTriggers(deps, row.number, { markInProgress: false });
        const movedSkip = movedDuringConsume(store, row);
        if (movedSkip) {
          logSupersededSettlement(deps, row, "no-new-evidence skip", movedSkip);
          continue;
        }
        store.logEvent("round_skipped_no_new_evidence", row.number, decision);
        if (standingInfo.kind === "unknown") {
          store.logAnomaly(
            "standing_review_unknown",
            row.number,
            null,
            `#${row.number} was re-triggered at ${row.head_sha.slice(0, 7)}, which is already reviewed with no author reply since, but the reviewed-head mark carries no verdict (posted_event=${standingInfo.posted_event ?? "null"}). No round was run — posting guard 2 would refuse its review — and no verdict was guessed; the PR is tracked until the author pushes or replies.`,
          );
        }
        const restored = restoreStandingLifecycle(store, row.number, standing, {
          botLogin: cfg.github.bot_login,
          now,
          reason: standing ? "no-new-evidence" : "no-new-evidence:standing-unknown",
        });
        log(
          `dispatch: #${row.number} skipped — no new evidence at ${row.head_sha.slice(0, 7)}; standing ${standing ?? "review (verdict unknown)"} stands, PR ${restored}`,
        );
        continue;
      }

      // a SYSTEM-provenance re-trigger (push / CI / staleness at an
      // existing trigger state — never a fresh human ask, which applyEvent
      // stamps "human") consults the delta classifier before paying
      // for a full round. Empty/trivial delta since the reviewed head ⇒
      // consume the trigger and leave state as an uphold would; significant ⇒
      // the full round below runs as today. First reviews never short-circuit,
      // and a withheld approval at this head is its own new evidence
      //: that round must run so the approval can finally post.
      if (
        roundType !== "first" &&
        (standing === "APPROVE" || standing === "REQUEST_CHANGES") &&
        mark?.head_sha &&
        !withheldHere &&
        row.trigger_provenance === "system"
      ) {
        const sc = await classifySystemRetrigger(deps, row, mark);
        if (sc.skip) {
          await consumeTriggers(deps, row.number, { markInProgress: false });
          const movedShort = movedDuringConsume(store, row);
          if (movedShort) {
            logSupersededSettlement(deps, row, "system short-circuit", movedShort);
            continue;
          }
          if (row.head_sha !== mark.head_sha) {
            // The uphold semantics of amendment ③, daemon-side: a
            // never-posted approval follows the head on a trivial/empty delta.
            carryWithheldMark(
              store,
              row.number,
              row.head_sha,
              `dispatch-short-circuit:${sc.reason}`,
              (m) => log(m),
            );
            if (standing === "APPROVE") {
              // This head's push question is answered (trivially). Claim the
              // same fingerprint the reconcile push-backstop checks so it is
              // not re-asked every sweep; INSERT OR IGNORE means a claim a
              // real recheck already holds is left untouched. No
              // wake is sent, so no receipt can exist: never the undelivered
              // sweep's to release.
              store.claimRecheck(
                row.number,
                recheckFingerprint({ trigger: "push" }, row.head_sha),
                {
                  head_sha: row.head_sha,
                  trigger: "push",
                  reason: `dispatch-short-circuit:${sc.reason}`,
                  nudge: false,
                },
              );
            }
          }
          log(
            `dispatch: #${row.number} short-circuited (${sc.reason}) — system re-trigger, standing ${standing}`,
          );
          store.logEvent("dispatch_short_circuit", row.number, {
            reason: sc.reason,
            delta_class: sc.class,
            head_sha: row.head_sha,
            last_reviewed_sha: mark.head_sha,
            standing_verdict: standing,
            files: sc.files,
          });
          applyEvent(
            store,
            row.number,
            { type: "verdict", verdict: standing },
            {},
            {
              botLogin: cfg.github.bot_login,
              now,
              reason: `dispatch-short-circuit:${sc.reason}`,
            },
          );
          continue;
        }
      }

      const consumed = await consumeTriggers(deps, row.number);

      // The round about to run re-decides the verdict from scratch, so the
      // withholding it might have inherited is spent. A new one is recorded if
      // this round's approval is withheld again (guards.ts guard 4).
      if (withheld) {
        store.clearApprovalWithheld(row.number);
        if (withheldHere)
          store.logEvent("approval_retry_dispatched", row.number, { head_sha: row.head_sha });
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

      // Prepare the tree BEFORE building the order, so the prompt cites the sha
      // the passes will actually read. The old sequence built the order from
      // `row.head_sha` (a webhook/reconcile snapshot) and only then fetched, so
      // a push landing in between made the prompt quietly wrong — passes cited
      // one sha while reading another tree, and their anchors were computed
      // against a diff the review was not about.
      //
      // And BEFORE the changed-files read: every file-derived fact of the round
      // — the migration gate, the pass plan and sweep focus, the collision
      // pre-check, the diffstat — must describe the head the tree holds. Read
      // first, a push landing before the fetch left the round reviewing the
      // new head with the old head's files (a migration the push added got no
      // gate and no collision check). The files API is by PR number, so read
      // after the fetch it lists at least the prepared head.
      const tree = deps.prepareWorktree
        ? await deps.prepareWorktree(row.number, baseRef)
        : undefined;

      const files = await deps.adapter.listPrFiles(row.number);
      const gate = eco.migrationGate(files);
      // The repo's written style guide, if any: the style lens runs only on
      // one (`[review] style_lens`). Total — an unreadable tree is no guide.
      // Read off the prepared tree BEFORE the plan, so the plan is built once
      // and the round row records exactly the order's plan.
      const styleGuide = lensEnabled(cfg.lenses, STYLE_PASS, cfg.review.style_lens)
        ? findStyleGuide(resolve(sandboxRoot(), worktreeFor(row.number)))
        : [];
      // The linters a CI job of the repo runs: lint conformance runs only on
      // them (`[review] lint_conformance`). Total — an unreadable tree is none.
      const ciLinters = lensEnabled(cfg.lenses, LINT_CONFORMANCE_PASS, cfg.review.lint_conformance)
        ? findCiLinters(resolve(sandboxRoot(), worktreeFor(row.number)))
        : [];
      // The plan is pure and deterministic in `files` + the PR body + the
      // style guide + the linters: built ONCE here and handed to
      // buildRoundOrder, so the round row and the order never disagree.
      const fullPlan = buildPassPlan(
        cfg,
        files,
        { title: row.title, body: prBody },
        eco,
        deps.heuristics,
        styleGuide,
        ciLinters,
      );
      // follow-up rounds (docs/follow-up-rounds.md): every round after
      // the first reviews the PR-owned change since the last reviewed head —
      // or, on any doubt, runs today's full re-review. `files` stays the WHOLE
      // PR for every per-PR fact (the migration gate, the pre-check, the
      // directive escalation, the diffstat, dependency sources, memory and
      // lessons); only the plan and the coverage check read the delta.
      let followUp: FollowUpDecision | null = null;
      let fullRound: { reason: FollowUpFullReason; detail?: Record<string, unknown> } | null = null;
      if (roundType === "re-review") {
        const decided = await decideFollowUp(deps, {
          pr: row.number,
          markHead: mark?.head_sha,
          tree,
          files,
          fullPlan,
          standing,
          // Captured before this dispatch cleared it: a withheld approval is
          // one GitHub never saw, so the sweep stays owed behind it.
          approvalWithheld: withheld !== undefined,
          ecosystem: eco,
          styleGuide,
          ciLinters,
        });
        if (decided.kind === "delta") followUp = decided.decision;
        else
          fullRound = {
            reason: decided.reason,
            ...(decided.detail ? { detail: decided.detail } : {}),
          };
      }
      let passPolicy = followUp ? followUp.plan : fullPlan;
      let plannedPasses = passPolicy.pass_plan;
      let lenses = [...new Set(plannedPasses.map((p) => p.lens))];
      let addablePasses = passPolicy.addable_lenses.map((lens) => ({
        lens,
        tier: addTierOf(cfg, lens),
      }));
      // Null when the profile switched the validator off: the round
      // had no validator, and recording the configured tier would say it did.
      let validateTier = plannedPasses.find((p) => p.lens === VALIDATE_PASS)?.tier ?? null;

      // Diffstat comes free off the files list dispatch already fetched — no
      // extra GitHub call in the hot path. trigger_ts is copied off pr_state
      // here because the `dispatched` transition clears it moments later.
      // validate_tier is recorded so a later audit can tell which tier killed
      // which finding.
      const diffstat = diffstatOf(files);
      const roundId = store.startRound(
        row.number,
        roundType,
        lenses,
        cfg.daemon.round_deadline_min,
        {
          ...diffstat,
          trigger_ts: row.trigger_ts,
          validate_tier: validateTier,
          pass_plan: plannedPasses,
          addable_passes: addablePasses,
          head_sha: tree?.head_sha || row.head_sha,
          ...(tree?.merge_base ? { merge_base: tree.merge_base } : {}),
          ...(roundType === "re-review"
            ? followUp
              ? {
                  scope: "delta" as const,
                  delta_base_sha: followUp.fromSha,
                  delta_lines: followUp.delta.lines,
                  delta_files: followUp.delta.files.length,
                  sweep_owed: followUp.sweepPlan !== undefined,
                  ...(followUp.sweepPlan
                    ? { sweep_plan: followUp.sweepPlan }
                    : { sweep_status: "not_owed" as const }),
                }
              : { scope: "full" as const }
            : {}),
        },
      );
      provisionalRoundId = roundId;
      const roundNo = (
        store.db.prepare("SELECT round_no FROM rounds WHERE id = ?").get(roundId) as {
          round_no: number;
        }
      ).round_no;

      // the delta as one patch file, beside the round's other state
      // files. A write that fails falls the round back to a full re-review —
      // the follow-up prompt names the file, and a missing one is never a
      // quieter round.
      let roundDelta: RoundDelta | undefined;
      if (followUp) {
        const patchFile = resolve(
          sandboxRoot(),
          "state",
          `pr-${row.number}-round-${roundNo}-delta.patch`,
        );
        try {
          mkdirSync(resolve(sandboxRoot(), "state"), { recursive: true });
          writeFileSync(`${patchFile}.tmp`, renderDeltaPatch(followUp.delta.files));
          renameSync(`${patchFile}.tmp`, patchFile);
          roundDelta = roundDeltaOf(followUp, patchFile);
        } catch (err) {
          log(`dispatch: #${row.number} delta patch not written — full round`, err);
          fullRound = {
            reason: "patch-write-failed",
            detail: { error: err instanceof Error ? err.message : String(err) },
          };
          followUp = null;
          passPolicy = fullPlan;
          plannedPasses = passPolicy.pass_plan;
          lenses = [...new Set(plannedPasses.map((p) => p.lens))];
          addablePasses = passPolicy.addable_lenses.map((lens) => ({
            lens,
            tier: addTierOf(cfg, lens),
          }));
          validateTier = plannedPasses.find((p) => p.lens === VALIDATE_PASS)?.tier ?? null;
          store.setRoundPlan(roundId, lenses, {
            validate_tier: validateTier,
            pass_plan: plannedPasses,
            addable_passes: addablePasses,
          });
          store.setRoundMeta(roundId, {
            scope: "full",
            delta_base_sha: null,
            delta_lines: null,
            delta_files: null,
            sweep_owed: null,
            sweep_plan: null,
            sweep_status: null,
          });
        }
      }
      if (fullRound) {
        store.logEvent("followup_full_round", row.number, {
          round_id: roundId,
          round_no: roundNo,
          reason: fullRound.reason,
          head_sha: tree?.head_sha || row.head_sha,
          last_reviewed_sha: mark?.head_sha ?? null,
          ...(fullRound.detail ?? {}),
        });
        log(`dispatch: #${row.number} round ${roundNo} runs in full (${fullRound.reason})`);
      }
      // the prior findings this follow-up round verifies — listed in
      // prior_finding_checks and written to the round's sidecar. Total: a list
      // that cannot be assembled renders an explicit "verify from your ledger"
      // note, never an empty one.
      const priorFindings = followUp
        ? preparePriorFindings(
            {
              store,
              findingsDir: deps.findingsDir ?? resolve(sandboxRoot(), "state", "findings"),
              stateDir: resolve(sandboxRoot(), "state"),
              log,
            },
            row.number,
            roundNo,
            tree?.head_sha || row.head_sha,
          )
        : null;
      const priorFindingsNote = priorFindings?.note ?? "";
      const sweepStart =
        followUp?.sweepPlan !== undefined
          ? sweepStartOf(
              priorFindings?.list ?? null,
              followUp.delta.files.flatMap((f) => (f.old_path ? [f.path, f.old_path] : [f.path])),
            )
          : undefined;

      if (tree && row.head_sha && tree.head_sha !== row.head_sha) {
        log(`dispatch: #${row.number} head drift ${row.head_sha} → ${tree.head_sha}`);
        store.logEvent("head_drift", row.number, {
          round_id: roundId,
          expected: row.head_sha,
          actual: tree.head_sha,
          source: "worktree_prepare",
        });
      }

      // the integrity fingerprint — git's config/hook files and, since
      //, this system's own policy surface under the sandbox root —
      // taken HERE: after the worktree is materialised (so the tree is the one
      // the round will read) and before the session hears about the round (so
      // nothing it does is inside the baseline). `verdicts.measureUsage`
      // re-checks it when the round ends. Best-effort in both directions: a
      // fingerprint that cannot be taken leaves the round unchecked, which is
      // the legacy behaviour — it never fails a round. Async since
      // H2: it hashes the whole policy surface (dist/, scripts/, …),
      // a loop turn after every file — and BOUNDED, because this await sits
      // inside the one serialized dispatch pump: a read that never returns
      // leaves this round unchecked (no baseline), never every later PR
      // undispatched.
      try {
        const budgetMs = Math.max(0, deps.integrityBudgetMs ?? INTEGRITY_BUDGET_MS);
        const baseline = await withinBudget(
          (deps.integrityFingerprint ?? fingerprintRoundIntegrity)({
            clonePath: githubCloneDir(cfg.github),
            worktreePath: resolve(sandboxRoot(), worktreeFor(row.number)),
            piHome: join(sandboxRoot(), "pihome"),
            sandboxRoot: sandboxRoot(),
          }),
          budgetMs,
        );
        if (baseline.kind === "done") {
          store.recordRoundGitConfig(roundId, baseline.value);
        } else {
          store.logEvent("round_integrity_unchecked", row.number, {
            round_id: roundId,
            stage: "baseline",
            reason: "budget",
            budget_ms: budgetMs,
          });
          log(
            `dispatch: #${row.number} integrity baseline not taken within ${budgetMs} ms — the round goes unchecked`,
          );
        }
      } catch (err) {
        log(`dispatch: #${row.number} git-config fingerprint unavailable`, err);
      }

      // The ecosystem pre-check, before the session hears about the round
      // (behind the seam). Django delivers collisions as its
      // own COMMENT, so whatever the review concludes, the renumber never
      // rides on the verdict; a `none` ecosystem runs nothing at all.
      const precheck = await ecosystemPreCheck(deps, eco, {
        round_id: roundId,
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
      // yourself" note, so the class is covered either way. A configured-off
      // ecosystem ("none") can never reach this block — off is not degraded,
      // and the seam's outcome union keeps the two apart structurally.
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
      // A withheld collision COMMENT is an anomaly too: the round
      // still hears the collisions through the gate note, but every later
      // collision comment on this PR stays withheld until the torn ledger row
      // is repaired — a human has to know that, once.
      if (
        precheck.commentWithheld &&
        !store.anomalyRaised("migration_collision_comment_withheld", row.number)
      ) {
        store.logAnomaly(
          "migration_collision_comment_withheld",
          row.number,
          roundNo,
          "migration collision COMMENT withheld: the event log holds a migration_collision_comment row for this PR that cannot be read, " +
            "so a duplicate cannot be ruled out; the collisions still ride the round prompt",
          [
            `ANOMALY (migration-precheck) — PR #${row.number} round ${roundNo}`,
            "The migration-number pre-check found collisions but WITHHELD the GitHub comment: the event log holds a " +
              "migration_collision_comment row for this PR whose payload cannot be read, so posting could duplicate an earlier comment.",
            "The session still hears the collisions through the round prompt's gate note, so nothing is lost this round — " +
              "but EVERY collision comment on this PR stays withheld until that row is repaired or deleted " +
              `(events table, kind = 'migration_collision_comment', pr = ${row.number}; see the migration_collision_comment_withheld events).`,
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

      const preparedHead = tree?.head_sha || row.head_sha;
      const rawRecoveryInstruction = store.roundRecoveryInstruction(row.number, roundNo);
      const recoveryInstruction = store.roundRecoveryInstructionForDispatch(
        row.number,
        roundNo,
        preparedHead,
      );
      if (rawRecoveryInstruction && !recoveryInstruction) {
        store.logEvent("round_recovery_instruction_not_applied", row.number, {
          target_round_no: roundNo,
          stored_head_sha: rawRecoveryInstruction.target_head_sha,
          prepared_head_sha: preparedHead,
          source_round_no: rawRecoveryInstruction.source_round_no,
          source_command_id: rawRecoveryInstruction.source_command_id,
          reason: "exact_successor_identity_mismatch",
        });
      }
      const recovery: RoundRecoveryContext | undefined = recoveryInstruction
        ? {
            stage: recoveryInstruction.stage,
            source_round_no: recoveryInstruction.source_round_no,
            source_command_id: recoveryInstruction.source_command_id,
            target_head_sha: recoveryInstruction.target_head_sha,
            immediate_attempt: recoveryInstruction.immediate_attempt,
            retry_epoch: recoveryInstruction.retry_epoch,
            ...(recoveryInstruction.source_incident_id
              ? { source_incident_id: recoveryInstruction.source_incident_id }
              : {}),
          }
        : undefined;
      // Third-party sources for the passes (benchmark 2026-09-26; `[review]
      // dependency_sources`). Total by contract — a dead registry yields an
      // empty note, never a failed or delayed-past-budget round.
      let dependencyNote = "";
      if (cfg.review.dependency_sources && deps.dependencySources) {
        try {
          dependencyNote = await deps.dependencySources(
            resolve(sandboxRoot(), worktreeFor(row.number)),
            files,
          );
        } catch (err) {
          log(`dispatch: #${row.number} dependency sources unavailable`, err);
        }
      }
      const built = buildRoundOrder({
        tree,
        plan: passPolicy,
        ...(followUp && roundDelta
          ? {
              followUp: {
                delta: roundDelta,
                deltaFiles: followUp.deltaFiles,
                priorFindingsNote,
                ...(followUp.sweepPlan ? { sweepPlan: followUp.sweepPlan } : {}),
                ...(sweepStart ? { sweepStart } : {}),
                ...(followUp.sweepUnswept ? { sweepUnswept: followUp.sweepUnswept } : {}),
              },
            }
          : {}),
        ecosystem: eco,
        ...(styleGuide.length ? { styleGuide } : {}),
        ...(ciLinters.length ? { ciLinters } : {}),
        ...(dependencyNote ? { dependencyNote } : {}),
        ...(recovery ? { recovery } : {}),
        migrationCollisions,
        ...(precheck.commentUndelivered ? { migrationCollisionsUndelivered: true } : {}),
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
        ...((): { settledDigest: string; ledgerCarry?: LedgerCarry } => {
          // one read of the ledger mirror per order; an explicit
          // settledDigest supplier still wins for the digest.
          const fromLedger = ledgerCarry(row.number);
          return {
            settledDigest: deps.settledDigest ? deps.settledDigest(row.number) : fromLedger.settled,
            ...(fromLedger.carry ? { ledgerCarry: fromLedger.carry } : {}),
          };
        })(),
        issuedAt: now().toISOString(),
        ...(prBody !== undefined ? { prBody } : {}),
        ...(deps.heuristics !== undefined ? { heuristics: deps.heuristics } : {}),
      });
      store.stampPostingKey(roundId, built.posting_key!);
      // The round row already holds the order's plan: the style guide and the
      // linters were read before the plan was built, and the plan was built
      // once.

      // The ONE memory call this round WAITS for, placed after the
      // worktree and the order so the context is seeded from the same sha the
      // passes read. It is bounded and total: the worst case is this round's
      // prompt arriving memory-less a couple of seconds later.
      //
      // under `[memory] delivery = "on"` the round's LESSON
      // SELECTION is awaited beside it — the prompt, the task files and the
      // lessons files are rendered from it. Its budget (≤ 2 s) runs from
      // here, inside the seed's deadline, so the round waits for the slower
      // of the two, never for their sum — but no lesson find is SENT before
      // the round's own context search was: the assembler says when it
      // issued the search, and a seed that never does (no assembler, a
      // failure before the search, an assembler that does not say) opens
      // the way when it settles. So the seed's search never queues behind a
      // lesson find on the server's one-thread embedder. Under
      // `shadow`/`off` the selection starts only after the handoff,
      // unawaited (below), exactly as S9a shipped it.
      const delivering = lessonsDelivering(deps, log);
      // F2: no case batch starts while this round reads memory — the
      // window opens here, before the seed, and closes once the selection
      // has taken over: under `on` when the awaited selection is in; under
      // `shadow` once `start` has opened the selector's own window, after the
      // handoff (a batch started during the handoff would sit in front of the
      // selection's finds). The `finally` below is the belt.
      endMemoryWindow = openMemoryWindow(deps, row.number, log);
      let seeded: RoundMemory;
      let selection: RoundSelectionResult | null = null;
      if (delivering) {
        let searchSent!: () => void;
        const seedSearchSent = new Promise<void>((resolveSent) => (searchSent = resolveSent));
        const seeding = seedRoundMemory(deps, built, files, () => searchSent());
        void seeding.then(
          () => searchSent(),
          () => searchSent(),
        );
        [seeded, selection] = await Promise.all([
          seeding,
          selectRoundLessons(deps, built, files, seedSearchSent),
        ]);
        endMemoryWindow();
      } else {
        seeded = await seedRoundMemory(deps, built, files);
      }
      const delivery: RoundLessonDelivery | null = selection
        ? buildRoundDelivery({
            selections: selection.selections,
            texts: selection.texts,
            pr: row.number,
            round_no: roundNo,
            head_sha: built.head_sha,
            repo: cfg.github.repo,
            rowsInTaskFiles: cfg.review.task_files,
          })
        : null;

      // `[review] task_files` (src/passtasks.ts): each discovery row's
      // complete lens task, written beside the round's pass outputs so the
      // session launches lenses with a pointer instead of generating every
      // task string. Total: a write that fails leaves the order without task
      // files, and the session writes the strings itself, as before. Under
      // `on` each row's delivered lessons ride its task file (S9b).
      let order = built;
      let rowsDelivered = false;
      if (cfg.review.task_files) {
        try {
          const dir = resolve(
            sandboxRoot(),
            "state",
            `pr-${row.number}-round-${roundNo}-passes`,
            "tasks",
          );
          const tasks = writePassTasks(
            dir,
            built,
            renderGateNotes(built, eco),
            delivery
              ? {
                  rows: new Map(delivery.rows.map((r) => [r.row, r.lessons] as const)),
                  repo: delivery.repo,
                }
              : undefined,
          );
          order = {
            ...built,
            pass_task_files: tasks.map((t) => ({ row: t.row, agent: t.agent, path: t.path })),
          };
          rowsDelivered = true;
        } catch (err) {
          log(`dispatch: #${row.number} lens task files unavailable`, err);
        }
        // the owed pre-approval sweep's task files — its own
        // directory and row index (`row` indexes `sweep_plan`), the whole PR's
        // full plan rendered exactly as a full round's. No lesson rows ride
        // them: lesson selection covers `pass_plan` rows only. Total, as above.
        if (built.sweep_plan && built.sweep_plan.length > 0) {
          try {
            const sweepDir = resolve(
              sandboxRoot(),
              "state",
              `pr-${row.number}-round-${roundNo}-passes`,
              "tasks-sweep",
            );
            const sweepOrder = sweepOrderOf(built, built.sweep_plan);
            const sweepTasks = writePassTasks(
              sweepDir,
              sweepOrder,
              renderGateNotes(sweepOrder, eco),
            );
            order = {
              ...order,
              sweep_task_files: sweepTasks.map((t) => ({
                row: t.row,
                agent: t.agent,
                path: t.path,
              })),
            };
          } catch (err) {
            log(`dispatch: #${row.number} sweep task files unavailable`, err);
          }
        }
      }
      const memory = deliverRoundLessons(deps, {
        seeded,
        // A row's lessons travel only in its task file: none written, none
        // delivered — the index must not say otherwise.
        delivery: delivery && !rowsDelivered ? { ...delivery, rows: [] } : delivery,
        dir: resolve(sandboxRoot(), "state", `pr-${row.number}-round-${roundNo}-passes`, "lessons"),
      });

      // The round is provisional until the worktree/session/prompt handoff
      // completes. Publishing reviewing/running state earlier created orphan
      // rounds whenever worktree preparation failed.
      await deps.hooks.dispatchRound(order, render(order, memory));
      // Record the receipt token this round's prompt carries (#5362), so the
      // recovery paths can tell "delivered" from "never arrived" instead of
      // inferring it. Stamped only AFTER dispatchRound resolved: the marker
      // asserts that a prompt bearing it was written, and a dispatch that
      // threw wrote nothing.
      store.stampPromptMarker(roundId, roundPromptMarker(row.number, roundNo));
      // the head this round reviews is the next follow-up round's
      // baseline — pin it against gc so a force-push cannot take it away.
      // Best-effort: an unpinned head is re-fetched, or the round runs in full.
      if (deps.pinReviewedHead) {
        try {
          const pinned = await deps.pinReviewedHead(row.number, order.head_sha);
          if (!pinned)
            log(`dispatch: #${row.number} reviewed head ${order.head_sha.slice(0, 7)} not pinned`);
        } catch (err) {
          log(`dispatch: #${row.number} reviewed head not pinned`, err);
        }
      }
      if (memory.lessons) logLessonDelivery(store, roundId, memory.lessons);
      // the round's lesson selection — the shadow ledger's
      // input. Started only now, with the round handed off, and never
      // awaited: under `shadow` it changes nothing in this round's prompt,
      // task files or agents, so nothing is gained by starting it sooner —
      // and starting it before the seed would queue its finds ahead of the
      // round's own memory search on the server's one-thread embedder. Under
      // `on` it already ran, awaited beside the seed (S9b, above).
      if (deps.lessons && !delivering) {
        try {
          deps.lessons.start(order, files);
        } catch (err) {
          log(`dispatch: #${row.number} lesson selection not started (ignored)`, err);
        }
      }
      // F2: `start` opened the selector's own window synchronously (or there
      // is no selection) — the round's own window closes now.
      endMemoryWindow();

      setPrGates(store, row.number, gate);
      applyEvent(
        store,
        row.number,
        { type: "dispatched" },
        {},
        { botLogin: cfg.github.bot_login, now },
      );
      store.logEvent("round_dispatched", row.number, {
        round_id: roundId,
        round_no: roundNo,
        round_type: roundType,
        // what a later round reviewed (absent on a first round).
        ...(roundType === "re-review"
          ? {
              scope: order.scope === "delta" ? "delta" : "full",
              ...(order.delta
                ? {
                    delta_lines: order.delta.lines,
                    delta_files: order.delta.files.length,
                    sweep_owed: (order.sweep_plan?.length ?? 0) > 0,
                    ...(order.sweep_start ? { sweep_start: order.sweep_start } : {}),
                  }
                : {}),
            }
          : {}),
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
        // `row` is the pre-dispatch snapshot; `dispatched` has just
        // cleared these on the live row, and a late guard-2 settlement needs
        // to explain which trigger paid for the round.
        trigger_ts: row.trigger_ts,
        trigger_provenance: row.trigger_provenance,
        recovery: order.recovery ?? null,
      });
      // Slack (S4): the PR's thread root on the first round we see, a
      // 🔄 line in-thread on later ones. Fire-and-forget: a slow or
      // blackholed Slack (bounded retries, capped Retry-After, one shared
      // post queue) must never stall the pump behind it — the announcer's
      // per-PR lane is claimed synchronously on the call, so thread order
      // still holds. The announcer swallows its own failures; the catches
      // here are belt-and-braces, and the round is recorded above already.
      if (deps.announce) {
        const pr = row.number;
        try {
          void deps.announce
            .roundStarted({
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
            })
            .catch((err: unknown) => log(`dispatch: slack announcement failed on #${pr}`, err));
        } catch (err) {
          log(`dispatch: slack announcement failed on #${pr}`, err);
        }
      }
      provisionalRoundId = undefined;
      dispatched.push(order);
    } catch (err) {
      // One bad PR must never stall the pump. Before the session handoff, the
      // provisional round is disposable. AFTER dispatchRound persisted a
      // durable command, deleting only the round would orphan a live command
      // that blocks every successor and that the supervisor cannot correlate.
      // Keep that round authoritative instead; best-effort publish reviewing
      // state and let the bounded command supervisor finish/recover it.
      let retainedCommand = false;
      if (provisionalRoundId !== undefined) {
        const provisional = store.runningRounds().find((round) => round.id === provisionalRoundId);
        const command = provisional
          ? store.sessionCommandForRound(row.number, provisional.round_no)
          : undefined;
        if (command) {
          retainedCommand = true;
          try {
            applyEvent(
              store,
              row.number,
              { type: "dispatched" },
              {},
              { botLogin: cfg.github.bot_login, now },
            );
          } catch (publishError) {
            log(
              `dispatch: #${row.number} retained command but could not publish reviewing state`,
              publishError,
            );
          }
          try {
            store.logAnomaly(
              "dispatch_commit_failed",
              row.number,
              provisional!.round_no,
              `session command ${command.id} was persisted but dispatch bookkeeping failed: ${String(err)}; bounded supervision retains ownership`,
            );
          } catch (anomalyError) {
            log(`dispatch: #${row.number} retained-command anomaly write failed`, anomalyError);
          }
        } else {
          store.discardRunningRound(provisionalRoundId);
          // under `on` the round's lesson selection ran — and was
          // recorded — before the handoff; a discarded round never ran, so
          // its ledger rows go too (and a selection still in flight records
          // nothing), or the shadow report would count the attempt.
          if (deps.lessons?.discard) {
            try {
              deps.lessons.discard(provisionalRoundId);
            } catch (discardError) {
              log(
                `dispatch: #${row.number} lesson record of the discarded round not dropped (ignored)`,
                discardError,
              );
            }
          }
        }
      }
      log(
        `dispatch: #${row.number} failed${retainedCommand ? " after durable handoff — round retained" : ""}`,
        err,
      );
      try {
        store.logEvent("dispatch_failed", row.number, {
          round_id: provisionalRoundId ?? null,
          retained_command: retainedCommand,
          error: String(err),
        });
      } catch (eventError) {
        log(`dispatch: #${row.number} failure event write failed`, eventError);
      }
    } finally {
      // F2: a round that failed after its seed never leaves the case
      // writer held (idempotent: a closed window stays closed).
      endMemoryWindow();
    }
  }
  return dispatched;
}
