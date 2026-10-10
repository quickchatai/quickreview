// quickreviewd — the daemon entrypoint. Wires config → store → gate → adapter →
// webhook server + reconcile poll + dispatch pump + verdict watcher + deadline
// checker + status.json writer.
//
// Everything that touches GitHub goes through the MutationGate, which in
// dry-run records the intended call to state/dryrun/ instead of executing it.
// The session manager is behind SessionHooks: `createDaemon({ hooks })` swaps
// the real implementation in for the disk-logging stub without touching this
// file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnomalyWakePolicy } from "./anomalies.js";
import { retryWithheldApproval, type CiAdapter, type WithheldRetryDeps } from "./cigate.js";
import {
  DEFAULT_ROUND_FIRST_PASS_MAX_MIN,
  DEFAULT_ROUND_PASSES_MAX_MIN,
  DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
  DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN,
  loadConfig,
  sandboxRoot,
  type Config,
} from "./config.js";
import { dispatchOnce, type DispatchAdapter } from "./dispatch.js";
import {
  DaemonLoadMonitor,
  EVENT_LOOP_WAKE_KIND,
  eventLoopPolicy,
  type DaemonLoadMonitorDeps,
  type DaemonLoadStatus,
} from "./eventloop.js";
import { MutationGate, type MutationIntent } from "./gate.js";
import { GitHubAdapter } from "./github.js";
import { TokenMinter } from "./githubAuth.js";
import { REVIEW_SET_ASIDE_STALE_WINDOW_MS, type FeedbackEvent } from "./feedback.js";
import { enforceLedgerFreshness } from "./ledgercheck.js";
import { readLedgerCarry } from "./ledgercarry.js";
import type { RepoFactsQuery } from "./lessonselect.js";
import { sweepExpiredLevers } from "./levers.js";
import {
  PingPongLedger,
  ThreadDecisionWatcher,
  buildWakeMessage,
  type AuthorReplyEvent,
} from "./pingpong.js";
import { OutcomeCapture, type AnchorGit } from "./outcomes.js";
import { reconcileOnce, type ReconcileAdapter } from "./reconcile.js";
import {
  RecheckWatcher,
  runBaseAdvance,
  runRecheck,
  type RecheckAdapter,
  type RecheckDeps,
  type RecheckOrder,
} from "./recheck.js";
import type { DispatchAnnouncer, VerdictAnnouncer } from "./slack/announce.js";
import { applyEvent } from "./statemachine.js";
import { buildPipelineStatus, buildStatusSnapshot, StateStore, writeStatusJson } from "./state.js";
import { PiAuthWatch } from "./authwatch.js";
import { SessionCommandSupervisor } from "./session-command-supervisor.js";
import { parseRoundProgress } from "./round-progress.js";
import { SingleFlight } from "./singleflight.js";
import { yieldToLoop } from "./yieldloop.js";
import { stubSessionHooks } from "./stubs.js";
import type { SessionHooks } from "./types.js";
import { VerdictWatcher, type VerdictAdapter } from "./verdicts.js";
import { applyInterpretation, createWebhookServer, type Interpretation } from "./webhook.js";
import { wakeOrHold } from "./wakes.js";
import { PrConversation, type ConversationAdapter } from "./pr-conversation.js";

// Partial<RecheckAdapter>: the recheck's two extra reads (compare, files) are a
// seam, not a requirement — a daemon wired without them simply never rechecks.
export type DaemonAdapter = DispatchAdapter &
  ReconcileAdapter &
  VerdictAdapter &
  Partial<RecheckAdapter> &
  Partial<CiAdapter> &
  Partial<ConversationAdapter>;

