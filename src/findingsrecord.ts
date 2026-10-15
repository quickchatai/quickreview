// The durable reasoning record.
//
// WHAT THIS IS. `rounds.lenses` records the PLAN and `rounds.executed_passes`
// records COUNTS — neither says which candidate findings were killed, nor why.
// Adjudication, the "how often the review backs down" metric and per-round
// volume all need that reasoning, so the session writes a schema'd file and
// the daemon parses it into queryable rows.
//
// THE SHAPE IS THE LEDGER PATTERN, DELIBERATELY. A prompt mandate alone does
// not stick. So the daemon parses the file after the round and, on
// missing/unparseable, emits a queryable anomaly plus EXACTLY ONE re-nudge
// through `wakeOrHold` telling the session to write only that record. The
// once-mark is persisted BEFORE the inject, so even a crashed inject can never
// become a nudge loop.
//
// A ROUND IS NEVER HELD OPEN FOR IT. This is a record, not a gate: the verdict
// has already been applied, the round row is already finished and the PR has
// already transitioned by the time any of this runs. A record that never
// arrives costs one anomaly row and one nudge, and nothing else — least of all
// a wedged PR (rule 9).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOUBT_WORDS } from "./doubtwords.js";
import {
  findingRecordKey,
  normalizeDisposition,
  recordNumber,
  recordString,
  type FindingDisposition,
} from "./findingkey.js";
import { WITHHOLD_WORDS } from "./postingpolicy.js";
import { bareTag, isSanctionedTag } from "./severity.js";
import type { StateStore } from "./state.js";
import { wakeOrHold } from "./wakes.js";

/** The validator's validity vetoes (src/doubtwords.ts). */
export { DOUBT_WORDS };

/** The disposition vocabulary lives in the leaf `findingkey.ts`, so the
 * renderer and the post-check read "posted" exactly as this parser does. */
export { normalizeDisposition, type FindingDisposition };

/** The axis a downgrade moved. `pass-validate`'s addendum requires a downgrade
 * to name one; the record carries it so the move is auditable. */
export type FindingAxis = "severity" | "confidence" | "reachability" | null;

function normalizeAxis(raw: unknown): FindingAxis {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v === "severity" || v === "confidence" || v === "reachability" ? v : null;
}

/**
 * The closed kill/downgrade vocabulary (`agents/pass-validate.md` plus the
 * `kill-vocabulary` addendum in `src/include.ts`). Recorded here for QUERIES
 * and for a parse note — never as a validator: the vocabulary grows with the
 * addenda, so an unknown word is noted, kept verbatim, and never a reason to
 * refuse the record.
 */
export const KILL_WORDS: readonly string[] = [
  // The validity vetoes are kill words too (folded onto `doubted` at parse).
  ...DOUBT_WORDS,
  "duplicate",
  "out-of-scope",
  "nit-out-of-delta",
  "below-bar",
  // Two of the three unreasoned shapes are kills.
  "nit-no-request",
  "self-narration",
  // Style from any lens but pass-style (the repo's own guide).
  "style-not-in-guide",
];

export const DOWNGRADE_WORDS: readonly string[] = [
  "security-demoted",
  "intent-over-cap",
  "design-over-cap",
  "style-over-cap",
  // A profile's `[lenses.<pass>] max_severity` ceiling
  // (src/lenstuning.ts PROFILE_CAP_WORD).
  "profile-over-cap",
  "inflated",
  "understated",
  "overreachable",
  "understated-reach",
  "feedback-shape",
  // A curated dont-raise lesson's demotion (src/include.ts
  // LESSON_VALIDATE_ADDENDUM), composed only while lessons are delivered.
  "lesson-shape",
  // The third unreasoned shape is a correction, not a kill: the tag is put back
  // inside the closed grammar and the finding survives.
  "tag-outside-grammar",
  // The mechanism is real, the claimed consequence was wrong — posted with
  // the true consequence instead of killed.
  "restated",
  // (validate-external-semantics) A claim resting on an external
  // tool's or library's behaviour that no read could settle — kept as a
  // question naming the assumption, never doubted away.
  "external-assumption",
];

