// Session manager tests. Every process invocation goes through a fake exec
// that records commands — no tmux, no pi, no git is ever spawned. Filesystem
// work happens inside a temp sandbox root.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pi } from "@earendil-works/pi-coding-agent";
import activateInjectBridge from "../extensions/inject-bridge.js";
import type { Config } from "../src/config.js";
import { dispatchOnce } from "../src/dispatch.js";
import { PiSessionManager, OVERSEER_SESSION, buildPiCommand, isSandboxSession, prOfSession, prSessionName } from "../src/sessions.js";
import { Tmux } from "../src/tmux.js";
import type { ExecFn } from "../src/tmux.js";
import { writeSessionBridgeState } from "../src/session-bridge.js";
import { SessionCommandSupervisor } from "../src/session-command-supervisor.js";
import { OriginStore } from "../src/slack/origin.js";
import { StateStore } from "../src/state.js";
import { roundPromptMarker } from "../src/types.js";
import type { RoundOrder } from "../src/types.js";
import { WorktreeManager } from "../src/worktrees.js";
import { daemonOriginWakes } from "../src/wire.js";

let root: string;
let secrets: string;
let calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
let liveSessions: Set<string>;
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
      escalation_reviewer: "mhale",
      trigger_label: "AI review requested",
      in_progress_label: "AI review in progress",
      reviewed_label: "Automatic Review",
      improvement_label: "Bot improvement",
      issue_label: "bot-filed",
      secrets_dir: secrets,
    },
    server: { hostname: "h", port: 8787 },
    daemon: { poll_interval_s: 300, max_concurrent_rounds: 6, round_deadline_min: 45, overseer_rotation_days: 7 },
    eod: { time: "18:00", timezone: "Europe/Warsaw" },
    caps: {
      improvement_pr_max_lines: 50,
      improvement_pr_max_files: 3,
      improvement_pr_per_day: 1,
      improvement_pr_per_week: 3,
      issues_per_day: 3,
    },
    models: { default: "openai/gpt-5.6-sol", conversation: "openai/conv", overseer: "openai/over", passes: {} },
    pi: { package: "@earendil-works/pi-coding-agent", version: "0.84.4", session_dir: "state/pi-sessions", subagent_max_concurrency: 6 },
    // Only the fields sessions.ts reads: the loopback endpoint the
    // sessions authenticate against, and the SERVER's ov.conf — passed so the
    // fork's root-key guard reads the real file instead of guessing from HOME.
    openviking: { host: "127.0.0.1", port: 1933, config_file: join(root, "ovhome", "ov.conf") },
  }) as unknown as Config;

