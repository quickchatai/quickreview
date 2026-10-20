// The Slack concierge appendix: the overseer system prompt
// is the seeded template plus — only when Slack is enabled — the appendix body,
// concatenated at spawn time. The seed file itself is never modified.
// All I/O is faked: no tmux, no pi, no Slack.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { PiSessionManager, OVERSEER_SESSION } from "../src/sessions.js";
import { writeSessionBridgeState } from "../src/overseer-bridge.js";
import { Tmux } from "../src/tmux.js";
import type { ExecFn } from "../src/tmux.js";
import { renderOverseerSystemPrompt } from "../src/templates.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const APPENDIX_SRC = join(REPO_ROOT, "prompts", "slack-overseer-appendix.md");
const SEED_SRC = join(REPO_ROOT, "prompts", "overseer-system.md");

let root: string;
let secrets: string;
let liveSessions: Set<string>;

const fakeExec: ExecFn = async (cmd, args) => {
  if (cmd === "tmux") {
    if (args[0] === "list-sessions")
      return { code: 0, stdout: [...liveSessions].join("\n"), stderr: "" };
    if (args[0] === "has-session") {
      const name = String(args[2]).replace(/^=/, "");
      return { code: liveSessions.has(name) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "new-session") {
      const session = String(args[3]);
      liveSessions.add(session);
      const generation = args
        .find((v) => v.startsWith("QCR_SESSION_BRIDGE_GENERATION="))
        ?.split("=", 2)[1];
      const path = args
        .find((v) => v.startsWith("QCR_SESSION_BRIDGE_STATE_FILE="))
        ?.slice("QCR_SESSION_BRIDGE_STATE_FILE=".length);
      if (generation && path)
        writeSessionBridgeState(path, {
          version: 1,
          session,
          generation,
          stage: "ready",
          updated_at: "2026-08-17T10:00:00Z",
        });
    }
  }
  return { code: 0, stdout: "", stderr: "" };
};

/** Minimal config; `slack` is read defensively by sessions.ts as an optional. */
function cfg(slackEnabled: boolean): Config {
  return {
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
      version: "0.84.1",
      session_dir: "state/pi-sessions",
    },
    slack: { enabled: slackEnabled },
  } as unknown as Config;
}

function manager(slackEnabled: boolean): PiSessionManager {
  return new PiSessionManager({
    cfg: cfg(slackEnabled),
    root,
    tmux: new Tmux({ exec: fakeExec }),
    piHome: join(root, "pihome"),
    now: () => new Date("2026-08-17T10:00:00Z"),
  });
}

/** The substituted prompt pi is launched with. */
function spawnedPrompt(): string {
  return readFileSync(join(root, "state", "session-prompts", `${OVERSEER_SESSION}.md`), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-slack-appendix-"));
  secrets = join(root, "secrets");
  liveSessions = new Set();
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(secrets, { recursive: true });
  // Real seed + real appendix: the contract is about these exact bytes.
  copyFileSync(SEED_SRC, join(root, "prompts", "overseer-system.md"));
  copyFileSync(APPENDIX_SRC, join(root, "prompts", "slack-overseer-appendix.md"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("overseer spawn-time Slack appendix", () => {
  it("appends nothing when Slack is disabled", async () => {
    await manager(false).ensureOverseerSession();
    const seed = readFileSync(join(root, "prompts", "overseer-system.md"), "utf8");
    expect(spawnedPrompt()).toBe(renderOverseerSystemPrompt(seed));
  });

  it("appends the appendix body when Slack is enabled, leaving the seed untouched", async () => {
    const seedPath = join(root, "prompts", "overseer-system.md");
    const before = readFileSync(seedPath);
    await manager(true).ensureOverseerSession();
    const prompt = spawnedPrompt();
    const appendix = readFileSync(APPENDIX_SRC, "utf8").trimEnd();
    expect(prompt.startsWith(renderOverseerSystemPrompt(readFileSync(seedPath, "utf8")))).toBe(
      true,
    );
    expect(prompt).toContain(appendix);
    expect(prompt).toContain("# Slack concierge appendix");
    expect(readFileSync(seedPath).equals(before)).toBe(true);
    // and the on-disk canonical seed in the repo is untouched too
    expect(readFileSync(SEED_SRC, "utf8")).toBe(before.toString("utf8"));
  });

  it("throws a clear error when Slack is enabled but the appendix file is missing", async () => {
    rmSync(join(root, "prompts", "slack-overseer-appendix.md"));
    await expect(manager(true).ensureOverseerSession()).rejects.toThrow(
      /slack-overseer-appendix\.md/,
    );
  });

  it("leaves a live bridge-ready overseer alone (no respawn, no prompt rewrite)", async () => {
    liveSessions.add(OVERSEER_SESSION);
    const m = manager(true);
    const generation = "existing-overseer";
    mkdirSync(join(root, "state", "sessions"), { recursive: true });
    writeFileSync(
      join(root, "state", "sessions", "overseer.json"),
      JSON.stringify({
        session: OVERSEER_SESSION,
        bridge_generation: generation,
        born_at: "2026-08-17T10:00:00Z",
      }),
    );
    writeSessionBridgeState(m.bridgeStatePath(OVERSEER_SESSION, generation), {
      version: 1,
      session: OVERSEER_SESSION,
      generation,
      stage: "ready",
      updated_at: "2026-08-17T10:00:00Z",
    });
    await m.ensureOverseerSession();
    expect(() => spawnedPrompt()).toThrow();
  });
});

describe("appendix content contract", () => {
  const appendix = readFileSync(APPENDIX_SRC, "utf8");

  it("names slack_reply as the only way to speak", () => {
    expect(appendix).toContain("slack_reply");
    expect(appendix).toMatch(/slack_reply\s*\{thread, text\}/);
    expect(appendix).toMatch(/ONLY way/i);
  });

  it("states that flag-owner is tier-free", () => {
    expect(appendix).toMatch(/`flag-owner` is TIER-FREE/);
  });

  it("names all three tiers", () => {
    for (const tier of ["anyone", "author", "owner"]) {
      expect(appendix).toContain(`\`${tier}\``);
    }
  });

  it("forbids **bold** in favour of mrkdwn *bold*", () => {
    expect(appendix).toContain("`*bold*` NOT `**bold**`");
  });

  it("routes Slack-caused commands to the Slack command directory", () => {
    expect(appendix).toContain("commands/slack/");
  });

  it("restates the unchanged invariants, the owner included", () => {
    expect(appendix).toMatch(/never dismiss a review|Never post a review, never dismiss/i);
    expect(appendix).toMatch(/INCLUDING the owner/);
  });

  it("carries the origin-header field list", () => {
    for (const field of [
      "source",
      "event_id",
      "thread",
      "thread_pr",
      "slack_user",
      "github_login",
      "tier",
      "authorized_prs",
      "received_at",
    ]) {
      expect(appendix).toContain(field);
    }
    expect(appendix).toContain("<!-- qcr:slack v1 -->");
  });

  it("contains no {{placeholder}}-shaped token render() would choke on", () => {
    expect(appendix.match(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g)).toBeNull();
  });
});
