// A NEW FINDING THAT RESEMBLES A DISMISSED ONE SAYS SO (scan-loop). Round 7
// of the self-scan re-raised a finding the operator had just dismissed
// (memory-openviking store.ts, all-tags-removed sync, 7ff2ed7f) under a new
// fingerprint because its wording shifted: exact matching missed it and the
// near-duplicate fold only joins findings the same run sighted, never a
// dismissed one from an earlier run. The store now runs the dedup's own
// resemblance test (`nearDuplicate`: same file, same kind, near lines,
// similar claim) against every DISMISSED finding when it stores a new one,
// and flags a hit `resembles_dismissed: {fingerprint, reason}`. FLAG ONLY —
// the new finding stays `new` (auto-dismissing it is a policy call nobody
// has made) and the dismissed one is not touched. Driven at the
// FindingsStore seam through the real rooted state port on a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateHomeFs } from "../src/setup/adapters.js";
import { FindingsStore, dismissedLookalike, nearDuplicate, type ReportedFinding } from "../src/setup/findings.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-scan-resembles-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const store = (): FindingsStore => new FindingsStore(stateHomeFs(stateDir));
const S = (run: string, at: string) => ({ run, sha: `sha-${run}`, at });

function reported(fp: string, over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    fingerprint: fp,
    unit: "memory-openviking",
    path: "src/openviking/store.ts",
    blob: "b1",
    start: 210,
    end: 214,
    lens: "pass-scan",
    kind: "correctness",
    severity: "P2",
    confidence: null,
    claim: "Sync never clears the tag header when all tags are removed from an entry, so stale tags persist.",
    evidence: null,
    fix: null,
    detail: null,
    validated: true,
    doubt: null,
    ...over,
  };
}

const OLD = reported("7f".repeat(32));
// Round 7's rewording: another fingerprint, a few lines off, the same defect.
const REWORDED = reported("a7".repeat(32), {
  blob: "b2",
  start: 226,
  end: 229,
  claim: "Sync does not clear the tag header when all tags are removed, leaving stale tags on the entry.",
});
const UNRELATED = reported("c3".repeat(32), {
  blob: "b2",
  start: 400,
  end: 402,
  kind: "security",
  claim: "The batch-write precondition hash is computed over the footer-stripped body.",
});
const REASON = "by design — the engine drops an empty header itself";

/** Round 1 reports OLD; the operator dismisses it. */
function dismissedOld(): FindingsStore {
  const st = store();
  st.report([OLD], S("r1", "2026-09-30T10:00:00Z"));
  const d = st.update(OLD.fingerprint, (f) => ({ ...f, state: "dismissed", dismissal: { reason: REASON, at: "t1", memory: "written" } }));
  expect(d.ok).toBe(true);
  return st;
}

describe("a new finding resembling a dismissed one is flagged, never dismissed", () => {
  it("the fixture is the dedup's near-duplicate, so the resemblance is the dedup's own test", () => {
    expect(nearDuplicate(OLD, REWORDED)).toBe(true);
    expect(nearDuplicate(OLD, UNRELATED)).toBe(false);
  });

  it("a reworded re-raise is flagged with the dismissal's fingerprint and reason; nothing changes state", () => {
    const st = dismissedOld();
    const before = st.load().findings.find((f) => f.fingerprint === OLD.fingerprint)!;
    expect(st.report([REWORDED], S("r2", "2026-09-30T11:00:00Z"))).toEqual({ added: 1, matched: 0, merged: 0 });
    const all = st.load().findings;
    expect(all).toHaveLength(2);
    const fresh = all.find((f) => f.fingerprint === REWORDED.fingerprint)!;
    expect(fresh.state).toBe("new");
    expect(fresh.resembles_dismissed).toEqual({ fingerprint: OLD.fingerprint, reason: REASON });
    expect(dismissedLookalike(fresh)).toEqual({ fingerprint: OLD.fingerprint, reason: REASON });
    // The dismissed finding is untouched: no fold, no alias, no sighting.
    expect(all.find((f) => f.fingerprint === OLD.fingerprint)).toEqual(before);
  });

  it("an unrelated new finding in the same file is not flagged", () => {
    const st = dismissedOld();
    st.report([UNRELATED], S("r2", "2026-09-30T11:00:00Z"));
    const fresh = st.load().findings.find((f) => f.fingerprint === UNRELATED.fingerprint)!;
    expect(fresh.state).toBe("new");
    expect(fresh.resembles_dismissed ?? null).toBeNull();
    expect(dismissedLookalike(fresh)).toBeNull();
  });

  it("a finding resembling one that is NOT dismissed is not flagged (it is the match question's, or the fold's)", () => {
    const st = store();
    st.report([OLD], S("r1", "2026-09-30T10:00:00Z"));
    st.report([REWORDED], S("r2", "2026-09-30T11:00:00Z"));
    const fresh = st.load().findings.find((f) => f.fingerprint === REWORDED.fingerprint)!;
    expect(fresh.resembles_dismissed ?? null).toBeNull();
  });

  it("a re-sighting keeps the flag; the flag goes once the dismissal it points at is undone", () => {
    const st = dismissedOld();
    st.report([REWORDED], S("r2", "2026-09-30T11:00:00Z"));
    st.report([REWORDED], S("r3", "2026-09-30T12:00:00Z"));
    expect(st.load().findings.find((f) => f.fingerprint === REWORDED.fingerprint)!.resembles_dismissed?.fingerprint).toBe(OLD.fingerprint);
    st.update(OLD.fingerprint, (f) => ({ ...f, state: "promoted" }));
    st.report([REWORDED], S("r4", "2026-09-30T13:00:00Z"));
    expect(st.load().findings.find((f) => f.fingerprint === REWORDED.fingerprint)!.resembles_dismissed ?? null).toBeNull();
  });

  it("the flag is only read on an untriaged finding — once the operator promotes or dismisses it, it is answered", () => {
    const st = dismissedOld();
    st.report([REWORDED], S("r2", "2026-09-30T11:00:00Z"));
    const r = st.update(REWORDED.fingerprint, (f) => ({ ...f, state: "promoted" }));
    expect(r.ok && dismissedLookalike(r.finding)).toBeNull();
  });

  it("list(): a flagged finding sorts below the unflagged findings of its severity", () => {
    const st = dismissedOld();
    const OTHER = reported("d4".repeat(32), { path: "src/z-last.ts", claim: "Another P2 entirely." });
    st.report([REWORDED, OTHER], S("r2", "2026-09-30T11:00:00Z"));
    const listed = st.list({ state: "new" }).findings.map((f) => f.fingerprint);
    // Path order alone would put src/openviking before src/z-last.
    expect(listed).toEqual([OTHER.fingerprint, REWORDED.fingerprint]);
  });
});
