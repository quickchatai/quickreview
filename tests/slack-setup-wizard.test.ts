// Tests for the pure helpers of deploy/collect-slack-secrets.mjs — no network,
// no prompts, no real files. The load-bearing one is patchConfigToml: the real
// config.toml goes in, the daemon's own parseConfig reads the result back.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";
// A plain ESM script with no type declarations by design; `tsconfig.tests.json`
// sets `allowJs`, so tsc infers its exports and the call sites below are
// really checked.
import * as wiz from "../deploy/collect-slack-secrets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");

describe("parseChannelId", () => {
  it("accepts a raw id", () => {
    expect(wiz.parseChannelId("C0ABCDEFG")).toEqual({ ok: true, id: "C0ABCDEFG" });
  });

  it("trims surrounding whitespace", () => {
    expect(wiz.parseChannelId("   C0ABCDEFG \n")).toEqual({ ok: true, id: "C0ABCDEFG" });
  });

  it("upper-cases a lowercased paste", () => {
    expect(wiz.parseChannelId("c0abcdefg")).toEqual({ ok: true, id: "C0ABCDEFG" });
  });

  it("accepts a legacy private-group id (G…)", () => {
    expect(wiz.parseChannelId("G01AB2CD3")).toEqual({ ok: true, id: "G01AB2CD3" });
  });

  it("extracts the id from a Slack permalink", () => {
    const r = wiz.parseChannelId("https://example.slack.com/archives/C0ABCDEFG/p1712345678000100");
    expect(r).toEqual({ ok: true, id: "C0ABCDEFG" });
  });

  it("extracts the id from a permalink carrying a query string", () => {
    const r = wiz.parseChannelId(
      "https://example.slack.com/archives/C0ABCDEFG/p1712345678000100?thread_ts=1712345678.000100&cid=C0ABCDEFG",
    );
    expect(r).toEqual({ ok: true, id: "C0ABCDEFG" });
  });

  it("falls back to the cid query parameter when the path has no archives segment", () => {
    const r = wiz.parseChannelId("https://app.slack.com/client/T01/x?cid=C0ABCDEFG");
    expect(r).toEqual({ ok: true, id: "C0ABCDEFG" });
  });

  it("rejects a #name and says where to find the id", () => {
    const r = wiz.parseChannelId("#dev-review");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/channel ID/);
    expect(r.reason).toMatch(/About/);
  });

  it("rejects empty input", () => {
    expect(wiz.parseChannelId("   ").ok).toBe(false);
    expect(wiz.parseChannelId(undefined).ok).toBe(false);
  });

  it("rejects garbage", () => {
    expect(wiz.parseChannelId("not a channel").ok).toBe(false);
    expect(wiz.parseChannelId("U01AB2CD3EF").ok).toBe(false);
    expect(wiz.parseChannelId("C12").ok).toBe(false);
  });

  it("rejects a URL with no id in it", () => {
    const r = wiz.parseChannelId("https://example.slack.com/messages/general");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Copy link/);
  });
});

describe("parseUserId", () => {
  it("accepts U… and W… ids, upper-casing", () => {
    expect(wiz.parseUserId("u01ab2cd3ef")).toEqual({ ok: true, id: "U01AB2CD3EF" });
    expect(wiz.parseUserId("W01AB2CD3").ok).toBe(true);
  });

  it("rejects a channel id or a handle", () => {
    expect(wiz.parseUserId("C0ABCDEFG").ok).toBe(false);
    expect(wiz.parseUserId("@morgan").ok).toBe(false);
  });
});

describe("tokenLooksValid", () => {
  const bot = `xoxb-${"1".repeat(40)}`;
  const app = `xapp-${"1".repeat(40)}`;

  it("accepts the right token in the right slot", () => {
    expect(wiz.tokenLooksValid("bot", bot).ok).toBe(true);
    expect(wiz.tokenLooksValid("app", app).ok).toBe(true);
  });

  it("names the mistake when the app token is pasted at step 2", () => {
    const r = wiz.tokenLooksValid("bot", app);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/APP-LEVEL token/);
    expect(r.reason).toMatch(/xapp-/);
  });

  it("names the mistake when the bot token is pasted at step 3", () => {
    const r = wiz.tokenLooksValid("app", bot);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BOT token/);
  });

  it("rejects a wrong prefix, whitespace, emptiness and a truncated paste", () => {
    expect(wiz.tokenLooksValid("bot", "xoxp-abc").ok).toBe(false);
    expect(wiz.tokenLooksValid("bot", `xoxb ${"1".repeat(40)}`).ok).toBe(false);
    expect(wiz.tokenLooksValid("bot", "").ok).toBe(false);
    expect(wiz.tokenLooksValid("bot", "xoxb-123").reason).toMatch(/short/);
  });
});

