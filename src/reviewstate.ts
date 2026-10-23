// What `qcr review` remembers about a target between runs (repo plus branch
// today; a PR keys the same way), so a second review covers only what changed
// and never repeats a finding that is still open.
//
// The state is the production reasoning record in miniature: one row per
// finding a round recorded (`RoundFindingRow`) and one per status a later
// round reported for a prior finding. The open list handed to the next round
// is production's `computePriorFindings` over them, so the chain, supersede
// and resolution rules are the daemon's, not a copy.
//
// Kept in the install's state home (src/reviewstore.ts), never tracked, never
// shared. Unreadable state is no state: the next review is a full one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeDisposition, recordString, type FindingDisposition } from "./findingkey.js";
import { parseFindingsRecord, type FindingsRecordEntry } from "./findingsrecord.js";
import { computePriorFindings, type PriorFindingsList } from "./priorfindings.js";
import type { RoundFindingRow } from "./storerows.js";

export const STATE_VERSION = 1;

/** The target a review is of: the key its state is kept under. */
export function branchTargetKey(repo: string, branch: string): string {
  return `branch:${repo}@${branch}`;
}

/** A PR's key: the repo and the PR number, apart from any branch of the repo. */
export function prTargetKey(repo: string, number: number): string {
  return `pr:${repo}#${number}`;
}

/** One review of the target. */
export interface ReviewRound {
  round_no: number;
  head_sha: string;
  base_sha: string;
  merge_base: string;
  reviewed_at: string;
  verdict: string | null;
  scope: "full" | "delta";
  cost_usd: number | null;
}

/** A status a round reported for a prior finding. */
export interface StoredCheck {
  checked_round: number;
  round_no: number;
  finding_key: string;
  status: string;
  evidence: string | null;
}

export interface ReviewState {
  version: typeof STATE_VERSION;
  target: string;
  rounds: ReviewRound[];
  rows: RoundFindingRow[];
  checks: StoredCheck[];
}

export function emptyState(target: string): ReviewState {
  return { version: STATE_VERSION, target, rounds: [], rows: [], checks: [] };
}

/** The target's state; null when there is none or it cannot be trusted. */
export function loadState(path: string | null, target: string): ReviewState | null {
  if (path === null || !existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewState>;
    if (
      s.version !== STATE_VERSION ||
      s.target !== target ||
      !Array.isArray(s.rounds) ||
      !Array.isArray(s.rows) ||
      !Array.isArray(s.checks) ||
      s.rounds.length === 0
    )
      return null;
    const last = s.rounds[s.rounds.length - 1];
    if (typeof last?.head_sha !== "string" || typeof last.round_no !== "number") return null;
    return s as ReviewState;
  } catch {
    return null;
  }
}

/** Atomic: a crash never leaves half a state. Best-effort by contract — a
 * state that could not be written only costs the next review its delta. */
export function saveState(path: string | null, s: ReviewState): boolean {
  if (path === null) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export const lastRound = (s: ReviewState): ReviewRound => s.rounds[s.rounds.length - 1]!;

/** The findings still open for the round after the last one: production's
 * prior-findings list over the state. */
export function openFindings(s: ReviewState | null, nextRound?: number): PriorFindingsList {
  const roundNo = nextRound ?? (s ? lastRound(s).round_no + 1 : 1);
  if (s === null) return { pr: 0, round_no: roundNo, findings: [], dropped: [], incomplete: [] };
  return computePriorFindings({
    pr: 0,
    roundNo,
    rows: s.rows,
    checks: s.checks.map((c) => ({ ...c })),
  });
}

// ---- recording a round -----------------------------------------------------------

/** The dispositions a reader sees as findings (the terminal hides the
 * review's own kills): carried as open findings, whatever the record called
 * them. */
const SHOWN_AS_POSTED = new Set<FindingDisposition>(["posted", "downgraded", "doubted", "unknown"]);

const norm = (s: string | null): string =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export interface RecordedRound {
  state: ReviewState;
  /** The round's findings that are new to the target. */
  fresh: FindingsRecordEntry[];
  /** Entries that re-raised a finding that was already open. Kept out of the
   * new findings. */
  repeats: FindingsRecordEntry[];
}

/**
 * Fold a finished round's findings record into the state. A finding that
 * re-raises one already open (the same key on the same file, a named older round, the same
 * title on the same file, or the same lens on the same line) is a repeat: it
 * is kept in the state as `merged` (auditable) and never reaches the reader as
 * new, whatever the session did. The statuses the round reported for the prior
 * findings are recorded, so the next list shrinks.
 */
export function recordRound(
  prev: ReviewState | null,
  target: string,
  round: ReviewRound,
  rawRecord: unknown,
): RecordedRound {
  const base: ReviewState =
    prev === null || round.scope === "full" ? emptyState(target) : structuredClone(prev);
  const open = round.scope === "delta" && prev ? openFindings(prev, round.round_no) : null;
  const raw =
    rawRecord !== null && typeof rawRecord === "object" && !Array.isArray(rawRecord)
      ? { ...(rawRecord as Record<string, unknown>), pr: undefined, round_no: undefined }
      : rawRecord;
  const parsed = parseFindingsRecord(raw, 0, round.round_no);
  const entries = parsed.record?.findings ?? [];
  const fresh: FindingsRecordEntry[] = [];
  const repeats: FindingsRecordEntry[] = [];
  let id = base.rows.reduce((m, r) => Math.max(m, r.id), 0);
  for (const e of entries) {
    const disposition = normalizeDisposition(e.disposition);
    const shown = SHOWN_AS_POSTED.has(disposition);
    const isRepeat =
      shown &&
      open !== null &&
      open.findings.some(
        (p) =>
          // A key is a round-local handle: it names the same finding only on
          // the same file.
          (p.finding_key === e.key && p.path === e.path) ||
          (e.raised_in_round !== null && e.raised_in_round < round.round_no) ||
          (p.path !== null &&
            p.path === e.path &&
            ((norm(p.title) !== "" && norm(p.title) === norm(e.title)) ||
              (p.line !== null && p.line === e.line && p.lens === e.lens))),
      );
    if (shown) (isRepeat ? repeats : fresh).push(e);
    base.rows.push({
      id: ++id,
      pr: 0,
      round_id: null,
      round_no: round.round_no,
      head_sha: round.head_sha,
      finding_key: e.key,
      path: e.path,
      line: e.line,
      lens: e.lens,
      tier: e.tier,
      unplanned: 0,
      severity: e.severity,
      confidence: e.confidence,
      reachability: e.reachability,
      kind: e.kind,
      disposition: isRepeat ? "merged" : shown ? "posted" : disposition,
      axis: e.axis,
      word: isRepeat ? "repeat-of-open" : e.word,
      reason: e.reason,
      evidence: e.evidence,
      posted_as: shown ? (e.posted_as ?? recordString(e.severity) ?? "finding") : e.posted_as,
      raised_in_round: e.raised_in_round,
      thread_id: e.thread_id,
      recorded_at: round.reviewed_at,
      title: e.title,
      lens_ids: null,
    });
  }
  for (const p of parsed.record?.prior ?? [])
    base.checks.push({
      checked_round: round.round_no,
      round_no: p.round_no,
      finding_key: p.finding_key,
      status: p.status,
      evidence: p.evidence,
    });
  base.rounds.push(round);
  return { state: base, fresh, repeats };
}
