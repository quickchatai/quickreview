// quickreviewd — the daemon entrypoint. Wires config → store → gate → adapter →
// webhook server + reconcile poll + dispatch pump + verdict watcher + deadline
// checker + status.json writer.
//
// Everything that touches GitHub goes through the MutationGate, which in
// dry-run (the default until the cutover) records the intended call to
// state/dryrun/ instead of executing it. The session manager is behind
// SessionHooks: `createDaemon({ hooks })` swaps B3's real implementation in for
// the disk-logging stub without touching this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot, type Config } from "./config.js";
import { dispatchOnce, type DispatchAdapter } from "./dispatch.js";
import { MutationGate, type MutationIntent } from "./gate.js";
import { GitHubAdapter } from "./github.js";
import { TokenMinter } from "./githubAuth.js";
import { PingPongLedger, ThreadDecisionWatcher, buildWakeMessage, type AuthorReplyEvent } from "./pingpong.js";
import { reconcileOnce, type ReconcileAdapter } from "./reconcile.js";
import type { DispatchAnnouncer, VerdictAnnouncer } from "./slack/announce.js";
import { applyEvent } from "./statemachine.js";
import { buildStatusSnapshot, StateStore, writeStatusJson } from "./state.js";
import { stubSessionHooks } from "./stubs.js";
import type { SessionHooks } from "./types.js";
import { VerdictWatcher, type VerdictAdapter } from "./verdicts.js";
import { applyInterpretation, createWebhookServer, type Interpretation } from "./webhook.js";
import { wakeOrHold } from "./wakes.js";

export type DaemonAdapter = DispatchAdapter & ReconcileAdapter & VerdictAdapter;

export interface DaemonDeps {
  cfg?: Config;
  root?: string;
  store?: StateStore;
  adapter?: DaemonAdapter;
  hooks?: SessionHooks;
  webhookSecret?: string;
  /** B4's prompt renderer; default is the round order as JSON. */
  renderPrompt?: (order: import("./types.js").RoundOrder) => string;
  log?: (msg: string, extra?: unknown) => void;
  /** Skip binding the HTTP port (tests). */
  listen?: boolean;
  /** Latest digest headline for status.json (B5's digest module). */
  digestHeadline?: () => string | undefined;
  /**
   * Slack announcer (S5b), resolved LAZILY: wire.ts builds the Slack
   * subsystem in `onStart`, i.e. after the store exists and after this deps
   * object was assembled, so the seam is a getter rather than a value. Absent
   * ⇒ no announcer is ever passed to dispatch or the verdict watcher and the
   * daemon behaves exactly as it did before Slack.
   */
  announce?: () => (DispatchAnnouncer & VerdictAnnouncer) | undefined;
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

export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcile(): Promise<void>;
  pump(): Promise<void>;
  readonly store: StateStore;
  readonly cfg: Config;
}

function readWebhookSecret(cfg: Config): string {
  return readFileSync(join(cfg.github.secrets_dir, "webhook_secret"), "utf8").trim();
}

/** The real adapter: token minter → mutation gate (dry-run aware) → adapter. */
function buildGitHubAdapter(cfg: Config, stateDir: string): GitHubAdapter {
  const minter = new TokenMinter(cfg.github.secrets_dir);
  const gate: MutationGate = new MutationGate(cfg.dry_run, join(stateDir, "dryrun"), (intent: MutationIntent): Promise<unknown> =>
    github.executeMutation(intent),
  );
  const github: GitHubAdapter = new GitHubAdapter(cfg, minter, gate);
  return github;
}

