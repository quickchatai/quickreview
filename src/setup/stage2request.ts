// Scan stage 2's START CHANNEL: the files through which a stage-2
// proposal is shown and started from OUTSIDE the companion — the TUI's
// click. A LEAF: it reaches its siblings by type only, so the TUI (which
// never imports the setup engine — tests/single-shepherd.test.ts) can read
// the proposal and ask for its start. The click's whole TUI half lives here
// (`clickStartStage2`, `stage2ClickOutcome`); the [8] scan tab's plan pane
// (placed by the prototype: `P`, then ⏎) is its button.
//
// Stage 2 starts one of two ways, and neither keeps an approval record (the
// spec's "no approval record"):
//
//   * the operator's word — the companion calls `scan_stage2_start` with the
//     proposal's key (and, for a narrowed "do it", the `rows` it may run —
//     the same `keptRows` rule as the click's narrowing below);
//   * a TUI click — the TUI writes `STAGE2_START_FILE` naming the key of the
//     proposal it showed; the companion's scan belt picks it up within
//     seconds and starts exactly that proposal, answering in
//     `STAGE2_RESULT_FILE`.
//
// Either way the start QUOTES A KEY, and the engine re-plans before it runs:
// a proposal that moved since it was shown (a new proposal, a new commit, a
// price that changed) is refused, so nothing runs that the operator did not
// see priced. A request is answered once — the result names the request it
// answered — so a click is never replayed.
//
// The click may NARROW the plan (space toggles a row off in the
// plan pane; the operator's word narrows the same way through
// `scan_stage2_start`'s `rows`): the request then names the runnable rows the operator kept,
// and the run is exactly those rows, stopped hard at THEIR total — the sum
// the pane showed. It can only narrow: a row that was not runnable in the
// proposal (covered, over the budget) can never be named, so nothing runs
// that was not shown priced and runnable.
//
// Files, all in the state home: `scan/stage2.json` (the latest proposal, the
// engine's), `scan/stage2-start.json` (the TUI's request),
// `scan/stage2-start-result.json` (the engine's answer).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Stage2Row, Stage2RowRequest } from "./stage2.js";

export const STAGE2_FILE = "scan/stage2.json";
export const STAGE2_START_FILE = "scan/stage2-start.json";
export const STAGE2_RESULT_FILE = "scan/stage2-start-result.json";
export const STAGE2_VERSION = 1;

/** The latest proposal, as stored — what the TUI shows and a start quotes. */
export interface StoredStage2Proposal {
  key: string;
  sha: string;
  at: string;
  /** What the companion asked for — the start re-plans from exactly this. */
  request: Stage2RowRequest[];
  budget_usd: number | null;
  /** The plan it priced. */
  rows: Stage2Row[];
  /** The hard stop: the runnable rows' total. */
  cap_usd: number;
  runnable: number;
  over_budget_usd: number;
  validator: boolean;
}

export interface Stage2File {
  version: number;
  proposal: StoredStage2Proposal | null;
}

export interface Stage2StartRequest {
  /** Unique per click; the result names it. */
  id: string;
  key: string;
  at: string;
  by: "tui";
  /** The runnable rows the operator kept (their ids); absent = all of them. */
  rows?: string[];
}

export interface Stage2StartResult {
  request: string;
  key: string;
  at: string;
  ok: boolean;
  /** The run it started. */
  run: string | null;
  errors: string[];
}

const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Parse the proposal file; throws on anything this version does not read. */
export function parseStage2File(text: string): Stage2File {
  const raw = JSON.parse(text) as Partial<Stage2File> | null;
  if (typeof raw !== "object" || raw === null || raw.version !== STAGE2_VERSION) throw new Error("not a version-1 stage 2 file");
  const p = raw.proposal ?? null;
  if (p !== null && (typeof p !== "object" || typeof p.key !== "string" || !Array.isArray(p.rows) || !Array.isArray(p.request))) {
    throw new Error("`proposal` is not a stage 2 proposal");
  }
  return { version: STAGE2_VERSION, proposal: p };
}

/** Parse a start request, or null when it is not one. */
export function parseStartRequest(text: string): Stage2StartRequest | null {
  try {
    const r = JSON.parse(text) as Partial<Stage2StartRequest> | null;
    if (typeof r !== "object" || r === null || typeof r.id !== "string" || r.id === "" || typeof r.key !== "string") return null;
    if (r.rows !== undefined && (!Array.isArray(r.rows) || !r.rows.every((x) => typeof x === "string"))) return null;
    return { id: r.id, key: r.key, at: typeof r.at === "string" ? r.at : "", by: "tui", ...(r.rows !== undefined ? { rows: [...r.rows] } : {}) };
  } catch {
    return null;
  }
}

