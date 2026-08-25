// qcr compare — the rubric machinery against fixtures. No GitHub, no
// dispatch: the dry-run round and every read are injected, reports land in a
// temp dir.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_MUTATION_KINDS,
  addedLineNumbers,
  attestDryRun,
  blockerParity,
  checkAnchors,
  comparePr,
  extractBlockers,
  hunkLineNumbers,
  invariantScan,
  jaccard,
  parseSettledThreads,
  readDryrunDir,
  renderIndex,
  runCompare,
  sandboxReviewFrom,
  settledThreadViolations,
  themeWords,
  type ChangedFilePatch,
  type DryrunRecord,
  type ReviewSnapshot,
} from "../src/compare.js";

const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-compare-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ---- fixtures ----------------------------------------------------------------

const PATCH = `@@ -10,6 +10,9 @@ def handler(request):
     ctx = build_context(request)
-    token = request.headers["x-token"]
+    token = request.headers.get("x-token")
+    if not token:
+        raise Unauthorized()
     return ctx
@@ -40,2 +43,3 @@ def save(rec):
     db.write(rec)
+    db.commit()`;

const patches: ChangedFilePatch[] = [{ path: "api/handler.py", patch: PATCH }];

const oldReview: ReviewSnapshot = {
  source: "old-flow",
  state: "REQUEST_CHANGES",
  body: [
    "## Blockers",
    "",
    "- `api/handler.py` unauthenticated request path — missing token validation before the context build",
    "- `api/handler.py:44` transaction commit happens outside the retry wrapper",
    "",
    "## Nits",
    "",
    "- naming could be tighter",
  ].join("\n"),
  comments: [],
};

const sandboxRecords: DryrunRecord[] = [
  { kind: "add_label", method: "POST", path: "/repos/o/r/issues/501/labels", pr: 501, note: "in progress", file: "a.json" },
  {
    kind: "create_review",
    method: "POST",
    path: "/repos/o/r/pulls/501/reviews",
    pr: 501,
    recorded_at: "2026-08-13T12:00:00Z",
    file: "b.json",
    body: {
      commit_id: "deadbeef",
      event: "REQUEST_CHANGES",
      body: ["## Blockers", "", "- `api/handler.py` unauthenticated token validation missing on the request path"].join("\n"),
      comments: [
        { path: "api/handler.py", line: 11, body: "BLOCKER: token validation missing — unauthenticated requests reach build_context" },
        { path: "api/handler.py", line: 44, body: "blocker: commit outside the retry wrapper — transaction can be lost" },
      ],
    },
  },
];

// ---- tests -------------------------------------------------------------------

describe("dry-run collection", () => {
  it("reads a dryrun dir and tolerates junk", () => {
    const dir = scratch();
    writeFileSync(join(dir, "1-add_label.json"), JSON.stringify({ kind: "add_label", method: "POST", path: "/x", pr: 1 }));
    writeFileSync(join(dir, "2-broken.json"), "{not json");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const recs = readDryrunDir(dir);
    expect(recs).toHaveLength(2);
    expect(recs[0]!.kind).toBe("add_label");
    expect(recs[1]!.kind).toBe("unparseable");
    expect(readDryrunDir(join(dir, "missing"))).toEqual([]);
  });

  it("picks the last create_review as the would-be review", () => {
    const snap = sandboxReviewFrom(sandboxRecords, 501);
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe("REQUEST_CHANGES");
    expect(snap!.comments).toHaveLength(2);
    expect(snap!.commit_id).toBe("deadbeef");
    expect(sandboxReviewFrom([sandboxRecords[0]!], 501)).toBeNull();
  });
});

