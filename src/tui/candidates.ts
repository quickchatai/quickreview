// The durable candidate list behind the `survey` skill.
//
// The survey answers *"anything worth looking at?"*. It does NOT judge — that
// is `adjudicate`'s job, and the two must not blur. Everything in this module
// is detection, ordering and durability; nothing here reaches a verdict about
// whether the review was right.
//
// Four properties, all load-bearing:
//
//  1. **The list does not expire.** There is no TTL here, no rolling window, no
//     retention sweep, and none may be added. A candidate not worked today is
//     still on the list next week: `mergeCandidates` only ever inserts or
//     updates, and the only thing that takes an entry out of the open list is a
//     recorded adjudication (and even then the row stays in the file). The
//     event feed's horizon is about a day; the reviews worth adjudicating are
//     usually older, which is the whole reason this file exists rather than the
//     companion re-reading `/feed/events.jsonl`.
//
//  2. **Worst-first, grouped by family.** A flat worst-first list buries a rare
//     disagreement under a pile of long re-blocks — and since most reviews
//     deviate from the perfect path, the rare families are the informative
//     ones. Groups come out in
//     `FAMILY_ORDER`, highest-signal first; inside a group it is severity
//     descending, then PR number.
//
//  3. **The empty answer reports what was checked.** Every family appears in
//     `families` on every sweep, with what it scanned and — when its source is
//     not reachable from here — the named gap. Never silence, never a
//     consolation candidate: the owner has to be able to tell it actually looked.
//
//  4. **Derivation is local and costs no VM read.** Round facts come from the
//     round manifests the evidence copier already copied down; PR facts come
//     from the poll snapshot the TUI already holds. The three comment-derived
//     families are fully implemented over `CapturedComment` and wired to
//     an empty source today, with the transport gap stated in the family
//     report rather than hidden.
//
// The file lands in the evidence dir, so the companion reads it at
// `/evidence/candidates.json` over the existing read-only mount — no new mount,
// no new channel, and the companion cannot write to it. Judged-ness therefore
// does not come back through a write from the companion: it is read out of the
// `#adjudication` memory entries `adjudicate` already mandates. One record, one
// direction.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CapturedComment } from "../capture.js";
import { parseEventTags } from "../memory/eventtags.js";
import { normalizeTag } from "../memory/store.js";
import type { StatusSnapshot } from "../state.js";
import { MANIFEST_NAME, prSignature, type RoundManifest, type WhyRound } from "./evidence.js";

// ---- the families ------------------------------------------------------------

/**
 * The seven candidate families. Ordered as they are reported:
 * highest-signal and rarest first, so a single explicit complaint is never
 * buried under a pile of long re-blocks.
 */
export const FAMILY_ORDER = [
  "feedback-tag",
  "disagreement",
  "dismissed",
  "no-verdict",
  "repeat-blocks",
  "repeat-approvals",
  "long-review",
] as const;
export type CandidateFamily = (typeof FAMILY_ORDER)[number];

export const FAMILY_TITLE: Record<CandidateFamily, string> = {
  "feedback-tag": "Explicit [feedback]",
  disagreement: "Human and bot disagreed",
  dismissed: "The review was dismissed",
  "no-verdict": "Rounds that produced no verdict",
  "repeat-blocks": "Blocked round after round",
  "repeat-approvals": "Approved more than once",
  "long-review": "Sheer length",
};

/** What each family is evidence OF — carried into the rendered survey so the
 * companion never has to remember why a family exists. */
export const FAMILY_WHY: Record<CandidateFamily, string> = {
  "feedback-tag": "a human said so, in words, on the PR — the highest-confidence family",
  disagreement:
    "a human approved where the bot blocked, or blocked where the bot approved (the false-negative direction)",
  dismissed: "the author threw the bot's review away rather than answering it",
  "no-verdict": "the round died — overdue, malformed, orphaned or cancelled — and nobody was told",
  "repeat-blocks": "the same PR re-blocked round after round; the treadmill, not a fix cycle",
  "repeat-approvals": "approved, then approved again; the recheck forbids this, so watch it die",
  "long-review": "ten rounds or more, whatever the pattern",
};