/** `settled:<thread-id>` is a kill word with a payload, so it is matched by
 * prefix rather than listed. */
export function isKnownVocabularyWord(word: string): boolean {
  const w = word.trim().toLowerCase();
  if (w.startsWith("settled:")) return true;
  return (
    KILL_WORDS.includes(w) ||
    DOWNGRADE_WORDS.includes(w) ||
    (WITHHOLD_WORDS as readonly string[]).includes(w)
  );
}

/** One candidate finding and why it ended where it did. */
export interface FindingsRecordEntry {
  /** The session's own handle for the candidate (`f1`, …). Falls back to
   * `<lens>@<path>:<line>#<index>` (`findingRecordKey`) so every entry has a
   * stable per-round identity. */
  key: string;
  path: string | null;
  line: number | null;
  /** WHICH LENS RAISED IT. The one field with no tolerable default. */
  lens: string;
  tier: string | null;
  severity: string | null;
  confidence: number | null;
  reachability: string | null;
  kind: string | null;
  disposition: FindingDisposition;
  axis: FindingAxis;
  /** The closed-vocabulary kill or downgrade word, verbatim. */
  word: string | null;
  /** The reason in the reviewer's OWN WORDS — the thing a bare `below-bar`
   * never carried and the thing adjudication reads. */
  reason: string | null;
  /** The evidence chain behind the raise. */
  evidence: string | null;
  /** How it posted, when it posted: blocker / question / nit / check this. */
  posted_as: string | null;
  /** The round that first raised it, when this entry is about an older
   * finding (a concession, an escalation). Null = raised this round. */
  raised_in_round: number | null;
  thread_id: number | null;
  /** The posted comment's one-line title, as the session wrote it. Null when
   * the entry has none — never derived from the reason. */
  title: string | null;
}

/** Cap on a recorded title — a title is one line, never a body. */
const TITLE_CAP = 300;

export interface FindingsRecordFile {
  pr: number;
  round_no: number;
  head_sha: string | null;
  /** The per-round comment count — how many inline comments this round
   * actually posted. `bot_comments.round_no` is the registry's own answer;
   * this is the session's, and the two disagreeing is itself a signal. */
  comments_posted: number | null;
  findings: FindingsRecordEntry[];
  /** The statuses this round reported for PRIOR findings (the
   * daemon-rendered list's refs). Empty when the record carries none. */
  prior: PriorStatusEntry[];
}

/** The status a follow-up round reports for one prior finding.
 * Closed set; `unverifiable` is honest-unknown and counts as unresolved. */
export type PriorStatus = "fixed" | "open" | "conceded" | "settled" | "obsolete" | "unverifiable";

export const PRIOR_STATUSES: readonly PriorStatus[] = [
  "fixed",
  "open",
  "conceded",
  "settled",
  "obsolete",
  "unverifiable",
];

/** The statuses that take a prior finding off the next round's list. */
export const PRIOR_RESOLVED_STATUSES: readonly PriorStatus[] = [
  "fixed",
  "conceded",
  "settled",
  "obsolete",
];

const PRIOR_STATUS_ALIASES: Readonly<Record<string, PriorStatus>> = {
  "still-open": "open",
  still_open: "open",
  unresolved: "open",
  "refuted-and-conceded": "conceded",
  removed: "obsolete",
  gone: "obsolete",
  unknown: "unverifiable",
};

/** One entry of the record's top-level `prior` array, parsed. */
export interface PriorStatusEntry {
  /** The daemon-issued ref, `<round_no>:<finding_key>`, as given. */
  ref: string;
  round_no: number;
  finding_key: string;
  status: PriorStatus;
  evidence: string | null;
}

/** Fold a session-written prior status onto the closed set; `fixed@<sha>`
 * is `fixed` (the sha is returned so it can ride the evidence). Null = not
 * a status this parser knows. */
