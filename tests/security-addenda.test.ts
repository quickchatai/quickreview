// The security addenda: the family's own-lens rule, the validator's rules for
// security candidates (the PR's words, a newly reachable sink, a cited
// refutation, evidence labels and the chain table), the scan's narrowing of
// two false-positive classes, and the two `[security] fold` entries that
// exist only when the config asks. Pinned at the seams: which passes each
// entry binds in which mode, where it composes, what the default config
// adds (nothing), and that every other lens's body is unchanged by them.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addendaForPass,
  buildAgents,
  composeAddendum,
  configAddenda,
  PASS_ADDENDA,
  SCAN_DEEP_RECALL_ADDENDUM,
  SCAN_SEC_PRECISION_ADDENDUM,
  SCAN_SEC_PRECISION_SCOPE,
  SEC_FAMILY_OWN_LENS_ADDENDUM,
  VALIDATE_PASS,
  VALIDATE_SEC_EVIDENCE_ADDENDUM,
  type PassAddendum,
} from "@quickchatai/pi-quickreview/src/include.js";
import { ALL_PASSES, SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { SECURITY_DEFAULTS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const root = resolve(process.cwd());

const REGISTRY_IDS = [
  "sec-family-own-lens",
  "validate-sec-pr-text",
  "validate-sec-newly-reachable",
  "validate-sec-variant-siblings",
  "validate-sec-refuted-cites",
  "validate-sec-evidence",
  "scan-sec-precision",
];
const FOLD_IDS = ["validate-security-fold", "scan-security-needs-review"];

/** The review config every caller's `cfg.review` stands in for. */
const REVIEW = { validate_demote: true, dedup_merge: true, validate_compact: true };
const FOLD_ON = [...PASS_ADDENDA, ...configAddenda(REVIEW, { fold: true })];

const ids = (
  p: string,
  mode: "pr" | "scan" = "pr",
  registry: readonly PassAddendum[] = PASS_ADDENDA,
  depth: "standard" | "deep" = "standard",
) => addendaForPass(p, registry, "django", mode, depth).map((a) => a.id);

/** Every pass that composes `id` in a PR build, and in a scan build. */
function boundTo(
  id: string,
  registry: readonly PassAddendum[] = PASS_ADDENDA,
): { pr: string[]; scan: string[] } {
  const of = (mode: "pr" | "scan") => ALL_PASSES.filter((p) => ids(p, mode, registry).includes(id));
  return { pr: of("pr"), scan: of("scan") };
}

const inScope = (scope: readonly string[]) => ALL_PASSES.filter((p) => scope.includes(p));

const text = (id: string, registry: readonly PassAddendum[] = FOLD_ON) =>
  registry.find((a) => a.id === id)!.text;

describe("each security addendum binds exactly its scope, in its mode", () => {
  it("the family's own-lens rule binds the fourteen family lenses, in both builds", () => {
    expect(boundTo("sec-family-own-lens")).toEqual({
      pr: [...SECURITY_FAMILY],
      scan: [...SECURITY_FAMILY],
    });
  });

  it("the validator's PR-text, refutation and evidence rules bind it alone, in both builds", () => {
    for (const id of [
      "validate-sec-pr-text",
      "validate-sec-refuted-cites",
      "validate-sec-evidence",
    ])
      expect(boundTo(id), id).toEqual({ pr: [VALIDATE_PASS], scan: [VALIDATE_PASS] });
  });

  it("the newly-reachable rule binds the validator in PR builds only — a scan has no delta", () => {
    expect(boundTo("validate-sec-newly-reachable")).toEqual({ pr: [VALIDATE_PASS], scan: [] });
  });

  // MUTATION: delete the validate-sec-variant-siblings entry from PASS_ADDENDA — this fails.
  it("the variant-siblings rule binds the validator in PR builds only, right after the newly-reachable rule it qualifies", () => {
    expect(boundTo("validate-sec-variant-siblings")).toEqual({ pr: [VALIDATE_PASS], scan: [] });
    const v = ids(VALIDATE_PASS, "pr");
    expect(v.indexOf("validate-sec-variant-siblings")).toBe(
      v.indexOf("validate-sec-newly-reachable") + 1,
    );
  });

  it("the scan's class narrowing binds the family, pass-security and the skeptic, in scan builds only", () => {
    expect(boundTo("scan-sec-precision")).toEqual({
      pr: [],
      scan: inScope(SCAN_SEC_PRECISION_SCOPE),
    });
    expect([...SCAN_SEC_PRECISION_SCOPE].sort()).toEqual(
      [...SECURITY_FAMILY, "pass-security", VALIDATE_PASS].sort(),
    );
  });

  // docs/profiles.md describes what the family does to the general security
  // lens, and must not call it unchanged while a scan build narrows its body
  // and the validator judges its candidates by the security rules.
  // MUTATION: restore "are not in the family and are unchanged." in
  // docs/profiles.md — this fails.
  it("docs/profiles.md states what changes for pass-security, as the registry binds it", () => {
    expect(ALL_PASSES).toContain("pass-security");
    expect(ids("pass-security", "pr")).not.toContain("scan-sec-precision");
    expect(ids("pass-security", "scan")).toContain("scan-sec-precision");
    const doc = readFileSync(join(root, "docs", "profiles.md"), "utf8").replace(/\s+/g, " ");
    expect(doc).not.toMatch(
      /`pass-security` and `pass-bounds` are not in the family and are unchanged/,
    );
    expect(doc).toContain(
      "The `pass-security` lens body is unchanged in PR builds; in scan builds it gains the `scan-sec-precision` narrowing",
    );
    expect(doc).toContain("Its candidates are security candidates");
  });

  // MUTATION: scope validate-security-fold to "all" — this fails (every lens
  // would carry it in a PR build).
  it("with fold on, the fold binds the validator in PR builds, the needs-review rule in scans", () => {
    expect(boundTo("validate-security-fold", FOLD_ON)).toEqual({ pr: [VALIDATE_PASS], scan: [] });
    expect(boundTo("scan-security-needs-review", FOLD_ON)).toEqual({
      pr: [],
      scan: [VALIDATE_PASS],
    });
  });

  it("the registry holds each id once, and the fold ids are never in it", () => {
    const all = PASS_ADDENDA.map((a) => a.id);
    for (const id of REGISTRY_IDS)
      expect(
        all.filter((x) => x === id),
        id,
      ).toHaveLength(1);
    for (const id of FOLD_IDS) expect(all, id).not.toContain(id);
  });
});

describe("[security] fold is the only switch, and it is off by default", () => {
  it("the default security config adds nothing — configAddenda(review) is today's list", () => {
    const today = configAddenda(REVIEW).map((a) => a.id);
    expect(today).toEqual([
      "validate-demote-not-kill",
      "dedup-group-validate",
      "validate-compact-output",
    ]);
    expect(SECURITY_DEFAULTS.fold).toBe(false);
    expect(configAddenda(REVIEW, SECURITY_DEFAULTS).map((a) => a.id)).toEqual(today);
    expect(configAddenda(REVIEW, { fold: false }).map((a) => a.id)).toEqual(today);
    expect(configAddenda({}).map((a) => a.id)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/security/)]),
    );
  });

  // MUTATION: push the two fold entries unconditionally — this fails.
  it("fold on adds exactly the two fold entries, after every other config addendum", () => {
    const off = configAddenda(REVIEW).map((a) => a.id);
    expect(configAddenda(REVIEW, { fold: true }).map((a) => a.id)).toEqual([...off, ...FOLD_IDS]);
  });

  // MUTATION: move the fold into PASS_ADDENDA ahead of validate-doubt-not-kill — this fails.
  it("the fold composes after the DOUBTED rule it qualifies, and after the registry's security rules", () => {
    const v = ids(VALIDATE_PASS, "pr", FOLD_ON);
    expect(v.indexOf("validate-security-fold")).toBeGreaterThan(
      v.indexOf("validate-doubt-not-kill"),
    );
    expect(v.indexOf("validate-security-fold")).toBeGreaterThan(v.indexOf("validate-sec-evidence"));
    expect(v.at(-1)).toBe("validate-security-fold");
    const s = ids(VALIDATE_PASS, "scan", FOLD_ON);
    expect(s.indexOf("scan-security-needs-review")).toBeGreaterThan(
      s.indexOf("scan-skeptic-validate"),
    );
    expect(s.at(-1)).toBe("scan-security-needs-review");
  });
});