/**
 * Thresholds. Deliberately constants and not `config.toml` knobs: these are not
 * tuning dials but the definitions of the families themselves, and a knob would
 * invite making the survey quieter when it got noisy — which is the one failure
 * mode a survey cannot have.
 */
export const LONG_REVIEW_ROUNDS = 10;
/**
 * Three consecutive REQUEST_CHANGES rounds, not two.
 *
 * **A block the author accepted and fixed is the review working**, not a
 * deviation. Block → fix → block is one fix cycle and stays off the list;
 * block → fix → block → fix → block is a treadmill.
 */
export const REPEAT_BLOCK_ROUNDS = 3;
export const REPEAT_APPROVAL_ROUNDS = 2;

// ---- the facts a sweep works from --------------------------------------------

/** One round, as much of it as the local record carries. */
export interface RoundFact {
  round_no: number;
  status: string;
  verdict: string | null;
  round_type?: string | null;
  finished_at?: string | null;
}

/** Behavioural signals that are not comments — the `feedback_signals` ledger kinds. Supplied
 * as plain strings so a new kind needs no change here. */
export interface PrSignal {
  kind: string;
  at?: string | null;
}

/** Everything the detector is allowed to look at for one PR. */
export interface PrFacts {
  pr: number;
  state: string;
  title?: string;
  author?: string;
  /** Cheap "has anything changed" key — `prSignature`, shared with the evidence copier. */
  signature: string;
  /** Rounds with a local record. May be shorter than the daemon's count; the
   * shortfall is reported as coverage, never silently treated as "no rounds". */
  rounds: RoundFact[];
  /** Rounds the daemon says exist, when known. */
  rounds_reported?: number;
  /** Captured human comments for this PR, when a transport supplies
   * them. Empty is normal today and is reported as a gap, not as "clean". */
  comments: CapturedComment[];
  signals: PrSignal[];
}

// ---- detection ---------------------------------------------------------------

/** One deviation found on one PR. Pre-durability: no identity, no history. */
export interface Detected {
  family: CandidateFamily;
  pr: number;
  /** Worst-first key inside the family. Bigger is worse. */
  severity: number;
  headline: string;
  detail: string[];
}

const BLOCK = "REQUEST_CHANGES";
const APPROVE = "APPROVE";

/** Statuses that mean the round ended without deciding anything. */
const DEAD_STATUSES = new Set(["expired", "overdue", "orphaned", "cancelled", "failed"]);

function verdictOf(r: RoundFact): string {
  return (r.verdict ?? "").trim().toUpperCase();
}

/**
 * The one good path: triggered → APPROVE in one round → merged. Everything else
 * is the space the survey works in: name the good path, flag every departure.
 * Few PRs take it, so it is a carve-out, not a filter.
 */
export function isPerfectPath(facts: PrFacts): boolean {
  if (facts.rounds.length !== 1) return false;
  // A short local record is not proof of one round: the daemon's count wins
  // when it says there were more.
  if ((facts.rounds_reported ?? 0) > 1) return false;
  const only = facts.rounds[0]!;
  if (verdictOf(only) !== APPROVE) return false;
  return facts.comments.every((c) => !c.tagged) && facts.signals.length === 0;
}

/** Longest run of consecutive blocking verdicts. */
function longestBlockRun(rounds: RoundFact[]): number {
  let best = 0;
  let run = 0;
  for (const r of rounds) {
    if (verdictOf(r) === BLOCK) {
      run += 1;
      best = Math.max(best, run);
    } else if (verdictOf(r) !== "") {
      run = 0;
    }
  }
  return best;
}

/**
 * Detect every deviation on one PR. Pure, and deliberately dumb: it counts
 * shapes and never asks whether the review was right. That question is
 * `adjudicate`'s, and answering it here would make the survey a judge.
 */
