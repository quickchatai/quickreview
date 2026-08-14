// Deploy tab (key 4) — "what would a deploy ship?" plus the deploy button:
// the commit the VM is running (the BUILD_SHA marker deploy.sh rsyncs along),
// local HEAD, the pending commit list + diffstat between them, and deploy.sh's
// own --dry-run plan verbatim. D D (armed confirm) runs `scripts/deploy.sh
// sync` on the operator's real terminal via hooks.deployRun — deploy.sh's own
// guardrails (clean tree, pin agreement) stay the only gate.
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
  const armed = st.armedAt !== undefined;
  const label = armed ? " ⚠ CLICK AGAIN TO DEPLOY NOW " : " ▶ DEPLOY TO VM ";
  const btn = armed ? `${SGR.bgRed}${SGR.bold}${label}${SGR.reset}` : `${SGR.inverse}${SGR.bold}${label}${SGR.reset}`;
  const suffix = armed ? "  any other key/click cancels" : "  runs ./scripts/deploy.sh sync (also: D D)";
  frame.boxRow(1, [{ text: ` ${btn}${FG.dim}${suffix}${RESET}`, width: cols - 2 }]);
  st.buttonZone = { x1: 2, y1: 2, x2: 1 + displayWidth(stripAnsi(label)), y2: 2 };

  const bodyRows = rows - 4; // top bar + button row + hints + bottom border
  const lines = deployLines(st, cols - 4);
  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(2 + r, [{ text: ` ${lines[st.scroll + r] ?? ""}`, width: cols - 2 }]);
  }
  const refreshing = st.loading ? "  refreshing…" : "";
  frame.boxRow(rows - 2, [{ text: ` ${SGR.dim}[1]board [2]digest [4]deploy  click ▶ or D D deploy  j/k scroll  r refresh  q quit${refreshing}${SGR.reset}`, width: cols - 2 }]);
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

  // One press = arm; a second press inside the confirm window = deploy.
  // Shared by the D key and the mouse button.
  const press = (theApp: App): void => {
    const t = now();
    if (st.armedAt !== undefined && t - st.armedAt < DEPLOY_CONFIRM_MS) {
      st.armedAt = undefined;
      if (theApp.hooks.deployRun) {
        theApp.hooks.deployRun(theApp); // synchronous: TUI is suspended while deploy.sh runs
        st.loaded = false;
        void load(); // re-read BUILD_SHA + plan against the new reality
      } else {
        theApp.notice("✖ deploy runner not wired");
      }
    } else {
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
    switch (key.kind) {
      case "down":
      case "up":
        if (key.kind === "down") st.scroll += 1;
        else st.scroll = Math.max(0, st.scroll - 1);
        theApp.repaint();
        return true;
      case "refresh":
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
