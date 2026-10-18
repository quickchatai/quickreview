// AACR-Bench what-if lever scorer — the PURE half (no fs, no pi, no network).
//
// Question it answers: how would the score move if the reviewer POSTED more of
// what its lenses found? A round writes three layers of evidence per case:
//
//   pi-events.jsonl      every lens pass's own final output (the `subagent`
//                        tool's `tool_execution_end` → result.details.results[])
//                        — the RAW candidates, in the lens's own words;
//   findings-record.json the session's disposition of every candidate
//                        (posted / merged / folded / killed / downgraded /
//                        withheld) — but for a killed or merged row `reason`
//                        says WHY it was dropped, not what it claimed;
//   results/all/*.json   what was actually scored — the control.
//
// This module parses the first, links the second onto it (so a dropped row
// gets its lens's own claim text back), and composes the scorer's input for
// four variants:
//
//   posted          exactly the run's own results/all (the control)
//   posted+killed   + every candidate the validator KILLED
//   posted+merged   + every MERGED / FOLDED candidate, as its own comment
//   all-candidates  every raw lens candidate (validator excluded), deduped
//                   only when path, line and claim text are identical
//
// The extra comments follow toOcrResult's conversion rules exactly: a
// single-line anchor at `line`, LEFT-side excluded (the harness forces every
// generated comment to the right side), and a candidate with no line
// excluded — the harness SKIPS its line gate when a generated comment has no
// line, so a lineless comment would be judged against every reference in its
// file, a free pass no posted comment gets. Every exclusion is counted. The
// anchor is the lens's own; only a lens that gave NO line borrows the line
// the session's record gave the same finding in the same file (flagged
// `anchor: "record"`), since that is where it would have been posted.
//
// Posted comments stay FIRST, in their original order, in every posted+
// variant. The harness walks generated comments in order per reference and a
// comment can match only once, so appending extras leaves the control's
// matches reachable exactly as before: any match the control makes and a
// posted+ variant loses is judge noise, and the report says so.

import { singleLineComment } from "./artifacts.js";
import { childResults } from "./aacr.js";
import { isLensTool, lensIdOf, LensOnce } from "../lensresult.js";
import { findingRecordKey, recordSide } from "../findingkey.js";
import { canonicalLensIds } from "../lensids.js";
import { normalizeDisposition } from "../findingsrecord.js";

// ---- the lens outputs in pi's JSON event stream -------------------------------

/** One lens (or validator) pass, as the lens tool (`subagent`, `launch_plan`,
 * `lens`, `lens_wave`) reported it. */
export interface LensOutput {
  /** 0-based index of the lens tool call in the stream. */
  call: number;
  /** The built agent name, e.g. `pass-baseline--terra-med`. */
  agent: string;
  /** The lens, tier stripped: `pass-baseline`. */
  lens: string;
  exitCode: number | null;
  /** The pass's final assistant text (its findings block). */
  text: string;
}

/** `pass-baseline--terra-med` / `baseline` / `Pass-Baseline` → `pass-baseline`. */
export function normalizeLens(name: string): string {
  const bare = name.trim().toLowerCase().split("--")[0]!.trim();
  if (!bare) return "";
  return bare.startsWith("pass-") ? bare : `pass-${bare}`;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("");
}

/**
 * Every pass the round ran, from pi `--mode json` stdout lines, in stream
 * order. A pass's output is its LAST assistant message that carries text —
 * the findings block; a line that is not JSON is skipped.
 */
export function lensOutputsFromEvents(lines: Iterable<string>): LensOutput[] {
  const out: LensOutput[] = [];
  const once = new LensOnce();
  let call = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // `launch_plan` returns the subagent tool's own parallel result;
    // `lens_wave` returns the wave's, which a later call can return again.
    if (e["type"] !== "tool_execution_end" || !isLensTool(e["toolName"])) continue;
    const results = childResults(e);
    for (const r of results) {
      if (!once.claim(lensIdOf(r))) continue;
      const row = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
      const agent = typeof row["agent"] === "string" ? row["agent"] : "";
      const messages = Array.isArray(row["messages"]) ? (row["messages"] as unknown[]) : [];
      let text = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as Record<string, unknown> | null;
        if (m?.["role"] !== "assistant") continue;
        const t = textOf(m);
        if (t.trim()) {
          text = t;
          break;
        }
      }
      out.push({
        call,
        agent,
        lens: normalizeLens(agent),
        exitCode: typeof row["exitCode"] === "number" ? row["exitCode"] : null,
        text,
      });
    }
    call++;
  }
  return out;
}

