// Stage 1's case ORDER prioritises coverage (scan-loop). The hard stop
// (ratified, unchanged) ends a run whose actuals outrun its estimate before
// the plan's tail; with cases in a fixed unit order that tail was the SAME
// cases every round (self-scan rounds 2 and 3 both cut onboard-core,
// onboard-steps, bench-harness ×2, bench-arms). Now a case holding a file
// the ledger never read — or whose newest reading was cut short — runs
// first, then cases of changed files, then the rest; a tier keeps the plan's
// own order. Asserted at the planner (planStage1) and at the run
// (ScanRunner, every port faked): repeated capped runs converge to full
// coverage, and a delta keeps unread-first.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_DEFAULTS, type ScanConfig } from "../src/config.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import { LEDGER_FILE, type LedgerFile } from "../src/setup/ledger.js";
import { planStage1 } from "../src/setup/scan.js";
import { ScanRunner, type ScanPorts, type ScanSource, type ScanTree } from "../src/setup/scanrun.js";
import type { UnitCut } from "../src/setup/unitcut.js";

const lines = (n: number, word: string): string => Array.from({ length: n }, (_, i) => `${word}_${i + 1} = ${i + 1}`).join("\n") + "\n";
const blob = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
const cutOf = (units: readonly string[]): UnitCut => ({
  units: units.map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
  ignored: [],
});