describe("an unproven security candidate posts as a question only under the fold", () => {
  const SURVIVES_AS_QUESTION = /survives,? as (?:a|the) question/i;
  const validatorBody = (fold: boolean, mode: "pr" | "scan" = "pr") =>
    composeAddendum(
      VALIDATE_PASS,
      [...PASS_ADDENDA, ...configAddenda(REVIEW, fold ? { fold: true } : SECURITY_DEFAULTS)],
      "django",
      mode,
    );

  // MUTATION: restore "it survives as a question naming that gap" in
  // VALIDATE_SEC_EVIDENCE_ADDENDUM's plausible branch — this fails.
  it("with the default config, no validator rule lets a plausible security candidate survive as a question", () => {
    for (const mode of ["pr", "scan"] as const) {
      const body = validatorBody(false, mode);
      expect(body, mode).toContain(VALIDATE_SEC_EVIDENCE_ADDENDUM);
      expect(body, mode).not.toMatch(SURVIVES_AS_QUESTION);
    }
    expect(VALIDATE_SEC_EVIDENCE_ADDENDUM).toMatch(
      /one or more plausible: it is not refuted, and it is not proven either — the DOUBTED rule above holds: list it under DOUBTED with the word `unverifiable`/,
    );
    expect(text("validate-sec-refuted-cites")).toMatch(
      /its claim is `unverifiable`, never `refuted`/,
    );
  });

  // MUTATION: drop the "This covers what the security evidence rule above
  // sends to DOUBTED" paragraph from VALIDATE_SECURITY_FOLD_ADDENDUM — this fails.
  it("with fold on, the PR validator lets a plausible candidate and a one-plausible-hop chain survive as a question", () => {
    const body = validatorBody(true);
    expect(body).toMatch(SURVIVES_AS_QUESTION);
    expect(body.indexOf("one or more evidence lines labelled plausible")).toBeGreaterThan(
      body.indexOf(VALIDATE_SEC_EVIDENCE_ADDENDUM),
    );
    expect(body).toMatch(
      /exactly one plausible hop and none contradicted survives as the question/,
    );
  });
});