// ---- a findings block → raw candidates ----------------------------------------

export type Side = "RIGHT" | "LEFT";

/** One finding exactly as a lens pass returned it (prompts/pass-common.md). */
export interface RawCandidate {
  lens: string;
  agent: string;
  call: number;
  /** 0-based position within that pass's findings block. */
  index: number;
  path: string;
  /** Head-side anchor; the END of a `a-b` range, as GitHub's `line` is. */
  line?: number;
  side: Side;
  /** `P0`…`P3` or `nit`, as written (normalised case). */
  severity: string;
  confidence?: number;
  claim: string;
  detail?: string;
  evidence?: string;
  fix?: string;
  kind?: string;
  title?: string;
}

const FIELD_RE = /^(\s*)(-\s+)?([a-z][a-z0-9 _-]{0,40}):(?:\s(.*)|$)/;

function severityOf(v: string | undefined): string {
  const s = (v ?? "").trim().replace(/[`*]/g, "");
  const m = /^(p[0-3])\b/i.exec(s);
  if (m) return m[1]!.toUpperCase();
  return /^nit\b/i.test(s) ? "nit" : s;
}

function lineOf(v: string | undefined): { line?: number; start?: number } {
  const m = /^\s*`?L?(\d+)(?:\s*[-–]\s*L?(\d+))?/.exec(v ?? "");
  if (!m) return {};
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : undefined;
  if (!(a > 0)) return {};
  return b !== undefined && b >= a ? { line: b, start: a } : { line: a };
}

function cleanPath(v: string): { path: string; line?: number } {
  let p = v
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^\.?\/+/, "");
  // `path: src/x.ts:42` (or `:10-30`) with no separate line field: the line
  // as `lineOf` reads a `line:` field, a range anchored at its end.
  const m = /^(.*\S):(\d+(?:\s*[-–]\s*\d+)?)$/.exec(p);
  if (m && !/^[a-z]+:\/\//i.test(p)) {
    p = m[1]!;
    const line = lineOf(m[2]).line;
    return line !== undefined ? { path: p, line } : { path: p };
  }
  return { path: p };
}

/**
 * Parse one pass's findings block. Tolerant of what the models actually
 * write — extra fields (`title`, `kind`, `request`, free-form keys), code
 * fences, continuation lines — and strict about substance: an item with no
 * path or no claim is not a candidate (counted in `dropped`, never repaired).
 */
export function parseFindingsBlock(
  text: string,
  who: { lens: string; agent: string; call: number },
): { candidates: RawCandidate[]; dropped: number } {
  const items: Array<Map<string, string>> = [];
  let cur: Map<string, string> | null = null;
  let lastKey = "";
  // Indentation of the block's item bullets, fixed by the first one: a `- `
  // deeper than that is a bullet INSIDE a field value, not a new finding.
  let itemIndent = -1;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) continue;
    if (!line.trim()) continue;
    const indent = /^\s*/.exec(line)![0].length;
    const m = FIELD_RE.exec(line);
    if (m && m[2] !== undefined && (itemIndent < 0 || indent <= itemIndent)) {
      cur = new Map();
      items.push(cur);
      itemIndent = indent;
      lastKey = m[3]!.trim();
      cur.set(lastKey, (m[4] ?? "").trim());
      continue;
    }
    // A line back at (or left of) the bullets' indentation that is not a new
    // item ends the item: `NONE`, `KILLED`, a heading, trailing prose.
    if (!cur || indent <= itemIndent) {
      cur = null;
      continue;
    }
    if (m && m[2] === undefined) {
      lastKey = m[3]!.trim();
      // First occurrence wins: a later `claim:` inside prose never replaces it.
      if (!cur.has(lastKey)) cur.set(lastKey, (m[4] ?? "").trim());
      else lastKey = "";
      continue;
    }
    // Continuation of the previous field.
    if (lastKey) cur.set(lastKey, `${cur.get(lastKey) ?? ""} ${line.trim()}`.trim());
  }

  const candidates: RawCandidate[] = [];
  let dropped = 0;
  items.forEach((f, index) => {
    const pathField = cleanPath(f.get("path") ?? f.get("file") ?? "");
    const claim = (f.get("claim") ?? "").trim();
    if (!pathField.path || !claim) {
      dropped++;
      return;
    }
    const ln = lineOf(f.get("line"));
    const line = ln.line ?? pathField.line;
    const conf = Number((f.get("confidence") ?? "").trim());
    const side: Side = /^left\b/i.test((f.get("side") ?? "").trim()) ? "LEFT" : "RIGHT";
    const opt = (k: string): string | undefined => {
      const v = f.get(k)?.trim();
      return v ? v : undefined;
    };
    const detail = opt("detail");
    const evidence = opt("evidence");
    const fix = opt("fix");
    const kind = opt("kind");
    const title = opt("title");
    candidates.push({
      lens: who.lens,
      agent: who.agent,
      call: who.call,
      index,
      path: pathField.path,
      ...(line !== undefined ? { line } : {}),
      side,
      severity: severityOf(f.get("severity")),
      ...(Number.isFinite(conf) && (f.get("confidence") ?? "").trim() !== ""
        ? { confidence: conf }
        : {}),
      claim,
      ...(detail !== undefined ? { detail } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      ...(fix !== undefined ? { fix } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(title !== undefined ? { title } : {}),
    });
  });
  return { candidates, dropped };
}

/** The validator is the round's adversary, not a lens: its survivors are
 * rewrites of lens candidates, so they are never raw candidates. */
export const VALIDATOR_LENS = "pass-validate";

/** Every raw lens candidate in the stream, in stream order. */
export function rawCandidatesFromEvents(lines: Iterable<string>): {
  candidates: RawCandidate[];
  passes: Array<{ agent: string; call: number; exitCode: number | null; found: number }>;
  dropped: number;
} {
  const candidates: RawCandidate[] = [];
  const passes: Array<{ agent: string; call: number; exitCode: number | null; found: number }> = [];
  let dropped = 0;
  for (const o of lensOutputsFromEvents(lines)) {
    if (o.lens === VALIDATOR_LENS) continue;
    const parsed = parseFindingsBlock(o.text, o);
    candidates.push(...parsed.candidates);
    dropped += parsed.dropped;
    passes.push({
      agent: o.agent,
      call: o.call,
      exitCode: o.exitCode,
      found: parsed.candidates.length,
    });
  }
  return { candidates, passes, dropped };
}

// ---- the findings record, linked back onto the raw candidates -----------------

export interface RecordFinding {
  /** The row's key by the findings record's own rule (src/findingkey.ts):
   * its `id`, else its `key`, else `<lens>@<path>:<line>#<index>`. */
  id: string;
  /** The record reader's closed set (`posted`, `merged`, `folded`, `killed`,
   * `doubted`, `downgraded`, `withheld`, `conceded`), its aliases folded in;
   * a spelling it does not know stays as written, lower-cased. */
  disposition: string;
  lenses: string[];
  path: string;
  side?: "LEFT" | "RIGHT";
  line?: number;
  severity: string;
  evidence?: string;
  reason?: string;
  kind?: string;
}

function recInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string") return lineOf(v).line;
  return undefined;
}