export function normalizePriorStatus(
  raw: unknown,
): { status: PriorStatus; sha: string | null } | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "-");
  const at = /^fixed@([0-9a-f]{4,40})$/.exec(v);
  if (at) return { status: "fixed", sha: at[1]! };
  if ((PRIOR_STATUSES as readonly string[]).includes(v))
    return { status: v as PriorStatus, sha: null };
  const alias = PRIOR_STATUS_ALIASES[v];
  return alias ? { status: alias, sha: null } : null;
}

/** Split a ref `<round_no>:<finding_key>` on its FIRST colon (a key may hold
 * colons — `recheck:<sha12>:<id>`). Null when it is not one. */
export function parsePriorRef(raw: unknown): { round_no: number; finding_key: string } | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/^r(?=\d)/i, "");
  const i = t.indexOf(":");
  if (i <= 0) return null;
  const head = t.slice(0, i);
  const key = t.slice(i + 1).trim();
  if (!/^\d+$/.test(head) || !key) return null;
  return { round_no: Number(head), finding_key: key };
}

/**
 * Parse the record's optional top-level `prior` array. Tolerant like the rest
 * of the record: an entry it cannot use is COUNTED in a note, never a reason
 * to reject the record. A ref naming this round or a later one is unusable
 * (a prior finding is from an earlier round). A ref reported twice keeps the
 * last report.
 */
function parsePriorArray(
  v: Record<string, unknown>,
  roundNo: number,
): { prior: PriorStatusEntry[]; notes: string[] } {
  const raw = v.prior ?? v.prior_findings;
  if (raw === undefined || raw === null) return { prior: [], notes: [] };
  if (!Array.isArray(raw)) return { prior: [], notes: ["`prior` is not an array (ignored)"] };
  const byRef = new Map<string, PriorStatusEntry>();
  let unusable = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      unusable++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const ref = parsePriorRef(e.ref ?? e.id);
    const st = normalizePriorStatus(e.status);
    if (!ref || !st || ref.round_no >= roundNo) {
      unusable++;
      continue;
    }
    const written = prose(e.evidence);
    const evidence =
      st.sha !== null && (written === null || !written.includes(st.sha))
        ? `fixed@${st.sha}${written ? ` — ${written}` : ""}`.slice(0, PROSE_CAP)
        : written;
    const canonical = `${ref.round_no}:${ref.finding_key}`;
    byRef.delete(canonical);
    byRef.set(canonical, {
      ref: canonical,
      round_no: ref.round_no,
      finding_key: ref.finding_key,
      status: st.status,
      evidence,
    });
  }
  return {
    prior: [...byRef.values()],
    notes:
      unusable > 0
        ? [
            `${unusable} prior-finding status entr${unusable === 1 ? "y" : "ies"} unusable (ignored)`,
          ]
        : [],
  };
}

export type FindingsRecordStatus =
  "ok" | "missing" | "unparseable" | "wrong_round" | "no_findings_array";

/**
 * What the round's POSTED output looked like against the output rules — a tag
 * inside the closed grammar, a nit that names a request, a doubted finding
 * never posted — plus a count of findings restated from earlier rounds.
 *
 * This is measurement over the record already collected — there is no
 * second table and no new mandate beyond one field (`request`) on nit entries.
 * Each list holds the offending entries' keys, so a query can go straight back
 * to the row.
 *
 * It is deliberately NOT a gate. The round is over by the time this runs, the
 * verdict is applied, and a record is never allowed to hold a PR open. The
 * enforcement lives where a finding is still preventable — the lens addendum
 * and the validator — and this is how we find out whether it worked.
 */
