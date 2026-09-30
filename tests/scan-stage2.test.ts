// Scan stage 2 (src/setup/stage2.ts + the stage-2 half of
// src/setup/scanrun.ts) driven the engine way, like tests/scan-run.test.ts:
// every port faked, the state home a temp dir through the real rooted state
// port. Stage 1's calibration runs first (a stage-2 row is priced from the
// ledger), then the companion's rows are proposed, priced, fitted and
// started — by its word (`startStage2`) or the TUI's click (the start
// channel). What is asserted is what the engine WRITES and RETURNS.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_DEFAULTS, type ScanConfig } from "../src/config.js";
import type { LensTuningMap } from "../src/lenstuning.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import { FindingsStore } from "../src/setup/findings.js";
import { LEDGER_FILE, type LedgerFile } from "../src/setup/ledger.js";
import { ScanRunner, type ScanPorts, type ScanSource, type ScanTree } from "../src/setup/scanrun.js";
import { pairTests, type Stage2RowRequest } from "../src/setup/stage2.js";
import {
  clickStartStage2,
  readStage2Proposal,
  stage2ClickOutcome,
  STAGE2_FILE,
  STAGE2_RESULT_FILE,
  STAGE2_START_FILE,
} from "../src/setup/stage2request.js";
import type { UnitCut } from "../src/setup/unitcut.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-stage2-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const lines = (n: number, word = "x"): string => Array.from({ length: n }, (_, i) => `${word}_${i + 1} = ${i + 1}`).join("\n") + "\n";

const TREE: Record<string, string> = {
  "app/models.py": lines(10, "model"),
  "app/views.py": lines(20, "view"),
  "app/tests/test_views.py": lines(8, "tv"),
  "app/migrations/0001_init.py": lines(6, "mig"),
  "lib/util.py": lines(30, "util"),
  "lib/big.py": lines(50, "big"),
  "tests/lib/test_util.py": lines(12, "tu"),
  "web/index.ts": lines(40, "web"),
  "web/index.test.ts": lines(9, "wt"),
  "web/package-lock.json": "{}\n",
  "gen/out.py": lines(5),
  "tools/x.py": lines(15, "tool"),
};

const CUT: UnitCut = {
  units: ["app", "lib", "web", "gen", "tools", "tests"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
  ignored: [],
};

const blob = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
const SHA = "1".repeat(40);

function fakeSource(files: Record<string, string>): ScanSource {
  return {
    location: "/reviewed-repo",
    resolve: (ref) => (ref === "HEAD" || ref === SHA ? SHA : null),
    open: (sha): { ok: true; tree: ScanTree } => ({
      ok: true,
      tree: {
        sha,
        root: `/state/scan/tree/${sha}`,
        files: Object.entries(files).map(([path, text]) => ({ path, blob: blob(text) })),
        read: (p) => files[p] ?? null,
        lines: (p) => (files[p] === undefined ? null : files[p]!.split("\n").length - 1),
      },
    }),
    list: (sha) => (sha === SHA ? Object.entries(files).map(([path, text]) => ({ path, blob: blob(text) })) : null),
  };
}

/** Answers like the lens it is: pass-scan (stage 1) with no suggestion, a
 * deep lens with one finding on each focus file's lines 2-3. */
function answer(spec: CaseSpec): string {
  const lens = spec.agent.replace(/--.*$/, "");
  if (lens === "pass-scan") return `FINDINGS pass-scan SCAN ${spec.id} @sha\nNONE\n\nSUGGEST NONE\n`;
  const focus = spec.prompt.split("Focus files")[1]!.split("\n\n")[0]!;
  const paths = [...focus.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]!);
  return [
    `FINDINGS ${lens} SCAN ${spec.id} @sha`,
    ...paths.flatMap((p) => [`- path: ${p}`, "  line: 2-3", "  kind: security", "  severity: P1", `  claim: ${p} trusts its caller`]),
  ].join("\n");
}

interface FakeRunner {
  run(spec: CaseSpec, signal: AbortSignal, onCost?: (spentSoFar: number) => void): Promise<CaseOutcome>;
  specs: CaseSpec[];
}

