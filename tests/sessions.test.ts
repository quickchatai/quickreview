// Session manager tests. Every process invocation goes through a fake exec
// that records commands — no tmux, no pi, no git is ever spawned. Filesystem
// work happens inside a temp sandbox root.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { PiSessionManager, OVERSEER_SESSION, buildPiCommand, isSandboxSession, prOfSession, prSessionName } from "../src/sessions.js";
import { Tmux } from "../src/tmux.js";
import type { ExecFn } from "../src/tmux.js";
import type { RoundOrder } from "../src/types.js";
import { WorktreeManager } from "../src/worktrees.js";

let root: string;
let secrets: string;
let calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
let liveSessions: Set<string>;

const cfg = (): Config =>
  ({
    dry_run: true,
    github: {
      repo: "example-org/example-app",
      app_slug: "example-review",
      bot_login: "example-review[bot]",
      review_team: "example-org/review",
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
    pi: { package: "@earendil-works/pi-coding-agent", version: "0.84.1", session_dir: "state/pi-sessions" },
  }) satisfies Config;

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
    if (args[0] === "kill-session") liveSessions.delete(String(args[2]).replace(/^=/, ""));
  }
  return { code: 0, stdout: "", stderr: "" };
};

function manager(now = () => new Date("2026-08-13T10:00:00Z")): PiSessionManager {
  return new PiSessionManager({
    cfg: cfg(),
    root,
    tmux: new Tmux({ exec: fakeExec }),
    worktrees: new WorktreeManager({ root, repo: "o/n", cloneUrl: "/dev/null", run: fakeExec }),
    piHome: join(root, "pihome"),
    now,
  });
}

const order: RoundOrder = {
  pr: 42,
  title: "Add rate limiting",
  round_id: 1,
  round_no: 1,
  round_type: "first",
  lenses: ["pass-baseline"],
  escalation_worthy: false,
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
  liveSessions = new Set();
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
        "HOME", "LANG", "OPENAI_API_KEY", "PATH", "QCR_INJECT_DIR", "QCR_LEDGER_FILE",
        "QCR_PI_VERSION", "QCR_PR", "QCR_SANDBOX_ROOT", "QCR_SECRETS_DIR", "QCR_SESSION_NAME", "TERM",
      ]);
    } finally {
      delete process.env.QCR_TEST_PERSONAL_TOKEN;
    }
  });

  it("omits the OpenAI key when the secrets dir has none", async () => {
    rmSync(join(secrets, "openai_api_key"));
    expect(manager().buildEnv("pr-1").OPENAI_API_KEY).toBeUndefined();
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
    expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("ROUND PROMPT BODY\n");
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
