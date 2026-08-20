// `qcr tui [pr|overseer]` entry point. Wires the real ssh runner; the
// optional target becomes the deep link.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig, sandboxRoot } from "../config.js";
import type { TuiDriver } from "./actions.js";
import { App } from "./app.js";
import type { DeployState } from "./deploytab.js";
import type { MemTabState } from "./memtab.js";
import type { MetricsView } from "./metricstab.js";
import { ensureSshMaster } from "./connect.js";
import { MOUSE_OFF, MOUSE_ON } from "./mouse.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR } from "./paint.js";
import { HotReloader, parseResumeArg, readResumeState, realReexec } from "./reload.js";
import { realSshRunner } from "./remote.js";

export function parseTarget(arg: string | undefined): { kind: "none" } | { kind: "pr"; pr: number } | { kind: "session"; session: string } | { kind: "bad"; reason: string } {
  if (arg === undefined || arg === "") return { kind: "none" };
  if (/^\d+$/.test(arg)) return { kind: "pr", pr: Number(arg) };
  if (arg === "overseer" || arg === "main") return { kind: "session", session: arg };
  return { kind: "bad", reason: `unknown target '${arg}' — expected a PR number, 'overseer', or 'main'` };
}

export const TUI_HELP = `qcr tui — live board for the review daemon (over ssh, read-only)

usage: qcr tui [<pr> | overseer | main] [--no-companion] [--no-reload]

  qcr tui           open the board
  qcr tui 5012      deep-link straight into PR 5012's pi session
  qcr tui overseer  deep-link into the overseer session

  --no-companion    skip the local companion entirely (container, ambient
                    feed, alert pipeline; the companion strip shows "companion
                    off")
  --no-reload       do not re-exec when a new dist/ build lands

keys: 1/2/3/4 tabs (2 = memory & learning — v toggles digest/memory view,
      x×2 retire · p pin · e edit · n new · A/R accept/reject a rubric proposal;
      3 = deploy — click ▶/■ buttons (D D deploy, S S stop/start);
      4 = metrics — 7/0/a window, # <pr> ⏎ for a PR timeline) ·
      companion strip on every tab: type any unclaimed key (or /) to start a
      message — ⏎ sends · Esc clears; click its mirror rows to go full-screen ·
      j/k select · ⏎ attach ·
      Ctrl-q detach (twice = literal) · Ctrl-c ×3 hard-kill the TUI ·
      s reconnect ssh (GCP passphrase, once) ·
      m quick-message · o overseer · M main · w detail · e events overlay · r refresh ·
      ? full key map · q quit

troubleshooting:
  ✖ unreachable      ssh to the VM failed — press s to re-establish the
                     master (prompts for the GCP key passphrase once); after a
                     reboot the 4h shared connection is gone until you do
  ▲ DATA STALE       ssh works but status.json stopped updating — the
                     container is down or the daemon hung (qcr-side:
                     ssh my-vm sudo docker ps / docker logs)
  keys lost in pi    the outer terminal must speak csi-u (kitty/ghostty/
                     wezterm/iterm2); running inside an outer tmux needs
                     extended-keys passthrough there too
`;

/** Flags the TUI owns; everything else is the (optional) deep-link target. */
export interface TuiArgs {
  target: string | undefined;
  companion: boolean;
  reload: boolean;
  resumeState: string | undefined;
  help: boolean;
}

export function parseTuiArgs(args: string[]): TuiArgs {
  const { stateFile, rest } = parseResumeArg(args);
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  return {
    target: rest.find((a) => !a.startsWith("-")),
    companion: !flags.has("--no-companion"),
    reload: !flags.has("--no-reload"),
    resumeState: stateFile,
    help: flags.has("--help") || flags.has("-h"),
  };
}

/**
 * the companion action channel's executor, mapped onto the App's
 * public surface plus the per-tab states the install hooks return. Exported
 * so tests can drive a real App through `processTuiActions`; runTui wires it
 * inside the companionUp block. RATIFIED: actions run instantly — no confirm
 * gate (see src/tui/actions.ts header).
 */
