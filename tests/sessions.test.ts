// Session manager tests. Every process invocation goes through a fake exec
// that records commands — no tmux, no pi, no git is ever spawned. Filesystem
// work happens inside a temp sandbox root.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { PiSessionManager, OVERSEER_SESSION, buildPiCommand, isSandboxSession, prOfSession, prSessionName } from "../src/sessions.js";
import { Tmux } from "../src/tmux.js";
import type { ExecFn } from "../src/tmux.js";
import { StateStore } from "../src/state.js";
import { roundPromptMarker } from "../src/types.js";
import type { RoundOrder } from "../src/types.js";
import { WorktreeManager } from "../src/worktrees.js";

let root: string;
let secrets: string;
let calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
let liveSessions: Set<string>;
let onKillSession: ((name: string) => void) | undefined;
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
    if (args[0] === "new-session") liveSessions.add(String(args[3]));
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

function manager(now = () => new Date("2026-08-13T10:00:00Z"), store?: StateStore): PiSessionManager {
  return new PiSessionManager({
    cfg: cfg(),
    root,
    tmux: new Tmux({ exec: fakeExec }),
    worktrees: new WorktreeManager({ root, repo: "o/n", cloneDir: "example-app", cloneUrl: "/dev/null", run: fakeExec }),
    piHome: join(root, "pihome"),
    ovSessions,
    now,
    ...(store ? { commandStore: store } : {}),
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

    const promptPath = m.promptPath("pr-42");
    expect(newSession).toContain(promptPath);
    expect(readFileSync(promptPath, "utf8")).toBe("Shepherd of PR #42 (Add rate limiting) at wt/pr-42.\n");
    expect(existsSync(join(m.injectDir("pr-42"), ".done"))).toBe(true);
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
    liveSessions.add("pr-42");
    await m.ensurePrSession(42, "T", "wt/pr-42");
    expect(tmuxArgs().some((a) => a[0] === "new-session")).toBe(false);
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
    liveSessions.add("pr-42");
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
    liveSessions.add("pr-42");
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

      liveSessions.add("pr-42");
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

      expect(await m.retrySessionCommand(original.id, "start lease expired")).toBe("retried");

      const retried = store.activeSessionCommand("pr-42")!;
      expect(retried).toMatchObject({ id: original.id, status: "pending", attempt: 1, owner_token: null });
      expect(readFileSync(retried.inject_path)).toEqual(bytes);
      const kill = tmuxArgs().findIndex((a) => a[0] === "kill-session" && a.includes("=pr-42"));
      const birth = tmuxArgs().findIndex((a, index) => index > kill && a[0] === "new-session" && a.includes("pr-42"));
      expect(kill).toBeGreaterThanOrEqual(0);
      expect(birth).toBeGreaterThan(kill);
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
    liveSessions.add("pr-42");
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
