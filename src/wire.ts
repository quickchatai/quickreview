// Production assembly of quickreviewd: createDaemon() with the real pi session
// manager, the round-template renderer, the agents build step, the EOD timer,
// the overseer command executor, and the weekly overseer rotation. `npm run
// daemon` runs this; createDaemon() alone (src/daemon.ts) stays the
// stub-wired, test-friendly core.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fsSecretReader,
  ingressHostnameFile,
  liveConfigPath,
  loadConfig,
  openVikingBaseUrl,
  sandboxRoot,
  slackTokenPath,
  validateSlackConfig,
  type Config,
  type SecretReader,
} from "./config.js";
import { CommandWatcher, processOperatorSeal, type CommandDeps } from "./commands.js";
import { drainLever, pauseLever, resumeLever, type LeverDeps } from "./levers.js";
import { CaseWriter } from "./cases.js";
import { Archiver } from "./archive/archiver.js";
import { piGlobalSessionsDir } from "./archive/piglobal.js";
import { pendingArchiveStatus } from "./archive/status.js";
import { Learner, learnerKnobsOf } from "./learner/learner.js";
import { renderNoPacketSection } from "./learner/packet.js";
import type { CurationReceipt } from "./learner/receipt.js";
import { LessonLedger } from "./lessonledger.js";
import { RoundLessonSelector, type RoundLessonHook } from "./lessonselect.js";
import { lessonDeliveryStatus, markRound } from "./lessonshadow.js";
import { RoundMemoryActivity } from "./memory/roundactivity.js";
import type { LessonDeliveryStatus } from "./memory/shadowstatus.js";
import { lessonFindClient, openVikingLessonEngine } from "./openviking/lessonfind.js";
import { createDaemon, type Daemon } from "./daemon.js";
import { reviewsInFlight } from "./dispatch.js";
import { eventLoopPolicy } from "./eventloop.js";
import { digestWritten, eodDigestContext, latestDigestHeadline } from "./digest.js";
import { startHeartbeat, type HeartbeatTimer } from "./anomalies.js";
import { opsDay, promptReader, startEodTimer, type EodTimer } from "./eod.js";
import { MutationGate, type MutationIntent } from "./gate.js";
import { GitHubAdapter } from "./github.js";
import { priorSidecarPath } from "./priorfindings.js";
import { resolveVerifiedPriorThreads } from "./priorresolve.js";
import { makePostingGuard } from "./guards.js";
import { classifyCi, ciBlocksApproval } from "./cigate.js";
import { TokenMinter } from "./githubAuth.js";
import {
  FeedbackEngine,
  FeedbackMemoryPump,
  dayScopedRebuild,
  feedbackDayAddendum,
  ledgerFeedbackSignal,
  type FeedbackEvent,
} from "./feedback.js";
import {
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
  lessonAddendaFor,
  identityVars,
  passTierModels,
  sweepLightVariants,
} from "./include.js";
import { ecosystemFor } from "./ecosystem.js";
import { applyProfileTuning, lensModelOverrides, lensTuningAddenda } from "./lenstuning.js";
import {
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  loadProfileLensTuning,
  loadProfilePosting,
} from "./profiles.js";
import { applyProfilePosting, postingPolicyAddenda } from "./postingpolicy.js";
import { prepareDependencySources, renderDependencyNote } from "./depsources.js";
import { fileImprovementPr, fileIssue, gitRunner, type FileOutcome } from "./improvements.js";
import {
  EMBEDDER_GATE_MAX_WAIT_MS,
  LocalEmbedderSupervisor,
  OpenVikingClient,
  OpenVikingSupervisor,
  ReembedDriver,
  keyFromFile,
  memoryServing,
  openVikingContextAssembler,
  openVikingStore,
  type OvRequestRecord,
} from "./openviking/index.js";
import {
  OV_REVIEWER_KEY_SECRET,
  keyChangeWatcher,
  openVikingSessionLifecycle,
  readOvcliKey,
  readRetiredUrisFile,
  writeRecallHint,
  writeRetiredUris,
} from "./memory/ovsession.js";
import type { ContextAssembler, RoundMemory } from "./memory/context.js";
import { MEMORY_LAYOUT_NOTE, ROUND_SEARCH_AREAS } from "./memory/layout.js";
import {
  MemoryHealthMonitor,
  disabledMemoryStatus,
  pendingMemoryStatus,
  type CaseWritesStatus,
  type MemoryStatus,
} from "./memory/health.js";
import { credentialProbe } from "./openviking/probe.js";
import {
  provisionReportPath,
  raiseProvisionWake,
  readProvisionReport,
} from "./openviking/provisionreport.js";
import { countedGapSink } from "./openviking/gapsink.js";
import { recoverPrForOperator } from "./operator-recovery.js";
import { resolveTerminalFailure } from "./terminal-failure.js";
import type { MemoryStore } from "./memory/store.js";
import { readPinnedFromSweep, startEodPinWatch, type PinnedSweepSource } from "./eodpinwatch.js";
import { reconcileOrphanedRounds } from "./reconcile.js";
import { OVERSEER_SESSION, PiSessionManager, prSessionName } from "./sessions.js";
import { SlackApiClient } from "./slack/api.js";
import { makeAnnouncer, type SlackAnnouncer } from "./slack/announce.js";
import { OriginStore } from "./slack/origin.js";
import { makeSlackReply } from "./slack/reply.js";
import { SlackRouter } from "./slack/router.js";
import { SlackSocketClient } from "./slack/socket.js";
import type { SlackTransport } from "./slack/types.js";
import type { StateStore } from "./state.js";
import type { RecheckOrder } from "./recheck.js";
import {
  RECHECK_TEMPLATE_FILE,
  renderRecheckPrompt,
  renderRoundPrompt,
  templateFileForOrder,
} from "./templates.js";
import { nodeExec } from "./tmux.js";
import type { RoundOrder, SessionCommandObservation, SessionHooks } from "./types.js";
import { WebhookHealer } from "./webhookheal.js";

export interface ProductionParts {
  cfg: Config;
  root: string;
  minter: TokenMinter;
  gate: MutationGate;
  adapter: GitHubAdapter;
  sessions: PiSessionManager;
  /** Late-bound observer for the raw-tier client's requests:
   * buildParts builds that client before the memory health monitor exists,
   * so createProductionDaemon points `sink` at the monitor once it does. */
  memoryRequests?: { sink: ((record: OvRequestRecord) => void) | null };
}

export function buildParts(root = sandboxRoot(), loaded = loadConfig()): ProductionParts {
  // The profile's per-lens tuning overlays the parsed config once, here, so
  // every consumer downstream (the plan, the agents build, the round row)
  // reads the one resolved `cfg.lenses` — the profile wins over
  // config.toml, the preset and the defaults. A malformed `[lenses]` table
  // fails the boot loudly, like every other profile loader.
  // The profile's `[posting]` policy rides the same overlay (src/postingpolicy.ts).
  const cfg = applyProfilePosting(
    applyProfileTuning(loaded, loadProfileLensTuning(root, loaded.review.profile)),
    loadProfilePosting(root, loaded.review.profile),
  );
  const minter = new TokenMinter(cfg.github.secrets_dir);
  const gate: MutationGate = new MutationGate(
    cfg.dry_run,
    join(root, "state", "dryrun"),
    (intent: MutationIntent) => adapter.executeMutation(intent),
  );
  const adapter: GitHubAdapter = new GitHubAdapter(cfg, minter, gate);
  // The PR's raw memory tier: the daemon owns create/delete of the
  // OpenViking session a PR's pi attaches to. Its own client, on the reviewer
  // user key — never ADMIN/ROOT. Both directions are total, so a store that is
  // down or unkeyed costs the raw tier and never a session.
  const memoryRequests: NonNullable<ProductionParts["memoryRequests"]> = { sink: null };
  const ovSessions = openVikingSessionLifecycle(
    new OpenVikingClient({
      baseUrl: openVikingBaseUrl(cfg.openviking),
      apiKey: keyFromFile(join(cfg.github.secrets_dir, OV_REVIEWER_KEY_SECRET)),
      user: cfg.openviking.user,
      account: cfg.openviking.account,
      timeoutMs: cfg.openviking.request_timeout_ms,
      // Counted with the daemon's other requests.
      onRequest: (r) => memoryRequests.sink?.(r),
    }),
    // The lifecycle logs a failed delete.
    { log: (msg) => console.log(`[quickreviewd] ${msg}`) },
  );
  const sessions = new PiSessionManager({
    cfg,
    root,
    ovSessions,
    configPath: liveConfigPath(),
  });
  return { cfg, root, minter, gate, adapter, sessions, memoryRequests };
}

// Exit-code checked, cwd mandatory: a runner that ignored git's exit or
// defaulted to the daemon's own cwd (a repo with no remote) would leave the
// improvement channel unable to push without saying so.
const gitRun = gitRunner(nodeExec);

