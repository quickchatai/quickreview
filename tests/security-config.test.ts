// The security configuration: config.toml's `[security]`, the profile's
// `[security]` overlay, the `[lenses.<pass>] plan`/`risk` keys, the
// `[posting]` and `[scan]` keys a security review reads, the addendum `mode:`
// line and `family:security` scope, the removed-line and config-line
// heuristics probes, and the profile's threat model. Each case drives the
// real parser or the real overlay (packages/pi-plugin/src/profiles.ts
// `applyProfileOverlays`, the one function the daemon, the one-shot review
// and the replay resolve through) and asserts on the resolved config.
//
// The repository's `.qcr/threat-model.md` passing the repo cut is pinned in
// tests/profile-overrides.test.ts, beside the rest of the repo extraction,
// because it needs a scratch git repository.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { configHome, homeProfileLookup, type InstallEnv } from "../src/install.js";
import {
  parseCoreConfig,
  parseScanTable,
  parseSecurityTable,
  SCAN_DEFAULTS,
  SECURITY_DEFAULTS,
  validateLensKnobs,
  withSecurityFamily,
  type CoreConfig,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { ALL_PASSES, SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { VALIDATE_PASS } from "@quickchatai/pi-quickreview/src/include.js";
import {
  alwaysPlannedLenses,
  parseLensTable,
  profileRiskLenses,
} from "@quickchatai/pi-quickreview/src/lenstuning.js";
import {
  isDefaultPosting,
  parsePostingTable,
  postingScope,
  postingSecurityMax,
  resolvePostingPolicy,
} from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import {
  applyProfileOverlays,
  applyProfileSecurity,
  loadProfileScan,
  loadProfileSecurity,
  loadProfileThreatModel,
  parseProfileAddendum,
  parseProfileHeuristics,
  securityOnlyLenses,
} from "@quickchatai/pi-quickreview/src/profiles.js";

const sandbox = join(import.meta.dirname, "..");
const FIXTURE = readFileSync(join(sandbox, "tests", "fixtures", "config.toml"), "utf8");
const root = sandbox;

let dir: string;
let env: InstallEnv;
const lookup = () => homeProfileLookup(env);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-security-config-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The fixture config.toml with `edit` applied to its parsed tables. */
function configWith(edit: (raw: Record<string, any>) => void = () => {}): CoreConfig {
  const raw = parseToml(FIXTURE) as Record<string, any>;
  edit(raw);
  return parseCoreConfig(stringifyToml(raw));
}

/** The fixture config reviewing under `profile`. */
function under(profile: string, edit?: (raw: Record<string, any>) => void): CoreConfig {
  return configWith((raw) => {
    raw.review = { ...raw.review, profile };
    edit?.(raw);
  });
}

/** A profile in the install's config home. */
function profile(name: string, toml: string, files: Record<string, string> = {}): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), toml);
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(p, rel), text);
}

// ---- config.toml ---------------------------------------------------------------

describe("[security] in config.toml", () => {
  it("an absent table is the defaults: strong triggers, nothing only, no fold, the label and the command on", () => {
    expect(configWith().security).toEqual(SECURITY_DEFAULTS);
    expect(SECURITY_DEFAULTS).toEqual({
      triggers: "strong",
      only: false,
      fold: false,
      label: "qcr:security",
      command: true,
    });
  });

  it("every key it sets is read", () => {
    const cfg = configWith((raw) => {
      raw.security = { triggers: "all", only: true, fold: true, label: "", command: false };
    });
    expect(cfg.security).toEqual({
      triggers: "all",
      only: true,
      fold: true,
      label: "",
      command: false,
    });
  });

  it.each([
    [{ triggers: "some" }, /\[security\] triggers must be "off", "strong", "all"/],
    [{ triggers: true }, /\[security\] triggers must be/],
    [{ only: "yes" }, /\[security\] only must be true or false/],
    [{ fold: 1 }, /\[security\] fold must be true or false/],
    [{ command: "on" }, /\[security\] command must be true or false/],
    [{ label: 7 }, /\[security\] label must be a label name/],
    [{ label: "x".repeat(51) }, /\[security\] label must be a label name of at most 50/],
    [{ label: "a\nb" }, /\[security\] label must be a label name/],
    [{ trigger: "all" }, /\[security\] unknown key "trigger"/],
  ])("refuses %j", (table, error) => {
    expect(() => configWith((raw) => (raw.security = table))).toThrow(error);
  });

  it("a table that is not a table is refused", () => {
    expect(() => configWith((raw) => (raw.security = "strong"))).toThrow(
      /\[security\] must be a table/,
    );
  });
});

