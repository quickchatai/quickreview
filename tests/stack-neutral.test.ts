// tests/stack-neutral.test.ts — the stack-neutral reseed (ratified on
//).
//
// Three frozen seeds (`pass-baseline`, `pass-ui`, `pass-data-safety`) carried
// one company's stack — pytest markers, Django Ninja, Tailwind tokens, lucide,
// a translation path, MySQL's ALGORITHM, Django's migration file shape — into
// every install. They were reseeded stack-neutral; the stack rules moved into
// the quickchat profile's addenda; and the two Django-only compiled addenda
// (`migration-numbering`, `django-migration-orm`) plus the round templates'
// missing-migration rule now follow the profile's ecosystem.
//
// Asserted at the seam (spec seam 2): what `buildAgents` puts in the BUILT pass
// bodies, and what `renderRoundPrompt` puts in a round order — for a generic
// install (no profile, ecosystem none) and for quickchat (its pack, django).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASS_ADDENDA, buildAgents, type PassAddendum } from "../src/include.js";
import type { EcosystemName } from "../src/ecosystem.js";
import { DJANGO_ECOSYSTEM, NONE_ECOSYSTEM } from "../src/ecosystem.js";
import { loadProfileAddenda } from "../src/profiles.js";
import { renderRoundPrompt, roundTemplateFile } from "../src/templates.js";
import type { RoundOrder, RoundType } from "../src/types.js";

const sandbox = join(import.meta.dirname, "..");
// The quickchat pack is excluded from the public snapshot; its pins self-skip.
const HAS_QC = existsSync(join(sandbox, "profiles", "quickchat"));

