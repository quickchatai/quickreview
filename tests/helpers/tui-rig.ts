// Shared rig for the TUI surface tests: fake terminal streams, a fake memory
// store spelled in the archived file's shape (the shortest honest way to
// write entries with real tags, days and pin flags), a fake digest fetcher,
// a fake change register, and `learningRig`, which installs the four
// learning surfaces over one store exactly as index.ts does.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { TUI_DEFAULTS } from "../../src/config.js";
import { parseLegacyMemory } from "../../src/memory/legacy-file.js";
import type { MemoryEntry, MemoryOp, MemoryStore } from "../../src/memory/store.js";
import { App } from "../../src/tui/app.js";
import type {
  ChangeEntry,
  ChangeLogProblem,
  ChangeRegister,
  RevertResult,
} from "../../src/tui/changelog-store.js";
import type { DigestFetcher } from "../../src/tui/digesttab.js";
import type { ChangeRegisterSource } from "../../src/tui/feedbacktab.js";
import {
  installLearningTabs,
  type LearningDeps,
  type LearningTabs,
} from "../../src/tui/learning.js";
import type { RemoteResult } from "../../src/tui/remote.js";
import type { ScanFinding } from "../../src/setup/scanreport.js";
import { installScanTab, ScanReportStore, type ScanTabState } from "../../src/tui/scantab.js";

export interface FakeStreams {
  out: NodeJS.WriteStream;
  input: NodeJS.ReadStream;
  written: () => string;
  type: (s: string | Buffer) => void;
}

export function fakeStreams(cols = 110, rows = 30): FakeStreams {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  let buf = "";
  (out as unknown as { columns: number }).columns = cols;
  (out as unknown as { rows: number }).rows = rows;
  out.write = ((s: string) => ((buf += s), true)) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return {
    out,
    input,
    written: () => buf,
    type: (s) => void (input as unknown as EventEmitter).emit("data", Buffer.from(s)),
  };
}

export const okSsh = (_h: string, _argv: string[]): Promise<RemoteResult> =>
  Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });

/** Three entries over two days: a pinned-free timeline with one `#bug`. */
export const SAMPLE = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive #eod-learning lesson about merge bases.

#refuted lesson about External Apps.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#bug #operations [[stale-recheck]] stale recheck flag lingers on #5180.
`;

export class FakeMemory implements MemoryStore {
  applied: MemoryOp[] = [];
  constructor(public md: string = SAMPLE) {}
  read(): Promise<MemoryEntry[]> {
    return Promise.resolve(parseLegacyMemory(this.md));
  }
  search(query: string): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    return Promise.resolve(
      parseLegacyMemory(this.md).filter((e) => e.text.toLowerCase().includes(q)),
    );
  }
  apply(op: MemoryOp): Promise<{ ok: boolean; message: string }> {
    this.applied.push(op);
    return Promise.resolve({ ok: true, message: `ok: ${op.op}` });
  }
}

export const fakeDigest: DigestFetcher = {
  // ASCENDING, like production: parseDigestList sorts lexicographically and
  // DigestState.back counts back from the NEWEST (= last) file.
  list: () => Promise.resolve(["2026-08-19.md", "2026-08-20.md"]),
  read: (f) => Promise.resolve(`# digest ${f}\n## Reviews\n- #5308 APPROVE`),
};

export function changeEntry(
  sha: string,
  subject: string,
  reverted?: { by: string; at: string },
): ChangeEntry {
  return {
    sha,
    short: sha.slice(0, 7),
    at: "2026-08-25T09:00:00Z",
    author: "QCR Companion",
    subject,
    feedback_pr: "5270",
    adjudication: "",
    ratified: 'he said "yes"',
    first_seen: "2026-08-25T09:30:00Z",
    ...(reverted ? { reverted } : {}),
  };
}

/** A change register that answers from memory and records reverts. */
export class FakeChanges implements ChangeRegisterSource {
  register: ChangeRegister | undefined;
  problem: ChangeLogProblem | undefined;
  reverted: string[] = [];
  refreshes = 0;
  constructor(entries?: ChangeEntry[], problem?: ChangeLogProblem) {
    this.register = entries
      ? { version: 1, updated_at: "2026-08-25T10:00:00Z", entries, scanned: 40 }
      : undefined;
    this.problem = problem;
  }
  refresh(): Promise<ChangeLogProblem | undefined> {
    this.refreshes += 1;
    return Promise.resolve(this.problem);
  }
  revert(sha: string): Promise<RevertResult> {
    this.reverted.push(sha);
    return Promise.resolve({ ok: true, message: `reverted ${sha.slice(0, 7)}` });
  }
}

