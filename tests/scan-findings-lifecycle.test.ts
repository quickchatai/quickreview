// The scan findings store's reconcile and collapse bookkeeping (selfscan
// setup-scan unit): a collapsed finding's severity, content hash and lenses
// after an alias sighting; a reverted tree; a moved finding from an
// interrupted run. Driven at the FindingsStore seam through the real rooted
// state port on a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateHomeFs } from "../src/setup/adapters.js";
import { FindingsStore, type ReportedFinding } from "../src/setup/findings.js";
import type { LedgerEntry } from "../src/setup/ledger.js";
import type { FileRange } from "../src/setup/scan.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-scan-life-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const store = (): FindingsStore => new FindingsStore(stateHomeFs(stateDir));
const S = (run: string, at: string) => ({ run, sha: `sha-${run}`, at });

function reported(fp: string, over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    fingerprint: fp,
    unit: "src",
    path: "src/commands.ts",
    blob: "b1",
    start: 932,
    end: 932,
    lens: "pass-security",
    kind: "security",
    severity: "P2",
    confidence: null,
    claim: "Operator authorization is checked on a pathname rather than bound to the command bytes actually read.",
    evidence: null,
    fix: null,
    detail: null,
    validated: true,
    doubt: null,
    ...over,
  };
}

// One defect, two lenses: collapsed into CANON (security) with ALIAS (data-safety).
const CANON = reported("aa".repeat(32));
const ALIAS = reported("ab".repeat(32), {
  start: 986,
  end: 987,
  lens: "pass-data-safety",
  severity: "P1",
  claim:
    "Operator authority is checked against a pathname rather than the command bytes subsequently read, allowing directory replacement to escalate session commands.",
});

function row(over: Partial<LedgerEntry> & Pick<LedgerEntry, "lens" | "run" | "at">): LedgerEntry {
  return { path: CANON.path, blob: "b2", tier: "t", effort: "low", validator: false, sha: `sha-${over.run}`, lines: 9, cost_usd: 0, case: "u", ...over };
}

describe("a collapsed finding after an alias sighting", () => {
  it("severity is recomputed from each sighting's latest report, whichever reports last (5aed2a85)", () => {
    const st = store();
    st.report([CANON, ALIAS], S("r1", "2026-09-30T10:00:00Z"));
    expect(st.load().findings[0]!.severity).toBe("P1");
    st.report([CANON], S("r2", "2026-09-30T11:00:00Z"));
    expect(st.load().findings[0]!.severity).toBe("P1");
    // The alias drops to P3 in a later run: the latest reports are P2 and P3.
    st.report([{ ...ALIAS, severity: "P3" }], S("r3", "2026-09-30T12:00:00Z"));
    expect(st.load().findings[0]!.severity).toBe("P2");
  });

  it("takes the alias sighting's content hash, so a ranged reading it began is not read as other content (513d1633)", () => {
    const st = store();
    st.report([CANON, ALIAS], S("r1", "2026-09-30T10:00:00Z"));
    // r2 reads the changed file (b2) in ranges; its first range reports the alias.
    st.report([{ ...ALIAS, blob: "b2" }], S("r2", "2026-09-30T11:00:00Z"));
    expect(st.load().findings[0]!.blob).toBe("b2");
    const first: FileRange = { start: 1, end: 600, total: 1200 };
    const second: FileRange = { start: 590, end: 1200, total: 1200 };
    const rows = ["pass-security", "pass-data-safety"].flatMap((lens) => [
      row({ lens, run: "r2", at: "2026-09-30T11:00:01Z", range: first }),
      row({ lens, run: "r3", at: "2026-09-30T12:00:00Z", range: second }),
    ]);
    // r3 finishes the ranges without another report: r2 already saw it at b2,
    // so it is not other content. r3's range does hold the finding's lines
    // and stayed silent — at the same content that is a re-read that did not
    // reproduce it, stamped, never a fix (scan-loop).
    expect(st.reconcile({ rows, tree: new Set([CANON.path]), run: S("r3", "2026-09-30T12:00:01Z") })).toEqual({ fixed: 0, pending: 0, not_reproduced: 1, dismissed_unreported: 0 });
    expect(st.load().findings[0]!.state).toBe("new");
  });

  it("a fresh finding of ANY lens that raised it might be it: held for the companion, never fixed outright (0c84de9c)", () => {
    const st = store();
    st.report([CANON, ALIAS], S("r1", "2026-09-30T10:00:00Z"));
    // r2: both lenses re-read changed content; security is silent, data-safety
    // reports the defect under a new fingerprint.
    const moved = reported("cc".repeat(32), { ...ALIAS, fingerprint: "cc".repeat(32), blob: "b2", start: 40, end: 41 });
    st.report([moved], S("r2", "2026-09-30T11:00:00Z"));
    const rows = [row({ lens: "pass-security", run: "r2", at: "2026-09-30T11:00:01Z" }), row({ lens: "pass-data-safety", run: "r2", at: "2026-09-30T11:00:02Z" })];
    expect(st.reconcile({ rows, tree: new Set([CANON.path]), run: S("r2", "2026-09-30T11:00:03Z") })).toEqual({ fixed: 0, pending: 1, not_reproduced: 0, dismissed_unreported: 0 });
    const q = st.question().question!;
    expect(q.fresh.map((f) => f.fingerprint)).toEqual([moved.fingerprint]);
    expect(st.match({ key: q.key, pairs: [{ old: CANON.fingerprint, new: moved.fingerprint }] })).toMatchObject({ ok: true, matched: 1, fixed: 0 });
  });
});

