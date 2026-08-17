// Deploy tab (key 4) — "what would a deploy ship?" plus the deploy button:
// the commit the VM is running (the BUILD_SHA marker deploy.sh rsyncs along),
// local HEAD, the pending commit list + diffstat between them, and deploy.sh's
// own --dry-run plan verbatim. Click ▶ (or D D) starts `scripts/deploy.sh
// sync` via hooks.deployRun and streams its output live into the pane — the
// TUI never suspends. deploy.sh's own guardrails (clean tree, pin agreement)
// stay the only gate.
import { execFile } from "node:child_process";
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import type { BoardKey } from "./keys.js";
import { Frame, SGR, displayWidth, rule, stripAnsi, truncate } from "./paint.js";
import type { RemoteResult, SshRunner } from "./remote.js";
import { FG, RESET } from "./theme.js";

function dockerSh(cfg: TuiConfig, script: string): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec", cfg.container, "sh", "-c", script];
}

/** BUILD_SHA rides the deploy rsync into the sandbox root on the VM. */
export function buildShaArgv(cfg: TuiConfig): string[] {
  return dockerSh(cfg, `cat '${cfg.remote_sandbox_root}/BUILD_SHA' 2>/dev/null || true`);
}

/** Container status straight from docker — works while it is stopped too. */
export function containerStatusArgv(cfg: TuiConfig): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "ps", "-a", "--filter", `name=${cfg.container}`, "--format", "{{.Status}}"];
}

/** The remote shell line hooks.powerRun streams: docker stop/start. */
export function powerCommand(cfg: TuiConfig, action: "stop" | "start"): string {
  return `${cfg.sudo_docker ? "sudo " : ""}docker ${action} ${cfg.container}`;
}

// ---- local (laptop-side) commands — all read-only ---------------------------

export const HEAD_ARGV = ["git", "rev-parse", "--short", "HEAD"];
export const DIRTY_ARGV = ["git", "status", "--porcelain"];
export const PLAN_ARGV = ["bash", "scripts/deploy.sh", "--dry-run", "sync"];

export function logArgv(deployedSha: string): string[] {
  return ["git", "log", "--oneline", `${deployedSha}..HEAD`];
}

export function diffStatArgv(deployedSha: string): string[] {
  return ["git", "diff", "--stat", `${deployedSha}..HEAD`];
}

/** Runs a local argv in the sandbox root. Injectable — tests never spawn. */
export type LocalRunner = (argv: string[]) => Promise<RemoteResult>;

export function realLocalRunner(cwd: string): LocalRunner {
  return (argv) =>
    new Promise((resolvePromise) => {
      execFile(argv[0]!, argv.slice(1), { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
        resolvePromise({ ok: err === null, stdout: String(stdout), stderr: String(stderr), code: err === null ? 0 : 1 });
      });
    });
}

// ---- state ------------------------------------------------------------------

export interface DeployedMarker {
  sha: string;
  at?: string;
  mode?: string;
}

/** BUILD_SHA content: `<short-sha> <iso-utc> <mode>` (one line). */
export function parseBuildSha(stdout: string): DeployedMarker | undefined {
  const [sha, at, mode] = stdout.trim().split(/\s+/);
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return undefined;
  return { sha, at, mode };
}

export interface DeployState {
  loaded: boolean;
  loading: boolean;
  deployed?: DeployedMarker;
  head?: string;
  dirty: string[];
  /** `git log --oneline deployed..HEAD`; undefined when the range is unknown. */
  commits?: string[];
  diffstat?: string[];
  /** deploy.sh --dry-run output — a refusal (dirty tree, pin drift) shows verbatim. */
  plan: string[];
  scroll: number;
  /** First D/click at this ms timestamp; a second inside the window deploys. */
  armedAt?: number;
  /** Screen rect of the DEPLOY button (1-based), refreshed on every paint. */
  buttonZone?: { x1: number; y1: number; x2: number; y2: number };
  /** `docker ps` Status line for the container ("Up 2 hours" / "Exited (0) …");
   * undefined until fetched, "" when docker listed nothing. */
  containerStatus?: string;
  /** A live (or just-finished) deploy/stop/start run streamed into the tab. */
  run?: DeployRun;
  /** Screen rect of the STOP/START power button, refreshed on every paint. */
  powerZone?: { x1: number; y1: number; x2: number; y2: number };
  /** Which button is armed — the two never arm together. */
  armedKind?: RunKind;
}