export function detectCandidates(facts: PrFacts): Detected[] {
  const out: Detected[] = [];
  if (isPerfectPath(facts)) return out;

  const tagged = facts.comments.filter((c) => c.tagged);
  if (tagged.length > 0) {
    out.push({
      family: "feedback-tag",
      pr: facts.pr,
      severity: tagged.length,
      headline: `${tagged.length} [feedback] comment${tagged.length === 1 ? "" : "s"}`,
      detail: tagged.slice(0, 3).map((c) => `${c.author}: ${firstLine(c.body)}`),
    });
  }

  const disagreements = facts.signals.filter((s) => DISAGREEMENT_KINDS.has(s.kind));
  if (disagreements.length > 0) {
    out.push({
      family: "disagreement",
      pr: facts.pr,
      severity: disagreements.length,
      headline: `${disagreements.length} human/bot disagreement signal${disagreements.length === 1 ? "" : "s"}`,
      detail: disagreements.map((s) => `${s.kind}${s.at ? ` at ${s.at}` : ""}`),
    });
  }

  const dismissals = facts.signals.filter((s) => DISMISSAL_KINDS.has(s.kind));
  if (dismissals.length > 0) {
    out.push({
      family: "dismissed",
      pr: facts.pr,
      severity: dismissals.length,
      headline: `review dismissed (${dismissals.length}×)`,
      detail: dismissals.map((s) => `${s.kind}${s.at ? ` at ${s.at}` : ""}`),
    });
  }

  const dead = facts.rounds.filter(
    (r) => DEAD_STATUSES.has(r.status) || (r.status === "done" && verdictOf(r) === ""),
  );
  if (dead.length > 0) {
    out.push({
      family: "no-verdict",
      pr: facts.pr,
      severity: dead.length,
      headline: `${dead.length} round${dead.length === 1 ? "" : "s"} produced no verdict`,
      detail: dead.map(
        (r) => `round ${r.round_no}: ${r.status}${r.verdict ? ` / ${r.verdict}` : ""}`,
      ),
    });
  }

  const run = longestBlockRun(facts.rounds);
  if (run >= REPEAT_BLOCK_ROUNDS) {
    out.push({
      family: "repeat-blocks",
      pr: facts.pr,
      severity: run,
      headline: `${run} blocking rounds in a row`,
      detail: [
        `${facts.rounds.length} rounds with a local record; longest REQUEST_CHANGES run ${run}`,
      ],
    });
  }

  const approvals = facts.rounds.filter((r) => verdictOf(r) === APPROVE).length;
  if (approvals >= REPEAT_APPROVAL_ROUNDS) {
    out.push({
      family: "repeat-approvals",
      pr: facts.pr,
      severity: approvals,
      headline: `approved ${approvals} times`,
      detail: [
        `rounds ${facts.rounds
          .filter((r) => verdictOf(r) === APPROVE)
          .map((r) => r.round_no)
          .join(", ")}`,
      ],
    });
  }

  const total = Math.max(facts.rounds.length, facts.rounds_reported ?? 0);
  if (total >= LONG_REVIEW_ROUNDS) {
    out.push({
      family: "long-review",
      pr: facts.pr,
      severity: total,
      headline: `${total} rounds`,
      detail: [`${facts.rounds.length} of ${total} rounds have a local record`],
    });
  }
  return out;
}

/** The `feedback_signals` ledger kinds, split by which family they feed. Strings rather than
 * a union so a kind added daemon-side needs no change here. */
const DISAGREEMENT_KINDS = new Set([
  "posting_guard_downgraded",
  "merged_over_block",
  "human_approved_over_block",
  "human_blocked_after_approve",
]);
// `review_set_aside` is the feedback ledger's name for a dismissed bot review;
// `review_dismissed` is kept for a transport that forwards the GitHub word.
const DISMISSAL_KINDS = new Set([
  "review_set_aside",
  "review_dismissed",
  "bot_comment_deleted",
  "trigger_withdrawn",
]);

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

// ---- durability --------------------------------------------------------------

