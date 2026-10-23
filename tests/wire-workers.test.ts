// [P8.15w] The worker world is the bot's only host, and wire.ts says so.
//
// Two halves. The source half pins what wire.ts and the tree must not do again: build the tmux
// manager as the bot host, bind it to the durable command store (its inject-file restore would
// write a worker command's `worker:<id>` path into the cwd), or let any module birth a `pr-<n>`
// session through it. The behaviour half builds the assembly (src/workerworld.ts) and shows the
// spec a worker is given carries what a tmux round's pi saw.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { roundPostingKey } from "../src/posting-receipt.js";
import { PiSessionManager } from "../src/sessions.js";
import { StateStore } from "../src/state.js";
import { PermitBroker } from "../src/ipc/permits.js";
import { WorkerSessionHost } from "../src/worker-session-host.js";
import { WORKER_ENV_DROPPED, buildWorkerWorld, workerSessionEnv } from "../src/workerworld.js";
import type { ExecFn } from "../src/tmux.js";
import type { WorkerSpec } from "../src/ipc/workerspec.js";
import type { SessionCommandRow } from "../src/state.js";

const SRC = resolve(import.meta.dirname, "..", "src");
const wire = readFileSync(join(SRC, "wire.ts"), "utf8");

describe("wire.ts: workers are the only bot host", () => {
  it("the bot host is the worker host, with no switch to the tmux manager", () => {
    expect(wire).toMatch(/const botHost: SessionHooks = workerWorld\.host;/);
    expect(wire).not.toMatch(/botHost: SessionHooks = sessions/);
    expect(wire).toMatch(/hooks: botHost,/);
  });

  it("the tmux manager is never bound to the durable command store or a PR title", () => {
    expect(wire).not.toContain("sessions.setCommandStore");
    expect(wire).not.toContain("sessions.setTitleResolver");
    expect(wire).not.toContain("sessions.setBeforeBirth");
    expect(wire).not.toContain("sessions.killSession");
  });

  it("no module outside the tmux manager births a PR session through it", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && e.name !== "sessions.ts") {
          if (/\.(ensurePrSession|spawnPrSession)\(/.test(readFileSync(p, "utf8"))) callers.push(p);
        }
      }
    };
    walk(SRC);
    walk(resolve(SRC, "..", "packages", "pi-plugin", "src"));
    expect(callers).toEqual([]);
  });

  it("the daemon starts the worker world before it asks which workers run, and stops it", () => {
    expect(wire).toMatch(
      /await workerWorld\.start\(\);[\s\S]*?const pre = await sessions\.preflight/,
    );
    expect(wire).toMatch(/await workerWorld\.stop\(\);/);
    expect(wire).toMatch(/operatorControl: workerWorld\.operatorControl,/);
    expect(wire).toMatch(/runtimeOf: workerWorld\.runtimeOf,/);
  });
});

// ---- the assembly ---------------------------------------------------------------

