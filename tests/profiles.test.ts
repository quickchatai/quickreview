// tests/profiles.test.ts — repo-profile addenda packs.
//
// Two jobs:
//  1. The loader contract: deterministic filename-sort order, strict
//     frontmatter (id + scope only), loud failure on anything malformed —
//     never a silent skip.
//  2. The byte-equivalence proof for the extraction: the six LEGACY_*
//     constants below are frozen, verbatim copies of the compiled-in registry
//     entries moved into profiles/quickchat/addenda/. Building the
//     real agents/ seeds with [generic registry + quickchat pack] must produce
//     exactly the bytes that [generic registry + these constants at the tail]
//     produces, across EVERY built variant file. The constants' tail position
//     mirrors the pack's composition point (after every built-in generic
//     entry, before the dynamic feedback-day addendum) — see docs/profiles.md
//     for the one deliberate delta vs the legacy registry: an extracted
//     entry that used to sit mid-registry now composes at its pass's tail.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASS_ADDENDA, buildAgents } from "../src/include.js";
import type { PassAddendum } from "../src/include.js";
import { configHome, locateProfile, type InstallEnv } from "../src/install.js";
import {
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  parseProfileAddendum,
  parseProfileHeuristics,
  reservedAddendumIds,
} from "../src/profiles.js";
import { PROFILE_EXTENDABLE_LENSES } from "../src/heuristics.js";

const sandbox = join(import.meta.dirname, "..");
/** A fixture profile in `<root>/profiles/` — found because `at(root)` names a
 * config in `<root>`, and a profile beside `$QCR_CONFIG` is on the lookup
 * path (the compose / VM shape).: a checkout's `profiles/` serves only
 * the generic examples, so a fixture can no longer just sit in one. The
 * config-home half is exercised in "the two locations" below. */
const profileDir = (root: string, profile: string): string => join(root, "profiles", profile);
const at = (root: string) => ({
  env: { QCR_CONFIG: join(root, "config.toml"), HOME: root, XDG_CONFIG_HOME: join(root, "xdg") },
});
// The quickchat pack is excluded from the assembled public snapshot
// (publish-manifest.json); the pins for that exact pack self-skip without it.
const HAS_QC = locateProfile({ root: sandbox, profile: "quickchat" }) !== null; //: the config home

// ---- the frozen legacy constants (verbatim from legacy src/include.ts) --

const LEGACY_MIGRATION_DISCIPLINE = "[private profile text removed]";

const LEGACY_NULLABILITY_TWO_HALVES = "[private profile text removed]";

const LEGACY_TEST_DOCTRINE = "[private profile text removed]";

const LEGACY_ORM_USAGE = "[private profile text removed]";

const LEGACY_DECLARED_SHAPE = "[private profile text removed]";

const LEGACY_CONFIG_PLACEMENT = "[private profile text removed]";

/**: the stack rules the three reseeded seeds carried, composed after
 * the six (filename order: 70-, 80-, 90-). */
const STACK_PACK_IDS = ["stack-baseline", "stack-ui", "stack-data-safety"];

/** The moved pack exactly as the compiled-in registry declared it. */
const LEGACY_PACK: PassAddendum[] = [
  { id: "migration-discipline", scope: ["pass-data-safety"], text: LEGACY_MIGRATION_DISCIPLINE },
  { id: "nullability-two-halves", scope: ["pass-backcompat"], text: LEGACY_NULLABILITY_TWO_HALVES },
  { id: "test-doctrine", scope: ["pass-baseline"], text: LEGACY_TEST_DOCTRINE },
  { id: "orm-usage", scope: ["pass-baseline"], text: LEGACY_ORM_USAGE },
  { id: "declared-shape", scope: ["pass-baseline"], text: LEGACY_DECLARED_SHAPE },
  { id: "config-placement", scope: ["pass-placement"], text: LEGACY_CONFIG_PLACEMENT },
];

// ---- parseProfileAddendum ---------------------------------------------------

