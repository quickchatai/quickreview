// Production assembly of quickreviewd: createDaemon() with the real pi session
// manager, the round-template renderer, the agents build step, the EOD timer,
// the overseer command executor, and the weekly overseer rotation. `npm run
// daemon` runs this; createDaemon() alone (src/daemon.ts) stays the
// stub-wired, test-friendly core.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
import { createDaemon, type Daemon } from "./daemon.js";
import { digestWritten, eodDigestContext, latestDigestHeadline } from "./digest.js";
import { startHeartbeat, type HeartbeatTimer } from "./anomalies.js";
import { opsDay, promptReader, startEodTimer, type EodTimer } from "./eod.js";
import { MutationGate, type MutationIntent } from "./gate.js";
import { GitHubAdapter } from "./github.js";
import { makePostingGuard } from "./guards.js";
import { TokenMinter } from "./githubAuth.js";
import { FeedbackEngine, dayScopedRebuild, feedbackDayAddendum, type FeedbackEvent } from "./feedback.js";
import {
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
  identityVars,
  passTierModels,
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
import { fileImprovementPr, fileIssue, gitRunner } from "./improvements.js";
import {
  OpenVikingClient,
  OpenVikingSupervisor,
  ReembedDriver,
  keyFromFile,
  openVikingContextAssembler,
  openVikingStore,
} from "./openviking/index.js";
import { OV_REVIEWER_KEY_SECRET, openVikingSessionLifecycle } from "./memory/ovsession.js";
import type { ContextAssembler, RoundMemory } from "./memory/context.js";
import { recoverPrForOperator } from "./operator-recovery.js";
import { resolveTerminalFailure } from "./terminal-failure.js";
import type { MemoryStore } from "./memory/store.js";
import { readPinnedFromSweep, startEodPinWatch, type PinnedSweepSource } from "./eodpinwatch.js";
import { reconcileOrphanedRounds } from "./reconcile.js";
import { PiSessionManager } from "./sessions.js";
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
  roundTemplateFile,
} from "./templates.js";
import { nodeExec } from "./tmux.js";
import type { RoundOrder, SessionHooks } from "./types.js";
import { WebhookHealer } from "./webhookheal.js";

export interface ProductionParts {
  cfg: Config;
  root: string;
  minter: TokenMinter;
  gate: MutationGate;
  adapter: GitHubAdapter;
  sessions: PiSessionManager;
}

export function buildParts(root = sandboxRoot(), loaded = loadConfig()): ProductionParts {
  // the profile's per-lens tuning overlays the parsed config ONCE,
  // here, so every consumer downstream (the plan, the agents build, the
  // round row) reads the one resolved `cfg.lenses` — the profile wins over
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
  // USER key — never ADMIN/ROOT. Both directions are total, so a store that is
  // down or unkeyed costs the raw tier and never a session.
  const ovSessions = openVikingSessionLifecycle(
    new OpenVikingClient({
      baseUrl: openVikingBaseUrl(cfg.openviking),
      apiKey: keyFromFile(join(cfg.github.secrets_dir, OV_REVIEWER_KEY_SECRET)),
      user: cfg.openviking.user,
      account: cfg.openviking.account,
      timeoutMs: cfg.openviking.request_timeout_ms,
    }),
  );
  const sessions = new PiSessionManager({
    cfg,
    root,
    ovSessions,
    configPath: liveConfigPath(),
  });
  return { cfg, root, minter, gate, adapter, sessions };
}

// exit-code checked, cwd mandatory — the first runner returned stdout
// whatever git's exit and defaulted to the daemon's own cwd (a repo with no
// remote), so the improvement channel could never push and never said so.
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

