// The deep scan: `[scan] depth = "deep"` and what it changes. Asserted at
// the seams the scan already has — the config parser and the profile loader,
// the agent build (`buildAgents` / `buildScanAgents`), the coverage ledger,
// the pure stage-2 planner, and the ScanRunner and its tools driven the
// engine way (every port faked, the state home a temp dir). A standard scan
// is pinned unchanged beside each deep behaviour.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderPreview, renderStatus, scanToolDefinitions } from "../extensions/setup-scan.js";
import { parseConfig, SCAN_DEFAULTS, type Config, type ScanConfig } from "../src/config.js";
import {
  NO_BUDGET_ADDENDUM,
  PASS_ADDENDA,
  SCAN_DEEP_CONSISTENCY_ADDENDUM,
  SCAN_DEEP_DIG_ADDENDUM,
  SCAN_DEEP_DUPLICATION_ADDENDUM,
  SCAN_DEEP_MAINTAINABILITY_ADDENDUM,
  SCAN_DEEP_MAX_SUGGESTIONS,
  SCAN_DEEP_RECALL_ADDENDUM,
  SCAN_DEEP_SUGGEST_ADDENDUM,
  SCAN_DELIVERY_ADDENDUM,
  addendaForPass,
  buildAgents,
  type PassAddendum,
} from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import type { LensTuningMap } from "../src/lenstuning.js";
import { ALL_PASSES, SCAN_DEEP_FLOOR_LENSES } from "../src/passes.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import {
  coveredBy,
  Ledger,
  LEDGER_FILE,
  measuredRate,
  readings,
  type LedgerEntry,
  type LedgerFile,
} from "../src/setup/ledger.js";
import { MAX_SUGGESTIONS, SCAN_DEEP_LENSES, SCAN_PASS } from "../src/setup/scan.js";
import { buildScanAgents, scanConfig } from "../src/setup/scanbuild.js";
import {
  ScanRunner,
  type ScanPorts,
  type ScanSettings,
  type ScanSource,
  type ScanTree,
} from "../src/setup/scanrun.js";
import {
  MAX_STAGE2_ROWS,
  planStage2,
  priceStage2Row,
  type RowPrice,
  type Stage2PlanInput,
  type Stage2Row,
  type Stage2RowRequest,
} from "../src/setup/stage2.js";
import { priceIsMeasured, priceLabel, readStage2Proposal } from "../src/setup/stage2request.js";
import type { UnitCut } from "../src/setup/unitcut.js";

const sandbox = join(import.meta.dirname, "..");
const fixtureToml = readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8");
const fixture: Config = parseConfig(fixtureToml);

let dir: string;
let env: InstallEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-deep-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- the config ----------------------------------------------------------------

function profile(name: string, toml: string): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), toml);
}

function configWith(name: string, extra = ""): string {
  return `${fixtureToml.replace(/^profile = .*$/m, "")}\n${extra}`.replace(
    /^\[review\]$/m,
    `[review]\nprofile = "${name}"`,
  );
}

describe("[scan] depth and deep_lenses", () => {
  it("default to a standard scan whose floor would be consistency, delivery, duplication and maintainability", () => {
    expect(fixture.scan.depth).toBe("standard");
    expect(SCAN_DEFAULTS.depth).toBe("standard");
    expect(SCAN_DEFAULTS.deep_lenses).toEqual([
      "pass-consistency",
      "pass-delivery",
      "pass-duplication",
      "pass-maintainability",
    ]);
    expect(SCAN_DEFAULTS.deep_lenses).toEqual([...SCAN_DEEP_FLOOR_LENSES]);
  });

  it("config.toml may make it deep and name the floor's lenses (a repeat kept once)", () => {
    const cfg = parseConfig(
      `${fixtureToml}\n[scan]\ndepth = "deep"\ndeep_lenses = ["pass-delivery", "pass-security", "pass-delivery"]\n`,
    );
    expect(cfg.scan).toEqual({
      ...SCAN_DEFAULTS,
      depth: "deep",
      deep_lenses: ["pass-delivery", "pass-security"],
    });
  });

  it("refuses a depth it does not know and a floor lens a scan cannot run, naming it", () => {
    expect(() => parseConfig(`${fixtureToml}\n[scan]\ndepth = "max"\n`)).toThrow(
      /\[scan\] depth must be "standard" or "deep"/,
    );
    expect(() => parseConfig(`${fixtureToml}\n[scan]\ndeep_lenses = ["pass-intent"]\n`)).toThrow(
      /\[scan\] deep_lenses entry "pass-intent" is not a lens a scan can run/,
    );
    expect(() => parseConfig(`${fixtureToml}\n[scan]\ndeep_lenses = ["pass-nope"]\n`)).toThrow(
      /deep_lenses entry "pass-nope"/,
    );
    expect(() => parseConfig(`${fixtureToml}\n[scan]\ndeep_lenses = []\n`)).toThrow(
      /deep_lenses must be a non-empty array/,
    );
  });

  it("a repo profile overrides both, along its extends chain", () => {
    profile("base", `[scan]\ndepth = "deep"\n`);
    profile("repo", `extends = "base"\n[scan]\ndeep_lenses = ["pass-consistency"]\n`);
    const cfg = scanConfig(
      sandbox,
      configWith("repo", `[scan]\ndepth = "standard"\ndeep_lenses = ["pass-security"]\n`),
      { env },
    );
    expect(cfg.scan.depth).toBe("deep");
    expect(cfg.scan.deep_lenses).toEqual(["pass-consistency"]);
    profile("bad", `[scan]\ndeep_lenses = ["pass-sweep"]\n`);
    expect(() => scanConfig(sandbox, configWith("bad"), { env })).toThrow(
      /deep_lenses entry "pass-sweep"/,
    );
  });
});

// ---- pass-delivery's recast, at either depth --------------------------------------

describe("pass-delivery's scan recast composes at both depths", () => {
  it("is a depth-free scan entry: a standard and a deep scan build both carry it", () => {
    const ids = (depth: "standard" | "deep") =>
      addendaForPass("pass-delivery", PASS_ADDENDA, "django", "scan", depth).map((a) => a.id);
    expect(PASS_ADDENDA.find((a) => a.id === "scan-delivery")?.depth).toBeUndefined();
    expect(ids("standard")).toContain("scan-delivery");
    expect(ids("deep")).toContain("scan-delivery");
    expect(
      addendaForPass("pass-delivery", PASS_ADDENDA, "django", "pr", "deep").map((a) => a.id),
    ).not.toContain("scan-delivery");
  });
});

