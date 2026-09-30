// Near-duplicate collapse in the scan findings store (scan-loop). Stage 2 of
// the self-scan reported the same defect twice — from two rows of one lens,
// or from two lenses — under different fingerprints, because the fingerprint
// hashes the anchored code and the lens. The store now collapses a fresh
// finding into a stored one when both are the same file, the same kind, near
// ranges and highly similar claims: one finding, the highest severity, every
// lens that raised it, the absorbed fingerprints kept as aliases so exact
// matching on a later run and triage still recognise them. Driven at the
// FindingsStore seam through the real rooted state port on a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateHomeFs } from "../src/setup/adapters.js";
import { FindingsStore, nearDuplicate, type ReportedFinding } from "../src/setup/findings.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-scan-dedup-"));
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
    claim: "c",
    evidence: null,
    fix: null,
    detail: null,
    validated: true,
    doubt: null,
    ...over,
  };
}

// The two real pairs selfscan stage 2 emitted in src/commands.ts.
const A932 = reported("aa".repeat(32), {
  start: 932,
  end: 932,
  claim: "Operator authorization is checked on a pathname rather than bound to the command bytes actually read.",
});
const A986 = reported("ab".repeat(32), {
  start: 986,
  end: 987,
  lens: "pass-data-safety",
  severity: "P1",
  claim:
    "Operator authority is checked against a pathname rather than the command bytes subsequently read, allowing directory replacement to escalate session commands.",
});
const B966 = reported("ba".repeat(32), {
  start: 966,
  end: 966,
  claim: "Unsealed operator commands bypass Slack authorization instead of inheriting session-channel restrictions.",
});
const B1047 = reported("bb".repeat(32), {
  start: 1047,
  end: 1047,
  claim: "Unsealed operator commands bypass Slack authorization despite being classified as session-issued.",
});

describe("near-duplicate findings collapse into one", () => {
  it("two lenses' reports of one defect become one finding: highest severity, every lens, the other's fingerprint an alias", () => {
    const st = store();
    expect(st.report([A932], S("r1", "2026-09-30T10:00:00Z"))).toEqual({ added: 1, matched: 0, merged: 0 });
    expect(st.report([A986, B966, B1047], S("r1", "2026-09-30T10:00:05Z"))).toEqual({ added: 1, matched: 0, merged: 2 });
    const all = st.load().findings;
    expect(all).toHaveLength(2);
    const a = all.find((f) => f.fingerprint === A932.fingerprint)!;
    expect(a).toMatchObject({ severity: "P1", lens: "pass-security", lenses: ["pass-security", "pass-data-safety"], aliases: [A986.fingerprint], seen: 1 });
    expect(a.merged).toEqual([
      { fingerprint: A986.fingerprint, lens: "pass-data-safety", start: 986, end: 987, severity: "P1", claim: A986.claim },
    ]);
    const b = all.find((f) => f.fingerprint === B966.fingerprint)!;
    expect(b).toMatchObject({ lenses: ["pass-security"], aliases: [B1047.fingerprint] });
    // The absorbed fingerprint still names the finding, and the lens filter finds it under either lens.
    expect(st.find(A986.fingerprint)).toMatchObject({ ok: true, finding: { fingerprint: A932.fingerprint } });
    expect(st.list({ lens: "pass-data-safety" }).findings.map((f) => f.fingerprint)).toEqual([A932.fingerprint]);
  });

  it("collapses inside one report too, and keeps a validated survivor's credibility over a doubt", () => {
    const st = store();
    const doubted = { ...A932, doubt: { word: "unlikely", reason: "r" } };
    st.report([doubted, A986], S("r1", "2026-09-30T10:00:00Z"));
    const [only, ...rest] = st.load().findings;
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ fingerprint: A932.fingerprint, doubt: null, severity: "P1" });
  });

  it("a later run's exact fingerprints, alias included, find the one finding — its triage state kept, nothing added", () => {
    const st = store();
    st.report([A932, A986], S("r1", "2026-09-30T10:00:00Z"));
    const dismissed = st.update(A932.fingerprint, (f) => ({ ...f, state: "dismissed", dismissal: { reason: "not real", at: "x", memory: "written" } }));
    expect(dismissed.ok).toBe(true);
    // r2 reports the absorbed one first, reworded, at a new line: it is still the alias.
    expect(st.report([{ ...A986, start: 990, end: 991, severity: "P0" }, A932], S("r2", "2026-09-30T11:00:00Z"))).toEqual({
      added: 0,
      matched: 2,
      merged: 0,
    });
    const all = st.load().findings;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      fingerprint: A932.fingerprint,
      state: "dismissed",
      seen: 2,
      severity: "P0",
      aliases: [A986.fingerprint],
      last_seen: { run: "r2" },
      // The canonical's own report refreshes its wording, not the alias's.
      claim: A932.claim,
      start: 932,
    });
    expect(all[0]!.merged![0]).toMatchObject({ start: 990, end: 991, severity: "P0" });
  });

  it("a match carries the collapsed lenses and aliases to the renamed finding", () => {
    const st = store();
    st.report([A932, A986], S("r1", "2026-09-30T10:00:00Z"));
    const moved = { ...A932, fingerprint: "cc".repeat(32), blob: "b2", start: 940, end: 940, claim: "Something else entirely about a moved check." };
    st.report([moved], S("r2", "2026-09-30T11:00:00Z"));
    const rows = [
      { path: A932.path, blob: "b2", lens: "pass-security", tier: "t", effort: "low", validator: false, sha: "sha-r2", lines: 9, cost_usd: 0, run: "r2", case: "u", at: "2026-09-30T11:00:01Z" },
      // Both lenses that raised the collapsed finding re-read the file.
      { path: A932.path, blob: "b2", lens: "pass-data-safety", tier: "t", effort: "low", validator: false, sha: "sha-r2", lines: 9, cost_usd: 0, run: "r2", case: "u2", at: "2026-09-30T11:00:01Z" },
    ];
    st.reconcile({ rows, tree: new Set([A932.path]), run: S("r2", "2026-09-30T11:00:02Z") });
    const q = st.question().question!;
    expect(st.match({ key: q.key, pairs: [{ old: A932.fingerprint, new: moved.fingerprint }] })).toMatchObject({ ok: true, matched: 1 });
    const f = st.load().findings.find((x) => x.fingerprint === moved.fingerprint)!;
    expect(f.lenses).toEqual(["pass-security", "pass-data-safety"]);
    expect(f.aliases).toEqual(expect.arrayContaining([A932.fingerprint, A986.fingerprint]));
  });
});