describe("[models] risk_passes always carries the security family", () => {
  // MUTATION: drop the SECURITY_FAMILY union from risk_passes
  // (`withSecurityFamily` returning `passes` as given) — this fails.
  it("the default list gains the family, in ALL_PASSES order after its own", () => {
    const risk = configWith().models.risk_passes;
    expect(risk.slice(0, 3)).toEqual(["pass-security", "pass-prod-risk", "pass-data-safety"]);
    expect(risk.slice(3)).toEqual([...SECURITY_FAMILY]);
  });

  it("a config's own list keeps its passes and gains the family, each once", () => {
    const risk = configWith((raw) => {
      raw.models.risk_passes = ["pass-security", "pass-sec-access"];
    }).models.risk_passes;
    expect(risk[0]).toBe("pass-security");
    for (const lens of SECURITY_FAMILY) expect(risk.filter((r) => r === lens)).toEqual([lens]);
    // even an empty list: the family is not the config's to drop
    expect(configWith((raw) => (raw.models.risk_passes = [])).models.risk_passes).toEqual([
      ...SECURITY_FAMILY,
    ]);
    expect(withSecurityFamily(["pass-ui"])).toEqual(["pass-ui", ...SECURITY_FAMILY]);
  });

  it("a risk_passes that is not a list of names is refused", () => {
    expect(() => configWith((raw) => (raw.models.risk_passes = "pass-security"))).toThrow(
      /risk_passes must be an array of pass names/,
    );
  });

  it("a [models.pass_tiers] pin or a [models.pass_models] move on a family lens is refused", () => {
    expect(() =>
      configWith((raw) => (raw.models.pass_tiers = { "pass-sec-access": "terra-med" })),
    ).toThrow(/pass-sec-access is a security-family lens/);
    expect(() =>
      configWith((raw) => (raw.models.pass_models = { "pass-sec-iam": "openai/gpt-x" })),
    ).toThrow(/pass-sec-iam is a risk pass/);
    // and past the parser too (the bench's --config route re-validates)
    const cfg = configWith();
    cfg.models.risk_passes = ["pass-security"];
    cfg.models.pass_tiers = { ...cfg.models.pass_tiers, "pass-sec-llm": "sol-med" };
    expect(() => validateLensKnobs(cfg)).toThrow(/pass-sec-llm is a security-family lens/);
  });
});