// ---- the build -------------------------------------------------------------------

function built(out: string): Map<string, string> {
  return new Map(
    readdirSync(out).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(out, f), "utf8")]),
  );
}

function prBuild(out: string, addenda: readonly PassAddendum[]): Map<string, string> {
  buildAgents(join(sandbox, "agents"), join(dir, out), {
    root: sandbox,
    tiers: fixture.models.tiers,
    riskPasses: fixture.models.risk_passes,
    validateTier: fixture.models.validate_tier,
    addenda,
  });
  return built(join(dir, out));
}

function scanBuild(out: string, depth: "standard" | "deep", addenda?: readonly PassAddendum[]) {
  buildAgents(join(sandbox, "agents"), join(dir, out), {
    root: sandbox,
    mode: "scan",
    scanDepth: depth,
    extraSrcDirs: [join(sandbox, "agents/scan")],
    tiers: fixture.models.tiers,
    riskPasses: fixture.models.risk_passes,
    validateTier: "terra-med",
    ...(addenda ? { addenda } : {}),
  });
  return built(join(dir, out));
}

const LENS_RECASTS: Record<string, string> = {
  "pass-consistency": "scan-deep-consistency",
  "pass-duplication": "scan-deep-duplication",
  "pass-maintainability": "scan-deep-maintainability",
};
const DEEP_IDS = [
  "scan-deep-suggest",
  "scan-deep-dig",
  ...Object.values(LENS_RECASTS),
  "scan-deep-recall",
  "scan-deep-no-budget",
];
const NEW_IDS = ["scan-delivery", ...DEEP_IDS];
const lensOf = (variant: string): string => variant.replace(/--.*$/, "");

describe("the deep addenda compose into a deep scan build alone", () => {
  it("only scan-mode entries carry a depth, and these are the deep ones", () => {
    for (const a of PASS_ADDENDA) if (a.depth !== undefined) expect(a.mode, a.id).toBe("scan");
    expect(
      PASS_ADDENDA.filter((a) => a.depth === "deep").map((a) => [a.id, a.scope, a.mode]),
    ).toEqual([
      ["scan-deep-suggest", [SCAN_PASS], "scan"],
      ["scan-deep-dig", SCAN_DEEP_LENSES, "scan"],
      ["scan-deep-consistency", ["pass-consistency"], "scan"],
      ["scan-deep-duplication", ["pass-duplication"], "scan"],
      ["scan-deep-maintainability", ["pass-maintainability"], "scan"],
      ["scan-deep-recall", SCAN_DEEP_LENSES, "scan"],
      ["scan-deep-no-budget", SCAN_DEEP_LENSES, "scan"],
    ]);
    // The PR rule's own words: a deep scan lens is told what a PR lens is.
    expect(PASS_ADDENDA.find((a) => a.id === "scan-deep-no-budget")!.text).toBe(NO_BUDGET_ADDENDUM);
  });

  it("deep adds exactly the suggest rule to pass-scan, and the dig, recall and no-budget rules (and its own recast) to every lens a scan runs — nothing to the validator", () => {
    for (const pass of [SCAN_PASS, ...ALL_PASSES]) {
      const at = (depth: "standard" | "deep") =>
        addendaForPass(pass, PASS_ADDENDA, "django", "scan", depth).map((a) => a.id);
      const added = at("deep").filter((id) => !at("standard").includes(id));
      const want =
        pass === SCAN_PASS
          ? ["scan-deep-suggest"]
          : SCAN_DEEP_LENSES.includes(pass)
            ? [
                "scan-deep-dig",
                ...(LENS_RECASTS[pass] ? [LENS_RECASTS[pass]!] : []),
                "scan-deep-recall",
                "scan-deep-no-budget",
              ]
            : [];
      expect(added, pass).toEqual(want);
      // A deep build only ever ADDS: every standard entry stays, in order.
      expect(
        at("deep").filter((id) => at("standard").includes(id)),
        pass,
      ).toEqual(at("standard"));
      // No PR build composes any of the three new entries.
      expect(
        addendaForPass(pass).map((a) => a.id),
        pass,
      ).not.toEqual(expect.arrayContaining([expect.stringMatching(/^scan-(delivery|deep-)/)]));
    }
  });

  it("a PR build is byte-identical without the three new entries, and a standard scan build without the deep two", () => {
    const pr = prBuild("pr", PASS_ADDENDA);
    expect(pr).toEqual(
      prBuild(
        "pr-old",
        PASS_ADDENDA.filter((a) => !NEW_IDS.includes(a.id)),
      ),
    );
    const standard = scanBuild("std", "standard");
    expect(standard).toEqual(
      scanBuild(
        "std-old",
        "standard",
        PASS_ADDENDA.filter((a) => !DEEP_IDS.includes(a.id)),
      ),
    );
    // The only standard scan body the new entries touch is pass-delivery's.
    const withoutAny = scanBuild(
      "std-none",
      "standard",
      PASS_ADDENDA.filter((a) => !NEW_IDS.includes(a.id)),
    );
    for (const [name, body] of standard) {
      if (lensOf(name) === "pass-delivery") {
        expect(body, name).toContain(SCAN_DELIVERY_ADDENDUM);
        expect(withoutAny.get(name), name).not.toContain(SCAN_DELIVERY_ADDENDUM);
      } else expect(body, name).toBe(withoutAny.get(name));
    }
  });

  it("a deep scan build carries the suggest rule on pass-scan, the dig rule on every deep lens, the delivery recast on pass-delivery", () => {
    const deep = scanBuild("deep", "deep");
    const standard = scanBuild("std", "standard");
    expect([...deep.keys()].sort()).toEqual([...standard.keys()].sort());
    for (const [name, body] of deep) {
      const lens = lensOf(name);
      expect(body.includes(SCAN_DEEP_SUGGEST_ADDENDUM), name).toBe(lens === SCAN_PASS);
      expect(body.includes(SCAN_DEEP_DIG_ADDENDUM), name).toBe(SCAN_DEEP_LENSES.includes(lens));
      expect(body.includes(SCAN_DELIVERY_ADDENDUM), name).toBe(lens === "pass-delivery");
      expect(standard.get(name)!.includes(SCAN_DEEP_DIG_ADDENDUM), name).toBe(false);
      expect(standard.get(name)!.includes(SCAN_DEEP_SUGGEST_ADDENDUM), name).toBe(false);
    }
    // A PR build is always standard, whatever it is asked for.
    buildAgents(join(sandbox, "agents"), join(dir, "pr-deep"), {
      root: sandbox,
      scanDepth: "deep",
      tiers: fixture.models.tiers,
      riskPasses: fixture.models.risk_passes,
      validateTier: fixture.models.validate_tier,
    });
    expect(built(join(dir, "pr-deep"))).toEqual(prBuild("pr", PASS_ADDENDA));
  });

  it("buildScanAgents builds at [scan] depth", () => {
    const out = join(dir, "via-cfg");
    buildScanAgents(
      sandbox,
      out,
      { ...fixture, scan: { ...fixture.scan, depth: "deep" } },
      { env },
    );
    const agents = built(out);
    expect(agents.get(`pass-scan--${fixture.scan.tier}`)).toContain(SCAN_DEEP_SUGGEST_ADDENDUM);
    expect(agents.get("pass-consistency--sol-med")).toContain(SCAN_DEEP_DIG_ADDENDUM);
  });

  it("the rules say what the spec asks them to", () => {
    expect(SCAN_DEEP_SUGGEST_ADDENDUM).toContain(
      "Name every focus file in at least one SUGGEST row",
    );
    expect(SCAN_DEEP_SUGGEST_ADDENDUM).toContain(`in up to ${SCAN_DEEP_MAX_SUGGESTIONS} rows`);
    for (const l of [
      "pass-consistency",
      "pass-duplication",
      "pass-maintainability",
      "pass-simplicity",
      "pass-abstraction",
      "pass-delivery",
    ])
      expect(SCAN_DEEP_SUGGEST_ADDENDUM, l).toContain(`\`${l}\``);
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("read its callers, its callees and its siblings");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("state × obligation table");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("the terminal ones too (closed, paused");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("RECORDED before the skip");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("ask what each branch does while one lags the other");
    // The other direction of the table, a reason's reach, the fall-through,
    // a lagging search index, and the argument against the value in hand.
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("the cell treated the SAME as its siblings");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("does not justify the side effects");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("name the work it then reaches");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("a search index and the list endpoint");
    expect(SCAN_DEEP_DIG_ADDENDUM).toContain("Every argument against the value in hand");
    expect(SCAN_DEEP_RECALL_ADDENDUM).toContain("There is no diff to fetch");
    expect(SCAN_DEEP_RECALL_ADDENDUM).toContain("Read every focus file to its end");
    expect(SCAN_DEEP_RECALL_ADDENDUM).toContain("Small is not silent");
    expect(SCAN_DEEP_RECALL_ADDENDUM).toContain("Report what another lens owns");
    expect(SCAN_DEEP_CONSISTENCY_ADDENDUM).toContain(
      "the member that does the same as the rest when its case means it should not",
    );
    expect(SCAN_DEEP_DUPLICATION_ADDENDUM).toContain("List the knowledge");
    expect(SCAN_DEEP_DUPLICATION_ADDENDUM).toContain("Three or more copies are one finding");
    expect(SCAN_DEEP_MAINTAINABILITY_ADDENDUM).toContain(
      "Every declared field: who fills it, who reads it",
    );
    expect(SCAN_DEEP_MAINTAINABILITY_ADDENDUM).toContain(
      "Every callback argument against the value in hand",
    );
  });
});

