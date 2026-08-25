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
import { visiblePrs } from "./filters.js";
import { reselect } from "./model.js";
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
                    feed, alert pipeline; the companion column shows
                    "companion off")
  --no-reload       do not re-exec when a new dist/ build lands

keys: 1/2/3/4/5 tabs (2 = memory & learning — v toggles digest/memory view,
      x×2 retire · p pin · e edit · n new · A/R accept/reject a rubric proposal;
      3 = deploy — click ▶/■ buttons (D D deploy, S S stop/start);
      4 = metrics — 7/0/a window, # <pr> ⏎ for a PR timeline;
      5 = changes — every feedback-derived commit, newest first; R arms a
      revert of the selected one and y confirms, local commit only) ·
      companion column on every tab: type any unclaimed key (or /) to talk to
      it — every byte reaches pi · wheel over the column, or PgUp/PgDn while
      focused, walks its scrollback ·
      \ collapses the column · click it to take the keyboard ·
      j/k select · ⏎ focus the PR's pi pane ·
      Ctrl-q release focus · Ctrl-c ×3 hard-kill the TUI ·
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
 * Chain an onPoll wrapper AFTER whatever is already installed. EVERY wrapper
 * runTui adds composes through this — an installer that reassigns
 * `app.hooks.onPoll` bare silently drops every earlier wrapper (the FeedWriter
 * block did exactly that and killed the strip-refresh wrapper in production).
 */