/** A candidate as it is STORED — identity, history, and judged-ness. */
export interface Candidate {
  /** Stable identity: one row per (family, PR). A family recurring on the same
   * PR updates in place rather than piling up duplicates. */
  key: string;
  pr: number;
  family: CandidateFamily;
  severity: number;
  headline: string;
  detail: string[];
  title?: string;
  author?: string;
  /** First sweep that saw it — never rewritten, so age is readable. */
  first_seen: string;
  /** Last sweep that re-derived it. NOT an expiry input: nothing reads this to
   * drop a row, and nothing may be added that does. */
  last_seen: string;
  /** The PR's signature as of the last sweep — the "did it move" input. */
  signature: string;
  /** When the sweep first saw `signature`. An adjudication older than this was
   * made against an earlier state of the PR. Absent on rows written before it
   * existed, and then read as `first_seen`. */
  signature_since?: string;
  /** Set when an `#adjudication` memory entry for this PR was observed, with
   * the PR signature at that moment. */
  judged: { at: string; signature: string } | null;
  /** Judged, and then the PR moved — back on the list, marked as a return. */
  returned: boolean;
}

/** What one family contributed to one sweep — present even when it found
 * nothing, which is the honest-empty-answer requirement in data form. */
export interface FamilyReport {
  family: CandidateFamily;
  title: string;
  why: string;
  /** How many PRs this family could actually look at. */
  scanned: number;
  found: number;
  /** Why this family cannot see everything it should, in one sentence. Absent
   * when the family's source is fully reachable from here. */
  gap?: string;
}

export interface CandidateList {
  version: 1;
  updated_at: string;
  /** Every family, every sweep. */
  families: FamilyReport[];
  candidates: Candidate[];
  coverage: { prs_scanned: number; rounds_with_local_record: number; rounds_reported: number };
}

export const CANDIDATES_FILE = "candidates.json";

/** What a read of the durable list found. `absent` and `unreadable` are
 * deliberately separate members: see `CandidateStore.read`. */
export type CandidateRead =
  | { state: "list"; list: CandidateList }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The store. Same shape as `EvidenceStore`: a plain file, written atomically
 * (temp + rename) so a reader never sees half a list. The sweeper reads it
 * when it has no list in hand — after a TUI restart, with no in-memory state
 * at all — and merges onto its own last list otherwise.
 */
export class CandidateStore {
  constructor(readonly dir: string) {}

  get path(): string {
    return join(this.dir, CANDIDATES_FILE);
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * The three answers a read of the durable list can give, kept apart.
   *
   * `absent` (no file yet) and `unreadable` (a file that exists and could not
   * be understood — truncated by a crash between the tmp write and the
   * rename, EACCES, EISDIR) are different facts, and the difference is the
   * whole point: `absent` means there is genuinely no candidate history,
   * `unreadable` means there is one and we cannot see it. A caller that folds
   * the second into the first rebuilds from an empty baseline and then saves
   * that truncation over the history.
   */
  read(): CandidateRead {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return { state: "absent" };
      return { state: "unreadable", reason: code ?? errText(err) };
    }
    try {
      const parsed = JSON.parse(raw) as CandidateList;
      if (!Array.isArray(parsed?.candidates))
        return { state: "unreadable", reason: "no candidates array" };
      return { state: "list", list: parsed };
    } catch (err) {
      return { state: "unreadable", reason: errText(err) };
    }
  }

  // There is deliberately no `load(): CandidateList | undefined` here: an
  // accessor that collapses `absent` and `unreadable` into one `undefined` is
  // what a merge-then-save reaches for, and it turns an unreadable file into
  // silent data loss. The only other reader of this file is the companion,
  // over the `/evidence:ro` mount, which parses the JSON itself.

