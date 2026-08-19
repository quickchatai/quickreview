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
  loadConfig,
  sandboxRoot,
  slackTokenPath,
  validateSlackConfig,
  type Config,
  type SecretReader,
} from "./config.js";
import { CommandWatcher, type CommandDeps } from "./commands.js";
import { createDaemon, type Daemon } from "./daemon.js";
import { latestDigestHeadline } from "./digest.js";
import { startHeartbeat, type HeartbeatTimer } from "./anomalies.js";
import { promptReader, startEodTimer, type EodTimer } from "./eod.js";
import { MutationGate, type MutationIntent } from "./gate.js";
import { GitHubAdapter } from "./github.js";
import { makePostingGuard } from "./guards.js";
import { TokenMinter } from "./githubAuth.js";
import { buildAgents } from "./include.js";
import { fileImprovementPr, fileIssue, type Run } from "./improvements.js";
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
import { RECHECK_TEMPLATE_FILE, renderRecheckPrompt, renderRoundPrompt, roundTemplateFile } from "./templates.js";
import { nodeExec } from "./tmux.js";
import type { RoundOrder, SessionHooks } from "./types.js";

export interface ProductionParts {
  cfg: Config;
  root: string;
  minter: TokenMinter;
  gate: MutationGate;
  adapter: GitHubAdapter;
  sessions: PiSessionManager;
}

export function buildParts(root = sandboxRoot(), cfg = loadConfig()): ProductionParts {
  const minter = new TokenMinter(cfg.github.secrets_dir);
  const gate: MutationGate = new MutationGate(cfg.dry_run, join(root, "state", "dryrun"), (intent: MutationIntent) =>
    adapter.executeMutation(intent),
  );
  const adapter: GitHubAdapter = new GitHubAdapter(cfg, minter, gate);
  const sessions = new PiSessionManager({ cfg, root });
  return { cfg, root, minter, gate, adapter, sessions };
}

const gitRun: Run = async (args, cwd) => (await nodeExec("git", args, cwd ? { cwd } : {})).stdout;

/** package.json version for the `daemon.up` line; never worth failing a boot. */
function packageVersion(root: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
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
function defaultTransport(opts: { cfg: Config; botToken: string; appToken: string }): SlackTransport {
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
  if (!botToken || !appToken) throw new Error("slack: token files vanished between validation and read");

  const transport = (opts.makeTransport ?? defaultTransport)({ cfg, botToken, appToken });

  // Who are we? Resolved ONCE, and required: the router's echo filter is built
  // on this identity, and a bot that cannot recognise its own messages will
  // answer itself forever.
  const identity = await transport.authTest();
  if (!identity) {
    throw new Error("slack: auth.test failed — refusing to start (a bot that cannot identify itself will answer its own echoes)");
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
      const cap = decision.cap === "per_user_daily_turns" ? cfg.slack.policy.per_user_daily_turns : cfg.slack.policy.daily_turns;
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
    void announcer.announceNotPickedUp().catch((err) => log("slack: not-picked-up sweep failed", err));
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
    ...(slack ? { tier: { dir: "local" as const, currentOrigin: () => slack.origins.latestAny() } } : {}),
    deps: slack ? { ...opts.deps, slackReply: slack.slackReply } : opts.deps,
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
      ...(hooks.compactSession ? { compactSession: (pr: number) => hooks.compactSession!(pr) } : {}),
      // Liveness + kill must survive the wrap: dropping sessionAlive here left
      // the stuck-round detector blind in production (liveness always
      // unknown ⇒ every stuck round parked). Found 2026-08-19.
      ...(hooks.sessionAlive ? { sessionAlive: (pr: number) => hooks.sessionAlive!(pr) } : {}),
      ...(hooks.killSession ? { killSession: (pr: number) => hooks.killSession!(pr) } : {}),
      injectOverseer: (message) => wake("overseer-wake", message),
    },
  };
}

