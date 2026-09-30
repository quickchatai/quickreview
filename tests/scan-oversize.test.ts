// A file larger than the scan's per-case line limit (selfscan round 2:
// src/state.ts, ~5.9k lines against the 3,000-line case) is still reviewed:
// the scan cuts it into LINE-RANGE cases — overlapping windows, at a
// declaration boundary when one is cheap to find — each naming its range in
// the task, the unit's name kept. The ledger records each range, a file is
// covered only once every range is, and a delta re-scan of a changed file
// re-runs all of its ranges. Stage 2 cuts a row naming such a file the same
// way, sized and priced by the ranges. Driven at the engine seam with fakes,
// as tests/scan-run.test.ts is.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_DEFAULTS, type ScanConfig } from "../src/config.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import { FindingsStore } from "../src/setup/findings.js";
import { coveredBy, LEDGER_FILE, type LedgerEntry, type LedgerFile } from "../src/setup/ledger.js";
import { cutRanges, planStage1, scanCasePrompt } from "../src/setup/scan.js";
import { ScanRunner, type ScanPorts, type ScanSource, type ScanTree } from "../src/setup/scanrun.js";
import type { UnitCut } from "../src/setup/unitcut.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-scan-oversize-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const blob = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

/** A 6,000-line module: a top-level function every 100 lines. */
function bigModule(tag = "v1"): string {
  const out: string[] = [];
  for (let i = 0; i < 6000; i++) out.push(i % 100 === 0 ? `export function f${i}_${tag}() {` : `  const x${i} = ${i};`);
  return `${out.join("\n")}\n`;
}

const small = (n: number, word: string): string => Array.from({ length: n }, (_, i) => `${word}_${i + 1} = ${i + 1}`).join("\n") + "\n";

const TREE1: Record<string, string> = {
  "core/state.ts": bigModule(),
  "lib/util.py": small(30, "util"),
  "web/index.ts": small(40, "web"),
};

const CUT: UnitCut = {
  units: ["core", "lib", "web"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
  ignored: [],
};

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

function fakeSource(trees: Record<string, Record<string, string>>, head: () => string): ScanSource {
  return {
    location: "/reviewed-repo",
    resolve: (ref: string) => (ref === "HEAD" ? head() : ref in trees ? ref : null),
    open: (sha: string): { ok: true; tree: ScanTree } | { ok: false; reason: string } => {
      const files = trees[sha];
      if (!files) return { ok: false, reason: "no such tree" };
      return {
        ok: true,
        tree: {
          sha,
          root: `/state/scan/tree/${sha}`,
          files: Object.entries(files).map(([path, text]) => ({ path, blob: blob(text) })),
          read: (p) => files[p] ?? null,
          lines: (p) => (files[p] === undefined ? null : files[p]!.split("\n").length - 1),
        },
      };
    },
    list: (sha: string) => (trees[sha] ? Object.entries(trees[sha]!).map(([path, text]) => ({ path, blob: blob(text) })) : null),
  };
}

/** The focus range a case prompt names for `path`, if any. */
function rangeIn(prompt: string, path: string): { start: number; end: number } | null {
  const m = new RegExp(`^- ${path.replace(/\./g, "\\.")} \\(lines (\\d+)-(\\d+) of \\d+`, "m").exec(prompt);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/** Answers like the lens: one finding just inside each focus file's range
 * (lines 2-3 for a whole file), and one OUTSIDE a ranged file's range —
 * which the run must drop. */
function answer(spec: CaseSpec): string {
  const lens = spec.agent.replace(/--.*$/, "");
  const items: string[] = [];
  for (const p of spec.files) {
    const r = rangeIn(spec.prompt, p);
    const at = r ? r.start + 1 : 2;
    items.push(`- path: ${p}`, `  line: ${at}-${at + 1}`, "  kind: bug", "  severity: P2", `  claim: ${p} at ${at} is wrong`);
    if (r) {
      const out = r.start > 10 ? 3 : r.end + 50;
      items.push(`- path: ${p}`, `  line: ${out}`, "  kind: bug", "  severity: P2", `  claim: ${p} at ${out} is outside the range`);
    }
  }
  return [`FINDINGS ${lens} SCAN ${spec.id} @sha`, ...items, "", "SUGGEST NONE"].join("\n");
}

interface FakeRunner {
  run(spec: CaseSpec, signal: AbortSignal, onCost?: (spentSoFar: number) => void): Promise<CaseOutcome>;
  specs: CaseSpec[];
}

function runner(): FakeRunner {
  const specs: CaseSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return { ok: true, output: answer(spec), cost_usd: 0.01 * spec.files.length };
    },
  };
}

