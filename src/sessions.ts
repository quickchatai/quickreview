// The daemon↔pi boundary: birth, wake, adopt, archive and kill of the per-PR
// pi sessions and the overseer session.
//
// This file is the tmux + inject-bridge host. The host-neutral half of a PR
// session's life (worktree, raw-notes tier, archive record, close, and the
// single-flights that order them) is `PrSessionLifecycle`
// (pr-session-lifecycle.ts); the overseer is not PR lifecycle and stays here.
//
// Shape of a session: a detached tmux session named `pr-<n>` (or `overseer`)
// running the pinned interactive pi TUI with cwd = the sandbox root, the
// substituted system prompt passed by path, and the two sandbox extensions
// loaded. The daemon never types into that TUI: it wakes the session by
// dropping a Markdown file into inject/<session>/, which the inject-bridge
// extension picks up (tmux send-keys is not used).
//
// pi's package is a dependency here, but its CLI is not run in tests; every
// assumption about its CLI surface is tagged VERIFY-ON-PIN and confined to
// buildPiCommand().
import { stripModelDocs } from "./promptdoc.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { verifiedPayload } from "./session-command-payload.js";
import type { Config } from "./config.js";
import {
  DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S,
  DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
  DEFAULT_SESSION_COMMAND_START_LEASE_S,
  DEFAULT_SUBAGENT_CACHE_STAGGER_MS,
  DEFAULT_SUBAGENT_PASS_DEADLINE_MIN,
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
import {
  bridgeCompaction,
  COMPACTION_REQUEST_FILE,
  OVERSEER_RETIRE_REQUEST_FILE,
  readSessionBridgeState,
  waitForSessionBridgeReady,
  writeSessionBridgeState,
  type CompactionRequest,
  type SessionBridgeState,
} from "./session-bridge.js";
import { sameSessionCommandOwner, type SessionCommandOwnership } from "./session-command.js";
import { Tmux } from "./tmux.js";
import type { ExecFn } from "./tmux.js";
import type { SessionCommandKind, SessionCommandRow, StateStore } from "./state.js";
import { roundPromptMarker, stampRoundPrompt } from "./types.js";
import { RECEIPT_SCOPE_SLACK_MS, ReceiptIndex, type ReceiptIndexStats } from "./receiptscan.js";
import type {
  OvSessionSweepReport,
  RoundOrder,
  SessionCommandObservation,
  SessionCommandRedeliveryResult,
  SessionCommandRetryResult,
  SessionCompactionReport,
  SessionHooks,
} from "./types.js";
import { identityVars } from "./include.js";
import { renderConversationSystemPrompt, renderOverseerSystemPrompt } from "./templates.js";
import { WorktreeManager } from "./worktrees.js";
import {
  PrSessionLifecycle,
  prOfSession,
  prSessionName,
  type PrSessionHost,
} from "./pr-session-lifecycle.js";

// The PR session naming lives with the lifecycle; sessions.ts keeps exporting it.
export { prOfSession, prSessionName };

export const OVERSEER_SESSION = "overseer";

/** Environment-variable prefixes that ride the `env K=V … pi …` argv (see
 * spawnSession). `QCR_` is the daemon's routing surface; `OPENVIKING_` is the
 * session's memory identity, which must be per-session and therefore cannot
 * come from the tmux server environment; `GIT_CONFIG_` is the config-scope pin
 * (see sessionGitConfigPins). Secrets are never prefixed — argv is
 * world-readable — so no prefix carries a credential. */
const ARGV_ENV_PREFIXES = ["QCR_", "OPENVIKING_", "GIT_CONFIG_"] as const;

/** The once-per-claim memory of `receipt_archived_unknown` holds at most this
 * many keys; past it, it starts again (each logged once more). */
const ARCHIVED_UNKNOWN_LOG_KEYS = 10_000;

/**
 * The config-scope pin: which files git may read configuration from, decided by
 * the daemon at spawn time rather than discovered by git at run time.
 *
 * Why this exists. `extensions/bash-guard.ts` vets command strings, and a
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
  return name === OVERSEER_SESSION || /^pr-\d+$/.test(name);
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

export interface AdoptionReport {
  /** Live sandbox sessions found at daemon start — adopted, never killed. */
  adopted: string[];
  prs: number[];
  overseer: boolean;
}

