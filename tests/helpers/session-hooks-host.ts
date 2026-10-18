// Hosts for the SessionHooks conformance suite (tests/session-hooks-conformance
// .test.ts).
//
// `SessionHooks` (src/types.ts) is the one seam between the daemon's state
// machine and whatever runs the per-PR pi. The conformance suite states the
// contract once and runs it against every host in `SESSION_HOSTS`; a new host
// (the per-round worker of Phase 8) joins by adding one entry here and passing
// the same cases. The suite never reaches below the hooks except through the
// `SessionHooksRig` verbs, which are the world the host runs in: what has
// reached a session's mailbox, what pi accepted, whether the session is up.
//
// The tmux host is today's `PiSessionManager` over a recording fake exec — no
// tmux, no pi and no git is ever spawned.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { writeSessionBridgeState } from "../../src/session-bridge.js";
import { PiSessionManager, prSessionName } from "../../src/sessions.js";
import { StateStore } from "../../src/state.js";
import { Tmux, type ExecFn } from "../../src/tmux.js";
import type { SessionHooks } from "../../src/types.js";
import { WorktreeManager } from "../../src/worktrees.js";

/** The hooks a conforming host provides in full. The optional members of
 * `SessionHooks` are optional for stubs; a real host has all of them. */
export type FullSessionHooks = Required<SessionHooks>;

export const HOST_NOW = new Date("2026-08-13T10:00:00Z");

export interface SessionHooksRig {
  readonly hooks: FullSessionHooks;
  /** The durable command store the host and the daemon share. */
  readonly store: StateStore;
  /** Is the PR's (or the overseer's) session up in the host? */
  isRunning(session: string): boolean;
  /** A session the host already runs, ready to take a wake — as left by an
   * earlier daemon. Birth goes through the hooks; this is only for a session
   * that exists before the case starts. */
  seedRunningSession(session: string): void;
  /** Messages that reached the session's mailbox and are not consumed yet,
   * as the exact bytes, in arrival order. */
  mailbox(session: string): string[];
  /** The session consumed what was in its mailbox and finished it: the
   * durable command is acked and the mailbox is empty. */
  settleDelivered(pr: number): void;
  /** pi accepted this user message into the PR session's transcript. */
  recordAccepted(pr: number, text: string): void;
  /** pi wrote something to the PR session's transcript that is not a prompt. */
  recordActivity(pr: number): void;
  /** The session consumed what was in its mailbox without settling it (the
   * wake file is gone, the durable command is untouched). */
  consumeMailbox(session: string): void;
  /** The session's bridge now reports a generation the host did not birth. */
  staleBridge(session: string): void;
  /** The session dies on its own — the container restarted, pi crashed. */
  killOutOfBand(session: string): void;
  /** From now on a kill of this session does not take. */
  wedgeSession(session: string): void;
  /** Every birth and kill the host performed, in order: "birth pr-42",
   * "kill pr-42". The fence cases read their ordering from it. */
  lifecycle(): string[];
  /** Run `fn` as a session comes up — the new consumer starting, which is
   * where a replayed command is reserved — or as a kill lands. */
  onBirth(fn: (session: string) => void): void;
  onKill(fn: (session: string) => void): void;
  /** The daemon restarts: fresh hooks over the same world and the same store. */
  restart(): FullSessionHooks;
  dispose(): void;
}

export interface SessionHooksHost {
  /** Names the host in the suite's output. */
  readonly name: string;
  open(): SessionHooksRig;
}

const TITLE = "Add rate limiting";

function config(root: string): Config {
  return {
    dry_run: true,
    github: {
      repo: "exampleorg/example-app",
      app_slug: "example-review",
      bot_login: "example-review[bot]",
      review_team: "exampleorg/review",
      trigger_label: "AI review requested",
      in_progress_label: "AI review in progress",
      reviewed_label: "Automatic Review",
      improvement_label: "Bot improvement",
      issue_label: "bot-filed",
      secrets_dir: join(root, "secrets"),
    },
    server: { hostname: "h", port: 8787 },
    daemon: {
      poll_interval_s: 300,
      max_concurrent_rounds: 6,
      round_deadline_min: 45,
      overseer_rotation_days: 7,
    },
    eod: { time: "18:00", timezone: "Europe/Warsaw" },
    caps: {
      improvement_pr_max_lines: 50,
      improvement_pr_max_files: 3,
      improvement_pr_per_day: 1,
      improvement_pr_per_week: 3,
      issues_per_day: 3,
    },
    models: {
      default: "openai/gpt-5.6-sol",
      conversation: "openai/conv",
      overseer: "openai/over",
      passes: {},
    },
    pi: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.4",
      session_dir: "state/pi-sessions",
      subagent_max_concurrency: 6,
    },
    openviking: { host: "127.0.0.1", port: 1933, config_file: join(root, "ovhome", "ov.conf") },
  } as unknown as Config;
}

