// The four identity lenses of the security family (authn-coverage, privesc,
// iam, tokens) split one territory, and the boundaries between them are
// rulings, not taste: a defect two lenses both claim is reported twice, and
// one neither claims is reported by nobody. These cases hold each split from
// both sides — the lens that owns it says so, the lens that does not points
// at the owner — and hold each lens's evidence fence to the lines it adds,
// since the base lines belong to `prompts/pass-sec-common.md` alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AGENTS = join(import.meta.dirname, "..", "agents");

const LENSES = [
  "pass-sec-authn-coverage",
  "pass-sec-privesc",
  "pass-sec-iam",
  "pass-sec-tokens",
] as const;
type Lens = (typeof LENSES)[number];

/** The lens's text with every run of whitespace folded to one space, so a
 * ruling holds however the prose is wrapped. */
const flat = (lens: Lens): string =>
  readFileSync(join(AGENTS, `${lens}.md`), "utf8").replace(/\s+/g, " ");

/** One `## ` section of a lens, folded. */
function section(lens: Lens, heading: string): string {
  const text = flat(lens);
  const start = text.indexOf(`## ${heading}`);
  expect(start, `${lens}: "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(" ## ", start + 3);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The base evidence lines every family finding carries, defined once in the
 * shared contract. */
const BASE_FIELDS = ["source", "boundary", "sink", "path", "controls", "cwe", "proof-gaps"];

/** The named lines each lens adds to the family block. */
const ADDED_FIELDS: Record<Lens, string[]> = {
  "pass-sec-authn-coverage": ["listener", "siblings", "bypass"],
  "pass-sec-privesc": ["actor", "gains", "gate", "precedent", "chain-lead"],
  "pass-sec-iam": ["gains"],
  "pass-sec-tokens": ["token", "holder", "lifetime"],
};

/** The `name:` lines inside the lens's evidence fence. */
function evidenceFields(lens: Lens): string[] {
  const raw = readFileSync(join(AGENTS, `${lens}.md`), "utf8");
  const at = raw.indexOf("## Evidence");
  expect(at, `${lens}: "## Evidence" section`).toBeGreaterThanOrEqual(0);
  const fence = /```\n([\s\S]*?)```/.exec(raw.slice(at))?.[1];
  expect(fence, `${lens}: evidence fence`).toBeDefined();
  return fence!
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => /^\s+([a-z-]+):/.exec(l)?.[1] ?? `<not a field line: ${l.trim()}>`);
}

describe("the identity lenses' evidence lines", () => {
  // MUTATION: add a `source:` line to the evidence fence of
  // agents/pass-sec-iam.md — fails.
  // MUTATION: rename `lifetime:` back to `window:` in agents/pass-sec-tokens.md — fails.
  it("add only their own named lines, never a base line", () => {
    for (const lens of LENSES) {
      const fields = evidenceFields(lens);
      expect(fields, lens).toEqual(ADDED_FIELDS[lens]);
      for (const base of BASE_FIELDS) expect(fields, `${lens}: ${base}`).not.toContain(base);
    }
  });

  // `gains:` replaced the retired `delta:` in both grant lenses; a finding with
  // nothing gained is no finding.
  // MUTATION: drop `("none" ⇒ do not emit)` from the gains line of
  // agents/pass-sec-privesc.md — fails.
  it("gate the grant lenses on a non-empty gains line", () => {
    for (const lens of ["pass-sec-privesc", "pass-sec-iam"] as const) {
      expect(section(lens, "Evidence"), lens).toMatch(/gains: [^`]*\("none" ⇒ do not emit\)/);
      expect(section(lens, "Never a finding"), lens).toContain("`gains: none`");
    }
  });
});

describe("the iam lens's database identities", () => {
  // A SECURITY DEFINER function runs only its own body with the owner's
  // privileges; EXECUTE on one confers the owner role only through a
  // steerable body.
  // MUTATION: restore "`EXECUTE` on a security-definer function owned by a
  // stronger role → that role" in agents/pass-sec-iam.md — fails.
  it("treats EXECUTE on a definer function as what its body does, unless the body can be steered", () => {
    const iam = flat("pass-sec-iam");
    expect(iam).not.toMatch(/security-definer function owned by a stronger role → that role/);
    expect(iam).toContain(
      "`EXECUTE` on a `SECURITY DEFINER` function owned by a stronger role confers only what its body does",
    );
    expect(iam).toContain("or the function lacks `SET search_path`");
    expect(iam).toContain(
      "a definer function with a pinned `search_path` and no argument-built dynamic SQL",
    );
  });
});

