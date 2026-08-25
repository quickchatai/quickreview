// The regression case set — real past human review findings a
// proposed change to the reviewer is tried against before it lands.
//
// Three things about this module are load-bearing, and each of them is a
// ratified decision rather than an implementation choice:
//
//  1. **Selection is by SUBSTANCE, not by verdict.** The obvious pool is the
//     354 human CHANGES_REQUESTED reviews, but blocking measures the REVIEWER,
//     not the finding: 82% of blocking findings carry no correctness
//     vocabulary, 231 are nothing but a question, 16 make no request at all,
//     and one reviewer is 43% of the corpus. Selecting on the GitHub verdict
//     would teach the reviewer to block on quote style. `selectCases` therefore
//     NEVER reads `state` — the field is carried through only so the report can
//     print it, and `tests/regression.test.ts` pins that by re-running the
//     selection with every verdict flipped and demanding an identical result.
//     The filter is the substance ladder (L0–L4), reproduced verbatim
//     below so the instrument can be judged rather than trusted.
//
//  2. **A failure is an INVESTIGATION, not a veto and not a bug.** The reviewer
//     legitimately differs from a human: much of what humans raise is out of
//     its remit by ratified design (style lint owns, naming preference, "as we
//     discussed"), and some human findings were argued down and merged anyway.
//     Every finding therefore carries an EXPECTATION label, `runRegression`
//     never returns a blocking verdict, and `renderInvestigation` ends in a
//     recommendation addressed to the owner with the context attached. There is
//     deliberately no score to maximize: a set that could be optimized would
//     ratchet the reviewer toward imitating one person's habits, which is not
//     the goal and never was.
//
//  3. **Dry-run is asserted HERE, in this module's own code** (rule 1). Not
//     read from `config.toml`, not inherited, not printed as prose — see
//     `src/compare.ts`'s `attestDryRun` for what that mistake looked like.
//     `runRegression` refuses to start unless the gate it was handed reports
//     dry-run, and it refuses to replay an open PR at all. Nothing in this file
//     imports the daemon, `wire.ts`, or a GitHub adapter; the replay is
//     injected, and a replay that routes through the live daemon is a posting
//     path (that is how the harness works, and it is not how this one
//     does). Pinned structurally by `tests/regression.test.ts`.
//
// Scoping rule 2 holds throughout: this reads code, review text and CI results
// off disk. It never executes reviewed code.

// ---- the substance ladder ----------------------------------------------------
//
// Verbatim from's `substance.mjs` (`export/substance.md` publishes the
// same regexes and the measured distribution). Reproduced rather than imported
// because the tracker asset is evidence, not a dependency — but it must stay
// byte-equivalent in behaviour, and any change to it changes what "substance"
// means for every case in the set.

/** A finding that carries no information without the diff in front of you. */
export const PURE_MARKER =
  /^(nit|nitpick|ditto|same|same here|as above|same as above|typo|typing|leftover\??|unused|remove|delete|why\??|what\??|how\??|\?+|👍|:\)|:\]|xd+|lgtm|ok|nice|wdyt\??|\.|,)[\s.!?:]*$/i;
/** Does the finding say WHY — a causal or consequential connective? */
export const REASON =
  /\b(because|since|so that|otherwise|as a result|which means|which will|which would|that way|this way|in order to|the (problem|issue|risk) is|hence|therefore|reason|else we|we (will|would|could) (end up|get|have|lose|break)|will (break|fail|crash|throw))\b/i;
/** Does it propose a concrete alternative — code, a name, a different shape? */
export const ALTERNATIVE =
  /```|\bwhat about\b|\binstead\b|\bsuggest\b|\brather than\b|\blet'?s\b|\bwe (can|could|should) (use|add|move|extract|make|have)\b|\bhow about\b|\bconsider\b|->|\bi would\b|\bmaybe (use|add|move|extract|make)\b/i;
/** Does it reach beyond the line — another file, another PR, docs, a trace? */
export const CONTEXT =
  /(?:^|[\s`(])((?:[\w.-]+\/)+[\w.-]+\.\w+)|https?:\/\/|\b(elsewhere|other (file|place|module)|the rest of|in \S+\.py|in \S+\.tsx?|previous pr|earlier|convention)\b/i;