/** Parse a start result, or null when it is not one. */
export function parseStartResult(text: string): Stage2StartResult | null {
  try {
    const r = JSON.parse(text) as Partial<Stage2StartResult> | null;
    if (typeof r !== "object" || r === null || typeof r.request !== "string" || typeof r.ok !== "boolean") return null;
    return {
      request: r.request,
      key: typeof r.key === "string" ? r.key : "",
      at: typeof r.at === "string" ? r.at : "",
      ok: r.ok,
      run: typeof r.run === "string" ? r.run : null,
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === "string") : [],
    };
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** The latest stage-2 proposal in the state home at `home`, none, or why it
 * cannot be read (then the TUI shows UNKNOWN — never "no proposal"). */
export function readStage2Proposal(home: string): { ok: true; proposal: StoredStage2Proposal | null } | { ok: false; error: string } {
  try {
    const text = readText(join(home, STAGE2_FILE));
    return { ok: true, proposal: text === null ? null : parseStage2File(text).proposal };
  } catch (err) {
    return { ok: false, error: `${STAGE2_FILE} cannot be read: ${clean(err)}` };
  }
}

/**
 * The runnable rows a start runs: all of them, or the subset `keep` names —
 * refused when `keep` is empty or names a row that is not runnable in the
 * proposal (the engine applies the same rule after it re-plans).
 */
export function keptRows(rows: readonly Stage2Row[], keep: readonly string[] | undefined): { ok: true; rows: Stage2Row[]; cap_usd: number | null } | { ok: false; errors: string[] } {
  const runnable = rows.filter((r) => r.status === "run");
  if (keep === undefined) return { ok: true, rows: runnable, cap_usd: null };
  if (keep.length === 0) return { ok: false, errors: ["every row is toggled off — keep at least one"] };
  const bad = keep.filter((id) => !runnable.some((r) => r.id === id));
  if (bad.length > 0) return { ok: false, errors: [`not a runnable row of the proposal: ${bad.join(", ")}`] };
  const kept = runnable.filter((r) => keep.includes(r.id));
  return { ok: true, rows: kept, cap_usd: kept.reduce((n, r) => n + r.estimate_usd, 0) };
}

/**
 * The TUI's click: ask the companion to start the stored proposal whose key
 * the TUI showed — all its runnable rows, or the ones in `keep`. Refused when
 * there is no proposal, it is no longer the one shown (`key`), or `keep`
 * names a row that is not runnable. Writes the request; the companion starts
 * it (or says why not) in `STAGE2_RESULT_FILE`.
 */
export function requestStage2Start(
  home: string,
  key: string,
  now: Date,
  keep?: readonly string[],
): { ok: true; request: Stage2StartRequest; proposal: StoredStage2Proposal; rows: number; cap_usd: number } | { ok: false; errors: string[] } {
  const read = readStage2Proposal(home);
  if (!read.ok) return { ok: false, errors: [read.error] };
  const p = read.proposal;
  if (p === null) return { ok: false, errors: ["no stage 2 proposal — ask the companion to propose one"] };
  if (p.key !== key) {
    return { ok: false, errors: [`the proposal changed since it was shown (showed ${key}, now ${p.key}) — look at the new one first`] };
  }
  if (p.runnable === 0) return { ok: false, errors: ["the proposal has no row to run"] };
  const kept = keptRows(p.rows, keep);
  if (!kept.ok) return kept;
  const request: Stage2StartRequest = {
    id: `${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`,
    key,
    at: now.toISOString(),
    by: "tui",
    ...(keep !== undefined ? { rows: [...keep] } : {}),
  };
  try {
    writeAtomic(join(home, STAGE2_START_FILE), `${JSON.stringify(request)}\n`);
  } catch (err) {
    return { ok: false, errors: [`the start request could not be written: ${clean(err)}`] };
  }
  return { ok: true, request, proposal: p, rows: kept.rows.length, cap_usd: kept.cap_usd ?? p.cap_usd };
}

/** The companion's answer to the request `id`, or null while it has not
 * answered (or answered another one). */
export function readStage2StartResult(home: string, id: string): Stage2StartResult | null {
  let text: string | null;
  try {
    text = readText(join(home, STAGE2_RESULT_FILE));
  } catch {
    return null;
  }
  const r = text === null ? null : parseStartResult(text);
  return r !== null && r.request === id ? r : null;
}

// ---- the TUI's click -------------------------------------------------------------

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The click: ask the companion to start the proposal whose key the TUI
 * showed — its kept rows when the operator toggled some off. The notice line
 * says what was asked, or why nothing was.
 */
export function clickStartStage2(
  home: string,
  key: string,
  now: Date = new Date(),
  keep?: readonly string[],
): { ok: true; request: string; line: string } | { ok: false; line: string } {
  const r = requestStage2Start(home, key, now, keep);
  if (!r.ok) return { ok: false, line: `stage 2 not started: ${r.errors.join("; ")}` };
  return {
    ok: true,
    request: r.request.id,
    line: `stage 2 asked to start — ${r.rows} row(s), hard stop ${usd(r.cap_usd)}; the companion starts it within seconds`,
  };
}

/** What became of the click `request`: the companion's answer, or null while
 * it has not answered (a companion that is down starts nothing). */
export function stage2ClickOutcome(home: string, request: string): string | null {
  const r = readStage2StartResult(home, request);
  if (r === null) return null;
  return r.ok ? `stage 2 started: ${r.run}` : `stage 2 refused: ${r.errors.join("; ")}`;
}
