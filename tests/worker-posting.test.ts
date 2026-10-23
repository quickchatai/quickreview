// A worker's posts reach the daemon's one gate through the supervisor.
//
// The REAL WorkerSupervisor starts a fake worker process (no pi, no model); the
// real IpcServer serves the supervisor's lookup and ops, which now include the
// post ops (src/postops.ts) over the real gate in dry-run, with the round
// resolved from the command's own session_commands row. A post comes from a
// client holding the command's capability, as the shims do. The dry-run record
// is the only trace; a refusal leaves none.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MutationGate, type MutationIntent } from "@quickchatai/pi-quickreview/src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import type { TokenMinter } from "@quickchatai/pi-quickreview/src/githubAuth.js";
import { makePostingGuard } from "@quickchatai/pi-quickreview/src/guards.js";
import { CapabilityStore, socketPathOf } from "../src/ipc/capability.js";
import { IpcClient } from "../src/ipc/client.js";
import { IpcServer } from "../src/ipc/server.js";
import type { WorkerSpec } from "../src/ipc/workerspec.js";
import { PostingJournal } from "../src/posting-journal.js";
import { commandRoundOf, type PostOutcome } from "../src/postops.js";
import { StateStore, type SessionCommandRow } from "../src/state.js";
import { WorkerSupervisor } from "../src/workersupervisor.js";
import { BOT, FakeGitHub, HEAD, KEY, OTHER_PR, PR, REPO } from "./helpers/post-ops-rig.js";

const FAKE = resolve(import.meta.dirname, "helpers", "fake-worker.mjs");
const REPO_ROOT = resolve(import.meta.dirname, "..");

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}