let now = new Date("2026-09-30T10:00:00Z");

function ports(cases: FakeRunner, source: ScanSource, scan: Partial<ScanConfig> = {}): ScanPorts {
  return {
    state: stateHomeFs(stateDir),
    clock: () => {
      now = new Date(now.getTime() + 1000);
      return now;
    },
    cases,
    source,
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({
      ok: true,
      settings: { scan: { ...SCAN_DEFAULTS, ...scan }, validateTier: "sol-high", riskPasses: ["pass-data-safety"] },
    }),
    buildAgents: () => ({ ok: true }),
  };
}

const ledger = (): LedgerFile => JSON.parse(readFileSync(join(stateDir, LEDGER_FILE), "utf8")) as LedgerFile;

async function runOnce(s: ScanRunner, opts: { delta?: boolean } = {}) {
  const p = await s.preview(opts);
  if (!p.ok) throw new Error(p.errors.join("; "));
  if (p.preview.blockers.length > 0) throw new Error(p.preview.blockers.join("; "));
  const r = await s.start({ key: p.preview.key, ...opts });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await s.idle();
  return { preview: p.preview, run: s.status().run! };
}

describe("cutting a file into line ranges", () => {
  it("fits every window to the case limit, overlaps neighbours, and covers the whole file", () => {
    const text = bigModule();
    const ranges = cutRanges(6000, 3000, text);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(ranges[0]!.start).toBe(1);
    expect(ranges[ranges.length - 1]!.end).toBe(6000);
    for (const r of ranges) {
      expect(r.end - r.start + 1).toBeLessThanOrEqual(3000);
      expect(r.total).toBe(6000);
    }
    for (let i = 1; i < ranges.length; i++) {
      // Overlapping, never a gap.
      expect(ranges[i]!.start).toBeLessThanOrEqual(ranges[i - 1]!.end);
      expect(ranges[i]!.start).toBeGreaterThan(ranges[i - 1]!.start);
    }
  });

  it("cuts just before a top-level declaration when one is near the limit", () => {
    const text = bigModule();
    const lines = text.split("\n");
    const [first] = cutRanges(6000, 3000, text);
    // The line after the window is a declaration: the window ends a function.
    expect(lines[first!.end]).toMatch(/^export function/);
  });

  it("falls back to fixed windows with a small overlap when the text cannot be read", () => {
    const ranges = cutRanges(6000, 3000, null);
    expect(ranges[0]).toEqual({ start: 1, end: 3000, total: 6000 });
    expect(ranges[1]!.start).toBeLessThan(3001);
    expect(ranges[1]!.start).toBeGreaterThan(2900);
    expect(ranges[ranges.length - 1]!.end).toBe(6000);
  });

  it("leaves a file that fits whole", () => {
    expect(cutRanges(120, 3000, null)).toEqual([{ start: 1, end: 120, total: 120 }]);
  });
});

