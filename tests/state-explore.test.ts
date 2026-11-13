// state_explore (packages/pi-plugin/src/stateexplore.ts): the five actions
// and every anchor kind over an in-memory ExploreIo. The fixtures are small
// versions of the defects the state lenses missed: a persisted slice field
// with no version bump, a companion write present at one exit and missing at
// another, a terminal call moved into one branch, two writes with no
// transaction, a getter replaced by a cached field. A world is given as base
// and head texts per file; the diff is computed from them (deletions first,
// as git prints them), so the patch and the files the io serves agree.
import { describe, expect, it } from "vitest";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";
import {
  ANCHOR_KINDS,
  classifyOccurrence,
  declaresLocal,
  EXPLORE_MAX_ADDED_LINES,
  EXPLORE_MAX_ANCHORS,
  EXPLORE_MAX_CHANGED_FILE_BYTES,
  EXPLORE_MAX_FILE_BYTES,
  EXPLORE_MAX_SITES,
  exploreRequestRefusal,
  isTerminalCallee,
  nameFormsOf,
  runStateExplore,
  STATE_EXPLORE_PARAMS,
  STATE_EXPLORE_PROBES,
  STATE_EXPLORE_TOOL,
  type ExploreIo,
  type ExploreRequest,
} from "@quickchatai/pi-quickreview/src/stateexplore.js";
import { LINE_MAX } from "@quickchatai/pi-quickreview/src/statetriggers.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

/** A unified diff of two texts: one hunk over the whole file, deletions
 * before additions. */
function unified(base: string, head: string): string {
  const a = base === "" ? [] : base.split("\n");
  const b = head === "" ? [] : head.split("\n");
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (i < n && (j === m || L[i + 1]![j]! >= L[i]![j + 1]!)) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  return [`@@ -1,${n} +1,${m} @@`, ...out].join("\n");
}

interface FileCase {
  path: string;
  base?: string;
  head?: string;
}

type World = ExploreIo & { reads: string[]; closed: number };

/** The PR's files over an unchanged tree. */
function world(
  files: FileCase[],
  tree: Record<string, string> = {},
  over: Partial<ExploreIo> = {},
): World {
  const head: Record<string, string> = { ...tree };
  const base: Record<string, string> = { ...tree };
  for (const f of files) {
    if (f.head !== undefined) head[f.path] = f.head;
    else delete head[f.path];
    if (f.base !== undefined) base[f.path] = f.base;
  }
  const diff: PrFileEntry[] = files.map((f) => ({
    filename: f.path,
    additions: 0,
    deletions: 0,
    status: f.base === undefined ? "added" : f.head === undefined ? "removed" : "modified",
    patch: unified(f.base ?? "", f.head ?? ""),
  }));
  const w: World = {
    reads: [],
    closed: 0,
    listHead: async () => Object.keys(head).map((p) => ({ path: p, size: head[p]!.length })),
    readHead: async (p) => {
      w.reads.push(p);
      return head[p] ?? null;
    },
    readBase: async (p) => base[p] ?? null,
    diff: async () => diff,
    close: async () => {
      w.closed++;
    },
    ...over,
  };
  return w;
}

const run = (req: ExploreRequest, io: ExploreIo, opts = {}): Promise<string> =>
  runStateExplore(req, io, opts);
const anchors = async (io: ExploreIo): Promise<string[]> =>
  (await run({ action: "anchors" }, io)).split("\n").filter((l) => /^\[[a-z-]+\] /.test(l));

const src = (...l: string[]): string => `${l.join("\n")}\n`;

// ---------------------------------------------------------------------------
// Fixtures

/** A companion write present at one exit and missing at another. */
const save = {
  path: "src/save.ts",
  base: src(
    "export async function save(form: Form) {",
    "  setSaving(true);",
    "  const r = await api.save(form);",
    "  if (!r.ok) {",
    "    return null;",
    "  }",
    "  return r.id;",
    "}",
  ),
  head: src(
    "export async function save(form: Form) {",
    "  setSaving(true);",
    "  const r = await api.save(form);",
    "  if (!r.ok) {",
    "    return null;",
    "  }",
    "  setSaving(false);",
    "  return r.id;",
    "}",
  ),
};

/** A terminal call moved into one branch. */
const worker = {
  path: "srv/worker.go",
  base: src(
    "package srv",
    "",
    "func (w *Worker) run(job Job) error {",
    "\terr := job.Do()",
    "\tif err != nil {",
    "\t\tw.log(err)",
    "\t}",
    "\tw.wg.Done()",
    "\treturn err",
    "}",
  ),
  head: src(
    "package srv",
    "",
    "func (w *Worker) run(job Job) error {",
    "\terr := job.Do()",
    "\tif err != nil {",
    "\t\tw.log(err)",
    "\t\treturn err",
    "\t}",
    "\tif job.Last {",
    "\t\tw.wg.Done()",
    "\t}",
    "\treturn nil",
    "}",
  ),
};

/** A persisted redux slice gains a field; no version, no migration. */
const slice = {
  path: "src/store/settingsSlice.ts",
  base: src(
    'import { createSlice } from "@reduxjs/toolkit";',
    "const initialState = {",
    '  theme: "light",',
    "  fontSize: 12,",
    "};",
    "export const settingsSlice = createSlice({",
    '  name: "settings",',
    "  initialState,",
    "  reducers: {},",
    "});",
  ),
  head: src(
    'import { createSlice } from "@reduxjs/toolkit";',
    "const initialState = {",
    '  theme: "light",',
    "  fontSize: 12,",
    "  layout: { sidebar: true },",
    "};",
    "export const settingsSlice = createSlice({",
    '  name: "settings",',
    "  initialState,",
    "  reducers: {},",
    "});",
  ),
};
const persistRoot = {
  "src/store/index.ts": src(
    'import { persistReducer } from "redux-persist";',
    'const persistConfig = { key: "root", version: 1, storage };',
    "export const root = persistReducer(persistConfig, reducer);",
  ),
};

/** Two writes with no transaction, and a getter replaced by a cache. */
const orders = {
  path: "app/services/orders.py",
  base: src(
    "class Orders:",
    "    def close(self, order):",
    "        total = self.get_total(order)",
    '        order.status = "closed"',
    "        order.save()",
    "        return total",
  ),
  head: src(
    "class Orders:",
    "    def close(self, order):",
    "        total = self._total",
    '        order.status = "closed"',
    "        order.save()",
    "        Invoice.objects.create(order=order, total=total)",
    "        return total",
  ),
};
const totals = {
  "app/services/totals.py": src(
    "class T:",
    "    def refresh(self, o):",
    "        self._total = sum(o.lines)",
  ),
};

/** A co-write: the diff adds a reset beside a state write other sites make bare. */
const conn = {
  path: "src/conn.c",
  base: src(
    "static void conn_fail(struct conn *c)",
    "{",
    "    c->state = CONN_FAILED;",
    "    notify(c);",
    "}",
  ),
  head: src(
    "static void conn_fail(struct conn *c)",
    "{",
    "    c->state = CONN_FAILED;",
    "    c->retries = 0;",
    "    notify(c);",
    "}",
  ),
};
const reconnect = {
  "src/reconnect.c": src(
    "void reconnect_fail(struct conn *c)",
    "{",
    '    log_warn("x");',
    "    c->state = CONN_FAILED;",
    "    schedule(c);",
    "}",
    "void other(struct conn *c)",
    "{",
    "    c->state = CONN_FAILED;",
    "    c->retries = 0;",
    "}",
  ),
};

// ---------------------------------------------------------------------------

describe("the tool's surface", () => {
  it("is named once and its parameters name every action", () => {
    expect(STATE_EXPLORE_TOOL).toBe("state_explore");
    expect(STATE_EXPLORE_PARAMS.properties.action.enum).toEqual([
      "anchors",
      "writes",
      "reads",
      "exits",
      "siblings",
    ]);
    expect(Object.keys(STATE_EXPLORE_PARAMS.properties)).toEqual([
      "action",
      "worktree",
      "base",
      "head",
      "name",
      "file",
      "line",
    ]);
  });

  it("refuses a malformed request before any read, and still closes the io", async () => {
    const w = world([save]);
    const bad: ExploreRequest[] = [
      { action: "writes" },
      { action: "writes", name: "a b" },
      { action: "reads", name: "x".repeat(81) },
      { action: "exits", file: "src/save.ts" },
      { action: "exits", file: "../etc/passwd", line: 1 },
      { action: "siblings", file: "/abs.ts", line: 2 },
      { action: "siblings", file: "src/save.ts", line: 0 },
      { action: "nope" as ExploreRequest["action"] },
    ];
    for (const r of bad) expect(await run(r, w), JSON.stringify(r)).toMatch(/^refused: /);
    expect(w.reads).toEqual([]);
    expect(w.closed).toBe(bad.length);
    expect(exploreRequestRefusal({ action: "writes", name: "this.state" })).toBeNull();
    expect(exploreRequestRefusal({ action: "reads", name: "s->m_state", file: "src/" })).toBeNull();
  });

  it("reads a dotted or arrow path by its last segment, with its member forms", () => {
    expect(nameFormsOf("this.state")).toMatchObject({ name: "state" });
    expect([...nameFormsOf("s->status")!.forms]).toEqual([
      "status",
      "status_",
      "_status",
      "m_status",
      "mStatus",
    ]);
    expect([...nameFormsOf("loading")!.setters]).toEqual(["setLoading", "set_loading"]);
    expect(nameFormsOf("a.b c")).toBeNull();
  });
});

