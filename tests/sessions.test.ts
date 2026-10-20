// Session manager tests. Every process invocation goes through a fake exec
// that records commands — no tmux, no pi, no git is ever spawned. Filesystem
// work happens inside a temp sandbox root.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  PiSessionManager,
  OVERSEER_SESSION,
  buildPiCommand,
  isSandboxSession,
  prOfSession,
  prSessionName,
} from "../src/sessions.js";
import { Tmux } from "../src/tmux.js";
import type { ExecFn } from "../src/tmux.js";
import { writeSessionBridgeState } from "../src/overseer-bridge.js";
import { type StateStore } from "../src/state.js";
import { WorktreeManager } from "../src/worktrees.js";
import { piAuthWatchDirs } from "../src/wire.js";
import { PiAuthWatch } from "../src/authwatch.js";

let root: string;
let secrets: string;
let calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
let liveSessions: Set<string>;
let onListSessions: (() => void) | undefined;
let onKillSession: ((name: string) => void) | undefined;
let onNewSession: ((name: string, args: string[]) => void) | undefined;
let autoBridgeReady = true;
let keepKilledSession = false;

const cfg = (): Config =>
  ({
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
      secrets_dir: secrets,
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
    },
    engine: {
      runtime: "sdk",
      lens_max_concurrency: 6,
      lens_cache_group: 5,
      lens_cache_stagger_ms: 2500,
      lens_pass_deadline_min: 8,
    },
    // Only the fields sessions.ts reads: the loopback endpoint the
    // sessions authenticate against, and the SERVER's ov.conf — passed so the
    // fork's root-key guard reads the real file instead of guessing from HOME.
    openviking: { host: "127.0.0.1", port: 1933, config_file: join(root, "ovhome", "ov.conf") },
  }) as unknown as Config;

