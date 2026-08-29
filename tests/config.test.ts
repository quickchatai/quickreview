import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS_TIER_DEFAULTS, expandHome, loadConfig, parseConfig, tierModel } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// the suite parses the NEUTRAL FIXTURE, not the operator's live
// config — editing identities in config.toml must never redden a test. The
// live file is read only by the "live config.toml" block at the bottom, which
// pins production invariants (rule 1) rather than identity values.
const configPath = resolve(root, "tests/fixtures/config.toml");
const liveConfigPath = resolve(root, "config.toml");

describe("expandHome", () => {
  it("expands a leading ~/ and leaves other paths alone", () => {
    expect(expandHome("~/x/y")).toBe(resolve(homedir(), "x/y"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("rel/path")).toBe("rel/path");
  });
});

describe("parseConfig", () => {
  const cfg = parseConfig(readFileSync(configPath, "utf8"));

  it("reads the fixture config knob set", () => {
    expect(cfg.github.repo).toBe("example-org/example-app");
    expect(cfg.github.app_slug).toBe("example-review");
    expect(cfg.github.bot_login).toBe("example-review[bot]");
    expect(cfg.github.review_team).toBe("example-org/review");
    // escalation_reviewer was removed on 2026-08-18: the daemon never
    // nominates a reviewer, so there is no reviewer to name.
    expect((cfg.github as unknown as Record<string, unknown>).escalation_reviewer).toBeUndefined();
    expect(cfg.server.port).toBe(8787);
    expect(cfg.daemon.poll_interval_s).toBeGreaterThan(0);
    expect(cfg.eod.time).toBe("18:00");
    expect(cfg.eod.timezone).toBe("Europe/Warsaw");
    expect(cfg.caps.improvement_pr_max_lines).toBe(50);
    expect(cfg.pi.session_dir).toBeTruthy();
  });

  it("the fixture keeps dry_run ON — tests never model the live posture", () => {
    expect(cfg.dry_run).toBe(true);
  });

  it("zombie-round expiry horizon: shipped value, and a default for older configs", () => {
    expect(cfg.daemon.expire_overdue_after_h).toBe(24);
    const older = readFileSync(configPath, "utf8").replace(/^expire_overdue_after_h.*$/m, "");
    expect(parseConfig(older).daemon.expire_overdue_after_h).toBe(24);
    const off = readFileSync(configPath, "utf8").replace(/^expire_overdue_after_h.*$/m, "expire_overdue_after_h = 0");
    expect(parseConfig(off).daemon.expire_overdue_after_h).toBe(0);
  });

  it("bounds pass milestones below the immutable command hard limit", () => {
    expect(cfg.daemon.round_first_pass_max_min).toBe(5);
    expect(cfg.daemon.round_passes_max_min).toBe(35);
    expect(cfg.daemon.round_finalize_grace_min).toBe(5);
    expect(cfg.daemon.posting_receipt_grace_s).toBe(120);
    const invalid = readFileSync(configPath, "utf8").replace("round_passes_max_min = 35", "round_passes_max_min = 45");
    expect(() => parseConfig(invalid)).toThrow(/round_first_pass_max_min/);
  });

  it("expands secrets_dir to an absolute path", () => {
    expect(cfg.github.secrets_dir.startsWith("~")).toBe(false);
    expect(cfg.github.secrets_dir).toBe(resolve(homedir(), ".config/example-review-bot"));
  });

  it("throws with the key name on a missing top-level section", () => {
    expect(() => parseConfig("dry_run = true\n")).toThrowError(/missing key 'github'/);
  });

  it("throws on a missing github key", () => {
    const trimmed = readFileSync(configPath, "utf8").replace(/^issue_label.*$/m, "");
    expect(() => parseConfig(trimmed)).toThrowError(/missing key 'issue_label'/);
  });

  it("coerces dry_run to a boolean", () => {
    const cfg2 = parseConfig(readFileSync(configPath, "utf8").replace("dry_run = true", "dry_run = false"));
    expect(cfg2.dry_run).toBe(false);
  });
});

// ---- [ops] timezone — the operations-day knob --------------------
describe("[ops] timezone", () => {
  const shipped = readFileSync(configPath, "utf8");
  // The fixture's [ops] block, for surgical splicing below.
  const OPS_WARSAW = '[ops]\ntimezone = "Europe/Warsaw"';

  it("reads the fixture knob", () => {
    expect(parseConfig(shipped).ops.timezone).toBe("Europe/Warsaw");
  });

  it("defaults to UTC when [ops] is absent — older configs keep parsing", () => {
    const without = shipped.replace(OPS_WARSAW, "");
    expect(parseConfig(without).ops.timezone).toBe("UTC");
  });

  it("[eod] and [slack.policy] default from [ops] when their own timezone is unset", () => {
    const derived = shipped
      .replace(OPS_WARSAW, '[ops]\ntimezone = "America/New_York"')
      .replace('time = "18:00"\ntimezone = "Europe/Warsaw"', 'time = "18:00"')
      .replace(/^timezone = "Europe\/Warsaw" +# the day boundary.*$/m, "");
    const cfg = parseConfig(derived);
    expect(cfg.ops.timezone).toBe("America/New_York");
    expect(cfg.eod.timezone).toBe("America/New_York");
    expect(cfg.slack.policy.timezone).toBe("America/New_York");
  });

  it("an explicit per-section timezone still wins over [ops]", () => {
    const cfg = parseConfig(shipped.replace(OPS_WARSAW, '[ops]\ntimezone = "America/New_York"'));
    expect(cfg.ops.timezone).toBe("America/New_York");
    // The fixture sets both sections explicitly — they keep their own zone.
    expect(cfg.eod.timezone).toBe("Europe/Warsaw");
    expect(cfg.slack.policy.timezone).toBe("Europe/Warsaw");
  });

  it("rejects a zone Intl does not know — same check the EOD formatter would hit at 18:00", () => {
    const bad = shipped.replace(OPS_WARSAW, '[ops]\ntimezone = "Mars/Olympus_Mons"');
    expect(() => parseConfig(bad)).toThrowError(/\[ops\] timezone 'Mars\/Olympus_Mons' is not a valid IANA timezone/);
  });
});

describe("[review]", () => {
  it("reads the fixture's escalation-mention fallback", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(cfg.review.escalation_mention_default).toBe("example-maintainer");
  });

  it("defaults to an empty mention when [review] is absent — older configs keep parsing", () => {
    const without = readFileSync(configPath, "utf8").replace(/\[review\][\s\S]*?(?=\n\[slack\])/, "");
    const cfg = parseConfig(without);
    expect(cfg.review.escalation_mention_default).toBe("");
  });
});

describe("[owner]", () => {
  it("reads the fixture's owner identity", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(cfg.owner).toEqual({ name: "Example Owner", slack_id: "", github_login: "example-owner" });
  });

  it("defaults every field when [owner] is absent — older configs keep parsing", () => {
    const without = readFileSync(configPath, "utf8").replace(/\[owner\][\s\S]*?(?=\n\[server\])/, "");
    const cfg = parseConfig(without);
    expect(cfg.owner).toEqual({ name: "", slack_id: "", github_login: "" });
  });
});

