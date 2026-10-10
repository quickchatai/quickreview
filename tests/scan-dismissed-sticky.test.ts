// A dismissal is sticky: the operator's triage decision is never overwritten
// by a re-scan, even when a re-read no longer reports the finding. Every path
// that settles an unreported finding — reconcile's outright settle, a report
// that shrinks the pending question, the companion's match answer, all
// through the one settle (`settleUnreported`) — keeps a dismissed finding
// `dismissed` and records the audit (`unreported`: the run and sha that no
// longer reported it). A re-sighting clears the audit and keeps the
// dismissal; a legacy store row (fixed, from dismissed) reads back as
// dismissed. Promoted findings still become `fixed` (their ticket closes).
// Driven at the FindingsStore seam through the real rooted state port on a
// temp dir.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateHomeFs } from "../src/setup/adapters.js";
import {
  FindingsStore,
  type FindingsFile,
  type ReportedFinding,
  type ScanFinding,
} from "../src/setup/findings.js";
import type { LedgerEntry } from "../src/setup/ledger.js";
import { FINDINGS_FILE, parseFindingsFile } from "../src/setup/scanreport.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-scan-sticky-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const store = (): FindingsStore => new FindingsStore(stateHomeFs(stateDir));
const S = (run: string, at: string) => ({ run, sha: `sha-${run}`, at });

function reported(fp: string, over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    fingerprint: fp,
    unit: "src",
    path: "src/proposals.ts",
    blob: "b1",
    start: 10,
    end: 12,
    lens: "pass-scan",
    kind: "correctness",
    severity: "P1",
    confidence: null,
    claim: "The accept path applies the patch before checking the manifest pin.",
    evidence: null,
    fix: null,
    detail: null,
    validated: true,
    doubt: null,
    ...over,
  };
}

function row(over: Partial<LedgerEntry> & Pick<LedgerEntry, "run" | "at">): LedgerEntry {
  return {
    path: "src/proposals.ts",
    blob: "b2",
    lens: "pass-scan",
    tier: "t",
    effort: "low",
    validator: false,
    sha: `sha-${over.run}`,
    lines: 9,
    cost_usd: 0,
    case: "u",
    ...over,
  };
}

const DISMISSAL = { reason: "by design", at: "t0", memory: "written" as const };
const OLD = "d1".repeat(32);
const PROMO = "e1".repeat(32);

function get(st: FindingsStore, fp: string): ScanFinding {
  const f = st.load().findings.find((x) => x.fingerprint === fp || (x.aliases ?? []).includes(fp));
  if (!f) throw new Error(`no finding ${fp}`);
  return f;
}

function dismiss(st: FindingsStore, fp: string): void {
  const r = st.update(fp, (f) => ({ ...f, state: "dismissed", dismissal: DISMISSAL }));
  if (!r.ok) throw new Error(r.errors.join("; "));
}