export interface RecordConformance {
  /** Posted with a `posted_as` outside the closed grammar (`[start here 3/5]`,
   * `[verified]`, "blocker, now fixed"). Such a finding escapes every consumer
   * keyed on the real tag — `resolveOwnReviewThread`'s refusals included. */
  ungrammatical_tags: string[];
  /** Posted as a nit while naming no request. A nit that asks for nothing is a
   * remark, not a finding. */
  nits_without_request: string[];
  /** Doubted AND carrying a `posted_as` — a finding the validator could not
   * stand behind that the session says it posted anyway (a doubt is never
   * posted on the PR). */
  doubted_posted: string[];
  /**
   * Posted this round while first raised in an earlier one. NOT automatically
   * a defect: a severity escalation across rounds is legitimate (blocking
   * late beats never). It is also where restated bookkeeping comes from, so
   * it is counted rather than judged, and never killed on this signal alone.
   */
  restated: string[];
}

export function isConformant(c: RecordConformance): boolean {
  return (
    c.ungrammatical_tags.length === 0 &&
    c.nits_without_request.length === 0 &&
    c.doubted_posted.length === 0
  );
}

export interface ParsedFindingsRecord {
  status: FindingsRecordStatus;
  record?: FindingsRecordFile;
  /** Shortfalls that did NOT reject the record (entries missing a lens, an
   * unknown vocabulary word, …). A note, never a rejection. */
  note?: string;
  /** The output-rule audit over the posted entries. Present whenever `record`
   * is. */
  conformance?: RecordConformance;
}

const num = recordNumber;
const str = recordString;

/** Cap on free prose the session writes, per field. The record is evidence,
 * not a transcript — an unbounded `evidence` blob would put a whole pass
 * output into every row. */
const PROSE_CAP = 4000;

function prose(val: unknown): string | null {
  const s = str(val);
  return s === null ? null : s.slice(0, PROSE_CAP);
}

/**
 * Parse and normalize one record file's already-JSON-decoded content.
 *
 * Tolerant like the verdict parser: digit-string numbers coerce,
 * `candidates` is accepted for `findings`, `name` for `lens`, and an entry the
 * parser cannot fully understand is kept with nulls plus a note rather than
 * dropped. The ONLY rejections are structural — not an object, the wrong
 * round, or no findings array at all — because those are the shapes where
 * there is nothing to record.
 */