  save(list: CandidateList): void {
    this.ensure();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

export function candidateKey(family: CandidateFamily, pr: number): string {
  return `${family}:pr-${pr}`;
}

/**
 * Fold this sweep's detections into the stored list.
 *
 * **This function is where "does not expire" lives.** There is no branch that
 * removes a row, and none that compares a timestamp against a horizon. A
 * candidate that stops being re-derived (its PR merged, the TUI went down,
 * nobody looked for a month) keeps its row, its `first_seen` and its place in
 * the ordering. If you are here to add a TTL, a rolling window or a
 * `MAX_CANDIDATES` cap, don't: the durability is the feature.
 *
 * `adjudications` maps PR → the timestamp of the newest `#adjudication` memory
 * entry for it. That is the only judged-ness input, and it flows one way:
 * `adjudicate` writes the entry, the sweep observes it, the row leaves the open
 * list. A row whose PR then moves comes back marked `returned`.
 */
export function mergeCandidates(
  previous: Candidate[],
  detected: Detected[],
  ctx: { now: string; facts: Map<number, PrFacts>; adjudications: Map<number, string> },
): Candidate[] {
  const byKey = new Map<string, Candidate>(previous.map((c) => [c.key, { ...c }]));

  for (const d of detected) {
    const key = candidateKey(d.family, d.pr);
    const f = ctx.facts.get(d.pr);
    const existing = byKey.get(key);
    if (existing) {
      existing.severity = d.severity;
      existing.headline = d.headline;
      existing.detail = d.detail;
      existing.last_seen = ctx.now;
      if (f) {
        existing.title = f.title;
        existing.author = f.author;
      }
    } else {
      byKey.set(key, {
        key,
        pr: d.pr,
        family: d.family,
        severity: d.severity,
        headline: d.headline,
        detail: d.detail,
        title: f?.title,
        author: f?.author,
        first_seen: ctx.now,
        last_seen: ctx.now,
        signature: f?.signature ?? "",
        signature_since: ctx.now,
        judged: null,
        returned: false,
      });
    }
  }

  // A PR whose signature changed but which produced no detection this sweep
  // still gets its signature refreshed — that is what lets a judged row notice
  // its PR moved even when the deviation itself is unchanged.
  //
  // An adjudication judges only what existed when it was made: one older than
  // the row itself is about something else (another family, an earlier state)
  // and never takes a candidate nobody looked at off the list; one older than
  // the PR's current signature — a receipt observed late — is bound to the
  // earlier state it was made against, so the row comes back as `returned`.
  for (const c of byKey.values()) {
    const f = ctx.facts.get(c.pr);
    if (f && f.signature !== c.signature) {
      c.signature = f.signature;
      c.signature_since = ctx.now;
    }
    const adjudicated = ctx.adjudications.get(c.pr);
    if (
      adjudicated &&
      (!c.judged || adjudicated > c.judged.at) &&
      instant(adjudicated) >= instant(c.first_seen)
    ) {
      const since = c.signature_since ?? c.first_seen;
      c.judged = {
        at: adjudicated,
        signature: instant(adjudicated) >= instant(since) ? c.signature : `(before ${since})`,
      };
    }
    c.returned = c.judged !== null && c.signature !== c.judged.signature;
  }

  return [...byKey.values()];
}

/** A timestamp as epoch ms. Memory stamps are UTC `YYYY-MM-DD HH:MM:SS`
 * (no zone), sweep stamps ISO — compared as strings, a space sorts before
 * `T` and a same-day comparison would lie. Unparseable ⇒ -Infinity, so an
 * unreadable receipt never judges anything (the safe direction: re-offer). */
function instant(ts: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(ts)
    ? `${ts.replace(" ", "T")}Z`
    : ts;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Everything still worth offering: never judged, or judged and then moved. */
export function openCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => c.judged === null || c.returned);
}

export interface CandidateGroup {
  family: CandidateFamily;
  title: string;
  why: string;
  candidates: Candidate[];
}

/**
 * Worst-first, grouped by family. Groups come out in `FAMILY_ORDER` (rarest and
 * highest-signal first) and only when non-empty; inside a group it is severity
 * descending, then PR number ascending so the order is stable sweep to sweep.
 */
export function groupCandidates(candidates: Candidate[]): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  for (const family of FAMILY_ORDER) {
    const rows = candidates
      .filter((c) => c.family === family)
      .sort((a, b) => b.severity - a.severity || a.pr - b.pr);
    if (rows.length > 0)
      groups.push({
        family,
        title: FAMILY_TITLE[family],
        why: FAMILY_WHY[family],
        candidates: rows,
      });
  }
  return groups;
}

