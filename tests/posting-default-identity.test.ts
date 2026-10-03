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
    delete cfg.posting;
    expect(renderedOrders(cfg)).toEqual(GOLDEN_ORDERS_UNRENDERED);
  });
  it("built agents", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(builtAgents(defaultCfg())).toBe(GOLDEN_AGENTS);
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
const GOLDEN_ORDERS_NO_DEDUP: Record<string, string> = {
  first: "e4d416f0b1b8bc90a8c99bc7b5d40b999dd3cf6cf6ccf31ea14d68f406d189bd",
  "re-review": "e496362d1e1a496c994e96c73aec8864c0d188e8de12c4d0471ffc3bf0989e28",
  staleness: "1f715115beed263bb8b18cae908a97f07162aa9a8fb20f4458b5fad85831c7bf",
};
// Re-pinned 2026-10-03 (round 7, docs/duplicate-merge.md, the owner's
// decisions): `[review] dedup_merge` defaults on, so step 4 carries the
// `{{dedup_note}}` (group candidates with `cluster_findings` before the
// validator; one comment per root cause), and the default profile sets
// `[posting] repeat_sites = false`, so the escalation line carries the
// posting-policy note. Off + no policy = GOLDEN_ORDERS_NO_DEDUP above.
const GOLDEN_ORDERS: Record<string, string> = {
  first: "8ad90a3c0393921cd32153e5920eb74c4d6cc0ca97d541c9553f7191ea651ecb",
  "re-review": "c5b0a829850e76d0c29050d60ccbdf12dad77575bdaeec786a41b58624251c80",
  staleness: "5b01f161f2e4d80f0376479672d6724300656bc732d16a9952cf3eb08f2c2f76",
};
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "3dddb72bc299b5893d679a6215880cb0b442b2403b2d91052e22fc1a4e0299ab",
  "re-review": "456c7615f48a28d595499ec1b739aa29381eebc5c4f635d3caed3a07a21efd1b",
  staleness: "a4f26831fb2c34864d3b367e9a24bd31390918902ec5f9c9b7721b0cbb4c4f94",
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
const GOLDEN_AGENTS_NO_DEDUP = "6852cb2be460901a9c431689a040bbae5492e0d3164c7f1ae553fa3bbf5ff9d4";
//   → (round 7, docs/duplicate-merge.md) `dedup-group-validate` (pass-validate,
//     `[review] dedup_merge` on by default) and the default profile's posting
//     addendum for `repeat_sites = false`. Off + no policy = the pin above.
const GOLDEN_AGENTS = "2c4f5344d2360e736e7ccd9d43241a44904df9fd5dfe2bee1afe8193386489d3";
