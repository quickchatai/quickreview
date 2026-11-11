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
  paneLogins,
  prepareBorrowedAgent,
  readTakeoverSpec,
  runTakeover,
  takeoverArgv,
  takeoverEnv,
} from "../src/takeoverpi.js";
import { TAKEOVER_TOOLS, type TakeoverSpec } from "../src/takeover.js";
import { loginRouteConfigFromEnv } from "../extensions/login-route.js";
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

  // A route resolved in the pane must be the owner's: the remembered choice
  // lives beside the login, and the catalog pi learned since its build beside
  // pi's own files.
  // MUTATION: drop MODEL_CHOICE_FILE from LOGIN_FILES in src/takeoverpi.ts —
  // the pane's pi has no remembered choice and this fails.
  it("copies the remembered model choice from beside the login and the learned catalog from the agent dir", () => {
    const login = ownerAgent();
    writeFileSync(join(login, "qcr-model.json"), '{"choice":"the-owners"}');
    writeFileSync(join(login, "models-store.json"), '{"from":"login-dir"}');
    const agent = join(dir, "own-agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "models-store.json"), '{"from":"agent-dir"}');
    writeFileSync(join(agent, "qcr-model.json"), '{"choice":"not-this-one"}');
    const borrow = join(dir, "borrow");
    prepareBorrowedAgent({
      agent_dir: agent,
      login_dir: login,
      borrow_dir: borrow,
      idle_ms: 60_000,
    });
    expect(readFileSync(join(borrow, "qcr-model.json"), "utf8")).toBe('{"choice":"the-owners"}');
    expect(readFileSync(join(borrow, "models-store.json"), "utf8")).toBe('{"from":"agent-dir"}');
    for (const name of ["qcr-model.json", "models-store.json"])
      expect(statSync(join(borrow, name)).mode & 0o777).toBe(0o600);
    // the owner's files are as they were
    expect(readFileSync(join(login, "qcr-model.json"), "utf8")).toBe('{"choice":"the-owners"}');
    // with no shared login dir, both come from the one agent dir
    const single = join(dir, "borrow-2");
    prepareBorrowedAgent({ agent_dir: login, borrow_dir: single, idle_ms: 60_000 });
    expect(readFileSync(join(single, "qcr-model.json"), "utf8")).toBe('{"choice":"the-owners"}');
    expect(readFileSync(join(single, "models-store.json"), "utf8")).toBe('{"from":"login-dir"}');
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

  // A login of a provider the session does not run on decides nothing: it is
  // left out of the copy, and the pane starts on the logins that last.
  // MUTATION: call copyPiAuth with no `providers` in prepareBorrowedAgent
  // (src/takeoverpi.ts) — the earliest expiry in the whole file refuses the
  // pane, and this fails.
  it("a login of another provider that is about to expire is left out of the copy, never a refusal", async () => {
    const agent = ownerAgent();
    const logins = JSON.parse(readFileSync(join(agent, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(agent, "auth.json"),
      JSON.stringify({
        ...logins,
        elsewhere: {
          type: "oauth",
          access: "SHORT",
          refresh: "SHORT-REFRESH",
          expires: Date.now() + 10 * 60_000,
        },
      }),
    );
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
    expect(lines).toEqual([]);
    expect(code).toBe(0);
    expect(ran).toBe(true);
    const copy = JSON.parse(
      readFileSync(join(dir, "run", "takeover-pr-7.agent", "auth.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(copy)).toEqual(["openai-codex"]);
  });

  // MUTATION: return `lasting` alone from paneLogins (src/takeoverpi.ts) — a
  // pane pinned to a model whose login dies inside the window starts on a
  // copy without it, and this fails.
  it("the pinned model's own login must last: a short one refuses the pane whatever else lasts", async () => {
    const agent = ownerAgent();
    const logins = JSON.parse(readFileSync(join(agent, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(agent, "auth.json"),
      JSON.stringify({
        ...logins,
        faux: { type: "oauth", access: "F", refresh: "F-R", expires: Date.now() + 10 * 60_000 },
      }),
    );
    const lines: string[] = [];
    const code = await runTakeover(specFile(), {
      env: { PATH: "/usr/bin" },
      log: (l) => lines.push(l),
      run: async () => 0,
    });
    expect(code).toBe(3);
    expect(lines.join("\n")).toMatch(/the faux access token expires at/);
    expect(existsSync(join(dir, "run", "takeover-pr-7.agent", "auth.json"))).toBe(false);
  });

  it("paneLogins: the lasting logins, the pin's own kept to be refused, and the whole file when nothing is left", () => {
    const now = 1_000_000;
    const raw = JSON.stringify({
      long: { type: "oauth", expires: now + 60 * 60_000 },
      key: { type: "api_key", key: "k" },
      short: { type: "oauth", expires: now + 60_000 },
    });
    const of = (pin: string | null, keyed = false, text = raw): string[] | undefined =>
      paneLogins(text, { needMs: 30 * 60_000, now, pin, keyed });
    expect(of(null)).toEqual(["long", "key"]);
    expect(of("long")).toEqual(["long", "key"]);
    expect(of("short")).toEqual(["long", "key", "short"]);
    // a provider with no stored login (its credential is a key) decides nothing
    expect(of("absent")).toEqual(["long", "key"]);
    const onlyShort = JSON.stringify({ short: { type: "oauth", expires: now + 60_000 } });
    // nothing lasts and no key is handed over: the whole file is judged, and refuses
    expect(of(null, false, onlyShort)).toBeUndefined();
    // with a key the pi runs on it: the short login is left out
    expect(of(null, true, onlyShort)).toEqual([]);
    expect(of("short", true, onlyShort)).toEqual(["short"]);
  });

  it("with a key file a login that is about to expire is left out and the pi starts on the key", async () => {
    ownerAgent(10 * 60_000);
    const secrets = join(dir, "secrets");
    mkdirSync(join(secrets, "model-env"), { recursive: true });
    writeFileSync(join(secrets, "model-env", "NORTH_API_KEY"), "north-key-value\n");
    const base = JSON.parse(readFileSync(specFile(), "utf8")) as TakeoverSpec;
    const lines: string[] = [];
    const code = await runTakeover(specFile({ env: { ...base.env, QCR_SECRETS_DIR: secrets } }), {
      env: { PATH: "/usr/bin" },
      log: (l) => lines.push(l),
      run: async () => 0,
    });
    expect(lines).toEqual([]);
    expect(code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(dir, "run", "takeover-pr-7.agent", "auth.json"), "utf8")),
    ).toEqual({});
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

  // MUTATION: drop the model env from takeoverEnv's result (or never read it
  // in runTakeover) - the pi starts with no credential at all; this fails.
  // MUTATION: pass `false` for `keyed` in runTakeover - the pane dies at the
  // login copy with "no pi login"; this fails.
  it("with no login but a key file in the secrets dir the pi starts on the key, which no spec file holds", async () => {
    mkdirSync(join(dir, "agent"));
    const secrets = join(dir, "secrets");
    mkdirSync(join(secrets, "model-env"), { recursive: true });
    writeFileSync(join(secrets, "model-env", "NORTH_API_KEY"), "north-key-value\n");
    const base = JSON.parse(readFileSync(specFile(), "utf8")) as TakeoverSpec;
    const file = specFile({ env: { ...base.env, QCR_SECRETS_DIR: secrets } });
    expect(readFileSync(file, "utf8")).not.toMatch(/north-key-value/);
    const seen: Array<{ env: NodeJS.ProcessEnv }> = [];
    const lines: string[] = [];
    const code = await runTakeover(file, {
      env: { PATH: "/usr/bin" },
      log: (l) => lines.push(l),
      run: async (cmd) => {
        seen.push(cmd);
        return 0;
      },
    });
    expect(lines).toEqual([]);
    expect(code).toBe(0);
    expect(seen[0]!.env["NORTH_API_KEY"]).toBe("north-key-value");
    const borrowed = join(dir, "run", "takeover-pr-7.agent");
    expect(seen[0]!.env["PI_CODING_AGENT_DIR"]).toBe(borrowed);
    expect(existsSync(join(borrowed, "auth.json"))).toBe(false);
  });

  it("with a login and a key file the login is borrowed as ever and the key rides along", async () => {
    ownerAgent();
    const secrets = join(dir, "secrets");
    mkdirSync(join(secrets, "model-env"), { recursive: true });
    writeFileSync(join(secrets, "model-env", "NORTH_API_KEY"), "north-key-value\n");
    const base = JSON.parse(readFileSync(specFile(), "utf8")) as TakeoverSpec;
    const seen: Array<{ env: NodeJS.ProcessEnv }> = [];
    const code = await runTakeover(specFile({ env: { ...base.env, QCR_SECRETS_DIR: secrets } }), {
      env: { PATH: "/usr/bin" },
      log: () => {},
      run: async (cmd) => {
        seen.push(cmd);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen[0]!.env["NORTH_API_KEY"]).toBe("north-key-value");
    expect(existsSync(join(dir, "run", "takeover-pr-7.agent", "auth.json"))).toBe(true);
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
  it("resumes the real session (not a fork) with the read tools, bash-guard and the login route", () => {
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
    // extensions: the guard first, then the login route, and nothing else (no
    // inject bridge, no lens, no memory)
    expect(argv.flatMap((a, i) => (a === "--extension" ? [argv[i + 1]] : []))).toEqual([
      spec.extensions[0]!,
      join(dir, "root", "extensions", "cli", "login-route.ts"),
    ]);
    expect(argv.join(" ")).not.toMatch(/inject-bridge|subagents|lens|ledger-pin|openviking/);
    expect(argv[argv.indexOf("--tools") + 1]!.split(",")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
    ]);
  });

  // MUTATION: pass `--model spec.model` whatever it holds — an unpinned
  // takeover starts pi with an empty `--model` and this fails.
  it("names a model only when the config pins one: with none the session resumes on its own", () => {
    const spec = JSON.parse(readFileSync(specFile(), "utf8")) as TakeoverSpec;
    const pinned = takeoverArgv(spec);
    expect(pinned[pinned.indexOf("--model") + 1]).toBe("faux/faux-1");
    const withLevel = takeoverArgv({ ...spec, model: "faux/faux-1:high" });
    expect(withLevel[withLevel.indexOf("--model") + 1]).toBe("faux/faux-1:high");
    const unpinned = takeoverArgv({ ...spec, model: "" });
    expect(unpinned).not.toContain("--model");
    expect(unpinned).not.toContain("--thinking");
    expect(unpinned).toEqual(expect.arrayContaining(["--session", spec.session_file]));
    // A level with no model is the level alone.
    const level = takeoverArgv({ ...spec, model: ":high" });
    expect(level).not.toContain("--model");
    expect(level[level.indexOf("--thinking") + 1]).toBe("high");
  });

  // MUTATION: drop QCR_LOGIN_OPEN from takeoverEnv — the login route prefills
  // `/login` on the borrowed copy, where a login is thrown away, and this fails.
  it("tells the login route the login is a borrowed copy: no /login is offered there", () => {
    const spec = JSON.parse(readFileSync(specFile(), "utf8")) as TakeoverSpec;
    const env = takeoverEnv({ PATH: "/usr/bin", QCR_LOGIN_OPEN: "submit" }, spec);
    expect(env["QCR_LOGIN_OPEN"]).toBe("none");
    expect(loginRouteConfigFromEnv(env)).toEqual({ open: "prefill", prompt: false });
    // even a spec that asks for the menu does not get one
    expect(
      takeoverEnv({}, { ...spec, env: { ...spec.env, QCR_LOGIN_OPEN: "submit" } })[
        "QCR_LOGIN_OPEN"
      ],
    ).toBe("none");
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
        "QCR_LOGIN_OPEN",
        "QCR_SANDBOX_ROOT",
        "QCR_TAKEOVER",
      ].sort(),
    );
    // the model env goes in first: it adds its names and replaces none
    const keyed = takeoverEnv({ PATH: "/usr/bin" }, spec, {
      NORTH_API_KEY: "north-key-value",
      PATH: "/from/a/key/file",
      GH_TOKEN: "t",
    });
    expect(keyed["NORTH_API_KEY"]).toBe("north-key-value");
    expect(keyed["PATH"]).toBe("/usr/bin");
    expect(keyed["GH_TOKEN"]).toBeUndefined();
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
