#!/usr/bin/env node
// Build the regression case set out of the corpus export.
//
//   node scripts/build-regression-set.mjs <corpus.jsonl> [out.json]
//
// Run by hand, never by a test and never by the daemon: the corpus is a 59MB
// tracker asset that lives outside this repo, and the committed fixture
// (tests/fixtures/regression-cases.json) is the product. Re-run it only to
// rebuild the set, and re-read the expectation labels when you do — they are a
// human judgment this script only PROPOSES.
//
// The selection itself is `selectCases` out of dist/src/regression.js, so the
// fixture is built by exactly the instrument the tests use. Nothing here talks
// to GitHub, to the daemon, or to a gate: it reads one file and writes another.
//
// Extraction follows's test-set-notes:
//   - one finding = one THREAD OPENER by a non-author, non-bot login, linked to
//     its review by comments.nodes[0].pullRequestReview.id (not login+time —
//     reviewers open threads across several reviews on one PR);
//   - replies and later comments are never findings (index 0 only);
//   - `body` (markdown intact) feeds the substance instrument, `bodyText` the
//     plaintext measures;
//   - OUTDATED threads are DROPPED. They anchor to a commit that is no longer
//     head, so a replay at the review's commit cannot align them. That loses
//     real findings and is the cheap choice, said out loud.
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const [corpusPath, outPath = "tests/fixtures/regression-cases.json"] = process.argv.slice(2);
if (!corpusPath) {
  console.error("usage: build-regression-set.mjs <corpus.jsonl> [out.json]");
  process.exit(2);
}

let sel;
try {
  sel = await import(resolve("dist/src/regression.js"));
} catch {
  console.error(
    "dist/src/regression.js missing — run `npm run build` first (the fixture must be built by the same instrument the tests use).",
  );
  process.exit(2);
}

const BOTS = /\[bot\]$|^(github-actions|dependabot|codecov|sonarcloud|coderabbitai)/i;
const HUNK_LINES = 10;
const TEXT_CAP = 900;

function trimHunk(h) {
  if (!h) return undefined;
  const lines = h.split("\n");
  return lines.slice(Math.max(0, lines.length - HUNK_LINES)).join("\n");
}

const candidates = [];
const rl = createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
let prs = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  const pr = JSON.parse(line);
  prs++;
  const author = pr.author?.login ?? "";
  const threads = pr.reviewThreads?.nodes ?? [];
  for (const review of pr.reviews?.nodes ?? []) {
    const login = review.author?.login ?? "";
    if (!login || login === author || BOTS.test(login)) continue;
    const findings = [];
    for (const t of threads) {
      if (t.isOutdated) continue;
      const c0 = t.comments?.nodes?.[0];
      if (!c0 || c0.replyTo) continue;
      if (c0.pullRequestReview?.id !== review.id) continue;
      if ((c0.author?.login ?? "") !== login) continue;
      if (typeof t.line !== "number") continue;
      const nodes = t.comments?.nodes ?? [];
      findings.push({
        path: t.path,
        line: t.line,
        ...(typeof t.startLine === "number" ? { startLine: t.startLine } : {}),
        text: (c0.body ?? "").slice(0, TEXT_CAP),
        plain: (c0.bodyText ?? "").slice(0, TEXT_CAP),
        ...(trimHunk(c0.diffHunk) ? { hunk: trimHunk(c0.diffHunk) } : {}),
        resolved: !!t.isResolved,
        gotReply: nodes.slice(1).some((n) => (n.author?.login ?? "") === author),
      });
    }
    if (!findings.length) continue;
    candidates.push({
      pr: pr.number,
      reviewer: login,
      submittedAt: review.submittedAt ?? "",
      // Carried for the report only. selectCases does not read it.
      state: review.state ?? "",
      prState: pr.state ?? "",
      headSha: review.commit?.oid ?? "",
      changedFiles: pr.changedFiles ?? 0,
      churn: (pr.additions ?? 0) + (pr.deletions ?? 0),
      findings,
    });
  }
}

const report = sel.selectCases(candidates, { perReviewerCap: 3, budget: 12, minFindings: 2 });

// The expectation labels are a HUMAN judgment and they live in their own file
// so that a rebuild of the corpus extraction cannot silently wipe them. A
// finding with no label defaults to `expected-catch` and NO note, which is how
// an unreviewed label stays visibly unreviewed.
const LABELS = "tests/fixtures/regression-labels.json";
const labels = existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, "utf8")).labels : {};
let labelled = 0;
for (const c of report.cases) {
  for (const f of c.findings) {
    const l = labels[`${c.id} ${f.path}:${f.line}`];
    if (!l) continue;
    f.expectation = l.expectation;
    if (l.note) f.note = l.note;
    labelled++;
  }
}

const set = {
  provenance: `export/corpus.jsonl (${prs} PRs, ${candidates.length} human reviews with inline threads); selected by src/regression.ts selectCases on SUBSTANCE (L>=${sel.QUALIFYING_RUNG}), never on the GitHub verdict; outdated threads dropped; cutoff ${sel.CONTAMINATION_CUTOFF}. Expectation labels default to expected-catch and want a human pass.`,
  builtAt: new Date().toISOString(),
  cases: report.cases,
};
writeFileSync(outPath, `${JSON.stringify(set, null, 2)}\n`);

const bytes = Buffer.byteLength(JSON.stringify(set));
const total = report.cases.reduce((n, c) => n + c.findings.length, 0);
console.log(
  `${report.cases.length} case(s), ${total} finding(s) (${labelled} human-labelled, ${total - labelled} defaulted), ${(bytes / 1024).toFixed(0)}KB -> ${outPath}`,
);
console.log("per reviewer:", report.perReviewer);
console.log(
  `rejected ${report.rejected.length} review(s); top reasons:`,
  Object.entries(
    report.rejected.reduce(
      (m, r) => (
        (m[r.reason.replace(/\d+/g, "N")] = (m[r.reason.replace(/\d+/g, "N")] ?? 0) + 1),
        m
      ),
      {},
    ),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6),
);