export function buildTuiDriver(app: App, memState: MemTabState, metricsView: MetricsView, deployState: DeployState): TuiDriver {
  // One keyboard owner at a time: an action must never type into a focused
  // pi pane or companion strip (same rule the mouse/tab handlers follow).
  const prep = (): void => {
    if (app.piFocused()) app.blurPiPane();
    app.strip?.blur();
  };
  const driver: TuiDriver = {
    switchTab: (tab) => {
      prep();
      app.tab = tab === "memory" ? "digest" : tab; // App's [2] tab id is "digest"
      app.repaint();
    },
    selectPr: (pr) => {
      prep();
      app.tab = "board";
      app.selectPr(pr); // public App API — selects + refreshes detail
      app.repaint();
    },
    metricsWindow: (w) => {
      prep();
      app.tab = "metrics";
      metricsView.drill = undefined;
      metricsView.window = w === "7d" ? "d7" : w === "30d" ? "d30" : "all";
      metricsView.scroll = 0;
      app.repaint();
    },
    metricsPr: (pr) => {
      prep();
      app.tab = "metrics";
      app.repaint();
      // Drive the tab's own PR-entry state machine so the timeline FETCH runs
      // (drillTo is closure-private): # opens entry, digits accumulate, ⏎ drills.
      app.pressKey("#");
      for (const d of String(pr)) app.pressKey(d);
      app.pressKey("\r");
    },
    digestDay: (date) => {
      prep();
      app.tab = "digest";
      memState.view = "digest";
      app.repaint();
      // Page to the day through the tab's own [ / ] keys so content loads
      // (pageDigest is closure-private). files are newest-first date-named.
      const i = memState.digest.files.findIndex((f) => f.startsWith(date));
      if (i < 0) {
        app.notice(`companion ▸ no digest for ${date}`);
        return;
      }
      const delta = i - memState.digest.back;
      for (let k = 0; k < Math.abs(delta); k++) app.pressKey(delta > 0 ? "[" : "]");
    },
    memoryView: (opts) => {
      prep();
      app.tab = "digest";
      if (opts.day !== undefined) driver.digestDay(opts.day); // day highlight = digest-selected day
      memState.view = "memory";
      if (opts.tag !== undefined) {
        memState.memFilter = opts.tag;
        memState.sel = 0; // old ordinal may exceed the narrowed list
      }
      app.repaint();
    },
    setBoardFilter: (f) => {
      prep();
      app.tab = "board";
      app.view.boardFilter = f;
      app.repaint();
    },
    setMemoryFilter: (tag) => {
      prep();
      app.tab = "digest";
      memState.view = "memory";
      memState.memFilter = tag;
      memState.sel = 0;
      app.repaint();
    },
    msgSession: (session, text) => app.hooks.sendMessage?.(session, text, app),
    overseerInject: (text) => app.hooks.sendMessage?.("overseer", text, app),
    deployTab: (action) => {
      prep();
      app.tab = "deploy";
      app.repaint();
      if (action === "abort") {
        app.pressKey("x"); // kills a running run (closes a finished log otherwise)
        return;
      }
      if (action === "deploy") {
        app.pressKey("D");
        app.pressKey("D"); // arm+confirm inside the window = instant (ratified)
        return;
      }
      // stop/start: the tab's S button computes its own kind from the observed
      // container state (powerKind()); refuse a mismatched request rather than
      // silently doing the opposite.
      const kind = deployState.containerStatus !== undefined && !/^Up /.test(deployState.containerStatus) ? "start" : "stop";
      if (kind !== action) {
        app.notice(`companion ▸ deploy_tab ${action} refused — container is ${deployState.containerStatus ?? "unknown"}`);
        return;
      }
      app.pressKey("S");
      app.pressKey("S");
    },
  };
  return driver;
}

