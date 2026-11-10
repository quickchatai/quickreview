import { describe, expect, it, vi } from "vitest";
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
  webhooksEnabled,
  loadConfig,
  parseCaps,
  parseConfig,
  tierModel,
} from "../src/config.js";
import { tuiMemoryContainer } from "../src/tui/memforward.js";
import {
  isModelSpec,
  isPinned,
  parseCoreConfig,
  parseModels,
  splitModelSpec,
  stripPins,
  tierSpec,
  TIER_LEVELS,
  withSecurityFamily,
  withThinking,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { PASS_TIER_ORDER } from "@quickchatai/pi-quickreview/src/types.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The suite parses the neutral fixture, never the operator's live config
// (that lives in the install's config home, out of reach).
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
    // There is no escalation_reviewer key: the daemon never nominates a
    // reviewer through it, so there is no reviewer to name.
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

  it("refuses a non-finite or non-numeric stage bound, which the ordering alone would pass", () => {
    const shipped = readFileSync(configPath, "utf8");
    for (const [from, to] of [
      ["session_command_running_max_min = 45", "session_command_running_max_min = inf"],
      ["session_command_running_max_min = 45", 'session_command_running_max_min = "60"'],
      ["round_finalize_grace_min = 5", 'round_finalize_grace_min = "5"'],
    ] as const) {
      const bad = shipped.replace(from, to);
      expect(bad, to).not.toBe(shipped);
      expect(() => parseConfig(bad), to).toThrow(/require finite numbers/);
    }
  });

  it("refuses a non-finite, non-numeric or non-positive start lease or bridge-ready timeout", () => {
    const shipped = readFileSync(configPath, "utf8");
    const shipping = {
      session_command_start_lease_s: "session_command_start_lease_s = 120",
      session_bridge_ready_timeout_s: "session_bridge_ready_timeout_s = 30",
    } as const;
    for (const [key, line] of Object.entries(shipping))
      for (const value of ["inf", '"120"', "0", "-5"]) {
        const bad = shipped.replace(line, `${key} = ${value}`);
        expect(bad).not.toBe(shipped);
        expect(() => parseConfig(bad), `${key} = ${value}`).toThrow(
          new RegExp(`require a finite number \\[daemon\\] ${key} > 0`),
        );
      }
  });

  it("the posted-tail grace defaults to 15 minutes and must be positive", () => {
    expect(cfg.daemon.round_posted_tail_grace_min).toBe(15);
    const set = (line: string) =>
      readFileSync(configPath, "utf8").replace(/^\[daemon\]$/m, `[daemon]\n${line}`);
    expect(
      parseConfig(set("round_posted_tail_grace_min = 20")).daemon.round_posted_tail_grace_min,
    ).toBe(20);
    expect(() => parseConfig(set("round_posted_tail_grace_min = 0"))).toThrow(
      /round_posted_tail_grace_min/,
    );
  });

  it("the compaction hold on a start lease defaults to 600 s and must be positive", () => {
    expect(cfg.daemon.session_compaction_max_s).toBe(600);
    const set = (line: string) =>
      readFileSync(configPath, "utf8").replace(/^\[daemon\]$/m, `[daemon]\n${line}`);
    expect(parseConfig(set("session_compaction_max_s = 300")).daemon.session_compaction_max_s).toBe(
      300,
    );
    expect(() => parseConfig(set("session_compaction_max_s = 0"))).toThrow(
      /session_compaction_max_s/,
    );
  });

  it("the lens permit ceiling defaults to 20 with a 250 ms grant stagger, and both are checked", () => {
    expect(cfg.daemon.lens_permits).toBe(20);
    expect(cfg.daemon.lens_grant_stagger_ms).toBe(250);
    const set = (line: string) =>
      readFileSync(configPath, "utf8").replace(/^\[daemon\]$/m, `[daemon]\n${line}`);
    expect(parseConfig(set("lens_permits = 12")).daemon.lens_permits).toBe(12);
    expect(parseConfig(set("lens_grant_stagger_ms = 0")).daemon.lens_grant_stagger_ms).toBe(0);
    for (const bad of ["lens_permits = 0", "lens_permits = 2.5", 'lens_permits = "20"'])
      expect(() => parseConfig(set(bad)), bad).toThrow(/lens_permits/);
    for (const bad of ["lens_grant_stagger_ms = -1", 'lens_grant_stagger_ms = "250"'])
      expect(() => parseConfig(set(bad)), bad).toThrow(/lens_grant_stagger_ms/);
  });

  it("the idle-PR answer worker's caps default to 600 s and $2, and are checked", () => {
    expect(cfg.daemon.answer_timeout_s).toBe(600);
    expect(cfg.daemon.answer_cap_usd).toBe(2);
    const set = (line: string) =>
      readFileSync(configPath, "utf8").replace(/^\[daemon\]$/m, `[daemon]\n${line}`);
    expect(parseConfig(set("answer_timeout_s = 120")).daemon.answer_timeout_s).toBe(120);
    expect(parseConfig(set("answer_cap_usd = 0.5")).daemon.answer_cap_usd).toBe(0.5);
    for (const bad of ["answer_timeout_s = 0", "answer_timeout_s = -5", 'answer_timeout_s = "600"'])
      expect(() => parseConfig(set(bad)), bad).toThrow(/answer_timeout_s/);
    for (const bad of ["answer_cap_usd = 0", 'answer_cap_usd = "2"'])
      expect(() => parseConfig(set(bad)), bad).toThrow(/answer_cap_usd/);
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

// ---- [ops] timezone — the operations-day knob ------------------------------
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

  it("rejects an [eod] or (live) [slack.policy] override Intl does not know, as it does [ops]", () => {
    const badEod = shipped.replace(
      'time = "18:00"\ntimezone = "Europe/Warsaw"',
      'time = "18:00"\ntimezone = "Mars/Olympus_Mons"',
    );
    expect(badEod).not.toBe(shipped);
    expect(() => parseConfig(badEod)).toThrowError(
      /\[eod\] timezone 'Mars\/Olympus_Mons' is not a valid IANA timezone/,
    );
    const badSlack = shipped.replace(
      /^timezone = "Europe\/Warsaw"( +# the day boundary.*)$/m,
      'timezone = "Mars/Olympus_Mons"$1',
    );
    expect(badSlack).not.toBe(shipped);
    // A switched-off concierge is a draft: nothing reads its clock.
    expect(parseConfig(badSlack).slack.policy.timezone).toBe("Mars/Olympus_Mons");
    const live = badSlack.replace(
      /^\[slack\]\n((?:#.*\n)*)enabled = false/m,
      "[slack]\n$1enabled = true",
    );
    expect(live).not.toBe(badSlack);
    expect(() => parseConfig(live)).toThrowError(
      /\[slack\.policy\] timezone 'Mars\/Olympus_Mons' is not a valid IANA timezone/,
    );
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
    expect(githubCloneDir({ ...cfg.github, repo: "https://github.com/o/n.git/" })).toBe("n");
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

// Every cap is validated when parsed: spreading the section through an `as`
// cast would let a missing or garbage cap reach `checkDiffstat` as undefined.
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
      light: "openai-codex/gpt-5.6-terra:medium",
      standard: "openai-codex/gpt-5.6-sol:medium",
      deep: "openai-codex/gpt-5.6-sol:high",
    });
    // The configured list, then the security family: a family lens always
    // runs at the risk tier, whatever the list says.
    expect(cfg.models.risk_passes).toEqual([
      "pass-security",
      "pass-prod-risk",
      "pass-data-safety",
      ...SECURITY_FAMILY,
    ]);
    // The fixture runs the validator at the top tier.
    expect(cfg.models.validate_tier).toBe("deep");
    expect(cfg.models.small_diff_lines).toBe(150);
  });

  it("defaults every tiered knob when [models] carries only the role models", () => {
    const minimal = readFileSync(configPath, "utf8").replace(
      /\[models\][\s\S]*?(?=\n\[tui\])/,
      '[models]\ndefault = "openai-codex/gpt-5.6-sol"\nconversation = "openai-codex/gpt-5.6-sol"\noverseer = "openai-codex/gpt-5.6-sol"\n',
    );
    const cfg2 = parseConfig(minimal);
    expect(cfg2.models.tiers).toEqual(MODELS_TIER_DEFAULTS.tiers);
    expect(cfg2.models.risk_passes).toEqual(withSecurityFamily(MODELS_TIER_DEFAULTS.risk_passes));
    expect(cfg2.models.validate_tier).toBe("deep");
    expect(cfg2.models.small_diff_lines).toBe(150);
    expect(cfg2.models.pricing).toEqual({});
  });

  // MUTATION: restore `String(req(raw, "conversation"))` in parseModels — a
  // [models] with no model key is `missing key` and this fails.
  it("a [models] that names no model pins none: every knob defaults, the model is empty", () => {
    const bare = readFileSync(configPath, "utf8").replace(
      /\[models\][\s\S]*?(?=\n\[tui\])/,
      "[models]\n",
    );
    for (const parse of [parseConfig, parseCoreConfig]) {
      const m = parse(bare).models;
      expect(m.model).toBe("");
      expect(m.tiers).toEqual(MODELS_TIER_DEFAULTS.tiers);
      expect(m.validate_tier).toBe("deep");
      expect(m.pass_models).toEqual({});
    }
  });

  // MUTATION: restore `req(raw, "models")` in parseCoreConfig or in
  // parseConfig — a config with no [models] section is `missing key 'models'`
  // in that parser, and this fails.
  it("a config with no [models] section at all pins nothing, in both parsers", () => {
    const none = readFileSync(configPath, "utf8").replace(/\[models\][\s\S]*?(?=\n\[tui\])/, "");
    expect(none).not.toMatch(/^\[models/m);
    for (const parse of [parseConfig, parseCoreConfig]) {
      const m = parse(none).models;
      expect(m.model).toBe("");
      expect(m.tiers).toEqual(MODELS_TIER_DEFAULTS.tiers);
      expect(Object.values(m.tiers).some(isPinned)).toBe(false);
      expect(m.risk_passes).toEqual(withSecurityFamily(MODELS_TIER_DEFAULTS.risk_passes));
      expect(m.validate_tier).toBe("deep");
      expect(m.small_diff_lines).toBe(150);
      expect(m.pass_models).toEqual({});
    }
    // A `models` that is no table is not an absent one.
    for (const parse of [parseConfig, parseCoreConfig])
      expect(() => parse(`models = "prov/model-a"\n${none}`)).toThrow(/\[models\] must be a table/);
  });

  // The shipped defaults name no model: each tier is the run's route at its
  // level. A [models.tiers] entry is laid over them key by key.
  // MUTATION: put a `provider/id` back into MODELS_TIER_DEFAULTS.tiers — this fails.
  it("the default tiers pin no model and carry the tier levels", () => {
    expect(MODELS_TIER_DEFAULTS.tiers).toEqual({
      light: `:${TIER_LEVELS.light}`,
      standard: `:${TIER_LEVELS.standard}`,
      deep: `:${TIER_LEVELS.deep}`,
    });
    expect(MODELS_TIER_DEFAULTS.tiers).toEqual({
      light: ":medium",
      standard: ":medium",
      deep: ":high",
    });
    const one = parseModels({ tiers: { deep: "prov/model-a:xhigh" } });
    expect(one.tiers).toEqual({
      light: ":medium",
      standard: ":medium",
      deep: "prov/model-a:xhigh",
    });
    expect(one.model).toBe("");
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
    expect(tierModel(cfg, "light")).toBe("openai-codex/gpt-5.6-terra:medium");
    expect(tierModel(cfg, "deep")).toBe("openai-codex/gpt-5.6-sol:high");
  });
});

describe("[models] model and the model spec grammar", () => {
  const [BASE, ADD, RISK] = PASS_TIER_ORDER;
  const SHAPE = 'must be "provider/model" with an optional ":<thinking level>"';

  it("a spec is [provider/model][:level]: the model part may be empty", () => {
    expect(splitModelSpec("prov/m:high")).toEqual({ model: "prov/m", thinking: "high" });
    expect(splitModelSpec("prov/m")).toEqual({ model: "prov/m", thinking: null });
    // MUTATION: put `(.+)` back in splitModelSpec's pattern — ":high" is a
    // model named ":high" and this fails.
    expect(splitModelSpec(":high")).toEqual({ model: "", thinking: "high" });
    expect(splitModelSpec("")).toEqual({ model: "", thinking: null });
    // Only a thinking level is a suffix: any other tail is the id's own.
    expect(splitModelSpec("prov/m:v2")).toEqual({ model: "prov/m:v2", thinking: null });
    expect(splitModelSpec(":v2")).toEqual({ model: ":v2", thinking: null });
    expect(["prov/m:high", "prov/m", ":high", ""].map(isPinned)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // An unpinned spec stays unpinned under a new level.
    expect(withThinking("", "high")).toBe(":high");
    expect(withThinking(":medium", "low")).toBe(":low");
  });

  it("[models] model is the pin, as written, with its level", () => {
    expect(parseModels({ model: "prov/m:high" }).model).toBe("prov/m:high");
    expect(parseModels({ model: "prov/m" }).model).toBe("prov/m");
    expect(parseModels({ model: "" }).model).toBe("");
    expect(parseModels({}).model).toBe("");
  });

  // MUTATION: check `model` with the old pass_models pattern
  // (`/^[\w.-]+\/[\w.:-]+$/`) — the three ids below are refused and this fails.
  it("a model id keeps its own slashes and its @, as pi's ids have them", () => {
    for (const id of [
      "openrouter/moonshotai/kimi-k2.6",
      "fireworks/accounts/fireworks/models/kimi-k3",
      "cloudflare-workers-ai/@cf/meta/llama-4",
    ]) {
      expect(parseModels({ model: id }).model).toBe(id);
      expect(parseModels({ model: `${id}:high` }).model).toBe(`${id}:high`);
      expect(parseModels({ tiers: { deep: `${id}:high` } }).tiers[RISK]).toBe(`${id}:high`);
    }
  });

  it.each([
    ["a bare id", "gpt-x"],
    ["a bare id with a level", "gpt-x:high"],
    ["a level and no model", ":high"],
    ["a provider and no id", "prov/"],
    ["an id and no provider", "/m"],
    ["a number", 5],
    ["a table", { id: "prov/m" }],
  ])("[models] model refuses %s", (_what, value) => {
    expect(() => parseModels({ model: value })).toThrow(
      `config.toml [models] model ${SHAPE} (got ${JSON.stringify(value)})`,
    );
  });

  // MUTATION: drop the isModelSpec check from parseTierSpecs — a tier with a
  // bare id loads and this fails.
  it("[models.tiers]: a value pins a provider's model or none, and the key is named as written", () => {
    // No model part: the tier runs on the run's route, at that level.
    const unpinned = parseModels({ tiers: { light: ":low", deep: "" } }).tiers;
    expect(unpinned[BASE]).toBe(":low");
    expect(unpinned[RISK]).toBe("");
    expect(unpinned[ADD]).toBe(MODELS_TIER_DEFAULTS.tiers[ADD]);
    expect(() => parseModels({ tiers: { deep: "gpt-x:high" } })).toThrow(
      `config.toml [models.tiers] deep ${SHAPE} (got "gpt-x:high")`,
    );
    expect(() => parseModels({ tiers: { "sol-high": "gpt-x" } })).toThrow(
      `config.toml [models.tiers] sol-high ${SHAPE} (got "gpt-x")`,
    );
    expect(() => parseModels({ tiers: { standard: 7 } })).toThrow(
      `config.toml [models.tiers] standard ${SHAPE} (got 7)`,
    );
    // A key that is no tier is left out before its value is read.
    expect(parseModels({ tiers: { "sol-ultra": "gpt-x" } }).tiers).toEqual(
      MODELS_TIER_DEFAULTS.tiers,
    );
  });

  it("isModelSpec: which spec with no model part counts depends on the place", () => {
    const bare = (v: unknown) =>
      (["whole", "any", "level"] as const).map((place) => isModelSpec(v, place));
    expect(bare("prov/m:high")).toEqual([true, true, true]);
    expect(bare("")).toEqual([true, true, false]);
    expect(bare(":high")).toEqual([false, true, true]);
    expect(bare("gpt-x")).toEqual([false, false, false]);
    expect(bare(undefined)).toEqual([false, false, false]);
  });

  it("[models] effort sets the level of an unpinned spec too", () => {
    const m = parseModels({ effort: "high", tiers: { light: ":low" } });
    expect(m.model).toBe(":max");
    expect(m.tiers[BASE]).toBe(":max");
    expect(isPinned(m.model)).toBe(false);
  });

  it("TIER_LEVELS names a level for every tier of the ladder", () => {
    expect(TIER_LEVELS).toEqual({ [BASE]: "medium", [ADD]: "medium", [RISK]: "high" });
  });

  describe("tierSpec: the literal spec a tier runs on", () => {
    const route = { spec: "routed/model" };
    const cfg = (tiers: Record<string, string>) => ({ models: parseModels({ tiers }) });

    it("a pinned tier is its own spec, whatever the route", () => {
      const pinned = cfg({ light: "prov/a:low", standard: "prov/b", deep: "prov/c:high" });
      expect(tierSpec(route, pinned, BASE)).toBe("prov/a:low");
      expect(tierSpec(route, pinned, ADD)).toBe("prov/b");
      expect(tierSpec(route, pinned, RISK)).toBe("prov/c:high");
    });

    // MUTATION: return the tier's own spec for an unpinned tier too — a
    // child pi is started on `--model :low` and this fails.
    it("an unpinned tier is the route's model at the tier's level", () => {
      const unpinned = cfg({ light: ":low", standard: "", deep: ":xhigh" });
      expect(tierSpec(route, unpinned, BASE)).toBe("routed/model:low");
      // No level of its own: the tier's.
      expect(tierSpec(route, unpinned, ADD)).toBe(`routed/model:${TIER_LEVELS[ADD]}`);
      expect(tierSpec(route, unpinned, RISK)).toBe("routed/model:xhigh");
    });
  });

  describe("stripPins: a run's one model replaces every pin below it", () => {
    const pinned = {
      models: {
        ...parseModels({
          model: "prov/main:high",
          tiers: { light: "prov/a:low", standard: "prov/b", deep: ":high" },
        }),
        pass_models: {
          "pass-style": "prov/small:low",
          "pass-ui": "prov/small",
          "pass-docs": ":low",
        },
      },
    };

    // MUTATION: keep a tier's model part in stripPins — this fails.
    it("each pinned tier and lens override loses its model and keeps its level", () => {
      const { cfg, replaced } = stripPins(pinned);
      expect(cfg.models.tiers).toEqual({
        [BASE]: ":low",
        // It named no level: the tier's own.
        [ADD]: `:${TIER_LEVELS[ADD]}`,
        [RISK]: ":high",
      });
      // An override that named no level says nothing without its model.
      expect(cfg.models.pass_models).toEqual({ "pass-style": ":low", "pass-docs": ":low" });
      // light, standard, pass-style, pass-ui: the specs that named a model.
      expect(replaced).toBe(4);
      expect(Object.values(cfg.models.tiers).some(isPinned)).toBe(false);
      expect(Object.values(cfg.models.pass_models).some(isPinned)).toBe(false);
    });

    it("the review's own model and the input are left as they were", () => {
      const before = structuredClone(pinned);
      const { cfg } = stripPins(pinned);
      expect(cfg.models.model).toBe("prov/main:high");
      expect(pinned).toEqual(before);
    });

    it("a config that pins nothing below its model is unchanged, and counts none", () => {
      const once = stripPins(pinned).cfg;
      expect(stripPins(once)).toEqual({ cfg: once, replaced: 0 });
    });
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

  it("parses the polling shape: no webhooks at all", () => {
    const cfg = parseConfig(`${shipped}\n[ingress]\nshape = "polling"\n`);
    expect(cfg.ingress.shape).toBe("polling");
    expect(webhooksEnabled(cfg)).toBe(false);
    expect(webhooksEnabled(parseConfig(shipped))).toBe(true);
  });
});

describe("[github] auth (the App, or the person's own credential)", () => {
  const shipped = readFileSync(configPath, "utf8");
  const user = (rest = '\n[ingress]\nshape = "polling"\n') =>
    `${shipped.replace("[github]\n", '[github]\nauth = "user"\n')}${rest}`;

  it("defaults to app: a missing key means the App", () => {
    expect(parseConfig(shipped).github.auth).toBe("app");
  });

  it('parses auth = "user" with the polling shape, an empty app_slug allowed', () => {
    const cfg = parseConfig(user().replace(/^app_slug = .*$/m, 'app_slug = ""'));
    expect(cfg.github.auth).toBe("user");
    expect(cfg.github.app_slug).toBe("");
  });

  it("lets a user-mode config leave app_slug out entirely", () => {
    const text = user().replace(/^app_slug = .*$/m, "");
    expect(parseConfig(text).github.app_slug).toBe("");
  });

  it('refuses auth = "user" with any shape but polling, saying what to set', () => {
    // MUTATION: drop the user-mode shape check in parseConfig — this fails.
    for (const rest of [
      "",
      '\n[ingress]\nshape = "none"\n',
      '\n[ingress]\nshape = "tunnel-file"\n',
    ])
      expect(() => parseConfig(user(rest))).toThrowError(
        /auth = "user" runs polling-only — set \[ingress\] shape = "polling"/,
      );
  });

  it("refuses an unknown auth value", () => {
    const text = shipped.replace("[github]\n", '[github]\nauth = "pat"\n');
    expect(() => parseConfig(text)).toThrowError(/\[github\]: auth must be "app" or "user"/);
  });

  it("the review core parses the key too (parseCoreConfig)", () => {
    expect(parseCoreConfig(user()).github.auth).toBe("user");
    expect(parseCoreConfig(shipped).github.auth).toBe("app");
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

// ---- the tracked configs — both parse and validate --------------------------
//
// The live config.toml lives in the install's config home, where no test can —
// or may — read it. What a tracked file can carry is asserted here; what only
// the live file can carry is the operator's: deploy.sh's preflight reads
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

// ---- config.example.toml — the new-operator template ----------------------
describe("config.example.toml", () => {
  const examplePath = resolve(root, "config.example.toml");

  it("parses and passes the same full validation as the live config", () => {
    const cfg = loadConfig(examplePath);
    expect(cfg.dry_run).toBe(true); // safe default: a fresh install never mutates GitHub
    expect(cfg.slack.enabled).toBe(false); // enabling Slack is a deliberate act
    expect(cfg.server.port).toBe(8787);
  });

  // The example is what a fresh install runs: it names no model, so a
  // review runs on whatever provider pi has a credential for.
  // MUTATION: uncomment `model = ` in config.example.toml's [models], or a
  // line of its [models.tiers] — this fails.
  it("pins no model: the review's model and every tier are the route's", () => {
    const cfg = loadConfig(examplePath);
    expect(cfg.models.model).toBe("");
    expect(cfg.models.tiers).toEqual(MODELS_TIER_DEFAULTS.tiers);
    expect(cfg.models.pass_models).toEqual({});
    // The older keys are gone from the file: nothing folds to a pin.
    const text = readFileSync(examplePath, "utf8");
    const models = text.slice(text.indexOf("\n[models]\n"), text.indexOf("\n[models.pricing]\n"));
    expect(models).not.toMatch(/^\s*"?(model|default|conversation|light|standard|deep)"?\s*=/m);
    // …and the pin is there to uncomment, in pi's own spelling.
    expect(models).toMatch(/^# model = "provider\/id"$/m);
  });

  it("ships empty identities for the values an operator must fill", () => {
    const cfg = loadConfig(examplePath);
    for (const key of ["repo", "app_slug", "bot_login", "review_team"] as const) {
      expect(cfg.github[key], `github.${key} must be a fill-me placeholder`).toBe("");
    }
  });
});

describe("[tui] memory_container", () => {
  const base = readFileSync(configPath, "utf8");

  it("defaults to empty, so a config that predates the sidecar relays into the daemon container", () => {
    const cfg = parseConfig(base);
    expect(cfg.tui.memory_container).toBe("");
    expect(tuiMemoryContainer(cfg.tui)).toBe(cfg.tui.container);
  });

  it("names the memory sidecar once the VM runs it, and only the memory path follows", () => {
    const cfg = parseConfig(
      base.replace(/^\[tui\]$/m, '[tui]\nmemory_container = "quickreview-memory"'),
    );
    expect(tuiMemoryContainer(cfg.tui)).toBe("quickreview-memory");
    // The board still reads the daemon's container.
    expect(cfg.tui.container).not.toBe("quickreview-memory");
  });

  it("a blank or padded value is the daemon container, never an empty docker target", () => {
    expect(tuiMemoryContainer({ container: "d", memory_container: "   " })).toBe("d");
    expect(tuiMemoryContainer({ container: "d", memory_container: " m " })).toBe("m");
  });

  it("the shipped example documents the key and keeps it empty", () => {
    const example = readFileSync(resolve(root, "config.example.toml"), "utf8");
    expect(example).toMatch(/^memory_container = ""/m);
    expect(parseConfig(example).tui.memory_container).toBe("");
  });
});

describe("the deleted overseer session's config knobs", () => {
  const withKeys = (toml: string): string =>
    toml
      .replace("[models]\n", '[models]\noverseer = "openai-codex/gpt-6.1-sol"\n')
      .replace("[daemon]\n", "[daemon]\noverseer_rotation_days = 7\n");

  it("accepts [models] overseer and [daemon] overseer_rotation_days, warns, and ignores both", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const cfg = parseConfig(withKeys(readFileSync(configPath, "utf8")));
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /\[models\] overseer is deprecated and ignored/.test(l))).toBe(true);
      expect(
        lines.some((l) => /\[daemon\] overseer_rotation_days is deprecated and ignored/.test(l)),
      ).toBe(true);
      expect("overseer" in cfg.models).toBe(false);
      expect("overseer_rotation_days" in cfg.daemon).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("a config without them parses silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      parseConfig(readFileSync(configPath, "utf8"));
      expect(warn.mock.calls.filter((c) => /overseer/.test(String(c[0])))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
