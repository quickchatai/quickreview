// tests/posting-default-identity.test.ts — the `[posting]` profile section
// (bench/aacr/ext/SNAPPY-PLAN.md) changes NOTHING for a profile that does not
// set it. The hashes below were taken on the tree BEFORE the section existed
// (a67993b, "plan for a snappy profile"): the built agents and the rendered
// round orders of the shipped `default` profile, over a fixed order. Any byte
// the posting policy leaks into a default build moves one of them.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildRoundOrder } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { PASS_ADDENDA, buildAgents, configAddenda } from "../src/include.js";
import { applyProfileTuning, lensModelOverrides, lensTuningAddenda } from "../src/lenstuning.js";
import { loadProfileAddenda, loadProfileLensTuning } from "../src/profiles.js";
import type { PrStateRow } from "../src/state.js";
import { renderRoundPrompt, ROUND_TEMPLATE_FILES } from "../src/templates.js";
import type { RoundType } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import * as posting from "./helpers/posting-hooks.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

function defaultCfg(): Config {
  const cfg = structuredClone(fixture);
  cfg.review.profile = "default";
  return posting.applyPosting(
    applyProfileTuning(cfg, loadProfileLensTuning(sandbox, "default")),
    sandbox,
    "default",
  );
}

const FILES: PrFileEntry[] = [
  { filename: "src/api/orders.py", status: "modified", additions: 120, deletions: 10, changes: 130, patch: "@@ -1,3 +1,4 @@\n+import os\n def f():\n-    pass\n+    return os.environ['X']\n" },
  { filename: "src/web/App.tsx", status: "modified", additions: 40, deletions: 2, changes: 42, patch: "@@ -1 +1,2 @@\n+export const a = 1;\n" },
  { filename: "tests/test_orders.py", status: "added", additions: 30, deletions: 0, changes: 30, patch: "@@ -0,0 +1 @@\n+def test_x(): pass\n" },
] as unknown as PrFileEntry[];

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function renderedOrders(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rt, file] of Object.entries(ROUND_TEMPLATE_FILES)) {
    const order = buildRoundOrder({
      cfg,
      row: { number: 7, title: "Orders: read X", head_sha: "abc" } as unknown as PrStateRow,
      files: FILES,
      roundId: 1,
      roundNo: rt === "first" ? 1 : 3,
      reviewNo: rt === "first" ? 1 : 3,
      roundType: rt as RoundType,
      worktree: "/wt",
      settledDigest: "",
      issuedAt: "2026-10-02T00:00:00Z",
      ecosystem: NONE_ECOSYSTEM,
      prBody: "This PR reads X from the environment so that orders can be routed by region. It also adds a test and a small UI constant for the routing banner.",
    });
    out[rt] = sha(
      renderRoundPrompt(readFileSync(join(sandbox, "prompts", file), "utf8"), order, undefined, undefined, NONE_ECOSYSTEM),
    );
  }
  return out;
}

function builtAgents(cfg: Config): string {
  const dir = mkdtempSync(join(tmpdir(), "qcr-posting-identity-"));
  try {
    buildAgents(join(sandbox, "agents"), dir, {
      root: sandbox,
      tiers: cfg.models.tiers,
      riskPasses: cfg.models.risk_passes,
      validateTier: cfg.models.validate_tier,
      models: lensModelOverrides(cfg.models, cfg.lenses),
      addenda: [
        ...PASS_ADDENDA,
        ...configAddenda(cfg.review),
        ...loadProfileAddenda(sandbox, "default"),
        ...lensTuningAddenda(cfg.lenses),
        ...posting.addenda(cfg),
      ],
    });
    const h = createHash("sha256");
    for (const f of readdirSync(dir).sort()) h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
    return h.digest("hex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("[posting] — the default profile builds and renders byte-identically", () => {
  it("rendered round orders", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(renderedOrders(defaultCfg())).toEqual(GOLDEN_ORDERS);
  });
  it("with render_outputs off, the orders are the pre-2026-10 bytes", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const cfg = defaultCfg();
    cfg.review.render_outputs = false;
    // the pre-2026-10 bytes predate the duplicate merge too (round 7)
    cfg.review.dedup_merge = false;
    // … and the per-file coverage check (gap plan item 4)
    cfg.review.coverage_check = false;
    delete cfg.posting;
    expect(renderedOrders(cfg)).toEqual(GOLDEN_ORDERS_UNRENDERED);
  });
  it("built agents", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(builtAgents(defaultCfg())).toBe(GOLDEN_AGENTS);
  });
  it("with coverage_check off, the orders are the bytes from before the coverage check", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const cfg = defaultCfg();
    cfg.review.coverage_check = false;
    expect(renderedOrders(cfg)).toEqual(GOLDEN_ORDERS_NO_COVERAGE);
  });
  it("the default profile's only policy is one comment per root cause (repeat_sites = false)", () => {
    const p = defaultCfg().posting;
    expect(p).toBeDefined();
    expect(p!.repeat_sites).toBe(false);
    expect({ ...p, repeat_sites: true }).toEqual({ ...p, repeat_sites: true, max_comments: 0, nits: "post", questions: "post", body: "full", comment_style: "full" });
  });
});

