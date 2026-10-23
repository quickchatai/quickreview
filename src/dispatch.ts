// Deterministic dispatch. No LLM in this path: FIFO by trigger time, at most
// `daemon.max_concurrent_rounds` rounds in flight, triggers consumed at
// dispatch, lenses/gates derived from the files API by the heuristics.
//
// Before paying for a re-review round, a SYSTEM-provenance trigger (push / CI /
// staleness — `pr_state.trigger_provenance`, stamped by
// statemachine.applyEvent) is run through the recheck delta classifier; an
// empty/trivial delta since the reviewed head consumes the trigger and upholds
// the standing verdict instead of dispatching. A human ask (fresh label, fresh
// team re-review request, author reply) is never short-circuited — but like
// every trigger it runs no round at a head already reviewed with no author
// reply since (guard 2's daemon half): it settles on the standing verdict.
//
// The round order (types.ts `RoundOrder`) is the daemon↔session contract; the
// plan and the order are built by the review planner (packages/pi-plugin/src/planner.ts), and the
// prompt renderer (packages/pi-plugin/src/templates.ts) is injected so this module has no content
// dependency.
import { botAccountLogin } from "@quickchatai/pi-quickreview/src/identity.js";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { githubCloneDir, sandboxRoot } from "./config.js";
import {
  fingerprintRoundIntegrity,
  INTEGRITY_BUDGET_MS,
  roundIntegrityOpts,
  type IntegrityFingerprint,
  type RoundIntegrityOpts,
} from "./execboundary.js";
import { withinBudget } from "@quickchatai/pi-quickreview/src/budget.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import type { PrFileEntry } from "./github.js";
import { DJANGO_ECOSYSTEM, type Ecosystem } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import { STYLE_PASS, LINT_CONFORMANCE_PASS } from "@quickchatai/pi-quickreview/src/heuristics.js";
import type { HeuristicsExtension } from "@quickchatai/pi-quickreview/src/heuristics.js";
import { lensEnabled } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import type { MigrationCollision } from "@quickchatai/pi-quickreview/src/migrations.js";
import { VALIDATE_PASS } from "@quickchatai/pi-quickreview/src/include.js";
import { hasNewEvidence } from "@quickchatai/pi-quickreview/src/guards.js";
import {
  addTierOf,
  buildPassPlan,
  buildRoundOrder,
  decideFollowUp,
  lensesOf,
  optionalOrderOf,
  renderDeltaPatch,
  reviewedHeadOf,
  roundDeltaOf,
  sweepOrderOf,
  type FollowUpDecision,
  type FollowUpFullReason,
  type PassPlan,
  type PreparedTree,
} from "@quickchatai/pi-quickreview/src/planner.js";
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
  verifyMerges,
  type DeltaClass,
  type DeltaList,
} from "./recheck.js";
import { postingReceiptPath, readPostingReceipt } from "./posting-receipt.js";
import type { RoundLessonHook, RoundSelectionResult } from "./lessonselect.js";
import {
  buildRoundDelivery,
  deliversAnything,
  deliveryCounts,
  onlyWritten,
  type RoundLessonDelivery,
} from "./memory/delivery.js";
import { findStyleGuide } from "@quickchatai/pi-quickreview/src/styleguide.js";
import { findCiLinters } from "@quickchatai/pi-quickreview/src/lintconfig.js";
import { writeLessonFiles, writePassTasks } from "@quickchatai/pi-quickreview/src/passtasks.js";
import {
  CONTEXT_PACK_FILE,
  readWorktreeFileForPack,
  renderContextPack,
} from "@quickchatai/pi-quickreview/src/contextpack.js";
import { renderGateNotes } from "@quickchatai/pi-quickreview/src/templates.js";
import { firstPartyDirectiveFiles } from "@quickchatai/pi-quickreview/src/severity.js";
import type { DispatchAnnouncer } from "./slack/announce.js";
import { applyEvent, restoreStandingLifecycle, setPrGates } from "./statemachine.js";
import type { ApprovalWithheldRow, PrStateRow, ReviewedHeadRow, StateStore } from "./state.js";
import { snapshotMark, standingReview } from "@quickchatai/pi-quickreview/src/standing-review.js";
import { roundPromptMarker } from "@quickchatai/pi-quickreview/src/types.js";
import type {
  LedgerCarry,
  PassPlanEntry,
  PassTier,
  RecordedAddablePass,
  RoundDelta,
  RoundOrder,
  RoundRecoveryContext,
  RoundType,
  SessionHooks,
} from "@quickchatai/pi-quickreview/src/types.js";
import { preparePriorFindings } from "@quickchatai/pi-quickreview/src/priorfindings.js";
import { type PrOwnedDelta, prWorktreeRel } from "./worktrees.js";

/** The slice of GitHubAdapter dispatch needs — all mutations are gated inside
 * the adapter, so this module never touches GitHub directly. */
export interface DispatchAdapter {
  listReviewsFull?(pr: number): Promise<Array<{ user: string; body: string; commit_id: string }>>;
  listPrFiles(n: number): Promise<PrFileEntry[] & { truncated?: boolean }>;
  /** Read-only; dispatch needs `base_ref` to keep the base branch fresh, and
   * `body` as pass-intent's artifact + substance-bar input. Absent body ⇒ the
   * intent lens is never selected. */
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
  /** `GET /compare/<base>...<head>` — read-only, the trivial-delta
   * short-circuit's delta source. Optional: an adapter without it (stub-wired
   * core, test fakes) never short-circuits — every re-trigger pays a full
   * round. */
  compareFiles?(base: string, head: string): Promise<DeltaList>;
}

