import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SLACK_CAUSE_DEFAULTS,
  SLACK_DEFAULTS,
  SLACK_POLICY_DEFAULTS,
  parseConfig,
  slackTokenPath,
  validateSlackConfig,
  type Config,
} from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = readFileSync(join(root, "config.toml"), "utf8");

/** The shipped config with an alternative [slack] block spliced in. */
function withSlack(block: string): Config {
  const base = shipped.slice(0, shipped.indexOf("\n[slack]"));
  return parseConfig(`${base}\n${block}\n`);
}

describe("shipped config.toml [slack]", () => {
  const cfg = parseConfig(shipped);

  it("ships disabled — turning Slack on is a deliberate deploy-time act", () => {
    expect(cfg.slack.enabled).toBe(false);
    expect(cfg.slack.channel).toBe("");
    expect(cfg.slack.legacy_owner_slack_id).toBe("");
  });

  it("carries the ratified policy numbers", () => {
    expect(cfg.slack.policy.daily_turns).toBe(80);
    expect(cfg.slack.policy.per_user_daily_turns).toBe(20);
    expect(cfg.slack.policy.thread_replies_per_day).toBe(6);
    expect(cfg.slack.policy.announcements_per_hour).toBe(20);
    expect(cfg.slack.policy.broadcast_verdicts).toBe("never");
    expect(cfg.slack.policy.timezone).toBe("Europe/Warsaw");
    expect(cfg.slack.post_min_interval_ms).toBe(1100);
    expect(cfg.slack.reconnect_backoff_ms).toEqual([1000, 2000, 5000, 15000, 30000]);
  });

  it("parses every per-cause switch and cooldown", () => {
    expect(cfg.slack.policy.causes["round.overdue"]).toEqual({ enabled: true, cooldown_min: 60 });
    expect(cfg.slack.policy.causes["pr.not_picked_up"]).toEqual({ enabled: true, cooldown_min: 120 });
    expect(cfg.slack.policy.causes["reconcile.storm"]).toEqual({ enabled: false, cooldown_min: 180 });
    expect(cfg.slack.policy.causes["pr.awaiting_human_stale"]).toEqual({ enabled: false, cooldown_min: 1440 });
    expect(Object.keys(cfg.slack.policy.causes).sort()).toEqual(Object.keys(SLACK_CAUSE_DEFAULTS).sort());
  });

  it("holds no token anywhere — only file names", () => {
    expect(JSON.stringify(cfg.slack)).not.toMatch(/xoxb-|xapp-/);
    expect(cfg.slack.bot_token_file).toBe("slack_bot_token");
    expect(cfg.slack.app_token_file).toBe("slack_app_token");
  });
});

describe("defaults merge", () => {
  it("an absent [slack] block yields the defaults verbatim", () => {
    const base = shipped.slice(0, shipped.indexOf("\n[slack]"));
    const cfg = parseConfig(base);
    expect(cfg.slack).toEqual(SLACK_DEFAULTS);
    expect(cfg.slack.policy).toEqual(SLACK_POLICY_DEFAULTS);
  });

  it("a partial [slack.policy] keeps every unmentioned default", () => {
    const cfg = withSlack(`[slack]\n[slack.policy]\ndaily_turns = 3\n`);
    expect(cfg.slack.policy.daily_turns).toBe(3);
    expect(cfg.slack.policy.per_user_daily_turns).toBe(SLACK_POLICY_DEFAULTS.per_user_daily_turns);
    expect(cfg.slack.policy.causes["daemon.up"]).toEqual({ enabled: true, cooldown_min: 0 });
  });

  it("a partial cause override merges into the default cause map", () => {
    const cfg = withSlack(`[slack]\n[slack.policy.causes]\n"digest.eod" = { enabled = true, cooldown_min = 5 }\n"custom.thing" = { enabled = true, cooldown_min = 7 }\n`);
    expect(cfg.slack.policy.causes["digest.eod"]).toEqual({ enabled: true, cooldown_min: 5 });
    expect(cfg.slack.policy.causes["custom.thing"]).toEqual({ enabled: true, cooldown_min: 7 });
    expect(cfg.slack.policy.causes["round.overdue"]).toEqual({ enabled: true, cooldown_min: 60 });
  });

  it("expands ~ in a token-file override and resolves bare names under secrets_dir", () => {
    const cfg = withSlack(`[slack]\nbot_token_file = "~/secrets/bot"\n`);
    expect(cfg.slack.bot_token_file.startsWith("~")).toBe(false);
    expect(slackTokenPath(cfg, "bot")).toBe(cfg.slack.bot_token_file);
    expect(slackTokenPath(cfg, "app")).toBe(join(cfg.github.secrets_dir, "slack_app_token"));
  });
});