// ---- the Slack concierge (S5b) ------------------------------------
//
// Everything Slack is assembled HERE and nowhere else, because this is the one
// module allowed to read the two tokens off disk. Three properties the shape
// enforces rather than documents:
//
//   * `[slack] enabled = false` ⇒ this function returns before it touches a
//     secret reader, a socket or a clock. Nothing is constructed, so nothing
//     can post, and the daemon is byte-for-byte its legacy self.
//   * A missing token, a malformed [slack] block or an auth.test that cannot
//     name us is a HARD boot error. A bot that cannot identify itself cannot
//     filter its own echoes — running anyway is a loop risk, not a degraded
//     mode.
//   * Socket Mode is the ONLY inbound transport. There is no HTTP route here
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
   * builds it BEFORE the daemon so daemon-originated overseer wakes can stamp a
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

  // Who are we? Resolved ONCE, and required: the router's echo filter is built
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
 * the BELT gate is installed — when the turn being served was caused by a
 * non-owner Slack message, the legacy dir refuses, so a tier-checked command
 * cannot slip past by being written to the wrong place. Slack off ⇒ no tier
 * gate at all, i.e. exactly the legacy watcher.
 *
 * The gate reads `latestAny()`, NOT `latest()`: the belt must not lift merely
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
 * The OPERATOR's command watcher: `commands/operator/`, the
 * directory `qcr drain`, the board's `u` and the deploy tab write AS ROOT.
 * Same vocabulary, same handlers; the difference is the issuer the watcher
 * stamps, and only the real process seal decides it. The same local Slack
 * belt as `commands/` is installed, and binds ONLY files the seal does not
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
 * The OTHER half of "who caused this turn": every daemon-originated overseer
 * wake stamps a `local` origin before it injects.
 *
 * One wrapper, one seam. The daemon is handed the returned `hooks`, so the EOD
 * sweep, the verdict anomalies, the ping-pong follow-ups and the connections
 * signal all stamp — without any of those modules knowing Slack exists. The
 * Slack router deliberately keeps the UNWRAPPED inject path: its turns must
 * stamp a Slack origin.
 *
 * Stamping is best-effort and never blocks a wake; with Slack off nothing is
 * written at all.
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
      // Liveness + kill must survive the wrap: dropping sessionAlive here left
      // the stuck-round detector blind in production (liveness always
      // unknown ⇒ every stuck round parked). Found 2026-08-19.
      ...(hooks.sessionAlive ? { sessionAlive: (pr: number) => hooks.sessionAlive!(pr) } : {}),
      ...(hooks.killSession ? { killSession: (pr: number) => hooks.killSession!(pr) } : {}),
      ...(hooks.sessionActivityAt
        ? { sessionActivityAt: (pr: number) => hooks.sessionActivityAt!(pr) }
        : {}),
      ...(hooks.injectPending ? { injectPending: (pr: number) => hooks.injectPending!(pr) } : {}),
      // Receipt/replay hooks are the command supervisor's positive evidence
      // and safe recovery path. Dropping them here made production exhaust a
      // failed ordinary wake at 0/N without attempting same-command replay.
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
      injectOverseer: (message) => wake("overseer-wake", message),
    },
  };
}

/**
 * Where the passive auth watch looks. PR and overseer sessions are spawned
 * with `--session-dir <root>/<pi.session_dir>/<session>`, so THAT is where
 * their expired-token errors land — watching pi's default store alone left
 * the watch blind to every reviewer session. The default store under the
 * container user's home (the pihome volume) stays covered for anything spawned
 * without an explicit dir.
 */
export function piAuthWatchDirs(sessions: Pick<PiSessionManager, "sessionsRoot">): string[] {
  return [sessions.sessionsRoot(), join(homedir(), ".pi", "agent", "sessions")];
}

