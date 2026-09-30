import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMPROVEMENT_DENY_PREFIXES_DEFAULT,
  MODELS_TIER_DEFAULTS,
  expandHome,
  githubCloneDir,
  ingressHostnameFile,
  loadConfig,
  parseCaps,
  parseConfig,
  tierModel,
} from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// the suite parses the NEUTRAL FIXTURE, never the operator's live
// config (that lives in the install's config home now, out of reach).
const configPath = resolve(root, "tests/fixtures/config.toml");

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
    const off = readFileSync(configPath, "utf8").replace(
      /^expire_overdue_after_h.*$/m,
      "expire_overdue_after_h = 0",
    );
    expect(parseConfig(off).daemon.expire_overdue_after_h).toBe(0);
  });

  it("bounds pass milestones below the immutable command hard limit", () => {
    expect(cfg.daemon.round_first_pass_max_min).toBe(5);
    expect(cfg.daemon.round_passes_max_min).toBe(35);
    expect(cfg.daemon.round_finalize_grace_min).toBe(5);
    expect(cfg.daemon.posting_receipt_grace_s).toBe(120);
    const invalid = readFileSync(configPath, "utf8").replace(
      "round_passes_max_min = 35",
      "round_passes_max_min = 45",
    );
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
    const cfg2 = parseConfig(
      readFileSync(configPath, "utf8").replace("dry_run = true", "dry_run = false"),
    );
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
    expect(() => parseConfig(bad)).toThrowError(
      /\[ops\] timezone 'Mars\/Olympus_Mons' is not a valid IANA timezone/,
    );
  });
});

describe("[review]", () => {
  it("reads the fixture's escalation-mention fallback", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(cfg.review.escalation_mention_default).toBe("example-maintainer");
  });

  it("defaults to an empty mention when [review] is absent — older configs keep parsing", () => {
    const without = readFileSync(configPath, "utf8").replace(
      /\[review\][\s\S]*?(?=\n\[slack\])/,
      "",
    );
    const cfg = parseConfig(without);
    expect(cfg.review.escalation_mention_default).toBe("");
  });
});

describe("[review.directives] (directive-vocabulary extensions)", () => {
  it("defaults every extra list to empty — exactly today's vocabulary", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(cfg.review.directives).toEqual({
      extra_vendored_segments: [],
      extra_basenames: [],
      extra_dir_segments: [],
      extra_root_dirs: [],
      extra_files: [],
    });
  });

  it("a partial [review.directives] table extends without clobbering siblings", () => {
    const toml = readFileSync(configPath, "utf8").replace(
      /\[review\]/,
      '[review.directives]\nextra_basenames = ["COPILOT.md"]\n\n[review]',
    );
    const cfg = parseConfig(toml);
    expect(cfg.review.directives.extra_basenames).toEqual(["COPILOT.md"]);
    expect(cfg.review.directives.extra_dir_segments).toEqual([]);
    expect(cfg.review.escalation_mention_default).toBe("example-maintainer");
  });
});

describe("[github] base_branch + clone_dir", () => {
  it("reads the fixture's explicit base branch; clone_dir defaults empty", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(cfg.github.base_branch).toBe("main");
    expect(cfg.github.clone_dir).toBe("");
  });

  it("base_branch defaults to main when absent — older configs keep parsing", () => {
    const without = readFileSync(configPath, "utf8").replace(/^base_branch = .*$/m, "");
    expect(parseConfig(without).github.base_branch).toBe("main");
  });

  it("githubCloneDir derives from the repo slug's basename unless clone_dir is set", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(githubCloneDir(cfg.github)).toBe("example-app");
    expect(githubCloneDir({ ...cfg.github, repo: "acme/widget-app" })).toBe("widget-app");
    expect(githubCloneDir({ ...cfg.github, repo: "https://github.com/o/n.git" })).toBe("n");
    expect(githubCloneDir({ ...cfg.github, clone_dir: "elsewhere" })).toBe("elsewhere");
    expect(githubCloneDir({ ...cfg.github, repo: "" })).toBe("repo");
  });
});

describe("[caps] improvement_pr_deny_prefixes", () => {
  it("defaults to the shipped denylist when absent (the fixture omits it)", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(cfg.caps.improvement_pr_deny_prefixes).toEqual([...IMPROVEMENT_DENY_PREFIXES_DEFAULT]);
    expect(cfg.caps.improvement_pr_deny_prefixes).toEqual([
      "migrations/",
      "infra/",
      "ansible/",
      ".github/workflows/",
    ]);
  });

  it("a configured value replaces the list", () => {
    const toml = readFileSync(configPath, "utf8").replace(
      /issues_per_day = 3/,
      'issues_per_day = 3\nimprovement_pr_deny_prefixes = ["db/"]',
    );
    expect(parseConfig(toml).caps.improvement_pr_deny_prefixes).toEqual(["db/"]);
  });
});

