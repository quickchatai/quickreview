import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS_TIER_DEFAULTS, expandHome, loadConfig, parseConfig, tierModel } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "config.toml");

describe("expandHome", () => {
  it("expands a leading ~/ and leaves other paths alone", () => {
    expect(expandHome("~/x/y")).toBe(resolve(homedir(), "x/y"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("rel/path")).toBe("rel/path");
  });
});

describe("parseConfig", () => {
  const cfg = parseConfig(readFileSync(configPath, "utf8"));

  it("reads the shipped config.toml knob set", () => {
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

  it("ships dry_run off — the cutover flag (flipped by the owner, 2026-08-14)", () => {
    expect(cfg.dry_run).toBe(false);
  });

  it("expands secrets_dir to an absolute path", () => {
    expect(cfg.github.secrets_dir.startsWith("~")).toBe(false);
    expect(cfg.github.secrets_dir).toBe(resolve(homedir(), ".config/quickreview-bot"));
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
