// P5.9: `qcr review --debug-pi`, a review round inside pi's own interactive UI.
// The units pin what the route hands pi (argv, env, the round's order and wave);
// the smoke runs the REAL `pi` CLI in a pty over a local OpenAI-compatible
// endpoint (no model, nothing leaves loopback): the round starts from the
// extension command, the planned wave runs as SDK sessions of that pi on its own
// dispatcher, the main session and every lens leave a JSONL, and the kept main
// session resumes under the same id.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEBUG_ROUND_COMMAND,
  DEBUG_BASH_ENV_ALLOW,
  createDebugRound,
  patchStatus,
  type DebugStatus,
} from "../extensions/debug-round.js";
import {
  DEBUG_ROUND_EXTENSIONS,
  DEBUG_START_MESSAGE,
  debugArgv,
  debugEnv,
  eventsFromSession,
  runDebugRound,
} from "../src/engine/debugpi.js";
import { LensWave, type WaveRunner } from "../src/engine/lens/wave.js";
import { mainSessionOf, lensSessionsOf } from "../src/engine/openable.js";
import { PiHost } from "../src/engine/pisdk.js";
import { BASH_ENV_ALLOW } from "../src/engine/roundsdk.js";
import { sdkRuntime } from "../src/engine/sdkruntime.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB } from "../src/hostroute.js";
import { findSession, runOpen } from "../src/opencli.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import { FILES, FIXTURE_CONFIG, TARGET, mkRoot, mkTree } from "./helpers/round-rig.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

const ROOT = resolve(import.meta.dirname, "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");
const tmp = mkdtempSync(join(tmpdir(), "debug-pi-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("[debug-pi] what pi is started with", () => {
  const argv = debugArgv({
    root: "/root",
    model: "local/m",
    sysPath: "/out/system-prompt.md",
    sessionDir: "/out/session",
    sessionName: "review-x",
  });

  it("loads the round's extensions with the debug one in the lens tool's place, bash-guard included", () => {
    const loaded = argv.flatMap((a, i) => (argv[i - 1] === "--extension" ? [basename(a)] : []));
    expect(loaded).toEqual([
      "bash-guard.ts",
      "ledger-pin.ts",
      "debug-round.ts",
      "finding-clusters.ts",
    ]);
    expect([...DEBUG_ROUND_EXTENSIONS]).toEqual(loaded);
    // lens.ts is inside debug-round.ts: loading it too would register the tools twice
    expect(loaded).not.toContain("lens.ts");
    expect(argv.filter((a) => /post/i.test(a))).toEqual([]);
    expect(argv).toEqual(expect.arrayContaining(["-ne", "-ns", "--approve"]));
    expect(argv).not.toContain("-nc");
  });

  it("persists the main session under the round's dir and starts the round from the command", () => {
    expect(argv[argv.indexOf("--session-dir") + 1]).toBe("/out/session");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("/out/system-prompt.md");
    expect(argv[argv.indexOf("--model") + 1]).toBe("local/m");
    // interactive: no --mode json, no -p
    expect(argv).not.toContain("--mode");
    expect(argv).not.toContain("-p");
    expect(argv.at(-1)).toBe(DEBUG_START_MESSAGE);
    expect(DEBUG_START_MESSAGE).toBe(`/${DEBUG_ROUND_COMMAND}`);
  });

  it("has no GitHub token in its environment, and the round's env over the terminal's", () => {
    const env = debugEnv(
      {
        PATH: "/usr/bin",
        TERM: "xterm",
        GITHUB_TOKEN: "a",
        GH_TOKEN: "b",
        GH_ENTERPRISE_TOKEN: "c",
        HOME: "/h",
      },
      { env: { HOME: "/round-home", QCR_PR: "7", TMPDIR: "/t" } },
      { order: "/out/round-order.md", tasksDir: "/out/tasks" },
    );
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["GH_ENTERPRISE_TOKEN"]).toBeUndefined();
    expect(env["TERM"]).toBe("xterm");
    expect(env["HOME"]).toBe("/round-home");
    expect(env["QCR_DEBUG_ORDER_FILE"]).toBe("/out/round-order.md");
    expect(env["QCR_DEBUG_TASKS_DIR"]).toBe("/out/tasks");
  });

  it("gives a lens pass the bash env a round's main session has", () => {
    expect([...DEBUG_BASH_ENV_ALLOW]).toEqual([...BASH_ENV_ALLOW]);
  });

  it("rebuilds the event stream from the session JSONL: its header, then a message_end per message", () => {
    const f = join(tmp, "s.jsonl");
    const msg = { role: "assistant", content: [], usage: { cost: { total: 0.5 } } };
    writeFileSync(
      f,
      [
        { type: "session", version: 3, id: "S" },
        { type: "message", id: "1", message: { role: "user", content: "hi" } },
        { type: "model_change", id: "2" },
        { type: "message", id: "3", message: msg },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n{torn",
    );
    const lines = eventsFromSession(f).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l["type"])).toEqual(["session", "message_end", "message_end"]);
    expect(lines[2]).toEqual({ type: "message_end", message: msg });
  });
});

