// H4: every skill the companion registers must parse the way pi
// parses it.
//
// From 2026-10-03 to 2026-10-08 the companion had no `replay` skill. Its
// SKILL.md description was an unquoted YAML scalar containing ": " ("Strictly
// offline: it never labels a PR…"). pi's `yaml` parse threw "Nested mappings
// are not allowed in compact mappings at line 2, column 14", pi printed that
// in its start-up banner, and it skipped the skill. `skill-descriptions.test.ts`
// read the same line with a regex and passed.
//
// This file parses every SKILL.md under every directory the companion
// entrypoint registers with pi. It uses a real YAML parser
// (tests/helpers/skill-frontmatter.ts) and checks what pi 1.0.0's loader
// checks (dist/core/skills.js):
//  - a description is required, and what pi's `yaml` hands back must be a
//    string (a plain `null`, `true` or `123` is not), or the skill is SKIPPED;
//  - the name and the description length rules are warnings in the banner,
//    held to here so the banner stays clean.
// One check is stricter than pi: no comments in the block. A ` #` in a plain
// scalar starts a comment, so it cuts a description short without any error.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter, type ScalarValue } from "./helpers/skill-frontmatter.js";

const ROOT = process.cwd();
const ENTRYPOINT = readFileSync(join(ROOT, "docker/companion/entrypoint.sh"), "utf8");

/** The skill directories the entrypoint pushes into pi's `skills` setting,
 * taken from the entrypoint itself, so a third registered dir is covered the
 * day it is added. `/workspace` is this checkout, mounted. */
function registeredSkillDirs(): string[] {
  const vars = [...ENTRYPOINT.matchAll(/cfg\.skills\.push\((\w+)\)/g)].map((m) => m[1]!);
  return vars.map((v) => {
    const decl = new RegExp(`const ${v} = "/workspace/([^"]+)";`).exec(ENTRYPOINT);
    if (!decl) throw new Error(`entrypoint pushes ${v} but never declares it as a /workspace path`);
    return resolve(ROOT, decl[1]!);
  });
}

/** Every SKILL.md under a registered dir, at any depth: pi recurses until it
 * finds one, so a nested skill loads too. */
function skillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && statSync(p).isDirectory()))
      out.push(...skillFiles(p));
    else if (e.name === "SKILL.md") out.push(p);
  }
  return out;
}

const DIRS = registeredSkillDirs();
const FILES = DIRS.flatMap(skillFiles);

/**
 * Why pi would skip this SKILL.md or warn about it, as a list of problems
 * (empty = it loads cleanly). Throws, with the parser's message, when the
 * block does not parse at all. Every registered file and every negative case
 * below goes through this one function.
 */
