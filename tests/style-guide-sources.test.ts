// tests/style-guide-sources.test.ts — where the style lens's guide comes from
//.
//
// Two sources, one rule: the repo's own written guide — now including the
// style rules it wrote for its agents (AGENTS.md, CLAUDE.md,
// .github/instructions) — and, only when the repo writes none, a guide the
// repo's profile points `pass-style` at in the config home. Every case goes
// through the seams production uses: `findStyleGuide` over a temp tree (what
// dispatch.ts and the bench call), a profile resolved from a temp config home
// (`loadProfileLensTuning` + `applyProfileTuning`, wire.ts's overlay), and
// what that makes `buildPassPlan` and `buildAgents` do.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { PASS_ADDENDA, buildAgents } from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import {
  applyProfileTuning,
  lensModelOverrides,
  lensTuningAddenda,
  PROFILE_GUIDE_MAX_CHARS,
} from "../src/lenstuning.js";
import { loadProfileAddenda, loadProfileLensTuning } from "../src/profiles.js";
import { findStyleGuide, SECTION_MIN_LINES } from "../src/styleguide.js";
import { runFingerprint } from "../src/bench/runner.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let repo: string;
let env: InstallEnv;
const lookup = () => ({ env, log: () => {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-style-sources-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rules = (n: number) => Array.from({ length: n }, (_, i) => `- rule ${i + 1}`).join("\n");

function put(rel: string, text: string): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

// ---- the detector reads agent-directive files ---------------------------------------

describe("findStyleGuide reads the style rules a repo wrote for its agents", () => {
  it("a style section of AGENTS.md is a guide, cited with its line span", () => {
    put("AGENTS.md", `# Agents\nintro\n## Code style\n${rules(SECTION_MIN_LINES)}\n## Deploy\nx\n`);
    expect(findStyleGuide(repo)).toEqual([`AGENTS.md:3-${3 + SECTION_MIN_LINES}`]);
  });

  it("agent files name the section for the agent: a bare Conventions / Naming heading counts", () => {
    put("CLAUDE.md", `# Guide\n## Conventions\n${rules(SECTION_MIN_LINES)}\n`);
    put(".github/copilot-instructions.md", `## Naming\n${rules(SECTION_MIN_LINES)}\n# Other\n`);
    expect(findStyleGuide(repo)).toEqual([
      `.github/copilot-instructions.md:1-${1 + SECTION_MIN_LINES}`,
      `CLAUDE.md:2-${2 + SECTION_MIN_LINES}`,
    ]);
  });

  it("every style section of a directive file, a nested heading inside one read as part of it", () => {
    put(
      "AGENTS.md",
      `## Code Conventions\n### Naming\n${rules(SECTION_MIN_LINES)}\n## Ops\nx\n## Formatting\n${rules(SECTION_MIN_LINES)}\n`,
    );
    const second = 1 + 1 + SECTION_MIN_LINES + 2 + 1;
    expect(findStyleGuide(repo)).toEqual([
      `AGENTS.md:1-${1 + 1 + SECTION_MIN_LINES}`,
      `AGENTS.md:${second}-${second + SECTION_MIN_LINES}`,
    ]);
  });

  it("a .github/instructions file named for style counts whole; other instructions by section", () => {
    put(
      ".github/instructions/code-style.instructions.md",
      `---\napplyTo: "**"\n---\n${rules(SECTION_MIN_LINES)}\n`,
    );
    put(".github/instructions/logging.instructions.md", "Wrap fields in extra_data.\n");
    put(".github/instructions/python.instructions.md", `## Style\n${rules(SECTION_MIN_LINES)}\n`);
    expect(findStyleGuide(repo)).toEqual([
      ".github/instructions/code-style.instructions.md",
      `.github/instructions/python.instructions.md:1-${1 + SECTION_MIN_LINES}`,
    ]);
  });

  it("written rules count whatever the heading: a `# Compliance Rules` AGENTS.md is a guide", () => {
    // The shape of all eight Qodo PR-Review-Bench repos' AGENTS.md (2026-10-03):
    // numbered `##` rules under one `# Compliance Rules` title.
    const body = Array.from(
      { length: 4 },
      (_, i) => `## ${i + 1}. Rule ${i + 1} Must Hold\n\nWhat it requires.\n- example a\n- example b\n`,
    ).join("\n");
    put("AGENTS.md", `# Compliance Rules\n\n${body}`);
    const [ref] = findStyleGuide(repo);
    expect(ref).toMatch(/^AGENTS\.md:1-\d+$/);
    // A "Rules" heading in an agent file with nothing substantial under it is still no guide.
    rmSync(join(repo, "AGENTS.md"));
    put("CLAUDE.md", "## Rules\nRun the tests.\n");
    expect(findStyleGuide(repo)).toEqual([]);
  });

  it("a thin section, or a directive file with no style section, is no guide", () => {
    put("AGENTS.md", `## Code style\nUse black.\n## Deploy\n${rules(40)}\n`);
    put(".github/instructions/code-style.instructions.md", "Use black.\n");
    expect(findStyleGuide(repo)).toEqual([]);
  });

  it("CLAUDE.md linked to AGENTS.md is read once", () => {
    put("AGENTS.md", `## Code style\n${rules(SECTION_MIN_LINES)}\n`);
    symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
    expect(findStyleGuide(repo)).toEqual([`AGENTS.md:1-${1 + SECTION_MIN_LINES}`]);
  });

  it("detects the first reviewed repo's real AGENTS.md (its heading outline, 2026-09-23)", () => {
    // The live file's section structure: the style rules sit under
    // `## Code Conventions`, split into per-stack `###`/`####` subsections,
    // between `## Production Database` and `## Datadog Observability`.
    const agents = [
      "# Agent Guidelines for Acme",
      "## Project Overview",
      "Acme is a web platform.",
      "## Forbidden Paths",
      "- secrets/",
      "## Working Guidelines",
      "### Reviewing PRs",
      "- read the diff",
      "## Development Commands",
      "### Running Tests",
      "- pytest",
      "## Production Database",
      "### Writing migrations that touch large tables",
      "- batch updates",
      "## Code Conventions", // line 15
      "### Backend (Python & Django)",
      "- Use Django Ninja for all new API endpoints",
      "- Always use absolute imports rather than relative imports",
      "- Always include typing for function inputs and outputs",
      "- Try to use Literals or consts instead of raw strings",
      "- Module-level constants belong at the top of the file",
      "### Backend Testing",
      "- Use pytest",
      "- Write function-based tests rather than class-based tests",
      "### Frontend (React & legacy HTML+JS)",
      "- Use icons from `lucide-react`",
      "- Use standard Tailwind text sizes",
      "#### Color & Theme System",
      "The app uses shadcn preset default.",
      "## Datadog Observability", // line 30
      "### Latency Awareness",
      "- mind p99",
      "## Design Context",
      "- see docs",
    ].join("\n");
    put("AGENTS.md", agents + "\n");
    put(
      ".github/instructions/logging.instructions.md",
      '---\napplyTo: "**"\n---\n\nWrap fields.\n',
    );
    expect(findStyleGuide(repo)).toEqual(["AGENTS.md:15-29"]);
  });
});

// ---- the profile's guide -------------------------------------------------------------

/** Write a profile into the install's config home, with optional extra files. */
function profile(name: string, toml: string, files: Record<string, string> = {}): string {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), toml);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(p, rel, ".."), { recursive: true });
    writeFileSync(join(p, rel), text);
  }
  return p;
}

