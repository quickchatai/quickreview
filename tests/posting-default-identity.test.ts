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
  {
    filename: "src/api/orders.py",
    status: "modified",
    additions: 120,
    deletions: 10,
    changes: 130,
    patch: "@@ -1,3 +1,4 @@\n+import os\n def f():\n-    pass\n+    return os.environ['X']\n",
  },
  {
    filename: "src/web/App.tsx",
    status: "modified",
    additions: 40,
    deletions: 2,
    changes: 42,
    patch: "@@ -1 +1,2 @@\n+export const a = 1;\n",
  },
  {
    filename: "tests/test_orders.py",
    status: "added",
    additions: 30,
    deletions: 0,
    changes: 30,
    patch: "@@ -0,0 +1 @@\n+def test_x(): pass\n",
  },
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
      prBody:
        "This PR reads X from the environment so that orders can be routed by region. It also adds a test and a small UI constant for the routing banner.",
    });
    out[rt] = sha(
      renderRoundPrompt(
        readFileSync(join(sandbox, "prompts", file), "utf8"),
        order,
        undefined,
        undefined,
        NONE_ECOSYSTEM,
      ),
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
    for (const f of readdirSync(dir).sort())
      h.update(f)
        .update("\0")
        .update(readFileSync(join(dir, f)))
        .update("\0");
    return h.digest("hex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("[posting] — the default profile builds and renders byte-identically", () => {
  it("rendered round orders", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(renderedOrders(defaultCfg())).toEqual(GOLDEN_ORDERS);
  });
  it(
    "with render_outputs off, the orders are the pre-2026-10 bytes",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const cfg = defaultCfg();
      cfg.review.render_outputs = false;
      // the pre-2026-10 bytes predate the duplicate merge too (round 7)
      cfg.review.dedup_merge = false;
      // … and the per-file coverage check (gap plan item 4)
      cfg.review.coverage_check = false;
      delete cfg.posting;
      expect(renderedOrders(cfg)).toEqual(GOLDEN_ORDERS_UNRENDERED);
    },
  );
  it("built agents", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(builtAgents(defaultCfg())).toBe(GOLDEN_AGENTS);
  });
  it(
    "with coverage_check off, the orders are the bytes from before the coverage check",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const cfg = defaultCfg();
      cfg.review.coverage_check = false;
      expect(renderedOrders(cfg)).toEqual(GOLDEN_ORDERS_NO_COVERAGE);
    },
  );
  it("the default profile's only policy is one comment per root cause (repeat_sites = false)", () => {
    const p = defaultCfg().posting;
    expect(p).toBeDefined();
    expect(p!.repeat_sites).toBe(false);
    expect({ ...p, repeat_sites: true }).toEqual({
      ...p,
      repeat_sites: true,
      max_comments: 0,
      nits: "post",
      questions: "post",
      body: "full",
      comment_style: "full",
    });
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
// Re-pinned 2026-10-03 (owner decision after the decisions validation, dv1 vs dv1hi): pass-baseline, pass-sweep and pass-behaviour-delta run at the sol-high tier by default (src/config.ts DEFAULT_PASS_TIERS), so their plan rows name sol-high and are not raisable
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the doc header and the RATIFIED fence marker lines no longer reach the model (stripped at render and at agent build; kept in the source)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ticket ids, dated asides and deployed-repo statistics outside the ratified fences removed from the round templates, the addenda and pass-ask-human
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ratified reseeds — validator doubts unverifiable/low-confidence candidates; baseline drops the duplicate-fix scan and reads test vacuity; data-safety folds in its no-exec rule; pass-common schema completed; seed doc headers, dated owner asides and stack names removed
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the re-review and staleness templates rendered the nit-policy note from a broken doc-header line; it now sits in the Dispatch body beside the pass plan, as in round-first, and the header is stripped whole
const GOLDEN_ORDERS_NO_DEDUP: Record<string, string> = {
  first: "95dce8cabc99262407ba081e617145004cd4574d903985bbfb121e6f4e14564d",
  "re-review": "9a8ed307dd2162cb0371e890ff6ad799b56e947326d89e2b51509322c75f4322",
  staleness: "8dafcd30986daf8b726ace10d4c10eaf5a54531096c17a38f681f8afdfd025b3",
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
// Re-pinned 2026-10-03 (owner decision after the decisions validation, dv1 vs dv1hi): pass-baseline, pass-sweep and pass-behaviour-delta run at the sol-high tier by default (src/config.ts DEFAULT_PASS_TIERS), so their plan rows name sol-high and are not raisable
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the doc header and the RATIFIED fence marker lines no longer reach the model (stripped at render and at agent build; kept in the source)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ticket ids, dated asides and deployed-repo statistics outside the ratified fences removed from the round templates, the addenda and pass-ask-human
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ratified reseeds — validator doubts unverifiable/low-confidence candidates; baseline drops the duplicate-fix scan and reads test vacuity; data-safety folds in its no-exec rule; pass-common schema completed; seed doc headers, dated owner asides and stack names removed
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the re-review and staleness templates rendered the nit-policy note from a broken doc-header line; it now sits in the Dispatch body beside the pass plan, as in round-first, and the header is stripped whole
const GOLDEN_ORDERS: Record<string, string> = {
  first: "3373761faaa368eca74c80cae9df522afedc11e1aff7af1fa9acd997c8f3f00f",
  "re-review": "834cddf5fafbccc6330e529f9933d3109a9312096ed15e1c3e2722fd432baea1",
  staleness: "4b2ae10b839a6a50c56f44b9ed32e2ebcb10678e0e44738a6743a45916b36857",
};
// Re-pinned 2026-10-03: pass-behaviour-delta planned only where base behaviour is at risk (owner decision): the fixture removes only `pass` and adds a line, so its plan no longer carries the lens
// Re-pinned 2026-10-03 (owner decision after the decisions validation, dv1 vs dv1hi): pass-baseline, pass-sweep and pass-behaviour-delta run at the sol-high tier by default (src/config.ts DEFAULT_PASS_TIERS), so their plan rows name sol-high and are not raisable
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the doc header and the RATIFIED fence marker lines no longer reach the model (stripped at render and at agent build; kept in the source)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ticket ids, dated asides and deployed-repo statistics outside the ratified fences removed from the round templates, the addenda and pass-ask-human
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ratified reseeds — validator doubts unverifiable/low-confidence candidates; baseline drops the duplicate-fix scan and reads test vacuity; data-safety folds in its no-exec rule; pass-common schema completed; seed doc headers, dated owner asides and stack names removed
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the re-review and staleness templates rendered the nit-policy note from a broken doc-header line; it now sits in the Dispatch body beside the pass plan, as in round-first, and the header is stripped whole
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "d1d537a03c9f5a1732930d7b508525161af8b09d0fdd5f3eb6a69c26d767fbfd",
  "re-review": "d1fa0cac0858b35044e2a4d2480857b20f8031ba35cf36ed615ef5cad196240b",
  staleness: "3bc9621d310ae6ee2b511b772216cfb721084cd7a3f34bc665182138743203f6",
};
// Re-pinned 2026-10-03: pass-behaviour-delta is planned (one row per group of files the PR modifies or deletes code in; `[review] behaviour_delta`, freeze fixes 2) — the fixture PR modifies code, so its plan and the built agents gain the lens
// Re-pinned 2026-10-03: pass-lint-conformance agent built (planned only when a CI job runs a linter covering a changed file; freeze fixes 2)
// Re-pinned 2026-10-03: every planned lens carries its reason (the owner's 2026-10-03 planning decision); backcompat also planned on changed public signatures and wire serialization; pass-claims also on a stated behaviour; quality lenses on test-only changes (freeze fixes 2)
// Re-pinned 2026-10-03: pass-behaviour-delta planned only where base behaviour is at risk (owner decision): the fixture removes only `pass` and adds a line, so its plan no longer carries the lens
// Re-pinned 2026-10-03 (owner decision after the decisions validation, dv1 vs dv1hi): pass-baseline, pass-sweep and pass-behaviour-delta run at the sol-high tier by default (src/config.ts DEFAULT_PASS_TIERS), so their plan rows name sol-high and are not raisable
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the doc header and the RATIFIED fence marker lines no longer reach the model (stripped at render and at agent build; kept in the source)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ticket ids, dated asides and deployed-repo statistics outside the ratified fences removed from the round templates, the addenda and pass-ask-human
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ratified reseeds — validator doubts unverifiable/low-confidence candidates; baseline drops the duplicate-fix scan and reads test vacuity; data-safety folds in its no-exec rule; pass-common schema completed; seed doc headers, dated owner asides and stack names removed
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the re-review and staleness templates rendered the nit-policy note from a broken doc-header line; it now sits in the Dispatch body beside the pass plan, as in round-first, and the header is stripped whole
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "a2a5b944d2a75a889073e0a6c3cbd88db950615f905ffe1c71c9c3696245bd48",
  "re-review": "3412bf545fa383f9e3bc624d9b34924d8f99fc3673f0cb0b500e370a2c43c2f1",
  staleness: "54b466ec97ac297c826041eb0988b311a152fd8471be559c2ca011d02451ac54",
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
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the doc header and the RATIFIED fence marker lines no longer reach the model (stripped at render and at agent build; kept in the source)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ticket ids, dated asides and deployed-repo statistics outside the ratified fences removed from the round templates, the addenda and pass-ask-human
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): contradictions resolved by keeping the newer rule (style/convention judged only by validate-convention-rule; cross-file un-merge bullet removed; unverifiable/low confidence are doubts; lens briefs point CI-run lint at pass-lint-conformance; concurrency brief describes its content planning)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): addenda merged and compressed (one injection rule, one external-semantics rule, exhaust-the-site absorbs baseline-sibling-sites, compressed memory/nit-scope/self-narration/tag-grammar/nit-request/detail/merge/unreasoned-output rules, kill-word enumerations dropped)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): lens scope boundaries: one owner map shared by the five quality lenses (prompts/pass-quality-common.md); placement/simplicity/sweep/rollout/widened/behaviour-delta name the neighbouring owner
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ratified reseeds — validator doubts unverifiable/low-confidence candidates; baseline drops the duplicate-fix scan and reads test vacuity; data-safety folds in its no-exec rule; pass-common schema completed; seed doc headers, dated owner asides and stack names removed
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): suppression rebalance — exclusions rephrased as scoped reporting rules (report X / X belongs to lens Z) where the meaning allows
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): self-review fixes — external-semantics question as a P3 demotion (reachability untouched) and the slip rule restored to its deliberate-token exclusion
const GOLDEN_AGENTS_NO_DEDUP = "e1a495f212d46f32de9b2f50c494d99872baff617ba3996e97d110d9f7b7092b";
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
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the doc header and the RATIFIED fence marker lines no longer reach the model (stripped at render and at agent build; kept in the source)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ticket ids, dated asides and deployed-repo statistics outside the ratified fences removed from the round templates, the addenda and pass-ask-human
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): contradictions resolved by keeping the newer rule (style/convention judged only by validate-convention-rule; cross-file un-merge bullet removed; unverifiable/low confidence are doubts; lens briefs point CI-run lint at pass-lint-conformance; concurrency brief describes its content planning)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): addenda merged and compressed (one injection rule, one external-semantics rule, exhaust-the-site absorbs baseline-sibling-sites, compressed memory/nit-scope/self-narration/tag-grammar/nit-request/detail/merge/unreasoned-output rules, kill-word enumerations dropped)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): lens scope boundaries: one owner map shared by the five quality lenses (prompts/pass-quality-common.md); placement/simplicity/sweep/rollout/widened/behaviour-delta name the neighbouring owner
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ratified reseeds — validator doubts unverifiable/low-confidence candidates; baseline drops the duplicate-fix scan and reads test vacuity; data-safety folds in its no-exec rule; pass-common schema completed; seed doc headers, dated owner asides and stack names removed
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): suppression rebalance — exclusions rephrased as scoped reporting rules (report X / X belongs to lens Z) where the meaning allows
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): self-review fixes — external-semantics question as a P3 demotion (reachability untouched) and the slip rule restored to its deliberate-token exclusion
const GOLDEN_AGENTS = "389f35248388735de9fb6038c42765fe3c779f7fef9a71446685891bbc8dffaf";
