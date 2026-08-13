// `qcr compare <pr...>` — the five-PR comparison harness.
//
// For each PR: run one dry-run round, collect the would-be review out of
// state/dryrun/, fetch the old flow's actual review from GitHub (reads only),
// and assemble a side-by-side report per the rubric:
//
//   (a) blocker parity      old-flow blockers vs sandbox blockers, matched by
//                           path + theme; every unmatched row flagged
//   (b) invariant scan      zero dry-run records of any kind outside the known
//                           allowlist; escalation redundancy honored
//   (c) anchor validity     every sandbox inline anchor lands on a changed line
//   (d) settled threads     no finding re-raises a thread the archived ledger
//                           lists as SETTLED
//   (e) tone / format       NOT judged here — both summaries are reproduced
//                           verbatim for the human
//
// The harness only assembles evidence. (a)–(d) are mechanical gates; the flip
// decision, and the flip itself, stay human. Nothing here mutates anything:
// the dry-run round is injected, GitHub access is read-only through the
// adapter, and the output is markdown on disk.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkAnchor, runsByPath } from "./anchors.js";
import type { MutationKind } from "./gate.js";

// ---- shapes ------------------------------------------------------------------

export interface ReviewComment {
  path: string;
  /** Line on the head side of the diff the comment anchors to. */
  line: number;
  body: string;
}

export interface ReviewSnapshot {
  source: "old-flow" | "sandbox";
  /** APPROVE / REQUEST_CHANGES / COMMENT / ESCALATE. */
  state: string;
  body: string;
  comments: ReviewComment[];
  commit_id?: string;
  submitted_at?: string;
}

/** One state/dryrun/*.json record (the gate's serialized MutationIntent). */
export interface DryrunRecord {
  kind: string;
  method: string;
  path: string;
  body?: unknown;
  note?: string;
  pr?: number;
  recorded_at?: string;
  /** Source file, for the report. */
  file?: string;
}

export interface ChangedFilePatch {
  path: string;
  /** Unified diff for the file, as GitHub's `files` endpoint returns it. */
  patch: string;
}

export interface Finding {
  path: string;
  text: string;
  /** Significant words, for theme matching. */
  theme: string[];
  origin: "body" | "inline";
  line?: number;
}

// ---- the known mutation-kind allowlist ---------------------------------------

/** Every mutation kind the sandbox is allowed to intend. The invariant scan is
 * an allowlist check, not a keyword hunt: any record whose kind is not on this
 * list is a violation by construction — which is exactly how the structural
 * review invariants are enforced: no kind outside this set exists in gate.ts,
 * so a record carrying one could only come from code that must not exist. */
export const ALLOWED_MUTATION_KINDS = [
  "add_label",
  "remove_label",
  "delete_team_review_request",
  "request_reviewer",
  "create_review",
  "create_review_comment_reply",
  "create_issue",
  "create_pull",
  "push_branch",
] as const satisfies readonly MutationKind[];

const ALLOWED = new Set<string>(ALLOWED_MUTATION_KINDS);

// ---- dry-run collection ------------------------------------------------------

/** Read state/dryrun/ into records (newest last). Tolerates junk files. */
export function readDryrunDir(dir: string): DryrunRecord[] {
  if (!existsSync(dir)) return [];
  const out: DryrunRecord[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, file), "utf8")) as DryrunRecord;
      out.push({ ...rec, file });
    } catch {
      out.push({ kind: "unparseable", method: "?", path: "?", note: `could not parse ${file}`, file });
    }
  }
  return out;
}

/** The would-be review for a PR: the last create_review record it produced. */
export function sandboxReviewFrom(records: DryrunRecord[], pr: number): ReviewSnapshot | null {
  const reviews = records.filter((r) => r.kind === "create_review" && (r.pr === pr || r.path.includes(`/pulls/${pr}/`)));
  const last = reviews[reviews.length - 1];
  if (!last) return null;
  const body = (last.body ?? {}) as {
    event?: string;
    body?: string;
    commit_id?: string;
    comments?: Array<{ path?: string; line?: number; position?: number; body?: string }>;
  };
  return {
    source: "sandbox",
    state: body.event ?? "COMMENT",
    body: body.body ?? "",
    commit_id: body.commit_id,
    submitted_at: last.recorded_at,
    comments: (body.comments ?? []).map((c) => ({
      path: c.path ?? "",
      line: c.line ?? c.position ?? 0,
      body: c.body ?? "",
    })),
  };
}

