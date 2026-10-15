// The SHADOW LEDGER's half that reads outcomes: which posted findings a
// delivered dont-raise lesson WOULD have touched, and what humans then did
// with those findings.
//
// WHY. Under `delivery = "on"` a curated dont-raise lesson has authority over
// the validator: a finding matching the lesson's lens, class and path
// precondition may be DEMOTED (`lesson-shape`; P0 always survives, a P1 on
// solid evidence too). Whether to grant that authority is decided on the
// evidence this module produces in shadow: for every lesson, the findings it
// would have touched that humans then FIXED (harm — a real finding hidden),
// that were refuted (a human's reply, or the reviewer's own concession on
// re-check) or set aside (help), and the ones still unknown — on
// the CLASS tier (below) the ones it would have demoted, on the LENS tier
// evidence the license does not reach.
//
// THE MATCHER is deterministic and runs on what state.db already holds — the
// round's recorded selection (src/lessonledger.ts) and its findings record
// (round_findings) — at the moment the findings record lands
// (src/findingsrecord.ts `onRecorded`), and again when a selection is
// recorded after its round's findings (it never is in practice: the
// selection runs at dispatch). A posted finding is MARKED by a dont-raise
// lesson selected for the round (for any discovery row or the validator)
// at LENS LEVEL — the lens and path preconditions are enough:
//   lens  — the finding's canonical lens ids share one with the lesson's
//           `lens=` (or the lesson names `pass-validate`, which judges every
//           finding, or names no lens — no precondition);
//   path  — one of the lesson's `paths=` globs matches the finding's path
//           (no `paths=`, no precondition);
// and the mark records the TIER it matched on:
//   class — the class held too: the finding's class (`<lens>.<kind>`, the
//           learner's own `findingClass`) equals the lesson's `class=`, or
//           one is a dot-prefix of the other (`baseline` covers
//           `baseline.authz`) — the learner's coverage rule. The STRONGER
//           tier, and the only one the validator's `lesson-shape` license
//           (the `lesson-validate` addendum, `on` only) reaches: the lens
//           tier widens the evidence, not the authority;
//   lens  — the class differs, or the lesson names none (the legacy prose
//           shapes). Only for a lesson that says WHERE it applies: one
//           naming `paths=`, or, with no `paths=`, exactly one discovery
//           lens (`lensAttributable`). A lesson with no `paths=` and no lens,
//           several, or only `pass-validate` would touch every finding of
//           every lens it covers — too broad to attribute — so it marks on
//           its class alone, and with no class either it is UNMEASURABLE.
// A finding two lessons touch on different tiers counts on the class tier.
//
// THE REPORT (`qcr lessons shadow-report [--days N]`) joins the marks with
// the outcome capture's `finding_outcomes` (src/outcomes.ts) and its
// `review_outcomes`:
//   harm      — fate `fixed`;
//   help      — fate `refuted_conceded`, or (no fate about the finding
//               itself — none, `unknown` or `open_at_close`) the review that
//               carried it was set aside: a WHOLE-REVIEW signal, shown apart;
//   upheld    — `upheld_after_reply` (a human pushed back, the bot held);
//   ignored   — `open_at_close`;
//   unknown   — no fate yet, or no outcome row;
//   exempt    — a P0: the license never demotes one, whatever the lesson says.
// A finding is counted ONCE however many rounds posted it: marks on the
// postings of one `carried_to` chain collapse onto its root, which
// carries the chain's fate.
// …in total and per tier (a finding on its strongest tier, so the two add up
// to the total), per lesson and per lens, plus the look-for lessons whose
// class later showed a human-raised miss (the learner's `recall` candidates —
// never the reviewer's own recheck reversals).
//
// Nothing here writes memory or GitHub, and nothing here is on a round's path.
import type { MemoryDelivery } from "./config.js";
import { globMatcherOrNothing } from "./glob.js";
import { findingClass, lensIdsOf, tableExists } from "./learner/miner.js";
import type {
  LessonLedger,
  ShadowMark,
  ShadowMarkRow,
  ShadowMatchTier,
  StoredSelection,
} from "./lessonledger.js";
import { classesRelated } from "./memory/lessons.js";
import { VALIDATOR_LENS, type RoleSelection, type SelectedLesson } from "./memory/selection.js";
import type { LessonDeliveryStatus, LessonTierCounts } from "./memory/shadowstatus.js";
import type { RoundFindingRow, StateStore } from "./state.js";