/** The session's findings record — tolerant in shape, like every reader
 * here, and accepting what the production reader accepts: a `findings` or a
 * `candidates` array (or a bare one), and every disposition spelling. */
export function parseFindingsRecord(raw: unknown): RecordFinding[] {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as {
    findings?: unknown;
    candidates?: unknown;
  };
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(o.findings)
      ? o.findings
      : Array.isArray(o.candidates)
        ? o.candidates
        : [];
  const out: RecordFinding[] = [];
  rows.forEach((row, i) => {
    const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    const str = (k: string): string | undefined => {
      const v = r[k];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    // `name` is the production reader's older spelling of `lens`.
    const lensRaw = Array.isArray(r["lens"])
      ? (r["lens"] as unknown[]).filter((x): x is string => typeof x === "string").join(",")
      : (str("lens") ?? str("name") ?? "");
    const line = recInt(r["line"]);
    const evidence = str("evidence");
    const reason = str("reason");
    const kind = str("kind");
    const written = (str("disposition") ?? "").toLowerCase();
    const disposition = normalizeDisposition(written);
    out.push({
      id: findingRecordKey(r, i),
      disposition: disposition === "unknown" ? written : disposition,
      lenses: canonicalLensIds(lensRaw),
      path: cleanPath(str("path") ?? "").path,
      side: recordSide(r["side"]),
      ...(line !== undefined ? { line } : {}),
      severity: severityOf(str("severity")),
      ...(evidence !== undefined ? { evidence } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(kind !== undefined ? { kind } : {}),
    });
  });
  return out;
}

export type LinkHow = "lens+path+line" | "other-lens+path+line" | "lens+text" | "unlinked";

export interface RecordLink {
  record: RecordFinding;
  /** Index into the candidate list, or null when no candidate fits. */
  candidate: number | null;
  how: LinkHow;
  lineDelta?: number;
}

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

/** A lens candidate may drift from where the record anchors it: the session
 * and the validator re-anchor to a changed-line run. Beyond this, it is not
 * the same finding. */
export const LINK_MAX_LINE_DELTA = { sameLens: 12, otherLens: 3 } as const;

/**
 * Give every record row its raw candidate — one-to-one, best pairs first. A
 * pair needs the same file; then the same lens beats another lens, a nearer
 * line beats a farther one, an equal severity breaks a tie, and word overlap
 * between the record's evidence and the candidate's text breaks the rest.
 * The record's `reason` is never used: for a dropped row it says why it was
 * dropped, not what it claimed.
 */
export function linkRecord(
  record: readonly RecordFinding[],
  candidates: readonly RawCandidate[],
): RecordLink[] {
  type Pair = { r: number; c: number; key: number[]; how: LinkHow; delta: number };
  const pairs: Pair[] = [];
  const cWords = candidates.map((c) =>
    words([c.claim, c.detail, c.evidence, c.kind].filter(Boolean).join(" ")),
  );
  // What a record row says it claimed, for both phases: its evidence and kind.
  const rWords = record.map((f) => words([f.evidence, f.kind].filter(Boolean).join(" ")));
  record.forEach((f, ri) => {
    const fWords = rWords[ri]!;
    candidates.forEach((c, ci) => {
      if (!f.path || c.path !== f.path) return;
      const sameLens = f.lenses.length === 0 || f.lenses.includes(c.lens);
      const delta =
        f.line !== undefined && c.line !== undefined
          ? Math.abs(f.line - c.line)
          : f.line === undefined && c.line === undefined
            ? 0
            : LINK_MAX_LINE_DELTA.otherLens; // one side lineless: a weak but real tie
      const max = sameLens ? LINK_MAX_LINE_DELTA.sameLens : LINK_MAX_LINE_DELTA.otherLens;
      if (delta > max) return;
      pairs.push({
        r: ri,
        c: ci,
        how: sameLens ? "lens+path+line" : "other-lens+path+line",
        delta,
        key: [
          sameLens ? 0 : 1,
          delta,
          f.severity && f.severity === c.severity ? 0 : 1,
          -jaccard(fWords, cWords[ci]!),
          ci,
        ],
      });
    });
  });
  pairs.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const d = a.key[i]! - b.key[i]!;
      if (d !== 0) return d;
    }
    return a.r - b.r;
  });
  const takenR = new Map<number, Pair>();
  const takenC = new Set<number>();
  for (const p of pairs) {
    if (takenR.has(p.r) || takenC.has(p.c)) continue;
    takenR.set(p.r, p);
    takenC.add(p.c);
  }
  // Second pass, for rows the anchor could not place: the session re-anchors
  // a finding onto the file where the defect SHOWS (a lint rule the lens
  // anchored in the config, posted at the notebook it breaks). Same lens
  // required, and the words must overlap clearly.
  const textPairs: Array<{ r: number; c: number; score: number }> = [];
  record.forEach((f, ri) => {
    if (takenR.has(ri) || f.lenses.length === 0) return;
    const fWords = rWords[ri]!;
    candidates.forEach((c, ci) => {
      if (takenC.has(ci) || !f.lenses.includes(c.lens)) return;
      const score = jaccard(fWords, cWords[ci]!);
      if (score >= LINK_MIN_TEXT_OVERLAP) textPairs.push({ r: ri, c: ci, score });
    });
  });
  textPairs.sort((a, b) => b.score - a.score || a.r - b.r || a.c - b.c);
  const textR = new Map<number, number>();
  for (const p of textPairs) {
    if (takenR.has(p.r) || textR.has(p.r) || takenC.has(p.c)) continue;
    textR.set(p.r, p.c);
    takenC.add(p.c);
  }
  return record.map((f, ri) => {
    const p = takenR.get(ri);
    if (p) return { record: f, candidate: p.c, how: p.how, lineDelta: p.delta };
    const t = textR.get(ri);
    return t !== undefined
      ? { record: f, candidate: t, how: "lens+text" }
      : { record: f, candidate: null, how: "unlinked" };
  });
}

