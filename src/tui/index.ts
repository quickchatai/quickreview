// `qcr tui [pr]` entry point. Wires the real ssh runner; the optional PR
// number opens the board with that PR selected.
import { join } from "node:path";
import { liveConfigPath, loadConfig, sandboxRoot, type Config } from "../config.js";
import type { TuiDriver } from "./actions.js";
import { App } from "./app.js";
import type { DeployState } from "./deploytab.js";
import type { LearningTabs } from "./learning.js";
import type { MetricsView } from "./metricstab.js";
import { ensureSshMaster } from "./connect.js";
import { MOUSE_OFF, MOUSE_ON } from "./mouse.js";
import { isFreshHealth } from "./poll.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR } from "./paint.js";
import { storeHealth } from "./memory.js";
import {
  entryKey,
  findMemoryEntry,
  memoryOrder,
  memoryRefUnread,
  setTimelineFilter,
} from "./memtab.js";
import { refOf } from "../memory/store.js";
import { isTab } from "./tabs.js";
import {
  HotReloader,
  parseResumeArg,
  readResumeState,
  realReexec,
  RELOAD_EXIT_CODE,
  resumeStatePath,
} from "./reload.js";
import { killInFlightSsh, runnerFor, transportOf } from "./remote.js";
import { chainOnPoll } from "./poll-hooks.js";
import { deliverMessage } from "./msg.js";
import type { ConnectionDiagnosis } from "./sshtriage.js";

export { chainOnPoll } from "./poll-hooks.js";

/**
 * `qcr tui <pr>` opens the board with that PR selected. `overseer` and `main`
 * are refused with the place to go instead: the TUI never attaches to a VM
 * session.
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

export const TUI_HELP = `qcr tui — live board and operator console for the review daemon (over ssh)

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
      8 scan: [ ] unit · p promote · d dismiss · f/F filter · t tier · P plan (space
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
 * The companion action channel's executor, mapped onto the App's public
 * surface plus the per-tab states the install hooks return. Exported so tests
 * can drive a real App through `processTuiActions`; runTui wires it inside
 * the companionUp block. Actions run instantly — no confirm gate (see
 * src/tui/actions.ts header).
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
  /** Press a deploy-tab run key twice (arm + confirm) and answer whether a
   * run started: the tab refuses a press with a result on screen, a drain
   * still owned, or a target not yet loaded, and a refused printable would
   * otherwise fall through to the companion column while the action read as
   * done. */
  const startDeployRun = (key: "D" | "S", kind: "deploy" | "stop" | "start"): void => {
    if (deployState.run)
      throw new Error(
        `deploy_tab ${kind} refused — ${deployState.run.running ? "a run is in flight" : "the previous result is still on screen (x closes it)"}`,
      );
    app.pressKey(key);
    app.pressKey(key);
    const started = (): string | undefined => deployState.run?.kind; // read after the presses
    if (started() !== kind)
      throw new Error(
        `deploy_tab ${kind} refused by the tab${app.view.noticeLine ? ` — ${app.view.noticeLine}` : ""}`,
      );
  };
  const driver: TuiDriver = {
    switchTab: (tab) => {
      prep();
      app.tab = tab; // one vocabulary: the verb's tab name IS the App's (src/tui/tabs.ts)
      app.repaint();
    },
    selectPr: (pr) => {
      prep();
      // public App API — selects + refreshes detail; a refusal leaves the tab
      if (!app.selectPr(pr)) throw new Error(`#${pr} is not on the board`);
      app.tab = "board";
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
      // The sequence starts from the dashboard: a half-typed operator entry
      // would swallow the "#" and prefix our digits, and an open timeline
      // answers to Esc only, so its "#" would reach the companion column.
      metricsView.prEntry = undefined;
      metricsView.drill = undefined;
      metricsView.scroll = 0;
      app.pressKey("#");
      if (metricsView.prEntry !== "")
        throw new Error(`metrics pr ${pr} refused — the metrics tab did not open its PR entry`);
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
      if (opts.tag !== undefined) setTimelineFilter(mem, opts.tag);
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
        mem.selKey = entryKey(ordered[i]!);
      }
      app.repaint();
    },
    memoryPin: async (ref, pin) => {
      // The companion may pin or unpin an existing entry, and nothing else
      // about memory rides this channel — the only op built here is `pin` or
      // `unpin` (CLAUDE.md rule 8). A memory write, not a keystroke: no tab
      // switch and no focus change (prep is for synthesized keys). It goes
      // through the one store — the same verb the tab's `p` uses — against
      // the entry as a new read finds it (the tab may never have been
      // opened). That read lists every tree again (the TUI's store keeps no
      // sweep cache; a file the listing shows unchanged may come from its
      // per-file cache), and the write re-reads the file and refuses a stale
      // hash — never applied blind.
      const memory = learning.store.memory;
      const entry = findMemoryEntry(await memory.read(), ref);
      if (!entry) {
        // Not found in a read that did not read everything is not "no such
        // entry": answering that would publish a fact to the companion from
        // no data.
        const unread = memoryRefUnread(storeHealth(memory), ref);
        if (unread)
          throw new Error(
            `memory not fully readable — '${ref}' may be there; nothing was written: ${unread}`,
          );
        throw new Error(`no memory entry '${ref}' — its id or URI, as memory lists it`);
      }
      if (entry.pinned === pin) return `${entry.id} is already ${pin ? "pinned" : "unpinned"}`;
      const res = await memory.apply({
        op: pin ? "pin" : "unpin",
        ...refOf(entry),
      });
      learning.store.reloadMemory();
      if (!res.ok) throw new Error(res.message);
      return res.message;
    },
    setBoardFilter: (f) => {
      prep();
      app.tab = "board";
      app.setBoardFilter(f);
      app.repaint();
    },
    setMemoryFilter: (tag) => {
      prep();
      app.tab = "memory";
      setTimelineFilter(learning.memory, tag);
      app.repaint();
    },
    msgSession: (session, text) => deliverMessage(app, session, text),
    overseerInject: (text) => deliverMessage(app, "overseer", text),
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
        startDeployRun("D", "deploy"); // arm+confirm inside the window = instant
        return;
      }
      // stop/start: the tab's S button computes its own kind from the observed
      // container state; refuse a mismatched request rather than silently doing
      // the opposite — and refuse outright when that state has not been read,
      // so a stop request can never stop a live reviewer on data nobody
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
      startDeployRun("S", action);
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

