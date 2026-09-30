// The SCAN REPORT's read side and its stop channel: what the TUI's
// `[8] scan` tab reads out of the state home, and the one file through which
// it asks the companion to stop a running scan. A LEAF like stage2request.ts:
// it reaches its siblings by type only, so the TUI (which never imports the
// setup engine — tests/single-shepherd.test.ts) can read the run record and
// the findings store without carrying the case runner along.
//
// Two record files, both the engine's (this module owns their names and
// their parsers, so the engine and the TUI can never read them differently):
// `scan/run.json` (scanrun.ts — the current run and a short history) and
// `scan/findings.json` (findings.ts — every finding with its state). Each is
// read TOTALLY and one of three facts: absent (no scan has written it),
// read, or unreadable with the reason — never an empty list standing in for
// a file that could not be read (the honest-unknown rule).
//
// The stop channel mirrors the stage-2 start channel: the TUI writes
// `SCAN_STOP_FILE` naming the run it showed running; the companion's scan
// belt picks it up within seconds, stops exactly that run (in-flight cases
// aborted, the ledger resumes the rest) and answers in
// `SCAN_STOP_RESULT_FILE`, naming the request it answered — so a stop is
// answered once and never replayed onto a later run.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FindingsFile, MatchQuestion, ResemblesDismissed, ScanFinding } from "./findings.js";
import type { RunFile, ScanRun, ScanRunSummary } from "./scanrun.js";

export type { FindingState, ScanFinding } from "./findings.js";
export type { ScanCaseState, ScanRun, ScanRunSummary } from "./scanrun.js";
export type { ScanSeverity } from "./scan.js";

export const RUN_FILE = "scan/run.json";
export const RUN_VERSION = 1;
export const FINDINGS_FILE = "scan/findings.json";
export const FINDINGS_VERSION = 1;
export const SCAN_STOP_FILE = "scan/stop.json";
export const SCAN_STOP_RESULT_FILE = "scan/stop-result.json";

// ---- validity tiers (owner ruling 2026-09-30: the scan validator is the skeptic) -----

/** The skeptic's tier for a stored scan finding: `confirmed` (it traced a
 * concrete scenario), `likely` (a real mechanism, reachability not fully
 * traced), `doubtful` (refuted, class-matched, or anything it would have
 * killed — kept, never dropped). */
export type Validity = "confirmed" | "likely" | "doubtful";
export const VALIDITIES: readonly Validity[] = ["confirmed", "likely", "doubtful"];
/** A tier, or `unknown`: no skeptic judged it (the validator was off or
 * failed) or it was stored before tiers existed — never guessed. */
export type ValidityView = Validity | "unknown";
/** Display order: confirmed first, unknown last. */
export const VALIDITY_ORDER: readonly ValidityView[] = [...VALIDITIES, "unknown"];

/** A finding's tier as stored — `unknown` when it carries none. */
export function validityOf(f: { validity?: Validity | null }): ValidityView {
  return f.validity !== undefined && f.validity !== null && (VALIDITIES as readonly string[]).includes(f.validity) ? f.validity : "unknown";
}

const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---- the two records ---------------------------------------------------------------

/** A finding's resemblance to a DISMISSED one (findings.ts sets it when it
 * stores the finding), as a reader shows it: only on a finding still
 * untriaged (`new`) — once the operator promotes or dismisses it, the
 * resemblance is answered. */
export function dismissedLookalike(f: Pick<ScanFinding, "state" | "resembles_dismissed">): ResemblesDismissed | null {
  return f.state === "new" ? (f.resembles_dismissed ?? null) : null;
}

/** 1 for a finding flagged as resembling a dismissed one, else 0 — the sort
 * key that puts it below the unflagged findings of its tier. */
export const lookalikeRank = (f: Pick<ScanFinding, "state" | "resembles_dismissed">): number => (dismissedLookalike(f) ? 1 : 0);

/** Parse the run record; throws on anything this version does not read. */
export function parseRunFile(text: string): RunFile {
  const raw = JSON.parse(text) as Partial<RunFile> | null;
  if (typeof raw !== "object" || raw === null || raw.version !== RUN_VERSION) throw new Error("unknown version");
  const current = raw.current ?? null;
  if (current !== null && (typeof current !== "object" || !Array.isArray(current.cases))) {
    throw new Error("`current` is not a scan run");
  }
  return { version: RUN_VERSION, current, history: Array.isArray(raw.history) ? raw.history : [] };
}

/** Parse the findings store; throws on anything this version does not read. */
export function parseFindingsFile(text: string): FindingsFile {
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
  return { version: FINDINGS_VERSION, findings: currentLookalikes(raw.findings.map(stickyDismissal)), question: q };
}

/** A `resembles_dismissed` flag is written when a finding is stored; the
 * dismissal it names can change after that — re-dismissed with another
 * reason, promoted (the operator changed his mind), or folded into a fresh
 * finding by a match answer. Every reader goes through this parse, so the
 * flag is re-read against the store here: it names the finding that now
 * carries that fingerprint (itself, or the one it became an alias of) and
 * that finding's CURRENT reason while it is still dismissed, and it is
 * dropped otherwise — a stale "looks like a finding you dismissed" never
 * reaches the operator. */