/** Word overlap (Jaccard) a same-lens, different-anchor link needs. */
export const LINK_MIN_TEXT_OVERLAP = 0.12;

// ---- the variants -------------------------------------------------------------

export const WHATIF_VARIANTS = [
  "posted",
  "posted+killed",
  "posted+merged",
  "all-candidates",
] as const;
export type WhatifVariant = (typeof WHATIF_VARIANTS)[number];

/** Which record dispositions each posted+ variant adds. */
export const ADDED_DISPOSITIONS: Record<WhatifVariant, readonly string[]> = {
  posted: [],
  // A doubted finding is a validator veto kept as a mark.
  "posted+killed": ["killed", "doubted"],
  "posted+merged": ["merged", "folded"],
  "all-candidates": [],
};

export type ExtraOrigin = "killed" | "merged" | "folded" | "candidate";

/** Where an extra comment came from — carried beside each scored comment
 * (`qcr_whatif`; the harness reads only path/start_line/end_line/content). */
export interface ExtraProvenance {
  origin: ExtraOrigin;
  lens: string;
  agent?: string;
  severity: string;
  record_id?: string;
  link?: LinkHow;
  /** `lens-claim`: the lens's own claim sentence. `record-evidence`: no raw
   * candidate could be linked to this record row, so its evidence stands in
   * (never its `reason`). */
  text_source: "lens-claim" | "record-evidence";
  /** Where the anchor came from: the lens's own `path`/`line`/`side` (the
   * rule), or the record's line when the lens gave none. */
  anchor: "lens" | "record";
}