describe("composition order", () => {
  // MUTATION: register sec-family-own-lens before scan-deep-recall — this fails.
  it("a family lens's deep scan body carries the own-lens rule after the recall rule it narrows", () => {
    for (const lens of SECURITY_FAMILY) {
      const body = composeAddendum(lens, PASS_ADDENDA, "django", "scan", "deep");
      const recall = body.indexOf(SCAN_DEEP_RECALL_ADDENDUM);
      expect(recall, lens).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(SEC_FAMILY_OWN_LENS_ADDENDUM), lens).toBeGreaterThan(recall);
    }
  });

  it("the registry entries sit after the validator rules they qualify and ahead of the pinned tail", () => {
    const all = PASS_ADDENDA.map((a) => a.id);
    const at = REGISTRY_IDS.map((id) => all.indexOf(id));
    // contiguous, in declaration order
    expect(at).toEqual(at.map((_, i) => at[0]! + i));
    expect(at[0]).toBeGreaterThan(all.indexOf("scan-deep-recall"));
    expect(at[0]).toBeGreaterThan(all.indexOf("validate-new-code-and-base"));
    expect(at.at(-1)).toBeLessThan(all.indexOf("diff-leftovers"));
  });

  it(
    "a family lens's built PR body carries the own-lens rule; the validator's carries the evidence rule",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const bodies = build(PASS_ADDENDA);
      const family = [...bodies].filter(([name]) => name.startsWith("pass-sec-access--"));
      expect(family.length).toBeGreaterThan(0);
      for (const [name, body] of family) expect(body, name).toContain(SEC_FAMILY_OWN_LENS_ADDENDUM);
      const validators = [...bodies].filter(([name]) => name.startsWith(`${VALIDATE_PASS}--`));
      expect(validators.length).toBeGreaterThan(0);
      for (const [name, body] of validators) {
        expect(body, name).toContain(VALIDATE_SEC_EVIDENCE_ADDENDUM);
        expect(body, name).not.toContain(SCAN_SEC_PRECISION_ADDENDUM);
      }
    },
  );
});

describe("every other lens is unchanged", () => {
  const without = PASS_ADDENDA.filter((a) => !REGISTRY_IDS.includes(a.id));
  const touched = new Set([...SECURITY_FAMILY, "pass-security", VALIDATE_PASS]);

  // MUTATION: scope sec-family-own-lens to "lenses" — this fails.
  it("composes the same addenda for every pass outside the security scopes, in both builds and both depths", () => {
    for (const pass of ALL_PASSES.filter((p) => !touched.has(p))) {
      expect(composeAddendum(pass, PASS_ADDENDA), pass).toBe(composeAddendum(pass, without));
      for (const depth of ["standard", "deep"] as const)
        expect(composeAddendum(pass, PASS_ADDENDA, "django", "scan", depth), pass).toBe(
          composeAddendum(pass, without, "django", "scan", depth),
        );
    }
    // pass-security gains the class narrowing in a scan, and nothing in a review.
    expect(composeAddendum("pass-security", PASS_ADDENDA)).toBe(
      composeAddendum("pass-security", without),
    );
  });

  it(
    "the built pass-baseline bodies are byte-identical with and without the entries",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const withEntries = build(PASS_ADDENDA);
      const withoutEntries = build(without);
      const baseline = [...withEntries.keys()].filter((n) => n.startsWith("pass-baseline--"));
      expect(baseline.length).toBeGreaterThan(0);
      for (const name of baseline)
        expect(withEntries.get(name), name).toBe(withoutEntries.get(name));
    },
  );
});