describe("boot validation", () => {
  const enabled = (extra = "") =>
    `[slack]\nenabled = true\nchannel = "C123"\nlegacy_owner_slack_id = "U0MAT"\n${extra}\n[slack.users]\nU0MAT = "mhale"\n`;
  const bothTokens = () => (path: string) => (path.endsWith("slack_bot_token") || path.endsWith("slack_app_token") ? "xoxb-x" : undefined);

  it("stays silent when disabled — nothing required, nothing read", () => {
    let reads = 0;
    const cfg = withSlack(`[slack]\nenabled = false\nchannel = ""\n`);
    expect(() =>
      validateSlackConfig(cfg, {
        readSecret: () => {
          reads += 1;
          return undefined;
        },
      }),
    ).not.toThrow();
    expect(reads).toBe(0);
  });

  it("fails loud when enabled with an empty channel", () => {
    expect(() => withSlack(`[slack]\nenabled = true\nchannel = ""\nlegacy_owner_slack_id = "U0MAT"\n[slack.users]\nU0MAT = "mhale"\n`)).toThrow(
      /non-empty `channel`/,
    );
  });

  it("fails loud when legacy_owner_slack_id is empty", () => {
    expect(() => withSlack(`[slack]\nenabled = true\nchannel = "C1"\nlegacy_owner_slack_id = ""\n`)).toThrow(/non-empty `legacy_owner_slack_id`/);
  });

  it("fails loud when legacy_owner_slack_id is absent from [slack.users]", () => {
    expect(() =>
      withSlack(`[slack]\nenabled = true\nchannel = "C1"\nlegacy_owner_slack_id = "U0MAT"\n[slack.users]\nU0OTHER = "someone"\n`),
    ).toThrow(/must appear as a key in \[slack.users\]/);
  });

  it("rejects a bogus channel_kind", () => {
    expect(() => withSlack(enabled(`channel_kind = "dm"`))).toThrow(/channel_kind/);
  });

  it("accepts a well-formed enabled config when both token files are present", () => {
    const cfg = withSlack(enabled());
    expect(() => validateSlackConfig(cfg, { readSecret: bothTokens() })).not.toThrow();
  });

  it("fails loud on a missing or empty token file — never a silent read-only Slack", () => {
    const cfg = withSlack(enabled());
    expect(() => validateSlackConfig(cfg, { readSecret: () => undefined })).toThrow(/bot token file .* missing or empty/);
    expect(() =>
      validateSlackConfig(cfg, { readSecret: (p) => (p.endsWith("slack_bot_token") ? "xoxb-x" : undefined) }),
    ).toThrow(/app token file .* missing or empty/);
  });

  it("reads real files through the default fs reader (temp secrets dir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-slack-secrets-"));
    const cfg = withSlack(enabled());
    cfg.github.secrets_dir = dir;
    writeFileSync(join(dir, "slack_bot_token"), "xoxb-real\n");
    expect(() => validateSlackConfig(cfg)).toThrow(/app token file/);
    writeFileSync(join(dir, "slack_app_token"), "   \n"); // whitespace only = empty
    expect(() => validateSlackConfig(cfg)).toThrow(/app token file/);
    writeFileSync(join(dir, "slack_app_token"), "xapp-real\n");
    expect(() => validateSlackConfig(cfg)).not.toThrow();
  });
});
