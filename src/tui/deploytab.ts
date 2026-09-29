// `[5] deploy` — "what would a deploy ship?" plus the deploy button:
// the commit the VM is running (the BUILD_SHA marker deploy.sh rsyncs along),
// local HEAD, the pending commit list + diffstat between them, and deploy.sh's
// own --dry-run plan verbatim. Click ▶ (or D D) owns the whole ceremony:
// engage the persistent daemon drain, visibly wait for a fresh zero-round
// snapshot, then stream `scripts/deploy.sh sync`. The new boot auto-lifts only
// after its first healthy reconcile; a failed sync stays drained.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateHome } from "../install.js";
import { parseRetunes, RETUNES_FILE, type RetunesRead } from "../setup/retunelog.js";
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import type { BoardKey } from "./keys.js";
import { barHeight, paintCmdBar, type BarButton, type LiveKeys } from "./cmdbar.js";
import {
  ACCENT,
  ACCENT_BG,
  BAD,
  HEADING,
  MUTED,
  OK,
  RESET as DRESET,
  STRONG,
  WARN,
  WARN_BG,
  badge,
  modeBadge,
  sectionTitle,
} from "./design.js";
import { Frame, displayWidth, rule, stripAnsi, truncate } from "./paint.js";
import { transportOf, type RemoteResult, type SshRunner } from "./remote.js";
import { CommandDrainSender, type DeployDrainSender } from "./deploy-drain.js";
import { chainOnPoll } from "./poll-hooks.js";
import {
  MemoryDeployCeremonyStore,
  type DeployCeremonyStore,
  type DurableDeployPhase,
} from "./deploy-ceremony.js";

export type { DeployDrainSender } from "./deploy-drain.js";
import {
  configDrift,
  configDriftText,
  parseConfigFingerprint,
  pendingRetuneLines,
  pendingRetunes,
  type ConfigRead,
} from "./confighome.js";
import { FG, RESET } from "./theme.js";

function dockerSh(cfg: TuiConfig, script: string): string[] {
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "exec",
    cfg.container,
    "sh",
    "-c",
    script,
  ];
}

/** BUILD_SHA rides the deploy rsync into the sandbox root on the VM. */
export function buildShaArgv(cfg: TuiConfig): string[] {
  return dockerSh(cfg, `cat '${cfg.remote_sandbox_root}/BUILD_SHA' 2>/dev/null || true`);
}

/**: the config home the last sync SHIPPED, fingerprinted inside the
 * container by the very script that fingerprints the local one — the
 * container's QCR_CONFIG names the shipped file. A VM that predates
 * has no such script, and then no config home was ever shipped to it: that is
 * a fact read (`none`), not an unanswered read, so it is said as one. */
export function configFingerprintArgv(cfg: TuiConfig): string[] {
  const root = cfg.remote_sandbox_root;
  const script = `${root}/scripts/config-fingerprint.sh`;
  return dockerSh(
    cfg,
    `if [ -f '${script}' ]; then bash '${script}' --located '${root}'; else echo none; fi`,
  );
}

/** Container status straight from docker — works while it is stopped too. */
export function containerStatusArgv(cfg: TuiConfig): string[] {
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "ps",
    "-a",
    "--filter",
    `name=${cfg.container}`,
    "--format",
    "{{.Status}}",
  ];
}

/** The remote shell line hooks.powerRun streams: docker stop/start. */
export function powerCommand(cfg: TuiConfig, action: "stop" | "start"): string {
  return `${cfg.sudo_docker ? "sudo " : ""}docker ${action} ${cfg.container}`;
}

/**: the FULL power command, binary first — what hooks.powerRun
 * spawns. ssh mode wraps `powerCommand` as the remote shell line (unchanged);
 * local mode runs the same words directly (the command is a fixed
 * space-joined `[sudo] docker <action> <container>`, so the split is exact). */
export function powerSpawnArgv(cfg: TuiConfig, action: "stop" | "start"): string[] {
  if (transportOf(cfg) === "local") return powerCommand(cfg, action).split(" ");
  return ["ssh", cfg.ssh_host, powerCommand(cfg, action)];
}

// ---- local (laptop-side) commands — all read-only ---------------------------

export const HEAD_ARGV = ["git", "rev-parse", "--short", "HEAD"];
export const DIRTY_ARGV = ["git", "status", "--porcelain"];
export const PLAN_ARGV = ["bash", "scripts/deploy.sh", "--dry-run", "sync"];
/**: the config home a sync WOULD ship, located exactly as deploy.sh
 * locates it (scripts/install-locator.sh `qcr_shipped_config`). */