export interface ExtraCandidate {
  path: string;
  line?: number;
  side: Side;
  content: string;
  prov: ExtraProvenance;
}

export interface OcrComment {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  qcr_whatif?: ExtraProvenance | { origin: "posted" };
}

/** The line the session's record gave a finding, when it is in the same file
 * as the lens candidate linked to it — where the finding would have been
 * posted. */
function recordLineFor(link: RecordLink, c: RawCandidate): number | undefined {
  return link.record.line !== undefined && link.record.path === c.path
    ? link.record.line
    : undefined;
}

/** A lens that gave no line takes the record's line for the same finding,
 * flagged `anchor: "record"`; one that gave a line keeps its own. */
function borrowRecordLine(x: ExtraCandidate, line: number | undefined): void {
  if (x.line !== undefined || line === undefined) return;
  x.line = line;
  x.prov.anchor = "record";
}

function candidateExtra(
  c: RawCandidate,
  origin: ExtraOrigin,
  f?: RecordFinding,
  how?: LinkHow,
): ExtraCandidate {
  return {
    path: c.path,
    ...(c.line !== undefined ? { line: c.line } : {}),
    side: c.side,
    content: c.claim,
    prov: {
      origin,
      lens: c.lens,
      agent: c.agent,
      severity: c.severity,
      ...(f ? { record_id: f.id } : {}),
      ...(how ? { link: how } : {}),
      text_source: "lens-claim",
      anchor: "lens",
    },
  };
}