/** Fake exec: records everything, fakes tmux list/has from `liveSessions`. */
const fakeExec: ExecFn = async (cmd, args, opts) => {
  calls.push({ cmd, args, env: opts?.env });
  if (cmd === "tmux") {
    if (args[0] === "list-sessions") {
      onListSessions?.();
      return { code: 0, stdout: [...liveSessions].join("\n"), stderr: "" };
    }
    if (args[0] === "has-session") {
      const name = String(args[2]).replace(/^=/, "");
      return { code: liveSessions.has(name) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "new-session") {
      const session = String(args[3]);
      liveSessions.add(session);
      onNewSession?.(session, args);
      if (autoBridgeReady) {
        const generation = args
          .find((value) => value.startsWith("QCR_SESSION_BRIDGE_GENERATION="))
          ?.split("=", 2)[1];
        const stateFile = args
          .find((value) => value.startsWith("QCR_SESSION_BRIDGE_STATE_FILE="))
          ?.slice("QCR_SESSION_BRIDGE_STATE_FILE=".length);
        if (generation && stateFile) {
          writeSessionBridgeState(stateFile, {
            version: 1,
            session,
            generation,
            stage: "ready",
            run_status: "idle",
            compaction: { state: "idle", seq: 0 },
            updated_at: "2026-08-13T10:00:00.000Z",
          });
        }
      }
    }
    if (args[0] === "kill-session") {
      const name = String(args[2]).replace(/^=/, "");
      onKillSession?.(name);
      if (!keepKilledSession) liveSessions.delete(name);
    }
  }
  return { code: 0, stdout: "", stderr: "" };
};

/** Records the OpenViking session lifecycle calls — no server, no HTTP. */
let ovCalls: string[];
const ovSessions = {
  create: async (id: string) => {
    ovCalls.push(`create ${id}`);
    return true;
  },
  remove: async (id: string) => {
    ovCalls.push(`delete ${id}`);
    return true;
  },
};

function manager(
  now = () => new Date("2026-08-13T10:00:00Z"),
  store?: StateStore,
  config = cfg(),
): PiSessionManager {
  return new PiSessionManager({
    cfg: config,
    root,
    tmux: new Tmux({ exec: fakeExec }),
    worktrees: new WorktreeManager({
      root,
      repo: "o/n",
      cloneDir: "example-app",
      cloneUrl: "/dev/null",
      run: fakeExec,
    }),
    piHome: join(root, "pihome"),
    ovSessions,
    now,
    ...(store ? { commandStore: store } : {}),
  });
}

function markExistingSessionReady(m: PiSessionManager, session: string): void {
  const generation = `existing-${session}`;
  liveSessions.add(session);
  mkdirSync(join(root, "state", "sessions"), { recursive: true });
  writeFileSync(
    join(root, "state", "sessions", `${session}.json`),
    `${JSON.stringify({ session, born_at: "2026-08-13T09:00:00.000Z", bridge_generation: generation })}\n`,
  );
  writeSessionBridgeState(m.bridgeStatePath(session, generation), {
    version: 1,
    session,
    generation,
    stage: "ready",
    updated_at: "2026-08-13T09:00:00.000Z",
  });
}

function tmuxArgs(): string[][] {
  return calls.filter((c) => c.cmd === "tmux").map((c) => c.args);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-sess-"));
  secrets = join(root, "secrets");
  calls = [];
  ovCalls = [];
  liveSessions = new Set();
  onListSessions = undefined;
  onKillSession = undefined;
  onNewSession = undefined;
  autoBridgeReady = true;
  keepKilledSession = false;
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(
    join(root, "prompts", "conversation-system.md"),
    "Shepherd of PR #{{n}} ({{title}}) at {{worktree}}.\n",
  );
  writeFileSync(join(root, "prompts", "overseer-system.md"), "You are the overseer.\n");
  writeFileSync(join(secrets, "openai_api_key"), "sk-app-key\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it("removes only the confirmed-gone session birth and bridge metadata", () => {
  const directory = join(root, "state", "sessions");
  mkdirSync(directory, { recursive: true });
  const removed = [
    "smoke-fixture.json",
    "smoke-fixture.bridge-old.json",
    "smoke-fixture.bridge-new.json",
  ];
  const retained = [
    "pr-7.json",
    "pr-7.bridge-old.json",
    "smoke-fixture-other.bridge-old.json",
    "smoke-fixture.bridge-not-json",
  ];
  for (const name of [...removed, ...retained]) writeFileSync(join(directory, name), "fixture");
  manager().removeSessionBirthMetadata("smoke-fixture");
  for (const name of removed) expect(existsSync(join(directory, name))).toBe(false);
  for (const name of retained) expect(existsSync(join(directory, name))).toBe(true);
});

describe("session naming", () => {
  it("maps PR numbers to session names and back", () => {
    expect(prSessionName(42)).toBe("pr-42");
    expect(prOfSession("pr-42")).toBe(42);
    expect(prOfSession("misc")).toBeUndefined();
    expect(isSandboxSession("overseer")).toBe(true);
    expect(isSandboxSession("pr-7")).toBe(true);
    expect(isSandboxSession("scratch")).toBe(false);
  });
});

describe("buildPiCommand", () => {
  it("pins model, session dir, system prompt and both extensions", () => {
    const argv = buildPiCommand({
      piBin: "pi",
      model: "openai/conv",
      sessionDir: "/s/state/pi-sessions/pr-1",
      systemPromptPath: "/s/state/session-prompts/pr-1.md",
      extensionPaths: ["/s/extensions/inject-bridge.ts", "/s/extensions/ledger-pin.ts"],
      sessionName: "pr-1",
    });
    expect(argv).toEqual([
      "pi",
      "--approve",
      "--model",
      "openai/conv",
      "--session-dir",
      "/s/state/pi-sessions/pr-1",
      "--system-prompt",
      "/s/state/session-prompts/pr-1.md",
      "--extension",
      "/s/extensions/inject-bridge.ts",
      "--extension",
      "/s/extensions/ledger-pin.ts",
      "--name",
      "pr-1",
    ]);
  });

  it("carries no update/auto-update flag (version is pinned by config)", () => {
    const argv = buildPiCommand({
      piBin: "pi",
      model: "m",
      sessionDir: "d",
      systemPromptPath: "p",
      extensionPaths: [],
      sessionName: "s",
    });
    expect(argv.join(" ")).not.toMatch(/update/i);
  });

  // pi's native subagent extension and its glue are retired (P9.4): lenses are
  // the engine's lens tool, and a session loads no subagent surface of any kind.
  it("loads no subagent glue or leaf-cache extension, and no stray lens hooks", () => {
    const joined = manager().extensionPaths().join("\n");
    for (const gone of ["subagents.ts", "leaf-cache.ts", "register-lens-agents", "pi-subagents"])
      expect(joined, gone).not.toContain(gone);
  });

  it("loads the vendored OpenViking fork, after ledger-pin", () => {
    const paths = manager().extensionPaths();
    const ov = join(root, "extensions", "vendor", "openviking-pi", "index.ts");
    expect(paths).toContain(ov);
    // Load order is handler-registration order in pi. ledger-pin owns
    // session_before_compact and must be registered first; the fork's own
    // compaction handler is deleted (PATCH 1), but the ordering is the
    // belt-and-braces half of that invariant.
    expect(paths.indexOf(join(root, "extensions", "ledger-pin.ts"))).toBeLessThan(
      paths.indexOf(ov),
    );
    // It rides argv, not a settings.json discovery dir: subagent children
    // load only the global settings extensions, so leaves get no memory
    // surface (the native children spawn without argv extensions).
    const argv = buildPiCommand({
      piBin: "pi",
      model: "m",
      sessionDir: "d",
      systemPromptPath: "p",
      extensionPaths: paths,
      sessionName: "pr-1",
    });
    expect(argv).toContain(ov);
  });

  it("always pre-trusts the project (--approve) — the reviewer never blocks on pi's trust modal", () => {
    const argv = buildPiCommand({
      piBin: "pi",
      model: "m",
      sessionDir: "d",
      systemPromptPath: "p",
      extensionPaths: [],
      sessionName: "s",
    });
    expect(argv).toContain("--approve");
  });
});

describe("birth", () => {
  /**
   * The config-scope pin has to be on the argv.
   *
   * tmux panes inherit the tmux SERVER's environment, not the client's
   * (the reason `ARGV_ENV_PREFIXES` exists at all).
   * A pin that rode only `buildEnv` would be present in every unit assertion
   * and absent from every real pane — silently doing nothing, which is exactly
   * the failure mode this defence exists to prevent. Against a real tmux
   * server: `tmux new-session -d -s <n> -c <cwd> env
   * GIT_CONFIG_GLOBAL=… <cmd>` puts the value in a GRANDCHILD's environment and
   * `HOME=<evil> git diff --no-index` does not execute there.
   */

  it("builds an env with the app key only — no personal credential", async () => {
    process.env.QCR_TEST_PERSONAL_TOKEN = "ghp_personal";
    try {
      const env = manager().buildEnv("pr-42", { QCR_PR: "42" });
      expect(env.OPENAI_API_KEY).toBe("sk-app-key");
      expect(env.QCR_SECRETS_DIR).toBe(secrets);
      expect(env.QCR_SESSION_NAME).toBe("pr-42");
      expect(env.QCR_INJECT_DIR).toBe(join(root, "inject", "pr-42"));
      expect(env.HOME).toBe(join(root, "pihome"));
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.QCR_TEST_PERSONAL_TOKEN).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual([
        // The config-scope pin — paths and a flag, no credential.
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_SYSTEM",
        "HOME",
        "LANG",
        "OPENAI_API_KEY",
        // Memory identity — non-secret every one of them (the reviewer key
        // rides ovcli.conf at 0600, never argv and never the environment).
        "OPENVIKING_BASE_URL",
        "OPENVIKING_CLI_CONFIG_FILE",
        "OPENVIKING_CONFIG_FILE",
        "OPENVIKING_PEER_ID",
        "OPENVIKING_URL",
        "OPENVIKING_USER",
        "PATH",
        "QCR_INJECT_DIR",
        // The leaf-cache extension's path and the prompt-cache
        // groups (below) — a path and two numbers, not credentials.
        "QCR_LEDGER_FILE",
        // Where the daemon publishes this PR's recall hint (the
        // round's own query and areas) — a path, not a credential.
        "QCR_OV_RECALL_HINT_FILE",
        // Where the daemon publishes the retired URIs the
        // extension's recall excludes — a path, not a credential.
        "QCR_OV_RETIRED_FILE",
        "QCR_OV_SESSION_ID",
        "QCR_PI_VERSION",
        "QCR_PR",
        "QCR_SANDBOX_ROOT",
        "QCR_SECRETS_DIR",
        "QCR_SESSION_NAME",
        "QCR_SUBAGENT_CACHE_GROUP",
        "QCR_SUBAGENT_CACHE_STAGGER_MS",
        // The engine lens tool's cap and per-pass deadline (minutes),
        // from config.toml [engine] lens_*.
        "QCR_SUBAGENT_MAX_CONCURRENCY",
        "QCR_SUBAGENT_PASS_DEADLINE_MIN",
        "TERM",
      ]);
      expect(env.QCR_SUBAGENT_MAX_CONCURRENCY).toBe("6");
      expect(env.QCR_SUBAGENT_PASS_DEADLINE_MIN).toBe("8");
      expect(env.QCR_OV_RETIRED_FILE).toBe(
        join(root, "pihome", ".openviking", "retired-uris.json"),
      );
      expect(env.QCR_OV_RECALL_HINT_FILE).toBe(
        join(root, "pihome", ".openviking", "recall-hints", "pr-42.json"),
      );
      // The overseer owns no PR and recalls on its own prompts: no hint file.
      expect(manager().buildEnv("overseer").QCR_OV_RECALL_HINT_FILE).toBeUndefined();
      // No credential of any kind reached the environment.
      for (const [k, v] of Object.entries(env)) {
        expect(k, `${k} must not look like an OpenViking key`).not.toMatch(/OPENVIKING.*KEY/);
        expect(String(v)).not.toContain("ov-reviewer-key");
      }
    } finally {
      delete process.env.QCR_TEST_PERSONAL_TOKEN;
    }
  });

  // The daemon hands each session the config IT loaded, so the posting
  // scripts never re-locate one (and never land on a different file than the
  // daemon's). QCR_ rides the argv, so it reaches the pane.
  it("hands the session the daemon's resolved config as QCR_CONFIG when wired", () => {
    const wired = new PiSessionManager({
      cfg: cfg(),
      root,
      tmux: new Tmux({ exec: fakeExec }),
      configPath: "/home/op/.config/qcr/default/config.toml",
    });
    expect(wired.buildEnv("pr-7").QCR_CONFIG).toBe("/home/op/.config/qcr/default/config.toml");
    expect(manager().buildEnv("pr-7").QCR_CONFIG).toBeUndefined();
  });

  it("omits the OpenAI key when the secrets dir has none", async () => {
    rmSync(join(secrets, "openai_api_key"));
    expect(manager().buildEnv("pr-1").OPENAI_API_KEY).toBeUndefined();
  });
});

