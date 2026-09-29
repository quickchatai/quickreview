// The SCAN FINDINGS STORE (spec "Findings"): every finding
// a scan has reported, keyed by its fingerprint — file + lens + kind + a hash
// of the anchored code, whitespace-normalised (scan.ts findingFingerprint).
//
// This slice writes and reads it; the triage verbs (dismiss, promote), the
// companion-judged sameness for what an exact match misses, and the
// automatic `fixed` state land with on the same file.
//
//   * EXACT MATCH FIRST. A finding whose fingerprint is already stored is the
//     same finding: its last sighting and wording are refreshed, and its
//     state — `new`, `promoted`, `dismissed` — is kept, so nothing is ever
//     triaged twice. (A `fixed` finding seen again has come back: it is
//     `new` again.)
//   * "MAY NOT BE VALID" IS A FLAG, NOT A STATE. A finding the validator
//     doubted is stored with its `doubt` (word and reason) and shown as such;
//     a finding no validator looked at is `validated: false`. Neither is
//     dropped.
//   * Individual findings never become memory (spec "Scan memory") — this
//     store is the PC-side record, in the state home, never shipped.
//
// Persistence: `<state home>/scan/findings.json`. An unreadable store is
// reported and refuses writes, like the ledger and the unit cut.
import type { StateFs } from "./engine.js";
import type { ScanSeverity } from "./scan.js";

export const FINDINGS_FILE = "scan/findings.json";
export const FINDINGS_VERSION = 1;

export type FindingState = "new" | "promoted" | "dismissed" | "fixed";

export interface Sighting {
  run: string;
  sha: string;
  at: string;
}

export interface ScanFinding {
  /** sha256 hex — the identity. */
  fingerprint: string;
  unit: string;
  path: string;
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
}

/** What a scan reports — a finding before the store gives it a history. */
export type ReportedFinding = Omit<ScanFinding, "state" | "first_seen" | "last_seen" | "seen">;

export interface FindingsFile {
  version: number;
  findings: ScanFinding[];
}

export interface FindingsFilter {
  state?: FindingState;
  lens?: string;
  unit?: string;
  severity?: ScanSeverity;
  /** true: only "may not be valid"; false: only the rest. */
  doubted?: boolean;
}

export class FindingsStore {
  constructor(private readonly state: StateFs) {}

  load(): { findings: ScanFinding[]; error: string | null } {
    let text: string | null;
    try {
      text = this.state.read(FINDINGS_FILE);
    } catch (err) {
      return { findings: [], error: `${FINDINGS_FILE} in ${this.state.location} cannot be read: ${String(err)}` };
    }
    if (text === null) return { findings: [], error: null };
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
      return { findings: raw.findings, error: null };
    } catch (err) {
      return {
        findings: [],
        error:
          `${FINDINGS_FILE} in ${this.state.location} is not a findings store this version reads (${String(err)}) — ` +
          "nothing will overwrite it; move it aside to start over",
      };
    }
  }

  /**
   * Record what one case reported. Exact fingerprint match first: a known
   * finding keeps its state and first sighting; an unknown one is `new`.
   * Returns how many were new and how many matched. Throws when the stored
   * file cannot be read — never writes over it.
   */
  report(reported: readonly ReportedFinding[], seen: Sighting): { added: number; matched: number } {
    const { findings, error } = this.load();
    if (error !== null) throw new Error(error);
    const byFp = new Map(findings.map((f) => [f.fingerprint, f]));
    let added = 0;
    let matched = 0;
    for (const r of reported) {
      const known = byFp.get(r.fingerprint);
      if (known) {
        // The same sighting twice (one case reporting a duplicate) counts once.
        const again = known.last_seen.run === seen.run && known.last_seen.sha === seen.sha;
        byFp.set(r.fingerprint, {
          ...known,
          ...r,
          state: known.state === "fixed" ? "new" : known.state,
          first_seen: known.first_seen,
          last_seen: seen,
          seen: again ? known.seen : known.seen + 1,
        });
        matched++;
      } else {
        byFp.set(r.fingerprint, { ...r, state: "new", first_seen: seen, last_seen: seen, seen: 1 });
        added++;
      }
    }
    const file: FindingsFile = { version: FINDINGS_VERSION, findings: [...byFp.values()] };
    this.state.write(FINDINGS_FILE, `${JSON.stringify(file, null, 1)}\n`);
    return { added, matched };
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