describe("a dismissed finding a re-scan no longer reports stays dismissed", () => {
  it("reconcile, file gone from the tree: dismissed, stamped for audit, not counted as fixed", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    dismiss(st, OLD);
    const r = st.reconcile({ rows: [], tree: new Set(), run: S("r2", "2026-09-30T11:00:00Z") });
    expect(r).toEqual({ fixed: 0, pending: 0, not_reproduced: 0, dismissed_unreported: 1 });
    expect(get(st, OLD)).toMatchObject({
      state: "dismissed",
      dismissal: DISMISSAL,
      unreported: { run: "r2", sha: "sha-r2" },
    });
  });

  it("reconcile, changed content with no possible fresh counterpart: dismissed, stamped", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    dismiss(st, OLD);
    const r = st.reconcile({
      rows: [row({ run: "r2", at: "2026-09-30T11:00:00Z" })],
      tree: new Set(["src/proposals.ts"]),
      blobs: new Map([["src/proposals.ts", "b2"]]),
      run: S("r2", "2026-09-30T11:00:00Z"),
    });
    expect(r).toMatchObject({ fixed: 0, dismissed_unreported: 1 });
    expect(get(st, OLD)).toMatchObject({ state: "dismissed", unreported: { run: "r2" } });
  });

  it("the audit is recorded once: a later reconcile neither restamps, recounts nor asks about it", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    dismiss(st, OLD);
    st.reconcile({ rows: [], tree: new Set(), run: S("r2", "2026-09-30T11:00:00Z") });
    // r3 re-reads at yet other content and raises a fresh finding of its lens.
    st.report(
      [
        reported("f3".repeat(32), {
          path: "src/other.ts",
          blob: "c3",
          claim: "Something else entirely.",
        }),
      ],
      S("r3", "2026-09-30T12:00:00Z"),
    );
    const r = st.reconcile({
      rows: [row({ run: "r3", at: "2026-09-30T12:00:00Z", path: "src/other.ts", blob: "c3" })],
      tree: new Set(["src/other.ts"]),
      run: S("r3", "2026-09-30T12:00:00Z"),
    });
    expect(r).toEqual({ fixed: 0, pending: 0, not_reproduced: 0, dismissed_unreported: 0 });
    expect(get(st, OLD)).toMatchObject({ state: "dismissed", unreported: { run: "r2" } });
    expect(st.question().question).toBeNull();
  });

  it("a stamped dismissal is out of play: its gone file's re-reads never make another finding's candidates", () => {
    const st = store();
    const X = "c1".repeat(32);
    const F = "f4".repeat(32);
    // D (lens B, file gone later) and X (lens A) sighted at r1; D dismissed.
    st.report(
      [
        reported(OLD, { path: "src/d.ts", lens: "pass-b" }),
        reported(X, { path: "src/x.ts", lens: "pass-a", claim: "X's own problem." }),
      ],
      S("r1", "2026-09-30T10:00:00Z"),
    );
    dismiss(st, OLD);
    // r2: d.ts is gone; lens B read z.ts; lens A raised F on y.ts. D has no candidate of its lens: stamped.
    st.report(
      [reported(F, { path: "src/y.ts", lens: "pass-a", claim: "An unrelated problem of lens A." })],
      S("r2", "2026-09-30T11:00:00Z"),
    );
    const r2 = [
      row({ run: "r2", at: "2026-09-30T11:00:00Z", lens: "pass-b", path: "src/z.ts" }),
      row({ run: "r2", at: "2026-09-30T11:00:00Z", lens: "pass-a", path: "src/y.ts" }),
    ];
    const tree = new Set(["src/x.ts", "src/y.ts", "src/z.ts"]);
    expect(st.reconcile({ rows: r2, tree, run: S("r2", "2026-09-30T11:00:00Z") })).toMatchObject({
      dismissed_unreported: 1,
      pending: 0,
    });
    // r3 re-reads x.ts at other content: X is fixed outright — F (first seen by
    // r2) is no candidate for it, since only the stamped D's gone file would
    // have pulled r2's findings in.
    const r3 = [
      ...r2,
      row({ run: "r3", at: "2026-09-30T12:00:00Z", lens: "pass-a", path: "src/x.ts" }),
    ];
    expect(st.reconcile({ rows: r3, tree, run: S("r3", "2026-09-30T12:00:00Z") })).toEqual({
      fixed: 1,
      pending: 0,
      not_reproduced: 0,
      dismissed_unreported: 0,
    });
    expect(get(st, X).state).toBe("fixed");
    expect(get(st, OLD)).toMatchObject({ state: "dismissed", unreported: { run: "r2" } });
  });

  it("the companion leaves it unpaired: dismissed, stamped, not counted as fixed", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    dismiss(st, OLD);
    const FRESH = "f2".repeat(32);
    st.report(
      [
        reported(FRESH, {
          blob: "b2",
          start: 40,
          end: 41,
          claim: "A different problem in the same lens.",
        }),
      ],
      S("r2", "2026-09-30T11:00:00Z"),
    );
    const rec = st.reconcile({
      rows: [row({ run: "r2", at: "2026-09-30T11:00:00Z" })],
      tree: new Set(["src/proposals.ts"]),
      blobs: new Map([["src/proposals.ts", "b2"]]),
      run: S("r2", "2026-09-30T11:00:00Z"),
    });
    expect(rec).toMatchObject({ fixed: 0, pending: 1 });
    const q = st.question().question!;
    expect(q.unreported.map((f) => f.fingerprint)).toEqual([OLD]);
    const m = st.match({ key: q.key, pairs: [] });
    expect(m).toEqual({ ok: true, matched: 0, fixed: 0, new: 1, dismissed_unreported: 1 });
    expect(get(st, OLD)).toMatchObject({
      state: "dismissed",
      dismissal: DISMISSAL,
      unreported: { run: "r2" },
    });
  });

  it("the companion pairs it: the moved finding keeps the dismissal and carries no audit stamp", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    dismiss(st, OLD);
    const FRESH = "f2".repeat(32);
    st.report(
      [reported(FRESH, { blob: "b2", start: 40, end: 42 })],
      S("r2", "2026-09-30T11:00:00Z"),
    );
    st.reconcile({
      rows: [row({ run: "r2", at: "2026-09-30T11:00:00Z" })],
      tree: new Set(["src/proposals.ts"]),
      blobs: new Map([["src/proposals.ts", "b2"]]),
      run: S("r2", "2026-09-30T11:00:00Z"),
    });
    const q = st.question().question!;
    expect(st.match({ key: q.key, pairs: [{ old: OLD, new: FRESH }] })).toMatchObject({
      ok: true,
      matched: 1,
      fixed: 0,
      dismissed_unreported: 0,
    });
    expect(get(st, FRESH)).toMatchObject({ state: "dismissed", dismissal: DISMISSAL });
    expect(get(st, FRESH).unreported ?? null).toBeNull();
  });

  it("re-sighted after the stamp: still dismissed (no reopen by a scan), the audit cleared", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    dismiss(st, OLD);
    st.reconcile({ rows: [], tree: new Set(), run: S("r2", "2026-09-30T11:00:00Z") });
    st.report([reported(OLD, { blob: "b3" })], S("r3", "2026-09-30T12:00:00Z"));
    expect(get(st, OLD)).toMatchObject({
      state: "dismissed",
      dismissal: DISMISSAL,
      unreported: null,
      fixed: null,
      seen: 2,
    });
    // And, back in play, a later unreport stamps it again.
    const r = st.reconcile({ rows: [], tree: new Set(), run: S("r4", "2026-09-30T13:00:00Z") });
    expect(r).toMatchObject({ fixed: 0, dismissed_unreported: 1 });
    expect(get(st, OLD)).toMatchObject({ state: "dismissed", unreported: { run: "r4" } });
  });
});

