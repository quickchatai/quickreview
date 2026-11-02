// tests/security-profile.test.ts — the shipped `security` profile
// (profiles/security/): a security-only review.
//
// Every case resolves the profile the way the daemon does — src/wire.ts
// `applyProfileOverlays` over the parsed config, then the plan
// (`buildPassPlan`) with the profile's ecosystem and heuristics, and the
// built agents with the registry plus the profile's pack — and asserts on
// what the resolved profile makes the plan, the scan table and the built
// bodies do, never on the loaders' internals. The overlay mechanics
// themselves (`only`, `fold`, `plan`, `risk`) are pinned in
// tests/security-config.test.ts; this file pins that the shipped profile
// uses them as its README says.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import {
  configHome,
  EXAMPLE_PROFILES,
  homeProfileLookup,
  locateProfile,
  type InstallEnv,
} from "../src/install.js";
import { ecosystemFor } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import {
  addendaForPass,
  buildAgents,
  PASS_ADDENDA,
  SCAN_PASS,
  VALIDATE_PASS,
} from "@quickchatai/pi-quickreview/src/include.js";
import { alwaysPlannedLenses } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { ALL_PASSES, SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { postingScope, postingSecurityMax } from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import {
  applyProfileOverlays,
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  loadProfileScan,
  loadProfileThreatModel,
} from "@quickchatai/pi-quickreview/src/profiles.js";
import {
  parseThreatModel,
  threatModelEntryGlob,
  threatModelHits,
} from "@quickchatai/pi-quickreview/src/threatmodel.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sandbox = join(import.meta.dirname, "..");
/** The checkout the loaders search last: this repo, so the shipped
 * `profiles/security` is found exactly where production finds it. */
const root = sandbox;
const PROFILE = "security";
const PROFILE_DIR = join(sandbox, "profiles", PROFILE);
const fixture: Config = parseConfig(
  readFileSync(join(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
const lookup = () => homeProfileLookup(env);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-security-profile-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The fixture config reviewing under `profile`, overlaid as wire.ts does. */
function resolved(profile: string, base: Config = fixture): Config {
  return applyProfileOverlays(root, { ...base, review: { ...base.review, profile } }, lookup());
}

/** The plan a daemon reviewing under `profile` builds for `files`. */
function plan(profile: string, files: PrFileEntry[], base: Config = fixture) {
  return buildPassPlan(
    resolved(profile, base),
    files,
    { title: "Rework sign-in", body: "" },
    ecosystemFor(loadProfileEcosystem(root, profile, lookup())),
    loadProfileHeuristics(root, profile, lookup()),
  );
}

const file = (filename: string, patch: string, additions = 40): PrFileEntry =>
  ({
    filename,
    additions,
    deletions: 0,
    changes: additions,
    status: "modified",
    patch,
  }) as PrFileEntry;

/** A change wide enough to plan most of the default review: an auth path (the
 * general security lens), a paged fetch loop and an environment read (the
 * bounds sub-lens), raw SQL (data safety), a route, a test, the docs. */
const BROAD: PrFileEntry[] = [
  file(
    "src/auth/login.ts",
    "@@ -1,2 +1,8 @@\n" +
      "+export async function syncAll(url: string) {\n" +
      "+  let page = 1;\n" +
      "+  while (page) {\n" +
      "+    const r = await fetch(`${url}?page=${page}`);\n" +
      "+    page = (await r.json()).next_page;\n" +
      "+  }\n" +
      "+  return process.env.LOGIN_HOST;\n" +
      "+}\n",
    300,
  ),
  file("src/api/routes.ts", "@@ -1 +1,2 @@\n+router.get('/users/:id', getUser);\n", 120),
  file("db/queries.sql", "@@ -1 +1,2 @@\n+SELECT * FROM users WHERE id = $1;\n"),
  file("tests/login.test.ts", "@@ -1 +1,2 @@\n+it('signs in', () => {});\n"),
  file("README.md", "@@ -1 +1,2 @@\n+Sign-in now pages.\n"),
];

/** The lenses a security-only review keeps. */
const KEPT = new Set([...SECURITY_FAMILY, VALIDATE_PASS]);

/** The four lenses the profile plans on every PR that changes code or config. */
const FLOOR = [
  "pass-sec-access",
  "pass-sec-authn-coverage",
  "pass-sec-injection",
  "pass-sec-secrets-data",
];

describe("the shipped security profile", () => {
  it("is a generic example the locator finds in the checkout, and loads", () => {
    expect(EXAMPLE_PROFILES).toContain(PROFILE);
    expect(locateProfile({ root, profile: PROFILE })?.dir).toBe(PROFILE_DIR);
    const pack = loadProfileAddenda(root, PROFILE, lookup());
    expect(pack.map((a) => [a.id, a.scope, a.mode])).toEqual([
      ["scan-stage1-security", [SCAN_PASS], "scan"],
      ["validate-security-only", [VALIDATE_PASS], undefined],
    ]);
  });

  /**
   * MUTATION: set `fold = false` in profiles/security/profile.toml — fails.
   * Drop one `plan = "always"` table — the floor assertion fails.
   */
  it("resolves security-only and folded, with the four-lens floor and its own posting budget", () => {
    const cfg = resolved(PROFILE);
    expect(cfg.security).toMatchObject({ only: true, fold: true, triggers: "all" });
    for (const lens of ALL_PASSES) {
      if (KEPT.has(lens)) expect(cfg.lenses?.[lens]?.enabled, lens).not.toBe(false);
      else expect(cfg.lenses?.[lens]?.enabled, lens).toBe(false);
    }
    expect(alwaysPlannedLenses(cfg.lenses)).toEqual(FLOOR);
    for (const lens of SECURITY_FAMILY) expect(cfg.models.risk_passes, lens).toContain(lens);
    expect(postingSecurityMax(cfg.posting)).toBe(8);
    expect(postingScope(cfg.posting)).toBe("security");
  });

  /**
   * The default profile plans the general lenses on this change (the
   * control, so the absences below are not vacuous); the security profile
   * plans none of them, and cannot be asked to add one.
   *
   * MUTATION: set `only = false` in profiles/security/profile.toml — this fails.
   */
  it("plans only family rows and the validator on a broad change, and offers nothing else to add", () => {
    const control = plan("default", BROAD).pass_plan.map((p) => p.lens);
    for (const lens of ["pass-baseline", "pass-security", "pass-bounds"])
      expect(control, `control: ${lens}`).toContain(lens);

    const p = plan(PROFILE, BROAD);
    const lenses = p.pass_plan.map((r) => r.lens);
    expect(lenses).toContain(VALIDATE_PASS);
    for (const lens of lenses) expect(KEPT.has(lens), `planned: ${lens}`).toBe(true);
    for (const lens of p.addable_lenses)
      expect(SECURITY_FAMILY, `addable: ${lens}`).toContain(lens);
    for (const lens of ["pass-baseline", "pass-security", "pass-bounds"]) {
      expect(lenses, `planned: ${lens}`).not.toContain(lens);
      expect(p.addable_lenses, `addable: ${lens}`).not.toContain(lens);
    }
    // Every family row the plan carries runs at the risk tier.
    for (const row of p.pass_plan.filter((r) => SECURITY_FAMILY.includes(r.lens)))
      expect(row.tier, row.lens).toBe("sol-high");
  });

  /**
   * An install whose `[models] validate_tier` is below sol-high (a low
   * preset) still validates security findings at sol-high under this profile.
   *
   * MUTATION: delete `[lenses.pass-validate] min_tier` from
   * profiles/security/profile.toml — this fails.
   */
  it("runs the validator at sol-high whatever the install's validate_tier", () => {
    const low: Config = { ...fixture, models: { ...fixture.models, validate_tier: "sol-med" } };
    expect(
      plan("default", BROAD, low).pass_plan.find((r) => r.lens === VALIDATE_PASS)?.tier,
      "control",
    ).toBe("sol-med");
    const row = plan(PROFILE, BROAD, low).pass_plan.find((r) => r.lens === VALIDATE_PASS);
    expect(row?.tier).toBe("sol-high");
    expect(row?.agent).toBe(`${VALIDATE_PASS}--sol-high`);
  });

  /**
   * MUTATION: set `kinds = ["security"]` in profiles/security/profile.toml —
   * the scan then drops every chain and this fails.
   */
  it("scans deep with the family alone, a six-lens floor, and keeps security and chain findings", () => {
    const scan = loadProfileScan(root, PROFILE, lookup());
    expect(scan.depth).toBe("deep");
    expect([...(scan.lenses ?? [])].sort()).toEqual([...SECURITY_FAMILY].sort());
    expect(scan.deep_lenses).toEqual([
      "pass-sec-authn-coverage",
      "pass-sec-access",
      "pass-sec-injection",
      "pass-sec-boundaries",
      "pass-sec-secrets-data",
      "pass-sec-variant",
    ]);
    for (const lens of scan.deep_lenses ?? []) expect(scan.lenses, lens).toContain(lens);
    expect(scan.threat_model).toBe("auto");
    // `[scan] kinds` keeps a kind it names or a kind under it
    // (`security` keeps `security:idor`): every kind the family writes
    // (prompts/pass-sec-common.md) is kept, and nothing else.
    const keeps = (kind: string): boolean =>
      (scan.kinds ?? []).some((k) => kind === k || kind.startsWith(`${k}:`));
    for (const kind of [
      "security",
      "security:idor",
      "security:ssrf",
      "exploit-chain",
      "partial-chain",
    ])
      expect(keeps(kind), kind).toBe(true);
    for (const kind of ["bug", "concurrency", "design", "securityish"])
      expect(keeps(kind), kind).toBe(false);
  });

  // Stage 1's SUGGEST rows are how a non-floor lens joins a security scan,
  // and this addendum is the last word on where they point.
  // MUTATION: drop the `pass-sec-toctou` clause from
  // profiles/security/addenda/scan-stage1-security.md — fails.
  it("points stage 1 at every family lens outside the deep floor", () => {
    const rule = readFileSync(
      join(root, "profiles", "security", "addenda", "scan-stage1-security.md"),
      "utf8",
    );
    const where = rule.slice(rule.indexOf("**Where to point.**"));
    for (const lens of SECURITY_FAMILY.filter(
      (l) => l !== "pass-sec-variant" && l !== "pass-sec-exploit-chain",
    ))
      expect(where, lens).toContain(`\`${lens}\``);
  });

  it("binds its scan rule to stage 1 of a scan alone, and its validator rule to both builds", () => {
    const pack = loadProfileAddenda(root, PROFILE, lookup());
    const ids = (pass: string, mode: "pr" | "scan") =>
      addendaForPass(pass, pack, "none", mode).map((a) => a.id);
    expect(ids(SCAN_PASS, "scan")).toEqual(["scan-stage1-security"]);
    expect(ids(SCAN_PASS, "pr")).toEqual([]);
    expect(ids(VALIDATE_PASS, "pr")).toEqual(["validate-security-only"]);
    expect(ids(VALIDATE_PASS, "scan")).toEqual(["validate-security-only"]);
    for (const lens of SECURITY_FAMILY)
      for (const mode of ["pr", "scan"] as const) expect(ids(lens, mode), lens).toEqual([]);
  });

  /**
   * The words tests/fences.test.ts and tests/stack-neutral.test.ts keep out
   * of every built body, over this profile's composition — and its scan
   * rule, which only a scan build composes, checked as text.
   *
   * MUTATION: write "awk" into profiles/security/addenda/validate-security-only.md — fails.
   */
  it(
    "builds bodies with none of the banned words, the validator carrying the security-only rule",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const pack = loadProfileAddenda(root, PROFILE, lookup());
      const banned: ReadonlyArray<[string, RegExp]> = [
        ["NEEDS_HUMAN", /NEEDS_HUMAN/],
        ["the park", /\bpark(s|ed|ing)?\b/i],
        ["awk", /\bawk\b/],
        ["Django", /Django/],
        ["pre-check", /pre-check/i],
      ];
      for (const entry of pack) {
        for (const [what, re] of banned) expect(entry.text, `${entry.id}: ${what}`).not.toMatch(re);
        expect(entry.text, `${entry.id}: a template brace`).not.toContain("{{");
      }

      const out = mkdtempSync(join(tmpdir(), "qcr-security-profile-build-"));
      try {
        const built = buildAgents(join(sandbox, "agents"), out, {
          root: sandbox,
          addenda: [...PASS_ADDENDA, ...pack],
          ecosystem: "none",
        });
        expect(built.length, "too few variants built to be the real set").toBeGreaterThanOrEqual(
          30,
        );
        for (const b of built) {
          const body = readFileSync(b.output, "utf8");
          for (const [what, re] of banned) expect(body, `${b.name}: ${what}`).not.toMatch(re);
          const rule = "## Security findings only (security profile)";
          if (b.pass === VALIDATE_PASS) expect(body, b.name).toContain(rule);
          else expect(body, b.name).not.toContain(rule);
        }
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );
});

describe("the threat model example", () => {
  const example = readFileSync(join(PROFILE_DIR, "threat-model.example.md"), "utf8");

  it("is never read as the profile's threat model", () => {
    expect(loadProfileThreatModel(root, PROFILE, lookup())).toBeNull();
  });

  it("parses into every section, and each entry point, control and sink names a file glob", () => {
    const tm = parseThreatModel(example, "profile");
    for (const field of [
      "entryPoints",
      "personas",
      "crownJewels",
      "controls",
      "sinks",
      "network",
      "dataIsolation",
      "tokenLifetimes",
    ] as const)
      expect(tm[field].length, field).toBeGreaterThan(0);
    for (const entry of [...tm.entryPoints, ...tm.controls, ...tm.sinks])
      expect(threatModelEntryGlob(entry), entry).not.toBeNull();
    const hits = threatModelHits(tm, ["src/api/routes/users.ts", "src/auth/middleware.ts"]);
    expect(hits.entry).toEqual(["src/api/routes/**"]);
    expect(hits.control).toEqual(["src/auth/middleware.*"]);
    expect(hits.sink).toEqual([]);
  });

  /** The README's private home: a profile in the config home that extends
   * this one and carries the copied file. It inherits security-only. */
  it("copied into a child profile in the config home, is that profile's threat model", () => {
    const child = join(configHome(env), "profiles", "mine");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "profile.toml"), `extends = "${PROFILE}"\n`);
    writeFileSync(join(child, "threat-model.md"), example);
    expect(loadProfileThreatModel(root, "mine", lookup())).toBe(example);
    expect(resolved("mine").security?.only).toBe(true);
  });
});