/** The slice of a recorded finding the matcher reads. */
export type MatchFinding = Pick<
  RoundFindingRow,
  "finding_key" | "path" | "lens" | "lens_ids" | "kind" | "severity" | "disposition"
>;

/**
 * Whether a dont-raise lesson can mark on the LENS tier: it must
 * say where it applies — `paths=` globs, or, with none, exactly one discovery
 * lens. `pass-validate` alone narrows nothing (the validator judges every
 * lens's finding), and neither does naming no lens or several: such a lesson
 * with no `paths=` would touch every finding of every lens it covers — too
 * broad to attribute — so it marks on its class alone.
 */
export function lensAttributable(lesson: Pick<SelectedLesson, "lens" | "paths">): boolean {
  if (lesson.paths.length > 0) return true;
  return lesson.lens.length === 1 && lesson.lens[0] !== VALIDATOR_LENS;
}

/** The stronger of two tiers: `class` outranks `lens`. */
export function strongerTier(a: ShadowMatchTier, b: ShadowMatchTier): ShadowMatchTier {
  return a === "class" || b === "class" ? "class" : "lens";
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
 * would have touched — on its lens and path — with the tier it matched
 * on and why. Pure and deterministic (sorted by finding, then lesson).
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
      const lensShared = lesson.lens.filter((l) => lensIds.includes(l));
      const lensOk =
        lesson.lens.length === 0 || lensShared.length > 0 || lesson.lens.includes(VALIDATOR_LENS);
      if (!lensOk) continue;
      const pathOk =
        lesson.paths.length === 0 ||
        (f.path !== null && globMatcherOrNothing(lesson.paths)(f.path));
      if (!pathOk) continue;
      const classMatch =
        lesson.class === null ? undefined : classes.find((c) => classesRelated(c, lesson.class!));
      const match: ShadowMatchTier = classMatch !== undefined ? "class" : "lens";
      if (match === "lens" && !lensAttributable(lesson)) continue;
      // On the lens tier the finding's class is the one under the first of
      // ITS lenses the lesson names (the lens the match rests on); a lesson
      // covering every lens (pass-validate, or none named) takes its first.
      const sharedId = lensIds.find((id) => lesson.lens.includes(id));
      const findingCls =
        classMatch ?? (sharedId !== undefined ? findingClass([sharedId], f.kind) : classes[0]!);
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
      const classWhy =
        match === "class"
          ? `class tier: ${findingCls} ~ ${lesson.class}`
          : lesson.class === null
            ? `lens tier: the lesson names no class (finding ${findingCls})`
            : `lens tier: class ${findingCls} differs from ${lesson.class}`;
      const sortedVia = [...via].sort();
      marks.push({
        finding_key: f.finding_key,
        lesson_uri: uri,
        lens: lensIds,
        finding_class: findingCls,
        lesson_class: lesson.class,
        match,
        severity: f.severity,
        path: f.path,
        via: sortedVia,
        why: `${lensWhy}; ${pathWhy}; ${classWhy}; selected for ${sortedVia.join(", ")}`,
      });
    }
  }
  return marks;
}

/**
 * Mark one round (pr, round_no) from what state.db holds: its newest
 * recorded selection and its findings record. Replaces the round's marks. A
 * round with no recorded selection (delivery `off`, the kill switch, a
 * round recorded before selection existed) is left alone. Returns the marks written, or
 * null when there was nothing to match against.
 */
