// The SCAN FINDINGS STORE (spec "Findings"): every finding
// a scan has reported, keyed by its fingerprint — file + lens + kind + a hash
// of the anchored code, whitespace-normalised (scan.ts findingFingerprint).
//
// Recognition across re-scans is two steps, and only the second
// costs judgement:
//
//   * EXACT MATCH FIRST. A finding whose fingerprint is already stored is the
//     same finding: its last sighting and wording are refreshed, and its
//     state — `new`, `promoted`, `dismissed` — is kept, so nothing is ever
//     triaged twice. (A `fixed` finding seen again has come back: it is
//     `new` again — or `dismissed` again, if that is what it was fixed from,
//     because the operator already said it is not a problem.)
//   * THE COMPANION JUDGES THE REST. After a run, `reconcile` finds the
//     stored findings the re-scan no longer reports: their file was read
//     again at other content — the content the run's tree holds (the ledger
//     says so) — and no exact match came back, or their file is gone from
//     the tree. One that no fresh finding of a lens that raised it (in its
//     unit, or of its kind) could possibly be is
//     `fixed` at once. The rest are held with those fresh candidates in ONE
//     pending MATCH QUESTION, which the companion answers whole (`match`,
//     quoting the question's key): the pairs it names are the same finding —
//     the old one keeps its state and history and takes the new wording,
//     position and fingerprint (the old fingerprint kept as an alias) — and
//     every old finding it did not pair is `fixed`. Nothing is ever fixed on
//     a guess, and nothing waits on the companion that an exact rule settles.
//   * `fixed` NEEDS CHANGED CONTENT (scan-loop). Only a re-read of OTHER
//     content can settle a finding fixed. A later reading of the SAME content
//     it was last seen at that does not report it again (a narrower stage-2
//     row, a re-run — model variance) leaves it open and stamps
//     `not_reproduced`: how many such readings, and the latest — once per
//     reading, cleared by the next sighting. Triage can still dismiss it; a
//     promoted one's ticket stays open, because only `fixed` closes one.
//   * `fixed` RECORDS WHERE. The run and sha that stopped reporting it, and
//     the state it was fixed from — what a promoted finding's ticket is
//     closed with.
//   * "MAY NOT BE VALID" IS A FLAG, NOT A STATE. A finding the validator
//     doubted is stored with its `doubt` (word and reason) and shown as such;
//     a finding no validator looked at is `validated: false`. Neither is
//     dropped.
//   * Individual findings never become memory (spec "Scan memory") — this
//     store is the PC-side record, in the state home, never shipped.
//   * TRIAGE (triage.ts drives it): a DISMISSED finding carries its
//     reason and whether its memory note was written; a PROMOTED one carries
//     its TICKET — where it was filed (the issue tracker or a markdown file)
//     and, once a re-scan found it fixed, when that ticket was closed. The
//     ticket record is what makes a finding never filed twice: it survives a
//     match (the new fingerprint inherits it), a fix and a return.
//   * NEAR-DUPLICATES COLLAPSE (scan-loop). The fingerprint hashes the lens
//     and the anchored code, so one defect raised by two lenses — or by two
//     rows of one lens anchored a few lines apart — arrives under two
//     fingerprints. A fresh finding (no exact or alias match) that is the
//     same file, the same kind, within NEAR_LINES of a live finding the SAME
//     run sighted and says the same thing (`nearDuplicate`: same subject, stemmed token
//     overlap at CLAIM_SIMILARITY) is folded into it: the stored one keeps
//     its identity, wording and triage, takes the higher severity, lists the
//     lens in `lenses`, the absorbed sighting in `merged`, and its
//     fingerprint in `aliases` — so the next run's exact match, triage by
//     fingerprint and ticket stamps all still find it. Deterministic and
//     deliberately under-merging: different kinds, far ranges, different
//     subjects, a fixed finding or one the match question holds never fold,
//     and a later run's look-alike of an older sighting is the companion's
//     match question, never a fold. `reconcile` runs the same fold once more
//     over the run's fresh findings (`collapseRun`), for a duplicate whose
//     case ran before the sighting it duplicates. A collapsed finding's
//     severity is the highest its sightings' LATEST reports give, and it is
//     unreported (fixed, or put to the match question) only once every lens
//     that raised it has re-read other content.
//
// Persistence: `<state home>/scan/findings.json`. An unreadable store is
// reported and refuses writes, like the ledger and the unit cut.
import { createHash } from "node:crypto";
import type { StateFs } from "./engine.js";
import { readings, type LedgerEntry, type Reading } from "./ledger.js";
import type { ScanSeverity } from "./scan.js";
import type { Reachability } from "../severity.js";
import { FINDINGS_FILE, FINDINGS_VERSION, parseFindingsFile } from "./scanreport.js";

export { FINDINGS_FILE, FINDINGS_VERSION };