// the section used to be spread through an `as` cast, so a missing
// or garbage cap parsed fine and reached `checkDiffstat` as undefined.
describe("[caps] every numeric cap is checked at parse time", () => {
  const base = readFileSync(configPath, "utf8");
  const ok = {
    improvement_pr_max_lines: 50,
    improvement_pr_max_files: 3,
    improvement_pr_per_day: 1,
    improvement_pr_per_week: 3,
    issues_per_day: 3,
  };

  it("parses the fixture's caps as numbers", () => {
    expect(parseConfig(base).caps).toEqual({
      ...ok,
      improvement_pr_deny_prefixes: [...IMPROVEMENT_DENY_PREFIXES_DEFAULT],
    });
  });

  it.each(Object.keys(ok))("refuses to load a config whose [caps] omits %s", (key) => {
    const without = base.replace(new RegExp(`^${key} = .*$`, "m"), "");
    expect(without).not.toContain(`${key} =`);
    expect(() => parseConfig(without)).toThrow(
      `[caps]: ${key} must be a non-negative number (got undefined)`,
    );
  });

  it("refuses a cap that is not a non-negative finite number", () => {
    for (const bad of ['"3"', "-1", "true", "nan", "inf"]) {
      const toml = base.replace(
        /^improvement_pr_max_files = 3$/m,
        `improvement_pr_max_files = ${bad}`,
      );
      expect(() => parseConfig(toml), bad).toThrow(
        "[caps]: improvement_pr_max_files must be a non-negative number",
      );
    }
    expect(() => parseCaps({ ...ok, improvement_pr_deny_prefixes: "db/" })).toThrow(
      "improvement_pr_deny_prefixes must be an array of strings",
    );
    expect(() => parseCaps({ ...ok, improvement_pr_deny_prefixes: [1] })).toThrow(
      "improvement_pr_deny_prefixes must be an array of strings",
    );
    expect(parseCaps(ok).improvement_pr_max_files).toBe(3);
  });
});

describe("[owner]", () => {
  it("reads the fixture's owner identity", () => {
    const cfg = parseConfig(readFileSync(configPath, "utf8"));
    expect(cfg.owner).toEqual({
      name: "Example Owner",
      slack_id: "",
      github_login: "example-owner",
    });
  });

  it("defaults every field when [owner] is absent — older configs keep parsing", () => {
    const without = readFileSync(configPath, "utf8").replace(
      /\[owner\][\s\S]*?(?=\n\[server\])/,
      "",
    );
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

  it("refuses a validate_tier outside the tier ladder (selfscan)", () => {
    const typo = readFileSync(configPath, "utf8").replace(
      /^validate_tier = .*$/m,
      'validate_tier = "sol-hig"',
    );
    expect(typo).toContain('validate_tier = "sol-hig"');
    expect(() => parseConfig(typo)).toThrow(/validate_tier/);
  });

  it("parses [models.pricing] entries keyed by bare model id", () => {
    const withPricing = readFileSync(configPath, "utf8").replace(
      "[models.pricing]",
      '[models.pricing]\n"gpt-5.6-sol" = { input_per_mtok = 1.25, output_per_mtok = 10.0 }',
    );
    const cfg2 = parseConfig(withPricing);
    expect(cfg2.models.pricing["gpt-5.6-sol"]).toEqual({
      input_per_mtok: 1.25,
      output_per_mtok: 10.0,
    });
  });

  it("tierModel resolves the full spec for a tier", () => {
    expect(tierModel(cfg, "terra-med")).toBe("openai-codex/gpt-5.6-terra:medium");
    expect(tierModel(cfg, "sol-high")).toBe("openai-codex/gpt-5.6-sol:high");
  });
});

describe("[ingress] (webhook-URL self-heal)", () => {
  const shipped = readFileSync(configPath, "utf8");

  it("defaults to shape 'none' when absent — no watcher ever starts", () => {
    const cfg = parseConfig(shipped);
    expect(cfg.ingress).toEqual({
      shape: "none",
      hostname_file: "",
      debounce_ms: 3000,
      sweep_interval_s: 300,
    });
  });

  it("parses the tunnel-file shape with its knobs", () => {
    const cfg = parseConfig(
      `${shipped}\n[ingress]\nshape = "tunnel-file"\nhostname_file = "/shared/hostname"\ndebounce_ms = 500\nsweep_interval_s = 60\n`,
    );
    expect(cfg.ingress).toEqual({
      shape: "tunnel-file",
      hostname_file: "/shared/hostname",
      debounce_ms: 500,
      sweep_interval_s: 60,
    });
    expect(ingressHostnameFile(cfg, "/root")).toBe("/shared/hostname");
  });

  it("defaults the hostname file under state/ when unset", () => {
    const cfg = parseConfig(`${shipped}\n[ingress]\nshape = "tunnel-file"\n`);
    expect(ingressHostnameFile(cfg, "/opt/quickreview/sandbox")).toBe(
      "/opt/quickreview/sandbox/state/ingress/hostname",
    );
  });

  it("rejects an unknown shape loudly at parse time", () => {
    expect(() => parseConfig(`${shipped}\n[ingress]\nshape = "carrier-pigeon"\n`)).toThrowError(
      /\[ingress\]: shape must be/,
    );
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

// ---- the tracked configs — both parse and validate ------
//
// This block used to read the LIVE config.toml and pin its production
// invariants (parses, dry_run = false, the deployment's explicit base branch /
// clone / denylist). `qcr install migrate` moved that file into the install's
// config home, where no test can — or may — read it, so the block
// skipped on every run. What a tracked file can carry is asserted here; what
// only the live file can carry is the operator's: deploy.sh's preflight reads
// it through the install locator (its pin checks refuse on drift, and its plan
// SHOWS the dry_run flag it ships — never changes it, rule 1).
describe("the tracked configs (fixture + example)", () => {
  for (const rel of ["tests/fixtures/config.toml", "config.example.toml"]) {
    it(`${rel} parses and passes full config validation`, () => {
      expect(() => loadConfig(resolve(root, rel))).not.toThrow();
    });
  }

  it("the fixture every test parses is dry-run — a test config never mutates GitHub", () => {
    expect(loadConfig(configPath).dry_run).toBe(true);
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