describe("OpenViking identity of a session", () => {
  it("puts the whole identity on the pi command line — and no key anywhere", async () => {
    const m = manager();
    writeFileSync(join(secrets, "openviking_reviewer_key"), "ov-reviewer-key\n");
    await m.ensureOverseerSession();

    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;
    const prefix = newSession.filter((a) => a.startsWith("OPENVIKING_") || a.startsWith("QCR_OV_"));
    expect(prefix).toContain("OPENVIKING_URL=http://127.0.0.1:1933");
    expect(prefix).toContain("OPENVIKING_USER=reviewer");
    // The peer id is per-session: all sessions share one cwd, so the
    // extension's path-derived peer cannot separate two of them.
    expect(prefix).toContain("OPENVIKING_PEER_ID=overseer");
    expect(prefix).toContain(`OPENVIKING_CLI_CONFIG_FILE=${m.ovcliConfPath()}`);
    // argv is world-readable (`ps`): the key must never appear on it.
    expect(newSession.join(" ")).not.toContain("ov-reviewer-key");
  });

  it("acts as the configured [openviking] user, on argv and in ovcli.conf alike", async () => {
    const base = cfg();
    const config = {
      ...base,
      openviking: { ...base.openviking, user: "alice" },
    } as unknown as Config;
    writeFileSync(join(secrets, "openviking_reviewer_key"), "ov-reviewer-key\n");
    const m = manager(undefined, undefined, config);
    await m.ensureOverseerSession();

    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;
    expect(newSession).toContain("OPENVIKING_USER=alice");
    expect(newSession).not.toContain("OPENVIKING_USER=reviewer");
    expect(JSON.parse(readFileSync(m.ovcliConfPath(), "utf8")).user).toBe("alice");
  });

  it("the overseer gets the identity but owns no raw tier", async () => {
    const m = manager();
    await m.ensureOverseerSession();
    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;
    expect(newSession).toContain("OPENVIKING_PEER_ID=overseer");
    expect(newSession.some((a) => a.startsWith("QCR_OV_SESSION_ID="))).toBe(false);
    expect(ovCalls).toEqual([]);
  });

  it("drops the reviewer key into the pi HOME at 0600, never onto argv", async () => {
    writeFileSync(join(secrets, "openviking_reviewer_key"), "ov-reviewer-key\n");
    const m = manager();
    await m.ensureOverseerSession();

    const path = m.ovcliConfPath();
    expect(path).toBe(join(root, "pihome", ".openviking", "ovcli.conf"));
    const conf = JSON.parse(readFileSync(path, "utf8"));
    expect(conf).toEqual({
      url: "http://127.0.0.1:1933",
      user: "reviewer",
      api_key: "ov-reviewer-key",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("REFUSES to hand a session the server's root key — 401 beats omnipotent", async () => {
    mkdirSync(join(root, "ovhome"), { recursive: true });
    writeFileSync(
      join(root, "ovhome", "ov.conf"),
      JSON.stringify({ server: { root_api_key: "ROOT-KEY" } }),
    );
    writeFileSync(join(secrets, "openviking_reviewer_key"), "ROOT-KEY\n");

    const m = manager();
    const result = m.provisionOvCredentials();

    expect(result.keyed).toBe(false);
    expect(result.reason).toBe("root-key-refused");
    const conf = JSON.parse(readFileSync(m.ovcliConfPath(), "utf8"));
    expect(conf.api_key).toBeUndefined();
    expect(JSON.stringify(conf)).not.toContain("ROOT-KEY");
  });

  it("runs memory-less when the secrets mount carries no reviewer key", async () => {
    const m = manager();
    const result = m.provisionOvCredentials();
    expect(result.keyed).toBe(false);
    expect(result.reason).toBe("no-key");
    expect(JSON.parse(readFileSync(m.ovcliConfPath(), "utf8")).api_key).toBeUndefined();
  });
});

describe("overseer birth", () => {
  it("concurrent overseer births share one session", async () => {
    const m = manager();
    await Promise.all([m.ensureOverseerSession(), m.ensureOverseerSession()]);
    expect(
      tmuxArgs().filter((a) => a[0] === "new-session" && a[3] === OVERSEER_SESSION),
    ).toHaveLength(1);
  });

  it("ensureOverseerSession births the overseer session", async () => {
    const m = manager();
    await m.ensureOverseerSession();
    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;
    expect(newSession[3]).toBe(OVERSEER_SESSION);
    expect(newSession).toContain("openai/over");
    expect(
      readdirSync(m.injectDir(OVERSEER_SESSION)).filter((f) => f.endsWith(".md")),
    ).toHaveLength(0);
  });

  it("gives concurrent injections distinct filenames", async () => {
    const m = manager();
    markExistingSessionReady(m, OVERSEER_SESSION);
    m.injectFile(OVERSEER_SESSION, "one");
    m.injectFile(OVERSEER_SESSION, "two");
    const files = readdirSync(m.injectDir(OVERSEER_SESSION)).filter((f) => f.endsWith(".md"));
    expect(new Set(files).size).toBe(2);
  });
});

describe("pi auth watch coverage", () => {
  it("watches the --session-dir every PR and overseer session actually writes", () => {
    const m = manager();
    const watch = new PiAuthWatch(piAuthWatchDirs(m), () => new Date());
    for (const session of ["pr-4242", "overseer"]) {
      const dir = m.sessionDir(session);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `2026-08-13T10-00-00_${session}.jsonl`),
        '{"errorMessage":"Provided authentication token is expired."}\n',
      );
    }
    const hits = watch.scan().map((h) => h.file);
    expect(hits.some((f) => f.startsWith(m.sessionDir("pr-4242")))).toBe(true);
    expect(hits.some((f) => f.startsWith(m.sessionDir("overseer")))).toBe(true);
  });
});

describe("daemon start", () => {
  it("adopts no tmux session: a live pr-* is neither listed, killed nor restarted at boot", async () => {
    liveSessions = new Set(["pr-7", "pr-42", "overseer", "some-other-session"]);
    const m = manager();
    expect("adopt" in m).toBe(false);
    await m.preflight([]);
    expect(tmuxArgs().some((a) => a[0] === "kill-session")).toBe(false);
    expect(tmuxArgs().some((a) => a[0] === "new-session")).toBe(false);
    expect(tmuxArgs().some((a) => a[0] === "list-sessions")).toBe(false);
  });

  it("preflight sweeps only the worktrees of PRs it was not told to keep", async () => {
    liveSessions = new Set(["pr-9"]); // a tmux pr-* is not a reason to keep a tree
    const m = manager();
    for (const pr of [7, 8, 9]) mkdirSync(m.worktrees.worktreePath(pr), { recursive: true });

    // 7 has a worker, 8 is active, 9 is stale.
    const { sweptWorktrees } = await m.preflight([8, 7]);

    expect(sweptWorktrees).toEqual([9]);
    expect(existsSync(m.worktrees.worktreePath(9))).toBe(false);
    expect(existsSync(m.worktrees.worktreePath(7))).toBe(true);
  });
});

it("refuses an overseer birth without its matching bridge-ready receipt", async () => {
  autoBridgeReady = false;
  const config = cfg();
  config.daemon.session_bridge_ready_timeout_s = 0.005;
  const m = manager(undefined, undefined, config);
  await expect(m.ensureOverseerSession()).rejects.toThrow(/timed out/);
  expect(liveSessions.has("overseer")).toBe(false);
});

it("replaces a live overseer whose bridge failed before accepting another wake", async () => {
  const m = manager();
  await m.ensureOverseerSession();
  const birth = JSON.parse(
    readFileSync(join(root, "state", "sessions", "overseer.json"), "utf8"),
  ) as { bridge_generation: string };
  writeSessionBridgeState(m.bridgeStatePath("overseer", birth.bridge_generation), {
    version: 1,
    session: "overseer",
    generation: birth.bridge_generation,
    stage: "failed",
    updated_at: "2026-08-13T10:00:00Z",
    detail: "watcher failed",
  });
  await m.ensureOverseerSession();
  expect(tmuxArgs().filter((a) => a[0] === "kill-session")).toHaveLength(1);
  expect(tmuxArgs().filter((a) => a[0] === "new-session")).toHaveLength(2);
});

it("defers automatic overseer rotation while an accepted wake remains unfinished", async () => {
  let now = new Date("2026-08-13T10:00:00Z");
  const m = manager(() => now);
  await m.ensureOverseerSession();
  m.injectFile("overseer", "accepted but still running");
  now = new Date("2026-08-21T10:00:00Z");
  expect(await m.rotateOverseerIfDue()).toBe(false);
  expect(tmuxArgs().filter((a) => a[0] === "kill-session")).toHaveLength(0);
});

it("holds automatic rotation for an accepted run even with an empty mailbox", async () => {
  let now = new Date("2026-08-13T10:00:00Z");
  const m = manager(() => now);
  await m.ensureOverseerSession();
  const birth = JSON.parse(
    readFileSync(join(root, "state", "sessions", "overseer.json"), "utf8"),
  ) as { bridge_generation: string };
  const state = {
    version: 1 as const,
    session: "overseer",
    generation: birth.bridge_generation,
    stage: "ready" as const,
    updated_at: now.toISOString(),
    compaction: { state: "idle" as const, seq: 0 },
  };
  writeSessionBridgeState(m.bridgeStatePath("overseer", birth.bridge_generation), {
    ...state,
    run_status: "active",
  });
  now = new Date("2026-08-21T10:00:00Z");
  expect(readdirSync(m.injectDir("overseer")).filter((file) => file.endsWith(".md"))).toEqual([]);
  expect(await m.rotateOverseerIfDue()).toBe(false);
  expect(tmuxArgs().filter((a) => a[0] === "kill-session")).toEqual([]);
  writeSessionBridgeState(m.bridgeStatePath("overseer", birth.bridge_generation), {
    ...state,
    run_status: "idle",
  });
  onListSessions = () => {
    if (existsSync(join(m.injectDir(OVERSEER_SESSION), ".overseer-retire-request.json")))
      liveSessions.delete(OVERSEER_SESSION);
  };
  expect(await m.rotateOverseerIfDue()).toBe(true);
});

it("accepts a legacy bridge receipt while holding automatic rotation as unknown", async () => {
  let now = new Date("2026-08-13T10:00:00Z");
  const m = manager(() => now);
  await m.ensureOverseerSession();
  const birth = JSON.parse(
    readFileSync(join(root, "state", "sessions", "overseer.json"), "utf8"),
  ) as { bridge_generation: string };
  writeSessionBridgeState(m.bridgeStatePath("overseer", birth.bridge_generation), {
    version: 1,
    session: "overseer",
    generation: birth.bridge_generation,
    stage: "ready",
    updated_at: now.toISOString(),
    compaction: { state: "idle", seq: 0 },
  });
  expect(await m.ensureOverseerSession()).toBe("overseer");
  now = new Date("2026-08-21T10:00:00Z");
  expect(await m.rotateOverseerIfDue()).toBe(false);
  expect(tmuxArgs().filter((a) => a[0] === "kill-session")).toEqual([]);
});

it.each(["alive", "unknown"] as const)(
  "never rotates stale idle telemetry when self-retirement is %s",
  async (probe) => {
    let now = new Date("2026-08-13T10:00:00Z");
    const config = cfg();
    config.daemon.session_bridge_ready_timeout_s = 0.005;
    const m = manager(() => now, undefined, config);
    await m.ensureOverseerSession();
    now = new Date("2026-08-21T10:00:00Z");
    if (probe === "unknown") vi.spyOn(m.tmux, "listSessionsKnown").mockResolvedValue(null);
    expect(await m.rotateOverseerIfDue()).toBe(false);
    expect(tmuxArgs().filter((args) => args[0] === "kill-session")).toEqual([]);
    expect(tmuxArgs().filter((args) => args[0] === "new-session")).toHaveLength(1);
    expect(existsSync(m.archiveDir("overseer"))).toBe(false);
  },
);

describe("overseer rotation", () => {
  it("is not due before the configured age", async () => {
    let now = new Date("2026-08-13T10:00:00Z");
    const m = manager(() => now);
    await m.ensureOverseerSession();
    now = new Date("2026-08-19T10:00:00Z"); // 6 days
    expect(m.overseerRotationDue()).toBe(false);
    expect(await m.rotateOverseerIfDue()).toBe(false);
  });

  it("records the run and respawns once the rotation interval elapses — ledger and meta, never the JSONL", async () => {
    let now = new Date("2026-08-13T10:00:00Z");
    const m = manager(() => now);
    await m.ensureOverseerSession();
    const sdir = join(m.sessionDir(OVERSEER_SESSION), "s");
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "run.jsonl"), '{"type":"session"}\n');
    mkdirSync(join(root, "state", "ledgers"), { recursive: true });
    writeFileSync(m.ledgerPath(OVERSEER_SESSION), "overseer ledger\n");

    now = new Date("2026-08-20T10:00:00Z"); // 7 days
    expect(m.overseerRotationDue()).toBe(true);
    onListSessions = () => {
      if (existsSync(join(m.injectDir(OVERSEER_SESSION), ".overseer-retire-request.json")))
        liveSessions.delete(OVERSEER_SESSION);
    };
    expect(await m.rotateOverseerIfDue()).toBe(true);

    const rec = join(m.archiveDir(OVERSEER_SESSION), "2026-08-20");
    expect(existsSync(join(rec, "session.jsonl"))).toBe(false);
    expect(readFileSync(join(rec, "ledger.md"), "utf8")).toBe("overseer ledger\n");
    expect(JSON.parse(readFileSync(join(rec, "meta.json"), "utf8")).session_file).toBe(
      join(sdir, "run.jsonl"),
    );
    // The transcript stays live until the archiver moves it.
    expect(existsSync(join(sdir, "run.jsonl"))).toBe(true);
    expect(tmuxArgs().filter((args) => args[0] === "kill-session")).toEqual([]);
    expect(tmuxArgs().filter((a) => a[0] === "new-session" && a[3] === "overseer")).toHaveLength(2);
    expect(liveSessions.has(OVERSEER_SESSION)).toBe(true);
  });

  it("rotation does not join a birth flight whose probe still describes the killed overseer", async () => {
    const m = manager();
    await m.ensureOverseerSession();
    let entered!: () => void;
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const finishProbe = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(m.tmux, "hasSession").mockImplementationOnce(async () => {
      entered();
      await finishProbe;
      return true;
    });
    const olderBirth = m.ensureOverseerSession();
    await probing;
    // Let the rotation run every continuation after its kill before the old
    // probe finishes. It must spawn without borrowing that stale flight.
    onKillSession = () => {
      setImmediate(release);
    };
    try {
      await Promise.all([olderBirth, m.rotateOverseer()]);
      expect(liveSessions.has(OVERSEER_SESSION)).toBe(true);
      expect(tmuxArgs().filter((a) => a[0] === "new-session" && a[3] === "overseer")).toHaveLength(
        2,
      );
    } finally {
      release();
    }
  });

  it("an overseer that survives the rotation kill is not reported rotated", async () => {
    const m = manager();
    await m.ensureOverseerSession();
    keepKilledSession = true;
    await expect(m.rotateOverseer()).rejects.toThrow(/survived the rotation kill/);
    expect(tmuxArgs().filter((a) => a[0] === "new-session" && a[3] === "overseer")).toHaveLength(1);
  });

  it("two rotations on the same date no longer overwrite each other", async () => {
    let now = new Date("2026-08-20T09:00:00Z");
    const m = manager(() => now);
    await m.ensureOverseerSession();
    const sdir = m.sessionDir(OVERSEER_SESSION);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "a.jsonl"), '{"n":1}\n');
    utimesSync(
      join(sdir, "a.jsonl"),
      new Date("2026-08-20T08:00:00Z"),
      new Date("2026-08-20T08:00:00Z"),
    );
    expect(await m.rotateOverseer()).toBe("2026-08-20");
    // The weekly rotation, then an operator restart-session the same day.
    now = new Date("2026-08-20T15:00:00Z");
    writeFileSync(join(sdir, "b.jsonl"), '{"n":2}\n');
    expect(await m.rotateOverseer()).toBe("2026-08-20-2");
    now = new Date("2026-08-20T16:00:00Z");
    expect(await m.rotateOverseer()).toBe("2026-08-20-3");
    const meta = (d: string) =>
      JSON.parse(readFileSync(join(m.archiveDir(OVERSEER_SESSION), d, "meta.json"), "utf8"));
    expect(meta("2026-08-20").archived_at).toBe("2026-08-20T09:00:00.000Z");
    expect(meta("2026-08-20").session_file).toBe(join(sdir, "a.jsonl"));
    expect(meta("2026-08-20-2").archived_at).toBe("2026-08-20T15:00:00.000Z");
    expect(meta("2026-08-20-2").session_file).toBe(join(sdir, "b.jsonl"));
    expect(meta("2026-08-20-3").archived_at).toBe("2026-08-20T16:00:00.000Z");
    // Both transcripts are still live — nothing was copied, nothing lost.
    expect(readFileSync(join(sdir, "a.jsonl"), "utf8")).toBe('{"n":1}\n');
    expect(readFileSync(join(sdir, "b.jsonl"), "utf8")).toBe('{"n":2}\n');
  });

  it("reports not-due when no birth record exists (adopted session)", () => {
    expect(manager().overseerRotationDue()).toBe(false);
  });
});
