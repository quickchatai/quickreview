// QCR PATCH 12 [P3.4]: createOpenViking(cfg), the shim that feeds it, and the
// deadline-plus-catch every hook now runs under. Pi is replaced by a recording
// stand-in and the OpenViking client by a fake, so nothing here touches a
// network or the developer's home. The shim-versus-factory parity case
// (registrations through pi's own loader) is in extension-factory-parity.test.ts,
// the containment canary in pi-canary/canary-9-extension-throw.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOpenViking } from "../extensions/vendor/openviking-pi/index.js";
import type { OVClient } from "../extensions/vendor/openviking-pi/client.js";
import { loadConfig } from "../extensions/vendor/openviking-pi/config.js";
import { boundedHook, HOOK_TIMEOUT_MS } from "../extensions/vendor/openviking-pi/qcr-hooks.js";
import {
  envOverlay,
  openVikingConfigFromEnv,
  pendingQueueFromEnv,
  type OpenVikingConfig,
} from "../extensions/vendor/openviking-pi/qcr-shim.js";
import { enqueue, listPending } from "../extensions/vendor/openviking-pi/shared/pending-queue.mjs";

const FORK = join(import.meta.dirname, "..", "extensions", "vendor", "openviking-pi");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-ovf-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An env that resolves the same on any machine: no credential file is read. */
const hermetic = (extra: Record<string, string> = {}): Record<string, string> => ({
  OPENVIKING_CREDENTIAL_SOURCE: "env",
  OPENVIKING_CLI_CONFIG_FILE: join(dir, "no-ovcli.conf"),
  OPENVIKING_CONFIG_FILE: join(dir, "no-ov.conf"),
  ...extra,
});

const shimFrom = (
  env: Record<string, string | undefined>,
  argv: string[] = ["node", "pi", "--approve"],
): OpenVikingConfig =>
  openVikingConfigFromEnv({ env, argv, cwd: "/work/repo", home: dir, extensionDir: FORK });

