// The daemon↔pi boundary: birth, wake, archive and kill of the per-PR
// pi sessions.
//
// PR sessions are hosted by workers only (worker-session-host.ts); this file
// no longer births, wakes or kills one. What stays is the tmux host of the
// replay harness and the path/archive helpers the worker host shares.
//
// Shape of a session: a detached tmux session
// running the pinned interactive pi TUI with cwd = the sandbox root, the
// substituted system prompt passed by path, and the two sandbox extensions
// loaded. The daemon never types into that TUI: it wakes the session by
// dropping a Markdown file into inject/<session>/, which the inject-bridge
// extension picks up (tmux send-keys is not used).
//
// pi's package is a dependency here, but its CLI is not run in tests; every
// assumption about its CLI surface is tagged VERIFY-ON-PIN and confined to
// buildPiCommand().
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import {
  DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S,
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
  ovRecallHintPathIn,
  ovRetiredPathIn,
  writeOvcliConf,
  type OvSessionLifecycle,
  type OvcliWriteResult,
} from "./memory/ovsession.js";
import { waitForSessionBridgeReady, writeSessionBridgeState } from "./session-bridge.js";
import { messagePayload } from "./session-command-payload.js";
import { piCliPath } from "./picli.js";
import { Tmux } from "./tmux.js";
import type { ExecFn } from "./tmux.js";
import type { StateStore } from "./state.js";
import { WorktreeManager } from "./worktrees.js";
import {
  PrSessionLifecycle,
  prOfSession,
  prSessionName,
  type PrSessionHost,
} from "./pr-session-lifecycle.js";

// The PR session naming lives with the lifecycle; sessions.ts keeps exporting it.
export { prOfSession, prSessionName };

/** Environment-variable prefixes that ride the `env K=V … pi …` argv (see
 * spawnSession). `QCR_` is the daemon's routing surface; `OPENVIKING_` is the
 * session's memory identity, which must be per-session and therefore cannot
 * come from the tmux server environment; `GIT_CONFIG_` is the config-scope pin
 * (see sessionGitConfigPins). Secrets are never prefixed — argv is
 * world-readable — so no prefix carries a credential. */
const ARGV_ENV_PREFIXES = ["QCR_", "OPENVIKING_", "GIT_CONFIG_"] as const;

/**
 * The config-scope pin: which files git may read configuration from, decided by
 * the daemon at spawn time rather than discovered by git at run time.
 *
 * Why this exists. `packages/pi-plugin/extensions/bash-guard.ts` vets command strings, and a
 * command-string guard cannot see git's implicit config search path:
 * `HOME=/tmp/evil git diff --no-index A B` executes arbitrary shell out of
 * `$HOME/.gitconfig`, and a session can equally write the real
 * `$HOME/.gitconfig` with its ordinary write tool and then run a plain
 * `git diff` — no suspicious token anywhere for the guard to see. No length of
 * blocklist reaches that.
 *
 * So the search path is not searched. Setting `GIT_CONFIG_GLOBAL` makes both
 * `$HOME/.gitconfig` and `$XDG_CONFIG_HOME/git/config` inert — git consults the
 * named file instead, so `HOME` and `XDG_CONFIG_HOME` stop being config
 * vectors whether or not the guard knows their names. Verified by execution:
 *
 *   HOME=<evil> git diff --no-index A B                        → ran <cmd>
 *   HOME=<evil> GIT_CONFIG_GLOBAL=<pin> git diff --no-index A B → did NOT run
 *   XDG_CONFIG_HOME=<evil> …                                    → same pair
 *
 * …and end-to-end through the real spawn shape (`tmux new-session -d -s <n> -c
 * <cwd> env K=V … <cmd>`), because tmux panes inherit the tmux server
 * environment: a pin that rode the client env would silently do nothing.
 * Hence `GIT_CONFIG_` in ARGV_ENV_PREFIXES above.
 *
 * The target is the pi HOME's own `.gitconfig` — the same file git would have
 * found by searching — and not `/dev/null`: the container's entrypoint writes
 * a `credential.helper` shell snippet into the global config
 * (docker/entrypoint.sh, daemon mode), and `fetch` is deliberately on
 * the session's read-verb allowlist because refusing it would wedge a review.
 * The pinned file's own `credential.helper` is still read and still invoked
 * (`git credential fill`), so nothing legitimate changes.
 *
 * What this does not do:
 *
 *   - It does not cover the repo scope. `<clone>/.git/config` is still read,
 *     and a session that writes `diff.external` there gets execution from a
 *     plain `git diff <base> <head>`. That half is closed at the write
 *     boundary instead (`checkWritePath` in bash-guard), because git has no
 *     "ignore the local config" switch to pin.
 *   - It does not stop a caller re-pointing these three variables on the
 *     command line: a later `GIT_CONFIG_GLOBAL=…` prefix wins over the spawn
 *     environment. The bash guard's COMMAND_INJECTING_ENV blocks that, and
 *     that block stays load-bearing. Env pins the floor; the guard stops it
 *     being lifted.
 */
