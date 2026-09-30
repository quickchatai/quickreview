// `qcr tui [pr|overseer]` entry point. Wires the real ssh runner; the
// optional target becomes the deep link.
import { join } from "node:path";
import { liveConfigPath, loadConfig, sandboxRoot, type Config } from "../config.js";
import type { TuiDriver } from "./actions.js";
import { App } from "./app.js";
import type { DeployState } from "./deploytab.js";
import type { LearningTabs } from "./learning.js";
import type { MetricsView } from "./metricstab.js";
import { ensureSshMaster } from "./connect.js";
import { MOUSE_OFF, MOUSE_ON } from "./mouse.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR } from "./paint.js";
import { visiblePrs } from "./filters.js";
import { memoryOrder } from "./memtab.js";
import { reselect } from "./model.js";
import { isTab } from "./tabs.js";
import { HotReloader, parseResumeArg, readResumeState, realReexec } from "./reload.js";
import { killInFlightSsh, runnerFor, transportOf } from "./remote.js";
import { chainOnPoll } from "./poll-hooks.js";
import type { ConnectionDiagnosis } from "./sshtriage.js";

export { chainOnPoll } from "./poll-hooks.js";

/**
 * `qcr tui <pr>` opens the board with that PR selected. `overseer` and `main`
 * used to deep-link into a full-screen attach of those sessions; the attach
 * is gone (2026-09-02 — the TUI never attaches to a VM session), so both are
 * refused with the place to go instead.
 */
export function parseTarget(
  arg: string | undefined,
): { kind: "none" } | { kind: "pr"; pr: number } | { kind: "bad"; reason: string } {
  if (arg === undefined || arg === "") return { kind: "none" };
  if (/^\d+$/.test(arg)) return { kind: "pr", pr: Number(arg) };
  if (arg === "overseer" || arg === "main") {
    return {
      kind: "bad",
      reason: `'${arg}' is no longer a target — the TUI never attaches to the ${arg} session; open the board and ask the companion`,
    };
  }
  return { kind: "bad", reason: `unknown target '${arg}' — expected a PR number` };
}

