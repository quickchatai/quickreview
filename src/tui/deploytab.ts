// `[5] deploy` — "what would a deploy ship?" plus the deploy button.
// Every deploy is a RELEASE: the tag, the two-arch build, the paid e2e and the
// owner's approval already happened in CI, so the tab only chooses a version.
// It shows the version and revision the VM runs (`qcr-update status --json`,
// read over ssh) against the chosen version, the commits between the two
// revisions (from the local checkout), and deploy.sh's own
// `--dry-run release <version>` plan verbatim. The version is one of the
// published ones (a read-only `gh api` packages listing, newest first) or typed
// with `V`. Click ▶ (or D D) owns the whole ceremony: engage the persistent
// daemon drain, visibly wait for a fresh zero-round snapshot, then stream
// `scripts/deploy.sh release <version>`. The new boot auto-lifts only after its
// first healthy reconcile; a failed release stays drained. On a legacy-layout
// VM the tab refuses and points at the cutover wizard (scripts/cutover.sh):
// the first release is the cutover, with its own window and acknowledgement.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_IMAGE_REPO } from "../onboard/steps/compose.js";
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
import { dockerShArgv, transportOf, type RemoteResult, type SshRunner } from "./remote.js";
import { CommandDrainSender, type DeployDrainSender } from "./deploy-drain.js";
import { isFreshHealth } from "./poll.js";
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
import { remoteSandboxRoot, resolveLayout } from "./layout.js";

/** What the VM's updater reports: `sudo qcr-update status --json`, over ssh
 * (deploy.sh reads the same). Read-only. */
export const UPDATE_STATUS_ARGV = ["sudo", "qcr-update", "status", "--json"];

export type VmLayout = "release" | "legacy" | "none";

/** The updater's report, reduced to what the tab shows. */
export interface UpdateStatus {
  layout: VmLayout;
  /** The CI build stamp of the running daemon image (`qcr.build-sha`). */
  revision?: string;
  /** The version of the last successful `qcr-update` run. */
  version?: string;
  /** When that run finished. */
  at?: string;
}

const REVISION_RE = /^[0-9a-f]{7,40}$/;

/** `qcr-update status --json` -> UpdateStatus; undefined when it is not that
 * report (the read succeeded and the content is the problem). */
export function parseUpdateStatus(stdout: string): UpdateStatus | undefined {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const layout = o.layout;
  if (layout !== "release" && layout !== "legacy" && layout !== "none") return undefined;
  const out: UpdateStatus = { layout };
  const daemon = o.daemon;
  if (typeof daemon === "object" && daemon !== null) {
    const sha = (daemon as Record<string, unknown>).build_sha;
    if (typeof sha === "string" && REVISION_RE.test(sha)) out.revision = sha;
  }
  const last = o.last_run;
  if (typeof last === "object" && last !== null) {
    const l = last as Record<string, unknown>;
    if (l.result === "ok" && typeof l.version === "string" && VERSION_RE.test(l.version)) {
      out.version = l.version;
      if (typeof l.at === "string") out.at = l.at;
    }
  }
  return out;
}

/** The release version spelling deploy.sh accepts: X.Y.Z, optionally
 * -prerelease. It names an image tag; "latest" is not one. */
export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

/** The package the releases are published as: the daemon image's ghcr
 * repository (`ghcr.io/<org>/<name>`), the one the compose route pulls. */
