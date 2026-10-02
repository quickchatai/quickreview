// The durable reasoning record (deciding).
//
// WHAT THIS IS. `rounds.lenses` records the PLAN and `rounds.executed_passes`
// records COUNTS — three findings were killed on #5359 r1 and the database
// cannot say which, nor why. The kill log existed in 82 rounds of 105 with no
// schema and no reader; the raise-side candidates file existed in 3 of 105.
// The reasoning evaporated, and's adjudication doctrine,
// "how often the review backs down" metric and's per-round volume
// survey all need it. The owner chose the reopened findings telemetry under that
// name: a schema'd file the session writes, parsed by the daemon
// into queryable rows.
//
// THE SHAPE IS THE LEDGER PATTERN, DELIBERATELY. A prompt mandate
// alone does not stick (3 of 105). So the daemon parses the file after the
// round and, on missing/unparseable, emits a queryable anomaly plus EXACTLY
// ONE re-nudge through `wakeOrHold` telling the session to write only that
// record. The once-mark is persisted BEFORE the inject, so even a crashed
// inject can never become a nudge loop.
//
// A ROUND IS NEVER HELD OPEN FOR IT. This is a record, not a gate: the verdict
// has already been applied, the round row is already finished and the PR has
// already transitioned by the time any of this runs. A record that never
// arrives costs one anomaly row and one nudge, and nothing else — least of all
// a wedged PR (rule 9; the map has spent enough on wedges).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WITHHOLD_WORDS } from "./postingpolicy.js";
import { isSanctionedTag } from "./severity.js";
import type { StateStore } from "./state.js";
import { wakeOrHold } from "./wakes.js";

/**
 * What happened to a candidate finding. Closed set — the record is only
 * countable if the disposition is.
 *
 * - `posted` — it survived validation and went out on the PR (the RAISE side,
 *   the half at 3 of 105 and the half adjudication actually needs).
 * - `killed` / `downgraded` — the validator vetoed or moved it.
 * - `doubted` — the validator could not stand behind the CLAIM (`DOUBT_WORDS`:
 *   refuted, unverifiable, bad anchor).: a validity veto is a mark,
 *   not a deletion — kept here as "may not be valid", never posted on the PR,
 *   shown in the TUI for the operator to judge.
 * - `merged` / `folded` — merge-stage attrition: the same defect
 *   collapsed into another finding, or a different defect carried as a
 *   paragraph under one. Attrition here counts like a kill; it must never
 *   vanish silently.
 * - `withheld` — the session itself dropped it before the validator saw it,
 *   or the profile's `[posting]` policy kept a survivor off the PR (a word
 *   from `WITHHOLD_WORDS`: `over-budget`, `nits-off`, …) — kept, never posted.
 * - `conceded` — REFUTED AND CONCEDED: previously posted, the author refuted
 *   it and the reviewer accepted the refutation. This is the state that lets a
 *   later round tell "escalating an open finding" (legitimate — the owner,
 *   2026-08-19: blocking late beats never) from "resurrecting a settled one"
 *   (not legitimate). Nothing else in the system records it.
 */
export type FindingDisposition =
  | "posted"
  | "killed"
  | "doubted"
  | "downgraded"
  | "merged"
  | "folded"
  | "withheld"
  | "conceded"
  | "unknown";

const DISPOSITIONS: ReadonlySet<string> = new Set([
  "posted",
  "killed",
  "doubted",
  "downgraded",
  "merged",
  "folded",
  "withheld",
  "conceded",
]);

/** Spellings a session plausibly writes, folded onto the closed set. Tolerant
 * input, exactly like the verdict file's digit-string coercion — never a
 * rejection reason. */
const DISPOSITION_ALIASES: Readonly<Record<string, FindingDisposition>> = {
  post: "posted",
  survive: "posted",
  survived: "posted",
  kill: "killed",
  vetoed: "killed",
  doubt: "doubted",
  "may-not-be-valid": "doubted",
  downgrade: "downgraded",
  demoted: "downgraded",
  capped: "downgraded",
  merge: "merged",
  fold: "folded",
  withhold: "withheld",
  dropped: "withheld",
  concede: "conceded",
  "refuted-and-conceded": "conceded",
  refuted_and_conceded: "conceded",
};

/**
 * The kill words that are a doubt about the CLAIM itself — the
 * validator's validity vetoes, as opposed to a repeat, scope, bar or shape
 * kill. The validator lists these under DOUBTED (the
 * `validate-doubt-not-kill` addendum in src/include.ts); a `killed` entry
 * carrying one is folded onto `doubted` at parse time anyway, so a session
 * still on an older prompt cannot make a doubted finding vanish as a kill.
 */
export const DOUBT_WORDS: readonly string[] = ["refuted", "unverifiable", "bad-anchor"];

export function normalizeDisposition(raw: unknown): FindingDisposition {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (DISPOSITIONS.has(v)) return v as FindingDisposition;
  return DISPOSITION_ALIASES[v] ?? "unknown";
}

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
 * and for a parse note — never as a validator: recorded that the
 * vocabulary already grew once (`feedback-shape`, from the day
 * addendum) and will grow again, so an unknown word is noted, kept verbatim,
 * and never a reason to refuse the record.
 */
export const KILL_WORDS: readonly string[] = [
  "refuted",
  "unverifiable",
  "bad-anchor",
  "duplicate",
  "out-of-scope",
  "nit-out-of-delta",
  "below-bar",
  // two of the three unreasoned shapes are kills.
  "nit-no-request",
  "self-narration",
  // 2026-09-27 — style from any lens but pass-style (the repo's own guide).
  "style-not-in-guide",
];

