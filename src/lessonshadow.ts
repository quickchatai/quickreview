// The SHADOW LEDGER's half that reads outcomes (S9a): which posted
// findings a delivered dont-raise lesson WOULD have touched, and what humans
// then did with those findings.
//
// WHY. R2 gives a curated dont-raise lesson authority over the validator: a
// finding matching the lesson's lens, class and path precondition may be
// DEMOTED (`lesson-shape`; P0 always survives, a P1 on solid evidence too).
// That authority is not switched on until the owner has read the evidence
// this module produces in shadow: for every lesson, the findings it would
// have demoted that humans then FIXED (harm — a real finding hidden), that
// humans refuted or set aside (help), and the ones still unknown.
//
// THE MATCHER is deterministic and runs on what state.db already holds — the
// round's recorded selection (src/lessonledger.ts) and its findings record
// (round_findings) — at the moment the findings record lands
// (src/findingsrecord.ts `onRecorded`), and again when a selection is
// recorded after its round's findings (it never is in practice: the
// selection runs at dispatch). A posted finding is MARKED by a dont-raise
// lesson selected for the round (for any discovery row or the validator)
// when all three preconditions hold:
//   lens  — the finding's canonical lens ids share one with the lesson's
//           `lens=` (or the lesson names `pass-validate`, which judges every
//           finding);
//   class — the finding's class (`<lens>.<kind>`, the learner's own
//           `findingClass`) equals the lesson's `class=`, or one is a
//           dot-prefix of the other (`baseline` covers `baseline.authz`) —
//           the learner's coverage rule;
//   path  — one of the lesson's `paths=` globs matches the finding's path
//           (no `paths=`, no precondition).
// A dont-raise lesson with no class (the legacy prose shapes) cannot be
// matched: its class precondition cannot be checked, so the report counts it
// as UNMEASURABLE rather than guessing it onto findings by lens alone.
//
// THE REPORT (`qcr lessons shadow-report [--days N]`) joins the marks with
// S6's `finding_outcomes` (src/outcomes.ts) and its `review_outcomes`:
//   harm      — fate `fixed`;
//   help      — fate `refuted_conceded`, or (no fate about the finding
//               itself — none, `unknown` or `open_at_close`) the review that
//               carried it was set aside: a WHOLE-REVIEW signal, shown apart;
//   upheld    — `upheld_after_reply` (a human pushed back, the bot held);
//   ignored   — `open_at_close`;
//   unknown   — no fate yet, or no outcome row;
//   exempt    — a P0: R2 never demotes one, whatever the lesson says.
// A finding is counted ONCE however many rounds posted it: marks on the
// postings of one `carried_to` chain (S6) collapse onto its root, which
// carries the chain's fate.
// …per lesson and per lens, plus the look-for lessons whose class later
// showed a human-raised miss (the learner's `recall` candidates — never the
// reviewer's own recheck reversals).
//
// Nothing here writes memory or GitHub, and nothing here is on a round's path.
import type { MemoryDelivery } from "./config.js";
import { globMatcher } from "./glob.js";
import { findingClass, lensIdsOf } from "./learner/miner.js";
import type { LessonLedger, ShadowMark, ShadowMarkRow, StoredSelection } from "./lessonledger.js";
import { VALIDATOR_LENS, type RoleSelection, type SelectedLesson } from "./memory/selection.js";
import type { LessonDeliveryStatus } from "./memory/shadowstatus.js";
import type { RoundFindingRow, StateStore } from "./state.js";

/** The slice of a recorded finding the matcher reads. */
export type MatchFinding = Pick<
  RoundFindingRow,
  "finding_key" | "path" | "lens" | "lens_ids" | "kind" | "severity" | "disposition"
>;