describe("[scan] lenses, kinds and threat_model", () => {
  it("default to every deep lens, every kind and a threat model drafted when none exists", () => {
    expect(SCAN_DEFAULTS.lenses).toEqual([]);
    expect(SCAN_DEFAULTS.kinds).toEqual([]);
    expect(SCAN_DEFAULTS.threat_model).toBe("auto");
    expect(configWith().scan).toEqual(SCAN_DEFAULTS);
  });

  it("are read from config.toml and from a profile", () => {
    const cfg = configWith((raw) => {
      raw.scan = {
        lenses: ["pass-sec-injection", "pass-sec-access", "pass-sec-injection"],
        kinds: ["security", "security:injection"],
        threat_model: "always",
      };
    });
    expect(cfg.scan.lenses).toEqual(["pass-sec-injection", "pass-sec-access"]);
    expect(cfg.scan.kinds).toEqual(["security", "security:injection"]);
    expect(cfg.scan.threat_model).toBe("always");
    profile(
      "scanner",
      '[scan]\nlenses = ["pass-sec-iam"]\nkinds = ["security"]\nthreat_model = "off"\n',
    );
    expect(loadProfileScan(root, "scanner", lookup())).toEqual({
      lenses: ["pass-sec-iam"],
      kinds: ["security"],
      threat_model: "off",
    });
  });

  it.each([
    [{ lenses: "pass-sec-iam" }, /lenses must be an array/],
    [{ lenses: ["pass-intent"] }, /lenses entry "pass-intent" is not a lens a scan can run/],
    [{ lenses: ["pass-validate"] }, /lenses entry "pass-validate" is not a lens a scan can run/],
    [{ kinds: "security" }, /kinds must be an array/],
    [{ kinds: ["Security"] }, /kinds entry "Security" is not a finding kind/],
    [{ kinds: ["security:"] }, /kinds entry "security:" is not a finding kind/],
    [{ threat_model: "never" }, /threat_model must be "auto", "always", "off"/],
  ])("refuses %j", (table, error) => {
    expect(() => parseScanTable("w", table)).toThrow(error);
  });
});

// ---- the profile -----------------------------------------------------------------

describe("the profile's [security] wins over config.toml", () => {
  it("for triggers, only and fold, the nearest profile in the chain winning per key", () => {
    profile("base", '[security]\ntriggers = "off"\nfold = true\n');
    profile("child", 'extends = "base"\n[security]\ntriggers = "all"\n');
    expect(loadProfileSecurity(root, "child", lookup())).toEqual({ triggers: "all", fold: true });
    const cfg = applyProfileOverlays(
      root,
      under("child", (raw) => (raw.security = { triggers: "strong", fold: false, label: "sec" })),
      lookup(),
    );
    expect(cfg.security).toEqual({
      triggers: "all",
      only: false,
      fold: true,
      label: "sec",
      command: true,
    });
  });

  it("refuses label and command, which are config.toml's alone", () => {
    profile("labels", '[security]\nlabel = "mine"\n');
    expect(() => loadProfileSecurity(root, "labels", lookup())).toThrow(
      /\[security\] label is config\.toml only/,
    );
    profile("commands", "[security]\ncommand = false\n");
    expect(() => loadProfileSecurity(root, "commands", lookup())).toThrow(
      /\[security\] command is config\.toml only/,
    );
    expect(() => parseSecurityTable("w", { label: "" }, ["triggers"])).toThrow(/config\.toml only/);
  });

  it("no profile, or one with no [security], is config.toml's table unchanged", () => {
    expect(loadProfileSecurity(root, "", lookup())).toEqual({});
    profile("plain", "");
    const cfg = applyProfileOverlays(root, under("plain"), lookup());
    expect(cfg.security).toEqual(SECURITY_DEFAULTS);
    expect(cfg.lenses).toEqual({});
    expect(cfg.posting).toBeUndefined();
  });
});