describe("anchors", () => {
  // MUTATION: drop `firstTokenLine`'s cut (count every leaving exit) — the
  // guard return before `setSaving(true)` would be named too, and the
  // second case below fails.
  it("exit-gap: a companion write added before one exit and missing at another", async () => {
    const a = await anchors(world([save]));
    expect(a).toContain(
      "[exit-gap] src/save.ts:7 (save) — `setSaving(false)` (added) comes before return@L8; not before return@L5 — do the exits that lack it leave the state right?",
    );
    const guarded = {
      path: "src/guard.ts",
      base: src("function f(x) {", "  if (!x) {", "    return;", "  }", "  go(x);", "}"),
      head: src(
        "function f(x) {",
        "  if (!x) {",
        "    return;",
        "  }",
        "  setBusy(true);",
        "  go(x);",
        "}",
      ),
    };
    expect((await anchors(world([guarded]))).filter((l) => l.startsWith("[exit-gap]"))).toEqual([]);
  });

  it("moved-call: a terminal call moved into one branch, with the exits that no longer pass it", async () => {
    const a = await anchors(world([worker]));
    expect(a).toContain(
      "[moved-call] srv/worker.go:10 (run) — `w.wg.Done()` moved from base L8 (depth 1) to depth 2 under `if job.Last` @L9; no copy remains outside the new branch; exits that do not pass it: return@L12 — does every path that reached it before still reach it?",
    );
    expect(isTerminalCallee("Done")).toBe(true);
    expect(isTerminalCallee("setIsLoading")).toBe(true);
    expect(isTerminalCallee("render")).toBe(false);
  });

  // MUTATION: drop the wrap branch in movedCalls (report each pair) — three
  // moved-call anchors appear instead of one wrap and this fails.
  it("moved-call: a block wrapped in a new opener is one wrap, not N moved lines", async () => {
    const wrap = {
      path: "src/sync.ts",
      base: src("function sync(a) {", "  load(a);", "  merge(a);", "  store(a);", "}"),
      head: src(
        "function sync(a) {",
        "  try {",
        "    load(a);",
        "    merge(a);",
        "    store(a);",
        "  } catch (e) {",
        "    log(e);",
        "  }",
        "}",
      ),
    };
    const moved = (await anchors(world([wrap]))).filter((l) => l.startsWith("[moved-call]"));
    expect(moved).toEqual([
      "[moved-call] src/sync.ts:2 (sync) — 3 lines wrapped in `try` (a re-indent: the block moved in whole) — do the paths that skip the new opener still reach what it now guards?",
    ]);
  });

  it("persisted-shape: a persisted slice gains a field and no version changes", async () => {
    const a = await anchors(world([slice], persistRoot));
    expect(a).toContain(
      "[persisted-shape] src/store/settingsSlice.ts:5 (top level) — slice state gains or changes `layout: { sidebar: true },` in a store persisted by redux-persist (src/store/index.ts:1) and the diff changes no `version` or `createMigrate` — what does the new reader do with data the old code stored?",
    );
    // A version bump in the same diff answers the question.
    const bumped = {
      path: "src/store/index.ts",
      base: persistRoot["src/store/index.ts"],
      head: persistRoot["src/store/index.ts"].replace("version: 1", "version: 2"),
    };
    expect(
      (await anchors(world([slice, bumped]))).filter((l) => l.startsWith("[persisted-shape]")),
    ).toEqual([]);
    // No redux-persist in the tree: nothing is stored, so nothing to ask.
    expect(
      (await anchors(world([slice]))).filter((l) => l.startsWith("[persisted-shape]")),
    ).toEqual([]);
  });

  it("persisted-shape: a model column with no migration; protobuf field numbers", async () => {
    const model = {
      path: "app/models/order.py",
      base: src("class Order(Model):", "    total = models.IntegerField()"),
      head: src(
        "class Order(Model):",
        "    total = models.IntegerField()",
        "    currency = models.CharField(max_length=3)",
      ),
    };
    expect(await anchors(world([model]))).toContain(
      "[persisted-shape] app/models/order.py:3 (top level) — column `currency` added or changed in a model or schema file and no migration in the diff — what does the new reader do with data the old code stored?",
    );
    const migration = { path: "app/migrations/0002_currency.py", head: src("ops = []") };
    expect(
      (await anchors(world([model, migration]))).filter((l) => l.startsWith("[persisted-shape]")),
    ).toEqual([]);
    const proto = {
      path: "api/order.proto",
      base: src("message Order {", "  string id = 1;", "  int64 total = 2;", "}"),
      head: src("message Order {", "  string id = 1;", "  string total_text = 2;", "}"),
    };
    expect(await anchors(world([proto]))).toContain(
      "[persisted-shape] api/order.proto:3 (structure unknown) — protobuf field number 2 changes from `int64 total` to `string total_text` — what does the new reader do with data the old code stored?",
    );
  });

  it("writes-no-tx and call-to-cache: two writes with no transaction; a getter replaced by a field", async () => {
    const a = await anchors(world([orders], totals));
    expect(a).toContain(
      "[writes-no-tx] app/services/orders.py:5 (close) — 2 writes in `close` (L5 `.save(`, L6 `.create(`) and no transaction marker in it or above its head — what is stored if the process stops between line 5 and line 6?",
    );
    expect(a).toContain(
      "[call-to-cache] app/services/orders.py:3 (close) — `get_total(…)` replaced by a read of `_total`; `_total` has 1 writer: app/services/totals.py:3 — who keeps it fresh on every path that changed the source?",
    );
    const atomic = {
      ...orders,
      head: orders.head.replace("    def close", "    @transaction.atomic\n    def close"),
    };
    expect(
      (await anchors(world([atomic], totals))).filter((l) => l.startsWith("[writes-no-tx]")),
    ).toEqual([]);
  });

  it("cowrite-gap and new-writer: a reset added beside a write other sites make bare", async () => {
    const a = await anchors(world([conn], reconnect));
    expect(a).toContain(
      "[cowrite-gap] src/conn.c:4 (conn_fail) — `c->retries = 0` added beside `c->state = CONN_FAILED` (L3); that statement occurs at 2 other sites, 1 without `retries` within ±6 lines: src/reconnect.c:4 — do these sites need it too?",
    );
    expect(a).toContain(
      "[new-writer] src/conn.c:4 (conn_fail) — `retries` written here; the head tree holds 2 writers in 2 files (the diff adds 1) and 0 readers; other writers: src/reconnect.c:10 — does this write keep what the other writers and the readers assume?",
    );
  });

  it("ranks, names the kinds that found nothing, and summarises the sweep", async () => {
    const out = await run({ action: "anchors" }, world([save, worker], {}));
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^anchors — /);
    expect(lines[1]).toMatch(/^\[limits: lexical structure/);
    const kinds = lines
      .filter((l) => /^\[[a-z-]+\] /.test(l))
      .map((l) => /^\[([a-z-]+)\]/.exec(l)![1]);
    // a moved terminal call and a terminal companion's gap rank first
    expect(kinds.slice(0, 2).sort()).toEqual(["exit-gap", "moved-call"]);
    expect(lines.at(-1)).toMatch(
      /^swept: 2 changed files \(2 code; 0 test files left out\); tree: searched \d+ of \d+ code files/,
    );
    expect(lines.at(-1)).toMatch(/no anchor: .*persisted-shape/);
  });

  it("says unknown for every kind when the diff cannot be read", async () => {
    const out = await run({ action: "anchors" }, world([save], {}, { diff: async () => null }));
    for (const k of ANCHOR_KINDS)
      expect(out).toContain(`[${k}] unknown: the PR's diff could not be read`);
  });

  // MUTATION: let a file with no structure fall through to the structural
  // kinds silently (drop `structural`'s addUnknown) — this fails.
  it("an unbalanced file is unknown for the structural kinds, never silently clear", async () => {
    const broken = {
      path: "src/broken.ts",
      base: src("function f() {", "  a();"),
      head: src("function f() {", "  a();", "  b();"),
    };
    const out = await run({ action: "anchors" }, world([broken]));
    expect(out).toContain(
      "[exit-gap] unknown: src/broken.ts: structure unknown (1 block still open at the end of the file (the innermost opened at line 1))",
    );
    expect(out).toContain("[writes-no-tx] unknown: src/broken.ts: structure unknown");
    expect(out).not.toMatch(/no anchor: [^\n]*exit-gap/);
  });

  it("an unreadable listing is unknown for the swept kinds", async () => {
    const out = await run(
      { action: "anchors" },
      world([conn], reconnect, { listHead: async () => null }),
    );
    expect(out).toContain(
      "[cowrite-gap] unknown: the head tree listing could not be read, so nothing was swept",
    );
    expect(out).toContain(
      "[new-writer] unknown: the head tree listing could not be read, so nothing was swept",
    );
  });

  it("caps the list and says what it cut", async () => {
    const many = Array.from({ length: EXPLORE_MAX_ANCHORS + 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      base: src(
        `function f${i}(x) {`,
        "  setBusy(true);",
        "  if (x) {",
        "    return 1;",
        "  }",
        "  return 2;",
        "}",
      ),
      head: src(
        `function f${i}(x) {`,
        "  setBusy(true);",
        "  if (x) {",
        "    return 1;",
        "  }",
        "  setBusy(false);",
        "  return 2;",
        "}",
      ),
    }));
    const out = await run({ action: "anchors" }, world(many), { maxChars: 1_000_000 });
    expect(out.split("\n").filter((l) => l.startsWith("[exit-gap] src/"))).toHaveLength(
      EXPLORE_MAX_ANCHORS,
    );
    expect(out).toContain("[cut: 5 more anchors not shown — exit-gap 5]");
    // `busy` is written in every file: 90 writers is an idiom, not a lead,
    // and the left-out field is named rather than silently dropped.
    expect(out).toContain("[new-writer: fields with 30 or more writers left out: busy (90)]");
    expect(out).not.toMatch(/no anchor: [^\n]*new-writer/);
  });
});

describe("writes and reads", () => {
  const tree = {
    "src/a.ts": src(
      "export class Job {",
      "  run() {",
      '    this.status = "running";',
      '    if (this.status === "done") return;',
      "    report(this.status);",
      "    return this.status;",
      "  }",
      "}",
      "// this.status = 'never' in a comment",
      'const msg = "the status changed";',
    ),
    "src/b.go": src(
      "package b",
      "",
      "func (j *Job) stop() {",
      "\tj.status = statusStopped",
      "\tj.setStatus(statusIdle)",
      "}",
    ),
    "src/c.cc": src("void Job::fail() {", "  status_ = kFailed;", "  ++m_status;", "}"),
    "app/d.py": src(
      "def mark(job):",
      "    job.update(status='done')",
      '    db.execute("UPDATE jobs SET status = 1 WHERE status = 0")',
      '    return {"status": job.status}',
    ),
    "src/e.ts": src(
      "interface Job {",
      "  status: Status;",
      "}",
      "const next = { ...job, status: 'x' };",
    ),
    "tests/a.test.ts": src("job.status = 'x';"),
  };

  // MUTATION: drop the comment check in classifyOccurrence (treat a blank
  // code character as code) — the commented write on src/a.ts:9 is listed
  // and this fails.
  it("lists every generic write shape, comments and prose left out, tests left out", async () => {
    const out = await run({ action: "writes", name: "status" }, world([], tree));
    expect(out.split("\n").slice(1)).toEqual([
      "9 sites in 5 files; searched 5 of 5 code files (tests and vendored code left out)",
      'src/a.ts:3  (run)  [member] this.status = "running";',
      "src/b.go:4  (stop)  [member] j.status = statusStopped",
      "src/b.go:5  (stop)  [setter] j.setStatus(statusIdle)",
      "src/c.cc:2  (fail)  [assign] status_ = kFailed;",
      "src/c.cc:3  (fail)  [assign] ++m_status;",
      "app/d.py:2  (mark)  [assign] job.update(status='done')",
      'app/d.py:3  (mark)  [sql] db.execute("UPDATE jobs SET status = 1 WHERE status = 0")',
      'app/d.py:4  (mark)  [key] return {"status": job.status}',
      "src/e.ts:4  (top level)  [key] const next = { ...job, status: 'x' };",
      // The companion table the writes action now ends with: these writes
      // share no statement beside them.
      "usually with — statements beside the writes in at least two-thirds of the writing functions (same block or ±6 lines, same function; a function counted once; keys in a literal left out; by name, literals abstracted):",
      "none",
    ]);
    expect(out).not.toContain("src/a.ts:9");
    expect(out).not.toContain("src/a.ts:10");
    expect(out).not.toContain("src/e.ts:2");
    expect(out).not.toContain("tests/");
  });

  it("splits the reads by use", async () => {
    const out = await run({ action: "reads", name: "status" }, world([], tree));
    expect(out).toMatch(/by use: condition \d+, return \d+, argument \d+, other \d+/);
    expect(out).toContain('src/a.ts:4  (run)  [condition] if (this.status === "done") return;');
    expect(out).toContain("src/a.ts:6  (run)  [return] return this.status;");
    expect(out).toContain("src/a.ts:5  (run)  [argument] report(this.status);");
  });

  it("filters to a path or directory, and lists the diff's files first", async () => {
    const out = await run({ action: "writes", name: "status", file: "app" }, world([], tree));
    expect(out).toContain("searched 1 of 1 code files");
    expect(out).not.toContain("src/");
    const none = await run({ action: "writes", name: "status", file: "nowhere" }, world([], tree));
    expect(none).toContain("unknown: no code file at or under `nowhere`");
  });

  it("classifies one occurrence at a time", () => {
    const occ = (line: string, word: string, code = line) =>
      classifyOccurrence(line, code, line.indexOf(word), word.length, word.startsWith("set"));
    expect(occ("x.state == 1", "state")).toEqual({ kind: "read", how: "condition" });
    expect(occ("x.state = 1", "state")).toEqual({ kind: "write", how: "member" });
    expect(occ("x.state += 1", "state")).toEqual({ kind: "write", how: "member" });
    expect(occ("state := 1", "state")).toEqual({ kind: "write", how: "assign" });
    expect(occ("f(x.state)", "state")).toEqual({ kind: "read", how: "argument" });
    expect(occ("setState(1)", "setState")).toEqual({ kind: "write", how: "setter" });
  });

  // MUTATION: make `whole` always true — a cut sweep that found nothing
  // reads "none in the files searched" with no warning, and this fails.
  it("a cut sweep never reads as none found", async () => {
    let t = 0;
    const big: Record<string, string> = {};
    for (let i = 0; i < 30; i++) big[`src/f${i}.ts`] = "export const x = 1;\n";
    const out = await run({ action: "writes", name: "status" }, world([], big), {
      deadlineMs: 5,
      now: () => (t += 1),
    });
    expect(out).toMatch(/\[cut: the deadline passed after \d+ of 30 code files\]/);
    expect(out).toContain("the sweep was cut, so this clears nothing");
  });

  it("caps the sites shown and counts the rest per file", async () => {
    const many: Record<string, string> = {
      "src/many.ts": Array.from(
        { length: EXPLORE_MAX_SITES + 7 },
        (_, i) => `a${i}.status = 1;`,
      ).join("\n"),
    };
    const out = await run({ action: "writes", name: "status" }, world([], many));
    expect(out.split("\n").filter((l) => l.startsWith("src/many.ts:"))).toHaveLength(
      EXPLORE_MAX_SITES,
    );
    expect(out).toContain("[cut: 7 more not shown — src/many.ts 7]");
  });
});