describe("[models] tiered pass scheme", () => {
  const cfg = parseConfig(readFileSync(configPath, "utf8"));

  it("reads the shipped tier map, risk passes, validate tier, and diff knob", () => {
    expect(cfg.models.tiers).toEqual({
      "terra-med": "openai-codex/gpt-5.6-terra:medium",
      "sol-med": "openai-codex/gpt-5.6-sol:medium",
      "sol-high": "openai-codex/gpt-5.6-sol:high",
    });
    expect(cfg.models.risk_passes).toEqual(["pass-security", "pass-prod-risk", "pass-data-safety"]);
    // the validator's floor is pinned at the top tier — it vetoes
    // sol-high findings, so it may never run below them.
    expect(cfg.models.validate_tier).toBe("sol-high");
    expect(cfg.models.small_diff_lines).toBe(150);
  });

  it("defaults every tiered knob when [models] carries only the role models", () => {
    const minimal = readFileSync(configPath, "utf8").replace(
      /\[models\][\s\S]*?(?=\n\[tui\])/,
      '[models]\ndefault = "openai-codex/gpt-5.6-sol"\nconversation = "openai-codex/gpt-5.6-sol"\noverseer = "openai-codex/gpt-5.6-sol"\n',
    );
    const cfg2 = parseConfig(minimal);
    expect(cfg2.models.tiers).toEqual(MODELS_TIER_DEFAULTS.tiers);
    expect(cfg2.models.risk_passes).toEqual(MODELS_TIER_DEFAULTS.risk_passes);
    expect(cfg2.models.validate_tier).toBe("sol-high");
    expect(cfg2.models.small_diff_lines).toBe(150);
    expect(cfg2.models.pricing).toEqual({});
  });

  it("parses [models.pricing] entries keyed by bare model id", () => {
    const withPricing = readFileSync(configPath, "utf8").replace(
      "[models.pricing]",
      '[models.pricing]\n"gpt-5.6-sol" = { input_per_mtok = 1.25, output_per_mtok = 10.0 }',
    );
    const cfg2 = parseConfig(withPricing);
    expect(cfg2.models.pricing["gpt-5.6-sol"]).toEqual({ input_per_mtok: 1.25, output_per_mtok: 10.0 });
  });

  it("tierModel resolves the full spec for a tier", () => {
    expect(tierModel(cfg, "terra-med")).toBe("openai-codex/gpt-5.6-terra:medium");
    expect(tierModel(cfg, "sol-high")).toBe("openai-codex/gpt-5.6-sol:high");
  });
});