/** The old `/auto-review` loop posted under a personal account and used this
 * grammar. In 1,387 PRs it fires on exactly one login in one date range and on
 * zero humans (`contamination.md`). A row it matches is the sandbox's
 * own output — scoring against it would be scoring the reviewer against itself. */
export const BOT_TAG = /^\s*\[(blocker|question|nit|check this|note)\b/i;

/** Polish appears freely in this corpus. Comparing an English lens against a
 * Polish finding measures translation, not review quality. */
export const POLISH = /[ąćęłńóśźż]|\b(nie|jest|tutaj|żeby|może|trzeba|powinno|zobacz|który|tego|takie)\b/i;

/** Findings whose evidence is not in the PR — a replay structurally cannot
 * reproduce them, so they would be permanent false misses masking real ones. */
export const OFF_PR = /\bas (we )?discussed\b|\bon the call\b|\boffline\b|\bslack\b|@[a-z0-9-]{3,}|\bscreenshot\b|\bstandup\b/i;

/** Nothing at or after this instant is human ground truth: 335 findings from
 * 2026-05-20 are the old loop's own output, and ~835 from 2026-03-01 are
 * suspected AI-assisted and cannot be separated (report §0). */
export const CONTAMINATION_CUTOFF = "2026-03-01T00:00:00Z";

export interface Substance {
  /** 0–4. */
  rung: number;
  name: string;
  contentFree: boolean;
  reason: boolean;
  alternative: boolean;
  context: boolean;
  question: boolean;
  multi: boolean;
  long: boolean;
}

export const RUNGS = ["L0 content-free", "L1 bare pointer", "L2 pointed claim", "L3 justified or proposes a fix", "L4 argued"] as const;

function multiSentence(s: string): boolean {
  return (s.replace(/```[\s\S]*?```/g, " ").match(/[.!?](\s|$)/g) ?? []).length >= 2;
}

/** @param md the markdown body (code fences and backticks intact — the shape
 *   signals live there) @param plain GitHub's `bodyText` (markdown stripped). */
export function classifySubstance(md: string, plain: string): Substance {
  const contentFree = plain.trim().length <= 20 || PURE_MARKER.test(plain.trim());
  const reason = REASON.test(md);
  const alternative = ALTERNATIVE.test(md);
  const context = CONTEXT.test(md);
  const question = /\?/.test(plain);
  const multi = multiSentence(plain);
  const long = plain.length >= 160;

  let rung: number;
  if (contentFree) rung = 0;
  else if (!reason && !alternative && !multi && plain.length < 80) rung = 1;
  else if (!reason && !alternative) rung = 2;
  else if (!(long && (reason || alternative) && (multi || /```/.test(md)))) rung = 3;
  else rung = 4;
  return { rung, name: RUNGS[rung]!, contentFree, reason, alternative, context, question, multi, long };
}

/** The substance bar for admission to the set: the finding must state a reason
 * or propose a concrete alternative. L0/L1 are remarks and L2 is a pointed
 * claim with nothing behind it — 72.5% of the corpus, and a set built out of
 * them would measure whether the reviewer likes the same lines, not whether it
 * reaches the same conclusions. */
export const QUALIFYING_RUNG = 3;

// ---- the case set ------------------------------------------------------------

/** How a miss on this finding is to be read. Assigned when the case is built
 * (by a human reading the thread — the builder script proposes, it does not
 * decide), and the reason the set cannot ratchet: two of the three labels make
 * a divergence the expected outcome. */
export type Expectation =
  /** The reviewer is supposed to reach this. A miss is worth a look. */
  | "expected-catch"
  /** Ratified design puts this outside the reviewer's remit (style lint owns,
   * naming preference, product opinion). A miss is CORRECT. */
  | "out-of-remit"
  /** The human was argued down, or the thread merged unresolved. Raising it is
   * not wrong and missing it is not wrong; recorded as context only. */
  | "expected-divergence";

export interface CaseFinding {
  path: string;
  /** End line on the head side (a multi-line thread also carries `startLine`). */
  line: number;
  startLine?: number;
  /** The reviewer's own words — thread opener only, never a reply. */
  text: string;
  /** A few lines of `diffHunk`, so the case reads without a clone. */
  hunk?: string;
  substance: Substance;
  /** Response signals. NOT selectors — recorded so a reader can weigh a miss. */
  resolved: boolean;
  gotReply: boolean;
  expectation: Expectation;
  /** Why that label. Required for anything but `expected-catch`. */
  note?: string;
}

export interface RegressionCase {
  /** Stable id: `pr-<n>-<reviewer>`. */
  id: string;
  pr: number;
  reviewer: string;
  /** The review's `submittedAt` — checked against the contamination cutoff. */
  submittedAt: string;
  /** The GitHub verdict. Carried for the REPORT only; `selectCases` must never
   * read it (see the module header). */
  state: string;
  /** MERGED / CLOSED. An OPEN PR is never replayed. */
  prState: string;
  /** The commit the findings were made against. */
  headSha: string;
  changedFiles: number;
  churn: number;
  findings: CaseFinding[];
}

export interface CaseSet {
  /** Free-text provenance: which corpus, which cutoff, who labelled. */
  provenance: string;
  builtAt: string;
  cases: RegressionCase[];
}

const EXPECTATIONS: readonly Expectation[] = ["expected-catch", "out-of-remit", "expected-divergence"];

/** Read a committed case set, refusing anything malformed. A silently-empty or
 * half-parsed set would produce a clean run out of nothing, which is the one
 * result this whole module exists to make impossible. */
export function parseCaseSet(raw: unknown): CaseSet {
  const o = raw as Partial<CaseSet>;
  if (!o || typeof o !== "object" || !Array.isArray(o.cases)) throw new Error("regression case set: no `cases` array");
  if (o.cases.length === 0) throw new Error("regression case set: empty — an empty set scores clean and means nothing");
  for (const c of o.cases) {
    if (!c.id || typeof c.pr !== "number" || !c.reviewer || !c.submittedAt) throw new Error(`regression case set: malformed case ${JSON.stringify(c.id ?? c.pr)}`);
    if (!Array.isArray(c.findings) || c.findings.length === 0) throw new Error(`regression case set: case ${c.id} has no findings`);
    for (const f of c.findings) {
      if (!f.path || typeof f.line !== "number" || !f.text) throw new Error(`regression case set: malformed finding in ${c.id}`);
      if (!EXPECTATIONS.includes(f.expectation)) throw new Error(`regression case set: unknown expectation "${f.expectation}" in ${c.id}`);
      if (!f.substance || typeof f.substance.rung !== "number") throw new Error(`regression case set: finding in ${c.id} carries no substance classification`);
    }
  }
  return { provenance: o.provenance ?? "", builtAt: o.builtAt ?? "", cases: o.cases };
}

// ---- selection ---------------------------------------------------------------

/** A review as the corpus exports it, before selection. */
export interface CandidateReview {
  pr: number;
  reviewer: string;
  submittedAt: string;
  /** Present, and deliberately unused by `selectCases`. */
  state: string;
  prState: string;
  headSha: string;
  changedFiles: number;
  churn: number;
  findings: Array<Omit<CaseFinding, "substance" | "expectation"> & { substance?: Substance; expectation?: Expectation }>;
}

export interface SelectOptions {
  /** Cases per reviewer. The stratification budget: without it the top two
   * reviewers ARE the set, and the set encodes their taste as the target. */
  perReviewerCap?: number;
  /** Total cases. The 354 CR reviews are a pool, not a target. */
  budget?: number;
  /** Minimum qualifying findings for a case to be worth replaying. */
  minFindings?: number;
  /** Reject huge PRs — nothing aligns on a 40-file diff. */
  maxChangedFiles?: number;
  maxChurn?: number;
  cutoff?: string;
}

export interface SelectionReport {
  cases: RegressionCase[];
  /** Why each rejected review was rejected, for auditing the instrument. */
  rejected: Array<{ pr: number; reviewer: string; reason: string }>;
  /** Findings per reviewer in the selected set. */
  perReviewer: Record<string, number>;
}

/** Is this finding admissible on its own merits? Verdict is not consulted. */
export function qualifyFinding(f: { text: string; plain?: string }): { ok: boolean; reason?: string; substance: Substance } {
  const plain = f.plain ?? f.text;
  const substance = classifySubstance(f.text, plain);
  if (BOT_TAG.test(f.text)) return { ok: false, reason: "machine-authored (bot grammar)", substance };
  if (POLISH.test(f.text)) return { ok: false, reason: "not English", substance };
  if (OFF_PR.test(f.text)) return { ok: false, reason: "evidence is not in the PR", substance };
  if (substance.rung < QUALIFYING_RUNG) return { ok: false, reason: `substance ${substance.name}`, substance };
  return { ok: true, substance };
}

/**
 * Pick the set. Reads substance, size, date and PR state — and NOT `state`,
 * the GitHub verdict, which is why the same pool with every verdict flipped
 * selects identically.
 */
export function selectCases(candidates: CandidateReview[], opts: SelectOptions = {}): SelectionReport {
  const perReviewerCap = opts.perReviewerCap ?? 6;
  const budget = opts.budget ?? 50;
  const minFindings = opts.minFindings ?? 2;
  const maxChangedFiles = opts.maxChangedFiles ?? 15;
  const maxChurn = opts.maxChurn ?? 600;
  const cutoff = opts.cutoff ?? CONTAMINATION_CUTOFF;

  const rejected: SelectionReport["rejected"] = [];
  const scored: Array<{ c: RegressionCase; weight: number }> = [];

  for (const r of candidates) {
    const drop = (reason: string) => rejected.push({ pr: r.pr, reviewer: r.reviewer, reason });
    if (r.prState === "OPEN") {
      drop("PR still open — never replayed");
      continue;
    }
    if (!(r.submittedAt < cutoff)) {
      drop(`at or after the contamination cutoff (${cutoff})`);
      continue;
    }
    if (r.changedFiles > maxChangedFiles || r.churn > maxChurn) {
      drop(`too large (${r.changedFiles} files / ${r.churn} lines)`);
      continue;
    }
    const kept: CaseFinding[] = [];
    for (const f of r.findings) {
      const q = qualifyFinding(f);
      if (!q.ok) continue;
      kept.push({ ...f, substance: q.substance, expectation: f.expectation ?? "expected-catch" });
    }
    if (kept.length < minFindings) {
      drop(`${kept.length} finding(s) clear the substance bar (need ${minFindings})`);
      continue;
    }
    // Rank by substance depth, never by verdict and never by finding count
    // alone — a long list of L3s is not better evidence than three L4s.
    const weight = kept.reduce((n, f) => n + f.substance.rung, 0) / kept.length;
    scored.push({
      c: {
        id: `pr-${r.pr}-${r.reviewer}`,
        pr: r.pr,
        reviewer: r.reviewer,
        submittedAt: r.submittedAt,
        state: r.state,
        prState: r.prState,
        headSha: r.headSha,
        changedFiles: r.changedFiles,
        churn: r.churn,
        findings: kept,
      },
      weight,
    });
  }

  scored.sort((a, b) => b.weight - a.weight || a.c.pr - b.c.pr);
  const perReviewer: Record<string, number> = {};
  const cases: RegressionCase[] = [];
  for (const s of scored) {
    if (cases.length >= budget) break;
    const n = perReviewer[s.c.reviewer] ?? 0;
    if (n >= perReviewerCap) {
      rejected.push({ pr: s.c.pr, reviewer: s.c.reviewer, reason: `per-reviewer cap ${perReviewerCap} reached` });
      continue;
    }
    perReviewer[s.c.reviewer] = n + 1;
    cases.push(s.c);
  }
  return { cases, rejected, perReviewer };
}

// ---- matching ----------------------------------------------------------------

/** What a replay hands back: whatever the reviewer would have said. */
export interface SandboxFinding {
  path: string;
  line?: number;
  text: string;
  /** `[blocker]` / `[question]` / `[nit]` … when the replay could read one. */
  tag?: string;
}

/** Theme words for matching. Deliberately NOT `compare.ts themeWords`: that one
 * strips backticked spans, and a human finding is often MOSTLY a backticked
 * identifier — stripping it removes the only alignable signal (
 * test-set-notes). Its STOPWORDS list also eats `add`/`use`/`make`/`need`,
 * which is most of a short human imperative. Here backticks are unwrapped and
 * only true function words are dropped. */
const FUNCTION_WORDS = new Set([
  "the","this","that","with","from","have","will","would","could","should","been","were","what","when","then","than","they","them","your","yours","here","there","which","while","about","into","just","also","only","very","much","more","most","some","such","like","does","doesn","don","not","but","and","for","are","was","you","its","it's","can","may","might","must","shall","because","since","otherwise","instead","consider","suggest","maybe","please",
]);

export function findingTheme(text: string): Set<string> {
  const unwrapped = text.replace(/`+/g, " ");
  const words = unwrapped
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w));
  return new Set(words);
}

export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  // Coverage of the SHORTER side, not Jaccard. A human finding has a median of
  // ~10 words; scoring a 5-token set against a bot's 40-token paragraph by
  // Jaccard is structurally small no matter how well they agree, which is the
  // single biggest mechanical risk to a meaningful score.
  return inter / Math.min(a.size, b.size);
}