/** A pi that records what an extension asks of it. */
function fakePi(onMessage: () => string = () => "") {
  const log: string[] = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const handlers = new Map<string, () => void>();
  const pi = {
    registerCommand: (name: string, o: { handler: (a: string, c: unknown) => Promise<void> }) => {
      commands.set(name, o.handler);
    },
    on: (event: string, h: () => void) => {
      handlers.set(event, h);
      return () => {};
    },
    sendUserMessage: (text: string) => {
      log.push(`message:${text.slice(0, 20)}${onMessage()}`);
    },
  } as unknown as ExtensionAPI;
  const notices: string[] = [];
  const ctx = { ui: { notify: (m: string) => notices.push(m) } };
  return { pi, log, commands, handlers, ctx, notices };
}

describe("[debug-pi] the tool uid", () => {
  const spec = (outDir: string) =>
    ({ outDir, target: { repo: "o/r", number: 1 }, cfg: {}, root: "/nowhere" }) as never;

  it("is refused where the entrypoint could not arrange the split, or named ids that are no ids", async () => {
    for (const env of [
      { QCR_TOOL_UID_REQUIRED: "1" },
      { QCR_TOOL_UID: "0", QCR_TOOL_GID: "1000" },
      { QCR_TOOL_UID: "1001" },
    ]) {
      const outDir = join(tmp, "uid-refused");
      await expect(runDebugRound(spec(outDir), { env, run: async () => 0 })).rejects.toThrow(
        /debug round in pi: .*(--cap-add SETUID|non-zero numeric ids)/,
      );
      // nothing was written
      expect(existsSync(outDir)).toBe(false);
    }
  });

  it("starts pi through setpriv as the tool uid, with its own argv and env after it", async () => {
    const dir = mkdtempSync(join(tmp, "uid-split-"));
    const root = mkRoot(dir, "root");
    const outDir = join(dir, "out");
    const cwd = join(dir, "work");
    mkdirSync(cwd);
    const cfg = benchConfig("");
    let launched: { bin: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
    await runDebugRound(
      {
        root,
        cwd,
        agentScope: "user",
        agentDir: join(dir, "agent"),
        tree: mkTree(dir, "tree"),
        files: FILES,
        target: TARGET,
        outDir,
        cfg,
        ecosystem: ecosystemFor("none"),
        timeoutMs: 60_000,
        prompts: {
          system: "You are the reviewer.",
          order: "ROUND ORDER",
          plannedLenses: [],
          passPlan: [],
          taskFiles: [],
        },
      },
      {
        piBin: "pi-under-test",
        env: { PATH: "/usr/bin", QCR_TOOL_UID: "65534", QCR_TOOL_GID: "1000", GITHUB_TOKEN: "x" },
        run: async (cmd) => {
          launched = cmd;
          return 0;
        },
      },
    );
    expect(launched!.bin).toBe("setpriv");
    expect(launched!.args.slice(0, 7)).toEqual([
      "--reuid=65534",
      "--regid=1000",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
    ]);
    expect(launched!.args[7]).toBe("pi-under-test");
    expect(launched!.args).toContain(DEBUG_START_MESSAGE);
    expect(launched!.env["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("starts pi as it is where nothing asks for a split, or the shared uid was accepted", async () => {
    for (const env of [{}, { QCR_TOOL_UID_REQUIRED: "1", QCR_ALLOW_SHARED_TOOL_UID: "1" }]) {
      const dir = mkdtempSync(join(tmp, "uid-none-"));
      let bin = "";
      await runDebugRound(
        {
          root: mkRoot(dir, "root"),
          cwd: dir,
          agentScope: "user",
          agentDir: join(dir, "agent"),
          tree: mkTree(dir, "tree"),
          files: FILES,
          target: TARGET,
          outDir: join(dir, "out"),
          cfg: benchConfig(""),
          ecosystem: ecosystemFor("none"),
          timeoutMs: 60_000,
          prompts: {
            system: "s",
            order: "o",
            plannedLenses: [],
            passPlan: [],
            taskFiles: [],
          },
        },
        {
          piBin: "pi-under-test",
          env,
          run: async (cmd) => {
            bin = cmd.bin;
            return 0;
          },
        },
      );
      expect(bin).toBe("pi-under-test");
    }
  });
});

describe("[debug-round] the extension command", () => {
  const taskDir = (name: string, rows: string[]): string => {
    const dir = join(tmp, name, "tasks");
    mkdirSync(dir, { recursive: true });
    for (const r of rows) writeFileSync(join(dir, r), `task ${r}\n`);
    return dir;
  };

  function rig(rows: string[]) {
    const id = `rig-${Math.random().toString(36).slice(2, 8)}`;
    const tasks = taskDir(id, rows);
    const wave = new LensWave();
    // what the board holds at the moment the order goes out
    const f = fakePi(() => ` rows=${wave.rows().length}`);
    const seen: Array<{ agent: string; signal?: AbortSignal }> = [];
    const runner: WaveRunner = {
      run: async (request) => {
        f.log.push(`lens:${request.agent}`);
        seen.push({ agent: request.agent, ...(request.signal ? { signal: request.signal } : {}) });
        return {
          text: "nothing",
          result: {
            agent: request.agent,
            model: "m",
            usage: { input: 0, output: 0, cacheRead: 0, cost: 0 },
            messages: [],
            exitCode: 0,
          },
        };
      },
    };
    const statusFile = join(tmp, id, "debug-round.json");
    void createDebugRound({
      lens: { factory: () => {}, runner, wave },
      order: "ROUND ORDER: review the PR.",
      tasksDir: tasks,
      env: { QCR_SANDBOX_ROOT: ROOT, QCR_LAUNCH_PLAN_DIRS: tasks },
      statusFile,
    })(f.pi);
    const status = (): DebugStatus => JSON.parse(readFileSync(statusFile, "utf8")) as DebugStatus;
    return { ...f, wave, seen, status, statusFile };
  }

  it("registers /qcr-round and waits: nothing runs until it is invoked", () => {
    const r = rig(["01-pass-a.md"]);
    expect([...r.commands.keys()]).toEqual([DEBUG_ROUND_COMMAND]);
    expect(r.log).toEqual([]);
    expect(r.status()).toMatchObject({ state: "waiting", wave: [] });
  });

  it("launches the planned wave, never the validator, and only then sends the order", async () => {
    const r = rig(["01-pass-a.md", "02-pass-b.md", "03-pass-validate.md"]);
    await r.commands.get(DEBUG_ROUND_COMMAND)!("", r.ctx);
    // both rows are on the board, started by the engine, before the order goes out
    expect(r.log.filter((l) => l.startsWith("lens:")).sort()).toEqual([
      "lens:pass-a",
      "lens:pass-b",
    ]);
    expect(r.log.find((l) => l.startsWith("message:"))).toBe("message:ROUND ORDER: review  rows=2");
    expect(r.wave.rows().map((x) => x.origin)).toEqual(["engine", "engine"]);
    await Promise.all(r.wave.rows().map((x) => x.done));
    await new Promise((res) => setTimeout(res, 10));
    expect(r.status()).toMatchObject({
      state: "started",
      wave: ["pass-a", "pass-b"],
      wave_settled: 2,
    });
    expect(r.status().order_sent_at).toBeTruthy();
    expect(r.notices[0]).toMatch(/2 lenses launched/);
  });

  it("is idempotent: a second /qcr-round starts nothing and sends nothing", async () => {
    const r = rig(["01-pass-a.md"]);
    await r.commands.get(DEBUG_ROUND_COMMAND)!("", r.ctx);
    const before = [...r.log];
    await r.commands.get(DEBUG_ROUND_COMMAND)!("", r.ctx);
    expect(r.log).toEqual(before);
    expect(r.notices.at(-1)).toMatch(/already started/);
  });

  it("ends the lenses it started when pi shuts down", async () => {
    const r = rig(["01-pass-a.md"]);
    await r.commands.get(DEBUG_ROUND_COMMAND)!("", r.ctx);
    expect(r.seen[0]!.signal?.aborted).toBe(false);
    r.handlers.get("session_shutdown")!();
    expect(r.seen[0]!.signal?.aborted).toBe(true);
  });

  it("a round with no task files still sends the order, and says why when the wave cannot be planned", async () => {
    const none = rig([]);
    await none.commands.get(DEBUG_ROUND_COMMAND)!("", none.ctx);
    expect(none.log).toEqual(["message:ROUND ORDER: review  rows=0"]);
    expect(none.status().wave_error).toMatch(/no discovery task files/);
    expect(none.notices[0]).toMatch(/wave not planned/);
  });

  it("merges fields into the status file instead of replacing it", () => {
    const f = join(tmp, "patch.json");
    patchStatus(f, { dispatcher: "reused" });
    patchStatus(f, { state: "started" });
    expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({
      dispatcher: "reused",
      state: "started",
    });
    expect(() =>
      patchStatus(join(tmp, "no", "such", "dir", "x.json"), { state: "waiting" }),
    ).not.toThrow();
  });
});

// ---- the smoke: the real pi in a pty ----------------------------------------------

const hasScript = spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!hasScript || process.platform !== "linux")(
  "[debug-pi] smoke: the real pi CLI in a pty, on a local endpoint",
  () => {
    let server: FakeOpenAI;
    beforeAll(async () => {
      server = await startFakeOpenAI();
    });
    afterAll(async () => {
      await server.close();
    });

    it("starts the round from /qcr-round, runs the wave in-process, keeps every JSONL, and the main session resumes under its id", async () => {
      const dir = mkdtempSync(join(tmp, "smoke-"));
      // Under the image's tool-uid split (tests/tool-uid-container.test.ts runs this
      // smoke so) pi is another uid of the same gid: it must reach what mkdtemp
      // made private. The login copy is opened by the route itself (debugpi.ts).
      if (process.env["QCR_TOOL_UID"] !== undefined) {
        chmodSync(tmp, 0o775);
        chmodSync(dir, 0o775);
      }
      const agentDir = join(dir, "agent");
      writeFakeProvider(agentDir, server.baseUrl);
      writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      for (const a of ["pass-a", "pass-b"])
        writeFileSync(
          join(agentDir, "agents", `${a}.md`),
          `---\nname: ${a}\ndescription: ${a}\nmodel: ${FAKE_MODEL}\ntools: read, bash\n---\nYou are ${a}.\n`,
        );
      const root = mkRoot(dir, "root");
      const tree = mkTree(dir, "tree");
      const outDir = join(dir, "out");
      const cwd = join(dir, "work");
      mkdirSync(cwd);
      copyFileSync(join(ROOT, REVIEWER_STUB), join(cwd, HOST_CONTEXT_STUB));
      const cfg = benchConfig("");
      cfg.models.conversation = FAKE_MODEL;
      server.script(Array.from({ length: 12 }, () => ({ text: "ok" })));

      const result = await runDebugRound(
        {
          root,
          cwd,
          agentScope: "user",
          agentDir,
          tree,
          files: FILES,
          target: TARGET,
          outDir,
          cfg,
          ecosystem: ecosystemFor("none"),
          timeoutMs: 60_000,
          prompts: {
            system: "You are the reviewer.",
            order: "ROUND ORDER: review the PR.",
            plannedLenses: ["pass-a", "pass-b"],
            passPlan: [],
            taskFiles: ["01-pass-a.md", "02-pass-b.md"].map((f) => ({
              path: join(outDir, "tasks", f),
              text: `task ${f}\n`,
            })),
          },
        },
        {
          piBin: PI_BIN,
          env: {
            ...process.env,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            TERM: "xterm-256color",
            GITHUB_TOKEN: "ghp_smoke_token",
          },
          // The pty: `script` gives pi a terminal; the test plays the person.
          run: (cmd) =>
            new Promise<number>((done) => {
              const line = `stty cols 140 rows 50; exec ${[cmd.bin, ...cmd.args].map(q).join(" ")}`;
              const child = spawn("script", ["-qefc", line, "/dev/null"], {
                cwd: cmd.cwd,
                env: cmd.env,
                stdio: ["pipe", "pipe", "pipe"],
              });
              child.stdout.resume();
              const t0 = Date.now();
              const poll = setInterval(() => {
                let wave = 0;
                try {
                  wave = (
                    JSON.parse(
                      readFileSync(join(outDir, "debug-round.json"), "utf8"),
                    ) as DebugStatus
                  ).wave_settled;
                } catch {
                  // not written yet
                }
                const main = mainSessionOf(outDir);
                const answered =
                  main !== null && readFileSync(main, "utf8").includes('"role":"assistant"');
                if ((wave >= 2 && answered) || Date.now() - t0 > 45_000) {
                  clearInterval(poll);
                  // ^D on an empty editor: the person leaves pi
                  child.stdin.write("\x04");
                  setTimeout(() => child.kill("SIGKILL"), 10_000);
                }
              }, 250);
              child.on("close", (c) => {
                clearInterval(poll);
                done(c ?? 1);
              });
            }),
        },
      );

      // the round: started from the command, wave in plan order, joined by the session
      const status = JSON.parse(
        readFileSync(join(outDir, "debug-round.json"), "utf8"),
      ) as DebugStatus;
      expect(status).toMatchObject({
        state: "started",
        wave: ["pass-a", "pass-b"],
        wave_settled: 2,
      });
      // the lens passes reused the CLI pi's HTTP dispatcher and installed none
      expect(status.dispatcher).toBe("reused");
      // the endpoint heard the main session and the two passes, and nothing else
      expect(server.requests).toHaveLength(3);
      const bodies = server.requests.map((r) => r.body);
      expect(bodies.some((b) => b.includes("You are the reviewer."))).toBe(true);
      expect(bodies.filter((b) => b.includes("You are pass-")).length).toBe(2);
      expect(bodies.join("")).not.toContain("ghp_smoke_token");
      // the order, not the command, is the main session's first user message
      const main = mainSessionOf(outDir)!;
      const text = readFileSync(main, "utf8");
      expect(text).toContain("ROUND ORDER: review the PR.");
      expect(text).not.toContain('"content":"/qcr-round"');
      // every lens left a JSONL a pi can open, under the id its ledger line names
      const kept = lensSessionsOf(outDir);
      expect(kept).toHaveLength(2);
      const ledgerIds = readFileSync(join(outDir, "lens-ledger.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { id: string }).id);
      expect(kept.map((k) => k.id).sort()).toEqual([...ledgerIds].sort());
      // usage came from the kept session (interactive pi prints no event stream)
      expect(result.usage).toBeDefined();
      expect(result.costUsd).not.toBeNull();
      expect(result.piRun.code).toBe(0);
      // `qcr open` finds the main session and a lens by agent name... (ambiguous ids aside)
      const deps = {
        detachedHome: join(dir, "d"),
        runsDir: join(dir, "r"),
        scanDir: join(dir, "s"),
        root: ROOT,
        cwd: dir,
        env: {},
        out: () => {},
        prepare: () => {
          throw new Error("not here");
        },
        spawn: () => 0,
      };
      expect(findSession(outDir, undefined, deps)).toMatchObject({ ok: true, file: main });
      expect(findSession(outDir, kept[0]!.id, deps)).toMatchObject({ ok: true, kind: "lens" });

      // the kept main session resumes with the same id and appends to the same file
      const firstLine = JSON.parse(text.split("\n", 1)[0]!) as { id: string };
      writeFakeProvider(join(dir, "resume-agent"), server.baseUrl);
      const host = await PiHost.create({ agentDir: join(dir, "resume-agent") });
      server.script([{ text: "back again" }]);
      const before = server.requests.length;
      try {
        const rt = sdkRuntime(host);
        const session = await rt.resume(main, {
          cwd,
          env: { PATH: process.env["PATH"] },
          model: FAKE_MODEL,
          eventsFile: join(dir, "resume-events.jsonl"),
          stderrFile: join(dir, "resume-stderr.log"),
          limits: { timeoutMs: 30_000 },
        });
        expect(session.id).toBe(firstLine.id);
        await session.followUp("one more thing");
        expect(session.sessionFile).toBe(main);
        await session.dispose();
      } finally {
        host.dispose();
      }
      expect(server.requests.length).toBe(before + 1);
      expect(readFileSync(main, "utf8")).toContain("one more thing");
      expect(existsSync(join(outDir, "round-order.md"))).toBe(true);

      // `qcr open` on the round the debug route left: the REAL pi shows the kept
      // session in a pty, forked, and the finished JSONL stays byte-for-byte as it was.
      const kept0 = readFileSync(main, "utf8");
      let screen = "";
      let prepared: { agentDir: string; cwd: string } | undefined;
      const code = await runOpen([outDir], false, {
        ...deps,
        root,
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          TERM: "xterm-256color",
          GITHUB_TOKEN: "ghp_smoke",
        },
        piBin: PI_BIN,
        out: () => {},
        prepare: ({ roundDir }) => {
          const agent = join(roundDir, "open-agent");
          const work = join(roundDir, "open-cwd");
          writeFakeProvider(agent, server.baseUrl);
          writeFileSync(join(agent, "auth.json"), "{}\n", { mode: 0o600 });
          mkdirSync(join(agent, "agents"), { recursive: true });
          mkdirSync(work, { recursive: true });
          copyFileSync(join(ROOT, REVIEWER_STUB), join(work, HOST_CONTEXT_STUB));
          prepared = { agentDir: agent, cwd: work };
          return {
            agentDir: agent,
            cwd: work,
            cleanup: () => {
              rmSync(agent, { recursive: true, force: true });
              rmSync(work, { recursive: true, force: true });
            },
          };
        },
        spawn: (cmd) =>
          new Promise<number>((done) => {
            const line = `stty cols 140 rows 50; exec ${[cmd.bin, ...cmd.args].map(q).join(" ")}`;
            const child = spawn("script", ["-qefc", line, "/dev/null"], {
              cwd: cmd.cwd,
              env: cmd.env,
              stdio: ["pipe", "pipe", "pipe"],
            });
            child.stdout.on("data", (b: Buffer) => (screen += b.toString()));
            const t0 = Date.now();
            const poll = setInterval(() => {
              // the fork's history is on screen once the round order is
              if (screen.includes("ROUND ORDER") || Date.now() - t0 > 30_000) {
                clearInterval(poll);
                child.stdin.write("\x04");
                setTimeout(() => child.kill("SIGKILL"), 10_000);
              }
            }, 250);
            child.on("close", (c) => {
              clearInterval(poll);
              done(c ?? 1);
            });
          }),
      });
      expect(screen).toContain("ROUND ORDER");
      expect(screen).not.toMatch(/Extension error|Failed to load extension/i);
      expect(code).toBe(0);
      expect(readFileSync(main, "utf8")).toBe(kept0);
      expect(lensSessionsOf(outDir)).toHaveLength(2);
      // the copy of the login went with the open
      expect(existsSync(prepared!.agentDir)).toBe(false);
    }, 120_000);
  },
);