function loadProblems(text: string, dirName: string): string[] {
  const fm = parseSkillFrontmatter(text);
  const problems: string[] = [];

  // pi falls back to the directory's name when `name` is not a string; we
  // hold the field to the directory, so a typo cannot hide behind that.
  const name = fm.fields.get("name");
  if (name?.resolvesTo !== "string") problems.push(`name is not a string (${shown(name)})`);
  else {
    if (name.value !== dirName) problems.push(`name ${name.value} is not the directory ${dirName}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name.value)) problems.push("name breaks pi's name rules");
    if (name.value.length > 64) problems.push("name over pi's 64-character limit");
  }

  // pi SKIPS the skill unless `typeof description === "string"` and it is
  // not blank. A plain `null`, `~`, `true` or `123` is not a string to pi.
  const description = fm.fields.get("description");
  if (description?.resolvesTo !== "string")
    problems.push(`description is not a string (${shown(description)})`);
  else {
    if (description.value.trim() === "") problems.push("description is empty");
    if (description.value.length > 1024) problems.push("description over pi's 1,024 limit");
  }

  if (fm.comments !== 0) problems.push("a comment in the front-matter (a ' #' in a plain value?)");

  // pi hides a skill from the model only on a real YAML boolean `true`.
  if (fm.fields.has("disable-model-invocation")) {
    const dmi = fm.fields.get("disable-model-invocation");
    if (dmi?.resolvesTo !== "boolean" || dmi.value !== "true")
      problems.push(`disable-model-invocation is not the boolean true (${shown(dmi)})`);
  }
  if (fm.body.length === 0) problems.push("no body");
  return problems;
}

function shown(v: ScalarValue | null | undefined): string {
  if (v === undefined) return "missing";
  if (v === null) return "empty or not a scalar";
  return `${v.style} ${JSON.stringify(v.value)} reads as ${v.resolvesTo}`;
}

describe("companion skill front-matter parses the way pi parses it", () => {
  it("covers both registered dirs: our own skills and the vendored set", () => {
    expect(DIRS.map((d) => relative(ROOT, d)).sort()).toEqual([
      ".claude/skills",
      "skills/companion",
    ]);
    expect(FILES.length).toBeGreaterThanOrEqual(30);
    expect(FILES.map((f) => relative(ROOT, f))).toContain("skills/companion/replay/SKILL.md");
  });

  for (const file of FILES) {
    const rel = relative(ROOT, file);
    it(`${rel} parses, and pi would load it without a warning`, () => {
      expect(loadProblems(readFileSync(file, "utf8"), rel.split("/").at(-2)!), rel).toEqual([]);
    });
  }
});

describe("the parser catches the defect classes", () => {
  // The exact front-matter replay shipped with before H4.
  const BROKEN_REPLAY =
    "---\nname: replay\ndescription: Re-run a past episode offline. Use when asked whether a tweak would still catch what humans caught. Strictly offline: it never labels a PR, never wakes a session, and never posts anything.\n---\n\n# Replaying\n";

  it("refuses an unquoted description with ': ' in it, with pi's own message", () => {
    expect(() => parseSkillFrontmatter(BROKEN_REPLAY)).toThrow(
      /Nested mappings are not allowed in compact mappings \(2:14\)/,
    );
  });

  it("reads the quoted form as the whole sentence, colon included", () => {
    const fixed = BROKEN_REPLAY.replace(/^description: (.*)$/m, 'description: "$1"');
    const d = parseSkillFrontmatter(fixed).fields.get("description")!;
    expect(d.value).toMatch(/^Re-run a past episode offline\./);
    expect(d.value).toMatch(/Strictly offline: it never labels a PR, .* never posts anything\.$/);
  });

  it("counts a comment that would cut a plain description short", () => {
    const fm = parseSkillFrontmatter(
      "---\nname: x\ndescription: Use when asked # about the backlog\n---\nbody\n",
    );
    expect(fm.fields.get("description")!.value).toBe("Use when asked");
    expect(fm.comments).toBe(1);
  });

  const skill = (front: string) => `---\nname: x\n${front}\n---\n\n# X\n`;

  it("passes a clean block, so the cases below fail for their own reason", () => {
    expect(loadProblems(skill("description: Use when asked about x."), "x")).toEqual([]);
    expect(
      loadProblems(skill("description: Use when asked.\ndisable-model-invocation: true"), "x"),
    ).toEqual([]);
  });

  // pi's `yaml` resolves these plain scalars to null, a boolean or a number,
  // and pi skips a skill whose description is not a string: the same silent
  // loss as replay's parse error, with no error at all.
  it.each([
    "null",
    "Null",
    "NULL",
    "~",
    "true",
    "False",
    "123",
    "-7",
    "+1.5",
    ".5e3",
    "0x1F",
    "0o17",
    ".inf",
    "-.Inf",
    ".NaN",
    "!!int 5",
    "",
  ])("refuses `description: %s`, which pi does not read as a string", (v) => {
    const problems = loadProblems(skill(`description: ${v}`), "x");
    expect(problems.join("\n")).toMatch(/^description is not a string/m);
  });

  // ...while the same text quoted, and the plain scalars YAML 1.2's core
  // schema leaves alone (no `_` separators, no `0b`, no 1.1 `yes`), are
  // strings to pi.
  it.each([
    '"123"',
    "'null'",
    '"true"',
    "1_000",
    "0b101",
    "yes",
    "1.2.3",
    "!!str 123",
    "Use when asked.",
  ])("reads `description: %s` as a string", (v) => {
    expect(parseSkillFrontmatter(skill(`description: ${v}`)).fields.get("description")).toEqual(
      expect.objectContaining({ resolvesTo: "string" }),
    );
  });

  it("refuses a name that is not a string, and a hide flag that is not the boolean", () => {
    expect(loadProblems("---\nname: null\ndescription: d\n---\nb\n", "x").join("\n")).toMatch(
      /^name is not a string/m,
    );
    expect(
      loadProblems(skill('description: d\ndisable-model-invocation: "true"'), "x").join("\n"),
    ).toMatch(/^disable-model-invocation is not the boolean true/m);
  });

  it("flags the comment that cut a description short", () => {
    expect(loadProblems(skill("description: Use when asked # about x"), "x")).toEqual([
      "a comment in the front-matter (a ' #' in a plain value?)",
    ]);
  });

  it("refuses a repeated key and a missing block, as pi's loader would skip them", () => {
    expect(() => parseSkillFrontmatter("---\nname: x\nname: y\n---\nb\n")).toThrow(
      /repeats the key/,
    );
    expect(() => parseSkillFrontmatter("# no front-matter\n")).toThrow(/no front-matter block/);
  });
});
