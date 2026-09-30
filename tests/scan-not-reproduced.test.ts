// `fixed` only when the code changed (scan-loop, round 4 of the self-scan):
// a re-read of a file at the SAME content a finding was last seen at that
// does not report it again is model variance, not a fix. The finding stays
// open, stamped `not_reproduced` (how many such re-reads, and the latest),
// so triage can still dismiss it — and a promoted one's ticket is not
// closed. A re-read of CHANGED content that no longer reports it is still
// `fixed` (FT-0428). Driven at the FindingsStore / ScanTriage seam through
// the real rooted state port on a temp dir.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { SinkResult, TrackerSink, TrackerTicket } from "../src/setup/engine.js";
import { FindingsStore, type ReportedFinding, type ScanFinding } from "../src/setup/findings.js";
import type { LedgerEntry } from "../src/setup/ledger.js";
import { ScanTriage } from "../src/setup/triage.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-notrepro-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FP = "ab".repeat(32);
const PATH = "src/commands.ts";
const S = (run: string, at: string) => ({ run, sha: `sha-${run}`, at });

function reported(over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    fingerprint: FP,
    unit: "src",
    path: PATH,
    blob: "b1",
    start: 10,
    end: 12,
    lens: "pass-security",
    kind: "security",
    severity: "P2",
    confidence: null,
    claim: "the command file is authorized by path, not by the bytes read",
    evidence: null,
    fix: null,
    detail: null,
    validated: true,
    doubt: null,
    validity: "confirmed",
    scenario: "a command file written by a session reaches the authorizer",
    ...over,
  };
}

function row(over: Partial<LedgerEntry> & Pick<LedgerEntry, "run" | "at" | "blob">): LedgerEntry {
  return { path: PATH, lens: "pass-security", tier: "t", effort: "low", validator: false, sha: `sha-${over.run}`, lines: 40, cost_usd: 0, case: "c", ...over };
}

const tree = new Set([PATH]);
const at = (blob: string) => new Map([[PATH, blob]]);
const only = (st: FindingsStore): ScanFinding => st.load().findings[0]!;

describe("a re-read of UNCHANGED content that does not report a finding", () => {
  it("keeps it open and stamps not_reproduced — never fixed", () => {
    const st = new FindingsStore(stateHomeFs(dir));
    st.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    // r2 (a narrower stage-2 row) re-reads the file at the same content, same lens, silent.
    const rows = [row({ blob: "b1", run: "r2", at: "2026-09-30T11:00:00Z" })];
    expect(st.reconcile({ rows, tree, blobs: at("b1"), run: S("r2", "2026-09-30T11:00:01Z") })).toEqual({
      fixed: 0,
      pending: 0,
      not_reproduced: 1,
    });
    expect(only(st)).toMatchObject({ state: "new", not_reproduced: { count: 1, run: "r2", sha: "sha-r2" } });
    expect(only(st).fixed ?? null).toBeNull();
    expect(st.question().question).toBeNull();
  });

  it("counts each silent re-read once: a later reconcile with no new reading stamps nothing", () => {
    const st = new FindingsStore(stateHomeFs(dir));
    st.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    const rows = [row({ blob: "b1", run: "r2", at: "2026-09-30T11:00:00Z" })];
    st.reconcile({ rows, tree, blobs: at("b1"), run: S("r2", "2026-09-30T11:00:01Z") });
    expect(st.reconcile({ rows, tree, blobs: at("b1"), run: S("r3", "2026-09-30T12:00:00Z") })).toEqual({ fixed: 0, pending: 0, not_reproduced: 0 });
    expect(only(st).not_reproduced).toMatchObject({ count: 1, run: "r2" });
    // A second silent re-read of the same content counts.
    const more = [...rows, row({ blob: "b1", run: "r4", at: "2026-09-30T13:00:00Z" })];
    expect(st.reconcile({ rows: more, tree, blobs: at("b1"), run: S("r4", "2026-09-30T13:00:01Z") })).toMatchObject({ not_reproduced: 1 });
    expect(only(st)).toMatchObject({ state: "new", not_reproduced: { count: 2, run: "r4" } });
  });

  it("a ranged re-read that does not hold the finding's lines, or the sighting run's own reading, stamps nothing", () => {
    const st = new FindingsStore(stateHomeFs(dir));
    st.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    const rows = [
      row({ blob: "b1", run: "r1", at: "2026-09-30T10:00:01Z" }),
      row({ blob: "b1", run: "r2", at: "2026-09-30T11:00:00Z", range: { start: 20, end: 40, total: 40 } }),
    ];
    expect(st.reconcile({ rows, tree, blobs: at("b1"), run: S("r2", "2026-09-30T11:00:01Z") })).toEqual({ fixed: 0, pending: 0, not_reproduced: 0 });
    expect(only(st).not_reproduced ?? null).toBeNull();
    // A range that holds lines 10-12 does count.
    const holds = [...rows, row({ blob: "b1", run: "r3", at: "2026-09-30T12:00:00Z", range: { start: 1, end: 25, total: 40 } })];
    expect(st.reconcile({ rows: holds, tree, blobs: at("b1"), run: S("r3", "2026-09-30T12:00:01Z") })).toMatchObject({ not_reproduced: 1 });
  });

  it("a dismissed finding is neither stamped nor counted — it is already triaged", () => {
    const st = new FindingsStore(stateHomeFs(dir));
    st.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    const raw = JSON.parse(readFileSync(join(dir, "scan/findings.json"), "utf8")) as { findings: ScanFinding[] };
    raw.findings[0]!.state = "dismissed";
    writeFileSync(join(dir, "scan/findings.json"), JSON.stringify(raw));
    const rows = [row({ blob: "b1", run: "r2", at: "2026-09-30T11:00:00Z" })];
    expect(st.reconcile({ rows, tree, blobs: at("b1"), run: S("r2", "2026-09-30T11:00:01Z") })).toEqual({ fixed: 0, pending: 0, not_reproduced: 0 });
    expect(only(st)).toMatchObject({ state: "dismissed" });
    expect(only(st).not_reproduced ?? null).toBeNull();
  });

  it("a later sighting clears the stamp; until then it stays in the open list for triage", () => {
    const st = new FindingsStore(stateHomeFs(dir));
    st.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    st.reconcile({ rows: [row({ blob: "b1", run: "r2", at: "2026-09-30T11:00:00Z" })], tree, blobs: at("b1"), run: S("r2", "2026-09-30T11:00:01Z") });
    expect(st.list({ state: "new" }).findings).toHaveLength(1);
    st.report([reported()], S("r3", "2026-09-30T12:00:00Z"));
    expect(only(st).not_reproduced ?? null).toBeNull();
  });
});