function openTmuxHost(): SessionHooksRig {
  const root = mkdtempSync(join(tmpdir(), "qcr-hooks-conformance-"));
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "prompts", "conversation-system.md"),
    "Shepherd of PR #{{n}} ({{title}}) at {{worktree}}.\n",
  );
  writeFileSync(join(root, "prompts", "overseer-system.md"), "You are the overseer.\n");
  writeFileSync(join(root, "secrets", "openai_api_key"), "sk-app-key\n");

  const live = new Set<string>();
  const wedged = new Set<string>();
  const lifecycle: string[] = [];
  let onBirth: ((session: string) => void) | undefined;
  let onKill: ((session: string) => void) | undefined;
  // The recording fake: tmux answers from `live`, and a new session's bridge
  // reports ready the way the real one does once pi is up.
  const exec: ExecFn = async (cmd, args) => {
    if (cmd !== "tmux") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "list-sessions") return { code: 0, stdout: [...live].join("\n"), stderr: "" };
    if (args[0] === "has-session")
      return { code: live.has(String(args[2]).replace(/^=/, "")) ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "new-session") {
      const session = String(args[3]);
      live.add(session);
      lifecycle.push(`birth ${session}`);
      onBirth?.(session);
      const generation = args
        .find((value) => value.startsWith("QCR_SESSION_BRIDGE_GENERATION="))
        ?.split("=", 2)[1];
      const stateFile = args
        .find((value) => value.startsWith("QCR_SESSION_BRIDGE_STATE_FILE="))
        ?.slice("QCR_SESSION_BRIDGE_STATE_FILE=".length);
      if (generation && stateFile)
        writeSessionBridgeState(stateFile, {
          version: 1,
          session,
          generation,
          stage: "ready",
          run_status: "idle",
          compaction: { state: "idle", seq: 0 },
          updated_at: HOST_NOW.toISOString(),
        });
    }
    if (args[0] === "kill-session") {
      const name = String(args[2]).replace(/^=/, "");
      lifecycle.push(`kill ${name}`);
      onKill?.(name);
      if (!wedged.has(name)) live.delete(name);
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const store = new StateStore(join(root, "state", "state.db"), () => HOST_NOW);
  const build = (): PiSessionManager => {
    const m = new PiSessionManager({
      cfg: config(root),
      root,
      tmux: new Tmux({ exec }),
      worktrees: new WorktreeManager({
        root,
        repo: "o/n",
        cloneDir: "example-app",
        cloneUrl: "/dev/null",
        run: exec,
      }),
      piHome: join(root, "pihome"),
      ovSessions: { create: async () => true, remove: async () => true },
      now: () => HOST_NOW,
      commandStore: store,
    });
    // A tracked PR can be woken out of round; the registry knows its title.
    m.setTitleResolver((pr) => store.getPr(pr)?.title ?? undefined);
    return m;
  };
  let manager = build();

  const jsonlFor = (pr: number): string => {
    const dir = join(manager.sessionDir(prSessionName(pr)), "--home-sandbox--");
    mkdirSync(dir, { recursive: true });
    return join(dir, "2026-08-13T10-00-01-000Z_abc.jsonl");
  };

  return {
    get hooks() {
      return manager as unknown as FullSessionHooks;
    },
    store,
    isRunning: (session) => live.has(session),
    seedRunningSession(session) {
      const generation = `existing-${session}`;
      live.add(session);
      mkdirSync(join(root, "state", "sessions"), { recursive: true });
      writeFileSync(
        join(root, "state", "sessions", `${session}.json`),
        `${JSON.stringify({ session, born_at: "2026-08-13T09:00:00.000Z", bridge_generation: generation })}\n`,
      );
      writeSessionBridgeState(manager.bridgeStatePath(session, generation), {
        version: 1,
        session,
        generation,
        stage: "ready",
        updated_at: "2026-08-13T09:00:00.000Z",
      });
    },
    mailbox(session) {
      const dir = manager.injectDir(session);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => readFileSync(join(dir, f), "utf8"));
    },
    settleDelivered(pr) {
      const session = prSessionName(pr);
      const row = store.activeSessionCommand(session);
      if (!row) return;
      if (!store.claimSessionCommand(row.id, "conformance-bridge", HOST_NOW.toISOString()))
        throw new Error(`could not claim ${row.id}`);
      store.markSessionCommandStarted(row.id, "conformance-bridge", HOST_NOW.toISOString());
      store.finishSessionCommand(row.id, "conformance-bridge", "acked");
      rmSync(row.inject_path, { force: true });
    },
    consumeMailbox(session) {
      const dir = manager.injectDir(session);
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) if (f.endsWith(".md")) rmSync(join(dir, f));
    },
    staleBridge(session) {
      writeSessionBridgeState(manager.bridgeStatePath(session, `existing-${session}`), {
        version: 1,
        session,
        generation: "stale-generation",
        stage: "ready",
        updated_at: "2026-08-13T09:59:00.000Z",
      });
    },
    killOutOfBand: (session) => void live.delete(session),
    recordAccepted(pr, text) {
      writeFileSync(
        jsonlFor(pr),
        `${JSON.stringify({ message: { role: "user", content: [{ type: "text", text }] } })}\n`,
      );
    },
    recordActivity(pr) {
      writeFileSync(
        jsonlFor(pr),
        `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working" }] } })}\n`,
      );
    },
    wedgeSession: (session) => void wedged.add(session),
    lifecycle: () => [...lifecycle],
    onBirth(fn) {
      onBirth = fn;
    },
    onKill(fn) {
      onKill = fn;
    },
    restart() {
      manager = build();
      return manager as unknown as FullSessionHooks;
    },
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const tmuxHost: SessionHooksHost = { name: "tmux", open: openTmuxHost };

/** Every host the contract runs against. */
export const SESSION_HOSTS: SessionHooksHost[] = [tmuxHost];

/** A tracked (or closed) PR in the registry, the title the host wakes it by. */
export function trackPr(
  store: StateStore,
  pr: number,
  state: "tracked" | "closed" = "tracked",
): void {
  store.upsertPr({
    number: pr,
    state,
    head_sha: "abc123",
    title: TITLE,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