// ---- (a) blocker parity ------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "this", "that", "these", "those", "is", "are", "was", "were",
  "be", "been", "being", "to", "of", "in", "on", "at", "for", "with", "without", "from", "by", "as", "it", "its",
  "we", "you", "your", "should", "would", "could", "will", "can", "may", "must", "not", "no", "here", "there",
  "blocker", "blocking", "issue", "problem", "please", "line", "lines", "code", "file", "when", "which", "what",
  "add", "adds", "added", "use", "uses", "used", "using", "make", "makes", "need", "needs", "needed",
]);

const BLOCKER_MARKERS = /(^|[^a-z])(blockers?|blocking|must[- ]fix|severity:\s*blocker|critical)([^a-z]|$)/i;
const PATH_RE = /(?:^|[\s`(])((?:[\w.-]+\/)+[\w.-]+\.[\w]+)(?::(\d+))?/;

export function themeWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/`[^`]*`/g, " ")
        .replace(/[^a-z0-9_]+/g, " ")
        .split(" ")
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
    ),
  ];
}

function pathFrom(text: string): { path: string; line?: number } {
  const m = PATH_RE.exec(text);
  if (!m || !m[1]) return { path: "" };
  return m[2] ? { path: m[1], line: Number(m[2]) } : { path: m[1] };
}

/** Pull the blocker-grade findings out of a review: every inline comment that
 * carries a blocker marker, plus body bullets that do. Deliberately generous —
 * an over-collected row shows up as an unmatched flag for the human, which is
 * the safe direction. */
export function extractBlockers(review: ReviewSnapshot): Finding[] {
  const found: Finding[] = [];
  for (const c of review.comments) {
    if (!BLOCKER_MARKERS.test(c.body)) continue;
    found.push({ path: c.path, line: c.line, text: c.body.trim().split("\n")[0]!.slice(0, 200), theme: themeWords(c.body), origin: "inline" });
  }
  let underBlockerHeading = false;
  for (const rawLine of review.body.split("\n")) {
    const line = rawLine.trim();
    if (/^#{1,6}\s/.test(line)) {
      underBlockerHeading = BLOCKER_MARKERS.test(line);
      continue;
    }
    const isBullet = /^([-*]|\d+\.)\s+/.test(line);
    if (!isBullet) continue;
    if (!underBlockerHeading && !BLOCKER_MARKERS.test(line)) continue;
    const text = line.replace(/^([-*]|\d+\.)\s+/, "");
    const { path, line: ln } = pathFrom(text);
    found.push({ path, ...(ln !== undefined ? { line: ln } : {}), text: text.slice(0, 200), theme: themeWords(text), origin: "body" });
  }
  return found;
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const inter = a.filter((w) => setB.has(w)).length;
  return inter / (new Set([...a, ...b]).size);
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const base = (p: string) => p.split("/").pop() ?? p;
  return base(a) === base(b);
}

export interface ParityRow {
  old?: Finding;
  sandbox?: Finding;
  score: number;
  status: "matched" | "missed-by-sandbox" | "sandbox-only";
}

/** Match old-flow blockers to sandbox blockers by path + theme overlap. */
export function blockerParity(oldFindings: Finding[], sandboxFindings: Finding[], threshold = 0.2): ParityRow[] {
  const rows: ParityRow[] = [];
  const takenSandbox = new Set<number>();
  for (const o of oldFindings) {
    let bestIdx = -1;
    let bestScore = 0;
    sandboxFindings.forEach((s, i) => {
      if (takenSandbox.has(i)) return;
      if (o.path && s.path && !samePath(o.path, s.path)) return;
      const score = jaccard(o.theme, s.theme);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0 && bestScore >= threshold) {
      takenSandbox.add(bestIdx);
      rows.push({ old: o, sandbox: sandboxFindings[bestIdx]!, score: bestScore, status: "matched" });
    } else {
      rows.push({ old: o, score: bestScore, status: "missed-by-sandbox" });
    }
  }
  sandboxFindings.forEach((s, i) => {
    if (!takenSandbox.has(i)) rows.push({ sandbox: s, score: 0, status: "sandbox-only" });
  });
  return rows;
}

// ---- (b) invariant scan ------------------------------------------------------

export interface InvariantViolation {
  rule: string;
  detail: string;
}

/** Mechanical invariant gate over one PR's dry-run records. */
export function invariantScan(records: DryrunRecord[], pr: number): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const r of records) {
    if (!ALLOWED.has(r.kind)) {
      violations.push({ rule: "mutation-kind allowlist", detail: `record ${r.file ?? "?"} carries kind "${r.kind}" — outside the known set` });
    }
    if (r.pr !== undefined && r.pr !== pr) {
      violations.push({ rule: "no unsolicited scope", detail: `record ${r.file ?? "?"} (${r.kind}) targets #${r.pr}, not the PR under comparison (#${pr})` });
    }
  }
  const escalations = records.filter((r) => r.kind === "request_reviewer");
  if (escalations.length > 1) {
    violations.push({ rule: "escalation redundancy", detail: `${escalations.length} request_reviewer records for #${pr} — one escalation per round at most` });
  }
  if (escalations.length === 1 && !records.some((r) => r.kind === "create_review")) {
    violations.push({ rule: "escalation after a clean AI review", detail: `#${pr} escalated without a create_review record in the same run` });
  }
  return violations;
}

