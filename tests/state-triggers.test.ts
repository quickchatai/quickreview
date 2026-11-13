// State-machine triggers (packages/pi-plugin/src/statetriggers.ts): which
// pass-sm-* lenses a PR's content plans. Every case hands `selectStateLenses`
// a file list as GitHub returns it and asserts on the selection — the lens,
// the strength and the reason — never on a probe's internals.
// The member detector (`memberCandidates`, the list the strong exhaustive
// probe names the first of) is driven through its export, with the same file
// lists, and asserted on the member lines it finds.
import { describe, expect, it } from "vitest";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";
import { EMPTY_HEURISTICS } from "@quickchatai/pi-quickreview/src/heuristics.js";
import { STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import {
  ADD_BACK_SCANS_MAX,
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

  it("a test file, a docs file and a file with no patch fire nothing", () => {
    const f = patched(
      "src/status.ts",
      ["   Active,", "+  Closed,", "+order.status = next;"],
      "@@ -3,2 +3,4 @@ enum Status {",
    );
    expect(lensesOf(select([f]))).toEqual(["pass-sm-transitions", "pass-sm-exhaustive"]);
    const { patch: _patch, ...bare } = f;
    for (const g of [
      { ...f, filename: "tests/status.test.ts" },
      { ...f, filename: "docs/status.md" },
      bare,
    ])
      expect(select([g]), g.filename).toEqual([]);
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
  it("two status flags added in one file are strong, camel- or snake-case; one is weak", () => {
    for (const two of [
      added(
        "src/form.tsx",
        "const [isSaving, setIsSaving] = useState(false);",
        "isDirty: boolean;",
      ),
      added("app/models.py", "is_active = models.BooleanField(default=True)", "has_paid = False"),
    ]) {
      const hit = of(select([two], "strong"), "pass-sm-states");
      expect(hit, two.filename).toMatchObject({ strength: "strong" });
      expect(hit!.why).toContain("two or more status flags");
    }
    const one = [added("src/form.tsx", "isDirty: boolean;")];
    expect(of(select(one, "strong"), "pass-sm-states")).toBeUndefined();
    expect(of(select(one, "all"), "pass-sm-states")).toMatchObject({ strength: "weak" });
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
    const edited = (n: number): StateSelection | undefined =>
      of(select([rewritten(n, (c) => `  } else ${c}`)], "strong"), "pass-sm-transitions");
    expect(edited(ADD_BACK_SCANS_MAX)).toBeUndefined();
    const over = edited(ADD_BACK_SCANS_MAX + 1);
    expect(over).toMatchObject({ strength: "strong" });
    expect(over!.why).toContain(`o${ADD_BACK_SCANS_MAX}.status`);
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
    expect(memberCandidates([both]).map((c) => c.text)).toEqual(["  Suspended = 'suspended',"]);
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
    expect(memberCandidates([rebased]).map((c) => c.text)).toEqual(["    B = 2"]);
    expect(of(select([rebased], "strong"), "pass-sm-exhaustive")).toMatchObject({
      strength: "strong",
    });
    const widened = patched("app/phase.py", [
      '-Phase = Literal["a", "b"]',
      '+Phase = Literal["a", "b", "c"]',
    ]);
    expect(memberCandidates([widened]).map((c) => c.text)).toEqual([
      'Phase = Literal["a", "b", "c"]',
    ]);
  });

  // No line of this patch holds a declaration word (`type X =` is none): a
  // union literal needs none. MUTATION: require `declared` of a union
  // candidate too — the literal is lost and this fails.
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
});

describe("pass-sm-derived", () => {
  it("an effect whose body only sets state is strong", () => {
    const sel = select(
      [added("src/c.tsx", "useEffect(() => { setTotal(items.length); }, [items]);")],
      "strong",
    );
    expect(of(sel, "pass-sm-derived")).toMatchObject({ strength: "strong" });
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
});

describe("weak signals, and the lines that are none", () => {
  // Each line alone, added to `file`, under mode `all`: `weak` plans `lens`
  // weakly (`why` names the row when two weak rows could fire); otherwise
  // it plans it not at all.
  const cases: { lens: string; file: string; line: string; weak: boolean; why?: string }[] = [
    {
      lens: "pass-sm-states",
      file: "src/task.ts",
      line: "completedAt?: Date | null;",
      weak: true,
      why: "nullable marker",
    },
    { lens: "pass-sm-states", file: "src/a.ts", line: "const ok = a === b;", weak: false },
    ...[
      "order.status = Status.SHIPPED;",
      "setPhase('review');",
      "machine.transitionTo('done');",
      "await db.update({ status: 'PAID' });",
    ].map((line) => ({ lens: "pass-sm-transitions", file: "src/x.ts", line, weak: true })),
    {
      lens: "pass-sm-transitions",
      file: "src/x.ts",
      line: "if (order.status === 'paid') return;",
      weak: false,
    },
    { lens: "pass-sm-exhaustive", file: "src/x.ts", line: "switch (order.status) {", weak: true },
    { lens: "pass-sm-stuck", file: "app/jobs.py", line: "job.status = 'processing'", weak: true },
    { lens: "pass-sm-stuck", file: "src/x.ts", line: "setLoading(false);", weak: false },
    ...[
      "window.addEventListener('message', onMessage);",
      "emitter.on('paid', handlePaid);",
      "@receiver(post_save, sender=Order)",
      "def handle_invoice_paid(event):",
      "onSubmit = async () => {",
    ].map((line) => ({ lens: "pass-sm-events", file: "src/x.py", line, weak: true })),
    {
      lens: "pass-sm-derived",
      file: "src/x.ts",
      line: "order.itemCount = items.length;",
      weak: true,
    },
    {
      lens: "pass-sm-derived",
      file: "src/x.ts",
      line: "if (order.itemCount === 0) return;",
      weak: false,
    },
    ...["async function shutdown() {", "def close(self):", "componentWillUnmount() {"].map(
      (line) => ({ lens: "pass-sm-lifecycle", file: "src/x.py", line, weak: true }),
    ),
    ...[
      'cur.execute("UPDATE orders SET status = %s WHERE id = %s", (s, id))',
      "Order.objects.filter(id=pk).update(status='paid')",
    ].map((line) => ({ lens: "pass-sm-durable", file: "app/repo.py", line, weak: true })),
  ];

  it.each(cases)("$lens: `$line`", ({ lens, file, line, weak, why }) => {
    const hit = of(select([added(file, line)]), lens);
    if (!weak) return expect(hit).toBeUndefined();
    expect(hit).toMatchObject({ strength: "weak" });
    if (why) expect(hit!.why).toContain(why);
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
  const members = (f: PrFileEntry): string[] => memberCandidates([f]).map((c) => c.text);

  it.each<[string, PrFileEntry, string]>([
    // The control for "a declaration word in another hunk" below.
    [
      "a constant under a declaration of its own hunk",
      hunked("src/config.ts", [
        "@@ -40,3 +40,4 @@ enum Limits {",
        [" RETRIES = 3", "+TIMEOUT = 30", " BACKOFF = 2"],
      ]),
      "TIMEOUT = 30",
    ],
    // The control for "a match arm" below.
    [
      "a Rust variant",
      patched(
        "src/kind.rs",
        [
          "     Alpha,",
          "     Beta,",
          " }",
          " fn code(k: Kind) -> Option<u8> { match k {",
          "+    Gamma,",
        ],
        "@@ -3,5 +3,6 @@ pub enum Kind {",
      ),
      "    Gamma,",
    ],
    // MUTATION: count context lines only (`l.sign === " "` for `existing` in
    // memberCandidates) — the renamed member is lost and this fails.
    [
      "a rename: a removed member is one the enumeration already had",
      patched("src/kind.ts", [" enum Kind {", "-  Beta,", "+  Delta,", " }"], "@@ -10,3 +10,3 @@"),
      "  Delta,",
    ],
    // MUTATION: let any line that holds the word open a declaration
    // (`openedBy` answers `{ name }` whatever the line is) — `BLUE =
    // enum.auto()` opens a new block, the candidate is lost and both fail.
    [
      "a member line that holds the word, the declaration in the header",
      patched(
        "app/colour.py",
        [" RED = enum.auto()", " GREEN = enum.auto()", "+ BLUE = enum.auto()"],
        "@@ -4,3 +4,4 @@ class Colour(enum.Enum):",
      ),
      " BLUE = enum.auto()",
    ],
    [
      "a member line that holds the word, the declaration in the body",
      patched("app/colour.py", [
        " class Colour(enum.Enum):",
        " RED = enum.auto()",
        " GREEN = enum.auto()",
        "+ BLUE = enum.auto()",
      ]),
      " BLUE = enum.auto()",
    ],
    // MUTATION: read a trailing comment as code (`codeOf` answers the line as
    // it is) — the added member's own comment declares a new enumeration and
    // this fails.
    [
      "a member whose trailing comment holds the word",
      patched(
        "src/status.ts",
        ["   Active = 'active',", "+  Suspended = 'suspended', // new enum member"],
        "@@ -3,2 +3,3 @@ export enum AccountStatus {",
      ),
      "  Suspended = 'suspended', // new enum member",
    ],
    // A `#` inside a string is no comment: the declaration stands.
    [
      "a Literal whose strings hold a `#`",
      patched("app/colour.py", ['-Colour = Literal["#fff"]', '+Colour = Literal["#fff", "#000"]']),
      'Colour = Literal["#fff", "#000"]',
    ],
  ])("finds %s", (_, f, member) => {
    expect(members(f)).toEqual([member]);
    expect(of(select([f], "strong"), "pass-sm-exhaustive")!.why).toContain(member.trim());
  });

  const typing = [" from typing import (", "     Any,", "+    Dict,", "     List,", " )"];
  it.each<[string, PrFileEntry]>([
    // MUTATION: make `declared` patch-wide (test ENUM_DECL_RE against every
    // line of the patch instead of the hunk's own) — the second hunk's
    // constant becomes a member and this fails.
    [
      "a constant beside a declaration word in another hunk",
      hunked(
        "src/config.ts",
        ["@@ -1,3 +1,3 @@", [" export enum Kind {", "   A = 'a',", " }"]],
        ["@@ -40,3 +40,4 @@ function load() {", [" RETRIES = 3", "+TIMEOUT = 30", " BACKOFF = 2"]],
      ),
    ],
    // MUTATION: drop `(?!>)` from ENUM_MEMBER_RE — the match arm reads as a
    // member assigned `> None` and this fails.
    [
      "a match arm beside enum variants",
      patched(
        "src/kind.rs",
        [
          "     Alpha,",
          "     Beta,",
          " }",
          " fn code(k: Kind) -> Option<u8> { match k {",
          "+        _ => None,",
        ],
        "@@ -3,5 +3,6 @@ pub enum Kind {",
      ),
    ],
    // MUTATION: start `existing.union` as true in memberCandidates — both
    // literals become candidates and this fails.
    [
      "literals beside no literal the union already had",
      patched("src/types.ts", ['+  | "a"', '+  | "b";'], "@@ -3,1 +3,3 @@ export type X ="),
    ],
    // MUTATION: drop the `unions.fresh` test in memberCandidates — the new
    // union's literals are candidates and this fails.
    [
      "a wholly new union beside another union's literals",
      patched("src/types.ts", [
        " export type Phase =",
        '   | "draft"',
        '   | "live";',
        "+export type Mode =",
        '+  | "x"',
        '+  | "y";',
      ]),
    ],
    // MUTATION: merge the two flags (`existing.union || existing.enum` for
    // either kind in memberCandidates) — each of the next four fails.
    [
      "an enum member beside union literals",
      patched("src/types.ts", ['   | "a"', "+  Foo,"], "@@ -3,2 +3,3 @@ export enum Kind {"),
    ],
    [
      "a union literal beside enum members",
      patched("src/types.ts", ["   Alpha,", '+  | "b"'], "@@ -3,2 +3,3 @@ export type Phase ="),
    ],
    [
      "a new enumeration under a union",
      patched("src/types.ts", [
        " export type Phase =",
        '   | "draft"',
        '   | "live";',
        "+export enum Kind {",
        "+  A,",
        "+  B,",
        "+}",
      ]),
    ],
    [
      "a new union under an enumeration",
      patched(
        "src/kind.ts",
        ["   Alpha,", "   Beta,", " }", "+export type Phase =", '+  | "a"', '+  | "b";'],
        "@@ -3,3 +3,6 @@ export enum Kind {",
      ),
    ],
    // MUTATION: drop the NOT_DECL_RE half of `declaresEnum` — the import-list
    // entries and the keyword argument become members and these fail.
    [
      "an import-list entry under `from enum import`",
      patched("app/x.py", [" from enum import Enum", ...typing]),
    ],
    [
      "a TS import-list entry from an `enum` module",
      patched("src/x.ts", [
        " import {",
        "   Foo,",
        "+  Bar,",
        "   Baz,",
        ' } from "./types/enum";',
      ]),
    ],
    [
      "a keyword argument under a comment that holds the word",
      patched("app/x.py", [
        " # TODO: make this an enum",
        " client = Client(",
        "     timeout=30,",
        "+    retries=3,",
        " )",
      ]),
    ],
    // MUTATION: test the word on the whole header again (`ENUM_DECL_RE.test(
    // h.header)` for `headerDeclares`) — this fails.
    [
      "an import-list entry under an import header",
      patched("app/x.py", typing, "@@ -4,5 +4,6 @@ from enum import Enum"),
    ],
    // MUTATION: read a trailing comment as code (`codeOf` answers the line as
    // it is) — the comment declares the hunk and this fails.
    [
      "a keyword argument beside a trailing comment that holds the word",
      patched("app/client.py", ["     retries=3,  # TODO: make this an enum", "+    timeout=30,"]),
    ],
  ])("finds no member in %s", (_, f) => {
    expect(members(f)).toEqual([]);
    expect(of(select([f], "strong"), "pass-sm-exhaustive")).toBeUndefined();
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