export const TUI_HELP = `qcr tui — live board for the review daemon (over ssh, read-only)

usage: qcr tui [<pr>] [--no-companion] [--no-reload]

  qcr tui           open the board
  qcr tui 5012      open the board with PR 5012 selected (⏎ focuses its pi pane)

  --no-companion    do not run the local companion (container, ambient feed,
                    alert pipeline). The layout does not change: the column
                    is still on the right and says "companion off"
  --no-reload       do not re-exec when a new dist/ build lands

layout: ONE shape, always — the tab on the left, the companion column on the
        right. Nothing goes full-screen and nothing collapses the column;
        anything you would have attached to a VM session for, ask the
        companion.

keys: 1…8 the eight surfaces — board · memory · digest · tickets · deploy ·
      metrics · feedback · scan (docs/tui.md says what each is for; the bar at the
      foot of the screen shows what the current frame answers to) ·
      2 memory: j/k select · [ ] older/newer day · e p x n edit/pin/retire/new ·
      3 digest: [ ] older/newer · 4 tickets: c actionable ⇄ all ·
      5 deploy: click ▶/■ buttons (D D deploy, S S stop/start) ·
      6 metrics: w/m/a window, # <pr> ⏎ for a PR timeline ·
      7 feedback: t focus · a archived · A/x accept/reject a proposal ·
      R then y reverts a feedback-derived commit (local, never pushed) ·
      8 scan: [ ] unit · p promote · d dismiss · f/F filter · P plan (space
      toggles a row, ⏎ approves, Esc back) · x stop · D delta re-scan ·
      companion column on every tab: type any unclaimed key (or /) to talk to
      it — every byte reaches pi · wheel over the column, or PgUp/PgDn while
      focused, walks its scrollback ·
      drag its left edge to resize · click it to take the keyboard ·
      board: j/k select · ⏎ focus the PR's pi pane · m quick-message ·
      g github · u unwedge · e events overlay · I set up the repo ·
      Ctrl-q release focus · Ctrl-c ×3 hard-kill the TUI ·
      s reconnect ssh (GCP passphrase, once) · r refresh ·
      ? full key map · q quit

troubleshooting:
  ✖ unreachable      ssh to the VM failed. The board names WHICH of the
                     three usual causes it is and prints the exact command to
                     run — a key missing from the agent (ssh-add …), a wedged
                     shared master (ssh -O exit …), or a host that is simply
                     not answering. Nothing is run for you; s re-checks and
                     reports, and offers the one GCP passphrase prompt when a
                     key is what is missing
  ▲ DATA STALE       ssh works but status.json stopped updating — the
                     container is down or the daemon hung (qcr-side:
                     ssh <host> sudo docker ps / docker logs)
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
export function buildTuiDriver(
  app: App,
  learning: LearningTabs,
  metricsView: MetricsView,
  deployState: DeployState,
): TuiDriver {
  // One keyboard owner at a time: an action must never type into a focused
  // pi pane or companion column (same rule the mouse/tab handlers follow).
  // A busy App (operator input box open, terminal lent to the `s` passphrase
  // prompt) is refused: a synthesized keystroke would land in the operator's
  // draft or nowhere.
  const prep = (): void => {
    if (app.piFocused()) app.blurPiPane();
    app.sidebar?.blur();
    if (app.isBusy()) throw new Error("operator input open / terminal in use — action refused");
  };
  const driver: TuiDriver = {
    switchTab: (tab) => {
      prep();
      app.tab = tab; // one vocabulary: the verb's tab name IS the App's (src/tui/tabs.ts)
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
      app.repaint();
      // Page to the day through the tab's own [ / ] keys so content loads.
      // files are date-named ASCENDING (parseDigestList sorts); back counts
      // BACK from the newest file. An unlisted digest is a failed result —
      // including when the listing itself has not happened or failed.
      const files = learning.store.digest.files ?? [];
      const i = files.findIndex((f) => f.startsWith(date));
      if (i < 0) throw new Error(`no digest for ${date}`);
      const target = files.length - 1 - i;
      const delta = target - learning.store.digest.back;
      for (let k = 0; k < Math.abs(delta); k++) app.pressKey(delta > 0 ? "[" : "]");
    },
    memoryView: (opts) => {
      prep();
      app.tab = "memory";
      const mem = learning.memory;
      if (opts.tag !== undefined) {
        mem.filter = opts.tag;
        mem.sel = 0; // old ordinal may exceed the narrowed list
        mem.selKey = undefined;
      }
      if (opts.day !== undefined) {
        // The day is a JUMP in the day-grouped timeline: land on its first
        // entry. A day with no entry under the current filter is a failed
        // result, not a silent no-op.
        const ordered = memoryOrder(learning.store.entries, mem.filter);
        const i = ordered.findIndex((e) => e.day === opts.day);
        if (i < 0)
          throw new Error(
            `no memory entries on ${opts.day}${mem.filter ? ` under #${mem.filter}` : ""}`,
          );
        mem.sel = i;
        mem.selKey = `${ordered[i]!.ts}|${ordered[i]!.id}#${ordered[i]!.block}`;
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
      app.tab = "memory";
      learning.memory.filter = tag;
      learning.memory.sel = 0;
      learning.memory.selKey = undefined;
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
      // stop/start: the tab's S button computes its own kind from the OBSERVED
      // container state; refuse a mismatched request rather than silently doing
      // the opposite — and refuse outright when that state has not been read.
      // Unknown folded into "stop" here exactly as it did in the tab, so a
      // companion asking for a stop could stop a live reviewer on data nobody
      // fetched.
      if (deployState.containerStatus === undefined) {
        throw new Error(
          `deploy_tab ${action} refused — the container's state has not been read yet`,
        );
      }
      const kind = !/^Up /.test(deployState.containerStatus) ? "start" : "stop";
      if (kind !== action)
        throw new Error(
          `deploy_tab ${action} refused — container is ${deployState.containerStatus}`,
        );
      app.pressKey("S");
      app.pressKey("S");
    },
  };
  return driver;
}

/**
 * Injectable ends of the TUI process. Production passes none of them; the
 * startup-contract test passes all four, so it can drive a real `runTui`
 * against fake terminal streams without depending on the operator's
 * `config.toml` and without the process exiting under vitest.
 */
export interface RunTuiDeps {
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  config?: Config;
  exit?: (code: number) => void;
}

/**
 * `qcr tui` — the whole startup, in two phases (contract).
 *
 * PHASE 0 is local only: parse, config, wire, and PAINT. Nothing external —
 * no ssh, no docker, no network, no directory scan — may run before the first
 * frame, and the frame it paints is the REAL layout with every unfetched value
 * marked unknown. The companion column's width comes from config, which is the
 * only layout-affecting fact there was, so nothing jumps when the container
 * later arrives (that is's objection, answered rather than dodged).
 *
 * PHASE 1 is the bring-up, streaming in behind that frame and reporting into
 * the companion column: connection triage, memory forward, namespaces,
 * container, day rollover, pi. It never blocks the board, and a step that
 * fails is a degraded mode, never a reason the TUI does not open.
 */
/** First slice of the quit-time wait for an in-flight bring-up. */
const BRING_UP_QUIT_GRACE_MS = 250;