/** $0.01 per file for stage 1; `deepPerFile` for a deep lens. */
function runner(deepPerFile = 0.01): FakeRunner {
  const specs: CaseSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      const per = spec.agent.startsWith("pass-scan--") ? 0.01 : deepPerFile;
      return { ok: true, output: answer(spec), cost_usd: per * spec.files.length };
    },
  };
}

let now = new Date("2026-09-29T10:00:00Z");

function ports(
  cases: FakeRunner,
  opts: { scan?: Partial<ScanConfig>; lenses?: LensTuningMap; riskPasses?: string[] } = {},
): ScanPorts {
  return {
    state: stateHomeFs(stateDir),
    clock: () => {
      now = new Date(now.getTime() + 1000);
      return now;
    },
    cases,
    source: fakeSource(TREE),
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({
      ok: true,
      settings: {
        scan: { ...SCAN_DEFAULTS, validator: false, exclude: ["gen/"], ...opts.scan },
        lenses: opts.lenses,
        riskPasses: opts.riskPasses ?? ["pass-data-safety"],
      },
    }),
    buildAgents: () => ({ ok: true }),
  };
}

const ledger = (): LedgerFile => JSON.parse(readFileSync(join(stateDir, LEDGER_FILE), "utf8")) as LedgerFile;

/** Stage 1's calibration run: 3 units, $0.05 over 150 lines. */
async function calibrate(s: ScanRunner): Promise<void> {
  const p = await s.preview();
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await s.start({ key: p.preview.key });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await s.idle();
}

const STAGE1_RATE = (0.05 / 150) * 1000;

const CROSS: Stage2RowRequest = {
  lens: "pass-security",
  files: ["app/views.py", "lib/util.py"],
  reason: "the views trust util's token check",
};

async function propose(s: ScanRunner, rows: unknown[], extra: { budget_usd?: number } = {}) {
  const r = await s.proposeStage2({ rows, ...extra });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.proposal;
}

describe("pairing tests with their code", () => {
  const tree = Object.keys(TREE);
  it("pairs a test beside, under, or in a top-level tree mirroring the code — same subject, same language", () => {
    expect(pairTests("app/views.py", tree)).toEqual(["app/tests/test_views.py"]);
    expect(pairTests("lib/util.py", tree)).toEqual(["tests/lib/test_util.py"]);
    expect(pairTests("web/index.ts", tree)).toEqual(["web/index.test.ts"]);
    expect(pairTests("app/models.py", tree)).toEqual([]);
  });

  it("mirrors src/main and src/test, never crosses a language, and the nearest win", () => {
    const t = [
      "src/main/java/acme/Billing.java",
      "src/test/java/acme/BillingTest.java",
      "svc/billing.py",
      "svc/billing.test.ts",
      "svc/tests/test_billing.py",
      "other/tests/test_billing.py",
    ];
    expect(pairTests("src/main/java/acme/Billing.java", t)).toEqual(["src/test/java/acme/BillingTest.java"]);
    expect(pairTests("svc/billing.py", t)).toEqual(["svc/tests/test_billing.py"]);
    expect(pairTests("svc/tests/test_billing.py", t)).toEqual([]);
  });
});