describe("the shim: env, argv, cwd and home become a value", () => {
  it("reads the process once and resolves the same config as loadConfig did", () => {
    const env = hermetic({
      OPENVIKING_URL: "http://ov.test:1933/",
      OPENVIKING_API_KEY: "k-main",
      OPENVIKING_ACCOUNT: "acct",
      OPENVIKING_USER: "reviewer",
      OPENVIKING_PEER_ID: "pr-42",
    });
    const cfg = shimFrom(env);
    expect(cfg.config.endpoint).toBe("http://ov.test:1933");
    expect(cfg.config.apiKey).toBe("k-main");
    expect(cfg.config.account).toBe("acct");
    expect(cfg.config.user).toBe("reviewer");
    expect(cfg.config.peerId).toBe("pr-42");
    expect(cfg.leaf).toBe(false);
    expect(cfg.cwd).toBe("/work/repo");
    // The config is a function of the arguments: the live process plays no part.
    const prior = process.env.OPENVIKING_USER;
    process.env.OPENVIKING_USER = "somebody-else";
    try {
      expect(shimFrom(env)).toEqual(cfg);
    } finally {
      if (prior === undefined) delete process.env.OPENVIKING_USER;
      else process.env.OPENVIKING_USER = prior;
    }
  });

  it("applies the overlay between the file merge and the clamps", () => {
    const cfg = shimFrom(
      hermetic({
        OPENVIKING_WORKSPACE_PEER: "0",
        OPENVIKING_RECALL_PEER_SCOPE: "actor",
        OPENVIKING_RECALL_LIMIT: "999",
      }),
    );
    expect(cfg.config.workspacePeer).toBe(false);
    // ...so no workspace-derived peer id, as before the move.
    expect(cfg.config.peerId).toBe("");
    expect(cfg.config.recallPeerScope).toBe("actor");
    expect(cfg.config.recallLimit).toBe(50); // clamped after the overlay
    expect(cfg.config.recallLimitConfigured).toBe(true);
    // Workspace peer on: the peer id derives from the cwd the shim was given.
    expect(shimFrom(hermetic()).config.peerId).toBe("-work-repo");
  });

  it("keeps query expansion off whatever the env says (ruling R3)", () => {
    const cfg = shimFrom(hermetic({ OPENVIKING_RECALL_QUERY_EXPANSION: "auto" }));
    expect(cfg.config.recallQueryExpansion).toBe("off");
    expect(cfg.config.takeoverEnabled).toBe(false);
  });

  it("loadConfig applies a given overlay and ignores the process without one", () => {
    const config = loadConfig(FORK, { env: hermetic({ OPENVIKING_RECALL_LIMIT: "3" }) });
    // No overlay passed: the env's limit is not applied by config.ts any more.
    expect(config.recallLimit).toBe(10);
    const overlaid = loadConfig(FORK, {
      env: hermetic(),
      overlay: envOverlay({ OPENVIKING_RECALL_LIMIT: "3" }),
    });
    expect(overlaid.recallLimit).toBe(3);
  });

  it("decides leaf from argv and env, and hands a leaf no second namespace", () => {
    const env = hermetic({ OPENVIKING_REVIEWER_KEY: "k-reviewer", OPENVIKING_USER: "actor" });
    const main = shimFrom(env);
    expect(main.leaf).toBe(false);
    expect(main.extraNamespaces.map((n) => n.name)).toEqual(["reviewer"]);
    const viaArgv = shimFrom(env, ["node", "pi", "--no-extensions", "-p"]);
    expect(viaArgv.leaf).toBe(true);
    expect(viaArgv.extraNamespaces).toEqual([]);
    expect(shimFrom({ ...env, QCR_OV_LEAF: "1" }).leaf).toBe(true);
  });

  it("takes the daemon's per-session hand-offs from env names", () => {
    const cfg = shimFrom(
      hermetic({
        QCR_OV_SESSION_ID: " pr-7 ",
        QCR_OV_RETIRED_FILE: "/s/retired.json",
        QCR_OV_RECALL_HINT_FILE: "/s/hint.json",
        OV_DEBUG_LOG: "/s/ov.log",
      }),
    );
    expect(cfg.sessionId).toBe("pr-7");
    expect(cfg.retiredFile).toBe("/s/retired.json");
    expect(cfg.recallHintFile).toBe("/s/hint.json");
    expect(cfg.debugLogFile).toBe("/s/ov.log");
    // The upstream-shaped name wins, as sync.ts always read it.
    expect(
      shimFrom(hermetic({ OPENVIKING_SESSION_ID: "a", QCR_OV_SESSION_ID: "b" })).sessionId,
    ).toBe("a");
    expect(shimFrom(hermetic()).sessionId).toBe("");
  });

  it("hands the credential re-reader only OPENVIKING_ names", () => {
    const cfg = shimFrom({ ...hermetic({ OPENVIKING_API_KEY: "k" }), GH_TOKEN: "t", HOME: "/h" });
    expect(Object.keys(cfg.credentialEnv).every((k) => k.startsWith("OPENVIKING_"))).toBe(true);
    expect(cfg.credentialEnv.OPENVIKING_API_KEY).toBe("k");
  });
});