let dir: string;
let stops: Array<() => Promise<unknown>>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wp-"));
  stops = [];
});
afterEach(async () => {
  for (const s of stops) await s().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function rig(opts: { headOf?: (pr: number, round: number) => string | undefined } = {}) {
  const root = join(dir, "root");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const cfg = { ...loadConfig(join(REPO_ROOT, "tests/fixtures/config.toml")), dry_run: true };
  cfg.github.repo = REPO;
  const store = new StateStore(":memory:");
  const gh = new FakeGitHub();
  const minter = {
    installationToken: async () => "t",
    appJwt: () => "j",
    invalidate: () => {},
  } as unknown as TokenMinter;
  const gate: MutationGate = new MutationGate(true, join(state, "dryrun"), (i: MutationIntent) =>
    adapter.executeMutation(i),
  );
  const adapter: GitHubAdapter = new GitHubAdapter(cfg, minter, gate, gh.fetch as never);
  gate.setGuard(
    makePostingGuard({ store, adapter, botLogin: cfg.github.bot_login, guards: cfg.guards }),
  );
  const caps = new CapabilityStore();
  const runDir = join(dir, "run");
  const sup = new WorkerSupervisor({
    store,
    capabilities: caps,
    runDir,
    socketPath: socketPathOf(runDir),
    workerMain: FAKE,
    logDir: join(dir, "logs"),
    payloadDir: join(dir, "payloads"),
    buildSpec: (row: SessionCommandRow, mode): WorkerSpec => ({
      mode,
      command_id: row.id,
      pr: row.pr,
      session: row.session,
      round_no: row.round_no,
      payload_path: row.payload_path,
      payload_sha256: row.payload_sha256,
      root,
      cwd: root,
      agent_dir: join(dir, "agent"),
      session_dir: join(dir, "sessions"),
      system_prompt_file: join(dir, "system.md"),
      model: "faux/faux-1",
      env: { PATH: process.env["PATH"] ?? "/usr/bin" },
      events_file: join(dir, "ev.jsonl"),
      stderr_file: join(dir, "err.log"),
      wall_clock_ms: 60_000,
      planned_wave: false,
    }),
    parentEnv: { PATH: process.env["PATH"] ?? "/usr/bin" },
    extraEnv: { FAKE_WORKER_MODE: "term-ok" },
    limits: { tickMs: 20, killGraceMs: 200, wallGraceMs: 0 },
    post: {
      root,
      adapter,
      store,
      journal: new PostingJournal({ dir: join(state, "posting-receipts"), repo: REPO }),
      cfg,
      botLogins: [BOT],
      roundOf: commandRoundOf(store, opts.headOf ?? (() => HEAD)),
    },
  });
  const server = new IpcServer({
    socketPath: socketPathOf(runDir),
    capabilities: caps,
    commands: sup.lookup,
    ops: sup.ops(),
    onEvent: sup.onEvent,
    helloTimeoutMs: 2000,
  });
  stops.push(
    () => sup.stop(),
    () => server.stop(),
    async () => store.close(),
  );
  mkdirSync(runDir, { recursive: true });
  await server.start();
  const roundId = store.startRound(PR, "first", ["pass-baseline"], 75);
  const roundNo = (
    store.db.prepare("SELECT round_no FROM rounds WHERE id=?").get(roundId) as { round_no: number }
  ).round_no;
  const connect = async (id: string, generation: number): Promise<IpcClient> => {
    const c = await IpcClient.connect({
      socketPath: socketPathOf(runDir),
      role: "shim",
      commandId: id,
      capability: caps.get(id)!,
      generation,
      timeoutMs: 5000,
    });
    stops.push(async () => c.close());
    return c;
  };
  const dryrun = (): unknown[] => {
    const d = join(state, "dryrun");
    return existsSync(d)
      ? readdirSync(d).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")))
      : [];
  };
  const result = (name: string, text = "**Verdict** fine."): string => {
    const p = join(state, name);
    writeFileSync(p, text);
    return p;
  };
  return { sup, store, gh, caps, roundNo, connect, dryrun, result, state };
}

describe("a worker posts through the supervisor's ops to the one gate", () => {
  it("a round's review lands in state/dryrun/ keyed by the command's own round, and replies with its outcome", async () => {
    const r = await rig();
    const row = r.sup.submit({ pr: PR, kind: "round", round_no: r.roundNo, payload: "order" });
    const info = await r.sup.launch(row.id);
    await until(() => r.store.getSessionCommand(row.id)!.started_at !== null);
    const c = await r.connect(row.id, info.generation);
    const out = await c.request<PostOutcome>(
      "post.review",
      {
        pr: PR,
        event: "COMMENT",
        body_file: r.result(`pr-${PR}-round-1-review.md`),
        posting_key: KEY,
        expected_head: HEAD,
      },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    expect(r.gh.posts()).toEqual([]);
    const recs = r.dryrun() as Array<{ body: { body: string } }>;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.body.body).toContain(KEY);
  });

  it("refuses a post for another PR than the command's, and a path outside the PR's files", async () => {
    const r = await rig();
    const row = r.sup.submit({ pr: PR, kind: "round", round_no: r.roundNo, payload: "order" });
    const info = await r.sup.launch(row.id);
    await until(() => r.store.getSessionCommand(row.id)!.started_at !== null);
    const c = await r.connect(row.id, info.generation);
    await expect(
      c.request(
        "post.review",
        { pr: OTHER_PR, event: "COMMENT", body_file: r.result(`pr-${OTHER_PR}-r.md`) },
        { pr: OTHER_PR },
      ),
    ).rejects.toMatchObject({ code: "wrong_pr" });
    await expect(
      c.request(
        "post.review",
        { pr: PR, event: "COMMENT", body_file: r.result(`pr-${OTHER_PR}-round-1-review.md`) },
        { pr: PR },
      ),
    ).rejects.toMatchObject({ code: "bad_path" });
    expect(r.dryrun()).toEqual([]);
  });

  it("refuses another command's capability, a capability minted for another command", async () => {
    const r = await rig();
    const row = r.sup.submit({ pr: PR, kind: "round", round_no: r.roundNo, payload: "order" });
    await r.sup.launch(row.id);
    await until(() => r.store.getSessionCommand(row.id)!.started_at !== null);
    const otherCap = r.caps.mint("another-command");
    await expect(
      IpcClient.connect({
        socketPath: socketPathOf(join(dir, "run")),
        role: "shim",
        commandId: row.id,
        capability: otherCap,
        generation: 1,
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(r.dryrun()).toEqual([]);
  });

  it("refuses a post once the command is no longer the live one", async () => {
    const r = await rig();
    const row = r.sup.submit({ pr: PR, kind: "round", round_no: r.roundNo, payload: "order" });
    const info = await r.sup.launch(row.id);
    await until(() => r.store.getSessionCommand(row.id)!.started_at !== null);
    const c = await r.connect(row.id, info.generation);
    r.sup.kill(row.id);
    await until(() => !r.sup.isLive(`pr-${PR}`));
    await expect(
      c.request(
        "post.review",
        { pr: PR, event: "COMMENT", body_file: r.result(`pr-${PR}-round-1-review.md`) },
        { pr: PR },
      ),
    ).rejects.toBeDefined();
    expect(r.dryrun()).toEqual([]);
  });
});

describe("commandRoundOf", () => {
  const store = (row: Partial<SessionCommandRow> | undefined) =>
    ({ getSessionCommand: () => row }) as never;
  it("keys only a round command, by its own round and the order's head", () => {
    const of = commandRoundOf(store({ pr: PR, kind: "round", round_no: 3 }), () => HEAD);
    expect(of("c", PR)).toEqual({ round_no: 3, head_sha: HEAD });
  });
  it("gives an answer, wake or unknown command no round", () => {
    expect(
      commandRoundOf(store({ pr: PR, kind: "wake", round_no: null }), () => HEAD)("c", PR),
    ).toBeNull();
    expect(commandRoundOf(store(undefined), () => HEAD)("c", PR)).toBeNull();
    expect(
      commandRoundOf(store({ pr: PR, kind: "round", round_no: 1 }), () => HEAD)("c", OTHER_PR),
    ).toBeNull();
  });
  it("refuses a round whose head is unknown rather than posting it unkeyed", () => {
    const of = commandRoundOf(store({ pr: PR, kind: "round", round_no: 1 }), () => undefined);
    expect(() => of("c", PR)).toThrowError(/head round 1 reviewed is unknown/);
  });
});