function tuned(name: string): Config {
  const cfg = structuredClone(fixture);
  cfg.review.profile = name;
  return applyProfileTuning(cfg, loadProfileLensTuning(sandbox, name, lookup()));
}

function agents(cfg: Config): Map<string, string> {
  const out = mkdtempSync(join(tmpdir(), "qcr-style-sources-build-"));
  try {
    const files = new Map<string, string>();
    const built = buildAgents(join(sandbox, "agents"), out, {
      root: sandbox,
      tiers: cfg.models.tiers,
      riskPasses: cfg.models.risk_passes,
      validateTier: cfg.models.validate_tier,
      models: lensModelOverrides(cfg.models, cfg.lenses),
      addenda: [
        ...PASS_ADDENDA,
        ...loadProfileAddenda(sandbox, cfg.review.profile, lookup()),
        ...lensTuningAddenda(cfg.lenses),
      ],
    });
    for (const b of built) files.set(b.name, readFileSync(b.output, "utf8"));
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const CODE: PrFileEntry[] = [
  { filename: "src/a.ts", additions: 3, deletions: 0, status: "modified" },
];
const styleRow = (cfg: Config, repoGuide: readonly string[] = []) =>
  buildPassPlan(cfg, CODE, undefined, NONE_ECOSYSTEM, undefined, repoGuide).pass_plan.find(
    (p) => p.lens === "pass-style",
  );

const GUIDE = "# House style\n\n- Name booleans is_/has_.\n- No abbreviations in public names.\n";
const GUIDED = '[lenses.pass-style]\nguide = "style-guide.md"\n';

describe("a profile may point pass-style at a guide in the config home", () => {
  it("with no repo guide, the style lens is planned on the profile's guide", () => {
    profile("drafted", GUIDED, { "style-guide.md": GUIDE });
    expect(styleRow(tuned(""))).toBeUndefined();
    const row = styleRow(tuned("drafted"))!;
    expect(row).toBeDefined();
    expect(row.why).toContain("this repo's profile style guide");
    expect(row.why).toContain("style-guide.md");
  });

  it("a guide the repo writes wins over the profile's", () => {
    profile("drafted", GUIDED, { "style-guide.md": GUIDE });
    put("AGENTS.md", `## Code style\n${rules(SECTION_MIN_LINES)}\n`);
    const row = styleRow(tuned("drafted"), findStyleGuide(repo))!;
    expect(row.why).toBe(`the repo's written style guide: AGENTS.md:1-${1 + SECTION_MIN_LINES}`);
    expect(row.why).not.toContain("profile");
  });

  it("the guide's text reaches pass-style and the validator only, through the addendum registry", () => {
    profile("drafted", GUIDED, { "style-guide.md": GUIDE });
    const cfg = tuned("drafted");
    const built = agents(cfg);
    const style = built.get("pass-style--sol-med")!;
    expect(style).toContain("Name booleans is_/has_.");
    expect(style).toContain(
      "a guide the repo itself writes, the repo's guide is the only standard",
    );
    expect(built.get(`pass-validate--${cfg.models.validate_tier}`)).toContain(
      "No abbreviations in public names.",
    );
    expect(built.get("pass-baseline--sol-med")).not.toContain("House style");
    // An untuned build is untouched by the feature.
    expect(agents(tuned("")).get("pass-style--sol-med")).not.toContain("profile style guide");
  });

  it("switching the style lens off beats the guide", () => {
    profile("off", `${GUIDED}enabled = false\n`, { "style-guide.md": GUIDE });
    expect(styleRow(tuned("off"))).toBeUndefined();
  });

  it("a child inherits its base's guide, resolved in the base's directory; its own replaces it", () => {
    profile("base", GUIDED, { "style-guide.md": GUIDE });
    profile("child", 'extends = "base"\n');
    expect(tuned("child").lenses?.["pass-style"]?.guide?.text).toBe(GUIDE);
    profile("own", `extends = "base"\n[lenses.pass-style]\nguide = "docs/mine.md"\n`, {
      "docs/mine.md": "- tabs\n",
    });
    const g = tuned("own").lenses?.["pass-style"]?.guide;
    expect(g?.file).toBe("docs/mine.md");
    expect(g?.text).toBe("- tabs\n");
  });

  it("refuses a guide it cannot honour, naming the file", () => {
    const outside = join(dir, "outside.md");
    writeFileSync(outside, GUIDE);
    const cases: [string, Record<string, string>, RegExp][] = [
      ['[lenses.pass-ui]\nguide = "g.md"\n', { "g.md": GUIDE }, /only \[lenses\.pass-style\]/],
      [`[lenses.pass-style]\nguide = "${outside}"\n`, {}, /must be relative/],
      ['[lenses.pass-style]\nguide = "../outside.md"\n', {}, /without '\.\.'/],
      ['[lenses.pass-style]\nguide = "missing.md"\n', {}, /cannot use/],
      ['[lenses.pass-style]\nguide = "empty.md"\n', { "empty.md": "  \n" }, /is empty/],
      [
        '[lenses.pass-style]\nguide = "big.md"\n',
        { "big.md": "x".repeat(PROFILE_GUIDE_MAX_CHARS + 1) },
        /over \d+ characters/,
      ],
      ["[lenses.pass-style]\nguide = 3\n", {}, /must be a file name/],
    ];
    cases.forEach(([toml, files, err], i) => {
      profile(`bad${i}`, toml, files);
      expect(() => tuned(`bad${i}`), toml).toThrow(err);
    });
    // A link that leaves the profile's directory is refused too.
    const p = profile("linked", '[lenses.pass-style]\nguide = "g.md"\n');
    symlinkSync(outside, join(p, "g.md"));
    expect(() => tuned("linked")).toThrow(/outside the profile's directory/);
  });

  it("the bench fingerprint records the guide by name and content hash", () => {
    profile("fp", GUIDED, { "style-guide.md": GUIDE });
    expect(runFingerprint(tuned("fp"), "fp").lenses).toEqual({
      "pass-style": {
        guide: {
          file: "style-guide.md",
          sha256: createHash("sha256").update(GUIDE).digest("hex"),
        },
      },
    });
  });
});

// ---- style findings stay nit unless max_severity raises them ---------------------------

describe("style findings are nits unless the profile raises the ceiling", () => {
  it("the validator caps pass-style at nit by default; max_severity replaces that cap", () => {
    const validator = (cfg: Config) =>
      agents(cfg).get(`pass-validate--${cfg.models.validate_tier}`)!;
    const plain = validator(tuned(""));
    // The built-in cap now lives in the one convention rule (case 1: keep as a nit).
    const NIT_CAP = "keep it as a `[nit]` (demote higher with `style-over-cap`)";
    expect(plain).toContain(NIT_CAP);
    expect(plain).not.toContain("Severity ceiling for `pass-style`");
    profile("loud", `${GUIDED}max_severity = "P2"\n`, { "style-guide.md": GUIDE });
    const raised = validator(tuned("loud"));
    const cap = raised.indexOf(NIT_CAP);
    const ceiling = raised.indexOf("Severity ceiling for `pass-style`: `P2`");
    expect(cap).toBeGreaterThan(-1);
    // Composed after the built-in cap, and it REPLACES it.
    expect(ceiling).toBeGreaterThan(cap);
    expect(raised).toContain("It REPLACES every other cap these instructions put on `pass-style`");
  });
});