describe("the pending queue's directory and limits are the shim's", () => {
  it("defaults under the given home, with env overrides parsed as the queue did", () => {
    expect(pendingQueueFromEnv({}, "/h")).toEqual({
      dir: "/h/.openviking/pending",
      maxRetries: undefined,
      ttlDays: undefined,
      replayLimit: undefined,
    });
    expect(
      pendingQueueFromEnv(
        {
          OPENVIKING_PENDING_DIR: "/q",
          OPENVIKING_PENDING_MAX_RETRIES: "0",
          OPENVIKING_PENDING_TTL_DAYS: "2",
          OPENVIKING_PENDING_REPLAY_LIMIT: "5",
        },
        "/h",
      ),
    ).toEqual({ dir: "/q", maxRetries: 0, ttlDays: 2, replayLimit: 5 });
    // A retry cap of -1, a zero replay limit and junk fall back to the defaults.
    const bad = pendingQueueFromEnv(
      {
        OPENVIKING_PENDING_MAX_RETRIES: "-1",
        OPENVIKING_PENDING_REPLAY_LIMIT: "0",
        OPENVIKING_PENDING_TTL_DAYS: "x",
      },
      "/h",
    );
    expect([bad.maxRetries, bad.ttlDays, bad.replayLimit]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("the queue module touches only the directory it is given", async () => {
    const queue = { dir: join(dir, "q") };
    expect((await enqueue("addMessage", "pr-1", { text: "a" }, { queue })).ok).toBe(true);
    expect(await listPending(queue)).toHaveLength(1);
    // Without a directory the queue is off: nothing is written anywhere.
    expect((await enqueue("addMessage", "pr-1", { text: "a" })).ok).toBe(false);
    expect(await listPending()).toEqual([]);
    expect(await listPending({ dir: "" })).toEqual([]);
  });
});

describe("boundedHook: a deadline and a catch", () => {
  it("passes a result through", async () => {
    expect(
      await boundedHook(
        "t",
        1000,
        async () => 7,
        () => {},
      ),
    ).toBe(7);
  });

  it("answers undefined and logs when the hook throws", async () => {
    const lines: string[] = [];
    const out = await boundedHook(
      "turn_end",
      1000,
      async () => {
        throw new Error("boom");
      },
      (m) => lines.push(m),
    );
    expect(out).toBeUndefined();
    expect(lines).toEqual(["hook turn_end: failed: boom"]);
  });

  it("answers on time when the hook never does, and drops a late failure quietly", async () => {
    const lines: string[] = [];
    let rejectLate!: (e: Error) => void;
    const late = new Promise<never>((_, rej) => (rejectLate = rej));
    const t0 = Date.now();
    const out = await boundedHook(
      "context",
      30,
      () => late,
      (m) => lines.push(m),
    );
    expect(out).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(lines[0]).toContain("no answer in 30 ms");
    rejectLate(new Error("too late"));
    await new Promise((r) => setTimeout(r, 10));
    expect(lines[1]).toContain("failed after its deadline: too late");
  });

  it("runs onFail for a throw and a missed deadline alike", async () => {
    const fail = (why: string) => `closed: ${why}`;
    expect(
      await boundedHook(
        "g",
        1000,
        () => Promise.reject(new Error("x")),
        () => {},
        fail,
      ),
    ).toBe("closed: x");
    expect(
      await boundedHook(
        "g",
        10,
        () => new Promise<string>(() => {}),
        () => {},
        fail,
      ),
    ).toBe("closed: timed out after 10 ms");
  });

  it("gives every hook a deadline, the recall one just past its 500 ms wait", () => {
    expect(Object.keys(HOOK_TIMEOUT_MS).sort()).toEqual(
      [
        "agent_end",
        "before_agent_start",
        "command",
        "context",
        "session_shutdown",
        "session_start",
        "tool_call",
        "turn_end",
      ].sort(),
    );
    expect(HOOK_TIMEOUT_MS.context).toBeGreaterThan(500);
    expect(HOOK_TIMEOUT_MS.context).toBeLessThan(2000);
  });
});

// ---- the factory, against a recording pi and a fake client -------------------

type Handler = (event: any, ctx: any) => Promise<any> | any;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const tools: string[] = [];
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
    },
    registerCommand: (name: string, def: { handler: Handler }) => commands.set(name, def),
    registerTool: (def: { name: string }) => tools.push(def.name),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands, tools };
}

interface FakeClientOpts {
  health?: () => Promise<boolean>;
  getSession?: (id: string) => Promise<unknown>;
}

function fakeClient(opts: FakeClientOpts = {}) {
  const calls: string[] = [];
  const client = {
    connected: false,
    rekey: null,
    cfg: { user: "reviewer" },
    health: async () => {
      calls.push("health");
      client.connected = await (opts.health ? opts.health() : Promise.resolve(true));
      return client.connected;
    },
    getSession: async (id: string) => {
      calls.push(`getSession ${id}`);
      return opts.getSession ? opts.getSession(id) : null;
    },
    getSessionContext: async () => null,
    fetchJSON: async () => ({ ok: false, status: 0 }),
  };
  return { client: client as unknown as OVClient, calls };
}

