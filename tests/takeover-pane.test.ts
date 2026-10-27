// The pane's side of a takeover (src/takeoverpi.ts): the borrowed login,
// the pi's argv and env, and the resume that reads what the operator said.
//
// pi is a fake: the `run` seam gets the command pi would have been started with,
// and (for the resume) appends the operator's turns to the PR's JSONL the way
// interactive pi does, through pi's own SessionManager. The worker that resumes
// the file afterwards is the real one on pi-ai's faux provider. No model, no
// network (the offline guard fails the file on any attempt).
import {
  chmodSync,
  existsSync,
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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DISABLED_REFRESH } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import {
  prepareBorrowedAgent,
  readTakeoverSpec,
  runTakeover,
  takeoverArgv,
  takeoverEnv,
} from "../src/takeoverpi.js";
import { TAKEOVER_TOOLS, type TakeoverSpec } from "../src/takeover.js";
import { LOCK_FILE } from "../src/loginrefresh/refresher.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import { bornReference, rehearseFile, type RequestShape } from "./helpers/resume-rehearsal.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

useOfflineGuard();

const HOUR = 3_600_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "takeover-pane-"));
});
afterEach(() => {
  // the read-only agent dir of one test
  try {
    chmodSync(join(dir, "agent"), 0o755);
  } catch {
    /* none */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The owner's agent dir as the refresher keeps it: a live OAuth login with a real
 * refresh token, the lock file the refresher holds, and a models file. */
function ownerAgent(expiresInMs = 24 * HOUR): string {
  const agent = join(dir, "agent");
  mkdirSync(agent, { recursive: true });
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
  writeFileSync(join(agent, LOCK_FILE), "");
  writeFileSync(join(agent, "models.json"), "{}");
  return agent;
}

function specFile(over: Partial<TakeoverSpec> = {}): string {
  const spec: TakeoverSpec = {
    v: 1,
    pr: 7,
    session: "takeover-pr-7",
    root: join(dir, "root"),
    cwd: join(dir, "root"),
    agent_dir: join(dir, "agent"),
    borrow_dir: join(dir, "run", "takeover-pr-7.agent"),
    session_file: join(dir, "root", "state", "pi-sessions", "pr-7", "s.jsonl"),
    model: "faux/faux-1",
    extensions: [join(dir, "root", "extensions", "bash-guard.ts")],
    env: {
      QCR_SANDBOX_ROOT: join(dir, "root"),
      QCR_TAKEOVER: "1",
      QCR_IPC_COMMAND_ID: "takeover-x",
    },
    idle_ms: 30 * 60_000,
    tools: TAKEOVER_TOOLS,
    ...over,
  };
  const file = join(dir, "spec.json");
  writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
  return file;
}

const listing = (d: string): string[] => readdirSync(d).sort();

describe("the takeover's login is a refresh-blanked borrowed copy", () => {
  it("has the disabled refresh token, in the pi's own agent dir, and writes nothing to the owner's", async () => {
    const agent = ownerAgent();
    const before = readFileSync(join(agent, "auth.json"), "utf8");
    const owner = listing(agent);
    const seen: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const code = await runTakeover(specFile(), {
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
        // At the moment pi would start: the copy is whole and blanked.
        const copy = JSON.parse(
          readFileSync(join(dir, "run", "takeover-pr-7.agent", "auth.json"), "utf8"),
        );
        expect(copy["openai-codex"]).toMatchObject({
          type: "oauth",
          access: "A-TOKEN",
          refresh: DISABLED_REFRESH,
        });
        expect(statSync(join(dir, "run", "takeover-pr-7.agent", "auth.json")).mode & 0o777).toBe(
          0o600,
        );
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    // the owner's login is untouched: same bytes, same files, no lock taken or made
    expect(readFileSync(join(agent, "auth.json"), "utf8")).toBe(before);
    expect(listing(agent)).toEqual(owner);
    // pi is pointed at its own copy, never the owner's dir
    expect(seen[0]!.env["PI_CODING_AGENT_DIR"]).toBe(join(dir, "run", "takeover-pr-7.agent"));
    expect(seen[0]!.env["PI_CODING_AGENT_DIR"]).not.toBe(agent);
    // the models file rides along
    expect(existsSync(join(dir, "run", "takeover-pr-7.agent", "models.json"))).toBe(true);
    // the spec file is read once and removed
    expect(existsSync(join(dir, "spec.json"))).toBe(false);
  });

  it("starts the pi the spec names when no entry override is given", async () => {
    ownerAgent();
    const seen: string[] = [];
    const code = await runTakeover(specFile({ pi_bin: "/opt/own-pi" }), {
      env: { PATH: "/usr/bin", HOME: "/home/qcr", QCR_IPC_CAP_FD: "3" },
      run: async (cmd) => {
        seen.push(cmd.bin);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["/opt/own-pi"]);
  });

  it("copies from a dir it may only read, while the refresher holds its lock", () => {
    const agent = ownerAgent();
    chmodSync(join(agent, "auth.json"), 0o444);
    chmodSync(agent, 0o555);
    const spec = { agent_dir: agent, borrow_dir: join(dir, "borrow"), idle_ms: 30 * 60_000 };
    expect(() => prepareBorrowedAgent(spec)).not.toThrow();
    expect(
      JSON.parse(readFileSync(join(dir, "borrow", "auth.json"), "utf8"))["openai-codex"].refresh,
    ).toBe(DISABLED_REFRESH);
  });

  // MUTATION: copy auth.json from spec.agent_dir in prepareBorrowedAgent — this fails.
  it("borrows the login from the shared login dir, and models and settings from the agent dir", () => {
    const login = ownerAgent();
    const agent = join(dir, "own-agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "models.json"), '{"own":true}');
    const borrow = join(dir, "borrow");
    prepareBorrowedAgent({
      agent_dir: agent,
      login_dir: login,
      borrow_dir: borrow,
      idle_ms: 60_000,
    });
    expect(
      JSON.parse(readFileSync(join(borrow, "auth.json"), "utf8"))["openai-codex"].refresh,
    ).toBe(DISABLED_REFRESH);
    expect(readFileSync(join(borrow, "models.json"), "utf8")).toBe('{"own":true}');
  });

  it("is refused, with no pi, when the token would expire inside the lease's window", async () => {
    ownerAgent(10 * 60_000);
    const lines: string[] = [];
    let ran = false;
    const code = await runTakeover(specFile(), {
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
    expect(existsSync(join(dir, "run", "takeover-pr-7.agent", "auth.json"))).toBe(false);
  });

  it("is refused when there is no login at all", async () => {
    mkdirSync(join(dir, "agent"));
    const lines: string[] = [];
    expect(
      await runTakeover(specFile(), {
        env: { PATH: "/usr/bin" },
        log: (l) => lines.push(l),
        run: async () => 0,
      }),
    ).toBe(3);
    expect(lines.join("\n")).toMatch(/no pi login/);
  });

  it("refuses a file that is not a takeover spec", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ v: 2 }));
    expect(() => readTakeoverSpec(file)).toThrow(/not a takeover spec/);
    writeFileSync(file, JSON.stringify({ v: 2 }));
    expect(await runTakeover(file, { log: () => {}, run: async () => 0 })).toBe(2);
  });
});

describe("the pi the pane starts", () => {
  it("resumes the real session (not a fork) with the read tools and bash-guard only", () => {
    const spec = JSON.parse(readFileSync(specFile(), "utf8")) as TakeoverSpec;
    const argv = takeoverArgv(spec);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--session",
        spec.session_file,
        "--tools",
        "read,grep,find,ls,bash",
        "--extension",
        spec.extensions[0]!,
        "--name",
        "takeover-pr-7",
        "-ne",
        "-ns",
      ]),
    );
    expect(argv).not.toContain("--fork");
    expect(argv).not.toContain("--continue");
    // extensions: the guard and nothing else (no inject bridge, no lens, no memory)
    expect(argv.filter((a) => a === "--extension")).toHaveLength(1);
    expect(argv.join(" ")).not.toMatch(/inject-bridge|subagents|lens|ledger-pin|openviking/);
    expect(argv[argv.indexOf("--tools") + 1]!.split(",")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
    ]);
  });

  it("gets an env with no GitHub token of any name and nothing it was not given", () => {
    const spec = JSON.parse(readFileSync(specFile(), "utf8")) as TakeoverSpec;
    const env = takeoverEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/qcr",
        GITHUB_TOKEN: "x",
        GH_TOKEN: "y",
        GH_ENTERPRISE_TOKEN: "z",
        OPENAI_API_KEY: "sk",
        QCR_IPC_CAP_FD: "3",
        AWS_SECRET_ACCESS_KEY: "s",
      },
      spec,
    );
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "QCR_IPC_CAP_FD",
        "QCR_IPC_COMMAND_ID",
        "QCR_SANDBOX_ROOT",
        "QCR_TAKEOVER",
      ].sort(),
    );
    // even a spec that names a token (it must not) does not pass one on
    const dirty = takeoverEnv(
      {},
      { ...spec, env: { ...spec.env, GITHUB_TOKEN: "t", GH_TOKEN: "t" } },
    );
    expect(dirty["GITHUB_TOKEN"]).toBeUndefined();
    expect(dirty["GH_TOKEN"]).toBeUndefined();
  });
});