describe("planStage1 orders cases by what the ledger has read", () => {
  const TREE: Record<string, string> = {
    "a/x.py": lines(10, "a"),
    "b/x.py": lines(10, "b"),
    "c/x.py": lines(10, "c"),
    "d/x.py": lines(10, "d"),
    "e/x.py": lines(10, "e"),
    "f/big.py": lines(90, "f"),
  };
  const files = Object.entries(TREE).map(([path, text]) => ({ path, blob: blob(text) }));
  const base = {
    cut: cutOf(["a", "b", "c", "d", "e", "f"]),
    files,
    linesOf: (p: string) => TREE[p]!.split("\n").length - 1,
    covered: new Set<string>(),
    exclude: [],
    budget: { maxFiles: 30, maxLines: 40 },
  };

  it("unread and cut-short first, then changed, each tier in the plan's order", () => {
    const plan = planStage1({
      ...base,
      // a, c: read at older content (changed). b, e: never read. d: its newest
      // reading, at older content, stopped between ranges. f: read in ranges
      // at THIS content, cut short — the rest is still due.
      history: new Map([
        ["a/x.py", { blob: "old-a", complete: true, at: "2026-09-01T00:00:00Z" }],
        ["c/x.py", { blob: "old-c", complete: true, at: "2026-09-01T00:00:00Z" }],
        ["d/x.py", { blob: "old-d", complete: false, at: "2026-09-01T00:00:00Z" }],
        ["f/big.py", { blob: blob(TREE["f/big.py"]!), complete: false, at: "2026-09-01T00:00:00Z" }],
      ]),
      partial: new Map([[`f/big.py\0${blob(TREE["f/big.py"]!)}`, [{ start: 1, end: 40 }]]]),
    });
    expect(plan.cases.map((c) => c.id)).toEqual(["b", "d", "e", "f#1", "f#2", "a", "c"]);
  });

  it("among changed files the stalest reading runs first, equal stamps in the plan's order", () => {
    const plan = planStage1({
      ...base,
      files: files.filter((f) => !f.path.startsWith("f/")),
      history: new Map([
        ["a/x.py", { blob: "old-a", complete: true, at: "2026-09-03T00:00:00Z" }],
        ["b/x.py", { blob: "old-b", complete: true, at: "2026-09-01T00:00:00Z" }],
        ["c/x.py", { blob: "old-c", complete: true, at: "2026-09-02T00:00:00Z" }],
        ["d/x.py", { blob: "old-d", complete: true, at: "2026-09-01T00:00:00Z" }],
      ]),
    });
    // e never read: first. Then b and d (oldest, plan order), c, a.
    expect(plan.cases.map((c) => c.id)).toEqual(["e", "b", "d", "c", "a"]);
  });

  it("with no reading history the plan's own order stands", () => {
    const plan = planStage1(base);
    expect(plan.cases.map((c) => c.unit)).toEqual(["a", "b", "c", "d", "e", "f", "f", "f"]);
  });

  it("a case holding one unread file among changed ones goes first", () => {
    const plan = planStage1({
      ...base,
      cut: { units: [{ name: "ab", roots: ["a", "b"], kind: "directory", note: "" }, ...cutOf(["c"]).units], ignored: [] },
      files: files.filter((f) => /^[abc]\//.test(f.path)),
      history: new Map([
        ["a/x.py", { blob: "old-a", complete: true, at: "2026-09-01T00:00:00Z" }],
        ["c/x.py", { blob: "old-c", complete: true, at: "2026-09-01T00:00:00Z" }],
      ]),
    });
    // Put "c" ahead in the cut: the unread b/x.py still lifts "ab" over it.
    const flipped = planStage1({
      ...base,
      cut: { units: [...cutOf(["c"]).units, { name: "ab", roots: ["a", "b"], kind: "directory", note: "" }], ignored: [] },
      files: files.filter((f) => /^[abc]\//.test(f.path)),
      history: new Map([
        ["a/x.py", { blob: "old-a", complete: true, at: "2026-09-01T00:00:00Z" }],
        ["c/x.py", { blob: "old-c", complete: true, at: "2026-09-01T00:00:00Z" }],
      ]),
    });
    expect(plan.cases.map((c) => c.id)).toEqual(["ab", "c"]);
    expect(flipped.cases.map((c) => c.id)).toEqual(["ab", "c"]);
  });
});

// ---- the run ----------------------------------------------------------------

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-order-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const OLD = ["u1", "u2", "u3"];
const NEW = ["u4", "u5", "u6"];
let CUT = cutOf([...OLD, ...NEW]);

/** Round `r`'s tree: u1-u3 always, their content new every round; u4-u6
 * (sat LAST in the cut, like the self-scan's starved tail) from round 1. */
function treeAt(r: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of OLD) out[`${u}/m.py`] = lines(10, `${u}_r${r}`);
  if (r > 0) for (const u of NEW) out[`${u}/m.py`] = lines(10, `${u}_r${r}`);
  return out;
}
const shaOf = (r: number): string => String(r).padStart(40, "0");

function fakeSource(rounds: number): ScanSource {
  const trees: Record<string, Record<string, string>> = {};
  for (let r = 0; r <= rounds; r++) trees[shaOf(r)] = treeAt(r);
  const listOf = (files: Record<string, string>) => Object.entries(files).map(([path, text]) => ({ path, blob: blob(text) }));
  return {
    location: "/reviewed-repo",
    resolve: (ref) => (ref in trees ? ref : null),
    open: (sha): { ok: true; tree: ScanTree } | { ok: false; reason: string } => {
      const files = trees[sha];
      if (!files) return { ok: false, reason: "no such tree" };
      return {
        ok: true,
        tree: {
          sha,
          root: `/state/scan/tree/${sha}`,
          files: listOf(files),
          read: (p) => files[p] ?? null,
          lines: (p) => (files[p] === undefined ? null : files[p]!.split("\n").length - 1),
        },
      };
    },
    list: (sha) => (trees[sha] ? listOf(trees[sha]!) : null),
  };
}

interface FakeRunner {
  run(spec: CaseSpec, signal: AbortSignal, onCost?: (spentSoFar: number) => void): Promise<CaseOutcome>;
  specs: CaseSpec[];
}

/** Answers NONE at once, costing `perFile` per focus file. */
function runner(perFile: number): FakeRunner {
  const specs: CaseSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return { ok: true, output: `FINDINGS pass-scan SCAN ${spec.id} @sha\nNONE\n\nSUGGEST NONE`, cost_usd: perFile * spec.files.length };
    },
  };
}

