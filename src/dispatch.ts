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
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { githubCloneDir, sandboxRoot } from "./config.js";
import { fingerprintRoundIntegrity } from "./execboundary.js";
import type { GateResult } from "./gate.js";
import type { PrFileEntry } from "./github.js";
import { DJANGO_ECOSYSTEM, type Ecosystem } from "./ecosystem.js";
import { promptTargetsFor } from "./escalation.js";
import {
  INTENT_PASS,
  passTier,
  selectLenses,
  selectSubLenses,
  SWEEP_PASS,
  sweepGroups,
  CODE_FILE_RE,
  TESTS_PASS,
} from "./heuristics.js";
import type { HeuristicsExtension } from "./heuristics.js";
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
  classifyDelta,
  recheckFingerprint,
  type DeltaClass,
  type DeltaFile,
} from "./recheck.js";
import { roundPostingKey } from "./posting-receipt.js";
import { directiveVocabulary, isFirstPartyDirectivePath } from "./severity.js";
import type { DispatchAnnouncer } from "./slack/announce.js";
import { applyEvent, restoreStandingLifecycle, setPrGates } from "./statemachine.js";
import type { PrStateRow, ReviewedHeadRow, StateStore } from "./state.js";
import { snapshotMark, standingReview } from "./standing-review.js";
import { higherTier, PASS_TIER_ORDER, roundPromptMarker } from "./types.js";
import type {
  PassPlanEntry,
  PassTier,
  RoundOrder,
  RoundRecoveryContext,
  RoundType,
  SessionHooks,
} from "./types.js";

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
  compareFiles?(base: string, head: string): Promise<DeltaFile[]>;
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
): Promise<{ collisions: MigrationCollision[]; degraded: boolean; commentWithheld: boolean }> {
  const outcome = await eco.preCheck(
    {
      logEvent: (kind, pr, payload) => deps.store.logEvent(kind, pr, payload),
      migrationCollisionCommented: (pr, fingerprint) =>
        deps.store.migrationCollisionCommented(pr, fingerprint),
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
 * When this daemon last alerted the overseer about memory being down, per
 * store (the store IS the daemon instance's identity, same as `activePumps`).
 *
 * The gap is EVENT-logged on every affected round — the record is never
 * thinned. Only the overseer ALERT is cooled down: a context store that stays
 * down would otherwise mint one anomaly inject per round forever, which buries
 * the anomalies that need reading. A cold-start daemon alerts on its first
 * degraded round, which is the sample that matters.
 */
const memoryAlertAt = new WeakMap<StateStore, number>();

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
 * alert the overseer, dispatch memory-less.
 */
async function seedRoundMemory(
  deps: DispatchDeps,
  order: RoundOrder,
  files: PrFileEntry[],
): Promise<RoundMemory> {
  const seed = deps.memory;
  if (!seed) return MEMORY_LESS;
  const log = deps.log ?? (() => {});
  const query = roundContextQuery({ title: order.title, files });
  const timeoutMs = seed.timeoutMs ?? ROUND_CONTEXT_DEFAULTS.timeoutMs;
  let mem: RoundMemory;
  try {
    mem = await assembleRoundMemory(seed.assembler, query, {
      ...(seed.maxTokens !== undefined ? { maxTokens: seed.maxTokens } : {}),
      timeoutMs,
      log,
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
  if (!mem.degraded) return mem;

  log(`dispatch: #${order.pr} round ${order.round_no} seeded memory-less (${describeGaps(mem)})`);
  const missing = [
    ...(mem.gaps.some((g) => g.part === "head") ? ["no standing-instructions head"] : []),
    ...(mem.gaps.some((g) => g.part === "context") ? ["no recalled context"] : []),
  ].join(" and ");
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();
  const cooldownMs = (seed.alertCooldownMin ?? 60) * 60_000;
  const last = memoryAlertAt.get(deps.store);
  if (last !== undefined && nowMs - last < cooldownMs) return mem;
  memoryAlertAt.set(deps.store, nowMs);
  deps.store.logAnomaly(
    "round_memory_degraded",
    order.pr,
    order.round_no,
    `context store did not answer at round build (${describeGaps(mem)}); the round was dispatched memory-less`,
    [
      `ANOMALY (memory) — PR #${order.pr} round ${order.round_no}`,
      `The context store did not answer when this round was built (${describeGaps(mem)}), so the round prompt carries ${missing}.`,
      "The round itself was dispatched normally and on time — memory never blocks or delays a review. But a memory " +
        "engine that stays down means every round is running blind: check the openviking supervisor's status " +
        "(state/status.json) and the daemon log.",
      `Further memory alerts are suppressed for ${seed.alertCooldownMin ?? 60} minutes; the per-round record stays in the round_memory_seeded events.`,
    ].join("\n"),
  );
  return mem;
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
    const own = await deps.adapter.listPrFiles(row.number);
    const prFiles = new Set(
      own.flatMap((f: DeltaFile) =>
        f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
      ),
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
    const cls = classifyDelta(delta, { prFiles, ...(resolvedFiles ? { resolvedFiles } : {}) });
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
  "pass-placement",
  "pass-simplicity",
  "pass-backcompat",
  // ADDABLE-ONLY, deliberately. `selectLenses` never emits
  // pass-concurrency — a read-modify-write race has no filename (the 29
  // corpus findings span eight unrelated modules), so no path predicate finds
  // the set. It reaches a round only through the add protocol, when the
  // session names the read-then-write it suspects.
  "pass-concurrency",
  // ADDABLE-ONLY for the same reason and one more. No path predicate
  // finds "code whose intent is written down nowhere", and the deciding fact —
  // whether the answer is in the repo at all — is only visible after the diff
  // has been read, which is exactly when the session runs the add protocol.
  // (pass-intent's substance bar is the precedent for what daemon-side
  // selection must be: cheap AND honest. The one body-shaped signal here — "the
  // PR text never says why" — is true of most PRs, so planning on it would
  // dispatch the lens nearly always: the pure-spend case that bar exists to
  // prevent, on a lens whose failure mode is volume.)
  "pass-ask-human",
  // Content-triggered sub-lenses (heuristics.ts SUBLENS_TRIGGERS — this list
  // is held equal to SUBLENS_PASSES by tests/review-levers.test.ts): planned
  // when their trigger fires, addable otherwise — the max-effort benchmark
  // runs added a lens on 6 of 10 PRs, and the added lens found defects no
  // planned one did.
  "pass-widened",
  "pass-roundtrip",
  "pass-deferred",
  "pass-bounds",
  "pass-claims",
  "pass-rollout",
  // The per-file sweep: planned as one row per file group when `[review]
  // sweep` is on; otherwise addable, so a session can sweep a file it
  // suspects.
  "pass-sweep",
  // the tests lens — planned on every PR that changes code when
  // `[review] tests_lens` is on; addable otherwise.
  "pass-tests",
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
  intent?: { title?: string | null; body?: string | null },
  /**: whose tier-forcing gate applies. Default Django — the shipped
   * pre-seam behavior; `none` never forces sol-med off a migrations path. */
  ecosystem: Ecosystem = DJANGO_ECOSYSTEM,
  /** Profile lens-heuristics extension; absent ⇒ generic core. */
  heuristics?: HeuristicsExtension,
): { pass_plan: PassPlanEntry[]; addable_lenses: string[]; sweep_unswept: string[] } {
  const defaultTier = passTier(files, {
    migrationGate: ecosystem.migrationGate(files),
    smallDiffLines: cfg.models.small_diff_lines,
  });
  const risk = new Set(cfg.models.risk_passes);
  const selected0 = selectLenses(files, intent, heuristics, {
    intentMinWords: cfg.review.intent_min_words,
    placementMinCodeFiles: cfg.review.placement_min_code_files,
    placementMinNewFileLines: cfg.review.placement_min_new_file_lines,
  });
  // Sub-lenses ride after the path-selected lenses, each with the reason its
  // trigger fired (benchmark 2026-09-26; `[review] sublenses`).
  const sub = cfg.review.sublenses
    ? selectSubLenses(files, intent).filter((s) => !selected0.includes(s.lens))
    : [];
  const whyOf = new Map(sub.map((s) => [s.lens, s.why]));
  // existing tests are consumers of every code change, and the PR's
  // own tests are claims about the code — one lens reads both.
  const tests =
    cfg.review.tests_lens && files.some((f) => CODE_FILE_RE.test(f.filename)) ? [TESTS_PASS] : [];
  const lenses = [...selected0, ...sub.map((s) => s.lens), ...tests, VALIDATE_PASS];
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
    const why = whyOf.get(lens);
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
  // not deep reasoning — inserted before the validator. The validator's tier
  // is computed from the lenses above and a terra-med sweep never raises it.
  let sweep_unswept: string[] = [];
  if (cfg.review.sweep) {
    const { groups, unswept } = sweepGroups(
      files,
      cfg.review.sweep_max_groups,
      cfg.review.sweep_group_files,
      cfg.review.sweep_group_lines,
    );
    sweep_unswept = unswept;
    const rows = groups.map((focus): PassPlanEntry => ({
      lens: SWEEP_PASS,
      agent: `${SWEEP_PASS}--terra-med`,
      tier: "terra-med",
      raisable_to: raisableFrom(SWEEP_PASS, "terra-med"),
      focus,
    }));
    pass_plan.splice(pass_plan.length - 1, 0, ...rows);
  }
  const selected = new Set(pass_plan.map((p) => p.lens));
  const addable_lenses = [...new Set([...ALL_PASSES, ...cfg.models.risk_passes])].filter(
    (l) => !selected.has(l),
  );
  return { pass_plan, addable_lenses, sweep_unswept };
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
  /**: the round's ecosystem. Absent ⇒ Django (pre-seam behavior). */
  ecosystem?: Ecosystem;
  /** exact predecessor identity for a pre-fanout recovery successor. */
  recovery?: RoundRecoveryContext;
  /** Profile lens-heuristics extension; absent ⇒ generic core. */
  heuristics?: HeuristicsExtension;
  /** The rendered third-party-sources block (src/depsources.ts). */
  dependencyNote?: string;
}): RoundOrder {
  const eco = args.ecosystem ?? DJANGO_ECOSYSTEM;
  const { pass_plan, addable_lenses, sweep_unswept } = buildPassPlan(
    args.cfg,
    args.files,
    { title: args.row.title, body: args.prBody },
    eco,
    args.heuristics,
  );
  const headSha = args.tree?.head_sha || args.row.head_sha;
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
    ...(sweep_unswept.length > 0 ? { sweep_unswept } : {}),
    ...(args.dependencyNote ? { dependency_note: args.dependencyNote } : {}),
    migration_gate: eco.migrationGate(args.files),
    migration_collisions: args.migrationCollisions ?? [],
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
  const eco = deps.ecosystem ?? DJANGO_ECOSYSTEM;
  const now = deps.now ?? (() => new Date());
  const render =
    deps.renderPrompt ?? ((o: RoundOrder, _m: RoundMemory) => JSON.stringify(o, null, 2));
  const worktreeFor = deps.worktreeFor ?? defaultWorktree;
  const settledDigest = deps.settledDigest ?? (() => "");
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
              // real recheck already holds is left untouched.
              store.claimRecheck(
                row.number,
                recheckFingerprint({ trigger: "push" }, row.head_sha),
                {
                  head_sha: row.head_sha,
                  trigger: "push",
                  reason: `dispatch-short-circuit:${sc.reason}`,
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

      const files = await deps.adapter.listPrFiles(row.number);
      const gate = eco.migrationGate(files);
      // The plan is pure and deterministic in `files` + the PR body, so
      // computing it here and again inside buildRoundOrder yields the same
      // tiers; taking the lens list off it keeps the round row and the order
      // from ever disagreeing.
      const passPolicy = buildPassPlan(
        cfg,
        files,
        { title: row.title, body: prBody },
        eco,
        deps.heuristics,
      );
      const plannedPasses = passPolicy.pass_plan;
      const lenses = [...new Set(plannedPasses.map((p) => p.lens))];
      const riskPasses = new Set(cfg.models.risk_passes);
      const addablePasses = passPolicy.addable_lenses.map((lens) => ({
        lens,
        tier: riskPasses.has(lens) ? "sol-high" : "sol-med",
      }));
      const validateTier =
        plannedPasses.find((p) => p.lens === VALIDATE_PASS)?.tier ?? cfg.models.validate_tier;

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
        },
      );
      provisionalRoundId = roundId;
      const roundNo = (
        store.db.prepare("SELECT round_no FROM rounds WHERE id = ?").get(roundId) as {
          round_no: number;
        }
      ).round_no;

      // Prepare the tree BEFORE building the order, so the prompt cites the sha
      // the passes will actually read. The old sequence built the order from
      // `row.head_sha` (a webhook/reconcile snapshot) and only then fetched, so
      // a push landing in between made the prompt quietly wrong — passes cited
      // one sha while reading another tree, and their anchors were computed
      // against a diff the review was not about.
      const tree = deps.prepareWorktree
        ? await deps.prepareWorktree(row.number, baseRef)
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
      // the legacy behaviour — it never fails a round.
      try {
        store.recordRoundGitConfig(
          roundId,
          fingerprintRoundIntegrity({
            clonePath: githubCloneDir(cfg.github),
            worktreePath: resolve(sandboxRoot(), worktreeFor(row.number)),
            piHome: join(sandboxRoot(), "pihome"),
            sandboxRoot: sandboxRoot(),
          }),
        );
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
      const order = buildRoundOrder({
        tree,
        ecosystem: eco,
        ...(dependencyNote ? { dependencyNote } : {}),
        ...(recovery ? { recovery } : {}),
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
        ...(deps.heuristics !== undefined ? { heuristics: deps.heuristics } : {}),
      });

      // The ONE memory call of this round, placed after the worktree
      // and the order so the context is seeded from the same sha the passes
      // read. It is bounded and total: the worst case is this round's prompt
      // arriving memory-less a couple of seconds later.
      store.stampPostingKey(roundId, order.posting_key!);
      const memory = await seedRoundMemory(deps, order, files);

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
    }
  }
  return dispatched;
}