describe("maskToken", () => {
  const secret = "xoxb-1234567890-ABCDEFGHIJKLMNOP-secrettail";

  it("never reveals the body of the token", () => {
    const masked = wiz.maskToken(secret);
    expect(masked).not.toContain("1234567890");
    expect(masked).not.toContain("ABCDEFGHIJKLMNOP");
    expect(masked).not.toContain(secret);
    expect(masked.startsWith("xoxb-")).toBe(true);
    expect(masked).toContain(`${secret.length} chars`);
  });

  it("reveals at most a prefix and a 3-char tail hint", () => {
    const masked = wiz.maskToken(secret);
    const revealed = masked.replace(/ \(\d+ chars\)$/, "").split("…");
    expect(revealed[0]).toBe("xoxb-");
    expect(revealed[1]!.length).toBeLessThanOrEqual(3);
  });

  it("masks a short value completely and handles empties", () => {
    expect(wiz.maskToken("xoxb-abc")).not.toContain("abc");
    expect(wiz.maskToken("")).toBe("(empty)");
  });
});

describe("looksLikeGithubLogin", () => {
  it("accepts real logins and rejects the usual mistakes", () => {
    expect(wiz.looksLikeGithubLogin("mhale")).toBe(true);
    expect(wiz.looksLikeGithubLogin("a-b-c9")).toBe(true);
    expect(wiz.looksLikeGithubLogin("@mhale")).toBe(false);
    expect(wiz.looksLikeGithubLogin("-mhale")).toBe(false);
    expect(wiz.looksLikeGithubLogin("sku--am")).toBe(false);
    expect(wiz.looksLikeGithubLogin("a".repeat(40))).toBe(false);
    expect(wiz.looksLikeGithubLogin("")).toBe(false);
  });
});

describe("renderUsersTable", () => {
  it("renders TOML entries in insertion order", () => {
    const map = new Map([
      ["U0OWNER", "mhale"],
      ["U0TEAM", "someone-else"],
    ]);
    expect(wiz.renderUsersTable(map)).toBe('U0OWNER = "mhale"\nU0TEAM = "someone-else"');
  });

  it("accepts a plain object and an empty map", () => {
    expect(wiz.renderUsersTable({ U0X: "a" })).toBe('U0X = "a"');
    expect(wiz.renderUsersTable(new Map())).toBe("");
    expect(wiz.renderUsersTable(undefined)).toBe("");
  });
});

describe("renderSlackValues", () => {
  const values = {
    channel: "C0ABCDEFG",
    channelName: "dev-review",
    channel_kind: "private",
    legacy_owner_slack_id: "U0OWNER",
    users: new Map([
      ["U0OWNER", "mhale"],
      ["U0TEAM", "other"],
    ]),
  };

  it("summarises the values without leaking anything secret", () => {
    const text = wiz.renderSlackValues(values);
    expect(text).toContain("C0ABCDEFG");
    expect(text).toContain("#dev-review");
    expect(text).toContain("private");
    expect(text).toContain("2 entries");
    expect(text).toContain("U0OWNER → mhale");
    expect(text).toMatch(/U0OWNER → mhale\s+\(tier-M\)/);
  });

  it("shows an empty channel as such", () => {
    const text = wiz.renderSlackValues({
      channel: "",
      channel_kind: "public",
      legacy_owner_slack_id: "",
      users: {},
    });
    expect(text).toContain("(empty)");
    expect(text).toContain("0 entries");
  });
});

describe("readSlackValues", () => {
  it("reads the shipped config's [slack] block", () => {
    const v = wiz.readSlackValues(shipped);
    expect(v).toMatchObject({
      enabled: false,
      channel: "",
      channel_kind: "public",
      legacy_owner_slack_id: "",
    });
    expect(v.users).toEqual({});
  });
});

describe("readSecretsDir", () => {
  it("reads [github].secrets_dir from the fixture config", () => {
    expect(wiz.readSecretsDir(shipped)).toMatch(/example-review-bot/);
  });

  it("falls back when the key is absent", () => {
    expect(wiz.readSecretsDir('[github]\nrepo = "x"\n')).toBe("~/.config/quickreview-bot");
  });
});

describe("expandHome", () => {
  it("expands a leading ~ only", () => {
    expect(wiz.expandHome("~/x", "/home/m")).toBe("/home/m/x");
    expect(wiz.expandHome("~", "/home/m")).toBe("/home/m");
    expect(wiz.expandHome("/abs/~x", "/home/m")).toBe("/abs/~x");
  });
});