let dir: string;
let store: StateStore;
const worlds: Array<ReturnType<typeof buildWorkerWorld>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wire-workers-"));
  store = new StateStore(":memory:");
});
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.stop().catch(() => {});
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function rig(over: Partial<Config["openviking"]> = {}) {
  const root = join(dir, "root");
  mkdirSync(join(root, "state"), { recursive: true });
  symlinkSync(resolve(SRC, "..", "prompts"), join(root, "prompts"));
  const base = loadConfig(resolve(SRC, "..", "tests/fixtures/config.toml"));
  const cfg: Config = {
    ...base,
    dry_run: true,
    models: { ...base.models, conversation: "local/m" },
    openviking: { ...base.openviking, enabled: true, ...over },
  };
  const tmuxCalls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    tmuxCalls.push([cmd, ...args.map(String)]);
    return { code: 1, stdout: "", stderr: "" };
  };
  const sessions = new PiSessionManager({ cfg, root, exec, configPath: join(dir, "config.toml") });
  const world = buildWorkerWorld({
    cfg,
    root,
    store,
    adapter: {} as never,
    sessions,
    permits: new PermitBroker({ ceiling: 4, staggerMs: 0 }),
    agentDir: join(dir, "agent"),
    pump: async () => {},
    log: () => {},
  });
  worlds.push(world);
  store.upsertPr({
    number: 7,
    state: "tracked",
    head_sha: "a".repeat(40),
    title: "Add rate limiting",
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  const specOf = (row: SessionCommandRow, mode: "round" | "answer" = "round"): WorkerSpec =>
    (
      world.supervisor as unknown as {
        deps: { buildSpec: (r: SessionCommandRow, m: "round" | "answer") => WorkerSpec };
      }
    ).deps.buildSpec(row, mode);
  return { cfg, root, sessions, world, tmuxCalls, specOf };
}

describe("the worker world", () => {
  it("is the WorkerSessionHost over the engine's lens tools, and births no tmux session", async () => {
    const r = rig();
    expect(r.world.host).toBeInstanceOf(WorkerSessionHost);
    expect(r.world.host.lensRuntime).toBe("engine");
    expect(r.world.runtimeOf(7)).toBe("idle");
    // A wake for a PR with a title and no running worker starts a worker, never a tmux session.
    await r.world.host.inject(7, "a wake").catch(() => {});
    expect(r.tmuxCalls.filter((c) => c.some((a) => /pr-\d+/.test(a)))).toEqual([]);
    expect(r.tmuxCalls.filter((c) => c.includes("new-session"))).toEqual([]);
  });

  it("gives a worker the environment a tmux round's pi had, bar the names it does not use", () => {
    const r = rig();
    const round = store.startRound(7, "first", ["pass-baseline"], 75);
    const roundNo = (
      store.db.prepare("SELECT round_no FROM rounds WHERE id=?").get(round) as {
        round_no: number;
      }
    ).round_no;
    const head = "b".repeat(40);
    store.db
      .prepare("UPDATE rounds SET posting_key=? WHERE id=?")
      .run(roundPostingKey(7, roundNo, head), round);
    const command = r.world.supervisor.submit({
      pr: 7,
      kind: "round",
      round_no: roundNo,
      payload: "the order",
    });
    const spec = r.specOf(command);

    const tmuxEnv = r.sessions.buildEnv("pr-7", {});
    for (const [name, value] of Object.entries(tmuxEnv)) {
      if (value === undefined || WORKER_ENV_DROPPED.includes(name)) continue;
      expect(spec.env[name], name).toBe(value);
    }
    // The pieces the ticket names: the memory identity and the config-scope pins.
    expect(spec.env["OPENVIKING_PEER_ID"]).toBe("pr-7");
    expect(spec.env["QCR_OV_SESSION_ID"]).toBeTruthy();
    expect(spec.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(spec.env["GIT_CONFIG_GLOBAL"]).toMatch(/\.gitconfig$/);
    // The round's identity, from its row; no model key, no inject bridge, no state database.
    expect(spec.env["QCR_ROUND_NO"]).toBe(String(roundNo));
    expect(spec.env["QCR_EXPECTED_HEAD"]).toBe(head);
    expect(spec.env["QCR_POSTING_KEY"]).toBe(roundPostingKey(7, roundNo, head));
    for (const name of WORKER_ENV_DROPPED) expect(spec.env).not.toHaveProperty(name);

    // The conversation prompt, rendered for this PR; the conversation model.
    expect(spec.model).toBe("local/m");
    const prompt = readFileSync(spec.system_prompt_file, "utf8");
    expect(prompt).toContain("Add rate limiting");
    expect(spec.env["QCR_WORKTREE"]).toBe(r.sessions.worktrees.worktreePath(7));
    expect(spec.session_dir).toBe(r.sessions.sessionDir("pr-7"));
    expect(spec).toMatchObject({ mode: "round", pr: 7, session: "pr-7", round_no: roundNo });
  });

  it("leaves a session no memory surface when memory is switched off", () => {
    const r = rig({ enabled: false });
    const command = r.world.supervisor.submit({
      pr: 7,
      kind: "wake",
      round_no: null,
      payload: "w",
    });
    const spec = r.specOf(command);
    expect(Object.keys(spec.env).filter((k) => /^(OPENVIKING_|QCR_OV_)/.test(k))).toEqual([]);
    expect(spec.env).not.toHaveProperty("QCR_ROUND_NO");
  });

  it("every name it drops is one the tmux route really sets (the list cannot go stale)", () => {
    const r = rig();
    const names = Object.keys(r.sessions.buildEnv("pr-7", {}));
    // Not every drop is present for every config (the model key needs a secret); the list may
    // only name things buildEnv can produce.
    const producible = new Set([...names, "OPENAI_API_KEY", "QCR_STATE_DB"]);
    for (const name of WORKER_ENV_DROPPED) expect(producible.has(name), name).toBe(true);
    expect(workerSessionEnv(r.sessions, "pr-7", {})).not.toHaveProperty("QCR_INJECT_DIR");
  });
});