export type FindingState = "new" | "promoted" | "dismissed" | "fixed";

export interface Sighting {
  run: string;
  sha: string;
  at: string;
}

/** Where a finding stopped being reported, and what it was before. */
export interface FixedMark extends Sighting {
  from: Exclude<FindingState, "fixed">;
}

export interface ScanFinding {
  /** sha256 hex — the identity. */
  fingerprint: string;
  unit: string;
  path: string;
  /** The file's content hash at the last sighting (absent on findings
   * stored before). */
  blob?: string | null;
  /** The anchored lines at the last sighting (1-based, inclusive). */
  start: number;
  end: number;
  lens: string;
  kind: string;
  severity: ScanSeverity;
  confidence: number | null;
  /** The lens's reachability (null: it wrote none, read as routine). Absent
   * on findings stored before the scan-loop quality pass. */
  reachability?: Reachability | null;
  /** What the lens said before the reachability cap lowered `severity`. */
  capped_from?: ScanSeverity | null;
  /** Whether `evidence` quotes the anchored code (`evidenceQuotesAnchor`) —
   * false marks a finding whose lines may not be the defect's. */
  anchor_quoted?: boolean;
  claim: string;
  evidence: string | null;
  fix: string | null;
  detail: string | null;
  state: FindingState;
  /** A validator looked at it (survived, or doubted). */
  validated: boolean;
  /** "May not be valid": the validator's doubt word and reason. */
  doubt: { word: string; reason: string } | null;
  first_seen: Sighting;
  last_seen: Sighting;
  /** Scans that reported it. */
  seen: number;
  /** Set while (and only while) the state is `fixed`. */
  fixed?: FixedMark | null;
  /** Re-reads of the unchanged content it was last seen at that did not
   * report it again — the latest, and how many since its last sighting.
   * The finding stays open; cleared when a scan reports it again. */
  not_reproduced?: NotReproduced | null;
  /** Fingerprints this finding carried before the companion matched it to
   * a moved or reworded sighting, and those of near-duplicates collapsed
   * into it — a ticket stamped with one still finds it. */
  aliases?: string[];
  /** Every lens that raised it, its own first — set once a near-duplicate
   * from another report was collapsed into it (absent: just `lens`). */
  lenses?: string[];
  /** The near-duplicate sightings collapsed into it, as last reported. */
  merged?: MergedSighting[];
  /** Its OWN fingerprint's latest severity, kept once near-duplicates
   * collapsed into it (`severity` is then the highest of this and each
   * merged sighting's) — so the aggregate is recomputed from the latest
   * reports whichever sighting reports last. */
  own_severity?: ScanSeverity;
  /** Why the operator dismissed it; kept after a later promote. */
  dismissal?: Dismissal | null;
  /** Where it was filed when promoted. */
  ticket?: FindingTicket | null;
}

export interface NotReproduced extends Sighting {
  count: number;
}

export interface MergedSighting {
  fingerprint: string;
  lens: string;
  start: number;
  end: number;
  severity: ScanSeverity;
  claim: string;
}

export interface Dismissal {
  reason: string;
  at: string;
  /** The unpinned memory note: written, or why not (a later dismiss retries). */
  memory: "written" | { problem: string };
}

export interface FindingTicket {
  /** Which sink filed it — a close goes back through the same kind. */
  sink: string;
  /** The sink's reference: `FT-NNNN`, or the markdown file's path. */
  ref: string;
  effort: string;
  filed_at: string;
  /** Set once the ticket was closed because a re-scan found it fixed. */
  closed?: { at: string; sha: string; run: string } | null;
}

/** What a scan reports — a finding before the store gives it a history. */
export type ReportedFinding = Omit<
  ScanFinding,
  "state" | "first_seen" | "last_seen" | "seen" | "fixed" | "not_reproduced" | "aliases" | "lenses" | "merged" | "own_severity" | "dismissal" | "ticket"
>;

// ---- near-duplicate collapse ----------------------------------------------------------

/** How far apart (lines between the two ranges) two sightings of one defect
 * may be anchored — selfscan stage 2 put one pair 81 lines apart. */
export const NEAR_LINES = 100;
/** The stemmed-token Jaccard two claims must reach to be one defect. */
export const CLAIM_SIMILARITY = 0.4;

const STOPWORDS = new Set(
  (
    "the a an of to in on at is are be by for and or not than rather but its it this that with from as into instead " +
    "being has have was were can could may when which while every only their them then there these those does did do"
  ).split(" "),
);

/** A claim's content tokens, in order: lower-cased words of 3+ characters,
 * stopwords out, each stemmed to its first five characters (so
 * authorization/authority, read/reads, omit/omits agree). */