function currentLookalikes(findings: ScanFinding[]): ScanFinding[] {
  if (!findings.some((f) => f.resembles_dismissed)) return findings;
  const owner = new Map<string, ScanFinding>();
  for (const f of findings) for (const a of f.aliases ?? []) owner.set(a, f);
  for (const f of findings) owner.set(f.fingerprint, f);
  return findings.map((f) => {
    if (!f.resembles_dismissed) return f;
    const { resembles_dismissed: flag, ...rest } = f;
    const d = owner.get(flag.fingerprint);
    if (!d || d.state !== "dismissed" || d.fingerprint === f.fingerprint) return rest;
    return { ...rest, resembles_dismissed: { fingerprint: d.fingerprint, reason: d.dismissal?.reason ?? flag.reason } };
  });
}

/** A finding a store written before the dismissal was sticky (scan-loop)
 * had flipped from `dismissed` to `fixed`: it reads back as the dismissal it
 * is, its fix kept as the `unreported` audit stamp (findings.ts). Every
 * other finding is returned as it is. */
function stickyDismissal(f: ScanFinding): ScanFinding {
  if (f.state !== "fixed" || f.fixed?.from !== "dismissed") return f;
  const { run, sha, at } = f.fixed;
  return { ...f, state: "dismissed", fixed: null, unreported: { run, sha, at } };
}

/** One record file: absent, read, or why it could not be. */
export type RecordRead<T> = { kind: "absent" } | { kind: "read"; value: T } | { kind: "unreadable"; why: string };

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function readRecord<T>(home: string, rel: string, parse: (text: string) => T): RecordRead<T> {
  let text: string | null;
  try {
    text = readText(join(home, rel));
  } catch (err) {
    return { kind: "unreadable", why: `${rel} cannot be read: ${clean(err)}` };
  }
  if (text === null) return { kind: "absent" };
  try {
    return { kind: "read", value: parse(text) };
  } catch (err) {
    return { kind: "unreadable", why: `${rel} is not a record this version reads (${clean(err)})` };
  }
}

/** The scan run record in the state home at `home`. */
export function readScanRuns(home: string): RecordRead<{ current: ScanRun | null; history: ScanRunSummary[] }> {
  return readRecord(home, RUN_FILE, (t) => {
    const f = parseRunFile(t);
    return { current: f.current, history: f.history };
  });
}

/** The findings store in the state home at `home`. */
export function readScanFindings(home: string): RecordRead<{ findings: ScanFinding[]; question: MatchQuestion | null }> {
  return readRecord(home, FINDINGS_FILE, (t) => {
    const f = parseFindingsFile(t);
    return { findings: f.findings, question: f.question ?? null };
  });
}

// ---- the stop channel --------------------------------------------------------------

export interface ScanStopRequest {
  /** Unique per click; the result names it. */
  id: string;
  /** The run the TUI showed running — only that run is stopped. */
  run: string;
  at: string;
  by: "tui";
}

export interface ScanStopResult {
  request: string;
  run: string;
  at: string;
  ok: boolean;
  errors: string[];
}

/** Parse a stop request, or null when it is not one. */
export function parseStopRequest(text: string): ScanStopRequest | null {
  try {
    const r = JSON.parse(text) as Partial<ScanStopRequest> | null;
    if (typeof r !== "object" || r === null || typeof r.id !== "string" || r.id === "" || typeof r.run !== "string" || r.run === "") return null;
    return { id: r.id, run: r.run, at: typeof r.at === "string" ? r.at : "", by: "tui" };
  } catch {
    return null;
  }
}

/** Parse a stop result, or null when it is not one. */
export function parseStopResult(text: string): ScanStopResult | null {
  try {
    const r = JSON.parse(text) as Partial<ScanStopResult> | null;
    if (typeof r !== "object" || r === null || typeof r.request !== "string" || typeof r.ok !== "boolean") return null;
    return {
      request: r.request,
      run: typeof r.run === "string" ? r.run : "",
      at: typeof r.at === "string" ? r.at : "",
      ok: r.ok,
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === "string") : [],
    };
  } catch {
    return null;
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * The TUI's stop: ask the companion to stop the run `run`, which the TUI
 * showed running. Refused when the record cannot be read or no longer shows
 * that run running — a stop is never aimed at a run the operator did not see.
 * The notice line says what was asked, or why nothing was.
 */
export function clickStopScan(
  home: string,
  run: string,
  now: Date = new Date(),
): { ok: true; request: string; line: string } | { ok: false; line: string } {
  const read = readScanRuns(home);
  if (read.kind === "unreadable") return { ok: false, line: `scan not stopped: ${read.why}` };
  const cur = read.kind === "read" ? read.value.current : null;
  if (cur === null || cur.id !== run || cur.state !== "running") {
    return { ok: false, line: `scan not stopped: ${run} is no longer running — look at the report again` };
  }
  const request: ScanStopRequest = {
    id: `${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`,
    run,
    at: now.toISOString(),
    by: "tui",
  };
  try {
    writeAtomic(join(home, SCAN_STOP_FILE), `${JSON.stringify(request)}\n`);
  } catch (err) {
    return { ok: false, line: `scan not stopped: the stop request could not be written: ${clean(err)}` };
  }
  return { ok: true, request: request.id, line: `stop asked for ${run} — the companion stops it within seconds; the ledger resumes the rest` };
}

/** What became of the stop `request`: the companion's answer, or null while
 * it has not answered (a companion that is down stops nothing — and runs
 * nothing either). */
export function scanStopOutcome(home: string, request: string): string | null {
  let text: string | null;
  try {
    text = readText(join(home, SCAN_STOP_RESULT_FILE));
  } catch {
    return null;
  }
  const r = text === null ? null : parseStopResult(text);
  if (r === null || r.request !== request) return null;
  return r.ok ? `scan ${r.run} stopped — what finished is in the ledger` : `scan stop refused: ${r.errors.join("; ")}`;
}
