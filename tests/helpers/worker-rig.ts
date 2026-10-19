// The world a bot worker runs in, for the tests of src/botworker.ts (P8.3): a
// production-shaped root of its own (so scripts/ and verdict/ are real and
// private), an agent dir with a login and the lens agents, a
// round's task files, and a FAKE DAEMON: a real IpcServer on a real unix socket
// serving `worker.spec`, `wakes.take` and `wakes.ack` and recording every event
// the worker sends. No model is involved; the worker's session talks to a faux
// provider or to a loopback endpoint, whichever the test gives its host.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CapabilityStore, socketPathOf } from "../../src/ipc/capability.js";
import { CONTROL_ACK_OP, parseControlAck, type ControlAck } from "../../src/ipc/control.js";
import { IpcClient } from "../../src/ipc/client.js";
import { PermitBroker, permitOps } from "../../src/ipc/permits.js";
import type { CommandState, IpcEventKind } from "../../src/ipc/protocol.js";
import { IpcServer } from "../../src/ipc/server.js";
import {
  WAKES_ACK_OP,
  WAKES_TAKE_OP,
  WORKER_SPEC_OP,
  type WakeBatch,
  type WorkerSpec,
} from "../../src/ipc/workerspec.js";
import { sessionGitConfigPins } from "../../src/sessions.js";
import { loadConfig } from "../../src/config.js";
import { MutationGate, type MutationIntent } from "../../src/gate.js";
import { GitHubAdapter } from "../../src/github.js";
import type { TokenMinter } from "../../src/githubAuth.js";
import { makePostingGuard } from "../../src/guards.js";
import { PostingJournal } from "../../src/posting-journal.js";
import { registerPostOps } from "../../src/postops.js";
import { StateStore } from "../../src/state.js";
import { BOT, FakeGitHub, HEAD, KEY, REPO as GH_REPO } from "./post-ops-rig.js";

export const REPO = resolve(import.meta.dirname, "..", "..");
export const PR = 7;
export const SESSION = `pr-${PR}`;

/** What the stub post client records of the shim's environment. */
export const POST_LOG = "post-shim.log";

export interface WorkerEvent {
  kind: IpcEventKind;
  body: Record<string, unknown>;
}