/** The exact newline policy both durable and direct wake files use. */
function messagePayload(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

export class PiSessionManager implements SessionHooks {
  readonly cfg: Config;
  readonly root: string;
  readonly tmux: Tmux;
  readonly worktrees: WorktreeManager;
  private readonly piBin: string;
  private readonly piHome: string;
  private readonly now: () => Date;
  private commandStore: StateStore | undefined;
  private readonly configPath: string | undefined;
  /** The host-neutral half of a PR session's life (worktree, raw tier,
   * archive, close); this class is its tmux + inject-bridge host. */
  private readonly lifecycle: PrSessionLifecycle;
  private injectSeq = 0;
  /** The receipt scan's index: each session file's receipt tokens, read once. */
  private readonly receipts = new ReceiptIndex();
  /** `receipt_archived_unknown` already logged, by (pr, marker, archive
   * state): once each, not once per sweep — reconcile asks about a standing
   * claim every pass, and a reopened PR left unrestored (mode not `on`) would
   * otherwise write ~288 rows a day per claim, indefinitely. A changed
   * archive state logs again; a restart logs each once more. */
  private readonly archivedUnknownLogged = new Set<string>();

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
    this.piBin = opts.piBin ?? "pi";
    this.piHome = opts.piHome ?? join(opts.root, "pihome");
    this.now = opts.now ?? (() => new Date());
    this.commandStore = opts.commandStore;
    this.configPath = opts.configPath;
    this.lifecycle = new PrSessionLifecycle({
      cfg: opts.cfg,
      root: opts.root,
      worktrees: this.worktrees,
      host: this.tmuxHost(),
      ovSessions: opts.ovSessions,
      now: this.now,
      commandStore: opts.commandStore,
    });
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
      join(this.root, "extensions", "inject-bridge.ts"),
      join(this.root, "extensions", "ledger-pin.ts"),
      join(this.root, "extensions", "muted-theme.ts"),
      // Publishes the parent + lens lifecycle as an ephemeral read-only
      // sidecar for the operator TUI. It observes pi events only; no session
      // scheduling or daemon state passes through it.
      join(this.root, "extensions", "round-progress.ts"),
      // First-party glue over pi's own subagent extension, imported at
      // runtime from the installed pinned package (nothing vendored, nothing
      // that can drift from the rule-7 pin). The built state/agents
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
      // The vendored + patched OpenViking extension: the memory tools a
      // session reaches. Last on purpose — it is the only extension
      // here we did not write, and pi registers handlers in load order, so
      // ours (ledger-pin above all) are in place before it arrives.
      //
      // It rides argv for the same reason the subagents glue does: a subagent
      // child loads no argv extensions, so a lens pass gets no memory surface
      // at all. Its own PATCH 2 is the second layer.
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
      QCR_PI_VERSION: this.cfg.pi.version,
      // The process-wide subagent fan-out cap the glue extension enforces
      // (config.toml [pi] subagent_max_concurrency).
      QCR_SUBAGENT_MAX_CONCURRENCY: String(this.cfg.pi.subagent_max_concurrency),
      // `[review] wide_lens_fanout`: a batched lens launch runs as wide as
      // that cap instead of native pi's in-call four (bench/aacr/PERF.md §1).
      QCR_SUBAGENT_WIDE_FANOUT: this.cfg.review?.wide_lens_fanout === false ? "0" : "1",
      // Lens children share the provider's prompt cache in groups
      // (extensions/subagents.ts), and the leaf-cache extension that puts a
      // round's context pack first rides a child only where the round has one.
      QCR_SUBAGENT_CACHE_GROUP: String(this.cfg.pi.subagent_cache_group ?? 0),
      QCR_SUBAGENT_CACHE_STAGGER_MS: String(
        this.cfg.pi.subagent_cache_stagger_ms ?? DEFAULT_SUBAGENT_CACHE_STAGGER_MS,
      ),
      // The per-pass deadline (config.toml [pi] subagent_pass_deadline_min):
      // a stalled lens child is aborted and retried once instead of holding
      // the round. "0" switches it off.
      QCR_SUBAGENT_PASS_DEADLINE_MIN: String(
        this.cfg.pi.subagent_pass_deadline_min ?? DEFAULT_SUBAGENT_PASS_DEADLINE_MIN,
      ),
      QCR_LEAF_CACHE_EXT: join(this.root, "extensions", "leaf-cache.ts"),
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

  /** The bridge receipt of the session's current generation (the one its
   * birth file names), or undefined when there is none to read. */
  private currentBridgeState(session: string): SessionBridgeState | undefined {
    try {
      const birth = JSON.parse(readFileSync(this.birthFile(session), "utf8")) as {
        bridge_generation?: string;
      };
      if (!birth.bridge_generation) return undefined;
      const state = readSessionBridgeState(this.bridgeStatePath(session, birth.bridge_generation));
      return state?.session === session && state.generation === birth.bridge_generation
        ? state
        : undefined;
    } catch {
      return undefined;
    }
  }

  private currentBridgeReady(session: string): boolean {
    return this.currentBridgeState(session)?.stage === "ready";
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
  ensurePrSession(pr: number, title: string, worktree: string): Promise<string> {
    return this.lifecycle.ensureSession(pr, title, worktree);
  }

  /** Late production binding (wire.ts): the archiver's `beforeBirth`. */
  setBeforeBirth(fn: (pr: number) => Promise<void>): void {
    this.lifecycle.setBeforeBirth(fn);
  }

  /** What the lifecycle asks of the tmux host: a session is a detached tmux
   * session whose inject bridge proves readiness by a generation receipt. */
  private tmuxHost(): PrSessionHost {
    return {
      liveSessions: () => this.tmux.listSessionsKnown().catch(() => null),
      provenGone: (pr) => this.sessionProvenGone(prSessionName(pr)),
      killConfirmed: (pr) => this.killConfirmed(prSessionName(pr)),
      stop: async (pr) => {
        const session = prSessionName(pr);
        await this.tmux.killSession(session);
        // A compaction request the killed bridge never took is not
        // a wake and nothing archives it; it would only keep the inject dir alive.
        try {
          rmSync(join(this.injectDir(session), COMPACTION_REQUEST_FILE), { force: true });
        } catch {
          /* best-effort */
        }
      },
      reuseLive: async (pr) => {
        const session = prSessionName(pr);
        if (!(await this.tmux.hasSession(session))) return undefined;
        if (this.currentBridgeReady(session)) return session;
        this.commandStore?.logEvent("session_bridge_stale", pr, {
          session,
          reason: "tmux alive without matching ready generation",
        });
        if (!(await this.killConfirmed(session))) {
          throw new Error(`session ${session} survived stale-bridge fence`);
        }
        return undefined;
      },
      spawn: (pr, title, worktree, { rawReady }) =>
        this.spawnPrSession(pr, title, worktree, rawReady),
    };
  }

  private async spawnPrSession(
    pr: number,
    title: string,
    worktree: string,
    rawReady: boolean,
  ): Promise<string> {
    const session = prSessionName(pr);
    const template = readFileSync(join(this.root, "prompts", "conversation-system.md"), "utf8");
    const body = renderConversationSystemPrompt(
      template,
      { pr, title, worktree },
      identityVars(this.cfg),
    );
    try {
      await this.spawnSession(session, body, this.cfg.models.conversation, {
        ...(rawReady ? {} : { QCR_OV_SESSION_ID: "", OPENVIKING_SESSION_ID: "" }),
        QCR_PR: String(pr),
        QCR_PR_META: `PR #${pr} — ${title} (worktree ${worktree})`,
        QCR_WORKTREE: worktree,
      });
    } catch (err) {
      // A creator outside this manager instance may win after our first check.
      // Adopt only when both tmux and the matching bridge-generation receipt
      // prove that winner is usable; process existence alone is not proof.
      if ((await this.tmux.hasSession(session)) && this.currentBridgeReady(session)) return session;
      throw err;
    }
    return session;
  }

  /** Slack concierge appendix, or "" when Slack is off. */
  private slackAppendix(): string {
    // Typed access, not a cast: rename `slack` or `enabled` in Config and this
    // fails the build instead of silently dropping the appendix. (The `?.`
    // survives hand-rolled test configs that omit the block entirely.)
    if (!this.cfg.slack?.enabled) return "";
    const path = join(this.root, "prompts", "slack-overseer-appendix.md");
    if (!existsSync(path))
      throw new Error(`slack.enabled = true but the overseer Slack appendix is missing: ${path}`);
    return `\n\n${stripModelDocs(readFileSync(path, "utf8")).trimEnd()}\n`;
  }

  /** Concurrent callers (a Slack burst, an anomaly beside the EOD sweep)
   * share one has→spawn flight, as PR births do: a second spawn would fail
   * on tmux's duplicate name before its caller wrote its wake. */
  async ensureOverseerSession(): Promise<string> {
    if (this.overseerRotation) {
      await this.overseerRotation;
      return OVERSEER_SESSION;
    }
    const existing = this.overseerBirth;
    if (existing) return existing;
    const birth = this.birthOverseer();
    this.overseerBirth = birth;
    try {
      return await birth;
    } finally {
      if (this.overseerBirth === birth) this.overseerBirth = undefined;
    }
  }

  private overseerBirth?: Promise<string>;
  private overseerRotation?: Promise<string | false>;

  private async birthOverseer(rotating = false): Promise<string> {
    const alive = await this.tmux.hasSession(OVERSEER_SESSION);
    // A probe begun before rotation may describe its old incarnation. Join
    // the rotation's fresh birth instead of fencing a newly starting bridge.
    if (!rotating && this.overseerRotation) {
      await this.overseerRotation;
      return OVERSEER_SESSION;
    }
    if (alive) {
      if (this.currentBridgeReady(OVERSEER_SESSION)) return OVERSEER_SESSION;
      if (!(await this.killConfirmed(OVERSEER_SESSION)))
        throw new Error("the overseer survived its stale-bridge fence");
    }
    const template = readFileSync(join(this.root, "prompts", "overseer-system.md"), "utf8");
    // The seeded overseer prompt is canonical and unmodifiable (CLAUDE.md rule
    // 6), so the Slack contract rides as a spawn-time appendix — same shape as
    // EXECUTION_POLICY_ADDENDUM in include.ts. Slack off = byte-identical prompt.
    const body =
      renderOverseerSystemPrompt(template, identityVars(this.cfg)) + this.slackAppendix();
    try {
      await this.spawnSession(OVERSEER_SESSION, body, this.cfg.models.overseer);
    } catch (err) {
      // A creator outside this manager instance may have won after our check.
      if (
        (await this.tmux.hasSession(OVERSEER_SESSION)) &&
        this.currentBridgeReady(OVERSEER_SESSION)
      )
        return OVERSEER_SESSION;
      throw err;
    }
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
    this.lifecycle.setCommandStore(store);
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
        const read = verifiedPayload(command);
        if (!read.ok) throw new Error(read.why);
        this.writeAtomic(command.inject_path, read.payload);
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

  /** Adopt at most the oldest legacy inject file (one with no durable command
   * row) per PR. Later files remain the filesystem backlog and are adopted
   * after the slot terminalizes; no legacy file is ever declared accepted
   * merely because it already exists. */
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
    if (this.prClosed(pr)) throw new Error(`PR #${pr} is closed — refusing command delivery`);
    if (this.lifecycle.cleanupInFlight(pr))
      throw new Error(`PR #${pr} session cleanup is in flight — refusing command delivery`);
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
    const payload = messagePayload(message);
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
    this.writeAtomic(path, messagePayload(message));
    return path;
  }

  /**
   * SessionHooks: ensure worktree + session, then inject the round prompt.
   *
   * The worktree is checked out at the order's sha, without a fetch: dispatch
   * already fetched and pinned it (`prepareWorktree`). Re-fetching here would
   * reintroduce the drift the pinning exists to remove — a push landing
   * between the two calls would leave the tree ahead of the prompt. Only if
   * the sha is not in the clone at all (no prepare hook ran) do we fetch.
   */
  async dispatchRound(order: RoundOrder, renderedPrompt: string): Promise<void> {
    await this.lifecycle.prepareRoundWorktree(order);
    await this.ensurePrSession(order.pr, order.title, order.worktree);
    if (this.commandStore?.getPr(order.pr)?.paused)
      throw new Error(`PR #${order.pr} paused during session preparation — round not handed off`);
    const stamped = stampRoundPrompt(renderedPrompt, order.pr, order.round_no);
    // Keep the exact bytes that were dispatched. Redelivery must send the same
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

  /** SessionHooks: has this round's prompt actually been accepted into the
   * session?
   *
   * A JSONL mtime cannot tell "the prompt arrived" from "the session was busy
   * doing something else" — and a prompt is dropped precisely because the
   * agent is busy, which also bumps the mtime. So delivery is read from a
   * receipt instead: `dispatchRound` stamps a token into the wake file, and pi
   * writes the user message it accepted — token included — into the session
   * JSONL. Present ⇒ delivered. Absent ⇒ never delivered.
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
    // The scan lives in `receiptscan.ts`: an index that reads each byte of a
    // session file once, asynchronously and in chunks, so a query never
    // blocks the event loop re-reading whole transcripts.
    const { answer, unreadable } = await this.receipts.present(root, marker, sinceMs);
    // A file we could not read might have held the marker, so absence is not
    // established: the answer is unknown rather than loss (CLAUDE.md, "a
    // delivered prompt is a receipt" ①) — but say so. The flag is
    // scan-global, so one permanently unreadable stale `.jsonl` makes every
    // receipt query for this PR answer `null` forever — which silently disables
    // both the redelivery-vs-loss decision and reconcile's claim-release sweep.
    // Unknown is the correct answer and a durable row is how it stops being a
    // silent one.
    if (answer === null && unreadable)
      this.commandStore?.logEvent("receipt_scan_unreadable", pr, {
        marker,
        since_ms: sinceMs,
        root,
      });
    // Archived is never absent. The archiver
    // moves a closed PR's transcripts out of this dir; once a reopened PR's
    // reborn session writes a fresh JSONL, a scan for a pre-close wake reads
    // only that file and answers `false` — and the claim sweep would release
    // a nudge that may well have landed. While the PR's archive is not
    // restored and could hold a file in this query's scope (its newest
    // archived mtime reaches the scope floor), a live `false` is unknown. A
    // live `true` stays true; a wake sent after the reopen is past every
    // archived mtime and is answered from the live files alone.
    if (answer === false) {
      const scope = this.archiveScopeOf(pr);
      if (
        scope === "unreadable" ||
        (scope !== null &&
          scope.state !== "restored" &&
          scope.max_mtime_ms !== null &&
          sinceMs - RECEIPT_SCOPE_SLACK_MS <= scope.max_mtime_ms)
      ) {
        const archiveState = scope === "unreadable" ? "unreadable" : scope.state;
        const key = `${pr}\u0000${marker}\u0000${archiveState}`;
        if (!this.archivedUnknownLogged.has(key)) {
          if (this.archivedUnknownLogged.size >= ARCHIVED_UNKNOWN_LOG_KEYS)
            this.archivedUnknownLogged.clear();
          this.archivedUnknownLogged.add(key);
          this.commandStore?.logEvent("receipt_archived_unknown", pr, {
            marker,
            since_ms: sinceMs,
            archive_state: archiveState,
            max_mtime_ms: scope === "unreadable" ? null : scope.max_mtime_ms,
          });
        }
        return null;
      }
    }
    // Nothing to read at all (a session that has not written since the wake)
    // is genuinely ambiguous on a slow first tool call — but every caller asks
    // only after the stall grace, by which point a session that received its
    // prompt has certainly written. So in-scope files without the marker are
    // reported as the absence they are.
    return answer;
  }

  /** The PR's archive row as the receipt guard reads it; "unreadable" when
   * the read failed (then a live `false` is unknown too — never a guess). */
  private archiveScopeOf(
    pr: number,
  ): { state: string; max_mtime_ms: number | null } | null | "unreadable" {
    // A store without the archive ledger (a narrow test double) has nothing
    // archived; a real store whose read fails is unknown.
    if (typeof this.commandStore?.archiveScope !== "function") return null;
    try {
      return this.commandStore.archiveScope(pr);
    } catch {
      return "unreadable";
    }
  }

  /** What the receipt index has read so far (status/diagnostics). */
  receiptIndexStats(): ReceiptIndexStats {
    return this.receipts.stats();
  }

  /** SessionHooks: re-deliver a round prompt whose receipt never appeared.
   * The cheap recovery: the same round, the same session, the same
   * conversation — just the wake file written again, byte-identical to what
   * was dispatched. No round is cancelled; a stale bridge may be replaced. No GitHub
   * state is touched, and the self-requeue budget is untouched.
   *
   * False when the saved prompt is gone (a round dispatched before this
   * existed, or a wiped state dir): the caller then falls through to the
   * expensive recovery rather than inventing a prompt. */
  async redeliverRound(pr: number, roundNo: number): Promise<boolean> {
    const command = this.commandStore?.sessionCommandForRound(pr, roundNo);
    let stamped: string;
    if (command) {
      const read = verifiedPayload(command);
      if (!read.ok) return false;
      stamped = read.payload.toString("utf8");
    } else {
      try {
        stamped = readFileSync(this.roundPromptPath(pr, roundNo), "utf8");
      } catch {
        return false;
      }
    }
    if (stamped.trim().length === 0) return false;
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

  /**
   * SessionHooks: redeliver one command whose start lease ran out, into the
   * same live, bridge-ready session — never a kill.
   * The row goes back to `pending` (same id, path and bytes; a CAS on what was
   * read) and the payload is rewritten at its inject path, which wakes the
   * bridge. A bridge that still holds the command as submitted-but-unstarted
   * resubmits it only when pi is idle with nothing queued (`inject-bridge.ts`
   * `reclaimRedelivered`), so a prompt pi did queue is never sent twice.
   * `not_live` when there is no live, ready bridge to redeliver into: that is
   * the kill-and-replay recovery's case.
   *
   * `observed` is the row the supervisor found due, and every check — this
   * read and the CAS — is against it, never against a fresh read: a bridge
   * that reserved the command after the due check (a new attempt, a fresh
   * lease) may hold a submission pi is still preflighting, and handing that
   * back would send it twice. A row that moved is
   * `raced`: the supervisor looks again on the fresh lease.
   */
  async redeliverSessionCommand(
    commandId: string,
    observed: SessionCommandObservation,
  ): Promise<SessionCommandRedeliveryResult> {
    const store = this.commandStore;
    const command = store?.getSessionCommand(commandId);
    if (!store || !command) return "redelivery_failed";
    if (command.status === "acked" || command.status === "cancelled") return "settled";
    if (command.started_at !== null) return "started";
    if (command.status !== "pending" && command.status !== "running") return "redelivery_failed";
    // The fast path, before any tmux or file work; the CAS below is what
    // binds (a reservation landing after this read still loses there).
    if (
      command.attempt !== observed.attempt ||
      command.redeliveries !== observed.redeliveries ||
      command.next_check_at !== observed.next_check_at
    )
      return "raced";
    const session = prSessionName(command.pr);
    if (!(await this.tmux.hasSession(session)) || !this.currentBridgeReady(session))
      return "not_live";
    const read = verifiedPayload(command);
    if (!read.ok) {
      this.notePayloadUnusable(store, command, read.why);
      return "redelivery_failed";
    }
    const payload = read.payload;
    if (
      !store.requeueSessionCommandForRedelivery(
        command.id,
        {
          attempt: observed.attempt,
          redeliveries: observed.redeliveries,
          next_check_at: observed.next_check_at,
        },
        this.commandDeadline(this.sessionCommandStartLeaseMs()),
      )
    ) {
      const current = store.getSessionCommand(command.id);
      if (!current || current.status === "acked" || current.status === "cancelled")
        return "settled";
      if (current.started_at !== null) return "started";
      // A round that ended meanwhile is the merits lifecycle's to close.
      if (
        current.kind === "round" &&
        current.round_no !== null &&
        store.roundStatus(current.pr, current.round_no) !== "running"
      )
        return "settled";
      return "raced";
    }
    try {
      this.writeAtomic(command.inject_path, payload);
    } catch (err) {
      store.noteSessionCommandRecoveryFailure(
        command.id,
        `redelivery write failed: ${String(err)}`,
      );
      return "redelivery_failed";
    }
    return "redelivered";
  }

  /** Retry one durable command without ever leaving the old
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
    // A closed PR is never reborn for an ordinary wake: settle the row
    // instead of replaying it into a respawned session.
    if (command.kind !== "round" && this.prClosed(command.pr)) {
      store.cancelSessionCommandsForClosedPr(command.pr);
      return "settled";
    }

    const read = verifiedPayload(command);
    if (!read.ok) {
      this.notePayloadUnusable(store, command, read.why);
      return "retry_failed";
    }
    const payload = read.payload;

    const prepareReplay = (): SessionCommandRetryResult | undefined => {
      // Nothing can consume or settle the old command after the tmux session is
      // proven absent. Check the merits lifecycle, then atomically return the
      // same ownership row to pending. A settlement that won during the kill is
      // success, never grounds for duplicate replay.
      if (command.kind === "round" && command.round_no !== null) {
        if (
          existsSync(join(this.root, "verdict", `pr-${command.pr}-round-${command.round_no}.json`))
        )
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
          const round = store
            .roundsFor(command.pr)
            .find((row) => row.round_no === command.round_no);
          if (!round || round.status !== "running") return "round_finished";
        }
        return "retry_failed";
      }
    };
    let preparation: SessionCommandRetryResult | undefined;
    let publicationError: { error: unknown } | undefined;
    const fenced = await this.fenceSession(command.pr, command, () => {
      preparation = prepareReplay();
      // Publish replay transport before releasing the close flight: a birth
      // already waiting on this fence must find its immutable command file.
      if (!preparation) {
        try {
          this.writeAtomic(command.inject_path, payload);
        } catch (error) {
          publicationError = { error };
        }
      }
    });
    if (!fenced) {
      const current = store.getSessionCommand(command.id);
      return !current || current.status === "acked" || current.status === "cancelled"
        ? "settled"
        : "raced";
    }
    if (preparation) return preparation;
    try {
      if (publicationError) throw publicationError.error;
      await this.ensureSessionForWake(command.pr);
      const replayed = store.getSessionCommand(command.id);
      if (replayed?.status === "acked" || replayed?.status === "cancelled") return "settled";
      // The recovery file exists before birth. A matching bridge writes ready
      // only after its synchronous startup drain, whose reservation is the one
      // transition that increments attempt. Tmux birth without that increment
      // is zero deliveries, never a successful replay.
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
   * Sticky sessions die with the container (restart/deploy) and are otherwise
   * reborn only on round dispatch — but rechecks and ping-pong fire without a
   * round. So a dead or unready session is respawned here (see
   * ensureSessionForWake): same prompt template, same env, worktree
   * re-ensured best-effort (the wake message cites it). A PR whose title is
   * unknown (never tracked) throws instead, and a closed PR throws whether or
   * not its session is still alive. */
  async inject(pr: number, message: string): Promise<void> {
    // Before the live fast path: a closed PR's session that outlived its
    // close cleanup takes no new wake either.
    if (this.prClosed(pr)) {
      throw new Error(`PR #${pr} is closed — refusing a wake into ${prSessionName(pr)}`);
    }
    await this.ensureSessionForWake(pr);
    this.queuePrCommand(pr, "wake", message, null);
  }

  /** Rebirth a dead or bridge-unready sticky session so a wake has somewhere
   * to land. Shared by `inject` and `redeliverRound` — a redelivery into tmux
   * without the matching watcher receipt would be written to a mailbox nobody
   * proved it owns, which is the same silent loss the receipt exists to catch.
   * Throws when the PR is closed, or was never tracked so no title is known. */
  private async ensureSessionForWake(pr: number): Promise<void> {
    const closing = this.lifecycle.cleanupInFlight(pr);
    if (closing) {
      await closing.catch(() => undefined);
      return this.ensureSessionForWake(pr);
    }
    const session = prSessionName(pr);
    const cleanupVersion = this.lifecycle.cleanupVersion(pr);
    const alive = await this.tmux.hasSession(session);
    // Cleanup can start or even finish during the probe. Its old answer may
    // name the consumer that was just killed, even after the PR reopens.
    if (cleanupVersion !== this.lifecycle.cleanupVersion(pr) || this.lifecycle.cleanupInFlight(pr))
      return this.ensureSessionForWake(pr);
    if (alive && this.currentBridgeReady(session)) return;
    if (this.prClosed(pr)) {
      throw new Error(`PR #${pr} is closed — refusing to respawn ${session} for a wake`);
    }
    const title = this.titleResolver?.(pr);
    if (title === undefined) {
      throw new Error(`no live session ${session} — dispatch a round to birth it first`);
    }
    // A reopened PR's archive comes back before its session does.
    await this.lifecycle.awaitBeforeBirth(pr);
    const worktree = await this.lifecycle.reviveWorktree(pr);
    if (this.prClosed(pr)) throw new Error(`PR #${pr} is closed — refusing to respawn ${session}`);
    await this.ensurePrSession(pr, title, worktree);
    console.log(`[quickreviewd] sessions: respawned dead ${session} for an out-of-round wake`);
  }

  /**
   * Wake the overseer and return the path of the wake file just written.
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

  /** Newest *.jsonl anywhere under a session's --session-dir. */
  newestSessionFile(session: string): string | undefined {
    return this.lifecycle.newestSessionFile(session);
  }

  /** SessionHooks: newest session-JSONL mtime for the PR's sticky session —
   * an activity signal. Null when no JSONL exists (a session that never wrote
   * anything has no activity to date).
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
   * anything. Its callers (reconcile's recheck-claim sweep, verdicts' silent-round check)
   * read it as a patience signal only: a pending wake means wait.
   * Whether a wake was delivered is never inferred from it — that is the
   * receipt token's job (`wakeReceiptPresent`): present = delivered, absent =
   * never arrived, unreadable = unknown. */
  async injectPending(pr: number): Promise<boolean> {
    const dir = this.injectDir(prSessionName(pr));
    try {
      return readdirSync(dir).some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  }

  /** Write a session's record into an archive dir (the lifecycle's archive
   * record: ledger, verdicts, `meta.json`). Returns what landed. */
  archiveSession(session: string, dest: string): string[] {
    return this.lifecycle.archiveSession(session, dest);
  }

  /** Is a session birth for `pr` in flight right now? Synchronous — the
   * archiver's eligibility re-reads it immediately before
   * anything of the PR's leaves the live tree. */
  birthInFlight(pr: number): boolean {
    return this.lifecycle.birthInFlight(pr);
  }

  /** SessionHooks: an affirmative tmux listing decides liveness. An
   * unavailable listing rejects, so recovery callers preserve unknown
   * rather than treating a failed probe as confirmed death. */
  async sessionAlive(pr: number): Promise<boolean> {
    const names = await this.tmux.listSessionsKnown();
    if (names === null) throw new Error("tmux liveness unknown: session listing unavailable");
    return names.includes(prSessionName(pr));
  }

  /** SessionHooks: kill a wedged session so the requeued round's dispatch
   * rebirths it fresh (live-but-stuck recovery), and the operator's
   * restart-session fence. It returns only once tmux affirmatively lists the
   * session as gone; a tmux that could not be asked throws, so no caller
   * releases ownership beside a pi that may still run. The ledger on disk is
   * the continuity that matters and survives the kill by design. */
  async killSession(pr: number): Promise<void>;
  async killSession(pr: number, expected: SessionCommandOwnership): Promise<boolean>;
  async killSession(pr: number, expected?: SessionCommandOwnership): Promise<void | boolean>;
  async killSession(pr: number, expected?: SessionCommandOwnership): Promise<void | boolean> {
    const fenced = await this.fenceSession(pr, expected);
    return expected ? fenced : undefined;
  }

  private async fenceSession(
    pr: number,
    expected?: SessionCommandOwnership,
    afterFence?: () => void,
  ): Promise<boolean> {
    const session = prSessionName(pr);
    let fenced = false;
    const owns = () => {
      if (!expected) return true;
      if (
        !this.commandStore ||
        !sameSessionCommandOwner(this.commandStore.getSessionCommand(expected.id), expected)
      )
        return false;
      const active = this.commandStore.activeSessionCommand(session);
      return !active || active.id === expected.id;
    };
    // Birth and delivery wait this existing close flight. Thus a successor
    // cannot be born between the last ownership check and the async tmux kill.
    await this.lifecycle.withPrClose(pr, async () => {
      if (!owns()) return;
      const gone = await this.sessionProvenGone(session);
      if (!owns()) return;
      if (!gone && !(await this.killConfirmed(session)))
        throw new Error(
          `session ${session} not proven gone after kill; recovery must not dispatch beside it`,
        );
      afterFence?.(); // Keep retry's CAS inside the same birth/close serialization.
      fenced = true;
    });
    return fenced;
  }

  /** Kill `session` and confirm it gone: `Tmux.killSession` ignores its exit
   * status, so the follow-up listing is the fence. True only when tmux
   * answered and no longer lists it — never when tmux could not be asked. */
  private async killConfirmed(session: string): Promise<boolean> {
    await this.tmux.killSession(session);
    return this.sessionProvenGone(session);
  }

  /** Does tmux affirmatively say `session` is gone? `hasSession` reads every
   * failed probe (a socket it may not open, EAGAIN) as absence; a cleanup
   * that destroys what a live session still writes to needs the listing tmux
   * could answer, so "could not ask" is never "gone". */
  private async sessionProvenGone(session: string): Promise<boolean> {
    let names: string[] | null;
    try {
      names = await this.tmux.listSessionsKnown();
    } catch {
      names = null;
    }
    return names !== null && !names.includes(session);
  }

  /** A recovery route found the command's saved payload unusable: say why on
   * the row (the supervisor reports it in place of the original reason) and
   * in the event log. */
  private notePayloadUnusable(
    store: StateStore,
    command: { id: string; pr: number },
    why: string,
  ): void {
    store.noteSessionCommandRecoveryFailure(command.id, why);
    this.recordEvent("session_command_payload_unusable", command.pr, {
      command_id: command.id,
      detail: why,
    });
    console.log(`[quickreviewd] sessions: command ${command.id} cannot be replayed: ${why}`);
  }

  /** SessionHooks: the reconcile sweep over closed PRs' raw tier (and any of
   * their sessions still alive in tmux); see the lifecycle. */
  sweepStaleOvSessions(max?: number): Promise<OvSessionSweepReport | null> {
    return this.lifecycle.sweepStaleOvSessions(max);
  }

  private recordEvent(kind: string, pr: number, payload: Record<string, unknown>): void {
    try {
      this.commandStore?.logEvent(kind, pr, payload);
    } catch {
      /* recording is best-effort; the log line says it too */
    }
  }

  /**
   * Post-round compaction, requested from the session's inject bridge: one
   * `.compact-request.json` in the inject dir, which the bridge runs through
   * pi's own `ctx.compact()` once nothing is in flight, holding every wake
   * until it ends. Never `/compact` typed into the pane: that aborts whatever
   * turn is running, and a wake submitted into a running compaction is
   * refused by pi without the bridge learning. The verdict file is the
   * round's last durable write; the tail after it finishes before the
   * compaction starts.
   * Best-effort: no live session is a no-op, and a bridge that does not know
   * the request ignores it (no compaction, never a stuck mailbox).
   */
  async compactSession(pr: number): Promise<void> {
    const session = prSessionName(pr);
    if (!(await this.tmux.hasSession(session))) return;
    const request: CompactionRequest = {
      version: 1,
      requested_at: this.now().toISOString(),
      reason: "round-end",
    };
    try {
      this.writeAtomic(
        join(this.injectDir(session), COMPACTION_REQUEST_FILE),
        `${JSON.stringify(request)}\n`,
      );
    } catch (err) {
      // Best-effort by contract: a compaction is an optimisation, never owed.
      console.log(
        `[quickreviewd] sessions: could not request compaction of ${session}: ${String(err)}`,
      );
    }
  }

  /** SessionHooks: the current bridge generation's compaction report — null
   * when there is no ready bridge to read or it reports no compaction,
   * and null when tmux holds no session: a pi killed or OOM'd mid-compaction
   * never reaches `session_shutdown`, so its last receipt still says
   * "running", and a dead session must never hold off its own recovery. */
  async sessionCompaction(pr: number): Promise<SessionCompactionReport | null> {
    const session = prSessionName(pr);
    const state = this.currentBridgeState(session);
    if (state?.stage !== "ready") return null;
    const compaction = bridgeCompaction(state) ?? null;
    if (compaction?.state === "running" && !(await this.tmux.hasSession(session))) return null;
    return compaction;
  }

  /** True only when the registry says the PR is closed; unknown is not closed. */
  private prClosed(pr: number): boolean {
    return this.lifecycle.prClosed(pr);
  }

  /** SessionHooks: archive the PR's record, drop its worktree, stop its
   * session and delete its raw tier; see the lifecycle. */
  archiveAndClose(pr: number): Promise<void> {
    return this.lifecycle.archiveAndClose(pr);
  }

  // ---- overseer rotation -------------------------------------------------

  /**
   * Weekly rotation on the daemon timer (and the operator's `restart-session
   * overseer`): record the run, then respawn. Each rotation gets its own
   * record dir — `archive/overseer/<YYYY-MM-DD>`, then `<date>-2`, `-3`, … for
   * another the same day — so two rotations on one date never overwrite each
   * other. Only the ledger and `meta.json` are written there;
   * the transcript stays live until the archiver moves it, named by its own
   * file name, into `archive/overseer/transcripts/`. Returns the dir's name.
   */
  async rotateOverseer(): Promise<string> {
    const rotated = await this.runOverseerRotation(false);
    return rotated === false ? this.rotateOverseer() : rotated;
  }

  private async runOverseerRotation(automatic: boolean): Promise<string | false> {
    if (this.overseerRotation) return this.overseerRotation;
    const rotation = this.rotateOverseerNow(automatic);
    this.overseerRotation = rotation;
    try {
      return await rotation;
    } finally {
      if (this.overseerRotation === rotation) this.overseerRotation = undefined;
    }
  }

  private async retireOverseerWhenIdle(): Promise<boolean> {
    const bridge = this.currentBridgeState(OVERSEER_SESSION);
    if (bridge?.stage !== "ready") return false;
    const nonce = randomUUID();
    const path = join(this.injectDir(OVERSEER_SESSION), OVERSEER_RETIRE_REQUEST_FILE);
    try {
      this.writeAtomic(path, JSON.stringify({ version: 1, generation: bridge.generation, nonce }));
      const deadline = performance.now() + this.sessionBridgeReadyTimeoutMs();
      while (true) {
        if (await this.sessionProvenGone(OVERSEER_SESSION)) return true;
        if (performance.now() >= deadline) return false;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now()))),
        );
      }
    } finally {
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as { nonce?: string };
        if (current.nonce === nonce) rmSync(path);
      } catch {
        /* Do not remove a replacement or unreadable request. */
      }
    }
  }

  private async rotateOverseerNow(automatic: boolean): Promise<string | false> {
    // Stale idle telemetry is never authority to kill. The bridge proves idle
    // in its own event loop and retires itself; unknown/timeout keeps it intact.
    if (automatic && !(await this.retireOverseerWhenIdle())) return false;
    const day = this.now().toISOString().slice(0, 10);
    const base = this.archiveDir(OVERSEER_SESSION);
    let stamp = day;
    for (let k = 2; existsSync(join(base, stamp)); k++) stamp = `${day}-${k}`;
    this.archiveSession(OVERSEER_SESSION, join(base, stamp));
    // A kill that did not take would let the respawn below adopt the old
    // overseer and report a rotation that never happened.
    if (!automatic && !(await this.killConfirmed(OVERSEER_SESSION))) {
      throw new Error(`the overseer survived the rotation kill — not rotated (record ${stamp})`);
    }
    // An older single-flight probe may still describe the overseer killed
    // above. Rotation needs its own fresh liveness decision.
    await this.birthOverseer(true);
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
    // Acceptance archives transport before the run settles. Idle telemetry
    // only admits the retirement request; the process itself proves idle.
    // A legacy receipt without run_status is unknown and safely holds automatic
    // rotation; the operator can still request an explicit restart.
    const bridge = this.currentBridgeState(OVERSEER_SESSION);
    if (
      bridge?.stage !== "ready" ||
      bridge.run_status !== "idle" ||
      bridge.compaction?.state !== "idle"
    )
      return false;
    try {
      if (readdirSync(this.injectDir(OVERSEER_SESSION)).some((file) => file.endsWith(".md")))
        return false;
    } catch {
      return false;
    }
    return (await this.runOverseerRotation(true)) !== false;
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
    const sweptWorktrees = await this.lifecycle.sweepStaleWorktrees(keep);
    return { adoption, sweptWorktrees };
  }
}