// ---- the ledger --------------------------------------------------------------------

const row = (over: Partial<LedgerEntry>): LedgerEntry => ({
  path: "a.py",
  blob: "A",
  lens: "pass-consistency",
  tier: "sol-med",
  effort: "tier",
  validator: false,
  sha: "s",
  lines: 100,
  cost_usd: 0.1,
  run: "r1",
  case: "c1",
  at: "2026-10-01T00:00:00Z",
  ...over,
});

describe("the coverage ledger honours depth", () => {
  it("a row with no depth is a standard reading: it covers a standard plan and never a deep one", () => {
    const rows = [row({})];
    expect(coveredBy(rows, "pass-consistency")).toEqual(new Set(["a.py\0A"]));
    expect(coveredBy(rows, "pass-consistency", "standard")).toEqual(new Set(["a.py\0A"]));
    expect(coveredBy(rows, "pass-consistency", "deep")).toEqual(new Set());
    expect(readings(rows, "pass-consistency", "deep").size).toBe(0);
  });

  it("a deep reading covers both depths", () => {
    const rows = [row({ depth: "deep" })];
    expect(coveredBy(rows, "pass-consistency", "deep")).toEqual(new Set(["a.py\0A"]));
    expect(coveredBy(rows, "pass-consistency")).toEqual(new Set(["a.py\0A"]));
  });

  it("a later reading of other content supersedes a deep one, at any depth", () => {
    const rows = [
      row({ depth: "deep", at: "2026-10-01T00:00:00Z" }),
      row({ blob: "B", at: "2026-10-02T00:00:00Z", run: "r2" }),
    ];
    // The file is back at A: the deep reading of A was superseded by B's.
    expect(coveredBy(rows, "pass-consistency", "deep")).toEqual(new Set());
    expect(coveredBy(rows, "pass-consistency")).toEqual(new Set(["a.py\0B"]));
  });

  it("a deep range reading is complete only over deep ranges", () => {
    const rows = [
      row({ range: { start: 1, end: 60, total: 100 }, depth: "deep" }),
      row({ range: { start: 50, end: 100, total: 100 } }),
    ];
    expect(coveredBy(rows, "pass-consistency")).toEqual(new Set(["a.py\0A"]));
    expect(coveredBy(rows, "pass-consistency", "deep")).toEqual(new Set());
    expect(readings(rows, "pass-consistency", "deep").get("a.py")!.ranges).toEqual([
      { start: 1, end: 60, total: 100 },
    ]);
  });

  it("records a standard and a deep row of one file side by side; an old ledger reads as it was", () => {
    const state = stateHomeFs(join(dir, "state"));
    // A ledger written before depths: rows with no depth field.
    const old: LedgerFile = { version: 1, entries: [row({})] };
    state.write(LEDGER_FILE, `${JSON.stringify(old)}\n`);
    const ledger = new Ledger(state);
    expect(ledger.load()).toEqual({ entries: [row({})], error: null });
    ledger.record([row({ depth: "deep", run: "r2" })]);
    const entries = ledger.load().entries;
    expect(entries.map((e) => e.depth ?? "standard")).toEqual(["standard", "deep"]);
    // A standard row written now is spelled exactly as before: no depth key.
    ledger.record([row({ blob: "C" })]);
    const raw = JSON.parse(readFileSync(join(dir, "state", LEDGER_FILE), "utf8")) as LedgerFile;
    expect(Object.keys(raw.entries.at(-1)!)).not.toContain("depth");
  });

  it("a rate is measured at one depth when asked, at any otherwise", () => {
    const rows = [row({ cost_usd: 0.1 }), row({ path: "b.py", cost_usd: 0.3, depth: "deep" })];
    const key = { lens: "pass-consistency", tier: "sol-med", effort: "tier", validator: false };
    expect(measuredRate(rows, key)!.usd_per_kline).toBeCloseTo(2, 9);
    expect(measuredRate(rows, { ...key, depth: "standard" })!.usd_per_kline).toBeCloseTo(1, 9);
    expect(measuredRate(rows, { ...key, depth: "deep" })!.usd_per_kline).toBeCloseTo(3, 9);
  });

  it("a stage-2 price stands on its own depth's readings when they price it as well; else it is marked across depth", () => {
    const cfg = { tier: "sol-med", effort: "low", validator: false, unmeasured_rate_factor: 4 };
    const stage1 = row({ lens: SCAN_PASS, effort: "low", path: "s.py", cost_usd: 0.05 });
    const std = row({ cost_usd: 0.2 });
    // Only standard readings of the lens: a deep row borrows them, and says so.
    const across = priceStage2Row(
      [stage1, std],
      cfg,
      "pass-consistency",
      "sol-med",
      "tier",
      "deep",
    )!;
    expect(across).toMatchObject({ basis: "measured", across_depth: true });
    expect(priceIsMeasured(across)).toBe(false);
    expect(priceLabel(across)).toBe("estimate: measured — from readings at the other depth");
    // A standard row is priced exactly as before.
    const same = priceStage2Row(
      [stage1, std],
      cfg,
      "pass-consistency",
      "sol-med",
      "tier",
      "standard",
    )!;
    expect(same).toEqual(priceStage2Row([stage1, std], cfg, "pass-consistency", "sol-med", "tier"));
    expect(same.across_depth).toBeUndefined();
    // A deep measurement of the lens wins for a deep row.
    const deep = row({ path: "d.py", cost_usd: 0.6, depth: "deep" });
    const own = priceStage2Row(
      [stage1, std, deep],
      cfg,
      "pass-consistency",
      "sol-med",
      "tier",
      "deep",
    )!;
    expect(own).toMatchObject({ basis: "measured" });
    expect(own.across_depth).toBeUndefined();
    expect(own.rate.usd_per_kline).toBeCloseTo(6, 9);
  });
});

