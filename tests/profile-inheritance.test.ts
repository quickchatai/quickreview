// tests/profile-inheritance.test.ts — `extends` chains and the default base
//.
//
// Every case resolves a profile the way wire.ts does (the three loaders in
// src/profiles.ts) and asserts on what the resolved profile makes the PLAN
// (`buildPassPlan`) and the BUILT AGENTS (`buildAgents`) do — never on the
// resolver's internals. The merge rules under test:
//   * addenda — base first; same id replaces in place; new id appends;
//     `[addenda] drop = [ids]` removes inherited ids (unknown ids refused);
//   * heuristics — unioned per lens;
//   * scalars (`ecosystem`) — child wins;
//   * a cycle, a missing base, a malformed `extends` — refused, loudly.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { ecosystemFor } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { PASS_ADDENDA, buildAgents } from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import {
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
} from "../src/profiles.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sandbox = join(import.meta.dirname, "..");
const cfg: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
/** The checkout the loaders search last: this repo, so the shipped
 * `profiles/default` is found exactly where production finds it. */
const root = sandbox;
const lookup = () => ({ env });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-profile-chain-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a profile into the install's config home. `addenda` maps a file name
 * to `[id, scope, marker]`; `undefined` leaves `addenda/` out entirely. */
function profile(
  name: string,
  opts: {
    toml?: string;
    addenda?: Record<string, [string, string, string]>;
    heuristics?: string;
  },
): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(p, { recursive: true });
  if (opts.toml !== undefined) writeFileSync(join(p, "profile.toml"), opts.toml);
  if (opts.addenda !== undefined) {
    mkdirSync(join(p, "addenda"), { recursive: true });
    for (const [file, [id, scope, marker]] of Object.entries(opts.addenda)) {
      writeFileSync(
        join(p, "addenda", file),
        `---\nid: ${id}\nscope: ${scope}\n---\n## ${marker}\n`,
      );
    }
  }
  if (opts.heuristics !== undefined) writeFileSync(join(p, "heuristics.toml"), opts.heuristics);
}

/** What a daemon selecting `name` would review with — wire.ts's three loads. */
function resolved(name: string) {
  return {
    addenda: loadProfileAddenda(root, name, lookup()),
    heuristics: loadProfileHeuristics(root, name, lookup()),
    ecosystem: ecosystemFor(loadProfileEcosystem(root, name, lookup())),
  };
}

