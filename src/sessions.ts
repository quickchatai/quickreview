// The daemon↔pi boundary (spec §4, brief B3 steps 2/6): birth, wake, adopt,
// archive and kill of the per-PR pi sessions and the overseer session.
//
// Shape of a session: a detached tmux session named `pr-<n>` (or `overseer`)
// running the pinned interactive pi TUI with cwd = the sandbox root, the
// substituted system prompt passed by path, and the two sandbox extensions
// loaded. The daemon never types into that TUI: it wakes the session by
// dropping a Markdown file into inject/<session>/, which the inject-bridge
// extension picks up (findings §3 option 2 — tmux send-keys is the fallback of
// last resort and is not used here).
//
// pi is not installed in this repo; every assumption about its CLI surface is
// tagged VERIFY-ON-PIN and confined to buildPiCommand().
import { stripModelDocs } from "./promptdoc.js";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import {
  DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S,
  DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
  DEFAULT_SESSION_COMMAND_START_LEASE_S,
  githubCloneDir,
  openVikingBaseUrl,
} from "./config.js";
import {
  OV_DEFAULT_BASE_URL,
  OV_REVIEWER_KEY_SECRET,
  OV_REVIEWER_USER,
  openVikingSessionEnv,
  ovSessionIdForPr,
  ovcliConfPathIn,
  writeOvcliConf,
  type OvSessionLifecycle,
  type OvcliWriteResult,
} from "./memory/ovsession.js";
import {
  readSessionBridgeState,
  waitForSessionBridgeReady,
  writeSessionBridgeState,
} from "./session-bridge.js";
import { Tmux } from "./tmux.js";
import type { ExecFn } from "./tmux.js";
import type { SessionCommandKind, SessionCommandRow, StateStore } from "./state.js";
import { roundPromptMarker, stampRoundPrompt } from "./types.js";
import type { RoundOrder, SessionCommandRetryResult, SessionHooks } from "./types.js";
import { identityVars } from "./include.js";
import { renderConversationSystemPrompt, renderOverseerSystemPrompt } from "./templates.js";
import { WorktreeManager } from "./worktrees.js";

export const OVERSEER_SESSION = "overseer";

/** Environment-variable prefixes that ride the `env K=V … pi …` argv (see
 * spawnSession). `QCR_` is the daemon's routing surface; `OPENVIKING_` is the
 * session's memory identity, which must be per-session and therefore cannot
 * come from the tmux server environment; `GIT_CONFIG_` is the config-scope pin
 * (see sessionGitConfigPins). SECRETS ARE NEVER PREFIXED — argv is
 * world-readable — so no prefix carries a credential. */
const ARGV_ENV_PREFIXES = ["QCR_", "OPENVIKING_", "GIT_CONFIG_"] as const;

/**
 * The config-scope pin: which files git may read configuration from, decided by
 * the DAEMON at spawn time rather than discovered by git at run time.
 *
 * Why this exists. `extensions/bash-guard.ts` vets COMMAND STRINGS, and four
 * adversarial rounds each found a way through it. The fourth is the
 * one that generalises: `HOME=/tmp/evil git diff --no-index A B` executes
 * arbitrary shell out of `$HOME/.gitconfig`, because git's *implicit search
 * path* was open while the *explicit* pointers (`GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_SYSTEM`) were blocked. Push it one step and the command becomes
 * innocent: a session writes the real `$HOME/.gitconfig` with its ordinary
 * write tool and then runs a plain `git diff` — no suspicious token anywhere
 * for a command-string guard to see. The guard is structurally blind to that
 * half, and no length of blocklist reaches it.
 *
 * So the search path is not searched. Setting `GIT_CONFIG_GLOBAL` makes both
 * `$HOME/.gitconfig` and `$XDG_CONFIG_HOME/git/config` inert — git consults the
 * named file INSTEAD, so `HOME` and `XDG_CONFIG_HOME` stop being config
 * vectors whether or not the guard knows their names. VERIFIED by execution,
 * not read off the docs:
 *
 *   HOME=<evil> git diff --no-index A B                        → ran <cmd>
 *   HOME=<evil> GIT_CONFIG_GLOBAL=<pin> git diff --no-index A B → did NOT run
 *   XDG_CONFIG_HOME=<evil> …                                    → same pair
 *
 * …and end-to-end through the real spawn shape (`tmux new-session -d -s <n> -c
 * <cwd> env K=V … <cmd>`), because CLAUDE.md's recorded gotcha is that tmux
 * panes inherit the tmux SERVER environment: a pin that rode the client env
 * would silently do nothing, which is the exact failure mode this defence is
 * about. Hence `GIT_CONFIG_` in ARGV_ENV_PREFIXES above.
 *
 * The target is the pi HOME's own `.gitconfig` — the SAME file git would have
 * found by searching — and NOT `/dev/null`, which the ticket's note suggested.
 * `/dev/null` would have been a live regression: the container's entrypoint
 * writes a `credential.helper` shell snippet into the global config
 * (deploy/ansible/templates/entrypoint.sh.j2), and `fetch` is deliberately on
 * the session's read-verb allowlist because refusing it would wedge a review.
 * Verified that the pinned file's own `credential.helper` is still read AND
 * still invoked (`git credential fill`), so nothing legitimate changes.
 *
 * What this does NOT do, stated plainly because two docstrings in this codebase
 * have already asserted a closedness they did not have:
 *
 *   - It does not cover the REPO scope. `<clone>/.git/config` is still read,
 *     and a session that writes `diff.external` there gets execution from a
 *     plain `git diff <base> <head>` — VERIFIED executing. That half is closed
 *     at the WRITE boundary instead (`checkWritePath` in bash-guard), because
 *     git has no "ignore the local config" switch to pin.
 *   - It does not stop a caller RE-POINTING these three variables on the
 *     command line: a later `GIT_CONFIG_GLOBAL=…` prefix wins over the spawn
 *     environment. The bash guard's COMMAND_INJECTING_ENV blocks that, and
 *     that block stays load-bearing. Env pins the floor; the guard stops it
 *     being lifted.
 */