describe("a promoted finding still becomes fixed (its ticket closes)", () => {
  it("reconcile fixes a promoted finding beside a dismissed one", () => {
    const st = store();
    st.report(
      [reported(OLD), reported(PROMO, { path: "src/pireview.ts" })],
      S("r1", "2026-09-30T10:00:00Z"),
    );
    dismiss(st, OLD);
    const p = st.update(PROMO, (f) => ({
      ...f,
      state: "promoted",
      ticket: { sink: "tracker", ref: "", effort: "e", filed_at: "t" },
    }));
    expect(p.ok).toBe(true);
    const r = st.reconcile({ rows: [], tree: new Set(), run: S("r2", "2026-09-30T11:00:00Z") });
    expect(r).toEqual({ fixed: 1, pending: 0, not_reproduced: 0, dismissed_unreported: 1 });
    expect(get(st, PROMO)).toMatchObject({
      state: "fixed",
      fixed: { from: "promoted", run: "r2" },
    });
    expect(get(st, OLD).state).toBe("dismissed");
  });
});

describe("a legacy store row: a finding fixed from dismissed", () => {
  it("reads a finding fixed FROM dismissed back as dismissed, the fix kept as the audit", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    const file = join(stateDir, FINDINGS_FILE);
    const raw = JSON.parse(readFileSync(file, "utf8")) as FindingsFile;
    const f = raw.findings[0]!;
    f.state = "fixed";
    f.dismissal = DISMISSAL;
    f.fixed = { run: "r5", sha: "sha-r5", at: "2026-09-30T15:00:00Z", from: "dismissed" };
    writeFileSync(file, JSON.stringify(raw));
    const want = {
      state: "dismissed",
      dismissal: DISMISSAL,
      fixed: null,
      unreported: { run: "r5", sha: "sha-r5", at: "2026-09-30T15:00:00Z" },
    };
    expect(get(st, OLD)).toMatchObject(want);
    // The TUI reads the same file through the same parser.
    expect(parseFindingsFile(readFileSync(file, "utf8")).findings[0]).toMatchObject(want);
    // And a store rewrite persists it: nothing flips it back.
    st.reconcile({
      rows: [],
      tree: new Set(["src/proposals.ts"]),
      run: S("r6", "2026-09-30T16:00:00Z"),
    });
    expect((JSON.parse(readFileSync(file, "utf8")) as FindingsFile).findings[0]).toMatchObject(
      want,
    );
  });

  it("leaves a finding fixed from new or promoted as it was", () => {
    const st = store();
    st.report([reported(OLD)], S("r1", "2026-09-30T10:00:00Z"));
    const file = join(stateDir, FINDINGS_FILE);
    const raw = JSON.parse(readFileSync(file, "utf8")) as FindingsFile;
    raw.findings[0]!.state = "fixed";
    raw.findings[0]!.fixed = { run: "r5", sha: "sha-r5", at: "t", from: "promoted" };
    writeFileSync(file, JSON.stringify(raw));
    expect(get(st, OLD)).toMatchObject({ state: "fixed", fixed: { from: "promoted" } });
  });
});