describe("parseProfileAddendum", () => {
  const F = "/p/addenda/10-x.md";

  it("parses id, scope and body; the composed text is newline + verbatim body", () => {
    const a = parseProfileAddendum(F, "---\nid: my-rule\nscope: all\n---\n## My rule\nBody.\n");
    expect(a.id).toBe("my-rule");
    expect(a.scope).toBe("all");
    expect(a.text).toBe("\n## My rule\nBody.\n");
  });

  it("parses the three scope shapes", () => {
    const one = (scope: string) =>
      parseProfileAddendum(F, `---\nid: x\nscope: ${scope}\n---\nB\n`).scope;
    expect(one("all")).toBe("all");
    expect(one("lenses")).toBe("lenses");
    expect(one("pass-baseline, pass-data-safety")).toEqual(["pass-baseline", "pass-data-safety"]);
    expect(one("pass-placement")).toEqual(["pass-placement"]);
  });

  it("blank frontmatter lines are tolerated; order of keys is free", () => {
    const a = parseProfileAddendum(F, "---\nscope: lenses\n\nid: y\n---\nB\n");
    expect(a.id).toBe("y");
    expect(a.scope).toBe("lenses");
  });

  it("fails LOUDLY on every malformed shape, naming the file", () => {
    const bad: Array<[string, string, RegExp]> = [
      ["no frontmatter", "## Just a body\n", /missing frontmatter/],
      [
        "unknown key",
        "---\nid: x\nscope: all\ntitle: nope\n---\nB\n",
        /unrecognized frontmatter line/,
      ],
      ["missing id", "---\nscope: all\n---\nB\n", /missing "id:"/],
      ["missing scope", "---\nid: x\n---\nB\n", /missing "scope:"/],
      ["bad id", "---\nid: Not_Kebab\nscope: all\n---\nB\n", /must be kebab-case/],
      ["unknown scope word", "---\nid: x\nscope: everything\n---\nB\n", /unknown scope/],
      ["non-pass name in list", "---\nid: x\nscope: baseline\n---\nB\n", /unknown scope/],
      ["empty scope list", "---\nid: x\nscope: ,\n---\nB\n", /empty scope/],
      ["empty body", "---\nid: x\nscope: all\n---\n   \n", /empty body/],
      ["duplicate key", "---\nid: x\nid: y\nscope: all\n---\nB\n", /duplicate frontmatter key/],
    ];
    for (const [label, raw, re] of bad) {
      expect(() => parseProfileAddendum(F, raw), label).toThrow(re);
      expect(() => parseProfileAddendum(F, raw), `${label} names the file`).toThrow(F);
    }
  });
});

// ---- loadProfileAddenda -----------------------------------------------------

describe("loadProfileAddenda", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-profiles-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const put = (profile: string, file: string, raw: string) => {
    const dir = join(profileDir(root, profile), "addenda");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), raw);
  };
  const entry = (id: string) => `---\nid: ${id}\nscope: all\n---\nBody of ${id}.\n`;

  it('"" (no profile) loads the empty pack without touching the filesystem', () => {
    expect(loadProfileAddenda(join(root, "does-not-exist"), "")).toEqual([]);
  });

  it("a missing profile directory fails loudly, naming the profile", () => {
    expect(() => loadProfileAddenda(root, "nope", at(root))).toThrow(/profile "nope" not found/);
  });

  it("a profile without an addenda/ directory fails loudly", () => {
    mkdirSync(profileDir(root, "bare"), { recursive: true });
    expect(() => loadProfileAddenda(root, "bare", at(root))).toThrow(/has no addenda\/ directory/);
  });

  it("composes in ascending filename order and ignores non-.md files", () => {
    put("p", "20-second.md", entry("second"));
    put("p", "10-first.md", entry("first"));
    put("p", "30-third.md", entry("third"));
    writeFileSync(join(profileDir(root, "p"), "addenda", ".gitkeep"), "");
    writeFileSync(join(profileDir(root, "p"), "addenda", "README"), "not an addendum");
    expect(loadProfileAddenda(root, "p", at(root)).map((a) => a.id)).toEqual(["first", "second", "third"]);
  });

  it("a duplicate id within the pack fails loudly", () => {
    put("p", "10-a.md", entry("same"));
    put("p", "20-b.md", entry("same"));
    expect(() => loadProfileAddenda(root, "p", at(root))).toThrow(/duplicate id "same"/);
  });

  it("an id colliding with a built-in registry entry fails loudly", () => {
    put("p", "10-a.md", entry("execution-policy"));
    expect(() => loadProfileAddenda(root, "p", at(root))).toThrow(/collides with a built-in registry entry/);
  });

  it("the dynamic feedback-day addendum's id is reserved too", () => {
    expect(reservedAddendumIds().has("feedback-day-validate")).toBe(true);
    put("p", "10-a.md", entry("feedback-day-validate"));
    expect(() => loadProfileAddenda(root, "p", at(root))).toThrow(/collides/);
  });

  it("a malformed file inside an otherwise good pack fails the whole load", () => {
    put("p", "10-good.md", entry("good"));
    put("p", "20-bad.md", "## no frontmatter\n");
    expect(() => loadProfileAddenda(root, "p", at(root))).toThrow(/missing frontmatter/);
  });
});