export interface Rig {
  app: App;
  streams: FakeStreams;
  mem: FakeMemory;
  changes: FakeChanges;
  learning: LearningTabs;
}

/** An App with the four learning surfaces installed over fakes. */
export function learningRig(
  over: Partial<LearningDeps> & {
    cols?: number;
    rows?: number;
    mem?: FakeMemory;
    changes?: FakeChanges;
  } = {},
): Rig {
  const streams = fakeStreams(over.cols ?? 110, over.rows ?? 30);
  const app = new App(TUI_DEFAULTS, okSsh, streams.out, streams.input);
  const mem = over.mem ?? new FakeMemory();
  const changes = over.changes ?? new FakeChanges([]);
  const { cols: _c, rows: _r, mem: _m, changes: _ch, ...deps } = over;
  const learning = installLearningTabs(app, {
    memory: mem,
    digestFetcher: fakeDigest,
    fetchProposals: () =>
      Promise.resolve({
        proposals: [
          { slug: "baseline-mergebase-2026-08-20", head: ["## Rationale", "3 refuted blockers"] },
        ],
        improvements: [{ kind: "pr" as const, number: 12, title: "docs fix", state: "open" }],
      }),
    readTickets: () => [],
    changes,
    ...deps,
  });
  return { app, streams, mem, changes, learning };
}