// ---- the deep floor, planned -------------------------------------------------------

const lines = (n: number, word = "x"): string =>
  Array.from({ length: n }, (_, i) => `${word}_${i + 1} = ${i + 1}`).join("\n") + "\n";

const TREE: Record<string, string> = {
  "app/models.py": lines(10, "model"),
  "app/views.py": lines(20, "view"),
  "app/data.bin.py": lines(3),
  "app/tests/test_views.py": lines(8, "tv"),
  "app/migrations/0001_init.py": lines(6, "mig"),
  "lib/util.py": lines(30, "util"),
  "lib/big.py": lines(50, "big"),
  "web/index.ts": lines(40, "web"),
  "web/package-lock.json": "{}\n",
  "gen/out.py": lines(5),
  "tools/x.py": lines(15, "tool"),
  "orphan/y.py": lines(5),
};
const UNREADABLE = new Set(["app/data.bin.py"]);

const CUT: UnitCut = {
  units: ["app", "lib", "web", "gen", "tools"].map((u) => ({
    name: u,
    roots: [u],
    kind: "directory",
    note: "",
  })),
  ignored: [],
};

const blob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");

const PRICE: RowPrice = {
  rate: { usd_per_kline: 1, cases: 1, lines: 1000, cost_usd: 1 },
  basis: "measured",
  from: "x",
};

function floorInput(over: Partial<Stage2PlanInput> = {}): Stage2PlanInput {
  return {
    rows: [],
    cut: CUT,
    files: Object.entries(TREE).map(([path, text]) => ({ path, blob: blob(text) })),
    linesOf: (p) =>
      TREE[p] === undefined || UNREADABLE.has(p) ? null : TREE[p]!.split("\n").length - 1,
    exclude: ["gen/"],
    budget: { maxFiles: 30, maxLines: 3000 },
    riskPasses: ["pass-data-safety"],
    defaultTier: "sol-med",
    covered: () => new Set(),
    price: () => PRICE,
    budgetUsd: null,
    floor: SCAN_DEEP_FLOOR_LENSES,
    ...over,
  };
}

function planned(input: Stage2PlanInput) {
  const p = planStage2(input);
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p;
}

const shape = (rows: readonly Stage2Row[]) =>
  rows.map((r) => [r.id, r.lens, r.files.map((f) => f.path).join(",")]);