export type RunKind = "deploy" | "stop" | "start";

/** deploy.sh / docker stop / docker start output streamed into the pane —
 * the TUI never suspends. */
export interface DeployRun {
  kind: RunKind;
  lines: string[];
  /** Trailing chunk fragment awaiting its newline. */
  partial: string;
  running: boolean;
  /** Exit code once finished (null = killed by signal). */
  code?: number | null;
}

const RUN_MAX_LINES = 5000;

/** Fold a raw chunk into the run log: ANSI stripped (ansible colors would
 * shred the frame), CR-progress collapsed, bounded backlog. */
export function appendRunChunk(run: DeployRun, chunk: string): void {
  const text = run.partial + chunk.replace(/\r\n/g, "\n");
  const parts = text.split("\n");
  run.partial = parts.pop() ?? "";
  for (const p of parts) {
    const line = stripAnsi(p).split("\r").pop() ?? "";
    run.lines.push(line);
  }
  if (run.lines.length > RUN_MAX_LINES) run.lines.splice(0, run.lines.length - RUN_MAX_LINES);
}

export const DEPLOY_CONFIRM_MS = 5000;

export interface DeployFetcher {
  load(): Promise<Omit<DeployState, "loaded" | "loading" | "scroll">>;
}

export class RealDeployFetcher implements DeployFetcher {
  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly local: LocalRunner,
  ) {}

  async load(): Promise<Omit<DeployState, "loaded" | "loading" | "scroll">> {
    const [marker, status, head, dirty, plan] = await Promise.all([
      this.ssh(this.cfg.ssh_host, buildShaArgv(this.cfg)),
      this.ssh(this.cfg.ssh_host, containerStatusArgv(this.cfg)),
      this.local(HEAD_ARGV),
      this.local(DIRTY_ARGV),
      this.local(PLAN_ARGV),
    ]);
    const deployed = marker.ok ? parseBuildSha(marker.stdout) : undefined;
    const out: Omit<DeployState, "loaded" | "loading" | "scroll"> = {
      deployed,
      containerStatus: status.ok ? status.stdout.trim() : undefined,
      head: head.ok ? head.stdout.trim() : undefined,
      dirty: dirty.ok ? dirty.stdout.split("\n").filter((l) => l.trim() !== "") : [],
      // A refusal exits non-zero with the reason on stderr — that IS the plan.
      plan: (plan.ok ? plan.stdout : `${plan.stdout}${plan.stderr}`).split("\n"),
    };
    if (deployed) {
      const [log, stat] = await Promise.all([this.local(logArgv(deployed.sha)), this.local(diffStatArgv(deployed.sha))]);
      // A sha local git doesn't know (rewritten history?) leaves these
      // undefined and the render says so instead of pretending "0 pending".
      if (log.ok) out.commits = log.stdout.split("\n").filter((l) => l.trim() !== "");
      if (stat.ok) out.diffstat = stat.stdout.split("\n").filter((l) => l.trim() !== "");
    }
    return out;
  }
}

// ---- render -----------------------------------------------------------------

function section(title: string, subtitle: string): string {
  return `${FG.accent}${SGR.bold}${title}${RESET} ${FG.dim}${subtitle}${RESET}`;
}

