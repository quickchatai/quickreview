// The pane's side of a bot debug round (src/debugroundpi.ts) and the debug
// extension's additions (extensions/debug-round.ts): the borrowed login, the round order,
// pi's argv and env, the resume that reads what the debug pi wrote, and the bash that
// hands the capability fd to the model's commands.
//
// pi is a fake: the `run` seam gets the command pi would have been started with and (for
// the resume) appends the round's turns to the PR's JSONL the way interactive pi does,
// through pi's own SessionManager. The worker that resumes the file afterwards is the
// real one on pi-ai's faux provider. No model, no network (the offline guard fails the
// file on any attempt).
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEBUG_BASH_ENV_ALLOW,
  capabilityFdOf,
  createDebugRound,
  lensAdjust,
} from "../extensions/debug-round.js";
import { jsonlHasMarker } from "../src/botworker.js";
import type { DebugRoundSpec } from "../src/debuground.js";
import {
  DEBUG_ORDER_NAME,
  DEBUG_START_MESSAGE,
  debugRoundArgv,
  debugRoundEnv,
  debugRoundOrder,
  readDebugSpec,
  runDebugRoundPane,
} from "../src/debugroundpi.js";
import { DISABLED_REFRESH } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { LensWave } from "@quickchatai/pi-quickreview/src/engine/lens/wave.js";
import { createCapabilityFd } from "../src/ipc/capability.js";
import { sessionCommandMarker } from "@quickchatai/pi-quickreview/src/session-command.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import { bornReference, rehearseFile, type RequestShape } from "./helpers/resume-rehearsal.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

useOfflineGuard();

