// The security family in the plan (packages/pi-plugin/src/planner.ts): which
// pass-sec-* rows a round plans and why, how the exploit chain becomes one
// row per strategy with only `delta` required and `compose` after the wave,
// what a request and `plan = "always"` add (and never add), how a
// security-only review anchors a follow-up round, which row carries a prior
// finding when there is no baseline (packages/pi-plugin/src/priortasks.ts),
// and the security fields of the round order. Every case asserts on what the
// planner hands its consumers — rows, reasons, order fields — never on its
// internals.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";
import { DJANGO_ECOSYSTEM } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import { VALIDATE_PASS } from "@quickchatai/pi-quickreview/src/include.js";
import type { LensTuning } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { CHAIN_PASS, SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import {
  buildPassPlan,
  buildRoundOrder,
  optionalOrderOf,
  planFollowUp,
  postOrderOf,
  sweepOrderOf,
  type PassPlan,
  type PlanSecurityInputs,
} from "@quickchatai/pi-quickreview/src/planner.js";
import type { PrOwnedDeltaFile } from "@quickchatai/pi-quickreview/src/prdelta.js";
import type { PriorFinding } from "@quickchatai/pi-quickreview/src/priorfindings.js";
import { assignPriorFindings } from "@quickchatai/pi-quickreview/src/priortasks.js";
import { applyProfileSecurity } from "@quickchatai/pi-quickreview/src/profiles.js";
import type { SecurityFact } from "@quickchatai/pi-quickreview/src/secfacts.js";
import { parseThreatModel } from "@quickchatai/pi-quickreview/src/threatmodel.js";
import type {
  PassPlanEntry,
  RoundOrder,
  SecurityRequest,
} from "@quickchatai/pi-quickreview/src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const fixture: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

/** The fixture with `lenses` as its profile's per-lens tuning. */
const tuned = (lenses: Record<string, LensTuning>, base: Config = fixture): Config => ({
  ...base,
  lenses: { ...base.lenses, ...lenses },
});

/** The fixture as a security-only review resolves it (`[security] only`). */
const securityOnly = (lenses: Record<string, LensTuning> = {}): Config =>
  applyProfileSecurity(tuned(lenses), { only: true });

/** One file whose patch adds (or removes) exactly these lines. */
const changed = (filename: string, lines: string[], sign: "+" | "-" = "+"): PrFileEntry => ({
  filename,
  additions: sign === "+" ? lines.length : 0,
  deletions: sign === "-" ? lines.length : 0,
  status: "modified",
  patch: [
    `@@ -1,${lines.length + 1} +1,${lines.length + 1} @@`,
    " context",
    ...lines.map((l) => `${sign}${l}`),
  ].join("\n"),
});

/** Interpolated SQL: a strong injection trigger. */
const SQL = changed("app/repo.py", [`cur.execute(f"SELECT * FROM users WHERE name = '{name}'")`]);
/** A guard taken away: authn-coverage and the chain's `delta`. */
const UNGUARDED = changed("app/views.py", ["@login_required"], "-");
/** Ordinary code: no security trigger fires on it. */
const PLAIN = changed("app/totals.py", ["total = sum(row.amount for row in rows)"]);
const README = changed("README.md", ["Run the tests before a release."]);

const REQUEST: SecurityRequest = { by: "maintainer", source: "label" };

const plan = (cfg: Config, files: PrFileEntry[], sec: PlanSecurityInputs = {}): PassPlan =>
  buildPassPlan(cfg, files, undefined, DJANGO_ECOSYSTEM, undefined, [], [], sec);

const rows = (p: PassPlan, lens: string): PassPlanEntry[] =>
  p.pass_plan.filter((r) => r.lens === lens);
const familyRows = (p: PassPlan): PassPlanEntry[] =>
  p.pass_plan.filter((r) => SECURITY_FAMILY.includes(r.lens));

describe("a family row in the default profile", () => {
  /**
   * MUTATION: mark every family row required (drop `&& !SECURITY_FAMILY.includes(lens)`
   * from the `required` expression in buildPassPlan) — this fails.
   */
  it("plans at the risk tier on a strong trigger, says why, and is not required", () => {
    expect(fixture.security.triggers).toBe("strong");
    const p = plan(fixture, [SQL]);
    const [row, ...more] = rows(p, "pass-sec-injection");
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      agent: "pass-sec-injection--sol-high",
      tier: "sol-high",
      raisable_to: [],
    });
    expect(row!.why).toMatch(/app\/repo\.py/);
    expect(row!.required).toBeUndefined();
    // The control: a risk pass outside the family, and the baseline, stay
    // required — the expression only exempts the family.
    expect(rows(p, "pass-baseline")[0]?.required).toBe(true);
    const risky = plan(fixture, [changed("auth/permissions.py", ["ROLES = ['admin']"])]);
    expect(rows(risky, "pass-security")[0]?.required).toBe(true);
  });

  it("plans nothing of the family on ordinary code or a docs change", () => {
    for (const files of [[PLAIN], [README]]) {
      const p = plan(fixture, files);
      expect(familyRows(p)).toEqual([]);
      expect(p.post_plan).toBeUndefined();
    }
  });

  it('is left out when [security] triggers = "off"', () => {
    const off: Config = { ...fixture, security: { ...fixture.security, triggers: "off" } };
    expect(familyRows(plan(off, [SQL, UNGUARDED]))).toEqual([]);
  });
});

