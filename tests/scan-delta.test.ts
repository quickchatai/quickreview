// The delta re-scan and finding matching (setup & scan spec
// "Findings" and "Delta re-scan", seam 3) driven the engine way: every port
// faked — an in-memory source of trees per sha, a fake case runner that
// answers like pass-scan, a FAKE JUDGE standing in for the companion's
// sameness call — and the state home a temp dir through the real rooted state
// port. What is asserted is what the run and the store WRITE and RETURN:
// which files a delta reads, which findings match exactly, what is handed to
// the companion, and what becomes `fixed` on its own.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_DEFAULTS, type ScanConfig } from "../src/config.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import {
  FINDINGS_FILE,
  FindingsStore,
  type FindingsFile,
  type MatchPair,
  type MatchQuestionView,
  type ReportedFinding,
  type ScanFinding,
} from "../src/setup/findings.js";
import type { LedgerEntry } from "../src/setup/ledger.js";
import { ScanRunner, type ScanPorts, type ScanSource, type ScanTree } from "../src/setup/scanrun.js";
import type { UnitCut } from "../src/setup/unitcut.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-delta-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const lines = (n: number, word: string): string => Array.from({ length: n }, (_, i) => `${word}_${i + 1} = ${i + 1}`).join("\n") + "\n";

const TREE: Record<string, string> = {
  "app/models.py": lines(10, "model"),
  "app/views.py": lines(20, "view"),
  "app/tests/test_views.py": lines(8, "t"),
  "lib/util.py": lines(30, "util"),
  "lib/big.py": lines(50, "big"),
  "web/index.ts": lines(40, "web"),
  "tools/x.py": lines(15, "tool"),
};

/** The next commit: the anchored code of app/models.py changed; lib/big.py
 * grew at the end (its anchored lines did not change); tools/x.py changed
 * below the anchor; web/index.ts deleted; lib/new.py added; app/views.py,
 * lib/util.py and the test untouched. */
const TREE2: Record<string, string> = {
  ...TREE,
  "app/models.py": lines(10, "model").replace("model_2 = 2\n", "model_2 = 22\n"),
  "lib/big.py": `${lines(50, "big")}big_extra = 1\n`,
  "tools/x.py": lines(15, "tool").replace("tool_10 = 10\n", "tool_10 = 100\n"),
  "lib/new.py": lines(5, "fresh"),
};
delete TREE2["web/index.ts"];

const CUT: UnitCut = {
  units: ["app", "lib", "web", "tools"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
  ignored: [],
};

const blob = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);

function fakeSource(trees: Record<string, Record<string, string>>): ScanSource {
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

/** pass-scan's answer: one finding of `kind` on the first focus file's
 * lines 2-3 — or NONE. */
function finding(spec: CaseSpec, kind = "bug"): string {
  const f = spec.files[0]!;
  return [
    `FINDINGS pass-scan SCAN ${spec.id} @sha`,
    `- path: ${f}`,
    "  line: 2-3",
    `  kind: ${kind}`,
    "  severity: P2",
    `  claim: ${f} is ${kind}-wrong`,
    "",
    "SUGGEST NONE",
  ].join("\n");
}

interface FakeRunner {
  run(spec: CaseSpec, signal: AbortSignal, onCost?: (spentSoFar: number) => void): Promise<CaseOutcome>;
  specs: CaseSpec[];
}

function runner(answer: (spec: CaseSpec) => string = (s) => finding(s), perFile: number | null = 0.01): FakeRunner {
  const specs: CaseSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return { ok: true, output: answer(spec), cost_usd: perFile === null ? null : perFile * spec.files.length };
    },
  };
}

let now = new Date("2026-09-29T10:00:00Z");

function ports(cases: FakeRunner, trees: Record<string, Record<string, string>> = { [SHA1]: TREE, [SHA2]: TREE2 }, scan: Partial<ScanConfig> = {}): ScanPorts {
  return {
    state: stateHomeFs(stateDir),
    clock: () => {
      now = new Date(now.getTime() + 1000);
      return now;
    },
    cases,
    source: fakeSource(trees),
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({ ok: true, settings: { scan: { ...SCAN_DEFAULTS, ...scan }, validateTier: "sol-high" } }),
    buildAgents: () => ({ ok: true }),
  };
}

async function run(s: ScanRunner, sha: string, delta = false) {
  const p = await s.preview({ sha, delta });
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await s.start({ key: p.preview.key, sha, delta });
  if (!r.ok) throw new Error(r.errors.join("; "));
  await s.idle();
  return { preview: p.preview, run: s.status().run! };
}