const HOUR = 3_600_000;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "debug-round-pane-"));
});
afterEach(() => {
  try {
    chmodSync(join(dir, "agent"), 0o755);
  } catch {
    /* none */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The bot's agent dir as the refresher keeps it: a live OAuth login with a real refresh
 * token, a models file, and the built lens agents. */
function ownerAgent(expiresInMs = 24 * HOUR): string {
  const agent = join(dir, "agent");
  mkdirSync(join(agent, "agents"), { recursive: true });
  writeFileSync(
    join(agent, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "A-TOKEN",
        refresh: "REAL-REFRESH",
        expires: Date.now() + expiresInMs,
      },
    }),
    { mode: 0o660 },
  );
  writeFileSync(join(agent, "auth.json.lock"), "");
  writeFileSync(join(agent, "models.json"), "{}");
  writeFileSync(join(agent, "agents", "pass-a.md"), "---\nname: pass-a\n---\nYou are pass-a.\n");
  return agent;
}

const ORDER_TEXT = "ROUND ORDER: review PR 7.";

function specOf(over: Partial<DebugRoundSpec> = {}): DebugRoundSpec {
  const root = join(dir, "root");
  mkdirSync(join(root, "state", "pr-7-round-1-passes"), { recursive: true });
  const payload = join(dir, "payload.md");
  if (!existsSync(payload)) writeFileSync(payload, `${ORDER_TEXT}\n`);
  const payloadSha = sha(readFileSync(payload, "utf8"));
  return {
    v: 1,
    pr: 7,
    session: "debug-pr-7",
    command_id: "cmd-1",
    round_no: 1,
    root,
    cwd: root,
    agent_dir: join(dir, "agent"),
    borrow_dir: join(dir, "run", "debug-pr-7.agent"),
    idle_ms: 30 * 60_000,
    session_dir: join(root, "state", "pi-sessions", "pr-7"),
    model: "faux/faux-1",
    system_prompt_file: join(root, "prompts", "system.md"),
    stub_file: join(root, "deploy", "reviewer", "AGENTS.override.md"),
    extensions: ["cli/bash-guard.ts", "cli/ledger-pin.ts", "cli/debug-round.ts"].map((e) =>
      join(root, "extensions", e),
    ),
    payload_path: payload,
    payload_sha256: payloadSha,
    marker: sessionCommandMarker("cmd-1", payloadSha),
    planned_wave: false,
    passes_dir: join(root, "state", "pr-7-round-1-passes"),
    lens_dir: join(root, "state", "lens", "pr-7", "r1"),
    env: {
      QCR_SANDBOX_ROOT: root,
      QCR_PR: "7",
      QCR_IPC_SOCKET: join(dir, "q.sock"),
      QCR_IPC_COMMAND_ID: "cmd-1",
      QCR_IPC_GENERATION: "1",
      QCR_IPC_CAP_FD: "3",
    },
    ...over,
  };
}

function specFile(over: Partial<DebugRoundSpec> = {}): string {
  const file = join(dir, "spec.json");
  writeFileSync(file, JSON.stringify(specOf(over)), { mode: 0o600 });
  return file;
}

describe("the debug pi's login is a refresh-blanked borrowed copy", () => {
  it("has the disabled refresh token, in the pi's own agent dir, with the lens agents linked and nothing written to the owner's", async () => {
    const agent = ownerAgent();
    const before = readFileSync(join(agent, "auth.json"), "utf8");
    const owner = readdirSync(agent).sort();
    const seen: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const code = await runDebugRoundPane(specFile(), {
      env: {
        PATH: "/usr/bin",
        HOME: "/home/qcr",
        GITHUB_TOKEN: "ghs_leak",
        GH_TOKEN: "ghs_leak2",
        OPENAI_API_KEY: "sk-leak",
        QCR_IPC_CAP_FD: "3",
      },
      run: async (cmd) => {
        seen.push(cmd);
        const borrowed = join(dir, "run", "debug-pr-7.agent");
        const copy = JSON.parse(readFileSync(join(borrowed, "auth.json"), "utf8"));
        expect(copy["openai-codex"]).toMatchObject({
          type: "oauth",
          access: "A-TOKEN",
          refresh: DISABLED_REFRESH,
        });
        expect(statSync(join(borrowed, "auth.json")).mode & 0o777).toBe(0o600);
        // the lens passes read the built agents from the pi's own agent dir
        expect(lstatSync(join(borrowed, "agents")).isSymbolicLink()).toBe(true);
        expect(existsSync(join(borrowed, "models.json"))).toBe(true);
        // the order file and the lens dir are there when pi starts
        expect(readFileSync(join(borrowed, DEBUG_ORDER_NAME), "utf8")).toContain(ORDER_TEXT);
        expect(statSync(join(borrowed, DEBUG_ORDER_NAME)).mode & 0o777).toBe(0o600);
        expect(existsSync(specOf().lens_dir)).toBe(true);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(readFileSync(join(agent, "auth.json"), "utf8")).toBe(before);
    expect(readdirSync(agent).sort()).toEqual(owner);
    expect(seen[0]!.env["PI_CODING_AGENT_DIR"]).toBe(join(dir, "run", "debug-pr-7.agent"));
    expect(seen[0]!.cwd).toBe(join(dir, "root"));
    // the spec file is read once and removed
    expect(existsSync(join(dir, "spec.json"))).toBe(false);
  });

  it("is refused, with no pi, when the token would expire inside the lease's window", async () => {
    ownerAgent(10 * 60_000);
    const lines: string[] = [];
    let ran = false;
    const code = await runDebugRoundPane(specFile(), {
      env: { PATH: "/usr/bin" },
      log: (l) => lines.push(l),
      run: async () => {
        ran = true;
        return 0;
      },
    });
    expect(code).toBe(3);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toMatch(/expires at/);
  });

  it("is refused, with no pi, when the saved order no longer verifies", async () => {
    ownerAgent();
    const spec = specOf();
    writeFileSync(spec.payload_path, "tampered\n");
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec), { mode: 0o600 });
    const lines: string[] = [];
    let ran = false;
    expect(
      await runDebugRoundPane(join(dir, "spec.json"), {
        env: { PATH: "/usr/bin" },
        log: (l) => lines.push(l),
        run: async () => {
          ran = true;
          return 0;
        },
      }),
    ).toBe(3);
    expect(ran).toBe(false);
    expect(lines.join("\n")).toMatch(/hash/);
  });

  it("is refused where the image asked for a tool uid it could not arrange", async () => {
    ownerAgent();
    const lines: string[] = [];
    expect(
      await runDebugRoundPane(specFile(), {
        env: { PATH: "/usr/bin", QCR_TOOL_UID_REQUIRED: "1" },
        log: (l) => lines.push(l),
        run: async () => 0,
      }),
    ).toBe(3);
    expect(lines.join("\n")).toMatch(/debug round/);
  });

  it("refuses a spec missing root, round_no or planned_wave", () => {
    for (const key of ["root", "round_no", "planned_wave"] as const) {
      const spec: Record<string, unknown> = { ...specOf() };
      delete spec[key];
      const file = join(dir, `missing-${key}.json`);
      writeFileSync(file, JSON.stringify(spec));
      expect(() => readDebugSpec(file), key).toThrow(/not a debug-round spec/);
    }
  });

  it("refuses a file that is not a debug-round spec", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ v: 2 }));
    expect(() => readDebugSpec(file)).toThrow(/not a debug-round spec/);
    writeFileSync(file, JSON.stringify({ v: 2 }));
    expect(await runDebugRoundPane(file, { log: () => {}, run: async () => 0 })).toBe(2);
  });
});