describe("exits", () => {
  it("lists each exit with its branch chain and the companion table", async () => {
    const out = await run({ action: "exits", file: "src/save.ts", line: 3 }, world([save]));
    expect(out.split("\n")).toEqual([
      "exits of `save` — src/save.ts lines 1–9; head: `export async function save(form: Form)`",
      expect.stringMatching(/^\[limits: /),
      "- return@L5 — via `if (!r.ok)` @L4",
      "- return@L8 — before it in its block: `setSaving(true)` L2, `api.save(…)` L3, `setSaving(false)` L7",
      expect.stringMatching(/^companions — /),
      "- `setSaving(false)` (L7): before return@L8; missing before return@L5",
      expect.stringMatching(/^skipped tails — /),
      "none",
    ]);
  });

  // MUTATION: drop the finally guard from `covers` — the release in the
  // finally block counts for no exit, the explicit one before `return 1`
  // reads as present there and missing before `return 2`, and this fails.
  it("a finally block or a defer counts for every exit it guards", async () => {
    const py = {
      path: "app/lock.py",
      head: src(
        "def work(self):",
        "    self.lock.acquire()",
        "    try:",
        "        if self.done:",
        "            self.lock.release()",
        "            return 1",
        "        return 2",
        "    finally:",
        "        self.lock.release()",
      ),
    };
    const out = await run({ action: "exits", file: "app/lock.py", line: 2 }, world([py]));
    expect(out).toContain("none among exits after each statement's first line");
    const go = {
      path: "srv/m.go",
      head: src(
        "package m",
        "func (s *S) f() error {",
        "\ts.mu.Lock()",
        "\tdefer s.mu.Unlock()",
        "\tif s.x {",
        "\t\treturn nil",
        "\t}",
        "\treturn s.g()",
        "}",
      ),
    };
    expect(await run({ action: "exits", file: "srv/m.go", line: 3 }, world([go]))).toContain(
      "none among exits after each statement's first line",
    );
  });

  it("is unknown outside a function, past the end, or in a file with no structure", async () => {
    const w = world([save, { path: "src/bad.ts", head: src("function f() {", "  g();") }]);
    expect(await run({ action: "exits", file: "src/save.ts", line: 99 }, w)).toMatch(
      /line 99 is past its end/,
    );
    expect(await run({ action: "exits", file: "src/save.ts", line: 10 }, w)).toMatch(
      /not inside a function/,
    );
    expect(await run({ action: "exits", file: "src/bad.ts", line: 2 }, w)).toMatch(
      /structure of `src\/bad.ts` could not be read/,
    );
    expect(await run({ action: "exits", file: "src/none.ts", line: 2 }, w)).toMatch(
      /is not a file in the head tree/,
    );
  });
});

describe("siblings", () => {
  it("lists a statement's other occurrences and the neighbours each lacks", async () => {
    const out = await run(
      { action: "siblings", file: "src/conn.c", line: 3 },
      world([conn], reconnect),
    );
    expect(out).toContain("siblings of src/conn.c:3 (conn_fail): `c->state = CONN_FAILED;`");
    expect(out).toContain("its neighbours (±3 lines): `c->retries = 0` L4, `notify(…)` L5");
    expect(out).toContain("other occurrences — same function: 0, same file: 0, tree: 2");
    expect(out).toContain(
      "src/reconnect.c:4  (reconnect_fail)  c->state = CONN_FAILED; — missing near it (±6): `c->retries = 0`, `notify(…)`",
    );
    expect(out).toContain(
      "src/reconnect.c:9  (other)  c->state = CONN_FAILED; — missing near it (±6): `notify(…)`",
    );
  });

  it("a line with no code is unknown", async () => {
    const out = await run(
      { action: "siblings", file: "src/reconnect.c", line: 7 },
      world([], { "src/reconnect.c": "int a;\n\nint b;\n" }),
    );
    expect(out).toMatch(/past its end|holds no code/);
  });
});

describe("caps and the clock", () => {
  it("cuts the answer at maxChars and says so", async () => {
    const out = await run({ action: "anchors" }, world([save, worker, conn], reconnect), {
      maxChars: 600,
    });
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toMatch(/\[cut: output over 600 characters; \d+ more lines not shown\]$/);
  });

  it("an io that throws is a line of the answer, never a throw", async () => {
    const io = world(
      [save],
      {},
      {
        readHead: async () => {
          throw new Error("boom");
        },
      },
    );
    const out = await run({ action: "exits", file: "src/save.ts", line: 2 }, io);
    expect(out).toMatch(/was not read: it could not be read at the head/);
  });
});

describe("linear", () => {
  // MUTATION: write `.*` for the table-name class `[\w"`.]{1,80}` in
  // SQL_WRITE_RE — an unbounded dot, and this fails.
  it("no probe holds an unbounded scan inside another, and each is fast on pathological lines", () => {
    expect(new Set(STATE_EXPLORE_PROBES.map((p) => p.id)).size).toBe(STATE_EXPLORE_PROBES.length);
    const evil = [
      "if ".repeat(5000),
      "status ".repeat(5000),
      `SET ${"a, ".repeat(3000)}`,
      `${"++a.".repeat(2000)}`,
      `message ${"a ".repeat(4000)}= 1`,
    ];
    const lines = [
      ...evil.map((l) => l.slice(0, LINE_MAX)),
      " ".repeat(100_000) + "x",
      `x${" ".repeat(100_000)}= 1`,
    ];
    const started = performance.now();
    for (const p of STATE_EXPLORE_PROBES) {
      expect(p.re.global || p.re.sticky, p.id).toBe(false);
      const source = p.re.source;
      expect(/(?<!\\)\.[*+]/.test(source), `${p.id}: an unbounded dot`).toBe(false);
      expect(/\)(?:[*+]|\{\d+,\})/.test(source), `${p.id}: an unbounded group`).toBe(false);
      expect(/\\s[*+](?:(?:\\.|[^\\()|])\?)*\\s[*+]/.test(source), `${p.id}: two blank runs`).toBe(
        false,
      );
      for (const l of lines) p.re.test(l);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("anchors: fixes from the offline replay", () => {
  // MUTATION: drop the UNREAD_KINDS loop from runAnchors — the four kinds a
  // file the call could not read never ran on are listed under "no anchor"
  // and this fails.
  it("a changed file that was not read leaves every kind unknown, never silent", async () => {
    const w = world([save], {}, { readHead: async () => null });
    const out = await run({ action: "anchors" }, w);
    for (const k of ANCHOR_KINDS.filter((k) => k !== "persisted-shape"))
      expect(out, k).toContain(`[${k}] unknown: src/save.ts: not read`);
    expect(out).not.toMatch(/no anchor: [^\n]*(?:moved-call|cowrite-gap|new-writer|call-to-cache)/);
  });

  // MUTATIONS, each fails this: drop the added-exit loop from exitGaps (the
  // early return that jumps over the cleanup gets no anchor); require the
  // exit to sit inside a block (the braceless `if (…) return;` is passed
  // over).
  it("an added early exit that jumps over a terminal call is an exit-gap", async () => {
    const grid = {
      path: "src/lv_grid.c",
      base: src(
        "static void grid_update(lv_obj_t * cont, void * user_data)",
        "{",
        "    LV_UNUSED(user_data);",
        "    calc(cont, &c);",
        "    layout(cont, &c);",
        "    calc_free(&c);",
        "    lv_obj_send_event(cont, LV_EVENT_LAYOUT_CHANGED, NULL);",
        "}",
      ),
      head: src(
        "static void grid_update(lv_obj_t * cont, void * user_data)",
        "{",
        "    LV_UNUSED(user_data);",
        "    lv_result_t res = calc(cont, &c);",
        "    if(res != LV_RESULT_OK) return;",
        "    layout(cont, &c);",
        "    calc_free(&c);",
        "    lv_obj_send_event(cont, LV_EVENT_LAYOUT_CHANGED, NULL);",
        "}",
      ),
    };
    expect(await anchors(world([grid]))).toContain(
      "[exit-gap] src/lv_grid.c:5 (grid_update) — return@L5 (added) leaves before `calc_free(…)` L7, `lv_obj_send_event(…)` L8, `layout(…)` L6, which the function's later path reaches — does this exit leave the state right?",
    );
    const exits = await run({ action: "exits", file: "src/lv_grid.c", line: 5 }, world([grid]));
    expect(exits).toContain(
      "- return@L5 skips `calc_free(…)` L7, `lv_obj_send_event(…)` L8, `layout(…)` L6",
    );
  });

  // MUTATION: report a line that kept its own opener under that opener (drop
  // the addedAncestor branch) — three moved-call anchors instead of one wrap.
  it("a block wrapped in a new opener is one wrap, not a move per line", async () => {
    const f = {
      path: "src/w.ts",
      base: src(
        "function f(a) {",
        "  if (a.ok) {",
        "    start();",
        "    step();",
        "    done();",
        "  }",
        "}",
      ),
      head: src(
        "function f(a) {",
        "  if (enabled) {",
        "    if (a.ok) {",
        "      start();",
        "      step();",
        "      done();",
        "    }",
        "  }",
        "}",
      ),
    };
    const moved = (await anchors(world([f]))).filter((l) => l.startsWith("[moved-call]"));
    expect(moved).toEqual([
      "[moved-call] src/w.ts:2 (f) — 3 lines wrapped in `if (enabled)` (a re-indent: the block moved in whole); it holds `done()` L6 — do the paths that skip the new opener still reach what it now guards?",
    ]);
  });

  // MUTATIONS, each fails this: stop the wrapper search at every function
  // (the callback the block moved into reads as a plain re-indent); take any
  // added opener for a new one (the re-indented `if (hash)` becomes the
  // wrapper).
  it("a block moved into a new callback is one anchor that says it now runs later", async () => {
    const f = {
      path: "src/cp.ts",
      base: src(
        "async function save(t) {",
        "  if (t.tracker) {",
        "    const hash = await t.tracker.commit();",
        "    if (hash) {",
        "      const i = findLast(t.messages);",
        "      mark(i);",
        "      if (i >= 0) {",
        "        notify(hash);",
        "      }",
        "    }",
        "  }",
        "}",
      ),
      head: src(
        "async function save(t) {",
        "  if (t.tracker) {",
        "    t.tracker.commit().then(async (hash) => {",
        "      if (hash) {",
        "        const i = findLast(t.messages);",
        "        mark(i);",
        "        if (i >= 0) {",
        "          notify(hash);",
        "        }",
        "      }",
        "    });",
        "  }",
        "}",
      ),
    };
    const moved = (await anchors(world([f]))).filter((l) => l.startsWith("[moved-call]"));
    expect(moved).toEqual([
      "[moved-call] src/cp.ts:3 (<callback of commit>) — 3 lines moved into the new callback `t.tracker.commit().then(async (hash) =>`; it holds `notify(…)` L8 — they now run when it runs, not where they stood: does the code after it rely on them having run?",
    ]);
  });

  // MUTATION: drop the edited-opener rule — the re-indented body of
  // `if (a && b)` and the calls of the reordered, renamed function read as
  // moved, and this fails.
  it("an opener edited in place, or a function reordered, moves no call", async () => {
    const edited = {
      path: "src/e.ts",
      base: src("function g(a) {", "  if (a) {", "  x();", "  }", "}"),
      head: src("function g(a) {", "  if (a && b) {", "    x();", "  }", "}"),
    };
    const reordered = {
      path: "src/r.ts",
      base: src(
        "function load() {",
        "  open();",
        "  read();",
        "}",
        "function b() {",
        "  x();",
        "  y();",
        "  z();",
        "}",
      ),
      head: src(
        "function b() {",
        "  x();",
        "  y();",
        "  z();",
        "}",
        "function loadAll() {",
        "  open();",
        "  read();",
        "}",
      ),
    };
    const out = await anchors(world([edited, reordered]));
    expect(out.filter((l) => l.startsWith("[moved-call]"))).toEqual([]);
  });

  // MUTATION: render the lexed head (`b.head`) — the literal reads as blanks.
  it("a branch is shown as written, string literals included", async () => {
    const f = {
      path: "src/c.ts",
      base: src(
        "async function confirm(choice: string) {",
        '  if (choice === "Cancel") {',
        "    log(choice);",
        "  }",
        "  return;",
        "}",
      ),
      head: src(
        "async function confirm(choice: string) {",
        '  if (choice === "Cancel") {',
        "    log(choice);",
        "    return;",
        "  }",
        "}",
      ),
    };
    const moved = (await anchors(world([f]))).find((l) => l.startsWith("[moved-call]"));
    expect(moved).toContain('under `if (choice === "Cancel")` @L2');
  });

  // MUTATION: drop the isLogCall check from exitGaps — the log line added
  // before one return is an exit-gap and this fails.
  it("a logging call is not a gap among the exits", async () => {
    const f = {
      path: "src/l.ts",
      base: src(
        "function h(r) {",
        "  begin();",
        "  if (!r.ok) {",
        "    return null;",
        "  }",
        "  return r.id;",
        "}",
      ),
      head: src(
        "function h(r) {",
        "  begin();",
        "  if (!r.ok) {",
        '    console.error("failed", r);',
        "    return null;",
        "  }",
        "  return r.id;",
        "}",
      ),
    };
    expect((await anchors(world([f]))).filter((l) => l.startsWith("[exit-gap]"))).toEqual([]);
  });

  // MUTATIONS, each fails this: pair removed[i] with added[i] only (the call
  // on the run's second removed line is never compared); strip only a
  // leading verb from the stem (`lv_text_get_size` shares nothing with
  // `text_size`).
  it("call-to-cache compares every line of a short run and reads a getter word inside a name", async () => {
    const f = {
      path: "src/label.ts",
      base: src(
        "function width(label: Label) {",
        "  trace(label);",
        "  const size = getSize(label.text);",
        "  const box = lv_text_get_size(label.text, font);",
        "  return size.x + box.x;",
        "}",
      ),
      head: src(
        "function width(label: Label) {",
        "  const size = label.cachedSize;",
        "  const box = label.text_size;",
        "  return size.x + box.x;",
        "}",
      ),
    };
    const tree = { "src/cache.ts": src("function refresh(l) {", "  l.cachedSize = 1;", "}") };
    const out = (await anchors(world([f], tree))).filter((l) => l.startsWith("[call-to-cache]"));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("`getSize(…)` replaced by a read of `cachedSize`");
    expect(out[1]).toContain("`lv_text_get_size(…)` replaced by a read of `text_size`");
  });

  // MUTATIONS, each fails this: drop the nothing-stripped check (`Connect`
  // pairs with `connect`); drop TYPE_WORDS from the member read (`GetString`
  // pairs with `.string`); let a non-member read be any name holding the
  // stem (`loadLibrary` pairs with `ModelLibraryLocal`).
  it("call-to-cache leaves out a call that is no getter, a type word and a type name", async () => {
    const f = {
      path: "src/n.ts",
      base: src(
        "function n(m: Mgr, cfg: Cfg) {",
        "  const conn = Connect(m.url);",
        "  const v = cfg.GetString(key);",
        "  const lib = loadLibrary(m.path);",
        "  return [conn, v, lib];",
        "}",
      ),
      head: src(
        "function n(m: Mgr, cfg: Cfg) {",
        "  const conn = m.connect;",
        "  const v = cfg.string;",
        "  const lib = ModelLibraryLocal.of(m.path);",
        "  return [conn, v, lib];",
        "}",
      ),
    };
    expect((await anchors(world([f]))).filter((l) => l.startsWith("[call-to-cache]"))).toEqual([]);
  });

  // MUTATIONS, each fails this: drop genericField (`in` is swept and
  // anchored); drop the per-file cap (the first file's twelve fields take
  // every slot and `omega` is never swept).
  it("new-writer skips short names and gives each changed file a share of the sweep", async () => {
    const many = {
      path: "src/a.ts",
      base: src("function a(s) {", "  s.x = 0;", "}"),
      head: src(
        "function a(s) {",
        "  s.x = 0;",
        "  s.in = 1;",
        ...Array.from({ length: 12 }, (_, i) => `  s.field${i} = ${i};`),
        "}",
      ),
    };
    const one = {
      path: "src/b.ts",
      base: src("function b(s) {", "  s.y = 0;", "}"),
      head: src("function b(s) {", "  s.y = 0;", "  s.omega = 1;", "}"),
    };
    const tree = {
      "src/r.ts": src(
        "function r(s) {",
        "  if (s.omega) go();",
        "  if (s.in) go();",
        ...Array.from({ length: 12 }, (_, i) => `  if (s.field${i}) go();`),
        "}",
      ),
    };
    const out = await run({ action: "anchors" }, world([many, one], tree), { maxChars: 100_000 });
    expect(out).toContain("[new-writer] src/b.ts:3 (b) — `omega` written here");
    expect(out).not.toContain("`in` written here");
  });

  // MUTATIONS, each fails this: drop isIdiom from cowritePairs (the pair is
  // made with `LV_UNUSED`); drop the busy-site filter (the pair beside a
  // statement at 25 sites is anchored).
  it("cowrite-gap passes over idioms and leaves out a partner found everywhere", async () => {
    const f = {
      path: "src/k.c",
      base: src("void k(int e) {", "    LV_UNUSED(e);", "    reset(state);", "}"),
      head: src(
        "void k(int e) {",
        "    LV_UNUSED(e);",
        "    cleanup(state);",
        "    reset(state);",
        "}",
      ),
    };
    const tree = { "src/m.c": src("void m(void) {", "    reset(state);", "}") };
    const out = await anchors(world([f], tree));
    expect(out.find((l) => l.startsWith("[cowrite-gap]"))).toContain(
      "`cleanup(…)` added beside `reset(state)` (L4)",
    );
    const busy: Record<string, string> = {};
    for (let i = 0; i < 25; i++)
      busy[`src/m${i}.c`] = src(`void m${i}(void) {`, "    reset(state);", "}");
    const text = await run({ action: "anchors" }, world([f], busy), { maxChars: 100_000 });
    expect(text).not.toContain("[cowrite-gap] src/k.c");
    expect(text).toContain(
      "[cowrite-gap: 1 pair beside a statement found at 20 or more sites left out",
    );
    expect(text).not.toMatch(/no anchor: [^\n]*cowrite-gap/);
  });

  // MUTATION: make yieldTurn resolve at once — an in-memory io never leaves
  // the microtask queue, so no other turn of the event loop runs and this
  // fails.
  it("a long anchors call yields the event loop between files", async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `src/y${i}.ts`,
      base: src(`function y${i}(s) {`, "  s.a = 1;", "}"),
      head: src(`function y${i}(s) {`, "  s.a = 1;", "  s.b = 2;", "}"),
    }));
    let turns = 0;
    let on = true;
    const tick = (): void => {
      if (!on) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    await run({ action: "anchors" }, world(files));
    on = false;
    expect(turns).toBeGreaterThanOrEqual(20);
  });

  // MUTATION: drop the budget check from cowritePairs — every added line is
  // examined and the co-write kind claims a whole look it did not take.
  it(
    "added lines past the per-call budget are not examined, and the kinds say so",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const n = EXPLORE_MAX_ADDED_LINES + 50;
      const big = {
        path: "src/big.ts",
        head: Array.from({ length: n }, (_, i) => `x.f${i}=1`).join("\n") + "\n",
      };
      const out = await run({ action: "anchors" }, world([big]), { deadlineMs: 120_000 });
      expect(out).toContain(
        `[cowrite-gap] unknown: added lines past the first ${EXPLORE_MAX_ADDED_LINES} were not examined`,
      );
      expect(out).toContain(
        `[new-writer] unknown: added lines past the first ${EXPLORE_MAX_ADDED_LINES} were not examined`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// The second replay: seven state defects the lenses missed with the tool in
// hand. Each fixture is the shape of one cause, in generic names.

/** A field written by three functions, each followed by a dirty mark; the
 * diff adds a fourth writer in a loop. `marks` says which old writers mark. */
function chainWorld(marks: readonly boolean[], newMarks = false): World {
  const old = (name: string, op: string, mark: boolean): string[] => [
    `void ${name}(Node *n)`,
    "{",
    `    n->status ${op};`,
    ...(mark ? ["    m_index.m_changed.insert(n);"] : ["    n->seen = true;"]),
    `    log_debug("${name}");`,
    "}",
  ];
  const ops = ["|= F_BAD", "|= F_BAD_PARENT", "&= ~F_MASK", "= 0"];
  const base = marks.flatMap((m, i) => old(`writer_${i}`, ops[i]!, m));
  const head = [
    ...base,
    "void relabel_children(Node *parent)",
    "{",
    "    for (Node *it = parent->first; it; it = it->next) {",
    "        it->status = (it->status & ~F_BAD) | F_BAD_PARENT;",
    ...(newMarks ? ["        m_index.m_changed.insert(it);"] : []),
    "    }",
    "}",
  ];
  return world([{ path: "src/chain.cpp", base: src(...base), head: src(...head) }]);
}

describe("writer-companion", () => {
  // MUTATIONS, each fails this: drop the check that the new write lacks the
  // partner (the marked loop is anchored too); drop isLogCall from
  // usualPartners (`log_debug(…)`, beside every old write, is named as well).
  it("a new write of a field without the statement every other write of it makes (C++)", async () => {
    const a = (await anchors(chainWorld([true, true, true]))).filter((l) =>
      l.startsWith("[writer-companion]"),
    );
    expect(a).toEqual([
      "[writer-companion] src/chain.cpp:22 (relabel_children) — `status` written here without `m_index.m_changed.insert(…)`, which sits beside the writes of `status` in 3 of 3 other functions that write it in this file (src/chain.cpp:3, src/chain.cpp:9, src/chain.cpp:15) — does this write need it?",
    ]);
    const marked = await anchors(chainWorld([true, true, true], true));
    expect(marked.filter((l) => l.startsWith("[writer-companion]"))).toEqual([]);
  });

  // MUTATIONS, each fails this: drop the two-thirds rule from usualPartners
  // (keep "at least two") — the partner beside 2 of 4 writing functions is
  // anchored; drop MIN_COMPANION_UNITS from writerCompanions — the partner
  // beside 2 of 3 is anchored.
  it("a partner beside fewer than two-thirds, or fewer than three, of the writing functions is no partner", async () => {
    const threeOfFour = (await anchors(chainWorld([true, true, true, false]))).filter((l) =>
      l.startsWith("[writer-companion]"),
    );
    expect(threeOfFour).toHaveLength(1);
    expect(threeOfFour[0]).toContain(
      "which sits beside the writes of `status` in 3 of 4 other functions that write it in this file",
    );
    // Two of three is a coincidence as often as a convention.
    const twoOfThree = (await anchors(chainWorld([true, true, false]))).filter((l) =>
      l.startsWith("[writer-companion]"),
    );
    expect(twoOfThree).toEqual([]);
    const half = (await anchors(chainWorld([true, true, false, false]))).filter((l) =>
      l.startsWith("[writer-companion]"),
    );
    expect(half).toEqual([]);
    // With one other writer there is nothing to call usual.
    const one = (await anchors(chainWorld([true]))).filter((l) =>
      l.startsWith("[writer-companion]"),
    );
    expect(one).toEqual([]);
  });

  // MUTATION: hold every new write to the whole tree's writers (drop the
  // file scope in writerCompanions) — the three unmarked writers elsewhere
  // bring the mark to half, the file's own convention is lost and the first
  // case fails.
  it("a new write is held to its own file's writers when the file has three, else to the tree's", async () => {
    const unmarked = {
      "src/load.cpp": src(
        ...[0, 1, 2].flatMap((i) => [
          `void load_${i}(Node *n, Disk *d)`,
          "{",
          "    n->status = d->status;",
          "}",
        ]),
      ),
    };
    const w = chainWorld([true, true, true]);
    const tree = world(
      [
        {
          path: "src/chain.cpp",
          base: (await w.readBase("src/chain.cpp"))!,
          head: (await w.readHead("src/chain.cpp"))!,
        },
      ],
      unmarked,
    );
    expect((await anchors(tree)).filter((l) => l.startsWith("[writer-companion]"))).toEqual([
      "[writer-companion] src/chain.cpp:22 (relabel_children) — `status` written here without `m_index.m_changed.insert(…)`, which sits beside the writes of `status` in 3 of 3 other functions that write it in this file (src/chain.cpp:3, src/chain.cpp:9, src/chain.cpp:15) — does this write need it?",
    ]);
    // One writer in the file and two elsewhere: the tree's writers are the peers.
    const spread = world(
      [
        {
          path: "src/fresh.cpp",
          base: src(
            "void a(Node *n)",
            "{",
            "    n->status = 1;",
            "    m_index.m_changed.insert(n);",
            "}",
          ),
          head: src(
            "void a(Node *n)",
            "{",
            "    n->status = 1;",
            "    m_index.m_changed.insert(n);",
            "}",
            "void b(Node *n)",
            "{",
            "    n->status = 2;",
            "}",
          ),
        },
      ],
      {
        "src/old.cpp": src(
          ...[0, 1].flatMap((i) => [
            `void o_${i}(Node *n)`,
            "{",
            `    n->status = ${i};`,
            "    m_index.m_changed.insert(n);",
            "}",
          ]),
        ),
      },
    );
    expect((await anchors(spread)).filter((l) => l.startsWith("[writer-companion]"))).toEqual([
      "[writer-companion] src/fresh.cpp:8 (b) — `status` written here without `m_index.m_changed.insert(…)`, which sits beside the writes of `status` in 3 of 3 other functions that write it in the head tree (src/fresh.cpp:3, src/old.cpp:3, src/old.cpp:8) — does this write need it?",
    ]);
  });

  // MUTATION: drop the usuallyWith call from runName — the writes action
  // ends without the companion table and this fails.
  it("the writes action ends with the statements that usually sit beside the writes", async () => {
    const out = await run({ action: "writes", name: "status" }, chainWorld([true, true, true]));
    expect(out).toContain(
      "usually with — statements beside the writes in at least two-thirds of the writing functions (same block or ±6 lines, same function; a function counted once; keys in a literal left out; by name, literals abstracted):\n- `m_index.m_changed.insert(…)` beside the writes in 3 of 4 functions; not beside: src/chain.cpp:22",
    );
    expect(out).not.toContain("`log_debug(…)` beside");
  });

  it("a changed file that cannot be read leaves the kind unknown", async () => {
    const out = await run({ action: "anchors" }, chainWorld([true, true, true]), {});
    expect(out).not.toMatch(/no anchor: [^\n]*writer-companion/);
    const blind = world(
      [{ path: "src/chain.cpp", base: src("int a;"), head: src("int a;", "int b;") }],
      {},
      { listHead: async () => null },
    );
    expect(await run({ action: "anchors" }, blind)).toContain(
      "[writer-companion] unknown: the head tree listing could not be read, so nothing was swept",
    );
  });
});

/** A module-level Map written by `.set`/`.delete`; one failure path clears
 * it and the other does not. */
const link = {
  path: "src/link.ts",
  head: src(
    "const sessionCache: Map<string, Session[]> = new Map();",
    "export async function connect(name: string, client: Client) {",
    "  client.onerror = () => {",
    "    markState(name, State.OFFLINE);",
    "    sessionCache.delete(name);",
    "  };",
    "  try {",
    "    const sessions = await client.listSessions();",
    "    sessionCache.set(name, sessions);",
    "    await discover(client);",
    "  } catch (e) {",
    "    markState(name, State.OFFLINE);",
    "  }",
    "}",
  ),
};

describe("write shapes", () => {
  // MUTATION: drop RECEIVER_METHOD_AFTER_RE from classifyOccurrence — the
  // Map's `.set`/`.delete` read as reads and this fails.
  it("a Map or Set `.set`/`.delete`/`.clear`/`.add` writes its receiver (TS)", async () => {
    const out = await run({ action: "writes", name: "sessionCache" }, world([link]));
    expect(out).toContain("src/link.ts:5  (onerror)  [collection] sessionCache.delete(name);");
    expect(out).toContain(
      "src/link.ts:9  (connect)  [collection] sessionCache.set(name, sessions);",
    );
    expect(out).toMatch(/^2 sites in 1 file;/m);
  });

  // MUTATION: drop CHAIN_ASSIGN_AFTER_RE from classifyOccurrence — the store
  // into `warp.transform.mat` is no write of `warp` and this fails.
  it("a store through a member chain writes every member on its left side (C)", async () => {
    const view = {
      path: "src/render.c",
      head: src(
        "static bool draw(struct out *o, struct frame *f)",
        "{",
        "    struct opts *cfg = o->cfg;",
        "    if (f->flipped) {",
        "        cfg->warp.transform.mat = mirror_matrix();",
        "        args.warp = &cfg->warp;",
        "        cfg->views[0].scale = 2;",
        "    }",
        "    return true;",
        "}",
      ),
    };
    const writes = await run({ action: "writes", name: "warp" }, world([view]));
    expect(writes).toContain(
      "src/render.c:5  (draw)  [chain] cfg->warp.transform.mat = mirror_matrix();",
    );
    expect(writes).toContain("src/render.c:6  (draw)  [member] args.warp = &cfg->warp;");
    expect(await run({ action: "writes", name: "views" }, world([view]))).toContain(
      "src/render.c:7  (draw)  [chain] cfg->views[0].scale = 2;",
    );
    const reads = await run({ action: "reads", name: "warp" }, world([view]));
    expect(reads).not.toContain("src/render.c:5");
  });

  // MUTATION: drop `(?<!-)` from COND_BEFORE_RE — the `>` of `->` reads as a
  // comparison and a plain member read is called a condition.
  it("the arrow of a member access is no comparison", () => {
    const occ = (line: string, word: string) =>
      classifyOccurrence(line, line, line.lastIndexOf(word), word.length, false);
    expect(occ("x = p->state;", "state")).toEqual({ kind: "read", how: "other" });
    expect(occ("if (a > state) go();", "state")).toEqual({ kind: "read", how: "condition" });
  });

  // MUTATIONS, each fails this: drop the alias search from nameRequest (the
  // writes through `p` are not listed); drop aliasTargetBack from
  // newWriterFields (the added `p->mode` write is no new writer of `state`).
  it("a write through a local pointer to a member is a write of that member (C)", async () => {
    const base = src(
      "void apply(struct out *o)",
      "{",
      "    struct opts *p = &o->state;",
      "    p->count++;",
      "}",
      "void read_only(struct out *o)",
      "{",
      "    const struct opts *q = &o->state;",
      "    show(q->mode);",
      "}",
    );
    const head = base.replace("    p->count++;\n", "    p->mode = MODE_FLIP;\n    p->count++;\n");
    const w = world([{ path: "src/apply.c", base, head }]);
    const out = await run({ action: "writes", name: "state" }, w);
    expect(out).toContain("src/apply.c:4  (apply)  [via p] p->mode = MODE_FLIP;");
    expect(out).toContain("src/apply.c:5  (apply)  [via p] p->count++;");
    expect(out).not.toContain("src/apply.c:10");
    expect(await anchors(w)).toContainEqual(
      expect.stringMatching(/^\[new-writer\] src\/apply\.c:4 \(apply\) — `state` written here/),
    );
  });

  // MUTATIONS, each fails this: drop ATOMIC_ARG_BEFORE_RE (the C11 calls are
  // reads); drop `store|exchange|fetch_…` from RECEIVER_METHOD_AFTER_RE (the
  // C++ member calls are reads).
  it("C11 and C++ atomics are writes (C, C++)", async () => {
    const tree = {
      "src/server.c": src(
        "static void add_conn(struct conn *c)",
        "{",
        "    list_add(config.conns, c);",
        "    atomic_fetch_add_explicit(&config.active_conns, 1, memory_order_relaxed);",
        "}",
        "static void drop_conn(struct conn *c)",
        "{",
        "    atomic_store(&config.active_conns, 0);",
        "    if (atomic_load(&config.active_conns) == 0) stop();",
        "}",
      ),
      "src/pool.cpp": src(
        "void Pool::reset() {",
        "  active_conns_.store(0);",
        "  active_conns_.fetch_add(1, std::memory_order_acq_rel);",
        "  active_conns_.compare_exchange_weak(expected, 2);",
        "}",
      ),
    };
    const out = await run({ action: "writes", name: "active_conns" }, world([], tree));
    expect(out.split("\n").filter((l) => /\[atomic\]/.test(l))).toEqual([
      "src/server.c:4  (add_conn)  [atomic] atomic_fetch_add_explicit(&config.active_conns, 1, memory_order_relaxed);",
      "src/server.c:8  (drop_conn)  [atomic] atomic_store(&config.active_conns, 0);",
      "src/pool.cpp:2  (reset)  [atomic] active_conns_.store(0);",
      "src/pool.cpp:3  (reset)  [atomic] active_conns_.fetch_add(1, std::memory_order_acq_rel);",
      "src/pool.cpp:4  (reset)  [atomic] active_conns_.compare_exchange_weak(expected, 2);",
    ]);
    expect(out).not.toContain("src/server.c:9");
  });
});

describe("siblings, both ways", () => {
  // MUTATION: drop originalLacks from runSiblings — the answer asked at the
  // catch path no longer names the delete the other path makes, and this
  // fails (the forward rows alone depend on which of the two lines is asked).
  it("names what the statement asked about lacks that most other occurrences have (TS)", async () => {
    const out = await run({ action: "siblings", file: "src/link.ts", line: 12 }, world([link]));
    expect(out).toContain("other occurrences — same function: 0, same file: 1, tree: 1");
    expect(out).toContain(
      "what src/link.ts:12 lacks — statements beside more than half of the other occurrences (±3) and not within ±6 lines of it: `sessionCache.delete(…)` (beside 1 of 1)",
    );
    const back = await run({ action: "siblings", file: "src/link.ts", line: 4 }, world([link]));
    expect(back).toContain("src/link.ts:12  (connect)");
    expect(back).not.toMatch(/what src\/link\.ts:4 lacks[^\n]*sessionCache\.delete/);
  });
});

describe("writes-no-tx, second replay", () => {
  // MUTATION: count each line of a continued statement as its own write
  // (drop the `stmt === lastStmt` skip) — the builder's `.update(` and
  // `.execute(` read as two writes and this fails.
  it("a chained query builder statement is one write (TS)", async () => {
    const repo = {
      path: "src/order.repository.ts",
      base: src(
        "export class OrderRepository {",
        "  async closeAll(ids: string[], target: string) {",
        "    return ids;",
        "  }",
        "}",
      ),
      head: src(
        "export class OrderRepository {",
        "  async closeAll(ids: string[], target: string) {",
        "    await this.manager",
        "      .createQueryBuilder()",
        "      .update(Order)",
        "      .set({ shelf: target })",
        "      .where({ id: In(ids) })",
        "      .execute();",
        "    return ids;",
        "  }",
        "}",
      ),
    };
    expect((await anchors(world([repo]))).filter((l) => l.startsWith("[writes-no-tx]"))).toEqual(
      [],
    );
  });

  // MUTATIONS, each fails this: drop storeCall (the service's own
  // `this.archive(` and the repository's `moveToShelf(` are no writes);
  // drop the loop anchor (the per-item write is named only as one of two).
  it("a store write per item in a loop, and store methods by their receiver's name (TS)", async () => {
    const svc = {
      path: "src/batch.service.ts",
      base: src(
        "export class BatchService {",
        "  async retireBatch(user: User, batchId: string) {",
        "    const orders = await this.orderRepository.findBy({ batchId });",
        "    return orders;",
        "  }",
        "}",
      ),
      head: src(
        "export class BatchService {",
        "  async retireBatch(user: User, batchId: string) {",
        "    const orders = await this.orderRepository.findBy({ batchId });",
        "    for (const o of orders) {",
        "      await this.archive(user, o.id);",
        "    }",
        "    await this.orderRepository.moveToShelf(batchId, null);",
        "    return orders;",
        "  }",
        "}",
      ),
    };
    expect((await anchors(world([svc]))).filter((l) => l.startsWith("[writes-no-tx]"))).toEqual([
      "[writes-no-tx] src/batch.service.ts:5 (retireBatch) — L5 `this.archive(` writes once per item inside `for (const o of orders)` @L4 in `retireBatch`, and no transaction marker in it or above its head — what is stored if the process stops partway through the items?",
      "[writes-no-tx] src/batch.service.ts:5 (retireBatch) — 2 writes in `retireBatch` (L5 `this.archive(`, L7 `orderRepository.moveToShelf(`) and no transaction marker in it or above its head — what is stored if the process stops between line 5 and line 7?",
    ]);
    // `this.` in a class not named for a store is not a store write.
    const view = { ...svc, head: svc.head.replace("BatchService", "BatchView") };
    const out = (await anchors(world([view]))).filter((l) => l.startsWith("[writes-no-tx]"));
    expect(out).toEqual([]);
  });

  // MUTATION: make the verb match lowercase only — Go's exported
  // `UpdateStatus` is no write and this fails.
  it("a store write per item in a Go loop, an exported method name", async () => {
    const g = {
      path: "srv/archive.go",
      base: src(
        "package srv",
        "",
        "func (s *Service) ArchiveAll(ids []string) error {",
        "\treturn nil",
        "}",
      ),
      head: src(
        "package srv",
        "",
        "func (s *Service) ArchiveAll(ids []string) error {",
        "\tfor _, id := range ids {",
        "\t\tif err := s.store.UpdateStatus(id, Archived); err != nil {",
        "\t\t\treturn err",
        "\t\t}",
        "\t}",
        "\treturn nil",
        "}",
      ),
    };
    expect((await anchors(world([g]))).filter((l) => l.startsWith("[writes-no-tx]"))).toEqual([
      "[writes-no-tx] srv/archive.go:5 (ArchiveAll) — L5 `store.UpdateStatus(` writes once per item inside `for _, id := range ids` @L4 in `ArchiveAll`, and no transaction marker in it or above its head — what is stored if the process stops partway through the items?",
    ]);
  });
});

/** An io whose one changed file appends `added` to `base`, with the patch
 * written directly (no line diff of a large file). */
function appendWorld(
  path: string,
  base: string,
  added: string[],
  tree: Record<string, string> = {},
): World {
  const baseLines = base.split("\n").length - 1;
  const head = base + src(...added);
  return world(
    [],
    { ...tree, [path]: head },
    {
      readBase: async (p) => (p === path ? base : (tree[p] ?? null)),
      diff: async () => [
        {
          filename: path,
          additions: added.length,
          deletions: 0,
          status: "modified",
          patch: [
            `@@ -${baseLines},0 +${baseLines + 1},${added.length} @@`,
            ...added.map((l) => `+${l}`),
          ].join("\n"),
        },
      ],
    },
  );
}

describe("file caps", () => {
  // MUTATION: give a changed file the tree cap (return EXPLORE_MAX_FILE_BYTES
  // from capOf for every path) — the 400 KiB changed file is not read, the
  // anchor is gone and this fails.
  it(
    "a changed file up to 1 MiB is read; an unchanged one over 256 KiB is still not swept",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      expect(EXPLORE_MAX_FILE_BYTES).toBe(256 * 1024);
      expect(EXPLORE_MAX_CHANGED_FILE_BYTES).toBe(1024 * 1024);
      const filler: string[] = [];
      for (let size = 0, i = 0; size < 400 * 1024; i++) {
        const l = `static int pad_${i}(int a) { return a + ${i}; }`;
        filler.push(l);
        size += l.length + 1;
      }
      const writers = [0, 1, 2].flatMap((i) => [
        `void writer_${i}(Node *n)`,
        "{",
        `    n->status |= FLAG_${i};`,
        "    m_index.m_changed.insert(n);",
        "}",
      ]);
      const base = src(...filler, ...writers);
      const added = [
        "void relabel_children(Node *parent)",
        "{",
        "    for (Node *it = parent->first; it; it = it->next) {",
        "        it->status = 0;",
        "    }",
        "}",
      ];
      const bigTree = { "src/other.cpp": src(...filler, "void w(Node *n) { n->status = 1; }") };
      const w = appendWorld("src/big.cpp", base, added, bigTree);
      const out = await run({ action: "anchors" }, w, { deadlineMs: 120_000, maxChars: 100_000 });
      const at = filler.length + writers.length + 4;
      expect(out).toContain(
        `[writer-companion] src/big.cpp:${at} (relabel_children) — \`status\` written here without \`m_index.m_changed.insert(…)\``,
      );
      expect(out).toContain("not searched: src/other.cpp (it is over 256 KiB)");
      expect(out).not.toContain("src/big.cpp: not read");
    },
  );
});

describe("linear at the changed-file cap", () => {
  // A timing bound, not a fence: every pass the anchors take over a changed
  // file is linear in its lines or capped (companions per request, alias
  // searches, functions walked, added lines examined), so a 1 MiB file of
  // the shapes the passes work hardest on finishes in seconds. This catches
  // a pass gone quadratic (minutes); a constant factor is below what a timer
  // can tell under load.
  it(
    "an adversarial 1 MiB C file, added whole, is shaped and anchored within a bound",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const parts: string[] = [];
      let i = 0;
      // The text's length is counted as it grows: a join per round is
      // quadratic and would time the test, not the tool.
      let size = 0;
      while (size < 1000 * 1024) {
        const at = parts.length;
        parts.push(
          `void w_${i}(struct node *n, struct out *o)`,
          "{",
          "    struct opts *p = &o->state;",
          `    n->status |= F_${i % 7};`,
          "    m_index.m_changed.insert(n);",
          `    p->a${i % 5}.b.c[${i % 3}].d = n->status;`,
          "    if (n->x) { if (n->y) { if (n->z) { return; } } }",
          `    atomic_fetch_add_explicit(&o->count, 1, memory_order_relaxed);`,
          "    cache.set(n, p);",
          "}",
          `int g_${i} = ${"a->".repeat(40)}b;`,
        );
        for (let k = at; k < parts.length; k++) size += parts[k]!.length + 1;
        i++;
      }
      const text = src(...parts);
      expect(text.length).toBeGreaterThan(1000 * 1024);
      expect(text.length).toBeLessThanOrEqual(EXPLORE_MAX_CHANGED_FILE_BYTES);
      const w = world(
        [],
        { "src/hot.c": text },
        {
          readBase: async () => null,
          diff: async () => [
            {
              filename: "src/hot.c",
              additions: parts.length,
              deletions: 0,
              status: "added",
              patch: [`@@ -0,0 +1,${parts.length} @@`, ...parts.map((l) => `+${l}`)].join("\n"),
            },
          ],
        },
      );
      const started = performance.now();
      const out = await run({ action: "anchors" }, w, { deadlineMs: 600_000, maxChars: 100_000 });
      const ms = performance.now() - started;
      expect(out).not.toContain("src/hot.c: not read");
      expect(out).not.toContain("deadline");
      expect(ms).toBeLessThan(20_000);
    },
  );

  // MUTATION: drop the MAX_MOVED_LINES budget from movedCalls — every one of
  // ten thousand moved lines is compared over its file's blocks, the call
  // goes quadratic, and the cut this asserts is never said.
  it(
    "a 1 MiB changed file with ten thousand moved lines compares a capped number and says so",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const b: string[] = [];
      const h: string[] = [];
      const patch: string[] = [];
      for (let i = 0, size = 0; size < 1000 * 1024; i++) {
        patch.push(
          `@@ -${b.length + 3},1 +${h.length + 3},3 @@`,
          "-    n->status = 1;",
          "+    if (n->ok) {",
          "+        n->status = 1;",
          "+    }",
        );
        b.push(`void w_${i}(struct node *n)`, "{", "    n->status = 1;", "    free_node(n);", "}");
        const fn = [
          `void w_${i}(struct node *n)`,
          "{",
          "    if (n->ok) {",
          "        n->status = 1;",
          "    }",
          "    free_node(n);",
          "}",
        ];
        h.push(...fn);
        for (const l of fn) size += l.length + 1;
      }
      const head = src(...h);
      const base = src(...b);
      expect(head.length).toBeGreaterThan(1000 * 1024);
      expect(head.length).toBeLessThanOrEqual(EXPLORE_MAX_CHANGED_FILE_BYTES);
      const w = world(
        [],
        { "src/hot.c": head },
        {
          readBase: async () => base,
          diff: async () => [
            {
              filename: "src/hot.c",
              additions: 0,
              deletions: 0,
              status: "modified",
              patch: patch.join("\n"),
            },
          ],
        },
      );
      const started = performance.now();
      const out = await run({ action: "anchors" }, w, { deadlineMs: 600_000, maxChars: 100_000 });
      expect(out).toContain(
        "[moved-call] unknown: moved lines past the first 200 were not compared one by one",
      );
      expect(performance.now() - started).toBeLessThan(20_000);
    },
  );
});

const only = (kind: string, lines: string[]): string[] =>
  lines.filter((l) => l.startsWith(`[${kind}]`));

/** Writers of `field` in the tree, one function each: `marked` of them with
 * the partner statement beside the write, the rest without. */
function writersTree(field: string, partner: string, marked: number, bare = 0): string {
  const out: string[] = [];
  for (let i = 0; i < marked + bare; i++)
    out.push(
      `void w_${i}(struct node *n)`,
      "{",
      `    n->${field} = ${i};`,
      ...(i < marked ? [`    ${partner};`] : ["    n->seen = 1;"]),
      "}",
    );
  return src(...out);
}

describe("persisted-shape: a struct's own body", () => {
  // MUTATION: test /\bstruct\b/ against the enclosing block's head again (in
  // persistedShapes) — the function whose parameter is a struct pointer reads
  // as a struct with a version field and this fails.
  it("a function whose head names a struct type is no struct; a struct still is (C)", async () => {
    const fnCase = world([
      {
        path: "v/l.c",
        base: src(
          "int load(struct cfg *c)",
          "{",
          "    int version = c->version;",
          "    return version;",
          "}",
        ),
        head: src(
          "int load(struct cfg *c)",
          "{",
          "    int version = c->version;",
          "    c->loaded = 1;",
          "    return version;",
          "}",
        ),
      },
    ]);
    expect(only("persisted-shape", await anchors(fnCase))).toEqual([]);
    const structCase = world([
      {
        path: "v/s.c",
        base: src("struct cfg {", "    int version;", "    int a;", "};"),
        head: src("struct cfg {", "    int version;", "    int a;", "    int b;", "};"),
      },
    ]);
    expect(only("persisted-shape", await anchors(structCase))).toEqual([
      expect.stringMatching(
        /^\[persisted-shape\] v\/s\.c:4 \(top level\) — a field added to a struct that carries a version field/,
      ),
    ]);
  });

  // A timing bound, not a fence: the struct-version check reads each
  // struct's body once, so a 1 MiB added function whose head names a struct
  // type (every added line inside it) finishes in well under a second; the
  // per-line rescan it replaces took about a minute.
  it(
    "a 1 MiB added function with struct parameters is anchored within a bound (C)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const parts = ["void f(struct s *p, struct s *q)", "{"];
      for (let i = 0, size = 0; size < 1000 * 1024; i++) {
        const l = `    p->a${i % 97} = q->version + ${i};`;
        parts.push(l);
        size += l.length + 1;
      }
      parts.push("}");
      const w = world(
        [],
        { "src/hot.c": src(...parts) },
        {
          readBase: async () => null,
          diff: async () => [
            {
              filename: "src/hot.c",
              additions: parts.length,
              deletions: 0,
              status: "added",
              patch: [`@@ -0,0 +1,${parts.length} @@`, ...parts.map((l) => `+${l}`)].join("\n"),
            },
          ],
        },
      );
      const started = performance.now();
      const out = await run({ action: "anchors" }, w, { deadlineMs: 600_000, maxChars: 100_000 });
      expect(out).not.toContain("src/hot.c: not read");
      expect(out).not.toContain("deadline");
      expect(performance.now() - started).toBeLessThan(20_000);
    },
  );
});

describe("persisted-shape and the deadline", () => {
  // MUTATION: drop the ctx.late() check before the persisted-shape pass —
  // past the deadline the kind is walked anyway, and with nothing found it
  // reads as "no anchor" and this fails.
  it("past the deadline the persisted-shape pass says it did not run", async () => {
    let t = 0;
    const out = await run({ action: "anchors" }, world([save]), {
      now: () => (t += 1000),
      deadlineMs: 1500,
    });
    expect(out).toContain(
      "[persisted-shape] unknown: src/save.ts and the files after it: the deadline passed",
    );
    expect(out).not.toMatch(/no anchor: [^\n]*persisted-shape/);
  });
});

describe("why a changed file was not read", () => {
  // MUTATION: drop the listing read from Ctx.head (the size is unknown when
  // the anchors read a changed file before any sweep) — the oversize file is
  // reported as "could not be read at the head" and this fails.
  it("a changed file over the cap is over the cap, and a base that cannot be read says so", async () => {
    const big = world(
      [{ path: "s/big.c", base: src("int a;"), head: src("int a;", "int b;") }],
      {},
      {
        listHead: async () => [{ path: "s/big.c", size: 2 * 1024 * 1024 }],
        readHead: async () => null,
      },
    );
    const out = await run({ action: "anchors" }, big);
    expect(out).toContain("[new-writer] unknown: s/big.c: not read (it is over 1 MiB)");
    expect(out).not.toContain("could not be read at the head");
    const noBase = world(
      [
        {
          path: "s/m.c",
          base: src("void f(void)", "{", "    a();", "}"),
          head: src("void f(void)", "{", "    b();", "}"),
        },
      ],
      {},
      { readBase: async () => null },
    );
    expect(await run({ action: "anchors" }, noBase)).toContain(
      "[moved-call] unknown: s/m.c: base not read (it could not be read at the base (absent, or over 1 MiB there))",
    );
  });
});

describe("cut notes say which cap cut", () => {
  // MUTATIONS, each fails this: drop the pointer-language gate from
  // newWriterFields (seventy JS member stores spend the alias look-backs and
  // the pointer note is printed); count a per-file cut as the call's cut
  // (the note names the first 10).
  it("JS member stores spend no pointer look-back, and the per-file cap is named (JS)", async () => {
    const body = Array.from({ length: 70 }, (_, i) => `  cfg.field_${i} = ${i};`);
    const w = world([
      {
        path: "src/cfg.js",
        base: src("export function f(cfg) {", "}"),
        head: src("export function f(cfg) {", ...body, "}"),
      },
    ]);
    const out = await run({ action: "anchors" }, w);
    expect(out).not.toContain("traced to the member it points at");
    expect(out).toContain(
      "[cut: 67 written fields past the first 3 of their changed file not swept]",
    );
    expect(out).not.toContain("past the first 10 not swept");
  });
});

describe("answers that find nothing say what they searched", () => {
  // MUTATION: drop WRITE_SHAPES from the writes action's none line — this
  // fails.
  it("a writes answer with no site names the shapes it reads", async () => {
    const out = await run(
      { action: "writes", name: "queue_depth" },
      world([], { "src/a.ts": src("f();") }),
    );
    expect(out).toContain(
      "none in the files searched — the shapes read: an assignment, ++/--, a setter,",
    );
    expect(out).toContain("a write through a call, a copy of a pointer or a reference is not seen");
  });

  // MUTATIONS, each fails this: drop the cut hedge from usuallyWith's
  // "none"; drop it from originalLacks.
  it("a companion table or a lacks row cut short says the none clears nothing", async () => {
    const tree = {
      "src/r.c": src(
        ...[0, 1, 2].flatMap((i) => [
          `void r_${i}(struct node *n)`,
          "{",
          `    n->depth = ${i};`,
          `    step_${i}(n);`,
          "}",
        ]),
        ...[0, 1, 2].flatMap((i) => [
          `void s_${i}(struct node *n)`,
          "{",
          `    pre_${i}(n);`,
          "    refresh_all();",
          `    post_${i}(n);`,
          "}",
        ]),
      ),
      "src/gone.c": src("int z;"),
    };
    const files = world([], tree);
    const cut: ExploreIo = {
      ...files,
      readHead: async (p) => (p === "src/gone.c" ? null : files.readHead(p)),
    };
    const writes = await run({ action: "writes", name: "depth" }, cut);
    expect(writes).toContain(
      "none of the writes found (the sweep was cut, so this clears nothing)",
    );
    const sib = await run({ action: "siblings", file: "src/r.c", line: 19 }, cut);
    expect(sib).toMatch(
      /lacks — [^\n]*: none among the occurrences found \(the sweep was cut, so this clears nothing\)/,
    );
    // A whole sweep says a plain none.
    expect(await run({ action: "writes", name: "depth" }, files)).toMatch(/\nnone(\n|$)/);
  });
});

describe("writer-companion: what counts as a write and a partner", () => {
  // MUTATION: drop the member-or-field-convention condition from the chain
  // rule in classifyOccurrence — the stores through the parameter `conn`
  // read as writes of `conn` and this fails; drop TYPE_BEFORE_RE — the
  // annotation reads as a store.
  it("a store through a root variable writes its member, not the variable; an annotation writes nothing", () => {
    const occ = (line: string, word: string) =>
      classifyOccurrence(line, line, line.indexOf(word), word.length, false);
    expect(occ("    conn->wr.opcode = 1;", "conn")?.kind).toBe("read");
    expect(occ("    conn->wr.opcode = 1;", "wr")).toEqual({ kind: "write", how: "chain" });
    expect(occ("    m_conn->wr.opcode = 1;", "m_conn")).toEqual({ kind: "write", how: "chain" });
    expect(occ("    p->conn.state = 1;", "conn")).toEqual({ kind: "write", how: "chain" });
    expect(occ("  const opts: Settings.Options = load();", "Settings")?.kind).toBe("read");
  });

  // MUTATION: drop the declaresLocal filter from writerCompanions — the new
  // local `int rdma_mode = 0;` is held to the field's writers and anchored.
  it("a line that declares a local of the field's name is no new write of the field (C)", async () => {
    const tree = { "src/net.c": writersTree("rdma_mode", "persist(n)", 3) };
    // The changed file writes the field once as a member (beside the mark)
    // and declares a local of the same name elsewhere.
    const local = world(
      [
        {
          path: "src/bench.c",
          base: src("int main(void)", "{", "    return 0;", "}"),
          head: src(
            "void set(struct node *n)",
            "{",
            "    n->rdma_mode = 1;",
            "    persist(n);",
            "}",
            "int main(void)",
            "{",
            "    int rdma_mode = 0;",
            "    return rdma_mode;",
            "}",
          ),
        },
      ],
      tree,
    );
    expect(only("writer-companion", await anchors(local))).toEqual([]);
    const field = world(
      [
        {
          path: "src/bench.c",
          base: src("void m(struct node *n)", "{", "}"),
          head: src("void m(struct node *n)", "{", "    n->rdma_mode = 9;", "}"),
        },
      ],
      tree,
    );
    expect(only("writer-companion", await anchors(field))).toEqual([
      expect.stringContaining("`rdma_mode` written here without `persist(…)`"),
    ]);
    expect(declaresLocal("    int rdma_mode = 0;", "rdma_mode")).toBe(true);
    expect(declaresLocal("    const struct opt *rdma_mode = &x;", "rdma_mode")).toBe(true);
    expect(declaresLocal("\trdma_mode := 0", "rdma_mode")).toBe(true);
    expect(declaresLocal("  let rdma_mode = 0;", "rdma_mode")).toBe(true);
    expect(declaresLocal("    rdma_mode = 0;", "rdma_mode")).toBe(false);
    expect(declaresLocal("    else rdma_mode = 0;", "rdma_mode")).toBe(false);
    expect(declaresLocal("    n->rdma_mode = 0;", "rdma_mode")).toBe(false);
  });

  // MUTATION: count a partner per site, not per function (make unitOf return
  // path:line) — six of nine sites have the mark, two-thirds, and the new
  // write is anchored; by function it is three of six.
  it("the writes of one function count once (C)", async () => {
    const lines = [
      "void init(struct node *n)",
      "{",
      "    n->slot_state = 1;",
      "    n->slot_state = 2;",
      "    n->slot_state = 3;",
      "    n->slot_state = 4;",
      "    mark_dirty(n);",
      "}",
      ...[1, 2].flatMap((i) => [
        `void m_${i}(struct node *n)`,
        "{",
        `    n->slot_state = ${i};`,
        "    mark_dirty(n);",
        "}",
      ]),
      ...[3, 4, 5].flatMap((i) => [
        `void b_${i}(struct node *n)`,
        "{",
        `    n->slot_state = ${i};`,
        "    n->seen = 1;",
        "}",
      ]),
    ];
    const base = src(...lines);
    const head = src(...lines, "void fresh(struct node *n)", "{", "    n->slot_state = 9;", "}");
    expect(
      only("writer-companion", await anchors(world([{ path: "src/slot.c", base, head }]))),
    ).toEqual([]);
  });

  // MUTATION: key a two-name call by its receiver again in partnerId — the
  // new write beside `ord.markDirty()` reads as lacking `order.markDirty()`.
  it("the same method through another variable is the same partner (JS)", async () => {
    const old = [0, 1, 2].flatMap((i) => [
      `function w${i}(order) {`,
      `  order.payment_state = ${i};`,
      "  order.markDirty();",
      "}",
    ]);
    const base = src(...old);
    const withMark = src(
      ...old,
      "function d(ord) {",
      "  ord.payment_state = 9;",
      "  ord.markDirty();",
      "}",
    );
    const without = src(...old, "function d(ord) {", "  ord.payment_state = 9;", "}");
    expect(
      only("writer-companion", await anchors(world([{ path: "src/w.js", base, head: withMark }]))),
    ).toEqual([]);
    expect(
      only("writer-companion", await anchors(world([{ path: "src/w.js", base, head: without }]))),
    ).toEqual([
      expect.stringContaining("`payment_state` written here without `order.markDirty(…)`"),
    ]);
  });

  // MUTATIONS, each fails this: drop the library prefix from IDIOM_RE (the
  // assertion macro is named as a partner); drop the key filter from
  // writerCompanions (the format call in the literal is named as a partner).
  it("a prefixed assertion macro and the lines of a literal are no partners (C, Go)", async () => {
    const c = writersTree("static_flag", "LV_ASSERT_MALLOC(n)", 3);
    const cw = world([
      {
        path: "c/s.c",
        base: c,
        head: c + src("void d(struct node *n)", "{", "    n->static_flag = 1;", "}"),
      },
    ]);
    expect(only("writer-companion", await anchors(cw))).toEqual([]);
    const lit = [0, 1, 2].flatMap((i) => [
      `func a${i}(b *B) {`,
      "\tsend(api.Progress{",
      `\t\tStatus: fmt.Sprintf("x %d", ${i}),`,
      "\t\tTotal:  b.Total,",
      "\t})",
      "}",
    ]);
    const gb = src("package p", "", ...lit);
    const gw = world([
      { path: "g/p.go", base: gb, head: gb + src("func d(p *P, n int) {", "\tp.Total = n", "}") },
    ]);
    expect(only("writer-companion", await anchors(gw))).toEqual([]);
  });
});

describe("writer-companion: same object, same member", () => {
  // MUTATION: drop the same-object check from companionsAt — the sibling
  // field `message`, set beside every old `code` write, is named as the new
  // write's missing partner.
  it("another field of the object the write stores into is no partner (JS)", async () => {
    const old = [0, 1, 2].flatMap((i) => [
      `function r${i}(resp) {`,
      `  resp.code = ${i};`,
      `  resp.message = "m${i}";`,
      "}",
    ]);
    const base = src(...old);
    const head = src(...old, "function d(resp) {", "  resp.code = 9;", "}");
    expect(
      only("writer-companion", await anchors(world([{ path: "src/r.js", base, head }]))),
    ).toEqual([]);
  });

  // MUTATION: drop the member match from peersOf (subOf) — the new write
  // into `container.Logger` is held to the writes into `container.Store`
  // and anchored without their `connect(…)`.
  it("a write into one member of a field is held to the writes into that member (Go)", async () => {
    const tree = {
      "app/ext.go": src(
        "package app",
        "",
        ...[0, 1, 2].flatMap((i) => [
          `func (a *App) Add${i}(db Store) {`,
          "\tdb.connect()",
          "\ta.container.Store = db",
          "}",
        ]),
      ),
    };
    const fresh = (line: string) =>
      world(
        [
          {
            path: "app/handler.go",
            base: src("package app", "", "func (h *H) Serve(l Logger, db Store) {", "}"),
            head: src(
              "package app",
              "",
              "func (h *H) Serve(l Logger, db Store) {",
              `\t${line}`,
              "}",
            ),
          },
        ],
        tree,
      );
    expect(only("writer-companion", await anchors(fresh("h.container.Logger = l")))).toEqual([]);
    expect(only("writer-companion", await anchors(fresh("h.container.Store = db")))).toEqual([
      expect.stringContaining("written here without `db.connect(…)`"),
    ]);
  });

  // A write in a deferred closure touches one member below the field, the
  // closure's own: `defer func() { h.container.Logger = old }()` is no peer
  // of the writes that replace `container` whole, and with no write into
  // `Logger` beside it there is nothing usual to miss. A plain new write of
  // the field still anchors.
  // MUTATION: hold a deferred write like any other in writerCompanions (its
  // member from subOf, which reads the closure as no store, and `strict`
  // false) — every writer of `container` becomes its peer, the closure is
  // anchored without `db.connect(…)`, and this fails.
  it("a write in a deferred closure is held to the writes into its own member (Go)", async () => {
    const tree = {
      "app/ext.go": src(
        "package app",
        "",
        ...[0, 1, 2].flatMap((i) => [
          `func (a *App) Add${i}(db Store) {`,
          "\tdb.connect()",
          "\ta.container = db",
          "}",
        ]),
      ),
    };
    // The change adds a plain write beside its partner, which makes
    // `container` a written field, and a second function whose write is
    // the line under test.
    const fresh = (line: string) =>
      world(
        [
          {
            path: "app/handler.go",
            base: src("package app", ""),
            head: src(
              "package app",
              "",
              "func (h *H) Serve(db Store) {",
              "\tdb.connect()",
              "\th.container = db",
              "}",
              "",
              "func (h *H) Swap(old Logger) {",
              `\t${line}`,
              "\th.run()",
              "}",
            ),
          },
        ],
        tree,
      );
    expect(
      only("writer-companion", await anchors(fresh("defer func() { h.container.Logger = old }()"))),
    ).toEqual([]);
    expect(only("writer-companion", await anchors(fresh("h.container = old")))).toEqual([
      expect.stringMatching(
        /^\[writer-companion\] app\/handler\.go:9 \(Swap\) — `container` written here without `db\.connect\(…\)`/,
      ),
    ]);
  });

  // A deferred closure whose own statement cannot be read as a store (the
  // last brace opens a nested closure) has no member to hold it to: the
  // write is reported unknown, not held to every writer of the field and
  // not passed over in silence.
  // MUTATION: drop the addUnknown call in writerCompanions' `deferred &&
  // sub === null` branch (keep its `continue`) — writer-companion reads as
  // "no anchor", and this fails.
  it("a deferred write whose member cannot be read is unknown, not anchored (Go)", async () => {
    const tree = {
      "app/ext.go": src(
        "package app",
        "",
        ...[0, 1, 2].flatMap((i) => [
          `func (a *App) Add${i}(db Store) {`,
          "\tdb.connect()",
          "\ta.container = db",
          "}",
        ]),
      ),
    };
    const io = world(
      [
        {
          path: "app/handler.go",
          base: src("package app", ""),
          head: src(
            "package app",
            "",
            "func (h *H) Serve(db Store) {",
            "\tdb.connect()",
            "\th.container = db",
            "}",
            "",
            "func (h *H) Swap(old Logger) {",
            "\tdefer func() { h.container.Logger = pick(func() { return old }) }()",
            "\th.run()",
            "}",
          ),
        },
      ],
      tree,
    );
    const out = await run({ action: "anchors" }, io);
    expect(only("writer-companion", out.split("\n"))).toEqual([
      "[writer-companion] unknown: `container` at app/handler.go:9: a write in a deferred closure whose member could not be read",
    ]);
    expect(out).not.toMatch(/no anchor: .*writer-companion/);
  });
});

describe("write shapes, widened", () => {
  // MUTATIONS, each fails this: drop `append|pop|push|put|push_back` from
  // RECEIVER_METHOD_AFTER_RE (the container mutations read as reads); drop
  // `__atomic_…_n`, `atomic_set` or `WRITE_ONCE` from ATOMIC_ARG_BEFORE_RE.
  it("container mutators and kernel or builtin atomics are writes (Py, JS, C)", async () => {
    const tree = {
      "x/f.py": src(
        "class Q:",
        "    def a(self, x):",
        "        self.pending_jobs.append(x)",
        "    def b(self):",
        "        self.pending_jobs.pop()",
      ),
      "x/j.js": src("export function put(reg, v) {", "  reg.entryList.push(v);", "}"),
      "x/c.c": src(
        "void f(struct srv *srv)",
        "{",
        "    srv->pending_list.push_back(1);",
        "    __atomic_store_n(&srv->run_flag, 1, __ATOMIC_SEQ_CST);",
        "    atomic_set(&srv->ref_cnt, 1);",
        "    WRITE_ONCE(srv->run_flag, 0);",
        "}",
      ),
    };
    const w = world([], tree);
    expect(await run({ action: "writes", name: "pending_jobs" }, w)).toMatch(
      /^2 sites in 1 file;/m,
    );
    expect(await run({ action: "writes", name: "entryList" }, w)).toContain(
      "x/j.js:2  (put)  [collection] reg.entryList.push(v);",
    );
    expect(await run({ action: "writes", name: "pending_list" }, w)).toContain(
      "[collection] srv->pending_list.push_back(1);",
    );
    const flag = await run({ action: "writes", name: "run_flag" }, w);
    expect(flag).toContain(
      "x/c.c:4  (f)  [atomic] __atomic_store_n(&srv->run_flag, 1, __ATOMIC_SEQ_CST);",
    );
    expect(flag).toContain("x/c.c:6  (f)  [atomic] WRITE_ONCE(srv->run_flag, 0);");
    expect(await run({ action: "writes", name: "ref_cnt" }, w)).toContain(
      "[atomic] atomic_set(&srv->ref_cnt, 1);",
    );
  });

  // MUTATIONS, each fails this: drop `:?` from ALIAS_LHS_RE (Go's `p :=`
  // binds no alias); drop `mut` from ADDR_BEFORE_RE (Rust's `&mut`); drop the
  // index from ADDR_END_AFTER_RE (the address of an element).
  it("an alias bound with :=, &mut or to an element is followed (Go, Rust, C)", async () => {
    const tree = {
      "z/a.go": src(
        "package p",
        "",
        "func a(s *Srv) {",
        "\tp := &s.conn_state",
        "\tp.mode = 1",
        "}",
      ),
      "z/a.rs": src(
        "fn a(s: &mut Srv) {",
        "    let p = &mut s.conn_state;",
        "    p.mode = 1;",
        "}",
      ),
      "z/a.c": src(
        "void a(struct srv *s, int i)",
        "{",
        "    struct ent *e = &s->conn_state[i];",
        "    e->mode = 1;",
        "}",
      ),
    };
    const out = await run({ action: "writes", name: "conn_state" }, world([], tree));
    expect(out).toContain("z/a.go:5  (a)  [via p] p.mode = 1");
    expect(out).toContain("z/a.rs:3  (a)  [via p] p.mode = 1;");
    expect(out).toContain("z/a.c:4  (a)  [via e] e->mode = 1;");
  });

  // MUTATION: restore the old DEREF_BEFORE_RE (a `*` after any non-word
  // character) — the declarator `char *slot = …` reads as a store through
  // the alias and this fails.
  it("a declaration that shadows an alias is no store through it; a store at a statement's start is (C)", async () => {
    const tree = {
      "src/a.c": src(
        "void fn_a(struct node *n)",
        "{",
        "    int *slot = &n->ref_count;",
        "    log_it(slot);",
        "    if (n->kind) {",
        "        char *slot = n->name;",
        "        use(slot);",
        "    }",
        "}",
        "void fn_b(struct node *n)",
        "{",
        "    int *slot = &n->ref_count;",
        "    *slot = 3;",
        "}",
      ),
    };
    const out = await run({ action: "writes", name: "ref_count" }, world([], tree));
    expect(out).toMatch(/^1 site in 1 file;/m);
    expect(out).toContain("src/a.c:13  (fn_b)  [via slot] *slot = 3;");
  });
});

describe("writes-no-tx: stored writes only", () => {
  const added = (path: string, before: string, after: string) => ({
    path,
    base: before,
    head: after,
  });

  // MUTATIONS, each fails this: drop CONTAINER_VERB_RE (a dict's update, a
  // Map's delete and a set's insert in a loop are per-item store writes);
  // drop `[Ss]et` back into STORE_CALL_RE (a client's and a store class's
  // setters are a sequence of writes); drop leavesAfter (the retry loop is
  // per item).
  it("in-memory containers, setters and a retry loop are no stored writes (Py, JS, C++, TS)", async () => {
    const w = world([
      added(
        "a/m.py",
        src("def merge(items):", "    out = {}", "    return out"),
        src(
          "def merge(items):",
          "    out = {}",
          "    for it in items:",
          "        out.update(it)",
          "    return out",
        ),
      ),
      added(
        "a/p.js",
        src("export function prune(keys) {", "  return 0;", "}"),
        src(
          "export function prune(seen, keys) {",
          "  for (const k of keys) {",
          "    seen.delete(k);",
          "  }",
          "  return 0;",
          "}",
        ),
      ),
      added(
        "a/i.cpp",
        src("void Index::Mark(int x) {", "}"),
        src(
          "void Index::Mark(int x) {",
          "    for (auto& e : m_entries) {",
          "        m_seen.insert(e.first);",
          "    }",
          "}",
        ),
      ),
      added(
        "a/s.ts",
        src("export class UserStore {", "  load(u) {", "  }", "}"),
        src(
          "export class UserStore {",
          "  load(u) {",
          "    this.setLoading(true);",
          "    this.setUser(u);",
          "  }",
          "}",
        ),
      ),
      added(
        "a/c.ts",
        src("export function init(api) {", "}"),
        src(
          "export function init(apiClient) {",
          "  apiClient.setHeader('x', 1);",
          "  apiClient.setTimeout(5);",
          "}",
        ),
      ),
      added(
        "a/rt.ts",
        src("export async function persist(orderRepository, o) {", "}"),
        src(
          "export async function persist(orderRepository, o) {",
          "  while (true) {",
          "    try {",
          "      await orderRepository.save(o);",
          "      break;",
          "    } catch (e) {",
          "      await sleep(10);",
          "    }",
          "  }",
          "}",
        ),
      ),
    ]);
    expect(only("writes-no-tx", await anchors(w))).toEqual([]);
  });

  // MUTATIONS, each fails this: drop storeReceiver (a Prisma model's update
  // and a model class's create in a loop are in-memory writes); drop
  // STORE_WORD_RE from it (a table handle's update is in memory); drop
  // PER_ITEM_CALLBACK_RE (the save inside forEach is no per-item write).
  it("an ORM or table call in a loop or a per-item callback is a per-item store write (TS, Py)", async () => {
    const w = world([
      added(
        "a/p.ts",
        src("export async function closeAll(ids: string[]) {", "}"),
        src(
          "export async function closeAll(ids: string[]) {",
          "  for (const id of ids) {",
          "    await prisma.order.update({ where: { id }, data: { open: false } });",
          "  }",
          "}",
        ),
      ),
      added(
        "a/m.ts",
        src("export async function seed(rows: Row[]) {", "}"),
        src(
          "export async function seed(rows: Row[]) {",
          "  for (const r of rows) {",
          "    await Order.create(r);",
          "  }",
          "}",
        ),
      ),
      added(
        "a/t.py",
        src("def strip(table_instance, rows):", "    return rows"),
        src(
          "def strip(table_instance, rows):",
          "    for r in rows:",
          "        table_instance.update(r.filter, r.values)",
          "    return rows",
        ),
      ),
      added(
        "a/f.ts",
        src("export async function saveAll(repo, items) {", "}"),
        src(
          "export async function saveAll(orderRepository, items) {",
          "  items.forEach(async (it) => {",
          "    await orderRepository.save(it);",
          "  });",
          "}",
        ),
      ),
    ]);
    expect(only("writes-no-tx", await anchors(w))).toEqual([
      "[writes-no-tx] a/p.ts:3 (closeAll) — L3 `.update(` writes once per item inside `for (const id of ids)` @L2 in `closeAll`, and no transaction marker in it or above its head — what is stored if the process stops partway through the items?",
      "[writes-no-tx] a/m.ts:3 (seed) — L3 `.create(` writes once per item inside `for (const r of rows)` @L2 in `seed`, and no transaction marker in it or above its head — what is stored if the process stops partway through the items?",
      "[writes-no-tx] a/t.py:3 (strip) — L3 `.update(` writes once per item inside `for r in rows:` @L2 in `strip`, and no transaction marker in it or above its head — what is stored if the process stops partway through the items?",
      "[writes-no-tx] a/f.ts:3 (<callback of forEach>) — L3 `.save(` writes once per item inside the per-item callback `items.forEach(async (it) =>` @L2, and no transaction marker in it or above its head — what is stored if the process stops partway through the items?",
    ]);
  });
});

describe("cowrite-gap passes over logging", () => {
  // MUTATIONS, each fails this: drop isLogCall from the neighbour test in
  // cowritePairs; drop the library-prefixed `_Log…` form from
  // LOG_CALLEE_RE — the log call beside the added line is swept as a
  // co-written statement and the three other log sites are anchored.
  it("a library-prefixed log call is neither side of a co-write (C)", async () => {
    const old = [0, 1, 2].flatMap((i) => [
      `int w${i}(void)`,
      "{",
      `    SDL_LogError(CAT, "w${i}");`,
      "    return 1;",
      "}",
    ]);
    const base = src(
      ...old,
      "int f(void)",
      "{",
      '    SDL_LogError(CAT, "f");',
      "    return 1;",
      "}",
    );
    const head = src(
      ...old,
      "int f(void)",
      "{",
      '    SDL_LogError(CAT, "f");',
      "    release_all();",
      "    return 1;",
      "}",
    );
    expect(only("cowrite-gap", await anchors(world([{ path: "src/f.c", base, head }])))).toEqual(
      [],
    );
  });
});