/**
 * The survey as text. An empty result is NOT an empty string: it reports the
 * families checked, one line each, so the owner can tell it actually looked.
 */
export function renderSurvey(list: CandidateList): string {
  const open = openCandidates(list.candidates);
  const groups = groupCandidates(open);
  const lines: string[] = [
    `Candidate survey — ${list.updated_at} (${list.coverage.prs_scanned} PRs scanned)`,
  ];
  if (groups.length === 0) {
    lines.push("", "Nothing worth adjudicating. Families checked:");
    for (const f of list.families)
      lines.push(`  · ${f.title} — scanned ${f.scanned}, found 0${f.gap ? ` (${f.gap})` : ""}`);
    return lines.join("\n");
  }
  for (const g of groups) {
    lines.push("", `${g.title} — ${g.why}`);
    for (const c of g.candidates) {
      const marks = [c.returned ? "returned" : "", `since ${c.first_seen.slice(0, 10)}`]
        .filter(Boolean)
        .join(", ");
      lines.push(`  #${c.pr} ${c.headline} [${marks}]`);
      for (const d of c.detail) lines.push(`      ${d}`);
    }
  }
  const quiet = list.families.filter((f) => f.found === 0);
  if (quiet.length > 0) {
    lines.push("", "Also checked, nothing found:");
    for (const f of quiet) lines.push(`  · ${f.title}${f.gap ? ` (${f.gap})` : ""}`);
  }
  return lines.join("\n");
}

// ---- reading the local record ------------------------------------------------

/**
 * Round facts for one PR out of the evidence store. Manifest-only by
 * design: `manifest.json` is written last and atomically, so a dir with one is
 * a round that copied completely, and a half-copy is simply not counted.
 */
export function roundFactsFromEvidence(evidenceDir: string, pr: number): RoundFact[] {
  const dir = join(evidenceDir, `pr-${pr}`);
  if (!existsSync(dir)) return [];
  const out: RoundFact[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/^round-\d+$/.test(entry)) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, entry, MANIFEST_NAME), "utf8")) as RoundManifest;
      const round = m.round as WhyRound | undefined;
      if (!round || !Number.isInteger(round.round_no)) continue;
      out.push({
        round_no: round.round_no,
        status: String(round.status ?? ""),
        verdict: round.verdict ?? null,
        round_type: typeof round.round_type === "string" ? round.round_type : null,
        finished_at: round.finished_at ?? null,
      });
    } catch {
      // A missing or unreadable manifest is an uncopied round, not a fact about
      // the review — coverage reports the shortfall.
    }
  }
  return out.sort((a, b) => a.round_no - b.round_no);
}

/**
 * `#adjudication` entries → PR → newest timestamp. Header-only, the way
 * `src/memory/eventtags.ts` intends: the `pr=` value is read from the leading
 * `k=v` run, so quoted human text in the body can never mint one.
 */
export function adjudicationsFrom(
  entries: Array<{ ts: string; text: string; tags: string[] }>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const e of entries) {
    if (!e.tags.some((t) => normalizeTag(t) === "adjudication")) continue;
    const first = e.text.split("\n")[0] ?? "";
    const kv = parseEventTags(first);
    const pr = Number(kv.pr ?? "");
    if (!Number.isInteger(pr) || pr <= 0) continue;
    const prev = out.get(pr);
    if (!prev || e.ts > prev) out.set(pr, e.ts);
  }
  return out;
}

// ---- the sweep ---------------------------------------------------------------

export interface CandidateSweepDeps {
  /** Where the evidence copier put the round manifests (usually the same dir as the list). */
  evidenceDir: string;
  /** Captured human comments per PR, when a transport supplies them. */
  comments?: (pr: number) => CapturedComment[];
  /** Behavioural signals per PR, when a transport supplies them. */
  signals?: (pr: number) => PrSignal[];
  /** Newest `#adjudication` timestamp per PR. Absent ⇒ judged-ness is inert and
   * nothing ever leaves the open list, which is the safe direction. */
  adjudications?: () => Promise<Map<number, string>>;
  now?: () => Date;
  onNotice?: (text: string) => void;
}