export interface World {
  dir: string;
  root: string;
  agentDir: string;
  sessionDir: string;
  lensDir: string;
  /** `<root>/state/pr-7-round-<k>-passes` */
  passes(round: number): string;
  /** The spec the fake daemon answers `worker.spec` with, for command `id`. */
  spec(id: string, order: string, over?: Partial<WorkerSpec>): WorkerSpec;
  /** Stage the verdict file the model's write tool would have written. */
  stageVerdict(round: number): void;
  /** What the stub post client recorded, one object per post. */
  posts(): Array<{ argv: string[]; ipc: string[]; round: string | null; cap: string | null }>;
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** A production-shaped root of this world's own: everything of the repo's tree
 * by symlink except the directories a worker writes (state/, verdict/), and
 * scripts/ copied so the verdict and post scripts resolve their root HERE. */
export function buildWorld(prefix = "botworker-"): World {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const root = join(dir, "root");
  mkdirSync(root);
  const own = new Set([".git", "state", "wt", "node_modules", "verdict", "scripts", "dist"]);
  for (const e of readdirSync(REPO)) if (!own.has(e)) symlinkSync(join(REPO, e), join(root, e));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "verdict"));
  mkdirSync(join(root, "scripts"));
  for (const f of ["commit-verdict.sh", "post-review.sh", "approve-pr.sh", "reply-thread.sh"]) {
    copyFileSync(join(REPO, "scripts", f), join(root, "scripts", f));
    chmodSync(join(root, "scripts", f), 0o755);
  }
  // The post client the scripts hand over to: a stub that records what the
  // shim would have been given (the real one needs the built tree).
  mkdirSync(join(root, "dist", "src", "ipc"), { recursive: true });
  writeFileSync(
    join(root, "dist", "src", "ipc", "postshim.js"),
    [
      "const fs = process.getBuiltinModule('node:fs');",
      "const names = Object.keys(process.env).filter((k) => k.startsWith('QCR_IPC_')).sort();",
      "// The capability, read the way the real client reads it: pread at offset 0 of the inherited fd.",
      "const buf = Buffer.alloc(32);",
      "let cap = null;",
      "try { fs.readSync(Number(process.env.QCR_IPC_CAP_FD), buf, 0, 32, 0); cap = buf.toString(); } catch (e) { cap = String(e); }",
      "fs.appendFileSync(process.env.QCR_TEST_LOG, JSON.stringify({",
      "  argv: process.argv.slice(2), ipc: names, round: process.env.QCR_ROUND_NO ?? null, cap,",
      "}) + '\\n');",
      "console.log('recorded');",
      "",
    ].join("\n"),
  );
  const agentDir = join(dir, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  // The owner's login as the refresher keeps it: a live OAuth token and a real
  // refresh token, which the worker may never use or write.
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "A-TOKEN",
        refresh: "REAL-REFRESH",
        expires: Date.now() + 24 * 3_600_000,
      },
    }),
  );
  for (const a of ["pass-a", "pass-b"])
    writeFileSync(
      join(agentDir, "agents", `${a}.md`),
      `---\nname: ${a}\ndescription: ${a} lens\nmodel: faux/faux-1\ntools: read, bash\n---\nYou are ${a}.\n`,
    );
  const sessionDir = join(root, "state", "pi-sessions", SESSION);
  const lensDir = join(root, "state", "lens", SESSION, "r1");
  writeFileSync(join(dir, "system.md"), "You are the reviewer of PR 7.\n");
  const home = join(dir, "home");
  mkdirSync(home);
  const logFile = join(dir, POST_LOG);

  const world: World = {
    dir,
    root,
    agentDir,
    sessionDir,
    lensDir,
    passes: (round) => join(root, "state", `pr-${PR}-round-${round}-passes`),
    spec(id, order, over = {}) {
      const payload = join(dir, "commands", `${id}.md`);
      mkdirSync(join(dir, "commands"), { recursive: true });
      writeFileSync(payload, order);
      mkdirSync(join(dir, "workers"), { recursive: true });
      return {
        mode: "round",
        command_id: id,
        pr: PR,
        session: SESSION,
        round_no: 1,
        payload_path: payload,
        payload_sha256: sha(order),
        root,
        cwd: root,
        agent_dir: agentDir,
        session_dir: sessionDir,
        system_prompt_file: join(dir, "system.md"),
        model: "faux/faux-1",
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: home,
          LANG: "C.UTF-8",
          QCR_SANDBOX_ROOT: root,
          QCR_SESSION_NAME: SESSION,
          QCR_PR: String(PR),
          QCR_ROUND_NO: "1",
          QCR_EXPECTED_HEAD: "a".repeat(40),
          QCR_POSTING_KEY: "pr-7-r1",
          QCR_LEDGER_FILE: join(root, "state", "ledgers", `${SESSION}.md`),
          QCR_SUBAGENT_MAX_CONCURRENCY: "4",
          QCR_SUBAGENT_WIDE_FANOUT: "1",
          QCR_SUBAGENT_CACHE_GROUP: "0",
          QCR_SUBAGENT_PASS_DEADLINE_MIN: "0",
          QCR_TEST_LOG: logFile,
          OPENVIKING_USER: "reviewer",
          OPENVIKING_PEER_ID: SESSION,
          ...sessionGitConfigPins(home),
        },
        events_file: join(dir, "workers", `${id}.events.jsonl`),
        stderr_file: join(dir, "workers", `${id}.pi-stderr.log`),
        wall_clock_ms: 60_000,
        planned_wave: false,
        lens_dir: lensDir,
        heartbeat_ms: 60_000,
        ...over,
      };
    },
    stageVerdict(round) {
      writeFileSync(
        join(root, "verdict", `pr-${PR}-round-${round}.json.tmp`),
        JSON.stringify({
          pr: PR,
          round_no: round,
          verdict: "APPROVE",
          head_sha: "a".repeat(40),
          passes: [],
        }),
      );
    },
    posts() {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as {
              argv: string[];
              ipc: string[];
              round: string | null;
              cap: string | null;
            },
        );
    },
  };
  return world;
}