describe("the round order the extension sends", () => {
  it("is the saved order, the engine lens section and the command's marker, as a worker builds it", () => {
    const spec = specOf();
    const order = debugRoundOrder(spec);
    expect(order.startsWith(`${ORDER_TEXT}\n\n## ENGINE LENS ROUTE`)).toBe(true);
    expect(order).toContain("`lens` and `lens_wave`");
    expect(order.trimEnd().endsWith(spec.marker)).toBe(true);
    // no wave planned: the session launches the rows itself
    expect(order).toContain("Launch the planned discovery rows with ONE `lens_wave` call");
  });

  it("names the wave the extension's command starts, when the round has task files", () => {
    const spec = specOf({ planned_wave: true });
    const tasks = join(spec.passes_dir, "tasks");
    mkdirSync(tasks, { recursive: true });
    for (const f of ["01-pass-a.md", "02-pass-b.md", "03-pass-validate.md"])
      writeFileSync(join(tasks, f), `task ${f}\n`);
    const order = debugRoundOrder(spec, "/usr/bin");
    expect(order).toContain("The engine started the planned discovery wave");
    expect(order).toContain("pass-a, pass-b");
    expect(order).not.toContain("pass-validate");
  });

  it("is refused for bytes that are not the ones dispatched", () => {
    const spec = specOf();
    writeFileSync(spec.payload_path, "other\n");
    expect(() => debugRoundOrder(spec)).toThrow(/hash/);
  });
});