export function createProductionDaemon(parts: ProductionParts = buildParts()): Daemon {
  const { cfg, root, gate, adapter, sessions } = parts;
  const log = (msg: string, extra?: unknown) => console.log(`[quickreviewd] ${msg}`, extra ?? "");

  const renderPrompt = (order: RoundOrder): string =>
    renderRoundPrompt(readFileSync(join(root, "prompts", roundTemplateFile(order.round_type)), "utf8"), order);
  // The recheck's own template — a nudge, not a round order.
  const renderRecheck = (order: RecheckOrder): string =>
    renderRecheckPrompt(readFileSync(join(root, "prompts", RECHECK_TEMPLATE_FILE), "utf8"), order);

  let eod: EodTimer | null = null;
  let heartbeat: HeartbeatTimer | null = null;
  let commands: CommandWatcher | null = null;
  let slack: SlackRuntime | null = null;

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

  const daemon = createDaemon({
    cfg,
    root,
    adapter,
    hooks,
    renderPrompt,
    renderRecheckPrompt: renderRecheck,
    // Conflict resolutions are never trivial (the owner, 2026-08-19): git-level
    // auto-merge comparison in the base clone names the hand-resolved files.
    resolvedFilesInMerges: (from, to, pr) => sessions.worktrees.resolvedFilesInMerges(from, to, pr),
    // One network fetch per round, before the order is built: the PR head and
    // the branch it targets, together. Everything downstream (prompt, session,
    // passes) then works from the shas this returns.
    prepareWorktree: (pr, baseRef) => sessions.worktrees.ensureWorktree(pr, { baseRef }),
    // Migration-number pre-check input: the base branch's migrations
    // at the sha the round pinned. Local git in the just-fetched base clone.
    listBaseMigrations: (baseSha) => sessions.worktrees.listMigrationFiles(baseSha),
    // Escalation-mention pick: most recent human author of the
    // touched first-party directive files at the round's merge base, read from
    // the base clone; the daemon's own bot identity never qualifies.
    directiveAuthor: (sha, paths) =>
      sessions.worktrees.lastHumanAuthor(sha, paths, { botLogins: [cfg.github.bot_login, cfg.github.app_slug] }),
    log,
    // Lazy on purpose: the Slack subsystem is built in onStart, after the
    // store exists. Off ⇒ this resolves undefined forever and dispatch/verdicts
    // never see an announcer.
    announce: () => slack?.announcer,
    digestHeadline: () => latestDigestHeadline(join(root, "digest")),
    // Passive pi auth-failure watch: pi's session JSONLs under the container
    // user's home (the pihome volume).
    piSessionsDir: join(homedir(), ".pi", "agent", "sessions"),

    async onStart(d) {
      // Out-of-round wakes (recheck, ping-pong) can now respawn a sticky
      // session the last restart killed — the title comes from the registry.
      sessions.setTitleResolver((pr) => d.store.getPr(pr)?.title);
      // Lens agents: expand {{include:...}} + per-pass model overrides into the
      // build dir the register-lens-agents extension reads (state/agents) —
      // each session registers them with pi-subagents at spawn via its
      // globalThis hook (the extension's own agents dir is hardcoded).
      const built = buildAgents(join(root, "agents"), join(root, "state", "agents"), {
        root,
        tiers: cfg.models.tiers,
        riskPasses: cfg.models.risk_passes,
        validateTier: cfg.models.validate_tier,
      });
      log(`built ${built.length} pass agents into state/agents`);

      // Adopt live sessions + sweep stale worktrees (never kills a live session).
      const active = d.store.allPrs().filter((p) => p.state !== "closed").map((p) => p.number);
      const pre = await sessions.preflight(active);
      log(`preflight: adopted=${pre.adoption.adopted.join(",") || "none"} swept-worktrees=${pre.sweptWorktrees.join(",") || "none"}`);

      // Rounds still marked running whose session did not survive the restart
      // are phantoms: cancel them, requeue the ones whose work was truly lost.
      const orphans = reconcileOrphanedRounds(d.store, pre.adoption.prs, { botLogin: cfg.github.bot_login, log });
      if (orphans.cancelled.length) {
        log(`startup: cancelled orphaned rounds on #${orphans.cancelled.join(", #")}; requeued ${orphans.requeued.length}`);
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
      const commandDeps: CommandDeps = {
        async rerunRound(pr) {
          const row = d.store.getPr(pr);
          if (!row) return { ok: false, reason: `unknown PR #${pr}` };
          d.store.upsertPr({ ...row, state: "queued", trigger_ts: new Date().toISOString() });
          await d.pump();
          return { ok: true, requeued: pr };
        },
        async restartSession(target) {
          if (target === "overseer") {
            const name = await sessions.rotateOverseer();
            return { ok: true, respawned: name };
          }
          // Kill the tmux session; the next dispatched round rebirths it fresh.
          await sessions.tmux.killSession(`pr-${target}`).catch(() => {});
          const row = d.store.getPr(target);
          if (row && row.state !== "closed") {
            d.store.upsertPr({ ...row, state: "queued", trigger_ts: new Date().toISOString() });
            await d.pump();
          }
          return { ok: true, restarted: `pr-${target}` };
        },
        pausePr(pr, reason) {
          const row = d.store.getPr(pr);
          if (!row) return { ok: false, reason: `unknown PR #${pr}` };
          d.store.setPaused(pr, true);
          d.store.logEvent("pr_paused", pr, { reason });
          return { ok: true, paused: pr };
        },
        async resumePr(pr) {
          const row = d.store.getPr(pr);
          if (!row) return { ok: false, reason: `unknown PR #${pr}` };
          d.store.setPaused(pr, false);
          d.store.logEvent("pr_resumed", pr, {});
          await d.pump();
          return { ok: true, resumed: pr };
        },
        flagOwnerLegacy(message) {
          const flags = join(root, "state", "flags");
          mkdirSync(flags, { recursive: true });
          appendFileSync(join(flags, "owner-legacy.log"), `${new Date().toISOString()} ${message}\n`);
          d.store.logEvent("flag_owner_legacy", null, { message });
          return { ok: true };
        },
        fileImprovementPr(payload) {
          return fileImprovementPr(payload, {
            cfg,
            adapter,
            gate,
            store: d.store,
            run: gitRun,
            scratchDir: join(root, "state", "scratch-improve"),
          });
        },
        fileIssue(payload) {
          return fileIssue(payload, { cfg, adapter, gate, store: d.store });
        },
      };
      // The Slack concierge. Off by default; when on it owns its own
      // tier-checked command dir, the socket, and every unprompted post. It is
      // started BEFORE the legacy watcher because that watcher borrows two
      // things from it: the reply handler and the origin lookup.
      slack = (await startSlack({
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

      commands = buildLocalCommandWatcher({ root, deps: commandDeps, store: d.store, slack, log: (l) => log(l) });
      await commands.start();

      // Daemon-clock EOD (Warsaw wall time; pi schedulers deliberately unused).
      eod = startEodTimer({
        timeHHMM: cfg.eod.time,
        timeZone: cfg.eod.timezone,
        readPrompt: promptReader(join(root, "prompts", "eod-sweep.md")),
        injectOverseer: (m) => wakeOverseerAsDaemon("eod-sweep", m),
        onFire: (date) => log(`EOD sweep injected for ${date}`),
        onError: (err) => log("EOD injection failed", err),
      });
      log(`EOD timer armed for ${eod.nextFire().toISOString()}`);

      // Daily overseer heartbeat — same Warsaw wall-clock machinery,
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
        void sessions.rotateOverseerIfDue().then((rotated) => {
          if (rotated) log("overseer rotated (weekly)");
        }).catch((err) => log("overseer rotation failed", err));
      }, 3600_000);
      rotation.unref?.();
    },

    async onStop(reason = "shutdown") {
      eod?.stop();
      heartbeat?.stop();
      commands?.stop();
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
  await daemon.start();
}

if (process.argv[1]?.endsWith("wire.js")) {
  void main();
}