describe("(a) blocker parity", () => {
  it("extracts blockers from body bullets under a Blockers heading and from marked inline comments", () => {
    expect(extractBlockers(oldReview)).toHaveLength(2);
    const sandbox = sandboxReviewFrom(sandboxRecords, 501)!;
    const f = extractBlockers(sandbox);
    expect(f.filter((x) => x.origin === "inline")).toHaveLength(2);
    expect(f.some((x) => x.origin === "body")).toBe(true);
    // the "Nits" bullet is not a blocker
    expect(extractBlockers(oldReview).some((x) => x.text.includes("naming"))).toBe(false);
  });

  it("matches old and sandbox blockers by path + theme", () => {
    const rows = blockerParity(extractBlockers(oldReview), extractBlockers(sandboxReviewFrom(sandboxRecords, 501)!));
    expect(rows.filter((r) => r.status === "missed-by-sandbox")).toHaveLength(0);
    expect(rows.filter((r) => r.status === "matched")).toHaveLength(2);
  });

  it("flags an old-flow blocker the sandbox never raised", () => {
    const sandbox: ReviewSnapshot = { source: "sandbox", state: "APPROVE", body: "Looks good.", comments: [] };
    const rows = blockerParity(extractBlockers(oldReview), extractBlockers(sandbox));
    expect(rows.every((r) => r.status === "missed-by-sandbox")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("flags sandbox-only findings separately (not a gate failure)", () => {
    const sandbox: ReviewSnapshot = {
      source: "sandbox",
      state: "REQUEST_CHANGES",
      body: "",
      comments: [{ path: "web/ui.tsx", line: 3, body: "BLOCKER: unbounded render loop in the effect dependency array" }],
    };
    const rows = blockerParity([], extractBlockers(sandbox));
    expect(rows).toEqual([expect.objectContaining({ status: "sandbox-only" })]);
  });

  it("theme words drop stopwords and short tokens; jaccard is symmetric", () => {
    expect(themeWords("The token validation is missing")).toEqual(["token", "validation", "missing"]);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], ["b"])).toBe(0);
  });
});

describe("(b) invariant scan", () => {
  it("passes a clean record set", () => {
    expect(invariantScan(sandboxRecords, 501)).toEqual([]);
  });

  it("detects a mutation kind outside the allowlist", () => {
    const v = invariantScan([...sandboxRecords, { kind: "retract_review", method: "PUT", path: "/x", pr: 501, file: "z.json" }], 501);
    expect(v).toHaveLength(1);
    expect(v[0]!.rule).toBe("mutation-kind allowlist");
    expect(v[0]!.detail).toContain("retract_review");
  });

  it("keeps the allowlist in step with the gate's kinds", () => {
    expect(ALLOWED_MUTATION_KINDS).toContain("create_review");
    expect(ALLOWED_MUTATION_KINDS).not.toContain("request_reviewer"); // retired 2026-08-18
    expect(ALLOWED_MUTATION_KINDS).toHaveLength(8);
  });

  it("flags a request_reviewer record as a retired kind, with the reason", () => {
    const req: DryrunRecord = { kind: "request_reviewer", method: "POST", path: "/x", pr: 501, file: "r.json" };
    const v = invariantScan([...sandboxRecords, req], 501);
    const retired = v.find((x) => x.rule === "retired mutation kind");
    expect(retired).toBeDefined();
    expect(retired!.detail).toContain("escalation was scrapped");
    // …and it is reported ONCE, not once per record.
    const twice = invariantScan([...sandboxRecords, req, { ...req, file: "r2.json" }], 501);
    expect(twice.filter((x) => x.rule === "retired mutation kind")).toHaveLength(1);
  });

  it("detects unsolicited scope (a record aimed at another PR)", () => {
    const v = invariantScan([...sandboxRecords, { kind: "add_label", method: "POST", path: "/x", pr: 777, file: "s.json" }], 501);
    expect(v.map((x) => x.rule)).toContain("no unsolicited scope");
  });
});

describe("(c) anchor validity", () => {
  it("computes added and hunk line numbers from a unified diff", () => {
    expect([...addedLineNumbers(PATCH)].sort((a, b) => a - b)).toEqual([11, 12, 13, 44]);
    const hunk = hunkLineNumbers(PATCH);
    expect(hunk.has(10)).toBe(true); // context line
    expect(hunk.has(11)).toBe(true); // added line
    expect(hunk.has(100)).toBe(false);
  });

  it("classifies anchors against the patch", () => {
    const checks = checkAnchors(
      [
        { path: "api/handler.py", line: 11, body: "on a changed line" },
        { path: "api/handler.py", line: 10, body: "context only" },
        { path: "api/handler.py", line: 900, body: "outside the diff" },
        { path: "other/file.py", line: 1, body: "unknown file" },
      ],
      patches,
    );
    expect(checks.map((c) => c.status)).toEqual(["on-changed-line", "context-only", "outside-diff", "unknown-file"]);
  });

  it("accepts every anchor of the fixture sandbox review", () => {
    const snap = sandboxReviewFrom(sandboxRecords, 501)!;
    expect(checkAnchors(snap.comments, patches).every((c) => c.status === "on-changed-line")).toBe(true);
  });
});