/** Task files for a round's planned wave: one discovery row per agent. */
export function writeTasks(world: World, round: number, agents: readonly string[]): string {
  const tasks = join(world.passes(round), "tasks");
  mkdirSync(tasks, { recursive: true });
  agents.forEach((agent, i) =>
    writeFileSync(
      join(tasks, `${String(i + 1).padStart(2, "0")}-${agent}.md`),
      `Review as ${agent}.\n`,
    ),
  );
  return tasks;
}

/** A real IpcServer on a real unix socket, standing in for the daemon. */
export class FakeDaemon {
  readonly caps = new CapabilityStore();
  readonly rows = new Map<string, CommandState>();
  readonly specs = new Map<string, WorkerSpec>();
  readonly events: WorkerEvent[] = [];
  readonly requests: Array<{ op: string; body: unknown }> = [];
  /** What `wakes.take` answers, one entry per call; an empty queue answers none. */
  readonly wakes: WakeBatch[][] = [];
  /** Runs inside `wakes.take`, before it answers; a test drops the connection here. */
  onTake: (() => Promise<void>) | undefined;
  readonly acked: string[] = [];
  /** The worker's `control.ack`s (P8.12), in arrival order. */
  readonly controlAcks: ControlAck[] = [];
  /** The daemon's real permit broker (P8.10), no stagger: a worker's passes ask it. */
  readonly permits = new PermitBroker({ ceiling: 20, staggerMs: 0 });
  /** The lens ids that asked the broker for a permit, in order. */
  readonly permitAsks: string[] = [];
  readonly server: IpcServer;
  readonly sock: string;
  private readonly clients: IpcClient[] = [];

  constructor() {
    const ask = this.permits.acquire.bind(this.permits);
    this.permits.acquire = (who, lensId, weight) => (
      this.permitAsks.push(lensId),
      ask(who, lensId, weight)
    );
    const sockDir = mkdtempSync(join(tmpdir(), "bw-sock-"));
    this.sock = socketPathOf(sockDir);
    this.server = new IpcServer({
      socketPath: this.sock,
      capabilities: this.caps,
      commands: (id) => this.rows.get(id) ?? null,
      helloTimeoutMs: 1000,
      onEvent: (ctx, kind, body) => {
        this.events.push({ kind, body: (body ?? {}) as Record<string, unknown> });
        void ctx;
      },
      ops: {
        ...permitOps(this.permits),
        [WORKER_SPEC_OP]: {
          roles: ["worker"],
          handle: (ctx) => {
            this.requests.push({ op: WORKER_SPEC_OP, body: undefined });
            const spec = this.specs.get(ctx.commandId);
            if (!spec) throw new Error("no spec");
            return spec;
          },
        },
        [CONTROL_ACK_OP]: {
          roles: ["worker"],
          handle: (_ctx, body) => {
            this.controlAcks.push(parseControlAck(body));
            return {};
          },
        },
        [WAKES_TAKE_OP]: {
          roles: ["worker"],
          handle: async () => {
            this.requests.push({ op: WAKES_TAKE_OP, body: undefined });
            await this.onTake?.();
            return { batches: this.wakes.shift() ?? [] };
          },
        },
        [WAKES_ACK_OP]: {
          roles: ["worker"],
          handle: (_ctx, body) => {
            this.requests.push({ op: WAKES_ACK_OP, body });
            this.acked.push((body as { id: string }).id);
            return {};
          },
        },
      },
    });
  }