/** Named once so the family report and the skill say the same thing. */
export const COMMENT_TRANSPORT_GAP =
  "no local copy of pr_comments — the daemon captures them into its SQLite on the VM and nothing brings them down yet";
export const SIGNAL_TRANSPORT_GAP =
  "no local copy of feedback_signals — the ledger lives in the daemon's SQLite on the VM";

/**
 * One pass over the poll snapshot, writing the durable list.
 *
 * Rides the TUI's existing poll, exactly like `EvidenceCopier`: no second
 * scheduler, re-entrant-safe, and it never throws — a TUI that cannot survey is
 * a TUI that must still paint. Unlike the copier it makes no remote call at
 * all: everything it reads is already on the owner's disk.
 */
export class CandidateSweeper {
  private busy = false;
  private lastAdjudications = new Map<number, string>();
  /** Per-PR round facts, keyed by the PR's snapshot signature — an unchanged
   * PR costs the 3-second poll zero manifest reads, since the reads are sync
   * fs work on the paint process. In-memory on purpose: a TUI restart simply
   * re-reads once. */
  private readonly roundsCache = new Map<number, { signature: string; rounds: RoundFact[] }>();
  /** The last list this sweeper produced, and its content fingerprint
   * (timestamps excluded) — when nothing material changed, the save is
   * skipped and the previous list returned, so the durable file is not
   * rewritten every 3 seconds. `last_seen`/`updated_at` therefore advance
   * only when something else about the list does; both are documented as
   * never being expiry inputs, so that is a cost of zero. */
  private lastList: CandidateList | undefined;
  private lastFingerprint: string | undefined;
  /** The reason last reported for an unreadable baseline, so a 3-second poll
   * says it once rather than 1,200 times an hour. Cleared the moment a read
   * succeeds, so a recurrence after a recovery is loud again. */
  private unreadableReported: string | undefined;

  constructor(
    readonly store: CandidateStore,
    private readonly deps: CandidateSweepDeps,
  ) {}

  get running(): boolean {
    return this.busy;
  }