function factoryConfig(over: Partial<OpenVikingConfig> = {}): OpenVikingConfig {
  return {
    ...shimFrom(hermetic()),
    debugLogFile: join(dir, "ov.log"),
    pendingQueue: { dir: join(dir, "pending") },
    ...over,
  };
}

const ctxFor = () => ({
  ui: { notify: () => {}, setStatus: () => {} },
  sessionManager: { getSessionId: () => "pi-session-0001", getBranch: () => [] },
});

const EVENTS = [
  "agent_end",
  "before_agent_start",
  "context",
  "session_shutdown",
  "session_start",
  "tool_call",
  "turn_end",
];

describe("createOpenViking(cfg)", () => {
  it("registers the seven hooks and the viking command, and no tool before connect", async () => {
    const { pi, handlers, commands, tools } = fakePi();
    await createOpenViking(factoryConfig({ makeClient: () => fakeClient().client }))(pi);
    expect([...handlers.keys()].sort()).toEqual(EVENTS);
    expect([...commands.keys()]).toEqual(["viking"]);
    expect(tools).toEqual([]);
  });

  it("registers nothing when the config is disabled", async () => {
    const { pi, handlers, commands } = fakePi();
    const base = factoryConfig();
    await createOpenViking({ ...base, config: { ...base.config, enabled: false } })(pi);
    expect(handlers.size + commands.size).toBe(0);
  });

  it("attaches to the session id in the config, not the process env", async () => {
    const prior = process.env.OPENVIKING_SESSION_ID;
    process.env.OPENVIKING_SESSION_ID = "from-process-env";
    try {
      const { pi, handlers, tools } = fakePi();
      const { client, calls } = fakeClient({ getSession: async (id) => ({ session_id: id }) });
      await createOpenViking(factoryConfig({ sessionId: "pr-42", makeClient: () => client }))(pi);
      await handlers.get("session_start")![0]!({}, ctxFor());
      expect(calls).toContain("getSession pr-42");
      expect(calls).not.toContain("getSession from-process-env");
      expect(tools).toContain("viking_search");
    } finally {
      if (prior === undefined) delete process.env.OPENVIKING_SESSION_ID;
      else process.env.OPENVIKING_SESSION_ID = prior;
    }
  });

  it("writes its debug log where the config says, never where the process env says", async () => {
    const stray = join(dir, "stray.log");
    const prior = process.env.OV_DEBUG_LOG;
    process.env.OV_DEBUG_LOG = stray;
    try {
      const { pi, handlers } = fakePi();
      const { client } = fakeClient({ getSession: async () => null });
      const log = join(dir, "cfg.log");
      await createOpenViking(
        factoryConfig({ sessionId: "pr-9", debugLogFile: log, makeClient: () => client }),
      )(pi);
      await handlers.get("session_start")![0]!({}, ctxFor());
      expect(readFileSync(log, "utf8")).toContain("ensureSession: session=pr-9 does not exist");
      expect(existsSync(stray)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.OV_DEBUG_LOG;
      else process.env.OV_DEBUG_LOG = prior;
    }
  });

  it("a leaf registers read tools only and runs no ambient hook", async () => {
    const { pi, handlers, tools } = fakePi();
    const { client, calls } = fakeClient();
    await createOpenViking(factoryConfig({ leaf: true, makeClient: () => client }))(pi);
    await handlers.get("session_start")![0]!({}, ctxFor());
    expect(tools).not.toContain("viking_write");
    expect(tools).toContain("viking_search");
    expect(calls).toEqual(["health"]);
    expect(
      await handlers.get("before_agent_start")![0]!({ prompt: "x", systemPrompt: "s" }, ctxFor()),
    ).toBeUndefined();
  });

  it("builds a client per extra namespace from the config's credentials", async () => {
    const built: string[] = [];
    const { pi } = fakePi();
    await createOpenViking(
      factoryConfig({
        extraNamespaces: [{ name: "reviewer", user: "reviewer", apiKey: "k2" }],
        makeClient: (c) => {
          built.push(`${c.user}:${c.apiKey}`);
          return fakeClient().client;
        },
      }),
    )(pi);
    expect(built).toEqual([
      `${factoryConfig().config.user}:${factoryConfig().config.apiKey}`,
      "reviewer:k2",
    ]);
    // A leaf never builds the second one.
    built.length = 0;
    await createOpenViking(
      factoryConfig({
        leaf: true,
        extraNamespaces: [{ name: "reviewer", user: "reviewer", apiKey: "k2" }],
        makeClient: (c) => {
          built.push(c.user);
          return fakeClient().client;
        },
      }),
    )(pi);
    expect(built).toHaveLength(1);
  });
});

describe("every hook has a timeout and a catch", () => {
  it("session_start: a health probe that hangs does not hold the turn", async () => {
    const { pi, handlers } = fakePi();
    const { client } = fakeClient({ health: () => new Promise<boolean>(() => {}) });
    await createOpenViking(
      factoryConfig({ hookTimeoutMs: { session_start: 40 }, makeClient: () => client }),
    )(pi);
    const t0 = Date.now();
    expect(await handlers.get("session_start")![0]!({}, ctxFor())).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(readFileSync(join(dir, "ov.log"), "utf8")).toContain(
      "hook session_start: no answer in 40 ms",
    );
  });

  it("session_start and before_agent_start: a client that throws is contained and logged", async () => {
    const { pi, handlers } = fakePi();
    const { client } = fakeClient({
      health: async () => {
        throw new Error("socket hang up");
      },
    });
    await createOpenViking(factoryConfig({ makeClient: () => client }))(pi);
    expect(await handlers.get("session_start")![0]!({}, ctxFor())).toBeUndefined();
    // before_agent_start retries start(), fails the same way, and adds nothing to the prompt.
    expect(
      await handlers.get("before_agent_start")![0]!(
        { prompt: "hello", systemPrompt: "s" },
        ctxFor(),
      ),
    ).toBeUndefined();
    const log = readFileSync(join(dir, "ov.log"), "utf8");
    expect(log).toContain("hook session_start: failed: socket hang up");
    expect(log).toContain("hook before_agent_start: failed: socket hang up");
  });

  it("context: a recall that never answers still returns, with no block injected", async () => {
    const { pi, handlers } = fakePi();
    // Connected with a daemon session, so the recall path runs for real; its
    // search never answers.
    const { client } = fakeClient({ getSession: async (id) => ({ session_id: id }) });
    await createOpenViking(
      factoryConfig({
        sessionId: "pr-3",
        hookTimeoutMs: { context: 60, before_agent_start: 5000 },
        makeClient: () => client,
      }),
    )(pi);
    await handlers.get("session_start")![0]!({}, ctxFor());
    // From here on the server stops answering.
    (client as unknown as { fetchJSON: unknown }).fetchJSON = () => new Promise(() => {});
    await handlers.get("before_agent_start")![0]!(
      { prompt: "review the diff", systemPrompt: "s" },
      ctxFor(),
    );
    const t0 = Date.now();
    const out = await handlers.get("context")![0]!(
      { messages: [{ role: "user", content: "x" }] },
      ctxFor(),
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    // Either the 500 ms recall budget or the hook deadline ended it; neither throws.
    if (out !== undefined) expect(out.messages).toHaveLength(1);
  });

  it("turn_end, session_shutdown, agent_end and the command swallow a throwing client", async () => {
    const { pi, handlers, commands } = fakePi();
    const { client } = fakeClient({ getSession: async (id) => ({ session_id: id }) });
    await createOpenViking(factoryConfig({ sessionId: "pr-5", makeClient: () => client }))(pi);
    await handlers.get("session_start")![0]!({}, ctxFor());
    const throwing = {
      ...ctxFor(),
      sessionManager: {
        getSessionId: () => "pi-1",
        getBranch: () => {
          throw new Error("branch boom");
        },
      },
    };
    expect(await handlers.get("turn_end")![0]!({}, throwing)).toBeUndefined();
    expect(readFileSync(join(dir, "ov.log"), "utf8")).toContain(
      "hook turn_end: failed: branch boom",
    );
    expect(await handlers.get("session_shutdown")![0]!({}, ctxFor())).toBeUndefined();
    expect(await handlers.get("agent_end")![0]!({}, ctxFor())).toBeUndefined();
    const notes: string[] = [];
    await commands.get("viking")!.handler("", { ui: { notify: (m: string) => notes.push(m) } });
    expect(notes[0]).toContain("OpenViking: connected");
    // A command whose ctx throws is contained too.
    await expect(
      commands.get("viking")!.handler("", {
        ui: {
          notify: () => {
            throw new Error("ui gone");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("tool_call is a guard: a failure refuses the call rather than waving it through", async () => {
    const { pi, handlers } = fakePi();
    await createOpenViking(factoryConfig({ makeClient: () => fakeClient().client }))(pi);
    const h = handlers.get("tool_call")![0]!;
    // The guard blocks a raw viking:// read through a file tool...
    const blocked = await h(
      { toolName: "read", input: { path: "viking://user/x/memories/a.md" } },
      ctxFor(),
    );
    expect(blocked?.block).toBe(true);
    // ...lets an ordinary call through...
    expect(await h({ toolName: "read", input: { path: "src/a.ts" } }, ctxFor())).toBeUndefined();
    // ...and refuses when the guard itself throws.
    const hostile = {
      get toolName(): string {
        throw new Error("hostile event");
      },
    };
    const refused = await h(hostile, ctxFor());
    expect(refused.block).toBe(true);
    expect(refused.reason).toContain("hostile event");
  });
});

describe("structure: the factory reads nothing from the process", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const src = (f: string) => strip(readFileSync(join(FORK, f), "utf8"));

  it("index.ts touches process only in the default export's shim call", () => {
    const index = src("index.ts");
    expect(index).not.toMatch(/process\./);
    expect(index).not.toMatch(/homedir\(|\bcwd\(\)/);
    expect(index).toContain("openVikingConfigFromProcess(");
  });

  it("only the shim reads the environment, argv and the home directory", () => {
    for (const f of ["sync.ts", "qcr-hooks.ts", "shared/pending-queue.mjs"]) {
      expect(src(f), f).not.toMatch(/process\.(env|argv|cwd)|homedir/);
    }
    // qcr-leaf.ts keeps the function, but no default reaches for the process.
    expect(src("qcr-leaf.ts")).not.toMatch(/process\./);
    // config.ts keeps `process.env` only as the default of an omitted `opts.env`.
    expect(src("config.ts").match(/process\.env/g) ?? []).toHaveLength(4);
    // ...and only the shim calls the leaf test.
    for (const f of ["index.ts", "sync.ts", "tools.ts", "config.ts"]) {
      expect(src(f), f).not.toContain("isLeafProcess(");
    }
    expect(src("qcr-shim.ts")).toContain("isLeafProcess(argv, env)");
  });

  it("registers every hook through the guard", () => {
    const index = src("index.ts");
    const hooks = index.match(/pi\.on\("[a-z_]+"/g) ?? [];
    expect(hooks).toHaveLength(7);
    for (const h of hooks) {
      const name = h.match(/"([a-z_]+)"/)![1]!;
      expect(index, name).toContain(`pi.on("${name}", guard("${name}"`);
    }
    expect(index).toContain('handler: guard("command"');
  });
});

describe("a config.json beside the module is still read", () => {
  it("merges the file under the credentials", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ recallLimit: 4, enabled: false }));
    const cfg = openVikingConfigFromEnv({
      env: hermetic(),
      argv: ["node", "pi"],
      cwd: "/w",
      home: dir,
      extensionDir: dir,
    });
    expect(cfg.config.enabled).toBe(false);
    expect(cfg.config.recallLimit).toBe(4);
    expect(cfg.config.recallLimitConfigured).toBe(true);
  });
});
