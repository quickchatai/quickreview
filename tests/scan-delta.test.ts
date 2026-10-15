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
import { planStage1, type PriorReading } from "../src/setup/scan.js";
import {
  ScanRunner,
  type ScanPorts,
  type ScanSource,
  type ScanTree,
} from "../src/setup/scanrun.js";
import type { UnitCut } from "../src/setup/unitcut.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-delta-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const lines = (n: number, word: string): string =>
  Array.from({ length: n }, (_, i) => `${word}_${i + 1} = ${i + 1}`).join("\n") + "\n";

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
  units: ["app", "lib", "web", "tools"].map((u) => ({
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

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);

function fakeSource(trees: Record<string, Record<string, string>>): ScanSource {
  const listOf = (files: Record<string, string>) =>
    Object.entries(files).map(([path, text]) => ({ path, blob: blob(text) }));
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
  run(
    spec: CaseSpec,
    signal: AbortSignal,
    onCost?: (spentSoFar: number) => void,
  ): Promise<CaseOutcome>;
  specs: CaseSpec[];
}

function runner(
  answer: (spec: CaseSpec) => string = (s) => finding(s),
  perFile: number | null = 0.01,
): FakeRunner {
  const specs: CaseSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return {
        ok: true,
        output: answer(spec),
        cost_usd: perFile === null ? null : perFile * spec.files.length,
      };
    },
  };
}

let now = new Date("2026-09-29T10:00:00Z");