/** package.json version for the `daemon.up` line; never worth failing a boot. */
function packageVersion(root: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

// ---- the Slack concierge ---------------------------------------------------
//
// Everything Slack is assembled here and nowhere else, because this is the one
// module allowed to read the two tokens off disk. Three properties the shape
// enforces rather than documents:
//
//   * `[slack] enabled = false` ⇒ this function returns before it touches a
//     secret reader, a socket or a clock. Nothing is constructed, so nothing
//     can post.
//   * A missing token, a malformed [slack] block or an auth.test that cannot
//     name us is a hard boot error. A bot that cannot identify itself cannot
//     filter its own echoes — running anyway is a loop risk, not a degraded
//     mode.
//   * Socket Mode is the only inbound transport. There is no HTTP route here
//     and none in src/webhook.ts (tests/slack-no-route.test.ts makes that
//     structural).

/** How often the duplicate-consumer check reads `hello.num_connections`. The
 * socket exposes the count, not an event; `noteConnections` only fires on a
 * CHANGE, so polling it is equivalent to hooking the frame. */
const SLACK_CONNECTIONS_TICK_MS = 60_000;

export interface SlackWiringOptions {
  cfg: Config;
  root: string;
  store: StateStore;
  /** The daemon's command handlers; the Slack dir gets these plus slackReply. */
  commandDeps: CommandDeps;
  /** Wake the overseer and return the wake file's PATH (origin binding). */
  injectOverseerFile: (message: string) => Promise<string>;
  /** The existing overseer-inject anomaly path — where ops signals go. Never
   * the channel: v1 ships ops causes off. */
  injectOverseer: (message: string) => Promise<void>;
  log: (msg: string, extra?: unknown) => void;
  version?: string;
  now?: () => Date;
  /** Test seam: how a token file is read. Default is the shared fs reader. */
  readSecret?: SecretReader;
  /** Test seam: how the transport is built from the two tokens. */
  makeTransport?: (opts: { cfg: Config; botToken: string; appToken: string }) => SlackTransport;
  /**
   * The origin store, when the caller already owns one. `createProductionDaemon`
   * builds it before the daemon so daemon-originated overseer wakes can stamp a
   * `local` origin through the very same store the belt reads. Omitted ⇒ built
   * here (tests, and any caller with no wake path of its own).
   */
  origins?: OriginStore;
}

/** The live Slack subsystem, as `onStop` needs to see it. */
export interface SlackRuntime {
  announcer: SlackAnnouncer;
  router: SlackRouter;
  origins: OriginStore;
  transport: SlackTransport;
  /** The tier-checked `commands/slack/` watcher. */
  commands: CommandWatcher;
  /** `CommandDeps.slackReply` — also handed to the legacy-dir watcher. */
  slackReply: NonNullable<CommandDeps["slackReply"]>;
  stop(reason: string): Promise<void>;
}

/** The real transport: Web API out, Socket Mode in, composed into one object. */
function defaultTransport(opts: {
  cfg: Config;
  botToken: string;
  appToken: string;
}): SlackTransport {
  const { cfg } = opts;
  const api = new SlackApiClient({
    botToken: opts.botToken,
    postMinIntervalMs: cfg.slack.post_min_interval_ms,
    userCacheTtlSec: cfg.slack.name_cache_ttl_s,
  });
  const socket = new SlackSocketClient({
    appToken: opts.appToken,
    backoffMs: cfg.slack.reconnect_backoff_ms,
    serverPingTimeoutMs: cfg.slack.server_ping_timeout_ms,
  });
  return {
    postMessage: (a) => api.postMessage(a),
    updateMessage: (a) => api.updateMessage(a),
    usersInfo: (id) => api.usersInfo(id),
    authTest: () => api.authTest(),
    pinsAdd: (a) => api.pinsAdd(a),
    startSocket: (h) => socket.startSocket(h),
    stopSocket: () => socket.stopSocket(),
    get numConnections(): number {
      return socket.numConnections;
    },
  };
}

/**
 * Build + start the concierge. Returns undefined when Slack is off — callers
 * pass that straight through, which is why nothing downstream needs a flag.
 */
export async function startSlack(opts: SlackWiringOptions): Promise<SlackRuntime | undefined> {
  const { cfg, root, store, log } = opts;
  if (!cfg.slack.enabled) return undefined;
  const now = opts.now ?? (() => new Date());
  const readSecret = opts.readSecret ?? fsSecretReader;

  // Fail loud, at boot, on a missing token or a half-filled [slack] block.
  validateSlackConfig(cfg, { readSecret });
  const botToken = readSecret(slackTokenPath(cfg, "bot"));
  const appToken = readSecret(slackTokenPath(cfg, "app"));
  if (!botToken || !appToken)
    throw new Error("slack: token files vanished between validation and read");

  const transport = (opts.makeTransport ?? defaultTransport)({ cfg, botToken, appToken });

  // Who are we? Resolved once, and required: the router's echo filter is built
  // on this identity, and a bot that cannot recognise its own messages will
  // answer itself forever.
  const identity = await transport.authTest();
  if (!identity) {
    throw new Error(
      "slack: auth.test failed — refusing to start (a bot that cannot identify itself will answer its own echoes)",
    );
  }
  log(`slack: connected as ${identity.user_id} in ${cfg.slack.channel}`);

  const origins = opts.origins ?? new OriginStore(join(root, "state", "slack", "origin"), now);
  const announcer = makeAnnouncer({
    cfg,
    store,
    slack: transport,
    now,
    log,
    version: opts.version,
    statusPath: join(root, "state", "status.json"),
    onAnomalySignal: (message) => {
      // Durable anomaly record beside the overseer wake.
      store.logAnomaly("slack_connections", null, null, message);
      return opts.injectOverseer(message);
    },
  });
  if (!announcer) throw new Error("slack: announcer not built despite enabled = true");

  const router = new SlackRouter({
    cfg,
    store,
    origins,
    inject: opts.injectOverseerFile,
    users: transport,
    identity,
    onCapReached: async (decision) => {
      const cap =
        decision.cap === "per_user_daily_turns"
          ? cfg.slack.policy.per_user_daily_turns
          : cfg.slack.policy.daily_turns;
      await announcer.capReached(cap);
    },
    now,
    log: (line) => log(line),
  });

  const slackReply = makeSlackReply({ cfg, store, api: transport, now, log: (line) => log(line) });
  const commands = new CommandWatcher({
    dir: join(root, "commands", "slack"),
    tier: { dir: "slack", currentOrigin: () => origins.latest() },
    deps: { ...opts.commandDeps, slackReply },
    store,
    log: (line) => log(line),
  });
  await commands.start();

  await transport.startSocket((event) => {
    void router.handle(event).catch((err) => log("slack: router threw (event dropped)", err));
  });

  const timers: Array<ReturnType<typeof setInterval>> = [];
  const every = (ms: number, fn: () => void): void => {
    const t = setInterval(fn, ms);
    t.unref?.();
    timers.push(t);
  };
  // Half the grace window, so a PR is noticed roughly when it goes overdue.
  every(Math.max(1, Math.round(cfg.slack.policy.pickup_grace_min / 2)) * 60_000, () => {
    void announcer
      .announceNotPickedUp()
      .catch((err) => log("slack: not-picked-up sweep failed", err));
  });
  // Every timer body is its own try/catch: a throw inside setInterval is an
  // uncaught exception, and a duplicate-consumer probe must never kill the daemon.
  every(SLACK_CONNECTIONS_TICK_MS, () => {
    try {
      announcer.noteConnections(transport.numConnections);
    } catch (err) {
      log("slack: connections probe failed", err);
    }
  });

  await announcer.daemonUp();
  announcer.startHeartbeat();

  return {
    announcer,
    router,
    origins,
    transport,
    commands,
    slackReply,
    async stop(reason: string): Promise<void> {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      announcer.stopHeartbeat();
      commands.stop();
      // The store is still open here (onStop runs before teardown), so the
      // post is ledgered; `daemonStopping` is bounded internally, so awaiting
      // it can never hold the exit open.
      await announcer.daemonStopping(reason);
      await transport.stopSocket().catch((err) => log("slack: socket stop failed", err));
    },
  };
}

/**
 * The legacy `commands/` watcher. Two things change when Slack is live, and
 * only those two: `slack_reply` becomes executable from this dir as well, and
 * the belt gate is installed — when the turn being served was caused by a
 * non-owner Slack message, the legacy dir refuses, so a tier-checked command
 * cannot slip past by being written to the wrong place. Slack off ⇒ no tier
 * gate at all.
 *
 * The gate reads `latestAny()`, not `latest()`: the belt must not lift merely
 * because a turn ran past the 15-minute TTL (text in the channel can ask for
 * exactly that — "take your time"). Only a daemon wake, which stamps a `local`
 * origin, supersedes a Slack origin here.
 */
export function buildLocalCommandWatcher(opts: {
  root: string;
  deps: CommandDeps;
  store: StateStore;
  slack: SlackRuntime | null;
  log: (line: string) => void;
}): CommandWatcher {
  const { slack } = opts;
  return new CommandWatcher({
    dir: join(opts.root, "commands"),
    ...(slack
      ? { tier: { dir: "local" as const, currentOrigin: () => slack.origins.latestAny() } }
      : {}),
    deps: slack ? { ...opts.deps, slackReply: slack.slackReply } : opts.deps,
    store: opts.store,
    log: opts.log,
  });
}

/**
 * The operator's command watcher: `commands/operator/`, the directory
 * `qcr drain`, the board's `u` and the deploy tab write as root.
 * Same vocabulary, same handlers; the difference is the issuer the watcher
 * stamps, and only the real process seal decides it. The same local Slack
 * belt as `commands/` is installed, and binds only files the seal does not
 * vouch for: the overseer cannot write into a sealed directory, but the
 * parent is the daemon's, so it can make or swap in an unsealed one — and a
 * file there is a session's, so it must be refused exactly where `commands/`
 * would refuse it. The daemon never creates the directory — see
 * `CommandWatcherOptions`.
 */
export function buildOperatorCommandWatcher(opts: {
  root: string;
  deps: CommandDeps;
  store: StateStore;
  slack: SlackRuntime | null;
  log: (line: string) => void;
}): CommandWatcher {
  const { slack } = opts;
  return new CommandWatcher({
    dir: join(opts.root, "commands", "operator"),
    operator: processOperatorSeal(),
    ...(slack
      ? { tier: { dir: "local" as const, currentOrigin: () => slack.origins.latestAny() } }
      : {}),
    deps: opts.deps,
    store: opts.store,
    log: opts.log,
  });
}

/**
 * The other half of "who caused this turn": every daemon-originated overseer
 * wake stamps a `local` origin before it injects.
 *
 * One wrapper, one seam. The daemon is handed the returned `hooks`, so the EOD
 * sweep, the verdict anomalies, the ping-pong follow-ups and the connections
 * signal all stamp — without any of those modules knowing Slack exists. The
 * Slack router deliberately keeps the unwrapped inject path: its turns must
 * stamp a Slack origin.
 *
 * Stamping is best-effort and never blocks a wake; with Slack off nothing is
 * written at all.
 *
 * The wrap must forward every optional hook the daemon reads; a hook dropped
 * here silently disables its consumer in production while unit tests, which
 * hand the daemon unwrapped hooks, stay green.
 */
export function daemonOriginWakes(opts: {
  hooks: SessionHooks;
  origins: OriginStore;
  enabled: boolean;
  log?: (msg: string, extra?: unknown) => void;
}): { hooks: SessionHooks; wake: (reason: string, message: string) => Promise<void> } {
  const { hooks, origins, enabled } = opts;
  const log = opts.log ?? (() => {});
  const wake = async (reason: string, message: string): Promise<void> => {
    if (enabled) {
      try {
        origins.writeLocal(reason);
      } catch (err) {
        log("slack: could not stamp a local origin for a daemon wake", err);
      }
    }
    await hooks.injectOverseer(message);
  };
  return {
    wake,
    hooks: {
      dispatchRound: (order, prompt) => hooks.dispatchRound(order, prompt),
      inject: (pr, message) => hooks.inject(pr, message),
      archiveAndClose: (pr) => hooks.archiveAndClose(pr),
      ...(hooks.compactSession
        ? { compactSession: (pr: number) => hooks.compactSession!(pr) }
        : {}),
      // Liveness + kill feed the stuck-round detector; without sessionAlive
      // liveness is always unknown and every stuck round parks.
      ...(hooks.sessionAlive ? { sessionAlive: (pr: number) => hooks.sessionAlive!(pr) } : {}),
      ...(hooks.killSession ? { killSession: (pr: number) => hooks.killSession!(pr) } : {}),
      ...(hooks.sessionActivityAt
        ? { sessionActivityAt: (pr: number) => hooks.sessionActivityAt!(pr) }
        : {}),
      ...(hooks.injectPending ? { injectPending: (pr: number) => hooks.injectPending!(pr) } : {}),
      // Receipt/replay hooks are the command supervisor's positive evidence
      // and safe recovery path; without them a failed ordinary wake exhausts
      // without attempting same-command replay.
      ...(hooks.roundPromptAccepted
        ? {
            roundPromptAccepted: (pr: number, roundNo: number, startedAtMs: number) =>
              hooks.roundPromptAccepted!(pr, roundNo, startedAtMs),
          }
        : {}),
      ...(hooks.wakeReceiptPresent
        ? {
            wakeReceiptPresent: (pr: number, marker: string, sinceMs: number) =>
              hooks.wakeReceiptPresent!(pr, marker, sinceMs),
          }
        : {}),
      ...(hooks.redeliverRound
        ? { redeliverRound: (pr: number, roundNo: number) => hooks.redeliverRound!(pr, roundNo) }
        : {}),
      ...(hooks.retrySessionCommand
        ? {
            retrySessionCommand: (commandId: string, reason: string) =>
              hooks.retrySessionCommand!(commandId, reason),
          }
        : {}),
      // Same-session redelivery and the bridge's compaction report; without
      // them a live session whose wake waited behind a compaction is killed
      // instead of redelivered to.
      ...(hooks.redeliverSessionCommand
        ? {
            redeliverSessionCommand: (commandId: string, observed: SessionCommandObservation) =>
              hooks.redeliverSessionCommand!(commandId, observed),
          }
        : {}),
      ...(hooks.sessionCompaction
        ? { sessionCompaction: (pr: number) => hooks.sessionCompaction!(pr) }
        : {}),
      // The reconcile pass's sweep of closed PRs' raw-tier sessions.
      ...(hooks.sweepStaleOvSessions
        ? { sweepStaleOvSessions: () => hooks.sweepStaleOvSessions!() }
        : {}),
      injectOverseer: (message) => wake("overseer-wake", message),
    },
  };
}

/**
 * Where the passive auth watch looks. PR and overseer sessions are spawned
 * with `--session-dir <root>/<pi.session_dir>/<session>`, so THAT is where
 * their expired-token errors land; pi's default store alone would miss every
 * reviewer session. The default store under the container user's home (the
 * pihome volume) stays covered for anything spawned without an explicit dir.
 */
export function piAuthWatchDirs(sessions: Pick<PiSessionManager, "sessionsRoot">): string[] {
  // pi's default global store — the same dir the archiver's pi-global store
  // moves day-old files out of: one definition, `piGlobalSessionsDir`.
  return [sessions.sessionsRoot(), piGlobalSessionsDir()];
}

/**
 * Where the `eod-curation-receipt` command lands. With no learner on this
 * daemon (memory switched off) the receipt is refused, with the reason —
 * which is what the sweep prompt's "off" no-packet section
 * (`renderNoPacketSection`) tells the curator: "the daemon would refuse
 * one". tests/eod-seed-coherence.test.ts holds the two together.
 */
export function routeCurationReceipt(
  learner: Pick<Learner, "applyReceipt"> | null,
  receipt: CurationReceipt,
): FileOutcome {
  if (!learner)
    return {
      ok: false,
      reason: "the learner is not running on this daemon ([openviking] enabled = false)",
    };
  return learner.applyReceipt(receipt);
}

export function createProductionDaemon(parts: ProductionParts = buildParts()): Daemon {
  const { cfg, root, gate, adapter, sessions } = parts;
  const log = (msg: string, extra?: unknown) => console.log(`[quickreviewd] ${msg}`, extra ?? "");

  // The daemon's one memory store, built in onStart once secrets are readable.
  // Everything that needs it is late-bound through this holder: the round
  // assembler and the EOD pinned-area watchdog are constructed before it
  // exists, and both degrade to "no memory" rather than to an error.
  let memoryStore: MemoryStore | null = null;
  /** The same store, as the sweep that keeps what it could not read (the
   * pinned watchdog must tell an outage from an empty pinned area). */
  let memorySweep: PinnedSweepSource | null = null;
  let memoryAssembler: ContextAssembler | null = null;
  const notBuiltYet = {
    status: "unreadable",
    reason: "memory store not built yet (daemon still starting)",
  } as const;
  const lateAssembler: ContextAssembler = {
    pinnedHead: () =>
      memoryAssembler ? memoryAssembler.pinnedHead() : Promise.resolve(notBuiltYet),
    contextBlock: (q, o) =>
      memoryAssembler ? memoryAssembler.contextBlock(q, o) : Promise.resolve(notBuiltYet),
  };

  // The profile-selected ecosystem seam, loaded once at assembly (a
  // malformed profile.toml fails the boot loudly). It decides the tier-forcing
  // migration gate, the round pre-check and the prompt's migration-gate prose;
  // "none" (no profile, no file, no key) runs none of that machinery.
  const ecosystem = ecosystemFor(loadProfileEcosystem(root, cfg.review.profile));
  log(`profile ${cfg.review.profile || "(none)"}: ecosystem ${ecosystem.name}`);

  // The identity variable map every prompt render and agent build
  // resolves {{owner_name}}/{{repo}}/{{bot_login}} against.
  const identity = identityVars(cfg);
  const renderPrompt = (order: RoundOrder, memory: RoundMemory): string =>
    renderRoundPrompt(
      readFileSync(join(root, "prompts", templateFileForOrder(order)), "utf8"),
      order,
      memory,
      cfg.owner.name,
      ecosystem,
      identity,
    );
  // The recheck's own template — a nudge, not a round order.
  const renderRecheck = (order: RecheckOrder): string =>
    renderRecheckPrompt(
      readFileSync(join(root, "prompts", RECHECK_TEMPLATE_FILE), "utf8"),
      order,
      identity,
    );

  let eod: EodTimer | null = null;
  let pinWatch: ReturnType<typeof startEodPinWatch> | null = null;
  let heartbeat: HeartbeatTimer | null = null;
  let commands: CommandWatcher | null = null;
  let operatorCommands: CommandWatcher | null = null;
  let slack: SlackRuntime | null = null;
  // The [feedback] engine, built in onStart (it needs the memory store). A
  // signal arriving in the boot gap between the webhook binding and onStart
  // is ledgered, never dropped: its row starts `pending`, the backfill pump
  // writes its memory entry, and the agents rebuild once the engine exists so
  // a same-day [feedback] comment still reaches the validator.
  let feedback: FeedbackEngine | null = null;
  let feedbackLedgeredEarly = false;
  // The [feedback] ledger's backfill pump — writes what memory still owes
  // while memory health reads healthy, and wakes `memory_write_backlog` when
  // an owed signal ages past the threshold.
  let feedbackPump: FeedbackMemoryPump | null = null;
  // The finding-case writer — one document per posted finding a human
  // answered or whose fate is known, into reviewer memory's `finding-cases/`,
  // through the same store; backfills `[memory] cases_backfill_days`. Writes
  // only while memory health reads healthy.
  let caseWriter: CaseWriter | null = null;
  // Is a review round reading memory right now? Dispatch opens a window
  // around each round's seed (through to its lesson selection), the selector
  // one around each prefetch, and the case writer starts no batch while any
  // is open — every case is a multi-second embedding on the one-thread
  // embedder those reads wait on.
  const roundActivity = new RoundMemoryActivity();
  // The learner — mines the human outcomes into lesson candidates at
  // EOD − `lessons_mine_lead_min`, hands the EOD sweep its outcomes packet
  // (`dayContext`), takes the `eod-curation-receipt`, checks every adoption
  // against memory, and wakes `eod_curation_missing` /
  // `eod_lessons_not_persisted`. Only where memory is switched on: with it off
  // there is nowhere a lesson could land.
  let learner: Learner | null = null;
  // The closed-PR archiver — daemon bookkeeping on its own timer (never a
  // reconcile step), started beside the case writer and the learner whatever
  // memory does. It starts no work before the first healthy reconcile plus
  // `[archive] start_delay_min`, and holds while draining, stalled, starved or
  // short of disk. Every tick plans (status.json `archive` says what a pass
  // would move); in mode `on` it also restores reopened PRs, moves the old
  // reader-less event rows and webhook deliveries into archive/db/, moves
  // closed PRs' files into archive/pr-<n>/ and seals finished months.
  let archiver: Archiver | null = null;
  // The lesson shadow ledger — every round's selection through OpenViking
  // (bounded, `[memory] delivery`), the marks a delivered dont-raise lesson
  // would have left on its posted findings, and the operator's kill switch.
  // Built in onStart (it needs the state store); the selector only where
  // memory is on. Under `shadow` nothing here changes a prompt; under `on`
  // dispatch awaits `select` beside the seed and renders the round's lessons,
  // and `repoFacts` reaches the recheck nudge and the ping-pong wake.
  let lessonLedger: LessonLedger | null = null;
  let lessonSelector: RoundLessonSelector | null = null;
  const lateLessons: RoundLessonHook = {
    start: (order, files) => lessonSelector?.start(order, files),
    delivering: () => lessonSelector?.delivering() ?? false,
    select: (order, files, opts) =>
      lessonSelector?.select(order, files, opts) ?? Promise.resolve(null),
    repoFacts: (q) => lessonSelector?.repoFacts(q) ?? Promise.resolve(""),
    // A round discarded before its handoff: its selection record goes (with
    // no selector nothing was ever recorded).
    discard: (roundId) => lessonSelector?.discard(roundId),
  };
  /** The status headline, recomputed at most once a minute (the heartbeat
   * runs far more often, and the report reads several tables). */
  let lessonStatusCache: { at: number; value: LessonDeliveryStatus | null } | null = null;
  // The OpenViking server, supervised as a child of this process. Started
  // first in onStart so it warms up while the agents build — but never
  // awaited: there is deliberately no boot ordering, and rounds run
  // memory-less until `/ready` passes.
  let openviking: OpenVikingSupervisor | null = null;
  // The local English embedder the server embeds through — a second
  // supervised child, started first; the server's first start waits (bounded)
  // for it to serve. Off unless the rendered ov.conf routes to it.
  let localEmbedder: LocalEmbedderSupervisor | null = null;
  // The embedder migration's daemon half — resumes the re-embed of reviewer
  // memory the entrypoint's `prepare` journalled, once /ready passes.
  // Timer-armed, never awaited; its block rides inside the heartbeat's
  // `openviking` entry.
  let reembed: ReembedDriver | null = null;
  // The webhook-URL self-heal. Only ever constructed when [ingress]
  // shape = "tunnel-file".
  let webhookHeal: WebhookHealer | null = null;
  // Reviewer-memory health — the authenticated probe of each credential in
  // use, fed by the daemon's own requests and round seeds, and the one source
  // of the status.json `memory` block every person-facing surface reads.
  // Built in onStart (it needs the store and the server's config); until then
  // the block reads `unknown` — never healthy, never off.
  let memoryHealth: MemoryHealthMonitor | null = null;
  /** Why memory is NOT monitored on this daemon; null while still deciding. */
  let memoryUnmonitored: string | null = null;
  if (parts.memoryRequests) parts.memoryRequests.sink = (r) => memoryHealth?.recordRequest(r);

  // The origin store is built here, before the daemon, because both halves of
  // "who caused this turn" write to it: the router (Slack turns) and every
  // daemon-originated overseer wake below (local turns).
  const origins = new OriginStore(join(root, "state", "slack", "origin"));

  // The daemon sees a wrapped SessionHooks (see `daemonOriginWakes`): every
  // autonomous overseer wake stamps a `local` origin, so the legacy-dir belt
  // knows the turn is the daemon's own.
  const { hooks, wake: wakeOverseerAsDaemon } = daemonOriginWakes({
    hooks: sessions,
    origins,
    enabled: cfg.slack.enabled,
    log,
  });

  // The profile's lens-heuristics extension, loaded once here so a
  // malformed heuristics.toml fails the assembly loudly (same contract as the
  // addenda pack below) and every dispatch selects with the same predicates.
  const profileHeuristics = loadProfileHeuristics(root, cfg.review.profile);

  // The gate's loud line (app-self-config executions) goes to the
  // daemon log; the default console fallback covers any unwired gate.
  gate.setLog(log);

  const daemon = createDaemon({
    cfg,
    root,
    adapter,
    postingDelivery: {
      createReview: async (pr, payload) => {
        // An approval queued by approve-pr.sh keeps that route's green-CI
        // precondition. Do not silently turn an old approval verdict into a
        // COMMENT that its session never marked approval_withheld.
        if (payload.event === "APPROVE" && cfg.guards.block_approve_on_red_ci) {
          try {
            if (
              ciBlocksApproval(classifyCi(await adapter.listChecks(payload.commit_id)), {
                noChecksIsRed: cfg.guards.no_checks_is_red,
              })
            )
              return { executed: false, blocked: "ci-not-green" };
          } catch {
            return { executed: false, blocked: "pr-unreadable" };
          }
        }
        return adapter.createReview(pr, payload);
      },
      listReviewsFull: (pr) => adapter.listReviewsFull(pr),
      // The deferred-posting retry: straight through the gate, whose guards
      // bind as on any review (guard 4 softens a red-CI approval to a
      // COMMENT there); only guard 5 is exempt, via `postingRetry`.
      createDeferredReview: (pr, payload, postingKey) =>
        adapter.createReview(pr, payload, { postingRetry: postingKey }),
    },
    hooks,
    renderPrompt,
    ecosystem,
    heuristics: profileHeuristics,
    // Pinned head + one budgeted context block per round. Past the
    // deadline the round dispatches memory-less and logs the gap — memory
    // never blocks or delays a round.
    memory: {
      assembler: lateAssembler,
      maxTokens: cfg.memory.context_tokens,
      timeoutMs: cfg.memory.context_timeout_ms,
      // Every seed, after the round was built, feeds memory health — a seed
      // that timed out reaches no client observer, so this is the only place
      // it is seen.
      onSeeded: (mem: RoundMemory) =>
        memoryHealth?.recordRoundSeed({
          degraded: mem.degraded,
          reasons: mem.gaps.map((g) => `${g.part}: ${g.reason}`),
        }),
      // The PR session's own recall (vendored openviking-pi patch 0008)
      // searches with the round's query and the round's areas, not the round
      // order.
      publishQuery: (pr: number, query: string) => {
        writeRecallHint(
          sessions.ovRecallHintPath(prSessionName(pr)),
          { query, areas: ROUND_SEARCH_AREAS },
          { log: (msg) => log(msg) },
        );
      },
      // The round's memory window — the case writer starts no
      // batch from the seed until the lesson selection has taken over.
      activity: roundActivity,
    },
    // The round's lesson selection (shadow ledger; awaited by dispatch only
    // under `delivery = "on"`); and the matcher, told when a round's findings
    // record lands.
    lessons: lateLessons,
    onFindingsRecorded: ({ pr, roundNo }) => {
      // Resolve the bot's own threads of the prior findings this round
      // verified fixed or obsolete — ping-pong resolves only threads the
      // author replied in, so a fix pushed without a reply would stay open.
      // Never awaited: GitHub reads and gated writes, each one total.
      void resolveVerifiedPriorThreads(
        {
          store: daemon.store,
          adapter,
          sidecarPath: (n, k) => priorSidecarPath(join(root, "state"), n, k),
          log,
        },
        pr,
        roundNo,
      ).catch((err) => log(`priorresolve: #${pr} round ${roundNo} failed (ignored)`, err));
      if (!lessonLedger) return;
      try {
        markRound(lessonLedger, daemon.store, pr, roundNo);
      } catch (err) {
        log(`lessons: #${pr} round ${roundNo} shadow marking failed (ignored)`, err);
      }
    },
    renderRecheckPrompt: renderRecheck,
    // Conflict resolutions are never trivial: git-level auto-merge comparison
    // in the base clone names the hand-resolved files.
    resolvedFilesInMerges: (from, to, pr) => sessions.worktrees.resolvedFilesInMerges(from, to, pr),
    // Outcome capture: did the code at a posted finding's anchor
    // change? Read-only git in the same base clone, no fetch, memoised.
    outcomeGit: sessions.worktrees,
    // One network fetch per round, before the order is built: the PR head and
    // the branch it targets, together. Everything downstream (prompt, session,
    // passes) then works from the shas this returns.
    prepareWorktree: (pr, baseRef) => sessions.worktrees.ensureWorktree(pr, { baseRef }),
    // Follow-up rounds: the PR-owned change since the last reviewed
    // head (the reviewed head replayed onto the round's merge base, read-only
    // git in the base clone), and the pin that keeps a reviewed head
    // replayable after a force-push.
    prOwnedDelta: (q) => sessions.worktrees.prOwnedDelta(q),
    pinReviewedHead: (pr, sha) => sessions.worktrees.pinReviewedHead(pr, sha),
    // Third-party sources at the PR's locked versions, unpacked into a cache
    // on the state volume for the passes to read (`[review]
    // dependency_sources`). Download and unpack only;
    // total — a dead registry yields an empty note.
    dependencySources: async (worktreePath, files) =>
      renderDependencyNote(
        await prepareDependencySources(worktreePath, files, {
          cacheDir: join(root, "state", "depcache"),
          log: (line) => log(`deps: ${line}`),
        }),
      ),
    // Migration-number pre-check input: the base branch's migrations
    // at the sha the round pinned. Local git in the just-fetched base clone.
    listBaseMigrations: (baseSha) => sessions.worktrees.listMigrationFiles(baseSha),
    // Escalation-mention pick: most recent human author of the
    // touched first-party directive files at the round's merge base, read from
    // the base clone; the daemon's own bot identity never qualifies.
    directiveAuthor: (sha, paths) =>
      sessions.worktrees.lastHumanAuthor(sha, paths, {
        botLogins: [cfg.github.bot_login, cfg.github.app_slug],
      }),
    log,
    // Lazy on purpose: the Slack subsystem is built in onStart, after the
    // store exists. Off ⇒ this resolves undefined forever and dispatch/verdicts
    // never see an announcer.
    announce: () => slack?.announcer,
    digestHeadline: () => latestDigestHeadline(join(root, "digest")),
    // Passive pi auth-failure watch: the JSONLs pi actually writes.
    piSessionsDir: piAuthWatchDirs(sessions),
    // The memory engine's heartbeat block — a cached, synchronous
    // read of the supervisor's last health + /proc sample, plus the reembed
    // journal (one small synchronous file read per heartbeat) and the local
    // embedder's status.
    openvikingStatus: () => {
      const status = openviking?.status();
      if (!status) return status;
      return {
        ...status,
        ...(reembed ? { reembed: reembed.status() } : {}),
        ...(localEmbedder ? { embedder: localEmbedder.status() } : {}),
      };
    },
    // The archiver's block — a cached synchronous read. Before
    // onStart builds it the mode is known and nothing else: `unknown`, a
    // null backlog, never 0.
    archiveStatus: () => (archiver ? archiver.status() : pendingArchiveStatus(cfg.archive.mode)),
    // Whether memory works, beside whether the server is up — and what memory
    // still owes the [feedback] ledger.
    memoryStatus: (): MemoryStatus => {
      const base = memoryHealth
        ? memoryHealth.status()
        : memoryUnmonitored !== null
          ? disabledMemoryStatus(memoryUnmonitored)
          : pendingMemoryStatus();
      // The finding-case ledger, when a case writer runs (the block is a
      // fresh object each call). Unread is unknown (null), never
      // "nothing owed".
      if (caseWriter) {
        let cases: CaseWritesStatus | null;
        try {
          cases = caseWriter.status();
        } catch (err) {
          log("memory status: could not read the finding-case ledger", err);
          cases = null;
        }
        base.case_writes = cases;
      }
      // The lesson shadow ledger's headline. Unread is unknown (null), never
      // "nothing happened".
      if (lessonLedger) {
        const nowMs = Date.now();
        if (!lessonStatusCache || nowMs - lessonStatusCache.at >= 60_000) {
          let value: LessonDeliveryStatus | null;
          try {
            value = lessonDeliveryStatus(lessonLedger, cfg.memory.delivery, {
              selecting: lessonSelector !== null,
            });
          } catch (err) {
            log("memory status: could not read the lesson ledger", err);
            value = null;
          }
          lessonStatusCache = { at: nowMs, value };
        }
        base.lessons = lessonStatusCache.value;
      }
      // The day's EOD curation and the lessons' balance. Unread is unknown
      // (null), never "all well".
      if (learner) {
        try {
          base.curation = learner.status();
        } catch (err) {
          log("memory status: could not read the learner's ledger", err);
          base.curation = null;
        }
      }
      try {
        const b = daemon.store.feedbackMemoryBacklog();
        return {
          ...base,
          feedback_writes: {
            pending: b.pending,
            failed: b.failed,
            oldest_pending_at: b.oldest_pending_at,
          },
        };
      } catch (err) {
        // Unread is unknown, never "nothing owed".
        log("memory status: could not read the [feedback] memory backlog", err);
        return { ...base, feedback_writes: null };
      }
    },

    // The [feedback] tuning loop.
    onFeedback: async (e: FeedbackEvent) => {
      if (!feedback) {
        // Before the engine exists the signal is ledgered, never dropped: its
        // row waits `pending` for the backfill pump.
        const res = ledgerFeedbackSignal(daemon.store, e, {
          timezone: cfg.ops.timezone,
          memoryEnabled: cfg.openviking.enabled,
        });
        if (res.result === "recorded") feedbackLedgeredEarly = true;
        log(
          `feedback: signal before engine ready — ledgered (${res.result}); memory is written by the backfill`,
          e.kind,
        );
        return;
      }
      await feedback.ingest(e);
    },

    async onStart(d) {
      // OpenViking first and unawaited: the server takes seconds to become
      // ready, so it starts warming while everything below builds. A missing
      // binary (any dev PC) is reported once and never retried; a crash is
      // respawned on a capped backoff ladder, forever.
      //
      // The local English embedder starts before it — the server's /ready
      // probes it — and the server's first start waits for it
      // to serve, bounded (EMBEDDER_GATE_MAX_WAIT_MS). Neither is awaited here.
      localEmbedder = new LocalEmbedderSupervisor({ cfg: cfg.openviking, repoRoot: root, log });
      localEmbedder.start();
      const embedderForGate = localEmbedder;
      openviking = new OpenVikingSupervisor({
        cfg: cfg.openviking,
        log,
        startGate: {
          open: () => embedderForGate.gateOpen(),
          maxWaitMs: EMBEDDER_GATE_MAX_WAIT_MS,
          what: "the local embedder",
        },
        // The reviewer's memory root does not exist on a fresh server until
        // something creates it. The TUI does this for the companion's sake;
        // the daemon does it here for its own, each time the server comes up,
        // so the round path's first sweep lists a real (empty) tree instead
        // of leaning on how the server spells a missing one.
        onReady: () => {
          // Memory health re-measures at once rather than at its next tick:
          // a server that just came up should read healthy (or say why not)
          // in seconds, not minutes.
          void memoryHealth?.probeNow();
          const store = memoryStore;
          if (!store?.ensureWritable) return;
          void store.ensureWritable().then(
            (res) =>
              log(
                `openviking ready: memory root ${res.ok ? "ready" : "NOT ready"} — ${res.message}`,
              ),
            (err) => log("openviking ready: memory root check failed", err),
          );
        },
      });
      openviking.start();
      const supervisor = openviking;
      reembed = new ReembedDriver({
        cfg: cfg.openviking,
        repoRoot: root,
        keyPath: join(cfg.github.secrets_dir, OV_REVIEWER_KEY_SECRET),
        ready: () => supervisor.status().ready,
        log,
      });
      reembed.start();

      // Bind the daemon's durable command slot before any PR session is
      // adopted or born. Pending rows reconstruct their exact inject bytes;
      // running rows retain their prior owner until bounded recovery.
      sessions.setCommandStore(d.store);
      // Out-of-round wakes (recheck, ping-pong) can now respawn a sticky
      // session the last restart killed — the title comes from the registry.
      sessions.setTitleResolver((pr) => d.store.getPr(pr)?.title);
      // Lens agents: expand {{include:...}} + per-pass model overrides into
      // the build dir (state/agents) the native subagent extension discovers
      // through its "user" scope — the container entrypoint symlinks
      // ~/.pi/agent/agents at it.
      //
      // The build composes in the same-day feedback addendum when today
      // carries [feedback] comments — validator-scoped, demotion-only,
      // regenerated on every ingest and expired on ops-day change (the
      // 5-minute day check below), so a mid-day restart picks today's
      // feedback up and yesterday's never leaks into a new day.
      // The repo-profile addenda pack is loaded once at assembly so a
      // malformed pack fails the boot loudly (never a silent skip) and every
      // rebuild composes the same bytes. Composition order is fixed in the
      // `addenda` list below, with the same-day feedback addendum last.
      const profileAddenda = loadProfileAddenda(root, cfg.review.profile);
      if (cfg.review.profile !== "") {
        log(`profile ${cfg.review.profile}: ${profileAddenda.length} addenda loaded`);
        const tuned = Object.keys(cfg.lenses ?? {});
        if (tuned.length) log(`profile ${cfg.review.profile}: lens tuning for ${tuned.join(", ")}`);
      }
      // The day is marked built only once the build LANDS (dayScopedRebuild):
      // a throw on the day-change tick is retried by the next tick instead of
      // leaving yesterday's feedback addendum in force all day.
      // The lesson ledger holds the operator's kill switch,
      // which decides (with `[memory] delivery`) whether the validator's
      // lesson addendum is composed — so it exists before the first build.
      lessonLedger = new LessonLedger(d.store);
      const agentsDay = dayScopedRebuild(
        () => opsDay(cfg.ops.timezone),
        (buildDay) => {
          const fb = feedbackDayAddendum(d.store.feedbackCommentsForDay(buildDay), buildDay);
          const lessonAdd = lessonAddendaFor(cfg.memory.delivery, lessonLedger);
          const built = buildAgents(join(root, "agents"), join(root, "state", "agents"), {
            root,
            tiers: cfg.models.tiers,
            riskPasses: cfg.models.risk_passes,
            validateTier: cfg.models.validate_tier,
            vars: identity,
            // Ecosystem-gated addenda follow the profile's selection.
            ecosystem: ecosystem.name,
            // A lens's profile `effort` rides the per-variant hook;
            // `[models.pass_tiers]` pins move a lens's tier on top of it.
            models: passTierModels(
              cfg.models.pass_tiers,
              cfg.models.tiers,
              lensModelOverrides(cfg.models, cfg.lenses),
              cfg.models.pass_models,
              sweepLightVariants(cfg.review),
            ),
            addenda: [
              ...PASS_ADDENDA,
              ...configAddenda(cfg.review),
              ...profileAddenda,
              // The profile's `emphasis` / `max_severity`, compiled.
              ...lensTuningAddenda(cfg.lenses),
              // The profile's `[posting]` policy, compiled for the validator.
              ...postingPolicyAddenda(cfg.posting),
              // The validator's lesson authority, beside the
              // same-day feedback addendum (never in place of it) — only
              // while `[memory] delivery = "on"` and the kill switch is on.
              ...lessonAdd,
              ...(fb ? [fb] : []),
            ],
          });
          log(
            `built ${built.length} pass agents into state/agents${lessonAdd.length ? " (+ lesson addendum)" : ""}${fb ? " (+ same-day feedback addendum)" : ""}`,
          );
        },
      );
      const rebuildAgents = agentsDay.rebuild;
      rebuildAgents();
      // Reviewer memory: the one daemon-side `MemoryStore`, over the
      // supervised OpenViking server on loopback. The reviewer user key is
      // read from the secrets mount lazily (`keyFromFile` re-checks on a TTL),
      // so a key that lands after boot is picked up without a restart — and an
      // absent key degrades exactly like a dead server, which is the correct
      // behaviour on a dev PC. Never an ADMIN or ROOT key.
      // One key source for the client, the health probe and the key-change
      // watcher: it re-stats the file every TTL and the client drops its
      // cache on a 401, so a rotated key is re-read rather than a dead one
      // held forever.
      const reviewerKey = keyFromFile(join(cfg.github.secrets_dir, OV_REVIEWER_KEY_SECRET));
      // The counted `openviking_gap`: every gap counted into the memory
      // block, and a quiet anomaly row at most once an hour per op:code that
      // carries the running count (src/openviking/gapsink.ts).
      const countedGap = countedGapSink({
        record: (gap) => memoryHealth?.recordGap(gap),
        logAnomaly: (kind, pr, roundNo, detail) => d.store.logAnomaly(kind, pr, roundNo, detail),
        log,
      });
      const memoryClient = new OpenVikingClient({
        baseUrl: openVikingBaseUrl(cfg.openviking),
        apiKey: reviewerKey,
        user: cfg.openviking.user,
        account: cfg.openviking.account,
        timeoutMs: cfg.openviking.request_timeout_ms,
        log,
        onGap: countedGap,
        onRequest: (r) => memoryHealth?.recordRequest(r),
      });
      const memory = openVikingStore(memoryClient, {
        defaultCategory: cfg.openviking.default_category,
        cacheTtlMs: cfg.openviking.read_cache_ttl_ms,
        log,
        // The sessions' own recall (vendored openviking-pi patch 0007) excludes
        // retired entries by this list, published beside their ovcli.conf
        // whenever the store's sweep sees it change.
        onRetired: (uris) => {
          writeRetiredUris(sessions.ovRetiredPath(), uris, {
            log: (msg) => log(msg),
          });
        },
        // …starting from the list the last daemon published, so a first sweep
        // that cannot read everything (the server still warming up) adds to
        // the sessions' exclusions and never wipes them.
        initialRetired: readRetiredUrisFile(sessions.ovRetiredPath()),
      });
      feedback = new FeedbackEngine({
        store: d.store,
        timezone: cfg.ops.timezone,
        rebuildAgents,
        memory,
        // Memory switched off: signals are ledgered `skipped`, never owed.
        memoryEnabled: cfg.openviking.enabled,
        log,
      });
      // Same-day [feedback] comments ledgered in the boot gap reach the
      // validator's addendum now (the boot build above may predate them).
      if (feedbackLedgeredEarly) {
        try {
          rebuildAgents();
        } catch (err) {
          log("feedback: agents rebuild for boot-gap signals failed", err);
        }
      }
      memoryStore = memory;
      memorySweep = memory;
      memoryAssembler = openVikingContextAssembler({
        client: memoryClient,
        store: memory,
        // Without quotas the server balances the block across every scope it
        // holds and a round gets about one memory entry beside two built-in
        // scope blurbs. The quotas name the corpus;
        // `context_tokens` stays the budget. See [memory] in config.toml.
        quotas: cfg.memory.context_quotas,
        searchTimeoutMs: cfg.openviking.search_timeout_ms,
        log,
      });

      // The lesson shadow ledger and the round's selection. The
      // ledger (and so the operator's kill switch) always; the selector only
      // where memory is on — with it off there is nothing to select from.
      // (Built before the first agents build — the kill switch decides the
      // validator's lesson addendum; this keeps that same ledger.)
      lessonLedger = lessonLedger ?? new LessonLedger(d.store);
      if (cfg.openviking.enabled && cfg.memory.delivery !== "off") {
        // Its own client — no health observer, no counted gap — so a find
        // the round's budget aborts never reads as memory failing (the
        // health window would otherwise call a slow-but-working server
        // degraded and pause the case writer, the pump and the learner).
        const lessonEngine = openVikingLessonEngine(
          lessonFindClient({
            baseUrl: openVikingBaseUrl(cfg.openviking),
            apiKey: reviewerKey,
            user: cfg.openviking.user,
            account: cfg.openviking.account,
            timeoutMs: cfg.openviking.request_timeout_ms,
            log,
          }),
          memory,
        );
        lessonSelector = new RoundLessonSelector({
          ledger: lessonLedger,
          mode: () => cfg.memory.delivery,
          engine: () => lessonEngine,
          budgetMs: cfg.memory.delivery_budget_ms,
          // The budget follows the mode — `shadow` runs after the
          // handoff and blocks nothing, so it gets its own, looser one.
          shadowBudgetMs: cfg.memory.shadow_budget_ms,
          activity: roundActivity,
          repo: cfg.github.repo,
          log,
        });
      }
      log(
        `lessons: [memory] delivery = ${cfg.memory.delivery}` +
          (cfg.memory.delivery === "on"
            ? lessonSelector
              ? " — DELIVERING: each round awaits its selection beside the memory seed (≤ " +
                `${cfg.memory.delivery_budget_ms} ms); lessons reach the lens task files, the lessons files of the validator and the lenses a session adds, the main session's index and past-review cases, and the recheck/ping-pong repo facts; the validator carries the lesson-shape addendum` +
                (cfg.review.task_files
                  ? ""
                  : " — but `[review] task_files = false`: the planned lenses have no task file, so THEY get no lessons")
              : " — but memory is off ([openviking] enabled = false): nothing to select, nothing delivered"
            : cfg.memory.delivery === "shadow"
              ? ` — selection and the shadow ledger only (after each round's handoff, ≤ ${cfg.memory.shadow_budget_ms} ms); no prompt, task file or agent changes`
              : " — nothing selected, nothing recorded") +
          (lessonLedger.lessonsOff() ? "; the operator's kill switch is OFF" : ""),
      );

      // Reviewer-memory health. "Not monitored" is reserved for memory
      // switched off — `[openviking] enabled = false`, which is what
      // declining memory in onboarding writes. Memory configured on whose
      // server cannot run (a binary missing after a rebuild, a venv path
      // drifted from `[openviking] bin`) is monitored: its probes go
      // unreachable and it reads `down` after `[memory] down_after_min`,
      // because that is an outage, not a choice, and must not be painted
      // like a deliberate off.
      if (!cfg.openviking.enabled) {
        memoryUnmonitored = "[openviking] enabled = false";
      } else {
        // A rotated daemon key reaches the sessions too: their ovcli.conf is
        // rewritten the moment the key changes, not at the next session birth.
        const watchKey = keyChangeWatcher(() => {
          const res = sessions.provisionOvCredentials();
          log(
            `openviking: the reviewer key changed — sessions' ovcli.conf ${res.written ? "rewritten" : "NOT rewritten"}${res.keyed ? "" : ` (${res.reason || "no key"})`}`,
          );
          d.store.logEvent("openviking_key_changed", null, {
            ovcli_written: res.written,
            keyed: res.keyed,
            reason: res.reason,
          });
          // A failed rewrite stays owed: the next probe tick tries again.
          return res.written;
        });
        const probeBase = {
          baseUrl: openVikingBaseUrl(cfg.openviking),
          user: cfg.openviking.user,
          account: cfg.openviking.account,
          timeoutMs: cfg.openviking.request_timeout_ms,
        };
        memoryHealth = new MemoryHealthMonitor({
          probes: {
            daemon: credentialProbe({
              ...probeBase,
              key: () => ({ state: "key", key: reviewerKey() ?? "" }),
            }),
            sessions: credentialProbe({
              ...probeBase,
              key: () => readOvcliKey(sessions.ovcliConfPath()),
            }),
          },
          beforeProbe: () => {
            watchKey(reviewerKey());
          },
          wake: (kind, detail, message) => d.store.logAnomaly(kind, null, null, detail, message),
          draining: () => d.store.drainState().draining,
          // Whether memory serves search — the server's /ready (it runs an
          // embedding probe) and the local embedder. The fs/ls probe needs no
          // embedding, so without this a dead embedder would read healthy
          // while every search failed. Cached, synchronous reads.
          serving: () =>
            memoryServing(
              cfg.openviking.embedding_provider,
              openviking?.status(),
              localEmbedder?.status(),
            ),
          incidents: {
            load: () => d.store.memoryIncident(),
            save: (incident) => d.store.recordMemoryIncident(incident),
          },
          where: {
            daemon: `secrets/${OV_REVIEWER_KEY_SECRET}`,
            sessions: "ovcli.conf in the pi HOME",
          },
          log,
          // Floors: a mistyped 0 must not become a tight probe loop or a
          // wake on every probe.
          intervalMs: Math.max(10, cfg.memory.probe_interval_s) * 1000,
          downAfterMs: Math.max(1, cfg.memory.down_after_min) * 60_000,
          bootGraceMs: Math.max(0, cfg.memory.boot_grace_min) * 60_000,
          rewakeMs: Math.max(1, cfg.memory.rewake_h) * 3_600_000,
        });
        // This boot's provisioning report (the entrypoint ran the script
        // before us): into the block, and one wake per report when it says
        // anything is wrong — keyed by the report's fingerprint, so a daemon
        // restart inside the same container does not repeat it.
        const prov = readProvisionReport(provisionReportPath(root));
        memoryHealth.setProvision(prov);
        raiseProvisionWake(d.store, prov);
        memoryHealth.start();

        // The backfill pump. It writes owed [feedback] signals through the
        // same `note` op on the same store — a retry on the one route, never
        // a second channel — only while health reads healthy, and wakes
        // `memory_write_backlog` past the threshold. Legacy rows (older than the
        // store's legacy cutoff, written under random names) are checked against a complete sweep
        // first (an entry whose write timed out may have landed after all).
        const health = memoryHealth;
        feedbackPump = new FeedbackMemoryPump({
          store: d.store,
          memory,
          healthy: () => health.currentState() === "healthy",
          healthState: () => health.currentState(),
          // Retired entries count as "landed": a legacy signal whose entry was
          // retired since — by the operator, or by the
          // relayout — was written once and must not be written again into
          // events/. (A relayout MOVE leaves the copy live in events/, so it
          // is found among the live entries.)
          readEntries: async () => {
            const sweep = await memory.sweep();
            return {
              entries: [...sweep.entries, ...sweep.retired],
              complete: sweep.unread.length === 0,
            };
          },
          wake: (kind, detail, message) => d.store.logAnomaly(kind, null, null, detail, message),
          log,
          intervalMs: Math.max(10, cfg.memory.backfill_interval_s) * 1000,
          backlogAfterMs: Math.max(1, cfg.memory.write_backlog_after_min) * 60_000,
          rewakeMs: Math.max(1, cfg.memory.rewake_h) * 3_600_000,
        });
        feedbackPump.start();

        // Finding cases: the learner's context. Rendered from state.db
        // (round_findings, the outcome capture's tables, the human replies,
        // the feedback ledger) and written through the same store's
        // `putDocuments` — one batch-write under `finding-cases/` a tick, every case
        // under its own precondition — only while memory reads healthy. Its
        // backfill reads a PR's inline comments through the adapter (a read:
        // never the gate) and runs the outcome capture for PRs nothing
        // captured. Never in a round's search scope; only the daemon's lesson
        // selection reads cases.
        caseWriter = new CaseWriter({
          store: d.store,
          outcomes: d.outcomes,
          memory,
          repo: cfg.github.repo,
          botLogin: cfg.github.bot_login,
          healthy: () => health.currentState() === "healthy",
          // No case batch starts while a review round reads memory (its seed,
          // its lesson selection); every batch sent reports its embedding
          // tail there, which a seed that starts inside it waits out (within
          // its own budget).
          rounds: roundActivity,
          embedTailMsPerCase: cfg.memory.case_embed_tail_ms,
          // While a review round runs or is queued to dispatch,
          // the backfill, the late activity and history cases wait.
          reviews: () => reviewsInFlight(d.store),
          read: adapter,
          log,
          intervalMs: Math.max(10, cfg.memory.cases_interval_s) * 1000,
          backfillDays: Math.max(0, cfg.memory.cases_backfill_days),
        });
        caseWriter.start();

        // The learner: state.db and the base clone's git in,
        // candidates and the EOD packet out; it reads the lessons in force
        // through the same store (only while memory reads healthy) and never
        // writes memory — the curator does, with `viking_write`'s typed
        // `lesson` (vendored patch 0010).
        learner = new Learner({
          store: d.store,
          root,
          eodTime: cfg.eod.time,
          timeZone: cfg.eod.timezone,
          botLogin: cfg.github.bot_login,
          baseBranch: cfg.github.base_branch,
          config: learnerKnobsOf(cfg.memory),
          git: sessions.worktrees,
          lessons: memory,
          healthy: () => health.currentState() === "healthy",
          wake: (kind, detail, message) => d.store.logAnomaly(kind, null, null, detail, message),
          log,
        });
        learner.start();
      }

      // The archiver. Its eligibility asks tmux which sessions live
      // (unknown holds, never "none") and the session manager which births are
      // in flight; its holds read the daemon's own load watch.
      archiver = new Archiver({
        store: d.store,
        cfg: cfg.archive,
        root,
        sessionsRoot: sessions.sessionsRoot(),
        firstHealthyReconcileAt: () => d.firstHealthyReconcileAt(),
        load: () => d.load.status(),
        starvedRatio: eventLoopPolicy(cfg.daemon).starvedRatio,
        liveSessions: () => sessions.tmux.listSessionsKnown(),
        birthInFlight: (pr) => sessions.birthInFlight(pr),
        // The stores that belong to no PR. The overseer's birth record
        // says which of its files is current (unreadable = unknown = nothing
        // moves); pi's global store lies under the container user's home.
        overseerBornAt: () => sessions.bornAt(OVERSEER_SESSION) ?? null,
        piGlobalDir: piGlobalSessionsDir(),
        log,
      });
      archiver.start();
      // A reopened PR's archive comes back before its session is born:
      // both birth paths await this, bounded, and never refuse the birth.
      const archiveRef = archiver;
      sessions.setBeforeBirth((pr) => archiveRef.beforeBirth(pr));

      // Adopt live sessions + sweep stale worktrees (never kills a live session).
      const active = d.store
        .allPrs()
        .filter((p) => p.state !== "closed")
        .map((p) => p.number);
      const pre = await sessions.preflight(active);
      log(
        `preflight: adopted=${pre.adoption.adopted.join(",") || "none"} swept-worktrees=${pre.sweptWorktrees.join(",") || "none"}`,
      );

      // Rounds still marked running whose session did not survive the restart
      // are phantoms: cancel them, requeue the ones whose work was truly lost.
      const orphans = reconcileOrphanedRounds(d.store, pre.adoption.prs, {
        botLogin: cfg.github.bot_login,
        log,
      });
      if (orphans.cancelled.length) {
        log(
          `startup: cancelled orphaned rounds on #${orphans.cancelled.join(", #")}; requeued ${orphans.requeued.length}`,
        );
      }

      // The overseer exists from boot, so `tmux attach -t overseer` works
      // after every restart rather than only after the first anomaly.
      try {
        await sessions.ensureOverseerSession();
        log("overseer session ready");
      } catch (err) {
        log("overseer spawn failed (will retry on first wake)", err);
      }

      // Overseer command files → validated execution (whitelist + caps).
      const leverDeps: LeverDeps = {
        store: d.store,
        levers: cfg.levers,
        timezone: cfg.ops.timezone,
      };
      const commandDeps: CommandDeps = {
        async rerunRound(pr) {
          return recoverPrForOperator({ store: d.store, pump: () => d.pump() }, pr, "rerun-round");
        },
        async restartSession(target) {
          if (target === "overseer") {
            const name = await sessions.rotateOverseer();
            return { ok: true, respawned: name };
          }
          return recoverPrForOperator(
            {
              store: d.store,
              pump: () => d.pump(),
              killSession: async (pr) => {
                const name = `pr-${pr}`;
                if (await sessions.tmux.hasSession(name)) await sessions.tmux.killSession(name);
                if (await sessions.tmux.hasSession(name)) {
                  throw new Error(
                    `session ${name} survived operator restart; refusing ownership reset`,
                  );
                }
              },
            },
            target,
            "restart-session",
          );
        },
        resolveTerminalFailure(payload) {
          return resolveTerminalFailure(
            {
              store: d.store,
              getPrDisposition: (pr) => adapter.getPrDisposition(pr),
            },
            payload,
          );
        },
        // The two bounded levers: who is asking comes from the
        // watcher's channel, and a session's hold is capped, budgeted and
        // expiring in src/levers.ts — an operator's is not.
        pausePr(pr, reason, issuer, forMin) {
          return pauseLever(leverDeps, pr, reason, issuer, forMin);
        },
        resumePr(pr, issuer) {
          return resumeLever(leverDeps, pr, issuer, () => d.pump());
        },
        flagOwner(message) {
          const flags = join(root, "state", "flags");
          mkdirSync(flags, { recursive: true });
          // owner.log; older entries live on in the legacy owner-legacy.log,
          // which nothing writes.
          appendFileSync(join(flags, "owner.log"), `${new Date().toISOString()} ${message}\n`);
          d.store.logEvent("flag_owner", null, { message });
          return { ok: true };
        },
        fileImprovementPr(payload) {
          return fileImprovementPr(payload, {
            cfg,
            adapter,
            gate,
            store: d.store,
            run: gitRun,
            // The reviewed repo's base clone — the one tree with `origin`
            // pointing at the reviewed repo and the session's branch in it.
            ensureRepoDir: () => sessions.worktrees.ensureBaseClone(),
          });
        },
        fileIssue(payload) {
          return fileIssue(payload, { cfg, adapter, gate, store: d.store });
        },
        retryThreadDecision(commentId) {
          return d.retryThreadDecision(commentId);
        },
        // The operator's lesson kill switch — reached only for a command the
        // sealed commands/operator/ channel delivered (commands.ts refuses
        // every other issuer, twice). State in state.db.
        lessonSwitch(change, file) {
          if (!lessonLedger)
            return { ok: false, reason: "the lesson ledger is not built on this daemon yet" };
          const r = lessonLedger.apply(change, file);
          lessonStatusCache = null;
          // The validator's lesson addendum is composed only
          // while the kill switch is on — so flipping it rebuilds the agents,
          // the way a [feedback] comment does for its addendum. Suppressing
          // one lesson needs no rebuild: the selector reads it every round.
          if (r.changed && (change.action === "off" || change.action === "on")) {
            try {
              rebuildAgents();
            } catch (err) {
              log("lessons: agents rebuild after the kill switch flipped failed", err);
            }
          }
          return {
            ok: true,
            changed: r.changed,
            lessons_off: r.lessons_off,
            suppressed: r.suppressed.length,
            ...("uri" in change ? { uri: change.uri } : {}),
          };
        },
        // The operator's archive verbs — reached only for a
        // command the sealed commands/operator/ channel delivered (commands.ts
        // refuses every other issuer, twice). Each runs under the archiver's
        // strict mutex and answers within OPERATOR_WAIT_MS; `archiver` is read
        // at call time, never captured at wiring.
        archiveRun() {
          if (!archiver)
            return { ok: false, reason: "the archiver is not built on this daemon yet" };
          return archiver.operatorRun();
        },
        archiveRestore(pr) {
          if (!archiver)
            return { ok: false, reason: "the archiver is not built on this daemon yet" };
          return archiver.operatorRestore(pr);
        },
        // The EOD curator's receipt for the day's outcomes packet.
        // `learner` is read at call time, never captured at wiring.
        curationReceipt(receipt) {
          return routeCurationReceipt(learner, receipt);
        },
        // Deploy-window drain. On = the webhook answers 200 and drops, the
        // pump starts nothing, recheck/ping-pong/EOD hold — in-flight rounds
        // finish naturally. Off is the manual lift; the automatic one is the
        // next boot's first healthy reconcile pass (daemon.ts). Never touches
        // GitHub, never goes near the gate.
        drain(on, issuer, forMin) {
          return drainLever(leverDeps, on, issuer, forMin, async () => {
            d.wakeThreadDecisions();
            await d.pump();
          });
        },
      };
      // The Slack concierge. Off by default; when on it owns its own
      // tier-checked command dir, the socket, and every unprompted post. It is
      // started before the legacy watcher because that watcher borrows two
      // things from it: the reply handler and the origin lookup.
      slack =
        (await startSlack({
          cfg,
          root,
          store: d.store,
          commandDeps,
          injectOverseerFile: (m) => sessions.injectOverseerFile(m),
          injectOverseer: (m) => wakeOverseerAsDaemon("slack-anomaly", m),
          origins,
          log,
          version: packageVersion(root),
        })) ?? null;
      if (slack) log("slack: concierge live (socket mode; commands/slack tier-checked)");

      commands = buildLocalCommandWatcher({
        root,
        deps: commandDeps,
        store: d.store,
        slack,
        log: (l) => log(l),
      });
      await commands.start();
      operatorCommands = buildOperatorCommandWatcher({
        root,
        deps: commandDeps,
        store: d.store,
        slack,
        log: (l) => log(l),
      });
      await operatorCommands.start();

      // Webhook-URL self-heal: only under the tunnel-file ingress shape. The
      // gated PATCH rides the app-self-config class, so it executes even in
      // dry-run (CLAUDE.md rule 1) — loudly.
      if (cfg.ingress.shape === "tunnel-file") {
        webhookHeal = new WebhookHealer({
          hostnameFile: ingressHostnameFile(cfg, root),
          readConfig: () => adapter.getAppWebhookConfig(),
          updateUrl: (newUrl, oldUrl) => adapter.updateOwnWebhookUrl(newUrl, oldUrl),
          logEvent: (kind, payload) => d.store.logEvent(kind, null, payload),
          anomaly: (detail) => d.store.logAnomaly("webhook_heal", null, null, detail, detail),
          log,
          debounceMs: cfg.ingress.debounce_ms,
          sweepIntervalMs: cfg.ingress.sweep_interval_s * 1000,
        });
        webhookHeal.start();
        log(`webhookheal: watching ${ingressHostnameFile(cfg, root)} (ingress shape tunnel-file)`);
      }

      // Daemon-clock EOD ([eod]-timezone wall time; pi schedulers deliberately unused).
      // Curation must never touch the owner's pinned entries. The watchdog
      // fingerprints the pinned area around the sweep and raises an anomaly on
      // any change. It wraps the inject rather than hooking inside
      // the timer, so a broken watchdog can never skip the sweep.
      const sweepSource = memorySweep;
      pinWatch =
        cfg.eod.pinned_watchdog && sweepSource
          ? startEodPinWatch({
              readPinned: readPinnedFromSweep(sweepSource),
              logAnomaly: (kind, pr, reason, detail, injectMessage) =>
                d.store.logAnomaly(kind, pr, reason, detail, injectMessage),
              timeZone: cfg.eod.timezone,
              digestReady: (date) => digestWritten(date, join(root, "digest")),
              windowMin: cfg.eod.pinned_watchdog_window_min,
              log,
            })
          : null;
      const injectEod = async (m: string): Promise<void> => {
        await wakeOverseerAsDaemon("eod-sweep", m);
      };
      eod = startEodTimer({
        timeHHMM: cfg.eod.time,
        timeZone: cfg.eod.timezone,
        readPrompt: promptReader(join(root, "prompts", "eod-sweep.md")),
        identity,
        // The day's cancellation summary rides the sweep prompt so the
        // digest actually mentions cancellations (grouped, loud first, "none"
        // explicit) — and the learner's outcomes packet, built here, at the
        // fire (a mine first when the day's has not run) — whose pointer the
        // digest carries and whose curation instructions render after the
        // seed. A learner that throws costs the packet, never the sweep.
        dayContext: async (date) => {
          const cancelled = eodDigestContext(d.store, date, cfg.eod.timezone);
          if (!learner) return cancelled;
          try {
            const prep = await learner.prepareEod(date);
            return { lines: `${cancelled}\n${prep.lines}`, curation: prep.curation };
          } catch (err) {
            log(`learner: the outcomes packet for ${date} failed`, err);
            return cancelled;
          }
        },
        // The curator learns the memory layout here — the seed is frozen and
        // names only some areas.
        ...(cfg.openviking.enabled ? { memoryLayout: MEMORY_LAYOUT_NOTE } : {}),
        // The seed starts §1 from "Outcomes to curate" and closes it with the
        // receipt, so a sweep the packet did not reach says why in that
        // section instead of dropping it: no learner on this daemon, or a
        // packet that failed or missed the wait.
        noCuration: (date) => renderNoPacketSection(date, learner ? "unavailable" : "off"),
        // Deploy-window drain: the sweep does not fire into a board being
        // drained for a deploy — it is deferred: the day is persisted in
        // state.db and fires once the drain lifts, across a restart too.
        shouldHold: () => d.store.drainState().draining,
        // One sweep at a time: while the pinned-area watch window of the
        // last sweep is open, the next day (a deferred one above all — they
        // queue back to back after a drain) waits behind it, so each window
        // judges its own day's work under its own date.
        sweepInFlight: () => pinWatch?.isOpen() === true,
        deferred: {
          load: () => d.store.eodDeferredDates(),
          save: (dates) => d.store.recordEodDeferred(dates),
        },
        onHeld: (date, why) => {
          d.store.logEvent(
            why === "draining" ? "eod_deferred_draining" : "eod_deferred_behind_sweep",
            null,
            { date },
          );
          log(
            why === "draining"
              ? `EOD sweep for ${date} deferred — draining; it fires once the drain lifts`
              : `EOD sweep for ${date} deferred — an earlier sweep is still in flight; it fires after`,
          );
        },
        onDeferredFire: (date) => {
          d.store.logEvent("eod_deferred_fired", null, { date });
          log(`EOD sweep for ${date} firing — the drain that deferred it has lifted`);
        },
        injectOverseer: pinWatch ? pinWatch.wrapInject(injectEod) : injectEod,
        onFire: (date) => {
          log(`EOD sweep injected for ${date}`);
          // The receipt for the day's packet is owed from now.
          learner?.eodFired(date);
        },
        onError: (err) => log("EOD injection failed (retried with backoff)", err),
        // Three retries failed too: the day's curation did not happen.
        onInjectFailed: (date, err, attempts) => {
          const why = err instanceof Error ? err.message : String(err);
          d.store.logAnomaly(
            "eod_inject_failed",
            null,
            null,
            `EOD sweep for ${date} not injected after ${attempts} attempts: ${why.slice(0, 200)}`,
            [
              `EOD INJECT FAILED — the EOD sweep for ${date} could not be delivered to the overseer (${attempts} attempts, backed off).`,
              `Last error: ${why.slice(0, 300)}`,
              "That day's curation did not run: no digest, no lessons. Check the overseer session (`qcr status`), then re-run the sweep by hand if the day matters.",
            ].join("\n"),
          );
        },
      });
      log(`EOD timer armed for ${eod.nextFire().toISOString()}`);

      // Daily overseer heartbeat — same wall-clock machinery,
      // morning slot. At most one boot catch-up if the daemon was down at the
      // hour; the fired-date lives in the store, so restarts never double-fire.
      heartbeat = startHeartbeat({
        timeHHMM: cfg.eod.heartbeat_time,
        timeZone: cfg.eod.timezone,
        lastFired: () => d.store.lastHeartbeatDate(),
        recordFired: (date) => d.store.recordHeartbeat(date),
        injectOverseer: (m) => wakeOverseerAsDaemon("overseer-heartbeat", m),
        log,
        onError: (err) => log("heartbeat injection failed", err),
      });
      log(`heartbeat armed for ${heartbeat.nextFire().toISOString()}`);

      // Weekly overseer rotation, checked hourly.
      const rotation = setInterval(() => {
        void sessions
          .rotateOverseerIfDue()
          .then((rotated) => {
            if (rotated) log("overseer rotated (weekly)");
          })
          .catch((err) => log("overseer rotation failed", err));
      }, 3600_000);
      rotation.unref?.();

      // Expire a stale same-day feedback addendum promptly on the
      // ops-day change — a 5-minute string compare, so yesterday's items
      // bite at most minutes into a new day, not an hour.
      const dayCheck = setInterval(() => {
        try {
          agentsDay.tick();
        } catch (err) {
          log("feedback: day-change agents rebuild failed", err);
        }
      }, 300_000);
      dayCheck.unref?.();
    },

    async onStop(reason = "shutdown") {
      memoryHealth?.stop();
      feedbackPump?.stop();
      caseWriter?.stop();
      learner?.stop();
      archiver?.stop();
      // The lesson selections in flight. A shadow one is cut now and records
      // nothing (`stop`): its budget — `shadow_budget_ms`, up to 20 s — does
      // not fit docker's 10 s stop grace beside the server's own 5 s, and a
      // record cut short by our stop would read as the engine's. An awaited
      // one (`on`) is not cut: it settles within `delivery_budget_ms`
      // (≤ 2 s); let it record before the server and the store go. The wait
      // follows that budget, never the shadow one.
      if (lessonSelector) {
        const selector = lessonSelector;
        lessonSelector = null;
        selector.stop();
        await Promise.race([
          selector.idle(),
          new Promise<void>((r) => setTimeout(r, cfg.memory.delivery_budget_ms + 500).unref?.()),
        ]);
      }
      eod?.stop();
      // Its open window polls the pinned area; drop it before the server goes.
      pinWatch?.stop();
      heartbeat?.stop();
      commands?.stop();
      operatorCommands?.stop();
      webhookHeal?.stop();
      webhookHeal = null;
      reembed?.stop();
      reembed = null;
      // SIGTERM then SIGKILL after a bounded grace — a memory engine must not
      // be able to hold the daemon's exit open.
      if (openviking) {
        try {
          await openviking.stop();
        } catch (err) {
          log("openviking: shutdown failed", err);
        }
        openviking = null;
      }
      // After the server: it may still be vectorizing on its way down.
      if (localEmbedder) {
        try {
          await localEmbedder.stop();
        } catch (err) {
          log("openviking: local embedder shutdown failed", err);
        }
        localEmbedder = null;
      }
      // Runs before the store closes, so the goodbye is ledgered; bounded by
      // the announcer itself, so it can never delay the exit.
      if (slack) {
        try {
          await slack.stop(reason);
        } catch (err) {
          log("slack: shutdown failed", err);
        }
        slack = null;
      }
    },
  });

  // Posting-time guards live on the gate, so every posting route in
  // the daemon — session review, approval path, migration pre-check comment —
  // passes through them. They need the store, which only exists once the
  // daemon has been built; hence the setter here rather than in buildParts().
  gate.setGuard(
    makePostingGuard({
      store: daemon.store,
      adapter,
      botLogin: cfg.github.bot_login,
      guards: cfg.guards,
      log,
    }),
  );

  return daemon;
}

async function main(): Promise<void> {
  const daemon = createProductionDaemon();
  const shutdown = (sig: string) => {
    void (async () => {
      console.log(`[quickreviewd] ${sig} — shutting down`);
      await daemon.stop();
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  try {
    await daemon.start();
  } catch (err) {
    // A failed boot (onStart is fatal — daemon.ts) exits non-zero after an
    // orderly stop, so the container's restart policy retries it rather than
    // leaving a half-assembled daemon serving reviews without its watchers.
    console.error("[quickreviewd] startup failed — exiting", err);
    await daemon.stop().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("wire.js")) {
  void main();
}
