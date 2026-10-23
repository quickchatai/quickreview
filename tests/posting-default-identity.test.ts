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
// `[review] render_outputs` defaults on, so step 6 of every round carries the
// `{{render_note}}` (write the findings record first, render the body and the
// inline comments with scripts/render-review.sh). The fixture has no ledger
// file, so `{{ledger_note}}` renders "".
//
// With `dedup_merge = false`, `coverage_check = false` and no posting policy:
const GOLDEN_ORDERS_NO_DEDUP: Record<string, string> = {
  first: "5a6b8eee1fedf57da0cf8cc7f87bb66ddda4447c12217ed92a0f1d4aa2644578",
  "re-review": "8e3d391f8d249489f97a154aa642725da69e9eeecf649710102783d337c9c19c",
  staleness: "a82515026ab63e8e187095cab7e539cfb9515c14a673f6182bb4a53816f41e31",
};
// The default orders: `[review] dedup_merge` on (step 4 carries the
// `{{dedup_note}}` — group candidates with `cluster_findings` before the
// validator, one comment per root cause), the default profile's
// `[posting] repeat_sites = false` (the escalation line carries the
// posting-policy note), and `[review] coverage_check` on (the fixture PR
// changes source files, so step 2 ends with the `{{coverage_note}}`).
const GOLDEN_ORDERS: Record<string, string> = {
  first: "ad5d377f8367e00161235e522b2e48536e13c04cc802b0688fd0e7018a09a76a",
  "re-review": "88f16158a6b65d415b35c7902745a7a4c76bf76b7a3799b28cd8607e231e5b9c",
  staleness: "60ac4fe87336a297b9e47755347679dc7dfb8b1270bf0aa0b6da54a55a3e14ff",
};
// `[review] coverage_check = false`: the default orders without the
// `{{coverage_note}}`.
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "4e8e9a9642ba9f9f461f9dc9854bcf5b2fb839218d7a837d5e90061abe668643",
  "re-review": "0f5aab47c6fe51dd64c4b302496aa766c8622ab52dd69b71bc221ae6ef26842d",
  staleness: "2b95af0a49ef7abad2af0888f196e807adcb643fa1cd0fd40934fc5981750f46",
};
// `[review] render_outputs = false`, `dedup_merge = false`, `coverage_check =
// false` and no posting policy: the orders without any of those levers.
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "5ca1f7843fb9a86f24e613368c2e7e58b0a4e2886fabd5a55408c3f2509b69e7",
  "re-review": "4ecb375e17c8b4212bea3985fe4bdaec897edae8fc8a7641c3eac20cf7ab4542",
  staleness: "53b9857224fada7bad93597f0cc45518a1ea7d9d4abe6761604ac683dff42e0e",
};
// The default profile's built agents with `[review] dedup_merge = false` and no
// posting policy. These hashes move only when an agent body, an addendum or the
// agent build changes on purpose; `[posting]` must never move them.
const GOLDEN_AGENTS_NO_DEDUP = "76f6c2ff687eba37da3cc55812c0c145074ae80387c20d4ba611e5212b69f6e3";
// The default build: as GOLDEN_AGENTS_NO_DEDUP plus `dedup-group-validate`
// (pass-validate, `[review] dedup_merge` on by default) and the default
// profile's posting addendum for `repeat_sites = false`.
const GOLDEN_AGENTS = "e35731c0247eb5f68c0fce12e2b90a865612ff43f8614473588af71f38414860";