describe("only = true: a security-only review", () => {
  // MUTATION: skip the enabled=false materialisation in applyProfileSecurity
  // (return `cfg.lenses` unchanged when `only`) — this fails.
  it("switches every lens off but the family and the validator, through enabled = false", () => {
    profile("seconly", "[security]\nonly = true\n");
    const cfg = applyProfileOverlays(root, under("seconly"), lookup());
    expect(cfg.security.only).toBe(true);
    for (const lens of ALL_PASSES) {
      const kept = SECURITY_FAMILY.includes(lens) || lens === VALIDATE_PASS;
      expect(cfg.lenses?.[lens]?.enabled, lens).toBe(kept ? undefined : false);
    }
    for (const lens of ["pass-baseline", "pass-bounds", "pass-security", "pass-sweep"])
      expect(cfg.lenses?.[lens]?.enabled, lens).toBe(false);
  });

  it("covers a lens added to ALL_PASSES later, with no edit", () => {
    const passes = [...ALL_PASSES, "pass-added-later"];
    expect(securityOnlyLenses({}, passes)["pass-added-later"]).toEqual({ enabled: false });
    const cfg = applyProfileSecurity(under(""), { only: true }, passes);
    expect(cfg.lenses?.["pass-added-later"]?.enabled).toBe(false);
    expect(cfg.lenses?.[VALIDATE_PASS]).toBeUndefined();
  });

  it("keeps an enabled the profile wrote, either way, and the rest of its tuning", () => {
    const lenses = securityOnlyLenses({
      "pass-baseline": { enabled: true },
      "pass-sec-llm": { enabled: false },
      "pass-ui": { emphasis: "forms" },
    });
    expect(lenses["pass-baseline"]).toEqual({ enabled: true });
    expect(lenses["pass-sec-llm"]).toEqual({ enabled: false });
    expect(lenses["pass-ui"]).toEqual({ emphasis: "forms", enabled: false });
  });

  it("config.toml's only = true does the same once the overlays run", () => {
    profile("plain", "");
    const cfg = applyProfileOverlays(
      root,
      under("plain", (raw) => (raw.security = { only: true })),
      lookup(),
    );
    expect(cfg.lenses?.["pass-baseline"]?.enabled).toBe(false);
    expect(cfg.lenses?.["pass-sec-injection"]).toBeUndefined();
  });

  it("scopes what posts to security findings, unless the profile set a scope itself", () => {
    profile("seconly", "[security]\nonly = true\n");
    const scoped = applyProfileOverlays(root, under("seconly"), lookup()).posting;
    expect(postingScope(scoped)).toBe("security");
    expect(isDefaultPosting(scoped)).toBe(false);
    profile("everything", '[security]\nonly = true\n[posting]\nscope = "all"\n');
    expect(applyProfileOverlays(root, under("everything"), lookup()).posting).toBeUndefined();
    profile("notonly", "[security]\nonly = false\n");
    expect(applyProfileOverlays(root, under("notonly"), lookup()).posting).toBeUndefined();
  });

  it("applying the overlays twice changes nothing more", () => {
    profile("seconly", "[security]\nonly = true\n[lenses.pass-ui]\nrisk = true\n");
    const once = applyProfileOverlays(root, under("seconly"), lookup());
    expect(applyProfileOverlays(root, once, lookup())).toEqual(once);
  });
});

describe("[lenses.<pass>] plan and risk", () => {
  it("parse, and are refused on the validator or with a bad value", () => {
    const t = parseLensTable(
      "w",
      { "pass-sec-access": { plan: "always", risk: true }, "pass-ui": { plan: "triggered" } },
      ALL_PASSES,
    );
    expect(t["pass-sec-access"]).toEqual({ plan: "always", risk: true });
    expect(alwaysPlannedLenses(t)).toEqual(["pass-sec-access"]);
    expect(profileRiskLenses(t)).toEqual(["pass-sec-access"]);
    expect(() => parseLensTable("w", { "pass-ui": { plan: "sometimes" } }, ALL_PASSES)).toThrow(
      /plan must be "triggered" or "always"/,
    );
    expect(() => parseLensTable("w", { "pass-ui": { risk: "yes" } }, ALL_PASSES)).toThrow(
      /risk must be true or false/,
    );
    expect(() => parseLensTable("w", { [VALIDATE_PASS]: { plan: "always" } }, ALL_PASSES)).toThrow(
      /plan — the validator is planned on every review already/,
    );
    expect(() => parseLensTable("w", { [VALIDATE_PASS]: { risk: true } }, ALL_PASSES)).toThrow(
      /risk — the validator's tier is \[models\] validate_tier/,
    );
  });

  it("risk = true joins the lens to risk_passes once, and false takes nothing out", () => {
    profile("risky", "[lenses.pass-ui]\nrisk = true\n[lenses.pass-security]\nrisk = false\n");
    const cfg = applyProfileOverlays(root, under("risky"), lookup());
    expect(cfg.models.risk_passes).toContain("pass-ui");
    expect(cfg.models.risk_passes).toContain("pass-security");
    expect(cfg.models.risk_passes.filter((p) => p === "pass-ui")).toHaveLength(1);
    expect(configWith().models.risk_passes).not.toContain("pass-ui");
  });

  it("a [models.pass_tiers] pin or [models.pass_models] move on a risk = true lens is refused", () => {
    profile("risky", "[lenses.pass-ui]\nrisk = true\n");
    expect(() =>
      applyProfileOverlays(
        root,
        under("risky", (raw) => (raw.models.pass_tiers = { "pass-ui": "terra-med" })),
        lookup(),
      ),
    ).toThrow(/\[lenses\.pass-ui\] risk = true, but \[models\.pass_tiers\] pins pass-ui/);
    expect(() =>
      applyProfileOverlays(
        root,
        under("risky", (raw) => (raw.models.pass_models = { "pass-ui": "openai/gpt-x" })),
        lookup(),
      ),
    ).toThrow(/\[lenses\.pass-ui\] risk = true, but \[models\.pass_models\] moves pass-ui/);
  });
});