describe("the exploit chain: one row per strategy", () => {
  /**
   * MUTATION: push the `compose` row into pass_plan instead of post_plan —
   * this fails: `compose` must never be a discovery row the wave launches.
   */
  it("plans delta (required), forward and backward in the plan, and compose after the wave", () => {
    const p = plan(fixture, [PLAIN], { securityRequest: REQUEST });
    const chain = rows(p, CHAIN_PASS);
    expect(chain.map((r) => r.strategy)).toEqual(["delta", "forward", "backward"]);
    for (const r of chain) {
      expect(r.agent).toBe(`${CHAIN_PASS}--sol-high`);
      expect(r.stage).toBeUndefined();
      expect(r.why).toMatch(new RegExp(`^${r.strategy}: `));
    }
    for (const r of chain) expect(r.required === true, r.strategy).toBe(r.strategy === "delta");
    expect(p.pass_plan.some((r) => r.strategy === "compose")).toBe(false);
    expect(p.post_plan).toEqual([
      expect.objectContaining({
        lens: CHAIN_PASS,
        agent: `${CHAIN_PASS}--sol-high`,
        strategy: "compose",
        stage: "post-discovery",
      }),
    ]);
    expect(p.post_plan![0]!.required).toBeUndefined();
    // Planned, so not offered to add again.
    expect(p.addable_lenses).not.toContain(CHAIN_PASS);
  });

  it("a removed guard plans the chain's delta, which names the guard, and compose", () => {
    const p = plan(fixture, [UNGUARDED]);
    expect(rows(p, "pass-sec-authn-coverage")).toHaveLength(1);
    const chain = rows(p, CHAIN_PASS);
    expect(chain.map((r) => r.strategy)).toEqual(["delta"]);
    expect(chain[0]!.why).toMatch(/^delta: .*guard/);
    expect(chain[0]!.required).toBe(true);
    expect(p.post_plan?.map((r) => r.strategy)).toEqual(["compose"]);
  });

  it("one class lens alone plans no chain row, and compose still reads its leads", () => {
    const p = plan(fixture, [SQL]);
    expect(rows(p, CHAIN_PASS)).toEqual([]);
    expect(p.post_plan?.map((r) => r.strategy)).toEqual(["compose"]);
  });

  it("a switched-off chain lens plans no strategy row and no compose", () => {
    const p = plan(tuned({ [CHAIN_PASS]: { enabled: false } }), [UNGUARDED], {
      securityRequest: REQUEST,
    });
    expect(rows(p, CHAIN_PASS)).toEqual([]);
    expect(p.post_plan).toBeUndefined();
    expect(rows(p, "pass-sec-authn-coverage")).toHaveLength(1);
  });

  /**
   * MUTATION: drop the security-only `delta` rule in buildPassPlan — the
   * only-mode plan below loses its delta row and this fails.
   */
  it("in a security-only review, two planned family rows are enough for a delta", () => {
    const floor: Record<string, LensTuning> = {
      "pass-sec-access": { plan: "always" },
      "pass-sec-injection": { plan: "always" },
    };
    const only = plan(securityOnly(floor), [PLAIN]);
    expect(rows(only, "pass-sec-access")).toHaveLength(1);
    expect(rows(only, "pass-sec-injection")).toHaveLength(1);
    const chain = rows(only, CHAIN_PASS);
    expect(chain.map((r) => r.strategy)).toEqual(["delta"]);
    expect(chain[0]!.why).toMatch(/security-only review planned 2 security lenses/);
    // The control: the same floor in the default review plans no delta.
    const mixed = plan(tuned(floor), [PLAIN]);
    expect(rows(mixed, "pass-sec-access")).toHaveLength(1);
    expect(rows(mixed, CHAIN_PASS)).toEqual([]);
  });
});