describe("the end-of-run fold, and what stays the companion's", () => {
  const rowAt = (run: string, at: string) => [
    { path: A932.path, blob: "b1", lens: "pass-security", tier: "t", effort: "low", validator: false, sha: `sha-${run}`, lines: 9, cost_usd: 0, run, case: "u", at },
  ];

  it("a duplicate whose case ran before the sighting it duplicates folds at the run's end", () => {
    const st = store();
    st.report([A932], S("r1", "2026-09-30T10:00:00Z"));
    // r2: the other lens's case ran first — A932 was not yet sighted this run.
    expect(st.report([A986], S("r2", "2026-09-30T11:00:00Z"))).toEqual({ added: 1, matched: 0, merged: 0 });
    st.report([A932], S("r2", "2026-09-30T11:00:05Z"));
    st.reconcile({ rows: rowAt("r2", "2026-09-30T11:00:06Z"), tree: new Set([A932.path]), run: S("r2", "2026-09-30T11:00:07Z") });
    const all = st.load().findings;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ fingerprint: A932.fingerprint, severity: "P1", aliases: [A986.fingerprint], seen: 2 });
    // And from then on the alias is an exact match.
    expect(st.report([A986, A932], S("r3", "2026-09-30T12:00:00Z"))).toEqual({ added: 0, matched: 2, merged: 0 });
  });

  it("a later run's look-alike of an older sighting is never folded: it is the companion's match question", () => {
    const st = store();
    st.report([A932], S("r1", "2026-09-30T10:00:00Z"));
    const moved = { ...A932, fingerprint: "cd".repeat(32), blob: "b2", start: 950, end: 950 };
    expect(st.report([moved], S("r2", "2026-09-30T11:00:00Z"))).toEqual({ added: 1, matched: 0, merged: 0 });
    const rows = [{ ...rowAt("r2", "2026-09-30T11:00:01Z")[0]!, blob: "b2" }];
    expect(st.reconcile({ rows, tree: new Set([A932.path]), run: S("r2", "2026-09-30T11:00:02Z") })).toEqual({ fixed: 0, pending: 1, not_reproduced: 0, dismissed_unreported: 0 });
    expect(st.load().findings).toHaveLength(2);
  });
});