export const CONFIG_FINGERPRINT_ARGV = ["bash", "scripts/config-fingerprint.sh", "--located", "."];

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
        resolvePromise({
          ok: err === null,
          stdout: String(stdout),
          stderr: String(stderr),
          code: err === null ? 0 : 1,
        });
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
  /** The VM's BUILD_SHA marker: the marker when read; `"absent"` when the VM
   * carries none (this system has never deployed to it — the first deploy
   * writes one); `"unparseable"` when the file is there but is not a
   * `<sha> <iso> <mode>` line (the read succeeded — the content is the
   * problem, and a redeploy rewrites it); `undefined` until fetched, and
   * after a fetch whose ssh or docker read never answered. Three different
   * facts, three different sentences: an unanswered read says NOTHING about
   * what the VM runs, so it must never render or publish as "no marker" —
   * and a corrupt marker must never be blamed on ssh. */
  deployed?: DeployedMarker | "absent" | "unparseable";
  /**: the config home this machine would ship, and the one the VM
   * was shipped — each `undefined` until fetched and after a read that never
   * answered. Compared by `configDrift`. */
  configLocal?: ConfigRead;
  configDeployed?: ConfigRead;
  /**: the setup re-tune log in this machine's state home — which
   * post-scan re-tune a pending profile change is. `undefined` until fetched. */
  retunes?: RetunesRead;
  /** Local HEAD; `undefined` when `git rev-parse` could not be read. */
  head?: string;
  /** Uncommitted paths, or `undefined` when `git status` could not be read.
   * NOT an empty array in that case: an unread tree rendered as a
   * green "clean" is the DRY-RUN-on-a-live-install bug wearing a deploy hat —
   * it says "nothing to ship" when it does not know. */
  dirty: string[] | undefined;
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
  /** A confirmed deploy is a drain ceremony, not an immediate process spawn. */
  deployPhase?:
    | "engaging-drain"
    | "waiting-rounds"
    | "syncing"
    | "awaiting-lift"
    | "done"
    | "lifting-after-abort"
    | "aborted"
    | "drain-failed"
    | "deploy-failed";
  drainRounds?: number;
  drainStatusNote?: string;
  targetHead?: string;
  preDeploySnapshotAt?: string;
  drainObserved?: boolean;
  firstUndrainedSnapshotAt?: string;
  deployRunId?: string;
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

/**: the re-tune log in this machine's state home (the companion
 * writes it through the mounted state home). A read that throws is UNKNOWN. */