export interface DaemonDeps {
  cfg?: Config;
  root?: string;
  store?: StateStore;
  adapter?: DaemonAdapter;
  hooks?: SessionHooks;
  webhookSecret?: string;
  /** The round prompt renderer; default is the round order as JSON. The second
   * argument is the round's assembled memory seed — MEMORY_LESS
   * when nothing is wired or the store was unreachable. */
  renderPrompt?: (
    order: import("./types.js").RoundOrder,
    memory: import("./memory/context.js").RoundMemory,
  ) => string;
  /** The pinned head + budgeted context block seeded into each round prompt.
   * Absent ⇒ rounds render memory-less, which is a supported
   * state, not a failure. */
  memory?: import("./memory/context.js").RoundMemorySeed;
  /** The round's lesson selection (src/lessonselect.ts) — started per round
   * by dispatch, never awaited; under `[memory] delivery = "on"` awaited
   * beside the seed, and its `repoFacts` reach the
   * recheck nudge and the ping-pong wake. Absent ⇒ nothing runs. */
  lessons?: import("./lessonselect.js").RoundLessonHook;
  /** Told when a round's findings record lands (the lesson shadow ledger's
   * matcher). */
  onFindingsRecorded?: (target: { pr: number; roundNo: number; roundId: number | null }) => void;
  /** Renderer for the recheck nudge (prompts/round-recheck.md); default JSON. */
  renderRecheckPrompt?: (order: RecheckOrder) => string;
  /** Profile lens-heuristics extension: the selected repo profile's
   * extra per-lens selection predicates, loaded once at assembly by wire.ts.
   * Absent ⇒ dispatch selects with the compiled-in generic core alone. */
  heuristics?: import("./heuristics.js").HeuristicsExtension;
  /** The outcome capture's git read: did the code at a posted
   * finding's anchor change between two commits? wire.ts passes the
   * WorktreeManager (read-only git in the base clone). Absent ⇒ every such
   * question is unknown, and only the evidence that needs no git decides. */
  outcomeGit?: AnchorGit;
  /** Hand-resolved merge files between two shas (conflict resolutions are
   * never trivial). wire.ts passes the
   * WorktreeManager's git-level auto-merge comparison. */
  resolvedFilesInMerges?: (
    from: string,
    to: string,
    pr?: number,
  ) => Promise<{ files: string[]; degraded: boolean }>;
  /** Fetch head + base and materialise the worktree before the order is built
   * (wire.ts passes the real WorktreeManager). Absent ⇒ no git: the order
   * falls back to the PR row's sha with no base facts. */
  prepareWorktree?: (
    pr: number,
    baseRef: string,
  ) => Promise<{ head_sha: string; base_ref: string; base_sha: string; merge_base: string }>;
  /** The PR-owned change between two reviewed heads (follow-up rounds) —
   * wire.ts passes `WorktreeManager.prOwnedDelta`. Absent ⇒ every
   * later round is a full re-review. */
  prOwnedDelta?: import("./dispatch.js").DispatchDeps["prOwnedDelta"];
  /** Pin a reviewed head against gc — `WorktreeManager.pinReviewedHead`. */
  pinReviewedHead?: (pr: number, sha: string) => Promise<boolean>;
  /** Base-branch migration paths at a sha, for the collision pre-check.
   * Absent ⇒ no git: the pre-check is skipped and logged. */
  listBaseMigrations?: (baseSha: string) => Promise<string[]>;
  /** Unpack the third-party sources a PR touches and return the round's note
   * (src/depsources.ts; `[review] dependency_sources`). Absent ⇒ no note. */
  dependencySources?: (
    worktreePath: string,
    files: import("./github.js").PrFileEntry[],
  ) => Promise<string>;
  /** The profile-selected ecosystem seam, handed through to dispatch.
   * Absent ⇒ dispatch's own default (Django); wire.ts always passes the
   * profile's selection. */
  ecosystem?: import("./ecosystem.js").Ecosystem;
  /** Most recent human author of paths at a sha (the escalation mention
   * pick). Absent ⇒ no git: the config fallback mention is used. */
  directiveAuthor?: (
    sha: string,
    paths: string[],
  ) => Promise<{ login: string | null; name: string; email: string } | null>;
  log?: (msg: string, extra?: unknown) => void;
  /** Shared deterministic clock for dispatch, verdict and stage supervision. */
  now?: () => Date;
  /** Skip binding the HTTP port (tests). */
  listen?: boolean;
  /** Latest digest headline for status.json (src/digest.ts). */
  digestHeadline?: () => string | undefined;
  /** pi's session-JSONL root(s) for the passive auth-failure watch
   * (src/authwatch.ts) — production passes `piAuthWatchDirs` (wire.ts).
   * Absent (tests, stubs) ⇒ the watch never runs. */
  piSessionsDir?: string | readonly string[];
  /**
   * The supervised OpenViking server's heartbeat block. A cached,
   * synchronous read — wire.ts hands the supervisor's `status()` here. Absent
   * (tests, stub daemons) ⇒ status.json simply carries no `openviking` key,
   * and a throwing implementation is swallowed: the heartbeat must never fail
   * on the memory engine.
   */
  openvikingStatus?: () => import("./openviking/types.js").OpenVikingStatus | undefined;
  /**
   * Reviewer-memory health — the `memory` block of status.json, beside
   * `openviking`: wire.ts hands the health monitor's synchronous
   * `status()`. Absent ⇒ no `memory` key (readers say "not reported"); a
   * throwing implementation is swallowed like the openviking read.
   */
  memoryStatus?: () => import("./memory/health.js").MemoryStatus | undefined;
  /**
   * The closed-PR archiver's block (src/archive/status.ts) — a cached,
   * synchronous read: wire.ts hands the archiver's `status()`.
   * Absent ⇒ no `archive` key (readers say "not reported"); a throwing
   * implementation is swallowed like the other blocks.
   */
  archiveStatus?: () => import("./archive/status.js").ArchiveStatus | undefined;
  /**
   * Seams of the daemon's event-loop watch (src/eventloop.ts):
   * the sampler, the cpu.stat reader, the clock and the evaluation timer.
   * Absent ⇒ the real drift sampler and /sys/fs/cgroup/cpu.stat. The watch
   * itself is always built — it is the daemon measuring itself, not a feature.
   */
  eventLoop?: Partial<
    Pick<
      DaemonLoadMonitorDeps,
      | "sampler"
      | "readCpuStat"
      | "cpuStatPath"
      | "now"
      | "evaluateEveryMs"
      | "setTimer"
      | "clearTimer"
    >
  >;
  /**
   * Slack announcer, resolved lazily: wire.ts builds the Slack
   * subsystem in `onStart`, i.e. after the store exists and after this deps
   * object was assembled, so the seam is a getter rather than a value. Absent
   * ⇒ no announcer is ever passed to dispatch or the verdict watcher.
   */
  announce?: () => (DispatchAnnouncer & VerdictAnnouncer) | undefined;
  /** The [feedback] tuning-loop sink — wire.ts hands the
   * FeedbackEngine's ingest here. Absent (tests, stub daemons) ⇒ signals are
   * interpreted but go nowhere. */
  onFeedback?: (e: FeedbackEvent) => Promise<void> | void;
  /** Extra periodic work (EOD timer arm, command watcher, overseer rotation)
   * started after the core loops; wired by src/wire.ts. */
  onStart?: (daemon: Daemon) => Promise<void> | void;
  onStop?: () => Promise<void> | void;
}