export function settle(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- the [8] scan tab ---------------------------------------------------

/** One finding in the store's shape; `over` sets what a test cares about. */
export function scanFinding(over: Partial<ScanFinding> & { fingerprint: string }): ScanFinding {
  const seen = { run: "scan-1", sha: "a".repeat(40), at: "2026-09-29T10:00:00Z" };
  return {
    unit: "billing",
    path: "billing/models.py",
    start: 88,
    end: 90,
    lens: "pass-data-safety",
    kind: "race",
    severity: "P1",
    confidence: 0.8,
    claim: "Invoice.total is recomputed without a lock; concurrent refunds race",
    evidence: null,
    fix: null,
    detail: null,
    state: "new",
    validated: true,
    doubt: null,
    first_seen: seen,
    last_seen: seen,
    seen: 1,
    ...over,
  };
}

/** A realistic small scan: two units, a doubted finding, a style group of
 * three under one rule, a dismissed and a fixed one. */
export const SCAN_FINDINGS: ScanFinding[] = [
  scanFinding({ fingerprint: "f1".padEnd(64, "0") }),
  scanFinding({
    fingerprint: "f2".padEnd(64, "0"),
    path: "billing/tasks.py",
    start: 31,
    end: 31,
    lens: "pass-placement",
    kind: "placement",
    severity: "P3",
    claim: "the retry belongs in the task wrapper",
    doubt: { word: "unverifiable", reason: "the wrapper is not in the tree" },
  }),
  ...[3, 4, 5].map((n) =>
    scanFinding({
      fingerprint: `f${n}`.padEnd(64, "0"),
      path: `billing/views${n}.py`,
      start: n,
      end: n,
      lens: "pass-style",
      kind: "style",
      severity: "nit",
      claim: `a module-level import inside a function breaks rule 4.2 (${n})`,
    }),
  ),
  scanFinding({ fingerprint: "f6".padEnd(64, "0"), unit: "auth", path: "auth/views.py", start: 140, end: 141, lens: "pass-security", kind: "authz", severity: "P2", claim: "the token check trusts the header" }),
  scanFinding({ fingerprint: "f7".padEnd(64, "0"), unit: "auth", path: "auth/forms.py", state: "dismissed", severity: "P3", claim: "unused field", dismissal: { reason: "kept for the API", at: "2026-09-29T10:00:00Z", memory: "written" } }),
  scanFinding({ fingerprint: "f8".padEnd(64, "0"), unit: "auth", path: "auth/old.py", state: "fixed", severity: "nit", claim: "old bug" }),
];

function scanCase(unit: string, status: string, n: number) {
  return {
    id: `${unit}-1`,
    unit,
    part: 1,
    parts: 1,
    files: [`${unit}/a.py`],
    lines: 10 * n,
    estimate_usd: 1,
    status,
    cost_usd: status === "done" ? 1 : null,
    findings: 0,
    doubted: 0,
    dropped: 0,
    suggestions: [],
    error: null,
    started_at: null,
    finished_at: null,
  };
}

/** Write the three records the tab reads into `home`. */
export function writeScanHome(
  home: string,
  opts: { running?: boolean; findings?: ScanFinding[]; proposal?: boolean } = {},
): void {
  mkdirSync(join(home, "scan"), { recursive: true });
  const sha = "27a8a94".padEnd(40, "0");
  const run = {
    id: "scan-2",
    mode: "stage1",
    sha,
    plan_key: "k",
    started_at: "2026-09-29T10:00:00Z",
    finished_at: opts.running === false ? "2026-09-29T11:00:00Z" : null,
    state: opts.running === false ? "complete" : "running",
    cap_usd: 55,
    estimate_usd: 55,
    spent_usd: 41.2,
    unpriced_cases: 0,
    settings: { tier: "sol-low", effort: "low", validator: true, validate_tier: "sol-high" },
    cases: [scanCase("billing", "done", 1), scanCase("auth", "running", 2), scanCase("widget", "pending", 3)],
    problems: [],
  };
  writeFileSync(
    join(home, "scan", "run.json"),
    JSON.stringify({ version: 1, current: run, history: opts.running === false ? [] : [{ id: "scan-1", mode: "calibration", sha, state: "complete", started_at: "", finished_at: "", cases_done: 3, cases: 3, findings: 2, spent_usd: 1 }] }),
  );
  writeFileSync(join(home, "scan", "findings.json"), JSON.stringify({ version: 1, findings: opts.findings ?? SCAN_FINDINGS, question: null }));
  if (opts.proposal !== false) {
    const row = (id: string, lens: string, est: number, status = "run") => ({
      id,
      lens,
      tier: "sol-high",
      effort: "tier",
      reason: `${lens} over the hot path`,
      units: ["billing"],
      files: [{ path: "billing/models.py", blob: "b" }],
      tests: [],
      unpaired: [],
      lines: 100,
      estimate_usd: est,
      price: { rate: { usd_per_kline: 1, basis_lines: 1, cases: 1 }, basis: "measured", from: lens },
      status,
    });
    writeFileSync(
      join(home, "scan", "stage2.json"),
      JSON.stringify({
        version: 1,
        proposal: {
          key: "proposalkey0001",
          sha,
          at: "2026-09-29T11:00:00Z",
          request: [],
          budget_usd: 20,
          rows: [row("row-1", "pass-security", 6.1), row("row-2", "pass-data-safety", 4.8), row("row-3", "pass-tests", 2.4, "over-budget")],
          cap_usd: 10.9,
          runnable: 2,
          over_budget_usd: 2.4,
          validator: true,
        },
      }),
    );
  }
}

/** Removes a scan rig's temp home when the test that made it finishes. A
 * `process.on("exit")` sweep leaked ~2,000 dirs: vitest worker threads never
 * fire it. Outside a running test there is no hook, so the rig refuses rather
 * than leak. Pinned by tests/tui-scantab.test.ts "scratch hygiene". */
function removeWhenTestFinishes(home: string): void {
  try {
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  } catch (e) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(`installScanRig must be called inside a test: ${String(e)}`);
  }
}

export interface ScanRig {
  home: string;
  store: ScanReportStore;
  state: ScanTabState;
  asks: Array<{ verb: string; text: string }>;
}

/** Install the scan tab over a temp state home holding `writeScanHome`'s
 * records; every ask is recorded instead of reaching a companion. */
export function installScanRig(app: App, opts: Parameters<typeof writeScanHome>[1] & { companionUp?: boolean | undefined } = {}): ScanRig {
  const home = mkdtempSync(join(tmpdir(), "qcr-scantab-"));
  removeWhenTestFinishes(home);
  writeScanHome(home, opts);
  const store = new ScanReportStore(home);
  const asks: ScanRig["asks"] = [];
  const state = installScanTab(app, {
    store,
    ask: (text, verb) => (asks.push({ verb, text }), { ok: true, line: `scan ${verb}: asked` }),
    companionUp: () => opts.companionUp,
    now: () => new Date("2026-09-29T12:00:00Z"),
  });
  return { home, store, state, asks };
}
