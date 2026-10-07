-- The lesson ledger's schema exactly as the S9a/F2 code created it (src/lessonledger.ts
-- at cfaeecb8, before R9): lesson_shadow_marks has no `match` column and a
-- NOT NULL lesson_class. tests/lesson-shadow-tiers.test.ts migrates a ledger built from it.
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
CREATE TABLE IF NOT EXISTS lesson_shadow_marks (
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  finding_key TEXT NOT NULL,
  lesson_uri TEXT NOT NULL,
  round_id INTEGER,
  -- the finding's canonical lens ids (JSON) and the class it matched as
  lens TEXT NOT NULL,
  finding_class TEXT NOT NULL,
  lesson_class TEXT NOT NULL,
  severity TEXT,
  path TEXT,
  -- where the lesson was selected: ["row:3", "validator"]
  via TEXT NOT NULL,
  why TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (pr, round_no, finding_key, lesson_uri)
);
CREATE INDEX IF NOT EXISTS lesson_shadow_marks_at ON lesson_shadow_marks (marked_at);
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