  start(): Promise<void> {
    return this.server.start();
  }

  stop(): Promise<void> {
    this.permits.stop();
    return this.server.stop();
  }

  /** Register a command the worker will be started for. */
  command(spec: WorkerSpec, over: Partial<CommandState> = {}): void {
    this.specs.set(spec.command_id, spec);
    this.rows.set(spec.command_id, {
      pr: spec.pr,
      generation: 1,
      active: true,
      may_post: false,
      lease: "none",
      ...over,
    });
    this.caps.mint(spec.command_id);
  }

  /** A daemon that predates an op: it answers `unknown_op`. */
  forget(op: string): void {
    delete (this.server as unknown as { ops: Record<string, unknown> }).ops[op];
  }

  /** The worker's end: a connected client, as `connectFromEnv` builds it. */
  async connect(commandId: string): Promise<IpcClient> {
    const client = await IpcClient.connect({
      socketPath: this.sock,
      role: "worker",
      commandId,
      capability: this.caps.get(commandId)!,
      generation: 1,
      timeoutMs: 5000,
    });
    this.clients.push(client);
    return client;
  }

  /** Push the operator's control to a command's worker, as the supervisor does. */
  control(commandId: string, kind: string, body: Record<string, unknown>): number {
    return this.server.push(commandId, kind, body);
  }

  kinds(): IpcEventKind[] {
    return this.events.map((e) => e.kind);
  }

  of(kind: IpcEventKind): WorkerEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  progress(stage: string): WorkerEvent[] {
    return this.of("progress").filter((e) => e.body["stage"] === stage);
  }
}

/** The daemon's REAL post ops on the fake daemon's socket, in dry-run: the real
 * MutationGate and posting guards over a scripted GitHub, the real receipt and
 * outbox journal. A post the worker's shims make lands under `<root>/state/dryrun/`
 * and nowhere else. Round 1 of PR 7 reviewed `HEAD`; the world's spec must carry
 * that head and posting key (`postingEnv`). */
export function registerDryRunPosting(
  daemon: FakeDaemon,
  world: World,
): { gh: FakeGitHub; dryrun(): Array<Record<string, unknown>> } {
  const state = join(world.root, "state");
  const dryrunDir = join(state, "dryrun");
  const cfg = { ...loadConfig(join(REPO, "tests/fixtures/config.toml")), dry_run: true };
  cfg.github.repo = GH_REPO;
  const store = new StateStore(":memory:");
  const gh = new FakeGitHub();
  const minter = {
    installationToken: async () => "t",
    appJwt: () => "j",
    invalidate: () => {},
  } as unknown as TokenMinter;
  const gate: MutationGate = new MutationGate(
    true,
    dryrunDir,
    (intent: MutationIntent): Promise<unknown> => adapter.executeMutation(intent),
  );
  const adapter: GitHubAdapter = new GitHubAdapter(cfg, minter, gate, gh.fetch as never);
  gate.setGuard(
    makePostingGuard({ store, adapter, botLogin: cfg.github.bot_login, guards: cfg.guards }),
  );
  registerPostOps(daemon.server, {
    root: world.root,
    adapter,
    store,
    journal: new PostingJournal({ dir: join(state, "posting-receipts"), repo: GH_REPO }),
    cfg,
    botLogins: [BOT],
    roundOf: () => ({ round_no: 1, head_sha: HEAD }),
  });
  return {
    gh,
    dryrun: () =>
      existsSync(dryrunDir)
        ? readdirSync(dryrunDir)
            .sort()
            .map((f) => JSON.parse(readFileSync(join(dryrunDir, f), "utf8")))
        : [],
  };
}

/** The round identity the post shims carry in env, matching the dry-run posting rig. */
export const postingEnv = { QCR_EXPECTED_HEAD: HEAD, QCR_POSTING_KEY: KEY } as const;