describe("the pi the pane starts", () => {
  it("resumes the real session (not a fork), switches the tree's context files off, appends the stub and starts the round from the command", () => {
    const withFile = specOf({ session_file: "/r/state/pi-sessions/pr-7/s.jsonl" });
    const argv = debugRoundArgv(withFile);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--session",
        "/r/state/pi-sessions/pr-7/s.jsonl",
        "-nc",
        "-ne",
        "-ns",
        "--append-system-prompt",
        withFile.stub_file!,
        "--name",
        "debug-pr-7",
      ]),
    );
    expect(argv).not.toContain("--fork");
    expect(argv).not.toContain("--continue");
    expect(argv).not.toContain("--session-dir");
    expect(argv.at(-1)).toBe(DEBUG_START_MESSAGE);
    // extensions in the spec's order; bash-guard first
    expect(argv.flatMap((a, i) => (argv[i - 1] === "--extension" ? [a] : []))).toEqual(
      withFile.extensions,
    );
    // no tools allowlist: the round's own tools (the lens pair, bash, the file tools)
    expect(argv).not.toContain("--tools");
    // a PR with no JSONL gets one born in its session dir
    const born = debugRoundArgv(specOf());
    expect(born).toContain("--session-dir");
    expect(born).not.toContain("--session");
  });

  it("gets an env with no GitHub token of any name, the round's own names, and the debug names", () => {
    const spec = specOf({ planned_wave: true });
    const env = debugRoundEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/qcr",
        GITHUB_TOKEN: "x",
        GH_TOKEN: "y",
        GH_ENTERPRISE_TOKEN: "z",
        OPENAI_API_KEY: "sk",
        AWS_SECRET_ACCESS_KEY: "s",
      },
      spec,
    );
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "OPENAI_API_KEY"])
      expect(env[name]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env).toMatchObject({
      PI_CODING_AGENT_DIR: spec.borrow_dir,
      QCR_IPC_CAP_FD: "3",
      QCR_IPC_COMMAND_ID: "cmd-1",
      QCR_DEBUG_ORDER_FILE: join(spec.borrow_dir, DEBUG_ORDER_NAME),
      QCR_DEBUG_STATUS_FILE: join(spec.borrow_dir, "debug-round.json"),
      QCR_DEBUG_LENS_DIR: spec.lens_dir,
      QCR_DEBUG_PACK_FILE: join(spec.passes_dir, "context-pack.md"),
      QCR_DEBUG_STUB_FILE: spec.stub_file,
      QCR_DEBUG_TASKS_DIR: spec.passes_dir,
    });
    // a round with no planned wave names no task dir
    expect(debugRoundEnv({}, specOf())["QCR_DEBUG_TASKS_DIR"]).toBeUndefined();
    // the takeover marker is not set: this round posts. The env names the fd and never the secret.
    expect(env["QCR_TAKEOVER"]).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe("the extension hands the capability fd to the model's commands", () => {
  const fakePi = () => {
    const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
    const pi = {
      registerCommand: () => {},
      registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) =>
        void tools.push(t),
      on: () => () => {},
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI;
    return { pi, tools };
  };
  const lens = {
    factory: () => {},
    runner: { run: async () => ({}) as never },
    wave: new LensWave(),
  };

  it("reads the fd the env names, and refuses a name that is no open descriptor", () => {
    const fd = createCapabilityFd(dir, "a".repeat(32));
    try {
      expect(capabilityFdOf({ QCR_IPC_CAP_FD: String(fd) })).toBe(fd);
      expect(capabilityFdOf({})).toBeNull();
      expect(capabilityFdOf({ QCR_IPC_CAP_FD: "" })).toBeNull();
      expect(() => capabilityFdOf({ QCR_IPC_CAP_FD: "2" })).toThrow(/not an fd number/);
      expect(() => capabilityFdOf({ QCR_IPC_CAP_FD: "x" })).toThrow(/not an fd number/);
      expect(() => capabilityFdOf({ QCR_IPC_CAP_FD: "999" })).toThrow(/not open/);
    } finally {
      closeSync(fd);
    }
  });

  it("registers a bash tool whose commands inherit the fd at the same number, readable with pread", async () => {
    const cap = "b".repeat(32);
    const fd = createCapabilityFd(dir, cap);
    const f = fakePi();
    try {
      void createDebugRound({
        lens,
        order: "ORDER",
        tasksDir: null,
        env: {},
        statusFile: join(dir, "status.json"),
        capFd: fd,
        cwd: dir,
      })(f.pi);
      const bash = f.tools.find((t) => t.name === "bash");
      expect(bash).toBeDefined();
      const run = async (command: string): Promise<string> => {
        const ctx = {
          sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined },
        };
        const out = (await bash!.execute("1", { command }, undefined, undefined, ctx)) as {
          content: Array<{ type: string; text?: string }>;
        };
        return out.content.map((c) => c.text ?? "").join("");
      };
      // two commands of one round both read it: the fd is never consumed
      expect(await run(`head -c 32 /proc/self/fd/${fd}`)).toContain(cap);
      expect(await run(`sh -c 'head -c 32 /proc/self/fd/${fd}'`)).toContain(cap);
    } finally {
      closeSync(fd);
    }
  });

  it("without a capability the round's bash is pi's own: nothing is registered", () => {
    const f = fakePi();
    void createDebugRound({
      lens,
      order: "ORDER",
      tasksDir: null,
      env: {},
      statusFile: join(dir, "status.json"),
    })(f.pi);
    expect(f.tools).toEqual([]);
  });

  it("keeps a bot round's lens files where the daemon says, and carries the reviewer stub as data", () => {
    const adjust = lensAdjust({
      cwd: "/root",
      lensDir: "/root/state/lens/pr-7/r1",
      stub: "STUB",
      pack: "PACK",
    });
    const config = { host: {}, cache: { size: 3, staggerMs: 1 } } as never;
    expect(adjust(config)).toMatchObject({
      ledgerPath: "/root/state/lens/pr-7/r1/lens-ledger.jsonl",
      sessionsDir: "/root/state/lens/pr-7/r1/lens-sessions",
      agentsFiles: [{ path: "/root/AGENTS.override.md", content: "STUB" }],
      bashEnv: { allow: DEBUG_BASH_ENV_ALLOW },
      cache: { size: 3, staggerMs: 1, pack: "PACK" },
    });
    // the engine route's debug round sets none of the bot's names
    const plain = lensAdjust({ cwd: "/root" })({ host: {} } as never) as unknown as Record<
      string,
      unknown
    >;
    expect(plain["ledgerPath"]).toBeUndefined();
    expect(plain["agentsFiles"]).toBeUndefined();
  });
});