export function parseFindingsRecord(
  raw: unknown,
  pr: number,
  roundNo: number,
): ParsedFindingsRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { status: "unparseable" };
  const v = raw as Record<string, unknown>;
  const filePr = num(v.pr);
  const fileRound = num(v.round_no);
  // A record for another round is worse than none: it would attribute one
  // round's reasoning to another. Rejected, and the nudge asks for this one.
  if ((filePr !== null && filePr !== pr) || (fileRound !== null && fileRound !== roundNo))
    return { status: "wrong_round" };
  const rawFindings = Array.isArray(v.findings)
    ? v.findings
    : Array.isArray(v.candidates)
      ? v.candidates
      : null;
  if (rawFindings === null) return { status: "no_findings_array" };

  const notes: string[] = [];
  let noLens = 0;
  let unknownDisposition = 0;
  let unknownWord = 0;
  const findings: FindingsRecordEntry[] = [];
  const conformance: RecordConformance = {
    ungrammatical_tags: [],
    nits_without_request: [],
    doubted_posted: [],
    restated: [],
  };
  for (const [i, entry] of rawFindings.entries()) {
    if (typeof entry !== "object" || entry === null) {
      noLens++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const lens = str(e.lens) ?? str(e.name) ?? "";
    if (!lens) noLens++;
    const path = str(e.path);
    const line = num(e.line);
    const word = str(e.word) ?? str(e.reason_word) ?? null;
    const written = normalizeDisposition(e.disposition);
    if (written === "unknown") unknownDisposition++;
    // A validity veto recorded as a kill is still a doubt.
    const disposition: FindingDisposition =
      written === "killed" && word !== null && DOUBT_WORDS.includes(word.trim().toLowerCase())
        ? "doubted"
        : written;
    if (word !== null && !isKnownVocabularyWord(word)) unknownWord++;
    // The ONE key rule (src/findingkey.ts) — the live render route stamps the
    // same key into the comment it posts, so the two always name one row.
    const key = findingRecordKey(e, i);
    const raisedIn = (() => {
      const r = num(e.raised_in_round);
      return r === null ? null : Math.trunc(r);
    })();
    // Output-rule audit — posted entries only: the three defects are about what
    // reaches the author, and a killed candidate reached nobody.
    if (disposition === "posted") {
      const postedAs = str(e.posted_as);
      if (postedAs !== null && !isSanctionedTag(postedAs)) conformance.ungrammatical_tags.push(key);
      const bare = bareTag(postedAs);
      // `request` is the field the nit rule asks a lens for: the concrete
      // change the nit asks for. Its ABSENCE is the defect — a nit that names
      // no change is a remark. Alternate spellings are accepted, as everywhere
      // else in this parser.
      const request = str(e.request) ?? str(e.ask) ?? str(e.remedy);
      if (bare === "nit" && request === null) conformance.nits_without_request.push(key);
      if (raisedIn !== null && raisedIn < roundNo) conformance.restated.push(key);
    }
    if (disposition === "doubted" && str(e.posted_as) !== null)
      conformance.doubted_posted.push(key);
    findings.push({
      key,
      path,
      line: line === null ? null : Math.trunc(line),
      lens,
      tier: str(e.tier),
      severity: str(e.severity),
      confidence: num(e.confidence),
      reachability: str(e.reachability),
      kind: str(e.kind),
      disposition,
      axis: normalizeAxis(e.axis),
      word,
      reason: prose(e.reason),
      evidence: prose(e.evidence),
      posted_as: str(e.posted_as),
      raised_in_round: raisedIn,
      thread_id: (() => {
        const t = num(e.thread_id);
        return t === null ? null : Math.trunc(t);
      })(),
      title: (() => {
        const t = str(e.title);
        return t === null ? null : t.replace(/\s+/g, " ").slice(0, TITLE_CAP);
      })(),
    });
  }
  if (noLens > 0) notes.push(`${noLens} entr${noLens === 1 ? "y" : "ies"} without a lens`);
  if (unknownDisposition > 0) notes.push(`${unknownDisposition} unrecognised disposition(s)`);
  if (unknownWord > 0) notes.push(`${unknownWord} word(s) outside the closed vocabulary`);
  if (conformance.ungrammatical_tags.length > 0)
    notes.push(
      `${conformance.ungrammatical_tags.length} posted finding(s) tagged outside the grammar`,
    );
  if (conformance.nits_without_request.length > 0)
    notes.push(`${conformance.nits_without_request.length} posted nit(s) asking for nothing`);
  if (conformance.doubted_posted.length > 0)
    notes.push(`${conformance.doubted_posted.length} doubted finding(s) marked as posted`);

  const priorParsed = parsePriorArray(v, roundNo);
  notes.push(...priorParsed.notes);
  const comments = num(v.comments_posted) ?? num(v.posted_comments);
  return {
    status: "ok",
    conformance,
    record: {
      pr,
      round_no: roundNo,
      head_sha: str(v.head_sha),
      comments_posted: comments === null ? null : Math.trunc(comments),
      findings,
      prior: priorParsed.prior,
    },
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}

/** Read + parse the record file. A missing/unreadable file is `missing`, an
 * undecodable one `unparseable` — enforcement is identical either way; the
 * distinction is for the record. */
export function readFindingsRecord(
  path: string,
  pr: number,
  roundNo: number,
): ParsedFindingsRecord {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { status: "missing" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { status: "unparseable" };
  }
  return parseFindingsRecord(decoded, pr, roundNo);
}

/** `<root>/state/findings/pr-<n>-round-<k>.json` — the pinned path, same
 * discipline as the verdict file and the round's other scratch paths. */
export function findingsRecordFile(pr: number, roundNo: number): string {
  return `pr-${pr}-round-${roundNo}.json`;
}

export function findingsRecordPath(findingsDir: string, pr: number, roundNo: number): string {
  return join(findingsDir, findingsRecordFile(pr, roundNo));
}

/**
 * The re-nudge wake. Bookkeeping-only and explicitly so: it arrives OUTSIDE a
 * round, after the verdict has already landed, and the session must not
 * mistake it for review work — no passes, no posting, no verdict file.
 *
 * It names the pinned scratch paths on purpose: the conversation has been
 * compacted by the time this arrives, but the pass outputs and the review body
 * are still on disk, so the record can be reconstructed from artifacts rather
 * than from memory.
 */
export function findingsRecordWake(pr: number, roundNo: number, relPath: string): string {
  return [
    `FINDINGS RECORD MISSING — PR #${pr} round ${roundNo}`,
    `The round is over and its verdict has been applied, but ${relPath} is missing or unreadable.`,
    "Write ONLY that file now, in this conversation: one entry per candidate finding this round produced — posted, killed, doubted, downgraded, merged, folded, withheld or conceded — each with its lens, severity, confidence, reachability, the closed-vocabulary kill/downgrade word, and the reason in your own words. On a POSTED entry also give `posted_as` (one of the sanctioned tags), and on a posted nit the `request` — the concrete change it asked for.",
    `Reconstruct it from the artifacts still on disk: state/pr-${pr}-round-${roundNo}-passes/, state/pr-${pr}-round-${roundNo}-review.md and state/pr-${pr}-round-${roundNo}-comments.json. Record only what those artifacts support — an honest partial record beats an invented complete one.`,
    "Do NOT do any review work, do NOT run passes, do NOT post anything to GitHub, and do NOT write a verdict file — this is a bookkeeping write only. You will not be asked again.",
  ].join("\n");
}

export interface FindingsCheckDeps {
  store: StateStore;
  /** Where the record lives — daemon.ts passes `<root>/state/findings`. */
  findingsDir: string;
  /** SessionHooks.inject — rides wakeOrHold, so a check that somehow lands
   * mid-round holds rather than interleaving (rule 9). */
  inject: (pr: number, message: string) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
  /**
   * Told every time a round's findings record LANDS in `round_findings`: the
   * lesson shadow ledger marks the round's posted
   * findings a selected dont-raise lesson would have touched
   * (src/lessonshadow.ts). Runs after `findings_recorded`; must not throw —
   * a throw is logged and swallowed, the record stands either way.
   */
  onRecorded?: (target: { pr: number; roundNo: number; roundId: number | null }) => void;
}

export interface FindingsCheckTarget {
  pr: number;
  roundNo: number;
  /** The round row the parsed entries hang off. Null ⇒ rows are still stored,
   * attributed by (pr, round_no) alone. */
  roundId: number | null;
  headSha: string;
  /** The round's PLANNED lenses (`rounds.lenses`). The add protocol lets the
   * main pi run a lens that appears in no plan, so the executed set is NOT
   * assumed equal to the plan: a lens outside this list is stored with
   * `unplanned = 1` rather than dropped or treated as an error. */
  planned: readonly string[];
}

export type FindingsCheckResult = "recorded" | "nudged" | "already_nudged";

/**
 * The enforcement step. Parsed ⇒ rows are written and the per-round comment
 * count lands on the round. Otherwise: `logAnomaly("findings_record_missing")`
 * EVERY time (the durable audit trail), plus at most ONE nudge per round.
 *
 * The once-mark is stamped BEFORE the inject, so no failure mode — a throwing
 * inject, a crash between the two, a second sweep of the same round — can ever
 * nudge twice. The safety direction is "never a loop"; the wake is best-effort
 * on top of a durable anomaly row.
 */
export async function enforceFindingsRecord(
  deps: FindingsCheckDeps,
  target: FindingsCheckTarget,
): Promise<FindingsCheckResult> {
  const { store, log } = deps;
  const { pr, roundNo, headSha, planned } = target;
  const path = findingsRecordPath(deps.findingsDir, pr, roundNo);
  const parsed = readFindingsRecord(path, pr, roundNo);

  if (parsed.status === "ok" && parsed.record) {
    ingestFindingsRecord(deps, target, parsed, parsed.record);
    return "recorded";
  }

  const detail = `findings record ${parsed.status} at ${path}`;
  log?.(`findings: #${pr} round ${roundNo} record ${parsed.status}`, { path });

  const key = `round-${roundNo}`;
  if (store.findingsNudgeSent(pr, key)) {
    // Still missing AFTER its one nudge: the session ignored it. A distinct,
    // WAKE-grade kind (anomalies.ts) — first detection stays quiet, because
    // the nudge itself is the response.
    store.logAnomaly("findings_record_unresolved", pr, roundNo, detail);
    store.logEvent("findings_record_repeat", pr, { round_no: roundNo, status: parsed.status });
    return "already_nudged";
  }
  store.logAnomaly("findings_record_missing", pr, roundNo, detail);
  // The mark carries what `ingestRepairedFindingsRecords` needs to store the
  // record the nudge asks for once it lands.
  store.recordFindingsNudge(pr, key, {
    round_no: roundNo,
    round_id: target.roundId,
    head_sha: headSha,
    planned: [...planned],
    status: parsed.status,
  });
  await wakeOrHold(
    { store, inject: deps.inject, ...(log ? { log } : {}) },
    pr,
    findingsRecordWake(pr, roundNo, `state/findings/${findingsRecordFile(pr, roundNo)}`),
    "findings_record_missing",
  );
  return "nudged";
}

/** How long after its nudge a missing record is still looked for. */
export const FINDINGS_REPAIR_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * Store the records the missing-record nudge asked for. The round's tail
 * checks once and nudges once; the reconstructed file lands later, when no
 * round tail is left to read it. So every sweep re-reads the record of each
 * round nudged within `FINDINGS_REPAIR_WINDOW_MS` that has no
 * `findings_recorded` event yet, and stores a record that now parses exactly
 * as the tail would have — rows, comment count, prior reports, the
 * `findings_recorded` event and `onRecorded`. A record still missing is left
 * alone: no second nudge and no further anomaly. Returns how many it stored.
 */
export function ingestRepairedFindingsRecords(
  deps: Pick<FindingsCheckDeps, "store" | "findingsDir" | "log" | "onRecorded">,
  now: Date,
): number {
  const { store } = deps;
  const since = new Date(now.getTime() - FINDINGS_REPAIR_WINDOW_MS).toISOString();
  const nudges = store.db
    .prepare(
      "SELECT pr, payload FROM events WHERE kind = 'findings_record_nudged' AND ts >= ? ORDER BY id",
    )
    .all(since) as Array<{ pr: number | null; payload: string | null }>;
  const recorded = store.db.prepare(
    "SELECT 1 FROM events WHERE kind = 'findings_recorded' AND pr = ? AND json_extract(payload, '$.round_no') = ? LIMIT 1",
  );
  const roundRow = store.db.prepare(
    "SELECT id, lenses, head_sha FROM rounds WHERE pr = ? AND round_no = ? ORDER BY id DESC LIMIT 1",
  );
  let stored = 0;
  for (const n of nudges) {
    if (n.pr === null || !n.payload) continue;
    let mark: { round_no?: unknown; round_id?: unknown; head_sha?: unknown; planned?: unknown };
    try {
      mark = JSON.parse(n.payload) as typeof mark;
    } catch {
      continue;
    }
    const roundNo = typeof mark.round_no === "number" ? mark.round_no : null;
    if (roundNo === null || recorded.get(n.pr, roundNo) !== undefined) continue;
    const parsed = readFindingsRecord(
      findingsRecordPath(deps.findingsDir, n.pr, roundNo),
      n.pr,
      roundNo,
    );
    if (parsed.status !== "ok" || !parsed.record) continue;
    // A mark written before it carried the round's identity: the round row.
    const round = roundRow.get(n.pr, roundNo) as
      { id: number; lenses: string | null; head_sha: string | null } | undefined;
    const planned = Array.isArray(mark.planned)
      ? mark.planned.filter((l): l is string => typeof l === "string")
      : (round?.lenses ?? "").split(",").filter(Boolean);
    ingestFindingsRecord(
      deps,
      {
        pr: n.pr,
        roundNo,
        roundId: typeof mark.round_id === "number" ? mark.round_id : (round?.id ?? null),
        headSha: typeof mark.head_sha === "string" ? mark.head_sha : (round?.head_sha ?? ""),
        planned,
      },
      parsed,
      parsed.record,
    );
    deps.log?.(`findings: #${n.pr} round ${roundNo} record arrived after its nudge — stored`);
    stored++;
  }
  return stored;
}

/** Store one parsed record: its rows, the round's comment count, the prior
 * reports, the `findings_recorded` event, `onRecorded`, and the output-rule
 * audit. */
function ingestFindingsRecord(
  deps: Pick<FindingsCheckDeps, "store" | "log" | "onRecorded">,
  target: FindingsCheckTarget,
  parsed: ParsedFindingsRecord,
  record: FindingsRecordFile,
): void {
  const { store, log } = deps;
  const { pr, roundNo, roundId, headSha, planned } = target;
  const stored = store.recordRoundFindings(
    { pr, round_id: roundId, round_no: roundNo, head_sha: record.head_sha ?? headSha },
    record.findings,
    planned,
  );
  if (record.comments_posted !== null && roundId !== null)
    store.recordRoundComments(roundId, record.comments_posted);
  // The statuses this round reported for prior findings. Stored
  // beside the listing the daemon made at order build; the next round's
  // list drops what a later report resolved.
  const priorReported =
    record.prior.length > 0
      ? store.recordPriorReports(pr, roundNo, record.head_sha ?? headSha, record.prior)
      : 0;
  store.logEvent("findings_recorded", pr, {
    round_id: roundId,
    round_no: roundNo,
    entries: stored,
    comments_posted: record.comments_posted,
    ...(priorReported > 0 ? { prior_reported: priorReported } : {}),
    ...(parsed.note ? { note: parsed.note } : {}),
  });
  try {
    deps.onRecorded?.({ pr, roundNo, roundId });
  } catch (err) {
    log?.(`findings: #${pr} round ${roundNo} onRecorded hook threw (ignored)`, err);
  }
  // The round's posted output against the three output rules. A quiet
  // anomaly (anomalies.ts wakes nobody for this kind) — a durable, queryable
  // row is the point, and no round is ever held open for it.
  const c = parsed.conformance;
  if (c) {
    store.logEvent("findings_conformance", pr, {
      round_no: roundNo,
      ungrammatical_tags: c.ungrammatical_tags.length,
      nits_without_request: c.nits_without_request.length,
      doubted_posted: c.doubted_posted.length,
      restated: c.restated.length,
    });
    if (!isConformant(c)) {
      store.logAnomaly(
        "review_output_unreasoned",
        pr,
        roundNo,
        `posted output outside the output rules: ${c.ungrammatical_tags.length} tag(s) outside the grammar ` +
          `(${c.ungrammatical_tags.join(", ")}), ${c.nits_without_request.length} nit(s) asking for nothing ` +
          `(${c.nits_without_request.join(", ")})` +
          (c.doubted_posted.length > 0
            ? `, ${c.doubted_posted.length} doubted finding(s) posted (${c.doubted_posted.join(", ")})`
            : ""),
      );
    }
  }
  log?.(
    `findings: #${pr} round ${roundNo} recorded ${stored} entr${stored === 1 ? "y" : "ies"}` +
      (parsed.note ? ` (${parsed.note})` : ""),
  );
}