describe("[posting] security_max and scope", () => {
  it("parse, and absent read as no separate channel and every finding", () => {
    expect(parsePostingTable("w", { security_max: 8, scope: "security" })).toEqual({
      security_max: 8,
      scope: "security",
    });
    expect(postingSecurityMax(undefined)).toBe(0);
    expect(postingScope(undefined)).toBe("all");
    const policy = resolvePostingPolicy({});
    expect(postingSecurityMax(policy)).toBe(0);
    expect(postingScope(policy)).toBe("all");
  });

  it("a policy that sets only their defaults is the default policy; one that moves them is not", () => {
    expect(isDefaultPosting(resolvePostingPolicy({ security_max: 0, scope: "all" }))).toBe(true);
    expect(isDefaultPosting(resolvePostingPolicy({ security_max: 1 }))).toBe(false);
    expect(isDefaultPosting(resolvePostingPolicy({ scope: "security" }))).toBe(false);
  });

  it.each([
    [{ security_max: -1 }, /security_max must be a whole number from 0/],
    [{ security_max: 51 }, /security_max must be a whole number from 0/],
    [{ security_max: 1.5 }, /security_max must be a whole number from 0/],
    [{ scope: "secure" }, /scope must be one of "all", "security"/],
  ])("refuses %j", (table, error) => {
    expect(() => parsePostingTable("w", table)).toThrow(error);
  });
});

// ---- addenda and heuristics -----------------------------------------------------

describe("a profile addendum's mode: and family:security scope", () => {
  const addendum = (front: string) => `---\nid: sec-rule\n${front}---\n## A rule\n`;

  it("mode: review binds the PR build, scan the scan build, both or none either", () => {
    expect(parseProfileAddendum("f.md", addendum("scope: all\nmode: review\n")).mode).toBe("pr");
    expect(parseProfileAddendum("f.md", addendum("scope: all\nmode: scan\n")).mode).toBe("scan");
    for (const front of ["scope: all\nmode: both\n", "scope: all\n"]) {
      const a = parseProfileAddendum("f.md", addendum(front));
      expect(a).toEqual({ id: "sec-rule", scope: "all", text: "\n## A rule\n" });
      expect("mode" in a).toBe(false);
    }
    expect(() => parseProfileAddendum("f.md", addendum("scope: all\nmode: pr\n"))).toThrow(
      /mode "pr" — use "review", "scan" or "both"/,
    );
    expect(() =>
      parseProfileAddendum("f.md", addendum("scope: all\nmode: scan\nmode: review\n")),
    ).toThrow(/duplicate frontmatter key "mode"/);
    expect(() => parseProfileAddendum("f.md", addendum("scope: all\nkind: x\n"))).toThrow(
      /only "id:", "scope:" and "mode:" are allowed/,
    );
  });

  it("family:security expands to the family, beside pass names, each once", () => {
    const a = parseProfileAddendum(
      "f.md",
      addendum("scope: family:security, pass-validate, pass-sec-iam\n"),
    );
    expect(a.scope).toEqual([...SECURITY_FAMILY, VALIDATE_PASS]);
    expect(() => parseProfileAddendum("f.md", addendum("scope: family:quality\n"))).toThrow(
      /unknown lens family "quality"/,
    );
  });
});