describe("a stage 2 proposal", () => {
  it("is refused until stage 1 has measured a price", async () => {
    const r = await new ScanRunner(ports(runner())).proposeStage2({ rows: [CROSS] });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.errors.join(" ")).toMatch(/run stage 1/);
  });

  it("takes a CROSS-MODULE row, pairs its tests, and prices it from the ledger; it runs nothing and is stored", async () => {
    const cases = runner();
    const s = new ScanRunner(ports(cases));
    await calibrate(s);
    const before = cases.specs.length;
    const p = await propose(s, [CROSS]);
    const row = p.rows[0]!;
    expect(row).toMatchObject({ id: "row-1", lens: "pass-security", tier: "sol-med", status: "run", units: ["app", "lib", "tests"] });
    expect(row.files.map((f) => f.path)).toEqual(["app/views.py", "lib/util.py"]);
    expect(row.tests.map((f) => f.path)).toEqual(["app/tests/test_views.py", "tests/lib/test_util.py"]);
    expect(row.lines).toBe(20 + 30 + 8 + 12);
    // Never measured, nothing else at this tier/effort: stage 1's rate × the factor.
    expect(row.price.basis).toBe("extrapolated");
    expect(row.estimate_usd).toBeCloseTo((70 / 1000) * STAGE1_RATE * SCAN_DEFAULTS.unmeasured_rate_factor, 9);
    expect(p.cap_usd).toBe(row.estimate_usd);
    expect(cases.specs.length).toBe(before);
    const stored = JSON.parse(readFileSync(join(stateDir, STAGE2_FILE), "utf8"));
    expect(stored.proposal.key).toBe(p.key);
  });

  it("never borrows pass-scan's rate: a deep lens at stage 1's tier and effort is still extrapolated", async () => {
    // A profile giving pass-security `effort = "low"` puts it at pass-scan's
    // exact settings (sol-med, low, validator off) — stage 1's cheap rate must
    // still reach it only through the factor.
    const s = new ScanRunner(ports(runner(), { lenses: { "pass-security": { effort: "low" } } }));
    await calibrate(s);
    const p = await propose(s, [CROSS]);
    expect(p.rows[0]!.effort).toBe("low");
    expect(p.rows[0]!.price).toMatchObject({ basis: "extrapolated", from: "pass-scan" });
    expect(p.rows[0]!.estimate_usd).toBeCloseTo((70 / 1000) * STAGE1_RATE * SCAN_DEFAULTS.unmeasured_rate_factor, 9);
  });

  it("refuses, as a whole, a row naming a test, an excluded or missing file, a non-deep or switched-off lens, or a tier the lens is not built at", async () => {
    const s = new ScanRunner(
      ports(runner(), { lenses: { "pass-ui": { enabled: false }, "pass-contracts": { min_tier: "sol-high" } } }),
    );
    await calibrate(s);
    const r = await s.proposeStage2({
      rows: [
        CROSS,
        { lens: "pass-security", files: ["app/tests/test_views.py"], reason: "r" },
        { lens: "pass-security", files: ["gen/out.py", "nope.py"], reason: "r" },
        { lens: "pass-intent", files: ["app/views.py"], reason: "r" },
        { lens: "pass-scan", files: ["app/views.py"], reason: "r" },
        { lens: "pass-ui", files: ["web/index.ts"], reason: "r" },
        { lens: "pass-contracts", files: ["web/index.ts"], tier: "sol-med", reason: "r" },
        { lens: "pass-data-safety", files: ["app/models.py"], tier: "sol-med", reason: "r" },
        { lens: "pass-security", files: ["app/views.py"], reason: "" },
      ],
    });
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors;
    expect(errors).toHaveLength(8);
    expect(errors[0]).toMatch(/^row-2: .*test — tests enter stage 2 only paired/);
    expect(errors[1]).toMatch(/^row-3: gen\/out\.py is excluded .*; nope\.py is not in the tree/);
    expect(errors[2]).toMatch(/^row-4: "pass-intent" is not a deep lens/);
    expect(errors[3]).toMatch(/^row-5: pass-scan is stage 1's lens/);
    expect(errors[4]).toMatch(/^row-6: "pass-ui" is switched off/);
    expect(errors[5]).toMatch(/^row-7: pass-contracts cannot run at "sol-med" here — one of: sol-high/);
    expect(errors[6]).toMatch(/^row-8: pass-data-safety cannot run at "sol-med" here — one of: sol-high/);
    expect(errors[7]).toMatch(/^row-9: no reason/);
    // Nothing stored from a refused proposal.
    expect(() => readFileSync(join(stateDir, STAGE2_FILE))).toThrow();
  });

  it("names migrations outright, and gives a lens with a floor its floor by default", async () => {
    const s = new ScanRunner(ports(runner(), { lenses: { "pass-contracts": { min_tier: "sol-high" } } }));
    await calibrate(s);
    const p = await propose(s, [
      { lens: "pass-data-safety", files: ["app/models.py", "app/migrations/0001_init.py"], reason: "the model and its migration" },
      { lens: "pass-contracts", files: ["web/index.ts"], reason: "the exported API" },
    ]);
    expect(p.rows.map((r) => r.tier)).toEqual(["sol-high", "sol-high"]);
    expect(p.rows[0]!.files.map((f) => f.path)).toContain("app/migrations/0001_init.py");
  });

  it("never pairs a test that [scan] exclude keeps out of scans (selfscan 30a4d516)", async () => {
    const s = new ScanRunner(ports(runner(), { scan: { exclude: ["gen/", "tests/lib/"] } }));
    await calibrate(s);
    const p = await propose(s, [CROSS]);
    expect(p.rows[0]!.tests.map((f) => f.path)).toEqual(["app/tests/test_views.py"]);
    expect(p.rows[0]!.unpaired).toEqual([]);
    expect(p.rows[0]!.lines).toBe(20 + 30 + 8);
  });

  it("refuses a row of several files bigger than one case, paired tests included in the count", async () => {
    const s = new ScanRunner(ports(runner(), { scan: { case_max_lines: 40 } }));
    await calibrate(s);
    const r = await s.proposeStage2({ rows: [{ lens: "pass-security", files: ["app/views.py", "lib/util.py"], reason: "two" }] });
    expect(!r.ok && r.errors[0]).toMatch(/over one case .* split it/);
    // ONE file over one case is not refused: it is cut into line ranges
    // (tests/scan-oversize.test.ts).
    const big = await propose(s, [{ lens: "pass-security", files: ["lib/big.py"], reason: "big" }]);
    expect(big.rows[0]!.ranges!.length).toBeGreaterThanOrEqual(2);
    // A row that fits without its test keeps the code and names the test it could not pair.
    const p = await propose(s, [{ lens: "pass-security", files: ["lib/util.py"], reason: "util" }]);
    expect(p.rows[0]!.tests).toEqual([]);
    expect(p.rows[0]!.unpaired).toEqual(["tests/lib/test_util.py"]);
  });

  it("is fitted to a budget in the companion's order: a row that does not fit is left out, a later cheaper one still fits", async () => {
    const s = new ScanRunner(ports(runner()));
    await calibrate(s);
    const perKline = STAGE1_RATE * SCAN_DEFAULTS.unmeasured_rate_factor;
    // row-1: 70 lines; row-2: lib/big.py, 50 lines; row-3: tools/x.py, 15 lines.
    const budget = ((70 + 15) / 1000) * perKline + 1e-6;
    const p = await propose(
      s,
      [
        CROSS,
        { lens: "pass-concurrency", files: ["lib/big.py"], reason: "shared cache" },
        { lens: "pass-prod-risk", files: ["tools/x.py"], reason: "the cron tool" },
      ],
      { budget_usd: budget },
    );
    expect(p.rows.map((r) => r.status)).toEqual(["run", "over-budget", "run"]);
    expect(p.runnable).toBe(2);
    expect(p.cap_usd).toBeCloseTo((85 / 1000) * perKline, 9);
    expect(p.over_budget_usd).toBeCloseTo((50 / 1000) * perKline, 9);
    expect(await s.proposeStage2({ rows: [CROSS], budget_usd: -1 })).toMatchObject({ ok: false });
  });
});

