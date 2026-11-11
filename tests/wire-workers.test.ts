// The worker world is the bot's only host, and wire.ts says so.
//
// Two halves. The source half pins what wire.ts and the tree must not do again: build the tmux
// manager as the bot host, bind it to the durable command store (its inject-file restore would
// write a worker command's `worker:<id>` path into the cwd), or let any module birth a `pr-<n>`
// session through it. The behaviour half builds the assembly (src/workerworld.ts) and shows the
// spec a worker is given carries what a tmux round's pi saw.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { roundPostingKey } from "../src/posting-receipt.js";
import { PiSessionManager } from "../src/sessions.js";
import { StateStore } from "../src/state.js";
import { PermitBroker } from "../src/ipc/permits.js";
import { WorkerSessionHost } from "../src/worker-session-host.js";
import { CHECK_EVERY_MS, STATUS_FILE } from "../src/loginrefresh/refresher.js";
import type { LoginRefreshFileStatus } from "../src/loginrefresh/types.js";
import {
  LOGIN_OWNER_FRESH_MS,
  LOGIN_STATUS_FILE,
  WORKER_ENV_DROPPED,
  buildWorkerWorld,
  loginOwnerOf,
  workerSessionEnv,
} from "../src/workerworld.js";
import type { ExecFn } from "../src/tmux.js";
import { parseWorkerSpec, type WorkerSpec } from "../src/ipc/workerspec.js";
import { MODELS_TIER_DEFAULTS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
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

function rig(
  over: Partial<Config["openviking"]> = {},
  models: Partial<Config["models"]> = {},
  more: { loginRefresh?: boolean; loginDir?: string; now?: () => number } = {},
) {
  const root = join(dir, "root");
  mkdirSync(join(root, "state"), { recursive: true });
  symlinkSync(resolve(SRC, "..", "prompts"), join(root, "prompts"));
  const base = loadConfig(resolve(SRC, "..", "tests/fixtures/config.toml"));
  const cfg: Config = {
    ...base,
    dry_run: true,
    models: { ...base.models, model: "local/m", ...models },
    openviking: { ...base.openviking, enabled: true, ...over },
    login_refresh: { ...base.login_refresh, enabled: more.loginRefresh === true },
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
    ...(more.loginDir !== undefined ? { loginDir: more.loginDir } : {}),
    ...(more.now ? { now: more.now } : {}),
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

  const wake = (r: ReturnType<typeof rig>): WorkerSpec =>
    r.specOf(r.world.supervisor.submit({ pr: 7, kind: "wake", round_no: null, payload: "w" }));

  it("names a worker the providers a pinned config's models name", () => {
    // The main model's provider, then the tiers' (the fixture pins them).
    const spec = wake(rig());
    expect(spec.providers?.[0]).toBe("local");
    expect(spec.providers?.length).toBeGreaterThan(1);
  });

  // MUTATION: put `providers: reviewProviders(cfg)` back in buildSpec
  // (src/workerworld.ts) — the unpinned spec then carries `providers: []`, and
  // this fails.
  it("names a worker no provider and no model when the config pins none", () => {
    const spec = wake(
      rig({}, { model: "", tiers: { ...MODELS_TIER_DEFAULTS.tiers }, pass_models: {} }),
    );
    // An empty list would read as "no provider": the field is absent, the model
    // is the empty spec, and it is a spec the worker's own parser takes.
    expect(spec).not.toHaveProperty("providers");
    expect(spec.model).toBe("");
    expect(parseWorkerSpec(JSON.parse(JSON.stringify(spec))).model).toBe("");
  });

  // ---- login_owner: whether the refresher is renewing the login now ----------
  //
  // A worker takes a stored login shorter than its command only when something
  // renews it meanwhile. The daemon says so in the spec, from the refresher's
  // own status file beside the login, and only while that file shows a
  // refresher that is there, looking, not paused and not failing.

  const NOW = Date.parse("2026-11-11T12:00:00.000Z");
  const healthy = (over: Partial<LoginRefreshFileStatus> = {}): string =>
    JSON.stringify({
      pid: process.pid,
      started_at: "2026-11-11T08:00:00.000Z",
      expires_at: "2026-11-11T18:00:00.000Z",
      provider: "prov-a",
      last_refresh: "2026-11-11T11:00:00.000Z",
      last_error: null,
      error_since: null,
      paused: false,
      checked_at: new Date(NOW - 60_000).toISOString(),
      ...over,
    } satisfies LoginRefreshFileStatus);
  const owner = (statusText: string | null, enabled = true, alive = (): boolean => true): boolean =>
    loginOwnerOf({ enabled, statusText, now: NOW, alive });

  it("reads the refresher's own file by its name, and calls it fresh for two of its checks", () => {
    // The daemon does not import the refresher's module, so the two are held
    // together here.
    expect(LOGIN_STATUS_FILE).toBe(STATUS_FILE);
    expect(LOGIN_OWNER_FRESH_MS).toBe(2 * CHECK_EVERY_MS);
  });

  // MUTATION: return `o.enabled` from loginOwnerOf (the refresher's status not
  // read) — a refresher in a failure episode still counts as renewing the
  // login, rounds start on a login nothing will renew, and this fails.
  it("login_owner is true only for an enabled refresher whose status is fresh, unpaused and without an error", () => {
    expect(owner(healthy())).toBe(true);
    // Off, or nothing published: nothing renews the login.
    expect(owner(healthy(), false)).toBe(false);
    expect(owner(null)).toBe(false);
    // A failure episode, and a login in progress.
    expect(owner(healthy({ last_error: "prov-a: 400 invalid_grant" }))).toBe(false);
    expect(owner(healthy({ paused: true }))).toBe(false);
    // A status that is not fresh: the refresher has stopped looking.
    const at = (ms: number): string => new Date(NOW - ms).toISOString();
    expect(owner(healthy({ checked_at: at(LOGIN_OWNER_FRESH_MS) }))).toBe(true);
    expect(owner(healthy({ checked_at: at(LOGIN_OWNER_FRESH_MS + 1) }))).toBe(false);
    expect(owner(healthy({ checked_at: null }))).toBe(false);
    expect(owner(healthy({ checked_at: "not a date" }))).toBe(false);
    // A file a refresher that is gone left behind.
    expect(owner(healthy(), true, () => false)).toBe(false);
    // A file that does not say is not one that says "healthy".
    const without = (key: keyof LoginRefreshFileStatus): string => {
      const o = JSON.parse(healthy()) as Record<string, unknown>;
      delete o[key];
      return JSON.stringify(o);
    };
    for (const key of ["pid", "paused", "last_error", "checked_at"] as const)
      expect(owner(without(key)), key).toBe(false);
    for (const text of ["", "{ not json", "null", "[]", '"healthy"'])
      expect(owner(text), text).toBe(false);
  });

  // MUTATION: leave `login_owner` out of buildSpec (src/workerworld.ts) — the
  // worker of a bot with a healthy refresher still drops a login shorter than
  // its round, and this fails.
  it("puts login_owner in every spec, read from the status file where the login is", () => {
    const loginDir = join(dir, "login");
    mkdirSync(loginDir, { recursive: true });
    const write = (text: string): void => writeFileSync(join(loginDir, LOGIN_STATUS_FILE), text);
    const now = (): number => NOW;

    // Enabled, but the refresher has published nothing yet. The spec is built
    // anew for each worker, so each one carries the answer of its own moment.
    const r = rig({}, {}, { loginRefresh: true, loginDir, now });
    const row = r.world.supervisor.submit({ pr: 7, kind: "wake", round_no: null, payload: "w" });
    expect(r.specOf(row).login_owner).toBe(false);
    write(healthy());
    const spec = r.specOf(row);
    expect(spec.login_owner).toBe(true);
    expect(parseWorkerSpec(JSON.parse(JSON.stringify(spec))).login_owner).toBe(true);
    write(
      healthy({ last_error: "prov-a: 400 invalid_grant", error_since: "2026-11-11T11:50:00Z" }),
    );
    expect(r.specOf(row).login_owner).toBe(false);
  });

  /** A healthy refresher's file in `<dir>/login`. */
  const healthyLoginDir = (): string => {
    const loginDir = join(dir, "login");
    mkdirSync(loginDir, { recursive: true });
    writeFileSync(join(loginDir, LOGIN_STATUS_FILE), healthy());
    return loginDir;
  };

  it("a healthy status file means nothing while [login_refresh] is off", () => {
    const r = rig({}, {}, { loginRefresh: false, loginDir: healthyLoginDir(), now: () => NOW });
    expect(wake(r).login_owner).toBe(false);
  });

  it("the status file is read beside the login, not beside another one", () => {
    healthyLoginDir();
    // No login dir is named: the login is in the agent dir, and the file is not.
    expect(wake(rig({}, {}, { loginRefresh: true, now: () => NOW })).login_owner).toBe(false);
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