describe("the identity lenses' ownership splits", () => {
  // A database GRANT: a migration's is the platform grant graph, one a request
  // handler runs is the application's role model.
  // MUTATION: change "a `GRANT` run at request time is yours" to "is iam's" in
  // agents/pass-sec-privesc.md — fails.
  it("give a migration GRANT to iam and a request-time GRANT to privesc", () => {
    expect(flat("pass-sec-iam")).toContain("(`GRANT … TO` and role membership in migrations)");
    expect(section("pass-sec-iam", "Stay inside your lens")).toContain(
      "a `GRANT` the app runs per request: `pass-sec-privesc`",
    );
    const privesc = section("pass-sec-privesc", "Stay inside your lens");
    expect(privesc).toContain("a `GRANT` or role membership a migration adds: iam");
    expect(privesc).toContain("a `GRANT` run at request time is yours");
  });

  // Row-level security: switched off is a missing authentication on that table
  // (authn-coverage); a wrong predicate is object access (access).
  // MUTATION: delete "Row-level security switched off on an exposed table is
  // yours." from agents/pass-sec-authn-coverage.md — fails.
  it("give row-level security switched off to authn-coverage and its predicates to access", () => {
    const authn = section("pass-sec-authn-coverage", "Stay inside your lens");
    expect(authn).toContain("Row-level security switched off on an exposed table is yours.");
    expect(authn).toMatch(/row-level security predicates are `pass-sec-access`/);
    for (const lens of ["pass-sec-privesc", "pass-sec-iam"] as const)
      expect(section(lens, "Stay inside your lens"), lens).toMatch(
        /row-level security predicates[^.]*access/i,
      );
  });

  // A missing role gate on an authenticated grant route: privesc's, so the
  // sibling diff in authn-coverage records it as a lead, not a candidate.
  // MUTATION: drop "(that role gate is privesc's)" from the authn-coverage
  // line of prompts/pass-sec-common.md — fails.
  it("give a missing role gate on an authenticated grant route to privesc, from both sides", () => {
    const common = readFileSync(
      join(AGENTS, "..", "prompts", "pass-sec-common.md"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(common).toContain(
      "without their function-level authorization where the effect is not a grant, override or security-setting write (that role gate is privesc's)",
    );
    expect(flat("pass-sec-authn-coverage")).toContain(
      "the missing or weak role gate is `pass-sec-privesc`'s: record it as a lead, not a candidate.",
    );
    const authn = section("pass-sec-authn-coverage", "Stay inside your lens");
    expect(authn).toContain(
      "a missing or weak role gate on an authenticated grant, override or security-setting route, are `pass-sec-privesc`'s",
    );
    expect(authn).toContain("When an unauthenticated row's effect is one of those lenses' classes");
    expect(section("pass-sec-privesc", "Stay inside your lens")).toContain(
      "an authenticated route whose role gate is absent, weak or reads the wrong value is yours",
    );
  });

  // OAuth `state` is token binding, not the access lens's CSRF.
  // MUTATION: replace "CSRF other than OAuth `state`" with "CSRF" in
  // agents/pass-sec-tokens.md — fails.
  it("give OAuth state to tokens", () => {
    const tokens = flat("pass-sec-tokens");
    expect(tokens).toContain("a missing or unchecked `state` is yours, not access's CSRF");
    expect(section("pass-sec-tokens", "Never a finding")).toContain(
      "CSRF other than OAuth `state`",
    );
  });

  // A service-account token automounted with a broad role: tokens and iam both
  // hand it to infra, so exactly one lens reports it.
  // MUTATION: change the automount clause's owner to `pass-sec-iam` in
  // agents/pass-sec-tokens.md — fails.
  it("hand a broadly bound automounted service-account token to infra", () => {
    for (const lens of ["pass-sec-tokens", "pass-sec-iam"] as const)
      expect(section(lens, "Stay inside your lens"), lens).toMatch(
        /service-account token automounted into a workload whose account holds a (cited )?broad role[^.;]*`pass-sec-infra`/,
      );
  });
});
