import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, loadConfig, modelForPass, parseConfig } from "../src/config.js";

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
    expect(cfg.github.escalation_reviewer).toBe("mhale");
    expect(cfg.server.port).toBe(8787);
    expect(cfg.daemon.poll_interval_s).toBeGreaterThan(0);
    expect(cfg.eod.time).toBe("18:00");
    expect(cfg.eod.timezone).toBe("Europe/Warsaw");
    expect(cfg.caps.improvement_pr_max_lines).toBe(50);
    expect(cfg.pi.session_dir).toBeTruthy();
  });

  it("defaults dry_run to on in the shipped config", () => {
    expect(cfg.dry_run).toBe(true);
  });

  it("expands secrets_dir to an absolute path", () => {
    expect(cfg.github.secrets_dir.startsWith("~")).toBe(false);
    expect(cfg.github.secrets_dir).toBe(resolve(homedir(), ".config/quickreview-bot"));
  });

  it("throws with the key name on a missing top-level section", () => {
    expect(() => parseConfig("dry_run = true\n")).toThrowError(/missing key 'github'/);
  });

  it("throws on a missing github key", () => {
    const trimmed = readFileSync(configPath, "utf8").replace(/^escalation_reviewer.*$/m, "");
    expect(() => parseConfig(trimmed)).toThrowError(/missing key 'escalation_reviewer'/);
  });

  it("coerces dry_run to a boolean", () => {
    const cfg2 = parseConfig(readFileSync(configPath, "utf8").replace("dry_run = true", "dry_run = false"));
    expect(cfg2.dry_run).toBe(false);
  });
});

describe("loadConfig / modelForPass", () => {
  it("loads from an explicit path without poisoning the module cache", () => {
    const a = loadConfig(configPath);
    const b = loadConfig(configPath);
    expect(a).not.toBe(b);
    expect(a.github.repo).toBe(b.github.repo);
  });

  it("falls back to the default model when no per-pass override exists", () => {
    const cfg = loadConfig(configPath);
    // Every real pass carries an override in config.toml now, so probe the
    // fallback with a pass name that has none.
    delete cfg.models.passes["pass-baseline"];
    expect(modelForPass(cfg, "pass-baseline")).toBe(cfg.models.default);
    cfg.models.passes["pass-security"] = "openai/gpt-5.6-terra";
    expect(modelForPass(cfg, "pass-security")).toBe("openai/gpt-5.6-terra");
  });
});