/** The tab body as one scrollable column. Pure for tests. */
export function deployLines(st: DeployState, width: number): string[] {
  if (!st.loaded) return [`${SGR.dim}loading…${SGR.reset}`];
  const lines: string[] = [];
  const dep = st.deployed;
  const depText = dep
    ? `${SGR.bold}${dep.sha}${SGR.reset}${dep.at ? ` ${FG.dim}${dep.at}${RESET}` : ""}${dep.mode ? ` ${FG.dim}(${dep.mode})${RESET}` : ""}`
    : `${FG.dim}unknown — no BUILD_SHA on the VM yet (the next deploy writes it)${RESET}`;
  lines.push(truncate(`${section("DEPLOYED", "what the VM runs")}  ${depText}`, width));
  const cleanliness = st.dirty.length === 0 ? `${FG.approve}clean${RESET}` : `${FG.anomaly}dirty — ${st.dirty.length} uncommitted (deploy.sh will refuse)${RESET}`;
  lines.push(truncate(`${section("LOCAL", "this working copy")}     ${SGR.bold}${st.head ?? "?"}${SGR.reset}  ${cleanliness}`, width));
  for (const d of st.dirty.slice(0, 8)) lines.push(truncate(`    ${FG.dim}${d}${RESET}`, width));
  if (st.dirty.length > 8) lines.push(`    ${FG.dim}… ${st.dirty.length - 8} more${RESET}`);
  lines.push("");

  if (dep && st.head && dep.sha === st.head && st.dirty.length === 0) {
    lines.push(`${FG.approve}✓ the VM already runs this commit — nothing to deploy${RESET}`);
  } else if (dep) {
    if (st.commits === undefined) {
      lines.push(truncate(`${FG.anomaly}deployed sha ${dep.sha} is unknown to local git — cannot diff${RESET}`, width));
    } else {
      lines.push(truncate(section(`PENDING (${st.commits.length})`, "commits a deploy would ship"), width));
      for (const c of st.commits) lines.push(truncate(`  ${c}`, width));
      if (st.commits.length === 0) lines.push(`  ${FG.dim}(none)${RESET}`);
      if (st.diffstat && st.diffstat.length > 0) {
        lines.push(truncate(section("DIFFSTAT", `${dep.sha}..HEAD`), width));
        for (const d of st.diffstat) lines.push(truncate(`  ${d}`, width));
      }
    }
  }
  lines.push("");
  lines.push(truncate(section("PLAN", "scripts/deploy.sh --dry-run sync, verbatim"), width));
  for (const p of st.plan) lines.push(truncate(`  ${p}`, width));
  lines.push("");
  if (st.armedAt !== undefined) {
    lines.push(truncate(`${SGR.bgRed}${SGR.bold} ARMED ${SGR.reset} press ${SGR.bold}D${SGR.reset} again to run ./scripts/deploy.sh sync (any other key cancels)`, width));
  } else {
    lines.push(truncate(`${SGR.bold}to deploy:${SGR.reset} press ${SGR.bold}D${SGR.reset} twice (runs ${FG.accent}./scripts/deploy.sh sync${RESET} in your terminal) — or run it yourself`, width));
  }
  return lines;
}