describe("starting stage 2 on the operator's word", () => {
  it("runs one case per row with the row's lens and tier; findings are filed under the owning unit; the ledger keys the lens", async () => {
    const cases = runner();
    const s = new ScanRunner(ports(cases));
    await calibrate(s);
    const p = await propose(s, [CROSS]);
    const r = await s.startStage2({ key: p.key });
    expect(r.ok).toBe(true);
    await s.idle();

    const spec = cases.specs.at(-1)!;
    expect(spec.agent).toBe("pass-security--sol-med");
    expect(spec.files).toEqual(["app/views.py", "lib/util.py", "app/tests/test_views.py", "tests/lib/test_util.py"]);
    expect(spec.prompt).toMatch(/stage 2, row-1: pass-security across units app, lib, tests/);
    expect(spec.prompt).toMatch(/Why this case: the views trust util's token check/);
    expect(spec.prompt).toMatch(/Their tests \(2 — read them for the contract/);

    const run = s.status().run!;
    expect(run).toMatchObject({ mode: "stage2", state: "complete", plan_key: p.key });
    expect(run.cases[0]).toMatchObject({ lens: "pass-security", tier: "sol-med", units: ["app", "lib", "tests"], findings: 2 });

    const { findings } = new FindingsStore(stateHomeFs(stateDir)).list({ lens: "pass-security" });
    expect(findings.map((f) => [f.path, f.unit]).sort()).toEqual([
      ["app/views.py", "app"],
      ["lib/util.py", "lib"],
    ]);
    const deep = ledger().entries.filter((e) => e.lens === "pass-security");
    expect(deep.map((e) => e.path).sort()).toEqual(["app/tests/test_views.py", "app/views.py", "lib/util.py", "tests/lib/test_util.py"]);
    expect(deep.every((e) => e.tier === "sol-med" && e.effort === "tier" && e.sha === SHA)).toBe(true);
    expect(s.status().ledger).toMatchObject({ deep_files: 4 });
  });

  it("afterwards: the same row is covered (free, not run again); the lens is measured; another lens at those settings borrows it", async () => {
    const s = new ScanRunner(ports(runner()));
    await calibrate(s);
    await s.startStage2({ key: (await propose(s, [CROSS])).key });
    await s.idle();
    const p = await propose(s, [
      CROSS,
      { lens: "pass-security", files: ["web/index.ts"], reason: "the client token" },
      { lens: "pass-contracts", files: ["web/index.ts"], reason: "the exported API" },
    ]);
    expect(p.rows.map((r) => [r.status, r.price.basis])).toEqual([
      ["covered", "measured"],
      ["run", "measured"],
      ["run", "borrowed"],
    ]);
    expect(p.rows[0]!.estimate_usd).toBe(0);
    // $0.04 over 70 lines, measured.
    expect(p.rows[1]!.price.rate.usd_per_kline).toBeCloseTo((0.04 / 70) * 1000, 9);
    expect(p.rows[2]!.price.from).toBe("pass-security");

    const only = await propose(s, [CROSS]);
    expect(only.runnable).toBe(0);
    expect(await s.startStage2({ key: only.key })).toMatchObject({ ok: false, errors: [expect.stringMatching(/nothing to run/)] });
  });

  it("refuses no key, a key that is not the latest proposal, and a proposal whose price moved since it was shown", async () => {
    const s = new ScanRunner(ports(runner()));
    await calibrate(s);
    expect(await s.startStage2({})).toMatchObject({ ok: false });
    const first = await propose(s, [CROSS]);
    const second = await propose(s, [{ lens: "pass-security", files: ["web/index.ts"], reason: "the client token" }]);
    expect(await s.startStage2({ key: first.key })).toMatchObject({ ok: false, errors: [expect.stringMatching(/not the latest/)] });
    // Stage 1 reads tools/ — the stage-1 rate moves, so the extrapolated price does.
    const p1 = await s.preview();
    await s.start({ key: p1.ok ? p1.preview.key : "" });
    await s.idle();
    expect(await s.startStage2({ key: second.key })).toMatchObject({ ok: false, errors: [expect.stringMatching(/plan changed since the proposal/)] });
  });

  it("stops HARD at the approved estimate: a row whose actuals outrun it ends the run, later rows are skipped", async () => {
    const s = new ScanRunner(ports(runner(5), { scan: { concurrency: 1 } }));
    await calibrate(s);
    const p = await propose(s, [CROSS, { lens: "pass-security", files: ["web/index.ts"], reason: "the client token" }]);
    await s.startStage2({ key: p.key });
    await s.idle();
    const run = s.status().run!;
    expect(run.state).toBe("capped");
    expect(run.cases.map((c) => c.status)).toEqual(["done", "skipped"]);
    expect(ledger().entries.some((e) => e.path === "web/index.ts" && e.lens === "pass-security")).toBe(false);
  });
});

describe("starting stage 2 from the TUI", () => {
  it("the click asks for the proposal it showed; the companion starts it and answers once", async () => {
    const cases = runner();
    const s = new ScanRunner(ports(cases));
    await calibrate(s);
    const p = await propose(s, [CROSS]);

    const shown = readStage2Proposal(stateDir);
    expect(shown.ok && shown.proposal?.key).toBe(p.key);
    const click = clickStartStage2(stateDir, p.key, new Date("2026-09-29T11:00:00Z"));
    expect(click.ok).toBe(true);
    if (!click.ok) return;
    expect(click.line).toMatch(/1 row\(s\), hard stop \$0\.\d\d/);
    expect(stage2ClickOutcome(stateDir, click.request)).toBeNull();

    const result = await s.consumeStage2Request();
    expect(result).toMatchObject({ ok: true, request: click.request, key: p.key });
    await s.idle();
    expect(s.status().run).toMatchObject({ mode: "stage2", state: "complete" });
    expect(stage2ClickOutcome(stateDir, click.request)).toBe(`stage 2 started: ${result!.run}`);
    // Answered once: the same request never starts a second run.
    expect(await s.consumeStage2Request()).toBeNull();
    expect(JSON.parse(readFileSync(join(stateDir, STAGE2_RESULT_FILE), "utf8")).request).toBe(click.request);
  });

  it("a click on a proposal that moved is refused at the TUI; one that moved after the click is refused by the companion", async () => {
    const s = new ScanRunner(ports(runner()));
    await calibrate(s);
    expect(clickStartStage2(stateDir, "whatever")).toMatchObject({ ok: false, line: expect.stringMatching(/no stage 2 proposal/) });
    const first = await propose(s, [CROSS]);
    const second = await propose(s, [{ lens: "pass-security", files: ["web/index.ts"], reason: "the client token" }]);
    expect(clickStartStage2(stateDir, first.key)).toMatchObject({ ok: false, line: expect.stringMatching(/changed since it was shown/) });

    const click = clickStartStage2(stateDir, second.key);
    expect(click.ok).toBe(true);
    // A new proposal lands between the click and the companion's pick-up.
    await propose(s, [CROSS]);
    const result = await s.consumeStage2Request();
    expect(result).toMatchObject({ ok: false, errors: [expect.stringMatching(/not the latest/)] });
    expect(click.ok && stage2ClickOutcome(stateDir, click.request)).toMatch(/^stage 2 refused: /);
    expect(s.status().run!.mode).toBe("calibration");
    expect(readFileSync(join(stateDir, STAGE2_START_FILE), "utf8")).toContain(second.key);
  });

  it("the click may NARROW the plan: only the kept rows run, stopped hard at their total", async () => {
    const cases = runner();
    const s = new ScanRunner(ports(cases));
    await calibrate(s);
    const p = await propose(s, [CROSS, { lens: "pass-security", files: ["web/index.ts"], reason: "the client token" }]);
    expect(p.rows.map((r) => r.status)).toEqual(["run", "run"]);
    const keptCap = p.rows[1]!.estimate_usd;

    const click = clickStartStage2(stateDir, p.key, new Date("2026-09-29T11:00:00Z"), ["row-2"]);
    expect(click.ok).toBe(true);
    if (!click.ok) return;
    expect(click.line).toContain(`1 row(s), hard stop $${keptCap.toFixed(2)}`);
    expect(JSON.parse(readFileSync(join(stateDir, STAGE2_START_FILE), "utf8")).rows).toEqual(["row-2"]);

    const before = cases.specs.length;
    expect(await s.consumeStage2Request()).toMatchObject({ ok: true });
    await s.idle();
    const run = s.status().run!;
    expect(run.cases.map((c) => c.id)).toEqual(["row-2"]);
    expect(run.cap_usd).toBeCloseTo(keptCap, 9);
    expect(cases.specs.slice(before).map((c) => c.files)).toEqual([["web/index.ts", "web/index.test.ts"]]);
  });

  it("a narrowed click can never name a row that was not runnable, nor keep nothing — at the TUI and at the engine", async () => {
    const s = new ScanRunner(ports(runner()));
    await calibrate(s);
    const perKline = STAGE1_RATE * SCAN_DEFAULTS.unmeasured_rate_factor;
    const p = await propose(
      s,
      [CROSS, { lens: "pass-concurrency", files: ["lib/big.py"], reason: "shared cache" }],
      { budget_usd: (70 / 1000) * perKline + 1e-6 },
    );
    expect(p.rows.map((r) => r.status)).toEqual(["run", "over-budget"]);
    expect(clickStartStage2(stateDir, p.key, undefined, ["row-2"])).toMatchObject({ ok: false, line: expect.stringMatching(/not a runnable row.*row-2/) });
    expect(clickStartStage2(stateDir, p.key, undefined, [])).toMatchObject({ ok: false, line: expect.stringMatching(/keep at least one/) });
    expect(await s.startStage2({ key: p.key, rows: ["row-2"] })).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a runnable row/)] });
    expect(await s.startStage2({ key: p.key, rows: "row-1" })).toMatchObject({ ok: false });
    expect(s.status().run!.mode).toBe("calibration");
  });
});
