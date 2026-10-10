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
  first: "0badc60ef34b0e17ee37d42a93b91698eb0d76af4ba12c6a2003ea48af960c2d",
  "re-review": "7ad23311703c0ef41ff70d411225a12937b6d7dc557bb65c34a01594fd1b129d",
  staleness: "d8cf0a30d4b67e51cc71d7b4c01e56552e1d9b3082078edc574c809238c0de22",
};
// The default orders: `[review] dedup_merge` on (step 4 carries the
// `{{dedup_note}}` — group candidates with `cluster_findings` before the
// validator, one comment per root cause), the default profile's
// `[posting] repeat_sites = false` (the escalation line carries the
// posting-policy note), and `[review] coverage_check` on (the fixture PR
// changes source files, so step 2 ends with the `{{coverage_note}}`).
const GOLDEN_ORDERS: Record<string, string> = {
  first: "9784844333520edd1b9547a03406ea74bc66e1fe7556bb99744fc641df8979ac",
  "re-review": "bf4c0cd168d43613f2e7d73c061b7b81086479e019ec0a2cf29c94aa62d3e864",
  staleness: "751cecf4c20167632b9d23ec6838b23321c8cf6e51f009ba42c6167ecf1323eb",
};
// `[review] coverage_check = false`: the default orders without the
// `{{coverage_note}}`.
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "5180d84b459ecdda74d0400bc291d4192faa7c0bce764b620088f5be5c247680",
  "re-review": "876d45e1f40443bfe7e8237e93d27fd9c017266ff4fe37d095a07ef9310b2733",
  staleness: "d4a5cf65b6bd961aaf8deaf733e0e0af50bd46adb738e44a7456b064867ce86e",
};
// `[review] render_outputs = false`, `dedup_merge = false`, `coverage_check =
// false` and no posting policy: the orders without any of those levers.
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "498182a29e35f2e55a6a10df0e6b7b81b983df45f385592b1e042d7946f3979f",
  "re-review": "696f32d9d2ff5c0d0354f47808c59ded99f4bfaf42feff8e32c5eea0667a7494",
  staleness: "fa9df9f27d682c909c1ba8c19e6fadad0637d912bfa83412b3649afb804cd546",
};
// The default profile's built agents with `[review] dedup_merge = false` and no
// posting policy. These hashes move only when an agent body, an addendum or the
// agent build changes on purpose; `[posting]` must never move them.
const GOLDEN_AGENTS_NO_DEDUP = "7aa60e49ced7c752a1b569d086d2d1d85661f929773e89887e69e5c184486e14";
// The default build: as GOLDEN_AGENTS_NO_DEDUP plus `dedup-group-validate`
// (pass-validate, `[review] dedup_merge` on by default) and the default
// profile's posting addendum for `repeat_sites = false`.
const GOLDEN_AGENTS = "fd698961d44bc7330a235a39ca65a88169b862e5d30187be779ae716a97c439b";