describe("(d) settled threads", () => {
  const ledger = [
    "# Ledger — PR #501",
    "",
    "| thread | state |",
    "| naming of `api/handler.py` helper — SETTLED (author explained the convention) | done |",
    "- `web/ui.tsx` memoization concern — SETTLED, benchmarked as irrelevant",
    "- `api/handler.py` token validation — OPEN",
  ].join("\n");

  it("parses SETTLED rows only", () => {
    const s = parseSettledThreads(ledger);
    expect(s).toHaveLength(2);
    expect(s[0]!.path).toBe("api/handler.py");
  });

  it("detects a re-raised settled thread", () => {
    const finding = extractBlockers({
      source: "sandbox",
      state: "REQUEST_CHANGES",
      body: "",
      comments: [{ path: "web/ui.tsx", line: 3, body: "BLOCKER: memoization concern — this component re-renders" }],
    })[0]!;
    const v = settledThreadViolations([finding], parseSettledThreads(ledger));
    expect(v).toHaveLength(1);
    expect(v[0]!.settled.text).toContain("memoization");
  });

  it("leaves an unrelated finding alone", () => {
    const finding = extractBlockers({
      source: "sandbox",
      state: "REQUEST_CHANGES",
      body: "",
      comments: [{ path: "api/handler.py", line: 11, body: "BLOCKER: token validation missing entirely" }],
    })[0]!;
    expect(settledThreadViolations([finding], parseSettledThreads(ledger))).toHaveLength(0);
  });
});

describe("report rendering", () => {
  const input = {
    pr: 501,
    oldReview,
    sandboxReview: sandboxReviewFrom(sandboxRecords, 501),
    records: sandboxRecords,
    patches,
    ledgerMd: "- `api/handler.py` naming — SETTLED",
  };

  it("renders all five rubric sections and reproduces both bodies verbatim", () => {
    const r = comparePr(input);
    expect(r.gatesPass).toBe(true);
    for (const h of ["(a) Blocker parity", "(b) Invariant scan", "(c) Anchor validity", "(d) Settled-thread discipline", "(e) Tone / format"]) {
      expect(r.markdown).toContain(h);
    }
    expect(r.markdown).toContain(oldReview.body.split("\n")[2]!);
    expect(r.markdown).toContain("src/anchors.ts");
    expect(r.markdown).toContain("**Mechanical gates (a)–(d): PASS.**");
  });

  // part A. The old report ended on the unconditional sentence
  // "dry_run stayed true — nothing was posted" with no check behind it. The
  // string must not come back, in any form, unless something observed it.
  it("never asserts dry-run it did not observe", () => {
    const r = comparePr(input); // no `dryRun` observation at all
    expect(r.dryRun.substantiated).toBe(false);
    expect(r.dryRun.status).toBe("unobserved");
    expect(r.markdown).toContain("DRY RUN NOT SUBSTANTIATED");
    expect(r.markdown).not.toContain("dry_run stayed true");
    expect(r.markdown).not.toContain("Dry run VERIFIED");
  });

  it("states the claim only on an observed dry-run gate", () => {
    const r = comparePr({ ...input, dryRun: { gateIsDryRun: true, executedMutations: 0 } });
    expect(r.dryRun.substantiated).toBe(true);
    expect(r.markdown).toContain("**Dry run VERIFIED**");
    expect(r.markdown).toContain("recorded to `state/dryrun/`");
  });

  it("shouts when the gate was live", () => {
    const r = comparePr({ ...input, dryRun: { gateIsDryRun: false, executedMutations: 0 } });
    expect(r.dryRun.status).toBe("live-gate");
    expect(r.markdown).toContain("⚠ **DRY RUN NOT SUBSTANTIATED (`live-gate`)");
    expect(r.markdown).toContain("makes **no claim**");
  });

  it("fails the gates when the sandbox misses a blocker", () => {
    const r = comparePr({ ...input, sandboxReview: { source: "sandbox", state: "APPROVE", body: "LGTM", comments: [] } });
    expect(r.gatesPass).toBe(false);
    expect(r.markdown).toContain("**MISSED**");
    expect(r.markdown).toContain("(a) Blocker parity — FAIL");
  });

  it("fails the gates on a forbidden mutation kind", () => {
    const r = comparePr({ ...input, records: [...sandboxRecords, { kind: "revoke_approval", method: "PUT", path: "/x", pr: 501, file: "q.json" }] });
    expect(r.gatesPass).toBe(false);
    expect(r.markdown).toContain("(b) Invariant scan — FAIL");
    expect(r.markdown).toContain("revoke_approval");
  });

  it("attestDryRun: a disproof beats a claim, and absence of evidence is never a pass", () => {
    const none: DryrunRecord[] = [];
    expect(attestDryRun({ gateIsDryRun: true, executedMutations: 0 }, none).status).toBe("observed-dry");
    expect(attestDryRun({ gateIsDryRun: false, executedMutations: 0 }, none).status).toBe("live-gate");
    expect(attestDryRun({ gateIsDryRun: true, executedMutations: 2 }, none).status).toBe("executed");
    expect(attestDryRun({ gateIsDryRun: null, executedMutations: null }, none).status).toBe("unobserved");
    // forceLive executes even under dry-run (rule 1's sole exception), so a
    // record carrying it disproves "nothing was posted".
    const forced = [{ kind: "supersede_own_review", method: "PUT", path: "/x", forceLive: true } as unknown as DryrunRecord];
    expect(attestDryRun({ gateIsDryRun: true, executedMutations: 0 }, forced).status).toBe("force-live");
    for (const a of [
      attestDryRun({ gateIsDryRun: false, executedMutations: 0 }, none),
      attestDryRun({ gateIsDryRun: null, executedMutations: null }, none),
      attestDryRun({ gateIsDryRun: true, executedMutations: 0 }, forced),
    ]) {
      expect(a.substantiated).toBe(false);
    }
  });

  it("index summarizes every PR and the gate verdict", () => {
    const idx = renderIndex([comparePr(input), comparePr({ ...input, pr: 502, records: [], sandboxReview: null })]);
    expect(idx).toContain("| #501 | PASS |");
    expect(idx).toContain("| #502 | **FAIL** |");
    expect(idx).toContain("1 PR(s) fail a mechanical gate: #502");
  });
});