/** The extra comments a posted+ variant adds, from the linked record. */
export function recordExtras(
  links: readonly RecordLink[],
  candidates: readonly RawCandidate[],
  dispositions: readonly string[],
): ExtraCandidate[] {
  const out: ExtraCandidate[] = [];
  for (const l of links) {
    const d = l.record.disposition;
    if (!dispositions.includes(d)) continue;
    const origin = (
      d === "folded" ? "folded" : d === "merged" ? "merged" : "killed"
    ) as ExtraOrigin;
    if (l.candidate !== null) {
      const c = candidates[l.candidate]!;
      const x = candidateExtra(c, origin, l.record, l.how);
      borrowRecordLine(x, recordLineFor(l, c));
      out.push(x);
      continue;
    }
    // No raw candidate fits: the record's evidence is the only description of
    // WHAT it claimed (its reason says why it was dropped). Flagged.
    if (!l.record.evidence) continue;
    out.push({
      path: l.record.path,
      ...(l.record.line !== undefined ? { line: l.record.line } : {}),
      side: l.record.side ?? "RIGHT",
      content: l.record.evidence,
      prov: {
        origin,
        lens: l.record.lenses.join(",") || "?",
        severity: l.record.severity,
        record_id: l.record.id,
        link: "unlinked",
        text_source: "record-evidence",
        anchor: "record",
      },
    });
  }
  return out;
}

/** Every raw lens candidate, deduped only on identical (path, line, claim).
 * A candidate the lens gave no line takes the line of the record row linked
 * to it in the same file — the anchor the session gave that finding — and
 * is otherwise left lineless (and so excluded when converted). */
export function allCandidateExtras(
  candidates: readonly RawCandidate[],
  links: readonly RecordLink[] = [],
): ExtraCandidate[] {
  const recordLine = new Map<number, number>();
  for (const l of links) {
    if (l.candidate === null) continue;
    const line = recordLineFor(l, candidates[l.candidate]!);
    if (line !== undefined) recordLine.set(l.candidate, line);
  }
  const seen = new Map<string, number>();
  const out: ExtraCandidate[] = [];
  candidates.forEach((c, i) => {
    const key = `${c.path}\0${c.line ?? ""}\0${c.claim}`;
    const x = candidateExtra(c, "candidate");
    borrowRecordLine(x, recordLine.get(i));
    const at = seen.get(key);
    // A duplicate is dropped — unless it is scoreable where the kept one is
    // not (a line the kept copy lacks, the head side where it sits on the
    // old): the kept copy would be excluded, losing the finding.
    if (at !== undefined) {
      if (!scoreable(out[at]!) && scoreable(x)) out[at] = x;
      return;
    }
    seen.set(key, out.length);
    out.push(x);
  });
  return out;
}

/** Whether the scorer gets an extra at all (`toOcrComments`): a line, on the
 * head side. */
function scoreable(x: ExtraCandidate): boolean {
  return exclusionOf(x) === null;
}

function exclusionOf(x: ExtraCandidate): keyof WhatifExcluded | null {
  return x.side === "LEFT" ? "left_side" : x.line === undefined ? "no_line" : null;
}

export interface WhatifExcluded {
  left_side: number;
  no_line: number;
}

/** Extras → the scorer's comment shape, by toOcrResult's rules: one line,
 * RIGHT side only, and a comment with no line is excluded (never anchored). */
export function toOcrComments(extras: readonly ExtraCandidate[]): {
  comments: OcrComment[];
  excluded: WhatifExcluded;
} {
  const excluded = { left_side: 0, no_line: 0 };
  const comments: OcrComment[] = [];
  for (const x of extras) {
    const reason = exclusionOf(x);
    if (reason !== null) {
      excluded[reason]++;
      continue;
    }
    comments.push({
      ...singleLineComment(x.path, x.line!, x.content),
      qcr_whatif: x.prov,
    });
  }
  return { comments, excluded };
}

/**
 * One case's result file for one variant. `posted` is the run's own
 * results/all file, parsed; its comments are carried over unchanged in their
 * original order, each tagged `qcr_whatif.origin = posted` (and are the whole
 * file for `posted`), and its token and duration fields are kept so the
 * harness's cost columns stay the run's.
 */
export function whatifResult(
  posted: unknown,
  variant: WhatifVariant,
  extras: readonly ExtraCandidate[],
): { result: Record<string, unknown>; added: number; excluded: WhatifExcluded } {
  const base = (typeof posted === "object" && posted !== null ? posted : {}) as Record<
    string,
    unknown
  >;
  const review = (base["review"] ?? {}) as Record<string, unknown>;
  const postedComments = Array.isArray(review["comments"]) ? (review["comments"] as unknown[]) : [];
  const { comments, excluded } = toOcrComments(variant === "posted" ? [] : extras);
  const kept =
    variant === "all-candidates"
      ? comments
      : [
          ...postedComments.map((c) => ({ ...(c as object), qcr_whatif: { origin: "posted" } })),
          ...comments,
        ];
  const result: Record<string, unknown> = {
    ...base,
    review: { ...review, comments: kept },
    qcr_whatif: {
      variant,
      posted: variant === "all-candidates" ? 0 : postedComments.length,
      added: comments.length,
      excluded,
    },
  };
  return { result, added: comments.length, excluded };
}