export function markRound(
  ledger: LessonLedger,
  store: StateStore,
  pr: number,
  roundNo: number,
): ShadowMark[] | null {
  const matched = ledger.matchRound(pr, roundNo);
  if (!matched) return null;
  const { marks } = matched;
  ledger.replaceMarks(pr, roundNo, matched.round.round_id, marks);
  if (marks.length > 0)
    store.logEvent("lesson_shadow_marked", pr, {
      round_no: roundNo,
      marks: marks.length,
      findings: new Set(marks.map((m) => m.finding_key)).size,
      by_tier: {
        class: marks.filter((m) => m.match === "class").length,
        lens: marks.filter((m) => m.match === "lens").length,
      },
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
  /** The same findings split by tier, each on its STRONGEST:
   * `class` — some lesson's class matched it too (what the validator's
   * license needs); `lens` — lens and path alone. The two add up to
   * `findings`. */
  findings_by_tier: Record<ShadowMatchTier, BucketCounts & { total: number }>;
  /** Mark rows (a finding a lesson marked in two postings is two rows). */
  marks: number;
  /** Mark rows per tier; they add up to `marks`. */
  marks_by_tier: Record<ShadowMatchTier, number>;
  /** Per lesson: `marks` and the buckets count the distinct findings it
   * marked, a chain once; `by_tier` splits them, each (lesson, finding) on
   * its strongest tier. `class` is null for a lesson with none. */
  per_lesson: Array<
    BucketCounts & {
      uri: string;
      class: string | null;
      selected_rounds: number;
      marks: number;
      by_tier: Record<ShadowMatchTier, BucketCounts & { marks: number }>;
    }
  >;
  per_lens: Array<
    BucketCounts & {
      lens: string;
      marks: number;
      by_tier: Record<ShadowMatchTier, BucketCounts & { marks: number }>;
    }
  >;
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
  /** Dont-raise lessons selected in the window that NEITHER tier can check:
   * no class, and too broad for the lens tier (no `paths=`, and not exactly
   * one discovery lens) — they mark nothing. */
  unmeasurable_dont_raise: string[];
  /** Dont-raise lessons selected in the window with a class but too broad
   * for the lens tier: they mark on their class alone, so the lens tier
   * never counts them. */
  class_tier_only_dont_raise: string[];
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
  // root (its first posting — the finding cases do the same): the chain's fate is
  // the root's (it inherits its successors' evidence), its severity the
  // earliest MARKED posting's (the one a delivered lesson would have touched
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
  // Each chain on its STRONGEST tier — a finding some lesson
  // matched on its class is a class-tier finding however many others touched
  // it on lens and path alone — so the two tiers add up to the total.
  const chainTier = new Map<string, ShadowMatchTier>();
  for (const m of marks) {
    const id = keyOf(m);
    const had = chainTier.get(id);
    chainTier.set(id, had === undefined ? m.match : strongerTier(had, m.match));
  }
  const findings = { ...zero(), total: bucketFor.size };
  const findingsByTier: ShadowReport["findings_by_tier"] = {
    class: { ...zero(), total: 0 },
    lens: { ...zero(), total: 0 },
  };
  for (const [id, b] of bucketFor) {
    findings[b] += 1;
    const t = findingsByTier[chainTier.get(id)!];
    t[b] += 1;
    t.total += 1;
  }
  const marksByTier: ShadowReport["marks_by_tier"] = {
    class: marks.filter((m) => m.match === "class").length,
    lens: marks.filter((m) => m.match === "lens").length,
  };
  const tierZero = (): Record<ShadowMatchTier, BucketCounts & { marks: number }> => ({
    class: { ...zero(), marks: 0 },
    lens: { ...zero(), marks: 0 },
  });

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
  const perLesson = new Map<string, ShadowReport["per_lesson"][number]>();
  const perLens = new Map<string, ShadowReport["per_lens"][number]>();
  // Per lesson: one count per (lesson, finding chain) — a lesson that marked
  // a finding in two of its postings marked ONE finding, on the stronger of
  // the tiers it marked it on.
  const lessonPairs = new Map<
    string,
    { uri: string; cls: string | null; chain: string; tier: ShadowMatchTier }
  >();
  for (const m of marks) {
    const chain = keyOf(m);
    const lk = `${m.lesson_uri}\u0000${chain}`;
    const had = lessonPairs.get(lk);
    if (had) had.tier = strongerTier(had.tier, m.match);
    else lessonPairs.set(lk, { uri: m.lesson_uri, cls: m.lesson_class, chain, tier: m.match });
  }
  for (const p of lessonPairs.values()) {
    const b = bucketFor.get(p.chain)!;
    const pl = perLesson.get(p.uri) ?? {
      ...zero(),
      uri: p.uri,
      class: p.cls,
      selected_rounds: selectedRounds.get(p.uri)?.size ?? 0,
      marks: 0,
      by_tier: tierZero(),
    };
    pl.marks += 1;
    pl[b] += 1;
    pl.by_tier[p.tier].marks += 1;
    pl.by_tier[p.tier][b] += 1;
    perLesson.set(p.uri, pl);
  }
  // Per lens: one count per (finding chain, lens) — a finding two lenses
  // raised counts for each, once whichever lessons (and postings) marked it,
  // on the strongest tier any of them marked it on.
  const lensPairs = new Map<string, { lens: string; chain: string; tier: ShadowMatchTier }>();
  for (const m of marks) {
    let lenses: string[] = [];
    try {
      const v = JSON.parse(m.lens) as unknown;
      if (Array.isArray(v)) lenses = v.filter((x): x is string => typeof x === "string");
    } catch {
      lenses = [];
    }
    if (lenses.length === 0) lenses = ["(no lens)"];
    const chain = keyOf(m);
    for (const lens of lenses) {
      const k = `${chain}\u0000${lens}`;
      const had = lensPairs.get(k);
      if (had) had.tier = strongerTier(had.tier, m.match);
      else lensPairs.set(k, { lens, chain, tier: m.match });
    }
  }
  for (const p of lensPairs.values()) {
    const b = bucketFor.get(p.chain)!;
    const pl = perLens.get(p.lens) ?? { ...zero(), lens: p.lens, marks: 0, by_tier: tierZero() };
    pl.marks += 1;
    pl[b] += 1;
    pl.by_tier[p.tier].marks += 1;
    pl.by_tier[p.tier][b] += 1;
    perLens.set(p.lens, pl);
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
  const classTierOnly: string[] = [];
  for (const [uri, l] of [...lessonInfo.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (l.kind === "dont-raise" && !lensAttributable(l))
      (l.class === null ? unmeasurable : classTierOnly).push(uri);
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
    findings_by_tier: findingsByTier,
    marks: marks.length,
    marks_by_tier: marksByTier,
    per_lesson: [...perLesson.values()].sort(
      (a, b) => b.marks - a.marks || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
    ),
    per_lens: [...perLens.values()].sort(
      (a, b) => b.marks - a.marks || (a.lens < b.lens ? -1 : a.lens > b.lens ? 1 : 0),
    ),
    look_for: lookFor,
    unmeasurable_dont_raise: unmeasurable,
    class_tier_only_dont_raise: classTierOnly,
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

/** The three bucket lines of one count — all, then each tier. */
function tierLines(
  indent: string,
  all: BucketCounts,
  byTier: Record<ShadowMatchTier, BucketCounts>,
): string[] {
  return [
    `${indent}all    ${bucketsLine(all)}`,
    `${indent}class  ${bucketsLine(byTier.class)}`,
    `${indent}lens   ${bucketsLine(byTier.lens)}`,
  ];
}

/** What `qcr lessons shadow-report` prints. */
export function renderShadowReport(r: ShadowReport): string {
  const out: string[] = [];
  out.push(
    `Lesson shadow report — the last ${r.days} day(s) (${r.since.slice(0, 16)}Z → ${r.until.slice(0, 16)}Z)`,
    `delivery: ${r.mode}${r.mode === "on" ? " (lessons reach the review; the CLASS-tier marks below are what the validator was LICENSED to demote — its findings record says what it did; the lens tier is outside that license)" : ""}; kill switch: ${r.lessons_off ? "LESSONS OFF" : "lessons on"}; ${r.suppressed} suppressed`,
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
  const ft = r.findings_by_tier;
  out.push(
    "",
    // The total holds lens-tier findings, which the validator's license
    // never reaches: only the class tier is "would-demote".
    `marked: ${r.marks} mark(s) on ${r.findings.total} posted finding(s) — ` +
      `class tier (would-demote) ${ft.class.total} finding(s) (${r.marks_by_tier.class} mark(s)), ` +
      `lens tier (evidence only) ${ft.lens.total} finding(s) (${r.marks_by_tier.lens} mark(s))`,
    ...tierLines("  ", r.findings, ft),
    "  class = the lesson's lens, class and path all held — what the validator's lesson-shape license needs; lens = lens and path held, the class differs or the lesson names none (lens-level matching) — evidence only. A finding both tiers touched counts on the class tier.",
    "  harm = humans then FIXED it (the lesson would have hidden a real finding); help = it was refuted and conceded (on a human's reply, or by the reviewer's own re-check), or its review was set aside (a whole-review signal); P0 is never demoted.",
  );
  out.push("", "Per lesson:");
  if (r.per_lesson.length === 0) out.push("  (no marks)");
  for (const l of r.per_lesson)
    out.push(
      `  ${lessonLabel(l.uri)}  class ${l.class ?? "(none)"}  selected in ${l.selected_rounds} round(s)  ` +
        `marks ${l.marks} (class ${l.by_tier.class.marks}, lens ${l.by_tier.lens.marks})`,
      ...tierLines("    ", l, l.by_tier),
    );
  out.push("", "Per lens:");
  if (r.per_lens.length === 0) out.push("  (no marks)");
  for (const l of r.per_lens)
    out.push(
      `  ${l.lens}  marks ${l.marks} (class ${l.by_tier.class.marks}, lens ${l.by_tier.lens.marks})`,
      ...tierLines("    ", l, l.by_tier),
    );
  out.push("", "Look-for lessons selected, and human-raised misses of their class since:");
  if (r.look_for.length === 0) out.push("  (none selected)");
  for (const l of r.look_for)
    out.push(
      `  ${lessonLabel(l.uri)}  class ${l.class ?? "(none)"}  selected in ${l.selected_rounds} round(s)  ` +
        (l.misses_after === null
          ? "misses UNKNOWN (no class, or no learner table)"
          : `misses since ${l.first_selected_at.slice(0, 10)}: ${l.misses_after} (on PRs it was selected for: ${l.misses_on_selected_prs})`),
    );
  if (r.class_tier_only_dont_raise.length > 0)
    out.push(
      "",
      `Dont-raise lessons too broad for the lens tier (no paths=, and not exactly one discovery lens — they mark on their class alone): ${r.class_tier_only_dont_raise.map(lessonLabel).join(", ")}`,
    );
  if (r.unmeasurable_dont_raise.length > 0)
    out.push(
      "",
      `Dont-raise lessons neither tier can check (no class, no paths=, and not exactly one discovery lens — they mark nothing): ${r.unmeasurable_dont_raise.map(lessonLabel).join(", ")}`,
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
    // Lessons reach a prompt only under `on`, with the kill
    // switch on and something to select from.
    delivering: mode === "on" && !r.lessons_off && opts.selecting !== false,
    lessons_off: r.lessons_off,
    suppressed: r.suppressed,
    window_days: days,
    rounds: r.rounds.total - r.rounds.lessons_off,
    timeouts: r.rounds.with_timeouts,
    unreadable: r.rounds.unreadable,
    ...tierCounts(r.findings),
    tiers: {
      class: tierCounts(r.findings_by_tier.class),
      lens: tierCounts(r.findings_by_tier.lens),
    },
    as_of: now.toISOString(),
  };
}

function tierCounts(b: BucketCounts & { total: number }): LessonTierCounts {
  return {
    marks: b.total,
    harm: b.harm,
    help: b.help_refuted + b.help_set_aside,
    unknown: b.unknown,
  };
}