describe("a request", () => {
  /**
   * MUTATION: plan the requested family after the `on()`/`skip` filters —
   * pass-sec-llm and pass-sec-variant come back and this fails.
   */
  it("plans the whole family, naming who asked, but never a lens switched off or skipped", () => {
    const cfg: Config = {
      ...tuned({ "pass-sec-llm": { enabled: false } }),
      review: { ...fixture.review, skip_lenses: ["pass-sec-variant"] },
    };
    const p = plan(cfg, [PLAIN], { securityRequest: REQUEST });
    const planned = new Set(familyRows(p).map((r) => r.lens));
    for (const lens of SECURITY_FAMILY) {
      if (lens === "pass-sec-llm" || lens === "pass-sec-variant") {
        expect(planned.has(lens), lens).toBe(false);
        expect(p.addable_lenses, lens).not.toContain(lens);
      } else expect(planned.has(lens), lens).toBe(true);
    }
    expect(rows(p, "pass-sec-access")[0]!.why).toMatch(/requested by @maintainer with a PR label/);
    for (const r of familyRows(p))
      expect(r.required === true, `${r.lens}:${r.strategy ?? ""}`).toBe(r.strategy === "delta");
  });

  it("keeps a trigger's own reason over the request's", () => {
    const p = plan(fixture, [SQL], { securityRequest: REQUEST });
    expect(rows(p, "pass-sec-injection")[0]!.why).toMatch(/app\/repo\.py/);
  });
});

describe('[lenses.<pass>] plan = "always"', () => {
  /**
   * MUTATION: drop `...family` (or the `always` set) from the plan's union —
   * this fails.
   */
  it("plans the lens on a change with code, and not on a docs-only change", () => {
    const cfg = tuned({
      "pass-sec-access": { plan: "always" },
      "pass-concurrency": { plan: "always" },
    });
    const p = plan(cfg, [PLAIN]);
    expect(rows(p, "pass-sec-access")).toHaveLength(1);
    expect(rows(p, "pass-sec-access")[0]!.why).toMatch(/plan = "always"/);
    expect(rows(p, "pass-concurrency")).toHaveLength(1);
    const docs = plan(cfg, [README]);
    expect(rows(docs, "pass-sec-access")).toEqual([]);
    expect(rows(docs, "pass-concurrency")).toEqual([]);
  });

  it("never plans a lens the profile switched off", () => {
    const cfg = tuned({ "pass-sec-access": { plan: "always", enabled: false } });
    expect(rows(plan(cfg, [PLAIN]), "pass-sec-access")).toEqual([]);
  });
});

// ---- follow-up rounds ----------------------------------------------------------

const deltaFile = (f: PrFileEntry): PrOwnedDeltaFile => ({
  path: f.filename,
  status: "modified",
  additions: f.additions,
  deletions: f.deletions,
  ranges: [[1, f.additions + f.deletions]],
  whole_file: false,
  patch: f.patch ?? "",
});

/** A follow-up round over a PR of `files` (each padded to 200 lines, so the
 * small delta stays under the ratio) whose fix push is `delta`. */
function followUp(cfg: Config, files: PrFileEntry[], delta: PrFileEntry[]) {
  const whole = files.map((f) => ({ ...f, additions: 200 }));
  const dfiles = delta.map(deltaFile);
  return planFollowUp(cfg, undefined, {
    delta: {
      ok: true,
      tree: "t".repeat(40),
      files: dfiles,
      lines: dfiles.reduce((n, f) => n + f.additions + f.deletions, 0),
      conflicted: [],
    },
    fromSha: "a".repeat(40),
    files: whole,
    fullPlan: plan(cfg, whole),
    ecosystem: DJANGO_ECOSYSTEM,
    styleGuide: [],
    ciLinters: [],
    sweepOwed: () => false,
  });
}