export interface DispatchDeps {
  cfg: Config;
  store: StateStore;
  adapter: DispatchAdapter;
  hooks: SessionHooks;
  /**
   * The profile-selected ecosystem seam: the tier-forcing migration gate, the
   * round pre-check, and the prompt's gate prose all come off it. Absent ⇒
   * Django; the production assembly (wire.ts) always passes the profile's
   * selection explicitly, so a `none` profile really runs none of the
   * machinery.
   */
  ecosystem?: Ecosystem;
  /** The template renderer, injected. Default: the order as JSON. The second
   * argument is the round's memory seed; a renderer may ignore it. */
  renderPrompt?: (order: RoundOrder, memory: RoundMemory) => string;
  /**
   * Round-memory seeding: the assembler the one per-round context call goes
   * through, plus its budget/deadline. Absent ⇒ every round renders
   * memory-less — memory is a seasoning on the prompt, never a precondition
   * for a round.
   */
  memory?: RoundMemorySeed;
  /**
   * The round's lesson selection (src/lessonselect.ts). Under
   * `[memory] delivery = "shadow"` it is started once per round, after the
   * round was handed to its session (seed, prompt and marker done), and
   * never awaited — nothing the session sees depends on it, and starting it
   * after the seed keeps its finds out of the seed's way on the server's
   * one-thread embedder. Under `on` (`delivering()`) it is awaited
   * beside the seed (`select`), no lesson find sent before the seed's search
   * is, and the round's task files, lessons files and prompt are rendered
   * from it; a round discarded before its handoff is `discard`ed from the
   * ledger. Absent ⇒ nothing runs. Must not throw (a throw is logged and
   * swallowed).
   */
  lessons?: RoundLessonHook;
  /** SETTLED digest carried from the session ledger. When absent, the digest
   * comes from `ledgerCarry`'s SETTLED items. */
  settledDigest?: (pr: number) => string;
  /**
   * The PR's mirrored ledger, re-handed in every round order
   * (packages/pi-plugin/src/ledgercarry.ts). Production reads `state/ledgers/pr-<n>.md`
   * (daemon.ts). Total: undefined carry ⇒ the order has no `ledger_carry`.
   * Absent ⇒ no carry and an empty digest.
   */
  ledgerCarry?: (pr: number) => { carry?: LedgerCarry; settled: string };
  worktreeFor?: (pr: number) => string;
  /**
   * Fetch the PR head + its base branch and materialise the worktree, before
   * the round order is built. Returns what is actually on disk. Optional: the
   * stub-wired daemon core and unit tests have no git, and fall back to the PR
   * row's sha with no base facts.
   */
  prepareWorktree?: (pr: number, baseRef: string, expectedHead: string) => Promise<PreparedTree>;
  /**
   * Every migration file present on the base branch at a commit. Read-only
   * git in the base clone, which the worktree preparation has just
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
  /** Hand-resolved merge files between two shas (conflict resolutions are
   * never trivial), for the trivial-delta short-circuit's classification.
   * Same seam RecheckDeps carries. Absent ⇒ merges classify by the ownership
   * rule alone. */
  resolvedFilesInMerges?: (
    from: string,
    to: string,
    pr?: number,
  ) => Promise<{ files: string[]; degraded: boolean }>;
  /**
   * The PR-OWNED change between the last reviewed head and this round's head
   * (`WorktreeManager.prOwnedDelta`): the reviewed head replayed onto the
   * round's merge base and diffed against the new head. Absent (stub-wired
   * core, unit tests without git) ⇒ every later round runs in full —
   * `followup_full_round {reason: "no-adapter"}`.
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
  /** Pin a head a round was dispatched to review against gc
   * (`WorktreeManager.pinReviewedHead`), so the next follow-up round can
   * replay it after a force-push. Best-effort; absent ⇒ nothing pinned. */
  pinReviewedHead?: (pr: number, sha: string) => Promise<boolean>;
  /** `<root>/state/findings` — where round findings records live, read by
   * the follow-up round's prior-findings list. Default: under the
   * sandbox root's state dir. */
  findingsDir?: string;
  /** `<root>/state/posting-receipts` — read to prove an interrupted
   * approval retry posted nothing before its withheld mark is restored.
   * Default: under the sandbox root's state dir. */
  postingReceiptDir?: string;
  /** The round's integrity baseline, taken before the session hears about
   * the round. Default: `fingerprintRoundIntegrity` — real, async reads of the
   * clone, worktree, pi home and sandbox policy surface. Injected only by a
   * test whose fake clock cannot wait on real file reads. */
  integrityFingerprint?: (opts: RoundIntegrityOpts) => Promise<IntegrityFingerprint>;
  /** How long the baseline may take before the round goes unchecked.
   * Default INTEGRITY_BUDGET_MS. */
  integrityBudgetMs?: number;
  /**
   * Unpack the third-party sources this PR touches and return the rendered
   * note for the order (packages/pi-plugin/src/depsources.ts; `[review] dependency_sources`).
   * Must never throw or hang past its own budget. Absent ⇒ no note.
   */
  dependencySources?: (worktreePath: string, files: PrFileEntry[]) => Promise<string>;
  /** Slack announcer. Optional: absent ⇒ no Slack at all, which
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
  return prWorktreeRel(pr);
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

/** Round type: no prior round → "first"; a staleness recheck → "staleness";
 * anything else → "re-review". `priorRounds` counts live verdicted rounds
 * only: backfilled rounds and cancelled or verdict-less attempts are not
 * counted, so such an attempt leaves the next round "first". */
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

/** Review rounds in flight, for the case writer: rounds running
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
 * The round's ecosystem pre-check (behind the ecosystem seam), run once
 * per round after the worktree is prepared and BEFORE the session is handed
 * the order.
 *
 * The behavior is the ecosystem's (`packages/pi-plugin/src/ecosystem.ts`): Django detects
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
 * PR touches migrations) must never be quieter than no check at all ("more
 * reliable, never quieter"): the caller renders an explicit
 * "the pre-check did not run — check collisions yourself" note into the round
 * prompt, which is what conditionally un-muzzles pass-data-safety's withdrawn
 * finding class for exactly that round (see packages/pi-plugin/src/include.ts,
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
      isDryRun: deps.cfg.dry_run,
      ...(deps.adapter.listReviewsFull
        ? {
            findCollisionComment: async (pr: number, marker: string, head: string) =>
              (await deps.adapter.listReviewsFull!(pr)).some(
                (review) =>
                  review.user === deps.cfg.github.bot_login &&
                  review.commit_id === head &&
                  review.body.split(/\r?\n/).includes(marker),
              ),
          }
        : {}),
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
 * First-party directive detection + the deterministic escalation-mention pick,
 * run per round after the worktree is prepared. Pure path predicate
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
  // The vocabulary is the compiled-in default extended by [review.directives]
  // — extension only, never a narrowing.
  const directiveFiles = firstPartyDirectiveFiles(args.files, deps.cfg.review.directives);
  if (directiveFiles.length === 0) return undefined;
  // An unset [review] escalation_mention_default falls back to the owner's
  // GitHub login — the config default itself stays "".
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
 * There is no per-round memory anomaly: the health monitor
 * (src/memory/health.ts) owns telling a person, on state transitions rather
 * than once per round. The `round_memory_seeded` event is the per-round
 * record, and it is what the monitor is fed from.
 */
async function seedRoundMemory(
  deps: DispatchDeps,
  order: RoundOrder,
  files: PrFileEntry[],
  /** Told once the round's context search was issued (the lesson finds
   * under `delivery = "on"` wait for it). Optional. */
  onContextSent?: () => void,
): Promise<RoundMemory> {
  const seed = deps.memory;
  if (!seed) return MEMORY_LESS;
  const log = deps.log ?? (() => {});
  const query = roundContextQuery({ title: order.title, files });
  // The session's own recall searches for the same thing.
  try {
    seed.publishQuery?.(order.pr, query);
  } catch (err) {
    log(`dispatch: #${order.pr} recall hint not published (ignored)`, err);
  }
  const timeoutMs = seed.timeoutMs ?? ROUND_CONTEXT_DEFAULTS.timeoutMs;
  // The seed's search waits — inside its own budget, never past
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
    // How long the search waited for the case writer's embedding tail,
    // inside `ms` (absent when no tracker is wired).
    ...(mem.quiet_wait_ms !== undefined ? { quiet_wait_ms: mem.quiet_wait_ms } : {}),
  });
  if (previousHead && previousHead.head_chars > 0) {
    // Empty is not degraded: a genuinely empty pinned area is a healthy
    // answer — right for a fresh install, wrong for a container recreated
    // without its data volume. One anomaly on the transition itself carries
    // that signal; the next round's baseline is this empty row, so it cannot
    // repeat. An owner who unpinned their last standing instruction sees it
    // once too, and knows why.
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
 * Open the round's memory window (`RoundMemorySeed.activity`):
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

/** `[memory] delivery = "on"` with a hook that can deliver. Total: a
 * throwing hook is "not delivering" — the shadow path. */
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
 * Hand the round's delivered lessons to its prompt: write the
 * lessons files (the validator's, and each lens the session may add) and
 * return the seed carrying the delivery — or the seed untouched when nothing
 * was selected, so the prompt keeps the standard bleed rule verbatim. Total: a
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

/** The trivial-delta short-circuit's answer for one system-provenance re-trigger. */
type ShortCircuit =
  | { skip: false }
  | {
      skip: true;
      reason: "unchanged-head" | "empty-delta" | "trivial-delta";
      class: DeltaClass;
      files: string[];
    };

/**
 * Classify the delta (last reviewed head → current head) for a
 * SYSTEM-provenance re-trigger, using the one recheck classifier
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
    // rule guard 2 reads) → full round; anything else would be a full round
    // whose output posting-time guard 2 throws away.
    if (hasNewEvidence(mark, row.head_sha)) return { skip: false };
    return { skip: true, reason: "unchanged-head", class: "empty", files: [] };
  }
  if (!deps.adapter.compareFiles) return { skip: false };
  try {
    const delta = await deps.adapter.compareFiles(mark.head_sha, row.head_sha);
    // The union with the reviewed head's ownership: a push reverting a
    // reviewed file is the PR's own change, not a base merge.
    // A truncated listing leaves ownership unknown (undefined).
    const prFiles = await reviewedOwnership(
      deps.adapter,
      row.number,
      mark.head_sha,
      delta,
      ownershipSet(await deps.adapter.listPrFiles(row.number)),
    );
    // The recheck's own merge check: a degraded one keeps the delta-only
    // classification but is never silently quieter.
    const resolvedFiles = new Set(
      await verifyMerges(
        deps.store,
        deps.resolvedFilesInMerges,
        mark.head_sha,
        row.head_sha,
        row.number,
        "dispatch",
      ),
    );
    const cls = classifyDelta(delta, {
      ...(prFiles ? { prFiles } : {}),
      resolvedFiles,
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
 * logged, never fatal — the reconcile poll re-derives the truth. Returns the
 * triggers really consumed: one the gate recorded instead of executing (dry
 * run) or a guard refused is still on GitHub, and is logged as such. */
async function consumeTriggers(
  deps: DispatchDeps,
  pr: number,
  /** The no-new-evidence skip consumes the triggers without starting
   * a round, so it must not paint the PR "AI review in progress". */
  opts: { markInProgress?: boolean } = {},
): Promise<string[]> {
  const consumed: string[] = [];
  const log = deps.log ?? (() => {});
  /** One trigger: consumed, already gone (consumed too), not executed, or
   * failed — logged. */
  const consume = async (
    which: "label" | "team_request",
    what: string,
    op: () => Promise<GateResult | undefined>,
  ): Promise<void> => {
    try {
      const result = await op();
      if (result?.executed === false) {
        deps.store.logEvent("trigger_consume_not_executed", pr, {
          which,
          ...(result.dryRunFile ? { dry_run: true } : {}),
          ...(result.blocked ? { blocked: result.blocked } : {}),
        });
        return;
      }
      consumed.push(which);
    } catch (err) {
      if (alreadyConsumed(err)) {
        consumed.push(which);
        deps.store.logEvent("trigger_already_consumed", pr, { which });
      } else {
        log(`dispatch: ${what} failed on #${pr}`, err);
        deps.store.logEvent("trigger_consume_failed", pr, { which, error: String(err) });
      }
    }
  };
  await consume("label", "label removal", () =>
    deps.adapter.removeLabel(pr, deps.cfg.github.trigger_label),
  );
  await consume("team_request", "team-request DELETE", () =>
    deps.adapter.deleteTeamReviewRequest(pr),
  );
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
 * A withheld approval's retry round that ended without deciding anything —
 * cancelled by a restart's orphan sweep, a self-requeue or an operator, or
 * held FAILED_LOUD until the operator's `u` — still owes the approval:
 * dispatch spent the mark at that round's handoff, and the round that would
 * have re-decided it never did. The mark is re-recorded here from the spend's
 * own record (`approval_retry_dispatched`), so the round that replaces it
 * runs instead of being skipped as no new evidence. A round that decided (a
 * verdict, a guard-2 no-op) or is still running owes nothing; neither does a
 * spend at another head or one a later round has overtaken.
 *
 * Only a round that PROVABLY posted nothing is restored: a restored mark
 * takes the replacement round past guard 2's daemon half, and the approval
 * route has no guard 2 of its own, so a round whose APPROVE went out would
 * post a second one. So the round has no posting receipt but a guard-2
 * refusal (a `prepared` or `deferred` one is unknown, never "not posted"), its
 * row records no posting, and the reviewed-head mark has not been stamped
 * since it started.
 */
function restoreInterruptedApprovalRetry(
  store: DispatchDeps["store"],
  row: Pick<PrStateRow, "number" | "head_sha">,
  postingReceiptDir: string,
): ApprovalWithheldRow | undefined {
  const spent = store.db
    .prepare(
      "SELECT payload FROM events WHERE pr = ? AND kind = 'approval_retry_dispatched' ORDER BY id DESC LIMIT 1",
    )
    .get(row.number) as { payload: string } | undefined;
  if (!spent) return undefined;
  let record: { head_sha?: unknown; round_id?: unknown; ci_state?: unknown; reason?: unknown };
  try {
    record = JSON.parse(spent.payload) as typeof record;
  } catch {
    return undefined;
  }
  if (record.head_sha !== row.head_sha || typeof record.round_id !== "number") return undefined;
  const round = store.roundsFor(row.number).find((r) => r.id === record.round_id);
  if (!round || round.status === "running" || round.status === "done") return undefined;
  if (round.status === "cancelled" && round.cancel_cause === "no_new_evidence") return undefined;
  if (store.hasLaterRound(row.number, round.round_no)) return undefined;
  // A receipt file that cannot be read is unknown too.
  if (existsSync(postingReceiptPath(postingReceiptDir, row.number, round.round_no))) {
    const receipt = readPostingReceipt(postingReceiptDir, row.number, round.round_no);
    if (receipt?.status !== "skipped") return undefined;
  }
  if (round.posted_event || round.gh_review_id !== null) return undefined;
  const mark = store.reviewedHead(row.number);
  if (mark && mark.reviewed_at >= round.started_at) return undefined;
  store.recordApprovalWithheld(row.number, {
    head_sha: row.head_sha,
    ci_state: typeof record.ci_state === "string" ? record.ci_state : null,
    reason: typeof record.reason === "string" ? record.reason : "red-ci",
  });
  store.logEvent("approval_retry_restored", row.number, {
    head_sha: row.head_sha,
    round_id: round.id,
    round_no: round.round_no,
    round_status: round.status,
    cancel_cause: round.cancel_cause ?? null,
  });
  return store.approvalWithheld(row.number);
}

/**
 * Did a webhook move this PR while dispatch awaited GitHub? The skip paths
 * decide from the row they read, then await trigger consumption (two GitHub
 * round-trips) before settling the PR back onto its standing verdict. A push
 * or a fresh review request applied in that window updates the QUEUED row —
 * nothing records a successor for a row that is not `reviewing` — and
 * settling it would erase that newer review debt: the stale standing verdict
 * replayed, the new trigger cleared. So a moved row is left queued for the
 * next pump, which decides again from what it now says. A row that left the
 * queue (a close, the operator) is not settled either: it is no longer this
 * dispatch's to decide. Returns the reason, or null when the row still says
 * what the decision read.
 */
function movedDuringConsume(
  store: DispatchDeps["store"],
  row: Pick<PrStateRow, "number" | "head_sha" | "trigger_ts" | "trigger_provenance">,
): string | null {
  const now = store.getPr(row.number);
  if (!now) return null;
  if (now.state !== "queued") return "left_queue";
  if (now.head_sha !== row.head_sha) return "head_moved";
  // A person's ask on a queued row keeps its trigger time and upgrades only
  // the provenance — a re-request the system short-circuit must not settle.
  if (now.trigger_ts !== row.trigger_ts || now.trigger_provenance !== row.trigger_provenance)
    return "retriggered";
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

export { ALL_PASSES } from "@quickchatai/pi-quickreview/src/passes.js";

// The review planner moved to packages/pi-plugin/src/planner.ts (the review core); re-exported so
// the app's importers keep their one module.
export {
  addTierOf,
  buildPassPlan,
  buildRoundOrder,
  decideFollowUp,
  followUpSweepOwed,
  LEAN_ADDABLE_PASSES,
  leanFollowUpPlan,
  lensesOf,
  optionalOrderOf,
  planFollowUp,
  renderDeltaPatch,
  reviewedHeadOf,
  roundDeltaOf,
  slowestFirst,
  sweepOrderOf,
  validatorTier,
  type FollowUpDecision,
  type FollowUpFullReason,
  type FollowUpHistory,
  type PassPlan,
  type PreparedTree,
  type PrOwnedDeltaReader,
} from "@quickchatai/pi-quickreview/src/planner.js";

/** What the round row records of a plan — the same projection on the
 * normal path and on the patch-write fallback, so the stored round and the
 * order always describe one plan. A follow-up round's optional rows ride
 * the addable record, so the executed-pass telemetry reads a run one as
 * offered work rather than an unknown addition. */
function recordedPlan(
  cfg: Config,
  plan: PassPlan,
  optionalPlan: readonly PassPlanEntry[] = [],
): {
  plannedPasses: PassPlanEntry[];
  lenses: string[];
  addablePasses: RecordedAddablePass[];
  validateTier: PassTier | null;
} {
  const plannedPasses = plan.pass_plan;
  const optional: RecordedAddablePass[] = optionalPlan.map((p) => ({
    lens: p.lens,
    tier: p.tier,
    optional: true,
    raisable_to: p.raisable_to,
  }));
  return {
    plannedPasses,
    lenses: lensesOf(plannedPasses),
    addablePasses: [
      ...plan.addable_lenses.map((lens) => ({ lens, tier: addTierOf(cfg, lens) })),
      ...optional,
    ],
    // Null when the profile switched the validator off: the round had no
    // validator, and recording the configured tier would say it did.
    validateTier: plannedPasses.find((p) => p.lens === VALIDATE_PASS)?.tier ?? null,
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

  // Deploy-window drain: the pump starts NOTHING while draining.
  // In-flight rounds keep running to their natural end; queued rows simply
  // wait and dispatch when the drain lifts. The refusal stays quiet at the
  // 15s tick — the drain itself is loud (status.json, qcr status, the board
  // banner, the drain_on event).
  if (store.drainState().draining) return [];

  const slots = capacity(store, cfg);
  if (slots <= 0) return [];

  const dispatched: RoundOrder[] = [];
  /** Why this queued PR may not dispatch now, or null. */
  const heldBack = (row: PrStateRow): string | null => {
    // One PR = one worktree = at most one round in flight. A queued row with a
    // round still running (requeue raced the verdict) waits for the next pump —
    // two rounds sharing wt/pr-<n> fight over the git index.
    if (store.hasRunningRound(row.number)) return "skipped — a round is already running";
    const failure = store.openReviewFailure(row.number);
    if (failure) {
      const action =
        failure.next_action === "retry_wait" && failure.next_retry_at
          ? `automatic retry at ${failure.next_retry_at}`
          : "operator u required";
      return `held FAILED_LOUD (${failure.incident_id}); ${action}`;
    }
    const active = store.blockingSessionCommand(`pr-${row.number}`);
    if (active) return `skipped — session command ${active.id} is ${active.status}`;
    // The operator holds the session (src/takeover.ts): the round waits for the release.
    // A debug lease (src/debuground.ts) is armed for exactly this round: it goes out,
    // and the worker host hands it to the debug pi in place of a worker.
    const lease = store.hostLease(row.number);
    if (lease && lease.kind !== "debug")
      return `skipped — under a ${lease.kind} lease (${lease.holder})`;
    if (store.hasHeldWakes(row.number))
      return "skipped — held conversational wakes must drain first";
    return null;
  };
  const eligible = queuedInOrder(store).filter((row) => {
    const why = heldBack(row);
    if (why) log(`dispatch: #${row.number} ${why}`);
    return why === null;
  });
  // A slot is spent by a round that went running — handed off, or retained
  // behind its durable command — never by a PR this pump skipped, settled or
  // failed to prepare: one PR failing every tick must not starve the queue
  // behind it.
  let started = 0;
  for (const queued of eligible) {
    if (started >= slots) break;
    // Eligibility holds when the work starts, not only when the pump listed
    // the queue: every PR before this one awaited GitHub, and a drain, a
    // close, a pause or a fresh hold may have landed meanwhile. The row is
    // read again, so the round is decided from what it says now.
    if (store.drainState().draining) break;
    const row = store.getPr(queued.number);
    if (!row || row.state !== "queued" || row.paused) {
      log(`dispatch: #${queued.number} skipped — no longer queued (${row?.state ?? "gone"})`);
      continue;
    }
    const why = heldBack(row);
    if (why) {
      log(`dispatch: #${row.number} ${why}`);
      continue;
    }
    let provisionalRoundId: number | undefined;
    // The round's memory window (opened before the seed, below).
    let endMemoryWindow: () => void = () => {};
    // Spends the withheld-approval mark this round inherits (set below).
    let spendWithholding: (roundId: number) => void = () => {};
    // Whether this dispatch painted the PR "in progress" (trigger consumption
    // for a round, below): a failure before any round owns the review takes
    // the label off again.
    let markedInProgress = false;
    try {
      // Backfilled (imported) rounds are excluded: a historical review must
      // never flip a still-open PR's next live round to "re-review", whose
      // template references a settled digest that never existed.
      const priorRounds = store.priorRoundCount(row.number);
      const roundType = roundTypeFor(row, priorRounds);

      // Guard 2, daemon half: a tick with nothing new to look at is a
      // no-op. The triggers are still consumed (leaving them would re-queue the
      // PR on the next reconcile, forever) and the PR returns to the state its
      // last verdict put it in — that verdict still stands.
      //
      // The mark is read through the one standing-review interpretation
      // (standing-review.ts): the shell stamps `posted_event` and the watcher
      // may never enrich `verdict`, so `verdict` alone can read null for a
      // standing REQUEST_CHANGES. Guard 2 keys on head + author reply and
      // nothing else, so THAT is the test here — provenance (a label, a team
      // re-request, a reconcile re-derivation) is a scheduling signal and
      // never widens the posting boundary. If the standing verdict cannot be
      // read off the mark (a COMMENT-only row), no round runs either — guard
      // 2 would still refuse it — but nothing is guessed: the PR lands in
      // `tracked` with a precise anomaly instead of an invented verdict.
      const mark = store.reviewedHead(row.number);
      const standingInfo = standingReview(mark);
      const standing = standingInfo.kind === "decided" ? standingInfo.verdict : null;
      // A withholding standing at THIS head is new evidence of its
      // own. The last round decided "no blockers, approval withheld for CI",
      // and something re-queued the PR — CI going green (cigate.ts) or a
      // person. Skipping here would leave that PR waiting for a verdict that is
      // never re-attempted, which is the stuck-PR failure the gate must not
      // create.
      const withheld =
        store.approvalWithheld(row.number) ??
        restoreInterruptedApprovalRetry(
          store,
          row,
          deps.postingReceiptDir ?? join(sandboxRoot(), "state", "posting-receipts"),
        );
      const withheldHere = withheld?.head_sha === row.head_sha;
      // The round about to run re-decides the verdict from scratch, so the
      // withholding it inherits is spent — once the round has a durable owner
      // (the session handoff), never before: a failure before the handoff
      // leaves the mark standing, so the next pump still owes the approval
      // retry and the reconcile backstop still sees it. Only the mark read
      // here is spent; a new one is recorded if this round's approval is
      // withheld again (guards.ts guard 4, or the verdict's
      // `approval_withheld`).
      let withholdingSpent = false;
      spendWithholding = (roundId) => {
        if (!withheld || withholdingSpent) return;
        store.db.transaction(() => {
          const current = store.approvalWithheld(row.number);
          if (
            current &&
            current.head_sha === withheld.head_sha &&
            current.created_at === withheld.created_at
          )
            store.clearApprovalWithheld(row.number);
          // The spend's own record: what `restoreInterruptedApprovalRetry`
          // re-records should this round end without deciding.
          if (withheldHere)
            store.logEvent("approval_retry_dispatched", row.number, {
              head_sha: row.head_sha,
              round_id: roundId,
              ci_state: withheld.ci_state,
              reason: withheld.reason,
            });
        })();
        withholdingSpent = true;
      };
      if (cfg.guards.skip_unchanged_head && !withheldHere && !hasNewEvidence(mark, row.head_sha)) {
        // Captured BEFORE the transition below clears them: current PR state
        // is not historical evidence (a later failure overwrites the
        // provenance).
        const decision = {
          stage: "dispatch",
          head_sha: row.head_sha,
          trigger_ts: row.trigger_ts,
          trigger_provenance: row.trigger_provenance,
          standing_verdict: standing,
          standing_source: standingInfo.kind === "decided" ? standingInfo.source : null,
          // Duplicate of standing_verdict, for readers of the older payload shape.
          last_verdict: standing,
          reviewed_at: mark!.reviewed_at,
          mark: snapshotMark(mark!),
        };
        await consumeTriggers(deps, row.number, { markInProgress: false });
        // An author reply landing during the consumption is new evidence the
        // skip did not see: the next pump runs the round it now owes.
        const movedSkip =
          movedDuringConsume(store, row) ??
          (hasNewEvidence(store.reviewedHead(row.number), row.head_sha) ? "new_evidence" : null);
        if (movedSkip) {
          logSupersededSettlement(deps, row, "no-new-evidence skip", movedSkip);
          continue;
        }
        store.logEvent("round_skipped_no_new_evidence", row.number, decision);
        // The head this skip settles is reviewed already: a successor owed at
        // it is answered, and is not promoted again on every reconcile pass.
        store.settleSuccessor(row.number, row.head_sha);
        if (standingInfo.kind === "unknown") {
          store.logAnomaly(
            "standing_review_unknown",
            row.number,
            null,
            `#${row.number} was re-triggered at ${row.head_sha.slice(0, 7)}, which is already reviewed with no author reply since, but the reviewed-head mark carries no verdict (posted_event=${standingInfo.posted_event ?? "null"}). No round was run — posting guard 2 would refuse its review — and no verdict was guessed; the PR is tracked until the author pushes or replies.`,
          );
        }
        const restored = restoreStandingLifecycle(store, row.number, standing, {
          botLogin: botAccountLogin(cfg.github),
          now,
          reason: standing ? "no-new-evidence" : "no-new-evidence:standing-unknown",
        });
        log(
          `dispatch: #${row.number} skipped — no new evidence at ${row.head_sha.slice(0, 7)}; standing ${standing ?? "review (verdict unknown)"} stands, PR ${restored}`,
        );
        continue;
      }

      // A SYSTEM-provenance re-trigger (push / CI / staleness at an existing
      // trigger state — never a fresh human ask, which applyEvent stamps
      // "human") consults the recheck delta classifier before paying for a
      // full round. Empty/trivial delta since the reviewed head ⇒ consume the
      // trigger and leave state as an uphold would; significant ⇒ the full
      // round below runs. First reviews never short-circuit, and a withheld
      // approval at this head is its own new evidence: that round must run so
      // the approval can finally post.
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
            // Uphold semantics, daemon-side: a never-posted (withheld) approval
            // follows the head on a trivial/empty delta.
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
              // real recheck already holds is left untouched. No wake is sent,
              // so no receipt can exist: never the undelivered sweep's to
              // release.
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
          // The trivial delta answers this head: a successor owed at it is
          // settled, so reconcile does not promote it again on every pass.
          store.settleSuccessor(row.number, row.head_sha);
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
              botLogin: botAccountLogin(cfg.github),
              now,
              reason: `dispatch-short-circuit:${sc.reason}`,
            },
          );
          continue;
        }
      }

      markedInProgress = true;
      const consumed = await consumeTriggers(deps, row.number);

      // The branch this PR targets (base freshness) and its body
      // (pass-intent's artifact + substance bar) come off one getPr read. A
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
      // the passes will actually read. `row.head_sha` is a webhook/reconcile
      // snapshot; a push landing between it and the fetch would otherwise have
      // passes cite one sha while reading another tree, with anchors computed
      // against a diff the review is not about.
      //
      // And BEFORE the changed-files read: every file-derived fact of the round
      // — the migration gate, the pass plan and sweep focus, the collision
      // pre-check, the diffstat — must describe the head the tree holds (read
      // first, a migration a racing push added would get no gate and no
      // collision check). The files API is by PR number, so read after the
      // fetch it lists at least the prepared head.
      const tree = deps.prepareWorktree
        ? await deps.prepareWorktree(row.number, baseRef, row.head_sha)
        : undefined;
      // The head this round reviews — the prepared tree's, else the row's —
      // decided once, so the round row, the prior findings, the pre-check,
      // the recovery identity and the order all name the same one.
      const preparedHead = reviewedHeadOf(tree, row);

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
      // Follow-up rounds (docs/follow-up-rounds.md): every round after the
      // first reviews the PR-owned change since the last reviewed head — or,
      // on any doubt, runs a full re-review. `files` stays the WHOLE
      // PR for every per-PR fact (the migration gate, the pre-check, the
      // directive escalation, the diffstat, dependency sources, memory and
      // lessons); only the plan and the coverage check read the delta.
      let followUp: FollowUpDecision | null = null;
      let fullRound: { reason: FollowUpFullReason; detail?: Record<string, unknown> } | null = null;
      if (roundType === "re-review") {
        const decided = await decideFollowUp(
          {
            cfg: deps.cfg,
            history: deps.store,
            ...(deps.prOwnedDelta ? { prOwnedDelta: deps.prOwnedDelta } : {}),
            ...(deps.heuristics ? { heuristics: deps.heuristics } : {}),
          },
          {
            pr: row.number,
            markHead: mark?.head_sha,
            tree,
            files,
            fullPlan,
            standing,
            // Read before this dispatch spends it: a withheld approval is
            // one GitHub never saw, so the sweep stays owed behind it.
            approvalWithheld: withheld !== undefined,
            ecosystem: eco,
            styleGuide,
            ciLinters,
          },
        );
        if (decided.kind === "delta") followUp = decided.decision;
        else
          fullRound = {
            reason: decided.reason,
            ...(decided.detail ? { detail: decided.detail } : {}),
          };
      }
      let passPolicy = followUp ? followUp.plan : fullPlan;
      let { plannedPasses, lenses, addablePasses, validateTier } = recordedPlan(
        cfg,
        passPolicy,
        followUp?.optionalPlan,
      );

      // The PR must still be queued when its round row is written — read in
      // the same turn as `startRound`. Preparation awaited GitHub and git, and
      // a verdict settling an older round (a late, orphan-swept one), a close
      // or the operator may have moved the row meanwhile; then this round is
      // nobody's work and no row is written. The in-progress label the
      // trigger consumption put on comes off again (best effort).
      const live = store.getPr(row.number);
      if (live?.state !== "queued") {
        log(
          `dispatch: #${row.number} left the queue (${live?.state ?? "gone"}) while its round was prepared — no round started`,
        );
        store.logEvent("dispatch_abandoned", row.number, {
          state: live?.state ?? null,
          head_sha: preparedHead,
        });
        try {
          await deps.adapter.removeLabel(row.number, cfg.github.in_progress_label);
        } catch (err) {
          log(`dispatch: #${row.number} in-progress label not removed`, err);
        }
        continue;
      }
      // Diffstat comes free off the files list dispatch already fetched — no
      // extra GitHub call in the hot path. trigger_ts is copied off pr_state
      // here because the `dispatched` transition clears it moments later.
      // validate_tier is recorded so a later audit can tell which tier judged
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
          head_sha: preparedHead,
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

      // The delta as one patch file, beside the round's other state
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
          ({ plannedPasses, lenses, addablePasses, validateTier } = recordedPlan(cfg, passPolicy));
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
          head_sha: preparedHead,
          last_reviewed_sha: mark?.head_sha ?? null,
          ...(fullRound.detail ?? {}),
        });
        log(`dispatch: #${row.number} round ${roundNo} runs in full (${fullRound.reason})`);
      }
      if (passPolicy.behaviour_unread)
        store.logEvent("behaviour_delta_unread", row.number, {
          round_id: roundId,
          round_no: roundNo,
          files: passPolicy.behaviour_unread,
        });
      // The prior findings this follow-up round verifies — listed in
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
            preparedHead,
          )
        : null;
      const priorFindingsNote = priorFindings?.note ?? "";

      if (tree?.pull_ref_sha) {
        log(
          `dispatch: #${row.number} GitHub's refs/pull/${row.number}/head lags (${tree.pull_ref_sha}); reviewing the API head ${tree.head_sha}`,
        );
        store.logEvent("pull_ref_lagged", row.number, {
          round_id: roundId,
          pull_ref: tree.pull_ref_sha,
          head: tree.head_sha,
        });
      }
      if (tree && row.head_sha && tree.head_sha !== row.head_sha) {
        log(`dispatch: #${row.number} head drift ${row.head_sha} → ${tree.head_sha}`);
        store.logEvent("head_drift", row.number, {
          round_id: roundId,
          expected: row.head_sha,
          actual: tree.head_sha,
          source: "worktree_prepare",
        });
      }

      // The integrity fingerprint — git's config/hook files and this system's
      // own policy surface under the sandbox root — taken HERE: after the
      // worktree is materialised (so the tree is the one the round will read)
      // and before the session hears about the round (so nothing it does is
      // inside the baseline). `verdicts.measureUsage` re-checks it when the
      // round ends. Best-effort in both directions: a fingerprint that cannot
      // be taken leaves the round unchecked — it never fails a round. It hashes
      // the whole policy surface (dist/, scripts/, …) asynchronously, a loop
      // turn after every file, and is BOUNDED, because this await sits inside
      // the one serialized dispatch pump: a read that never returns leaves
      // this round unchecked (no baseline), never every later PR undispatched.
      try {
        const budgetMs = Math.max(0, deps.integrityBudgetMs ?? INTEGRITY_BUDGET_MS);
        const baseline = await withinBudget(
          (deps.integrityFingerprint ?? fingerprintRoundIntegrity)(
            roundIntegrityOpts(githubCloneDir(cfg.github), sandboxRoot(), worktreeFor(row.number)),
          ),
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

      // The ecosystem pre-check, before the session hears about the round.
      // Django delivers collisions as its
      // own COMMENT, so whatever the review concludes, the renumber never
      // rides on the verdict; a `none` ecosystem runs nothing at all.
      const precheck = await ecosystemPreCheck(deps, eco, {
        round_id: roundId,
        pr: row.number,
        files,
        head_sha: preparedHead,
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
        // Durable anomaly record + the overseer wake (WAKE class) — one
        // logAnomaly call, the store's sink writes the inject.
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
      // Third-party sources for the passes (`[review] dependency_sources`).
      // Total by contract — a dead registry yields an empty note, never a
      // failed or delayed-past-budget round.
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
                ...(priorFindings?.list ? { priorFindings: priorFindings.list } : {}),
                ...(followUp.optionalPlan ? { optionalPlan: followUp.optionalPlan } : {}),
                ...(followUp.sweepPlan ? { sweepPlan: followUp.sweepPlan } : {}),
                ...(followUp.sweepUnswept ? { sweepUnswept: followUp.sweepUnswept } : {}),
                ...(followUp.sweepBehaviourUnread
                  ? { sweepBehaviourUnread: followUp.sweepBehaviourUnread }
                  : {}),
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
          // One read of the ledger mirror per order; an explicit
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
        // The host's lens tools, so the prompt and the task files name the ones its
        // sessions have (rule 9: `lens` / `lens_wave` on workers).
        ...(deps.hooks.lensRuntime ? { lensRuntime: deps.hooks.lensRuntime } : {}),
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
      // Under `[memory] delivery = "on"` the round's LESSON
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
      // unawaited (below).
      const delivering = lessonsDelivering(deps, log);
      // No case batch starts while this round reads memory — the
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

      // `[review] task_files` (packages/pi-plugin/src/passtasks.ts): each discovery row's
      // complete lens task, written beside the round's pass outputs so the
      // session launches lenses with a pointer instead of generating every
      // task string. Total: a write that fails leaves the order without task
      // files, and the session writes the strings itself. Under `on` each
      // row's delivered lessons ride its task file.
      // `[review] context_pack = "pack-first"`: the round's CONTEXT
      // PACK, written before the task files that point at it, and only where
      // children share a cache key (`[engine] lens_cache_group`) — an unshared
      // pack costs every lens more, not less. Total: a pack that cannot be
      // written leaves the round exactly as without one; a stale pack from an
      // earlier attempt of this round number never survives into it.
      const passesDir = resolve(sandboxRoot(), "state", `pr-${row.number}-round-${roundNo}-passes`);
      const packPath = join(passesDir, CONTEXT_PACK_FILE);
      const removeStalePack = (): void => {
        try {
          rmSync(packPath, { force: true });
        } catch (err) {
          log(`dispatch: #${row.number} stale context pack not removed`, err);
        }
      };
      let packed: RoundOrder = built;
      if (
        cfg.review.task_files &&
        cfg.review.context_pack === "pack-first" &&
        cfg.engine.lens_cache_group > 0
      ) {
        try {
          const pack = renderContextPack({
            pr: row.number,
            headSha: built.head_sha,
            mergeBase: built.merge_base,
            files,
            ...(followUp ? { deltaPatch: renderDeltaPatch(followUp.delta.files) } : {}),
            readFile: (p) => readWorktreeFileForPack(resolve(sandboxRoot(), built.worktree), p),
            maxTokens: cfg.review.context_pack_max_tokens,
          });
          mkdirSync(passesDir, { recursive: true });
          writeFileSync(`${packPath}.tmp`, pack.text);
          renameSync(`${packPath}.tmp`, packPath);
          packed = { ...built, context_pack_file: packPath };
          store.logEvent("context_pack_written", row.number, {
            round_id: roundId,
            chars: pack.chars,
            diff_files: pack.diffFiles.length,
            diff_omitted: pack.diffOmitted.length,
            full_files: pack.fullFiles.length,
          });
        } catch (err) {
          log(`dispatch: #${row.number} context pack not written`, err);
          // A child finds the pack beside its task file, not through the
          // order — an earlier attempt's pack left here would be read as
          // this round's.
          removeStalePack();
        }
      } else {
        removeStalePack();
      }

      let order = packed;
      let rowsDelivered = false;
      if (cfg.review.task_files) {
        try {
          const dir = join(passesDir, "tasks");
          const tasks = writePassTasks(
            dir,
            packed,
            renderGateNotes(packed, eco),
            delivery
              ? {
                  rows: new Map(delivery.rows.map((r) => [r.row, r.lessons] as const)),
                  repo: delivery.repo,
                }
              : undefined,
          );
          order = {
            ...packed,
            pass_task_files: tasks.map((t) => ({ row: t.row, agent: t.agent, path: t.path })),
          };
          rowsDelivered = true;
        } catch (err) {
          log(`dispatch: #${row.number} lens task files unavailable`, err);
        }
        // The owed pre-approval sweep's task files — its own
        // directory and row index (`row` indexes `sweep_plan`), the whole PR's
        // full plan rendered exactly as a full round's. No lesson rows ride
        // them: lesson selection covers `pass_plan` rows only. Total, as above.
        // With no sweep owed, an earlier attempt's sweep dir is removed, so
        // nothing stale can be launched from it.
        const sweepDir = join(passesDir, "tasks-sweep");
        if (!built.sweep_plan || built.sweep_plan.length === 0) {
          try {
            rmSync(sweepDir, { recursive: true, force: true });
          } catch (err) {
            log(`dispatch: #${row.number} stale sweep task dir not removed`, err);
          }
        }
        // The optional rows' task files — their own directory and
        // row index (`row` indexes `optional_plan`), rendered from the
        // follow-up order itself, so they carry the change since the last
        // review exactly as the core rows do. Total, as above.
        const optionalDir = join(passesDir, "tasks-optional");
        if (!built.optional_plan || built.optional_plan.length === 0) {
          try {
            rmSync(optionalDir, { recursive: true, force: true });
          } catch (err) {
            log(`dispatch: #${row.number} stale optional task dir not removed`, err);
          }
        } else {
          try {
            const optionalOrder = optionalOrderOf(packed, built.optional_plan);
            const optionalTasks = writePassTasks(
              optionalDir,
              optionalOrder,
              renderGateNotes(optionalOrder, eco),
            );
            order = {
              ...order,
              optional_task_files: optionalTasks.map((t) => ({
                row: t.row,
                agent: t.agent,
                path: t.path,
              })),
            };
          } catch (err) {
            log(`dispatch: #${row.number} optional task files unavailable`, err);
          }
        }
        if (built.sweep_plan && built.sweep_plan.length > 0) {
          try {
            const sweepOrder = sweepOrderOf(packed, built.sweep_plan);
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
        dir: join(passesDir, "lessons"),
      });

      // A PR closed while its round was prepared gets no session and no
      // prompt: the provisional round is discarded like any failed
      // preparation (the close hook already archived the session).
      if (store.getPr(row.number)?.state === "closed")
        throw new Error(`#${row.number} closed while its round was prepared — not handed off`);
      // The round is provisional until the worktree/session/prompt handoff
      // completes; publishing reviewing/running state any earlier would leave
      // an orphan round whenever worktree preparation fails.
      const prompt = render(order, memory);
      // Rendering and optional preparation may have awaited or invoked callers
      // that changed the operator hold. Re-admit at the actual handoff seam.
      const admitted = store.getPr(row.number);
      if (!admitted || admitted.state === "closed" || admitted.paused)
        throw new Error(`#${row.number} closed or paused during preparation — not handed off`);
      await deps.hooks.dispatchRound(order, prompt);
      // Record the receipt token this round's prompt carries, so the
      // recovery paths can tell "delivered" from "never arrived" instead of
      // inferring it. Stamped only AFTER dispatchRound resolved: the marker
      // asserts that a prompt bearing it was written, and a dispatch that
      // threw may not have written it (one that persisted its durable
      // command first is retained by the catch below, unstamped).
      store.stampPromptMarker(roundId, roundPromptMarker(row.number, roundNo));
      spendWithholding(roundId);
      // The head this round reviews is the next follow-up round's
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
      // The round's lesson selection — the shadow ledger's
      // input. Started only now, with the round handed off, and never
      // awaited: under `shadow` it changes nothing in this round's prompt,
      // task files or agents, so nothing is gained by starting it sooner —
      // and starting it before the seed would queue its finds ahead of the
      // round's own memory search on the server's one-thread embedder. Under
      // `on` it already ran, awaited beside the seed (above).
      if (deps.lessons && !delivering) {
        try {
          deps.lessons.start(order, files);
        } catch (err) {
          log(`dispatch: #${row.number} lesson selection not started (ignored)`, err);
        }
      }
      // `start` opened the selector's own window synchronously (or there
      // is no selection) — the round's own window closes now.
      endMemoryWindow();

      setPrGates(store, row.number, gate);
      applyEvent(
        store,
        row.number,
        { type: "dispatched" },
        {},
        { botLogin: botAccountLogin(cfg.github), now },
      );
      store.logEvent("round_dispatched", row.number, {
        round_id: roundId,
        round_no: roundNo,
        round_type: roundType,
        // What a later round reviewed (absent on a first round).
        ...(roundType === "re-review"
          ? {
              scope: order.scope === "delta" ? "delta" : "full",
              ...(order.delta
                ? {
                    delta_lines: order.delta.lines,
                    delta_files: order.delta.files.length,
                    sweep_owed: (order.sweep_plan?.length ?? 0) > 0,
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
      // Slack: the PR's thread root on the first round we see, a
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
      started++;
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
          started++;
          // The retained round owns the review now: the withholding it
          // inherited is spent, exactly as on a clean handoff.
          try {
            spendWithholding(provisionalRoundId);
          } catch (spendError) {
            log(`dispatch: #${row.number} withheld-approval mark not spent`, spendError);
          }
          try {
            applyEvent(
              store,
              row.number,
              { type: "dispatched" },
              {},
              { botLogin: botAccountLogin(cfg.github), now },
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
          // Under `on` the round's lesson selection ran — and was
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
      // No round owns the review: the PR stays queued for the next pump,
      // which paints it again when its round really starts.
      if (!retainedCommand && markedInProgress) {
        try {
          await deps.adapter.removeLabel(row.number, cfg.github.in_progress_label);
        } catch (labelError) {
          log(`dispatch: #${row.number} in-progress label not removed`, labelError);
        }
      }
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
      // A round that failed after its seed never leaves the case
      // writer held (idempotent: a closed window stays closed).
      endMemoryWindow();
    }
  }
  return dispatched;
}