// Sub-poll cadences (seconds). The authoritative reconcile interval is
// config.daemon.poll_interval_s; these are cheap local ticks.
const DISPATCH_TICK_S = 15;
const VERDICT_SWEEP_S = 10;
const DEADLINE_TICK_S = 60;
const STATUS_TICK_S = 30;
const AUTHWATCH_TICK_S = 60;
/** A reconcile pass running this many poll intervals is abandoned (logged as
 * the quiet anomaly `reconcile_pass_overdue`) and the next one starts. */
export const RECONCILE_OVERDUE_INTERVALS = 3;

export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcile(): Promise<void>;
  pump(): Promise<void>;
  /** Deterministic review-failure retry tick: claim due debt, then hand it to
   * the one pump. */
  retryDueReviewFailures(): Promise<number>;
  /** Public deterministic scan seam; the periodic loop calls the same object. */
  scanRoundStages(): Promise<void>;
  wakeThreadDecisions(): void;
  retryThreadDecision(commentId: number): { ok: boolean; reason?: string; file?: string };
  readonly store: StateStore;
  readonly cfg: Config;
  /** The outcome capture the reconcile pass drives — handed to the
   * finding-case writer (wire.ts), which reads its tables and
   * runs its capture for the PRs its backfill covers. */
  readonly outcomes: OutcomeCapture;
  /** The daemon's event-loop watch — its status() is
   * status.json `daemon`. */
  readonly load: DaemonLoadMonitor;
  /** When the first reconcile pass that completed healthily (no step error)
   * ended; null before one has. The archiver starts no work before
   * it plus its own delay — never on the boot pass. */
  firstHealthyReconcileAt(): Date | null;
}

function readWebhookSecret(cfg: Config): string {
  return readFileSync(join(cfg.github.secrets_dir, "webhook_secret"), "utf8").trim();
}

/** The real adapter: token minter → mutation gate (dry-run aware) → adapter. */
function buildGitHubAdapter(cfg: Config, stateDir: string): GitHubAdapter {
  const minter = new TokenMinter(cfg.github.secrets_dir);
  const gate: MutationGate = new MutationGate(
    cfg.dry_run,
    join(stateDir, "dryrun"),
    (intent: MutationIntent): Promise<unknown> => github.executeMutation(intent),
  );
  const github: GitHubAdapter = new GitHubAdapter(cfg, minter, gate);
  return github;
}

/** A wake with its repo facts appended — the wake itself, byte for byte,
 * when there are none. */
export function withRepoFacts(wake: string, facts: string): string {
  return facts ? `${wake.replace(/\s+$/, "")}${facts}` : wake;
}

/** What serving an author's reply in a bot thread needs (ping-pong). */
export interface AuthorReplyDeps {
  store: StateStore;
  pingpong: PingPongLedger;
  inject: (pr: number, message: string) => Promise<void>;
  /** The sandbox root: the wake names the PR's worktree under it. */
  root: string;
  log: (msg: string, extra?: unknown) => void;
  /** The repo-fact lessons for the replied thread's file,
   * rendered — "" unless `[memory] delivery = "on"`. Must not reject (the
   * daemon's `repoFactsFor` is total). Absent ⇒ none asked. */
  repoFacts?: (q: RepoFactsQuery) => Promise<string>;
}

/**
 * Serve one author reply in a bot thread: claim it, then wake the PR's
 * session (held while its round is in flight). The webhook interpretation
 * guarantees a same-PR bot-owned root; the claim comes before the wake so a
 * duplicate delivery cannot produce duplicate replies or resolutions.
 */
export async function serveAuthorReply(
  deps: AuthorReplyDeps,
  reply: Extract<Interpretation, { kind: "author_reply" }>,
): Promise<void> {
  const { store, pingpong, log } = deps;
  if (reply.in_reply_to_id === null) return;
  // Deploy-window drain: no ping-pong wake while draining — and the
  // claim is deliberately not taken, so a redelivery after the lift
  // can still service the reply. Belt-and-braces in practice: while
  // draining the webhook drops the delivery before it reaches here.
  if (store.drainState().draining) {
    log(`pingpong: #${reply.pr} reply dropped — draining`);
    return;
  }
  const event: AuthorReplyEvent = {
    pr: reply.pr,
    comment_id: reply.comment_id,
    in_reply_to_id: reply.in_reply_to_id,
    body: reply.body,
    author: reply.author,
  };
  // The repo facts for the replied thread's file — "" unless
  // `[memory] delivery = "on"`, so the wake is otherwise byte-identical.
  // The path rides the interpretation only, never the event: the wake's
  // own text does not change. Read before the claim, so the claim is
  // still followed at once by its wake — a claimed message has no sweep
  // to recover it.
  let facts = "";
  if (deps.repoFacts && reply.path) {
    const before = store.getPr(reply.pr);
    facts = await deps.repoFacts({
      pr: reply.pr,
      title: before?.title ?? "",
      paths: [reply.path],
      head_sha: before?.head_sha ?? null,
      purpose: "pingpong",
    });
    if (typeof facts !== "string") facts = "";
    // That read can take the lesson budget (≤ 2 s): a drain the operator
    // started meanwhile still stops the wake, the claim still not taken.
    if (store.drainState().draining) {
      log(`pingpong: #${reply.pr} reply dropped — draining`);
      return;
    }
  }
  if (!pingpong.claimAuthorMessage(event)) return;
  const row = store.getPr(reply.pr);
  // The PR's one main pi never gets a second instruction while its round
  // is in flight — the wake is held and flushed at round end (rule 9).
  const disposition = await wakeOrHold(
    { store, inject: deps.inject, log },
    reply.pr,
    withRepoFacts(
      buildWakeMessage(
        event,
        {
          head_sha: row?.head_sha,
          worktree: join(deps.root, "wt", `pr-${reply.pr}`),
        },
        pingpong.discipline(reply.in_reply_to_id),
      ),
      facts,
    ),
    "author_reply",
    // The message is already claimed: a failed injection must hold
    // the wake, or no redelivery can ever answer it.
    { holdOnFailure: true },
  );
  if (disposition === "held")
    log(`pingpong: #${reply.pr} reply held — round in flight, backlog or failed inject`);
}