describe("the deep floor", () => {
  it("puts every floor lens over every file stage 1 reads, grouped by unit, in deep_lenses order — the companion's rows may be none", () => {
    const p = planned(floorInput());
    const perLens = (lens: string) => [
      [lens, "app/models.py,app/views.py"],
      [lens, "lib/big.py,lib/util.py"],
      [lens, "web/index.ts"],
      [lens, "tools/x.py"],
    ];
    expect(shape(p.rows).map(([, l, f]) => [l, f])).toEqual(
      SCAN_DEEP_FLOOR_LENSES.flatMap(perLens),
    );
    // No test, migration, lockfile, excluded glob, unreadable or unowned file.
    expect(p.rows.map((r) => r.id)).toEqual(Array.from({ length: 16 }, (_, i) => `floor-${i + 1}`));
    const r = p.rows[0]!;
    expect(r).toMatchObject({
      floor: true,
      reason: "deep floor: pass-consistency over app",
      tier: "sol-med",
      tests: [],
      status: "run",
      units: ["app"],
    });
    expect(p.floor).toEqual({
      lenses: [...SCAN_DEEP_FLOOR_LENSES],
      skipped: [],
      covered: 0,
      named: 0,
    });
  });

  it("chunks a unit to one case, and reads a file over one case alone in line ranges", () => {
    const p = planned(
      floorInput({ floor: ["pass-delivery"], budget: { maxFiles: 1, maxLines: 40 } }),
    );
    expect(shape(p.rows)).toEqual([
      ["floor-1", "pass-delivery", "app/models.py"],
      ["floor-2", "pass-delivery", "app/views.py"],
      ["floor-3", "pass-delivery", "lib/big.py"],
      ["floor-4", "pass-delivery", "lib/util.py"],
      ["floor-5", "pass-delivery", "web/index.ts"],
      ["floor-6", "pass-delivery", "tools/x.py"],
    ]);
    expect(p.rows[2]!.ranges!.length).toBeGreaterThan(1);
    expect(p.rows.every((r) => r.lines <= 40 * (r.ranges?.length ?? 1))).toBe(true);
  });

  it("skips a lens the profile switched off, and says so", () => {
    const lenses: LensTuningMap = { "pass-duplication": { enabled: false } };
    const p = planned(floorInput({ lenses }));
    expect(new Set(p.rows.map((r) => r.lens))).toEqual(
      new Set(["pass-consistency", "pass-delivery", "pass-maintainability"]),
    );
    expect(p.floor).toMatchObject({ skipped: ["pass-duplication"] });
    // Every floor lens off and no row of the companion's: nothing to propose.
    const off = Object.fromEntries(SCAN_DEEP_FLOOR_LENSES.map((l) => [l, { enabled: false }]));
    const none = planStage2(floorInput({ lenses: off }));
    expect(none).toMatchObject({ ok: false, errors: [expect.stringMatching(/switched off/)] });
  });

  it("runs the companion's rows first; a floor row drops a file they name for the same lens, and a file already read deep", () => {
    const rows: Stage2RowRequest[] = [
      { lens: "pass-consistency", files: ["app/views.py"], reason: "the two handlers differ" },
      { lens: "pass-security", files: ["lib/util.py"], reason: "token check" },
    ];
    const p = planned(
      floorInput({
        rows,
        floor: ["pass-consistency", "pass-delivery"],
        covered: (lens) =>
          lens === "pass-delivery"
            ? new Set([`web/index.ts\0${blob(TREE["web/index.ts"]!)}`])
            : new Set(),
      }),
    );
    expect(shape(p.rows)).toEqual([
      ["row-1", "pass-consistency", "app/views.py"],
      ["row-2", "pass-security", "lib/util.py"],
      ["floor-1", "pass-consistency", "app/models.py"],
      ["floor-2", "pass-consistency", "lib/big.py,lib/util.py"],
      ["floor-3", "pass-consistency", "web/index.ts"],
      ["floor-4", "pass-consistency", "tools/x.py"],
      ["floor-5", "pass-delivery", "app/models.py,app/views.py"],
      ["floor-6", "pass-delivery", "lib/big.py,lib/util.py"],
      ["floor-7", "pass-delivery", "tools/x.py"],
    ]);
    expect(p.rows[0]!.floor).toBeUndefined();
    expect(p.floor).toMatchObject({ named: 1, covered: 1 });
  });

  it("is priced and fitted like any row, after the companion's", () => {
    // $1/kline: the companion's row (app/views.py + its test, 28 lines) first.
    const rows: Stage2RowRequest[] = [
      { lens: "pass-security", files: ["app/views.py"], reason: "auth" },
    ];
    const p = planned(floorInput({ rows, floor: ["pass-consistency"], budgetUsd: 0.1 }));
    expect(p.rows.map((r) => [r.id, r.status, Number(r.estimate_usd.toFixed(3))])).toEqual([
      ["row-1", "run", 0.028],
      ["floor-1", "run", 0.03],
      ["floor-2", "over-budget", 0.08],
      ["floor-3", "run", 0.04],
      ["floor-4", "over-budget", 0.015],
    ]);
    expect(p.total_usd).toBeCloseTo(0.098, 9);
    expect(p.over_budget_usd).toBeCloseTo(0.095, 9);
    // With no price at all, the floor is refused like any row.
    expect(planStage2(floorInput({ price: () => null }))).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/^floor-1: no measured price/)],
    });
  });

  it("MAX_STAGE2_ROWS binds the companion's rows alone; no floor, no empty proposal", () => {
    // Fifty files in one unit, one per case: 50 floor rows per lens.
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) many[`app/m${i}.py`] = lines(2);
    const input = floorInput({
      files: Object.entries(many).map(([path, text]) => ({ path, blob: blob(text) })),
      linesOf: (p) => (many[p] === undefined ? null : 2),
      budget: { maxFiles: 1, maxLines: 3000 },
    });
    const p = planned(input);
    expect(p.rows.length).toBe(200);
    expect(p.rows.length).toBeGreaterThan(MAX_STAGE2_ROWS);
    const tooMany = Array.from({ length: MAX_STAGE2_ROWS + 1 }, () => ({
      lens: "pass-security",
      files: ["app/m0.py"],
      reason: "r",
    }));
    expect(planStage2({ ...input, rows: tooMany })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/at most 100 in one proposal/)],
    });
    const { floor: _f, ...standard } = floorInput();
    expect(planStage2(standard)).toMatchObject({
      ok: false,
      errors: ["a stage 2 proposal needs at least one row"],
    });
  });
});

// ---- the runner and its tools ------------------------------------------------------