describe("runCompare", () => {
  it("dry-runs each PR, writes a report per PR plus an index, and exits on the gates", async () => {
    const outDir = join(scratch(), "reports");
    const dispatched: number[] = [];
    const out: string[] = [];
    const run = await runCompare(
      [501, 502],
      {
        dispatchDryRun: async (pr) => void dispatched.push(pr),
        readRecords: (pr) => (pr === 501 ? sandboxRecords : []),
        fetchOldReview: async () => oldReview,
        fetchPatches: async () => patches,
        readLedger: () => "",
        outDir,
      },
      (s) => out.push(s),
    );
    expect(dispatched).toEqual([501, 502]);
    expect(run.results.map((r) => r.pr)).toEqual([501, 502]);
    expect(run.results[0]!.gatesPass).toBe(true);
    expect(run.results[1]!.gatesPass).toBe(false); // no create_review record at all
    expect(run.exitCode).toBe(1);
    expect(readFileSync(join(outDir, "501-compare.md"), "utf8")).toContain("PR #501");
    expect(readFileSync(run.indexPath, "utf8")).toContain("| #501 |");
    expect(out.join("\n")).toContain("gates PASS");
  });

  it("fails the run when the dry-run claim is DISPROVED, even with clean gates", async () => {
    const outDir = join(scratch(), "reports");
    const out: string[] = [];
    const run = await runCompare(
      [501],
      {
        dispatchDryRun: async () => {},
        readRecords: () => sandboxRecords,
        fetchOldReview: async () => oldReview,
        fetchPatches: async () => patches,
        readLedger: () => "",
        observeDryRun: () => ({ gateIsDryRun: false, executedMutations: 1 }),
        outDir,
      },
      (s) => out.push(s),
    );
    expect(run.results[0]!.gatesPass).toBe(true);
    expect(run.exitCode).toBe(1);
    expect(out.join("\n")).toContain("dry run NOT substantiated");
    expect(readFileSync(run.indexPath, "utf8")).toContain("Dry run NOT substantiated on 1 PR(s)");
  });

  it("creates the output directory when missing", async () => {
    const base = scratch();
    const outDir = join(base, "nested", "reports");
    mkdirSync(base, { recursive: true });
    const run = await runCompare(
      [7],
      {
        dispatchDryRun: async () => {},
        readRecords: () => [],
        fetchOldReview: async () => null,
        fetchPatches: async () => [],
        readLedger: () => "",
        outDir,
      },
      () => {},
    );
    expect(readFileSync(run.indexPath, "utf8")).toContain("Cutover comparison");
  });
});