/** Fake exec: records everything, fakes tmux list/has from `liveSessions`. */
const fakeExec: ExecFn = async (cmd, args, opts) => {
  calls.push({ cmd, args, env: opts?.env });
  if (cmd === "tmux") {
    if (args[0] === "list-sessions") return { code: 0, stdout: [...liveSessions].join("\n"), stderr: "" };
    if (args[0] === "has-session") {
      const name = String(args[2]).replace(/^=/, "");
      return { code: liveSessions.has(name) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "new-session") {
      const session = String(args[3]);
      liveSessions.add(session);
      onNewSession?.(session, args);
      if (autoBridgeReady && session.startsWith("pr-")) {
        const generation = args.find((value) => value.startsWith("QCR_SESSION_BRIDGE_GENERATION="))?.split("=", 2)[1];
        const stateFile = args.find((value) => value.startsWith("QCR_SESSION_BRIDGE_STATE_FILE="))?.slice("QCR_SESSION_BRIDGE_STATE_FILE=".length);
        if (generation && stateFile) {
          writeSessionBridgeState(stateFile, {
            version: 1,
            session,
            generation,
            stage: "ready",
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
    worktrees: new WorktreeManager({ root, repo: "o/n", cloneDir: "example-app", cloneUrl: "/dev/null", run: fakeExec }),
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

const order: RoundOrder = {
  pr: 42,
  title: "Add rate limiting",
  round_id: 1,
  round_no: 1,
  round_type: "first",
  lenses: ["pass-baseline"],
  escalation_reasons: [],
  migration_gate: false,
  head_sha: "abc123",
  worktree: "wt/pr-42",
  settled_digest: "",
  issued_at: "2026-08-13T10:00:00Z",
};

function tmuxArgs(): string[][] {
  return calls.filter((c) => c.cmd === "tmux").map((c) => c.args);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-sess-"));
  secrets = join(root, "secrets");
  calls = [];
  ovCalls = [];
  liveSessions = new Set();
  onKillSession = undefined;
  onNewSession = undefined;
  autoBridgeReady = true;
  keepKilledSession = false;
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(root, "prompts", "conversation-system.md"), "Shepherd of PR #{{n}} ({{title}}) at {{worktree}}.\n");
  writeFileSync(join(root, "prompts", "overseer-system.md"), "You are the overseer.\n");
  writeFileSync(join(secrets, "openai_api_key"), "sk-app-key\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
      "--model", "openai/conv",
      "--session-dir", "/s/state/pi-sessions/pr-1",
      "--system-prompt", "/s/state/session-prompts/pr-1.md",
      "--extension", "/s/extensions/inject-bridge.ts",
      "--extension", "/s/extensions/ledger-pin.ts",
      "--name", "pr-1",
    ]);
  });

  it("carries no update/auto-update flag (version is pinned by config)", () => {
    const argv = buildPiCommand({
      piBin: "pi", model: "m", sessionDir: "d", systemPromptPath: "p", extensionPaths: [], sessionName: "s",
    });
    expect(argv.join(" ")).not.toMatch(/update/i);
  });

  it("loads the live round-progress reporter in every parent session", () => {
    const paths = manager().extensionPaths();
    expect(paths).toContain(join(root, "extensions", "round-progress.ts"));
    expect(paths.indexOf(join(root, "extensions", "round-progress.ts"))).toBeLessThan(
      paths.indexOf(join(root, "extensions", "subagents.ts")),
    );
  });

  // the subagents glue (pi's native subagent extension loaded from
  // the installed package) rides per-spawn argv, NEVER a settings.json entry —
  // children load only the global settings extensions, so a leaf never gets
  // the subagent tool and a pass cannot fan out (rule 9, structurally).
  it("loads the first-party subagents glue on argv in every parent session", () => {
    const paths = manager().extensionPaths();
    expect(paths).toContain(join(root, "extensions", "subagents.ts"));
    // The retired register-lens-agents hook must not come back.
    expect(paths.join("\n")).not.toContain("register-lens-agents");
    expect(paths.join("\n")).not.toContain("pi-subagents");
  });

  it("loads the vendored OpenViking fork, after ledger-pin", () => {
    const paths = manager().extensionPaths();
    const ov = join(root, "extensions", "vendor", "openviking-pi", "index.ts");
    expect(paths).toContain(ov);
    // Load order is handler-registration order in pi. ledger-pin owns
    // session_before_compact and must be registered first; the fork's own
    // compaction handler is deleted (PATCH 1), but the ordering is the
    // belt-and-braces half of that invariant.
    expect(paths.indexOf(join(root, "extensions", "ledger-pin.ts"))).toBeLessThan(paths.indexOf(ov));
    // It rides argv, not a settings.json discovery dir: subagent children
    // load only the global settings extensions, so leaves get no memory
    // surface (the native children spawn without argv extensions).
    const argv = buildPiCommand({
      piBin: "pi", model: "m", sessionDir: "d", systemPromptPath: "p",
      extensionPaths: paths, sessionName: "pr-1",
    });
    expect(argv).toContain(ov);
  });

  it("always pre-trusts the project (--approve) — the reviewer never blocks on pi's trust modal", () => {
    const argv = buildPiCommand({
      piBin: "pi", model: "m", sessionDir: "d", systemPromptPath: "p", extensionPaths: [], sessionName: "s",
    });
    expect(argv).toContain("--approve");
  });
});

describe("birth", () => {
  it("spawns a detached tmux session running pi with the substituted prompt", async () => {
    const m = manager();
    await m.ensurePrSession(42, "Add rate limiting", "wt/pr-42");

    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;
    expect(newSession.slice(0, 6)).toEqual(["new-session", "-d", "-s", "pr-42", "-c", root]);
    expect(newSession).toContain("pi");
    expect(newSession).toContain("openai/conv");
    expect(newSession).toContain(join(root, "extensions", "inject-bridge.ts"));
    expect(newSession).toContain(join(root, "extensions", "ledger-pin.ts"));
    expect(newSession).toContain(join(root, "state", "pi-sessions", "pr-42"));
    expect(newSession.some((value) => value.startsWith("QCR_SESSION_BRIDGE_GENERATION="))).toBe(true);
    expect(newSession.some((value) => value.startsWith(
      `QCR_SESSION_BRIDGE_STATE_FILE=${join(root, "state", "sessions", "pr-42.bridge-")}`,
    ))).toBe(true);
    expect(newSession).toContain("QCR_SESSION_BRIDGE_LEDGER_REQUIRED=0");

    const promptPath = m.promptPath("pr-42");
    expect(newSession).toContain(promptPath);
    expect(readFileSync(promptPath, "utf8")).toBe("Shepherd of PR #42 (Add rate limiting) at wt/pr-42.\n");
    expect(existsSync(join(m.injectDir("pr-42"), ".done"))).toBe(true);
  });

  /**
   * the config-scope pin has to be ON THE ARGV, and this test is the
   * whole reason the ticket said "this is NOT a one-line change".
   *
   * tmux panes inherit the tmux SERVER's environment, not the client's
   * (CLAUDE.md's recorded gotcha, and why `ARGV_ENV_PREFIXES` exists at all).
   * A pin that rode only `buildEnv` would be present in every unit assertion
   * and absent from every real pane — silently doing nothing, which is exactly
   * the failure mode this defence exists to prevent. Proven end-to-end against
   * a real tmux server as well: `tmux new-session -d -s <n> -c <cwd> env
   * GIT_CONFIG_GLOBAL=… <cmd>` puts the value in a GRANDCHILD's environment and
   * `HOME=<evil> git diff --no-index` does not execute there.
   */
  it("pins git's config scopes on the argv, where the pane can actually see them", async () => {
    const m = manager();
    await m.ensurePrSession(42, "Add rate limiting", "wt/pr-42");
    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;

    // On the argv, and BEFORE the program token — this is an `env K=V … pi …`
    // prefix, not a flag pi would have to understand.
    const envIdx = newSession.indexOf("env");
    const piIdx = newSession.indexOf("pi");
    expect(envIdx).toBeGreaterThan(-1);
    for (const pin of [`GIT_CONFIG_GLOBAL=${join(root, "pihome", ".gitconfig")}`, "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_NOSYSTEM=1"]) {
      const at = newSession.indexOf(pin);
      expect(at, `${pin} must ride the argv`).toBeGreaterThan(envIdx);
      expect(at, `${pin} must precede the pi binary`).toBeLessThan(piIdx);
    }
    // NOT /dev/null for the global scope: the container's entrypoint writes a
    // `credential.helper` there and `fetch` is an allowed read verb, so
    // /dev/null would have broken every session-side fetch on a private repo.
    expect(newSession.join(" ")).not.toContain("GIT_CONFIG_GLOBAL=/dev/null");
  });

  it("single-flights concurrent births for the same PR", async () => {
    const m = manager();
    const [a, b] = await Promise.all([
      m.ensurePrSession(42, "T", "wt/pr-42"),
      m.ensurePrSession(42, "T", "wt/pr-42"),
    ]);
    expect([a, b]).toEqual(["pr-42", "pr-42"]);
    expect(tmuxArgs().filter((args) => args[0] === "new-session")).toHaveLength(1);
    expect(ovCalls.filter((call) => call === "create pr-42")).toHaveLength(1);
  });

  it("does not respawn a session that is already live", async () => {
    const m = manager();
    markExistingSessionReady(m, "pr-42");
    await m.ensurePrSession(42, "T", "wt/pr-42");
    expect(tmuxArgs().some((a) => a[0] === "new-session")).toBe(false);
  });

  it("fences a live tmux whose ready receipt belongs to a stale generation", async () => {
    const m = manager();
    markExistingSessionReady(m, "pr-42");
    writeSessionBridgeState(m.bridgeStatePath("pr-42", "existing-pr-42"), {
      version: 1,
      session: "pr-42",
      generation: "stale-generation",
      stage: "ready",
      updated_at: "2026-08-13T09:59:00.000Z",
    });

    await m.ensurePrSession(42, "T", "wt/pr-42");

    const kill = tmuxArgs().findIndex((a) => a[0] === "kill-session" && a.includes("=pr-42"));
    const birth = tmuxArgs().findIndex((a, index) => index > kill && a[0] === "new-session" && a.includes("pr-42"));
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(birth).toBeGreaterThan(kill);
  });

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
        // config-scope pin — paths and a flag, no credential.
        "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM",
        "HOME", "LANG", "OPENAI_API_KEY",
        // identity — non-secret every one of them (the reviewer key
        // rides ovcli.conf at 0600, never argv and never the environment).
        "OPENVIKING_BASE_URL", "OPENVIKING_CLI_CONFIG_FILE", "OPENVIKING_CONFIG_FILE",
        "OPENVIKING_PEER_ID", "OPENVIKING_URL", "OPENVIKING_USER",
        "PATH", "QCR_INJECT_DIR", "QCR_LEDGER_FILE", "QCR_OV_SESSION_ID",
        "QCR_PI_VERSION", "QCR_PR", "QCR_SANDBOX_ROOT", "QCR_SECRETS_DIR", "QCR_SESSION_NAME",
        // the process-wide subagent fan-out cap for the glue.
        "QCR_SUBAGENT_MAX_CONCURRENCY", "TERM",
      ]);
      expect(env.QCR_SUBAGENT_MAX_CONCURRENCY).toBe("6");
      // No credential of any kind reached the environment.
      for (const [k, v] of Object.entries(env)) {
        expect(k, `${k} must not look like an OpenViking key`).not.toMatch(/OPENVIKING.*KEY/);
        expect(String(v)).not.toContain("ov-reviewer-key");
      }
    } finally {
      delete process.env.QCR_TEST_PERSONAL_TOKEN;
    }
  });

  it("omits the OpenAI key when the secrets dir has none", async () => {
    rmSync(join(secrets, "openai_api_key"));
    expect(manager().buildEnv("pr-1").OPENAI_API_KEY).toBeUndefined();
  });
});