export function createProductionDaemon(parts: ProductionParts = buildParts()): Daemon {
  const { cfg, root, gate, adapter, sessions } = parts;
  const log = (msg: string, extra?: unknown) => console.log(`[quickreviewd] ${msg}`, extra ?? "");

  // The daemon's ONE memory store, built in onStart once secrets are readable.
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

  // the profile-selected ecosystem seam, loaded ONCE at assembly (a
  // malformed profile.toml fails the boot loudly). It decides the tier-forcing
  // migration gate, the round pre-check and the prompt's migration-gate prose;
  // "none" (no profile, no file, no key) runs none of that machinery.
  const ecosystem = ecosystemFor(loadProfileEcosystem(root, cfg.review.profile));
  log(`profile ${cfg.review.profile || "(none)"}: ecosystem ${ecosystem.name}`);

  // the identity variable map every prompt render and agent build
  // resolves {{owner_name}}/{{repo}}/{{bot_login}} against.
  const identity = identityVars(cfg);
  const renderPrompt = (order: RoundOrder, memory: RoundMemory): string =>
    renderRoundPrompt(
      readFileSync(join(root, "prompts", roundTemplateFile(order.round_type)), "utf8"),
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
  // built in onStart (it needs the store). Signals arriving in the
  // boot gap between the webhook binding and onStart are dropped with a log —
  // the tuning loop is best-effort, never lifecycle.
  let feedback: FeedbackEngine | null = null;
  // the OpenViking server, supervised as a child of this process.
  // Started FIRST in onStart so it warms up while the agents build — but never
  // awaited: there is deliberately NO boot ordering, and rounds run
  // memory-less until `/ready` passes.
  let openviking: OpenVikingSupervisor | null = null;
  // the embedder migration's daemon half — resumes the re-embed of
  // reviewer memory the entrypoint's `prepare` journalled, once /ready passes.
  // Timer-armed, never awaited; its block rides inside the heartbeat's
  // `openviking` entry.
  let reembed: ReembedDriver | null = null;
  // the webhook-URL self-heal. Only ever constructed when [ingress]
  // shape = "tunnel-file" — a daemon without the tunnel shape configured
  // never starts the watcher.
  let webhookHeal: WebhookHealer | null = null;

  // The origin store is built HERE, before the daemon, because both halves of
  // "who caused this turn" write to it: the router (Slack turns) and every
  // daemon-originated overseer wake below (local turns).
  const origins = new OriginStore(join(root, "state", "slack", "origin"));

  // The daemon sees a WRAPPED SessionHooks (see `daemonOriginWakes`): every
  // autonomous overseer wake stamps a `local` origin, so the legacy-dir belt
  // knows the turn is the daemon's own.
  const { hooks, wake: wakeOverseerAsDaemon } = daemonOriginWakes({
    hooks: sessions,
    origins,
    enabled: cfg.slack.enabled,
    log,
  });

  // the profile's lens-heuristics extension, loaded ONCE here so a
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
      alertCooldownMin: cfg.memory.alert_cooldown_min,
    },
    renderRecheckPrompt: renderRecheck,
    // Conflict resolutions are never trivial (the owner, 2026-08-19): git-level
    // auto-merge comparison in the base clone names the hand-resolved files.
    resolvedFilesInMerges: (from, to, pr) => sessions.worktrees.resolvedFilesInMerges(from, to, pr),
    // One network fetch per round, before the order is built: the PR head and
    // the branch it targets, together. Everything downstream (prompt, session,
    // passes) then works from the shas this returns.
    prepareWorktree: (pr, baseRef) => sessions.worktrees.ensureWorktree(pr, { baseRef }),
    // Third-party sources at the PR's locked versions, unpacked into a cache
    // on the state volume for the passes to read (`[review]
    // dependency_sources`, benchmark 2026-09-26). Download and unpack only;
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
    // journal (one small synchronous file read per heartbeat).
    openvikingStatus: () => {
      const status = openviking?.status();
      return status && reembed ? { ...status, reembed: reembed.status() } : status;
    },

    // The [feedback] tuning loop.
    onFeedback: async (e: FeedbackEvent) => {
      if (!feedback) {
        log("feedback: signal before engine ready — dropped", e.kind);
        return;
      }
      await feedback.ingest(e);
    },

    async onStart(d) {
      // OpenViking first and unawaited: the server takes seconds to
      // become ready, so it starts warming while everything below builds. A
      // missing binary (any dev PC) is reported once and never retried; a
      // crash is respawned on a capped backoff ladder, forever.
      openviking = new OpenVikingSupervisor({
        cfg: cfg.openviking,
        log,
        // The reviewer's memory root does not exist on a fresh server until
        // something creates it. The TUI does this for the companion's sake;
        // the daemon does it here for its own, each time the server comes up,
        // so the round path's first sweep lists a real (empty) tree instead
        // of leaning on how the server spells a missing one.
        onReady: () => {
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
      // the build composes in the SAME-DAY feedback addendum when
      // today carries [feedback] comments — validator-scoped, demotion-only,
      // regenerated on every ingest and expired on ops-day change (the
      // hourly tick below), so a mid-day restart picks today's feedback up
      // and yesterday's never leaks into a new day.
      // the repo-profile addenda pack, loaded ONCE at assembly so a
      // malformed pack fails the boot loudly (never a silent skip) and every
      // rebuild composes the same bytes. Composition order is fixed here:
      // built-in generics, then the profile pack, then the same-day feedback
      // addendum last.
      const profileAddenda = loadProfileAddenda(root, cfg.review.profile);
      if (cfg.review.profile !== "") {
        log(`profile ${cfg.review.profile}: ${profileAddenda.length} addenda loaded`);
        const tuned = Object.keys(cfg.lenses ?? {});
        if (tuned.length) log(`profile ${cfg.review.profile}: lens tuning for ${tuned.join(", ")}`);
      }
      // The day is marked built only once the build LANDS (dayScopedRebuild):
      // a throw on the day-change tick is retried by the next tick instead of
      // leaving yesterday's feedback addendum in force all day.
      const agentsDay = dayScopedRebuild(
        () => opsDay(cfg.ops.timezone),
        (buildDay) => {
          const fb = feedbackDayAddendum(d.store.feedbackCommentsForDay(buildDay), buildDay);
          const built = buildAgents(join(root, "agents"), join(root, "state", "agents"), {
            root,
            tiers: cfg.models.tiers,
            riskPasses: cfg.models.risk_passes,
            validateTier: cfg.models.validate_tier,
            vars: identity,
            // ecosystem-gated addenda follow the profile's selection.
            ecosystem: ecosystem.name,
            // a lens's profile `effort` rides the per-variant hook;
            // `[models.pass_tiers]` pins move a lens's tier on top of it.
            models: passTierModels(
              cfg.models.pass_tiers,
              cfg.models.tiers,
              lensModelOverrides(cfg.models, cfg.lenses),
            ),
            addenda: [
              ...PASS_ADDENDA,
              ...configAddenda(cfg.review),
              ...profileAddenda,
              // the profile's `emphasis` / `max_severity`, compiled.
              ...lensTuningAddenda(cfg.lenses),
              // The profile's `[posting]` policy, compiled for the validator.
              ...postingPolicyAddenda(cfg.posting),
              ...(fb ? [fb] : []),
            ],
          });
          log(
            `built ${built.length} pass agents into state/agents${fb ? " (+ same-day feedback addendum)" : ""}`,
          );
        },
      );
      const rebuildAgents = agentsDay.rebuild;
      rebuildAgents();
      // Reviewer memory: the ONE daemon-side `MemoryStore`, over the
      // supervised OpenViking server on loopback. The reviewer USER key is
      // read from the secrets mount lazily (`keyFromFile` re-checks on a TTL),
      // so a key that lands after boot is picked up without a restart — and an
      // ABSENT key degrades exactly like a dead server, which is the correct
      // behaviour on a dev PC. Never an ADMIN or ROOT key.
      const memoryClient = new OpenVikingClient({
        baseUrl: openVikingBaseUrl(cfg.openviking),
        apiKey: keyFromFile(join(cfg.github.secrets_dir, OV_REVIEWER_KEY_SECRET)),
        user: cfg.openviking.user,
        account: cfg.openviking.account,
        timeoutMs: cfg.openviking.request_timeout_ms,
        log,
        onGap: (gap) => log("openviking gap", gap),
      });
      const memory = openVikingStore(memoryClient, {
        defaultCategory: cfg.openviking.default_category,
        cacheTtlMs: cfg.openviking.read_cache_ttl_ms,
        log,
      });
      feedback = new FeedbackEngine({
        store: d.store,
        timezone: cfg.ops.timezone,
        rebuildAgents,
        memory,
        log,
      });
      memoryStore = memory;
      memorySweep = memory;
      memoryAssembler = openVikingContextAssembler({
        client: memoryClient,
        store: memory,
        // WITHOUT quotas the server balances the block across every scope it
        // holds and a round gets ~one memory entry beside two built-in scope
        // blurbs (measured 2026-08-21). The quotas name the corpus;
        // `context_tokens` stays the budget. See [memory] in config.toml.
        quotas: cfg.memory.context_quotas,
        searchTimeoutMs: cfg.openviking.search_timeout_ms,
        log,
      });

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

      // The overseer must exist from boot — lazily spawning it on the first
      // anomaly left `tmux attach -t overseer` dead after every restart.
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
          // owner.log (pre-rename entries live on in owner-legacy.log,
          // which nothing writes any more).
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
            // The reviewed repo's base clone — the ONE tree with `origin`
            // pointing at the reviewed repo and the session's branch in it.
            ensureRepoDir: () => sessions.worktrees.ensureBaseClone(),
          });
        },
        fileIssue(payload) {
          return fileIssue(payload, { cfg, adapter, gate, store: d.store });
        },
        // Deploy-window drain (2026-08-25). ON = the webhook answers 200 and
        // drops, the pump starts nothing, recheck/ping-pong/EOD hold —
        // in-flight rounds finish naturally. OFF is the manual lift; the
        // automatic one is the next boot's first healthy reconcile pass
        // (daemon.ts). Never touches GitHub, never goes near the gate.
        retryThreadDecision(commentId) {
          return d.retryThreadDecision(commentId);
        },
        drain(on, issuer, forMin) {
          return drainLever(leverDeps, on, issuer, forMin, async () => {
            d.wakeThreadDecisions();
            await d.pump();
          });
        },
      };
      // The Slack concierge. Off by default; when on it owns its own
      // tier-checked command dir, the socket, and every unprompted post. It is
      // started BEFORE the legacy watcher because that watcher borrows two
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

      // Webhook-URL self-heal: only under the tunnel-file ingress
      // shape. The gated PATCH rides the app-self-config class, so it executes
      // even in dry-run (ratified rule-1 amendment, 2026-08-30) — loudly.
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
      // Curation must never touch the owner's pinned entries. The
      // watchdog fingerprints the pinned area around the sweep and raises an
      // anomaly on any change. It WRAPS the inject rather than hooking inside
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
        // the day's cancellation summary rides the sweep prompt so
        // the digest actually mentions cancellations (grouped, loud first,
        // "none" explicit).
        dayContext: (date) => eodDigestContext(d.store, date, cfg.eod.timezone),
        // Deploy-window drain: the sweep does not fire into a board being
        // drained for a deploy — skipped for the day, loudly.
        shouldHold: () => d.store.drainState().draining,
        onHeld: (date) => {
          d.store.logEvent("eod_skipped_draining", null, { date });
          log(`EOD sweep for ${date} skipped — draining`);
        },
        injectOverseer: pinWatch ? pinWatch.wrapInject(injectEod) : injectEod,
        onFire: (date) => log(`EOD sweep injected for ${date}`),
        onError: (err) => log("EOD injection failed", err),
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

      // expire a stale same-day feedback addendum promptly on the
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
      eod?.stop();
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

  // Posting-time guards live ON the gate, so every posting route in
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
    // A failed boot (onStart is fatal — daemon.ts) exits NON-ZERO after an
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