describe("heuristics.toml removed_lines and config_lines", () => {
  const PATCH = [
    "--- a/app/views.py",
    "+++ b/app/views.py",
    "@@ -1,3 +1,2 @@",
    "-@login_required",
    " def settings(request):",
    "+    return render(request)",
  ].join("\n");

  // MUTATION: make removed-line probes test "+" lines (wrap as `^\+.*(?:…)`)
  // — this fails.
  it("a removed_lines probe matches a removed line, never the --- header nor an added line", () => {
    const ext = parseProfileHeuristics(
      "h.toml",
      '[pass-security]\nremoved_lines = ["login_required", "views", "render"]\n',
    );
    const [guard, views, render] = ext.removedLines?.["pass-security"] ?? [];
    expect(guard?.test(PATCH)).toBe(true);
    expect(guard?.test("-    @Login_Required")).toBe(true);
    expect(views?.test(PATCH)).toBe(false); // only the `--- a/app/views.py` header names it
    expect(render?.test(PATCH)).toBe(false); // only an added line names it
    expect(ext.addedLines).toEqual({});
  });

  it("a config_lines probe matches an added line, case-insensitively", () => {
    const ext = parseProfileHeuristics(
      "h.toml",
      '[pass-security]\nconfig_lines = ["AuthType:\\\\s*NONE"]\n',
    );
    const [probe] = ext.configLines?.["pass-security"] ?? [];
    expect(probe?.test("+  authtype: none")).toBe(true);
    expect(probe?.test("-  AuthType: NONE")).toBe(false);
  });

  it("an extension with neither keeps its two-key shape, and a bad probe is refused", () => {
    expect(parseProfileHeuristics("h.toml", '[pass-ui]\npaths = ["x"]\n')).not.toHaveProperty(
      "removedLines",
    );
    expect(() =>
      parseProfileHeuristics("h.toml", '[pass-security]\nremoved_lines = ["("]\n'),
    ).toThrow(/removed_lines pattern "\(" is not a valid RegExp/);
    expect(() => parseProfileHeuristics("h.toml", '[pass-security]\ndeleted = ["x"]\n')).toThrow(
      /only "paths", "added_lines", "removed_lines" and "config_lines" are allowed/,
    );
  });
});

// ---- the threat model -------------------------------------------------------------

describe("the profile's threat-model.md", () => {
  it("the nearest profile in the chain that carries one wins whole", () => {
    profile("base", "", { "threat-model.md": "## Controls\n- base\n" });
    profile("child", 'extends = "base"\n');
    profile("own", 'extends = "base"\n', { "threat-model.md": "## Controls\n- own\n" });
    profile("blank", 'extends = "base"\n', { "threat-model.md": "  \n" });
    expect(loadProfileThreatModel(root, "child", lookup())).toBe("## Controls\n- base\n");
    expect(loadProfileThreatModel(root, "own", lookup())).toBe("## Controls\n- own\n");
    expect(loadProfileThreatModel(root, "blank", lookup())).toBe("## Controls\n- base\n");
  });

  it("no profile, or none that carries one, is null — and the repo layer is never read here", () => {
    expect(loadProfileThreatModel(root, "", lookup())).toBeNull();
    profile("plain", "");
    const repoDir = join(dir, "repo-layer");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "threat-model.md"), "## Controls\n- repo\n");
    const withRepo = { ...lookup(), repoProfile: { dir: repoDir } };
    expect(loadProfileThreatModel(root, "plain", withRepo)).toBeNull();
    expect(loadProfileThreatModel(root, "", withRepo)).toBeNull();
  });
});
