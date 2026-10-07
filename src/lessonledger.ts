// The LESSON LEDGER (S9a): what every round's lesson selection was,
// which posted findings a delivered dont-raise lesson WOULD have touched, and
// the operator's kill switch — all on the state database, none of it in
// memory.
//
// FIVE TABLES, OWNED HERE (on the state database, like the outcome capture's
// and the learner's):
//
// - `lesson_rounds` — one row per round the selector ran for: the delivery
//   mode, what the prefetch got (finds asked, answered, timed out, refused),
//   how long it took, and the round's state (`selected`, `partial`,
//   `timeout`, `unreadable`, `lessons_off`). A round the switch is `off` for
//   has no row at all: `off` runs nothing.
// - `lesson_selections` — per round, one row per ROLE: every discovery plan
//   row, the validator, every lens the session may add (S9b, `addable`, its
//   row the lens's index in `addable_lenses`), the main session's cases. The lessons (or cases) it
//   would carry with every field the matcher and the report need, the cuts
//   (each with why), the drop counts per filter, the query, and whether its
//   find timed out. The contract's "round, row, lesson URIs, cases, cuts,
//   prefetch ms, timeouts" — the round-level facts live on `lesson_rounds`.
// - `lesson_shadow_marks` — per posted finding, every delivered dont-raise
//   lesson whose lens and path precondition the finding meets, the TIER it
//   matched on (`match`: `class` — the lesson's class matched the finding's
//   too, what the validator's `lesson-shape` license needs; `lens` — lens and
//   path alone, the owner's ruling R9), and why (src/lessonshadow.ts
//   `matchShadow`). Re-recording a round's findings replaces its marks. A
//   ledger from before R9 (no `match` column, `lesson_class` NOT NULL) is
//   migrated ONCE (`migrateMarkTiers`): every existing row kept as `class` —
//   the only tier that matcher had — and each recorded round's R9 marks
//   added where it holds none for that (finding, lesson) — its lens-tier
//   marks — so a report window never reads the lens tier as zero for rounds
//   it was never measured on.
// - `lesson_switch` / `lesson_suppressions` — THE OPERATOR'S KILL SWITCH.
//   `lessons-off` / `lessons-on` and `suppress-lesson <uri>` /
//   `unsuppress-lesson <uri>` arrive ONLY through the root-sealed
//   `commands/operator/` channel (src/commands.ts) and are stored
//   here — never as an OpenViking tag, which anyone holding a key (the
//   overseer, the companion) could write and nothing could tell from the
//   operator's. The selector reads both on every round.
//
// Nothing here writes memory or GitHub, and nothing here is on a round's
// critical path: the selector records after the round was dispatched.
import type { MemoryDelivery } from "./config.js";
import { matchShadow } from "./lessonshadow.js";
import type {
  RoleSelection,
  SelectedCase,
  SelectedLesson,
  SelectionCut,
} from "./memory/selection.js";
import type { StateStore } from "./state.js";

// The marks table, shared by the schema and the R9 migration that rebuilds a
// pre-R9 one (SQLite cannot drop a NOT NULL in place).
const MARKS_TABLE_COLUMNS_SQL = `(
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  finding_key TEXT NOT NULL,
  lesson_uri TEXT NOT NULL,
  round_id INTEGER,
  -- the finding's canonical lens ids (JSON); its class (\`<lens>.<kind>\`) —
  -- the one that matched on the class tier, the one under the lens it shared
  -- with the lesson on the lens tier
  lens TEXT NOT NULL,
  finding_class TEXT NOT NULL,
  -- the lesson's class; NULL for a lesson with none (it can match only on the
  -- lens tier)
  lesson_class TEXT,
  -- R9: which tier matched — class (lens, class and path) | lens
  -- (lens and path; the class differs or the lesson names none)
  match TEXT NOT NULL DEFAULT 'class' CHECK (match IN ('class', 'lens')),
  severity TEXT,
  path TEXT,
  -- where the lesson was selected: ["row:3", "validator"]
  via TEXT NOT NULL,
  why TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (pr, round_no, finding_key, lesson_uri)
)`;
const MARKS_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS lesson_shadow_marks_at ON lesson_shadow_marks (marked_at);";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lesson_rounds (
  round_id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  mode TEXT NOT NULL,
  -- selected | partial | timeout | unreadable | lessons_off
  state TEXT NOT NULL,
  finds INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0,
  prefetch_ms INTEGER,
  -- the store's retired list arrived in time (1), or only the headers could
  -- say what is retired (0)
  retired_list INTEGER NOT NULL DEFAULT 0,
  suppressed INTEGER NOT NULL DEFAULT 0,
  as_of TEXT,
  note TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_rounds_pr ON lesson_rounds (pr, round_no);