// docs/duplicate-merge.md: with `[review] dedup_merge = false` and no profile
// posting policy, the orders and the agents are byte-identical to the pins
// from before the duplicate merge (2026-10-03, round 7).
describe("[review] dedup_merge = false — byte-identical to before the duplicate merge", () => {
  const noDedup = () => {
    const cfg = defaultCfg();
    cfg.review.dedup_merge = false;
    // these pins predate the per-file coverage check too (gap plan item 4)
    cfg.review.coverage_check = false;
    delete cfg.posting;
    return cfg;
  };
  it("rendered round orders", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(renderedOrders(noDedup())).toEqual(GOLDEN_ORDERS_NO_DEDUP);
  });
  it("built agents", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(builtAgents(noDedup())).toBe(GOLDEN_AGENTS_NO_DEDUP);
  });
});

// Deliberate re-pin (2026-10-02, owner order "make the review itself faster"):
// `[review] render_outputs` defaults on, so step 6 of every round carries the
// `{{render_note}}` (write the findings record first, render the body and the
// inline comments with scripts/render-review.sh). With the lever off the
// orders are byte-identical to the pre-lever pins below.
// Re-pinned 2026-10-03 (both maps): the step-6 anchor rule of the three round
// templates says "Anchor at the cause" — the line a fix would edit, the
// symptom site named in the body (round 6, mined from the Qodo run: about nine
// findings anchored on the test or caller that exposed the defect).
// Re-pinned 2026-10-03: pass-behaviour-delta is planned (one row per group of files the PR modifies or deletes code in; `[review] behaviour_delta`, freeze fixes 2) — the fixture PR modifies code, so its plan and the built agents gain the lens
// Re-pinned 2026-10-03: pass-lint-conformance agent built (planned only when a CI job runs a linter covering a changed file; freeze fixes 2)
// Re-pinned 2026-10-03: every planned lens carries its reason (the owner's 2026-10-03 planning decision); backcompat also planned on changed public signatures and wire serialization; pass-claims also on a stated behaviour; quality lenses on test-only changes (freeze fixes 2)
// Re-pinned 2026-10-03: pass-behaviour-delta planned only where base behaviour is at risk (owner decision): the fixture removes only `pass` and adds a line, so its plan no longer carries the lens
const GOLDEN_ORDERS_NO_DEDUP: Record<string, string> = {
  first: "e85a6bd6aea57afdd8979778bd784664702b99ebe1ab1817af8c2b9ae630a965",
  "re-review": "cbee3b06e368bf1ed13008e7b9b603596d6b2848ec7a5b43e119b9311bbe8f7f",
  staleness: "c78f3001aa0227d8241310a65fe355d510c310ad1d89c344c96a8b41bd059687",
};
// Re-pinned 2026-10-03 (round 7, docs/duplicate-merge.md, the owner's
// decisions): `[review] dedup_merge` defaults on, so step 4 carries the
// `{{dedup_note}}` (group candidates with `cluster_findings` before the
// validator; one comment per root cause), and the default profile sets
// `[posting] repeat_sites = false`, so the escalation line carries the
// posting-policy note. Off + no policy = GOLDEN_ORDERS_NO_DEDUP above.
// Re-pinned 2026-10-03: pass-behaviour-delta is planned (one row per group of files the PR modifies or deletes code in; `[review] behaviour_delta`, freeze fixes 2) — the fixture PR modifies code, so its plan and the built agents gain the lens
// Re-pinned 2026-10-03: pass-lint-conformance agent built (planned only when a CI job runs a linter covering a changed file; freeze fixes 2)
// Re-pinned 2026-10-03: every planned lens carries its reason (the owner's 2026-10-03 planning decision); backcompat also planned on changed public signatures and wire serialization; pass-claims also on a stated behaviour; quality lenses on test-only changes (freeze fixes 2)
// Re-pinned 2026-10-03 (gap plan item 4): `[review] coverage_check` defaults
// on and the fixture PR changes source files, so the end of step 2 carries the
// `{{coverage_note}}` (after the lenses, `coverage_gaps` lists the changed
// source files no lens raised a finding on; at most two pass-sweep rows cover
// them, each saying why). Off = GOLDEN_ORDERS_NO_COVERAGE below, the previous
// pin unchanged.
// Re-pinned 2026-10-03: pass-behaviour-delta planned only where base behaviour is at risk (owner decision): the fixture removes only `pass` and adds a line, so its plan no longer carries the lens
const GOLDEN_ORDERS: Record<string, string> = {
  first: "66a96f5b6803a4dd932047ee5d925bc37985aa7a17e7f229c148373d9dd40196",
  "re-review": "59df02e91a27712366e5615b5404b4fc91902dac92d8762d6bfb9593bc1cbe90",
  staleness: "2dac597082e3499b03b4ade4c902c28e297bcef8e0f1e3e4baffb9dc2cd04e4b",
};
// Re-pinned 2026-10-03: pass-behaviour-delta planned only where base behaviour is at risk (owner decision): the fixture removes only `pass` and adds a line, so its plan no longer carries the lens
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "d86b6e43c0cd205430ef32dc77a024b8f53946df3c31bb851881f542ef1d9098",
  "re-review": "ae720926944e7f45552617654f1b4c89f253a8740dc404d9c1332b469aaa54ec",
  staleness: "fed92fd19711669fa90ec3eb360041f8fdab0d1590f3651358d2fc2c03e87bb5",
};
// Re-pinned 2026-10-03: pass-behaviour-delta is planned (one row per group of files the PR modifies or deletes code in; `[review] behaviour_delta`, freeze fixes 2) — the fixture PR modifies code, so its plan and the built agents gain the lens
// Re-pinned 2026-10-03: pass-lint-conformance agent built (planned only when a CI job runs a linter covering a changed file; freeze fixes 2)
// Re-pinned 2026-10-03: every planned lens carries its reason (the owner's 2026-10-03 planning decision); backcompat also planned on changed public signatures and wire serialization; pass-claims also on a stated behaviour; quality lenses on test-only changes (freeze fixes 2)
// Re-pinned 2026-10-03: pass-behaviour-delta planned only where base behaviour is at risk (owner decision): the fixture removes only `pass` and adds a line, so its plan no longer carries the lens
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "0fd96d713d97c5d96b440728dfeb8223eb2b3b888a7b2188bab97c7925138be0",
  "re-review": "3624d725965f845fe005292c1b28f6bb81b7fc3ce5645ee7d82d82d76f576036",
  staleness: "e7c772cee4f784c4511998b8adb7b42924edced330913ec49c6f86ed23970462",
};
// Deliberate re-pins — the default profile's built agents changed ON PURPOSE,
// never through `[posting]` (owner-approved review changes, 2026-10-02, after
// the Martian golden mining):
//   36379ba6… (a67993b, pre-[posting]) → a9474797… the `concurrency-planned`
//   addendum (pass-concurrency planned by its content trigger)
//   → 95c8be2a… `consistency-identifiers` (pass-consistency)
//   → 5fe083e9… `validate-external-semantics`, `validate-interface-contract`,
//     `validate-masked-defect` (pass-validate)
//   → fa18446f… `tests-cannot-observe` (pass-tests) and
//     `tests-cannot-observe-validate` (pass-validate)
//   → 59d5ef67… `concurrency-duplicate-init` (pass-concurrency; round 4)
//   → ae8b406f… `write-predicate-scope` (pass-baseline, pass-data-safety; round 4)
//   → 853d0ed7… `persistence-bypasses-callbacks` (pass-baseline, pass-data-safety; round 4)
//   → ac4f9d98… `removed-rule-other-consumers` (pass-ui, pass-sweep, pass-widened; round 4)
//   → fd3982c0… `contract-values-renumbered` (pass-baseline, pass-backcompat, pass-contracts; round 4)
//   → 0721d5cc… `validate-documented-semantics` (pass-validate; round 4)
//   → e9949621… `persistence-bypasses-callbacks` names no framework (stack-neutral fence)
//   → 1b65b1fe… `quality-cap-validate`: a convention finding quoting a rule the
//     repo wrote is judged as style, not killed for its lens (round 5, mined
//     from the Qodo run: 13 written-rule violations killed "from a non-style lens")
//   → 65df59a1… `reordered-statements` (pass-baseline, pass-sweep; round 5,
//     the largest never-raised functional class in the Qodo run)
//   → 8b5461c4… `anchor-at-cause` (every lens) and `validate-anchor-at-cause`
//     (pass-validate): anchor at the line a fix would edit (round 6, Qodo run)
//   → 3c0cce3e… `line-local-slips` (pass-baseline, pass-sweep): one-token
//     operator/variable slips on changed lines (round 6, Qodo + Martian goldens)
//   → e08d36d8… `style-written-rule-checklist` (pass-style) and
//     `validate-written-rule-kept` (pass-validate): every written rule walked,
//     one grouped nit per rule; a written-rule finding is demoted, never killed
//     for its shape (round 7, the Qodo near-miss audit)
//   → 6852cb2b… `validate-convention-rule` replaces `validate-written-rule-kept`
//     (one rule: written rule → nit; CI-run lint → P2 build defect; neither →
//     style-not-in-guide), `validate-new-code-and-base`, documented semantics
//     extended to published standards (freeze fixes 2, the cross-benchmark
//     miss analysis: AACR lint kills, Qodo "base had the same gap")
//   → f36c394a… `exhaust-the-site` (pass-baseline, pass-sweep, pass-widened, pass-behaviour-delta): siblings, twins, every consequence (freeze fixes 2)
// Re-pinned 2026-10-03: pass-behaviour-delta is planned (one row per group of files the PR modifies or deletes code in; `[review] behaviour_delta`, freeze fixes 2) — the fixture PR modifies code, so its plan and the built agents gain the lens
// Re-pinned 2026-10-03: pass-lint-conformance agent built (planned only when a CI job runs a linter covering a changed file; freeze fixes 2)
// Re-pinned 2026-10-03: `sweep-mechanical-checklist` (pass-sweep; freeze fixes 2)
// Re-pinned 2026-10-03: `tests-loosened-is-behaviour` (pass-tests; freeze fixes 2)
// Re-pinned 2026-10-03: `sweep-docs-and-moves` (pass-sweep; freeze fixes 2)
// Re-pinned 2026-10-03: `no-budget` (every lens): no token, time or finding budget applies; report every real issue (gap plan, the phantom 8k budget)
// Re-pinned 2026-10-03: `repeated-copy` (pass-duplication, pass-baseline, pass-sweep) and `repeated-copy-validate`: three or more near-identical copies the PR adds are one P2 design finding, never withheld as design preference (owner decision)
// Re-pinned 2026-10-03: `regression-test-ask` (pass-tests) and `regression-test-ask-validate`: a PR that claims a bug fix with no test exercising the fixed path gets one regression-test request (owner decision)
const GOLDEN_AGENTS_NO_DEDUP = "5b4289fb6dba53fba084375ce5646b6e9d7eb803fbcf8c0a584cddd46af5852f";
//   → (round 7, docs/duplicate-merge.md) `dedup-group-validate` (pass-validate,
//     `[review] dedup_merge` on by default) and the default profile's posting
//     addendum for `repeat_sites = false`. Off + no policy = the pin above.
//   → fe4177b8… `exhaust-the-site` (pass-baseline, pass-sweep, pass-widened, pass-behaviour-delta): siblings, twins, every consequence (freeze fixes 2)
// Re-pinned 2026-10-03: pass-behaviour-delta is planned (one row per group of files the PR modifies or deletes code in; `[review] behaviour_delta`, freeze fixes 2) — the fixture PR modifies code, so its plan and the built agents gain the lens
// Re-pinned 2026-10-03: pass-lint-conformance agent built (planned only when a CI job runs a linter covering a changed file; freeze fixes 2)
// Re-pinned 2026-10-03: `sweep-mechanical-checklist` (pass-sweep; freeze fixes 2)
// Re-pinned 2026-10-03: `tests-loosened-is-behaviour` (pass-tests; freeze fixes 2)
// Re-pinned 2026-10-03: `sweep-docs-and-moves` (pass-sweep; freeze fixes 2)
// Re-pinned 2026-10-03: dedup-group-validate keeps each merged member's anchor and forbids a second fix folded into a merged body (freeze fixes 2)
// Re-pinned 2026-10-03: `no-budget` (every lens): no token, time or finding budget applies; report every real issue (gap plan, the phantom 8k budget)
// Re-pinned 2026-10-03: `repeated-copy` (pass-duplication, pass-baseline, pass-sweep) and `repeated-copy-validate`: three or more near-identical copies the PR adds are one P2 design finding, never withheld as design preference (owner decision)
// Re-pinned 2026-10-03: `regression-test-ask` (pass-tests) and `regression-test-ask-validate`: a PR that claims a bug fix with no test exercising the fixed path gets one regression-test request (owner decision)
const GOLDEN_AGENTS = "5e65f91a448953a6c88948ca4258054c4e75327dc75628949d4f3d6e1a91bf1e";