export function renderDeployTab(st: DeployState, dryRun: boolean, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  frame.set(0, rule(cols, "┌", "┐", ["quickreview", dryRun ? "DRY-RUN" : `${SGR.bgRed}${SGR.bold} LIVE ${SGR.reset}`, "deploy"]));

  // The button row — deploy + power, both mouse-clickable, pinned under the
  // title. While a run streams, the row becomes its status chip.
  const run = st.run;
  const RUN_VERBS: Record<RunKind, [string, string, string]> = {
    deploy: [" ⟳ DEPLOYING… ", " ✔ DEPLOY OK ", " ✖ DEPLOY FAILED"],
    stop: [" ⟳ STOPPING VM APP… ", " ■ STOPPED ", " ✖ STOP FAILED"],
    start: [" ⟳ STARTING VM APP… ", " ✔ STARTED ", " ✖ START FAILED"],
  };
  if (run) {
    const [busy, ok, bad] = RUN_VERBS[run.kind];
    const label = run.running ? busy : run.code === 0 ? ok : `${bad} (exit ${run.code ?? "signal"}) `;
    const chip =
      run.running || run.code === 0
        ? `${SGR.inverse}${SGR.bold}${label}${SGR.reset}`
        : `${SGR.bgRed}${SGR.bold}${label}${SGR.reset}`;
    const suffix = run.running ? "  streaming — j/k scroll · x abort" : "  x close log · r refresh";
    frame.boxRow(1, [{ text: ` ${chip}${FG.dim}${suffix}${RESET}`, width: cols - 2 }]);
    st.buttonZone = undefined;
    st.powerZone = undefined;
  } else {
    const running = st.containerStatus === undefined ? undefined : /^Up /.test(st.containerStatus);
    const deployArmed = st.armedKind === "deploy";
    const powerKind: RunKind = running === false ? "start" : "stop";
    const powerArmed = st.armedKind === powerKind;
    const dLabel = deployArmed ? " ⚠ CLICK AGAIN TO DEPLOY NOW " : " ▶ DEPLOY TO VM ";
    const pLabel = powerArmed
      ? powerKind === "stop"
        ? " ⚠ CLICK AGAIN TO STOP NOW "
        : " ⚠ CLICK AGAIN TO START NOW "
      : powerKind === "stop"
        ? " ■ STOP VM APP "
        : " ▶ START VM APP ";
    const dBtn = deployArmed ? `${SGR.bgRed}${SGR.bold}${dLabel}${SGR.reset}` : `${SGR.inverse}${SGR.bold}${dLabel}${SGR.reset}`;
    const pBtn = powerArmed ? `${SGR.bgRed}${SGR.bold}${pLabel}${SGR.reset}` : `${SGR.inverse}${SGR.bold}${pLabel}${SGR.reset}`;
    const vm =
      st.containerStatus === undefined
        ? `${FG.dim}VM: …${RESET}`
        : st.containerStatus === ""
          ? `${FG.dim}VM: no container${RESET}`
          : running
            ? `VM: ${st.containerStatus}`
            : `${SGR.bold}VM: ${st.containerStatus}${SGR.reset}`;
    const suffix = st.armedKind !== undefined ? "  any other key/click cancels" : "  (also: D D deploy · S S stop/start)";
    frame.boxRow(1, [{ text: ` ${dBtn}  ${pBtn}  ${vm}${FG.dim}${suffix}${RESET}`, width: cols - 2 }]);
    const dW = displayWidth(stripAnsi(dLabel));
    st.buttonZone = { x1: 2, y1: 2, x2: 1 + dW, y2: 2 };
    const pX = 2 + dW + 2;
    st.powerZone = { x1: pX, y1: 2, x2: pX + displayWidth(stripAnsi(pLabel)) - 1, y2: 2 };
  }

  const bodyRows = rows - 4; // top bar + button row + hints + bottom border
  if (run) {
    // Live log view: tail-follow; st.scroll counts lines BACK from the tail.
    const all = run.partial ? [...run.lines, run.partial] : run.lines;
    const maxOff = Math.max(0, all.length - bodyRows);
    const off = Math.min(st.scroll, maxOff);
    const start = Math.max(0, all.length - bodyRows - off);
    for (let r = 0; r < bodyRows; r++) {
      const line = all[start + r];
      frame.boxRow(2 + r, [{ text: ` ${line === undefined ? "" : truncate(line, cols - 4)}`, width: cols - 2 }]);
    }
  } else {
    const lines = deployLines(st, cols - 4);
    for (let r = 0; r < bodyRows; r++) {
      frame.boxRow(2 + r, [{ text: ` ${lines[st.scroll + r] ?? ""}`, width: cols - 2 }]);
    }
  }
  const refreshing = st.loading ? "  refreshing…" : "";
  const hints = run
    ? `[1]board [2]digest [4]deploy  j/k scroll log  ${run.running ? "x abort" : "x close log"}  q quit`
    : `[1]board [2]digest [4]deploy  click ▶ or D D deploy  j/k scroll  r refresh  q quit`;
  frame.boxRow(rows - 2, [{ text: ` ${SGR.dim}${hints}${refreshing}${SGR.reset}`, width: cols - 2 }]);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

// ---- hooks ------------------------------------------------------------------

export function installDeployHooks(app: App, fetcher?: DeployFetcher, now: () => number = () => Date.now()): DeployState {
  const f = fetcher ?? new RealDeployFetcher(app.cfg, app.ssh, realLocalRunner(process.cwd()));
  const st: DeployState = { loaded: false, loading: false, dirty: [], plan: [], scroll: 0 };

  const load = async (): Promise<void> => {
    if (st.loading) return;
    st.loading = true;
    try {
      Object.assign(st, await f.load());
      st.loaded = true;
    } finally {
      st.loading = false;
    }
    app.repaint();
  };

  app.hooks.deployScreen = (theApp, cols, rows) => {
    if (!st.loaded && !st.loading) void load();
    return renderDeployTab(st, theApp.view.dryRun, cols, rows).render();
  };

  // The kill handle of the run in flight (undefined once it exits).
  let handle: { kill(): void } | undefined;

  type StreamRunner = (a: App, onData: (chunk: string) => void, onExit: (code: number | null) => void) => { kill(): void };

  const startRun = (theApp: App, kind: RunKind): void => {
    const power = theApp.hooks.powerRun;
    const runner: StreamRunner | undefined =
      kind === "deploy"
        ? theApp.hooks.deployRun
        : power && ((a, onData, onExit) => power(a, kind, onData, onExit));
    if (!runner) {
      theApp.notice(`✖ ${kind} runner not wired`);
      return;
    }
    const run: DeployRun = { kind, lines: [], partial: "", running: true };
    st.run = run;
    st.scroll = 0; // follow the tail
    handle = runner(
      theApp,
      (chunk) => {
        if (st.run !== run) return; // stale callback after a close
        appendRunChunk(run, chunk);
        theApp.repaint();
      },
      (code) => {
        if (run.partial) {
          run.lines.push(stripAnsi(run.partial));
          run.partial = "";
        }
        run.running = false;
        run.code = code;
        handle = undefined;
        st.loaded = false;
        void load(); // re-read BUILD_SHA/status/plan against the new reality
        theApp.repaint();
      },
    );
    theApp.repaint();
  };

  // One press = arm; a second press of the SAME button inside the confirm
  // window = run. Shared by keys (D/S) and the mouse. Ignored mid-run.
  const press = (theApp: App, kind: RunKind): void => {
    if (st.run?.running) return;
    const t = now();
    if (st.armedKind === kind && st.armedAt !== undefined && t - st.armedAt < DEPLOY_CONFIRM_MS) {
      st.armedAt = undefined;
      st.armedKind = undefined;
      startRun(theApp, kind);
    } else {
      st.run = undefined; // arming clears a finished log
      st.armedAt = t;
      st.armedKind = kind;
    }
    theApp.repaint();
  };

  /** The power button's action follows the container's observed state:
   * running (or unknown — a stop of a stopped container is a no-op) → stop,
   * definitely stopped → start. */
  const powerKind = (): RunKind => (st.containerStatus !== undefined && !/^Up /.test(st.containerStatus) ? "start" : "stop");

  const disarm = (theApp: App): void => {
    if (st.armedAt === undefined) return;
    st.armedAt = undefined;
    st.armedKind = undefined;
    theApp.repaint();
  };

  app.hooks.deployClick = (theApp, x, y): void => {
    const inside = (z?: { x1: number; y1: number; x2: number; y2: number }): boolean =>
      z !== undefined && x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2;
    if (inside(st.buttonZone)) press(theApp, "deploy");
    else if (inside(st.powerZone)) press(theApp, powerKind());
    else disarm(theApp); // a click anywhere else cancels
  };

  app.hooks.deployKey = (theApp, key: BoardKey): boolean => {
    if (key.kind === "char" && key.ch === "D") {
      press(theApp, "deploy");
      return true;
    }
    if (key.kind === "char" && key.ch === "S") {
      press(theApp, powerKind());
      return true;
    }
    if (st.armedAt !== undefined) disarm(theApp); // any other key disarms
    if (st.run && key.kind === "char" && key.ch === "x") {
      if (st.run.running) {
        handle?.kill(); // abort — onExit lands with the signal code
        theApp.notice(`${st.run.kind} aborted (SIGTERM)`);
      } else {
        st.run = undefined; // close the finished log, back to the plan view
        st.scroll = 0;
      }
      theApp.repaint();
      return true;
    }
    switch (key.kind) {
      case "down":
      case "up": {
        // Plan view: scroll is lines from the top. Log view: lines back from
        // the tail (0 = follow), so up/down invert.
        const delta = key.kind === "down" ? 1 : -1;
        if (st.run) {
          const total = st.run.lines.length + (st.run.partial ? 1 : 0);
          st.scroll = Math.max(0, Math.min(st.scroll - delta, total));
        } else {
          st.scroll = Math.max(0, st.scroll + delta);
        }
        theApp.repaint();
        return true;
      }
      case "refresh":
        if (st.run?.running) return true; // never reload state under a live run
        st.run = undefined;
        st.scroll = 0;
        void load();
        theApp.repaint();
        return true;
      default:
        return false; // tabs/quit/help fall through to the app
    }
  };

  return st;
}