/** Calibration, then the rest: every stage-1 file of SHA1 read. */
async function fullScan(r: FakeRunner = runner()): Promise<void> {
  const s = new ScanRunner(ports(r));
  await run(s, SHA1);
  await run(s, SHA1);
  const left = await s.preview({ sha: SHA1 });
  if (!left.ok || left.preview.cases.length > 0) throw new Error("the full scan left something unread");
}

const store = (): FindingsStore => new FindingsStore(stateHomeFs(stateDir));
const byPath = (path: string): ScanFinding[] => store().load().findings.filter((f) => f.path === path);

function setState(path: string, state: ScanFinding["state"]): void {
  const file = join(stateDir, FINDINGS_FILE);
  const raw = JSON.parse(readFileSync(file, "utf8")) as FindingsFile;
  for (const f of raw.findings) if (f.path === path) f.state = state;
  writeFileSync(file, JSON.stringify(raw));
}

describe("a delta re-scan reads only changed-hash files", () => {
  it("changed and new files only; unchanged files, tests and deleted files are not read", async () => {
    await fullScan();
    const r = runner();
    const s = new ScanRunner(ports(r));
    const { preview, run: done } = await run(s, SHA2, true);
    expect(preview.mode).toBe("delta");
    // app/views.py and lib/util.py: unchanged, and read already.
    expect(preview.delta).toEqual({ since: SHA1, unchanged: 0 });
    expect(preview.covered).toBe(2);
    const read = preview.cases.flatMap((c) => c.files.map((f) => f.path)).sort();
    expect(read).toEqual(["app/models.py", "lib/big.py", "lib/new.py", "tools/x.py"]);
    expect(r.specs.flatMap((x) => x.files).sort()).toEqual(read);
    // Priced from the ledger and stopped hard at its own estimate.
    expect(preview.estimate_usd).toBeGreaterThan(0);
    expect(preview.cap_usd).toBe(preview.estimate_usd);
    expect(done).toMatchObject({ mode: "delta", state: "complete", sha: SHA2 });
  });

  it("the rest of an unfinished scan is not a change: a file the last scan never reached, unchanged, stays out", async () => {
    // Calibration only: app, web and lib read; tools never reached.
    const s = new ScanRunner(ports(runner(), { [SHA1]: TREE, [SHA3]: { ...TREE, "app/models.py": TREE2["app/models.py"]! } }));
    await run(s, SHA1);
    const p = await s.preview({ sha: SHA3, delta: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toEqual(["app/models.py"]);
    expect(p.preview.delta).toEqual({ since: SHA1, unchanged: 1 });
    // …while an ordinary preview at the same sha still offers the rest.
    const full = await s.preview({ sha: SHA3 });
    if (!full.ok) throw new Error(full.errors.join("; "));
    expect(full.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toContain("tools/x.py");
  });

  it("a delta and a full preview are different plans: one's key never starts the other", async () => {
    await fullScan();
    const s = new ScanRunner(ports(runner()));
    const d = await s.preview({ sha: SHA2, delta: true });
    if (!d.ok) throw new Error(d.errors.join("; "));
    expect(await s.start({ key: d.preview.key, sha: SHA2 })).toMatchObject({ ok: false });
  });

  it("refuses with no scan to compare against, before a price exists, and when nothing changed", async () => {
    const fresh = new ScanRunner(ports(runner()));
    expect(await fresh.preview({ sha: SHA2, delta: true })).toMatchObject({ ok: false, errors: [expect.stringMatching(/no stage-1 scan/)] });

    const unpriced = new ScanRunner(ports(runner((s) => finding(s), null)));
    await run(unpriced, SHA1);
    const p = await unpriced.preview({ sha: SHA2, delta: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.blockers.join(" ")).toMatch(/no measured price/);
    expect((await unpriced.start({ key: p.preview.key, sha: SHA2, delta: true })).ok).toBe(false);
  });

  it("nothing changed since the last scan: nothing to read, nothing started", async () => {
    await fullScan();
    const s = new ScanRunner(ports(runner()));
    const p = await s.preview({ sha: SHA1, delta: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.cases).toEqual([]);
    expect(p.preview.blockers.join(" ")).toMatch(/nothing changed/);
  });
});

/** The re-scan's answers: the app finding's code changed and it is now
 * reported as a design finding (a reword the fingerprint cannot follow);
 * lib reports the same finding on the same code; tools reports nothing. */
const rescanAnswer = (spec: CaseSpec): string =>
  spec.unit === "app" ? finding(spec, "design") : spec.unit === "tools" ? "NONE\n\nSUGGEST NONE" : finding(spec);

/** The fake judge: pairs every unreported finding with a fresh one on the
 * same file — what the companion would answer for a moved-and-reworded one. */
function samePathJudge(q: MatchQuestionView): MatchPair[] {
  return q.unreported.flatMap((o) => {
    const n = q.fresh.find((f) => f.path === o.path);
    return n ? [{ old: o.fingerprint, new: n.fingerprint }] : [];
  });
}

describe("exact match first, then the companion, then fixed", () => {
  async function rescan() {
    await fullScan();
    setState("app/models.py", "promoted");
    setState("lib/big.py", "dismissed");
    const oldApp = byPath("app/models.py")[0]!.fingerprint;
    const s = new ScanRunner(ports(runner(rescanAnswer)));
    const { run: done } = await run(s, SHA2, true);
    return { done, oldApp };
  }

  it("an exact fingerprint keeps its triage; what nothing fresh could be is fixed at once, with the scan sha", async () => {
    const { done } = await rescan();
    // lib/big.py grew, but the anchored code is the same: the same finding.
    expect(byPath("lib/big.py")).toEqual([expect.objectContaining({ state: "dismissed", seen: 2, fixed: null })]);
    // tools/x.py was re-read and reports nothing; web/index.ts is gone —
    // no fresh finding could be either (other units, other kinds): fixed.
    for (const p of ["tools/x.py", "web/index.ts"]) {
      expect(byPath(p)).toEqual([
        expect.objectContaining({ state: "fixed", fixed: expect.objectContaining({ run: done.id, sha: SHA2, from: "new" }) }),
      ]);
    }
    // The app finding is neither fixed nor matched: it waits on the companion.
    expect(done.matching).toEqual({ fixed: 2, pending: 1 });
  });

  it("hands the companion only what an exact match missed", async () => {
    const { oldApp } = await rescan();
    const { question } = store().question();
    expect(question).not.toBeNull();
    expect(question!.unreported.map((f) => f.fingerprint)).toEqual([oldApp]);
    expect(question!.fresh).toEqual([expect.objectContaining({ path: "app/models.py", kind: "design", state: "new" })]);
    // Still promoted while undecided — never fixed on a guess.
    expect(byPath("app/models.py").find((f) => f.fingerprint === oldApp)!.state).toBe("promoted");
  });

  it("the judge's pair is the same finding: its state and history carried onto the new sighting", async () => {
    const { done, oldApp } = await rescan();
    const { question } = store().question();
    const r = store().match({ key: question!.key, pairs: samePathJudge(question!) });
    expect(r).toEqual({ ok: true, matched: 1, fixed: 0, new: 0 });
    const app = byPath("app/models.py");
    expect(app).toHaveLength(1);
    expect(app[0]).toMatchObject({ state: "promoted", kind: "design", seen: 2, aliases: [oldApp] });
    expect(app[0]!.first_seen.sha).toBe(SHA1);
    expect(app[0]!.last_seen).toMatchObject({ run: done.id, sha: SHA2 });
    expect(store().question().question).toBeNull();
  });

  it("an old finding the judge pairs with nothing is fixed; the fresh one stays new", async () => {
    const { oldApp } = await rescan();
    const { question } = store().question();
    expect(store().match({ key: question!.key, pairs: [] })).toEqual({ ok: true, matched: 0, fixed: 1, new: 1 });
    const app = byPath("app/models.py");
    expect(app.find((f) => f.fingerprint === oldApp)).toMatchObject({ state: "fixed", fixed: expect.objectContaining({ sha: SHA2, from: "promoted" }) });
    expect(app.find((f) => f.fingerprint !== oldApp)).toMatchObject({ state: "new", kind: "design" });
  });

  it("an answer is refused whole: a stale key, a stranger, a reused fingerprint", async () => {
    const { oldApp } = await rescan();
    const { question } = store().question();
    const fresh = question!.fresh[0]!.fingerprint;
    expect(store().match({ key: "stale", pairs: [] })).toMatchObject({ ok: false });
    expect(store().match({ key: question!.key, pairs: [{ old: "nope", new: fresh }] })).toMatchObject({ ok: false });
    expect(store().match({ key: question!.key, pairs: [{ old: fresh, new: oldApp }] })).toMatchObject({ ok: false });
    // Nothing moved.
    expect(store().question().question!.key).toBe(question!.key);
    expect(byPath("app/models.py").find((f) => f.fingerprint === oldApp)!.state).toBe("promoted");
  });
});

// ---- the store alone ------------------------------------------------------------

const S = (run: string, sha: string, at: string) => ({ run, sha, at });

function reported(path: string, fp: string, over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    fingerprint: fp,
    unit: path.split("/")[0]!,
    path,
    blob: `b1-${path}`,
    start: 1,
    end: 2,
    lens: "pass-scan",
    kind: "bug",
    severity: "P2",
    confidence: null,
    claim: "c",
    evidence: null,
    fix: null,
    detail: null,
    validated: false,
    doubt: null,
    ...over,
  };
}

function row(path: string, blobHash: string, run: string, at: string): LedgerEntry {
  return {
    path,
    blob: blobHash,
    lens: "pass-scan",
    tier: "sol-med",
    effort: "low",
    validator: false,
    sha: run,
    lines: 10,
    cost_usd: 0.01,
    run,
    case: "u",
    at,
  };
}

describe("the findings store's lifecycle", () => {
  it("a fixed finding that comes back is new again — or dismissed again, if the operator already said so", () => {
    const st = store();
    st.report([reported("a/x.py", "fa"), reported("a/y.py", "fb")], S("r1", "s1", "2026-09-29T10:00:00Z"));
    const file = join(stateDir, FINDINGS_FILE);
    const raw = JSON.parse(readFileSync(file, "utf8")) as FindingsFile;
    raw.findings.find((f) => f.fingerprint === "fb")!.state = "dismissed";
    writeFileSync(file, JSON.stringify(raw));
    // Both files gone at s2: fixed.
    expect(st.reconcile({ rows: [], tree: new Set(), run: S("r2", "s2", "2026-09-29T11:00:00Z") })).toEqual({ fixed: 2, pending: 0 });
    st.report([reported("a/x.py", "fa"), reported("a/y.py", "fb")], S("r3", "s3", "2026-09-29T12:00:00Z"));
    const got = new Map(st.load().findings.map((f) => [f.fingerprint, f]));
    expect(got.get("fa")).toMatchObject({ state: "new", fixed: null, seen: 2 });
    expect(got.get("fb")).toMatchObject({ state: "dismissed", fixed: null });
  });

  it("counts a re-read from a run the companion never finished: the ledger, not the run, says the file changed", () => {
    const st = store();
    st.report([reported("a/x.py", "fa")], S("r1", "s1", "2026-09-29T10:00:00Z"));
    // r2 read a/x.py at new content and was interrupted before its end.
    const rows = [row("a/x.py", "b1-a/x.py", "r1", "2026-09-29T10:00:01Z"), row("a/x.py", "b2", "r2", "2026-09-29T11:00:00Z")];
    expect(st.reconcile({ rows, tree: new Set(["a/x.py"]), run: S("r3", "s3", "2026-09-29T12:00:00Z") })).toEqual({ fixed: 1, pending: 0 });
    expect(st.load().findings[0]).toMatchObject({ state: "fixed", fixed: { run: "r3", sha: "s3", from: "new" } });
  });

  it("a finding its own run read is not unreported, and one never re-read stays as it was", () => {
    const st = store();
    st.report([reported("a/x.py", "fa"), reported("b/y.py", "fb")], S("r1", "s1", "2026-09-29T10:00:00Z"));
    const rows = [row("a/x.py", "b1-a/x.py", "r1", "2026-09-29T10:00:01Z")];
    expect(st.reconcile({ rows, tree: new Set(["a/x.py", "b/y.py"]), run: S("r1", "s1", "2026-09-29T10:00:02Z") })).toEqual({ fixed: 0, pending: 0 });
    expect(st.load().findings.every((f) => f.state === "new")).toBe(true);
  });

  it("an unreported finding reported exactly again later leaves the question", () => {
    const st = store();
    st.report([reported("a/x.py", "old")], S("r1", "s1", "2026-09-29T10:00:00Z"));
    st.report([reported("a/x.py", "fresh", { blob: "b2" })], S("r2", "s2", "2026-09-29T11:00:00Z"));
    const rows = [row("a/x.py", "b2", "r2", "2026-09-29T11:00:01Z")];
    expect(st.reconcile({ rows, tree: new Set(["a/x.py"]), run: S("r2", "s2", "2026-09-29T11:00:02Z") })).toEqual({ fixed: 0, pending: 1 });
    // The old one comes back exactly at s3: nothing left to judge.
    st.report([reported("a/x.py", "old", { blob: "b3" })], S("r3", "s3", "2026-09-29T12:00:00Z"));
    expect(st.question().question).toBeNull();
    expect(st.load().findings.every((f) => f.state === "new")).toBe(true);
  });
});
