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
import { loadProfileAddenda, parseProfileAddendum, profileDir, reservedAddendumIds } from "../src/profiles.js";

const sandbox = join(import.meta.dirname, "..");

// ---- the frozen legacy constants (verbatim from legacy src/include.ts) --

const LEGACY_MIGRATION_DISCIPLINE = "[private profile text removed]";

const LEGACY_NULLABILITY_TWO_HALVES = "[private profile text removed]";

const LEGACY_TEST_DOCTRINE = "[private profile text removed]";

const LEGACY_ORM_USAGE = "[private profile text removed]";

const LEGACY_DECLARED_SHAPE = "[private profile text removed]";

const LEGACY_CONFIG_PLACEMENT = "[private profile text removed]";

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
    const one = (scope: string) => parseProfileAddendum(F, `---\nid: x\nscope: ${scope}\n---\nB\n`).scope;
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
      ["unknown key", "---\nid: x\nscope: all\ntitle: nope\n---\nB\n", /unrecognized frontmatter line/],
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
    expect(() => loadProfileAddenda(root, "nope")).toThrow(/profile "nope" not found/);
  });

  it("a profile without an addenda/ directory fails loudly", () => {
    mkdirSync(profileDir(root, "bare"), { recursive: true });
    expect(() => loadProfileAddenda(root, "bare")).toThrow(/has no addenda\/ directory/);
  });

  it("composes in ascending filename order and ignores non-.md files", () => {
    put("p", "20-second.md", entry("second"));
    put("p", "10-first.md", entry("first"));
    put("p", "30-third.md", entry("third"));
    writeFileSync(join(profileDir(root, "p"), "addenda", ".gitkeep"), "");
    writeFileSync(join(profileDir(root, "p"), "addenda", "README"), "not an addendum");
    expect(loadProfileAddenda(root, "p").map((a) => a.id)).toEqual(["first", "second", "third"]);
  });

  it("a duplicate id within the pack fails loudly", () => {
    put("p", "10-a.md", entry("same"));
    put("p", "20-b.md", entry("same"));
    expect(() => loadProfileAddenda(root, "p")).toThrow(/duplicate id "same"/);
  });

  it("an id colliding with a built-in registry entry fails loudly", () => {
    put("p", "10-a.md", entry("execution-policy"));
    expect(() => loadProfileAddenda(root, "p")).toThrow(/collides with a built-in registry entry/);
  });

  it("the dynamic feedback-day addendum's id is reserved too", () => {
    expect(reservedAddendumIds().has("feedback-day-validate")).toBe(true);
    put("p", "10-a.md", entry("feedback-day-validate"));
    expect(() => loadProfileAddenda(root, "p")).toThrow(/collides/);
  });

  it("a malformed file inside an otherwise good pack fails the whole load", () => {
    put("p", "10-good.md", entry("good"));
    put("p", "20-bad.md", "## no frontmatter\n");
    expect(() => loadProfileAddenda(root, "p")).toThrow(/missing frontmatter/);
  });
});

// ---- the shipped profiles ---------------------------------------------------

describe("the shipped profiles", () => {
  it("minimal is empty — selecting it equals selecting no profile at all", () => {
    expect(loadProfileAddenda(sandbox, "minimal")).toEqual([]);
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
      for (const leaked of ["the owner", "mhale", "gfrost", "quickchat", "2026-", "corpus", "this team"]) {
        expect(a.text.includes(leaked), `${a.id} leaks "${leaked}"`).toBe(false);
      }
    }
  });

  it("quickchat carries the six moved corpus rules under their original ids, in registry order", () => {
    const pack = loadProfileAddenda(sandbox, "quickchat");
    expect(pack.map((a) => a.id)).toEqual(LEGACY_PACK.map((a) => a.id));
    expect(pack.map((a) => a.scope)).toEqual(LEGACY_PACK.map((a) => a.scope));
  });
});

// ---- the byte-equivalence proof ------------------------------------

describe("quickchat extraction is byte-preserving", () => {
  it("every moved file's composed text is byte-identical to the legacy constant", () => {
    const pack = loadProfileAddenda(sandbox, "quickchat");
    expect(pack.length).toBe(LEGACY_PACK.length);
    for (let i = 0; i < pack.length; i++) {
      expect(pack[i]!.text, pack[i]!.id).toBe(LEGACY_PACK[i]!.text);
    }
  });

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

  it("building with the quickchat pack reproduces the compiled-in constants' output byte-for-byte", () => {
    const expected = build([...PASS_ADDENDA, ...LEGACY_PACK]);
    const actual = build([...PASS_ADDENDA, ...loadProfileAddenda(sandbox, "quickchat")]);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, bytes] of expected) {
      expect(actual.get(name), name).toBe(bytes);
    }
  });

  it("no profile (and the minimal profile) build exactly the generic addenda set", () => {
    const bare = build(PASS_ADDENDA);
    const minimal = build([...PASS_ADDENDA, ...loadProfileAddenda(sandbox, "minimal")]);
    expect([...minimal.keys()].sort()).toEqual([...bare.keys()].sort());
    for (const [name, bytes] of bare) expect(minimal.get(name), name).toBe(bytes);
    // …and none of the moved house rules leaks into the generic build.
    for (const [name, bytes] of bare) {
      expect(bytes.includes("## Migration discipline — the team's four standing rules"), name).toBe(false);
      expect(bytes.includes("## How this team tests"), name).toBe(false);
    }
  });

  it("the dynamic feedback-day addendum still composes LAST, after the pack", () => {
    const fb: PassAddendum = { id: "feedback-day-validate", scope: ["pass-validate"], text: "\n## FB-LAST\nx\n" };
    const files = build([...PASS_ADDENDA, ...loadProfileAddenda(sandbox, "quickchat"), fb]);
    for (const [name, bytes] of files) {
      if (!name.startsWith("pass-validate--")) continue;
      expect(bytes.trimEnd().endsWith("## FB-LAST\nx"), name).toBe(true);
    }
  });
});
