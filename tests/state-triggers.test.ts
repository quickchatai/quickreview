// State-machine triggers (packages/pi-plugin/src/statetriggers.ts): which
// pass-sm-* lenses a PR's content plans. Every case hands `selectStateLenses`
// a file list as GitHub returns it and asserts on the selection — the lens,
// the strength and the reason — never on a probe's internals.
// The member detector (`memberCandidates`) is driven through its export,
// with the same file lists.
import { describe, expect, it } from "vitest";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";
import { EMPTY_HEURISTICS } from "@quickchatai/pi-quickreview/src/heuristics.js";
import { STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import {
  ADD_BACK_SCANS_MAX,
  ENUM_MEMBER_RE,
  enumTypeName,
  isSourceCode,
  LINE_MAX,
  memberCandidates,
  selectStateLenses,
  STATE_TRIGGERS,
  type StateSelection,
} from "@quickchatai/pi-quickreview/src/statetriggers.js";

/** One file whose patch has these lines; a line's first character is its
 * sign (`+`, `-` or a space for context). */
const patched = (filename: string, lines: string[], header = "@@ -1,9 +1,9 @@"): PrFileEntry => ({
  filename,
  additions: lines.filter((l) => l.startsWith("+")).length,
  deletions: lines.filter((l) => l.startsWith("-")).length,
  status: "modified",
  patch: [header, ...lines].join("\n"),
});
const added = (filename: string, ...lines: string[]): PrFileEntry =>
  patched(
    filename,
    lines.map((l) => `+${l}`),
  );
const removed = (filename: string, ...lines: string[]): PrFileEntry =>
  patched(
    filename,
    lines.map((l) => `-${l}`),
  );
/** One file whose patch has several hunks, each a header and its lines. */
const hunked = (filename: string, ...hunks: [header: string, lines: string[]][]): PrFileEntry => ({
  filename,
  additions: hunks.flatMap(([, ls]) => ls).filter((l) => l.startsWith("+")).length,
  deletions: hunks.flatMap(([, ls]) => ls).filter((l) => l.startsWith("-")).length,
  status: "modified",
  patch: hunks.flatMap(([header, ls]) => [header, ...ls]).join("\n"),
});

const select = (
  files: PrFileEntry[],
  mode: "off" | "strong" | "all" = "all",
  intent?: { title?: string; body?: string },
): StateSelection[] => selectStateLenses(files, { mode, ...(intent ? { intent } : {}) });
const lensesOf = (sel: StateSelection[]): string[] => sel.map((s) => s.lens);
const of = (sel: StateSelection[], lens: string): StateSelection | undefined =>
  sel.find((s) => s.lens === lens);

/** `n` distinct checks removed, each added back as `back(check)` makes it. */
const rewritten = (n: number, back: (check: string) => string): PrFileEntry => {
  const checks = Array.from({ length: n }, (_, i) => `if (o${i}.status !== 1) throw 1;`);
  return patched("src/order.ts", [
    ...checks.map((c) => `-  ${c}`),
    ...checks.map((c) => `+${back(c)}`),
  ]);
};

describe("the trigger table", () => {
  it("every trigger names a family lens, and every family lens has a trigger of each strength it documents", () => {
    for (const t of STATE_TRIGGERS) expect(STATE_FAMILY, t.id).toContain(t.lens);
    // The enumeration member probe is a function, not a row, so exhaustive
    // has a weak row only.
    for (const lens of STATE_FAMILY)
      expect(
        STATE_TRIGGERS.some((t) => t.lens === lens),
        lens,
      ).toBe(true);
    expect(new Set(STATE_TRIGGERS.map((t) => t.id)).size).toBe(STATE_TRIGGERS.length);
  });

  // A probe is run with `exec` in a loop: a global or sticky regex would
  // carry its `lastIndex` from one line to the next.
  it("no probe is global or sticky", () => {
    for (const t of STATE_TRIGGERS) {
      expect(t.re.global, t.id).toBe(false);
      expect(t.re.sticky, t.id).toBe(false);
    }
  });
});

describe("modes", () => {
  const files = [added("src/order.ts", "order.status = next;")];

  // MUTATION: drop the `opts.mode === "off"` return — the strong signal
  // below plans its lens and this fails.
  it("off plans nothing", () => {
    expect(select(files, "off")).toEqual([]);
    const strong = [
      removed("src/order.ts", "  if (order.status !== 'pending') throw new Error('bad');"),
    ];
    expect(lensesOf(select(strong, "strong"))).toEqual(["pass-sm-transitions"]);
    expect(select(strong, "off")).toEqual([]);
  });

  // MUTATION: drop the weak-strength skip under "strong" — this fails.
  it("strong leaves the weak signals out; all reads them", () => {
    expect(select(files, "strong")).toEqual([]);
    expect(of(select(files, "all"), "pass-sm-transitions")).toMatchObject({
      strength: "weak",
      files: ["src/order.ts"],
    });
  });

  it("a test file and a docs file fire nothing", () => {
    expect(select([added("tests/order.test.ts", "order.status = next;")])).toEqual([]);
    expect(select([added("docs/orders.md", "order.status = next;")])).toEqual([]);
  });

  it("the selection comes in family order", () => {
    const sel = select([
      added(
        "src/job.ts",
        "job.status = 'done';",
        "emitter.on('paid', handle);",
        "this.isLoading = true;",
      ),
    ]);
    const order = lensesOf(sel).map((l) => STATE_FAMILY.indexOf(l));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("pass-sm-states", () => {
  // MUTATION: change the strong trigger's `min` to 1 — the one-flag case
  // becomes strong and this fails.
  it("two status flags added in one file are strong; one is weak", () => {
    const two = select(
      [
        added(
          "src/form.tsx",
          "const [isSaving, setIsSaving] = useState(false);",
          "isDirty: boolean;",
        ),
      ],
      "strong",
    );
    expect(of(two, "pass-sm-states")).toMatchObject({ strength: "strong" });
    expect(of(two, "pass-sm-states")!.why).toContain("two or more status flags");
    const one = [added("src/form.tsx", "isDirty: boolean;")];
    expect(of(select(one, "strong"), "pass-sm-states")).toBeUndefined();
    expect(of(select(one, "all"), "pass-sm-states")).toMatchObject({ strength: "weak" });
  });

  it("snake-case and ORM flags count", () => {
    const sel = select(
      [added("app/models.py", "is_active = models.BooleanField(default=True)", "has_paid = False")],
      "strong",
    );
    expect(of(sel, "pass-sm-states")).toMatchObject({ strength: "strong" });
  });

  it("a nullable marker field is a weak signal", () => {
    const sel = select([added("src/task.ts", "completedAt?: Date | null;")]);
    expect(of(sel, "pass-sm-states")!.why).toContain("nullable marker");
  });

  it("an ordinary boolean expression is not a flag", () => {
    expect(
      of(select([added("src/a.ts", "const ok = a === b;")]), "pass-sm-states"),
    ).toBeUndefined();
  });
});

describe("pass-sm-transitions", () => {
  // MUTATION: drop the "not added back" filter in lineHit — the moved-check
  // case fires and this fails.
  it("a removed check of the current state is strong, unless the file adds it back", () => {
    const gone = select(
      [removed("src/order.ts", "  if (order.status !== 'pending') throw new Error('bad');")],
      "strong",
    );
    expect(of(gone, "pass-sm-transitions")).toMatchObject({ strength: "strong" });
    expect(of(gone, "pass-sm-transitions")!.why).toContain("check of the current state is removed");
    const moved = select(
      [
        patched("src/order.ts", [
          "-  if (order.status !== 'pending') throw new Error('bad');",
          "+    if (order.status !== 'pending') throw new Error('bad');",
        ]),
      ],
      "strong",
    );
    expect(of(moved, "pass-sm-transitions")).toBeUndefined();
  });

  // A check that an edit keeps is not a removed one, although the edited
  // line's own match is another text.
  // MUTATION: look the matched text up in the set alone (drop the substring
  // scan in lineHit) — both edits fire and this fails.
  it("a check that an edited line still holds is not removed", () => {
    for (const kept of [
      "  if (o.status !== 1 && p.state === 2) throw 1;",
      "  } else if (o.status !== 1) throw 1;",
    ]) {
      const edited = patched("src/order.ts", ["-  if (o.status !== 1) throw 1;", `+${kept}`]);
      expect(of(select([edited], "strong"), "pass-sm-transitions"), kept).toBeUndefined();
    }
  });

  // MUTATION: drop the cap (`scans < ADD_BACK_SCANS_MAX` in lineHit) — the
  // 33rd edited check is found added back, nothing fires and this fails.
  it("looks an edited check up by a scan at most ADD_BACK_SCANS_MAX times a file, and never reads a capped look as added back", () => {
    expect(ADD_BACK_SCANS_MAX).toBe(32);
    const edited = (n: number): StateSelection | undefined =>
      of(select([rewritten(n, (c) => `  } else ${c}`)], "strong"), "pass-sm-transitions");
    expect(edited(ADD_BACK_SCANS_MAX)).toBeUndefined();
    const over = edited(ADD_BACK_SCANS_MAX + 1);
    expect(over).toMatchObject({ strength: "strong" });
    expect(over!.why).toContain(`o${ADD_BACK_SCANS_MAX}.status`);
  });

  it("a state write, a setter and a transition call are weak signals", () => {
    for (const line of [
      "order.status = Status.SHIPPED;",
      "setPhase('review');",
      "machine.transitionTo('done');",
      "await db.update({ status: 'PAID' });",
    ])
      expect(of(select([added("src/x.ts", line)]), "pass-sm-transitions"), line).toMatchObject({
        strength: "weak",
      });
  });

  it("a comparison is not a write", () => {
    expect(
      of(
        select([added("src/x.ts", "if (order.status === 'paid') return;")]),
        "pass-sm-transitions",
      ),
    ).toBeUndefined();
  });

  it("the PR's words plan it weakly", () => {
    const sel = select([added("src/x.ts", "const a = 1;")], "all", {
      title: "Rework the order state machine",
    });
    expect(of(sel, "pass-sm-transitions")!.why).toContain("PR text");
    expect(
      of(
        select([added("src/x.ts", "const a = 1;")], "strong", {
          title: "Rework the state machine",
        }),
        "pass-sm-transitions",
      ),
    ).toBeUndefined();
  });
});

describe("pass-sm-exhaustive", () => {
  // MUTATION: drop the `existing` requirement in memberCandidates — the
  // wholly-new-enum case fires and this fails.
  it("a member added to an existing enumeration is strong; a wholly new one is not", () => {
    const grown = patched(
      "src/status.ts",
      ["   Active = 'active',", "+  Suspended = 'suspended',", "   Closed = 'closed',"],
      "@@ -3,6 +3,7 @@ export enum AccountStatus {",
    );
    const sel = select([grown], "strong");
    expect(of(sel, "pass-sm-exhaustive")).toMatchObject({
      strength: "strong",
      files: ["src/status.ts"],
    });
    expect(of(sel, "pass-sm-exhaustive")!.why).toContain("Suspended = 'suspended',");
    const fresh = patched("src/kind.ts", [
      "+export enum Kind {",
      "+  A = 'a',",
      "+  B = 'b',",
      "+}",
    ]);
    expect(of(select([fresh], "strong"), "pass-sm-exhaustive")).toBeUndefined();
    // Members added under a declaration the hunk shows, beside no member the
    // enumeration already had.
    const first = patched(
      "src/kind.ts",
      ["+  A = 'a',", "+  B = 'b',"],
      "@@ -3,1 +3,3 @@ export enum Kind {",
    );
    expect(of(select([first], "strong"), "pass-sm-exhaustive")).toBeUndefined();
  });

  // A wholly new enumeration is new whatever sits beside it in the hunk: a
  // statement or a constant is member-shaped, and the added declaration line
  // itself holds the word.
  // MUTATION: drop the `enums.fresh` test in memberCandidates (`kind ===
  // "enum" && !declared`) — the new enumeration's members are candidates and
  // this fails.
  it("a wholly new enumeration beside member-shaped lines is not a member added to one", () => {
    const beside: [string, string[], string?][] = [
      [
        "src/kind.ts",
        ["   init();", " }", " ", "+export enum Kind {", '+  A = "a",', '+  B = "b",', "+}"],
        "@@ -10,3 +10,7 @@ function setup() {",
      ],
      ["app/kind.py", [" DEFAULT = 3", " ", "+class Kind(Enum):", "+    A = 1", "+    B = 2"]],
      ["src/kind.ts", ["+export enum Kind {", '+  A = "a",', "+}", " ", " init();"]],
      ["app/phase.py", [" DEFAULT = 3", '+Phase = Literal["a", "b"]']],
    ];
    for (const [file, lines, header] of beside) {
      const f = patched(file, lines, header);
      expect(memberCandidates([f]), lines.join("\n")).toEqual([]);
      expect(of(select([f], "strong"), "pass-sm-exhaustive")).toBeUndefined();
    }
    // A new enumeration under one that grew: only the grown one's member.
    const both = patched(
      "src/status.ts",
      [
        "   Active = 'active',",
        "+  Suspended = 'suspended',",
        " }",
        "+export enum Kind {",
        "+  A,",
        "+  B,",
        "+}",
      ],
      "@@ -3,3 +3,8 @@ export enum AccountStatus {",
    );
    expect(memberCandidates([both]).map((c) => [c.text, c.typeName])).toEqual([
      ["  Suspended = 'suspended',", "AccountStatus"],
    ]);
  });

  // MUTATION: call every added declaration new (`enums.fresh = l.sign ===
  // "+"`, whatever was removed) — both edits lose their member and this
  // fails.
  it("a declaration line edited in place is the old enumeration still", () => {
    const rebased = patched("app/status.py", [
      "-class Status(Enum):",
      "+class Status(StrEnum):",
      "     A = 1",
      "+    B = 2",
    ]);
    expect(memberCandidates([rebased]).map((c) => [c.text, c.typeName])).toEqual([
      ["    B = 2", "Status"],
    ]);
    expect(of(select([rebased], "strong"), "pass-sm-exhaustive")).toMatchObject({
      strength: "strong",
    });
    const widened = patched("app/phase.py", [
      '-Phase = Literal["a", "b"]',
      '+Phase = Literal["a", "b", "c"]',
    ]);
    expect(memberCandidates([widened]).map((c) => c.typeName)).toEqual(["Phase"]);
  });

  it("a literal added to an existing union is strong", () => {
    const union = patched("src/types.ts", [
      " export type Phase =",
      '   | "draft"',
      '+  | "archived"',
      '   | "live";',
    ]);
    expect(of(select([union], "strong"), "pass-sm-exhaustive")).toMatchObject({
      strength: "strong",
    });
  });

  it("a Python enum member counts when the patch shows the class", () => {
    const py = patched("app/status.py", [
      " class OrderStatus(TextChoices):",
      '     PENDING = "pending"',
      '+    ON_HOLD = "on_hold"',
    ]);
    expect(of(select([py], "strong"), "pass-sm-exhaustive")).toMatchObject({ strength: "strong" });
  });

  // An assignment among assignments is not an enumeration: without a
  // declaration word in the patch, plain `NAME = value` lines never fire.
  it("an added constant beside others, with no enumeration in sight, is not a member", () => {
    const consts = patched("src/config.ts", [" const A = 1;", "+TIMEOUT = 30", " RETRIES = 3"]);
    expect(of(select([consts], "strong"), "pass-sm-exhaustive")).toBeUndefined();
  });

  it("a dispatch over a state-like value is a weak signal", () => {
    const sel = select([added("src/x.ts", "switch (order.status) {")]);
    expect(of(sel, "pass-sm-exhaustive")).toMatchObject({ strength: "weak" });
  });
});

describe("pass-sm-stuck", () => {
  // MUTATION: drop the trigger's `unless` — the try/finally case becomes
  // strong and this fails.
  it("a transient state entered with no failure handling in the file is strong", () => {
    const bare = [
      added("src/save.tsx", "setIsSaving(true);", "await api.save(form);", "setIsSaving(false);"),
    ];
    expect(of(select(bare, "strong"), "pass-sm-stuck")).toMatchObject({ strength: "strong" });
    const covered = [
      added(
        "src/save.tsx",
        "setIsSaving(true);",
        "try {",
        "  await api.save(form);",
        "} finally {",
        "  setIsSaving(false);",
        "}",
      ),
    ];
    expect(of(select(covered, "strong"), "pass-sm-stuck")).toBeUndefined();
    expect(of(select(covered, "all"), "pass-sm-stuck")).toMatchObject({ strength: "weak" });
  });

  it("a stored transient status is a weak signal", () => {
    const sel = select([added("app/jobs.py", "job.status = 'processing'")]);
    expect(of(sel, "pass-sm-stuck")).toMatchObject({ strength: "weak" });
  });

  it("leaving a transient state is not entering one", () => {
    expect(of(select([added("src/x.ts", "setLoading(false);")]), "pass-sm-stuck")).toBeUndefined();
  });
});

describe("pass-sm-events", () => {
  it("a PR that speaks of duplicates or ordering plans it strongly", () => {
    for (const title of [
      "Fix double submit on checkout",
      "Handle out-of-order webhook events",
      "Make the consumer idempotent",
      "Callback fires twice",
    ])
      expect(
        of(select([added("src/x.ts", "const a = 1;")], "strong", { title }), "pass-sm-events"),
        title,
      ).toMatchObject({ strength: "strong" });
  });

  it("a handler, a listener or a consumer is a weak signal", () => {
    for (const line of [
      "window.addEventListener('message', onMessage);",
      "emitter.on('paid', handlePaid);",
      "@receiver(post_save, sender=Order)",
      "def handle_invoice_paid(event):",
      "onSubmit = async () => {",
    ])
      expect(of(select([added("src/x.py", line)]), "pass-sm-events"), line).toMatchObject({
        strength: "weak",
      });
  });
});

describe("pass-sm-derived", () => {
  it("an effect whose body only sets state is strong", () => {
    const sel = select(
      [added("src/c.tsx", "useEffect(() => { setTotal(items.length); }, [items]);")],
      "strong",
    );
    expect(of(sel, "pass-sm-derived")).toMatchObject({ strength: "strong" });
  });

  it("a stored count or cache write is a weak signal; a comparison is not", () => {
    expect(
      of(select([added("src/x.ts", "order.itemCount = items.length;")]), "pass-sm-derived"),
    ).toMatchObject({
      strength: "weak",
    });
    expect(
      of(select([added("src/x.ts", "if (order.itemCount === 0) return;")]), "pass-sm-derived"),
    ).toBeUndefined();
  });
});

describe("pass-sm-lifecycle", () => {
  it("a removed phase check is strong", () => {
    const sel = select(
      [removed("src/conn.ts", "    if (this.closed) throw new Error('closed');")],
      "strong",
    );
    expect(of(sel, "pass-sm-lifecycle")).toMatchObject({ strength: "strong" });
  });

  it("a lifecycle method is a weak signal", () => {
    for (const line of [
      "async function shutdown() {",
      "def close(self):",
      "componentWillUnmount() {",
    ])
      expect(of(select([added("src/x.py", line)]), "pass-sm-lifecycle"), line).toMatchObject({
        strength: "weak",
      });
  });
});

describe("pass-sm-durable", () => {
  // MUTATION: make the `stored` probe read code files instead of
  // STORED_FILE_RE — the migration case stops firing and this fails.
  it("a migration or schema that touches a stored state is strong", () => {
    for (const f of [
      added(
        "app/migrations/0007_status.py",
        "migrations.AddField('order', 'status', models.CharField())",
      ),
      added("db/migrate/20260101_add_phase.rb", "add_column :orders, :phase, :string"),
      added("schema.sql", "ALTER TYPE order_status ADD VALUE 'on_hold';"),
    ])
      expect(of(select([f], "strong"), "pass-sm-durable"), f.filename).toMatchObject({
        strength: "strong",
      });
  });

  it("a migration with no state in it fires nothing", () => {
    const f = added(
      "app/migrations/0008_name.py",
      "migrations.AddField('user', 'nickname', models.CharField())",
    );
    expect(of(select([f], "strong"), "pass-sm-durable")).toBeUndefined();
  });

  it("a stored state write is a weak signal", () => {
    for (const line of [
      'cur.execute("UPDATE orders SET status = %s WHERE id = %s", (s, id))',
      "Order.objects.filter(id=pk).update(status='paid')",
    ])
      expect(of(select([added("app/repo.py", line)]), "pass-sm-durable"), line).toMatchObject({
        strength: "weak",
      });
  });
});

describe("a profile's probes", () => {
  // MUTATION: drop extensionHits from selectStateLenses — this fails.
  it("plan a family lens strongly, under `strong`", () => {
    const sel = selectStateLenses([added("src/checkout/flow.ts", "const a = 1;")], {
      mode: "strong",
      extension: {
        ...EMPTY_HEURISTICS,
        paths: { "pass-sm-transitions": [/(^|\/)checkout\//] },
      },
    });
    expect(of(sel, "pass-sm-transitions")).toMatchObject({ strength: "strong" });
    expect(of(sel, "pass-sm-transitions")!.why).toContain("profile's path signal");
  });
});

describe("linear probes", () => {
  // The text is the PR author's and a probe runs in the dispatch pump: a
  // line is cut to LINE_MAX before any regex reads it, so no input makes a
  // probe super-linear. MUTATION: remove the `.slice(1, 1 + LINE_MAX)` in
  // sideLines — the long-line case below matches past the cut and fails.
  it("reads only the first LINE_MAX characters of a line", () => {
    const pad = " ".repeat(LINE_MAX + 10);
    const sel = select([added("src/x.ts", `${pad}order.status = next;`)]);
    expect(of(sel, "pass-sm-transitions")).toBeUndefined();
  });

  it("stays fast on pathological lines", () => {
    const evil = [
      "if ".repeat(5000),
      "status ".repeat(5000),
      `${"is".repeat(3000)}X${" ".repeat(3000)}= `,
      `UPDATE ${"SET ".repeat(3000)}`,
      `${"(".repeat(4000)}${")".repeat(4000)}`,
      "| ".repeat(5000),
    ];
    const files = [
      patched(
        "src/evil.ts",
        evil.flatMap((l) => [`+${l}`, `-${l}`, ` ${l}`]),
        "@@ -1,9 +1,9 @@ enum X {",
      ),
      patched(
        "db/migrate/evil.sql",
        evil.map((l) => `+${l}`),
      ),
    ];
    const started = performance.now();
    for (let i = 0; i < 20; i++) select(files, "all", { title: evil[0]!, body: evil.join("\n") });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("linear probes: the lines of a patch", () => {
  // MUTATION: scan the added side for every removed check (drop the set
  // lookup and the cap in lineHit) — 20 000 moved checks cost 20 000 scans of
  // 20 000 lines and this fails.
  it("a moved block of many distinct checks costs one lookup a line", () => {
    const block = rewritten(20_000, (c) => `      ${c}`);
    const started = performance.now();
    const sel = select([block], "strong");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(of(sel, "pass-sm-transitions")).toBeUndefined();
  });

  // MUTATION: drop the cap (`scans < ADD_BACK_SCANS_MAX` in lineHit) — every
  // edited check is found by a scan, nothing fires and this fails.
  it("many edited checks stop at the scan cap", () => {
    const block = rewritten(20_000, (c) => `  } else ${c}`);
    const started = performance.now();
    const sel = select([block], "strong");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(of(sel, "pass-sm-transitions")).toMatchObject({ strength: "strong" });
  });
});

/** Lines that are almost a member and end in a character no member ends in,
 * with a run of blanks at each place the member pattern allows one. */
const BLANK_RUNS = [
  `A${" ".repeat(LINE_MAX - 2)}!`,
  `${" ".repeat(LINE_MAX / 2)}A${" ".repeat(LINE_MAX / 2 - 2)}!`,
  `A =${" ".repeat(LINE_MAX - 4)}{`,
  `A = x${" ".repeat(LINE_MAX - 6)}{`,
  `A (${" ".repeat(LINE_MAX - 4)}{`,
  `case${" ".repeat(LINE_MAX - 5)}!`,
  `| "a"${" ".repeat(LINE_MAX - 6)}!`,
  `class A${" ".repeat(LINE_MAX - 8)}!`,
  `enum${" ".repeat(LINE_MAX - 5)}!`,
  `type A${" ".repeat(LINE_MAX - 7)}!`,
];

describe("the member detector", () => {
  const grown = patched(
    "src/status.ts",
    ["   Active = 'active',", "+  Suspended = 'suspended',", "   Closed = 'closed',"],
    "@@ -3,6 +3,7 @@ export enum AccountStatus {",
  );
  const python = patched("app/status.py", [
    " class OrderStatus(TextChoices):",
    '     PENDING = "pending"',
    '+    ON_HOLD = "on_hold"',
  ]);

  it("a candidate carries its file, hunk, head line, text and type", () => {
    expect(memberCandidates([grown])).toEqual([
      {
        file: "src/status.ts",
        hunk: 0,
        line: 4,
        text: "  Suspended = 'suspended',",
        union: false,
        typeName: "AccountStatus",
      },
    ]);
  });

  // MUTATION: advance the head line on a removed line in hunksOf (drop the
  // `sign !== "-"` test) — `Delta` moves from line 11 to 13 and this fails.
  it("the line is the head line: a removed line above the member is not counted", () => {
    const f = patched(
      "src/kind.ts",
      ["   Alpha,", "-  Beta,", "-  Gamma,", "+  Delta,"],
      "@@ -10,4 +10,3 @@ enum Kind {",
    );
    expect(memberCandidates([f]).map((c) => [c.line, c.text])).toEqual([[11, "  Delta,"]]);
  });

  // MUTATION: make `declared` patch-wide (test ENUM_DECL_RE against every
  // line of the patch instead of the hunk's own) — the second hunk's
  // constant becomes a member and this fails.
  it("a declaration word in another hunk of the patch does not make a member", () => {
    const constants: [string, string[]] = [
      "@@ -40,3 +40,4 @@ function load() {",
      [" RETRIES = 3", "+TIMEOUT = 30", " BACKOFF = 2"],
    ];
    const elsewhere = hunked(
      "src/config.ts",
      ["@@ -1,3 +1,3 @@", [" export enum Kind {", "   A = 'a',", " }"]],
      constants,
    );
    expect(memberCandidates([elsewhere])).toEqual([]);
    expect(of(select([elsewhere], "strong"), "pass-sm-exhaustive")).toBeUndefined();
    // The same lines under a declaration of their own are a member.
    const here = hunked("src/config.ts", ["@@ -40,3 +40,4 @@ enum Limits {", constants[1]]);
    expect(memberCandidates([here]).map((c) => c.text)).toEqual(["TIMEOUT = 30"]);
  });

  // MUTATION: drop `(?!>)` from ENUM_MEMBER_RE — the match arm reads as a
  // member assigned `> None` and this fails.
  it("a match arm beside enum variants is not a member", () => {
    const arm = patched(
      "src/kind.rs",
      [
        "     Alpha,",
        "     Beta,",
        " }",
        " fn code(k: Kind) -> Option<u8> { match k {",
        "+        _ => None,",
      ],
      "@@ -3,5 +3,6 @@ pub enum Kind {",
    );
    expect(memberCandidates([arm])).toEqual([]);
    expect(ENUM_MEMBER_RE.test("_ => None,")).toBe(false);
    expect(ENUM_MEMBER_RE.test("Other = 7,")).toBe(true);
    // The hunk is one a real variant would be found in.
    const variant = { ...arm, patch: arm.patch!.replace("        _ => None,", "    Gamma,") };
    expect(memberCandidates([variant]).map((c) => c.text)).toEqual(["    Gamma,"]);
  });

  // MUTATION: return from memberCandidates after the first file that has a
  // candidate — the second file's member is lost and this fails.
  it("two files that each grow an enumeration are two candidates; the hit names the first", () => {
    const found = memberCandidates([grown, python]);
    expect(found.map((c) => [c.file, c.typeName])).toEqual([
      ["src/status.ts", "AccountStatus"],
      ["app/status.py", "OrderStatus"],
    ]);
    const hit = of(select([grown, python], "strong"), "pass-sm-exhaustive")!;
    expect(hit.files).toEqual(["src/status.ts"]);
    expect(hit.why).toBe(
      "a member is added to an existing enumeration in src/status.ts (`Suspended = 'suspended',`)",
    );
  });

  // MUTATION: keep only the first candidate of a file (stop at the first
  // hunk that has one) — one candidate is left of three and this fails.
  it("one file that grows two enumerations yields every added member", () => {
    const f = hunked(
      "src/enums.ts",
      ["@@ -3,3 +3,4 @@ export enum Colour {", ["   Red,", "+  Green,", "   Blue,"]],
      ["@@ -20,3 +21,5 @@ export enum Size {", ["   Small,", "+  Medium,", "+  Large,"]],
    );
    expect(memberCandidates([f])).toEqual([
      {
        file: "src/enums.ts",
        hunk: 0,
        line: 4,
        text: "  Green,",
        union: false,
        typeName: "Colour",
      },
      {
        file: "src/enums.ts",
        hunk: 1,
        line: 22,
        text: "  Medium,",
        union: false,
        typeName: "Size",
      },
      { file: "src/enums.ts", hunk: 1, line: 23, text: "  Large,", union: false, typeName: "Size" },
    ]);
  });

  // MUTATION: require `declared` of a union candidate too — the union below
  // has no declaration word in its hunk, so it is lost and this fails.
  it("a union literal needs no declaration word and is marked as a union", () => {
    const union = patched(
      "src/types.ts",
      [" export type Phase =", '   | "draft"', '+  | "archived"', '   | "live";'],
      "@@ -7,3 +7,4 @@",
    );
    expect(memberCandidates([union])).toEqual([
      {
        file: "src/types.ts",
        hunk: 0,
        line: 9,
        text: '  | "archived"',
        union: true,
        typeName: "Phase",
      },
    ]);
  });

  // MUTATION: start `existing.union` as true in memberCandidates — both
  // literals become candidates and this fails.
  it("literals added beside no literal the union already had are not members added to one", () => {
    const f = patched("src/types.ts", ['+  | "a"', '+  | "b";'], "@@ -3,1 +3,3 @@ export type X =");
    expect(memberCandidates([f])).toEqual([]);
  });

  // MUTATION: drop the `unions.fresh` test in memberCandidates — the new
  // union's literals are candidates beside the other union's and this fails.
  it("a wholly new union beside another union's literals is not a member added to one", () => {
    const f = patched("src/types.ts", [
      " export type Phase =",
      '   | "draft"',
      '   | "live";',
      "+export type Mode =",
      '+  | "x"',
      '+  | "y";',
    ]);
    expect(memberCandidates([f])).toEqual([]);
  });

  // MUTATION: count context lines only (`l.sign === " "` for `existing` in
  // memberCandidates) — the renamed member is lost and this fails.
  it("a removed member is one the enumeration already had: a rename is a candidate", () => {
    const f = patched(
      "src/kind.ts",
      [" enum Kind {", "-  Beta,", "+  Delta,", " }"],
      "@@ -10,3 +10,3 @@",
    );
    expect(memberCandidates([f]).map((c) => c.text)).toEqual(["  Delta,"]);
  });

  // MUTATION: merge the two flags (`existing.union || existing.enum` for
  // either kind in memberCandidates) — a line of one kind beside lines of the
  // other becomes a candidate and this fails.
  it("a member of one kind does not make the other kind an existing one", () => {
    const enumBesideUnion = patched(
      "src/types.ts",
      ['   | "a"', "+  Foo,"],
      "@@ -3,2 +3,3 @@ export enum Kind {",
    );
    expect(memberCandidates([enumBesideUnion])).toEqual([]);
    const unionBesideEnum = patched(
      "src/types.ts",
      ["   Alpha,", '+  | "b"'],
      "@@ -3,2 +3,3 @@ export type Phase =",
    );
    expect(memberCandidates([unionBesideEnum])).toEqual([]);
    // The same in the shape a change has: a new enumeration under a union,
    // and a new union under an enumeration.
    const enumAfterUnion = patched("src/types.ts", [
      " export type Phase =",
      '   | "draft"',
      '   | "live";',
      "+export enum Kind {",
      "+  A,",
      "+  B,",
      "+}",
    ]);
    expect(memberCandidates([enumAfterUnion])).toEqual([]);
    const unionAfterEnum = patched(
      "src/kind.ts",
      ["   Alpha,", "   Beta,", " }", "+export type Phase =", '+  | "a"', '+  | "b";'],
      "@@ -3,3 +3,6 @@ export enum Kind {",
    );
    expect(memberCandidates([unionAfterEnum])).toEqual([]);
  });

  // MUTATION: drop `(?:(?:class|struct)\s+)?(?!(?:class|struct)\b)` from
  // ENUM_NAME_RE (take the identifier after the keyword) — `enum class
  // Status` names `class` and this fails.
  it("the type name follows the shape of the declaration", () => {
    const cases: [string, string | undefined][] = [
      ["class IO(StrEnum):", "IO"],
      ["class OrderStatus(models.TextChoices):", "OrderStatus"],
      ["class Colour(str, Enum):", "Colour"],
      ["export enum AccountStatus {", "AccountStatus"],
      ["enum class Status(val code: Int) {", "Status"],
      ["enum struct Flags : int {", "Flags"],
      ["public sealed interface Shape permits Circle {", "Shape"],
      ["sealed trait Status", "Status"],
      ["export type Phase =", "Phase"],
      ["Mode = Literal[", "Mode"],
      ["\tPending Status = iota", "Status"],
      ["\tPending = iota", undefined],
      ["typedef enum {", undefined],
      ["const (", undefined],
      ["class Order(Base):", undefined],
    ];
    for (const [line, name] of cases) expect(enumTypeName(line), line).toBe(name);
  });

  // MUTATION: drop the NOT_DECL_RE test in memberCandidates — the comment's
  // "enum of" names the type `of` and this fails.
  it("a comment or an import that holds the word names no type", () => {
    const f = patched(
      "app/colour.py",
      [" # the enum of colours we print", "     RED = 1", "+    BLUE = 2"],
      "@@ -4,3 +4,4 @@ class Colour(Enum):",
    );
    expect(memberCandidates([f]).map((c) => c.typeName)).toEqual(["Colour"]);
    const imported = patched(
      "app/colour.py",
      [" from enum import Enum", "     RED = 1", "+    BLUE = 2"],
      "@@ -4,3 +4,4 @@ class Colour(Enum):",
    );
    expect(memberCandidates([imported]).map((c) => c.typeName)).toEqual(["Colour"]);
  });

  // MUTATION: let any line that holds the word open a declaration (`openedBy`
  // answers `{ name }` whatever the line is) — `BLUE = enum.auto()` opens a
  // new block with no name, the candidate is lost and this fails.
  it("a member line that holds the word keeps the declaration above it", () => {
    const body = [" RED = enum.auto()", " GREEN = enum.auto()", "+ BLUE = enum.auto()"];
    const header = patched("app/colour.py", body, "@@ -4,3 +4,4 @@ class Colour(enum.Enum):");
    const context = patched("app/colour.py", [" class Colour(enum.Enum):", ...body]);
    for (const f of [header, context])
      expect(memberCandidates([f]).map((c) => [c.text, c.typeName])).toEqual([
        [" BLUE = enum.auto()", "Colour"],
      ]);
    // A bare `X = iota` does open a block, and it names no type.
    const go = patched(
      "pkg/status.go",
      [" \tPending Status = iota", " \tPaid", " )", " const (", " \tA = iota", " \tB", "+\tC"],
      "@@ -5,6 +5,7 @@",
    );
    expect(memberCandidates([go]).map((c) => [c.text, c.typeName])).toEqual([["\tC", undefined]]);
  });

  // MUTATION: read a trailing comment as code (`codeOf` answers the line as
  // it is) — the comment names the type `member`, a comment declares the last
  // hunk, and this fails.
  it("a trailing comment that holds the word declares nothing and names no type", () => {
    const ts = patched(
      "src/status.ts",
      ["   Active = 1, // first enum member", "+  Closed = 2,"],
      "@@ -3,2 +3,3 @@ export enum AccountStatus {",
    );
    expect(memberCandidates([ts]).map((c) => c.typeName)).toEqual(["AccountStatus"]);
    const py = patched("app/colour.py", [
      " class Colour(Enum):",
      "     RED = 1  # first enum member",
      "+    BLUE = 2",
    ]);
    expect(memberCandidates([py]).map((c) => c.typeName)).toEqual(["Colour"]);
    // On the added member itself: it is still a member of the enumeration.
    const own = patched(
      "src/status.ts",
      ["   Active = 'active',", "+  Suspended = 'suspended', // new enum member"],
      "@@ -3,2 +3,3 @@ export enum AccountStatus {",
    );
    expect(memberCandidates([own]).map((c) => c.typeName)).toEqual(["AccountStatus"]);
    // A `#` inside a string is no comment: the declaration stands.
    const literal = patched("app/colour.py", [
      '-Colour = Literal["#fff"]',
      '+Colour = Literal["#fff", "#000"]',
    ]);
    expect(memberCandidates([literal]).map((c) => c.typeName)).toEqual(["Colour"]);
    const commented = patched("app/client.py", [
      "     retries=3,  # TODO: make this an enum",
      "+    timeout=30,",
    ]);
    expect(memberCandidates([commented])).toEqual([]);
  });

  // MUTATION: drop the NOT_DECL_RE half of `declaresEnum` — the import list
  // entries and the keyword argument become members and this fails.
  // MUTATION: test the word on the whole header again (`ENUM_DECL_RE.test(
  // h.header)` for `headerDeclares`) — the last case fails.
  it("an import or a comment that holds the word declares nothing: an import-list entry and a keyword argument are no member", () => {
    const typing = [" from typing import (", "     Any,", "+    Dict,", "     List,", " )"];
    const none: PrFileEntry[] = [
      patched("app/x.py", [" from enum import Enum", ...typing]),
      patched("src/x.ts", [
        " import {",
        "   Foo,",
        "+  Bar,",
        "   Baz,",
        ' } from "./types/enum";',
      ]),
      patched("app/x.py", [
        " # TODO: make this an enum",
        " client = Client(",
        "     timeout=30,",
        "+    retries=3,",
        " )",
      ]),
      patched("app/x.py", typing, "@@ -4,5 +4,6 @@ from enum import Enum"),
    ];
    for (const f of none) {
      expect(memberCandidates([f]), f.patch).toEqual([]);
      expect(of(select([f], "strong"), "pass-sm-exhaustive")).toBeUndefined();
    }
    // A declaration in the body still declares.
    const real = patched("app/colour.py", [
      " class Colour(Enum):",
      "     RED = 1",
      "+    BLUE = 2",
    ]);
    expect(memberCandidates([real]).map((c) => c.typeName)).toEqual(["Colour"]);
  });

  // MUTATION: take the type from the hunk header only (never update
  // `enumName` in the body) — the Go block has no header scope, its type is
  // lost and this fails.
  it("the nearest declaration above the member names the type", () => {
    const go = patched(
      "pkg/status.go",
      [" const (", " \tPending Status = iota", " \tPaid", "+\tShipped", " )"],
      "@@ -5,4 +5,5 @@",
    );
    expect(memberCandidates([go]).map((c) => [c.text, c.typeName])).toEqual([
      ["\tShipped", "Status"],
    ]);
    const two = patched(
      "src/enums.ts",
      ["   Red,", " }", " export enum Size {", "   Small,", "+  Large,"],
      "@@ -3,5 +3,6 @@ export enum Colour {",
    );
    expect(memberCandidates([two]).map((c) => c.typeName)).toEqual(["Size"]);
  });

  it("a test file, a docs file and a file with no patch carry no candidate", () => {
    expect(memberCandidates([{ ...grown, filename: "tests/status.test.ts" }])).toEqual([]);
    expect(memberCandidates([{ ...grown, filename: "docs/status.md" }])).toEqual([]);
    const { patch: _patch, ...bare } = grown;
    expect(memberCandidates([bare])).toEqual([]);
    expect(isSourceCode(grown)).toBe(true);
    expect(isSourceCode(bare)).toBe(false);
  });

  // MUTATION: remove the cut in hunksOf (`const cut = raw;`) — the text past
  // LINE_MAX is read, the line is no longer member-shaped and this fails.
  it("reads only the first LINE_MAX characters of a line", () => {
    const long = `  Suspended,${" ".repeat(LINE_MAX)}and(more`;
    const f = patched("src/status.ts", ["   Active,", `+${long}`], "@@ -3,2 +3,3 @@ enum Status {");
    expect(memberCandidates([f]).map((c) => c.text)).toEqual([long.slice(0, LINE_MAX)]);
  });

  // The declaration a candidate belongs to is carried forward through the
  // hunk. MUTATION: find it per candidate instead, by walking up from the
  // member to the top of the hunk — the hunk below then costs one walk per
  // added line and this fails.
  it("stays linear in a hunk of many added members", () => {
    const lines = [" First,"];
    for (let i = 0; i < 60_000; i++) lines.push(`+M${i},`);
    const f = patched("src/big.ts", lines, "@@ -1,1 +1,60001 @@ enum Big {");
    const started = performance.now();
    expect(memberCandidates([f])).toHaveLength(60_000);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  // MUTATION: restore the member pattern's free-standing `\s*` between its
  // optional parts (`IDENT\s*(?:\(…\))?\s*(?:=…)?\s*[,;]?\s*`) — one line of
  // blanks then costs a scan per way of splitting it, and this fails.
  it("a run of blanks in a member-shaped line costs one scan", () => {
    const signed = (sign: string): string[] =>
      Array.from({ length: 5 }, () => BLANK_RUNS.map((l) => `${sign}${l}`)).flat();
    const header = "@@ -1,50 +1,50 @@ enum X {";
    const started = performance.now();
    expect(memberCandidates([patched("src/evil.ts", signed("+"), header)])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
    // Every other probe reads the same lines, on each side of the diff.
    const files = [
      patched("src/evil.ts", [...signed("+"), ...signed("-"), ...signed(" ")], header),
      patched("db/migrate/evil.sql", signed("+")),
    ];
    for (let i = 0; i < 10; i++) select(files, "all", { body: BLANK_RUNS.join("\n") });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