/**
 * Clean quit stops the container (conversation + auth survive on volumes).
 * The question is whether THIS start put a container up — true from the
 * moment `ensureUp` returns, not only once the rollover and the pi spawn
 * behind it finished: a quit whose bring-up grace ran out mid-rollover would
 * otherwise leave a freshly started container running. A failed stop is
 * swallowed — leaving it running is harmless, the next start adopts it.
 */
export async function stopCompanionOnQuit(opts: {
  containerStarted: boolean;
  stop: () => Promise<void>;
  write: (line: string) => void;
}): Promise<void> {
  if (!opts.containerStarted) return;
  opts.write("qcr tui: stopping the companion container…\n");
  try {
    await opts.stop();
  } catch {
    /* leaving it running is harmless: the next start adopts */
  }
}

/**
 * `qcr tui` — the whole startup, in two phases.
 *
 * Phase 0 is local only: parse, config, wire, and paint. Nothing external —
 * no ssh, no docker, no network, no directory scan — may run before the first
 * frame, and the frame it paints is the real layout with every unfetched value
 * marked unknown. The companion column's width comes from config, the only
 * layout-affecting fact, so nothing jumps when the container later arrives.
 *
 * Phase 1 is the bring-up, streaming in behind that frame and reporting into
 * the companion column: connection triage, memory forward, namespaces,
 * container, day rollover, pi. It never blocks the board, and a step that
 * fails is a degraded mode, never a reason the TUI does not open.
 */
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
  // One transport decision for every remote op — ssh to the VM, or the same
  // commands against local docker on the laptop topology.
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
  // A reload under the supervisor exits with RELOAD_EXIT_CODE so the next
  // build takes over this terminal state — the alt screen, mouse reporting
  // and raw mode stay exactly as they are. Restoring here would flash the
  // shell between builds. Every other exit restores.
  process.on("exit", (code) => {
    if (code === RELOAD_EXIT_CODE) return;
    restoreTerminal();
  });
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

  // The companion column is layout: its width depends on nothing but the
  // terminal, so wiring it here — before anything asks docker whether the
  // container is running — is what makes the first frame the real one. The
  // sidebar is only `available()` once the container answers, and the
  // container fills a column that was already the right size.
  const { CompanionSidebar, restorePreferredSidebarWidth } = await import("./sidebar.js");
  const { CompanionLifecycle, realDockerRunner } = await import("./companion.js");
  const companion = new CompanionLifecycle(full.companion, realDockerRunner);
  // The companion's read-only GitHub token, minted here from the App
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
  /** `ensureUp` returned: a container is running on this start's account,
   * whether or not the rollover and pi spawn behind it ever finish. */
  let companionContainerStarted = false;
  let companionError: string | undefined;
  // The column exists in every configuration: `--no-companion` and
  // `[companion] enabled = false` decide what runs and what the column says,
  // never whether the right half of the screen is there.
  app.sidebar = new CompanionSidebar(full.companion, realDockerRunner, {
    available: () => companionUp,
    onUpdate: () => app.repaint(),
    // pi's `/copy` inside the container lands in a tmux paste buffer; the
    // column forwards it here, to the host clipboard.
    onCopy: (text) => app.copyText(text, "the companion"),
  });
  if (!companionOn)
    app.sidebar.setOff(args.companion ? "[companion] enabled = false" : "--no-companion");

  // Bring-up progress goes in that column: it is empty at this moment and
  // already the right shape, so it costs no new surface — and the lines are
  // never written to the normal screen, where the alt screen's clear would
  // erase them (a visible flicker). With the companion off the same column
  // carries the skipped steps, and stays as the place that says why it is off.
  const { StartupProgress } = await import("./startup.js");
  const progress = new StartupProgress(undefined, {
    onUpdate: (p) => {
      // Kept after the bring-up settles on purpose: a `✗ companion container ·
      // docker is not running` is the most useful thing the column can show,
      // and clearing it would delete the diagnosis a second after it appeared.
      // The hand-off is the sidebar's `mirrored` latch — the checklist yields
      // to pi's first real capture and never comes back.
      app.sidebar?.setStartup(p.lines());
      app.repaint();
    },
  });
  app.sidebar.setStartup(progress.lines());

  // No attach hooks: the TUI never attaches to a VM session — see AppHooks.
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
  // The profile commits setup asked for, carried out here, on the config
  // mirror's timer — the container cannot see the config home's .git (the
  // home holds secrets/, so it is never mounted whole).
  const commitProfiles = (): void => {
    for (const r of commitRequestedProfiles()) app.notice(commitLine(r));
  };
  // The four learning surfaces — [2] memory, [3] digest, [4] tickets,
  // [7] feedback — over one store. Accept-verdict git actions run against
  // this working copy (the canonical repo); the [sink] config decides where
  // the defect auto-filer writes (wayfinder tracker, gated github command
  // channel, or none) and which effort the ticket projection reads.
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
  // One memory store for the whole TUI: OpenViking on the VM, reached over
  // the memory forward's loopback listener, holding both user keys. Every
  // memory surface in the TUI shares this instance — a second one would mean
  // a second sweep and a second health opinion.
  const { tuiMemoryStore, tuiMemoryBaseUrl } = await import("./memory.js");
  // The companion namespace's retired URIs, published into the state home
  // the companion mounts — its recall excludes them.
  const { MEMORY: COMPANION_MEMORY } = await import("./companion.js");
  const { stateHome: memStateHome } = await import("../install.js");
  const memStore = tuiMemoryStore({
    retiredFiles: { companion: join(memStateHome(), COMPANION_MEMORY.retiredFile) },
  });
  // The TUI brings the memory forward up itself, so the Memory tab works
  // without the operator installing the systemd unit first. It adopts a
  // forward that is already listening (the unit, or another qcr tui) and stops
  // only one it started — see memforward.ts for why that split matters.
  // Constructed here, started in the bring-up: `ensure()` probes over HTTP.
  const { MemoryForward, forwardUsable } = await import("./memforward.js");
  const memForward = new MemoryForward({
    baseUrl: tuiMemoryBaseUrl(),
    repoRoot: sandboxRoot(),
    // The forward follows the same [tui] target knob — local mode reaches the
    // daemon container's loopback engine via plain docker exec.
    local: transportOf(cfg) === "local",
    sudoDocker: cfg.sudo_docker,
    sshHost: cfg.ssh_host,
    container: cfg.container,
    log: (line) => app.notice(line),
  });
  const { buildIssueSink, ticketProjection } = await import("./issuesink.js");
  const { readEffortTickets } = await import("./trackertickets.js");
  const projection = ticketProjection(full);
  const { RealDeployFetcher, installDeployHooks, powerSpawnArgv, realLocalRunner } =
    await import("./deploytab.js");
  const { FileDeployCeremonyStore } = await import("./deploy-ceremony.js");
  const localRunner = realLocalRunner(sandboxRoot());
  // The change register — every feedback-derived commit (identified by its
  // `Ratified-in-session:` trailer), newest first, with a one-key revert on
  // the feedback tab. It reads and writes the local checkout only, through
  // the same read-only local-git seam the deploy tab uses; nothing here
  // touches the VM, GitHub or the gate. Persisted under state/ so the list is
  // on screen before git has been asked anything.
  const { ChangeLog, ChangeRegisterStore } = await import("./changelog-store.js");
  const { stateHome } = await import("../install.js");
  const { PIN_PROPOSALS_FILE, parsePinProposals } = await import("../setup/pins.js");
  const learning = installLearningTabs(app, {
    memory: memStore,
    // The entries setup proposed to pin, marked ☆ on the memory tab.
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
    issueLabel: full.github.issue_label,
    eod: { time: full.eod.time, timezone: full.eod.timezone },
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
    // docker stop/start on the VM (or local docker in local mode), streamed
    // into the tab like a deploy.
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
        writeCompanionAsk({
          injectDir: companionInjectDir(full.companion),
          suffix: `scan-${verb}`,
          text,
        });
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
    companionUp: () =>
      !companionOn || companionError !== undefined ? false : companionUp ? true : undefined,
  });

  // Finished-round evidence, copied down from the VM into a local store the
  // companion reads read-only. Its dir is created in the bring-up,
  // before the container starts — the mount source must exist first, or docker
  // invents it root-owned and the copier can never write into it.
  const {
    EvidenceCopier,
    EvidenceStore,
    SWEEP_PROGRESS_FILE,
    SweepProgressFile,
    evidenceWhyIntervalMs,
  } = await import("./evidence.js");
  const evidence = new EvidenceStore(full.companion.evidence_dir);

  // Ambient feed + alert pipeline + startup healing. All of it hangs
  // off companionOn, so --no-companion really means "none of this runs" —
  // the column itself is not part of "this": it is layout, and it is always
  // there.
  const { companionStarter, installCompanionTabHooks } = await import("./companiontab.js");

  // The companion sidebar is the only companion surface. Mirror + send go
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

  // The evidence copier rides the existing poll — no second scheduler,
  // and deliberately not awaited. `sweep()` is re-entrant-safe (a sweep in
  // flight makes the next call a no-op) and every remote read is killed at
  // `evidence_timeout_s`, so a wedged ssh control master stalls the copier and
  // nothing else: the poll keeps polling and the board keeps painting. Runs
  // whether or not the companion is up — the record is worth keeping either
  // way, and it is what the companion will read when it next starts.
  //
  // Its per-PR progress lives beside the TUI's other state files,
  // so a re-exec (every local build) resumes instead of re-running `qcr why`
  // for every PR, and its `why` execs are paced by `evidence_why_interval_s`
  // and held while the board's last status shows a drain or a stale heartbeat.
  const evidenceCopier = new EvidenceCopier(cfg, evidence, runner, {
    sessionDir: full.pi.session_dir,
    timeoutMs: Math.max(5, cfg.evidence_timeout_s) * 1000,
    whyIntervalMs: evidenceWhyIntervalMs(cfg),
    progress: new SweepProgressFile(join(sandboxRoot(), "state", SWEEP_PROGRESS_FILE)),
    onNotice: (text) => app.notice(text),
  });
  chainOnPoll(app, (a) => {
    void evidenceCopier.sweep(a.view.snapshot).catch(() => {
      /* best-effort — a failed copy is retried on the next poll, never fatal */
    });
  });

  // The durable candidate list behind the `survey` skill. Derived from what
  // is already on this disk — the poll snapshot plus the evidence store's
  // round manifests — so it costs no remote reads and rides the same poll. It lands
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

  // A reviewer-memory incident older than
  // `[memory] incident_ticket_after_min` becomes one issue-tracker ticket
  // (actor qcr-tui, deduped by the incident's start), read from status.json —
  // never from memory, which is the thing that is down (the `#bug` filer reads
  // memory, so it could never report this). Independent of the companion:
  // the board banner and this ticket reach a person with the column off.
  const { maybeFileCurationIncident, maybeFileMemoryIncident, newIncidentFilerMemo } =
    await import("./memincident.js");
  const incidentMemo = newIncidentFilerMemo();
  const incidentTracker =
    full.sink.kind === "wayfinder" && full.sink.root && full.sink.effort && full.sink.parent
      ? { root: full.sink.root, effort: full.sink.effort, parent: full.sink.parent }
      : undefined;
  /** One incident filer's notices: a filing, a missing tracker, a failure —
   * each distinct line once, so a tracker that keeps failing does not repaint
   * the notice every poll. */
  const incidentNotifier = (
    what: string,
  ): ((a: App, out: ReturnType<typeof maybeFileMemoryIncident>) => void) => {
    let last = "";
    return (a, out) => {
      const line =
        out.kind === "filed"
          ? `${what} filed as ${out.ticketId} (${out.file})`
          : out.kind === "no-tracker" || out.kind === "failed"
            ? out.line
            : "";
      if (line !== "" && line !== last) {
        last = line;
        a.notice(line);
      }
    };
  };
  const incidentNotice = incidentNotifier("memory incident");
  chainOnPoll(app, (a) => {
    const out = maybeFileMemoryIncident(incidentTracker, a.view.snapshot?.memory, {
      fresh: isFreshHealth(a.view.health),
      now: new Date(),
      afterMs: full.memory.incident_ticket_after_min * 60_000,
      memo: incidentMemo,
    });
    incidentNotice(a, out);
  });
  // The learner's EOD curation that did not reach memory (no receipt, or
  // lessons memory does not hold) — the same person path: one
  // ticket per curation incident (its oldest unresolved failure) older than
  // the same threshold, from status.json `memory.curation`.
  const curationMemo = newIncidentFilerMemo();
  const curationNotice = incidentNotifier("EOD curation incident");
  chainOnPoll(app, (a) => {
    const out = maybeFileCurationIncident(incidentTracker, a.view.snapshot?.memory, {
      fresh: isFreshHealth(a.view.health),
      now: new Date(),
      afterMs: full.memory.incident_ticket_after_min * 60_000,
      memo: curationMemo,
    });
    curationNotice(a, out);
  });

  // ---- the connection triage ------------------------------------------------
  //
  // The TUI does the three-way ssh triage behind the first frame:
  // `ensureSshMaster` before the alt screen would be both a network call
  // gating the first paint and, on a bad day, an interactive prompt. Nothing
  // here is self-healing by design; the TUI reports the cause and the exact
  // command, and `s` re-runs the check.
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
      // Before the container, never after: the companion's pi extension picks
      // the user namespace it writes into by listing `viking://user/`, and
      // caches that choice for the life of the process. A namespace whose
      // directory does not exist yet is invisible to it, so it falls back to
      // `user/default` and every write is refused, reported only as "access
      // denied". Needs the forward up, so it is awaited here.
      progress.begin("memory-forward");
      const fwd = await memForward.ensure();
      if (fwd.state === "failed") progress.fail("memory-forward", fwd.detail);
      else progress.done("memory-forward", fwd.state);
      if (forwardUsable(fwd)) {
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
        if (typeof m === "object")
          app.notice(`companion: config mirror NOT refreshed — ${m.failed}`);
        commitProfiles();
      };
      syncConfig();
      configMirrorTimer ??= setInterval(syncConfig, CONFIG_MIRROR_EVERY_MS);
      configMirrorTimer.unref();
      await companion.ensureUp((line) => {
        progress.note("container", line);
        app.notice(`companion: ${line}`);
      });
      companionContainerStarted = true;
      progress.done("container");
      // The container's memory network exists now: a forward we started
      // before it (a cold host) binds the bridge address it could not.
      await memForward.rebindMissing();
      // Daily rollover — strictly between "container is up" and
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
        // The first-run interview — the marker path is the setup wizard's
        // contract; the template makes it work without the wizard too.
        firstRunTemplatePath: join(sandboxRoot(), "prompts", "companion-first-run.md"),
        firstRunMarkerPath: join(companionStateDir, "first-run.json"),
      });
      const report = await rollover.run();
      if (report.deferred) {
        // The container could not be read, so the day is deliberately not
        // recorded and yesterday's conversation continues. Loud, because a
        // rollover that silently did not happen reads as one that did.
        app.notice(`companion: day rollover DEFERRED — ${report.deferred}`);
      } else if (report.stoodDown) {
        app.notice(`companion: ${report.stoodDown}`);
      } else if (report.verdict.kind === "rollover") {
        app.notice(
          `companion: new day ${report.verdict.today} — fresh conversation (${report.steps.length} steps)`,
        );
      }
      for (const warning of report.warnings ?? []) app.notice(`companion: ${warning}`);
      if (report.interviewFile) {
        app.notice(
          "companion: first start on this installation — greeting + calibration interview queued",
        );
      }
      progress.done(
        "rollover",
        report.deferred
          ? `deferred — ${report.deferred}`
          : report.stoodDown
            ? "rolled over by another start"
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
    available: () => companionUp,
    failure: () => companionError,
    retry: companionOn ? startAndWire : undefined,
  });

  /** Everything the companion feed / alert pipeline needs, once it is up. */
  const wireCompanionChannels = async (): Promise<void> => {
    const { FeedWriter, buildTuiView } = await import("./feed.js");
    const feed = new FeedWriter(full.companion.feed_dir);

    // Publish the operator's view: the last painted frame plus the derived
    // state behind it. Two triggers, one throttle: the poll below (so it
    // keeps up with the daemon) and every repaint (so it keeps up with the
    // operator's keystrokes — "what is on their screen" is only true if it
    // tracks the screen). Files only: this never injects a companion turn,
    // and the companion reads it on demand through the `tui_*` tools.
    const publishView = (): void => {
      try {
        // One read of the frame for both: the view's screen metadata (rows,
        // chars, truncation) describes the text written beside it.
        const screen = app.screenText();
        feed.writeView(
          buildTuiView({
            now: new Date(),
            screen,
            tab: app.tab,
            snapshot: app.view.snapshot,
            health: app.view.health,
            selectedPr: app.currentPr(),
            panePr: app.view.piPr,
            paneFocused: app.view.piFocus === true,
            notice: app.view.noticeLine,
            deploy: deployState,
            tuiMemoryRequests: memStore.requestCounts(),
          }),
          screen,
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
    const { maybeWritePiAuthAlert, maybeWriteMemoryAlert, maybeWriteCurationAlert } =
      await import("./alerts.js");
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
    // Reviewer memory refusing a key or down — one desktop notification per
    // transition, from status.json `memory` (never from OpenViking), and only
    // from a fresh snapshot.
    const memoryAlertMem = { lastWritten: "" };
    chainOnPoll(app, (a) => {
      try {
        maybeWriteMemoryAlert(
          full.companion.alerts_dir,
          a.view.snapshot?.memory,
          isFreshHealth(a.view.health),
          memoryAlertMem,
        );
      } catch {
        // alerting is best-effort; never break the poll loop
      }
    });

    // The day's EOD curation did not reach memory (no receipt,
    // or a lesson refused / not found) — one notification per (state, day),
    // from status.json `memory.curation`, fresh snapshots only.
    const curationAlertMem = { lastWritten: "" };
    chainOnPoll(app, (a) => {
      try {
        maybeWriteCurationAlert(
          full.companion.alerts_dir,
          a.view.snapshot?.memory,
          isFreshHealth(a.view.health),
          curationAlertMem,
        );
      } catch {
        // alerting is best-effort; never break the poll loop
      }
    });

    // No memory request-file channel here, and no memory feed: the companion
    // reaches OpenViking directly, over a host-owned forward, holding both
    // user keys. A second write path is exactly what must not exist — do not
    // add one as an "offline fallback" (CLAUDE.md rule 8).

    // The companion → TUI action channel. Sweep discipline is the usual one
    // (poll cadence, busy flag so a slow sweep never stacks);
    // processTuiActions itself archives-before-execute and writes the result
    // files. Each executed action's trace lands on the notice line — actions
    // execute instantly, with no confirm gate.
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
    // `begin` first, and it is not decoration: the probe chain is the slowest
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

    // The evidence store's dir must exist before the container mounts
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
    // A tab name this build does not know (e.g. from an older build) lands on
    // the board.
    if (isTab(resumed.tab)) app.tab = resumed.tab;
    app.view.eventsScroll = resumed.eventsScroll;
    app.view.eventsFocus = resumed.eventsFocus;
    if (app.sidebar && resumed.sidebarWidth !== undefined) {
      app.sidebar.preferredWidth = restorePreferredSidebarWidth(resumed.sidebarWidth);
    }
  }

  // Hot-reload: watch our own dist/ and re-exec when a new build lands.
  const reloadState = resumeStatePath(sandboxRoot());
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
        // The forward must be released here, not in the cleanup after
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
        // orphaned forever. Against a wedged ControlMaster (an ssh config
        // block with no ServerAliveInterval lets a network blip hang the
        // master and every slave riding it) those children never exit on
        // their own either, and they stack up one generation per reload.
        // Kill them here, while the loop still turns.
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
  // opens over it.
  const initial = target.kind === "pr" ? target.pr : resumed?.pr;
  const running = app.run(initial);
  // Only now: a recursive dist watcher walks the tree, and the bring-up talks
  // to ssh, docker and OpenViking. Neither may precede the frame above.
  reloader?.start();
  // Kept, not dropped on the floor: quitting during the bring-up must not
  // leave it running against the teardown below, or `spawnPi()` could land
  // after `gracefulStop()` (a clean quit that leaves a freshly spawned
  // companion behind) and `memForward.stop()` could close a forward the
  // bring-up was still about to use.
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
  // This runs after the terminal is restored, so every millisecond it takes is
  // a terminal that looks dead: board gone, prompt not back, nothing
  // responding. Say what is happening: a slow docker, or a container whose
  // PID 1 ignores SIGTERM (so `docker stop` runs to its full timeout), must
  // not look like a hang.
  await stopCompanionOnQuit({
    containerStarted: companionContainerStarted || companionUp,
    stop: () => companion.gracefulStop(),
    write: (line) => out.write(line),
  });
  // Exit explicitly. Anything still holding the event loop — a docker exec
  // that never returned, an ssh master, a socket — would otherwise keep the
  // process alive with the terminal already restored, which is exactly the
  // "TUI is gone but the shell never comes back" state.
  exit(0);
}
