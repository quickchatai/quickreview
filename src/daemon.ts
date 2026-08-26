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
import { AnomalyWakePolicy } from "./anomalies.js";
import { retryWithheldApproval, type CiAdapter, type WithheldRetryDeps } from "./cigate.js";
import { loadConfig, sandboxRoot, type Config } from "./config.js";
import { dispatchOnce, type DispatchAdapter } from "./dispatch.js";
import { MutationGate, type MutationIntent } from "./gate.js";
import { GitHubAdapter } from "./github.js";
import { TokenMinter } from "./githubAuth.js";
import { REVIEW_SET_ASIDE_STALE_WINDOW_MS, type FeedbackEvent } from "./feedback.js";
import { enforceLedgerFreshness } from "./ledgercheck.js";
import { PingPongLedger, ThreadDecisionWatcher, buildWakeMessage, type AuthorReplyEvent } from "./pingpong.js";
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
import { buildStatusSnapshot, StateStore, writeStatusJson } from "./state.js";
import { PiAuthWatch } from "./authwatch.js";
import { stubSessionHooks } from "./stubs.js";
import type { SessionHooks } from "./types.js";
import { VerdictWatcher, type VerdictAdapter } from "./verdicts.js";
import { applyInterpretation, createWebhookServer, type Interpretation } from "./webhook.js";
import { wakeOrHold } from "./wakes.js";

// Partial<RecheckAdapter>: the recheck's two extra reads (compare, files) are a
// seam, not a requirement — a daemon wired without them simply never rechecks,
// which is exactly how every legacy caller and test behaves.
export type DaemonAdapter = DispatchAdapter & ReconcileAdapter & VerdictAdapter & Partial<RecheckAdapter> & Partial<CiAdapter>;