describe("OpenViking identity and the PR's raw-notes session", () => {
  it("puts the whole identity on the pi command line — and no key anywhere", async () => {
    const m = manager();
    writeFileSync(join(secrets, "openviking_reviewer_key"), "ov-reviewer-key\n");
    await m.ensurePrSession(42, "T", "wt/pr-42");

    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;
    const prefix = newSession.filter((a) => a.startsWith("OPENVIKING_") || a.startsWith("QCR_OV_"));
    expect(prefix).toContain("OPENVIKING_URL=http://127.0.0.1:1933");
    expect(prefix).toContain("OPENVIKING_USER=reviewer");
    // The peer id is per-session: all sessions share one cwd, so the
    // extension's path-derived peer cannot separate two PRs.
    expect(prefix).toContain("OPENVIKING_PEER_ID=pr-42");
    // QCR_-prefixed spelling: only prefixed vars survive onto the argv, and
    // the tmux SERVER env would be shared by every session.
    expect(prefix).toContain("QCR_OV_SESSION_ID=pr-42");
    expect(prefix).toContain(`OPENVIKING_CLI_CONFIG_FILE=${m.ovcliConfPath()}`);
    // argv is world-readable (`ps`): the key must never appear on it.
    expect(newSession.join(" ")).not.toContain("ov-reviewer-key");
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
    await m.ensurePrSession(42, "T", "wt/pr-42");

    const path = m.ovcliConfPath();
    expect(path).toBe(join(root, "pihome", ".openviking", "ovcli.conf"));
    const conf = JSON.parse(readFileSync(path, "utf8"));
    expect(conf).toEqual({ url: "http://127.0.0.1:1933", user: "reviewer", api_key: "ov-reviewer-key" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("REFUSES to hand a session the server's root key — 401 beats omnipotent", async () => {
    mkdirSync(join(root, "ovhome"), { recursive: true });
    writeFileSync(join(root, "ovhome", "ov.conf"), JSON.stringify({ server: { root_api_key: "ROOT-KEY" } }));
    writeFileSync(join(secrets, "openviking_reviewer_key"), "ROOT-KEY\n");

    const m = manager();
    const result = m.provisionOvCredentials();

    expect(result.keyed).toBe(false);
    expect(result.reason).toBe("root-key-refused");
    const conf = JSON.parse(readFileSync(m.ovcliConfPath(), "utf8"));
    expect(conf.api_key).toBeUndefined();
    expect(JSON.stringify(conf)).not.toContain("ROOT-KEY");
  });

  it("creates the PR's OpenViking session at birth and deletes it at close", async () => {
    const m = manager();
    await m.ensurePrSession(42, "T", "wt/pr-42");
    expect(ovCalls).toEqual(["create pr-42"]);

    // A wedged session is killed and reborn — the notes must SURVIVE that.
    await m.killSession(42);
    expect(ovCalls).toEqual(["create pr-42"]);

    mkdirSync(join(root, "example-app", ".git"), { recursive: true });
    await m.archiveAndClose(42);
    expect(ovCalls).toEqual(["create pr-42", "delete pr-42"]);
  });

  it("a memory engine that is down costs the PR its raw tier and nothing else", async () => {
    const m = new PiSessionManager({
      cfg: cfg(),
      root,
      tmux: new Tmux({ exec: fakeExec }),
      worktrees: new WorktreeManager({ root, repo: "o/n", cloneDir: "example-app", cloneUrl: "/dev/null", run: fakeExec }),
      piHome: join(root, "pihome"),
      ovSessions: {
        create: async () => {
          throw new Error("connection refused");
        },
        remove: async () => {
          throw new Error("connection refused");
        },
      },
    });
    await expect(m.ensurePrSession(42, "T", "wt/pr-42")).resolves.toBe("pr-42");
    expect(liveSessions.has("pr-42")).toBe(true);
    mkdirSync(join(root, "example-app", ".git"), { recursive: true });
    await expect(m.archiveAndClose(42)).resolves.toBeUndefined();
  });

  it("runs memory-less when the secrets mount carries no reviewer key", async () => {
    const m = manager();
    const result = m.provisionOvCredentials();
    expect(result.keyed).toBe(false);
    expect(result.reason).toBe("no-key");
    expect(JSON.parse(readFileSync(m.ovcliConfPath(), "utf8")).api_key).toBeUndefined();
  });
});

describe("injection", () => {
  it("dispatchRound refreshes the worktree, ensures the session and drops the prompt file", async () => {
    const m = manager();
    await m.dispatchRound(order, "ROUND PROMPT BODY");

    const gitCalls = calls.filter((c) => c.cmd === "git").map((c) => c.args[0]);
    expect(gitCalls).toContain("clone");
    expect(gitCalls).toContain("fetch");
    expect(tmuxArgs().some((a) => a[0] === "new-session" && a[3] === "pr-42")).toBe(true);

    const dir = m.injectDir("pr-42");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    // The body, plus the receipt token the recovery paths look for (#5362).
    expect(readFileSync(join(dir, files[0]!), "utf8")).toBe(
      `ROUND PROMPT BODY\n\n${roundPromptMarker(42, order.round_no)}\n`,
    );
  });

  it("reads the receipt out of the session JSONL — present, absent, unknowable (#5362)", async () => {
    const m = manager();
    await m.dispatchRound(order, "ROUND PROMPT BODY");
    const started = Date.parse("2026-08-13T10:00:00Z");
    const jsonlDir = m.sessionDir("pr-42");
    mkdirSync(jsonlDir, { recursive: true });
    const jsonl = join(jsonlDir, "2026-08-13T10-00-00-000Z_abc.jsonl");

    // Nothing written since the round started: no evidence either way.
    expect(await m.roundPromptAccepted(42, 1, started)).toBeNull();

    // The session wrote, but the prompt is not among what it accepted. This is
    // #5362 exactly: round 1's prompt and two hand-typed messages were in the
    // JSONL, round 2's order was simply not there.
    writeFileSync(
      jsonl,
      `${JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "wake up finish the review" }] } })}\n`,
    );
    expect(await m.roundPromptAccepted(42, 1, started)).toBe(false);

    // pi accepted it: the token comes back verbatim through JSON encoding.
    writeFileSync(
      jsonl,
      `${JSON.stringify({
        message: { role: "user", content: [{ type: "text", text: `ROUND PROMPT BODY\n\n${roundPromptMarker(42, 1)}\n` }] },
      })}\n`,
    );
    expect(await m.roundPromptAccepted(42, 1, started)).toBe(true);
    // A different round's token is not this round's receipt.
    expect(await m.roundPromptAccepted(42, 2, started)).toBe(false);
  });

  // / MC-01. The ratified receipt rule (#5362 ①) is: present =
  // delivered, absent = never arrived, **unreadable = unknown, and unknown is
  // NEVER read as loss**. The catch inside the scan returned `false`, which is
  // the "provably never arrived" answer — the exact reading the rule forbids,
  // and the one that (once redelivery is spent) kills a live conversation.
  // The comment on the line above the catch already said so.
  describe("an unreadable session JSONL is UNKNOWN, never loss", () => {
    // The fault is injected with a SYMLINK TO A DIRECTORY, not `chmod 0o000`.
    // `readdirSync(withFileTypes)` does not follow symlinks, so the entry is
    // not reported as a directory and falls through to the `.jsonl` branch;
    // `statSync` then follows it and succeeds (in scope, mtime now), and
    // `readFileSync` fails with EISDIR. That is exactly the shape the rule is
    // about — stats fine, cannot be read — and unlike a permission bit it
    // behaves identically for every uid. The first version of these tests used
    // `chmod` behind `it.skipIf(root)`, which meant the fix lost all cover in
    // any root context while the suite still reported green: the "green suites
    // lie" mode this whole ticket exists to close.
    const unreadableJsonl = (dir: string, name: string): void => {
      const target = join(dir, `${name}.d`);
      mkdirSync(target, { recursive: true });
      symlinkSync(target, join(dir, name));
    };

    it("returns null, not false, when an in-scope file cannot be read", async () => {
      const store = new StateStore(":memory:");
      const m = manager(() => new Date("2026-08-13T10:00:00Z"), store);
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const started = Date.parse("2026-08-13T10:00:00Z");
      const jsonlDir = m.sessionDir("pr-42");
      mkdirSync(jsonlDir, { recursive: true });
      // The entry stats in scope — the session demonstrably wrote — but its
      // bytes are not readable, so nothing can be concluded about the marker.
      unreadableJsonl(jsonlDir, "2026-08-13T10-00-00-000Z_abc.jsonl");

      expect(await m.roundPromptAccepted(42, 1, started)).toBeNull();

      // F4: and it says so. The flag is scan-global, so one permanently
      // unreadable stale file would otherwise answer `null` for this PR
      // forever, silently disabling the redelivery-vs-loss decision and
      // reconcile's claim-release sweep.
      const kinds = store.eventsOn(new Date().toISOString().slice(0, 10)).map((e) => e.kind);
      expect(kinds).toContain("receipt_scan_unreadable");
      store.close();
    });

    it("keeps scanning past an unreadable file — the marker may be in the next one", async () => {
      const m = manager();
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const started = Date.parse("2026-08-13T10:00:00Z");
      const jsonlDir = m.sessionDir("pr-42");
      mkdirSync(jsonlDir, { recursive: true });
      // Named so the unreadable one is walked first: the old code returned out
      // of `walk` entirely on a failed read, so `b.jsonl` was never opened.
      unreadableJsonl(jsonlDir, "a-blocked.jsonl");
      writeFileSync(
        join(jsonlDir, "b-delivered.jsonl"),
        `${JSON.stringify({ text: `BODY\n\n${roundPromptMarker(42, 1)}\n` })}\n`,
      );

      expect(await m.roundPromptAccepted(42, 1, started)).toBe(true);
    });

    it("still reports a genuine absence as false — the fix does not blunt the receipt", async () => {
      const m = manager();
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const started = Date.parse("2026-08-13T10:00:00Z");
      const jsonlDir = m.sessionDir("pr-42");
      mkdirSync(jsonlDir, { recursive: true });
      writeFileSync(join(jsonlDir, "readable.jsonl"), `${JSON.stringify({ text: "no marker here" })}\n`);
      expect(await m.roundPromptAccepted(42, 1, started)).toBe(false);
    });
  });

  it("ignores JSONL files that predate the round — the prompt cannot be in one", async () => {
    const m = manager();
    await m.dispatchRound(order, "BODY");
    const jsonlDir = m.sessionDir("pr-42");
    mkdirSync(jsonlDir, { recursive: true });
    const stale = join(jsonlDir, "old.jsonl");
    writeFileSync(stale, `${JSON.stringify({ text: roundPromptMarker(42, 1) })}\n`);
    const old = new Date("2026-08-13T08:00:00Z");
    utimesSync(stale, old, old);

    // Two hours after that file was last touched: it is out of scope, and it
    // is the only file — so the answer is "cannot tell", never "delivered".
    expect(await m.roundPromptAccepted(42, 1, Date.parse("2026-08-13T10:00:00Z"))).toBeNull();
  });

  it("redelivers the EXACT dispatched bytes, and reports false when there is nothing saved", async () => {
    const m = manager();
    await m.dispatchRound(order, "ROUND PROMPT BODY");
    const dir = m.injectDir("pr-42");
    const first = readdirSync(dir).filter((f) => f.endsWith(".md"));
    const original = readFileSync(join(dir, first[0]!), "utf8");

    expect(await m.redeliverRound(42, 1)).toBe(true);
    const after = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(after).toHaveLength(2);
    // Byte-identical: re-rendering later would quietly change the order (a
    // different head, a different memory block), so the session would read a
    // round the daemon never recorded.
    const fresh = after.find((f) => f !== first[0]!)!;
    expect(readFileSync(join(dir, fresh), "utf8")).toBe(original);

    // A round whose saved prompt is gone cannot be redelivered — the caller
    // must escalate rather than invent an order.
    expect(await m.redeliverRound(42, 99)).toBe(false);
  });

  it("never uses tmux send-keys to wake a session", async () => {
    const m = manager();
    await m.dispatchRound(order, "body");
    await m.injectOverseer("anomaly");
    expect(tmuxArgs().some((a) => a[0] === "send-keys")).toBe(false);
  });

  it("inject() requires a live session", async () => {
    const m = manager();
    await expect(m.inject(42, "reply to author")).rejects.toThrow(/no live session pr-42/);
    markExistingSessionReady(m, "pr-42");
    await m.inject(42, "reply to author");
    expect(readdirSync(m.injectDir("pr-42")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });

  // Live gap 2026-08-19: sticky sessions die with the container and are only
  // reborn on round dispatch, but rechecks/ping-pong wake WITHOUT a round —
  // every post-restart push recheck threw. With a title resolver set, inject
  // respawns the session instead.
  it("inject() respawns a dead session when the title resolver knows the PR", async () => {
    const m = manager();
    m.setTitleResolver((pr) => (pr === 42 ? "Add rate limiting" : undefined));
    expect(liveSessions.has("pr-42")).toBe(false);
    await m.inject(42, "recheck: head moved");
    expect(liveSessions.has("pr-42")).toBe(true);
    expect(readdirSync(m.injectDir("pr-42")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    // An unknown PR still refuses — no registry row means nothing to respawn from.
    await expect(m.inject(77, "wake")).rejects.toThrow(/no live session pr-77/);
  });

  it("inject() fences a live PR tmux whose bridge generation is stale", async () => {
    const m = manager();
    m.setTitleResolver(() => order.title);
    markExistingSessionReady(m, "pr-42");
    writeSessionBridgeState(m.bridgeStatePath("pr-42", "existing-pr-42"), {
      version: 1,
      session: "pr-42",
      generation: "stale-generation",
      stage: "ready",
      updated_at: "2026-08-13T09:59:00.000Z",
    });

    await m.inject(42, "author reply");

    const kill = tmuxArgs().findIndex((args) => args[0] === "kill-session" && args.includes("=pr-42"));
    const birth = tmuxArgs().findIndex((args, index) => index > kill && args[0] === "new-session" && args.includes("pr-42"));
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(birth).toBeGreaterThan(kill);
  });

  it("injectOverseer births the overseer session on demand", async () => {
    const m = manager();
    await m.injectOverseer("EOD sweep");
    const newSession = tmuxArgs().find((a) => a[0] === "new-session")!;
    expect(newSession[3]).toBe(OVERSEER_SESSION);
    expect(newSession).toContain("openai/over");
    expect(readdirSync(m.injectDir(OVERSEER_SESSION)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });

  it("gives concurrent injections distinct filenames", async () => {
    const m = manager();
    markExistingSessionReady(m, "pr-42");
    await m.inject(42, "one");
    await m.inject(42, "two");
    const files = readdirSync(m.injectDir("pr-42")).filter((f) => f.endsWith(".md"));
    expect(new Set(files).size).toBe(2);
  });
});

describe("durable command ownership", () => {
  it("records round dispatch and ordinary wakes in the same exact-byte command slot", async () => {
    const dbPath = join(root, "state", "state.db");
    const store = new StateStore(dbPath, () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      await m.dispatchRound(order, "ROUND PROMPT BODY");

      expect(tmuxArgs().find((args) => args[0] === "new-session")).toContain("QCR_SESSION_BRIDGE_LEDGER_REQUIRED=1");
      const row = store.activeSessionCommand("pr-42")!;
      const bytes = readFileSync(row.inject_path);
      expect(row).toMatchObject({ pr: 42, session: "pr-42", kind: "round", round_no: 1, status: "pending", attempt: 0 });
      expect(row.payload_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(readFileSync(row.payload_path)).toEqual(bytes);
      expect(row.inject_path).toContain(`--cmd-${row.id}.md`);
      expect(m.buildEnv("pr-42")).toMatchObject({
        QCR_STATE_DB: dbPath,
        QCR_SESSION_COMMAND_START_LEASE_MS: "120000",
        QCR_SESSION_COMMAND_RUNNING_LEASE_MS: "2700000",
      });

      markExistingSessionReady(m, "pr-42");
      await expect(m.inject(42, "author replied")).rejects.toThrow(/session command .* is pending/);
    } finally {
      store.close();
    }
  });

  it("redelivery reuses the same command id and byte-identical durable payload", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const original = store.activeSessionCommand("pr-42")!;
      const bytes = readFileSync(original.payload_path);
      store.claimSessionCommand(original.id, "bridge", "2026-08-13T10:30:00Z");
      store.finishSessionCommand(original.id, "bridge", "failed", "no start");
      rmSync(original.inject_path);

      expect(await m.redeliverRound(42, 1)).toBe(true);
      const retried = store.activeSessionCommand("pr-42")!;
      expect(retried.id).toBe(original.id);
      expect(retried.attempt).toBe(1);
      expect(readFileSync(retried.inject_path)).toEqual(bytes);
      expect(readFileSync(retried.payload_path)).toEqual(bytes);
    } finally {
      store.close();
    }
  });

  it("kills the old session before retrying the same unstarted command id and bytes", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      m.setTitleResolver((pr) => (pr === 42 ? order.title : undefined));
      store.upsertPr({ number: 42, state: "reviewing", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      store.startRound(42, "first", ["pass-baseline"], 45);
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const original = store.activeSessionCommand("pr-42")!;
      const bytes = readFileSync(original.payload_path);
      store.claimSessionCommand(original.id, "bridge-old", "2026-08-13T10:02:00Z");
      onNewSession = () => {
        store.claimSessionCommand(original.id, "bridge-new", "2026-08-13T10:04:00Z");
      };

      expect(await m.retrySessionCommand(original.id, "start lease expired")).toBe("retried");

      const retried = store.activeSessionCommand("pr-42")!;
      expect(retried).toMatchObject({ id: original.id, status: "running", attempt: 2, owner_token: "bridge-new" });
      expect(readFileSync(retried.inject_path)).toEqual(bytes);
      const kill = tmuxArgs().findIndex((a) => a[0] === "kill-session" && a.includes("=pr-42"));
      const birth = tmuxArgs().findIndex((a, index) => index > kill && a[0] === "new-session" && a.includes("pr-42"));
      expect(kill).toBeGreaterThanOrEqual(0);
      expect(birth).toBeGreaterThan(kill);
    } finally {
      store.close();
    }
  });

  it("does not report replay when the reborn tmux never publishes matching bridge readiness", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const config = cfg();
      config.daemon.session_bridge_ready_timeout_s = 0.005;
      const m = manager(undefined, store, config);
      m.setTitleResolver(() => order.title);
      store.upsertPr({ number: 42, state: "queued", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      markExistingSessionReady(m, "pr-42");
      await m.inject(42, "recovered author reply");
      const command = store.activeSessionCommand("pr-42")!;
      store.claimSessionCommand(command.id, "bridge-old", "2026-08-13T10:02:00Z");
      autoBridgeReady = false;

      expect(await m.retrySessionCommand(command.id, "start evidence unknown")).toBe("retry_failed");

      expect(liveSessions.has("pr-42")).toBe(false);
      expect(store.getSessionCommand(command.id)).toMatchObject({
        status: "pending",
        attempt: 1,
        failure: expect.stringContaining("timed out"),
      });
      expect(store.recentEvents(20).some((event) => event.kind === "session_bridge_readiness_failed")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("composes #5454 through wire, supervisor, manager, and the real failing bridge", async () => {
    const dbPath = join(root, "state", "state.db");
    let clock = new Date("2026-09-01T08:08:00.000Z");
    const store = new StateStore(dbPath, () => clock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = cfg();
      config.daemon.session_command_unknown_max_checks = 0;
      config.daemon.session_command_max_start_retries = 2;
      config.daemon.session_bridge_ready_timeout_s = 0.05;
      const m = manager(() => clock, store, config);
      m.setTitleResolver(() => "PR 5454");
      store.upsertPr({ number: 5454, state: "queued", head_sha: "e038", title: "PR 5454", author: "alice", trigger_ts: clock.toISOString(), stale_recheck: 0, migration_gate: 0 });
      const payload = Buffer.from("# Author reply — PR #5454\n\noldest durable wake\n", "utf8");
      const payloadPath = join(root, "state", "session-commands", "cmd-5454.md");
      mkdirSync(join(root, "state", "session-commands"), { recursive: true });
      writeFileSync(payloadPath, payload);
      store.createSessionCommand({
        id: "cmd-5454",
        pr: 5454,
        session: "pr-5454",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        payload_path: payloadPath,
        inject_path: join(root, "inject", "pr-5454", "wake--cmd-cmd-5454.md"),
        next_check_at: clock.toISOString(),
      });
      store.failPendingSessionCommand("cmd-5454", "historical attempt-zero failure");
      for (let n = 1; n <= 4; n++) store.holdWake(5454, `# Author reply — PR #5454\n\nreply ${n}`, "author_reply");
      // Exact incident shape: tmux exists, but no generation receipt does.
      liveSessions.add("pr-5454");
      autoBridgeReady = false;
      onNewSession = (_session, args) => {
        const changed: Array<[string, string | undefined]> = [];
        for (const token of args) {
          const equals = token.indexOf("=");
          if (equals < 1) continue;
          const key = token.slice(0, equals);
          if (!key.startsWith("QCR_")) continue;
          changed.push([key, process.env[key]]);
          process.env[key] = token.slice(equals + 1);
        }
        try {
          // The daemon handed Pi the real DB path. Removing only its directory
          // entry leaves this already-open StateStore usable while making the
          // bridge's independent fileMustExist open fail before reservation.
          rmSync(dbPath, { force: true });
          const handlers = new Map<string, Array<(event?: unknown) => void>>();
          const pi = {
            on(event: string, handler: (event?: unknown) => void) {
              const list = handlers.get(event) ?? [];
              list.push(handler);
              handlers.set(event, list);
            },
            sendUserMessage() {},
          } as unknown as Pi;
          activateInjectBridge(pi);
          for (const handler of handlers.get("session_start") ?? []) handler({});
        } finally {
          for (const [key, prior] of changed) {
            if (prior === undefined) delete process.env[key];
            else process.env[key] = prior;
          }
        }
      };

      const retry = vi.spyOn(m, "retrySessionCommand");
      const { hooks } = daemonOriginWakes({
        hooks: m,
        origins: new OriginStore(join(root, "state", "slack", "origin")),
        enabled: false,
      });
      const supervisor = new SessionCommandSupervisor({
        cfg: config,
        store,
        hooks,
        verdictDir: join(root, "verdict"),
        onRoundFailure: async () => "requeued",
        now: () => clock,
      });

      await expect(supervisor.scan()).rejects.toThrow(/ledger_open/);
      clock = new Date("2026-09-01T08:11:00.000Z");
      await expect(supervisor.scan()).rejects.toThrow(/ledger_open/);
      clock = new Date("2026-09-01T08:14:00.000Z");
      await supervisor.scan();

      expect(retry).toHaveBeenCalledTimes(2);
      expect(store.getSessionCommand("cmd-5454")).toMatchObject({
        status: "failed",
        attempt: 0,
        recovery_attempts: 2,
        failure: expect.stringContaining("ledger_open"),
      });
      expect(store.heldWakes(5454)).toHaveLength(4);
      expect(store.blockingSessionCommand("pr-5454")).toBeTruthy();
      expect(store.openReviewFailure(5454)).toMatchObject({
        command_id: "cmd-5454",
        work_owed: 1,
        detail: expect.stringContaining("ledger_open"),
      });
      expect(store.recentEvents(100).filter((event) => event.kind === "session_bridge_readiness_failed")).toHaveLength(2);

      const listPrFiles = vi.fn(async () => { throw new Error("blocked dispatch touched GitHub"); });
      expect(await dispatchOnce({
        cfg: config,
        store,
        hooks,
        adapter: {
          listPrFiles,
          getPr: async () => { throw new Error("blocked dispatch read PR"); },
          addLabel: async () => { throw new Error("blocked dispatch mutated label"); },
          removeLabel: async () => { throw new Error("blocked dispatch mutated label"); },
          deleteTeamReviewRequest: async () => { throw new Error("blocked dispatch consumed trigger"); },
          createReview: async () => { throw new Error("blocked dispatch posted review"); },
        },
        now: () => clock,
      })).toEqual([]);
      expect(listPrFiles).not.toHaveBeenCalled();
      expect(store.roundsFor(5454)).toHaveLength(0);
    } finally {
      errors.mockRestore();
      store.close();
    }
  });

  it("does not report replay when a ready bridge never reserves the command", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      m.setTitleResolver(() => order.title);
      store.upsertPr({ number: 42, state: "queued", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      markExistingSessionReady(m, "pr-42");
      await m.inject(42, "recovered author reply");
      const command = store.activeSessionCommand("pr-42")!;
      const payload = readFileSync(command.payload_path);
      store.claimSessionCommand(command.id, "bridge-old", "2026-08-13T10:02:00Z");

      expect(await m.retrySessionCommand(command.id, "start evidence unknown")).toBe("retry_failed");

      expect(store.getSessionCommand(command.id)).toMatchObject({
        id: command.id,
        status: "pending",
        attempt: 1,
        owner_token: null,
      });
      expect(readFileSync(command.payload_path)).toEqual(payload);
      expect(readFileSync(command.inject_path)).toEqual(payload);
    } finally {
      store.close();
    }
  });

  it("fences and replays a started ordinary wake under the same id and exact bytes", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      m.setTitleResolver((pr) => (pr === 42 ? order.title : undefined));
      store.upsertPr({ number: 42, state: "queued", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      markExistingSessionReady(m, "pr-42");
      await m.inject(42, "oldest wake 🚀\0body");
      const original = store.activeSessionCommand("pr-42")!;
      const expectedBytes = Buffer.from("oldest wake 🚀\0body\n", "utf8");
      const bytes = readFileSync(original.payload_path);
      expect(bytes).toEqual(expectedBytes);
      expect(original.payload_sha256).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
      store.claimSessionCommand(original.id, "bridge-old", "2026-08-13T10:02:00Z");
      store.markSessionCommandStarted(original.id, "bridge-old", "2026-08-13T10:45:00Z");
      for (let i = 0; i < 6; i++) store.holdWake(42, `later-${i}`, "author_reply");
      onNewSession = () => {
        store.claimSessionCommand(original.id, "bridge-new", "2026-08-13T10:47:00Z");
      };

      expect(await m.retrySessionCommand(original.id, "running bound expired")).toBe("retried");

      expect(store.getSessionCommand(original.id)).toMatchObject({
        id: original.id,
        kind: "wake",
        status: "running",
        attempt: 2,
        owner_token: "bridge-new",
        started_at: null,
      });
      expect(readFileSync(original.payload_path)).toEqual(expectedBytes);
      expect(readFileSync(original.inject_path)).toEqual(expectedBytes);
      expect(store.heldWakes(42).map((wake) => wake.payload)).toEqual([
        "later-1", "later-2", "later-3", "later-4", "later-5",
      ]);
      const kill = tmuxArgs().findIndex((a) => a[0] === "kill-session" && a.includes("=pr-42"));
      const birth = tmuxArgs().findIndex((a, index) => index > kill && a[0] === "new-session" && a.includes("pr-42"));
      expect(kill).toBeGreaterThanOrEqual(0);
      expect(birth).toBeGreaterThan(kill);
    } finally {
      store.close();
    }
  });

  it("does not replay an ordinary wake whose settlement wins during the fence", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      m.setTitleResolver(() => order.title);
      store.upsertPr({ number: 42, state: "queued", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      markExistingSessionReady(m, "pr-42");
      await m.inject(42, "author reply");
      const command = store.activeSessionCommand("pr-42")!;
      store.claimSessionCommand(command.id, "bridge-old", "2026-08-13T10:02:00Z");
      store.markSessionCommandStarted(command.id, "bridge-old", "2026-08-13T10:45:00Z");
      onKillSession = () => { store.finishSessionCommand(command.id, "bridge-old", "acked"); };

      expect(await m.retrySessionCommand(command.id, "expired")).toBe("settled");
      expect(store.getSessionCommand(command.id)?.status).toBe("acked");
      expect(tmuxArgs().filter((a) => a[0] === "new-session")).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("refuses replay when the old tmux session survives the kill", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      m.setTitleResolver(() => order.title);
      store.upsertPr({ number: 42, state: "reviewing", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      store.startRound(42, "first", ["pass-baseline"], 45);
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const command = store.activeSessionCommand("pr-42")!;
      store.claimSessionCommand(command.id, "bridge-old", "2026-08-13T10:02:00Z");
      keepKilledSession = true;

      await expect(m.retrySessionCommand(command.id, "expired")).rejects.toThrow(/survived command-recovery kill/);
      expect(store.getSessionCommand(command.id)).toMatchObject({ status: "running", owner_token: "bridge-old", attempt: 1, started_at: null });
      expect(tmuxArgs().filter((a) => a[0] === "new-session")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("refuses replay when correlated acceptance wins during the kill", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      m.setTitleResolver(() => order.title);
      store.upsertPr({ number: 42, state: "reviewing", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      store.startRound(42, "first", ["pass-baseline"], 45);
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const command = store.activeSessionCommand("pr-42")!;
      store.claimSessionCommand(command.id, "bridge-old", "2026-08-13T10:02:00Z");
      onKillSession = () => { store.markSessionCommandStarted(command.id, "bridge-old", "2026-08-13T10:45:00Z"); };

      expect(await m.retrySessionCommand(command.id, "expired")).toBe("accepted_race");
      expect(store.getSessionCommand(command.id)).toMatchObject({ status: "running", started_at: "2026-08-13T10:00:00.000Z" });
      expect(tmuxArgs().filter((a) => a[0] === "new-session")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("does not replay after the verdict lifecycle terminalizes the round during the kill", async () => {
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      m.setTitleResolver(() => order.title);
      store.upsertPr({ number: 42, state: "reviewing", head_sha: "abc123", title: order.title, author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      const roundId = store.startRound(42, "first", ["pass-baseline"], 45);
      await m.dispatchRound(order, "ROUND PROMPT BODY");
      const command = store.activeSessionCommand("pr-42")!;
      store.claimSessionCommand(command.id, "bridge-old", "2026-08-13T10:02:00Z");
      onKillSession = () => { store.markRoundCancelled(roundId, "verdict won", "unknown"); };

      expect(await m.retrySessionCommand(command.id, "expired")).toBe("round_finished");
      expect(store.getSessionCommand(command.id)?.status).toBe("running");
      expect(tmuxArgs().filter((a) => a[0] === "new-session")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("adopts legacy pending files one at a time without inventing acknowledgement", () => {
    const inject = join(root, "inject", "pr-42");
    mkdirSync(inject, { recursive: true });
    const firstPath = join(inject, "2026-08-13T09-00-00-0000.md");
    const secondPath = join(inject, "2026-08-13T09-00-01-0000.md");
    writeFileSync(firstPath, "first legacy\n");
    writeFileSync(secondPath, "second legacy\n");
    const store = new StateStore(join(root, "state", "state.db"), () => new Date("2026-08-13T10:00:00Z"));
    try {
      const m = manager(undefined, store);
      const first = store.blockingSessionCommand("pr-42")!;
      expect(first).toMatchObject({ kind: "legacy", status: "pending", inject_path: firstPath });
      expect(store.getSessionCommandByInjectPath(secondPath)).toBeUndefined();

      store.claimSessionCommand(first.id, "bridge", "2026-08-13T10:30:00Z");
      store.markSessionCommandStarted(first.id, "bridge", "2026-08-13T10:30:00Z");
      store.finishSessionCommand(first.id, "bridge", "acked");
      rmSync(firstPath);
      m.restorePendingSessionCommands();
      expect(store.blockingSessionCommand("pr-42")).toMatchObject({ kind: "legacy", status: "pending", inject_path: secondPath });
    } finally {
      store.close();
    }
  });

  it("reconstructs a missing pending inject file after manager restart without creating a second command", async () => {
    const dbPath = join(root, "state", "state.db");
    const store = new StateStore(dbPath, () => new Date("2026-08-13T10:00:00Z"));
    try {
      const first = manager(undefined, store);
      await first.dispatchRound(order, "ROUND PROMPT BODY");
      const command = store.activeSessionCommand("pr-42")!;
      rmSync(command.inject_path);

      const restarted = manager(undefined, store);
      restarted.restorePendingSessionCommands();
      expect(readFileSync(command.inject_path)).toEqual(readFileSync(command.payload_path));
      expect(store.db.prepare("SELECT COUNT(*) AS c FROM session_commands").get()).toEqual({ c: 1 });
    } finally {
      store.close();
    }
  });
});

describe("adoption", () => {
  it("adopts live sandbox sessions at daemon restart and kills nothing", async () => {
    liveSessions = new Set(["pr-7", "pr-42", "overseer", "some-other-session"]);
    const m = manager();
    const report = await m.adopt();
    expect(report.adopted.sort()).toEqual(["overseer", "pr-42", "pr-7"]);
    expect(report.prs.sort((a, b) => a - b)).toEqual([7, 42]);
    expect(report.overseer).toBe(true);
    expect(tmuxArgs().some((a) => a[0] === "kill-session")).toBe(false);
    expect(tmuxArgs().some((a) => a[0] === "new-session")).toBe(false);
  });

  it("preflight adopts and sweeps only worktrees of inactive PRs", async () => {
    liveSessions = new Set(["pr-7"]);
    const m = manager();
    for (const pr of [7, 8, 9]) mkdirSync(m.worktrees.worktreePath(pr), { recursive: true });

    const { adoption, sweptWorktrees } = await m.preflight([8]);

    expect(adoption.prs).toEqual([7]);
    expect(sweptWorktrees).toEqual([9]); // 7 live, 8 active, 9 stale
    expect(existsSync(m.worktrees.worktreePath(9))).toBe(false);
    expect(existsSync(m.worktrees.worktreePath(7))).toBe(true);
  });
});

describe("archive and close", () => {
  function seedSessionArtifacts(m: PiSessionManager, session: string): void {
    const sdir = join(m.sessionDir(session), "--home-sandbox--");
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "20260810_old.jsonl"), '{"type":"session","n":1}\n');
    writeFileSync(join(sdir, "20260812_new.jsonl"), '{"type":"session","n":2}\n');
    mkdirSync(join(root, "state", "ledgers"), { recursive: true });
    writeFileSync(m.ledgerPath(session), "LEDGER PR #42 @ abc123\n");
    mkdirSync(join(root, "verdict"), { recursive: true });
    writeFileSync(join(root, "verdict", "pr-42-round-1.json"), '{"verdict":"APPROVE"}');
    writeFileSync(join(root, "verdict", "pr-99-round-1.json"), '{"verdict":"APPROVE"}');
  }

  it("picks the newest session JSONL", () => {
    const m = manager();
    seedSessionArtifacts(m, "pr-42");
    expect(m.newestSessionFile("pr-42")).toContain("20260812_new.jsonl");
    expect(m.newestSessionFile("pr-1")).toBeUndefined();
  });

  it("archives JSONL + ledger + this PR's verdicts, drops the worktree, kills tmux", async () => {
    const m = manager();
    markExistingSessionReady(m, "pr-42");
    seedSessionArtifacts(m, "pr-42");
    mkdirSync(m.worktrees.worktreePath(42), { recursive: true });
    mkdirSync(join(root, "example-app", ".git"), { recursive: true });

    await m.archiveAndClose(42);

    const dest = m.archiveDir("pr-42");
    expect(readFileSync(join(dest, "session.jsonl"), "utf8")).toBe('{"type":"session","n":2}\n');
    expect(readFileSync(join(dest, "ledger.md"), "utf8")).toBe("LEDGER PR #42 @ abc123\n");
    expect(readdirSync(join(dest, "verdicts"))).toEqual(["pr-42-round-1.json"]);
    expect(JSON.parse(readFileSync(join(dest, "meta.json"), "utf8")).archived_at).toBe("2026-08-13T10:00:00.000Z");

    const gitArgs = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(gitArgs.some((a) => a.startsWith("worktree remove --force"))).toBe(true);
    expect(gitArgs).toContain("worktree prune");
    expect(tmuxArgs()).toContainEqual(["kill-session", "-t", "=pr-42"]);
    expect(liveSessions.has("pr-42")).toBe(false);
  });

  it("archives what exists when the session left no JSONL", async () => {
    const m = manager();
    await m.archiveAndClose(42);
    expect(existsSync(join(m.archiveDir("pr-42"), "meta.json"))).toBe(true);
    expect(existsSync(join(m.archiveDir("pr-42"), "session.jsonl"))).toBe(false);
  });
});

describe("overseer rotation", () => {
  it("is not due before the configured age", async () => {
    let now = new Date("2026-08-13T10:00:00Z");
    const m = manager(() => now);
    await m.ensureOverseerSession();
    now = new Date("2026-08-19T10:00:00Z"); // 6 days
    expect(m.overseerRotationDue()).toBe(false);
    expect(await m.rotateOverseerIfDue()).toBe(false);
  });

  it("archives and respawns once the rotation interval elapses", async () => {
    let now = new Date("2026-08-13T10:00:00Z");
    const m = manager(() => now);
    await m.ensureOverseerSession();
    const sdir = join(m.sessionDir(OVERSEER_SESSION), "s");
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "run.jsonl"), '{"type":"session"}\n');

    now = new Date("2026-08-20T10:00:00Z"); // 7 days
    expect(m.overseerRotationDue()).toBe(true);
    expect(await m.rotateOverseerIfDue()).toBe(true);

    expect(existsSync(join(m.archiveDir(OVERSEER_SESSION), "2026-08-20", "session.jsonl"))).toBe(true);
    expect(tmuxArgs()).toContainEqual(["kill-session", "-t", "=overseer"]);
    expect(tmuxArgs().filter((a) => a[0] === "new-session" && a[3] === "overseer")).toHaveLength(2);
    expect(liveSessions.has(OVERSEER_SESSION)).toBe(true);
  });

  it("reports not-due when no birth record exists (adopted session)", () => {
    expect(manager().overseerRotationDue()).toBe(false);
  });
});