export const DOWNGRADE_WORDS: readonly string[] = [
  "security-demoted",
  "intent-over-cap",
  "design-over-cap",
  "style-over-cap",
  // a profile's `[lenses.<pass>] max_severity` ceiling
  // (src/lenstuning.ts PROFILE_CAP_WORD).
  "profile-over-cap",
  "inflated",
  "understated",
  "overreachable",
  "understated-reach",
  "feedback-shape",
  // the third shape is a correction, not a kill: the tag is put back
  // inside the closed grammar and the finding survives.
  "tag-outside-grammar",
  // Benchmark 2026-09-26: the mechanism is real, the claimed consequence was
  // wrong — posted with the true consequence instead of killed.
  "restated",
  // 2026-10-02 (validate-external-semantics): a claim resting on an external
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
   * `<lens>@<path>:<line>` so every entry has a stable per-round identity. */
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
}

export interface FindingsRecordFile {
  pr: number;
  round_no: number;
  head_sha: string | null;
  /** The per-round comment count — how many inline comments this round
   * actually posted. `bot_comments.round_no` is the registry's own answer;
   * this is the session's, and the two disagreeing is itself a signal. */
  comments_posted: number | null;
  findings: FindingsRecordEntry[];
}

export type FindingsRecordStatus =
  "ok" | "missing" | "unparseable" | "wrong_round" | "no_findings_array";

/**
 * What the round's POSTED output looked like against the three rules
 * — and against: a doubted finding is never posted.
 *
 * This is measurement over the record already collects — there is no
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
   * remark, not a finding — 63.7% of them, at 449 characters each. */
  nits_without_request: string[];
  /** Doubted AND carrying a `posted_as` — a finding the validator could not
   * stand behind that the session says it posted anyway (a doubt is
   * never posted on the PR). */
  doubted_posted: string[];
  /**
   * Posted this round while first raised in an earlier one. NOT automatically
   * a defect: a severity escalation across rounds is ratified behaviour
   * (the owner, 2026-08-19 — blocking late beats never). It IS the population
   * that the 14.2% bookkeeping share comes out of, so it is counted rather
   * than judged, and never killed on this signal alone.
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
  /** The audit over the posted entries. Present whenever `record` is. */
  conformance?: RecordConformance;
}

function num(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val.trim())) return Number(val.trim());
  return null;
}

function str(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const t = val.trim();
  return t.length > 0 ? t : null;
}

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
 * Tolerant in exactly the direction: digit-string numbers coerce,
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
    // a validity veto recorded as a kill is still a doubt.
    const disposition: FindingDisposition =
      written === "killed" && word !== null && DOUBT_WORDS.includes(word.trim().toLowerCase())
        ? "doubted"
        : written;
    if (word !== null && !isKnownVocabularyWord(word)) unknownWord++;
    const key = str(e.id) ?? str(e.key) ?? `${lens || "?"}@${path ?? "?"}:${line ?? "?"}#${i}`;
    const raisedIn = (() => {
      const r = num(e.raised_in_round);
      return r === null ? null : Math.trunc(r);
    })();
    // audit — posted entries only: the three defects are about what
    // reaches the author, and a killed candidate reached nobody.
    if (disposition === "posted") {
      const postedAs = str(e.posted_as);
      if (postedAs !== null && !isSanctionedTag(postedAs)) conformance.ungrammatical_tags.push(key);
      const bare = (postedAs ?? "")
        .trim()
        .replace(/^\[|\]$/g, "")
        .trim()
        .toLowerCase();
      // `request` is the one new field asks a lens for: the concrete
      // change the nit asks for. Its ABSENCE is the defect — a nit that names
      // no change is a remark. Alternate spellings are accepted, as everywhere
      // else in this parser.
      const request = str(e.request) ?? str(e.ask) ?? str(e.remedy);
      if (bare === "nit" && request === null) conformance.nits_without_request.push(key);
      if (raisedIn !== null && raisedIn < roundNo) conformance.restated.push(key);
    }
    if (disposition === "doubted" && str(e.posted_as) !== null) conformance.doubted_posted.push(key);
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
   * mid-round holds rather than interleaving (rule 9 S4). */
  inject: (pr: number, message: string) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
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
  const { pr, roundNo, roundId, headSha, planned } = target;
  const path = findingsRecordPath(deps.findingsDir, pr, roundNo);
  const parsed = readFindingsRecord(path, pr, roundNo);

  if (parsed.status === "ok" && parsed.record) {
    const stored = store.recordRoundFindings(
      { pr, round_id: roundId, round_no: roundNo, head_sha: parsed.record.head_sha ?? headSha },
      parsed.record.findings,
      planned,
    );
    if (parsed.record.comments_posted !== null && roundId !== null)
      store.recordRoundComments(roundId, parsed.record.comments_posted);
    store.logEvent("findings_recorded", pr, {
      round_id: roundId,
      round_no: roundNo,
      entries: stored,
      comments_posted: parsed.record.comments_posted,
      ...(parsed.note ? { note: parsed.note } : {}),
    });
    // the round's posted output against the three rules. A quiet
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
          `posted output outside the rules: ${c.ungrammatical_tags.length} tag(s) outside the grammar ` +
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
  store.recordFindingsNudge(pr, key, {
    round_no: roundNo,
    head_sha: headSha,
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