/** Build the real agents/ seeds under the resolved profile: name → bytes. */
function agents(name: string): Map<string, string> {
  const out = mkdtempSync(join(tmpdir(), "qcr-profile-chain-build-"));
  try {
    const files = new Map<string, string>();
    const addenda = [...PASS_ADDENDA, ...resolved(name).addenda];
    for (const b of buildAgents(join(sandbox, "agents"), out, { root: sandbox, addenda })) {
      files.set(b.name, readFileSync(b.output, "utf8"));
    }
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The body of one built baseline variant. */
function baselineBody(name: string): string {
  const body = agents(name).get("pass-baseline--terra-med");
  if (body === undefined) throw new Error("no pass-baseline--terra-med built");
  return body;
}

function plan(name: string, files: PrFileEntry[]) {
  const r = resolved(name);
  // Unpinned (the shipped DEFAULT_PASS_TIERS would mask the ecosystem's tier gate).
  return buildPassPlan(
    { ...cfg, models: { ...cfg.models, pass_tiers: {} } },
    files,
    undefined,
    r.ecosystem,
    r.heuristics,
  );
}

const file = (filename: string, extra: Partial<PrFileEntry> = {}): PrFileEntry => ({
  filename,
  additions: 5,
  deletions: 0,
  status: "modified",
  ...extra,
});

/** A spread of diffs that exercises the tier gate, the path core, the
 * content probes and the structural lenses. */
const CORPUS: PrFileEntry[][] = [
  [file("app/migrations/0007_x.py", { status: "added" })],
  [file("web/src/App.tsx"), file("api/schema.graphql")],
  [file("app/settings_prod.py"), file("app/management/commands/sync.py")],
  [file("svc/auth/token.py", { patch: "+@lru_cache\n+def f(): pass\n" })],
  [file("infra/terraform/main.tf"), file("package.json"), file("worker/queue.py")],
  [file("app/views.py", { additions: 400, status: "added" })],
];

// ---- the default base --------------------------------------------------------

describe("the default profile", () => {
  it("ships in the checkout and resolves to the shipped behaviour", () => {
    const r = resolved("default");
    expect(r.addenda).toEqual([]);
    expect(r.heuristics).toEqual({ paths: {}, addedLines: {} });
    expect(r.ecosystem.name).toBe("none");
  });

  it(
    "an empty child of it reviews exactly as no profile does — plan and built agents",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      profile("house", { toml: 'extends = "default"\n' }); // no addenda/, no heuristics
      for (const files of CORPUS) {
        expect(plan("house", files), files[0]!.filename).toEqual(plan("", files));
        expect(plan("default", files), files[0]!.filename).toEqual(plan("", files));
      }
      const generic = agents("");
      const child = agents("house");
      expect([...child.keys()].sort()).toEqual([...generic.keys()].sort());
      for (const [name, bytes] of generic) expect(child.get(name), name).toBe(bytes);
    },
  );
});

// ---- addenda: add / replace by id / drop ------------------------------------

describe("addenda merge down the chain", () => {
  const BASE = {
    "10-a.md": ["rule-a", "pass-baseline", "RULE A (base)"],
    "20-b.md": ["rule-b", "pass-baseline", "RULE B (base)"],
    "30-c.md": ["rule-c", "pass-baseline", "RULE C (base)"],
  } satisfies Record<string, [string, string, string]>;

  it("a child inherits the base's pack, in the base's order", () => {
    profile("base", { addenda: BASE });
    profile("child", { toml: 'extends = "base"\n' });
    const body = baselineBody("child");
    const at = (m: string) => body.indexOf(`## ${m}`);
    expect(at("RULE A (base)")).toBeGreaterThan(0);
    expect(at("RULE A (base)")).toBeLessThan(at("RULE B (base)"));
    expect(at("RULE B (base)")).toBeLessThan(at("RULE C (base)"));
  });

  it("same id replaces IN PLACE, a new id appends, drop removes", () => {
    profile("base", { addenda: BASE });
    profile("child", {
      toml: 'extends = "base"\n\n[addenda]\ndrop = ["rule-c"]\n',
      addenda: {
        "10-new.md": ["rule-d", "pass-baseline", "RULE D (child)"],
        "90-b.md": ["rule-b", "pass-baseline", "RULE B (child)"],
      },
    });
    const body = baselineBody("child");
    const at = (m: string) => body.indexOf(`## ${m}`);
    expect(at("RULE B (base)")).toBe(-1);
    expect(at("RULE C (base)")).toBe(-1);
    // B' keeps B's place even though its file sorts after D's.
    expect(at("RULE A (base)")).toBeLessThan(at("RULE B (child)"));
    expect(at("RULE B (child)")).toBeLessThan(at("RULE D (child)"));
    // The scope follows the replacing entry, not the replaced one.
    expect(agents("child").get("pass-security--sol-high")).not.toContain("RULE B (child)");
  });

  it("the replacing entry's scope wins", () => {
    profile("base", { addenda: BASE });
    profile("child", {
      toml: 'extends = "base"\n',
      addenda: { "10-b.md": ["rule-b", "all", "RULE B (everywhere)"] },
    });
    const built = agents("child");
    expect(built.get("pass-validate--sol-high")).toContain("## RULE B (everywhere)");
    expect(built.get("pass-validate--sol-high")).not.toContain("## RULE A (base)");
  });

  it("dropping an id and defining it again moves it to the tail", () => {
    profile("base", { addenda: BASE });
    profile("child", {
      toml: 'extends = "base"\n[addenda]\ndrop = ["rule-a"]\n',
      addenda: { "10-a.md": ["rule-a", "pass-baseline", "RULE A (moved)"] },
    });
    const body = baselineBody("child");
    expect(body.indexOf("## RULE C (base)")).toBeLessThan(body.indexOf("## RULE A (moved)"));
  });

  it("chains of three: the grandchild sees what every ancestor left", () => {
    profile("family", { addenda: BASE });
    profile("team", {
      toml: 'extends = "family"\n[addenda]\ndrop = ["rule-a"]\n',
      addenda: { "10-t.md": ["rule-t", "pass-baseline", "RULE T (team)"] },
    });
    profile("repo", {
      toml: 'extends = "team"\n',
      addenda: { "10-c.md": ["rule-c", "pass-baseline", "RULE C (repo)"] },
    });
    const body = baselineBody("repo");
    expect(body).not.toContain("## RULE A (base)");
    expect(body).toContain("## RULE B (base)");
    expect(body).toContain("## RULE C (repo)");
    expect(body).not.toContain("## RULE C (base)");
    expect(body.indexOf("## RULE C (repo)")).toBeLessThan(body.indexOf("## RULE T (team)"));
  });

  it("a drop that names nothing inherited is refused — a typo, and a built-in alike", () => {
    profile("base", { addenda: BASE });
    profile("typo", { toml: 'extends = "base"\n[addenda]\ndrop = ["rule-z"]\n' });
    expect(() => agents("typo")).toThrow(/drop names "rule-z" — no profile it extends defines it/);
    const builtin = PASS_ADDENDA[0]!.id;
    profile("builtin", { toml: `extends = "base"\n[addenda]\ndrop = ["${builtin}"]\n` });
    expect(() => agents("builtin")).toThrow(/a built-in registry entry, which no profile can drop/);
  });

  it("[addenda] takes only drop, and drop only ids", () => {
    profile("base", { addenda: BASE });
    profile("bad-key", { toml: 'extends = "base"\n[addenda]\nadd = ["x"]\n' });
    expect(() => agents("bad-key")).toThrow(/\[addenda\] unknown key "add"/);
    profile("bad-drop", { toml: 'extends = "base"\n[addenda]\ndrop = "rule-a"\n' });
    expect(() => agents("bad-drop")).toThrow(/drop must be an array of addendum ids/);
  });

  it("a profile that extends nothing still needs its addenda/ directory", () => {
    profile("root-only", { toml: 'ecosystem = "none"\n' });
    expect(() => agents("root-only")).toThrow(/has no addenda\/ directory/);
  });
});

// ---- heuristics: union per lens ----------------------------------------------

describe("heuristics union down the chain", () => {
  it("the child's predicates add to the base's, per lens", () => {
    profile("base", {
      addenda: {},
      heuristics: "[pass-security]\npaths = ['^vault-base/']\n",
    });
    profile("child", {
      toml: 'extends = "base"\n',
      heuristics:
        "[pass-security]\npaths = ['^vault-child/']\n\n[pass-delivery]\nadded_lines = ['enqueue_later']\n",
    });
    const lenses = (name: string, files: PrFileEntry[]) =>
      plan(name, files).pass_plan.map((p) => p.lens);
    const baseFile = [file("vault-base/x.txt")];
    const childFile = [file("vault-child/x.txt")];
    const probe = [file("lib/x.txt", { patch: "+enqueue_later(job)\n" })];
    // Neither path nor probe is in the generic core…
    for (const files of [baseFile, childFile])
      expect(lenses("", files)).not.toContain("pass-security");
    expect(lenses("", probe)).not.toContain("pass-delivery");
    // …the base selects on its own path only…
    expect(lenses("base", baseFile)).toContain("pass-security");
    expect(lenses("base", childFile)).not.toContain("pass-security");
    // …and the child on both, plus its own probe.
    expect(lenses("child", baseFile)).toContain("pass-security");
    expect(lenses("child", childFile)).toContain("pass-security");
    expect(lenses("child", probe)).toContain("pass-delivery");
  });
});

// ---- scalars: child wins -------------------------------------------------------

describe("scalars: the nearest profile that sets one wins", () => {
  const migration = [file("app/migrations/0007_x.py", { status: "added" })];
  const baselineTier = (name: string) =>
    plan(name, migration).pass_plan.find((p) => p.lens === "pass-baseline")?.tier;

  it("an unset child inherits the base's ecosystem; a set one overrides it", () => {
    profile("dj", { toml: 'extends = "default"\necosystem = "django"\n' });
    profile("inherits", { toml: 'extends = "dj"\n' });
    profile("overrides", { toml: 'extends = "dj"\necosystem = "none"\n' });
    expect(baselineTier("")).toBe("terra-med");
    expect(baselineTier("dj")).toBe("sol-med"); // the django tier gate
    expect(baselineTier("inherits")).toBe("sol-med");
    expect(baselineTier("overrides")).toBe("terra-med");
  });

  it("a base naming an unknown ecosystem breaks every child, overridden or not", () => {
    profile("broken", { addenda: {}, toml: 'ecosystem = "rails"\n' });
    profile("child", { toml: 'extends = "broken"\necosystem = "none"\n' });
    expect(() => plan("child", migration)).toThrow(/profile "broken".*unknown ecosystem "rails"/);
  });
});

// ---- refusals -------------------------------------------------------------------

describe("the chain is refused, loudly, when it cannot resolve", () => {
  it("a cycle — two profiles, and a self-extend — naming the loop", () => {
    profile("a", { toml: 'extends = "b"\n' });
    profile("b", { toml: 'extends = "a"\n' });
    for (const build of [() => agents("a"), () => plan("a", CORPUS[0]!)]) {
      expect(build).toThrow(/extends cycle a → b → a/);
    }
    profile("self", { toml: 'extends = "self"\n' });
    expect(() => agents("self")).toThrow(/extends cycle self → self/);
  });

  it("a missing base names who extends it and where it looked", () => {
    profile("orphan", { toml: 'extends = "nowhere"\n' });
    for (const build of [() => agents("orphan"), () => plan("orphan", CORPUS[0]!)]) {
      expect(build).toThrow(/profile "orphan" extends "nowhere", which was not found/);
      expect(build).toThrow(join(configHome(env), "profiles"));
    }
  });

  it("extends must be a plain profile name", () => {
    profile("empty", { toml: 'extends = ""\n' });
    expect(() => agents("empty")).toThrow(/extends must be a profile name/);
    profile("number", { toml: "extends = 3\n" });
    expect(() => agents("number")).toThrow(/extends must be a profile name/);
    profile("escape", { toml: 'extends = "../escape"\n' });
    expect(() => agents("escape")).toThrow(/not a plain name/);
  });
});