function ports(
  cases: FakeRunner,
  trees: Record<string, Record<string, string>> = { [SHA1]: TREE, [SHA2]: TREE2 },
  scan: Partial<ScanConfig> = {},
): ScanPorts {
  return {
    state: stateHomeFs(stateDir),
    clock: () => {
      now = new Date(now.getTime() + 1000);
      return now;
    },
    cases,
    source: fakeSource(trees),
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({
      ok: true,
      settings: { scan: { ...SCAN_DEFAULTS, validator: false, ...scan } },
    }),
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
  if (!left.ok || left.preview.cases.length > 0)
    throw new Error("the full scan left something unread");
}

const store = (): FindingsStore => new FindingsStore(stateHomeFs(stateDir));
const byPath = (path: string): ScanFinding[] =>
  store()
    .load()
    .findings.filter((f) => f.path === path);

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
    expect(preview.delta).toEqual({ since: SHA1, owed: 0 });
    expect(preview.covered).toBe(2);
    const read = preview.cases.flatMap((c) => c.files.map((f) => f.path)).sort();
    expect(read).toEqual(["app/models.py", "lib/big.py", "lib/new.py", "tools/x.py"]);
    expect(r.specs.flatMap((x) => x.files).sort()).toEqual(read);
    // Priced from the ledger and stopped hard at its own estimate.
    expect(preview.estimate_usd).toBeGreaterThan(0);
    expect(preview.cap_usd).toBe(preview.estimate_usd);
    expect(done).toMatchObject({ mode: "delta", state: "complete", sha: SHA2 });
  });

  it("the rest of an unfinished scan is still owed: a file no scan ever read, unchanged, is in the delta", async () => {
    // Calibration only: app, web and lib read; tools never reached.
    const s = new ScanRunner(
      ports(runner(), {
        [SHA1]: TREE,
        [SHA3]: { ...TREE, "app/models.py": TREE2["app/models.py"]! },
      }),
    );
    await run(s, SHA1);
    const p = await s.preview({ sha: SHA3, delta: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    // Unread first: tools/x.py (never read) ahead of app/models.py (changed).
    expect(p.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toEqual([
      "tools/x.py",
      "app/models.py",
    ]);
    expect(p.preview.delta).toEqual({ since: SHA1, owed: 1 });
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
    expect(await fresh.preview({ sha: SHA2, delta: true })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/no stage-1 scan/)],
    });

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
  spec.unit === "app"
    ? finding(spec, "design")
    : spec.unit === "tools"
      ? "NONE\n\nSUGGEST NONE"
      : finding(spec);

/** The fake judge: pairs every unreported finding with a fresh one on the
 * same file — what the companion would answer for a moved-and-reworded one. */
function samePathJudge(q: MatchQuestionView): MatchPair[] {
  return q.unreported.flatMap((o) => {
    const n = q.fresh.find((f) => f.path === o.path);
    return n ? [{ old: o.fingerprint, new: n.fingerprint }] : [];
  });
}

describe("a run with nothing to read still reconciles what it owes", () => {
  // The next commit only deletes a reported file: every remaining file is
  // covered at its content, so no case is planned — yet the deleted file's
  // finding must still settle.
  const ONLY_DELETED: Record<string, string> = { ...TREE };
  delete ONLY_DELETED["web/index.ts"];

  it.each([false, true])(
    "a deletion-only commit is startable and reconciles the deleted file's finding (delta %s)",
    async (delta) => {
      await fullScan();
      expect(byPath("web/index.ts").map((f) => f.state)).toEqual(["new"]);
      const r = runner();
      const s = new ScanRunner(ports(r, { [SHA1]: TREE, [SHA3]: ONLY_DELETED }));
      const p = await s.preview({ sha: SHA3, delta });
      expect(p.ok && p.preview.cases).toEqual([]);
      expect(p.ok && p.preview.blockers).toEqual([]);
      expect(p.ok && p.preview.reconcile_only).toMatch(/1 open finding/);
      const got = await run(s, SHA3, delta);
      expect(r.specs).toEqual([]);
      expect(got.run.state).toBe("complete");
      // Reconciled: gone from the tree, it is put to the companion (it may
      // have moved into a file the full scan read after it was seen).
      expect(got.run.matching).toMatchObject({ pending: 1 });
      expect(
        store()
          .question()
          .question?.unreported.map((f) => f.path),
      ).toEqual(["web/index.ts"]);
      // Asked: nothing is owed any more, so the empty plan is refused again.
      const again = await s.preview({ sha: SHA3, delta });
      expect(again.ok && again.preview.reconcile_only).toBeUndefined();
      expect(again.ok && again.preview.blockers.join(" ")).toMatch(
        /nothing (left|changed) to read/,
      );
    },
  );

  it("a run that ended before its reconcile leaves the empty plan startable", async () => {
    await fullScan();
    const file = join(stateDir, "scan/run.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      current: { matching?: unknown; state: string };
    };
    raw.current.matching = null;
    raw.current.state = "running";
    writeFileSync(file, JSON.stringify(raw));
    const s = new ScanRunner(ports(runner()));
    const p = await s.preview({ sha: SHA1 });
    expect(p.ok && p.preview.blockers).toEqual([]);
    expect(p.ok && p.preview.reconcile_only).toMatch(/ended before its findings were reconciled/);
    const got = await run(s, SHA1);
    expect(got.run.matching).not.toBeNull();
  });
});

describe("a start still planning keeps its tree", () => {
  it("a preview at another sha, planned meanwhile, does not prune the starting run's tree", async () => {
    await fullScan();
    const p = ports(runner(), { [SHA1]: TREE, [SHA2]: TREE2 });
    const keeps: Array<{ sha: string; keep: string[] }> = [];
    const open = p.source.open;
    p.source = {
      ...p.source,
      open: (sha, keep) => {
        keeps.push({ sha, keep: [...keep] });
        return open(sha, keep);
      },
    };
    const s = new ScanRunner(p);
    const first = await s.preview({ sha: SHA2, delta: true });
    if (!first.ok) throw new Error(first.errors.join("; "));
    keeps.length = 0;
    // Issued together, as a model's parallel tool calls are.
    const [started, other] = await Promise.all([
      s.start({ key: first.preview.key, sha: SHA2, delta: true }),
      s.preview({ sha: SHA1 }),
    ]);
    expect(started.ok).toBe(true);
    expect(other.ok).toBe(true);
    await s.idle();
    expect(keeps.map((k) => k.sha)).toEqual([SHA2, SHA1]);
    expect(keeps[1]!.keep).toContain(SHA2);
  });
});

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
    expect(byPath("lib/big.py")).toEqual([
      expect.objectContaining({ state: "dismissed", seen: 2, fixed: null }),
    ]);
    // tools/x.py was re-read and reports nothing; web/index.ts is gone —
    // no fresh finding could be either (other units, other kinds): fixed.
    for (const p of ["tools/x.py", "web/index.ts"]) {
      expect(byPath(p)).toEqual([
        expect.objectContaining({
          state: "fixed",
          fixed: expect.objectContaining({ run: done.id, sha: SHA2, from: "new" }),
        }),
      ]);
    }
    // The app finding is neither fixed nor matched: it waits on the companion.
    expect(done.matching).toEqual({
      fixed: 2,
      pending: 1,
      not_reproduced: 0,
      dismissed_unreported: 0,
    });
  });

  it("hands the companion only what an exact match missed", async () => {
    const { oldApp } = await rescan();
    const { question } = store().question();
    expect(question).not.toBeNull();
    expect(question!.unreported.map((f) => f.fingerprint)).toEqual([oldApp]);
    expect(question!.fresh).toEqual([
      expect.objectContaining({ path: "app/models.py", kind: "design", state: "new" }),
    ]);
    // Still promoted while undecided — never fixed on a guess.
    expect(byPath("app/models.py").find((f) => f.fingerprint === oldApp)!.state).toBe("promoted");
  });

  it("the judge's pair is the same finding: its state and history carried onto the new sighting", async () => {
    const { done, oldApp } = await rescan();
    const { question } = store().question();
    const r = store().match({ key: question!.key, pairs: samePathJudge(question!) });
    expect(r).toEqual({ ok: true, matched: 1, fixed: 0, new: 0, dismissed_unreported: 0 });
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
    expect(store().match({ key: question!.key, pairs: [] })).toEqual({
      ok: true,
      matched: 0,
      fixed: 1,
      new: 1,
      dismissed_unreported: 0,
    });
    const app = byPath("app/models.py");
    expect(app.find((f) => f.fingerprint === oldApp)).toMatchObject({
      state: "fixed",
      fixed: expect.objectContaining({ sha: SHA2, from: "promoted" }),
    });
    expect(app.find((f) => f.fingerprint !== oldApp)).toMatchObject({
      state: "new",
      kind: "design",
    });
  });

  it("an answer is refused whole: a stale key, a stranger, a reused fingerprint", async () => {
    const { oldApp } = await rescan();
    const { question } = store().question();
    const fresh = question!.fresh[0]!.fingerprint;
    expect(store().match({ key: "stale", pairs: [] })).toMatchObject({ ok: false });
    expect(
      store().match({ key: question!.key, pairs: [{ old: "nope", new: fresh }] }),
    ).toMatchObject({ ok: false });
    expect(
      store().match({ key: question!.key, pairs: [{ old: fresh, new: oldApp }] }),
    ).toMatchObject({ ok: false });
    // Nothing moved.
    expect(store().question().question!.key).toBe(question!.key);
    expect(byPath("app/models.py").find((f) => f.fingerprint === oldApp)!.state).toBe("promoted");
  });
});