export function readRetuneLog(home: string = stateHome()): RetunesRead {
  let text: string | null;
  try {
    text = readFileSync(join(home, RETUNES_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") text = null;
    else return { state: "unreadable", error: `${RETUNES_FILE} cannot be read: ${String(err)}` };
  }
  return parseRetunes(text);
}

export class RealDeployFetcher implements DeployFetcher {
  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly local: LocalRunner,
    private readonly retuneLog: () => RetunesRead = () => readRetuneLog(),
  ) {}

  async load(): Promise<Omit<DeployState, "loaded" | "loading" | "scroll">> {
    const [marker, status, head, dirty, plan, cfgRemote, cfgLocal] = await Promise.all([
      this.ssh(this.cfg.ssh_host, buildShaArgv(this.cfg)),
      this.ssh(this.cfg.ssh_host, containerStatusArgv(this.cfg)),
      this.local(HEAD_ARGV),
      this.local(DIRTY_ARGV),
      this.local(PLAN_ARGV),
      this.ssh(this.cfg.ssh_host, configFingerprintArgv(this.cfg)),
      this.local(CONFIG_FINGERPRINT_ARGV),
    ]);
    // `buildShaArgv` swallows a missing file into empty output, so an ok/empty
    // answer is a VM with no marker; ok/garbage is a marker we read but could
    // not parse; a failed exec is a VM we could not ask.
    const deployed = marker.ok
      ? marker.stdout.trim() === ""
        ? "absent"
        : (parseBuildSha(marker.stdout) ?? "unparseable")
      : undefined;
    const out: Omit<DeployState, "loaded" | "loading" | "scroll"> = {
      deployed,
      containerStatus: status.ok ? status.stdout.trim() : undefined,
      configLocal: cfgLocal.ok ? parseConfigFingerprint(cfgLocal.stdout) : undefined,
      configDeployed: cfgRemote.ok ? parseConfigFingerprint(cfgRemote.stdout) : undefined,
      retunes: this.retuneLog(),
      head: head.ok ? head.stdout.trim() : undefined,
      dirty: dirty.ok ? dirty.stdout.split("\n").filter((l) => l.trim() !== "") : undefined,
      // A refusal exits non-zero with the reason on stderr — that IS the plan.
      plan: (plan.ok ? plan.stdout : `${plan.stdout}${plan.stderr}`).split("\n"),
    };
    if (typeof deployed === "object") {
      const [log, stat] = await Promise.all([
        this.local(logArgv(deployed.sha)),
        this.local(diffStatArgv(deployed.sha)),
      ]);
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
  return sectionTitle(title, subtitle);
}

/** The tab body as one scrollable column. Pure for tests. */
export function deployLines(st: DeployState, width: number): string[] {
  if (!st.loaded) return [`${MUTED}loading…${DRESET}`];
  const lines: string[] = [];
  const dep = typeof st.deployed === "object" ? st.deployed : undefined;
  const depText = dep
    ? `${STRONG}${dep.sha}${DRESET}${dep.at ? ` ${FG.dim}${dep.at}${RESET}` : ""}${dep.mode ? ` ${FG.dim}(${dep.mode})${RESET}` : ""}`
    : st.deployed === "absent"
      ? `${FG.dim}unknown — no BUILD_SHA on the VM yet (the next deploy writes it)${RESET}`
      : st.deployed === "unparseable"
        ? `${WARN}unknown — the VM's BUILD_SHA was read but is not a <sha> <iso> <mode> line (corrupt marker; the next deploy rewrites it)${DRESET}`
        : `${WARN}unknown — the VM's BUILD_SHA could not be read (ssh/docker failed); r retries${DRESET}`;
  lines.push(truncate(`${section("DEPLOYED", "what the VM runs")}  ${depText}`, width));
  const headText = st.head
    ? `${STRONG}${st.head}${DRESET}`
    : `${WARN}HEAD unknown — git rev-parse failed${DRESET}`;
  const cleanliness =
    st.dirty === undefined
      ? `${WARN}unknown — git status could not be read${DRESET}`
      : st.dirty.length === 0
        ? `${OK}clean${DRESET}`
        : `${BAD}dirty — ${st.dirty.length} uncommitted (deploy.sh will refuse)${DRESET}`;
  lines.push(
    truncate(`${section("LOCAL", "this working copy")}     ${headText}  ${cleanliness}`, width),
  );
  for (const d of (st.dirty ?? []).slice(0, 8))
    lines.push(truncate(`    ${FG.dim}${d}${RESET}`, width));
  if ((st.dirty?.length ?? 0) > 8)
    lines.push(`    ${FG.dim}… ${st.dirty!.length - 8} more${RESET}`);
  // the config home ships beside the commit, so it has its own line.
  const drift = configDrift(st.configLocal, st.configDeployed);
  const driftInk =
    drift.kind === "same" ? OK : drift.kind === "changed" || drift.kind === "no-home" ? BAD : WARN;
  lines.push(
    truncate(
      `${section("CONFIG", "config home vs the VM")}  ${driftInk}${configDriftText(drift)}${DRESET}`,
      width,
    ),
  );
  // which post-scan re-tune that profile change is, and why.
  const retunes = pendingRetunes(st.retunes, drift, dep?.at);
  const retuneInk = retunes.state === "pending" ? BAD : WARN;
  for (const [i, l] of pendingRetuneLines(retunes).entries()) {
    lines.push(truncate(i === 0 ? `  ${retuneInk}${l}${DRESET}` : `  ${FG.dim}${l}${RESET}`, width));
  }
  lines.push("");

  // "Up to date, nothing to deploy" is a CLAIM, so it needs every fact — an
  // unreadable working tree is not the same as a clean one, and a config home
  // that could not be compared is not the same as one that matches.
  if (dep && st.head && dep.sha === st.head && st.dirty?.length === 0) {
    lines.push(
      drift.kind === "same"
        ? `${OK}✓ the VM already runs this commit and this config home — nothing to deploy${DRESET}`
        : drift.kind === "changed" || drift.kind === "never-shipped"
          ? `${WARN}the VM runs this commit, but its config home is behind — a sync ships it${DRESET}`
          : `${WARN}the VM runs this commit; whether its config home matches is not known${DRESET}`,
    );
  } else if (dep) {
    if (st.commits === undefined) {
      lines.push(
        truncate(
          `${BAD}deployed sha ${dep.sha} is unknown to local git — cannot diff${DRESET}`,
          width,
        ),
      );
    } else {
      lines.push(
        truncate(section(`PENDING (${st.commits.length})`, "commits a deploy would ship"), width),
      );
      for (const c of st.commits) lines.push(truncate(`  ${c}`, width));
      if (st.commits.length === 0) lines.push(`  ${MUTED}none yet — nothing to ship${DRESET}`);
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
    lines.push(
      truncate(
        `${badge("warn", "ARMED")} press ${STRONG}D${DRESET} again to drain → wait for zero → deploy (any other key cancels)`,
        width,
      ),
    );
  } else {
    lines.push(
      truncate(
        `${STRONG}to deploy:${DRESET} press ${STRONG}D${DRESET} twice (${ACCENT}drain → zero rounds → ./scripts/deploy.sh sync → healthy-boot auto-lift${DRESET})`,
        width,
      ),
    );
  }
  return lines;
}

/**
 * What the deploy tab answers to on this frame. `D` and `S` only while no run
 * is on screen (a press during one is refused, and a refused key is a dead
 * key); `S` only once the container's state has been READ — the unknown
 * state registers no key exactly as it paints no click zone (a
 * stop derived from unread data could stop a live reviewer); `x` while there
 * is a run to abort or a finished log to close.
 */
export function deployKeys(st: DeployState): LiveKeys {
  const bar: BarButton[] = [];
  if (st.run) {
    bar.push({ key: "x", label: st.run.running ? "x abort" : "x close log" });
    return { bar, inline: [] };
  }
  bar.push({ key: "D", label: st.armedKind === "deploy" ? "D confirm deploy" : "D deploy" });
  if (st.containerStatus !== undefined) {
    const kind = /^Up /.test(st.containerStatus) ? "stop" : "start";
    bar.push({ key: "S", label: st.armedKind === kind ? `S confirm ${kind}` : `S ${kind} VM app` });
  }
  return { bar, inline: [] };
}

export function renderDeployTab(
  st: DeployState,
  dryRun: boolean | undefined,
  cols: number,
  rows: number,
): Frame {
  const frame = new Frame(cols, rows);
  const live = deployKeys(st);
  frame.set(0, rule(cols, "┌", "┐", [`${HEADING}quickreview${DRESET}`, modeBadge(dryRun), "deploy"]));

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
    const deployLabel =
      run.kind === "deploy"
        ? st.deployPhase === "engaging-drain"
          ? " ⟳ ENGAGING DRAIN… "
          : st.deployPhase === "waiting-rounds"
            ? ` ⏳ DRAINING — ${st.drainRounds ?? "?"} round${st.drainRounds === 1 ? "" : "s"} finishing `
            : st.deployPhase === "lifting-after-abort"
              ? " ⟳ ABORTING — LIFTING DRAIN… "
              : st.deployPhase === "aborted"
                ? " ■ DEPLOY ABORTED · DRAIN OFF "
                : st.deployPhase === "awaiting-lift"
                  ? " ✔ DEPLOY OK · DRAIN AUTO-LIFT PENDING "
                  : st.deployPhase === "done"
                    ? " ✔ DEPLOY OK · DRAIN LIFTED "
                    : st.deployPhase === "drain-failed" || st.deployPhase === "deploy-failed"
                      ? ` ✖ DEPLOY FAILED (exit ${run.code ?? "signal"}) `
                      : undefined
        : undefined;
    const label =
      deployLabel ??
      (run.running ? busy : run.code === 0 ? ok : `${bad} (exit ${run.code ?? "signal"}) `);
    const chip = run.running
      ? `${ACCENT_BG}${STRONG}${label}${DRESET}`
      : run.code === 0
        ? `${OK}${STRONG}${label}${DRESET}`
        : `${BAD}${STRONG}${label}${DRESET}`;
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
    // An UNFETCHED (or failed) container status used to fall through to
    // "■ STOP VM APP", which asserts the container is up. Say what is true —
    // the state is unknown — and let `r` fetch it.
    // UNKNOWN is checked FIRST, before armed. It cannot currently be both (an
    // unknown state registers no zone and `pressPower` refuses, so nothing can
    // arm it) — but reading the armed branch first invites the next editor to
    // conclude the unknown case is merely a label, which is the mistake this
    // whole guard exists to undo.
    const pLabel =
      running === undefined
        ? " ▮ VM APP STATE UNKNOWN "
        : powerArmed
          ? powerKind === "stop"
            ? " ⚠ CLICK AGAIN TO STOP NOW "
            : " ⚠ CLICK AGAIN TO START NOW "
          : powerKind === "stop"
            ? " ■ STOP VM APP "
            : " ▶ START VM APP ";
    const dBtn = deployArmed
      ? `${WARN_BG}${STRONG}${dLabel}${DRESET}`
      : `${ACCENT_BG}${STRONG}${dLabel}${DRESET}`;
    // Unknown is not a button: painted in muted ink, and — below — it claims no
    // click zone at all, so it cannot be pressed into arming a stop.
    const pBtn =
      running === undefined
        ? `${MUTED}${pLabel}${DRESET}`
        : powerArmed
          ? `${WARN_BG}${STRONG}${pLabel}${DRESET}`
          : `${ACCENT_BG}${STRONG}${pLabel}${DRESET}`;
    const vm =
      st.containerStatus === undefined
        ? `${WARN}VM: state unknown — r refreshes${DRESET}`
        : st.containerStatus === ""
          ? `${FG.dim}VM: no container${RESET}`
          : running
            ? `VM: ${st.containerStatus}`
            : `${STRONG}VM: ${st.containerStatus}${DRESET}`;
    const suffix =
      st.armedKind !== undefined
        ? "  any other key/click cancels"
        : "  (also: D D deploy · S S stop/start)";
    const refreshing = st.loading ? "  refreshing…" : "";
    frame.boxRow(1, [
      { text: ` ${dBtn}  ${pBtn}  ${vm}${FG.dim}${suffix}${refreshing}${RESET}`, width: cols - 2 },
    ]);
    const dW = displayWidth(stripAnsi(dLabel));
    st.buttonZone = { x1: 2, y1: 2, x2: 1 + dW, y2: 2 };
    const pX = 2 + dW + 2;
    // No zone while the state is unread: a click there must not arm anything.
    st.powerZone =
      running === undefined
        ? undefined
        : { x1: pX, y1: 2, x2: pX + displayWidth(stripAnsi(pLabel)) - 1, y2: 2 };
  }

  const bodyRows = rows - 3 - barHeight("deploy", cols, live.bar); // top bar + button row + command bar + bottom border
  if (run) {
    // Live log view: tail-follow; st.scroll counts lines BACK from the tail.
    const all = run.partial ? [...run.lines, run.partial] : run.lines;
    const maxOff = Math.max(0, all.length - bodyRows);
    const off = Math.min(st.scroll, maxOff);
    const start = Math.max(0, all.length - bodyRows - off);
    for (let r = 0; r < bodyRows; r++) {
      const line = all[start + r];
      frame.boxRow(2 + r, [
        { text: ` ${line === undefined ? "" : truncate(line, cols - 4)}`, width: cols - 2 },
      ]);
    }
  } else {
    const lines = deployLines(st, cols - 4);
    for (let r = 0; r < bodyRows; r++) {
      frame.boxRow(2 + r, [{ text: ` ${lines[st.scroll + r] ?? ""}`, width: cols - 2 }]);
    }
  }
  paintCmdBar(frame, "deploy", cols, rows, live.bar);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

// ---- hooks ------------------------------------------------------------------

export function installDeployHooks(
  app: App,
  fetcher?: DeployFetcher,
  now: () => number = () => Date.now(),
  drainSender?: DeployDrainSender,
  ceremonyStore?: DeployCeremonyStore,
): DeployState {
  const f = fetcher ?? new RealDeployFetcher(app.cfg, app.ssh, realLocalRunner(process.cwd()));
  const drain = drainSender ?? new CommandDrainSender(app.cfg, app.ssh);
  const ceremony = ceremonyStore ?? new MemoryDeployCeremonyStore();
  const st: DeployState = { loaded: false, loading: false, dirty: undefined, plan: [], scroll: 0 };

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

  const screen = (theApp: App, cols: number, rows: number): Frame => {
    if (!st.loaded && !st.loading) void load();
    return renderDeployTab(st, theApp.view.dryRun, cols, rows);
  };

  // The kill handle exists only while deploy.sh / docker is running. A drain
  // wait is cancellable too, but cancellation is a validated `drain off`
  // command rather than a process signal.
  let handle: { kill(): void } | undefined;
  let targetCheckInFlight = false;
  let drainAttempt = 0;
  let abortDrainRequested = false;

  const line = (run: DeployRun, text: string): void => {
    if (run.lines[run.lines.length - 1] !== text) run.lines.push(text);
  };
  const persist = (phase: DurableDeployPhase): void =>
    ceremony.write({
      version: 1,
      phase,
      ...(st.targetHead ? { target_head: st.targetHead } : {}),
      ...(st.preDeploySnapshotAt ? { pre_deploy_snapshot_at: st.preDeploySnapshotAt } : {}),
      ...(st.drainObserved ? { drain_observed: true } : {}),
      ...(st.firstUndrainedSnapshotAt
        ? { first_undrained_snapshot_at: st.firstUndrainedSnapshotAt }
        : {}),
      ...(st.deployRunId ? { deploy_run_id: st.deployRunId } : {}),
      updated_at: new Date(now()).toISOString(),
    });
  const failDrain = (theApp: App, run: DeployRun, reason: string): void => {
    if (st.run !== run) return;
    st.deployPhase = "drain-failed";
    persist("drain-failed");
    run.running = false;
    run.code = 1;
    line(run, `✖ drain failed — ${reason}`);
    line(run, "deploy did not start");
    theApp.notice(`✖ deploy drain failed — ${reason}`);
    theApp.repaint();
  };

  const attachDeployProcess = (theApp: App, run: DeployRun): void => {
    const runner = theApp.hooks.deployRun;
    if (!runner || !st.deployRunId) {
      failDrain(theApp, run, !runner ? "deploy runner not wired" : "durable deploy run id missing");
      return;
    }
    handle = runner(
      theApp,
      st.deployRunId,
      (chunk) => {
        if (st.run !== run) return;
        appendRunChunk(run, chunk);
        theApp.repaint();
      },
      (code) => {
        if (st.run !== run) return;
        if (run.partial) {
          run.lines.push(stripAnsi(run.partial));
          run.partial = "";
        }
        run.running = false;
        run.code = code;
        handle = undefined;
        if (code === 0) {
          st.deployPhase = "awaiting-lift";
          persist("awaiting-lift");
          line(
            run,
            "✓ sync finished — healthy boot will auto-lift the drain after its first reconcile",
          );
          theApp.notice("deploy complete — waiting for healthy boot to auto-lift drain");
        } else {
          st.deployPhase = "deploy-failed";
          persist("deploy-failed");
          line(run, "✖ deploy failed — drain remains ON; investigate before lifting it");
          theApp.notice("✖ deploy failed — drain remains on");
        }
        st.loaded = false;
        void load();
        theApp.repaint();
      },
    );
    theApp.repaint();
  };

  const launchDeployProcess = (theApp: App, run: DeployRun): void => {
    if (st.run !== run || st.deployPhase !== "waiting-rounds") return;
    if (!st.loaded) {
      line(run, "… waiting for local deploy target to reload before sync");
      return;
    }
    if (!st.head) {
      st.deployPhase = "deploy-failed";
      run.running = false;
      run.code = 1;
      persist("deploy-failed");
      line(run, "✖ local deploy target is unknown — deploy did not start; drain remains ON");
      theApp.notice("✖ deploy target unknown — drain remains on");
      theApp.repaint();
      return;
    }
    if (st.targetHead && st.targetHead !== st.head) {
      st.deployPhase = "deploy-failed";
      run.running = false;
      run.code = 1;
      persist("deploy-failed");
      line(
        run,
        `✖ local HEAD moved from ${st.targetHead} to ${st.head} while draining — deploy did not start; drain remains ON`,
      );
      theApp.notice("✖ deploy target changed while draining — drain remains on");
      theApp.repaint();
      return;
    }
    st.preDeploySnapshotAt = theApp.view.snapshot?.written_at;
    st.deployRunId = `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 12)}`;
    st.deployPhase = "syncing";
    persist("syncing");
    line(run, "✓ drain confirmed and board quiet — starting ./scripts/deploy.sh sync");
    line(run, "  deploy process is durable across the required TUI hot reload");
    line(run, "  drain stays on until the new boot's first healthy reconcile");
    theApp.notice("deploy drain reached zero — starting durable sync");
    attachDeployProcess(theApp, run);
  };

  const startDeployProcess = (theApp: App, run: DeployRun): void => {
    if (st.run !== run || st.deployPhase !== "waiting-rounds" || targetCheckInFlight) return;
    targetCheckInFlight = true;
    line(run, "… board is quiet — refreshing local HEAD and deploy preflight");
    theApp.repaint();
    void f
      .load()
      .then((latest) => {
        targetCheckInFlight = false;
        if (st.run !== run || st.deployPhase !== "waiting-rounds") return;
        Object.assign(st, latest);
        st.loaded = true;
        launchDeployProcess(theApp, run);
      })
      .catch((err: unknown) => {
        targetCheckInFlight = false;
        failDrain(
          theApp,
          run,
          `could not refresh deploy target (${String(err instanceof Error ? err.message : err)})`,
        );
      });
  };

  const observeDrain = (theApp: App): void => {
    const run = st.run;
    const health = theApp.view.health;
    const snap = theApp.view.snapshot;
    if (!run || run.kind !== "deploy") {
      const saved = ceremony.read();
      if (
        saved &&
        snap &&
        health.kind !== "stale" &&
        health.kind !== "unreachable" &&
        snap.draining !== true
      ) {
        const liftGenerationOk =
          saved.phase !== "awaiting-lift" ||
          (saved.pre_deploy_snapshot_at !== undefined &&
            Date.parse(snap.written_at) > Date.parse(saved.pre_deploy_snapshot_at));
        if (liftGenerationOk) ceremony.clear();
      }
      return;
    }
    const postDeployGeneration =
      st.preDeploySnapshotAt !== undefined &&
      snap !== undefined &&
      Date.parse(snap.written_at) > Date.parse(st.preDeploySnapshotAt);
    if (
      st.deployPhase === "awaiting-lift" &&
      snap &&
      postDeployGeneration &&
      health.kind !== "stale" &&
      health.kind !== "unreachable" &&
      snap.draining !== true
    ) {
      st.deployPhase = "done";
      ceremony.clear();
      line(run, "✓ drain auto-lifted by the new boot's first healthy reconcile");
      theApp.notice("deploy complete — drain lifted; reconcile is recovering dropped deliveries");
      theApp.repaint();
      return;
    }
    if (st.deployPhase !== "waiting-rounds") return;
    if (!snap || health.kind === "stale" || health.kind === "unreachable") {
      const note = "waiting for a fresh daemon status before deploy";
      if (st.drainStatusNote !== note) line(run, `… ${note}`);
      st.drainStatusNote = note;
      theApp.repaint();
      return;
    }
    if (snap.draining !== true) {
      const repeatedUndrained =
        st.firstUndrainedSnapshotAt !== undefined &&
        Date.parse(snap.written_at) > Date.parse(st.firstUndrainedSnapshotAt);
      if (st.drainObserved || repeatedUndrained) {
        st.deployPhase = "aborted";
        run.running = false;
        run.code = null;
        ceremony.clear();
        line(
          run,
          "■ drain was lifted outside this ceremony — deploy cancelled; review work resumed",
        );
        theApp.notice("deploy cancelled — operator lifted the drain");
      } else {
        if (!st.firstUndrainedSnapshotAt) {
          st.firstUndrainedSnapshotAt = snap.written_at;
          persist("waiting-rounds");
        }
        const note = "daemon acknowledged drain; waiting for status.json to show it";
        if (st.drainStatusNote !== note) line(run, `… ${note}`);
        st.drainStatusNote = note;
      }
      theApp.repaint();
      return;
    }
    st.firstUndrainedSnapshotAt = undefined;
    if (!st.drainObserved) {
      st.drainObserved = true;
      persist("waiting-rounds");
    }
    st.drainStatusNote = undefined;
    if (st.drainRounds !== snap.running_rounds) {
      st.drainRounds = snap.running_rounds;
      line(
        run,
        `DRAINING — ${snap.running_rounds} round${snap.running_rounds === 1 ? "" : "s"} finishing · ${snap.drained_deliveries ?? 0} webhook delivery(ies) dropped`,
      );
      theApp.notice(
        `deploy drain — ${snap.running_rounds} round${snap.running_rounds === 1 ? "" : "s"} finishing`,
      );
    }
    if (snap.running_rounds === 0) startDeployProcess(theApp, run);
    else theApp.repaint();
  };

  const liftDrainAfterAbort = (theApp: App, run: DeployRun): void => {
    if (st.run !== run) return;
    st.deployPhase = "lifting-after-abort";
    persist("lifting-after-abort");
    line(run, "→ deploy aborted before sync — lifting drain so review work can resume…");
    theApp.notice("deploy aborted — lifting drain");
    const attempt = ++drainAttempt;
    void drain
      .set(false)
      .then((result) => {
        if (st.run !== run || attempt !== drainAttempt) return;
        run.running = false;
        run.code = null;
        if (result.ok && result.draining === false) {
          st.deployPhase = "aborted";
          ceremony.clear();
          line(
            run,
            `✓ drain lifted — ${result.dropped_deliveries ?? 0} dropped delivery(ies) will be recovered by reconcile`,
          );
          theApp.notice("deploy aborted — drain lifted; review work resumed");
        } else {
          st.deployPhase = "drain-failed";
          persist("drain-failed");
          line(
            run,
            `✖ could not lift drain — ${result.reason ?? "daemon did not confirm"}; drain may remain ON`,
          );
          theApp.notice("✖ deploy aborted but drain lift failed — check board");
        }
        theApp.repaint();
      })
      .catch((err: unknown) => {
        if (st.run !== run || attempt !== drainAttempt) return;
        run.running = false;
        run.code = 1;
        st.deployPhase = "drain-failed";
        persist("drain-failed");
        line(
          run,
          `✖ could not lift drain — ${String(err instanceof Error ? err.message : err)}; drain may remain ON`,
        );
        theApp.notice("✖ deploy aborted but drain lift failed — check board");
        theApp.repaint();
      });
    theApp.repaint();
  };

  const startDrain = (theApp: App, resuming = false, resumeAbort = false): void => {
    if (!resuming && (!st.loaded || !st.head)) {
      theApp.notice("deploy target is still loading — wait for LOCAL HEAD, then press D D again");
      return;
    }
    const run: DeployRun = {
      kind: "deploy",
      lines: ["→ engaging daemon deploy drain…"],
      partial: "",
      running: true,
    };
    st.run = run;
    st.scroll = 0;
    st.deployPhase = resumeAbort ? "lifting-after-abort" : "engaging-drain";
    if (!resuming) {
      st.targetHead = st.head;
      st.deployRunId = undefined;
    }
    st.preDeploySnapshotAt = undefined;
    st.drainObserved = false;
    st.firstUndrainedSnapshotAt = undefined;
    persist(resumeAbort ? "abort-requested" : "engaging-drain");
    st.drainRounds = undefined;
    st.drainStatusNote = undefined;
    abortDrainRequested = resumeAbort;
    const attempt = ++drainAttempt;
    theApp.notice("deploy requested — engaging drain; no new review work will start");
    theApp.repaint();
    void drain
      .set(true)
      .then((result) => {
        if (st.run !== run || attempt !== drainAttempt) return;
        if (!result.ok || result.draining !== true) {
          if (abortDrainRequested) liftDrainAfterAbort(theApp, run);
          else failDrain(theApp, run, result.reason ?? "daemon did not confirm drain");
          return;
        }
        if (abortDrainRequested) {
          liftDrainAfterAbort(theApp, run);
          return;
        }
        if (result.issuer === "session") {
          // the daemon found commands/operator/ unsealed and bounded
          // this drain like a session's — it can lapse mid-sync. A deploy never
          // rides a drain that may lift itself; the receipt says when it does.
          failDrain(
            theApp,
            run,
            `the daemon bounded the drain because the operator channel is NOT sealed (commands/operator/ in the container must be root-owned 0755) — ` +
              `it lapses ${result.expires_at ?? "at an unknown time"}; \`qcr drain off\` lifts it now. Fix the directory before deploying`,
          );
          return;
        }
        st.deployPhase = "waiting-rounds";
        persist("waiting-rounds");
        st.drainRounds = result.running_rounds;
        line(
          run,
          `✓ drain engaged — ${result.running_rounds ?? "?"} round(s) reported by command receipt`,
        );
        theApp.notice(
          `drain engaged — ${result.running_rounds ?? "?"} round(s) finishing before deploy`,
        );
        observeDrain(theApp);
        theApp.repaint();
      })
      .catch((err: unknown) => {
        if (abortDrainRequested) liftDrainAfterAbort(theApp, run);
        else failDrain(theApp, run, String(err instanceof Error ? err.message : err));
      });
  };

  const startPowerRun = (theApp: App, kind: "stop" | "start"): void => {
    const power = theApp.hooks.powerRun;
    if (!power) {
      theApp.notice(`✖ ${kind} runner not wired`);
      return;
    }
    st.deployPhase = undefined;
    const run: DeployRun = { kind, lines: [], partial: "", running: true };
    st.run = run;
    st.scroll = 0;
    handle = power(
      theApp,
      kind,
      (chunk) => {
        if (st.run !== run) return;
        appendRunChunk(run, chunk);
        theApp.repaint();
      },
      (code) => {
        if (run.partial) run.lines.push(stripAnsi(run.partial));
        run.partial = "";
        run.running = false;
        run.code = code;
        handle = undefined;
        st.loaded = false;
        void load();
        theApp.repaint();
      },
    );
    theApp.repaint();
  };

  const savedCeremony = ceremony.read();
  if (savedCeremony) {
    st.targetHead = savedCeremony.target_head;
    st.preDeploySnapshotAt = savedCeremony.pre_deploy_snapshot_at;
    st.drainObserved = savedCeremony.drain_observed === true;
    st.firstUndrainedSnapshotAt = savedCeremony.first_undrained_snapshot_at;
    st.deployRunId = savedCeremony.deploy_run_id;
    if (savedCeremony.phase === "engaging-drain" || savedCeremony.phase === "abort-requested") {
      // Drain-on is idempotent. Reissuing is the only safe recovery from a
      // reload that may have landed before or after the daemon receipt. An
      // abort first proves ON, then sends OFF, so write/result races cannot
      // leave the later ON command standing.
      startDrain(app, true, savedCeremony.phase === "abort-requested");
    } else {
      const phase = savedCeremony.phase;
      const running =
        phase === "waiting-rounds" || phase === "lifting-after-abort" || phase === "syncing";
      const run: DeployRun = {
        kind: "deploy",
        lines: [`↻ restored deploy ceremony after TUI reload (${phase})`],
        partial: "",
        running,
        ...(phase === "awaiting-lift"
          ? { code: 0 }
          : phase === "deploy-failed" || phase === "drain-failed"
            ? { code: 1 }
            : {}),
      };
      st.run = run;
      st.deployPhase = phase;
      if (phase === "syncing") {
        line(run, "↻ re-attaching to the same durable deploy process");
        app.notice("TUI reloaded during deploy — re-attaching to durable sync");
        attachDeployProcess(app, run);
      } else if (phase === "lifting-after-abort") {
        liftDrainAfterAbort(app, run);
      } else {
        app.notice(`restored deploy ceremony — ${phase}`);
      }
    }
  }

  if (savedCeremony) void load().then(() => observeDrain(app));
  chainOnPoll(app, observeDrain);

  // One press = arm; a second press of the SAME button inside the confirm
  // window starts the drain ceremony (deploy) or the power process.
  const press = (theApp: App, kind: RunKind): void => {
    if (st.run?.running) return;
    if (kind === "deploy" && st.run) {
      theApp.notice("close the previous deploy result with x before starting another");
      return;
    }
    if (kind === "deploy" && ceremony.read()) {
      theApp.notice(
        "previous deploy still owns the drain — resolve or lift it before another deploy",
      );
      return;
    }
    const t = now();
    if (st.armedKind === kind && st.armedAt !== undefined && t - st.armedAt < DEPLOY_CONFIRM_MS) {
      st.armedAt = undefined;
      st.armedKind = undefined;
      if (kind === "deploy") startDrain(theApp);
      else startPowerRun(theApp, kind);
    } else {
      st.run = undefined;
      st.deployPhase = undefined;
      st.armedAt = t;
      st.armedKind = kind;
    }
    theApp.repaint();
  };

  /**
   * The power button's action follows the container's OBSERVED state:
   * definitely up → stop, definitely stopped → start, and NOT YET READ →
   * nothing at all.
   *
   * That last case used to fold into "stop", rationalised as "a stop of a
   * stopped container is a no-op" — which is true of a stopped container and
   * false of the only case that matters. Unknown is not stopped: if the
   * reviewer is up and `docker ps` merely has not been read, that press stops
   * a live container on data nobody fetched. lengthened the unfetched
   * window by design (the tab's load now runs behind the first frame), so this
   * is reachable from the moment the TUI opens.
   */
  const powerKind = (): RunKind | undefined =>
    st.containerStatus === undefined
      ? undefined
      : /^Up /.test(st.containerStatus)
        ? "stop"
        : "start";

  /** The power button/key: refuse on an unread state, and go and read it. */
  const pressPower = (theApp: App): void => {
    const kind = powerKind();
    if (kind === undefined) {
      st.armedAt = undefined;
      st.armedKind = undefined;
      theApp.notice("VM app state has not been read — refreshing instead of guessing");
      void load();
      theApp.repaint();
      return;
    }
    press(theApp, kind);
  };

  const disarm = (theApp: App): void => {
    if (st.armedAt === undefined) return;
    st.armedAt = undefined;
    st.armedKind = undefined;
    theApp.repaint();
  };

  const click = (theApp: App, x: number, y: number): boolean => {
    const inside = (z?: { x1: number; y1: number; x2: number; y2: number }): boolean =>
      z !== undefined && x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2;
    if (inside(st.buttonZone)) press(theApp, "deploy");
    else if (inside(st.powerZone)) pressPower(theApp);
    else disarm(theApp); // a click anywhere else cancels
    return true;
  };

  const onKey = (theApp: App, key: BoardKey): boolean => {
    // `D`/`S` are this tab's only while offered (deployKeys): with a run on
    // screen the press would be refused, and a refused printable belongs to
    // the companion column instead.
    if (key.kind === "char" && key.ch === "D" && !st.run) {
      press(theApp, "deploy");
      return true;
    }
    if (key.kind === "char" && key.ch === "S" && !st.run && st.containerStatus !== undefined) {
      pressPower(theApp);
      return true;
    }
    const disarmed = st.armedAt !== undefined;
    if (disarmed) disarm(theApp); // any other key disarms
    if (st.run && key.kind === "char" && key.ch === "x") {
      if (st.run.running) {
        if (st.run.kind === "deploy" && st.deployPhase === "engaging-drain") {
          abortDrainRequested = true;
          st.deployPhase = "lifting-after-abort";
          persist("abort-requested");
          line(st.run, "→ abort requested — waiting for drain receipt before lifting it safely");
          theApp.notice("deploy abort requested — drain will be lifted after acknowledgement");
        } else if (st.run.kind === "deploy" && st.deployPhase === "waiting-rounds") {
          liftDrainAfterAbort(theApp, st.run);
        } else if (st.deployPhase !== "lifting-after-abort") {
          handle?.kill(); // sync/power abort — drain deliberately stays on after a failed sync
          theApp.notice(
            `${st.run.kind} aborted (SIGTERM)${st.run.kind === "deploy" ? " — drain remains on" : ""}`,
          );
        }
      } else if (st.deployPhase === "awaiting-lift") {
        theApp.notice("deploy finished but drain has not auto-lifted yet — result stays visible");
      } else {
        const acknowledgedFailure =
          st.deployPhase === "deploy-failed" || st.deployPhase === "drain-failed";
        if (acknowledgedFailure) {
          ceremony.clear();
          theApp.notice(
            "deploy failure acknowledged — drain state unchanged; D D may retry safely",
          );
        }
        st.run = undefined; // close the finished log, back to the plan view
        st.scroll = 0;
        st.deployPhase = undefined;
        if (!ceremony.read()) {
          st.targetHead = undefined;
          st.preDeploySnapshotAt = undefined;
          st.drainObserved = undefined;
          st.firstUndrainedSnapshotAt = undefined;
          st.deployRunId = undefined;
        }
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
        // A key that just disarmed is CONSUMED — it must not also fall
        // through and seed the companion column (or act on the board).
        return disarmed; // otherwise tabs/quit/help fall through to the app
    }
  };

  app.hooks.tabs.deploy = { screen, click, key: onKey, keys: () => deployKeys(st) };
  return st;
}