/** Build the real agents/ seeds; return pass name → its sol-med (or only) body. */
function build(addenda: readonly PassAddendum[], ecosystem?: EcosystemName): Map<string, string> {
  const out = mkdtempSync(join(tmpdir(), "qcr-stackneutral-"));
  try {
    const bodies = new Map<string, string>();
    for (const b of buildAgents(join(sandbox, "agents"), out, {
      root: sandbox,
      addenda,
      ...(ecosystem ? { ecosystem } : {}),
    })) {
      if (!bodies.has(b.pass) || b.tier === "sol-med")
        bodies.set(b.pass, readFileSync(b.output, "utf8"));
    }
    return bodies;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Every stack-specific rule the three seeds carried before the reseed, as the
 * phrase that carries it. A generic build contains none; quickchat's, all. */
const MOVED_RULES: Record<string, string[]> = {
  "pass-baseline": [
    "@pytest.mark.health",
    "@pytest.mark.django_db(transaction=True)",
    "select_related",
    "prefetch_related",
    '`if x:` is falsy on `""`',
    "`EXPECTED_*` constant",
    "Django Ninja (not DRF) for new endpoints",
    "Pydantic for dict↔Schema",
    "absolute imports",
  ],
  "pass-ui": [
    "bg-gray-*",
    "hsl(var(...))",
    "surface-*",
    "lucide-react",
    "standard Tailwind text sizes",
    "em/en dashes",
    "frontend/Config/app/translation/",
    "queryClient.ts",
    "react-query",
    "localStorage",
  ],
  "pass-data-safety": [
    "MySQL",
    "`INSTANT` is deploy-safe",
    "`INPLACE` still scans",
    "`COPY` write-locks through a rebuild",
    "<app>/migrations/<NNNN>_*.py",
    "master's current head for that app",
    "makemigrations --check",
    "`sqlmigrate` output",
    "single `default` database",
  ],
};

/** Words no stack-neutral lens body may carry for a generic install. */
const STACK_WORDS = [
  "Django",
  "pytest",
  "Ninja",
  "Pydantic",
  "Tailwind",
  "lucide",
  "react-query",
  "queryClient",
  "MySQL",
  "sqlmigrate",
  "ALGORITHM",
  "INSTANT",
  "makemigrations",
];

/** In a BUILT body: the generic execution policy names `pytest` among the
 * runners a pass may never start — a tooling list, not a stack rule. */
const BUILT_STACK_WORDS = STACK_WORDS.filter((w) => w !== "pytest");

describe("the reseeded seeds are stack-neutral", () => {
  it("the seed files themselves name no stack", () => {
    for (const pass of Object.keys(MOVED_RULES)) {
      const seed = readFileSync(join(sandbox, "agents", `${pass}.md`), "utf8");
      for (const word of STACK_WORDS) expect(seed, `${pass}: ${word}`).not.toContain(word);
      expect(seed, `${pass}: master`).not.toMatch(/\bmaster\b/);
    }
  });

  it("a generic install (no profile, ecosystem none) builds lenses with no stack in them", () => {
    const bodies = build(PASS_ADDENDA, "none");
    for (const [pass, phrases] of Object.entries(MOVED_RULES)) {
      const body = bodies.get(pass)!;
      for (const word of BUILT_STACK_WORDS) expect(body, `${pass}: ${word}`).not.toContain(word);
      for (const phrase of phrases) expect(body, `${pass}: ${phrase}`).not.toContain(phrase);
    }
  });

  it("the generic lenses keep every rule — stated for any stack", () => {
    const bodies = build(PASS_ADDENDA, "none");
    const baseline = bodies.get("pass-baseline")!;
    expect(baseline).toContain("Missing tests for a real feature is **P1**");
    expect(baseline).toContain("in the shape the repo's existing");
    expect(baseline).toContain("the pinned copy must be updated in the");
    expect(baseline).toContain("Judge against the conventions the repo writes down");
    const ui = bodies.get("pass-ui")!;
    expect(ui).toContain("translated in **every** locale the repo ships");
    expect(ui).toContain("HTTP through the repo's shared client");
    const ds = bodies.get("pass-data-safety")!;
    expect(ds).toContain("P1 ONLY when out of order with the base");
    expect(ds).toContain("judge by the real DDL the migration produces");
  });
});

describe("ecosystem none: no pre-check claim, no Django rule", () => {
  it("pass-data-safety carries no daemon pre-check claim and keeps the ordering class", () => {
    const ds = build(PASS_ADDENDA, "none").get("pass-data-safety")!;
    expect(ds).not.toContain("handled daemon-side");
    expect(ds).not.toMatch(/pre-check/i);
    expect(ds).not.toContain("## Django migrations: ORM first");
    // The no-exec supersession is generic and stays.
    expect(ds).toContain("## Data safety: no execution");
    // With no pre-check, nothing withdraws the lens's own ordering P1.
    expect(ds).not.toContain("That classification is withdrawn");
  });

  it("no built pass anywhere mentions the pre-check or Django", () => {
    for (const [pass, body] of build(PASS_ADDENDA, "none")) {
      expect(body, pass).not.toMatch(/pre-check/i);
      expect(body, pass).not.toContain("Django");
    }
  });

  it("the round order carries no Django rule and no gate prose", () => {
    const order: RoundOrder = {
      pr: 7,
      title: "Add a column",
      round_id: 1,
      round_no: 1,
      round_type: "first",
      lenses: ["pass-data-safety", "pass-validate"],
      pass_plan: [],
      addable_lenses: [],
      migration_gate: false,
      head_sha: "h",
      base_ref: "main",
      base_sha: "b",
      merge_base: "m",
      worktree: "/w",
      settled_digest: "",
      issued_at: "2026-09-28T10:00:00Z",
    };
    const types: RoundType[] = ["first", "re-review", "staleness"];
    for (const rt of types) {
      const text = readFileSync(join(sandbox, "prompts", roundTemplateFile(rt)), "utf8");
      const out = renderRoundPrompt(
        text,
        { ...order, round_type: rt },
        undefined,
        undefined,
        NONE_ECOSYSTEM,
      );
      expect(out, rt).not.toContain("Django");
      expect(out, rt).not.toMatch(/pre-check/i);
      expect(NONE_ECOSYSTEM.missingMigrationNote).toBe("");
    }
  });
});

describe("ecosystem django keeps today's bytes", () => {
  it("the default build IS the django build", () => {
    const defaulted = build(PASS_ADDENDA);
    const django = build(PASS_ADDENDA, "django");
    for (const [pass, body] of django) expect(defaulted.get(pass), pass).toBe(body);
  });

  it("the gated addenda compose at their registry position", () => {
    const ds = build(PASS_ADDENDA, "django").get("pass-data-safety")!;
    const at = (s: string): number => ds.indexOf(s);
    expect(
      at("## Migration numbering against the base branch is handled daemon-side"),
    ).toBeGreaterThan(0);
    expect(at("## Migration numbering against the base branch")).toBeLessThan(
      at("## Data safety: no execution"),
    );
    expect(at("## Data safety: no execution")).toBeLessThan(at("## Django migrations: ORM first"));
  });

  it("the round order's missing-migration rule is django's", () => {
    expect(DJANGO_ECOSYSTEM.missingMigrationNote).toContain("**Add on a missing migration.**");
    expect(DJANGO_ECOSYSTEM.missingMigrationNote).toContain("Django model's fields");
  });
});

describe.skipIf(!HAS_QC)("quickchat reviews lose nothing", () => {
  let bodies: Map<string, string>;
  beforeEach(() => {
    bodies = build([...PASS_ADDENDA, ...loadProfileAddenda(sandbox, "quickchat")], "django");
  });
  afterEach(() => bodies.clear());

  it("every stack rule the three seeds carried reaches its lens through the pack", () => {
    for (const [pass, phrases] of Object.entries(MOVED_RULES)) {
      const body = bodies.get(pass)!;
      for (const phrase of phrases) expect(body, `${pass}: ${phrase}`).toContain(phrase);
    }
  });

  it("the stack rules reach ONLY the lens that carried them", () => {
    for (const [pass, body] of bodies) {
      for (const heading of [
        "## This repo's stack for the baseline lens",
        "## This repo's frontend for the UI lens",
        "## This repo's database and migrations for the data-safety lens",
      ]) {
        const expected = heading.includes("baseline")
          ? "pass-baseline"
          : heading.includes("UI")
            ? "pass-ui"
            : "pass-data-safety";
        expect(body.includes(heading), `${pass}: ${heading}`).toBe(pass === expected);
      }
    }
  });

  it("the pack never re-instructs an execution the no-exec addendum withdrew", () => {
    const ds = bodies.get("pass-data-safety")!;
    expect(ds).not.toMatch(/run `sqlmigrate`/);
    // …and the Django pre-check is still the one reporting number collisions.
    expect(ds).toContain("A number collision with master is still the daemon's to report");
  });
});