/** `QCR_SECRETS_MOUNT` from the daemon's own environment, when it names an
 * absolute path (`docker/entrypoint.sh` exports it in every daemon container). */
export function secretsMountEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const mount = env.QCR_SECRETS_MOUNT?.trim() ?? "";
  return mount.startsWith("/") ? { QCR_SECRETS_MOUNT: mount } : {};
}

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

export function isSandboxSession(name: string): boolean {
  return prOfSession(name) !== undefined;
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
 * - `--model <provider/id>` — documented.
 * - `--session-dir <path>` — documented for RPC mode; assumed to
 *   apply to the interactive TUI as well. Per-session dir (not the shared
 *   store) so archival can pick "the newest .jsonl" unambiguously — all PR
 *   sessions share one cwd, so the cwd-keyed global store would mix them.
 * - `--system-prompt <path>` — not documented; pi documents only the
 *   `.pi/SYSTEM.md` / `~/.pi/agent/SYSTEM.md` override files. If no such flag
 *   exists, fall back to writing the substituted prompt to
 *   `<pi home>/.pi/SYSTEM.md` per session home (the substituted text is
 *   already on disk at systemPromptPath either way).
 * - `--extension <path>` — not documented; pi documents discovery dirs and a
 *   settings.json "extensions" array. Fallback: emit the same paths into the
 *   session's settings.json.
 * - `--name <display name>` — documented.
 * - `--theme <path>` — same flag the companion uses (VERIFY-ON-PIN); loads the
 *   fleet muted theme so no session ever flashes pi's bright-green tool panel.
 * There is deliberately no update/auto-update flag: the pi version is pinned by
 * config.pi.version and the container image.
 */
export function buildPiCommand(spec: PiCommandSpec): string[] {
  const argv = [
    spec.piBin,
    // --approve: pre-trust project-local .pi resources for this run. Without
    // it a cwd carrying .pi/ (our settings.json) hits pi's interactive "Trust
    // project folder?" modal and the session stalls forever. The reviewer
    // never blocks on interactive input.
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

/** The lifecycle's host for a manager that hosts no PR session. The lifecycle
 * is built for the paths, the archive record and the worktree sweep; a birth,
 * kill or fence through it is a bug. Only spawn throws; the kill, fence and
 * reuse operations are inert (`false` / `undefined`). */
const NO_PR_HOST: PrSessionHost = {
  liveSessions: async () => null,
  provenGone: async () => false,
  killConfirmed: async () => false,
  stop: async () => undefined,
  reuseLive: async () => undefined,
  spawn: async (pr) => {
    throw new Error(`the tmux manager hosts no PR session (#${pr}); workers are the only PR host`);
  },
};

export interface PiSessionManagerOptions {
  cfg: Config;
  /** Sandbox root (cwd of every session). */
  root: string;
  tmux?: Tmux;
  /** Used to build a Tmux when one is not supplied. */
  exec?: ExecFn;
  worktrees?: WorktreeManager;
  /** The pi to start. Omitted: the pinned pi's own CLI (src/picli.ts). */
  piBin?: string;
  /** HOME for the pi process — the container's pihome volume. */
  piHome?: string;
  /** The PR's raw-notes tier: an OpenViking session created when the
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

export class PiSessionManager {
  readonly cfg: Config;
  readonly root: string;
  readonly tmux: Tmux;
  readonly worktrees: WorktreeManager;
  private readonly piBin: string;
  private readonly piHome: string;
  private readonly now: () => Date;
  private readonly commandStore: StateStore | undefined;
  private readonly configPath: string | undefined;
  /** The host-neutral lifecycle, used here for its paths, the archive record
   * and the worktree sweep only: this class hosts no PR session (the workers
   * are the only PR host, src/worker-session-host.ts). */
  private readonly lifecycle: PrSessionLifecycle;
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
        // ("acme/widget-app" → "widget-app").
        cloneDir: githubCloneDir(opts.cfg.github),
        run: opts.exec,
      });
    this.piBin = opts.piBin ?? piCliPath();
    this.piHome = opts.piHome ?? join(opts.root, "pihome");
    this.now = opts.now ?? (() => new Date());
    this.commandStore = opts.commandStore;
    this.configPath = opts.configPath;
    this.lifecycle = new PrSessionLifecycle({
      cfg: opts.cfg,
      root: opts.root,
      worktrees: this.worktrees,
      host: NO_PR_HOST,
      ovSessions: opts.ovSessions,
      now: this.now,
      commandStore: opts.commandStore,
    });
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
    return this.lifecycle.sessionsRoot();
  }

  sessionDir(session: string): string {
    return this.lifecycle.sessionDir(session);
  }

  ledgerPath(session: string): string {
    return this.lifecycle.ledgerPath(session);
  }

  archiveDir(session: string): string {
    return this.lifecycle.archiveDir(session);
  }

  sessionCommandPayloadPath(id: string): string {
    return join(this.root, "state", "session-commands", `${id}.md`);
  }

  extensionPaths(): string[] {
    return [
      join(this.root, "extensions", "cli", "inject-bridge.ts"),
      join(this.root, "extensions", "cli", "ledger-pin.ts"),
      join(this.root, "extensions", "cli", "muted-theme.ts"),
      // docs/duplicate-merge.md: the `cluster_findings` tool a round calls
      // before pass-validate (`[review] dedup_merge`). The bench session
      // loads the same file (src/bench/runner.ts), so both routes group
      // candidates with one code path. Pure: it reads and writes nothing.
      join(this.root, "packages", "pi-plugin", "extensions", "finding-clusters.ts"),
      // The vendored + patched OpenViking extension: the memory tools a
      // session reaches. Last on purpose — it is the only extension
      // here we did not write, and pi registers handlers in load order, so
      // ours (ledger-pin above all) are in place before it arrives.
      //
      // It rides argv, not the global settings: a lens session loads no argv
      // extensions, so a lens pass gets no memory surface at all. Its own
      // PATCH 2 is the second layer.
      //
      // Its patches are load-bearing — read
      // extensions/vendor/openviking-pi/README.md before touching this line.
      // In particular PATCH 1 removes the extension's session_before_compact
      // handler so ledger-pin stays the sole owner of compaction.
      join(this.root, "extensions", "vendor", "openviking-pi", "index.ts"),
    ];
  }

  /** The fleet muted theme — every pi session gets it (no bright greens). */
  themePath(): string {
    return join(this.root, "extensions", "muted-theme.json");
  }

  // ---- OpenViking identity ----------------------------------------------

  /** `http://host:port` from `[openviking]`; a hand-rolled config without the
   * block falls back to the loopback default (the port is never published). */
  ovBaseUrl(): string {
    const ov = this.cfg.openviking;
    return ov ? openVikingBaseUrl(ov) : OV_DEFAULT_BASE_URL;
  }

  /** The OpenViking user the sessions act as: `[openviking] user`, the same
   * identity the daemon's own clients use with the same confined key; a
   * hand-rolled config without it falls back to the reviewer default. */
  ovUser(): string {
    return this.cfg.openviking?.user || OV_REVIEWER_USER;
  }

  /** The reviewer credential file every session resolves its key from. */
  ovcliConfPath(): string {
    return ovcliConfPathIn(this.piHome);
  }

  /** Where the daemon publishes the retired URIs the sessions' recall
   * excludes — beside ovcli.conf. */
  ovRetiredPath(): string {
    return ovRetiredPathIn(this.piHome);
  }

  /** Where the daemon publishes a PR session's recall hint — the
   * round's own context query, which the session's recall searches with
   * instead of the whole round order. */
  ovRecallHintPath(session: string): string {
    return ovRecallHintPathIn(this.piHome, session);
  }

  /**
   * Write the reviewer user key into the pi HOME, 0600, before a session is
   * born. The key is deliberately not an environment variable and not on the
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
        user: this.ovUser(),
      },
      {
        serverConfigPath: this.cfg.openviking?.config_file,
        log: (msg) => console.log(`[quickreviewd] sessions: ${msg}`),
      },
    );
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
   * personal credential, is ever placed here (CLAUDE.md rule 3).
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
      // Inside a daemon container the secrets are the mount the entrypoint
      // names, the install locator's first answer: the session's HOME holds no
      // install home, so without it mint-token.sh (pr-checks.sh's sanctioned
      // read) looks for the App id under that HOME and finds none (the 1.0.4
      // cutover's first worker round). A path, not a credential; bash-guard
      // also reads it into its secret-path set.
      ...secretsMountEnv(),
      QCR_PI_VERSION: this.cfg.pi.version,
      // The engine lens tool's config (`[engine] lens_*`): the worker's lens
      // runner reads these names back (lensRunConfigFromEnv).
      QCR_SUBAGENT_MAX_CONCURRENCY: String(this.cfg.engine.lens_max_concurrency),
      QCR_SUBAGENT_CACHE_GROUP: String(this.cfg.engine.lens_cache_group),
      QCR_SUBAGENT_CACHE_STAGGER_MS: String(this.cfg.engine.lens_cache_stagger_ms),
      // A stalled lens pass is aborted and retried once instead of holding the
      // round. "0" switches it off.
      QCR_SUBAGENT_PASS_DEADLINE_MIN: String(this.cfg.engine.lens_pass_deadline_min),
      // The daemon's own resolved config, so the posting scripts read the
      // file the daemon read. Set by the daemon — the bash guard
      // refuses a session's own `QCR_CONFIG=` prefix.
      ...(this.configPath ? { QCR_CONFIG: this.configPath } : {}),
      // The config-scope pin. Here as well as on the argv because buildEnv
      // is also the tmux client's environment; the argv copy is the
      // one that reaches the pane (ARGV_ENV_PREFIXES carries `GIT_CONFIG_`).
      ...sessionGitConfigPins(this.piHome),
      ...(this.commandStore && this.commandStore.path !== ":memory:"
        ? {
            QCR_STATE_DB: this.commandStore.path,
          }
        : {}),
    };
    const openai = this.secret("openai_api_key");
    if (openai) env.OPENAI_API_KEY = openai;
    // OpenViking identity. Explicit, because every session shares one
    // working directory and the extension's path-derived peer id therefore
    // cannot tell two PRs apart. The PR's raw-notes session is attached by id;
    // a non-PR session gets no session id (no raw tier, tools only). None of these is a secret — the key rides ovcli.conf at 0600.
    const pr = prOfSession(session);
    Object.assign(
      env,
      openVikingSessionEnv({
        baseUrl: this.ovBaseUrl(),
        user: this.ovUser(),
        peerId: session,
        cliConfigPath: this.ovcliConfPath(),
        serverConfigPath: this.cfg.openviking?.config_file,
        retiredFile: this.ovRetiredPath(),
        ...(pr === undefined
          ? {}
          : {
              ovSessionId: ovSessionIdForPr(pr),
              recallHintFile: this.ovRecallHintPath(session),
            }),
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

  /** Birth an arbitrary session (the replay harness). A
   * daemon-owned birth is not complete when tmux returns: the exact Pi
   * generation must prove that its inject bridge opened and swept the mailbox
   * first. */
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
    const spawnEnv = {
      ...extraEnv,
      QCR_SESSION_BRIDGE_GENERATION: generation,
      QCR_SESSION_BRIDGE_STATE_FILE: bridgeStateFile,
    };
    writeSessionBridgeState(bridgeStateFile, {
      version: 1,
      session,
      generation,
      stage: "starting",
      updated_at: this.now().toISOString(),
    });
    // tmux panes inherit the tmux server's environment, not the client's, so
    // per-session vars must ride the command line itself. Only the QCR_* routing
    // vars and the OPENVIKING_* identity are prefixed — HOME/PATH/OPENAI_API_KEY
    // stay whatever the container (or dev box) provides, which is where pi's
    // auth actually lives.
    //
    // Nothing prefixed here is a secret, and nothing may become one: argv is
    // world-readable inside the container (`ps`), which is why the OpenViking
    // key rides a 0600 ovcli.conf instead (see provisionOvCredentials).
    const qcrPrefix = Object.entries(this.buildEnv(session, spawnEnv))
      .filter(([k, v]) => ARGV_ENV_PREFIXES.some((p) => k.startsWith(p)) && v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    await this.tmux.newSession(session, ["env", ...qcrPrefix, ...command], {
      cwd: this.root,
      env: this.buildEnv(session, spawnEnv),
    });
    this.recordBirth(session, generation);
    // Readiness admission belongs to the two daemon-owned session kinds.
    // Isolated replay/smoke callers retain their own lifecycle protocol.
    if (!isSandboxSession(session)) return;
    try {
      await waitForSessionBridgeReady(
        bridgeStateFile,
        session,
        generation,
        this.sessionBridgeReadyTimeoutMs(),
      );
    } catch (error) {
      const detail = String(error);
      this.commandStore?.logEvent("session_bridge_readiness_failed", prOfSession(session) ?? null, {
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

  /** Remove routing metadata only after the caller has confirmed this session is gone. */
  removeSessionBirthMetadata(session: string): void {
    const directory = join(this.root, "state", "sessions");
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    rmSync(this.birthFile(session), { force: true });
    for (const name of names) {
      if (name.startsWith(`${session}.bridge-`) && name.endsWith(".json")) {
        rmSync(join(directory, name), { force: true });
      }
    }
  }

  private recordBirth(session: string, bridgeGeneration: string): void {
    this.writeAtomic(
      this.birthFile(session),
      `${JSON.stringify({ session, born_at: this.now().toISOString(), bridge_generation: bridgeGeneration }, null, 2)}\n`,
    );
  }

  // ---- injection ---------------------------------------------------------

  private injectFileName(): string {
    const ts = this.now().toISOString().replace(/[:.]/g, "-");
    const prefix = `${ts}-${String(this.injectSeq++).padStart(4, "0")}`;
    return `${prefix}.md`;
  }

  private sessionBridgeReadyTimeoutMs(): number {
    return (
      (this.cfg.daemon?.session_bridge_ready_timeout_s ?? DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S) *
      1000
    );
  }

  /** Drop a wake file the inject-bridge extension will deliver. */
  injectFile(session: string, message: string): string {
    const dir = this.injectDir(session);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, this.injectFileName());
    this.writeAtomic(path, messagePayload(message));
    return path;
  }

  // ---- archival / death --------------------------------------------------

  /** Write a session's record into an archive dir (the lifecycle's archive
   * record: ledger, verdicts, `meta.json`). Returns what landed. */
  archiveSession(session: string, dest: string): string[] {
    return this.lifecycle.archiveSession(session, dest);
  }

  // ---- daemon start ------------------------------------------------------

  /**
   * Daemon start: sweep the worktrees of PRs that are no longer active (ported
   * preflight). `keepPrs` are the active PRs plus any a worker still runs for
   * (src/workerliveness.ts). The boot adopts no tmux `pr-*` session: whatever a
   * worker-world boot finds is read from the leases, and a PR with none is idle
   * with its JSONL.
   */
  async preflight(keepPrs: Iterable<number>): Promise<{ sweptWorktrees: number[] }> {
    const sweptWorktrees = await this.lifecycle.sweepStaleWorktrees(new Set<number>(keepPrs));
    return { sweptWorktrees };
  }
}