describe("a follow-up round's anchor", () => {
  /**
   * MUTATION: accept a security-only delta plan with no family row (drop the
   * `anchor-unplanned` return in planFollowUp) — this fails.
   */
  it("in a security-only review is a family row: a delta that plans none runs in full", () => {
    const cfg = securityOnly();
    const none = followUp(cfg, [SQL, PLAIN], [PLAIN]);
    expect(none).toMatchObject({ kind: "full", reason: "anchor-unplanned" });

    const some = followUp(cfg, [SQL, PLAIN], [SQL]);
    expect(some.kind).toBe("delta");
    if (some.kind !== "delta") return;
    expect(rows(some.decision.plan, "pass-baseline")).toEqual([]);
    expect(familyRows(some.decision.plan).length).toBeGreaterThan(0);
  });

  it("outside it is still pass-baseline, under the reason it always had", () => {
    const cfg = tuned({ "pass-baseline": { enabled: false } });
    expect(followUp(cfg, [SQL, PLAIN], [SQL])).toMatchObject({
      kind: "full",
      reason: "baseline-unplanned",
    });
  });

  it("plans the delta with the same request the full plan had", () => {
    const cfg = securityOnly();
    const whole = [SQL, PLAIN].map((f) => ({ ...f, additions: 200 }));
    const r = planFollowUp(cfg, undefined, {
      delta: {
        ok: true,
        tree: "t".repeat(40),
        files: [deltaFile(PLAIN)],
        lines: 1,
        conflicted: [],
      },
      fromSha: "a".repeat(40),
      files: whole,
      fullPlan: plan(cfg, whole, { securityRequest: REQUEST }),
      ecosystem: DJANGO_ECOSYSTEM,
      styleGuide: [],
      ciLinters: [],
      sweepOwed: () => false,
      securityRequest: REQUEST,
    });
    expect(r.kind).toBe("delta");
    if (r.kind !== "delta") return;
    const planned = new Set(familyRows(r.decision.plan).map((p) => p.lens));
    expect(planned).toEqual(new Set(SECURITY_FAMILY));
  });
});

describe("a prior finding's owner without a baseline row", () => {
  const prior = (lens: string, path: string): PriorFinding => ({
    ref: `1:${lens}-${path}`,
    round_no: 1,
    finding_key: `${lens}-${path}`,
    origin_round: 1,
    earlier_refs: [],
    head_sha: "b".repeat(40),
    path,
    line: 3,
    posted_as: "blocker",
    severity: "P1",
    lens,
    lens_ids: [lens],
    title: "a finding",
    thread_id: null,
    blocking: true,
    last_status: null,
    last_status_round: null,
    last_evidence: null,
    reason: null,
    evidence: null,
  });
  const row = (lens: string, strategy?: PassPlanEntry["strategy"]): PassPlanEntry => ({
    lens,
    agent: `${lens}--sol-high`,
    tier: "sol-high",
    raisable_to: [],
    ...(strategy ? { strategy } : {}),
  });

  /**
   * MUTATION: drop the family fallback in assignPriorFindings — the
   * baseline finding below is left unassigned and this fails.
   */
  it("is the first security-family class row, never the chain's or the validator's", () => {
    const plan = [row(CHAIN_PASS, "delta"), row("pass-sec-access"), row(VALIDATE_PASS)];
    const assigned = assignPriorFindings(
      { round_no: 2, findings: [prior("pass-baseline", "app/a.py")] },
      plan,
      new Set(["app/a.py"]),
    );
    expect(assigned.map((a) => a.row)).toEqual([1]);
  });

  it("is still pass-baseline when the plan has one", () => {
    const plan = [row("pass-sec-access"), row("pass-baseline")];
    const assigned = assignPriorFindings(
      { round_no: 2, findings: [prior("pass-tests", "app/a.py")] },
      plan,
      new Set(),
    );
    expect(assigned.map((a) => a.row)).toEqual([1]);
  });
});

// ---- the round order -----------------------------------------------------------