// ---- the shipped profiles ---------------------------------------------------

describe("the shipped profiles", () => {
  it("minimal is empty — selecting it equals selecting no profile at all", () => {
    expect(loadProfileAddenda(sandbox, "minimal")).toEqual([]);
  });

  it("default is the shipped behaviour: empty pack, no heuristics, no ecosystem", () => {
    expect(loadProfileAddenda(sandbox, "default")).toEqual([]);
    expect(loadProfileHeuristics(sandbox, "default")).toEqual({ paths: {}, addedLines: {} });
    expect(loadProfileEcosystem(sandbox, "default")).toBe("none");
  });

  it("example-django parses clean: six single-lens rules, no team names inside", () => {
    const pack = loadProfileAddenda(sandbox, "example-django");
    expect(pack.map((a) => a.id)).toEqual([
      "migration-discipline",
      "new-column-nullability",
      "test-doctrine",
      "orm-usage",
      "declared-shape",
      "config-placement",
    ]);
    for (const a of pack) {
      expect(Array.isArray(a.scope), a.id).toBe(true);
      expect((a.scope as readonly string[]).length, a.id).toBe(1);
      // Sanitized: no attributions, dates, or team/product references.
      for (const leaked of [
        "the owner",
        "mhale",
        "gfrost",
        "quickchat",
        "2026-",
        "corpus",
        "this team",
      ]) {
        expect(a.text.includes(leaked), `${a.id} leaks "${leaked}"`).toBe(false);
      }
    }
  });

  it.skipIf(!HAS_QC)(
    "quickchat carries the six moved corpus rules under their original ids, in registry order",
    () => {
      const pack = loadProfileAddenda(sandbox, "quickchat");
      expect(pack.map((a) => a.id)).toEqual([...LEGACY_PACK.map((a) => a.id), ...STACK_PACK_IDS]);
      expect(pack.slice(0, LEGACY_PACK.length).map((a) => a.scope)).toEqual(
        LEGACY_PACK.map((a) => a.scope),
      );
    },
  );
});

// ---- the byte-equivalence proof ------------------------------------