/** `a` and `b` name the same class, or one refines the other. */
export function classesRelated(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function safeMatcher(globs: readonly string[]): (p: string) => boolean {
  try {
    return globMatcher(globs);
  } catch {
    return () => false;
  }
}

/** Every dont-raise lesson a round's selection delivered, with where. */
function deliveredDontRaise(
  selections: ReadonlyArray<Pick<RoleSelection | StoredSelection, "role" | "row" | "lessons">>,
): Map<string, { lesson: SelectedLesson; via: string[] }> {
  const out = new Map<string, { lesson: SelectedLesson; via: string[] }>();
  for (const s of selections) {
    if (s.role !== "row" && s.role !== "validator") continue;
    const via = s.role === "validator" ? "validator" : `row:${s.row}`;
    for (const l of s.lessons) {
      if (l.kind !== "dont-raise") continue;
      const have = out.get(l.uri);
      if (have) {
        if (!have.via.includes(via)) have.via.push(via);
      } else out.set(l.uri, { lesson: l, via: [via] });
    }
  }
  return out;
}

/**
 * The marks of one round: every POSTED finding a delivered dont-raise lesson
 * would have touched, and why. Pure and deterministic (sorted by finding,
 * then lesson).
 */
export function matchShadow(
  selections: ReadonlyArray<Pick<RoleSelection | StoredSelection, "role" | "row" | "lessons">>,
  findings: readonly MatchFinding[],
): ShadowMark[] {
  const lessons = [...deliveredDontRaise(selections).entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const marks: ShadowMark[] = [];
  const posted = [...findings]
    .filter((f) => f.disposition === "posted")
    .sort((a, b) => (a.finding_key < b.finding_key ? -1 : a.finding_key > b.finding_key ? 1 : 0));
  for (const f of posted) {
    const lensIds = lensIdsOf(f.lens_ids, f.lens);
    const classes =
      lensIds.length > 0
        ? lensIds.map((id) => findingClass([id], f.kind))
        : [findingClass([], f.kind)];
    for (const [uri, { lesson, via }] of lessons) {
      if (lesson.class === null) continue;
      const lensShared = lesson.lens.filter((l) => lensIds.includes(l));
      const lensOk =
        lesson.lens.length === 0 || lensShared.length > 0 || lesson.lens.includes(VALIDATOR_LENS);
      if (!lensOk) continue;
      const cls = classes.find((c) => classesRelated(c, lesson.class!));
      if (cls === undefined) continue;
      const pathOk =
        lesson.paths.length === 0 || (f.path !== null && safeMatcher(lesson.paths)(f.path));
      if (!pathOk) continue;
      const lensWhy =
        lesson.lens.length === 0
          ? "the lesson names no lens"
          : lensShared.length > 0
            ? `lens ${lensShared.join(",")} in the lesson's lens=`
            : `the lesson names ${VALIDATOR_LENS}`;
      const pathWhy =
        lesson.paths.length === 0
          ? "the lesson names no paths"
          : `path ${f.path} matches ${lesson.paths.join(",")}`;
      marks.push({
        finding_key: f.finding_key,
        lesson_uri: uri,
        lens: lensIds,
        finding_class: cls,
        lesson_class: lesson.class,
        severity: f.severity,
        path: f.path,
        via: [...via].sort(),
        why: `${lensWhy}; class ${cls} ~ ${lesson.class}; ${pathWhy}; selected for ${[...via].sort().join(", ")}`,
      });
    }
  }
  return marks;
}

/**
 * Mark one round (pr, round_no) from what state.db holds: its newest
 * recorded selection and its findings record. Replaces the round's marks. A
 * round with no recorded selection (delivery `off`, the kill switch, a
 * daemon that predates S9a) is left alone. Returns the marks written, or
 * null when there was nothing to match against.
 */
export function markRound(
  ledger: LessonLedger,
  store: StateStore,
  pr: number,
  roundNo: number,
): ShadowMark[] | null {
  const round = ledger.roundFor(pr, roundNo);
  if (!round || round.state === "lessons_off") return null;
  const findings = store.findingsForRound(pr, roundNo);
  const marks = matchShadow(ledger.selections(round.round_id), findings);
  ledger.replaceMarks(pr, roundNo, round.round_id, marks);
  if (marks.length > 0)
    store.logEvent("lesson_shadow_marked", pr, {
      round_no: roundNo,
      marks: marks.length,
      findings: new Set(marks.map((m) => m.finding_key)).size,
    });
  return marks;
}

// ---- the report -----------------------------------------------------------------

export type ShadowBucket =
  "harm" | "help_refuted" | "help_set_aside" | "upheld" | "ignored" | "unknown" | "exempt_p0";

export interface BucketCounts {
  harm: number;
  help_refuted: number;
  help_set_aside: number;
  upheld: number;
  ignored: number;
  unknown: number;
  exempt_p0: number;
}

function zero(): BucketCounts {
  return {
    harm: 0,
    help_refuted: 0,
    help_set_aside: 0,
    upheld: 0,
    ignored: 0,
    unknown: 0,
    exempt_p0: 0,
  };
}

export interface ShadowReport {
  days: number;
  since: string;
  until: string;
  mode: MemoryDelivery;
  lessons_off: boolean;
  suppressed: number;
  /** False when the outcome capture's tables are missing (a fresh state.db):
   * every fate then reads unknown. */
  outcomes_available: boolean;
  rounds: {
    total: number;
    selected: number;
    partial: number;
    timeout: number;
    unreadable: number;
    lessons_off: number;
    /** Rounds with at least one find still out at the prefetch's deadline. */
    with_timeouts: number;
    prefetch_ms_p50: number | null;
    prefetch_ms_max: number | null;
  };
  /** Distinct marked findings, each counted once in its bucket — a finding
   * posted again in a later round (its `carried_to` chain) is ONE finding. */
  findings: BucketCounts & { total: number };
  /** Mark rows (a finding a lesson marked in two postings is two rows). */
  marks: number;
  /** Per lesson: `marks` and the buckets count the distinct findings it
   * marked, a chain once. */
  per_lesson: Array<
    BucketCounts & { uri: string; class: string; selected_rounds: number; marks: number }
  >;
  per_lens: Array<BucketCounts & { lens: string; marks: number }>;
  look_for: Array<{
    uri: string;
    class: string | null;
    selected_rounds: number;
    first_selected_at: string;
    /** Human-raised misses of a related class since its first selection;
     * null when the lesson has no class (unmeasurable) or the learner's
     * table is missing. */
    misses_after: number | null;
    misses_on_selected_prs: number | null;
  }>;
  /** Dont-raise lessons selected in the window that carry no class — the
   * matcher cannot check their class precondition. */
  unmeasurable_dont_raise: string[];
}

/** One posted finding's identity in the report: (pr, round, key). */
function findingId(pr: number, roundNo: number, key: string): string {
  return `${pr}\u0000${roundNo}\u0000${key}`;
}

function parseFindingId(id: string): { round_no: number; key: string } {
  const a = id.indexOf("\u0000");
  const b = id.indexOf("\u0000", a + 1);
  return { round_no: Number(id.slice(a + 1, b)), key: id.slice(b + 1) };
}

function tableExists(store: StateStore, name: string): boolean {
  return (
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Which bucket one marked finding lands in. */
export function bucketOf(
  severity: string | null,
  fate: string | null,
  setAside: boolean,
): ShadowBucket {
  if ((severity ?? "").trim().toUpperCase() === "P0") return "exempt_p0";
  // A fate about THIS finding outranks a signal about its whole review.
  if (fate === "fixed") return "harm";
  if (fate === "refuted_conceded") return "help_refuted";
  if (fate === "upheld_after_reply") return "upheld";
  if (setAside) return "help_set_aside";
  if (fate === "open_at_close") return "ignored";
  return "unknown";
}

export interface ReportOptions {
  days: number;
  mode: MemoryDelivery;
  now?: () => Date;
}

/**
 * The shadow report over the last `days` days: the rounds the selector ran,
 * every mark joined with what humans then did, per lesson and per lens, and
 * the look-for lessons whose class later showed a human-raised miss.
 */
export function shadowReport(ledger: LessonLedger, opts: ReportOptions): ShadowReport {
  const store = ledger.store;
  const until = (opts.now ?? (() => new Date()))();
  const days = Math.max(1, Math.floor(opts.days));
  const since = new Date(until.getTime() - days * 86_400_000).toISOString();
  const sw = ledger.switchState();

  const rounds = ledger.roundsSince(since);
  const ms = rounds.map((r) => r.prefetch_ms).filter((x): x is number => typeof x === "number");
  const count = (s: string) => rounds.filter((r) => r.state === s).length;

  const outcomesAvailable = tableExists(store, "finding_outcomes");
  const fateStmt = outcomesAvailable
    ? store.db.prepare(
        "SELECT fate FROM finding_outcomes WHERE pr = ? AND round_no = ? AND finding_key = ?",
      )
    : null;
  const fateOf = (pr: number, roundNo: number, key: string): string | null =>
    (fateStmt?.get(pr, roundNo, key) as { fate: string } | undefined)?.fate ?? null;
  const setAsideStmt = tableExists(store, "review_outcomes")
    ? store.db.prepare(
        "SELECT 1 FROM review_outcomes WHERE pr = ? AND round_no = ? AND kind = 'set_aside' LIMIT 1",
      )
    : null;
  const setAsideOf = (pr: number, roundNo: number): boolean =>
    setAsideStmt !== null && setAsideStmt.get(pr, roundNo) !== undefined;

  const marks = ledger.marksSince(since);
  // ONE FINDING, ONE COUNT. A finding posted again in a later round has a
  // posted row per round, and the outcome capture CARRIES the earlier one
  // (`finding_outcomes.carried_to` = `<round>:<key>` of the later posting),
  // so both read the same fate. A lesson selected in both rounds marks both
  // rows — counted per row, a single human fix would read as harm twice. So
  // every mark is counted against its finding CHAIN, named by the chain's
  // root (its first posting — S7's cases do the same): the chain's fate is
  // the root's (it inherits its successors' evidence), its severity the
  // earliest MARKED posting's (the one a delivered lesson would have demoted
  // first), and it counts as set aside when any marked posting's review was.
  const carriedFrom = new Map<string, string>();
  if (outcomesAvailable) {
    const chainStmt = store.db.prepare(
      "SELECT round_no, finding_key, carried_to FROM finding_outcomes WHERE pr = ? AND carried_to IS NOT NULL",
    );
    for (const pr of new Set(marks.map((m) => m.pr))) {
      for (const row of chainStmt.all(pr) as Array<{
        round_no: number;
        finding_key: string;
        carried_to: string;
      }>) {
        // `<round>:<key>` — the key itself may hold ':'.
        const cut = row.carried_to.indexOf(":");
        const round = Number(row.carried_to.slice(0, cut));
        if (cut <= 0 || !Number.isInteger(round)) continue;
        carriedFrom.set(
          findingId(pr, round, row.carried_to.slice(cut + 1)),
          findingId(pr, row.round_no, row.finding_key),
        );
      }
    }
  }
  const rootOf = new Map<string, string>();
  const chainOf = (m: Pick<ShadowMarkRow, "pr" | "round_no" | "finding_key">): string => {
    const start = findingId(m.pr, m.round_no, m.finding_key);
    const known = rootOf.get(start);
    if (known !== undefined) return known;
    let at = start;
    const seen = new Set<string>([at]);
    for (;;) {
      const prev = carriedFrom.get(at);
      if (prev === undefined || seen.has(prev)) break; // the root, or a cycle
      seen.add(prev);
      at = prev;
    }
    rootOf.set(start, at);
    return at;
  };
  const chains = new Map<
    string,
    { pr: number; root: { round_no: number; key: string }; first: ShadowMarkRow; setAside: boolean }
  >();
  for (const m of marks) {
    const id = chainOf(m);
    const c = chains.get(id);
    const aside = setAsideOf(m.pr, m.round_no);
    if (!c) {
      const root = parseFindingId(id);
      chains.set(id, { pr: m.pr, root, first: m, setAside: aside });
      continue;
    }
    if (m.round_no < c.first.round_no) c.first = m;
    c.setAside ||= aside;
  }
  const bucketFor = new Map<string, ShadowBucket>();
  for (const [id, c] of chains) {
    // The root's fate; were the root's row missing, the earliest marked one's.
    const fate =
      fateOf(c.pr, c.root.round_no, c.root.key) ??
      fateOf(c.first.pr, c.first.round_no, c.first.finding_key);
    bucketFor.set(id, bucketOf(c.first.severity, fate, c.setAside));
  }
  const keyOf = (m: ShadowMarkRow): string => chainOf(m);
  const findings = { ...zero(), total: bucketFor.size };
  for (const b of bucketFor.values()) findings[b] += 1;

  const selections = ledger.selectionsSince(since);
  const selectedRounds = new Map<string, Set<number>>();
  const selectedPrs = new Map<string, Set<number>>();
  const firstSelected = new Map<string, string>();
  const lessonInfo = new Map<string, SelectedLesson>();
  for (const s of selections) {
    if (s.role !== "row" && s.role !== "validator") continue;
    for (const l of s.lessons) {
      if (!lessonInfo.has(l.uri)) lessonInfo.set(l.uri, l);
      if (!selectedRounds.has(l.uri)) selectedRounds.set(l.uri, new Set());
      selectedRounds.get(l.uri)!.add(s.round_id);
      if (!selectedPrs.has(l.uri)) selectedPrs.set(l.uri, new Set());
      selectedPrs.get(l.uri)!.add(s.pr);
      const first = firstSelected.get(l.uri);
      if (first === undefined || s.recorded_at < first) firstSelected.set(l.uri, s.recorded_at);
    }
  }
  const perLesson = new Map<
    string,
    BucketCounts & { uri: string; class: string; selected_rounds: number; marks: number }
  >();
  const perLens = new Map<string, BucketCounts & { lens: string; marks: number }>();
  // Per lesson: one count per (lesson, finding chain) — a lesson that marked
  // a finding in two of its postings marked ONE finding.
  const lessonSeen = new Set<string>();
  for (const m of marks) {
    const lk = `${m.lesson_uri}\u0000${keyOf(m)}`;
    if (lessonSeen.has(lk)) continue;
    lessonSeen.add(lk);
    const b = bucketFor.get(keyOf(m))!;
    const pl = perLesson.get(m.lesson_uri) ?? {
      ...zero(),
      uri: m.lesson_uri,
      class: m.lesson_class,
      selected_rounds: selectedRounds.get(m.lesson_uri)?.size ?? 0,
      marks: 0,
    };
    pl.marks += 1;
    pl[b] += 1;
    perLesson.set(m.lesson_uri, pl);
  }
  // Per lens: one count per (finding chain, lens) — a finding two lenses
  // raised counts for each, once whichever lessons (and postings) marked it.
  const lensSeen = new Set<string>();
  for (const m of marks) {
    const b = bucketFor.get(keyOf(m))!;
    let lenses: string[] = [];
    try {
      const v = JSON.parse(m.lens) as unknown;
      if (Array.isArray(v)) lenses = v.filter((x): x is string => typeof x === "string");
    } catch {
      lenses = [];
    }
    if (lenses.length === 0) lenses = ["(no lens)"];
    for (const lens of lenses) {
      const k = `${keyOf(m)}\u0000${lens}`;
      if (lensSeen.has(k)) continue;
      lensSeen.add(k);
      const pl = perLens.get(lens) ?? { ...zero(), lens, marks: 0 };
      pl.marks += 1;
      pl[b] += 1;
      perLens.set(lens, pl);
    }
  }

  // Look-for lessons: did a human-raised miss of their class follow?
  const learnerTable = tableExists(store, "lesson_candidates");
  const misses = learnerTable
    ? (store.db
        .prepare(
          "SELECT class, pr, occurred_at FROM lesson_candidates WHERE polarity = 'look-for' AND source = 'recall'",
        )
        .all() as Array<{ class: string; pr: number | null; occurred_at: string }>)
    : [];
  const lookFor: ShadowReport["look_for"] = [];
  const unmeasurable: string[] = [];
  for (const [uri, l] of [...lessonInfo.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (l.kind === "dont-raise" && l.class === null) unmeasurable.push(uri);
    if (l.kind !== "look-for") continue;
    const first = firstSelected.get(uri)!;
    let after: number | null = null;
    let onPrs: number | null = null;
    if (l.class !== null && learnerTable) {
      const hits = misses.filter(
        (c) => c.occurred_at >= first && classesRelated(c.class, l.class!),
      );
      after = hits.length;
      const prs = selectedPrs.get(uri) ?? new Set<number>();
      onPrs = hits.filter((c) => c.pr !== null && prs.has(c.pr)).length;
    }
    lookFor.push({
      uri,
      class: l.class,
      selected_rounds: selectedRounds.get(uri)?.size ?? 0,
      first_selected_at: first,
      misses_after: after,
      misses_on_selected_prs: onPrs,
    });
  }

  return {
    days,
    since,
    until: until.toISOString(),
    mode: opts.mode,
    lessons_off: sw.lessons_off,
    suppressed: sw.suppressed.length,
    outcomes_available: outcomesAvailable,
    rounds: {
      total: rounds.length,
      selected: count("selected"),
      partial: count("partial"),
      timeout: count("timeout"),
      unreadable: count("unreadable"),
      lessons_off: count("lessons_off"),
      with_timeouts: rounds.filter((r) => r.timeouts > 0).length,
      prefetch_ms_p50: median(ms),
      prefetch_ms_max: ms.length ? Math.max(...ms) : null,
    },
    findings,
    marks: marks.length,
    per_lesson: [...perLesson.values()].sort(
      (a, b) => b.marks - a.marks || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
    ),
    per_lens: [...perLens.values()].sort(
      (a, b) => b.marks - a.marks || (a.lens < b.lens ? -1 : a.lens > b.lens ? 1 : 0),
    ),
    look_for: lookFor,
    unmeasurable_dont_raise: unmeasurable,
  };
}

/** The memory-relative id of a lesson URI (`experiences/<file>`), for a
 * person to read; the URI itself when it is not under a memories root. */
export function lessonLabel(uri: string): string {
  const cut = uri.indexOf("/memories/");
  return cut < 0 ? uri : uri.slice(cut + "/memories/".length);
}

function bucketsLine(b: BucketCounts): string {
  return (
    `harm ${b.harm} · help ${b.help_refuted + b.help_set_aside} (refuted ${b.help_refuted}, set aside ${b.help_set_aside}) · ` +
    `upheld ${b.upheld} · ignored ${b.ignored} · unknown ${b.unknown} · P0 exempt ${b.exempt_p0}`
  );
}

/** What `qcr lessons shadow-report` prints. */
export function renderShadowReport(r: ShadowReport): string {
  const out: string[] = [];
  out.push(
    `Lesson shadow report — the last ${r.days} day(s) (${r.since.slice(0, 16)}Z → ${r.until.slice(0, 16)}Z)`,
    `delivery: ${r.mode}${r.mode === "on" ? " (lessons reach the review; the marks below are what the validator was LICENSED to demote — its findings record says what it did)" : ""}; kill switch: ${r.lessons_off ? "LESSONS OFF" : "lessons on"}; ${r.suppressed} suppressed`,
  );
  const rr = r.rounds;
  out.push(
    `rounds: ${rr.total} recorded — ${rr.selected} selected, ${rr.partial} partial, ${rr.timeout} timed out, ${rr.unreadable} unreadable, ${rr.lessons_off} lessons-off; ${rr.with_timeouts} with a find past the deadline` +
      (rr.prefetch_ms_p50 !== null
        ? `; prefetch p50 ${rr.prefetch_ms_p50} ms, max ${rr.prefetch_ms_max} ms`
        : ""),
  );
  if (!r.outcomes_available)
    out.push(
      "outcomes: UNAVAILABLE — the outcome capture's tables are missing, so every fate reads unknown",
    );
  out.push(
    "",
    `would-demote: ${r.marks} mark(s) on ${r.findings.total} posted finding(s)`,
    `  ${bucketsLine(r.findings)}`,
    "  harm = humans then FIXED it (the lesson would have hidden a real finding); help = humans refuted it, or set its review aside (a whole-review signal); P0 is never demoted.",
  );
  out.push("", "Per lesson:");
  if (r.per_lesson.length === 0) out.push("  (no marks)");
  for (const l of r.per_lesson)
    out.push(
      `  ${lessonLabel(l.uri)}  class ${l.class}  selected in ${l.selected_rounds} round(s)  marks ${l.marks}`,
      `    ${bucketsLine(l)}`,
    );
  out.push("", "Per lens:");
  if (r.per_lens.length === 0) out.push("  (no marks)");
  for (const l of r.per_lens)
    out.push(`  ${l.lens.padEnd(24)} marks ${l.marks}  ${bucketsLine(l)}`);
  out.push("", "Look-for lessons selected, and human-raised misses of their class since:");
  if (r.look_for.length === 0) out.push("  (none selected)");
  for (const l of r.look_for)
    out.push(
      `  ${lessonLabel(l.uri)}  class ${l.class ?? "(none)"}  selected in ${l.selected_rounds} round(s)  ` +
        (l.misses_after === null
          ? "misses UNKNOWN (no class, or no learner table)"
          : `misses since ${l.first_selected_at.slice(0, 10)}: ${l.misses_after} (on PRs it was selected for: ${l.misses_on_selected_prs})`),
    );
  if (r.unmeasurable_dont_raise.length > 0)
    out.push(
      "",
      `Dont-raise lessons with no class (their class precondition cannot be checked, so they mark nothing): ${r.unmeasurable_dont_raise.map(lessonLabel).join(", ")}`,
    );
  return out.join("\n");
}

/** The status block's headline: the last `days` of the ledger. */
export function lessonDeliveryStatus(
  ledger: LessonLedger,
  mode: MemoryDelivery,
  opts: {
    days?: number;
    now?: () => Date;
    /** A selector is built (memory switched on). Absent ⇒ assumed. */
    selecting?: boolean;
  } = {},
): LessonDeliveryStatus {
  const days = opts.days ?? 7;
  const now = (opts.now ?? (() => new Date()))();
  const r = shadowReport(ledger, { days, mode, now: () => now });
  return {
    delivery: mode,
    // lessons reach a prompt only under `on`, with the kill
    // switch on and something to select from.
    delivering: mode === "on" && !r.lessons_off && opts.selecting !== false,
    lessons_off: r.lessons_off,
    suppressed: r.suppressed,
    window_days: days,
    rounds: r.rounds.total - r.rounds.lessons_off,
    timeouts: r.rounds.with_timeouts,
    unreadable: r.rounds.unreadable,
    marks: r.findings.total,
    harm: r.findings.harm,
    help: r.findings.help_refuted + r.findings.help_set_aside,
    unknown: r.findings.unknown,
    as_of: now.toISOString(),
  };
}