describe("loadConfig", () => {
  it("loads from an explicit path without poisoning the module cache", () => {
    const a = loadConfig(configPath);
    const b = loadConfig(configPath);
    expect(a).not.toBe(b);
    expect(a.github.repo).toBe(b.github.repo);
  });
});

// ---- the LIVE config.toml — production invariants only ----------
//
// Deliberately the only place in this file that reads the committed
// config.toml. It pins what must hold in PRODUCTION regardless of the
// operator's identity values: the file stays parseable/valid, and dry_run
// stays false (rule 1 — LIVE since the 2026-08-14 cutover; the flag is
// the owner's alone). Identity assertions live on the fixture above, so an
// adopter editing repo/app/team/ssh values never reddens the suite.
describe("live config.toml (production invariants)", () => {
  it("parses and passes full config validation", () => {
    expect(() => loadConfig(liveConfigPath)).not.toThrow();
  });

  it("keeps dry_run false — the cutover flag (rule 1, the owner's alone)", () => {
    expect(loadConfig(liveConfigPath).dry_run).toBe(false);
  });
});

// ---- config.example.toml — the new-operator template ------------
describe("config.example.toml", () => {
  const examplePath = resolve(root, "config.example.toml");

  it("parses and passes the same full validation as the live config", () => {
    const cfg = loadConfig(examplePath);
    expect(cfg.dry_run).toBe(true); // safe default: a fresh install never mutates GitHub
    expect(cfg.slack.enabled).toBe(false); // enabling Slack is a deliberate act
    expect(cfg.server.port).toBe(8787);
  });

  it("ships empty identities for the values an operator must fill", () => {
    const cfg = loadConfig(examplePath);
    for (const key of ["repo", "app_slug", "bot_login", "review_team"] as const) {
      expect(cfg.github[key], `github.${key} must be a fill-me placeholder`).toBe("");
    }
  });
});