CREATE INDEX IF NOT EXISTS lesson_rounds_at ON lesson_rounds (recorded_at);
CREATE TABLE IF NOT EXISTS lesson_selections (
  round_id INTEGER NOT NULL,
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  -- row | validator | addable | cases
  role TEXT NOT NULL,
  -- the pass-plan row; the addable lens's index; -1 for the main session's cases
  row INTEGER NOT NULL,
  lens TEXT NOT NULL,
  agent TEXT,
  query TEXT,
  -- ok | timeout | unreadable | find_cap
  status TEXT NOT NULL,
  reason TEXT,
  lessons TEXT NOT NULL DEFAULT '[]',
  cases TEXT NOT NULL DEFAULT '[]',
  cuts TEXT NOT NULL DEFAULT '[]',
  dropped TEXT NOT NULL DEFAULT '{}',
  timed_out INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (round_id, role, row)
);
CREATE INDEX IF NOT EXISTS lesson_selections_pr ON lesson_selections (pr, round_no);
CREATE TABLE IF NOT EXISTS lesson_shadow_marks ${MARKS_TABLE_COLUMNS_SQL};
${MARKS_INDEX_SQL}
CREATE TABLE IF NOT EXISTS lesson_switch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lessons_off INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT,
  file TEXT
);
CREATE TABLE IF NOT EXISTS lesson_suppressions (
  uri TEXT PRIMARY KEY,
  suppressed_at TEXT NOT NULL,
  file TEXT
);
`;

export type LessonRoundState = "selected" | "partial" | "timeout" | "unreadable" | "lessons_off";

export interface LessonRoundRow {
  round_id: number;
  pr: number;
  round_no: number;
  mode: MemoryDelivery;
  state: LessonRoundState;
  finds: number;
  answered: number;
  timeouts: number;
  refused: number;
  prefetch_ms: number | null;
  retired_list: number;
  suppressed: number;
  as_of: string | null;
  note: string | null;
  recorded_at: string;
}

/** A selection as the ledger hands it back, JSON columns parsed. */
export interface StoredSelection {
  round_id: number;
  pr: number;
  round_no: number;
  role: RoleSelection["role"];
  row: number;
  lens: string;
  agent: string | null;
  query: string | null;
  status: RoleSelection["status"];
  reason: string | null;
  lessons: SelectedLesson[];
  cases: SelectedCase[];
  cuts: SelectionCut[];
  dropped: Record<string, number>;
  timed_out: number;
  recorded_at: string;
}

/**
 * Which tier a shadow mark matched on (R9). `class` is the STRONGER:
 * the lesson's lens, class and path preconditions all held — exactly what
 * the validator's `lesson-shape` license (R2, the `lesson-validate` addendum)
 * needs. `lens`: the lens and path preconditions held and the class did not
 * (or the lesson names none) — lens-level matching, evidence only.
 */
export type ShadowMatchTier = "class" | "lens";

export interface ShadowMarkRow {
  pr: number;
  round_no: number;
  finding_key: string;
  lesson_uri: string;
  round_id: number | null;
  lens: string;
  finding_class: string;
  lesson_class: string | null;
  match: ShadowMatchTier;
  severity: string | null;
  path: string | null;
  via: string;
  why: string;
  marked_at: string;
}

/** A mark as the matcher produces it (before it is stamped and stored). */
export interface ShadowMark {
  finding_key: string;
  lesson_uri: string;
  lens: string[];
  finding_class: string;
  /** Null for a lesson with no class — it matches on the lens tier only. */
  lesson_class: string | null;
  match: ShadowMatchTier;
  severity: string | null;
  path: string | null;
  via: string[];
  why: string;
}

/** What the kill switch says right now. */
export interface LessonSwitchState {
  lessons_off: boolean;
  changed_at: string | null;
  suppressed: string[];
}

/** One operator change to the kill switch (src/commands.ts). */
export type LessonSwitchChange =
  | { action: "off" }
  | { action: "on" }
  | { action: "suppress"; uri: string }
  | { action: "unsuppress"; uri: string };

function json<T>(raw: string | null | undefined, fallback: T): T {
  try {
    const v = JSON.parse(raw ?? "") as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export class LessonLedger {
  readonly store: StateStore;
  private readonly now: () => Date;

  constructor(store: StateStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
    this.store.db.exec(SCHEMA);
    this.migrateMarkTiers();
  }

  private ts(): string {
    return this.now().toISOString();
  }

  /** The marks table has the R9 shape (a `match` column). */
  private marksHaveTiers(): boolean {
    return (
      this.store.db.prepare("PRAGMA table_info(lesson_shadow_marks)").all() as Array<{
        name: string;
      }>
    ).some((c) => c.name === "match");
  }

  /**
   * R9, once per database: a marks table from before lens-level
   * matching has no `match` column and a NOT NULL `lesson_class` (a lens-tier
   * mark of a lesson with no class has none to store). Rebuild it in place —
   * every existing row copied as `class`, the only tier the strict matcher
   * had — and then ADD each recorded round's lens-tier marks beside them
   * (`backfillLensTier`), so the report and the headline never read the lens
   * tier of a pre-R9 round as zero. Existing rows are never touched: the
   * backfill inserts only (finding, lesson) pairs the table does not hold. One
   * IMMEDIATE transaction, the shape checked again inside it — the daemon and
   * `qcr lessons shadow-report` both open this database, and the second one
   * in finds the work done.
   */
  private migrateMarkTiers(): void {
    if (this.marksHaveTiers()) return;
    const db = this.store.db;
    let kept = 0;
    let added: { rounds: number; marks: Record<ShadowMatchTier, number> } = {
      rounds: 0,
      marks: { class: 0, lens: 0 },
    };
    let migrated = false;
    db.transaction(() => {
      if (this.marksHaveTiers()) return;
      db.exec(`
        DROP INDEX IF EXISTS lesson_shadow_marks_at;
        ALTER TABLE lesson_shadow_marks RENAME TO lesson_shadow_marks_before_tiers;
        CREATE TABLE lesson_shadow_marks ${MARKS_TABLE_COLUMNS_SQL};
        INSERT INTO lesson_shadow_marks
          (pr, round_no, finding_key, lesson_uri, round_id, lens, finding_class, lesson_class,
           match, severity, path, via, why, marked_at)
        SELECT pr, round_no, finding_key, lesson_uri, round_id, lens, finding_class, lesson_class,
           'class', severity, path, via, why, marked_at
          FROM lesson_shadow_marks_before_tiers;
        DROP TABLE lesson_shadow_marks_before_tiers;
        ${MARKS_INDEX_SQL}
      `);
      kept = (db.prepare("SELECT COUNT(*) AS n FROM lesson_shadow_marks").get() as { n: number }).n;
      added = this.backfillLensTier();
      migrated = true;
    }).immediate();
    if (migrated)
      this.store.logEvent("lesson_shadow_tiers_migrated", null, {
        kept_as_class: kept,
        rounds_backfilled: added.rounds,
        marks_added: added.marks,
      });
  }

  /**
   * The marks every recorded round has under R9 — INSERTED where the round
   * holds no mark for that (finding, lesson), never replacing one: in
   * practice its lens-tier marks, since the strict matcher already wrote its
   * class-tier ones (a round it never marked gets both). Each round is
   * matched the way `markRound` matches it (its newest recorded selection,
   * its findings record; a `lessons_off` round has nothing to match), and a
   * mark is stamped with the round's own marking time — its earliest
   * existing mark, else when its findings record landed — so it falls in the
   * same report window as the round's other marks. A round with a mark to
   * add has posted findings, so the second is always there: it is read off
   * the very rows the marks were matched against.
   */
  private backfillLensTier(): { rounds: number; marks: Record<ShadowMatchTier, number> } {
    const db = this.store.db;
    const pairs = db
      .prepare("SELECT DISTINCT pr, round_no FROM lesson_rounds ORDER BY pr, round_no")
      .all() as Array<{ pr: number; round_no: number }>;
    const ins = db.prepare(
      `INSERT OR IGNORE INTO lesson_shadow_marks
         (pr, round_no, finding_key, lesson_uri, round_id, lens, finding_class, lesson_class,
          match, severity, path, via, why, marked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const firstMark = db.prepare(
      "SELECT MIN(marked_at) AS at FROM lesson_shadow_marks WHERE pr = ? AND round_no = ?",
    );
    let rounds = 0;
    const marks: Record<ShadowMatchTier, number> = { class: 0, lens: 0 };
    for (const { pr, round_no } of pairs) {
      const round = this.roundFor(pr, round_no);
      if (!round || round.state === "lessons_off") continue;
      const findings = this.store.findingsForRound(pr, round_no);
      const computed = matchShadow(this.selections(round.round_id), findings);
      if (computed.length === 0) continue;
      // A mark comes from a posted finding, so `findings` is not empty here:
      // when the round's findings record landed is the latest of its rows.
      const findingsAt = findings.reduce(
        (at, f) => (f.recorded_at > at ? f.recorded_at : at),
        findings[0]!.recorded_at,
      );
      const at = (firstMark.get(pr, round_no) as { at: string | null }).at ?? findingsAt;
      let added = 0;
      for (const m of computed) {
        const n = ins.run(
          pr,
          round_no,
          m.finding_key,
          m.lesson_uri,
          round.round_id,
          JSON.stringify(m.lens),
          m.finding_class,
          m.lesson_class,
          m.match,
          m.severity,
          m.path,
          JSON.stringify(m.via),
          m.why,
          at,
        ).changes;
        marks[m.match] += n;
        added += n;
      }
      if (added > 0) rounds += 1;
    }
    return { rounds, marks };
  }

  // ---- the kill switch ---------------------------------------------------------

  lessonsOff(): boolean {
    const row = this.store.db
      .prepare("SELECT lessons_off FROM lesson_switch WHERE id = 1")
      .get() as { lessons_off: number } | undefined;
    return (row?.lessons_off ?? 0) === 1;
  }

  suppressedUris(): string[] {
    return (
      this.store.db.prepare("SELECT uri FROM lesson_suppressions ORDER BY uri").all() as Array<{
        uri: string;
      }>
    ).map((r) => r.uri);
  }

  switchState(): LessonSwitchState {
    const row = this.store.db
      .prepare("SELECT lessons_off, changed_at FROM lesson_switch WHERE id = 1")
      .get() as { lessons_off: number; changed_at: string | null } | undefined;
    return {
      lessons_off: (row?.lessons_off ?? 0) === 1,
      changed_at: row?.changed_at ?? null,
      suppressed: this.suppressedUris(),
    };
  }

  /**
   * Apply one OPERATOR change. The caller (wire.ts's command handler) is only
   * ever reached from the sealed operator channel — `executeCommand` refuses
   * every other issuer — so this does not ask who is calling. Idempotent: a
   * second `lessons-off` is a no-op that still answers with the state.
   */
  apply(change: LessonSwitchChange, file: string): LessonSwitchState & { changed: boolean } {
    const at = this.ts();
    let changed = false;
    const tx = this.store.db.transaction(() => {
      switch (change.action) {
        case "off":
        case "on": {
          const off = change.action === "off" ? 1 : 0;
          const was = this.lessonsOff() ? 1 : 0;
          if (was !== off) changed = true;
          this.store.db
            .prepare(
              `INSERT INTO lesson_switch (id, lessons_off, changed_at, file) VALUES (1, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET lessons_off = excluded.lessons_off,
                 changed_at = CASE WHEN lesson_switch.lessons_off = excluded.lessons_off
                   THEN lesson_switch.changed_at ELSE excluded.changed_at END,
                 file = CASE WHEN lesson_switch.lessons_off = excluded.lessons_off
                   THEN lesson_switch.file ELSE excluded.file END`,
            )
            .run(off, at, file);
          break;
        }
        case "suppress": {
          const r = this.store.db
            .prepare(
              "INSERT OR IGNORE INTO lesson_suppressions (uri, suppressed_at, file) VALUES (?, ?, ?)",
            )
            .run(change.uri, at, file);
          changed = r.changes > 0;
          break;
        }
        case "unsuppress": {
          const r = this.store.db
            .prepare("DELETE FROM lesson_suppressions WHERE uri = ?")
            .run(change.uri);
          changed = r.changes > 0;
          break;
        }
      }
    });
    tx();
    const state = this.switchState();
    this.store.logEvent("lesson_switch_changed", null, {
      action: change.action,
      ...("uri" in change ? { uri: change.uri } : {}),
      changed,
      lessons_off: state.lessons_off,
      suppressed: state.suppressed.length,
      file,
    });
    return { ...state, changed };
  }

  // ---- selections ----------------------------------------------------------------

  /** Record one round's selection (all its roles) — REPLACING a previous
   * record of the same round. */
  recordRound(
    round: Omit<LessonRoundRow, "recorded_at">,
    selections: readonly RoleSelection[],
  ): void {
    const at = this.ts();
    const tx = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM lesson_selections WHERE round_id = ?").run(round.round_id);
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO lesson_rounds
             (round_id, pr, round_no, mode, state, finds, answered, timeouts, refused,
              prefetch_ms, retired_list, suppressed, as_of, note, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          round.round_id,
          round.pr,
          round.round_no,
          round.mode,
          round.state,
          round.finds,
          round.answered,
          round.timeouts,
          round.refused,
          round.prefetch_ms,
          round.retired_list,
          round.suppressed,
          round.as_of,
          round.note,
          at,
        );
      const ins = this.store.db.prepare(
        `INSERT OR REPLACE INTO lesson_selections
           (round_id, pr, round_no, role, row, lens, agent, query, status, reason,
            lessons, cases, cuts, dropped, timed_out, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of selections)
        ins.run(
          round.round_id,
          round.pr,
          round.round_no,
          s.role,
          s.row,
          s.lens,
          s.agent,
          s.query,
          s.status,
          s.reason ?? null,
          JSON.stringify(s.lessons),
          JSON.stringify(s.cases),
          JSON.stringify(s.cuts),
          JSON.stringify(s.dropped),
          s.status === "timeout" ? 1 : 0,
          at,
        );
    });
    tx();
  }

  /**
   * Drop one round's record — its `lesson_rounds` row, its selections and
   * any marks stamped with it — because dispatch DISCARDED the round before
   * its handoff (S9b: under `on` the selection runs before the
   * handoff, and a failed handoff deletes the provisional round). Without
   * this the report and the status headline would count an attempt that
   * never ran: round totals, timeouts, each lesson's selected rounds. Round
   * ids are never reused, so the retry records under its own id.
   */
  discardRound(roundId: number): { rounds: number; selections: number; marks: number } {
    let out = { rounds: 0, selections: 0, marks: 0 };
    const tx = this.store.db.transaction(() => {
      const selections = this.store.db
        .prepare("DELETE FROM lesson_selections WHERE round_id = ?")
        .run(roundId).changes;
      const marks = this.store.db
        .prepare("DELETE FROM lesson_shadow_marks WHERE round_id = ?")
        .run(roundId).changes;
      const rounds = this.store.db
        .prepare("DELETE FROM lesson_rounds WHERE round_id = ?")
        .run(roundId).changes;
      out = { rounds, selections, marks };
    });
    tx();
    return out;
  }

  roundRow(roundId: number): LessonRoundRow | undefined {
    return this.store.db.prepare("SELECT * FROM lesson_rounds WHERE round_id = ?").get(roundId) as
      LessonRoundRow | undefined;
  }

  /** The newest recorded round of (pr, round_no) — a round number is unique
   * per PR, but a replayed record keeps the last. */
  roundFor(pr: number, roundNo: number): LessonRoundRow | undefined {
    return this.store.db
      .prepare(
        "SELECT * FROM lesson_rounds WHERE pr = ? AND round_no = ? ORDER BY recorded_at DESC, round_id DESC LIMIT 1",
      )
      .get(pr, roundNo) as LessonRoundRow | undefined;
  }

  selections(roundId: number): StoredSelection[] {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM lesson_selections WHERE round_id = ? ORDER BY CASE role WHEN 'row' THEN 0 WHEN 'validator' THEN 1 WHEN 'addable' THEN 2 ELSE 3 END, row",
      )
      .all(roundId) as Array<Record<string, unknown>>;
    return rows.map(storedSelection);
  }

  /** Rounds recorded since `since` (ISO), oldest first. */
  roundsSince(since: string): LessonRoundRow[] {
    return this.store.db
      .prepare("SELECT * FROM lesson_rounds WHERE recorded_at >= ? ORDER BY recorded_at, round_id")
      .all(since) as LessonRoundRow[];
  }

  // ---- shadow marks ---------------------------------------------------------------

  /** Replace the marks of one round (pr, round_no) with `marks`. */
  replaceMarks(
    pr: number,
    roundNo: number,
    roundId: number | null,
    marks: readonly ShadowMark[],
  ): void {
    const at = this.ts();
    const tx = this.store.db.transaction(() => {
      this.store.db
        .prepare("DELETE FROM lesson_shadow_marks WHERE pr = ? AND round_no = ?")
        .run(pr, roundNo);
      const ins = this.store.db.prepare(
        `INSERT OR REPLACE INTO lesson_shadow_marks
           (pr, round_no, finding_key, lesson_uri, round_id, lens, finding_class, lesson_class,
            match, severity, path, via, why, marked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of marks)
        ins.run(
          pr,
          roundNo,
          m.finding_key,
          m.lesson_uri,
          roundId,
          JSON.stringify(m.lens),
          m.finding_class,
          m.lesson_class,
          m.match,
          m.severity,
          m.path,
          JSON.stringify(m.via),
          m.why,
          at,
        );
    });
    tx();
  }

  marks(pr: number, roundNo: number): ShadowMarkRow[] {
    return this.store.db
      .prepare(
        "SELECT * FROM lesson_shadow_marks WHERE pr = ? AND round_no = ? ORDER BY finding_key, lesson_uri",
      )
      .all(pr, roundNo) as ShadowMarkRow[];
  }

  marksSince(since: string): ShadowMarkRow[] {
    return this.store.db
      .prepare(
        "SELECT * FROM lesson_shadow_marks WHERE marked_at >= ? ORDER BY pr, round_no, finding_key, lesson_uri",
      )
      .all(since) as ShadowMarkRow[];
  }

  /** Every selection of the rounds recorded since `since`, for the report —
   * one query. */
  selectionsSince(since: string): StoredSelection[] {
    const rows = this.store.db
      .prepare(
        `SELECT s.* FROM lesson_selections s JOIN lesson_rounds r ON r.round_id = s.round_id
         WHERE r.recorded_at >= ?
         ORDER BY r.recorded_at, s.round_id, CASE s.role WHEN 'row' THEN 0 WHEN 'validator' THEN 1 WHEN 'addable' THEN 2 ELSE 3 END, s.row`,
      )
      .all(since) as Array<Record<string, unknown>>;
    return rows.map(storedSelection);
  }
}

function storedSelection(r: Record<string, unknown>): StoredSelection {
  return {
    round_id: r["round_id"] as number,
    pr: r["pr"] as number,
    round_no: r["round_no"] as number,
    role: r["role"] as StoredSelection["role"],
    row: r["row"] as number,
    lens: r["lens"] as string,
    agent: (r["agent"] as string | null) ?? null,
    query: (r["query"] as string | null) ?? null,
    status: r["status"] as StoredSelection["status"],
    reason: (r["reason"] as string | null) ?? null,
    lessons: json<SelectedLesson[]>(r["lessons"] as string, []),
    cases: json<SelectedCase[]>(r["cases"] as string, []),
    cuts: json<SelectionCut[]>(r["cuts"] as string, []),
    dropped: json<Record<string, number>>(r["dropped"] as string, {}),
    timed_out: r["timed_out"] as number,
    recorded_at: r["recorded_at"] as string,
  };
}
