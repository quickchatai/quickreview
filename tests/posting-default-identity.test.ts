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
  first: "16fae871533d01c7440caa13b44687b84924034fe9292d2102bf5040e7e20897",
  "re-review": "61dc264e5b74988be58029990447c8d31e2818fb49e3cbd945d16afe1a9b10bf",
  staleness: "2caf304d72191eef677d9a88898abff3bfc4737fe15f4b9314df1d963a69360d",
};
// The default orders: `[review] dedup_merge` on (step 4 carries the
// `{{dedup_note}}` — group candidates with `cluster_findings` before the
// validator, one comment per root cause), the default profile's
// `[posting] repeat_sites = false` (the escalation line carries the
// posting-policy note), and `[review] coverage_check` on (the fixture PR
// changes source files, so step 2 ends with the `{{coverage_note}}`).
const GOLDEN_ORDERS: Record<string, string> = {
  first: "2b3750e79b4b53e7d8017462fd210ba70704b61585a56a3148bcaef8d6d56e9b",
  "re-review": "ba2134ca140a3c718d19772e6b1c691b6061aefb7e3dd4d924c11564f6304bf6",
  staleness: "2dfdecaa2472bb8946711e6e7f002f8517cb202d18cca98b1750e41d3130103c",
};
// `[review] coverage_check = false`: the default orders without the
// `{{coverage_note}}`.
const GOLDEN_ORDERS_NO_COVERAGE: Record<string, string> = {
  first: "a185df542356590b31fc2079cf1800cd634493a3abe8b05281d96881896dfb02",
  "re-review": "70560c09cb6a065cfc0f23949ad0225d2ff17c33eed0fadd6637f011817825cb",
  staleness: "9e33c95b4b63ce02f817d8a6f25963dc1ef910c90ba58b44663080283238a9a5",
};
// `[review] render_outputs = false`, `dedup_merge = false`, `coverage_check =
// false` and no posting policy: the orders without any of those levers.
const GOLDEN_ORDERS_UNRENDERED: Record<string, string> = {
  first: "1462bf6df87eaabcab5cdec0ed031d77e53b4db07ae1078470d78449140214ac",
  "re-review": "fcf6b30fd82055ba1e70ecd3b0c1fd51edd0f2cc26097c54a05ce01688574007",
  staleness: "0d7f7c6c47a8da25ce12276f59541b10ba78c298498e13eeab32f1994068da17",
};
// The default profile's built agents with `[review] dedup_merge = false` and no
// posting policy. These hashes move only when an agent body, an addendum or the
// agent build changes on purpose; `[posting]` must never move them.
const GOLDEN_AGENTS_NO_DEDUP = "d2a647e89dd90ca4bcf5674617a1d7732b83a10be0eb27c5f7297375f7221ca6";
// The default build: as GOLDEN_AGENTS_NO_DEDUP plus `dedup-group-validate`
// (pass-validate, `[review] dedup_merge` on by default) and the default
// profile's posting addendum for `repeat_sites = false`.
const GOLDEN_AGENTS = "ddd1bd754c1b45c01e706e3bbd6e3bacf0afd0b4ab40e5f0633493c013cbb757";
