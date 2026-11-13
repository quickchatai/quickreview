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
// `[review] render_outputs` defaults on, so step 6 of every round carries the
// `{{render_note}}` (write the findings record first, render the body and the
// inline comments with scripts/render-review.sh). The fixture has no ledger
// file, so `{{ledger_note}}` renders "".
//
// With `dedup_merge = false`, `coverage_check = false` and no posting policy:
const GOLDEN_ORDERS_NO_DEDUP: Record<string, string> = {
  first: "3d40618a18addbb7006445dff4e4234ec5236305dedbc9c7f957837853e14a11",
  "re-review": "6bb51364c3f7e03ef82460315b60ba956c00b6a1bad790f5b716acc8fd4d7a3a",
  staleness: "3f97978241c7694aff07f259d7a6fc4dcf7e8cc54cee4598b2258f3e71dfae03",
};
// The default orders: `[review] dedup_merge` on (step 4 carries the
// `{{dedup_note}}` — group candidates with `cluster_findings` before the
// validator, one comment per root cause), the default profile's
// `[posting] repeat_sites = false` (the escalation line carries the
// posting-policy note), and `[review] coverage_check` on (the fixture PR
// changes source files, so step 2 ends with the `{{coverage_note}}`).
const GOLDEN_ORDERS: Record<string, string> = {
  first: "16f8869b278b63ec90bcb89d32302f47b2fdb2e4179ba8311280b7ad4d657940",
  "re-review": "4b1046e97710eea9fa747a7b1df73b8a5c7949802d6eea89eaf3b3db050f3d4e",
  staleness: "eda131165ad60241bbd6bf0c07cc9c3fc724344b8e30913674362777848d9f09",
};
// `[review] coverage_check = false`: the default orders without the
// `{{coverage_note}}`.
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "ec27151a3e319ca5abbbb306038aa861b56db2e8ad9a9a0359dbab3eebfe4d43",
  "re-review": "234954c12b420b13e524d0638cf440a6373097eafb627745272a2f0a9afcfd76",
  staleness: "79063519c4d0eac75b68be7fef7c9cf25bab100f9a61b06f4eb0c8f49862e303",
};
// `[review] render_outputs = false`, `dedup_merge = false`, `coverage_check =
// false` and no posting policy: the orders without any of those levers.
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "fe866b096bf7aa743b34ce7652f6e5288b163de10b6e6dd23e99ea4d4501e085",
  "re-review": "3be76190934d06b26625c5b60cc72b6254d700f45c7a8650e3df662a4a6a10d2",
  staleness: "3b3f086afb046df74b2b90d3588bafd54d57504f94291997d31bad515223cce5",
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