describe("content read before, superseded, then back: read again (selfscan def42498)", () => {
  // tools/x.py read at A (a finding), re-read at B (none: fixed), then
  // reverted to A. Coverage is the NEWEST reading per file, not every reading
  // ever — else A counts as covered, nothing re-reads it, and the finding
  // stays `fixed` while the defect is back in the tree.
  const SHA4 = "4".repeat(40);
  const TREE4: Record<string, string> = { ...TREE2, "tools/x.py": TREE["tools/x.py"]! };
  const trees = { [SHA1]: TREE, [SHA2]: TREE2, [SHA4]: TREE4 };

  it("a delta re-reads the reverted file and the fixed finding comes back", async () => {
    const first = new ScanRunner(ports(runner(), trees));
    await run(first, SHA1);
    await run(first, SHA1);
    await run(new ScanRunner(ports(runner(rescanAnswer), trees)), SHA2, true);
    expect(byPath("tools/x.py")).toEqual([expect.objectContaining({ state: "fixed" })]);

    const r = runner();
    const { preview } = await run(new ScanRunner(ports(r, trees)), SHA4, true);
    expect(preview.cases.flatMap((c) => c.files.map((f) => f.path))).toEqual(["tools/x.py"]);
    expect(byPath("tools/x.py")).toEqual([expect.objectContaining({ state: "new", fixed: null })]);
  });

  it("a full preview offers it too; the newest reading of a file still covers it", async () => {
    const first = new ScanRunner(ports(runner(), trees));
    await run(first, SHA1);
    await run(first, SHA1);
    await run(new ScanRunner(ports(runner(rescanAnswer), trees)), SHA2, true);
    const p = await new ScanRunner(ports(runner(), trees)).preview({ sha: SHA4 });
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toEqual(["tools/x.py"]);
  });

  it("a delta cut short before the reverted file keeps it owed: the next delta still reads it", async () => {
    // The revert lands beside another change; the delta finishes lib but the
    // tools case fails. The last scan is now SHA5 — whose tree holds the
    // reverted content, and the ledger read that content once, long ago.
    const SHA5 = "5".repeat(40);
    const TREE5: Record<string, string> = {
      ...TREE4,
      "lib/util.py": `${lines(30, "util")}util_extra = 1\n`,
    };
    const all = { ...trees, [SHA5]: TREE5 };
    const first = new ScanRunner(ports(runner(), all));
    await run(first, SHA1);
    await run(first, SHA1);
    await run(new ScanRunner(ports(runner(rescanAnswer), all)), SHA2, true);
    const failTools: FakeRunner = {
      specs: [],
      run: async (spec) =>
        spec.unit === "tools"
          ? { ok: false, reason: "pi exited 1", cost_usd: 0 }
          : { ok: true, output: finding(spec), cost_usd: 0.01 * spec.files.length },
    };
    const cut = await new ScanRunner(ports(failTools, all)).preview({ sha: SHA5, delta: true });
    if (!cut.ok) throw new Error(cut.errors.join("; "));
    expect(cut.preview.cases.flatMap((c) => c.files.map((f) => f.path)).sort()).toEqual([
      "lib/util.py",
      "tools/x.py",
    ]);
    const s = new ScanRunner(ports(failTools, all));
    const started = await s.start({ key: cut.preview.key, sha: SHA5, delta: true });
    if (!started.ok) throw new Error(started.errors.join("; "));
    await s.idle();

    const again = await new ScanRunner(ports(runner(), all)).preview({ sha: SHA5, delta: true });
    if (!again.ok) throw new Error(again.errors.join("; "));
    expect(again.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toEqual(["tools/x.py"]);
  });
});

describe("a delta covers every file changed OR with no complete reading at its content (self-scan round 7)", () => {
  // A file never read to completion is owed a reading even when its content
  // has not changed since the baseline; leaving it out as "unchanged" would
  // leave a file no lens has ever read.
  const T: Record<string, string> = {
    "a/read.py": lines(10, "r"),
    "a/never.py": lines(10, "n"),
    "a/changed.py": lines(10, "c"),
  };
  const files = Object.entries(T).map(([path, text]) => ({ path, blob: blob(text) }));
  const b = (p: string): string => blob(T[p]!);
  const at = "2026-09-01T00:00:00Z";
  const base = {
    cut: {
      units: [{ name: "a", roots: ["a"], kind: "directory" as const, note: "" }],
      ignored: [],
    },
    files,
    linesOf: (p: string) => T[p]!.split("\n").length - 1,
    exclude: [],
    budget: { maxFiles: 1, maxLines: 400 },
    // The last scan's tree held every file at this very content, except the changed one.
    delta: {
      read: new Map([
        ["a/read.py", b("a/read.py")],
        ["a/changed.py", "old-c"],
      ]),
      baseline: new Map([
        ["a/read.py", b("a/read.py")],
        ["a/never.py", b("a/never.py")],
        ["a/changed.py", "old-c"],
      ]),
    },
    history: new Map<string, PriorReading>([
      ["a/read.py", { blob: b("a/read.py"), complete: true, at }],
      ["a/changed.py", { blob: "old-c", complete: true, at }],
    ]),
    covered: new Set([`a/read.py\0${b("a/read.py")}`]),
  };
  const planned = (plan: ReturnType<typeof planStage1>) =>
    plan.cases.flatMap((c) => c.files.map((f) => f.path));

  it("an unchanged file never read is in the delta — unread first; an unchanged, fully-read one is not", () => {
    const plan = planStage1(base);
    expect(planned(plan)).toEqual(["a/never.py", "a/changed.py"]);
    expect(plan.covered).toBe(1);
    expect(plan.owed).toBe(1);
  });

  it("an unchanged file whose newest reading at this content did not complete is in the delta", () => {
    const plan = planStage1({
      ...base,
      history: new Map([
        ...base.history,
        ["a/never.py", { blob: b("a/never.py"), complete: false, at }],
      ]),
    });
    expect(planned(plan)).toEqual(["a/never.py", "a/changed.py"]);
  });

  it("a file the last scan skipped as binary, unchanged and text now, is in the delta (engine)", async () => {
    const withNul = { ...TREE, "tools/x.py": `${lines(15, "tool")}\0tail\n` };
    const src = fakeSource({ [SHA1]: withNul, [SHA3]: withNul });
    // At SHA1 the tree could not read tools/x.py (binary); at SHA3 — the same
    // blob — it reads as text.
    const binaryAt1: ScanSource = {
      ...src,
      open: (sha, keep) => {
        const o = src.open(sha, keep);
        if (!o.ok || sha !== SHA1) return o;
        const t = o.tree;
        return {
          ok: true,
          tree: {
            ...t,
            lines: (p) => (p === "tools/x.py" ? null : t.lines(p)),
            whyUnreadable: (p) => (p === "tools/x.py" ? "binary" : null),
          },
        };
      },
    };
    const mk = (r: FakeRunner): ScanRunner => new ScanRunner({ ...ports(r), source: binaryAt1 });
    const first = mk(runner());
    await run(first, SHA1);
    let left = await first.preview({ sha: SHA1 });
    if (left.ok && left.preview.cases.length > 0) {
      await run(first, SHA1);
      left = await first.preview({ sha: SHA1 });
    }
    if (!left.ok) throw new Error(left.errors.join("; "));
    expect(left.preview.cases).toEqual([]);
    expect(left.preview.skipped).toEqual([{ path: "tools/x.py", why: "binary" }]);

    const p = await mk(runner()).preview({ sha: SHA3, delta: true });
    if (!p.ok) throw new Error(p.errors.join("; "));
    expect(p.preview.cases.flatMap((c) => c.files.map((f) => f.path))).toEqual(["tools/x.py"]);
    expect(p.preview.delta).toEqual({ since: SHA1, owed: 1 });
    expect(p.preview.blockers).toEqual([]);
  });

  it("nothing changed and everything read whole: the delta is empty", () => {
    const plan = planStage1({
      ...base,
      files: files.filter((f) => f.path === "a/read.py"),
    });
    expect(plan.cases).toEqual([]);
    expect(plan.owed).toBe(0);
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
  it("a fixed finding that comes back is new again; a dismissed one is never fixed and comes back dismissed", () => {
    const st = store();
    st.report(
      [reported("a/x.py", "fa"), reported("a/y.py", "fb")],
      S("r1", "s1", "2026-09-29T10:00:00Z"),
    );
    const file = join(stateDir, FINDINGS_FILE);
    const raw = JSON.parse(readFileSync(file, "utf8")) as FindingsFile;
    raw.findings.find((f) => f.fingerprint === "fb")!.state = "dismissed";
    writeFileSync(file, JSON.stringify(raw));
    // Both files gone at s2: the untriaged one fixed, the dismissed one kept
    // dismissed and stamped (a scan never overwrites a dismissal).
    expect(
      st.reconcile({ rows: [], tree: new Set(), run: S("r2", "s2", "2026-09-29T11:00:00Z") }),
    ).toEqual({ fixed: 1, pending: 0, not_reproduced: 0, dismissed_unreported: 1 });
    st.report(
      [reported("a/x.py", "fa"), reported("a/y.py", "fb")],
      S("r3", "s3", "2026-09-29T12:00:00Z"),
    );
    const got = new Map(st.load().findings.map((f) => [f.fingerprint, f]));
    expect(got.get("fa")).toMatchObject({ state: "new", fixed: null, seen: 2 });
    expect(got.get("fb")).toMatchObject({ state: "dismissed", fixed: null });
  });

  it("counts a re-read from a run the companion never finished: the ledger, not the run, says the file changed", () => {
    const st = store();
    st.report([reported("a/x.py", "fa")], S("r1", "s1", "2026-09-29T10:00:00Z"));
    // r2 read a/x.py at new content and was interrupted before its end.
    const rows = [
      row("a/x.py", "b1-a/x.py", "r1", "2026-09-29T10:00:01Z"),
      row("a/x.py", "b2", "r2", "2026-09-29T11:00:00Z"),
    ];
    expect(
      st.reconcile({ rows, tree: new Set(["a/x.py"]), run: S("r3", "s3", "2026-09-29T12:00:00Z") }),
    ).toEqual({ fixed: 1, pending: 0, not_reproduced: 0, dismissed_unreported: 0 });
    expect(st.load().findings[0]).toMatchObject({
      state: "fixed",
      fixed: { run: "r3", sha: "s3", from: "new" },
    });
  });

  it("a finding its own run read is not unreported, and one never re-read stays as it was", () => {
    const st = store();
    st.report(
      [reported("a/x.py", "fa"), reported("b/y.py", "fb")],
      S("r1", "s1", "2026-09-29T10:00:00Z"),
    );
    const rows = [row("a/x.py", "b1-a/x.py", "r1", "2026-09-29T10:00:01Z")];
    expect(
      st.reconcile({
        rows,
        tree: new Set(["a/x.py", "b/y.py"]),
        run: S("r1", "s1", "2026-09-29T10:00:02Z"),
      }),
    ).toEqual({ fixed: 0, pending: 0, not_reproduced: 0, dismissed_unreported: 0 });
    expect(st.load().findings.every((f) => f.state === "new")).toBe(true);
  });

  it("a later run that changes nothing about the pending question leaves its key where it was", () => {
    const st = store();
    st.report([reported("a/x.py", "old")], S("r1", "s1", "2026-09-29T10:00:00Z"));
    st.report([reported("a/x.py", "fresh", { blob: "b2" })], S("r2", "s2", "2026-09-29T11:00:00Z"));
    const rows = [row("a/x.py", "b2", "r2", "2026-09-29T11:00:01Z")];
    st.reconcile({ rows, tree: new Set(["a/x.py"]), run: S("r2", "s2", "2026-09-29T11:00:02Z") });
    const before = st.question().question!;
    // r3 read nothing new: the companion's answer to the key it read still lands.
    expect(
      st.reconcile({ rows, tree: new Set(["a/x.py"]), run: S("r3", "s3", "2026-09-29T12:00:00Z") }),
    ).toEqual({ fixed: 0, pending: 1, not_reproduced: 0, dismissed_unreported: 0 });
    expect(st.question().question).toMatchObject({ key: before.key, run: "r2", sha: "s2" });
    expect(st.match({ key: before.key, pairs: [{ old: "old", new: "fresh" }] })).toMatchObject({
      ok: true,
      matched: 1,
    });
  });

  it("an unreported finding reported exactly again later leaves the question", () => {
    const st = store();
    st.report([reported("a/x.py", "old")], S("r1", "s1", "2026-09-29T10:00:00Z"));
    st.report([reported("a/x.py", "fresh", { blob: "b2" })], S("r2", "s2", "2026-09-29T11:00:00Z"));
    const rows = [row("a/x.py", "b2", "r2", "2026-09-29T11:00:01Z")];
    expect(
      st.reconcile({ rows, tree: new Set(["a/x.py"]), run: S("r2", "s2", "2026-09-29T11:00:02Z") }),
    ).toEqual({ fixed: 0, pending: 1, not_reproduced: 0, dismissed_unreported: 0 });
    // The old one comes back exactly at s3: nothing left to judge.
    st.report([reported("a/x.py", "old", { blob: "b3" })], S("r3", "s3", "2026-09-29T12:00:00Z"));
    expect(st.question().question).toBeNull();
    expect(st.load().findings.every((f) => f.state === "new")).toBe(true);
  });
});