describe("quickchat extraction is byte-preserving", () => {
  it.skipIf(!HAS_QC)(
    "every moved file's composed text is byte-identical to the legacy constant",
    () => {
      const pack = loadProfileAddenda(sandbox, "quickchat");
      expect(pack.length).toBe(LEGACY_PACK.length + STACK_PACK_IDS.length);
      for (let i = 0; i < LEGACY_PACK.length; i++) {
        expect(pack[i]!.text, pack[i]!.id).toBe(LEGACY_PACK[i]!.text);
      }
    },
  );

  it("the compiled-in registry no longer carries the six (diff-leftovers stays)", () => {
    const ids = PASS_ADDENDA.map((a) => a.id);
    for (const a of LEGACY_PACK) expect(ids, a.id).not.toContain(a.id);
    expect(ids).toContain("diff-leftovers");
  });

  /** Build the real agents/ seeds with a given registry; return name → bytes. */
  function build(addenda: readonly PassAddendum[]): Map<string, string> {
    const out = mkdtempSync(join(tmpdir(), "qcr-byteeq-"));
    try {
      const files = new Map<string, string>();
      for (const b of buildAgents(join(sandbox, "agents"), out, { root: sandbox, addenda })) {
        files.set(`${b.name}.md`, readFileSync(b.output, "utf8"));
      }
      return files;
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  it.skipIf(!HAS_QC)(
    "building with the quickchat pack reproduces the compiled-in constants' output byte-for-byte",
    () => {
      // The six at the tail as before;'s stack rules after them.
      const pack = loadProfileAddenda(sandbox, "quickchat");
      const expected = build([...PASS_ADDENDA, ...LEGACY_PACK, ...pack.slice(LEGACY_PACK.length)]);
      const actual = build([...PASS_ADDENDA, ...pack]);
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [name, bytes] of expected) {
        expect(actual.get(name), name).toBe(bytes);
      }
    },
  );

  it("no profile (and the minimal profile) build exactly the generic addenda set", () => {
    const bare = build(PASS_ADDENDA);
    const minimal = build([...PASS_ADDENDA, ...loadProfileAddenda(sandbox, "minimal")]);
    expect([...minimal.keys()].sort()).toEqual([...bare.keys()].sort());
    for (const [name, bytes] of bare) expect(minimal.get(name), name).toBe(bytes);
    // …and none of the moved house rules leaks into the generic build.
    for (const [name, bytes] of bare) {
      expect(bytes.includes("## Migration discipline — the team's four standing rules"), name).toBe(
        false,
      );
      expect(bytes.includes("## How this team tests"), name).toBe(false);
    }
  });

  it("the dynamic feedback-day addendum still composes LAST, after the pack", () => {
    const fb: PassAddendum = {
      id: "feedback-day-validate",
      scope: ["pass-validate"],
      text: "\n## FB-LAST\nx\n",
    };
    // The shipped pack where present (the private tree); the example pack in
    // the public snapshot — compose-last holds for any pack.
    const pack = loadProfileAddenda(sandbox, HAS_QC ? "quickchat" : "example-django");
    const files = build([...PASS_ADDENDA, ...pack, fb]);
    for (const [name, bytes] of files) {
      if (!name.startsWith("pass-validate--")) continue;
      expect(bytes.trimEnd().endsWith("## FB-LAST\nx"), name).toBe(true);
    }
  });
});

// ---- lens-selection heuristics ------------------------------------

describe("parseProfileHeuristics", () => {
  const F = "/p/heuristics.toml";

  it("compiles paths verbatim (case-sensitive) and added_lines as added-line probes", () => {
    const ext = parseProfileHeuristics(
      F,
      `[pass-security]\npaths = ['(^|/)settings[^/]*\\.py$']\n\n[pass-delivery]\nadded_lines = ['@background_decorator']\n`,
    );
    const settings = ext.paths["pass-security"]![0]!;
    expect(settings.test("project/settings_prod.py")).toBe(true);
    expect(settings.test("project/SETTINGS_prod.py")).toBe(false); // case-sensitive, like the core
    expect(settings.test("docs/settings_notes.md")).toBe(false);
    const probe = ext.addedLines["pass-delivery"]![0]!;
    expect(probe.test("@@ -1 +1,2 @@\n+@background_decorator\n def handle():")).toBe(true);
    expect(probe.test("@@ -1,2 +1 @@\n-@background_decorator\n pass")).toBe(false); // removed line: no
    expect(probe.test(" @background_decorator")).toBe(false); // context line: no
  });

  it("an empty file and an empty lens table are both legal (nothing to add)", () => {
    expect(parseProfileHeuristics(F, "")).toEqual({ paths: {}, addedLines: {} });
    expect(parseProfileHeuristics(F, "[pass-ui]\n")).toEqual({ paths: {}, addedLines: {} });
  });

  it("rejects a non-extendable lens, naming why", () => {
    expect(() => parseProfileHeuristics(F, `[pass-intent]\npaths = ['x']\n`)).toThrow(
      /not an extendable lens/,
    );
    expect(() => parseProfileHeuristics(F, `[pass-concurrency]\npaths = ['x']\n`)).toThrow(
      /addable-only/,
    );
    expect(() => parseProfileHeuristics(F, `[pass-nope]\npaths = ['x']\n`)).toThrow(/pass-nope/);
    expect(() => parseProfileHeuristics(F, `[pass-validate]\npaths = ['x']\n`)).toThrow(
      /not an extendable lens/,
    );
  });

  it("rejects unknown keys, non-arrays, non-strings, empty patterns and bad regexes — loudly", () => {
    expect(() => parseProfileHeuristics(F, `[pass-ui]\nglobs = ['x']\n`)).toThrow(
      /unknown key "globs"/,
    );
    expect(() => parseProfileHeuristics(F, `[pass-ui]\npaths = 'x'\n`)).toThrow(
      /must be an array of strings/,
    );
    expect(() => parseProfileHeuristics(F, `[pass-ui]\npaths = [1]\n`)).toThrow(
      /must be an array of strings/,
    );
    expect(() => parseProfileHeuristics(F, `[pass-ui]\npaths = ['']\n`)).toThrow(/empty pattern/);
    expect(() => parseProfileHeuristics(F, `[pass-ui]\npaths = ['(unclosed']\n`)).toThrow(
      /not a valid RegExp/,
    );
    expect(() => parseProfileHeuristics(F, `[pass-ui]\nadded_lines = ['[']\n`)).toThrow(
      /not a valid RegExp/,
    );
    expect(() => parseProfileHeuristics(F, `not toml ===`)).toThrow(/not valid TOML/);
  });
});

describe("loadProfileHeuristics", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-profiles-h-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('"" (no profile) is the empty extension without touching the filesystem', () => {
    expect(loadProfileHeuristics(join(root, "does-not-exist"), "")).toEqual({
      paths: {},
      addedLines: {},
    });
  });

  it("a missing profile directory fails loudly; an ABSENT heuristics.toml does not", () => {
    expect(() => loadProfileHeuristics(root, "nope", at(root))).toThrow(/profile "nope" not found/);
    mkdirSync(profileDir(root, "bare"), { recursive: true });
    expect(loadProfileHeuristics(root, "bare", at(root))).toEqual({ paths: {}, addedLines: {} });
  });

  it("a malformed heuristics.toml fails the load, naming the file", () => {
    mkdirSync(profileDir(root, "bad"), { recursive: true });
    writeFileSync(join(profileDir(root, "bad"), "heuristics.toml"), "[pass-ui]\npaths = ['(']\n");
    expect(() => loadProfileHeuristics(root, "bad", at(root))).toThrow(
      /heuristics\.toml.*not a valid RegExp/,
    );
  });

  it("the shipped quickchat and example-django files load and stay inside the extendable set", () => {
    for (const profile of HAS_QC ? ["quickchat", "example-django"] : ["example-django"]) {
      const ext = loadProfileHeuristics(sandbox, profile);
      for (const lens of [...Object.keys(ext.paths), ...Object.keys(ext.addedLines)]) {
        expect(PROFILE_EXTENDABLE_LENSES, `${profile}: ${lens}`).toContain(lens);
      }
    }
  });
});