// ---- (c) anchor validity -----------------------------------------------------
//
// The verdict comes from src/anchors.ts (B4) — the same changed-run containment
// check the posting path uses, so the report cannot disagree with what the
// daemon would have accepted. The two local diff walkers below are kept only to
// classify a *failed* anchor for the human (context line inside a hunk vs
// nowhere near the diff), which anchors.ts does not distinguish.

/** New-side line numbers of `+` lines in a unified diff. */
export function addedLineNumbers(patch: string): Set<number> {
  const added = new Set<number>();
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      added.add(newLine);
      newLine++;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // removed / "no newline" — no new-side line consumed
    } else if (newLine > 0) {
      newLine++;
    }
  }
  return added;
}

/** Every new-side line number covered by a hunk (added + context). */
export function hunkLineNumbers(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("-") || line.startsWith("\\")) continue;
    if (newLine > 0) {
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

export interface AnchorCheck {
  path: string;
  line: number;
  status: "on-changed-line" | "context-only" | "outside-diff" | "unknown-file";
}

/** Provenance line for the report: which module judged the anchors. */
export const ANCHOR_SOURCE = "src/anchors.ts (changed-run containment, RIGHT side)";

export function checkAnchors(comments: ReviewComment[], patches: ChangedFilePatch[]): AnchorCheck[] {
  const byPath = new Map(patches.map((p) => [p.path, p.patch]));
  const runs = runsByPath(Object.fromEntries(patches.map((p) => [p.path, p.patch])));
  return comments.map((c) => {
    const patch = byPath.get(c.path);
    if (patch === undefined) return { path: c.path, line: c.line, status: "unknown-file" as const };
    const verdict = checkAnchor(runs, { path: c.path, side: "RIGHT", line: c.line });
    if (verdict.ok) return { path: c.path, line: c.line, status: "on-changed-line" as const };
    if (hunkLineNumbers(patch).has(c.line)) return { path: c.path, line: c.line, status: "context-only" as const };
    return { path: c.path, line: c.line, status: "outside-diff" as const };
  });
}

// ---- (d) settled threads -----------------------------------------------------

export interface SettledEntry {
  path: string;
  text: string;
  theme: string[];
}

/** Parse SETTLED rows out of an archived ledger (`archive/pr-<n>/ledger.md`).
 * A row is any line that carries the SETTLED marker. */
export function parseSettledThreads(ledgerMd: string): SettledEntry[] {
  const out: SettledEntry[] = [];
  for (const raw of ledgerMd.split("\n")) {
    const line = raw.trim();
    if (!/\bSETTLED\b/.test(line)) continue;
    const text = line.replace(/^[-*|]\s*/, "").replace(/\|/g, " ").trim();
    out.push({ path: pathFrom(text).path, text: text.slice(0, 200), theme: themeWords(text.replace(/\bSETTLED\b/g, " ")) });
  }
  return out;
}

export interface SettledViolation {
  settled: SettledEntry;
  finding: Finding;
  score: number;
}

/** Any sandbox finding that re-raises a SETTLED thread. */
export function settledThreadViolations(findings: Finding[], settled: SettledEntry[], threshold = 0.25): SettledViolation[] {
  const out: SettledViolation[] = [];
  for (const f of findings) {
    for (const s of settled) {
      if (s.path && f.path && !samePath(s.path, f.path)) continue;
      const score = jaccard(f.theme, s.theme);
      if (score >= threshold) out.push({ settled: s, finding: f, score });
    }
  }
  return out;
}

// ---- report ------------------------------------------------------------------

export interface ComparePrInput {
  pr: number;
  oldReview: ReviewSnapshot | null;
  sandboxReview: ReviewSnapshot | null;
  records: DryrunRecord[];
  patches: ChangedFilePatch[];
  ledgerMd: string;
}

export interface CompareResult {
  pr: number;
  parity: ParityRow[];
  violations: InvariantViolation[];
  anchors: AnchorCheck[];
  settled: SettledViolation[];
  /** (a)–(d) clean. (e), tone, is the human's. */
  gatesPass: boolean;
  markdown: string;
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

export function comparePr(input: ComparePrInput): CompareResult {
  const oldFindings = input.oldReview ? extractBlockers(input.oldReview) : [];
  const sandboxFindings = input.sandboxReview ? extractBlockers(input.sandboxReview) : [];
  const parity = blockerParity(oldFindings, sandboxFindings);
  const violations = invariantScan(input.records, input.pr);
  const anchors = checkAnchors(input.sandboxReview?.comments ?? [], input.patches);
  const settled = settledThreadViolations(sandboxFindings, parseSettledThreads(input.ledgerMd));

  const missed = parity.filter((r) => r.status === "missed-by-sandbox");
  const badAnchors = anchors.filter((a) => a.status !== "on-changed-line");
  const gatesPass = missed.length === 0 && violations.length === 0 && badAnchors.length === 0 && settled.length === 0 && input.sandboxReview !== null;

  const L: string[] = [];
  L.push(`# PR #${input.pr} — old flow vs sandbox (dry run)`);
  L.push("");
  L.push(`Generated by \`qcr compare\`. Gates (a)–(d) are mechanical; (e) tone/format is yours.`);
  L.push(`Anchor verdicts from ${ANCHOR_SOURCE}.`);
  L.push("");
  L.push(`| verdict | old flow | sandbox (dry run) |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| state | ${input.oldReview?.state ?? "—"} | ${input.sandboxReview?.state ?? "— (no create_review record)"} |`);
  L.push(`| inline comments | ${input.oldReview?.comments.length ?? 0} | ${input.sandboxReview?.comments.length ?? 0} |`);
  L.push(`| blockers | ${oldFindings.length} | ${sandboxFindings.length} |`);
  L.push("");

  L.push(`## (a) Blocker parity ${missed.length === 0 ? "— PASS" : `— FAIL (${missed.length} missed)`}`);
  L.push("");
  if (parity.length === 0) {
    L.push("No blockers on either side.");
  } else {
    L.push("| status | old flow | sandbox | score |");
    L.push("| --- | --- | --- | --- |");
    for (const r of parity) {
      const flag = r.status === "matched" ? "matched" : r.status === "missed-by-sandbox" ? "**MISSED**" : "sandbox-only";
      L.push(
        `| ${flag} | ${r.old ? `\`${r.old.path || "—"}\` ${esc(r.old.text)}` : "—"} | ${
          r.sandbox ? `\`${r.sandbox.path || "—"}\` ${esc(r.sandbox.text)}` : "—"
        } | ${r.score.toFixed(2)} |`,
      );
    }
    L.push("");
    L.push("`sandbox-only` rows are not failures — judge whether each is a real finding or noise.");
  }
  L.push("");

  L.push(`## (b) Invariant scan ${violations.length === 0 ? "— PASS" : `— FAIL (${violations.length})`}`);
  L.push("");
  L.push(`${input.records.length} dry-run record(s); kinds: ${[...new Set(input.records.map((r) => r.kind))].join(", ") || "none"}.`);
  L.push(`Allowlist: ${ALLOWED_MUTATION_KINDS.join(", ")}.`);
  if (violations.length) {
    L.push("");
    for (const v of violations) L.push(`- **${v.rule}** — ${v.detail}`);
  }
  L.push("");

  L.push(`## (c) Anchor validity ${badAnchors.length === 0 ? "— PASS" : `— FAIL (${badAnchors.length})`}`);
  L.push("");
  if (anchors.length === 0) {
    L.push("No inline anchors.");
  } else {
    L.push("| file | line | status |");
    L.push("| --- | --- | --- |");
    for (const a of anchors) L.push(`| \`${a.path}\` | ${a.line} | ${a.status === "on-changed-line" ? "ok" : `**${a.status}**`} |`);
  }
  L.push("");

  L.push(`## (d) Settled-thread discipline ${settled.length === 0 ? "— PASS" : `— FAIL (${settled.length})`}`);
  L.push("");
  if (settled.length === 0) {
    L.push("No sandbox finding re-raises a SETTLED thread.");
  } else {
    for (const s of settled) L.push(`- re-raised (score ${s.score.toFixed(2)}): sandbox "${esc(s.finding.text)}" vs SETTLED "${esc(s.settled.text)}"`);
  }
  L.push("");

  L.push("## (e) Tone / format — human judgment");
  L.push("");
  L.push("### Old-flow review body (verbatim)");
  L.push("");
  L.push("```markdown");
  L.push(input.oldReview?.body ?? "(none)");
  L.push("```");
  L.push("");
  L.push("### Sandbox review body (verbatim, would-be)");
  L.push("");
  L.push("```markdown");
  L.push(input.sandboxReview?.body ?? "(none)");
  L.push("```");
  L.push("");
  L.push(`---`);
  L.push("");
  L.push(`**Mechanical gates (a)–(d): ${gatesPass ? "PASS" : "FAIL"}.** dry_run stayed true — nothing was posted.`);
  L.push("");

  return { pr: input.pr, parity, violations, anchors, settled, gatesPass, markdown: L.join("\n") };
}

// ---- the run -----------------------------------------------------------------

export interface CompareDeps {
  /** Run one dry-run round against the PR's head. Injected: B2's dispatch. */
  dispatchDryRun: (pr: number) => Promise<void>;
  /** Dry-run records produced for this PR (default: read state/dryrun/). */
  readRecords: (pr: number) => Promise<DryrunRecord[]> | DryrunRecord[];
  /** The old flow's posted review — adapter reads only (listReviews + bodies +
   * inline comments). Null when the PR has none. */
  fetchOldReview: (pr: number) => Promise<ReviewSnapshot | null>;
  /** Changed files with patches, for anchor validation. */
  fetchPatches: (pr: number) => Promise<ChangedFilePatch[]>;
  /** Archived ledger markdown for the PR ("" when there is none). */
  readLedger: (pr: number) => Promise<string> | string;
  outDir: string;
}

export interface CompareRun {
  results: CompareResult[];
  reportPaths: string[];
  indexPath: string;
  exitCode: number;
}

export function renderIndex(results: CompareResult[]): string {
  const L: string[] = [];
  L.push("# Cutover comparison — index");
  L.push("");
  L.push("rubric: (a) blocker parity, (b) invariant scan, (c) anchor validity,");
  L.push("(d) settled-thread discipline are hard gates; (e) tone/format is judgment.");
  L.push("Pass = (a)–(d) clean on all five PRs. The flip itself stays manual.");
  L.push("");
  L.push("| PR | gates (a)–(d) | missed blockers | invariant violations | bad anchors | re-raised threads | report |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    L.push(
      `| #${r.pr} | ${r.gatesPass ? "PASS" : "**FAIL**"} | ${r.parity.filter((p) => p.status === "missed-by-sandbox").length} | ${
        r.violations.length
      } | ${r.anchors.filter((a) => a.status !== "on-changed-line").length} | ${r.settled.length} | [\`${r.pr}-compare.md\`](./${r.pr}-compare.md) |`,
    );
  }
  L.push("");
  const failing = results.filter((r) => !r.gatesPass);
  L.push(failing.length === 0 ? `All ${results.length} PR(s) clean on the mechanical gates.` : `${failing.length} PR(s) fail a mechanical gate: ${failing.map((r) => `#${r.pr}`).join(", ")}.`);
  L.push("");
  return L.join("\n");
}

/** The `qcr compare <pr...>` entrypoint. */
export async function runCompare(prs: number[], deps: CompareDeps, print: (s: string) => void = console.log): Promise<CompareRun> {
  const results: CompareResult[] = [];
  const reportPaths: string[] = [];
  mkdirSync(deps.outDir, { recursive: true });

  for (const pr of prs) {
    await deps.dispatchDryRun(pr);
    const [records, oldReview, patches, ledgerMd] = [
      await deps.readRecords(pr),
      await deps.fetchOldReview(pr),
      await deps.fetchPatches(pr),
      await deps.readLedger(pr),
    ];
    const result = comparePr({ pr, oldReview, sandboxReview: sandboxReviewFrom(records, pr), records, patches, ledgerMd });
    const file = join(deps.outDir, `${pr}-compare.md`);
    writeFileSync(file, result.markdown);
    reportPaths.push(file);
    results.push(result);
    print(`#${pr}: gates ${result.gatesPass ? "PASS" : "FAIL"} -> ${file}`);
  }

  const indexPath = join(deps.outDir, "index.md");
  writeFileSync(indexPath, renderIndex(results));
  print(`index -> ${indexPath}`);
  return { results, reportPaths, indexPath, exitCode: results.every((r) => r.gatesPass) ? 0 : 1 };
}