let now = new Date("2026-09-29T10:00:00Z");
function ports(cases: FakeRunner, rounds: number, scan: Partial<ScanConfig> = {}): ScanPorts {
  return {
    state: stateHomeFs(stateDir),
    clock: () => {
      now = new Date(now.getTime() + 1000);
      return now;
    },
    cases,
    source: fakeSource(rounds),
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({
      ok: true,
      settings: { scan: { ...SCAN_DEFAULTS, validator: false, case_max_files: 1, concurrency: 1, calibration_units: 3, ...scan } },
    }),
    buildAgents: () => ({ ok: true }),
  };
}

async function runOnce(s: ScanRunner, sha: string, delta = false) {
  const p = await s.preview({ sha, delta });
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await s.start({ key: p.preview.key, sha, delta });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await s.idle();
  return { preview: p.preview, run: s.status().run! };
}

const readPaths = (): Set<string> => new Set((JSON.parse(readFileSync(join(stateDir, LEDGER_FILE), "utf8")) as LedgerFile).entries.map((e) => e.path));

/** Calibrate on round 0 (u1-u3 at $0.01 a case), then make every case cost
 * twice its estimate: the hard stop then fits half of each run. */
async function calibrated(rounds: number): Promise<ScanRunner> {
  const cal = await runOnce(new ScanRunner(ports(runner(0.01), rounds)), shaOf(0));
  expect(cal.run.mode).toBe("calibration");
  expect(cal.run.state).toBe("complete");
  return new ScanRunner(ports(runner(0.02), rounds));
}

describe("capped runs converge to full coverage instead of starving the same tail", () => {
  it("the files never read run first; the next capped run reads the rest", async () => {
    const s = await calibrated(2);
    const r1 = await runOnce(s, shaOf(1));
    expect(r1.run.mode).toBe("stage1");
    expect(r1.run.state).toBe("capped");
    expect(r1.preview.cases.map((c) => c.id)).toEqual([...NEW, ...OLD]);
    expect(r1.run.cases.filter((c) => c.status === "done").map((c) => c.id)).toEqual(NEW);

    const r2 = await runOnce(s, shaOf(2));
    expect(r2.run.state).toBe("capped");
    // Everything changed again; nothing is unread any more, so the stalest
    // reading runs first — the OLD half, starved last round, is read first
    // (the rate now counts round 1's dearer cases, so a little more fits).
    expect(r2.run.cases.filter((c) => c.status === "done").map((c) => c.id).slice(0, 3)).toEqual(OLD);
    expect([...readPaths()].sort()).toEqual([...OLD, ...NEW].map((u) => `${u}/m.py`).sort());
  });
});

describe("changed files the last capped run starved run first next time", () => {
  it("does not depend on the cut putting the starved half first", async () => {
    // NEW first in the cut: round 2's changed files would, in plain plan
    // order, re-read NEW and starve OLD (read at round 0) a second time.
    CUT = cutOf([...NEW, ...OLD]);
    try {
      const s = await calibrated(2);
      const r1 = await runOnce(s, shaOf(1));
      expect(r1.run.state).toBe("capped");
      expect(r1.run.cases.filter((c) => c.status === "done").map((c) => c.id)).toEqual(NEW);
      const r2 = await runOnce(s, shaOf(2));
      expect(r2.run.state).toBe("capped");
      expect(r2.preview.cases.map((c) => c.id)).toEqual([...OLD, ...NEW]);
      expect(r2.run.cases.filter((c) => c.status === "done").map((c) => c.id).slice(0, 3)).toEqual(OLD);
    } finally {
      CUT = cutOf([...OLD, ...NEW]);
    }
  });
});

describe("a delta keeps unread-first", () => {
  it("new files ahead of changed ones, and the capped delta reads the new files", async () => {
    const s = await calibrated(1);
    const d = await runOnce(s, shaOf(1), true);
    expect(d.run.mode).toBe("delta");
    expect(d.preview.cases.map((c) => c.id)).toEqual([...NEW, ...OLD]);
    expect(d.run.state).toBe("capped");
    expect(d.run.cases.filter((c) => c.status === "done").map((c) => c.id)).toEqual(NEW);
  });
});