export interface DaemonDeps {
  cfg?: Config;
  root?: string;
  store?: StateStore;
  adapter?: DaemonAdapter;
  hooks?: SessionHooks;
  webhookSecret?: string;
  /** B4's prompt renderer; default is the round order as JSON. The second
   * argument is the round's assembled memory seed — MEMORY_LESS
   * when nothing is wired or the store was unreachable. */
  renderPrompt?: (order: import("./types.js").RoundOrder, memory: import("./memory/context.js").RoundMemory) => string;
  /** The pinned head + budgeted context block seeded into each round prompt
   *. Absent ⇒ rounds render memory-less, which is a supported
   * state, not a failure. */
  memory?: import("./memory/context.js").RoundMemorySeed;
  /** Renderer for the recheck nudge (prompts/round-recheck.md); default JSON. */
  renderRecheckPrompt?: (order: RecheckOrder) => string;
  /** Hand-resolved merge files between two shas (the owner, 2026-08-19 —
   * conflict resolutions are never trivial). wire.ts passes the
   * WorktreeManager's git-level auto-merge comparison. */
  resolvedFilesInMerges?: (from: string, to: string, pr?: number) => Promise<{ files: string[]; degraded: boolean }>;
  /** Fetch head + base and materialise the worktree before the order is built
   * (wire.ts passes the real WorktreeManager). Absent ⇒ no git: the order
   * falls back to the PR row's sha with no base facts. */
  prepareWorktree?: (
    pr: number,
    baseRef: string,
  ) => Promise<{ head_sha: string; base_ref: string; base_sha: string; merge_base: string }>;
  /** Base-branch migration paths at a sha, for the collision pre-check
   *. Absent ⇒ no git: the pre-check is skipped and logged. */
  listBaseMigrations?: (baseSha: string) => Promise<string[]>;
  /** Most recent human author of paths at a sha (the escalation
   * mention pick). Absent ⇒ no git: the config fallback mention is used. */
  directiveAuthor?: (sha: string, paths: string[]) => Promise<{ login: string | null; name: string; email: string } | null>;
  log?: (msg: string, extra?: unknown) => void;
  /** Skip binding the HTTP port (tests). */
  listen?: boolean;
  /** Latest digest headline for status.json (B5's digest module). */
  digestHeadline?: () => string | undefined;
  /** pi's session-JSONL root for the passive auth-failure watch
   * (src/authwatch.ts). Absent (tests, stubs) ⇒ the watch never runs. */
  piSessionsDir?: string;
  /**
   * The supervised OpenViking server's heartbeat block. A CACHED,
   * synchronous read — wire.ts hands the supervisor's `status()` here. Absent
   * (tests, stub daemons) ⇒ status.json simply carries no `openviking` key,
   * and a throwing implementation is swallowed: the heartbeat must never fail
   * on the memory engine.
   */
  openvikingStatus?: () => import("./openviking/types.js").OpenVikingStatus | undefined;
  /**
   * Slack announcer (S5b), resolved LAZILY: wire.ts builds the Slack
   * subsystem in `onStart`, i.e. after the store exists and after this deps
   * object was assembled, so the seam is a getter rather than a value. Absent
   * ⇒ no announcer is ever passed to dispatch or the verdict watcher and the
   * daemon behaves exactly as it did before Slack.
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

export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcile(): Promise<void>;
  pump(): Promise<void>;
  wakeThreadDecisions(): void;
  retryThreadDecision(commentId: number): { ok: boolean; reason?: string; file?: string };
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

  // Overseer wake policy: every logAnomaly flows through the ONE
  // severity map + dedup; WAKE classes write an overseer inject, QUIET classes
  // stay DB-only. Wired here so stub-wired daemons behave identically.
  const wakePolicy = new AnomalyWakePolicy({ injectOverseer: (m) => hooks.injectOverseer(m), log });
  store.setAnomalySink((signal) => wakePolicy.onAnomaly(signal));

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
    // The durable reasoning record — same dir the round prompts pin.
    findingsDir: join(root, "state", "findings"),
    log,
  });
  const pingpong = new PingPongLedger(store.db);
  const threadDecisions = new ThreadDecisionWatcher({
    adapter: gh as GitHubAdapter,
    store,
    ledger: pingpong,
    verdictDir,
    log,
    isDraining: () => store.drainState().draining,
    // The author asked for a person. Park the PR locally — no reviewer is
    // requested on GitHub (escalation mechanics scrapped 2026-08-18).
    onHumanRequested: async (decision) => {
      applyEvent(store, decision.pr, { type: "human_requested" }, {}, {
        botLogin: cfg.github.bot_login,
        reason: "pingpong:human-requested",
      });
    },
  });

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
        onAuthorReply: async (reply) => {
          // Webhook interpretation guarantees a same-PR bot-owned root. Claim
          // the author message before waking so duplicate deliveries cannot
          // produce duplicate replies or resolutions.
          if (reply.in_reply_to_id === null) return;
          // Deploy-window drain: no ping-pong wake while draining — and the
          // claim is deliberately NOT taken, so a redelivery after the lift
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
        // A push after an approve — the case that caught 13 real post-approval
        // regressions in the predecessor system.
        onSynchronize: async (sync) => {
          await guard(`recheck #${sync.pr}`, () =>
            runRecheck(recheckDeps, { pr: sync.pr, trigger: "push", head_sha: sync.meta.head_sha }),
          );
        },
        onCiCompleted: async (ci) => {
          for (const pr of ci.prs) {
            await guard(`recheck #${pr}`, () =>
              runRecheck(recheckDeps, { pr, trigger: "ci", head_sha: ci.head_sha, ci: { conclusion: ci.conclusion } }),
            );
            // the other side of the same event. A PR whose approval
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
            runBaseAdvance(recheckDeps, { branch: advance.branch, before: advance.before, after: advance.after }),
          );
        },
        // forward tuning-loop signals to the engine. A review set
        // aside right after a head push is GitHub's own stale-review sweep,
        // classified here (the store holds the push clock), not a human verdict.
        onFeedbackSignal: async (e) => {
          if (!deps.onFeedback) return;
          await guard(`feedback #${e.pr}`, async () => {
            if (e.kind === "review_set_aside") {
              const lastPush = store.lastEventAt("head_push", e.pr);
              const stale = lastPush !== undefined && Date.now() - Date.parse(lastPush) < REVIEW_SET_ASIDE_STALE_WINDOW_MS;
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

  // Deploy-window drain auto-lift (2026-08-25): only the boot's FIRST
  // reconcile pass may lift the drain, and only when it completed HEALTHILY —
  // reconcileOnce resolved AND its per-step `report.errors` is empty. A
  // failed first pass leaves the drain standing for the rest of this boot (a
  // broken deploy must not resume work blind); clearing it then takes an
  // explicit `drain off`. Consequence the owner accepted: in a multi-deploy
  // window each healthy boot lifts the drain, so the operator re-drains
  // before each step.
  let firstReconcileSeen = false;
  const reconcile = async (): Promise<void> => {
    const bootFirstPass = !firstReconcileSeen;
    firstReconcileSeen = true;
    await guard("reconcile", async () => {
      const report = await reconcileOnce({
        cfg,
        store,
        adapter: gh,
        hooks,
        log,
        // push-trigger backstop: same runRecheck the webhook's
        // onSynchronize calls — a dead/lost webhook no longer means a
        // post-review push goes unexamined (live gap 2026-08-19, #5307).
        onHeadPush: async (pr, head_sha) => {
          await guard(`recheck #${pr}`, () => runRecheck(recheckDeps, { pr, trigger: "push", head_sha }));
        },
        // backstop: merged-over-block for closes the webhook missed.
        onMergedOverBlock: async (pr) => {
          await guard(`feedback #${pr}`, async () => deps.onFeedback?.({ kind: "merged_over_block", pr }));
        },
      });
      log(
        `reconcile: open=${report.open_prs} triggered=${report.triggered.length} ` +
          `closed=${report.closed.length} captured=${report.captured_comments} ` +
          `corrections=${report.corrections} errors=${report.errors.length}`,
      );
      if (bootFirstPass && report.errors.length === 0 && store.drainState().draining) {
        const { dropped } = store.setDraining(false);
        store.logEvent("drain_lifted", null, { dropped_deliveries: dropped });
        log(`drain_lifted — first reconcile pass healthy; ${dropped} webhook delivery(ies) were dropped while draining`);
        threadDecisions.requestSweep();
      }
      await pump();
    });
  };

  const pump = async (): Promise<void> => {
    await guard("dispatch", async () => {
      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: gh,
        hooks,
        renderPrompt: deps.renderPrompt,
        ...(deps.memory ? { memory: deps.memory } : {}),
        prepareWorktree: deps.prepareWorktree,
        listBaseMigrations: deps.listBaseMigrations,
        directiveAuthor: deps.directiveAuthor,
        resolvedFilesInMerges: deps.resolvedFilesInMerges,
        announce,
        log,
      });
      for (const o of orders) log(`dispatched #${o.pr} round ${o.round_no} (${o.round_type}) lenses=${o.lenses.join(",")}`);
    });
  };

  // Passive pi auth-failure watch (the owner, 2026-08-19): no smoke calls, just
  // the session JSONLs pi already writes. A detection is a WAKE-grade anomaly
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
    reconcile,
    pump,
    wakeThreadDecisions: () => threadDecisions.requestSweep(),
    retryThreadDecision: (commentId) => threadDecisions.retryFailed(commentId),

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
      rechecks.start();
      writeStatus();
      // onStart BEFORE the first reconcile: the sweep can nudge a recheck at a
      // dead session immediately (boot after a deploy restart), and the
      // respawn path needs the title resolver wired in onStart. Live failure
      // 2026-08-19: "no live session pr-5290" thrown by the boot sweep.
      if (deps.onStart) await guard("onStart", async () => deps.onStart!(this));
      await reconcile();

      every(cfg.daemon.poll_interval_s, () => void reconcile());
      every(DISPATCH_TICK_S, () => void pump());
      every(VERDICT_SWEEP_S, () => void guard("verdict sweep", async () => {
        await verdicts.sweep();
        await threadDecisions.sweep();
        await rechecks.sweep();
      }));
      every(DEADLINE_TICK_S, () => void guard("deadline check", async () => {
        await verdicts.checkDeadlines();
        // Zombie-round expiry: rounds stuck `overdue` past the
        // horizon whose PR has since verdicted/closed become terminal
        // `expired`. Rounds a rerun could still service are left standing.
        if (cfg.daemon.expire_overdue_after_h > 0) {
          const expired = store.expireOverdueRounds(cfg.daemon.expire_overdue_after_h);
          if (expired.length > 0) log(`expired ${expired.length} zombie round(s): ids ${expired.join(",")}`);
        }
        // Stranded rounds: the ones the sweep above deliberately
        // leaves — overdue, but the PR is still open and still undecided, so
        // "a rerun could service it". Nothing ever does; found one
        // sitting untouched since the cutover, ten days and invisible. Past a
        // week that is not pending rescue, it is abandoned: terminalize it and
        // SAY SO. One anomaly per round, once, because the row stops being
        // overdue the moment it is reported.
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
          log(`stranded round closed: #${r.pr} round ${r.round_no} (overdue since ${r.deadline_at})`);
        }
      }));
      every(STATUS_TICK_S, writeStatus);
      if (piAuthWatch) every(AUTHWATCH_TICK_S, authWatchTick);
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
      rechecks.stop();
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