function order(
  cfg: Config,
  files: PrFileEntry[],
  extra: Partial<Parameters<typeof buildRoundOrder>[0]> = {},
): RoundOrder {
  return buildRoundOrder({
    cfg,
    row: { number: 7, head_sha: "c".repeat(40), title: "Rework the search" },
    files,
    roundId: 1,
    roundNo: 1,
    roundType: "first",
    worktree: "/wt",
    settledDigest: "",
    issuedAt: "2026-11-01T00:00:00Z",
    ...extra,
  });
}

const SECURITY_ORDER_FIELDS = [
  "post_plan",
  "post_task_files",
  "chain_compose",
  "security_fold",
  "security_only",
  "security_validator_agent",
  "threat_model",
  "threat_model_excerpt",
  "security_facts",
  "security_request",
  "prior_partial_chains",
] as const;

const lowValidator: Config = {
  ...fixture,
  models: { ...fixture.models, validate_tier: "sol-med" },
};

describe("the round order's security fields", () => {
  it("are absent when no family row is planned", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const o = order(lowValidator, [PLAIN]);
    for (const k of SECURITY_ORDER_FIELDS) expect(o, k).not.toHaveProperty(k);
  });

  /**
   * MUTATION: drop the `security_validator_agent` assignment in
   * buildRoundOrder — this fails.
   */
  it("raise the security validator beside a family row", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const o = order(lowValidator, [SQL]);
    expect(o.security_validator_agent).toBe(`${VALIDATE_PASS}--sol-high`);
    expect(o.pass_plan.find((r) => r.lens === VALIDATE_PASS)?.tier).toBe("sol-med");
    expect(order(lowValidator, [PLAIN]).security_validator_agent).toBeUndefined();
    // Already at the risk tier: nothing to raise.
    expect(order(fixture, [SQL]).security_validator_agent).toBeUndefined();
  });

  it("carry compose, the fold and the security-only flag", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const cfg: Config = { ...fixture, security: { ...fixture.security, fold: true, only: true } };
    const o = order(cfg, [UNGUARDED]);
    expect(o.post_plan?.map((r) => r.strategy)).toEqual(["compose"]);
    expect(o.chain_compose).toBe(true);
    expect(o.security_fold).toBe(true);
    expect(o.security_only).toBe(true);
    expect(o.lenses).toContain(CHAIN_PASS);
    expect(o.pass_plan.some((r) => r.stage === "post-discovery")).toBe(false);
  });

  it("carry the threat model and facts beside a family row", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const threatModel = parseThreatModel("## Entry points\n- `app/api/**`\n", "repo");
    const fact: SecurityFact = {
      check: "route-inventory",
      status: "unknown",
      lens: "pass-sec-authn-coverage",
      detail: "the repository could not be listed",
    };
    const extra = {
      threatModel,
      securityFacts: [fact],
      priorPartialChains: ["L1 app/views.py:3 → L2 app/repo.py:9 (two hops unproven)"],
    };
    const o = order(fixture, [UNGUARDED], extra);
    expect(o.threat_model).toEqual({ source: "repo", hash: threatModel.hash });
    expect(o.threat_model_excerpt).toContain("Threat model");
    expect(o.security_facts).toEqual([fact]);
    expect(o.prior_partial_chains).toEqual(extra.priorPartialChains);

    const plain = order(fixture, [PLAIN], extra);
    for (const k of ["threat_model", "threat_model_excerpt", "security_facts"])
      expect(plain, k).not.toHaveProperty(k);
    expect(plain).not.toHaveProperty("prior_partial_chains");
  });

  it("name the request", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const o = order(fixture, [PLAIN], { securityRequest: REQUEST });
    expect(o.security_request).toEqual(REQUEST);
    expect(o.lenses).toEqual(expect.arrayContaining([...SECURITY_FAMILY]));
  });
});

describe("the post-discovery rows' own order", () => {
  it("plans them alone; no derived order carries them", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const o = order(fixture, [UNGUARDED]);
    const post = postOrderOf(o, o.post_plan!);
    expect(post.pass_plan).toEqual(o.post_plan);
    expect(post.lenses).toEqual([CHAIN_PASS]);
    expect(post).not.toHaveProperty("post_plan");
    expect(post).not.toHaveProperty("prior_assignments");
    expect(sweepOrderOf(o, o.pass_plan)).not.toHaveProperty("post_plan");
    expect(optionalOrderOf(o, [])).not.toHaveProperty("post_plan");
    expect(optionalOrderOf(o, [])).not.toHaveProperty("chain_compose");
  });
});