const SHA = "1".repeat(40);
let stateDir: string;
let now: Date;
beforeEach(() => {
  stateDir = join(dir, "state-home");
  now = new Date("2026-10-12T10:00:00Z");
});

function fakeSource(files: Record<string, string>): ScanSource {
  const listed = () => Object.entries(files).map(([path, text]) => ({ path, blob: blob(text) }));
  return {
    location: "/reviewed-repo",
    resolve: (ref) => (ref === "HEAD" || ref === SHA ? SHA : null),
    open: (sha): { ok: true; tree: ScanTree } => ({
      ok: true,
      tree: {
        sha,
        root: `/state/scan/tree/${sha}`,
        files: listed(),
        read: (p) => (UNREADABLE.has(p) ? null : (files[p] ?? null)),
        lines: (p) =>
          files[p] === undefined || UNREADABLE.has(p) ? null : files[p]!.split("\n").length - 1,
      },
    }),
    list: (sha) => (sha === SHA ? listed() : null),
  };
}

/** pass-scan answers NONE with `suggest` SUGGEST rows naming its first focus
 * file; a deep lens answers NONE. */
function answer(spec: CaseSpec, suggest: number): string {
  const lens = spec.agent.replace(/--.*$/, "");
  if (lens !== SCAN_PASS) return `FINDINGS ${lens} SCAN ${spec.id} @sha\nNONE\n`;
  const sugs = Array.from(
    { length: suggest },
    (_, i) =>
      `- lens: pass-consistency\n  files: ${spec.files[0]}\n  reason: sibling ${i + 1} differs`,
  );
  return `FINDINGS pass-scan SCAN ${spec.id} @sha\nNONE\n\n${suggest ? `SUGGEST\n${sugs.join("\n")}` : "SUGGEST NONE"}\n`;
}

interface Rig {
  scan: ScanRunner;
  specs: CaseSpec[];
  builds: ScanSettings[];
  settings: Partial<ScanConfig>;
}

function rig(
  opts: {
    suggest?: number;
    settings?: Partial<ScanConfig>;
    /** Reshape the fake runner's outcome (reads, a transcript). */
    outcome?: (spec: CaseSpec, base: CaseOutcome & { ok: true }) => CaseOutcome;
  } = {},
): Rig {
  const specs: CaseSpec[] = [];
  const builds: ScanSettings[] = [];
  const settings: Partial<ScanConfig> = { ...opts.settings };
  const ports: ScanPorts = {
    state: stateHomeFs(stateDir),
    clock: () => {
      now = new Date(now.getTime() + 1000);
      return now;
    },
    cases: {
      run: async (spec): Promise<CaseOutcome> => {
        specs.push(spec);
        const base = {
          ok: true as const,
          output: answer(spec, opts.suggest ?? 0),
          cost_usd: 0.01 * spec.files.length,
        };
        return opts.outcome ? opts.outcome(spec, base) : base;
      },
    },
    source: fakeSource(TREE),
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({
      ok: true,
      settings: {
        scan: { ...SCAN_DEFAULTS, validator: false, exclude: ["gen/"], ...settings },
        riskPasses: ["pass-data-safety"],
      },
    }),
    buildAgents: (s) => {
      builds.push(s);
      return { ok: true };
    },
  };
  return { scan: new ScanRunner(ports), specs, builds, settings };
}

/** Preview and start until nothing is left to read at the current depth. */
async function scanAll(s: ScanRunner): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const p = await s.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    if (p.preview.blockers.length > 0) return;
    const r = await s.start({ key: p.preview.key });
    if (!r.ok) throw new Error(r.errors.join("; "));
    await s.idle();
  }
}

const ledgerRows = (): LedgerEntry[] =>
  (JSON.parse(readFileSync(join(stateDir, LEDGER_FILE), "utf8")) as LedgerFile).entries;

describe("a deep stage 1", () => {
  it("re-reads what only a standard reading covers, priced from the standard rate and saying so; its rows are deep and cover both depths", async () => {
    const r = rig();
    await scanAll(r.scan);
    const standardRows = ledgerRows().length;
    expect(ledgerRows().every((e) => e.depth === undefined)).toBe(true);
    const nothing = await r.scan.preview();
    expect(nothing.ok && nothing.preview.blockers.join(" ")).toMatch(/nothing left to read/);

    r.settings.depth = "deep";
    const p = await r.scan.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview).toMatchObject({
      mode: "stage1",
      depth: "deep",
      rate_across_depth: true,
      covered: 0,
    });
    expect(p.preview.settings.depth).toBe("deep");
    expect(p.preview.files).toBe(6);
    expect((await r.scan.start({ key: p.preview.key })).ok).toBe(true);
    await r.scan.idle();
    expect(r.builds.at(-1)!.scan.depth).toBe("deep");
    expect(r.scan.status().run!.settings.depth).toBe("deep");
    const deep = ledgerRows().slice(standardRows);
    expect(deep.length).toBe(6);
    expect(deep.every((e) => e.depth === "deep" && e.lens === SCAN_PASS)).toBe(true);

    // Deep coverage now stands for both depths, and the deep rate is its own.
    const again = await r.scan.preview();
    expect(again.ok && again.preview).toMatchObject({ rate_across_depth: false, covered: 6 });
    r.settings.depth = "standard";
    const std = await r.scan.preview();
    expect(std.ok && std.preview.blockers.join(" ")).toMatch(/nothing left to read/);
    expect(std.ok && std.preview.rate_across_depth).toBe(false);
  });

  it("a deep delta says an unchanged file read only at standard depth is not yet read deep; the ledger line counts files, not readings", async () => {
    const r = rig();
    await scanAll(r.scan);
    r.settings.depth = "deep";
    const p = await r.scan.preview({ delta: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.delta).toEqual({ since: SHA, owed: 6, owed_shallow: 6 });
    const text = renderPreview(p.preview);
    expect(text).toContain(
      "; 6 of the files are unchanged but not yet read at deep depth — read first",
    );
    expect(text).not.toMatch(/no reading covers them yet/);
    // Owed for both reasons: each named with its own count.
    const mixed = renderPreview({ ...p.preview, delta: { since: SHA, owed: 6, owed_shallow: 2 } });
    expect(mixed).toContain(
      "; 4 of the files are unchanged but no reading covers them yet (never read, cut short or unreadable before)" +
        "; 2 of the files are unchanged but not yet read at deep depth — read first",
    );
    // A standard delta keeps its one clause and carries no shallow count.
    r.settings.depth = "standard";
    const std = await r.scan.preview({ delta: true });
    expect(std.ok && std.preview.delta).toEqual({ since: SHA, owed: 0 });
    const legacy = renderPreview({ ...p.preview, delta: { since: SHA, owed: 3 } });
    expect(legacy).toContain(
      "; 3 of the files are unchanged but no reading covers them yet (never read, cut short or unreadable before) — read first",
    );

    // Six files read at both depths: twelve stage-1 rows, six files.
    r.settings.depth = "deep";
    await scanAll(r.scan);
    expect(ledgerRows().filter((e) => e.lens === SCAN_PASS)).toHaveLength(12);
    expect(r.scan.status().ledger).toMatchObject({ files: 6 });
    expect(renderStatus(r.scan.status())).toMatch(/Ledger: 6 file\(s\) read by stage 1/);
  });

  it("a deep plan's key is not a standard plan's", async () => {
    const r = rig();
    const std = await r.scan.preview();
    r.settings.depth = "deep";
    const deep = await r.scan.preview();
    if (!std.ok || !deep.ok) throw new Error("preview refused");
    expect(std.preview.cases.map((c) => c.id)).toEqual(deep.preview.cases.map((c) => c.id));
    expect(deep.preview.key).not.toBe(std.preview.key);
    expect((await r.scan.start({ key: std.preview.key })).ok).toBe(false);
  });

  it("keeps up to the deep suggestion cap; a standard run keeps five", async () => {
    const r = rig({ suggest: 8 });
    await scanAll(r.scan);
    const std = r.scan.status().run!.cases.map((c) => c.suggestions.length);
    expect(Math.max(...std)).toBe(MAX_SUGGESTIONS);
    r.settings.depth = "deep";
    await scanAll(r.scan);
    expect(Math.max(...r.scan.status().run!.cases.map((c) => c.suggestions.length))).toBe(8);
    expect(SCAN_DEEP_MAX_SUGGESTIONS).toBeGreaterThan(8);
  });
});