describe("what the entries say", () => {
  it("every one binds only security candidates, by lens or kind", () => {
    for (const id of [...REGISTRY_IDS.filter((x) => x !== "sec-family-own-lens"), ...FOLD_IDS]) {
      const t = text(id);
      expect(t, id).toContain("security candidate");
      expect(t, id).toContain("`pass-sec-*`");
      expect(t, id).toContain("`pass-security`");
      expect(t, id).toMatch(/`kind:` begins `security`/);
    }
  });

  it("the PR's words are data, never counterevidence", () => {
    const t = text("validate-sec-pr-text");
    for (const phrase of ["already reviewed", "only a test", "dependency bump", "intended"])
      expect(t, phrase).toContain(phrase);
    expect(t).toMatch(/never the PR's words/);
  });

  it("a newly reachable pre-existing sink is in scope, anchored at the PR's hop", () => {
    const t = text("validate-sec-newly-reachable");
    expect(t).toMatch(/adds a path to it/);
    expect(t).toMatch(/removed or weakened guard/);
    expect(t).toMatch(/`out-of-scope`/);
  });

  it("a variant's sibling outside the diff is in scope, judged body-only, killed only off-pattern or off-PR", () => {
    const t = text("validate-sec-variant-siblings");
    expect(t).toContain("`pass-sec-variant`");
    expect(t).toContain("`seed:` line names a hunk of this PR");
    expect(t).toMatch(/never kill such a candidate `out-of-scope`/);
    expect(t).toMatch(/body-only finding \(no `line:`, `path:` kept\)/);
    expect(t).toMatch(/only when the seed it cites is not a hunk of this PR/);
  });

  it("refutation cites a line; absence and an absent edge control are not refutation", () => {
    const t = text("validate-sec-refuted-cites");
    expect(t).toMatch(/Absence alone is not refutation/);
    expect(t).toMatch(/A control the repository does not contain does not count/);
  });

  it("the chain table: one plausible is unverifiable, two or more is partial-chain, any contradicted refutes", () => {
    const t = text("validate-sec-evidence");
    for (const label of ["**valid**", "**plausible**", "**contradicted**"])
      expect(t, label).toContain(label);
    expect(t).toContain("| every hop valid | survives |");
    expect(t).toContain(
      "| exactly one plausible, none contradicted | DOUBTED with the word `unverifiable`, naming that hop |",
    );
    expect(t).toContain(
      "| two or more plausible, none contradicted | DOUBTED with the word `partial-chain` |",
    );
    expect(t).toContain("| any hop contradicted | `refuted`, citing the hop |");
    expect(t).toMatch(/Never merge a chain into one of its leads/);
    expect(t).toContain("security_outcome: confirmed | question | partial-chain | refuted");
    expect(t).toContain("hop_labels:");
  });

  it("the scan narrowing: a tenant or webhook sender is never the same principal; an attacker's parallel requests are never contrived", () => {
    const t = text("scan-sec-precision");
    expect(t).toMatch(/A tenant, an end user/);
    expect(t).toMatch(/webhook or callback sender/);
    expect(t).toMatch(/parallel or repeated requests/);
    // Not the scan-precision heading, which the five scan-precision lenses alone carry.
    expect(t).not.toContain("Scan precision");
  });

  it("the fold: unverifiable becomes the one downgrade security-demoted, a question naming the proof gap", () => {
    const t = text("validate-security-fold");
    expect(t).toContain("`security-demoted`");
    expect(t).toMatch(/do NOT list it under DOUBTED/);
    expect(t).toMatch(/\*\*confidence\*\*/);
    expect(t).toMatch(/proof gap/);
    expect(t).toMatch(/keep its severity/);
  });

  it("the scan fold: an unverified or uncited same-principal security candidate is needs-review", () => {
    const t = text("scan-security-needs-review");
    expect(t).toContain("`needs-review`");
    expect(t).toContain("`unverifiable`");
    expect(t).toContain("`[same-principal]`");
    expect(t).toContain("`[contrived-concurrency]`");
  });

  it("carries no stack word, no template braces, no tracker id or date", () => {
    for (const id of [...REGISTRY_IDS, ...FOLD_IDS]) {
      const t = text(id);
      expect(t, id).not.toContain("{{");
      expect(t, id).not.toContain("Django");
      expect(t, id).not.toMatch(/pre-check/i);
      expect(t, id).not.toMatch(/\bFT-\d{4}\b|\b20\d\d-\d\d-\d\d\b|#\d{4,}/);
    }
  });
});

/** Build the real agents with `addenda`; variant name → body. */
function build(addenda: readonly PassAddendum[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "qcr-sec-addenda-"));
  try {
    buildAgents(join(root, "agents"), dir, { root, addenda });
    return new Map(
      readdirSync(dir).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