  async sweep(snapshot: StatusSnapshot | undefined): Promise<CandidateList | undefined> {
    if (!snapshot || this.busy) return undefined;
    this.busy = true;
    try {
      if (this.deps.adjudications) {
        try {
          this.lastAdjudications = await this.deps.adjudications();
        } catch {
          // Memory unreachable: keep the last map. Judged-ness going stale
          // re-offers a settled item, which is recoverable; dropping the map
          // would do the same thing more loudly.
        }
      }
      return this.build(snapshot, this.lastAdjudications);
    } catch (err) {
      this.deps.onNotice?.(
        `survey: sweep failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  /**
   * The baseline this sweep merges onto: the in-memory list when we have one,
   * otherwise the durable file. `undefined` means the file exists and could
   * not be read — the sweep must then do nothing at all.
   *
   * Folding "unreadable" into "no candidates" would seed `mergeCandidates`
   * from an empty `previous`, dropping every candidate whose PR has since left
   * the snapshot, and the save would write that truncation over the history
   * the feature exists to keep.
   */
  private baseline(): Candidate[] | undefined {
    if (this.lastList !== undefined) return this.lastList.candidates;
    const read = this.store.read();
    if (read.state === "unreadable") {
      if (this.unreadableReported !== read.reason) {
        this.unreadableReported = read.reason;
        this.deps.onNotice?.(
          `survey: ${this.store.path} exists but cannot be read (${read.reason}) — standing down rather than ` +
            `overwriting the candidate history; move the file aside to rebuild from scratch`,
        );
      }
      return undefined;
    }
    this.unreadableReported = undefined;
    return read.state === "list" ? read.list.candidates : [];
  }

  private build(
    snapshot: StatusSnapshot,
    adjudications: Map<number, string>,
  ): CandidateList | undefined {
    // Read the baseline first: an unread one means this sweep neither merges
    // nor saves, and there is no point walking the manifests for it.
    const previous = this.baseline();
    if (previous === undefined) return undefined;
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const facts = new Map<number, PrFacts>();
    const detected: Detected[] = [];
    let roundsLocal = 0;
    let roundsReported = 0;

    for (const pr of [...snapshot.prs].sort((a, b) => a.number - b.number)) {
      const sig = prSignature(pr);
      const cached = this.roundsCache.get(pr.number);
      // Fresh cache = same signature AND a local record at least as long as
      // the daemon reports. The second half matters: the evidence copier
      // drains a backlog ROUNDS_PER_SWEEP at a time across ticks with no
      // signature move, so a signature-only key would freeze the shortfall.
      // (A cheap `existsSync` miss for a never-copied PR, a manifest re-read
      // only while genuinely short.) Both sides count the same thing: the
      // snapshot's `rounds` excludes `expired` rounds, so the local side must
      // too — or an expired manifest stands in for a reported round the
      // copier has not landed yet, and the shortfall freezes.
      const fresh =
        cached !== undefined &&
        cached.signature === sig &&
        reportedRounds(cached.rounds) >= (pr.rounds ?? 0);
      const rounds = fresh
        ? cached.rounds
        : roundFactsFromEvidence(this.deps.evidenceDir, pr.number);
      this.roundsCache.set(pr.number, { signature: sig, rounds });
      const f: PrFacts = {
        pr: pr.number,
        state: pr.state,
        title: pr.title,
        author: pr.author,
        signature: prSignature(pr),
        rounds,
        rounds_reported: pr.rounds ?? 0,
        comments: this.deps.comments?.(pr.number) ?? [],
        signals: this.deps.signals?.(pr.number) ?? [],
      };
      facts.set(pr.number, f);
      roundsLocal += reportedRounds(rounds);
      roundsReported += pr.rounds ?? 0;
      detected.push(...detectCandidates(f));
    }

    const candidates = mergeCandidates(previous, detected, { now, facts, adjudications });
    const open = openCandidates(candidates);
    const list: CandidateList = {
      version: 1,
      updated_at: now,
      families: FAMILY_ORDER.map((family) => ({
        family,
        title: FAMILY_TITLE[family],
        why: FAMILY_WHY[family],
        scanned: facts.size,
        found: open.filter((c) => c.family === family).length,
        gap: familyGap(family, this.deps),
      })),
      candidates,
      coverage: {
        prs_scanned: facts.size,
        rounds_with_local_record: roundsLocal,
        rounds_reported: roundsReported,
      },
    };
    // Unchanged content ⇒ no write: rewriting candidates.json every 3-second
    // poll is fs churn for a file whose durability is the point. Timestamps
    // are excluded from the comparison (they move every sweep by
    // construction); they advance on the next material change, and nothing
    // reads either as an expiry input.
    const fingerprint = listFingerprint(list);
    if (this.lastList !== undefined && fingerprint === this.lastFingerprint) return this.lastList;
    this.store.save(list);
    this.lastList = list;
    this.lastFingerprint = fingerprint;
    return list;
  }
}

/** Local rounds counted the way the daemon's snapshot counts them
 * (`buildStatusSnapshot`: every round that is not `expired`). */
function reportedRounds(rounds: RoundFact[]): number {
  return rounds.filter((r) => r.status !== "expired").length;
}

/** The list's content, timestamps excluded — the "did anything change" key
 * behind the sweep's save-skip. */
function listFingerprint(list: CandidateList): string {
  return JSON.stringify({
    families: list.families,
    coverage: list.coverage,
    candidates: list.candidates.map((c) => ({ ...c, first_seen: "", last_seen: "" })),
  });
}

function familyGap(family: CandidateFamily, deps: CandidateSweepDeps): string | undefined {
  if (family === "feedback-tag") return deps.comments ? undefined : COMMENT_TRANSPORT_GAP;
  if (family === "disagreement" || family === "dismissed")
    return deps.signals ? undefined : SIGNAL_TRANSPORT_GAP;
  return undefined;
}