describe("the resume reads the operator's turns", () => {
  let born: RequestShape;
  beforeAll(async () => {
    born = await bornReference();
  }, HEAVY_TIMEOUT_MS);

  it(
    "a worker resuming the JSONL after a takeover replays what the operator said and answered",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // The PR's session as the bot's last round left it.
      const sessions = join(dir, "pr-7");
      mkdirSync(sessions, { recursive: true });
      const work = join(dir, "root");
      mkdirSync(work, { recursive: true });
      const bot = SessionManager.create(work, sessions);
      bot.appendMessage({
        role: "user",
        content: [{ type: "text", text: "ROUND ORDER: review PR 7" }],
        timestamp: 1,
      });
      bot.appendMessage(fauxAssistantMessage("Round 1: one blocker on a.py:3."));
      const file = bot.getSessionFile()!;
      expect(file).toBeDefined();
      const botLines = readFileSync(file, "utf8");

      // The takeover: the pi opens THAT file and the operator talks to it.
      ownerAgent();
      const code = await runTakeover(specFile({ session_file: file }), {
        env: { PATH: "/usr/bin" },
        run: async (cmd) => {
          expect(cmd.args[cmd.args.indexOf("--session") + 1]).toBe(file);
          const pi = SessionManager.open(file, sessions, work);
          pi.appendMessage({
            role: "user",
            content: [{ type: "text", text: "OPERATOR: why is a.py:3 a blocker?" }],
            timestamp: 2,
          });
          pi.appendMessage(
            fauxAssistantMessage("It dereferences the value before the null check."),
          );
          return 0;
        },
      });
      expect(code).toBe(0);

      // Append-only: the bot's history is byte-for-byte what it was, in the same file.
      const after = readFileSync(file, "utf8");
      expect(after.startsWith(botLines)).toBe(true);
      expect(readdirSync(sessions).filter((f) => f.endsWith(".jsonl"))).toEqual([
        file.slice(file.lastIndexOf("/") + 1),
      ]);

      // What the next worker resumes: pi's own replay carries both operator turns.
      const replay = JSON.stringify(
        SessionManager.open(file, sessions, work).buildSessionContext().messages,
      );
      expect(replay).toContain("OPERATOR: why is a.py:3 a blocker?");
      expect(replay).toContain("It dereferences the value before the null check.");
      expect(replay.indexOf("ROUND ORDER")).toBeLessThan(replay.indexOf("OPERATOR:"));

      // And the real worker, on the faux provider, resumes that file under the same id:
      // it replays the longer history, appends only, and starts no second session.
      const row = await rehearseFile(file, "takeover", born);
      expect(row.problems).toEqual([]);
      expect(row.resumed).toBe(true);
      expect(row.idKept).toBe(true);
      expect(row.historyKept).toBe(true);
      expect(row.replayed).toBeGreaterThanOrEqual(4);
    },
  );
});