export function createDaemon(deps: DaemonDeps = {}): Daemon {
  const cfg = deps.cfg ?? loadConfig();
  const root = deps.root ?? sandboxRoot();
  const stateDir = join(root, "state");
  const log =
    deps.log ?? ((msg: string, extra?: unknown) => console.log(`[quickreviewd] ${msg}`, extra ?? ""));
  const store = deps.store ?? new StateStore(join(stateDir, "state.db"));
  const hooks = deps.hooks ?? stubSessionHooks(root, log);
  const roundStageBounds = {
    first_pass_max_min: cfg.daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN,
    passes_max_min: cfg.daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN,
    running_max_min:
      cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
    follow_up_sweep_extra_min:
      cfg.daemon.follow_up_sweep_extra_min ?? DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN,
  };

  // Overseer wake policy: every logAnomaly flows through the one
  // severity map + dedup; WAKE classes write an overseer inject, QUIET classes
  // stay DB-only. Wired here so stub-wired daemons behave identically.
  const wakePolicy = new AnomalyWakePolicy({ injectOverseer: (m) => hooks.injectOverseer(m), log });
  store.setAnomalySink((signal) => wakePolicy.onAnomaly(signal));

  const gh: DaemonAdapter = deps.adapter ?? buildGitHubAdapter(cfg, stateDir);

  // The daemon measures its own event loop and the container's CPU
  // throttling. A stall wakes through the one anomaly funnel (WAKE kind
  // `daemon_event_loop_stalled`), rate-limited by the watch's cooldown.
  const load = new DaemonLoadMonitor({
    policy: eventLoopPolicy(cfg.daemon),
    raise: (detail, message) => store.logAnomaly(EVENT_LOOP_WAKE_KIND, null, null, detail, message),
    log,
    ...deps.eventLoop,
  });

  // The lazy announcer seam: a thin forwarder so the verdict watcher (built
  // once, here) reaches whatever wire.ts assembles later — and swallows the
  // gap before it exists. Absent `deps.announce` ⇒ undefined, i.e. no Slack.
  const resolveAnnounce = deps.announce;
  const announce: (DispatchAnnouncer & VerdictAnnouncer) | undefined = resolveAnnounce
    ? {
        roundStarted: async (a) => void (await resolveAnnounce()?.roundStarted(a)),
        verdict: async (a) => void (await resolveAnnounce()?.verdict(a)),
        anomaly: async (a) => void (await resolveAnnounce()?.anomaly(a)),
        superseded: async (a) => void (await resolveAnnounce()?.superseded(a)),
      }
    : undefined;

  const verdictDir = join(root, "verdict");
  const verdicts = new VerdictWatcher({
    cfg,
    store,
    adapter: gh,
    hooks,
    announce,
    verdictDir,
    root, // anchors the default pi-session dir for round usage measurement
    ...(deps.now ? { now: deps.now } : {}),
    // The durable reasoning record — same dir the round prompts pin.
    findingsDir: join(root, "state", "findings"),
    // The lesson shadow ledger marks the round's posted findings.
    ...(deps.onFindingsRecorded ? { onFindingsRecorded: deps.onFindingsRecorded } : {}),
    log,
  });
  const roundStages = new SessionCommandSupervisor({
    cfg,
    store,
    hooks,
    verdictDir,
    progress: (pr) => {
      try {
        return parseRoundProgress(
          readFileSync(join(stateDir, "round-progress", `pr-${pr}.json`), "utf8"),
        );
      } catch {
        return undefined;
      }
    },
    onRoundFailure: (pr, roundNo, stage, detail) =>
      verdicts.recoverInfrastructureFailure(pr, roundNo, stage, detail),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const prConversation = new PrConversation({
    store,
    adapter: gh,
    verdictDir,
    botLogin: cfg.github.bot_login,
    inject: (pr, message) => hooks.inject(pr, message),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const pingpong = new PingPongLedger(store.db);
  const threadDecisions = new ThreadDecisionWatcher({
    adapter: gh as GitHubAdapter,
    store,
    ledger: pingpong,
    verdictDir,
    log,
    isDraining: () => store.drainState().draining,
    botLogin: cfg.github.bot_login,
    ownerActorAlias:
      cfg.github.bot_login === `${cfg.github.app_slug}[bot]` ? cfg.github.app_slug : undefined,
    // The author asked for a person on a review thread.
    //
    // There is no park to put them in: the state event is a deliberate no-op
    // (`statemachine.ts`: "noted, never a handover — AI keeps working") and no
    // reviewer is ever nominated on GitHub (rule 10). The signal is recorded,
    // durably and visibly, and it is never a handover. `logAnomaly` is the one
    // durable funnel; the kind is deliberately unlisted in `anomalies.ts`
    // WAKE_KINDS, so it is quiet-tier — it lands in the DB, surfaces in the
    // operator views and in the overseer's daily heartbeat, and never injects.
    // An author asking for a person is worth a human's eyes; it is not a
    // review that ran unsoundly now.
    onHumanRequested: async (decision) => {
      applyEvent(
        store,
        decision.pr,
        { type: "human_requested" },
        {},
        {
          botLogin: cfg.github.bot_login,
          reason: "pingpong:human-requested",
        },
      );
      store.logAnomaly(
        "human_requested",
        decision.pr,
        null,
        `the author asked for a person on thread ${decision.thread_id} (comment ${decision.comment_id})` +
          `${decision.reason ? ` — ${decision.reason}` : ""}. No handover exists: the reviewer keeps driving.`,
      );
    },
  });

  // The repo-fact lessons a recheck nudge and a ping-pong wake
  // carry for the paths they touch. Total — the hook is bounded by the lesson
  // prefetch's budget, and a throw is "" — so neither wake is ever held or
  // lost for it.
  const repoFactsFor = async (q: RepoFactsQuery): Promise<string> => {
    try {
      const s = await deps.lessons?.repoFacts?.(q);
      return typeof s === "string" ? s : "";
    } catch (err) {
      log(`lessons: #${q.pr} ${q.purpose} repo facts failed (ignored)`, err);
      return "";
    }
  };

  // The post-approval delta recheck. Three of its four triggers are
  // wired below; the fourth — an author reply — is owned by ping-pong above and
  // deliberately never reaches this path.
  const recheckDeps: RecheckDeps = {
    cfg,
    store,
    adapter: gh,
    inject: (pr, message) => hooks.inject(pr, message),
    ...(deps.renderRecheckPrompt ? { renderPrompt: deps.renderRecheckPrompt } : {}),
    ...(deps.resolvedFilesInMerges ? { resolvedFilesInMerges: deps.resolvedFilesInMerges } : {}),
    // The repo facts for the delta's files — "" unless
    // `[memory] delivery = "on"`, so the nudge is otherwise byte-identical.
    ...(deps.lessons?.repoFacts
      ? { repoFacts: (q: Parameters<NonNullable<RecheckDeps["repoFacts"]>>[0]) => repoFactsFor(q) }
      : {}),
    log,
  };
  const rechecks = new RecheckWatcher({
    cfg,
    store,
    verdictDir,
    findingsDir: join(root, "state", "findings"),
    log,
    // Ledger freshness after a recheck uphold — same enforcement the
    // VerdictWatcher runs at round end, keyed by head (no round in flight).
    checkLedger: async (pr, headSha) => {
      await enforceLedgerFreshness(
        {
          store,
          ledgerPathFor: (n) => join(root, "state", "ledgers", `pr-${n}.md`),
          inject: (n, message) => hooks.inject(n, message),
          log,
        },
        { pr, roundNo: null, headSha },
      );
    },
  });

  // The withheld-approval retry — same `ci_completed` event, opposite
  // direction: the recheck above asks whether a standing approval must fall,
  // this asks whether a withheld one can finally be given.
  const ciDeps: WithheldRetryDeps = { cfg, store, adapter: gh, log };

  const timers: NodeJS.Timeout[] = [];
  let server: ReturnType<typeof createWebhookServer> | null = null;
  let stopping = false;

  const onInterpretation = async (i: Interpretation): Promise<void> => {
    await applyInterpretation(
      {
        cfg,
        store,
        onPrTouched: async () => {
          await pump();
        },
        onAuthorPrComment: async (comment) => {
          await prConversation.accept(comment);
        },
        onAuthorReply: async (reply) => {
          await serveAuthorReply(
            {
              store,
              pingpong,
              inject: (pr, message) => hooks.inject(pr, message),
              root,
              log,
              ...(deps.lessons?.repoFacts ? { repoFacts: repoFactsFor } : {}),
            },
            reply,
          );
        },
        onClosed: async (pr) => {
          await hooks.archiveAndClose(pr);
        },
        // A push after an approve: the recheck audits the new delta.
        onSynchronize: async (sync) => {
          await guard(`recheck #${sync.pr}`, () =>
            runRecheck(recheckDeps, { pr: sync.pr, trigger: "push", head_sha: sync.meta.head_sha }),
          );
        },
        onCiCompleted: async (ci) => {
          for (const pr of ci.prs) {
            await guard(`recheck #${pr}`, () =>
              runRecheck(recheckDeps, {
                pr,
                trigger: "ci",
                head_sha: ci.head_sha,
                ci: { conclusion: ci.conclusion },
              }),
            );
            // The other side of the same event. A PR whose approval
            // was withheld for red CI is re-queued the moment CI goes green at
            // that head — without this the gate turns every infra flake into a
            // permanently stuck PR.
            await guard(`approval retry #${pr}`, async () => {
              const outcome = await retryWithheldApproval(ciDeps, {
                pr,
                head_sha: ci.head_sha,
                conclusion: ci.conclusion,
              });
              if (outcome.action === "requeued") await pump();
            });
          }
        },
        onBaseAdvanced: async (advance) => {
          await guard(`recheck base ${advance.branch}`, () =>
            runBaseAdvance(recheckDeps, {
              branch: advance.branch,
              before: advance.before,
              after: advance.after,
            }),
          );
        },
        // Forward tuning-loop signals to the engine. A review set
        // aside right after a head push is GitHub's own stale-review sweep,
        // classified here (the store holds the push clock), not a human verdict.
        onFeedbackSignal: async (e) => {
          if (!deps.onFeedback) return;
          await guard(`feedback #${e.pr}`, async () => {
            if (e.kind === "review_set_aside") {
              const lastPush = store.lastEventAt("head_push", e.pr);
              const stale =
                lastPush !== undefined &&
                Date.now() - Date.parse(lastPush) < REVIEW_SET_ASIDE_STALE_WINDOW_MS;
              await deps.onFeedback!({ ...e, stale });
            } else {
              await deps.onFeedback!(e);
            }
          });
        },
      },
      i,
    );
  };

  const guard = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log(`${what} failed`, err);
      store.logEvent("daemon_error", null, { what, error: String(err) });
    }
  };

  // Outcome capture: what became of every posted finding. It reads only
  // (state.db, the base clone) and rides the reconcile pass.
  const outcomes = new OutcomeCapture({
    store,
    botLogin: cfg.github.bot_login,
    ...(deps.outcomeGit ? { git: deps.outcomeGit } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    log,
  });

  let firstReconcileSeen = false;
  let firstHealthyReconcileAt: Date | null = null;
  // Deploy-window drain auto-lift: only the boot's first reconcile pass may
  // lift the drain, and only when it completed healthily — reconcileOnce
  // resolved and its per-step `report.errors` is empty. A failed first pass
  // leaves the drain standing for the rest of this boot (a broken deploy must
  // not resume work blind); clearing it then takes an explicit `drain off`.
  // In a multi-deploy window each healthy boot lifts the drain, so the
  // operator re-drains before each step.
  //
  // One reconcile pass at a time: an overlapping pass would pay every step
  // again. A tick that finds a pass running is skipped; an explicit call
  // waits for it and then runs its own pass.
  //
  // The guard is bounded: it covers reconcileOnce and the drain lift only —
  // the conversation sweep and the dispatch pump run after it is released,
  // each behind its own lock — and a pass still running after
  // RECONCILE_OVERDUE_INTERVALS poll intervals is abandoned, so one hung await
  // can never stop every later pass (and with them the backstop and the
  // undelivered-recheck sweep).
  const reconcileFlight = new SingleFlight({
    overdueMs: () => RECONCILE_OVERDUE_INTERVALS * cfg.daemon.poll_interval_s * 1000,
    onOverdue: (ageMs) => {
      const detail =
        `a reconcile pass has run ${Math.round(ageMs / 1000)} s ` +
        `(over ${RECONCILE_OVERDUE_INTERVALS} poll intervals of ${cfg.daemon.poll_interval_s} s) ` +
        `without settling — no longer waited for; the next pass starts beside it`;
      log(`reconcile: ${detail}`);
      store.logAnomaly("reconcile_pass_overdue", null, null, detail);
    },
  });
  const reconcile = async (): Promise<void> => {
    if (!(await reconcileFlight.run(reconcilePass))) return;
    // Outside the single-flight: both have their own locks (PrConversation's
    // `busy`, dispatch's per-store active pump), and a pump that hangs on a
    // worktree fetch must not hold the next reconcile pass back.
    await guard("reconcile", async () => {
      await prConversation.sweep();
      await pump();
    });
  };
  const reconcileTick = (): void => {
    if (reconcileFlight.running()) {
      log("reconcile: the previous pass is still running — this tick skipped");
      return;
    }
    void reconcile();
  };
  /** The guarded part of a pass; true when it completed (the follow-ups run
   * only then). */
  const reconcilePass = async (): Promise<boolean> => {
    const bootFirstPass = !firstReconcileSeen;
    firstReconcileSeen = true;
    let completed = false;
    await guard("reconcile", async () => {
      const report = await reconcileOnce({
        cfg,
        store,
        adapter: gh,
        hooks,
        log,
        // Push-trigger backstop: same runRecheck the webhook's onSynchronize
        // calls, so a dead/lost webhook never leaves a post-review push
        // unexamined.
        onHeadPush: async (pr, head_sha) => {
          await guard(`recheck #${pr}`, () =>
            runRecheck(recheckDeps, { pr, trigger: "push", head_sha }),
          );
        },
        // Feedback backstop: merged-over-block for closes the webhook missed.
        onMergedOverBlock: async (pr) => {
          await guard(`feedback #${pr}`, async () =>
            deps.onFeedback?.({ kind: "merged_over_block", pr }),
          );
        },
        outcomes,
        // The boot's first pass lifts a deploy drain; the undelivered-recheck
        // sweep reads session transcripts and is not needed for that, so it
        // starts on the next pass to keep the boot pass short.
        receiptSweep: !bootFirstPass,
      });
      log(
        `reconcile: open=${report.open_prs} triggered=${report.triggered.length} ` +
          `closed=${report.closed.length} captured=${report.captured_comments} ` +
          `corrections=${report.corrections} errors=${report.errors.length}`,
      );
      if (report.errors.length === 0 && firstHealthyReconcileAt === null)
        firstHealthyReconcileAt = deps.now ? deps.now() : new Date();
      if (bootFirstPass && report.errors.length === 0 && store.drainState().draining) {
        // The operator's lift: this is the deploy flow's drain completing, so
        // it clears whatever hold stands — a session's included.
        const { dropped } = store.liftDrain("operator");
        store.logEvent("drain_lifted", null, { dropped_deliveries: dropped });
        log(
          `drain_lifted — first reconcile pass healthy; ${dropped} webhook delivery(ies) were dropped while draining`,
        );
        threadDecisions.requestSweep();
      }
      completed = true;
    });
    return completed;
  };

  const pump = async (): Promise<void> => {
    await guard("dispatch", async () => {
      // Session levers that lapsed since the last tick leave the ledger here;
      // the readers below already treat them as gone.
      sweepExpiredLevers(store, (line) => log(line));
      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: gh,
        hooks,
        renderPrompt: (order, memory) =>
          (deps.renderPrompt ? deps.renderPrompt(order, memory) : JSON.stringify(order, null, 2)) +
          prConversation.context(order.pr),
        ...(deps.memory ? { memory: deps.memory } : {}),
        ...(deps.lessons ? { lessons: deps.lessons } : {}),
        ...(deps.ecosystem ? { ecosystem: deps.ecosystem } : {}),
        ...(deps.heuristics ? { heuristics: deps.heuristics } : {}),
        // Every round order re-hands the PR's ledger, read
        // from ledger-pin's mirror — the same file the freshness check reads.
        // Total: no file, an unreadable one or another PR's ⇒ no carry.
        ledgerCarry: (n) => readLedgerCarry(join(root, "state", "ledgers", `pr-${n}.md`), n),
        prepareWorktree: deps.prepareWorktree,
        ...(deps.prOwnedDelta ? { prOwnedDelta: deps.prOwnedDelta } : {}),
        ...(deps.pinReviewedHead ? { pinReviewedHead: deps.pinReviewedHead } : {}),
        findingsDir: join(root, "state", "findings"),
        listBaseMigrations: deps.listBaseMigrations,
        ...(deps.dependencySources ? { dependencySources: deps.dependencySources } : {}),
        directiveAuthor: deps.directiveAuthor,
        resolvedFilesInMerges: deps.resolvedFilesInMerges,
        announce,
        log,
        ...(deps.now ? { now: deps.now } : {}),
      });
      for (const o of orders)
        log(
          `dispatched #${o.pr} round ${o.round_no} (${o.round_type}) lenses=${o.lenses.join(",")}`,
        );
    });
  };

  const retryDueReviewFailures = async (): Promise<number> => {
    // This transition only republishes ordinary queued debt; the one dispatch
    // pump below remains the sole round and pi-command creator.
    const automaticRetries = store.activateDueReviewFailureRetries(store.currentTimeIso());
    if (automaticRetries.length > 0) {
      for (const retry of automaticRetries) {
        log(
          `automatic pre-fanout retry: #${retry.pr} round ${retry.target_round_no} epoch ${retry.retry_epoch} @ ${retry.target_head_sha.slice(0, 7)}`,
        );
      }
      await pump();
    }
    return automaticRetries.length;
  };

  // Passive pi auth-failure watch: no smoke calls, just the session JSONLs pi
  // already writes. A detection is a wake-grade anomaly
  // (10-min dedup via the sink) and a status.json flag the TUI alerts on.
  const piAuthWatch = deps.piSessionsDir ? new PiAuthWatch(deps.piSessionsDir) : undefined;
  const authWatchTick = (): void => {
    if (!piAuthWatch) return;
    try {
      const hits = piAuthWatch.scan();
      if (hits.length > 0) {
        const files = hits.map((h) => h.file.split("/").pop()).join(", ");
        store.logAnomaly(
          "pi_auth_expired",
          null,
          null,
          `pi API auth failures (token expired) in ${hits.length} session file(s): ${files}`,
          [
            "PI AUTH EXPIRED — sessions are failing API calls with token-expired errors.",
            `Fresh hits in: ${files}`,
            "Every round in flight will wedge until a human re-runs /login in the container (interactive OAuth — the daemon cannot do it).",
          ].join("\n"),
        );
        log(`authwatch: pi token-expired errors in ${hits.length} session file(s)`, files);
        writeStatus();
      }
    } catch (err) {
      log("authwatch failed", err);
    }
  };

  const writeStatus = (): void => {
    // Fail-soft twice over: reading the OpenViking block can never abort the
    // heartbeat (its own try/catch), and the write itself is guarded as before.
    let openviking: import("./openviking/types.js").OpenVikingStatus | undefined;
    try {
      openviking = deps.openvikingStatus?.();
    } catch (err) {
      log("openviking status read failed (heartbeat continues)", err);
    }
    let memory: import("./memory/health.js").MemoryStatus | undefined;
    try {
      memory = deps.memoryStatus?.();
    } catch (err) {
      log("memory health read failed (heartbeat continues)", err);
    }
    let daemonLoad: DaemonLoadStatus | undefined;
    try {
      daemonLoad = load.status();
    } catch (err) {
      log("event-loop watch read failed (heartbeat continues)", err);
    }
    let archive: import("./archive/status.js").ArchiveStatus | undefined;
    try {
      archive = deps.archiveStatus?.();
    } catch (err) {
      log("archive status read failed (heartbeat continues)", err);
    }
    try {
      writeStatusJson(
        stateDir,
        buildStatusSnapshot(
          store,
          cfg.dry_run,
          deps.digestHeadline?.(),
          undefined,
          cfg.daemon.max_concurrent_rounds,
          piAuthWatch?.status(),
          openviking,
          threadDecisions.status(),
          roundStages.health(),
          roundStageBounds,
          memory,
          daemonLoad,
          archive,
        ),
      );
    } catch (err) {
      log("status.json write failed", err);
    }
  };

  const every = (seconds: number, fn: () => void): void => {
    const t = setInterval(fn, seconds * 1000);
    t.unref?.();
    timers.push(t);
  };

  return {
    store,
    cfg,
    outcomes,
    load,
    firstHealthyReconcileAt: () => firstHealthyReconcileAt,
    reconcile,
    pump,
    retryDueReviewFailures,
    scanRoundStages: () => roundStages.scan(),
    wakeThreadDecisions: () => threadDecisions.requestSweep(),
    retryThreadDecision: (commentId) => threadDecisions.retryFailed(commentId),

    async start(): Promise<void> {
      log(`starting — ${cfg.dry_run ? "DRY-RUN" : "LIVE"} — repo ${cfg.github.repo}`);
      store.logEvent("daemon_start", null, { dry_run: cfg.dry_run, port: cfg.server.port });
      // First, so a boot that holds the loop is measured too.
      load.start();

      if (deps.listen !== false) {
        const secret = deps.webhookSecret ?? readWebhookSecret(cfg);
        server = createWebhookServer({
          cfg,
          store,
          secret,
          onInterpretation,
          // Only the pipeline block — never the whole snapshot (every PR,
          // every round) on each probe: `/health` is what a stalled loop is
          // measured by, so it must cost almost nothing itself.
          pipelineHealth: () => buildPipelineStatus(store, new Date(), roundStages.health()),
          log,
        });
        // Loopback by default; in the container the daemon must bind 0.0.0.0
        // (docker's published port targets the container's eth0, and the
        // host-side binding is already 127.0.0.1-only).
        const bindHost = process.env.QC_BIND_HOST ?? "127.0.0.1";
        await new Promise<void>((resolve) => server!.listen(cfg.server.port, bindHost, resolve));
        log(`webhook listening on ${bindHost}:${cfg.server.port}/webhook`);
      }

      verdicts.start();
      threadDecisions.start();
      rechecks.start();
      writeStatus();
      // Start the correctness scan without holding daemon startup. If it
      // hangs, its attempt lease ages while status.json keeps advancing and
      // the pipeline reports unhealthy rather than blocking the process.
      void guard("round stage supervisor", async () => {
        try {
          await roundStages.scan();
        } finally {
          writeStatus();
        }
      });
      // onStart before the first reconcile: the sweep can nudge a recheck at a
      // dead session immediately (boot after a deploy restart), and the
      // respawn path needs the title resolver wired in onStart.
      //
      // Fatal, not guarded: onStart assembles the command watchers, the EOD
      // timer and the Slack concierge, and refuses loudly on what must not
      // run half-built (Slack auth.test, a malformed profile pack). Swallowing
      // the throw would leave a daemon that reviews PRs while serving no
      // overseer or operator command and running no sweep. The caller
      // (wire.ts main) stops and exits non-zero; the container restart is the
      // retry.
      if (deps.onStart) {
        // A real event-loop turn between the first status write and the
        // assembly: each is tens of ms of synchronous work, and back to back
        // (with any of onStart's calls answering without real I/O) they would
        // be one uninterrupted span of the boot.
        await yieldToLoop();
        try {
          await deps.onStart(this);
        } catch (err) {
          log("onStart failed — refusing to run a half-assembled daemon", err);
          store.logEvent("daemon_error", null, {
            what: "onStart",
            error: String(err),
            fatal: true,
          });
          throw err;
        }
      }
      // The periodic timers go in BEFORE the boot's first reconcile is
      // awaited: that pass, and the dispatch pump it runs after, can hang on
      // an await with no deadline of its own (a worktree fetch), and a boot
      // left waiting there would install no later reconcile, no recovery scan
      // and no status heartbeat. A tick that finds the boot pass still
      // running is skipped like any other overlap.
      every(cfg.daemon.poll_interval_s, reconcileTick);
      every(DISPATCH_TICK_S, () => void pump());
      every(
        VERDICT_SWEEP_S,
        () =>
          void guard("verdict sweep", async () => {
            await verdicts.sweep();
            await threadDecisions.sweep();
            await prConversation.sweep();
            await rechecks.sweep();
          }),
      );
      every(DEADLINE_TICK_S, () => {
        void guard("round stage supervisor", async () => {
          try {
            await roundStages.scan();
          } finally {
            writeStatus();
          }
        });
        void guard("deadline check", async () => {
          await verdicts.checkDeadlines();
          // A safe pre-fanout exhaustion is a circuit breaker, not an inert
          // operator park.
          await retryDueReviewFailures();
          // Zombie-round expiry: rounds stuck `overdue` past the
          // horizon whose PR has since verdicted/closed become terminal
          // `expired`. Rounds a rerun could still service are left standing.
          if (cfg.daemon.expire_overdue_after_h > 0) {
            const expired = store.expireOverdueRounds(cfg.daemon.expire_overdue_after_h);
            if (expired.length > 0)
              log(`expired ${expired.length} zombie round(s): ids ${expired.join(",")}`);
          }
          // Stranded rounds: the ones the sweep above deliberately leaves —
          // overdue, but the PR is still open and still undecided, so "a rerun
          // could service it". Nothing reruns an overdue round on its own, so
          // past a week it is abandoned: terminalize it and say so. One anomaly
          // per round, once, because the row stops being overdue the moment it
          // is reported.
          for (const r of store.expireStrandedRounds()) {
            store.logAnomaly(
              "round_stranded",
              r.pr,
              r.round_no,
              `round ${r.round_no} has sat overdue since ${r.deadline_at} with nothing to rescue it — closed as expired`,
              [
                `STRANDED ROUND — PR #${r.pr} round ${r.round_no}`,
                `Overdue since ${r.deadline_at}; its PR was still open and undecided, so the zombie sweep kept skipping it. Nothing reruns an overdue round, so it would have sat there indefinitely.`,
                "The round row is now closed (expired). Its spend still counts. GitHub was NOT touched and the PR was NOT requeued — decide whether this PR still needs a review, and if so trigger one (commands/rerun-round).",
              ].join("\n"),
            );
            log(
              `stranded round closed: #${r.pr} round ${r.round_no} (overdue since ${r.deadline_at})`,
            );
          }
        });
      });
      every(STATUS_TICK_S, writeStatus);
      if (piAuthWatch) every(AUTHWATCH_TICK_S, authWatchTick);

      await reconcile();
    },

    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      log("stopping");
      if (deps.onStop) await guard("onStop", async () => deps.onStop!());
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      load.stop();
      verdicts.stop();
      threadDecisions.stop();
      rechecks.stop();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      writeStatus();
      store.logEvent("daemon_stop", null, {});
      if (!deps.store) store.close();
    },
  };
}

// No process entrypoint here, deliberately. An entrypoint in this module
// would build a real MutationGate against the real config without installing
// the posting guards or the CI gate. `src/wire.ts` is the production assembly
// and the only entrypoint that builds a live gate; it installs the guards
// before it starts. This module stays the stub-wired, test-friendly core.
// Pinned by `tests/fences-gate.test.ts`.