export interface MatchOptions {
  /** Theme overlap needed on the same file. Calibrate against real pairs and
   * record what you measured — the harness's 0.2 Jaccard does not
   * carry across, it was tuned for bot-vs-bot prose. */
  threshold?: number;
  /** Lines apart still considered the same place. */
  lineWindow?: number;
}

const DEFAULT_MATCH: Required<MatchOptions> = { threshold: 0.34, lineWindow: 12 };

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

/** Did the sandbox reach this finding? Same file, then either the same place or
 * the same theme. Returns the best candidate and its score either way, so a
 * near-miss can be read rather than only counted. */
export function matchFinding(
  human: CaseFinding,
  sandbox: SandboxFinding[],
  opts: MatchOptions = {},
): { matched: boolean; best?: SandboxFinding; score: number } {
  const { threshold, lineWindow } = { ...DEFAULT_MATCH, ...opts };
  const theme = findingTheme(human.text);
  let best: SandboxFinding | undefined;
  let bestScore = 0;
  for (const s of sandbox) {
    if (baseName(s.path) !== baseName(human.path)) continue;
    const near = typeof s.line === "number" && Math.abs(s.line - human.line) <= lineWindow;
    const score = Math.max(overlap(theme, findingTheme(s.text)), near ? threshold : 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { matched: bestScore >= threshold, best, score: bestScore };
}

// ---- scoring -----------------------------------------------------------------

export type FindingOutcome =
  /** The sandbox reached an `expected-catch` finding. */
  | "reached"
  /** It did not reach an `expected-catch` finding. Worth a LOOK, not a bug. */
  | "not-reached"
  /** It correctly stayed out of something ratified as out of remit. */
  | "correctly-silent"
  /** It raised something ratified as out of remit. Note it; not a failure. */
  | "out-of-remit-raised"
  /** An expected divergence, either way. Context only. */
  | "divergence";

export interface ScoredFinding {
  finding: CaseFinding;
  outcome: FindingOutcome;
  best?: SandboxFinding;
  score: number;
}

export interface ScoredCase {
  case: RegressionCase;
  findings: ScoredFinding[];
  /** Sandbox findings that matched nothing human. NOT failures — the reviewer
   * reads things humans skipped, which is the point of having it. */
  sandboxOnly: SandboxFinding[];
  /** True when the replay produced NOTHING for a case that has findings. The
   * harness's failure mode was a vacuous PASS from an extractor that
   * matched nothing; a case that scores clean because it scored nothing is a
   * harness fault and is reported as one. */
  vacuous: boolean;
}

export function scoreCase(c: RegressionCase, sandbox: SandboxFinding[], opts: MatchOptions = {}): ScoredCase {
  const used = new Set<SandboxFinding>();
  const findings: ScoredFinding[] = c.findings.map((f) => {
    const m = matchFinding(f, sandbox, opts);
    if (m.matched && m.best) used.add(m.best);
    let outcome: FindingOutcome;
    if (f.expectation === "expected-divergence") outcome = "divergence";
    else if (f.expectation === "out-of-remit") outcome = m.matched ? "out-of-remit-raised" : "correctly-silent";
    else outcome = m.matched ? "reached" : "not-reached";
    return { finding: f, outcome, ...(m.best ? { best: m.best } : {}), score: m.score };
  });
  return {
    case: c,
    findings,
    sandboxOnly: sandbox.filter((s) => !used.has(s)),
    vacuous: sandbox.length === 0 && c.findings.length > 0,
  };
}

// ---- the run -----------------------------------------------------------------

/** The gate the replay goes through. Structural, not a config read: whatever
 * builds a replay must hand us the actual gate, and we check it ourselves. */
export interface ReplayGate {
  readonly isDryRun: boolean;
}

export interface RegressionDeps {
  /** Replay one case and return what the reviewer would say. It must build its
   * own round in a scratch root against `case.headSha`; it must NOT label a PR
   * and let the live daemon dispatch, which is a posting path. */
  replay: (c: RegressionCase) => Promise<SandboxFinding[]>;
  gate: ReplayGate;
  match?: MatchOptions;
  now?: () => Date;
  /** What is being tried, for the report header. */
  changeUnderTest?: string;
}

export class ReplayRefused extends Error {}

/**
 * The safety assertion, in this module's own code (rule 1). It reads no config
 * and trusts no printed sentence; it refuses to start on anything it cannot
 * establish. Exported so a caller can check before doing expensive setup, but
 * `runRegression` calls it regardless.
 */
export function assertReplaySafe(cases: RegressionCase[], gate: ReplayGate, cutoff = CONTAMINATION_CUTOFF): void {
  if (gate?.isDryRun !== true) {
    throw new ReplayRefused(
      "regression replay refused: the gate it was handed does not report dry-run. A replay posts real reviews to real authors otherwise, and `dry_run` is the owner's alone to change (rule 1).",
    );
  }
  const open = cases.filter((c) => c.prState === "OPEN");
  if (open.length) {
    throw new ReplayRefused(`regression replay refused: ${open.length} case(s) are still-open PRs (${open.map((c) => `#${c.pr}`).join(", ")}) — never replay one.`);
  }
  const late = cases.filter((c) => !(c.submittedAt < cutoff));
  if (late.length) {
    throw new ReplayRefused(
      `regression replay refused: ${late.length} case(s) are at or after the contamination cutoff ${cutoff} (${late.map((c) => `#${c.pr}`).join(", ")}) — those rows are the reviewer's own output, so the run would score it against itself.`,
    );
  }
}

export type Recommendation = "no-action" | "look-at-these" | "ask-owner-legacy";

export interface RegressionRun {
  cases: ScoredCase[];
  changeUnderTest: string;
  ranAt: string;
  /** Advisory, always. There is no blocking verdict in this module. */
  recommendation: Recommendation;
  /** One line saying what the recommendation means, in plain words. */
  headline: string;
  /** Share of scored `expected-catch` findings held by the loudest reviewer.
   * A high number means the run is measuring one person's taste. */
  reviewerSkew: number;
  markdown: string;
  /** Always 0. A regression run never vetoes a change — see the header. */
  exitCode: 0;
}

export async function runRegression(cases: RegressionCase[], deps: RegressionDeps): Promise<RegressionRun> {
  assertReplaySafe(cases, deps.gate);
  const scored: ScoredCase[] = [];
  for (const c of cases) scored.push(scoreCase(c, await deps.replay(c), deps.match));

  const perReviewer: Record<string, number> = {};
  let scoredCatch = 0;
  for (const sc of scored) {
    for (const f of sc.findings) {
      if (f.finding.expectation !== "expected-catch") continue;
      scoredCatch++;
      perReviewer[sc.case.reviewer] = (perReviewer[sc.case.reviewer] ?? 0) + 1;
    }
  }
  const loudest = Math.max(0, ...Object.values(perReviewer));
  const reviewerSkew = scoredCatch ? loudest / scoredCatch : 0;

  const notReached = scored.flatMap((sc) => sc.findings.filter((f) => f.outcome === "not-reached"));
  const vacuous = scored.filter((sc) => sc.vacuous);

  let recommendation: Recommendation;
  let headline: string;
  if (vacuous.length >= Math.max(1, Math.ceil(scored.length / 2))) {
    recommendation = "ask-owner-legacy";
    headline = `${vacuous.length} of ${scored.length} case(s) produced NO sandbox findings at all. Suspect the replay harness before the reviewer — a set that scores clean because it scored nothing is the failure mode this was built to avoid.`;
  } else if (notReached.length === 0) {
    recommendation = "no-action";
    headline = "Every finding the reviewer is expected to reach, it reached. Nothing here argues against the change.";
  } else {
    recommendation = "look-at-these";
    headline = `${notReached.length} finding(s) the reviewer is expected to reach went unreached. Read them and decide — this is an investigation, not a verdict on the change.`;
  }

  const run: Omit<RegressionRun, "markdown"> = {
    cases: scored,
    changeUnderTest: deps.changeUnderTest ?? "(unnamed change)",
    ranAt: (deps.now ?? (() => new Date()))().toISOString(),
    recommendation,
    headline,
    reviewerSkew,
    exitCode: 0,
  };
  return { ...run, markdown: renderInvestigation(run) };
}

// ---- the investigation -------------------------------------------------------

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** The output a human reads. It opens by saying what it is NOT, because the one
 * way this set can do harm is by being read as a pass/fail gate that the
 * reviewer is then tuned to satisfy. */
export function renderInvestigation(run: Omit<RegressionRun, "markdown">): string {
  const L: string[] = [];
  L.push("# Regression investigation — human review cases");
  L.push("");
  L.push(`Change under test: **${run.changeUnderTest}** · ${run.ranAt}`);
  L.push("");
  L.push("> **This is not a gate.** Nothing here vetoes a change and nothing here");
  L.push("> waves one through. The cases are real findings by human reviewers on");
  L.push("> closed PRs, selected for SUBSTANCE and not for the GitHub verdict; the");
  L.push("> reviewer legitimately differs from any one of those humans, and two of");
  L.push("> the three expectation labels make a divergence the expected outcome.");
  L.push("> The goal is not to imitate a reviewer. Read the unreached findings, then");
  L.push("> decide.");
  L.push("");
  L.push(`**Recommendation: \`${run.recommendation}\`.** ${run.headline}`);
  L.push("");

  const counts: Record<string, number> = {};
  for (const sc of run.cases) for (const f of sc.findings) counts[f.outcome] = (counts[f.outcome] ?? 0) + 1;
  L.push("| outcome | findings | means |");
  L.push("| --- | --- | --- |");
  L.push(`| reached | ${counts["reached"] ?? 0} | the reviewer got to an expected-catch finding |`);
  L.push(`| **not reached** | ${counts["not-reached"] ?? 0} | expected-catch, no sandbox finding aligned — **investigate** |`);
  L.push(`| correctly silent | ${counts["correctly-silent"] ?? 0} | out of remit by ratified design, and it stayed out |`);
  L.push(`| out-of-remit raised | ${counts["out-of-remit-raised"] ?? 0} | it raised something lint/taste owns — note, not a failure |`);
  L.push(`| divergence | ${counts["divergence"] ?? 0} | the human was argued down; either answer is defensible |`);
  L.push("");

  L.push(`Reviewer skew: **${(run.reviewerSkew * 100).toFixed(0)}%** of scored expected-catch findings come from one reviewer.`);
  if (run.reviewerSkew > 0.4) {
    L.push("");
    L.push("⚠ That is high enough that this run is partly measuring one person's habits. Widen the set before acting on a pattern in it.");
  }
  L.push("");

  const vacuous = run.cases.filter((c) => c.vacuous);
  if (vacuous.length) {
    L.push(`⚠ **${vacuous.length} case(s) produced no sandbox findings at all** (${vacuous.map((c) => c.case.id).join(", ")}). A case that scores clean because nothing was extracted is a harness fault, not a result — check the replay before reading anything below as a regression.`);
    L.push("");
  }

  L.push("## Findings to look at");
  L.push("");
  const toLook = run.cases.flatMap((sc) => sc.findings.filter((f) => f.outcome === "not-reached").map((f) => ({ sc, f })));
  if (toLook.length === 0) {
    L.push("None.");
  } else {
    for (const { sc, f } of toLook) {
      L.push(`### #${sc.case.pr} \`${f.finding.path}\`:${f.finding.line} — ${sc.case.reviewer}, ${sc.case.submittedAt.slice(0, 10)}`);
      L.push("");
      L.push(`Substance: **${f.finding.substance.name}** · thread ${f.finding.resolved ? "was resolved" : "went unresolved"}${f.finding.gotReply ? ", author replied" : ""} · GitHub verdict on the review was \`${sc.case.state}\` (not why it was selected).`);
      L.push("");
      L.push("> " + clip(f.finding.text, 900).split("\n").join("\n> "));
      L.push("");
      if (f.finding.hunk) {
        L.push("```diff");
        L.push(f.finding.hunk);
        L.push("```");
        L.push("");
      }
      L.push(f.best ? `Nearest sandbox finding (score ${f.score.toFixed(2)}, below threshold): "${esc(clip(f.best.text, 300))}"` : "The sandbox said nothing on this file.");
      L.push("");
      L.push("Ask: is this in the reviewer's remit at all? If it is, is the miss the change under test, or was it never reached before either? Re-label the case `out-of-remit` if the honest answer is that we do not want it raised.");
      L.push("");
    }
  }

  L.push("## Every case");
  L.push("");
  L.push("| case | reviewer | verdict (context only) | findings | reached | not reached | sandbox-only |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const sc of run.cases) {
    L.push(
      `| \`${sc.case.id}\` | ${sc.case.reviewer} | ${sc.case.state} | ${sc.findings.length} | ${sc.findings.filter((f) => f.outcome === "reached").length} | ${
        sc.findings.filter((f) => f.outcome === "not-reached").length
      } | ${sc.sandboxOnly.length} |`,
    );
  }
  L.push("");
  L.push("`sandbox-only` counts are not failures: the reviewer reads things humans skipped, and that is what it is for.");
  L.push("");
  return L.join("\n");
}