export function releasePackage(repo: string = RELEASE_IMAGE_REPO): { org: string; name: string } {
  const [org, name] = repo.replace(/^ghcr\.io\//, "").split("/");
  return { org: org ?? "", name: name ?? "" };
}

/** The published versions: the package's tags, one per line, through the
 * operator's own `gh` (a read; nothing is mutated). */
export const PUBLISHED_VERSIONS_ARGV = [
  "gh",
  "api",
  "--paginate",
  `orgs/${releasePackage().org}/packages/container/${releasePackage().name}/versions`,
  "--jq",
  ".[].metadata.container.tags[]",
];

function versionParts(v: string): [number, number, number, string] {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/.exec(v)!;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
}

/** Newest first; a release outranks its own prereleases. */
export function compareVersionsDesc(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] as number) - (x[i] as number);
  if (x[3] === y[3]) return 0;
  if (x[3] === "") return -1;
  if (y[3] === "") return 1;
  // Semver precedence: dot-separated identifiers, numeric ones numerically
  // and below alphanumeric ones, a shorter run below a longer one it prefixes.
  const xs = x[3].split(".");
  const ys = y[3].split(".");
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const a = xs[i]!;
    const b = ys[i]!;
    if (a === b) continue;
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    if (an && bn) return Number(a) < Number(b) ? 1 : -1;
    if (an !== bn) return an ? 1 : -1;
    return a < b ? 1 : -1;
  }
  return xs.length < ys.length ? 1 : -1;
}

/** The tag list -> the published versions, newest first, deduplicated. Tags
 * that are not a version (`latest`, a digest tag) are not releases. */
export function parsePublishedVersions(stdout: string): string[] {
  const seen = new Set(
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => VERSION_RE.test(l)),
  );
  return [...seen].sort(compareVersionsDesc);
}

/** The git tag a release is cut from. */
export function releaseTag(version: string): string {
  return `v${version}`;
}

/** The config home the last sync shipped, fingerprinted inside the
 * container by the very script that fingerprints the local one — the
 * container's QCR_CONFIG names the shipped file. A VM without that script has
 * never been shipped a config home: that is a fact read (`none`), not an
 * unanswered read, so it is said as one. */