describe("manifestYaml", () => {
  it("reproduces the §5 manifest", () => {
    const y = wiz.manifestYaml("public");
    expect(y).toContain("name: quickreview-concierge");
    expect(y).toContain("display_name: quickreview");
    expect(y).toContain("- chat:write");
    expect(y).toContain("- channels:history");
    expect(y).toContain("- users:read");
    expect(y).toContain("socket_mode_enabled: true");
    expect(y).toContain("- message.channels");
    expect(y).toContain("org_deploy_enabled: false");
    expect(y).toContain("token_rotation_enabled: false");
    // the private-only bits stay commented out in the public variant
    expect(y).toMatch(/# - groups:history/);
    expect(y).toMatch(/# - message.groups/);
  });

  it("uncomments the private-channel scope and event in the private variant", () => {
    const y = wiz.manifestYaml("private");
    expect(y).toMatch(/^ +- groups:history$/m);
    expect(y).toMatch(/^ +- message\.groups$/m);
  });
});

// --------------------------------------------------------------------------
// patchConfigToml — the one that has to be right.

const PATCH = {
  channel: "C0ABCDEFG",
  channel_kind: "private",
  legacy_owner_slack_id: "U0OWNER",
  users: new Map([
    ["U0OWNER", "mhale"],
    ["U0TEAM", "teammate"],
  ]),
};

/** The text between a header line and the next `[`-header, inclusive of the header. */
function section(text: string, header: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  expect(start, `missing ${header}`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("patchConfigToml", () => {
  const patched: string = wiz.patchConfigToml(shipped, PATCH);

  it("sets the three scalars", () => {
    expect(patched).toMatch(/^channel = "C0ABCDEFG"/m);
    expect(patched).toMatch(/^channel_kind = "private"/m);
    expect(patched).toMatch(/^legacy_owner_slack_id = "U0OWNER"/m);
  });

  it("writes the [slack.users] entries", () => {
    expect(section(patched, "[slack.users]")).toContain('U0OWNER = "mhale"');
    expect(section(patched, "[slack.users]")).toContain('U0TEAM = "teammate"');
  });

  it("preserves every comment in the file", () => {
    const comments = (t: string) => t.split("\n").filter((l) => l.trim().startsWith("#"));
    expect(comments(patched)).toEqual(comments(shipped));
  });

  it("preserves the trailing comments on the patched lines themselves", () => {
    expect(patched).toMatch(/^channel = "C0ABCDEFG" +# the ONE channel id/m);
    expect(patched).toMatch(/^channel_kind = "private" +# "public" \| "private"/m);
  });

  it("leaves [slack.policy] and [slack.policy.causes] byte-identical", () => {
    expect(section(patched, "[slack.policy]")).toBe(section(shipped, "[slack.policy]"));
    expect(section(patched, "[slack.policy.causes]")).toBe(
      section(shipped, "[slack.policy.causes]"),
    );
  });

  it("does not touch `enabled`", () => {
    expect(patched).toMatch(/^enabled = false/m);
    expect(wiz.readSlackValues(patched).enabled).toBe(false);
  });

  it("leaves every other key of [slack] alone", () => {
    for (const key of [
      "bot_token_file",
      "app_token_file",
      "post_min_interval_ms",
      "reconnect_backoff_ms",
      "server_ping_timeout_ms",
      "catchup_max_age_s",
      "max_reply_chars",
      "name_cache_ttl_s",
    ]) {
      const line = (t: string) => t.split("\n").find((l) => l.startsWith(`${key} `));
      expect(line(patched)).toBe(line(shipped));
    }
  });

  it("touches nothing outside the [slack] tables", () => {
    const before = shipped.slice(0, shipped.indexOf("\n[slack]"));
    expect(patched.slice(0, patched.indexOf("\n[slack]"))).toBe(before);
  });

  it("is idempotent", () => {
    expect(wiz.patchConfigToml(patched, PATCH)).toBe(patched);
  });

  it("replaces a pre-existing [slack.users] body instead of appending to it", () => {
    const second: string = wiz.patchConfigToml(patched, {
      ...PATCH,
      users: new Map([["U0OWNER", "mhale"]]),
    });
    const body = section(second, "[slack.users]");
    expect(body).toContain('U0OWNER = "mhale"');
    expect(body).not.toContain("U0TEAM");
    expect(body.split("\n").filter((l) => /^U/.test(l))).toHaveLength(1);
  });

  it("creates [slack.users] when the section is missing", () => {
    const without = shipped.replace(/\n\[slack\.users\][\s\S]*?(?=\n\[slack\.policy\])/, "");
    expect(without.split("\n").some((l) => l.trim() === "[slack.users]")).toBe(false);
    const made: string = wiz.patchConfigToml(without, PATCH);
    expect(section(made, "[slack.users]")).toContain('U0OWNER = "mhale"');
    expect(parseConfig(made).slack.users).toEqual({ U0OWNER: "mhale", U0TEAM: "teammate" });
  });

  it("throws when there is no [slack] section to patch", () => {
    expect(() => wiz.patchConfigToml('[github]\nrepo = "x"\n', PATCH)).toThrow(
      /no \[slack\] section/,
    );
  });

  // The loop-closing assertion: the daemon's own parser reads the wizard's output.
  it("produces a file the daemon's parseConfig accepts, with exactly these values", () => {
    const before = parseConfig(shipped);
    const cfg = parseConfig(patched);
    expect(cfg.slack.channel).toBe("C0ABCDEFG");
    expect(cfg.slack.channel_kind).toBe("private");
    // the wizard writes the legacy [slack] key; parseConfig folds it
    // into [owner] slack_id and drops it from the parsed slack shape.
    expect(cfg.owner.slack_id).toBe("U0OWNER");
    expect("legacy_owner_slack_id" in cfg.slack).toBe(false);
    expect(cfg.slack.users).toEqual({ U0OWNER: "mhale", U0TEAM: "teammate" });
    expect(cfg.slack.enabled).toBe(false);
    expect(cfg.slack.policy).toEqual(before.slack.policy);
    expect(cfg.slack.bot_token_file).toBe(before.slack.bot_token_file);
    expect(cfg.slack.app_token_file).toBe(before.slack.app_token_file);
  });

  it("passes the daemon's enabled-mode shape check once enabled is flipped", () => {
    const live = patched.replace(/^enabled = false/m, "enabled = true");
    const cfg = parseConfig(live);
    expect(cfg.slack.enabled).toBe(true);
    expect(cfg.owner.slack_id in cfg.slack.users).toBe(true);
  });

  it("is rejected by the daemon when legacy_owner_slack_id is not in the map", () => {
    const orphan: string = wiz.patchConfigToml(shipped, {
      ...PATCH,
      users: new Map([["U0TEAM", "teammate"]]),
    });
    const live = orphan.replace(/^enabled = false/m, "enabled = true");
    expect(() => parseConfig(live)).toThrow(/must appear as a key in \[slack\.users\]/);
  });
});

describe("diffLines", () => {
  it("shows only the changed lines with context", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const after = "a\nb\nc\nD\ne\nf\ng\nh\n";
    const d = wiz.diffLines(before, after, 1);
    expect(d).toContain("- d");
    expect(d).toContain("+ D");
    expect(d).not.toContain("  a");
  });

  it("returns nothing when the texts are identical", () => {
    expect(wiz.diffLines("a\nb\n", "a\nb\n")).toBe("");
  });

  it("diffs the real patch down to a handful of lines", () => {
    const d = wiz.diffLines(shipped, wiz.patchConfigToml(shipped, PATCH), 2);
    expect(d).toMatch(/^\+ channel = "C0ABCDEFG"/m);
    expect(d.split("\n").filter((l) => l.startsWith("+")).length).toBeLessThanOrEqual(6);
    expect(d).not.toContain("daily_turns");
  });
});

describe("finalChecks", () => {
  const good = {
    channel: "C0ABCDEFG",
    channel_kind: "public",
    legacy_owner_slack_id: "U0OWNER",
    users: { U0OWNER: "mhale" },
    botTokenOk: true,
    appTokenOk: true,
  };

  it("passes when everything the daemon needs is in place", () => {
    expect(wiz.finalChecks(good).every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it("fails the identity check when legacy_owner_slack_id is not a key in the map", () => {
    const checks = wiz.finalChecks({ ...good, users: { U0OTHER: "x" } });
    const c = checks.find((x: { label: string }) => x.label.includes("key in [slack.users]"));
    expect(c!.ok).toBe(false);
    expect(c!.hint).toMatch(/own-PR rights/);
  });

  it("fails on an empty channel, a bad kind, or a missing token file", () => {
    const fails = (patch: Record<string, unknown>) =>
      wiz.finalChecks({ ...good, ...patch }).filter((c: { ok: boolean }) => !c.ok).length;
    expect(fails({ channel: "  " })).toBe(1);
    expect(fails({ channel_kind: "secret" })).toBe(1);
    expect(fails({ botTokenOk: false })).toBe(1);
    expect(fails({ appTokenOk: false })).toBe(1);
    expect(fails({ legacy_owner_slack_id: "" })).toBe(2); // empty AND not a key
  });
});