describe("reconcile settles only against the content the run's tree holds", () => {
  it("a reading of other content does not fix a finding whose file the run's tree has reverted to (790d58cb)", () => {
    const st = store();
    st.report([CANON], S("r1", "2026-09-30T10:00:00Z"));
    // r2 read clean b2 and died before its reconcile; r3's tree is back at b1
    // and ended before re-reading the file.
    const rows = [row({ lens: "pass-security", run: "r2", at: "2026-09-30T11:00:00Z" })];
    const tree = new Set([CANON.path]);
    const blobs = new Map([[CANON.path, "b1"]]);
    expect(st.reconcile({ rows, tree, blobs, run: S("r3", "2026-09-30T12:00:00Z") })).toEqual({ fixed: 0, pending: 0, not_reproduced: 0, dismissed_unreported: 0 });
    expect(st.load().findings[0]!.state).toBe("new");
    // At b2 in the tree, the same reading does settle it.
    expect(st.reconcile({ rows, tree, blobs: new Map([[CANON.path, "b2"]]), run: S("r4", "2026-09-30T13:00:00Z") })).toEqual({ fixed: 1, pending: 0, not_reproduced: 0, dismissed_unreported: 0 });
  });

  it("a deleted path's finding keeps an interrupted earlier run's moved sighting as a candidate (60299a8b)", () => {
    const st = store();
    st.report([CANON], S("r1", "2026-09-30T10:00:00Z"));
    // r2 reports it moved to another file, writes its ledger row, then dies.
    const moved = reported("dd".repeat(32), { path: "src/operator.ts", blob: "q1" });
    st.report([moved], S("r2", "2026-09-30T11:00:00Z"));
    const rows = [row({ lens: "pass-security", path: "src/operator.ts", blob: "q1", run: "r2", at: "2026-09-30T11:00:01Z" })];
    // r3: the old path is gone; nothing re-reads the new one.
    expect(st.reconcile({ rows, tree: new Set(["src/operator.ts"]), run: S("r3", "2026-09-30T12:00:00Z") })).toEqual({ fixed: 0, pending: 1, not_reproduced: 0, dismissed_unreported: 0 });
    expect(st.question().question!.fresh.map((f) => f.fingerprint)).toEqual([moved.fingerprint]);
  });
});
