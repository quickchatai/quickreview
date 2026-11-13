// tests/posting-default-identity.test.ts — the `[posting]` profile section
// (bench/aacr/ext/SNAPPY-PLAN.md) changes NOTHING for a profile that does not
// set it. The hashes below pin the built agents and the rendered round orders
// of the shipped `default` profile over a fixed order: the default pins carry
// that profile's one posting policy (`repeat_sites = false`), the NO_DEDUP and
// UNRENDERED pins carry none. Any byte the posting policy leaks into a build
// beyond that moves one of them.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildRoundOrder } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import {
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
} from "@quickchatai/pi-quickreview/src/include.js";
import {
  applyProfileTuning,
  lensModelOverrides,
  lensTuningAddenda,
} from "@quickchatai/pi-quickreview/src/lenstuning.js";
import {
  loadProfileAddenda,
  loadProfileLensTuning,
} from "@quickchatai/pi-quickreview/src/profiles.js";
import type { PrStateRow } from "../src/state.js";
import {
  renderRoundPrompt,
  ROUND_TEMPLATE_FILES,
} from "@quickchatai/pi-quickreview/src/templates.js";
import type { RoundType } from "@quickchatai/pi-quickreview/src/types.js";
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
      // the unrendered pins also exclude the duplicate merge…
      cfg.review.dedup_merge = false;
      // … and the per-file coverage check
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
// posting policy, the orders and the agents are the pins without the
// duplicate merge.
describe("[review] dedup_merge = false — byte-identical to before the duplicate merge", () => {
  const noDedup = () => {
    const cfg = defaultCfg();
    cfg.review.dedup_merge = false;
    // … and without the per-file coverage check
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

// Golden round-order hashes. Every one of these moves whenever a round
// template, the pass plan, or a rendered note changes; re-pin deliberately and
// say why in the commit, never to make `[posting]` pass.
//
// The security family moved them all: the findings-record example gains a
// security entry, the `posted_as` bullet covers a downgraded entry that went
// out, the kill-word list gains `partial-chain`, and the validator gains the
// security addenda. The fourteen `pass-sec-*` lenses join the build but not
// the addable list of a round with no security signal, as this fixture's is.
// None of it is `[posting]`.
//
// The tier names moved every hash here once more, orders and agents alike:
// the same bytes with the tiers spelled `light`, `standard` and `deep`, in
// the plan table, the add rule and each built agent's file name.
//
// The add rule's tier moved every order here: a lens the session adds runs
// at its `[models.pass_tiers]` pin (planner.ts `addTierOf`), so the add
// protocol names `pass-behaviour-delta--deep`, a shipped pin, where it named
// the add rule's standard variant. Nothing about `[posting]` moved them.
//
// `[review] render_outputs` defaults on, so step 6 of every round carries the
// `{{render_note}}` (write the findings record first, render the body and the
// inline comments with scripts/render-review.sh). The fixture has no ledger
// file, so `{{ledger_note}}` renders "".
//
// With `dedup_merge = false`, `coverage_check = false` and no posting policy:
const GOLDEN_ORDERS_NO_DEDUP: Record<string, string> = {
  first: "5e93ea2a38b3b26aa3f17690239f299aef5080e710d43b8d0d52f0db76275048",
  "re-review": "66d8746c6a063356ffd63058b9227e11fdfaa5f3b4bcd305d81944cb54a6cf4a",
  staleness: "175cc506287fdf0e3fc01911dff1a38aa4a2e009bb24a2de5a2903650ee75fca",
};
// The default orders: `[review] dedup_merge` on (step 4 carries the
// `{{dedup_note}}` — group candidates with `cluster_findings` before the
// validator, one comment per root cause), the default profile's
// `[posting] repeat_sites = false` (the escalation line carries the
// posting-policy note), and `[review] coverage_check` on (the fixture PR
// changes source files, so step 2 ends with the `{{coverage_note}}`).
const GOLDEN_ORDERS: Record<string, string> = {
  first: "3234acfe8872b9c3cd124bb82dc9ddca1ff3aeaeb38f6e830f48c0505b9b9ee0",
  "re-review": "684bdfc91d91ddae97b44c0e56975d4b6934c55352a8c6dec73916b91867c86f",
  staleness: "2cbb4883b943062be9bf4defed20230035def5a560809ccdea1abd0f4005af47",
};
// `[review] coverage_check = false`: the default orders without the
// `{{coverage_note}}`.
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "f7354157cb0406141d8d0d71a929a356293bd0c2df7b4ab21507c02d86a75ae9",
  "re-review": "282587694ee6e9eede79e6e572470e3c8126941063d745bec3058747a887944e",
  staleness: "b360059534fd29902d56693eb2827b028a827642a12c7a4d9ae23741e2bd7cbc",
};
// `[review] render_outputs = false`, `dedup_merge = false`, `coverage_check =
// false` and no posting policy: the orders without any of those levers.
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "2facca8d02bdc50c98eeb80c09fcd1296d1f966082b13b5a4db1ed24653a05af",
  "re-review": "da1953fbba0d4c48c23dabbf9f7e4ca83b300f229ff6eac1d1ac072b1f9c9df7",
  staleness: "4544cd6c9efc69124cff586de81dda729f0953aa1f4238534109210a9f21b257",
};
// The default profile's built agents with `[review] dedup_merge = false` and no
// posting policy. These hashes move only when an agent body, an addendum or the
// agent build changes on purpose; `[posting]` must never move them.
//
// The state-machine family moved these two: the eight `pass-sm-*` lenses
// join the build (their shared contract, their own-lens addendum, the deep
// spec of the shipped pin and `state_explore` on their tools lines), and the
// validator gains its two state rules, `validate-state-evidence` and
// `validate-state-keep`. All of it is agent text or an agent's frontmatter,
// and none of it is `[posting]`. A round with no state-machine signal, as
// this fixture's is, plans and is offered none of the family, so no order
// moves for it.
// MUTATION: delete a sentence of prompts/pass-sm-common.md, or the
// `validate-state-keep` entry of PASS_ADDENDA (include.ts) — both "built
// agents" cases fail, and no "rendered round orders" case does.
const GOLDEN_AGENTS_NO_DEDUP = "b3616b9dc81b176a6d6103c4788a489c3fe71ed73ff4961ab359434828c608fe";
// The default build: as GOLDEN_AGENTS_NO_DEDUP plus `dedup-group-validate`
// (pass-validate, `[review] dedup_merge` on by default) and the default
// profile's posting addendum for `repeat_sites = false`.
const GOLDEN_AGENTS = "352c0390d941fc4b31676a0de5654e491d685f2a72151d6b04de09f30726cf62";