describe("a re-read of CHANGED content that does not report a finding", () => {
  it("is fixed, as before (FT-0428)", () => {
    const st = new FindingsStore(stateHomeFs(dir));
    st.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    const rows = [row({ blob: "b2", run: "r2", at: "2026-09-30T11:00:00Z" })];
    expect(st.reconcile({ rows, tree, blobs: at("b2"), run: S("r2", "2026-09-30T11:00:01Z") })).toEqual({ fixed: 1, pending: 0, not_reproduced: 0 });
    expect(only(st)).toMatchObject({ state: "fixed", fixed: { run: "r2", from: "new" } });
  });

  it("a finding once not reproduced is still fixed when its content later changes", () => {
    const st = new FindingsStore(stateHomeFs(dir));
    st.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    const rows = [row({ blob: "b1", run: "r2", at: "2026-09-30T11:00:00Z" })];
    st.reconcile({ rows, tree, blobs: at("b1"), run: S("r2", "2026-09-30T11:00:01Z") });
    const changed = [...rows, row({ blob: "b2", run: "r3", at: "2026-09-30T12:00:00Z" })];
    expect(st.reconcile({ rows: changed, tree, blobs: at("b2"), run: S("r3", "2026-09-30T12:00:01Z") })).toMatchObject({ fixed: 1 });
    expect(only(st).state).toBe("fixed");
  });
});

class FakeSink implements TrackerSink {
  readonly kind = "tracker";
  filed: TrackerTicket[] = [];
  closes: string[] = [];
  async file(t: TrackerTicket): Promise<SinkResult> {
    this.filed.push(t);
    return { ok: true, ref: `FT-${9000 + this.filed.length}` };
  }
  async close(ref: string): Promise<SinkResult> {
    this.closes.push(ref);
    return { ok: true, ref };
  }
}

describe("a promoted finding's ticket", () => {
  function setup() {
    const state = stateHomeFs(dir);
    const findings = new FindingsStore(state);
    const sink = new FakeSink();
    let tick = 0;
    const triage = new ScanTriage({
      findings,
      state,
      memory: null,
      tracker: sink,
      clock: () => new Date(Date.parse("2026-09-30T14:00:00Z") + 1000 * tick++),
      units: () => ["src"],
      runs: () => [{ id: "r2", sha: "sha-r2", state: "complete" }, { id: "r1", sha: "sha-r1", state: "complete" }],
    });
    return { findings, sink, triage };
  }

  it("is not closed when the re-read was of unchanged content; it is when the content changed", async () => {
    const { findings, sink, triage } = setup();
    findings.report([reported()], S("r1", "2026-09-30T10:00:00Z"));
    expect(await triage.promote({ fingerprint: FP, effort: "e" })).toMatchObject({ ok: true });
    const rows = [row({ blob: "b1", run: "r2", at: "2026-09-30T11:00:00Z" })];
    findings.reconcile({ rows, tree, blobs: at("b1"), run: S("r2", "2026-09-30T11:00:01Z") });
    expect(only(findings)).toMatchObject({ state: "promoted", not_reproduced: { count: 1 } });
    expect(await triage.closeFixed()).toEqual({ closed: [], problems: [] });
    expect(sink.closes).toEqual([]);

    const changed = [...rows, row({ blob: "b2", run: "r3", at: "2026-09-30T12:00:00Z" })];
    findings.reconcile({ rows: changed, tree, blobs: at("b2"), run: S("r3", "2026-09-30T12:00:01Z") });
    expect((await triage.closeFixed()).closed).toHaveLength(1);
    expect(sink.closes).toEqual(["FT-9001"]);
  });
});