// ---- the two locations --------------------------------------------
//
// A profile is looked up in the install's config home first, then in the
// checkout's `profiles/` — for the generic examples ONLY (an
// install's own profile left there is stranded, never read, until `qcr
// install migrate` moves it). Every loader resolves through the install
// locator, so these cases hold for all three — and, through `buildAgents`,
// for what the built passes actually say.
describe("profiles load from the config home, then the checkout's examples", () => {
  let dir: string;
  let root: string;
  let env: InstallEnv;
  const lookup = () => ({ env });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-profiles-home-"));
    root = join(dir, "checkout");
    env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Write a whole profile under `base/profiles/<name>/`. */
  function writeProfile(base: string, name: string, marker: string): void {
    const p = join(base, "profiles", name);
    mkdirSync(join(p, "addenda"), { recursive: true });
    writeFileSync(
      join(p, "addenda", "10-rule.md"),
      `---\nid: house-rule\nscope: pass-baseline\n---\n## ${marker}\n`,
    );
    writeFileSync(join(p, "heuristics.toml"), `[pass-security]\npaths = ['${marker}']\n`);
    writeFileSync(join(p, "profile.toml"), marker === "HOME" ? 'ecosystem = "django"\n' : "");
  }

  it("a profile only in the config home loads from there, every loader alike", () => {
    writeProfile(configHome(env), "house", "HOME");
    expect(loadProfileAddenda(root, "house", lookup()).map((a) => a.text)).toEqual(["\n## HOME\n"]);
    expect(loadProfileHeuristics(root, "house", lookup()).paths["pass-security"]?.[0]?.source).toBe(
      "HOME",
    );
    expect(loadProfileEcosystem(root, "house", lookup())).toBe("django");
  });

  it("the config home wins over a checkout profile of the same name", () => {
    writeProfile(root, "house", "CHECKOUT");
    writeProfile(configHome(env), "house", "HOME");
    expect(loadProfileAddenda(root, "house", lookup())[0]?.text).toBe("\n## HOME\n");
    expect(loadProfileEcosystem(root, "house", lookup())).toBe("django");
  });

  it("a checkout profile is never read — the not-found names it and the way out; the examples still load", () => {
    writeProfile(root, "house", "CHECKOUT");
    for (const load of [loadProfileAddenda, loadProfileHeuristics]) {
      let message = "";
      try {
        load(root, "house", lookup());
      } catch (err) {
        message = String(err);
      }
      expect(message).toMatch(/profile "house" not found/);
      expect(message).toContain(`${join(root, "profiles", "house")} is no longer read`);
      expect(message).toContain("qcr install migrate");
    }
    // …and a chain whose base is stranded fails the same way.
    writeProfile(configHome(env), "child", "HOME");
    writeFileSync(join(configHome(env), "profiles", "child", "profile.toml"), 'extends = "house"\n');
    expect(() => loadProfileAddenda(root, "child", lookup())).toThrow(
      /extends "house", which was not found.*no longer read.*qcr install migrate/,
    );
    // The shipped examples live in the checkout by design.
    expect(loadProfileAddenda(sandbox, "minimal", lookup())).toEqual([]);
    expect(loadProfileEcosystem(sandbox, "example-django", lookup())).toBe("django");
  });

  it("not found anywhere names every place it looked", () => {
    for (const load of [loadProfileAddenda, loadProfileHeuristics]) {
      let message = "";
      try {
        load(root, "nowhere", lookup());
      } catch (err) {
        message = String(err);
      }
      expect(message).toMatch(/profile "nowhere" not found/);
      expect(message).toContain(join(configHome(env), "profiles"));
      expect(message).toContain(join(root, "profiles"));
    }
    expect(loadProfileEcosystem(root, "nowhere", lookup())).toBe("none");
  });

  it("a profile name that could escape profiles/ is refused by every loader, before any read", () => {
    writeProfile(dir, "escape", "ESCAPE"); // <dir>/profiles/escape — reachable only by '..'
    for (const bad of ["../escape", "../../profiles/escape", "a/b", "..", ".hidden", "/abs"]) {
      expect(() => loadProfileAddenda(root, bad, lookup()), bad).toThrow(/not a plain name/);
      expect(() => loadProfileHeuristics(root, bad, lookup()), bad).toThrow(/not a plain name/);
      expect(() => loadProfileEcosystem(root, bad, lookup()), bad).toThrow(/not a plain name/);
    }
  });

  it("the built passes carry the config home's addenda, not the checkout's", () => {
    writeProfile(root, "house", "CHECKOUT");
    writeProfile(configHome(env), "house", "HOME");
    const out = mkdtempSync(join(tmpdir(), "qcr-profiles-build-"));
    try {
      const built = buildAgents(join(sandbox, "agents"), out, {
        root: sandbox,
        addenda: [...PASS_ADDENDA, ...loadProfileAddenda(root, "house", lookup())],
      });
      const baseline = built.filter((b) => b.name.startsWith("pass-baseline"));
      expect(baseline.length).toBeGreaterThan(0);
      for (const b of baseline) {
        const text = readFileSync(b.output, "utf8");
        expect(text, b.name).toContain("## HOME");
        expect(text, b.name).not.toContain("## CHECKOUT");
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
