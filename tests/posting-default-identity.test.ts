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
// Re-pinned 2026-10-05 (ordered by the owner before the freeze): the ledger step's
// compaction promise now says what is true at pi 1.0.0 — the ledger survives word for word
// (pinned into the compaction summary, and re-handed by the next round order); everything
// else only as a paraphrase. The fixture has no ledger file, so `{{ledger_note}}` renders "".
// Re-pinned 2026-10-08 (H1a, #5885): step 7 of the three round templates
// tells the session never to write the verdict file in place — stage it at
// `verdict/<name>.tmp`, then publish it with scripts/commit-verdict.sh (one
// rename), and the guard-5 head_moved outcome the same way. Every map moves.
// Re-pinned 2026-10-08 (integration review): the ledger step no longer
// says the verdict file makes the daemon compact the conversation at once —
// since H1b the daemon closes the round and the compaction runs once the run
// settles — and the findings-record step says nothing written after the
// verdict is part of the round. Every map moves.
// Re-pinned 2026-10-09 (launch the slowest rows first): the pass
// plan lists its rows slowest first (dispatch.ts `slowestFirst`) — the same
// rows in a new order — and the plan's lens list follows it. Every map moves.
// Re-pinned 2026-10-09 (launch_plan): step 2 of the round templates
// launches every discovery row with ONE `launch_plan` call over the task
// directory — per-row `subagent` calls only without task files or when the
// tool is unavailable — and never one lens per turn. Every map moves.
// Re-pinned 2026-10-09 (the main session's serial tail): the posting
// calls are given whole in env-prefix form (`export` is refused by the exec
// policy), the templates list what the policy always refuses and forbid reading
// the daemon's scripts for formats; under render_outputs the note hands the
// decided verdict to `scripts/commit-verdict.sh --from-record`. Every map moves.
const GOLDEN_ORDERS_NO_DEDUP: Record<string, string> = {
  first: "1cc3eb2e2368b34fa5922e47b9954b051e5947ad833d198acaa31eddc2646da0",
  "re-review": "fc6a45420abbd1b0cb455eea4e3dc906272fb3a1fd7db91b3909d8720b66b318",
  staleness: "ea3fa493077cdc0442a56aebc2f5922a6e113b3b3e06509f7e8ed7b7e8618b7d",
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
// Re-pinned 2026-10-05 (ordered by the owner before the freeze): the ledger step's
// compaction promise now says what is true at pi 1.0.0 — the ledger survives word for word
// (pinned into the compaction summary, and re-handed by the next round order); everything
// else only as a paraphrase. The fixture has no ledger file, so `{{ledger_note}}` renders "".
// Re-pinned 2026-10-08 (H1a, #5885): step 7 of the three round templates
// tells the session never to write the verdict file in place — stage it at
// `verdict/<name>.tmp`, then publish it with scripts/commit-verdict.sh (one
// rename), and the guard-5 head_moved outcome the same way. Every map moves.
// Re-pinned 2026-10-08 (integration review): the ledger step no longer
// says the verdict file makes the daemon compact the conversation at once —
// since H1b the daemon closes the round and the compaction runs once the run
// settles — and the findings-record step says nothing written after the
// verdict is part of the round. Every map moves.
// Re-pinned 2026-10-09 (coverage row): `{{coverage_note}}` passes
// `coverage_gaps` a `swept` list — every file in the focus of a RETURNED
// pass-sweep / pass-behaviour-delta row, NONE included — so a file a sweep row
// already read no longer draws a coverage row. Only this map moves (the
// no-coverage map renders no note).
// Re-pinned 2026-10-09 (launch the slowest rows first): the pass
// plan lists its rows slowest first (dispatch.ts `slowestFirst`) — the same
// rows in a new order — and the plan's lens list follows it. Every map moves.
// Re-pinned 2026-10-09 (launch_plan): step 2 of the round templates
// launches every discovery row with ONE `launch_plan` call over the task
// directory — per-row `subagent` calls only without task files or when the
// tool is unavailable — and never one lens per turn. Every map moves.
// Re-pinned 2026-10-09 (the main session's serial tail): the posting
// calls are given whole in env-prefix form (`export` is refused by the exec
// policy), the templates list what the policy always refuses and forbid reading
// the daemon's scripts for formats; under render_outputs the note hands the
// decided verdict to `scripts/commit-verdict.sh --from-record`. Every map moves.
const GOLDEN_ORDERS: Record<string, string> = {
  first: "fbf96e86f8a3126363f8bec83fa582ef9f8c52735080f0ebaf067acf50a17598",
  "re-review": "f36cbf302a8b7f87c2ec36c9f47b6e82da42b1371533c3b14f943eb2de16b0d8",
  staleness: "a3df1a736698ca45ab0a41cb0ec00b4632575a49f79d8a21052e546212d84065",
};
// Re-pinned 2026-10-09 (review fix): the coverage note's `swept` now
// credits returned pass-sweep rows only — pass-behaviour-delta skips pure additions.
// Re-pinned 2026-10-03: pass-behaviour-delta planned only where base behaviour is at risk (owner decision): the fixture removes only `pass` and adds a line, so its plan no longer carries the lens
// Re-pinned 2026-10-03 (owner decision after the decisions validation, dv1 vs dv1hi): pass-baseline, pass-sweep and pass-behaviour-delta run at the sol-high tier by default (src/config.ts DEFAULT_PASS_TIERS), so their plan rows name sol-high and are not raisable
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the doc header and the RATIFIED fence marker lines no longer reach the model (stripped at render and at agent build; kept in the source)
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ticket ids, dated asides and deployed-repo statistics outside the ratified fences removed from the round templates, the addenda and pass-ask-human
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): ratified reseeds — validator doubts unverifiable/low-confidence candidates; baseline drops the duplicate-fix scan and reads test vacuity; data-safety folds in its no-exec rule; pass-common schema completed; seed doc headers, dated owner asides and stack names removed
// Re-pinned 2026-10-03 (prompt cleanup, owner-approved): the re-review and staleness templates rendered the nit-policy note from a broken doc-header line; it now sits in the Dispatch body beside the pass plan, as in round-first, and the header is stripped whole
// Re-pinned 2026-10-05 (ordered by the owner before the freeze): the ledger step's
// compaction promise now says what is true at pi 1.0.0 — the ledger survives word for word
// (pinned into the compaction summary, and re-handed by the next round order); everything
// else only as a paraphrase. The fixture has no ledger file, so `{{ledger_note}}` renders "".
// Re-pinned 2026-10-08 (H1a, #5885): step 7 of the three round templates
// tells the session never to write the verdict file in place — stage it at
// `verdict/<name>.tmp`, then publish it with scripts/commit-verdict.sh (one
// rename), and the guard-5 head_moved outcome the same way. Every map moves.
// Re-pinned 2026-10-08 (integration review): the ledger step no longer
// says the verdict file makes the daemon compact the conversation at once —
// since H1b the daemon closes the round and the compaction runs once the run
// settles — and the findings-record step says nothing written after the
// verdict is part of the round. Every map moves.
// Re-pinned 2026-10-09 (launch the slowest rows first): the pass
// plan lists its rows slowest first (dispatch.ts `slowestFirst`) — the same
// rows in a new order — and the plan's lens list follows it. Every map moves.
// Re-pinned 2026-10-09 (launch_plan): step 2 of the round templates
// launches every discovery row with ONE `launch_plan` call over the task
// directory — per-row `subagent` calls only without task files or when the
// tool is unavailable — and never one lens per turn. Every map moves.
// Re-pinned 2026-10-09 (the main session's serial tail): the posting
// calls are given whole in env-prefix form (`export` is refused by the exec
// policy), the templates list what the policy always refuses and forbid reading
// the daemon's scripts for formats; under render_outputs the note hands the
// decided verdict to `scripts/commit-verdict.sh --from-record`. Every map moves.
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "f370d5f65106e8ed0c9a0ca165a64aaf910cdef5c6f471f8277bf3842aabe428",
  "re-review": "36e76f3a552030ecdf9230c2d80b07d1183906646d8ec8ca380545853f89d38f",
  staleness: "99fe6265b3eb031a7c23b33c7deab43eecd3035723b02f591554160d7e3412a6",
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
// Re-pinned 2026-10-05 (ordered by the owner before the freeze): the ledger step's
// compaction promise now says what is true at pi 1.0.0 — the ledger survives word for word
// (pinned into the compaction summary, and re-handed by the next round order); everything
// else only as a paraphrase. The fixture has no ledger file, so `{{ledger_note}}` renders "".
// Re-pinned 2026-10-08 (H1a, #5885): step 7 of the three round templates
// tells the session never to write the verdict file in place — stage it at
// `verdict/<name>.tmp`, then publish it with scripts/commit-verdict.sh (one
// rename), and the guard-5 head_moved outcome the same way. Every map moves.
// Re-pinned 2026-10-08 (integration review): the ledger step no longer
// says the verdict file makes the daemon compact the conversation at once —
// since H1b the daemon closes the round and the compaction runs once the run
// settles — and the findings-record step says nothing written after the
// verdict is part of the round. Every map moves.
// Re-pinned 2026-10-09 (launch the slowest rows first): the pass
// plan lists its rows slowest first (dispatch.ts `slowestFirst`) — the same
// rows in a new order — and the plan's lens list follows it. Every map moves.
// Re-pinned 2026-10-09 (launch_plan): step 2 of the round templates
// launches every discovery row with ONE `launch_plan` call over the task
// directory — per-row `subagent` calls only without task files or when the
// tool is unavailable — and never one lens per turn. Every map moves.
// Re-pinned 2026-10-09 (the main session's serial tail): the posting
// calls are given whole in env-prefix form (`export` is refused by the exec
// policy), the templates list what the policy always refuses and forbid reading
// the daemon's scripts for formats; under render_outputs the note hands the
// decided verdict to `scripts/commit-verdict.sh --from-record`. Every map moves.
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "458c329083eb4df22d167a7bc3ab0b7eeddaa0e7cb623aefa94911a51987a892",
  "re-review": "519d70354964a35fa87eb4958cd80ec68f25b0ee64ca0eb8d4cfda3dc7f18030",
  staleness: "911e51a65fb2602143fdeeb603178f3b5b0c79c67fffafcb5ec91bbc7ef38e5d",
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