export function sessionGitConfigPins(piHome: string): Record<string, string> {
  return {
    // The global scope, named rather than searched for.
    GIT_CONFIG_GLOBAL: join(piHome, ".gitconfig"),
    // The system scope, twice: the pointer AND the switch. Either alone is
    // enough today; both because they are independent in git and cost nothing.
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

export function prSessionName(pr: number): string {
  return `pr-${pr}`;
}

export function isSandboxSession(name: string): boolean {
  return name === OVERSEER_SESSION || /^pr-\d+$/.test(name);
}

export function prOfSession(name: string): number | undefined {
  const m = /^pr-(\d+)$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

export interface PiCommandSpec {
  piBin: string;
  model: string;
  sessionDir: string;
  systemPromptPath: string;
  extensionPaths: string[];
  sessionName: string;
  /** Path to a pi theme JSON; omitted = pi's built-in default. */
  themePath?: string;
}

/**
 * The pi argv for a session.
 *
 * VERIFY-ON-PIN, every flag:
 * - `--model <provider/id>` — documented (findings §8).
 * - `--session-dir <path>` — documented for RPC mode (findings §1); assumed to
 *   apply to the interactive TUI as well. Per-session dir (not the shared
 *   store) so archival can pick "the newest .jsonl" unambiguously — all PR
 *   sessions share one cwd, so the cwd-keyed global store would mix them.
 * - `--system-prompt <path>` — NOT documented. findings §7 document only the
 *   `.pi/SYSTEM.md` / `~/.pi/agent/SYSTEM.md` override files. If no such flag
 *   exists, fall back to writing the substituted prompt to
 *   `<pi home>/.pi/SYSTEM.md` per session home (the substituted text is
 *   already on disk at systemPromptPath either way).
 * - `--extension <path>` — NOT documented; findings §5 document discovery dirs
 *   and a settings.json "extensions" array. Fallback: emit the same paths into
 *   the session's settings.json.
 * - `--name <display name>` — documented (findings §1).
 * - `--theme <path>` — same flag the companion uses (VERIFY-ON-PIN); loads the
 *   fleet muted theme so no session ever flashes pi's bright-green tool panel.
 * There is deliberately no update/auto-update flag: the pi version is pinned by
 * config.pi.version and the container image.
 */
export function buildPiCommand(spec: PiCommandSpec): string[] {
  const argv = [
    spec.piBin,
    // --approve: pre-trust project-local .pi resources for this run (verified
    // against the pinned 0.84.1 --help). Without it a cwd carrying .pi/ (our
    // settings.json, shipped 2026-08-20) hits pi's interactive "Trust project
    // folder?" modal and the session stalls forever (pr-5334 incident). The
    // reviewer never blocks on interactive input — the owner, 2026-08-20.
    "--approve",
    "--model",
    spec.model,
    "--session-dir",
    spec.sessionDir,
    "--system-prompt",
    spec.systemPromptPath,
  ];
  if (spec.themePath) argv.push("--theme", spec.themePath);
  for (const ext of spec.extensionPaths) argv.push("--extension", ext);
  argv.push("--name", spec.sessionName);
  return argv;
}

export interface PiSessionManagerOptions {
  cfg: Config;
  /** Sandbox root (cwd of every session). */
  root: string;
  tmux?: Tmux;
  /** Used to build a Tmux when one is not supplied. */
  exec?: ExecFn;
  worktrees?: WorktreeManager;
  piBin?: string;
  /** HOME for the pi process — the container's pihome volume. */
  piHome?: string;
  /** The PR's raw-notes tier: an OpenViking SESSION created when the
   * PR's pi session is born and deleted when the PR closes. Absent ⇒ no raw
   * tier is managed at all (test wiring, or a daemon with memory off) — the
   * sessions still run, memory-less, which is the standing degradation rule. */
  ovSessions?: OvSessionLifecycle;
  now?: () => Date;
  /** Durable PR-session command ownership. Optional only for narrow unit
   * wiring; production binds the daemon's StateStore before sessions start. */
  commandStore?: StateStore;
  /** The live config.toml the daemon itself loaded — handed to every
   * session as QCR_CONFIG so its scripts read exactly the daemon's config
   * rather than re-locating one. Absent in unit wiring. */
  configPath?: string;
}

export interface AdoptionReport {
  /** Live sandbox sessions found at daemon start — adopted, never killed. */
  adopted: string[];
  prs: number[];
  overseer: boolean;
}

export class PiSessionManager implements SessionHooks {
  readonly cfg: Config;
  readonly root: string;
  readonly tmux: Tmux;
  readonly worktrees: WorktreeManager;
  private readonly piBin: string;
  private readonly piHome: string;
  private readonly ovSessions: OvSessionLifecycle | undefined;
  private readonly now: () => Date;
  private commandStore: StateStore | undefined;
  private readonly configPath: string | undefined;
  private readonly prSessionBirths = new Map<number, Promise<string>>();
  private injectSeq = 0;

  constructor(opts: PiSessionManagerOptions) {
    this.cfg = opts.cfg;
    this.root = opts.root;
    this.tmux = opts.tmux ?? new Tmux({ exec: opts.exec });
    this.worktrees =
      opts.worktrees ??
      new WorktreeManager({
        root: opts.root,
        repo: opts.cfg.github.repo,
        // [github] clone_dir when set, else the repo slug's basename
        // — "acme/widget-app" keeps deriving "widget-app".
        cloneDir: githubCloneDir(opts.cfg.github),
        run: opts.exec,
      });
    this.piBin = opts.piBin ?? "pi";
    this.piHome = opts.piHome ?? join(opts.root, "pihome");
    this.ovSessions = opts.ovSessions;
    this.now = opts.now ?? (() => new Date());
    this.commandStore = opts.commandStore;
    this.configPath = opts.configPath;
    if (this.commandStore) this.restorePendingSessionCommands();
  }

  // ---- paths -------------------------------------------------------------

  injectDir(session: string): string {
    return join(this.root, "inject", session);
  }

  promptPath(session: string): string {
    return join(this.root, "state", "session-prompts", `${session}.md`);
  }

  /** Where every session's `--session-dir` lives (one subdir per session). */
  sessionsRoot(): string {
    return join(this.root, this.cfg.pi.session_dir);
  }

  sessionDir(session: string): string {
    return join(this.sessionsRoot(), session);
  }

  ledgerPath(session: string): string {
    return join(this.root, "state", "ledgers", `${session}.md`);
  }

  archiveDir(session: string): string {
    return join(this.root, "archive", session);
  }

  sessionCommandPayloadPath(id: string): string {
    return join(this.root, "state", "session-commands", `${id}.md`);
  }

  extensionPaths(): string[] {
    return [
      join(this.root, "extensions", "inject-bridge.ts"),
      join(this.root, "extensions", "ledger-pin.ts"),
      join(this.root, "extensions", "muted-theme.ts"),
      // Publishes the parent + lens lifecycle as an ephemeral read-only
      // sidecar for the operator TUI. It observes pi events only; no session
      // scheduling or daemon state passes through it.
      join(this.root, "extensions", "round-progress.ts"),
      // first-party glue over pi's OWN subagent extension, imported
      // at runtime from the installed pinned package (nothing vendored,
      // nothing that can drift from the rule-7 pin). The built state/agents
      // passes reach it through the native "user" discovery scope — the VM
      // entrypoint symlinks ~/.pi/agent/agents to state/agents. Rides argv on
      // purpose: children load only the global settings extensions, so the
      // subagent tool never exists inside a leaf and a pass cannot fan out.
      join(this.root, "extensions", "subagents.ts"),
      // docs/duplicate-merge.md: the `cluster_findings` tool a round calls
      // before pass-validate (`[review] dedup_merge`). The bench session
      // loads the same file (src/bench/runner.ts), so both routes group
      // candidates with one code path. Pure: it reads and writes nothing.
      join(this.root, "extensions", "finding-clusters.ts"),
      // The vendored + patched OpenViking extension: the memory
      // tools a session reaches. LAST on purpose — it is the only extension
      // here we did not write, and pi registers handlers in load order, so
      // ours (ledger-pin above all) are in place before it arrives.
      //
      // It rides argv for the same reason the subagents glue does: a subagent
      // child loads no argv extensions, so a lens pass gets no memory surface
      // at all. Its own PATCH 2 is the second layer.
      //
      // Its four patches are load-bearing — read
      // extensions/vendor/openviking-pi/README.md before touching this line.
      // In particular PATCH 1 removed the extension's session_before_compact
      // handler so ledger-pin stays the sole owner of compaction.
      join(this.root, "extensions", "vendor", "openviking-pi", "index.ts"),
    ];
  }

  /** The fleet muted theme — every pi session gets it (no bright greens). */
  themePath(): string {
    return join(this.root, "extensions", "muted-theme.json");
  }

  // ---- OpenViking identity -------------------------------------

  /** `http://host:port` from `[openviking]`; a hand-rolled config without the
   * block falls back to the loopback default (the port is never published). */
  ovBaseUrl(): string {
    const ov = this.cfg.openviking;
    return ov ? openVikingBaseUrl(ov) : OV_DEFAULT_BASE_URL;
  }

  /** The reviewer credential file every session resolves its key from. */
  ovcliConfPath(): string {
    return ovcliConfPathIn(this.piHome);
  }

  /**
   * Write the reviewer USER key into the pi HOME, 0600, before a session is
   * born. The key is deliberately NOT an environment variable and NOT on the
   * argv — `ps` is readable by anything in the container — and it can never be
   * the server's root key: `writeOvcliConf` refuses that, leaving the session
   * unauthenticated (a loud 401) rather than omnipotent (silent).
   */
  provisionOvCredentials(): OvcliWriteResult {
    return writeOvcliConf(
      this.ovcliConfPath(),
      {
        url: this.ovBaseUrl(),
        apiKey: this.secret(OV_REVIEWER_KEY_SECRET) ?? "",
        user: OV_REVIEWER_USER,
      },
      {
        serverConfigPath: this.cfg.openviking?.config_file,
        log: (msg) => console.log(`[quickreviewd] sessions: ${msg}`),
      },
    );
  }

  /** Create the PR's raw-notes session. Total: a memory engine that is down
   * costs the PR its raw tier and nothing else. */
  private async ensureOvSession(pr: number): Promise<boolean> {
    if (!this.ovSessions) return false;
    try {
      return await this.ovSessions.create(ovSessionIdForPr(pr));
    } catch {
      return false;
    }
  }

  /** Delete the PR's raw-notes session and its archives — the raw tier ages
   * out by DELETE, never by `commit` (which exists to PROMOTE notes into
   * durable memory, i.e. the extraction we deliberately switched off). */
  private async deleteOvSession(pr: number): Promise<boolean> {
    if (!this.ovSessions) return false;
    try {
      return await this.ovSessions.remove(ovSessionIdForPr(pr));
    } catch {
      return false;
    }
  }

  // ---- environment -------------------------------------------------------

  /** Read a secret file from the app's secrets dir (never from process.env). */
  private secret(name: string): string | undefined {
    const p = join(this.cfg.github.secrets_dir, name);
    try {
      const v = readFileSync(p, "utf8").trim();
      return v.length > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The environment a session runs in — built from scratch, never spread from
   * process.env. Only the app credential path is reachable: the OpenAI key
   * comes out of the app secrets dir, and GitHub auth is minted per command by
   * scripts/mint-token.sh from the app PEM. No GH_TOKEN/GITHUB_TOKEN, no
   * personal credential, is ever placed here (B3 hard rule).
   */
  buildEnv(session: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: this.piHome,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      QCR_SANDBOX_ROOT: this.root,
      QCR_SESSION_NAME: session,
      QCR_INJECT_DIR: this.injectDir(session),
      QCR_LEDGER_FILE: this.ledgerPath(session),
      QCR_SECRETS_DIR: this.cfg.github.secrets_dir,
      QCR_PI_VERSION: this.cfg.pi.version,
      // the process-wide subagent fan-out cap the glue extension
      // enforces (config.toml [pi] subagent_max_concurrency; VM runs 6 — the
      // old pi-subagents config.json number — the glue's own default is the
      // companion's 4).
      QCR_SUBAGENT_MAX_CONCURRENCY: String(this.cfg.pi.subagent_max_concurrency),
      // `[review] wide_lens_fanout`: a batched lens launch runs as wide as
      // that cap instead of native pi's in-call four (bench/aacr/PERF.md §1).
      QCR_SUBAGENT_WIDE_FANOUT: this.cfg.review?.wide_lens_fanout === false ? "0" : "1",
      // the daemon's own resolved config, so the posting scripts read
      // the file the daemon read. Set by the DAEMON — the bash guard still
      // refuses a session's own `QCR_CONFIG=` prefix.
      ...(this.configPath ? { QCR_CONFIG: this.configPath } : {}),
      // The config-scope pin. Here as well as on the argv because
      // buildEnv is also the tmux CLIENT's environment; the argv copy is the
      // one that reaches the pane (ARGV_ENV_PREFIXES carries `GIT_CONFIG_`).
      ...sessionGitConfigPins(this.piHome),
      ...(this.commandStore && this.commandStore.path !== ":memory:"
        ? {
            QCR_STATE_DB: this.commandStore.path,
            QCR_SESSION_COMMAND_START_LEASE_MS: String(this.sessionCommandStartLeaseMs()),
            QCR_SESSION_COMMAND_RUNNING_LEASE_MS: String(this.sessionCommandRunningLeaseMs()),
          }
        : {}),
    };
    const openai = this.secret("openai_api_key");
    if (openai) env.OPENAI_API_KEY = openai;
    // OpenViking identity. Explicit, because every session shares one
    // working directory and the extension's path-derived peer id therefore
    // cannot tell two PRs apart. The PR's raw-notes session is attached by id;
    // the overseer owns no PR and so gets no session id (no raw tier, tools
    // only). None of these is a secret — the key rides ovcli.conf at 0600.
    const pr = prOfSession(session);
    Object.assign(
      env,
      openVikingSessionEnv({
        baseUrl: this.ovBaseUrl(),
        user: OV_REVIEWER_USER,
        peerId: session,
        cliConfigPath: this.ovcliConfPath(),
        serverConfigPath: this.cfg.openviking?.config_file,
        ...(pr === undefined ? {} : { ovSessionId: ovSessionIdForPr(pr) }),
      }),
    );
    return { ...env, ...extra };
  }

  // ---- birth / adoption --------------------------------------------------

  private writeAtomic(path: string, body: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${this.injectSeq++}`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  }

  /** Substituted system prompt on disk; pi gets it by path. */
  writeSystemPrompt(session: string, body: string): string {
    const path = this.promptPath(session);
    this.writeAtomic(path, body);
    return path;
  }

  /** Birth an arbitrary session (used by ensure* and by the smoke script).
   * A PR birth is not complete when tmux returns: the exact Pi generation must
   * prove that its inject bridge opened and swept the mailbox first. */
  async spawnSession(
    session: string,
    systemPromptBody: string,
    model: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<void> {
    const promptPath = this.writeSystemPrompt(session, systemPromptBody);
    // The reviewer credential lands before pi starts: the extension resolves it
    // at load time, and a session born without it is memory-less for its life.
    this.provisionOvCredentials();
    mkdirSync(this.injectDir(session), { recursive: true });
    mkdirSync(join(this.injectDir(session), ".done"), { recursive: true });
    mkdirSync(this.sessionDir(session), { recursive: true });
    const command = buildPiCommand({
      piBin: this.piBin,
      model,
      sessionDir: this.sessionDir(session),
      systemPromptPath: promptPath,
      extensionPaths: this.extensionPaths(),
      sessionName: session,
      themePath: this.themePath(),
    });
    const generation = randomUUID();
    const bridgeStateFile = this.bridgeStatePath(session, generation);
    const durablePrBridge =
      prOfSession(session) !== undefined &&
      Boolean(this.commandStore && this.commandStore.path !== ":memory:");
    const spawnEnv = {
      ...extraEnv,
      QCR_SESSION_BRIDGE_GENERATION: generation,
      QCR_SESSION_BRIDGE_STATE_FILE: bridgeStateFile,
      // Production PR sessions own the durable command ledger. Explicit 0 is
      // reserved for isolated smoke/replay harnesses with no daemon StateStore.
      QCR_SESSION_BRIDGE_LEDGER_REQUIRED: durablePrBridge ? "1" : "0",
    };
    writeSessionBridgeState(bridgeStateFile, {
      version: 1,
      session,
      generation,
      stage: "starting",
      updated_at: this.now().toISOString(),
    });
    // tmux panes inherit the tmux SERVER's environment, not the client's, so
    // per-session vars must ride the command line itself. Only the QCR_* routing
    // vars and the OPENVIKING_* identity are prefixed — HOME/PATH/OPENAI_API_KEY
    // stay whatever the container (or dev box) provides, which is where pi's
    // auth actually lives.
    //
    // Nothing prefixed here is a secret, and nothing may become one: argv is
    // world-readable inside the container (`ps`), which is why the OpenViking
    // KEY rides a 0600 ovcli.conf instead (see provisionOvCredentials).
    const qcrPrefix = Object.entries(this.buildEnv(session, spawnEnv))
      .filter(([k, v]) => ARGV_ENV_PREFIXES.some((p) => k.startsWith(p)) && v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    await this.tmux.newSession(session, ["env", ...qcrPrefix, ...command], {
      cwd: this.root,
      env: this.buildEnv(session, spawnEnv),
    });
    this.recordBirth(session, generation);
    if (prOfSession(session) === undefined) return;
    try {
      await waitForSessionBridgeReady(
        bridgeStateFile,
        session,
        generation,
        this.sessionBridgeReadyTimeoutMs(),
      );
    } catch (error) {
      const detail = String(error);
      this.commandStore?.logEvent("session_bridge_readiness_failed", prOfSession(session)!, {
        session,
        generation,
        detail,
      });
      if (await this.tmux.hasSession(session)) await this.tmux.killSession(session);
      throw error;
    }
  }

  private birthFile(session: string): string {
    return join(this.root, "state", "sessions", `${session}.json`);
  }

  bridgeStatePath(session: string, generation: string): string {
    return join(this.root, "state", "sessions", `${session}.bridge-${generation}.json`);
  }

  private recordBirth(session: string, bridgeGeneration: string): void {
    this.writeAtomic(
      this.birthFile(session),
      `${JSON.stringify({ session, born_at: this.now().toISOString(), bridge_generation: bridgeGeneration }, null, 2)}\n`,
    );
  }

  private currentBridgeReady(session: string): boolean {
    try {
      const birth = JSON.parse(readFileSync(this.birthFile(session), "utf8")) as {
        bridge_generation?: string;
      };
      if (!birth.bridge_generation) return false;
      const state = readSessionBridgeState(this.bridgeStatePath(session, birth.bridge_generation));
      return Boolean(
        birth.bridge_generation &&
        state?.session === session &&
        state.generation === birth.bridge_generation &&
        state.stage === "ready",
      );
    } catch {
      return false;
    }
  }

  bornAt(session: string): Date | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.birthFile(session), "utf8")) as { born_at?: string };
      return raw.born_at ? new Date(raw.born_at) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Birth on first trigger; concurrent callers for one PR share the complete
   * has→prepare→spawn flight. Unrelated PRs remain independent. */
  async ensurePrSession(pr: number, title: string, worktree: string): Promise<string> {
    const existing = this.prSessionBirths.get(pr);
    if (existing) return existing;
    const birth = this.birthPrSession(pr, title, worktree);
    this.prSessionBirths.set(pr, birth);
    try {
      return await birth;
    } finally {
      if (this.prSessionBirths.get(pr) === birth) this.prSessionBirths.delete(pr);
    }
  }

  private async birthPrSession(pr: number, title: string, worktree: string): Promise<string> {
    const session = prSessionName(pr);
    if (await this.tmux.hasSession(session)) {
      if (this.currentBridgeReady(session)) return session;
      this.commandStore?.logEvent("session_bridge_stale", pr, {
        session,
        reason: "tmux alive without matching ready generation",
      });
      await this.tmux.killSession(session);
      if (await this.tmux.hasSession(session)) {
        throw new Error(`session ${session} survived stale-bridge fence`);
      }
    }
    // The PR's raw-notes tier, created BEFORE pi starts so the extension has
    // something to attach to on the first turn. A store object, not a session
    // anyone schedules: the daemon still owns exactly two pi session kinds.
    await this.ensureOvSession(pr);
    const template = readFileSync(join(this.root, "prompts", "conversation-system.md"), "utf8");
    const body = renderConversationSystemPrompt(
      template,
      { pr, title, worktree },
      identityVars(this.cfg),
    );
    try {
      await this.spawnSession(session, body, this.cfg.models.conversation, {
        QCR_PR: String(pr),
        QCR_PR_META: `PR #${pr} — ${title} (worktree ${worktree})`,
        QCR_WORKTREE: worktree,
      });
    } catch (err) {
      // A creator outside this manager instance may win after our first check.
      // Adopt only when both tmux and the matching bridge-generation receipt
      // prove that winner is usable; process existence alone caused #5454.
      if ((await this.tmux.hasSession(session)) && this.currentBridgeReady(session)) return session;
      throw err;
    }
    return session;
  }

  /** Slack concierge appendix, or "" when Slack is off. */
  private slackAppendix(): string {
    // Typed access, not a cast: rename `slack` or `enabled` in Config and this
    // FAILS THE BUILD instead of silently dropping the appendix. (The `?.`
    // survives hand-rolled test configs that omit the block entirely.)
    if (!this.cfg.slack?.enabled) return "";
    const path = join(this.root, "prompts", "slack-overseer-appendix.md");
    if (!existsSync(path))
      throw new Error(`slack.enabled = true but the overseer Slack appendix is missing: ${path}`);
    return `\n\n${stripModelDocs(readFileSync(path, "utf8")).trimEnd()}\n`;
  }

  async ensureOverseerSession(): Promise<string> {
    if (await this.tmux.hasSession(OVERSEER_SESSION)) return OVERSEER_SESSION;
    const template = readFileSync(join(this.root, "prompts", "overseer-system.md"), "utf8");
    // The seeded overseer prompt is canonical and unmodifiable (CLAUDE.md rule
    // 6), so the Slack contract rides as a spawn-time appendix — same shape as
    // EXECUTION_POLICY_ADDENDUM in include.ts. Slack off = byte-identical prompt.
    const body =
      renderOverseerSystemPrompt(template, identityVars(this.cfg)) + this.slackAppendix();
    await this.spawnSession(OVERSEER_SESSION, body, this.cfg.models.overseer);
    return OVERSEER_SESSION;
  }

  /**
   * Daemon restart: find the sandbox's live tmux sessions and take them over.
   * Purely observational — nothing is killed or restarted here.
   */
  async adopt(): Promise<AdoptionReport> {
    const names = (await this.tmux.listSessions()).filter(isSandboxSession);
    const prs = names.map(prOfSession).filter((n): n is number => n !== undefined);
    return { adopted: names, prs, overseer: names.includes(OVERSEER_SESSION) };
  }

  // ---- injection ---------------------------------------------------------

  /** Late production binding: createDaemon owns the StateStore, while parts
   * construct the session manager first. Restore pending files immediately;
   * running rows are never resubmitted by a restart. */
  setCommandStore(store: StateStore): void {
    this.commandStore = store;
    this.restorePendingSessionCommands();
  }

  /** Recreate only provably-pending inject files from their immutable payload.
   * A running command belongs to its bridge owner until the bounded recovery
   * sweep decides otherwise; replaying it here would create two shepherds. */
  restorePendingSessionCommands(): { restored: string[]; failed: string[] } {
    const restored: string[] = [];
    const failed: string[] = [];
    const store = this.commandStore;
    if (!store) return { restored, failed };
    this.adoptLegacyPendingCommands();
    for (const command of store.activeSessionCommands()) {
      if (command.status !== "pending" || existsSync(command.inject_path)) continue;
      try {
        const payload = readFileSync(command.payload_path);
        const hash = createHash("sha256").update(payload).digest("hex");
        if (hash !== command.payload_sha256)
          throw new Error(`payload hash ${hash} != ${command.payload_sha256}`);
        this.writeAtomic(command.inject_path, payload);
        restored.push(command.id);
      } catch (err) {
        const failure = `restart reconstruction failed: ${String(err)}`;
        store.failPendingSessionCommand(command.id, failure);
        store.logAnomaly(
          "session_command_failed",
          command.pr,
          command.round_no,
          `${failure}; command ${command.id} remains failed and blocks successors until bounded recovery/operator action`,
        );
        failed.push(command.id);
      }
    }
    return { restored, failed };
  }

  /** Adopt at most the oldest legacy file per PR. Later files remain the
   * filesystem backlog and are adopted after the slot terminalizes; no legacy
   * file is ever declared accepted merely because it already exists. */
  private adoptLegacyPendingCommands(): void {
    const store = this.commandStore;
    if (!store) return;
    const injectRoot = join(this.root, "inject");
    let sessions;
    try {
      sessions = readdirSync(injectRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of sessions) {
      if (
        !entry.isDirectory() ||
        !/^pr-\d+$/.test(entry.name) ||
        store.blockingSessionCommand(entry.name)
      )
        continue;
      const dir = join(injectRoot, entry.name);
      let files: string[];
      try {
        files = readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .sort();
      } catch {
        continue;
      }
      for (const file of files) {
        const injectPath = join(dir, file);
        const existing = store.getSessionCommandByInjectPath(injectPath);
        if (existing?.status === "acked") {
          try {
            const done = join(dir, ".done");
            mkdirSync(done, { recursive: true });
            renameSync(injectPath, join(done, file));
          } catch {
            return;
          }
          continue;
        }
        if (existing) break;
        try {
          const payload = readFileSync(injectPath);
          const id = randomUUID();
          const payloadPath = this.sessionCommandPayloadPath(id);
          this.writeAtomic(payloadPath, payload);
          store.createSessionCommand({
            id,
            pr: prOfSession(entry.name)!,
            session: entry.name,
            kind: "legacy",
            round_no: null,
            payload_sha256: createHash("sha256").update(payload).digest("hex"),
            payload_path: payloadPath,
            inject_path: injectPath,
            next_check_at: this.commandDeadline(this.sessionCommandStartLeaseMs()),
          });
        } catch (err) {
          console.error(
            `[quickreviewd] sessions: FAILED_LOUD could not adopt ${injectPath}: ${String(err)}`,
          );
        }
        break;
      }
    }
  }

  private injectFileName(commandId?: string): string {
    const ts = this.now().toISOString().replace(/[:.]/g, "-");
    const prefix = `${ts}-${String(this.injectSeq++).padStart(4, "0")}`;
    return commandId ? `${prefix}--cmd-${commandId}.md` : `${prefix}.md`;
  }

  private commandDeadline(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }

  private sessionCommandStartLeaseMs(): number {
    return (
      (this.cfg.daemon.session_command_start_lease_s ?? DEFAULT_SESSION_COMMAND_START_LEASE_S) *
      1000
    );
  }

  private sessionBridgeReadyTimeoutMs(): number {
    return (
      (this.cfg.daemon?.session_bridge_ready_timeout_s ?? DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S) *
      1000
    );
  }

  private sessionCommandRunningLeaseMs(): number {
    return (
      (this.cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN) *
      60_000
    );
  }

  private queuePrCommand(
    pr: number,
    kind: SessionCommandKind,
    message: string,
    roundNo: number | null,
  ): SessionCommandRow | undefined {
    const store = this.commandStore;
    if (!store) {
      this.injectFile(prSessionName(pr), message);
      return undefined;
    }
    const session = prSessionName(pr);
    const blocking = store.blockingSessionCommand(session);
    if (blocking) throw new Error(`session command ${blocking.id} is ${blocking.status}`);
    // A round's command is born only while its round is still running. The
    // dispatch that created the round awaited the worktree and the session
    // before reaching here, and an operator `restart-session` may have
    // cancelled the round in that window; delivering it anyway would hand the
    // session a cancelled round that the supervisor then kills, and the
    // recovery that cancelled it would never see a successor. This check and
    // the insert below are one synchronous block, so nothing interleaves.
    if (kind === "round" && roundNo !== null) {
      const status = store.roundStatus(pr, roundNo);
      if (status !== undefined && status !== "running")
        throw new Error(`round ${roundNo} of #${pr} is ${status}; not delivering its prompt`);
    }
    const id = randomUUID();
    const payload = message.endsWith("\n") ? message : `${message}\n`;
    const payloadPath = this.sessionCommandPayloadPath(id);
    const injectPath = join(this.injectDir(session), this.injectFileName(id));
    this.writeAtomic(payloadPath, payload);
    const command = store.createSessionCommand({
      id,
      pr,
      session,
      kind,
      round_no: roundNo,
      payload_sha256: createHash("sha256").update(payload).digest("hex"),
      payload_path: payloadPath,
      inject_path: injectPath,
      next_check_at: this.commandDeadline(this.sessionCommandStartLeaseMs()),
    });
    try {
      this.writeAtomic(injectPath, payload);
    } catch (err) {
      store.failPendingSessionCommand(id, `inject write failed: ${String(err)}`);
      throw err;
    }
    return command;
  }

  /** Drop a wake file the inject-bridge extension will deliver. */
  injectFile(session: string, message: string): string {
    const dir = this.injectDir(session);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, this.injectFileName());
    this.writeAtomic(path, message.endsWith("\n") ? message : `${message}\n`);
    return path;
  }

  /**
   * SessionHooks: ensure worktree + session, then inject the round prompt.
   *
   * The worktree is checked out at the ORDER's sha, without a fetch: dispatch
   * already fetched and pinned it (`prepareWorktree`). Re-fetching here would
   * reintroduce the drift the pinning exists to remove — a push landing
   * between the two calls would leave the tree ahead of the prompt. Only if
   * the sha is not in the clone at all (no prepare hook ran) do we fetch.
   */
  async dispatchRound(order: RoundOrder, renderedPrompt: string): Promise<void> {
    if (order.head_sha && (await this.worktrees.hasCommit(order.head_sha))) {
      await this.worktrees.checkoutAt(order.pr, order.head_sha);
    } else {
      await this.worktrees.ensureWorktree(order.pr, { baseRef: order.base_ref });
    }
    await this.ensurePrSession(order.pr, order.title, order.worktree);
    const stamped = stampRoundPrompt(renderedPrompt, order.pr, order.round_no);
    // Keep the exact bytes that were dispatched. Redelivery must send the SAME
    // prompt — re-rendering later would quietly change the order (a different
    // head, a different memory block, a different nit-scope note), so what the
    // session eventually reads would not be the round the daemon recorded.
    this.saveRoundPrompt(order.pr, order.round_no, stamped);
    this.queuePrCommand(order.pr, "round", stamped, order.round_no);
  }

  private roundPromptPath(pr: number, roundNo: number): string {
    return join(this.root, "state", "round-prompts", `pr-${pr}-round-${roundNo}.md`);
  }

  private saveRoundPrompt(pr: number, roundNo: number, stamped: string): void {
    try {
      const path = this.roundPromptPath(pr, roundNo);
      mkdirSync(dirname(path), { recursive: true });
      this.writeAtomic(path, stamped);
    } catch (err) {
      // Best-effort by contract: losing the copy costs the cheap recovery for
      // this round, never the dispatch itself.
      console.log(
        `[quickreviewd] sessions: could not save the round prompt for #${pr} round ${roundNo}: ${String(err)}`,
      );
    }
  }

  /** SessionHooks: has this round's prompt actually been ACCEPTED into the
   * session? (#5362.)
   *
   * The daemon had no positive evidence of delivery at all — every net
   * inferred it from a JSONL mtime, which cannot distinguish "the prompt
   * arrived" from "the session was busy doing something else". That is the
   * inference that made the net structurally blind: a prompt is
   * dropped precisely BECAUSE the agent is busy, and a busy agent always
   * bumps the mtime after the round started.
   *
   * The receipt is a fact instead of a guess: `dispatchRound` stamps a token
   * into the wake file, and pi writes the user message it accepted — token
   * included — into the session JSONL. Present ⇒ delivered. Absent ⇒ never
   * delivered. Verified live on #5362, whose JSONL holds round 1's prompt and
   * two hand-typed messages but no trace whatsoever of round 2's.
   *
   * Returns null for "cannot tell": no session dir, nothing readable. The
   * caller must treat null as "no evidence either way" and never as loss.
   * Only files touched at/after the round started are read — the prompt cannot
   * be in an older one, and that keeps the scan bounded on long conversations.
   */
  async roundPromptAccepted(
    pr: number,
    roundNo: number,
    startedAtMs: number,
  ): Promise<boolean | null> {
    return this.wakeReceiptPresent(pr, roundPromptMarker(pr, roundNo), startedAtMs);
  }

  /** SessionHooks: the general receipt read — did a wake carrying `marker`
   * reach the session? `roundPromptAccepted` is the round-shaped wrapper; the
   * recheck sweep uses this directly, because a recheck has no round row and
   * (unlike a round) no deadline underneath it to catch a silent loss. */
  async wakeReceiptPresent(pr: number, marker: string, sinceMs: number): Promise<boolean | null> {
    const root = this.sessionDir(prSessionName(pr));
    if (!existsSync(root)) return null;
    const startedAtMs = sinceMs;
    // A file is in scope if it could contain a write made after the round
    // started. The slack absorbs coarse mtimes and small clock differences;
    // being generous here costs a few extra reads, being tight would report a
    // delivered round as lost.
    const floor = startedAtMs - 60_000;
    let sawCandidate = false;
    // An I/O failure anywhere in the scan makes the whole answer UNKNOWN
    // (#5362 rule ①: present = delivered, absent = never arrived, unreadable =
    // unknown — and unknown is NEVER read as loss). Before the catch
    // below returned `false`, i.e. "provably never arrived", which is the one
    // reading the rule forbids: after redelivery is spent that answer kills a
    // live conversation. A failed read also no longer aborts the scan — the
    // marker may still be in the next file.
    let unreadable = false;
    const walk = (dir: string): boolean => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        unreadable = true;
        return false;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (walk(full)) return true;
          continue;
        }
        if (!e.name.endsWith(".jsonl")) continue;
        try {
          if (statSync(full).mtimeMs < floor) continue;
        } catch {
          // Cannot even tell whether this file is in scope.
          unreadable = true;
          continue;
        }
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          // An unreadable file is not evidence of absence.
          unreadable = true;
          continue;
        }
        // The marker is deliberately plain ASCII, so it survives JSON string
        // encoding byte-for-byte and a substring search over the raw file is
        // exact — no per-line parsing, no partial-write hazard.
        if (text.includes(marker)) return true;
        sawCandidate = true;
      }
      return false;
    };
    if (walk(root)) return true;
    // A file we could not read might have held the marker, so absence is not
    // established: report UNKNOWN rather than loss.
    if (unreadable) {
      // …but say so. The flag is scan-GLOBAL, so ONE permanently unreadable
      // stale `.jsonl` makes every receipt query for this PR answer `null`
      // forever — which silently disables both the redelivery-vs-loss decision
      // here and reconcile's claim-release sweep. Unknown is the correct
      // answer and a durable row is how it stops being a silent one.
      this.commandStore?.logEvent("receipt_scan_unreadable", pr, {
        marker,
        since_ms: sinceMs,
        root,
      });
      return null;
    }
    // Nothing to read at all (a session that has not written since the round
    // started) is genuinely ambiguous on a slow first tool call — but the
    // caller only asks after the stall grace, by which point a session that
    // received its prompt has certainly written. Report the absence.
    return sawCandidate ? false : null;
  }

  /** SessionHooks: re-deliver a round prompt whose receipt never appeared
   * (#5362). The cheap recovery: the same round, the same session, the same
   * conversation — just the wake file written again, byte-identical to what
   * was dispatched. No round is cancelled, no session is killed, no GitHub
   * state is touched, and the self-requeue budget is untouched.
   *
   * False when the saved prompt is gone (a round dispatched before this
   * existed, or a wiped state dir): the caller then falls through to the
   * expensive recovery rather than inventing a prompt. */
  async redeliverRound(pr: number, roundNo: number): Promise<boolean> {
    const command = this.commandStore?.sessionCommandForRound(pr, roundNo);
    let stamped: string;
    try {
      stamped = command
        ? readFileSync(command.payload_path, "utf8")
        : readFileSync(this.roundPromptPath(pr, roundNo), "utf8");
    } catch {
      return false;
    }
    if (stamped.trim().length === 0) return false;
    const hash = createHash("sha256").update(stamped).digest("hex");
    if (command && hash !== command.payload_sha256) return false;
    // The session may have died since dispatch; the bridge only delivers to a
    // live one. Rebirth it exactly as `inject` does, so a redelivery into a
    // dead session is not silently swallowed.
    await this.ensureSessionForWake(pr);
    if (!command || !this.commandStore) {
      this.injectFile(prSessionName(pr), stamped);
      return true;
    }
    if (command.status === "running") {
      // Never report a no-op as redelivery. A correlated start means the
      // prompt already landed; an unaccepted owner must expire through the
      // command lease before the same id can be retried safely.
      return command.started_at !== null;
    }
    if (command.status === "pending") {
      this.restorePendingSessionCommands();
      return true;
    }
    // Reuse the original path as well as the id. A failed no-start attempt
    // deliberately leaves that file pending; minting a second filename would
    // let the old evidence be adopted as a new legacy command on restart.
    const injectPath = command.inject_path;
    try {
      if (
        !this.commandStore.retrySessionCommand(command.id, {
          inject_path: injectPath,
          next_check_at: this.commandDeadline(this.sessionCommandStartLeaseMs()),
        })
      )
        return false;
      this.writeAtomic(injectPath, stamped);
      return true;
    } catch (err) {
      this.commandStore.failPendingSessionCommand(
        command.id,
        `redelivery write failed: ${String(err)}`,
      );
      return false;
    }
  }

  /**: retry one durable command without ever leaving the old
   * consumer alive beside its replay. Rounds may only use this before start;
   * an ordinary wake may use it after acceptance because the tmux fence comes
   * first. In both cases the same id, path and exact payload bytes survive. */
  async retrySessionCommand(
    commandId: string,
    _reason: string,
  ): Promise<SessionCommandRetryResult> {
    const store = this.commandStore;
    const command = store?.getSessionCommand(commandId);
    if (
      !store ||
      !command ||
      !["pending", "running", "failed"].includes(command.status) ||
      (command.kind === "round" && command.started_at !== null)
    )
      return "retry_failed";
    // A closed PR is never reborn for an ordinary wake (selfscan 666a2356):
    // settle the row instead of replaying it into a respawned session.
    if (command.kind !== "round" && this.prClosed(command.pr)) {
      store.cancelSessionCommandsForClosedPr(command.pr);
      return "settled";
    }

    let payload: Buffer;
    try {
      payload = readFileSync(command.payload_path);
      if (createHash("sha256").update(payload).digest("hex") !== command.payload_sha256)
        return "retry_failed";
    } catch {
      return "retry_failed";
    }

    const session = prSessionName(command.pr);
    if (await this.tmux.hasSession(session)) {
      await this.tmux.killSession(session);
      if (await this.tmux.hasSession(session)) {
        throw new Error(`session ${session} survived command-recovery kill; refusing replay`);
      }
    }

    // Nothing can consume or settle the old command after the tmux session is
    // proven absent. Check the merits lifecycle, then atomically return the
    // same ownership row to pending. A settlement that won during the kill is
    // success, never grounds for duplicate replay.
    if (command.kind === "round" && command.round_no !== null) {
      if (existsSync(join(this.root, "verdict", `pr-${command.pr}-round-${command.round_no}.json`)))
        return "round_finished";
      const round = store.roundsFor(command.pr).find((row) => row.round_no === command.round_no);
      if (!round || round.status !== "running") return "round_finished";
    }
    if (
      !store.retrySessionCommandAfterFence(
        command.id,
        command.attempt,
        this.commandDeadline(this.sessionCommandStartLeaseMs()),
      )
    ) {
      const current = store.getSessionCommand(command.id);
      if (current?.status === "acked") return "settled";
      if (
        command.kind === "round" &&
        current?.started_at !== null &&
        current?.started_at !== undefined
      )
        return "accepted_race";
      if (command.kind === "round" && command.round_no !== null) {
        const round = store.roundsFor(command.pr).find((row) => row.round_no === command.round_no);
        if (!round || round.status !== "running") return "round_finished";
      }
      return "retry_failed";
    }
    try {
      this.writeAtomic(command.inject_path, payload);
      await this.ensureSessionForWake(command.pr);
      const replayed = store.getSessionCommand(command.id);
      if (replayed?.status === "acked" || replayed?.status === "cancelled") return "settled";
      // The recovery file exists BEFORE birth. A matching bridge writes ready
      // only after its synchronous startup drain, whose reservation is the one
      // transition that increments attempt. Tmux birth without that increment
      // is zero deliveries, never a successful replay (#5454).
      if (!replayed || replayed.attempt <= command.attempt) {
        const detail = `bridge became ready without reserving command ${command.id} (delivery attempt stayed ${command.attempt})`;
        store.noteSessionCommandRecoveryFailure(command.id, detail);
        store.logEvent("session_command_replay_unreserved", command.pr, {
          command_id: command.id,
          delivery_attempt: replayed?.attempt ?? command.attempt,
          detail,
        });
        console.log(`[quickreviewd] sessions: ${detail}`);
        return "retry_failed";
      }
      return "retried";
    } catch (error) {
      // The pending row + immutable payload remain the one obligation. The
      // next finite supervisor check retries rebirth; no held-wake conversion
      // can evict or reorder it. Persist the pre-reserve cause outside the Pi
      // pane, because the recovery fence is about to destroy that pane.
      const detail = String(error);
      store.noteSessionCommandRecoveryFailure(command.id, detail);
      store.logEvent("session_command_rebirth_failed", command.pr, {
        command_id: command.id,
        delivery_attempt: store.getSessionCommand(command.id)?.attempt ?? command.attempt,
        detail,
      });
      console.log(
        `[quickreviewd] sessions: command ${command.id} recovery rebirth failed: ${detail}`,
      );
      return "retry_failed";
    }
  }

  /** Late-bound title lookup for respawning a dead sticky session (the store
   * exists only after wire-up; set from onStart). */
  private titleResolver?: (pr: number) => string | undefined;

  setTitleResolver(fn: (pr: number) => string | undefined): void {
    this.titleResolver = fn;
  }

  /** SessionHooks: wake a PR session outside a round (ping-pong, follow-ups).
   *
   * Sticky sessions die with the container (restart/deploy) and are only
   * reborn on round dispatch — but rechecks and ping-pong are exactly the
   * paths that fire WITHOUT a round (live gap 2026-08-19: every post-restart
   * push recheck threw "no live session"). If the title is resolvable, the
   * session is respawned here: same prompt template, same env, worktree
   * re-ensured best-effort (the wake message cites it). Only when no title is
   * known (PR never tracked) does the original error stand. */
  async inject(pr: number, message: string): Promise<void> {
    await this.ensureSessionForWake(pr);
    this.queuePrCommand(pr, "wake", message, null);
  }

  /** Rebirth a dead or bridge-unready sticky session so a wake has somewhere
   * to land. Shared by `inject` and `redeliverRound` — a redelivery into tmux
   * without the matching watcher receipt would be written to a mailbox nobody
   * proved it owns, which is the same silent loss the receipt exists to catch.
   * Throws only when the PR was never tracked, so no title is known. */
  private async ensureSessionForWake(pr: number): Promise<void> {
    const session = prSessionName(pr);
    if ((await this.tmux.hasSession(session)) && this.currentBridgeReady(session)) return;
    if (this.prClosed(pr)) {
      throw new Error(`PR #${pr} is closed — refusing to respawn ${session} for a wake`);
    }
    const title = this.titleResolver?.(pr);
    if (title === undefined) {
      throw new Error(`no live session ${session} — dispatch a round to birth it first`);
    }
    const worktree = this.worktrees.worktreePath(pr);
    try {
      await this.worktrees.ensureWorktree(pr);
    } catch {
      // Best-effort: an unfetchable worktree must not lose the wake — the
      // session can re-derive state from the message + GitHub reads.
    }
    await this.ensurePrSession(pr, title, worktree);
    console.log(`[quickreviewd] sessions: respawned dead ${session} for an out-of-round wake`);
  }

  /**
   * Wake the overseer and return the PATH of the wake file just written.
   *
   * The Slack router binds its origin record to the inject file's
   * basename, so it needs the name back; `injectOverseer` below keeps the
   * void-returning SessionHooks shape every other caller is typed against.
   */
  async injectOverseerFile(message: string): Promise<string> {
    await this.ensureOverseerSession();
    return this.injectFile(OVERSEER_SESSION, message);
  }

  /** SessionHooks: wake the overseer (anomalies, EOD sweep). */
  async injectOverseer(message: string): Promise<void> {
    await this.injectOverseerFile(message);
  }

  // ---- archival / death --------------------------------------------------

  /** Newest *.jsonl anywhere under a session's --session-dir. Ties break on the
   * filename — pi names sessions `<timestamp>_<uuid>.jsonl` (findings §1). */
  newestSessionFile(session: string): string | undefined {
    const root = this.sessionDir(session);
    let newest: { path: string; mtime: number; name: string } | undefined;
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".jsonl")) {
          const mtime = statSync(full).mtimeMs;
          const better =
            !newest || mtime > newest.mtime || (mtime === newest.mtime && e.name > newest.name);
          if (better) newest = { path: full, mtime, name: e.name };
        }
      }
    };
    walk(root);
    return newest?.path;
  }

  /** SessionHooks: newest session-JSONL mtime for the PR's sticky session —
   * the lost-prompt net's activity signal. Null when no JSONL exists
   * (a session that never wrote anything has no activity to date).
   * VERIFY-ON-PIN: the net's entire evidence base is that pi APPENDS to the
   * session JSONL promptly (bumping mtime) whenever a prompt is ACCEPTED into
   * the session — a stale mtime after a consumed inject must mean the prompt
   * never became a turn, not merely lazy/buffered writes. Confirm on the live
   * 0.84.1 container (smoke:session): send a prompt, watch the JSONL mtime
   * move within seconds. */
  async sessionActivityAt(pr: number): Promise<number | null> {
    const file = this.newestSessionFile(prSessionName(pr));
    if (!file) return null;
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  /** SessionHooks: unconsumed wake files in the PR session's inject dir —
   * still pending means the inject-bridge is retrying, not that it lost
   * anything.
   * VERIFY-ON-PIN: the complementary assumption — a wake CONSUMED
   * (moved to .done/) with no JSONL activity implies a mid-turn drop, i.e.
   * pi writes NOTHING to the session JSONL for a sendUserMessage() dropped
   * mid-turn on 0.84.1. If a dropped prompt does leave a JSONL record, the
   * lost-prompt net can never fire and needs a different silence signal. */
  async injectPending(pr: number): Promise<boolean> {
    const dir = this.injectDir(prSessionName(pr));
    try {
      return readdirSync(dir).some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  }

  /** Copy JSONL + ledger (+ verdicts) into an archive dir. Returns what landed. */
  archiveSession(session: string, dest: string): string[] {
    mkdirSync(dest, { recursive: true });
    const written: string[] = [];
    const jsonl = this.newestSessionFile(session);
    if (jsonl) {
      const target = join(dest, "session.jsonl");
      copyFileSync(jsonl, target);
      written.push(target);
    }
    const ledger = this.ledgerPath(session);
    if (existsSync(ledger)) {
      const target = join(dest, "ledger.md");
      copyFileSync(ledger, target);
      written.push(target);
    }
    const pr = prOfSession(session);
    if (pr !== undefined) {
      const verdictDir = join(this.root, "verdict");
      if (existsSync(verdictDir)) {
        const prefix = `pr-${pr}-round-`;
        for (const f of readdirSync(verdictDir)) {
          if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
          mkdirSync(join(dest, "verdicts"), { recursive: true });
          const target = join(dest, "verdicts", f);
          copyFileSync(join(verdictDir, f), target);
          written.push(target);
        }
      }
    }
    this.writeAtomic(
      join(dest, "meta.json"),
      `${JSON.stringify(
        {
          session,
          archived_at: this.now().toISOString(),
          session_file: jsonl ?? null,
          files: written,
        },
        null,
        2,
      )}\n`,
    );
    return written;
  }

  /** SessionHooks: is the PR's tmux session alive? Read by the
   * stuck-round detector (verdicts.ts checkDeadlines) — the same tmux
   * has-session signal every other lifecycle decision here uses. */
  async sessionAlive(pr: number): Promise<boolean> {
    return this.tmux.hasSession(prSessionName(pr));
  }

  /** SessionHooks: kill a wedged session so the requeued round's dispatch
   * rebirths it fresh (live-but-stuck recovery). The ledger on disk is the
   * continuity that matters and survives the kill by design. */
  async killSession(pr: number): Promise<void> {
    const session = prSessionName(pr);
    if (!(await this.tmux.hasSession(session))) return;
    await this.tmux.killSession(session);
    if (await this.tmux.hasSession(session)) {
      throw new Error(`session ${session} survived kill; recovery must not dispatch beside it`);
    }
  }

  /** SessionHooks: PR merged/closed — archive, drop the worktree, kill tmux. */
  /** Post-round compaction: type `/compact` into the session's pane. Manual
   * /compact is a documented pi command (findings §compaction).
   * Verified live 2026-08-19 (tag burned): mid-turn arrival is NOT harmless —
   * it ABORTS the in-flight turn (stopReason:"aborted"), which cut off every
   * post-deploy round's tail. The verdict file is therefore the round's LAST
   * durable write by template order (ledger comes before it); anything a
   * session does after its verdict write is expendable by design.
   * Best-effort: a missing session is a no-op, never an error. */
  async compactSession(pr: number): Promise<void> {
    const session = prSessionName(pr);
    if (!(await this.tmux.hasSession(session))) return;
    try {
      await this.tmux.send(session, "/compact", true);
    } catch {
      // Best-effort by contract: the has/send pair races session death during
      // shutdown/restart — a vanished pane must not log as a failure.
    }
  }

  /** True only when the registry says the PR is closed; unknown is not closed. */
  private prClosed(pr: number): boolean {
    return this.commandStore?.getPr(pr)?.state === "closed";
  }

  async archiveAndClose(pr: number): Promise<void> {
    const session = prSessionName(pr);
    // Terminalize outstanding ordinary wakes FIRST, so no recovery sweep can
    // replay one into a session reborn after the kill below (selfscan 666a2356).
    this.commandStore?.cancelSessionCommandsForClosedPr(pr);
    this.archiveSession(session, this.archiveDir(session));
    await this.worktrees.remove(pr);
    await this.tmux.killSession(session);
    // The raw tier dies with the PR: DELETE removes the session's messages AND
    // its archives (verified — the tree is gone). Deliberately AFTER the tmux
    // kill, so nothing is still syncing turns into it, and deliberately NOT in
    // killSession(): a wedged session is respawned and keeps its notes.
    await this.deleteOvSession(pr);
  }

  // ---- overseer rotation -------------------------------------------------

  /** Weekly rotation on the daemon timer: archive the run, then respawn. */
  async rotateOverseer(): Promise<string> {
    const stamp = this.now().toISOString().slice(0, 10);
    this.archiveSession(OVERSEER_SESSION, join(this.archiveDir(OVERSEER_SESSION), stamp));
    await this.tmux.killSession(OVERSEER_SESSION);
    await this.ensureOverseerSession();
    return stamp;
  }

  /** True when the live overseer is older than config.daemon.overseer_rotation_days. */
  overseerRotationDue(): boolean {
    const born = this.bornAt(OVERSEER_SESSION);
    if (!born) return false;
    const ageDays = (this.now().getTime() - born.getTime()) / 86_400_000;
    return ageDays >= this.cfg.daemon.overseer_rotation_days;
  }

  async rotateOverseerIfDue(): Promise<boolean> {
    if (!this.overseerRotationDue()) return false;
    await this.rotateOverseer();
    return true;
  }

  // ---- daemon start ------------------------------------------------------

  /**
   * Daemon start: adopt live sessions and sweep worktrees whose PR is no
   * longer active (ported preflight). Never touches a live session.
   */
  async preflight(
    activePrs: Iterable<number>,
  ): Promise<{ adoption: AdoptionReport; sweptWorktrees: number[] }> {
    const adoption = await this.adopt();
    const keep = new Set<number>([...activePrs, ...adoption.prs]);
    const sweptWorktrees = await this.worktrees.sweepStale(keep);
    return { adoption, sweptWorktrees };
  }
}
