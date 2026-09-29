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
//     again at other content (the ledger says so) and no exact match came
//     back, or their file is gone from the tree. One that no fresh finding of
//     the same lens (in its unit, or of its kind) could possibly be is
//     `fixed` at once. The rest are held with those fresh candidates in ONE
//     pending MATCH QUESTION, which the companion answers whole (`match`,
//     quoting the question's key): the pairs it names are the same finding —
//     the old one keeps its state and history and takes the new wording,
//     position and fingerprint (the old fingerprint kept as an alias) — and
//     every old finding it did not pair is `fixed`. Nothing is ever fixed on
//     a guess, and nothing waits on the companion that an exact rule settles.
//   * `fixed` RECORDS WHERE. The run and sha that stopped reporting it, and
//     the state it was fixed from — what a promoted finding's ticket is
//     closed with.
//   * "MAY NOT BE VALID" IS A FLAG, NOT A STATE. A finding the validator
//     doubted is stored with its `doubt` (word and reason) and shown as such;
//     a finding no validator looked at is `validated: false`. Neither is
//     dropped.
//   * Individual findings never become memory (spec "Scan memory") — this
//     store is the PC-side record, in the state home, never shipped.
//
// Persistence: `<state home>/scan/findings.json`. An unreadable store is
// reported and refuses writes, like the ledger and the unit cut.
import { createHash } from "node:crypto";
import type { StateFs } from "./engine.js";
import type { LedgerEntry } from "./ledger.js";
import type { ScanSeverity } from "./scan.js";

export const FINDINGS_FILE = "scan/findings.json";
export const FINDINGS_VERSION = 1;

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
  /** Fingerprints this finding carried before the companion matched it to
   * a moved or reworded sighting — a ticket stamped with one still finds it. */
  aliases?: string[];
}

/** What a scan reports — a finding before the store gives it a history. */
export type ReportedFinding = Omit<ScanFinding, "state" | "first_seen" | "last_seen" | "seen" | "fixed" | "aliases">;

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

/** Could fresh finding `n` be old finding `o`, moved or reworded? Same lens,
 * and the same unit or the same kind. */
function mightBe(o: ScanFinding, n: ScanFinding): boolean {
  return o.lens === n.lens && (o.unit === n.unit || o.kind === n.kind);
}

function fixIt(f: ScanFinding, at: Sighting): ScanFinding {
  if (f.state === "fixed") return f;
  return { ...f, state: "fixed", fixed: { run: at.run, sha: at.sha, at: at.at, from: f.state } };
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
      const raw = JSON.parse(text) as Partial<FindingsFile> | null;
      if (typeof raw !== "object" || raw === null || raw.version !== FINDINGS_VERSION || !Array.isArray(raw.findings)) {
        throw new Error("not a version-1 findings store");
      }
      for (const f of raw.findings) {
        if (typeof f?.fingerprint !== "string" || typeof f.path !== "string" || typeof f.state !== "string") {
          throw new Error("a finding has no fingerprint, path or state");
        }
      }
      const q = raw.question ?? null;
      if (q !== null && (typeof q.key !== "string" || !Array.isArray(q.unreported) || !Array.isArray(q.fresh))) {
        throw new Error("the pending match question is malformed");
      }
      return { file: { version: FINDINGS_VERSION, findings: raw.findings, question: q }, error: null };
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
   * reported again, so it leaves the question. Returns how many were new and
   * how many matched. Throws when the stored file cannot be read — never
   * writes over it.
   */
  report(reported: readonly ReportedFinding[], seen: Sighting): { added: number; matched: number } {
    const { file, error } = this.loadFile();
    if (error !== null) throw new Error(error);
    const byFp = new Map(file.findings.map((f) => [f.fingerprint, f]));
    let added = 0;
    let matched = 0;
    const back = new Set<string>();
    for (const r of reported) {
      const known = byFp.get(r.fingerprint);
      if (known) {
        // The same sighting twice (one case reporting a duplicate) counts once.
        const again = known.last_seen.run === seen.run && known.last_seen.sha === seen.sha;
        const state: FindingState = known.state === "fixed" ? (known.fixed?.from === "dismissed" ? "dismissed" : "new") : known.state;
        byFp.set(r.fingerprint, {
          ...known,
          ...r,
          state,
          fixed: null,
          first_seen: known.first_seen,
          last_seen: seen,
          seen: again ? known.seen : known.seen + 1,
        });
        back.add(r.fingerprint);
        matched++;
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
    return { added, matched };
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
  reconcile(args: { rows: readonly LedgerEntry[]; tree: ReadonlySet<string>; run: Sighting }): ReconcileResult {
    const { file, error } = this.loadFile();
    if (error !== null) throw new Error(error);
    const byFp = new Map(file.findings.map((f) => [f.fingerprint, f]));
    const newest = new Map<string, LedgerEntry>();
    for (const r of args.rows) {
      const k = `${r.lens}\0${r.path}`;
      const had = newest.get(k);
      if (!had || r.at >= had.at) newest.set(k, r);
    }
    const prior = file.question ?? null;
    const pending = new Set(prior?.unreported ?? []);
    const rereadBy = new Set<string>([args.run.run]);
    const unreported: string[] = [];
    for (const f of byFp.values()) {
      if (f.state === "fixed" || pending.has(f.fingerprint)) continue;
      if (!args.tree.has(f.path)) {
        unreported.push(f.fingerprint);
        continue;
      }
      const row = newest.get(`${f.lens}\0${f.path}`);
      if (!row || row.run === f.last_seen.run || row.at < f.last_seen.at) continue;
      if (f.blob != null && row.blob === f.blob) continue;
      unreported.push(f.fingerprint);
      rereadBy.add(row.run);
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
    return { fixed: settled.fixed, pending: settled.question?.unreported.length ?? 0 };
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
   * same finding (one-to-one, same lens); every unreported finding it does
   * not pair is fixed; every fresh one it does not pair stays new. Refused —
   * all of it — on a stale key, an unknown fingerprint, a reused one or a
   * lens mismatch.
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
      if (of && nf && of.lens !== nf.lens) errors.push(`${o.slice(0, 12)} and ${n.slice(0, 12)} are different lenses' findings`);
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
      byFp.set(nfp, {
        ...n,
        state: o.state,
        fixed: null,
        first_seen: o.first_seen,
        seen: o.seen + n.seen,
        aliases: [...new Set([...(o.aliases ?? []), old, ...(n.aliases ?? [])])],
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
          (filter.lens === undefined || f.lens === filter.lens) &&
          (filter.unit === undefined || f.unit === filter.unit) &&
          (filter.severity === undefined || f.severity === filter.severity) &&
          (filter.doubted === undefined || (f.doubt !== null) === filter.doubted),
      )
      .sort((a, b) => rank(a.severity) - rank(b.severity) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));
    return { findings: kept, error };
  }
}