describe("stage 1 over a file bigger than one case", () => {
  it("plans ≥2 range cases under the unit's name, each naming its range in the task", () => {
    const files = Object.entries(TREE1).map(([path, text]) => ({ path, blob: blob(text) }));
    const plan = planStage1({
      cut: CUT,
      files,
      linesOf: (p) => TREE1[p]!.split("\n").length - 1,
      textOf: (p) => TREE1[p] ?? null,
      covered: new Set(),
      exclude: [],
      budget: { maxFiles: 30, maxLines: 3000 },
    });
    const core = plan.cases.filter((c) => c.unit === "core");
    expect(core.length).toBeGreaterThanOrEqual(2);
    expect(core.map((c) => c.id)).toEqual(core.map((_, i) => `core#${i + 1}`));
    for (const c of core) {
      expect(c.parts).toBe(core.length);
      expect(c.files).toHaveLength(1);
      const f = c.files[0]!;
      expect(f.path).toBe("core/state.ts");
      expect(f.range).toBeDefined();
      // Sized by the range, not the file.
      expect(c.lines).toBe(f.range!.end - f.range!.start + 1);
      expect(c.lines).toBeLessThanOrEqual(3000);
      const prompt = scanCasePrompt(c, { root: "/t", sha: SHA1, caseId: `run/${c.id}` });
      expect(prompt).toContain(`- core/state.ts (lines ${f.range!.start}-${f.range!.end} of 6000`);
      expect(prompt).toMatch(/read the whole file/i);
      expect(prompt).toMatch(new RegExp(`only .*inside lines ${f.range!.start}-${f.range!.end}`));
    }
  });

  it("runs every range, drops findings outside a case's range, and the file ends covered", async () => {
    const cases = runner();
    const s = new ScanRunner(ports(cases, fakeSource({ [SHA1]: TREE1 }, () => SHA1)));
    // Calibration, then the rest: every range of the big file runs.
    await runOnce(s);
    const rest = await runOnce(s);
    expect(rest.run.state).toBe("complete");
    const rangeSpecs = cases.specs.filter((c) => c.files.includes("core/state.ts"));
    expect(rangeSpecs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rangeSpecs.map((c) => c.id)).size).toBe(rangeSpecs.length);

    const rows = ledger().entries.filter((e) => e.path === "core/state.ts");
    expect(rows.length).toBe(rangeSpecs.length);
    expect(rows.every((e) => e.range !== undefined && e.range !== null)).toBe(true);
    // Coverage is complete: the file is covered, and a new preview has nothing left.
    expect(coveredBy(ledger().entries, "pass-scan").has(`core/state.ts\0${blob(TREE1["core/state.ts"]!)}`)).toBe(true);
    const again = await s.preview();
    expect(again.ok && again.preview.cases).toEqual([]);

    // Each range reported its in-range finding; the out-of-range ones were dropped.
    const store = new FindingsStore(stateHomeFs(stateDir)).load();
    const onBig = store.findings.filter((f) => f.path === "core/state.ts");
    expect(onBig.length).toBe(rangeSpecs.length);
    expect(onBig.every((f) => !/outside the range/.test(f.claim))).toBe(true);
    const run = s.status().run!;
    expect(run.cases.filter((c) => c.unit === "core").every((c) => c.dropped >= 1)).toBe(true);
  });

  it("a file with only some ranges read is not covered, and the next preview plans only the rest", () => {
    const b = blob(TREE1["core/state.ts"]!);
    const row = (start: number, end: number): LedgerEntry => ({
      path: "core/state.ts",
      blob: b,
      lens: "pass-scan",
      tier: "sol-med",
      effort: "low",
      validator: false,
      sha: SHA1,
      lines: end - start + 1,
      cost_usd: 0.01,
      run: "r1",
      case: "core#1",
      at: "2026-09-30T10:00:00.000Z",
      range: { start, end, total: 6000 },
    });
    const ranges = cutRanges(6000, 3000, TREE1["core/state.ts"]!);
    const first = ranges[0]!;
    const partial = [row(first.start, first.end)];
    expect(coveredBy(partial, "pass-scan").size).toBe(0);
    const whole = ranges.map((r) => row(r.start, r.end));
    expect(coveredBy(whole, "pass-scan").has(`core/state.ts\0${b}`)).toBe(true);
  });

  it("a delta re-scan of the changed file re-runs ALL its ranges", async () => {
    let head = SHA1;
    const TREE2 = { ...TREE1, "core/state.ts": bigModule("v2") };
    const cases = runner();
    const s = new ScanRunner(ports(cases, fakeSource({ [SHA1]: TREE1, [SHA2]: TREE2 }, () => head)));
    await runOnce(s);
    await runOnce(s);
    const full = cases.specs.filter((c) => c.files.includes("core/state.ts")).length;
    head = SHA2;
    const before = cases.specs.length;
    const d = await runOnce(s, { delta: true });
    expect(d.preview.mode).toBe("delta");
    const deltaCases = d.preview.cases.filter((c) => c.unit === "core");
    expect(deltaCases.length).toBe(full);
    expect(d.preview.cases.every((c) => c.unit === "core")).toBe(true);
    const ran = cases.specs.slice(before).filter((c) => c.files.includes("core/state.ts"));
    expect(ran.length).toBe(full);
    expect(coveredBy(ledger().entries, "pass-scan").has(`core/state.ts\0${blob(TREE2["core/state.ts"])}`)).toBe(true);
  });
  it("a changed file with only SOME ranges re-read settles none of its findings yet", async () => {
    let head = SHA1;
    const TREE2 = { ...TREE1, "core/state.ts": bigModule("v2") };
    const cases = runner();
    const s = new ScanRunner(ports(cases, fakeSource({ [SHA1]: TREE1, [SHA2]: TREE2 }, () => head)));
    await runOnce(s);
    await runOnce(s);
    // At the new content, every range after the first fails.
    head = SHA2;
    let seen = 0;
    const flaky = cases.run;
    cases.run = async (spec, signal, onCost) => {
      if (spec.files.includes("core/state.ts") && seen++ > 0) return { ok: false, reason: "boom", cost_usd: 0 };
      return flaky(spec, signal, onCost);
    };
    const d = await runOnce(s, { delta: true });
    expect(d.run.state).toBe("partial");
    const store = new FindingsStore(stateHomeFs(stateDir));
    const big = store.load().findings.filter((f) => f.path === "core/state.ts");
    expect(big.some((f) => f.state === "fixed")).toBe(false);
    const q = store.question().question;
    expect(q?.unreported.filter((f) => f.path === "core/state.ts") ?? []).toEqual([]);
    expect(coveredBy(ledger().entries, "pass-scan").has(`core/state.ts\0${blob(TREE2["core/state.ts"])}`)).toBe(false);
  });
});