export function createDaemon(deps: DaemonDeps = {}): Daemon {
  const cfg = deps.cfg ?? loadConfig();
  const root = deps.root ?? sandboxRoot();
  const stateDir = join(root, "state");
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.log(`[quickreviewd] ${msg}`, extra ?? ""));
  const store = deps.store ?? new StateStore(join(stateDir, "state.db"));
  const hooks = deps.hooks ?? stubSessionHooks(root, log);

  const gh: DaemonAdapter = deps.adapter ?? buildGitHubAdapter(cfg, stateDir);

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
    log,
  });
  const pingpong = new PingPongLedger(store.db);
  const threadDecisions = new ThreadDecisionWatcher({
    adapter: gh as GitHubAdapter,
    store,
    ledger: pingpong,
    verdictDir,
    log,
    onHumanRequested: async (decision) => {
      await gh.requestEscalationReview(decision.pr);
      applyEvent(store, decision.pr, { type: "escalation_detected" }, {}, {
        botLogin: cfg.github.bot_login,
        reason: "pingpong:human-requested",
      });
    },
  });

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
        onAuthorReply: async (reply) => {
          // Webhook interpretation guarantees a same-PR bot-owned root. Claim
          // the author message before waking so duplicate deliveries cannot
          // produce duplicate replies or resolutions.
          if (reply.in_reply_to_id === null) return;
          const event: AuthorReplyEvent = {
            pr: reply.pr,
            comment_id: reply.comment_id,
            in_reply_to_id: reply.in_reply_to_id,
            body: reply.body,
            author: reply.author,
          };
          if (!pingpong.claimAuthorMessage(event)) return;
          const row = store.getPr(reply.pr);
          // S4: the PR's one main pi never gets a second instruction while its
          // round is in flight — the wake is held and flushed at round end.
          const disposition = await wakeOrHold(
            { store, inject: (pr, message) => hooks.inject(pr, message), log },
            reply.pr,
            buildWakeMessage(event, {
              head_sha: row?.head_sha,
              worktree: join(root, "wt", `pr-${reply.pr}`),
            }, pingpong.discipline(reply.in_reply_to_id)),
            "author_reply",
          );
          if (disposition === "held") log(`pingpong: #${reply.pr} reply held — round in flight`);
        },
        onClosed: async (pr) => {
          await hooks.archiveAndClose(pr);
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

  const reconcile = async (): Promise<void> => {
    await guard("reconcile", async () => {
      const report = await reconcileOnce({ cfg, store, adapter: gh, hooks, log });
      log(
        `reconcile: open=${report.open_prs} triggered=${report.triggered.length} ` +
          `closed=${report.closed.length} corrections=${report.corrections} errors=${report.errors.length}`,
      );
      await pump();
    });
  };

  const pump = async (): Promise<void> => {
    await guard("dispatch", async () => {
      const orders = await dispatchOnce({ cfg, store, adapter: gh, hooks, renderPrompt: deps.renderPrompt, announce, log });
      for (const o of orders) log(`dispatched #${o.pr} round ${o.round_no} (${o.round_type}) lenses=${o.lenses.join(",")}`);
    });
  };

  const writeStatus = (): void => {
    try {
      writeStatusJson(stateDir, buildStatusSnapshot(store, cfg.dry_run, deps.digestHeadline?.(), undefined, cfg.daemon.max_concurrent_rounds));
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
    reconcile,
    pump,

    async start(): Promise<void> {
      log(`starting — ${cfg.dry_run ? "DRY-RUN" : "LIVE"} — repo ${cfg.github.repo}`);
      store.logEvent("daemon_start", null, { dry_run: cfg.dry_run, port: cfg.server.port });

      if (deps.listen !== false) {
        const secret = deps.webhookSecret ?? readWebhookSecret(cfg);
        server = createWebhookServer({ cfg, store, secret, onInterpretation, log });
        // Loopback by default; in the container the daemon must bind 0.0.0.0
        // (docker's published port targets the container's eth0, and the
        // host-side binding is already 127.0.0.1-only — spec §9).
        const bindHost = process.env.QC_BIND_HOST ?? "127.0.0.1";
        await new Promise<void>((resolve) => server!.listen(cfg.server.port, bindHost, resolve));
        log(`webhook listening on ${bindHost}:${cfg.server.port}/webhook`);
      }

      verdicts.start();
      threadDecisions.start();
      writeStatus();
      await reconcile();

      every(cfg.daemon.poll_interval_s, () => void reconcile());
      every(DISPATCH_TICK_S, () => void pump());
      every(VERDICT_SWEEP_S, () => void guard("verdict sweep", async () => {
        await verdicts.sweep();
        await threadDecisions.sweep();
      }));
      every(DEADLINE_TICK_S, () => void guard("deadline check", () => verdicts.checkDeadlines()));
      every(STATUS_TICK_S, writeStatus);
      if (deps.onStart) await guard("onStart", async () => deps.onStart!(this));
    },

    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      log("stopping");
      if (deps.onStop) await guard("onStop", async () => deps.onStop!());
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      verdicts.stop();
      threadDecisions.stop();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      writeStatus();
      store.logEvent("daemon_stop", null, {});
      if (!deps.store) store.close();
    },
  };
}

async function main(): Promise<void> {
  const daemon = createDaemon();
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

if (process.argv[1]?.endsWith("daemon.js")) {
  void main();
}