export async function runTui(argv: string | string[] = []): Promise<void> {
  const args = parseTuiArgs(typeof argv === "string" ? [argv] : argv);
  if (args.help) {
    console.log(TUI_HELP);
    return;
  }
  const target = parseTarget(args.target);
  if (target.kind === "bad") {
    console.error(`qcr tui: ${target.reason}`);
    process.exitCode = 2;
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("qcr tui needs an interactive terminal");
    process.exitCode = 2;
    return;
  }
  const full = loadConfig();
  const cfg = full.tui;

  // The GCP key passphrase, once, natively — before the alt screen, so the
  // OpenSSH prompt is a plain terminal prompt. Failure degrades to the
  // unreachable banner (retry from the board with s).
  ensureSshMaster(cfg);

  const app = new App(cfg, realSshRunner);

  // The terminal must come back whatever kills us — raw mode + alt screen
  // surviving a crash is exactly the "only closing the terminal works" trap.
  const restoreTerminal = (): void => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* stdin already gone */
    }
    process.stdout.write(MOUSE_OFF + ALT_SCREEN_OFF);
  };
  process.on("exit", restoreTerminal);
  process.on("SIGINT", () => {
    restoreTerminal();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restoreTerminal();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    restoreTerminal();
    console.error("qcr tui crashed:", err);
    process.exit(1);
  });

  /** Suspend the TUI, run something on the real terminal, come back. */
  const onRealTerminal = (fn: () => void): void => {
    app.suspend();
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* keep going — fn may still work */
    }
    process.stdout.write(MOUSE_OFF + ALT_SCREEN_OFF);
    try {
      fn();
    } finally {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdout.write(ALT_SCREEN_ON + CLEAR + MOUSE_ON);
      app.resume();
    }
  };
  app.hooks.reconnect = () => onRealTerminal(() => ensureSshMaster(cfg));
  app.hooks.deployRun = (_theApp, onData, onExit) => {
    // Streamed into the deploy tab — the TUI never leaves the screen.
    // deploy.sh's own guardrails (clean tree, pin agreement) are the gate.
    // Colors off: the pane strips ANSI anyway, plain text diffs better.
    const child = spawn("bash", ["scripts/deploy.sh", "sync"], {
      cwd: sandboxRoot(),
      env: { ...process.env, ANSIBLE_FORCE_COLOR: "0", PY_COLORS: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b: Buffer) => onData(b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => onData(b.toString("utf8")));
    child.on("close", (code) => onExit(code));
    child.on("error", (err) => {
      onData(`\nspawn failed: ${String(err)}\n`);
      onExit(1);
    });
    return {
      kill: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      },
    };
  };
  app.view.repo = full.github.repo;
  const { spawn } = await import("node:child_process");
  const { existsSync, mkdirSync, renameSync, writeFileSync } = await import("node:fs");
  app.hooks.openUrl = (url) => {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  };
  const marker = join(sandboxRoot(), "state", "tui-help-shown");
  app.hooks.helpSeen = {
    get: () => existsSync(marker),
    set: () => {
      mkdirSync(join(sandboxRoot(), "state"), { recursive: true });
      writeFileSync(marker, new Date().toISOString());
    },
  };
  const { installAttachHooks } = await import("./attach.js");
  await installAttachHooks(app);
  const { installMessageHooks } = await import("./msg.js");
  installMessageHooks(app);
  // the [2] tab is Memory & learning — digest view + memory
  // management. Accept-verdict git actions run against THIS working copy
  // (the canonical repo); the tracker path feeds the defect auto-filer.
  const { installMemoryLearningHooks } = await import("./memtab.js");
  const { execFile } = await import("node:child_process");
  const gitRun = (cmd: string, args: string[], stdin?: string): Promise<string> =>
    new Promise((res, rej) => {
      const child = execFile(cmd, args, { cwd: sandboxRoot() }, (err, stdout, stderr) => {
        if (err) rej(new Error(stderr.trim() || err.message));
        else res(stdout);
      });
      if (stdin !== undefined) child.stdin?.end(stdin);
      else child.stdin?.end();
    });
  const memState = installMemoryLearningHooks(app, {
    gitRun,
    repoRoot: sandboxRoot(),
    tracker: full.companion.tracker_dir
      ? { root: full.companion.tracker_dir, effort: "review-sandbox", parent: "" }
      : undefined,
  });
  const { RealDeployFetcher, installDeployHooks, powerCommand, realLocalRunner } = await import("./deploytab.js");
  const localRunner = realLocalRunner(sandboxRoot());
  app.hooks.powerRun = (_theApp, action, onData, onExit) => {
    // docker stop/start on the VM, streamed into the tab like a deploy.
    const child = spawn("ssh", [cfg.ssh_host, powerCommand(cfg, action)], { stdio: ["ignore", "pipe", "pipe"] });
    onData(`$ ssh ${cfg.ssh_host} ${powerCommand(cfg, action)}\n`);
    child.stdout.on("data", (b: Buffer) => onData(b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => onData(b.toString("utf8")));
    child.on("close", (code) => onExit(code));
    child.on("error", (err) => {
      onData(`\nspawn failed: ${String(err)}\n`);
      onExit(1);
    });
    return {
      kill: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      },
    };
  };

  const deployState = installDeployHooks(app, new RealDeployFetcher(cfg, realSshRunner, localRunner));
  const { installMetricsHooks, localHeadProbe } = await import("./metricstab.js");
  // The metrics OPERATIONS card answers "deploy needed?" through the same
  // read-only local-git seam the deploy tab uses.
  const metricsView = installMetricsHooks(app, undefined, localHeadProbe(localRunner));

  // Companion container: adopt-or-start before the board comes up. A failure
  // here is a degraded mode, never a reason not to open the TUI.
  const { CompanionLifecycle, realDockerRunner } = await import("./companion.js");
  const companion = new CompanionLifecycle(full.companion, realDockerRunner);
  const companionOn = args.companion && full.companion.enabled;
  let companionUp = false;
  let companionError: string | undefined;
  const companionStateDir = join(sandboxRoot(), "state", "companion");
  const policyStatePath = join(companionStateDir, "alert-policy.json");
  const startCompanion = async (): Promise<void> => {
    try {
      await companion.ensureUp((line) => app.notice(`companion: ${line}`));
      // daily rollover — strictly between "container is up" and
      // "pi is spawned": on the first start of a new Warsaw day it archives
      // yesterday, kills the session and queues the opening context, so the
      // spawnPi below births the fresh conversation that reads it.
      const { CompanionRollover } = await import("./rollover.js");
      const { latestDigestHeadline } = await import("../digest.js");
      const rollover = new CompanionRollover(full.companion, realDockerRunner, {
        statePath: join(companionStateDir, "rollover.json"),
        policyStatePath,
        templatePath: join(sandboxRoot(), "prompts", "companion-day-open.md"),
        injectDir: companion.hostInjectDir(),
        localDigestHeadline: () => latestDigestHeadline(),
      });
      const report = await rollover.run();
      if (report.verdict.kind === "rollover") {
        app.notice(`companion: new day ${report.verdict.today} — fresh conversation (${report.steps.length} steps)`);
      }
      await companion.spawnPi();
      companionUp = true;
      companionError = undefined;
    } catch (err) {
      companionError = String(err instanceof Error ? err.message : err);
      app.notice(`companion unavailable: ${companionError}`);
    }
  };
  if (companionOn) await startCompanion();

  // ambient feed + alert pipeline + companion tab. All of it hangs off
  // companionOn, so --no-companion really means "none of this runs".
  const { installCompanionTabHooks } = await import("./companiontab.js");
  const { spawn: spawnPty } = companionOn ? await import("node-pty") : { spawn: undefined };
  installCompanionTabHooks(app, {
    lifecycle: companion,
    available: () => companionUp,
    failure: () => companionError,
    retry: companionOn ? startCompanion : undefined,
    spawner: (argv, cols, rows) => {
      const p = spawnPty!("docker", argv, { name: "xterm-256color", cols, rows, env: process.env as Record<string, string> });
      return {
        write: (data) => p.write(data),
        resize: (c, r) => p.resize(c, r),
        kill: () => {
          try {
            p.kill();
          } catch {
            /* already dead */
          }
        },
        onData: (cb) => p.onData(cb),
        onExit: (cb) => p.onExit(cb),
      };
    },
  });

  // the companion strip — chrome on every tab. Mirror + send go
  // through the same local docker seam the lifecycle uses; refresh piggybacks
  // the app poll (the strip's own 500ms timer only runs focused/after-send).
  const { CompanionStrip } = await import("./strip.js");
  app.strip = new CompanionStrip(full.companion, realDockerRunner, {
    available: () => companionUp,
    onUpdate: () => app.repaint(),
  });
  {
    const prevOnPoll = app.hooks.onPoll;
    app.hooks.onPoll = (a) => {
      prevOnPoll?.(a);
      void a.strip?.refresh();
    };
  }

  let alerts: { stop(): void } | undefined;
  if (companionUp) {
    const { FeedWriter } = await import("./feed.js");
    const feed = new FeedWriter(full.companion.feed_dir);
    app.hooks.onPoll = (a) => {
      const snap = a.view.snapshot;
      if (!snap) return;
      try {
        feed.write(snap, a.rawEvents, a.view.health.kind);
      } catch (err) {
        a.notice(`✖ feed write failed: ${String(err instanceof Error ? err.message : err)}`);
      }
    };

    const { AlertConsumer, AlertPolicy, filePolicyStore, notifySendRunner } = await import("./alerts.js");
    const { InjectSender } = await import("./msg.js");
    const overseer = new InjectSender(cfg, realSshRunner);
    // Persisted per-cause memory: "already told you" survives a TUI restart
    // inside the same Warsaw day, and resets with the day.
    const policy = new AlertPolicy(full.companion.cooldown_min, () => new Date(), filePolicyStore(policyStatePath));
    const consumer = new AlertConsumer(full.companion.alerts_dir, policy, {
      notice: (text) => app.notice(text),
      badge: (badge) => app.setAlertBadge(badge),
      notify: notifySendRunner,
      inject: (text) => void overseer.send("overseer", text, (_state, label) => app.notice(label)),
    });
    consumer.start(Math.max(1, cfg.poll_interval_s) * 1000);
    alerts = consumer;

    // Daemon-detected pi auth failures (status.json `pi_auth_expired`) ride
    // the same pipeline: on each poll, bridge a fresh flag into one alert
    // file; the consumer above does badge + notify + inject + cooldown.
    const { maybeWritePiAuthAlert } = await import("./alerts.js");
    const piAuthMem = { lastWritten: "" };
    const prevOnPoll = app.hooks.onPoll;
    app.hooks.onPoll = (a) => {
      prevOnPoll?.(a);
      try {
        maybeWritePiAuthAlert(full.companion.alerts_dir, a.view.snapshot?.pi_auth_expired, piAuthMem);
      } catch {
        // alerting is best-effort; never break the poll loop
      }
    };

    // §6 (rule-8 amendment): companion memory-edit requests. The
    // companion drops JSON under /alerts/memedit; the TUI validates and
    // executes over its own ssh. Sweep serialized behind a simple in-flight
    // flag so a slow ssh never stacks sweeps.
    const { processMemRequests } = await import("./memrequests.js");
    const { SshMemoryStore, blockHash } = await import("./memory.js");
    const memStore = new SshMemoryStore(cfg, realSshRunner);
    const memReqDir = join(full.companion.alerts_dir, "memedit");
    // The companion cannot read VM memory itself; the TUI publishes the
    // entries (with the expect-hashes addressed ops need) into the feed
    // every ~12 polls and right after a request batch lands.
    const memFeedPath = join(full.companion.feed_dir, "memory.json");
    const writeMemFeed = async (): Promise<void> => {
      const entries = await memStore.read();
      // tmp+rename like feed.ts — the companion polls this file and must
      // never see a torn write.
      mkdirSync(full.companion.feed_dir, { recursive: true });
      const payload = JSON.stringify({ written_at: new Date().toISOString(), entries: entries.map((e) => ({ ...e, expect: blockHash(e.text) })) }, null, 2) + "\n";
      writeFileSync(`${memFeedPath}.tmp`, payload);
      renameSync(`${memFeedPath}.tmp`, memFeedPath);
    };
    let memReqBusy = false;
    let memPollN = 0;
    const prevOnPoll2 = app.hooks.onPoll;
    app.hooks.onPoll = (a) => {
      prevOnPoll2?.(a);
      if (memReqBusy) return;
      memReqBusy = true;
      const feedDue = memPollN++ % 12 === 0;
      void processMemRequests(memReqDir, memStore)
        .then(async (done) => {
          for (const r of done) a.notice(`companion memedit ${r.file}: ${r.ok ? "✓" : "✖"} ${r.message}`);
          if (done.length > 0) memState.memLoaded = false; // timeline refresh on next open
          if (done.length > 0 || feedDue) await writeMemFeed();
        })
        .catch(() => {
          /* best-effort — never break the poll loop */
        })
        .finally(() => {
          memReqBusy = false;
        });
    };

    // the companion → TUI action channel. Same sweep discipline as
    // the memedit requests above (poll cadence, busy flag so a slow sweep
    // never stacks); processTuiActions itself archives-before-execute and
    // writes the result files. Each executed action's trace lands on the
    // notice line — instant execution is the ratified decision.
    const { processTuiActions } = await import("./actions.js");
    const tuiActionsDir = join(full.companion.alerts_dir, "tui-actions");
    const driver = buildTuiDriver(app, memState, metricsView, deployState);
    let tuiActBusy = false;
    const prevOnPoll3 = app.hooks.onPoll;
    app.hooks.onPoll = (a) => {
      prevOnPoll3?.(a);
      if (tuiActBusy) return;
      tuiActBusy = true;
      void processTuiActions(tuiActionsDir, driver)
        .then((done) => {
          for (const r of done) a.notice(r.trace ?? `companion tui-action ${r.file}: ✖ ${r.message}`);
        })
        .catch(() => {
          /* best-effort — never break the poll loop */
        })
        .finally(() => {
          tuiActBusy = false;
        });
    };
  }

  // Restore a hot-reload snapshot before run(), so the first paint is already
  // on the right tab with the right selection.
  const resumed = args.resumeState ? readResumeState(args.resumeState) : undefined;
  if (resumed) {
    if (resumed.tab === "digest") app.tab = "digest";
    else if (resumed.tab === "deploy") app.tab = "deploy";
    else if (resumed.tab === "metrics") app.tab = "metrics";
    app.view.eventsScroll = resumed.eventsScroll;
    app.view.eventsFocus = resumed.eventsFocus;
    app.view.detailFull = resumed.detailFull;
  }

  // Hot-reload: watch our own dist/ and re-exec when a new build lands.
  const reloadState = join(sandboxRoot(), "state", "tui-resume.json");
  const reloader = args.reload
    ? new HotReloader({
        distDir: join(sandboxRoot(), "dist"),
        stateFile: reloadState,
        isBusy: () => app.isBusy(),
        snapshot: () => ({
          tab: app.tab,
          pr: app.currentPr(),
          eventsScroll: app.view.eventsScroll,
          eventsFocus: app.view.eventsFocus,
          detailFull: app.view.detailFull,
          saved_at: "",
        }),
        reexec: (file) => realReexec(file, () => app.quit()),
      })
    : undefined;
  reloader?.start();
  app.hooks.onResume = () => reloader?.poke();

  // Deep link: run() completes its synchronous setup (terminal modes, poller)
  // before awaiting quit, so the attach can start right after — the board
  // loads behind it and is one Ctrl-q away.
  const initial = target.kind === "pr" ? target.pr : resumed?.pr;
  const running = app.run(initial);
  if (target.kind === "pr") void app.hooks.attach?.(`pr-${target.pr}`, app);
  else if (target.kind === "session") void app.hooks.attach?.(target.session, app);
  await running;
  reloader?.stop();
  alerts?.stop();

  // Clean quit stops the container (conversation + auth survive on volumes).
  // A crash deliberately leaves it running — the next start adopts it.
  if (companionUp) {
    try {
      await companion.gracefulStop();
    } catch {
      /* leaving it running is harmless: the next start adopts */
    }
  }
}