/** True if the promise settled inside `ms`. The timer is unref'd, so a slow
 * bring-up can never be the thing that holds the process open. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  const settled = await Promise.race([p.then(() => true), timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

export async function runTui(argv: string | string[] = [], deps: RunTuiDeps = {}): Promise<void> {
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
  const out = deps.out ?? process.stdout;
  const input = deps.input ?? process.stdin;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  if (!out.isTTY || !input.isTTY) {
    console.error("qcr tui needs an interactive terminal");
    process.exitCode = 2;
    return;
  }

  // ---- phase 0: local only, ending in the first frame -----------------------

  const full = deps.config ?? loadConfig();
  const cfg = full.tui;
  // ONE transport decision for every remote op — ssh to the VM, or
  // the same commands against local docker on the laptop topology.
  const runner = runnerFor(cfg);

  const app = new App(cfg, runner, out, input);

  // The terminal must come back whatever kills us — raw mode + alt screen
  // surviving a crash is exactly the "only closing the terminal works" trap.
  const restoreTerminal = (): void => {
    try {
      if (input.isTTY) input.setRawMode(false);
    } catch {
      /* stdin already gone */
    }
    out.write(MOUSE_OFF + ALT_SCREEN_OFF);
  };
  process.on("exit", restoreTerminal);
  process.on("SIGINT", () => {
    restoreTerminal();
    exit(130);
  });
  process.on("SIGTERM", () => {
    restoreTerminal();
    exit(143);
  });
  process.on("uncaughtException", (err) => {
    restoreTerminal();
    console.error("qcr tui crashed:", err);
    exit(1);
  });

  /** Suspend the TUI, run something on the real terminal, come back. */
  const onRealTerminal = (fn: () => void): void => {
    // Quit can land mid-flight (the operator presses `s`, then Ctrl-C twice
    // while the probes run). The terminal is already restored by then, so
    // going back into the alt screen would leave a blank alternate screen with
    // no TUI behind it. Run the work plainly and leave the terminal alone.
    if (app.isStopped()) {
      fn();
      return;
    }
    app.suspend();
    try {
      if (input.isTTY) input.setRawMode(false);
    } catch {
      /* keep going — fn may still work */
    }
    out.write(MOUSE_OFF + ALT_SCREEN_OFF);
    try {
      fn();
    } finally {
      // Deliberate, and NOT safe to "fix": this return also swallows a throw
      // from fn(), which is what we want on the quit path — the alt screen is
      // already gone, and restoring it to report an error would repaint over
      // the shell the operator is back in. Restructuring so the return sits
      // outside the finally would change that, and error propagation on quit
      // is behaviour, not style.
      // eslint-disable-next-line no-unsafe-finally
      if (app.isStopped()) return; // quit happened while fn ran
      if (input.isTTY) input.setRawMode(true);
      out.write(ALT_SCREEN_ON + CLEAR + MOUSE_ON);
      app.resume();
    }
  };
  const { DurableDeployProcess } = await import("./deploy-process.js");
  const durableDeploy = new DurableDeployProcess(sandboxRoot());
  app.hooks.deployRun = (_theApp, runId, onData, onExit) =>
    durableDeploy.startOrAttach(runId, onData, onExit);
  app.view.repo = full.github.repo;
  const { spawn } = await import("node:child_process");
  const { openUrlDetached } = await import("./openurl.js");
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  app.hooks.openUrl = (url) => openUrlDetached(url, (line) => app.notice(line));
  const marker = join(sandboxRoot(), "state", "tui-help-shown");
  app.hooks.helpSeen = {
    get: () => existsSync(marker),
    set: () => {
      mkdirSync(join(sandboxRoot(), "state"), { recursive: true });
      writeFileSync(marker, new Date().toISOString());
    },
  };

  // The companion column is LAYOUT (ruling 2, made unconditional
  // 2026-09-02): its width depends on nothing but the terminal, so wiring it
  // here — before anything asks docker whether the container is running — is
  // what makes the first frame the real one. The sidebar is only
  // `available()` once the container answers, and the container fills a
  // column that was already the right size.
  const { CompanionSidebar, restorePreferredSidebarWidth } = await import("./sidebar.js");
  const { CompanionLifecycle, realDockerRunner } = await import("./companion.js");
  const companion = new CompanionLifecycle(full.companion, realDockerRunner);
  // the companion's READ-ONLY GitHub token, minted HERE from the App
  // credential this host holds and handed over as an env file in a dir the
  // container mounts read-only. Refreshed while the TUI runs (it lives an
  // hour); constructed now, first minted in the bring-up — it is network.
  const { CompanionGithubToken, tokenOutcomeLine } = await import("./ghread.js");
  const { companionGithubDir } = await import("../install.js");
  const ghToken = new CompanionGithubToken({
    dir: companionGithubDir(),
    repo: full.github.repo,
    secretsDir: full.github.secrets_dir,
  });
  let configMirrorTimer: NodeJS.Timeout | undefined;
  const CONFIG_MIRROR_EVERY_MS = 30_000;
  const companionOn = args.companion && full.companion.enabled;
  let companionUp = false;
  let companionError: string | undefined;
  // The column exists in EVERY configuration (2026-09-02): `--no-companion`
  // and `[companion] enabled = false` decide what runs and what the column
  // says, never whether the right half of the screen is there.
  app.sidebar = new CompanionSidebar(full.companion, realDockerRunner, {
    available: () => companionUp,
    onUpdate: () => app.repaint(),
  });
  if (!companionOn)
    app.sidebar.setOff(args.companion ? "[companion] enabled = false" : "--no-companion");

  // Bring-up progress goes IN that column (ruling 3): it is empty at this
  // moment and already the right shape, so it costs no new surface — and the
  // lines are never written to the normal screen, where the alt screen's clear
  // used to erase them (that erasure was the flicker). With the companion off
  // the same column carries the skipped steps, and stays as the place that
  // says WHY it is off.
  const { StartupProgress } = await import("./startup.js");
  const progress = new StartupProgress(undefined, {
    onUpdate: (p) => {
      // Kept after the bring-up settles ON PURPOSE: a `✗ companion container ·
      // docker is not running` is the most useful thing the column can show,
      // and clearing it would delete the diagnosis a second after it appeared.
      // The hand-off is the sidebar's `mirrored` latch — the checklist yields
      // to pi's first real capture and never comes back.
      app.sidebar?.setStartup(p.lines());
      app.repaint();
    },
  });
  app.sidebar.setStartup(progress.lines());

  // No attach hooks: the full-screen attach is retired — see AppHooks.
  const { installMessageHooks } = await import("./msg.js");
  installMessageHooks(app);
  const { installUnwedgeHooks } = await import("./unwedge.js");
  installUnwedgeHooks(app);
  // `I` asks the companion to run its setup skill — one inject into
  // its own column (drained now, or at its next start) — and hands it the
  // keyboard. The same ask `qcr setup` makes from a shell.
  const { requestSetup, commitRequestedProfiles, commitLine } = await import("./setupentry.js");
  const { companionInjectDir } = await import("./companion.js");
  app.hooks.setup = (theApp) => {
    try {
      requestSetup({ injectDir: companionInjectDir(full.companion) });
    } catch (err) {
      theApp.notice(`setup: the request could not be written — ${String(err)}`);
      return;
    }
    theApp.notice(
      companionUp
        ? "setup: asked the companion — it takes it from here"
        : "setup: asked — the companion picks it up when it starts",
    );
    theApp.openCompanion();
  };
  // The profile commits setup asked for, carried out HERE, on the config
  // mirror's timer — the container cannot see the config home's .git (the
  // home holds secrets/, so it is never mounted whole).
  const commitProfiles = (): void => {
    for (const r of commitRequestedProfiles()) app.notice(commitLine(r));
  };
  // The four learning surfaces — [2] memory, [3] digest, [4] tickets,
  // [7] feedback — over ONE store. Accept-verdict git
  // actions run against THIS working copy (the canonical repo); the [sink]
  // config decides where the defect auto-filer writes (wayfinder
  // tracker, gated github command channel, or none) and which effort the
  // ticket projection reads.
  const { installLearningTabs } = await import("./learning.js");
  const { execFile } = await import("node:child_process");
  const gitRun = (cmd: string, args2: string[], stdin?: string): Promise<string> =>
    new Promise((res, rej) => {
      const child = execFile(cmd, args2, { cwd: sandboxRoot() }, (err, stdout, stderr) => {
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
  // Constructed here, STARTED in the bring-up: `ensure()` probes over HTTP.
  const { MemoryForward } = await import("./memforward.js");
  const memForward = new MemoryForward({
    baseUrl: tuiMemoryBaseUrl(),
    repoRoot: sandboxRoot(),
    // the forward follows the SAME [tui] target knob — local mode
    // reaches the daemon container's loopback engine via plain docker exec.
    local: transportOf(cfg) === "local",
    sudoDocker: cfg.sudo_docker,
    log: (line) => app.notice(line),
  });
  const { buildIssueSink, ticketProjection } = await import("./issuesink.js");
  const { readEffortTickets } = await import("./trackertickets.js");
  const projection = ticketProjection(full);
  const { RealDeployFetcher, installDeployHooks, powerSpawnArgv, realLocalRunner } =
    await import("./deploytab.js");
  const { FileDeployCeremonyStore } = await import("./deploy-ceremony.js");
  const localRunner = realLocalRunner(sandboxRoot());
  // the change register — every feedback-derived commit (identified by
  // its `Ratified-in-session:` trailer), newest first, with a one-key revert
  // on the feedback tab. It reads and writes the LOCAL checkout only, through
  // the same read-only local-git seam the deploy tab uses; nothing here
  // touches the VM, GitHub or the gate. Persisted under state/ so the list is
  // on screen before git has been asked anything.
  const { ChangeLog, ChangeRegisterStore } = await import("./changelog-store.js");
  const { stateHome } = await import("../install.js");
  const { PIN_PROPOSALS_FILE, parsePinProposals } = await import("../setup/pins.js");
  const learning = installLearningTabs(app, {
    memory: memStore,
    // the entries setup proposed to pin, marked ☆ on the memory tab.
    readPinProposals: () => {
      try {
        return parsePinProposals(readFileSync(join(stateHome(), PIN_PROPOSALS_FILE), "utf8"));
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT"
          ? { state: "absent" }
          : { state: "unreadable", error: String(err) };
      }
    },
    forward: memForward,
    gitRun,
    repoRoot: sandboxRoot(),
    configPath: liveConfigPath(),
    sink: buildIssueSink(full, app.ssh, memStore),
    changes: new ChangeLog(
      new ChangeRegisterStore(join(sandboxRoot(), "state", "changes")),
      localRunner,
    ),
    ...(projection
      ? {
          readTickets: () => readEffortTickets(projection.root, projection.effort),
          ticketsEffort: projection.effort,
        }
      : {}),
  });
  app.hooks.powerRun = (_theApp, action, onData, onExit) => {
    // docker stop/start on the VM (or local docker in local mode),
    // streamed into the tab like a deploy.
    const cmd = powerSpawnArgv(cfg, action);
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    onData(`$ ${cmd.join(" ")}\n`);
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

  const deployState = installDeployHooks(
    app,
    new RealDeployFetcher(cfg, runner, localRunner),
    undefined,
    undefined,
    new FileDeployCeremonyStore(join(sandboxRoot(), "state", "tui-deploy-ceremony.json")),
  );
  const { installMetricsHooks, localHeadProbe } = await import("./metricstab.js");
  // The metrics OPERATIONS card answers "deploy needed?" through the same
  // read-only local-git seam the deploy tab uses.
  const metricsView = installMetricsHooks(app, undefined, localHeadProbe(localRunner));
  // `[8] scan` — the scan report, read from the state home the
  // companion writes. Its two request files (the stage-2 start, the stop)
  // are answered by the companion's scan belt; promote, dismiss and delta go
  // to the companion as the operator's asks, through the setup entry's inject
  // channel.
  const { installScanTab, ScanReportStore } = await import("./scantab.js");
  const { writeCompanionAsk } = await import("./setupentry.js");
  installScanTab(app, {
    store: new ScanReportStore(stateHome()),
    ask: (text, verb) => {
      try {
        writeCompanionAsk({ injectDir: companionInjectDir(full.companion), suffix: `scan-${verb}`, text });
      } catch (err) {
        return { ok: false, line: `✖ scan ${verb}: the ask could not be written — ${String(err)}` };
      }
      return {
        ok: true,
        line: companionUp
          ? `scan ${verb}: asked the companion — the report updates when it has acted`
          : `scan ${verb}: asked — the companion picks it up when it starts`,
      };
    },
    companionUp: () => (!companionOn || companionError !== undefined ? false : companionUp ? true : undefined),
  });

  // finished-round evidence, copied down from the VM into a local
  // store the companion reads read-only. Its dir is CREATED in the bring-up,
  // before the container starts — the mount source must exist first, or docker
  // invents it root-owned and the copier can never write into it.
  const { EvidenceCopier, EvidenceStore } = await import("./evidence.js");
  const evidence = new EvidenceStore(full.companion.evidence_dir);

  // ambient feed + alert pipeline + startup healing. All of it hangs
  // off companionOn, so --no-companion really means "none of this runs" —
  // the column itself is not part of "this": it is layout, and it is always
  // there.
  const { companionStarter, installCompanionTabHooks } = await import("./companiontab.js");

  // the companion sidebar is the ONLY companion surface (the strip and
  // the full-screen attach it opened are both retired). Mirror + send go
  // through the same local docker seam the lifecycle uses; refresh piggybacks
  // the app poll (the sidebar's own 500ms timer only runs focused/after-send).
  chainOnPoll(app, (a) => void a.sidebar?.refresh());
  // The header carries what the sidebar cannot know for itself: whose day it
  // is (the companion rolls over on the ops-timezone boundary, so a stale day
  // in the header is the first visible sign a rollover was missed) and whether
  // memory is actually reachable — a companion talking with no memory behind
  // it looks identical to a healthy one until you ask it something.
  const { todayDate } = await import("./rollover.js");
  chainOnPoll(app, (a) => {
    const fwd = memForward.view();
    a.sidebar?.setHeader({
      day: todayDate(new Date(), process.env, full.ops.timezone),
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
  const evidenceCopier = new EvidenceCopier(cfg, evidence, runner, {
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

  // ---- the connection triage (ruling 4) ----------------------------
  //
  // The TUI does the three-way ssh triage the operator used to do by hand, and
  // it does it BEHIND the first frame: the old startup ran `ensureSshMaster`
  // synchronously before the alt screen, which is both a network call gating
  // the first paint and, on a bad day, an interactive prompt. Nothing here is
  // self-healing — the owner declined that explicitly; the TUI reports the
  // cause and the exact command, and `s` re-runs the check.
  const { diagnosisLine, triageConnection } = await import("./sshtriage.js");
  const applyDiagnosis = (d: ConnectionDiagnosis): void => {
    app.view.connection = d;
    if (d.kind === "ok" || d.kind === "local") progress.done("ssh", d.cause);
    else progress.fail("ssh", diagnosisLine(d));
    app.notice(d.kind === "ok" || d.kind === "local" ? `✓ ${d.cause}` : `✖ ${diagnosisLine(d)}`);
    app.repaint();
  };
  // `s` starts its own async chain, independent of the bring-up. Tracked for
  // the same reason: quit must not tear the terminal down underneath it.
  let pendingReconnect: Promise<void> = Promise.resolve();
  app.hooks.reconnect = () => {
    progress.begin("ssh", "re-checking");
    app.notice("checking the connection to the VM…");
    pendingReconnect = (async () => {
      let d = await triageConnection(cfg);
      // A missing key is the one class the operator can clear from here: `s`
      // is them asking for the single native passphrase prompt. A wedged
      // master or a dead host is reported with its command instead — prompting
      // against either would just hang.
      if (d.kind === "no-agent-key" || d.kind === "unknown") {
        onRealTerminal(() => {
          ensureSshMaster(cfg);
        });
        d = await triageConnection(cfg);
      }
      applyDiagnosis(d);
      // Awaited, not fired and forgotten: it is part of "re-run the check and
      // report the new outcome", and quit waits for this chain.
      await app.poller.tick();
    })().catch((err: unknown) =>
      app.notice(`✖ ssh check failed: ${String(err instanceof Error ? err.message : err)}`),
    );
  };

  // ---- the bring-up: everything external, behind the first frame ------------

  const startCompanion = async (): Promise<void> => {
    try {
      // BEFORE the container, never after: the companion's pi extension picks
      // the user namespace it writes into by listing `viking://user/`, and
      // caches that choice for the life of the process. A namespace whose
      // directory does not exist yet is invisible to it, so it falls back to
      // `user/default` and every write is refused — the whole of 2026-08-21,
      // reported only as "access denied". Needs the forward up, so await it
      // rather than riding the eager `ensure()` above.
      progress.begin("memory-forward");
      const fwd = await memForward.ensure();
      if (fwd.state === "failed") progress.fail("memory-forward", fwd.detail);
      else progress.done("memory-forward", fwd.state);
      if (fwd.state === "adopted" || fwd.state === "owned") {
        progress.begin("memory-namespaces");
        const notes = await memStore.ensureNamespaces();
        for (const note of notes) app.notice(`memory: ${note}`);
        progress.done(
          "memory-namespaces",
          notes.length > 0 ? `${notes.length} note${notes.length === 1 ? "" : "s"}` : "ready",
        );
      } else {
        progress.skip("memory-namespaces", "forward down");
      }
      progress.begin("container");
      // Before the container, so a cold start finds the token already there.
      // Total: no credential, or GitHub down, is a note — never a failed start.
      const gh = await ghToken.refresh();
      progress.note("container", tokenOutcomeLine(gh));
      app.notice(`companion: ${tokenOutcomeLine(gh)}`);
      ghToken.start((o) => {
        if (o.kind === "failed") app.notice(`companion: ${tokenOutcomeLine(o)}`);
      });
      // The companion's read-only mirror of the live config — a copy, not a
      // file bind, so a config.toml replaced by rename is still seen (see
      // CONTAINER.configLive). Kept in step on the same timer as the token.
      const syncConfig = (): void => {
        const m = companion.syncConfigMirror();
        if (typeof m === "object") app.notice(`companion: config mirror NOT refreshed — ${m.failed}`);
        commitProfiles();
      };
      syncConfig();
      configMirrorTimer ??= setInterval(syncConfig, CONFIG_MIRROR_EVERY_MS);
      configMirrorTimer.unref();
      await companion.ensureUp((line) => {
        progress.note("container", line);
        app.notice(`companion: ${line}`);
      });
      progress.done("container");
      // daily rollover — strictly between "container is up" and
      // "pi is spawned": on the first start of a new ops day it archives
      // yesterday, kills the session and queues the opening context, so the
      // spawnPi below births the fresh conversation that reads it.
      progress.begin("rollover");
      const { CompanionRollover } = await import("./rollover.js");
      const { latestDigestHeadline } = await import("../digest.js");
      const rollover = new CompanionRollover(full.companion, realDockerRunner, {
        statePath: join(companionStateDir, "rollover.json"),
        policyStatePath,
        templatePath: join(sandboxRoot(), "prompts", "companion-day-open.md"),
        injectDir: companion.hostInjectDir(),
        localDigestHeadline: () => latestDigestHeadline(),
        ownerName: full.owner.name,
        timeZone: full.ops.timezone,
        // the first-run interview — the marker path is the
        // wizard's contract; the template makes it work without the wizard too.
        firstRunTemplatePath: join(sandboxRoot(), "prompts", "companion-first-run.md"),
        firstRunMarkerPath: join(companionStateDir, "first-run.json"),
      });
      const report = await rollover.run();
      if (report.deferred) {
        // the container could not be read, so the day is deliberately
        // NOT recorded and yesterday's conversation continues. Loud, because a
        // rollover that silently did not happen reads as one that did.
        app.notice(`companion: day rollover DEFERRED — ${report.deferred}`);
      } else if (report.verdict.kind === "rollover") {
        app.notice(
          `companion: new day ${report.verdict.today} — fresh conversation (${report.steps.length} steps)`,
        );
      }
      if (report.interviewFile) {
        app.notice(
          "companion: first start on this installation — greeting + calibration interview queued",
        );
      }
      progress.done(
        "rollover",
        report.deferred
          ? `deferred — ${report.deferred}`
          : report.verdict.kind === "rollover"
            ? `new day ${report.verdict.today}`
            : "same day",
      );
      progress.begin("companion-pi");
      await companion.spawnPi();
      progress.done("companion-pi");
      companionUp = true;
      companionError = undefined;
      app.repaint();
    } catch (err) {
      companionError = String(err instanceof Error ? err.message : err);
      for (const key of [
        "memory-forward",
        "memory-namespaces",
        "container",
        "rollover",
        "companion-pi",
      ] as const) {
        const step = progress.steps().find((s) => s.key === key);
        if (step?.state === "running") progress.fail(key, companionError);
        else if (step?.state === "pending") progress.skip(key, "companion unavailable");
      }
      app.notice(`companion unavailable: ${companionError}`);
    }
  };
  const companionStateDir = join(sandboxRoot(), "state", "companion");
  const policyStatePath = join(companionStateDir, "alert-policy.json");

  // Boot and retry share ONE start: the channels below are wired after the
  // first start that leaves the companion up, whichever path that was.
  const startAndWire = companionStarter({
    start: startCompanion,
    up: () => companionUp,
    wire: () => wireCompanionChannels(),
  });
  installCompanionTabHooks(app, {
    lifecycle: companion,
    available: () => companionUp,
    failure: () => companionError,
    retry: companionOn ? startAndWire : undefined,
  });

  /** Everything the companion feed / alert pipeline needs, once it is up. */
  const wireCompanionChannels = async (): Promise<void> => {
    const { FeedWriter, buildTuiView } = await import("./feed.js");
    const feed = new FeedWriter(full.companion.feed_dir);

    // publish the operator's view: the last painted frame plus the
    // derived state behind it. Two triggers, one throttle: the poll below (so
    // it keeps up with the daemon) and every repaint (so it keeps up with
    // the owner's keystrokes — "what is on their screen" is only true if it
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

    const { AlertConsumer, AlertPolicy, filePolicyStore, notifySendRunner } =
      await import("./alerts.js");
    const { InjectSender } = await import("./msg.js");
    const overseer = new InjectSender(cfg, runner);
    // Persisted per-cause memory: "already told you" survives a TUI restart
    // inside the same ops day, and resets with the day.
    const policy = new AlertPolicy(
      full.companion.cooldown_min,
      () => new Date(),
      filePolicyStore(policyStatePath),
      full.ops.timezone,
    );
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
        maybeWritePiAuthAlert(
          full.companion.alerts_dir,
          a.view.snapshot?.pi_auth_expired,
          piAuthMem,
        );
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
    const driver = buildTuiDriver(app, learning, metricsView, deployState);
    let tuiActBusy = false;
    chainOnPoll(app, (a) => {
      if (tuiActBusy) return;
      tuiActBusy = true;
      void processTuiActions(tuiActionsDir, driver)
        .then((done) => {
          for (const r of done)
            a.notice(r.trace ?? `companion tui-action ${r.file}: ✖ ${r.message}`);
        })
        .catch(() => {
          /* best-effort — never break the poll loop */
        })
        .finally(() => {
          tuiActBusy = false;
        });
    });
  };

  let alerts: { stop(): void } | undefined;

  /**
   * PHASE 1. Every external thing the TUI does at startup, in one place,
   * behind the first frame and reported into the companion column.
   */
  const bringUp = async (): Promise<void> => {
    // The tracker scan is a filesystem walk, so it waits for the frame too.
    learning.store.reloadTickets(); // total: an unreadable tracker is an UNKNOWN pane, never a failed start
    // The triage runs CONCURRENTLY with the companion: a wedged ssh master can
    // cost its probe seconds, and the companion has nothing to do with ssh.
    //
    // `begin` FIRST, and it is not decoration: the probe chain is the slowest
    // thing here (a blackholed host costs its ConnectTimeout), so this is the
    // step most likely to need the overdue warning — and a step left `pending`
    // says "nobody has reached this yet", which would be a lie the moment the
    // probes start.
    progress.begin("ssh");
    const triaged = triageConnection(cfg)
      .then(applyDiagnosis)
      .catch((err: unknown) =>
        progress.fail("ssh", `probe failed: ${String(err instanceof Error ? err.message : err)}`),
      );

    // the evidence store's dir must exist before the container mounts
    // it (docker would invent it root-owned), and the copier writes into it
    // whether or not the companion is up.
    try {
      evidence.ensure();
    } catch (err) {
      app.notice(
        `✖ evidence store ${evidence.dir}: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
    if (companionOn) {
      await startAndWire();
    } else {
      for (const key of ["memory-namespaces", "container", "rollover", "companion-pi"] as const) {
        progress.skip(key, "--no-companion");
      }
      // The Memory tab still needs the forward even with the companion off.
      progress.begin("memory-forward");
      const fwd = await memForward.ensure();
      if (fwd.state === "failed") progress.fail("memory-forward", fwd.detail);
      else progress.done("memory-forward", fwd.state);
    }
    await triaged;
  };

  // The first poll is a step like any other: it begins when the poller does
  // (inside `run()` below) and completes on the first snapshot. Until then the
  // board says PRS (?) — an honest unknown, never a count of zero.
  progress.begin("poll");
  chainOnPoll(app, (a) => {
    const step = progress.steps().find((s) => s.key === "poll");
    if (a.view.snapshot) {
      if (step?.state !== "done") progress.done("poll", `${a.view.snapshot.prs.length} PRs`);
      return;
    }
    if (step?.state === "running" && a.poller.state.consecutiveFailures >= 2) {
      progress.fail(
        "poll",
        app.view.connection ? diagnosisLine(app.view.connection) : "status.json unreadable",
      );
    }
  });

  // Restore a hot-reload snapshot before run(), so the first paint is already
  // on the right tab with the right selection.
  const resumed = args.resumeState ? readResumeState(args.resumeState) : undefined;
  if (resumed) {
    // A tab name from an older build (`changes`) is not a tab any more and
    // lands on the board, like an unknown one.
    if (isTab(resumed.tab)) app.tab = resumed.tab;
    app.view.eventsScroll = resumed.eventsScroll;
    app.view.eventsFocus = resumed.eventsFocus;
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
        // Same reasoning covers in-flight ssh: the per-call SIGKILL in
        // `realSshRunner` is a timer on the loop that spawnSync is about to
        // freeze, so a capture/poll/why still running at reload time is
        // orphaned FOREVER. Against a wedged ControlMaster (an ssh-config
        // config block sets no ServerAliveInterval, so a network blip hangs
        // the master and every slave riding it) those children never exit on
        // their own either: measured live at 4h58m, with 26 stacked
        // generations each holding its own. Kill them here, while the loop
        // still turns.
        reexec: (file) =>
          realReexec(file, () => {
            killInFlightSsh();
            memForward.stop();
            app.quit();
          }),
      })
    : undefined;

  // ---- the first frame ------------------------------------------------------
  //
  // Deep link: `qcr tui <pr>` is the board with that PR selected — nothing
  // opens over it (the full-screen attach it used to start is gone).
  const initial = target.kind === "pr" ? target.pr : resumed?.pr;
  const running = app.run(initial);
  // Only now: a recursive dist watcher walks the tree, and the bring-up talks
  // to ssh, docker and OpenViking. Neither may precede the frame above.
  reloader?.start();
  // Kept, not dropped on the floor. Quitting DURING the bring-up used to leave
  // it running against the teardown below: `spawnPi()` could land after
  // `gracefulStop()` (a clean quit that leaves a freshly spawned companion
  // behind — the opposite of what it promises), and `memForward.stop()` could
  // close a forward the bring-up was still about to use.
  const bringUpDone = bringUp().catch(() => {
    /* every step already reports itself; a bring-up cannot fail the quit */
  });
  await running;
  // Let the bring-up finish before tearing down what it is still touching.
  // Bounded, and announced: this runs AFTER the terminal is restored, so a
  // silent wait here is a terminal that looks dead — the same reasoning the
  // companion stop below is written under.
  const inFlight = Promise.allSettled([bringUpDone, pendingReconnect]);
  if (!(await settledWithin(inFlight, BRING_UP_QUIT_GRACE_MS))) {
    out.write("qcr tui: waiting for startup to finish before shutting down…\n");
    await settledWithin(inFlight, BRING_UP_QUIT_GRACE_MS * 3);
  }
  reloader?.stop();
  progress.stop();
  alerts?.stop();
  ghToken.stop();
  if (configMirrorTimer) clearInterval(configMirrorTimer);
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
    out.write("qcr tui: stopping the companion container…\n");
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
  exit(0);
}