const CONSISTENCY: Stage2RowRequest = {
  lens: "pass-consistency",
  files: ["app/views.py"],
  reason: "the two handlers differ",
};

describe("a deep stage 2 proposal through the runner", () => {
  it("adds the floor at [scan] depth, or at the call's deep; deep: false is standard; the key moves with depth", async () => {
    const r = rig();
    await scanAll(r.scan);
    const std = await r.scan.proposeStage2({ rows: [CONSISTENCY] });
    if (!std.ok) throw new Error(std.errors.join("; "));
    expect(std.proposal).toMatchObject({ depth: "standard", floor: null });
    expect(std.proposal.rows.map((x) => x.id)).toEqual(["row-1"]);

    const deep = await r.scan.proposeStage2({ rows: [CONSISTENCY], deep: true });
    if (!deep.ok) throw new Error(deep.errors.join("; "));
    expect(deep.proposal.depth).toBe("deep");
    expect(deep.proposal.rows[0]!.id).toBe("row-1");
    expect(deep.proposal.rows.filter((x) => x.floor).length).toBe(16);
    expect(deep.proposal.key).not.toBe(std.proposal.key);

    r.settings.depth = "deep";
    const byConfig = await r.scan.proposeStage2({ rows: [CONSISTENCY] });
    expect(byConfig.ok && byConfig.proposal.key).toBe(deep.proposal.key);
    const off = await r.scan.proposeStage2({ rows: [CONSISTENCY], deep: false });
    expect(off.ok && off.proposal.key).toBe(std.proposal.key);
    const floorOnly = await r.scan.proposeStage2({ rows: [] });
    expect(floorOnly.ok && floorOnly.proposal.rows.every((x) => x.floor)).toBe(true);
    expect(await r.scan.proposeStage2({ rows: [], deep: "yes" })).toMatchObject({
      ok: false,
      errors: ["`deep` must be true or false (or left out)"],
    });
  });

  it("starts at the depth it was made at, whatever [scan] depth says by then: built deep, its rows written deep", async () => {
    const r = rig();
    await scanAll(r.scan);
    const p = await r.scan.proposeStage2({ rows: [CONSISTENCY], deep: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(r.settings.depth).toBeUndefined();
    const started = await r.scan.startStage2({ key: p.proposal.key });
    expect(started.ok).toBe(true);
    await r.scan.idle();
    expect(r.builds.at(-1)!.scan.depth).toBe("deep");
    const run = r.scan.status().run!;
    expect(run).toMatchObject({ mode: "stage2", state: "complete" });
    expect(run.settings.depth).toBe("deep");
    expect(run.cases.map((c) => c.id)).toEqual(p.proposal.rows.map((x) => x.id));
    const floorCase = r.specs.find((s) => s.prompt.includes("floor-2"))!;
    expect(floorCase.prompt).toMatch(/Why this case: deep floor: pass-consistency over lib/);
    expect(floorCase.prompt).toMatch(/This row is the deep scan's floor/);
    const deep = ledgerRows().filter((e) => e.lens !== SCAN_PASS);
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.every((e) => e.depth === "deep")).toBe(true);
    // Every floor file is now read deep: the next deep proposal has no floor left.
    const next = await r.scan.proposeStage2({ rows: [], deep: true });
    expect(next).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/nothing left for the floor/)],
    });
  });

  it("a standard reading never covers a deep row, and its price says it was measured at the other depth", async () => {
    const r = rig();
    await scanAll(r.scan);
    const std = await r.scan.proposeStage2({ rows: [CONSISTENCY] });
    if (!std.ok) throw new Error(std.errors.join("; "));
    await r.scan.startStage2({ key: std.proposal.key });
    await r.scan.idle();
    const again = await r.scan.proposeStage2({ rows: [CONSISTENCY] });
    expect(again.ok && again.proposal.rows[0]!.status).toBe("covered");
    const deep = await r.scan.proposeStage2({ rows: [CONSISTENCY], deep: true });
    if (!deep.ok) throw new Error(deep.errors.join("; "));
    expect(deep.proposal.rows[0]).toMatchObject({
      status: "run",
      price: { basis: "measured", across_depth: true },
    });
    expect(readStage2Proposal(stateDir)).toMatchObject({ ok: true, proposal: { depth: "deep" } });
  });
});

