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
  /** A live (or just-finished) deploy run streamed into the tab. */
  run?: DeployRun;
}

/** deploy.sh output streamed into the pane — the TUI never suspends. */
export interface DeployRun {
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
    const [marker, head, dirty, plan] = await Promise.all([
      this.ssh(this.cfg.ssh_host, buildShaArgv(this.cfg)),
      this.local(HEAD_ARGV),
      this.local(DIRTY_ARGV),
      this.local(PLAN_ARGV),
    ]);
    const deployed = marker.ok ? parseBuildSha(marker.stdout) : undefined;
    const out: Omit<DeployState, "loaded" | "loading" | "scroll"> = {
      deployed,
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

  // THE button — always visible, pinned under the title, mouse-clickable.
  // While a run streams it doubles as the status chip.
  const armed = st.armedAt !== undefined;
  const run = st.run;
  const label = run?.running
    ? " ⟳ DEPLOYING… "
    : run
      ? run.code === 0
        ? " ✔ DEPLOY OK "
        : ` ✖ DEPLOY FAILED (exit ${run.code ?? "signal"}) `
      : armed
        ? " ⚠ CLICK AGAIN TO DEPLOY NOW "
        : " ▶ DEPLOY TO VM ";
  const btn =
    run?.running || (run && run.code === 0)
      ? `${SGR.inverse}${SGR.bold}${label}${SGR.reset}`
      : run || armed
        ? `${SGR.bgRed}${SGR.bold}${label}${SGR.reset}`
        : `${SGR.inverse}${SGR.bold}${label}${SGR.reset}`;
  const suffix = run?.running
    ? "  streaming ./scripts/deploy.sh sync — j/k scroll · x abort"
    : run
      ? "  x close log · r refresh"
      : armed
        ? "  any other key/click cancels"
        : "  runs ./scripts/deploy.sh sync (also: D D)";
  frame.boxRow(1, [{ text: ` ${btn}${FG.dim}${suffix}${RESET}`, width: cols - 2 }]);
  st.buttonZone = run ? undefined : { x1: 2, y1: 2, x2: 1 + displayWidth(stripAnsi(label)), y2: 2 };

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

  const startRun = (theApp: App): void => {
    if (!theApp.hooks.deployRun) {
      theApp.notice("✖ deploy runner not wired");
      return;
    }
    const run: DeployRun = { lines: [], partial: "", running: true };
    st.run = run;
    st.scroll = 0; // follow the tail
    handle = theApp.hooks.deployRun(
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
        void load(); // re-read BUILD_SHA + plan against the new reality
        theApp.repaint();
      },
    );
    theApp.repaint();
  };

  // One press = arm; a second press inside the confirm window = deploy.
  // Shared by the D key and the mouse button. Ignored while a run streams.
  const press = (theApp: App): void => {
    if (st.run?.running) return;
    const t = now();
    if (st.armedAt !== undefined && t - st.armedAt < DEPLOY_CONFIRM_MS) {
      st.armedAt = undefined;
      startRun(theApp);
    } else {
      st.run = undefined; // arming clears a finished log
      st.armedAt = t;
    }
    theApp.repaint();
  };

  app.hooks.deployClick = (theApp, x, y): void => {
    const z = st.buttonZone;
    if (z && x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) {
      press(theApp);
    } else if (st.armedAt !== undefined) {
      st.armedAt = undefined; // a click anywhere else cancels
      theApp.repaint();
    }
  };

  app.hooks.deployKey = (theApp, key: BoardKey): boolean => {
    if (key.kind === "char" && key.ch === "D") {
      press(theApp);
      return true;
    }
    if (st.armedAt !== undefined) st.armedAt = undefined; // any other key disarms
    if (st.run && key.kind === "char" && key.ch === "x") {
      if (st.run.running) {
        handle?.kill(); // abort — onExit lands with the signal code
        theApp.notice("deploy aborted (SIGTERM to deploy.sh)");
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
