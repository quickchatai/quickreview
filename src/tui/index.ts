// `qcr tui [pr|overseer]` entry point. Wires the real ssh runner; the
// optional target becomes the deep link.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig, sandboxRoot } from "../config.js";
import { App } from "./app.js";
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
                    feed, alert pipeline and the companion tab)
  --no-reload       do not re-exec when a new dist/ build lands

keys: 1/2/3/4/5 tabs (3 = companion, also c; 4 = deploy — click ▶ or D D deploys;
      5 = metrics — 7/0/a window, # <pr> ⏎ for a PR timeline) ·
      j/k select · ⏎ attach ·
      Ctrl-q detach (twice = literal) · Ctrl-c ×3 hard-kill the TUI ·
      s reconnect ssh (GCP passphrase, once) ·
      m quick-message · o overseer · M main · w detail · e events · r refresh ·
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
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
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
  const { installDigestHooks } = await import("./digesttab.js");
  installDigestHooks(app);
  const { RealDeployFetcher, installDeployHooks, realLocalRunner } = await import("./deploytab.js");
  installDeployHooks(app, new RealDeployFetcher(cfg, realSshRunner, realLocalRunner(sandboxRoot())));
  const { installMetricsHooks } = await import("./metricstab.js");
  installMetricsHooks(app);

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