function claimStems(claim: string): string[] {
  return (claim.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map((w) => w.slice(0, 5));
}

const SEVERITY_ORDER: readonly ScanSeverity[] = ["P0", "P1", "P2", "P3", "nit"];
const higher = (a: ScanSeverity, b: ScanSeverity): ScanSeverity => (SEVERITY_ORDER.indexOf(b) < SEVERITY_ORDER.indexOf(a) ? b : a);

/**
 * Are `a` and `b` the same defect reported twice? Same file, same kind,
 * ranges overlapping or at most NEAR_LINES apart, the same subject (first
 * content stem — "Inline-comment reads…" and "Issue-comment reads…" are one
 * pattern in two places, not one defect) and claims whose stemmed tokens
 * overlap at CLAIM_SIMILARITY or more. Pure; symmetric.
 */
export function nearDuplicate(
  a: Pick<ScanFinding, "path" | "kind" | "start" | "end" | "claim">,
  b: Pick<ScanFinding, "path" | "kind" | "start" | "end" | "claim">,
): boolean {
  if (a.path !== b.path || a.kind !== b.kind) return false;
  const gap = Math.max(a.start, b.start) - Math.min(a.end, b.end);
  if (gap > NEAR_LINES) return false;
  const sa = claimStems(a.claim);
  const sb = claimStems(b.claim);
  if (sa.length === 0 || sb.length === 0 || sa[0] !== sb[0]) return false;
  const A = new Set(sa);
  const B = new Set(sb);
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / (A.size + B.size - common) >= CLAIM_SIMILARITY;
}

/** A validated survivor with no doubt, of the two, clears the flag. */
function combinedDoubt(a: ReportedFinding | ScanFinding, b: ReportedFinding): ScanFinding["doubt"] {
  if ((a.validated && a.doubt === null) || (b.validated && b.doubt === null)) return null;
  return a.doubt ?? b.doubt;
}

/** Can a fresh near-duplicate fold into `f`? Only a live finding this very
 * run has sighted — a sighting in a LATER run that merely resembles an old
 * one is the companion's match question, never a silent fold —
 * and never one the pending question holds. */
function collapsible(f: ScanFinding, run: string, held: ReadonlySet<string>): boolean {
  return f.state !== "fixed" && f.last_seen.run === run && !held.has(f.fingerprint);
}

/** Fold stored finding `f` (fresh this run) into `into`, its own collapsed
 * sightings and aliases with it. */
function absorbFinding(into: ScanFinding, f: ScanFinding): ScanFinding {
  const once = absorb(into, f);
  return {
    ...once,
    lenses: [...new Set([...once.lenses!, ...(f.lenses ?? [])])],
    merged: [...once.merged!, ...(f.merged ?? []).filter((m) => !once.merged!.some((x) => x.fingerprint === m.fingerprint))],
    aliases: [...new Set([...once.aliases!, ...(f.aliases ?? [])])],
  };
}

/**
 * The end-of-run pass: a finding first seen this run, untriaged, that is a
 * near-duplicate of another finding this run sighted folds into it — what
 * report-time collapse misses when the duplicate's case ran before the
 * sighting it duplicates. Mutates `byFp`; returns how many folded.
 */
function collapseRun(byFp: Map<string, ScanFinding>, run: string, held: ReadonlySet<string>): number {
  let folded = 0;
  const all = [...byFp.values()];
  for (const f of all) {
    if (!byFp.has(f.fingerprint)) continue;
    const fresh = f.state === "new" && f.first_seen.run === run && !f.ticket && !f.dismissal && !held.has(f.fingerprint);
    if (!fresh) continue;
    const into = [...byFp.values()].find((o) => o.fingerprint !== f.fingerprint && collapsible(o, run, held) && nearDuplicate(o, f));
    if (!into) continue;
    const cur = byFp.get(f.fingerprint)!;
    byFp.delete(f.fingerprint);
    byFp.set(into.fingerprint, absorbFinding(into, cur));
    folded++;
  }
  return folded;
}

function sightingOf(r: ReportedFinding): MergedSighting {
  return { fingerprint: r.fingerprint, lens: r.lens, start: r.start, end: r.end, severity: r.severity, claim: r.claim };
}

/** The highest of a finding's own latest severity and each merged
 * sighting's latest. */
function aggregateSeverity(own: ScanSeverity, merged: readonly MergedSighting[]): ScanSeverity {
  return merged.reduce((s, m) => higher(s, m.severity), own);
}

/** Fold reported near-duplicate `r` into stored `into`. It is a sighting at
 * the content `r` read, so the content hash moves with it. */
function absorb(into: ScanFinding, r: ReportedFinding): ScanFinding {
  const lenses = [...new Set([...(into.lenses ?? [into.lens]), r.lens])];
  const merged = [...(into.merged ?? []).filter((m) => m.fingerprint !== r.fingerprint), sightingOf(r)];
  // Before anything collapsed into it, its severity IS its own; a record
  // stored before `own_severity` existed falls back to its aggregate.
  const own = into.own_severity ?? into.severity;
  return {
    ...into,
    ...(r.blob !== undefined ? { blob: r.blob } : {}),
    own_severity: own,
    severity: aggregateSeverity(own, merged),
    validated: into.validated || r.validated,
    doubt: combinedDoubt(into, r),
    lenses,
    merged,
    aliases: [...new Set([...(into.aliases ?? []), r.fingerprint])],
  };
}

/** The companion's pending sameness call: stored findings a re-scan no
 * longer reports exactly, and the fresh findings any of them might be. */
export interface MatchQuestion {
  /** Moves whenever the question does; an answer must quote it. */
  key: string;
  /** The latest run that fed the question — a finding left unpaired is
   * fixed as of this sighting. */
  run: string;
  sha: string;
  at: string;
  unreported: string[];
  fresh: string[];
}

export interface FindingsFile {
  version: number;
  findings: ScanFinding[];
  /** At most one pending match question. */
  question?: MatchQuestion | null;
}

export interface FindingsFilter {
  state?: FindingState;
  lens?: string;
  unit?: string;
  severity?: ScanSeverity;
  /** true: only "may not be valid"; false: only the rest. */
  doubted?: boolean;
}

export interface ReconcileResult {
  /** Findings fixed outright: nothing fresh could be them. */
  fixed: number;
  /** Unreported findings waiting on the companion's match. */
  pending: number;
  /** Open findings a re-read of their UNCHANGED content did not report
   * again — kept open, stamped `not_reproduced`, never fixed. */
  not_reproduced: number;
}

export interface MatchPair {
  /** A fingerprint from the question's `unreported`. */
  old: string;
  /** A fingerprint from the question's `fresh`. */
  new: string;
}

export type MatchResult =
  | { ok: true; matched: number; fixed: number; new: number }
  | { ok: false; errors: string[] };

/** The question, both sides expanded, for the companion to judge. */
export interface MatchQuestionView {
  key: string;
  run: string;
  sha: string;
  unreported: ScanFinding[];
  fresh: ScanFinding[];
}

/** Every lens that raised `f` — a collapsed finding's all of them. */
const lensesOf = (f: ScanFinding): string[] => f.lenses ?? [f.lens];

/** Do `a` and `b` share a lens that raised them? */
function shareLens(a: ScanFinding, b: ScanFinding): boolean {
  const la = lensesOf(a);
  return lensesOf(b).some((l) => la.includes(l));
}

/** Could fresh finding `n` be old finding `o`, moved or reworded? A lens in
 * common (any lens a collapsed finding holds — its silent primary lens is
 * not the only one that can report it again), and the same unit or the
 * same kind. */
function mightBe(o: ScanFinding, n: ScanFinding): boolean {
  return shareLens(o, n) && (o.unit === n.unit || o.kind === n.kind);
}

/** The state a `fixed` finding takes when a scan reports it again: dismissed
 * stays dismissed (the operator already said it is not a problem); promoted
 * stays promoted while its ticket is still open (nothing closed it
 * yet); anything else, including a promoted one whose ticket was closed, is
 * `new` again — the ticket record stays, so a re-promote never files twice. */
function returnedState(f: ScanFinding): FindingState {
  if (f.fixed?.from === "dismissed") return "dismissed";
  if (f.fixed?.from === "promoted" && f.ticket && !f.ticket.closed) return "promoted";
  return "new";
}

function fixIt(f: ScanFinding, at: Sighting): ScanFinding {
  if (f.state === "fixed") return f;
  return { ...f, state: "fixed", fixed: { run: at.run, sha: at.sha, at: at.at, from: f.state }, not_reproduced: null };
}

/** The question over `unreported` × `fresh`, or null when nothing waits. */
function questionOf(unreported: readonly string[], fresh: readonly string[], at: Sighting): MatchQuestion | null {
  if (unreported.length === 0) return null;
  const u = [...new Set(unreported)].sort();
  const f = [...new Set(fresh)].sort();
  const key = createHash("sha256").update(JSON.stringify({ u, f, run: at.run })).digest("hex").slice(0, 16);
  return { key, run: at.run, sha: at.sha, at: at.at, unreported: u, fresh: f };
}

/**
 * Settle a question's two sides against `byFp`: an old finding with no
 * fresh candidate left is fixed now; a fresh one no old finding could be
 * leaves the question (it is simply new). Mutates `byFp`; returns the
 * question that still waits and how many it fixed.
 */
function settleQuestion(
  byFp: Map<string, ScanFinding>,
  unreported: readonly string[],
  fresh: readonly string[],
  at: Sighting,
): { question: MatchQuestion | null; fixed: number } {
  const live = (fp: string): ScanFinding | null => {
    const f = byFp.get(fp);
    return f && f.state !== "fixed" ? f : null;
  };
  const olds = [...new Set(unreported)].map(live).filter((f): f is ScanFinding => f !== null);
  const oldSet = new Set(olds.map((f) => f.fingerprint));
  const news = [...new Set(fresh)]
    .map(live)
    .filter((f): f is ScanFinding => f !== null && !oldSet.has(f.fingerprint));
  let fixed = 0;
  const waiting: string[] = [];
  for (const o of olds) {
    if (news.some((n) => mightBe(o, n))) waiting.push(o.fingerprint);
    else {
      byFp.set(o.fingerprint, fixIt(o, at));
      fixed++;
    }
  }
  const held = olds.filter((o) => waiting.includes(o.fingerprint));
  const candidates = news.filter((n) => held.some((o) => mightBe(o, n))).map((n) => n.fingerprint);
  return { question: questionOf(waiting, candidates, at), fixed };
}

/**
 * The latest reading that re-read `f`'s lines at the very content it was
 * last seen at, by another run since, with EVERY lens that raised it — and
 * did not report it (a reading that did would have moved its last sighting).
 * Null when some lens has no such row. A ranged row counts only when its
 * range holds the finding's lines.
 */
function silentReread(f: ScanFinding, rows: readonly LedgerEntry[], current: string | undefined): LedgerEntry | null {
  if (f.blob == null || (current !== undefined && current !== f.blob)) return null;
  let latest: LedgerEntry | null = null;
  for (const lens of lensesOf(f)) {
    let best: LedgerEntry | null = null;
    for (const r of rows) {
      if (r.lens !== lens || r.path !== f.path || r.blob !== f.blob) continue;
      if (r.run === f.last_seen.run || r.at < f.last_seen.at) continue;
      if (r.range && (r.range.start > f.start || r.range.end < f.end)) continue;
      if (best === null || r.at > best.at) best = r;
    }
    if (best === null) return null;
    if (latest === null || best.at > latest.at) latest = best;
  }
  return latest;
}

export class FindingsStore {
  constructor(private readonly state: StateFs) {}

  private loadFile(): { file: FindingsFile; error: string | null } {
    const empty: FindingsFile = { version: FINDINGS_VERSION, findings: [], question: null };
    let text: string | null;
    try {
      text = this.state.read(FINDINGS_FILE);
    } catch (err) {
      return { file: empty, error: `${FINDINGS_FILE} in ${this.state.location} cannot be read: ${String(err)}` };
    }
    if (text === null) return { file: empty, error: null };
    try {
      return { file: parseFindingsFile(text), error: null };
    } catch (err) {
      return {
        file: empty,
        error:
          `${FINDINGS_FILE} in ${this.state.location} is not a findings store this version reads (${String(err)}) — ` +
          "nothing will overwrite it; move it aside to start over",
      };
    }
  }

  private write(findings: Iterable<ScanFinding>, question: MatchQuestion | null): void {
    const file: FindingsFile = { version: FINDINGS_VERSION, findings: [...findings], question };
    this.state.write(FINDINGS_FILE, `${JSON.stringify(file, null, 1)}\n`);
  }

  load(): { findings: ScanFinding[]; error: string | null } {
    const { file, error } = this.loadFile();
    return { findings: file.findings, error };
  }

  /**
   * Record what one case reported. Exact fingerprint match first: a known
   * finding keeps its state and first sighting; an unknown one is `new`.
   * A known finding the pending match question held as unreported has been
   * reported again, so it leaves the question. An unknown one that is a
   * near-duplicate of a stored live finding is collapsed into it
   * (`nearDuplicate`). Returns how many were new, how many matched (by
   * fingerprint or alias) and how many were collapsed. Throws when the stored file cannot be read — never
   * writes over it.
   */
  report(reported: readonly ReportedFinding[], seen: Sighting): { added: number; matched: number; merged: number } {
    const { file, error } = this.loadFile();
    if (error !== null) throw new Error(error);
    const byFp = new Map(file.findings.map((f) => [f.fingerprint, f]));
    // An absorbed near-duplicate's fingerprint names the finding it joined.
    const aliasOf = new Map<string, string>();
    for (const f of file.findings) for (const a of f.merged ?? []) aliasOf.set(a.fingerprint, f.fingerprint);
    const held = new Set(file.question?.unreported ?? []);
    let added = 0;
    let matched = 0;
    let merged = 0;
    const back = new Set<string>();
    for (const r of reported) {
      const ownFp = byFp.has(r.fingerprint) ? r.fingerprint : aliasOf.get(r.fingerprint);
      const known = ownFp === undefined ? undefined : byFp.get(ownFp);
      if (known && ownFp !== undefined) {
        // The same sighting twice (one case reporting a duplicate) counts once.
        const again = known.last_seen.run === seen.run && known.last_seen.sha === seen.sha;
        const state: FindingState = known.state === "fixed" ? returnedState(known) : known.state;
        const history = { state, fixed: null, not_reproduced: null, first_seen: known.first_seen, last_seen: seen, seen: again ? known.seen : known.seen + 1 };
        if (ownFp === r.fingerprint) {
          // A collapsed finding carries the highest severity its sightings now
          // give — its own latest and each absorbed one's latest, never a
          // stale maximum a re-scan has since lowered.
          const severity = aggregateSeverity(r.severity, known.merged ?? []);
          byFp.set(ownFp, { ...known, ...r, severity, ...(known.merged ? { own_severity: r.severity } : {}), ...history });
        } else {
          // A sighting of an absorbed near-duplicate: the finding keeps its own
          // wording and position; the alias's record and the severity move.
          byFp.set(ownFp, { ...absorb(known, r), ...history });
        }
        back.add(ownFp);
        matched++;
        continue;
      }
      const twin = [...byFp.values()].find((f) => collapsible(f, seen.run, held) && nearDuplicate(f, r));
      if (twin) {
        byFp.set(twin.fingerprint, absorb(twin, r));
        aliasOf.set(r.fingerprint, twin.fingerprint);
        merged++;
      } else {
        byFp.set(r.fingerprint, { ...r, state: "new", first_seen: seen, last_seen: seen, seen: 1 });
        added++;
      }
    }
    let question = file.question ?? null;
    if (question !== null && question.unreported.some((fp) => back.has(fp))) {
      const q = question;
      question = settleQuestion(
        byFp,
        q.unreported.filter((fp) => !back.has(fp)),
        q.fresh,
        { run: q.run, sha: q.sha, at: q.at },
      ).question;
    }
    this.write(byFp.values(), question);
    return { added, matched, merged };
  }

  /**
   * After a run: find the stored findings a re-scan no longer reports and
   * settle what an exact rule can. A finding is UNREPORTED when its file is
   * gone from the run's tree, or when the ledger's newest row for its lens
   * and file is a later run's reading of other content — so a run the
   * companion never finished is still counted by the next one. Unreported
   * findings with no possible fresh counterpart are fixed now; the rest join
   * the one pending match question, with the fresh findings (first seen by
   * the runs that re-read those files) that might be them.
   */
  reconcile(args: {
    rows: readonly LedgerEntry[];
    tree: ReadonlySet<string>;
    /** The run's tree's content hash per path: when given, only a reading
     * of THAT content settles a finding — a newer reading of other content
     * says nothing about a tree that has since gone back. */
    blobs?: ReadonlyMap<string, string>;
    run: Sighting;
  }): ReconcileResult {
    const { file, error } = this.loadFile();
    if (error !== null) throw new Error(error);
    const byFp = new Map(file.findings.map((f) => [f.fingerprint, f]));
    // Each file's newest reading per lens — only a COMPLETE one: a file read
    // in line ranges whose ranges are not all back yet has not been re-read,
    // and the findings in its unread ranges must not read as fixed.
    const newest = new Map<string, Reading>();
    for (const lens of new Set(args.rows.map((r) => r.lens))) {
      for (const [path, r] of readings(args.rows, lens)) if (r.complete) newest.set(`${lens}\0${path}`, r);
    }
    const prior = file.question ?? null;
    collapseRun(byFp, args.run.run, new Set([...(prior?.unreported ?? []), ...(prior?.fresh ?? [])]));
    const pending = new Set(prior?.unreported ?? []);
    const rereadBy = new Set<string>([args.run.run]);
    const unreported: string[] = [];
    let notReproduced = 0;
    for (const f of [...byFp.values()]) {
      if (f.state === "fixed" || pending.has(f.fingerprint)) continue;
      if (!args.tree.has(f.path)) {
        unreported.push(f.fingerprint);
        // Wherever it moved may have been read by a run the companion never
        // finished: every run of its lenses since its last sighting is one
        // whose fresh findings might be it.
        const lenses = lensesOf(f);
        for (const r of args.rows) {
          if (r.run !== f.last_seen.run && r.at >= f.last_seen.at && lenses.includes(r.lens)) rereadBy.add(r.run);
        }
        continue;
      }
      const current = args.blobs?.get(f.path);
      // A collapsed finding is unreported only when EVERY lens that raised
      // it has re-read other content since — one lens's silence is not the
      // other's, and a single-lens run must not settle what it never read.
      const readingsOf = lensesOf(f).map((l) => newest.get(`${l}\0${f.path}`));
      const reread = readingsOf.every((reading) => {
        const row = reading?.newest;
        return (
          row !== undefined &&
          row.run !== f.last_seen.run &&
          row.at >= f.last_seen.at &&
          !(f.blob != null && row.blob === f.blob) &&
          (current === undefined || row.blob === current)
        );
      });
      if (!reread) {
        // Only OTHER content can have fixed it (scan-loop): a later reading of
        // the content it was last seen at, over its lines, that did not
        // report it again is not a fix — it stays open, stamped, once per
        // reading. A dismissed one is already triaged: nothing to stamp or
        // count (the count asks for triage).
        const silent = f.state === "dismissed" ? null : silentReread(f, args.rows, current);
        if (silent !== null && !(f.not_reproduced && f.not_reproduced.at >= silent.at)) {
          byFp.set(f.fingerprint, {
            ...f,
            not_reproduced: { run: silent.run, sha: silent.sha, at: silent.at, count: (f.not_reproduced?.count ?? 0) + 1 },
          });
          notReproduced++;
        }
        continue;
      }
      unreported.push(f.fingerprint);
      // Every run of each reading re-read the file: a ranged reading finished
      // by a later run keeps the earlier run's findings as candidates.
      for (const reading of readingsOf) for (const r of reading!.runs) rereadBy.add(r);
    }
    const fresh = [...byFp.values()]
      .filter((f) => f.state !== "fixed" && rereadBy.has(f.first_seen.run))
      .map((f) => f.fingerprint);
    const at: Sighting = args.run;
    const settled = settleQuestion(byFp, [...pending, ...unreported], [...(prior?.fresh ?? []), ...fresh], at);
    // A run that changed nothing about the question leaves it as it was: its
    // key must not move under a companion that is judging it right now.
    const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
    const question =
      prior !== null && settled.question !== null && same(settled.question.unreported, prior.unreported) && same(settled.question.fresh, prior.fresh)
        ? prior
        : settled.question;
    this.write(byFp.values(), question);
    return { fixed: settled.fixed, pending: settled.question?.unreported.length ?? 0, not_reproduced: notReproduced };
  }

  /** The pending match question with both sides expanded, or null. */
  question(): { question: MatchQuestionView | null; error: string | null } {
    const { file, error } = this.loadFile();
    const q = file.question ?? null;
    if (q === null) return { question: null, error };
    const byFp = new Map(file.findings.map((f) => [f.fingerprint, f]));
    const expand = (fps: readonly string[]): ScanFinding[] => fps.map((fp) => byFp.get(fp)).filter((f): f is ScanFinding => f !== undefined);
    return { question: { key: q.key, run: q.run, sha: q.sha, unreported: expand(q.unreported), fresh: expand(q.fresh) }, error };
  }

  /**
   * The companion's answer to the pending question, whole: `pairs` are the
   * same finding (one-to-one, a lens in common); every unreported finding it does
   * not pair is fixed; every fresh one it does not pair stays new. Refused —
   * all of it — on a stale key, an unknown fingerprint, a reused one, a
   * lens mismatch, or a pair whose two sides carry different tickets.
   */
  match(args: { key?: unknown; pairs?: unknown }): MatchResult {
    const { file, error } = this.loadFile();
    if (error !== null) return { ok: false, errors: [error] };
    const q = file.question ?? null;
    if (q === null) return { ok: false, errors: ["no match question is pending — nothing to judge"] };
    if (args.key !== q.key) {
      return { ok: false, errors: [`the question moved since you read it (key ${String(args.key)}, now ${q.key}) — read it again`] };
    }
    if (args.pairs !== undefined && !Array.isArray(args.pairs)) return { ok: false, errors: ["`pairs` must be a list of {old, new}"] };
    const byFp = new Map(file.findings.map((f) => [f.fingerprint, f]));
    const pairs: MatchPair[] = [];
    const errors: string[] = [];
    const usedOld = new Set<string>();
    const usedNew = new Set<string>();
    for (const raw of (args.pairs ?? []) as unknown[]) {
      const p = raw as Partial<MatchPair> | null;
      const o = typeof p?.old === "string" ? p.old : "";
      const n = typeof p?.new === "string" ? p.new : "";
      if (!q.unreported.includes(o)) errors.push(`${JSON.stringify(o)} is not an unreported finding of this question`);
      else if (usedOld.has(o)) errors.push(`${o.slice(0, 12)} is paired twice`);
      if (!q.fresh.includes(n)) errors.push(`${JSON.stringify(n)} is not a fresh finding of this question`);
      else if (usedNew.has(n)) errors.push(`${n.slice(0, 12)} is paired twice`);
      const of = byFp.get(o);
      const nf = byFp.get(n);
      if (of && nf && !shareLens(of, nf)) errors.push(`${o.slice(0, 12)} and ${n.slice(0, 12)} are different lenses' findings`);
      // Each side's ticket is a filed work item: a pair that would keep only
      // one of two different tickets would orphan the other.
      else if (of?.ticket && nf?.ticket && of.ticket.ref !== nf.ticket.ref) {
        errors.push(`${o.slice(0, 12)} (${of.ticket.ref}) and ${n.slice(0, 12)} (${nf.ticket.ref}) both carry a ticket — settle one on its ticket before pairing them`);
      }
      usedOld.add(o);
      usedNew.add(n);
      pairs.push({ old: o, new: n });
    }
    if (errors.length > 0) return { ok: false, errors };

    const at: Sighting = { run: q.run, sha: q.sha, at: q.at };
    let matched = 0;
    for (const { old, new: nfp } of pairs) {
      const o = byFp.get(old);
      const n = byFp.get(nfp);
      if (!o || !n) continue;
      byFp.delete(old);
      // The triage travels with the finding: a matched promoted finding
      // keeps its ticket (never filed twice), a dismissed one its reason —
      // and a fresh one promoted or dismissed while the question waited
      // keeps its own when the old side has none.
      const triaged = o.ticket ? o : n.ticket ? n : o.dismissal ? o : n.dismissal ? n : o;
      byFp.set(nfp, {
        ...n,
        state: triaged.state,
        fixed: null,
        first_seen: o.first_seen,
        seen: o.seen + n.seen,
        aliases: [...new Set([...(o.aliases ?? []), old, ...(n.aliases ?? [])])],
        ...(o.lenses || n.lenses ? { lenses: [...new Set([...(o.lenses ?? [o.lens]), ...(n.lenses ?? [n.lens])])] } : {}),
        ...(o.merged || n.merged ? { merged: [...(o.merged ?? []), ...(n.merged ?? [])] } : {}),
        dismissal: o.dismissal ?? n.dismissal ?? null,
        ticket: triaged.ticket ?? null,
      });
      matched++;
    }
    let fixed = 0;
    for (const fp of q.unreported) {
      if (usedOld.has(fp)) continue;
      const f = byFp.get(fp);
      if (f && f.state !== "fixed") {
        byFp.set(fp, fixIt(f, at));
        fixed++;
      }
    }
    this.write(byFp.values(), null);
    return { ok: true, matched, fixed, new: q.fresh.filter((fp) => !usedNew.has(fp)).length };
  }

  /** The stored findings the filter keeps, most severe first, then by file. */
  list(filter: FindingsFilter = {}): { findings: ScanFinding[]; error: string | null } {
    const { findings, error } = this.load();
    const rank = (s: ScanSeverity): number => ["P0", "P1", "P2", "P3", "nit"].indexOf(s);
    const kept = findings
      .filter(
        (f) =>
          (filter.state === undefined || f.state === filter.state) &&
          (filter.lens === undefined || f.lens === filter.lens || (f.lenses ?? []).includes(filter.lens)) &&
          (filter.unit === undefined || f.unit === filter.unit) &&
          (filter.severity === undefined || f.severity === filter.severity) &&
          (filter.doubted === undefined || (f.doubt !== null) === filter.doubted),
      )
      .sort((a, b) => rank(a.severity) - rank(b.severity) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));
    return { findings: kept, error };
  }

  // -- triage (the rules are triage.ts's, the record is here) --

  /**
   * The one stored finding `ref` names: a full fingerprint, an alias (a
   * fingerprint it carried before a match), or an unambiguous prefix of at
   * least 12 hex characters — what `scan_findings` shows.
   */
  find(ref: string): { ok: true; finding: ScanFinding } | { ok: false; errors: string[] } {
    const { findings, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    const want = ref.trim().toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(want)) return { ok: false, errors: [`${JSON.stringify(ref)} is not a fingerprint (12+ hex characters)`] };
    const exact = findings.find((f) => f.fingerprint === want || (f.aliases ?? []).includes(want));
    if (exact) return { ok: true, finding: exact };
    const hits = findings.filter((f) => f.fingerprint.startsWith(want) || (f.aliases ?? []).some((a) => a.startsWith(want)));
    if (hits.length === 1) return { ok: true, finding: hits[0]! };
    return {
      ok: false,
      errors: [hits.length === 0 ? `no stored finding has fingerprint ${want}` : `${want} matches ${hits.length} findings — give more of the fingerprint`],
    };
  }

  /**
   * Rewrite ONE finding, by its current fingerprint, under a fresh load —
   * refused (nothing written) when the store cannot be read or the finding
   * is gone (a match renamed it since the caller looked). `change` returns
   * the new record, or an error string to refuse.
   */
  update(
    fingerprint: string,
    change: (f: ScanFinding) => ScanFinding | string,
  ): { ok: true; finding: ScanFinding } | { ok: false; errors: string[] } {
    const { file, error } = this.loadFile();
    if (error !== null) return { ok: false, errors: [error] };
    const i = file.findings.findIndex((f) => f.fingerprint === fingerprint);
    if (i < 0) return { ok: false, errors: [`finding ${fingerprint.slice(0, 12)} is no longer stored under that fingerprint — list the findings again`] };
    const next = change(file.findings[i]!);
    if (typeof next === "string") return { ok: false, errors: [next] };
    file.findings[i] = next;
    this.write(file.findings, file.question ?? null);
    return { ok: true, finding: next };
  }
}