describe("a stage 2 start narrowed by row ids", () => {
  it("refuses rows that are not a list of ids, naming both id shapes", async () => {
    const r = rig();
    expect(await r.scan.startStage2({ key: "k", rows: [1] })).toEqual({
      ok: false,
      errors: ["`rows` must be a list of row ids from the proposal (`row-<n>` / `floor-<n>`)"],
    });
  });
});

describe("the propose tool", () => {
  async function call(defs: PiToolDefinition[], params: Record<string, unknown>): Promise<string> {
    const def = defs.find((d) => d.name === "scan_stage2_propose")!;
    return (await def.execute("id", params)).content.map((c) => c.text).join("\n");
  }

  it("takes deep, and its preview says the depth and splits the companion's rows from the floor", async () => {
    const r = rig();
    await scanAll(r.scan);
    const defs = scanToolDefinitions(r.scan, null as never, () => null);
    const prop = defs.find((d) => d.name === "scan_stage2_propose")!;
    expect(JSON.stringify(prop.parameters)).toContain('"deep"');

    const text = await call(defs, { rows: [CONSISTENCY], deep: true });
    expect(text).toMatch(/^STAGE 2 proposal \(deep\) at 111111111111 — 17 row\(s\) to run/);
    expect(text).toMatch(
      /DEEP: your rows 1 to run, ~\$\d+\.\d\d; the floor 16 to run, ~\$\d+\.\d\d\./,
    );
    expect(text).toMatch(/row-1: pass-consistency at sol-med over app/);
    expect(text).toMatch(
      /The deep floor:\n {2}pass-consistency \(floor floor-1…floor-4\) at sol-med: 4 row\(s\)/,
    );
    expect(text).toMatch(/pass-delivery \(floor floor-5…floor-8\)/);
    expect(text).toMatch(
      /Left out of the floor: 0 file × lens already read deep at this content, 1 named by your rows/,
    );
    // Floor rows are summed per lens, never listed one by one.
    expect(text).not.toMatch(/floor-2: /);

    const std = await call(defs, { rows: [CONSISTENCY], deep: false });
    expect(std).toMatch(/^STAGE 2 proposal at 111111111111 — 1 row\(s\) to run/);
    expect(std).not.toMatch(/DEEP|floor/);
    expect(await call(defs, { rows: [], deep: "yes" })).toMatch(
      /^Stage 2 proposal refused:\n✗ `deep` must be true or false/,
    );
  });
});

describe("a deep stage 2 hands each case what stage 1 saw, and credits only what the lens opened", () => {
  it("carries stage 1's suggestions for the row's lens and files into the case prompt", async () => {
    const r = rig({ suggest: 1 });
    await scanAll(r.scan);
    const suggested = r.specs
      .filter((x) => x.agent.startsWith(`${SCAN_PASS}--`))
      .map((x) => x.files[0]!);
    expect(suggested.length).toBeGreaterThan(0);
    const p = await r.scan.proposeStage2({ rows: [], deep: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    r.specs.length = 0;
    expect((await r.scan.startStage2({ key: p.proposal.key })).ok).toBe(true);
    await r.scan.idle();
    const led = r.specs.filter((x) =>
      x.prompt.includes("What the first look pointed this lens at"),
    );
    expect(led.length).toBeGreaterThan(0);
    for (const x of led) {
      expect(x.agent, x.id).toMatch(/^pass-consistency--/);
      expect(x.prompt, x.id).toContain(": sibling 1 differs");
      expect(
        x.files.some((f) => suggested.includes(f)),
        x.id,
      ).toBe(true);
    }
    // Another lens over the same files carries none: the suggestion named
    // pass-consistency.
    for (const x of r.specs.filter((y) => !y.agent.startsWith("pass-consistency--")))
      expect(x.prompt, x.id).not.toContain("What the first look pointed this lens at");
  });

  it("writes ledger rows only for the focus files the lens opened, says which it did not, and keeps the transcript names", async () => {
    const r = rig({
      outcome: (spec, base) => {
        const root = `/state/scan/tree/${SHA}`;
        const firstOnly = spec.files.length > 1 && !spec.id.endsWith("/validate");
        return {
          ...base,
          reads: (firstOnly ? spec.files.slice(0, 1) : spec.files).map((f) => `${root}/${f}`),
          transcript: `${spec.id.split("/")[0]}/${spec.id.split("/").slice(1).join(".")}.jsonl`,
        };
      },
    });
    const p = await r.scan.preview();
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect((await r.scan.start({ key: p.preview.key })).ok).toBe(true);
    await r.scan.idle();
    const run = r.scan.status().run!;
    const multi = run.cases.filter((c) => c.files.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    const rows = ledgerRows();
    for (const c of run.cases) {
      expect(c.status, c.id).toBe("done");
      expect(c.reads, c.id).toBe(c.files.length > 1 ? 1 : c.files.length);
      expect(c.transcript, c.id).toMatch(/\.jsonl$/);
      const recorded = rows.filter((e) => e.case === c.id).map((e) => e.path);
      if (c.files.length > 1) {
        expect(recorded, c.id).toEqual([c.files[0]]);
        expect(c.unopened, c.id).toEqual(c.files.slice(1));
        expect(run.problems.join("\n"), c.id).toContain(
          `case ${c.id}: ${SCAN_PASS} opened 1 of its ${c.files.length} focus files — not opened: ${c.files.slice(1).join(", ")}`,
        );
      } else {
        expect(recorded, c.id).toEqual(c.files);
        expect(c.unopened, c.id).toBeUndefined();
      }
    }
    // What was not opened is still to read.
    const again = await r.scan.preview();
    if (!again.ok) throw new Error(again.errors.join("; "));
    const unopened = multi.flatMap((c) => c.files.slice(1));
    const planned = again.preview.cases.flatMap((c) => c.files.map((f) => f.path));
    for (const f of unopened) expect(planned, f).toContain(f);
  });
});