export function configFingerprintArgv(cfg: TuiConfig): string[] {
  const root = remoteSandboxRoot(cfg);
  const script = `${root}/scripts/config-fingerprint.sh`;
  return dockerShArgv(
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

/** The full power command, binary first — what hooks.powerRun spawns.
 * ssh mode wraps `powerCommand` as the remote shell line;
 * local mode runs the same words directly (the command is a fixed
 * space-joined `[sudo] docker <action> <container>`, so the split is exact). */
export function powerSpawnArgv(cfg: TuiConfig, action: "stop" | "start"): string[] {
  if (transportOf(cfg) === "local") return powerCommand(cfg, action).split(" ");
  return ["ssh", cfg.ssh_host, powerCommand(cfg, action)];
}

// ---- local (laptop-side) commands — all read-only ---------------------------

export const HEAD_ARGV = ["git", "rev-parse", "--short", "HEAD"];
export const DIRTY_ARGV = ["git", "status", "--porcelain"];
/** deploy.sh's own plan for a release, run locally. */
export function planArgv(version: string): string[] {
  return ["bash", "scripts/deploy.sh", "--dry-run", "release", version];
}
/** The chosen version's revision in the local checkout: its release tag. */
export function versionRevArgv(version: string): string[] {
  return ["git", "rev-parse", "--short", `${releaseTag(version)}^{commit}`];
}
/** The config home a sync would ship, located exactly as deploy.sh
 * locates it (scripts/install-locator.sh `qcr_shipped_config`). */
export const CONFIG_FINGERPRINT_ARGV = ["bash", "scripts/config-fingerprint.sh", "--located", "."];

export function logArgv(deployedSha: string, to: string): string[] {
  return ["git", "log", "--oneline", `${deployedSha}..${to}`];
}

export function diffStatArgv(deployedSha: string, to: string): string[] {
  return ["git", "diff", "--stat", `${deployedSha}..${to}`];
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

/** The build stamp `BUILD_SHA` holds: the release image's is one bare sha; a
 * legacy marker was `<short-sha> <iso-utc> <mode>`. `qcr metrics` reads it from
 * the app root, so the format keeps its one parser here. */
export function parseBuildSha(
  stdout: string,
): { sha: string; at?: string; mode?: string } | undefined {
  const [sha, at, mode] = stdout.trim().split(/\s+/);
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return undefined;
  return { sha, at, mode };
}

/** What the VM runs: the CI build stamp and, once a `qcr-update` run has
 * finished ok, the version and when. */
export interface DeployedMarker {
  sha: string;
  version?: string;
  at?: string;
}

export interface DeployState {
  loaded: boolean;
  loading: boolean;
  /** What the VM runs, from `qcr-update status --json`: the marker when the
   * report names a build stamp; `"absent"` when the VM runs no release image
   * (no daemon container, or the legacy one); `"unparseable"` when the report
   * was read but is not that report (the read succeeded — the content is the
   * problem); `undefined` until fetched, and after a fetch whose ssh read
   * never answered. Different facts, different sentences: an unanswered read
   * says nothing about what the VM runs, so it must never render or publish as
   * "no release" — and a corrupt report must never be blamed on ssh. */
  deployed?: DeployedMarker | "absent" | "unparseable";
  /** The VM's layout, from the same report; undefined = unread. A deploy needs
   * it read: legacy refuses (the cutover wizard owns that release). */
  layout?: VmLayout;
  /** The published versions, newest first; undefined = the listing was not
   * read (no gh, no access) — a typed version still works. */
  versions?: string[];
  /** The version a deploy would ship: typed with `V`, else the newest
   * published. Undefined until one exists. */
  version?: string;
  /** The chosen version's revision in the local checkout (its tag), or
   * undefined when the tag is not there. */
  versionRev?: string;
  /** The config home this machine would ship, and the one the VM
   * was shipped — each `undefined` until fetched and after a read that never
   * answered. Compared by `configDrift`. */
  configLocal?: ConfigRead;
  configDeployed?: ConfigRead;
  /** The setup re-tune log in this machine's state home — which
   * post-scan re-tune a pending profile change is. `undefined` until fetched. */
  retunes?: RetunesRead;
  /** Local HEAD; `undefined` when `git rev-parse` could not be read. */
  head?: string;
  /** Uncommitted paths, or `undefined` when `git status` could not be read.
   * Not an empty array in that case: an unread tree rendered as a green
   * "clean" says "nothing to ship" when it does not know. */
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
  targetVersion?: string;
  preDeploySnapshotAt?: string;
  drainObserved?: boolean;
  firstUndrainedSnapshotAt?: string;
  deployRunId?: string;
}

export type RunKind = "deploy" | "stop" | "start";

/**
 * The power action a container status offers: definitely up → stop,
 * definitely not up → start, and not yet read → none at all.
 *
 * Unknown is not stopped: if the reviewer is up and `docker ps` merely has
 * not been read, a "stop" would stop a live container on data nobody fetched.
 */
export function powerActionFor(containerStatus: string | undefined): "stop" | "start" | undefined {
  if (containerStatus === undefined) return undefined;
  return /^Up /.test(containerStatus) ? "stop" : "start";
}

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

/** Why a deploy cannot start now, or undefined. The version must be a release
 * version and the VM's layout must have been read as one a release can land on. */
export function deployRefusal(st: DeployState): string | undefined {
  if (st.layout !== "release" && st.layout !== "none") return layoutRefusal(st.layout);
  if (!st.version || !VERSION_RE.test(st.version))
    return "no deploy version chosen — press V and type one (X.Y.Z), or publish a release";
  return undefined;
}

/** Why a deploy cannot start on this VM layout. The legacy VM's first release
 * is the cutover — its own window, drain and acknowledgement — not a button. */
export function layoutRefusal(layout: VmLayout | undefined): string {
  if (layout === "legacy")
    return "this VM still runs the legacy layout — its first release is the cutover: run scripts/cutover.sh <version> (the cutover wizard), not the deploy tab";
  return "the VM's layout has not been read (qcr-update status) — r refreshes; a deploy is not started on a guess";
}

export interface DeployFetcher {
  /** `version` = the operator's choice (typed, or held from a load); absent =
   * default to the newest published. */
  load(version?: string): Promise<Omit<DeployState, "loaded" | "loading" | "scroll">>;
}

/** The re-tune log in this machine's state home (the companion writes it
 * through the mounted state home). A read that throws is unknown. */
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

  async load(version?: string): Promise<Omit<DeployState, "loaded" | "loading" | "scroll">> {
    // The remote paths below follow the container's root: settle it first.
    await resolveLayout(this.cfg, this.ssh);
    const [update, status, head, dirty, published, cfgRemote, cfgLocal] = await Promise.all([
      this.ssh(this.cfg.ssh_host, UPDATE_STATUS_ARGV),
      this.ssh(this.cfg.ssh_host, containerStatusArgv(this.cfg)),
      this.local(HEAD_ARGV),
      this.local(DIRTY_ARGV),
      this.local(PUBLISHED_VERSIONS_ARGV),
      this.ssh(this.cfg.ssh_host, configFingerprintArgv(this.cfg)),
      this.local(CONFIG_FINGERPRINT_ARGV),
    ]);
    // A failed exec is a VM we could not ask; ok/garbage is a report we read
    // but cannot use; the layout decides whether there is a release to show.
    const reported = update.ok ? parseUpdateStatus(update.stdout) : undefined;
    const deployed: DeployState["deployed"] = !update.ok
      ? undefined
      : reported === undefined
        ? "unparseable"
        : reported.layout === "release" && reported.revision !== undefined
          ? {
              sha: reported.revision,
              ...(reported.version ? { version: reported.version } : {}),
              ...(reported.at ? { at: reported.at } : {}),
            }
          : reported.layout === "release"
            ? "unparseable"
            : "absent";
    const versions = published.ok ? parsePublishedVersions(published.stdout) : undefined;
    const chosen = version ?? versions?.[0];
    const out: Omit<DeployState, "loaded" | "loading" | "scroll"> = {
      deployed,
      layout: reported?.layout,
      versions,
      version: chosen,
      containerStatus: status.ok ? status.stdout.trim() : undefined,
      configLocal: cfgLocal.ok ? parseConfigFingerprint(cfgLocal.stdout) : undefined,
      configDeployed: cfgRemote.ok ? parseConfigFingerprint(cfgRemote.stdout) : undefined,
      retunes: this.retuneLog(),
      head: head.ok ? head.stdout.trim() : undefined,
      dirty: dirty.ok ? dirty.stdout.split("\n").filter((l) => l.trim() !== "") : undefined,
      // Present even when unread: the tab merges each load over the last one,
      // so an omitted key would keep the previous load's range on screen.
      versionRev: undefined,
      commits: undefined,
      diffstat: undefined,
      plan: [],
    };
    if (chosen === undefined) {
      out.plan = ["no version chosen — press V and type one (X.Y.Z), or publish a release"];
      return out;
    }
    if (!VERSION_RE.test(chosen)) {
      out.plan = [`"${chosen}" is not a release version (X.Y.Z, optionally -prerelease)`];
      return out;
    }
    const [plan, rev] = await Promise.all([
      this.local(planArgv(chosen)),
      this.local(versionRevArgv(chosen)),
    ]);
    // A refusal exits non-zero with the reason on stderr — that IS the plan.
    out.plan = (plan.ok ? plan.stdout : `${plan.stdout}${plan.stderr}`).split("\n");
    if (rev.ok && rev.stdout.trim() !== "") out.versionRev = rev.stdout.trim();
    if (typeof deployed === "object" && out.versionRev !== undefined) {
      const [log, stat] = await Promise.all([
        this.local(logArgv(deployed.sha, out.versionRev)),
        this.local(diffStatArgv(deployed.sha, out.versionRev)),
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
    ? `${dep.version ? `${STRONG}${dep.version}${DRESET} ` : `${FG.dim}version unrecorded${RESET} `}${FG.dim}rev${RESET} ${STRONG}${dep.sha}${DRESET}${dep.at ? ` ${FG.dim}${dep.at}${RESET}` : ""}`
    : st.layout === "legacy"
      ? `${WARN}the legacy layout — no release image yet${DRESET}`
      : st.deployed === "absent"
        ? `${FG.dim}unknown — the VM runs no release image yet (the first release starts one)${RESET}`
        : st.deployed === "unparseable"
          ? `${WARN}unknown — qcr-update status was read but names no build stamp (r retries)${DRESET}`
          : `${WARN}unknown — qcr-update status could not be read (ssh failed, or provision never installed the updater); r retries${DRESET}`;
  lines.push(truncate(`${section("DEPLOYED", "what the VM runs")}  ${depText}`, width));
  const verText = st.version
    ? `${STRONG}${st.version}${DRESET}${st.versionRev ? ` ${FG.dim}rev${RESET} ${STRONG}${st.versionRev}${DRESET}` : ` ${WARN}tag ${releaseTag(st.version)} is not in this checkout (git fetch --tags)${DRESET}`}${st.versions === undefined ? ` ${FG.dim}(published list not read — gh api failed)${RESET}` : st.versions.includes(st.version) ? ` ${FG.dim}(published)${RESET}` : ` ${WARN}(not among the ${st.versions.length} published)${DRESET}`}`
    : `${WARN}none chosen — press ${STRONG}V${DRESET}${WARN} and type a version${DRESET}`;
  lines.push(truncate(`${section("VERSION", "what a deploy would ship")}  ${verText}`, width));
  if (
    st.layout === "legacy" ||
    (st.loaded && st.layout === undefined && st.deployed === undefined)
  ) {
    lines.push(truncate(`${BAD}${layoutRefusal(st.layout)}${DRESET}`, width));
  }
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
  // The config home ships beside the commit, so it has its own line.
  const drift = configDrift(st.configLocal, st.configDeployed);
  const driftInk =
    drift.kind === "same" ? OK : drift.kind === "changed" || drift.kind === "no-home" ? BAD : WARN;
  lines.push(
    truncate(
      `${section("CONFIG", "config home vs the VM")}  ${driftInk}${configDriftText(drift)}${DRESET}`,
      width,
    ),
  );
  // Which post-scan re-tune that profile change is, and why.
  const retunes = pendingRetunes(st.retunes, drift, dep?.at);
  const retuneInk = retunes.state === "pending" ? BAD : WARN;
  for (const [i, l] of pendingRetuneLines(retunes).entries()) {
    lines.push(
      truncate(i === 0 ? `  ${retuneInk}${l}${DRESET}` : `  ${FG.dim}${l}${RESET}`, width),
    );
  }
  lines.push("");

  // "Up to date, nothing to deploy" is a claim, so it needs every fact — a
  // config home that could not be compared is not the same as one that matches.
  if (dep && st.version && dep.version === st.version) {
    lines.push(
      drift.kind === "same"
        ? `${OK}✓ the VM already runs ${st.version} and this config home — nothing to deploy${DRESET}`
        : drift.kind === "changed" || drift.kind === "never-shipped"
          ? `${WARN}the VM runs ${st.version}, but its config home is behind — a release ships it${DRESET}`
          : `${WARN}the VM runs ${st.version}; whether its config home matches is not known${DRESET}`,
    );
  } else if (dep && st.version) {
    if (st.commits === undefined) {
      lines.push(
        truncate(
          `${BAD}${st.versionRev ? `deployed revision ${dep.sha} is unknown to local git` : `${releaseTag(st.version)} is unknown to local git`} — cannot list the commits${DRESET}`,
          width,
        ),
      );
    } else {
      lines.push(
        truncate(
          section(
            `PENDING (${st.commits.length})`,
            `commits ${dep.sha}..${st.versionRev ?? st.version}`,
          ),
          width,
        ),
      );
      for (const c of st.commits) lines.push(truncate(`  ${c}`, width));
      if (st.commits.length === 0) lines.push(`  ${MUTED}none yet — nothing to ship${DRESET}`);
      if (st.diffstat && st.diffstat.length > 0) {
        lines.push(
          truncate(section("DIFFSTAT", `${dep.sha}..${st.versionRev ?? st.version}`), width),
        );
        for (const d of st.diffstat) lines.push(truncate(`  ${d}`, width));
      }
    }
  }
  lines.push("");
  lines.push(
    truncate(
      section("PLAN", `scripts/deploy.sh --dry-run release ${st.version ?? "<version>"}, verbatim`),
      width,
    ),
  );
  for (const p of st.plan) lines.push(truncate(`  ${p}`, width));
  lines.push("");
  if (st.armedAt !== undefined) {
    const armed =
      st.armedKind === "stop" || st.armedKind === "start"
        ? `press ${STRONG}S${DRESET} again to ${st.armedKind} the VM app`
        : `press ${STRONG}D${DRESET} again to drain → wait for zero → deploy`;
    lines.push(truncate(`${badge("warn", "ARMED")} ${armed} (any other key cancels)`, width));
  } else {
    lines.push(
      truncate(
        `${STRONG}to deploy:${DRESET} press ${STRONG}D${DRESET} twice (${ACCENT}drain → zero rounds → ./scripts/deploy.sh release ${st.version ?? "<version>"} → healthy-boot auto-lift${DRESET})`,
        width,
      ),
    );
  }
  return lines;
}

/**
 * What the deploy tab answers to on this frame. `D` and `S` only while no run
 * is on screen (a press during one is refused, and a refused key is a dead
 * key); `S` only once the container's state has been read — the unknown
 * state registers no key exactly as it paints no click zone (a stop derived
 * from unread data could stop a live reviewer); `x` while there
 * is a run to abort or a finished log to close.
 */
export function deployKeys(st: DeployState): LiveKeys {
  const bar: BarButton[] = [];
  if (st.run) {
    // Awaiting the drain's auto-lift keeps the finished log (x only says so).
    const finished = st.deployPhase === "awaiting-lift" ? "x awaiting drain lift" : "x close log";
    bar.push({ key: "x", label: st.run.running ? "x abort" : finished });
    return { bar, inline: [] };
  }
  bar.push({ key: "D", label: st.armedKind === "deploy" ? "D confirm deploy" : "D deploy" });
  bar.push({ key: "V", label: st.version ? `V version ${st.version}` : "V set version" });
  const kind = powerActionFor(st.containerStatus);
  if (kind !== undefined) {
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
    const suffix = run.running
      ? "  streaming — j/k scroll · x abort"
      : st.deployPhase === "awaiting-lift"
        ? "  log stays until the drain auto-lifts · r refresh"
        : "  x close log · r refresh";
    frame.boxRow(1, [{ text: ` ${chip}${FG.dim}${suffix}${RESET}`, width: cols - 2 }]);
    st.buttonZone = undefined;
    st.powerZone = undefined;
  } else {
    const action = powerActionFor(st.containerStatus);
    const running = action === undefined ? undefined : action === "stop";
    const deployArmed = st.armedKind === "deploy";
    const powerKind: RunKind = action ?? "stop";
    const powerArmed = st.armedKind === powerKind;
    const dLabel = deployArmed ? " ⚠ CLICK AGAIN TO DEPLOY NOW " : " ▶ DEPLOY TO VM ";
    // An unfetched (or failed) container status must not paint
    // "■ STOP VM APP", which asserts the container is up. Say what is true —
    // the state is unknown — and let `r` fetch it.
    // Unknown is checked first, before armed. It cannot currently be both (an
    // unknown state registers no zone and `pressPower` refuses, so nothing can
    // arm it) — but reading the armed branch first invites the next editor to
    // conclude the unknown case is merely a label.
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
    const all = run.partial
      ? [...run.lines, stripAnsi(run.partial).split("\r").pop() ?? ""]
      : run.lines;
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
    const from = Math.max(0, Math.min(st.scroll, lines.length - bodyRows));
    for (let r = 0; r < bodyRows; r++) {
      frame.boxRow(2 + r, [{ text: ` ${lines[from + r] ?? ""}`, width: cols - 2 }]);
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
      // A version chosen while a load was pending makes that load stale: it
      // is discarded and the choice loaded instead.
      for (;;) {
        const requested = st.version;
        const result = await f.load(requested);
        if (st.version !== requested) continue;
        Object.assign(st, result);
        st.loaded = true;
        break;
      }
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

  /** A run's process ended: flush its trailing fragment and record the exit. */
  const finishRun = (run: DeployRun, code: number | null): void => {
    if (run.partial) {
      run.lines.push(stripAnsi(run.partial));
      run.partial = "";
    }
    run.running = false;
    run.code = code;
    handle = undefined;
  };
  const line = (run: DeployRun, text: string): void => {
    if (run.lines[run.lines.length - 1] !== text) run.lines.push(text);
  };
  const persist = (phase: DurableDeployPhase): void =>
    ceremony.write({
      version: 1,
      phase,
      ...(st.targetVersion ? { target_version: st.targetVersion } : {}),
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
      st.targetVersion ?? st.version ?? "",
      (chunk) => {
        if (st.run !== run) return;
        appendRunChunk(run, chunk);
        theApp.repaint();
      },
      (code) => {
        if (st.run !== run) return;
        finishRun(run, code);
        if (code === 0) {
          st.deployPhase = "awaiting-lift";
          persist("awaiting-lift");
          line(
            run,
            "✓ release finished — healthy boot will auto-lift the drain after its first reconcile",
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

  /** The latest daemon status is fresh and shows the drain on with no round running. */
  const drainQuiet = (theApp: App): boolean => {
    const snap = theApp.view.snapshot;
    const health = theApp.view.health;
    return (
      snap !== undefined &&
      isFreshHealth(health) &&
      snap.draining === true &&
      snap.running_rounds === 0
    );
  };

  const launchDeployProcess = (theApp: App, run: DeployRun): void => {
    if (st.run !== run || st.deployPhase !== "waiting-rounds") return;
    if (!st.loaded) {
      line(run, "… waiting for local deploy target to reload before the release");
      return;
    }
    // The preflight refresh is asynchronous: the status that started it may
    // have gone stale, or the board busy again, while it ran. A release starts
    // only on a status that proves the drain quiet now; otherwise the next
    // fresh zero-round poll starts the preflight again.
    if (!drainQuiet(theApp)) {
      const note = "waiting for a fresh zero-round daemon status before the release";
      if (st.drainStatusNote !== note) line(run, `… ${note}`);
      st.drainStatusNote = note;
      theApp.repaint();
      return;
    }
    if (!st.version || !VERSION_RE.test(st.version)) {
      st.deployPhase = "deploy-failed";
      run.running = false;
      run.code = 1;
      persist("deploy-failed");
      line(run, "✖ deploy version is unknown — deploy did not start; drain remains ON");
      theApp.notice("✖ deploy version unknown — drain remains on");
      theApp.repaint();
      return;
    }
    if (st.targetVersion && st.targetVersion !== st.version) {
      st.deployPhase = "deploy-failed";
      run.running = false;
      run.code = 1;
      persist("deploy-failed");
      line(
        run,
        `✖ the chosen version changed from ${st.targetVersion} to ${st.version} while draining — deploy did not start; drain remains ON`,
      );
      theApp.notice("✖ deploy target changed while draining — drain remains on");
      theApp.repaint();
      return;
    }
    if (st.layout !== "release" && st.layout !== "none") {
      st.deployPhase = "deploy-failed";
      run.running = false;
      run.code = 1;
      persist("deploy-failed");
      line(run, `✖ ${layoutRefusal(st.layout)} — deploy did not start; drain remains ON`);
      theApp.notice("✖ deploy refused — drain remains on");
      theApp.repaint();
      return;
    }
    st.preDeploySnapshotAt = theApp.view.snapshot?.written_at;
    st.deployRunId = `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 12)}`;
    st.deployPhase = "syncing";
    persist("syncing");
    line(
      run,
      `✓ drain confirmed and board quiet — starting ./scripts/deploy.sh release ${st.version}`,
    );
    line(run, "  deploy process is durable across the required TUI hot reload");
    line(run, "  drain stays on until the new boot's first healthy reconcile");
    theApp.notice(`deploy drain reached zero — starting durable release ${st.version}`);
    attachDeployProcess(theApp, run);
  };

  const startDeployProcess = (theApp: App, run: DeployRun): void => {
    if (st.run !== run || st.deployPhase !== "waiting-rounds" || targetCheckInFlight) return;
    targetCheckInFlight = true;
    line(run, "… board is quiet — refreshing local HEAD and deploy preflight");
    theApp.repaint();
    void f
      .load(st.targetVersion ?? st.version)
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
        isFreshHealth(health) &&
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
      isFreshHealth(health) &&
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
    if (!snap || !isFreshHealth(health)) {
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
    if (!resuming) {
      const refusal = deployRefusal(st);
      if (refusal !== undefined) {
        theApp.notice(`✖ ${refusal}`);
        return;
      }
    }
    if (!resuming && !st.loaded) {
      theApp.notice("deploy target is still loading — wait, then press D D again");
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
      st.targetVersion = st.version;
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
          // The daemon found commands/operator/ unsealed and bounded
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
        finishRun(run, code);
        st.loaded = false;
        void load();
        theApp.repaint();
      },
    );
    theApp.repaint();
  };

  const savedCeremony = ceremony.read();
  if (savedCeremony) {
    st.targetVersion = savedCeremony.target_version;
    st.version = savedCeremony.target_version;
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

  // One press = arm; a second press of the same button inside the confirm
  // window starts the drain ceremony (deploy) or the power process.
  const press = (theApp: App, kind: RunKind): void => {
    if (st.run?.running) return;
    if (kind === "deploy" && st.run) {
      theApp.notice("close the previous deploy result with x before starting another");
      return;
    }
    if (kind === "deploy") {
      const refusal = st.loaded
        ? deployRefusal(st)
        : "the deploy target is still loading — wait, then press D again";
      if (refusal !== undefined) {
        theApp.notice(`✖ ${refusal}`);
        return;
      }
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

  /** The power button/key follows the container's observed state
   * (`powerActionFor`): refuse on an unread state, and go and read it. The
   * tab's load runs behind the first frame, so the unread window is open from
   * the moment the TUI opens. */
  const pressPower = (theApp: App): void => {
    const kind = powerActionFor(st.containerStatus);
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
    if (key.kind === "char" && key.ch === "V" && !st.run) {
      disarm(theApp);
      const published =
        st.versions === undefined
          ? "published list not read"
          : `published: ${st.versions.slice(0, 5).join(" ") || "none"}`;
      theApp.promptInput(`deploy version (X.Y.Z) — ${published}`, st.version ?? "", (text) => {
        const typed = text.trim().replace(/^v(?=\d)/, "");
        if (!VERSION_RE.test(typed)) {
          theApp.notice(`✖ "${typed}" is not a release version (X.Y.Z, optionally -prerelease)`);
          return;
        }
        st.version = typed;
        st.loaded = false;
        void load();
        theApp.repaint();
      });
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
          st.targetVersion = undefined;
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
        // A finished deploy whose ceremony still owns the drain (a failure
        // awaiting x, a sync awaiting its auto-lift) stays on screen: x is
        // the only way to acknowledge it, and it needs the run.
        if (!(st.run?.kind === "deploy" && ceremony.read())) {
          st.run = undefined;
          st.deployPhase = undefined;
          st.scroll = 0;
        }
        void load();
        theApp.repaint();
        return true;
      default:
        // A key that just disarmed is consumed — it must not also fall
        // through and seed the companion column (or act on the board).
        return disarmed; // otherwise tabs/quit/help fall through to the app
    }
  };

  app.hooks.tabs.deploy = { screen, click, key: onKey, keys: () => deployKeys(st) };
  return st;
}