describe("review fixes: a collapsed finding's severity and fix judgement", () => {
  it("severity follows the sightings' latest reports, not a stale maximum", () => {
    const st = store();
    st.report([A932, A986], S("r1", "2026-09-30T10:00:00Z"));
    expect(st.load().findings[0]!.severity).toBe("P1");
    // r2: both lenses now rate it lower — the collapsed finding follows.
    st.report([{ ...A986, severity: "P3" }, { ...A932, severity: "P2" }], S("r2", "2026-09-30T11:00:00Z"));
    expect(st.load().findings[0]!.severity).toBe("P2");
  });

  it("is not fixed by one lens's re-read while the other lens that raised it never re-read the file", () => {
    const st = store();
    st.report([A932, A986], S("r1", "2026-09-30T10:00:00Z"));
    const row = (lens: string, run: string, at: string) => ({
      path: A932.path, blob: "b2", lens, tier: "t", effort: "low", validator: false, sha: `sha-${run}`, lines: 9, cost_usd: 0, run, case: "u", at,
    });
    // r2 runs pass-security alone on changed content and reports nothing.
    expect(st.reconcile({ rows: [row("pass-security", "r2", "2026-09-30T11:00:00Z")], tree: new Set([A932.path]), run: S("r2", "2026-09-30T11:00:01Z") })).toEqual({ fixed: 0, pending: 0, not_reproduced: 0, dismissed_unreported: 0 });
    expect(st.load().findings[0]!.state).toBe("new");
    // r3: both lenses re-read it and neither reports it — now it is fixed.
    const rows = [row("pass-security", "r3", "2026-09-30T12:00:00Z"), row("pass-data-safety", "r3", "2026-09-30T12:00:01Z")];
    expect(st.reconcile({ rows, tree: new Set([A932.path]), run: S("r3", "2026-09-30T12:00:02Z") })).toEqual({ fixed: 1, pending: 0, not_reproduced: 0, dismissed_unreported: 0 });
  });
});

describe("never an over-merge", () => {
  const cases: Array<[string, ReportedFinding]> = [
    ["a different kind", { ...A986, kind: "bug" }],
    ["a far-apart range", { ...A986, start: 1400, end: 1401 }],
    ["another file", { ...A986, path: "src/verdicts.ts" }],
    ["an unrelated claim", { ...A986, claim: "The pause budget resets at UTC midnight instead of the Warsaw day boundary." }],
  ];
  for (const [what, other] of cases) {
    it(`keeps ${what} apart`, () => {
      const st = store();
      st.report([A932, other], S("r1", "2026-09-30T10:00:00Z"));
      expect(st.load().findings).toHaveLength(2);
      expect(nearDuplicate(A932, other)).toBe(false);
    });
  }

  it("keeps apart one pattern in two places — the claims name different subjects (selfscan github.ts 691/706)", () => {
    const inline = reported("d1".repeat(32), { path: "src/github.ts", kind: "bug", start: 706, end: 706, claim: "Inline-comment reads silently omit every comment beyond the first 100." });
    const issue = reported("d2".repeat(32), {
      path: "src/github.ts",
      kind: "bug",
      start: 691,
      end: 691,
      claim: "Issue-comment reads silently omit comments beyond the first 100, defeating missed-webhook recovery.",
    });
    expect(nearDuplicate(inline, issue)).toBe(false);
  });

  it("never folds a fresh finding into a fixed one, or into one the pending match question holds", () => {
    const st = store();
    st.report([A932], S("r1", "2026-09-30T10:00:00Z"));
    st.reconcile({ rows: [], tree: new Set(), run: S("r2", "2026-09-30T11:00:00Z") });
    expect(st.load().findings[0]!.state).toBe("fixed");
    st.report([A986], S("r3", "2026-09-30T12:00:00Z"));
    expect(st.load().findings).toHaveLength(2);
  });
});