// ---- reading the scored metrics back ------------------------------------------

export interface MetricsRound {
  summary: Record<string, number>;
  eval_res: Array<{
    instance_id: string;
    comments: Array<{
      note: string;
      path: string;
      from_line: number | null;
      to_line: number | null;
      line_match: boolean;
      semantic_match: boolean;
      matched_note: string;
    }>;
  }>;
}

export interface RefOutcome {
  instance_id: string;
  /** Position of the reference in the instance's reference list. */
  ref: number;
  note: string;
  path: string;
  from_line: number | null;
  to_line: number | null;
  /** Per variant: in how many rounds the judge matched it, and to what —
   * `note_rounds` saying in how many rounds each matched note was the match. */
  matched: Partial<
    Record<
      WhatifVariant,
      { rounds: number; of: number; notes: string[]; note_rounds: Map<string, number> }
    >
  >;
}

/** A reference's identity across metrics files: its instance and its
 * position in the instance's reference list. */
export function refKey(r: { instance_id: string; ref: number }): string {
  return `${r.instance_id}#${r.ref}`;
}

/** Fold every variant's per-round metrics into one row per reference. The
 * reference list is the dataset's, so its order is identical in every file. */
export function refOutcomes(
  rounds: Partial<Record<WhatifVariant, readonly MetricsRound[]>>,
): RefOutcome[] {
  const byKey = new Map<string, RefOutcome>();
  for (const v of WHATIF_VARIANTS) {
    const rs = rounds[v];
    if (!rs) continue;
    for (const round of rs) {
      for (const inst of round.eval_res) {
        inst.comments.forEach((c, i) => {
          const key = refKey({ instance_id: inst.instance_id, ref: i });
          let row = byKey.get(key);
          if (!row) {
            row = {
              instance_id: inst.instance_id,
              ref: i,
              note: c.note,
              path: c.path,
              from_line: c.from_line,
              to_line: c.to_line,
              matched: {},
            };
            byKey.set(key, row);
          }
          const m = (row.matched[v] ??= {
            rounds: 0,
            of: rs.length,
            notes: [] as string[],
            note_rounds: new Map<string, number>(),
          });
          if (c.semantic_match) {
            m.rounds++;
            if (c.matched_note) {
              if (!m.notes.includes(c.matched_note)) m.notes.push(c.matched_note);
              m.note_rounds.set(c.matched_note, (m.note_rounds.get(c.matched_note) ?? 0) + 1);
            }
          }
        });
      }
    }
  }
  return [...byKey.values()];
}

/** References a variant matched in MORE rounds than the control did (the
 * candidates for a real catch), and FEWER (the control's own judge noise, or
 * — for all-candidates — a posted comment's wording the raw claim lacks). */
export function deltaVsControl(
  rows: readonly RefOutcome[],
  variant: WhatifVariant,
): { gained: RefOutcome[]; lost: RefOutcome[] } {
  const gained: RefOutcome[] = [];
  const lost: RefOutcome[] = [];
  for (const r of rows) {
    const v = r.matched[variant];
    const c = r.matched.posted;
    if (!v || !c) continue;
    const vr = v.rounds / v.of;
    const cr = c.rounds / c.of;
    if (vr > cr) gained.push(r);
    else if (vr < cr) lost.push(r);
  }
  return { gained, lost };
}

/** The harness's line gate (judge.py diff_location_is_same): two closed
 * ranges pass when they overlap or lie within `k` lines of each other. Only a
 * generated comment that passes it is ever shown to the judge for that
 * reference. */
export function lineGate(
  refFrom: number,
  refTo: number,
  genFrom: number,
  genTo: number,
  k = 1,
): boolean {
  const overlap = !(refFrom > genTo || genFrom > refTo);
  const distance = overlap ? 0 : Math.min(Math.abs(refFrom - genTo), Math.abs(genFrom - refTo));
  return distance <= k;
}