describe("the resume reads what the debug pi wrote", () => {
  let born: RequestShape;
  beforeAll(async () => {
    born = await bornReference();
  }, HEAVY_TIMEOUT_MS);

  it(
    "keeps the JSONL id, appends only, carries the order's marker, and the worker resumes the same file under the same id",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // The PR's session as an earlier round left it.
      const sessions = join(dir, "pr-7");
      mkdirSync(sessions, { recursive: true });
      const work = join(dir, "root");
      mkdirSync(work, { recursive: true });
      const bot = SessionManager.create(work, sessions);
      bot.appendMessage({
        role: "user",
        content: [{ type: "text", text: "ROUND ORDER: round 0" }],
        timestamp: 1,
      });
      bot.appendMessage(fauxAssistantMessage("Round 0: nothing found."));
      const file = bot.getSessionFile()!;
      const earlier = readFileSync(file, "utf8");
      const id = (JSON.parse(earlier.split("\n", 1)[0]!) as { id: string }).id;

      ownerAgent();
      const spec = specOf({ session_file: file });
      writeFileSync(join(dir, "spec.json"), JSON.stringify(spec), { mode: 0o600 });
      const code = await runDebugRoundPane(join(dir, "spec.json"), {
        env: { PATH: "/usr/bin" },
        run: async (cmd) => {
          expect(cmd.args[cmd.args.indexOf("--session") + 1]).toBe(file);
          // pi: /qcr-round sends the order file as the first message, then the model answers
          const pi = SessionManager.open(file, sessions, work);
          const order = readFileSync(cmd.env["QCR_DEBUG_ORDER_FILE"]!, "utf8");
          pi.appendMessage({
            role: "user",
            content: [{ type: "text", text: order }],
            timestamp: 2,
          });
          pi.appendMessage(fauxAssistantMessage("Round 1: one blocker on a.py:3."));
          return 0;
        },
      });
      expect(code).toBe(0);

      // Append-only, one file, the same id; the order carries the command's marker, so a
      // worker taking the round over continues instead of sending the order again.
      const after = readFileSync(file, "utf8");
      expect(after.startsWith(earlier)).toBe(true);
      expect(readdirSync(sessions).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
      expect((JSON.parse(after.split("\n", 1)[0]!) as { id: string }).id).toBe(id);
      expect(jsonlHasMarker(file, spec.marker)).toBe(true);
      expect(jsonlHasMarker(file, "<!-- qcr-command:other -->")).toBe(false);

      // The real worker, on the faux provider, resumes that file under the same id.
      const row = await rehearseFile(file, "debug-round", born);
      expect(row.problems).toEqual([]);
      expect(row.resumed).toBe(true);
      expect(row.idKept).toBe(true);
      expect(row.historyKept).toBe(true);
      expect(row.replayed).toBeGreaterThanOrEqual(4);
    },
  );
});
