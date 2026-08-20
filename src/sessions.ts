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
import { openVikingBaseUrl } from "./config.js";
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
import { Tmux } from "./tmux.js";
import type { ExecFn } from "./tmux.js";
import type { RoundOrder, SessionHooks } from "./types.js";
import { renderConversationSystemPrompt, renderOverseerSystemPrompt } from "./templates.js";
import { WorktreeManager } from "./worktrees.js";

export const OVERSEER_SESSION = "overseer";

/** Environment-variable prefixes that ride the `env K=V … pi …` argv (see
 * spawnSession). `QCR_` is the daemon's routing surface; `OPENVIKING_` is the
 * session's memory identity, which must be per-session and therefore cannot
 * come from the tmux server environment. SECRETS ARE NEVER PREFIXED — argv is
 * world-readable — so no third prefix carries a credential. */
const ARGV_ENV_PREFIXES = ["QCR_", "OPENVIKING_"] as const;

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
  private injectSeq = 0;

  constructor(opts: PiSessionManagerOptions) {
    this.cfg = opts.cfg;
    this.root = opts.root;
    this.tmux = opts.tmux ?? new Tmux({ exec: opts.exec });
    this.worktrees =
      opts.worktrees ?? new WorktreeManager({ root: opts.root, repo: opts.cfg.github.repo, run: opts.exec });
    this.piBin = opts.piBin ?? "pi";
    this.piHome = opts.piHome ?? join(opts.root, "pihome");
    this.ovSessions = opts.ovSessions;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- paths -------------------------------------------------------------

  injectDir(session: string): string {
    return join(this.root, "inject", session);
  }

  promptPath(session: string): string {
    return join(this.root, "state", "session-prompts", `${session}.md`);
  }

  sessionDir(session: string): string {
    return join(this.root, this.cfg.pi.session_dir, session);
  }

  ledgerPath(session: string): string {
    return join(this.root, "state", "ledgers", `${session}.md`);
  }

  archiveDir(session: string): string {
    return join(this.root, "archive", session);
  }

  extensionPaths(): string[] {
    return [
      join(this.root, "extensions", "inject-bridge.ts"),
      join(this.root, "extensions", "ledger-pin.ts"),
      join(this.root, "extensions", "muted-theme.ts"),
      // Registers the built state/agents lens passes with pi-subagents via its
      // globalThis hook (live finding 2026-08-18: the extension's agents dir is
      // hardcoded, our old .pi/subagents.config.json was inert). Rides argv on
      // purpose: pi-subagents' child processes load only the global settings
      // extensions, so passes stay unregistered inside a leaf.
      join(this.root, "extensions", "register-lens-agents.ts"),
      // The vendored + patched OpenViking extension: the memory
      // tools a session reaches. LAST on purpose — it is the only extension
      // here we did not write, and pi registers handlers in load order, so
      // ours (ledger-pin above all) are in place before it arrives.
      //
      // It rides argv for the same reason register-lens-agents does: a
      // pi-subagents child is built with --no-extensions, so a lens pass gets
      // no memory surface at all. Its own PATCH 2 is the second layer.
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

  private writeAtomic(path: string, body: string): void {
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

  /** Birth an arbitrary session (used by ensure* and by the smoke script). */
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
    // tmux panes inherit the tmux SERVER's environment, not the client's, so
    // per-session vars must ride the command line itself. Only the QCR_* routing
    // vars and the OPENVIKING_* identity are prefixed — HOME/PATH/OPENAI_API_KEY
    // stay whatever the container (or dev box) provides, which is where pi's
    // auth actually lives.
    //
    // Nothing prefixed here is a secret, and nothing may become one: argv is
    // world-readable inside the container (`ps`), which is why the OpenViking
    // KEY rides a 0600 ovcli.conf instead (see provisionOvCredentials).
    const qcrPrefix = Object.entries(this.buildEnv(session, extraEnv))
      .filter(([k, v]) => ARGV_ENV_PREFIXES.some((p) => k.startsWith(p)) && v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    await this.tmux.newSession(session, ["env", ...qcrPrefix, ...command], {
      cwd: this.root,
      env: this.buildEnv(session, extraEnv),
    });
    this.recordBirth(session);
  }

  private birthFile(session: string): string {
    return join(this.root, "state", "sessions", `${session}.json`);
  }

  private recordBirth(session: string): void {
    this.writeAtomic(
      this.birthFile(session),
      `${JSON.stringify({ session, born_at: this.now().toISOString() }, null, 2)}\n`,
    );
  }

  bornAt(session: string): Date | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.birthFile(session), "utf8")) as { born_at?: string };
      return raw.born_at ? new Date(raw.born_at) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Birth on first trigger; a live session is left strictly alone. */
  async ensurePrSession(pr: number, title: string, worktree: string): Promise<string> {
    const session = prSessionName(pr);
    if (await this.tmux.hasSession(session)) return session;
    // The PR's raw-notes tier, created BEFORE pi starts so the extension has
    // something to attach to on the first turn. A store object, not a session
    // anyone schedules: the daemon still owns exactly two pi session kinds.
    await this.ensureOvSession(pr);
    const template = readFileSync(join(this.root, "prompts", "conversation-system.md"), "utf8");
    const body = renderConversationSystemPrompt(template, { pr, title, worktree });
    await this.spawnSession(session, body, this.cfg.models.conversation, {
      QCR_PR: String(pr),
      QCR_PR_META: `PR #${pr} — ${title} (worktree ${worktree})`,
      QCR_WORKTREE: worktree,
    });
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
    return `\n\n${readFileSync(path, "utf8").trimEnd()}\n`;
  }

  async ensureOverseerSession(): Promise<string> {
    if (await this.tmux.hasSession(OVERSEER_SESSION)) return OVERSEER_SESSION;
    const template = readFileSync(join(this.root, "prompts", "overseer-system.md"), "utf8");
    // The seeded overseer prompt is canonical and unmodifiable (CLAUDE.md rule
    // 6), so the Slack contract rides as a spawn-time appendix — same shape as
    // EXECUTION_POLICY_ADDENDUM in include.ts. Slack off = byte-identical prompt.
    const body = renderOverseerSystemPrompt(template) + this.slackAppendix();
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

  private injectFileName(): string {
    const ts = this.now().toISOString().replace(/[:.]/g, "-");
    return `${ts}-${String(this.injectSeq++).padStart(4, "0")}.md`;
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
    this.injectFile(prSessionName(order.pr), renderedPrompt);
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
    const session = prSessionName(pr);
    if (!(await this.tmux.hasSession(session))) {
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
    this.injectFile(session, message);
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
        { session, archived_at: this.now().toISOString(), session_file: jsonl ?? null, files: written },
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
    await this.tmux.killSession(prSessionName(pr)).catch(() => {});
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

  async archiveAndClose(pr: number): Promise<void> {
    const session = prSessionName(pr);
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
  async preflight(activePrs: Iterable<number>): Promise<{ adoption: AdoptionReport; sweptWorktrees: number[] }> {
    const adoption = await this.adopt();
    const keep = new Set<number>([...activePrs, ...adoption.prs]);
    const sweptWorktrees = await this.worktrees.sweepStale(keep);
    return { adoption, sweptWorktrees };
  }
}