export function chainOnPoll(app: App, fn: (a: App) => void): void {
  const prev = app.hooks.onPoll;
  app.hooks.onPoll = (a) => {
    prev?.(a);
    fn(a);
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
  // pi pane or companion column (same rule the mouse/tab handlers follow).
  // A busy App (operator input box open, attach suspended) is refused: a
  // synthesized keystroke would land in the operator's draft or nowhere.
  const prep = (): void => {
    if (app.piFocused()) app.blurPiPane();
    app.sidebar?.blur();
    if (app.isBusy()) throw new Error("operator input open / attach active — action refused");
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
      // A half-typed operator entry would swallow the "#" and prefix our
      // digits — clear entry mode first so the sequence starts clean.
      metricsView.prEntry = undefined;
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
      // (pageDigest is closure-private). files are date-named ASCENDING
      // (parseDigestList sorts); back counts BACK from the newest file.
      const i = memState.digest.files.findIndex((f) => f.startsWith(date));
      if (i < 0) throw new Error(`no digest for ${date}`);
      const target = memState.digest.files.length - 1 - i;
      const delta = target - memState.digest.back;
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
      // The old ordinal may point past (or at a hole in) the narrowed list.
      app.view.selected = reselect(visiblePrs(app.view), undefined, app.view.selected);
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
        if (!deployState.run) throw new Error("deploy_tab abort refused — no run in flight");
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
      if (kind !== action) throw new Error(`deploy_tab ${action} refused — container is ${deployState.containerStatus ?? "unknown"}`);
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
  const { installUnwedgeHooks } = await import("./unwedge.js");
  installUnwedgeHooks(app);
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
  // ONE memory store for the whole TUI: OpenViking on the VM,
  // reached over the memory forward's loopback listener, holding BOTH user
  // keys. Every memory surface in the TUI shares this instance — a second one
  // would mean a second sweep and a second health opinion.
  const { tuiMemoryStore, tuiMemoryBaseUrl } = await import("./memory.js");
  const memStore = tuiMemoryStore();
  // the TUI brings the memory forward up itself, so the Memory tab
  // works without the operator installing the systemd unit first. It ADOPTS a
  // forward that is already listening (the unit, or another qcr tui) and stops
  // only one it started — see memforward.ts for why that split matters.
  const { MemoryForward } = await import("./memforward.js");
  const memForward = new MemoryForward({
    baseUrl: tuiMemoryBaseUrl(),
    repoRoot: sandboxRoot(),
    log: (line) => app.notice(line),
  });
  // Eagerly, not on first visit to the tab: the companion container reaches
  // memory over the same forward's docker-bridge bind, and it starts below
  // regardless of which tab the operator is looking at.
  void memForward.ensure();
  const memState = installMemoryLearningHooks(app, {
    memory: memStore,
    forward: memForward,
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

  // the change register — every feedback-derived commit (identified by
  // its `Ratified-in-session:` trailer), newest first, with a one-key revert.
  // It reads and writes the LOCAL checkout only, through the same read-only
  // local-git seam the deploy tab uses; nothing here touches the VM, GitHub or
  // the gate. Persisted under state/ so the list is on screen before git has
  // been asked anything.
  const { ChangeLog, ChangeRegisterStore } = await import("./changelog-store.js");
  const { installChangesHooks } = await import("./changestab.js");
  installChangesHooks(app, new ChangeLog(new ChangeRegisterStore(join(sandboxRoot(), "state", "changes")), localRunner));

  // finished-round evidence, copied down from the VM into a local
  // store the companion reads read-only. Created BEFORE the container starts —
  // the mount source must exist first, or docker invents it root-owned and the
  // copier can never write into it.
  const { EvidenceCopier, EvidenceStore } = await import("./evidence.js");
  const evidence = new EvidenceStore(full.companion.evidence_dir);
  try {
    evidence.ensure();
  } catch (err) {
    app.notice(`✖ evidence store ${evidence.dir}: ${String(err instanceof Error ? err.message : err)}`);
  }

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
      // BEFORE the container, never after: the companion's pi extension picks
      // the user namespace it writes into by listing `viking://user/`, and
      // caches that choice for the life of the process. A namespace whose
      // directory does not exist yet is invisible to it, so it falls back to
      // `user/default` and every write is refused — the whole of 2026-08-21,
      // reported only as "access denied". Needs the forward up, so await it
      // rather than riding the eager `ensure()` above.
      const fwd = await memForward.ensure();
      if (fwd.state === "adopted" || fwd.state === "owned") {
        for (const note of await memStore.ensureNamespaces()) app.notice(`memory: ${note}`);
      }
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
  // no pty spawner here any more — the companion is never opened
  // full-screen, so the only thing left to install is the startup healing.
  const { installCompanionTabHooks } = await import("./companiontab.js");
  installCompanionTabHooks(app, {
    lifecycle: companion,
    available: () => companionUp,
    failure: () => companionError,
    retry: companionOn ? startCompanion : undefined,
  });

  // the companion sidebar — a permanent right-hand column on every
  // tab, and the ONLY companion surface (the strip and the full-screen attach
  // it opened are both retired). Mirror + send go through the same local
  // docker seam the lifecycle uses; refresh piggybacks the app poll (the
  // sidebar's own 500ms timer only runs focused/after-send).
  const { CompanionSidebar, restorePreferredSidebarWidth } = await import("./sidebar.js");
  app.sidebar = new CompanionSidebar(full.companion, realDockerRunner, {
    available: () => companionUp,
    onUpdate: () => app.repaint(),
  });
  chainOnPoll(app, (a) => void a.sidebar?.refresh());
  // The header carries what the sidebar cannot know for itself: whose day it
  // is (the companion rolls over on the Warsaw boundary, so a stale day in
  // the header is the first visible sign a rollover was missed) and whether
  // memory is actually reachable — a companion talking with no memory behind
  // it looks identical to a healthy one until you ask it something.
  const { todayDate } = await import("./rollover.js");
  chainOnPoll(app, (a) => {
    const fwd = memForward.view();
    a.sidebar?.setHeader({
      day: todayDate(new Date()),
      memory: fwd.state === "failed" ? "degraded" : fwd.state === "off" ? "off" : "ok",
    });
  });

  // the evidence copier rides the EXISTING poll — no second scheduler,
  // and deliberately not awaited. `sweep()` is re-entrant-safe (a sweep in
  // flight makes the next call a no-op) and every remote read is killed at
  // `evidence_timeout_s`, so a wedged ssh control master stalls the copier and
  // nothing else: the poll keeps polling and the board keeps painting. Runs
  // whether or not the companion is up — the record is worth keeping either
  // way, and it is what the companion will read when it next starts.
  const evidenceCopier = new EvidenceCopier(cfg, evidence, realSshRunner, {
    sessionDir: full.pi.session_dir,
    timeoutMs: Math.max(5, cfg.evidence_timeout_s) * 1000,
    onNotice: (text) => app.notice(text),
  });
  chainOnPoll(app, (a) => {
    void evidenceCopier.sweep(a.view.snapshot).catch(() => {
      /* best-effort — a failed copy is retried on the next poll, never fatal */
    });
  });

  // the durable candidate list behind the `survey` skill. Derived from
  // what is already on this disk — the poll snapshot plus's round
  // manifests — so it costs ZERO remote reads and rides the same poll. It lands
  // in the evidence dir, which is already mounted `/evidence:ro`, so the
  // companion reads `/evidence/candidates.json` over an existing channel and
  // cannot write to it.
  //
  // Judged-ness comes back the other way, out of the `#adjudication` memory
  // entries `adjudicate` already mandates — one record, one direction, and no
  // second write path from the companion. It is read at a slow cadence because
  // memory is an HTTP hop and the list only needs it to stop re-offering
  // something settled.
  const { CandidateStore, CandidateSweeper, adjudicationsFrom } = await import("./candidates.js");
  const candidates = new CandidateStore(full.companion.evidence_dir);
  let adjudicationsAt = 0;
  let adjudicationsCache = new Map<number, string>();
  const candidateSweeper = new CandidateSweeper(candidates, {
    evidenceDir: evidence.dir,
    onNotice: (text) => app.notice(text),
    adjudications: async () => {
      // 5 minutes: an adjudication is a human-scale event, and a stale map only
      // re-offers something already judged for one more cycle.
      if (Date.now() - adjudicationsAt < 300_000) return adjudicationsCache;
      adjudicationsAt = Date.now();
      adjudicationsCache = adjudicationsFrom(await memStore.read());
      return adjudicationsCache;
    },
  });
  chainOnPoll(app, (a) => {
    void candidateSweeper.sweep(a.view.snapshot).catch(() => {
      /* best-effort — the survey is rebuilt from scratch on the next poll */
    });
  });

  let alerts: { stop(): void } | undefined;
  if (companionUp) {
    const { FeedWriter, buildTuiView } = await import("./feed.js");
    const feed = new FeedWriter(full.companion.feed_dir);

    // publish the operator's view: the last painted frame plus the
    // derived state behind it. Two triggers, one throttle: the poll below (so
    // it keeps up with the daemon) and every repaint (so it keeps up with
    // the owner's keystrokes — "what is on his screen" is only true if it
    // tracks the screen). Files only: this NEVER injects a companion turn,
    // and the companion reads it on demand through the `tui_*` tools.
    const publishView = (): void => {
      try {
        feed.writeView(
          buildTuiView({
            now: new Date(),
            tab: app.tab,
            snapshot: app.view.snapshot,
            health: app.view.health,
            selectedPr: app.currentPr(),
            panePr: app.view.piPr,
            paneFocused: app.view.piFocus === true,
            notice: app.view.noticeLine,
            deploy: deployState,
          }),
          app.screenText(),
        );
      } catch {
        // Publishing the view is a side effect of painting it — a failure here
        // must never surface on the notice line, let alone break the poll.
      }
    };
    app.afterRepaint = publishView;
    chainOnPoll(app, () => publishView());

    chainOnPoll(app, (a) => {
      const snap = a.view.snapshot;
      if (!snap) return;
      try {
        feed.write(snap, a.rawEvents, a.view.health.kind);
      } catch (err) {
        a.notice(`✖ feed write failed: ${String(err instanceof Error ? err.message : err)}`);
      }
    });

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
    chainOnPoll(app, (a) => {
      try {
        maybeWritePiAuthAlert(full.companion.alerts_dir, a.view.snapshot?.pi_auth_expired, piAuthMem);
      } catch {
        // alerting is best-effort; never break the poll loop
      }
    });

    // No memory request-file channel here, and no memory feed:
    // the companion reaches OpenViking DIRECTLY, over a host-owned forward,
    // holding both USER keys. The `/alerts/memedit` mediation and the
    // `/feed/memory.json` publication it depended on are retired —
    // two write paths was the thing being deleted. Do not reintroduce either
    // as an "offline fallback".

    // the companion → TUI action channel. Sweep discipline is the
    // usual one (poll cadence, busy flag so a slow sweep never stacks);
    // processTuiActions itself archives-before-execute and
    // writes the result files. Each executed action's trace lands on the
    // notice line — instant execution is the ratified decision.
    const { processTuiActions } = await import("./actions.js");
    const tuiActionsDir = join(full.companion.alerts_dir, "tui-actions");
    const driver = buildTuiDriver(app, memState, metricsView, deployState);
    let tuiActBusy = false;
    chainOnPoll(app, (a) => {
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
    });
  }

  // Restore a hot-reload snapshot before run(), so the first paint is already
  // on the right tab with the right selection.
  const resumed = args.resumeState ? readResumeState(args.resumeState) : undefined;
  if (resumed) {
    if (resumed.tab === "digest") app.tab = "digest";
    else if (resumed.tab === "deploy") app.tab = "deploy";
    else if (resumed.tab === "metrics") app.tab = "metrics";
    else if (resumed.tab === "changes") app.tab = "changes";
    app.view.eventsScroll = resumed.eventsScroll;
    app.view.eventsFocus = resumed.eventsFocus;
    app.view.detailFull = resumed.detailFull;
    if (app.sidebar && resumed.sidebarWidth !== undefined) {
      app.sidebar.preferredWidth = restorePreferredSidebarWidth(resumed.sidebarWidth);
    }
  }

  // Hot-reload: watch our own dist/ and re-exec when a new build lands.
  const reloadState = join(sandboxRoot(), "state", "tui-resume.json");
  const reloader = args.reload
    ? new HotReloader({
        distDir: join(sandboxRoot(), "dist"),
        stateFile: reloadState,
        snapshot: () => ({
          tab: app.tab,
          pr: app.currentPr(),
          eventsScroll: app.view.eventsScroll,
          eventsFocus: app.view.eventsFocus,
          detailFull: app.view.detailFull,
          sidebarWidth: app.sidebar?.preferredWidth,
          saved_at: "",
        }),
        // The forward MUST be released here, not in the cleanup after
        // `await running`. `realReexec` calls this teardown and then
        // spawnSync's the new build synchronously — `app.quit()` merely
        // resolves a promise, so that cleanup is a microtask which cannot run
        // until spawnSync returns, i.e. not until the child has exited. Left
        // to it, the old process would sit inside spawnSync holding :1933
        // with a FROZEN event loop: the new TUI finds the port taken, cannot
        // bind, and memory is dead for the rest of the session.
        reexec: (file) =>
          realReexec(file, () => {
            memForward.stop();
            app.quit();
          }),
      })
    : undefined;
  reloader?.start();

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
  // Closes only a forward THIS process bound; an adopted one (systemd unit,
  // another qcr tui) is left running on purpose — see memforward.ts.
  memForward.stop();

  // Clean quit stops the container (conversation + auth survive on volumes).
  // A crash deliberately leaves it running — the next start adopts it.
  //
  // This runs AFTER the terminal is restored, so every millisecond it takes is
  // a terminal that looks dead: board gone, prompt not back, nothing
  // responding. It used to take 10.1s — `docker stop`'s full timeout, because
  // the container's PID 1 ignored SIGTERM (fixed that in the
  // entrypoint). Say what is happening regardless: a slow docker, or a
  // container built before that fix, must not look like a hang.
  if (companionUp) {
    process.stdout.write("qcr tui: stopping the companion container…\n");
    try {
      await companion.gracefulStop();
    } catch {
      /* leaving it running is harmless: the next start adopts */
    }
  }
  // Exit explicitly. Anything still holding the event loop — a docker exec
  // that never returned, an ssh master, a socket — would otherwise keep the
  // process alive with the terminal already restored, which is exactly the
  // "TUI is gone but the shell never comes back" state.
  process.exit(0);
}