describe("stage 2 over a file bigger than one case", () => {
  it("cuts a row naming it into range cases, sized and priced by the ranges, and runs them all", async () => {
    const cases = runner();
    const s = new ScanRunner(ports(cases, fakeSource({ [SHA1]: TREE1 }, () => SHA1)));
    await runOnce(s);
    const p = await s.proposeStage2({ rows: [{ lens: "pass-security", files: ["core/state.ts"], reason: "auth state" }] });
    if (!p.ok) throw new Error(p.errors.join("; "));
    const row = p.proposal.rows[0]!;
    expect(row.status).toBe("run");
    expect(row.ranges!.length).toBeGreaterThanOrEqual(2);
    const read = row.ranges!.reduce((n, r) => n + (r.end - r.start + 1), 0);
    expect(row.lines).toBe(read);
    expect(row.estimate_usd).toBeCloseTo((read / 1000) * row.price.rate.usd_per_kline, 9);

    const before = cases.specs.length;
    const r = await s.startStage2({ key: p.proposal.key });
    if (!r.ok) throw new Error(r.errors.join("; "));
    await s.idle();
    const run = s.status().run!;
    expect(run.state).toBe("complete");
    expect(run.cases.map((c) => c.id)).toEqual(row.ranges!.map((_, i) => `${row.id}#${i + 1}`));
    const ran = cases.specs.slice(before);
    expect(ran).toHaveLength(row.ranges!.length);
    for (const [i, spec] of ran.entries()) expect(rangeIn(spec.prompt, "core/state.ts")).toEqual({ start: row.ranges![i]!.start, end: row.ranges![i]!.end });
    expect(coveredBy(ledger().entries, "pass-security").has(`core/state.ts\0${blob(TREE1["core/state.ts"]!)}`)).toBe(true);
    // Covered now: the same row proposed again is free.
    const again = await s.proposeStage2({ rows: [{ lens: "pass-security", files: ["core/state.ts"], reason: "auth state" }] });
    expect(again.ok && again.proposal.rows[0]!.status).toBe("covered");
  });

  it("still refuses a several-file row over one case, and says to name the big file alone", async () => {
    const s = new ScanRunner(ports(runner(), fakeSource({ [SHA1]: TREE1 }, () => SHA1)));
    await runOnce(s);
    const r = await s.proposeStage2({ rows: [{ lens: "pass-security", files: ["core/state.ts", "lib/util.py"], reason: "x" }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/core\/state\.ts .*alone/);
  });
});

describe("a ranged reading cut short across runs", () => {
  /** A 6,000-line module whose every line (so every finding's anchored code)
   * differs from `bigModule`'s. */
  function otherModule(): string {
    const out: string[] = [];
    for (let i = 0; i < 6000; i++) out.push(i % 100 === 0 ? `export function g${i}() {` : `  let y${i} = ${i * 7};`);
    return `${out.join("\n")}\n`;
  }

  async function cutShort() {
    let head = SHA1;
    const TREE2 = { ...TREE1, "core/state.ts": otherModule() };
    const cases = runner();
    const s = new ScanRunner(ports(cases, fakeSource({ [SHA1]: TREE1, [SHA2]: TREE2 }, () => head)));
    await runOnce(s);
    await runOnce(s);
    head = SHA2;
    let seen = 0;
    const real = cases.run;
    cases.run = async (spec, signal, onCost) => {
      if (spec.files.includes("core/state.ts") && seen++ > 0) return { ok: false, reason: "boom", cost_usd: 0 };
      return real(spec, signal, onCost);
    };
    const x = await runOnce(s, { delta: true });
    expect(x.run.state).toBe("partial");
    cases.run = real;
    return { s, cases, TREE2, x };
  }

  it("the next delta re-scan reads the ranges still unread — the file is not 'unchanged' while half-read", async () => {
    const { s, cases, TREE2 } = await cutShort();
    const before = cases.specs.length;
    const y = await runOnce(s, { delta: true });
    const core = y.preview.cases.filter((c) => c.unit === "core");
    expect(core.length).toBeGreaterThanOrEqual(1);
    expect(cases.specs.slice(before).some((c) => c.files.includes("core/state.ts"))).toBe(true);
    expect(coveredBy(ledger().entries, "pass-scan").has(`core/state.ts\0${blob(TREE2["core/state.ts"])}`)).toBe(true);
  });

  it("findings first seen by the run that read the earlier ranges are candidates when the reading completes", async () => {
    const { s, x } = await cutShort();
    const store = new FindingsStore(stateHomeFs(stateDir));
    const fromX = store.load().findings.filter((f) => f.path === "core/state.ts" && f.first_seen.run === x.run.id);
    expect(fromX.length).toBeGreaterThanOrEqual(1);
    await runOnce(s, { delta: true });
    // The old range-1 finding may be the one run X saw again at new content:
    // X's findings are fresh candidates for it, not left out because a later
    // run finished the reading.
    const q = store.question().question;
    const fresh = new Set((q?.fresh ?? []).map((f) => f.fingerprint));
    for (const f of fromX) expect(fresh.has(f.fingerprint)).toBe(true);
  });
});
