// The structure engine (packages/pi-plugin/src/stateshape.ts): line kinds,
// block depth, function extent and exits for each language family the
// state lenses meet — C, C++, Go, TS/JS, Python — the statement keys two
// sites compare by, and the honest unknown when the text cannot be counted.
// Every case drives `shapeOf` on a literal file and asserts on what it
// returns, never on the lexer's internals.
import { describe, expect, it } from "vitest";
import {
  dialectOf,
  exitsOf,
  functionAt,
  lineFunctions,
  normalise,
  receiverWrite,
  shapeOf,
  STATE_SHAPE_PROBES,
  stmtKey,
  type Block,
  type Shape,
} from "@quickchatai/pi-quickreview/src/stateshape.js";
import { LINE_MAX } from "@quickchatai/pi-quickreview/src/statetriggers.js";
import {
  COLUMN_SHAPES,
  scanLines,
  TokenTable,
} from "@quickchatai/pi-quickreview/src/statetokens.js";

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

function fns(shape: Shape): Block[] {
  return (shape.structure?.blocks ?? []).filter((b) => b.kind === "function");
}
function fn(shape: Shape, name: string): Block {
  const f = fns(shape).find((b) => b.name === name);
  expect(f, `function ${name}`).toBeDefined();
  return f!;
}
function exits(shape: Shape, name: string): string[] {
  return exitsOf(shape, fn(shape, name)).map((e) => `${e.kind}@${e.line}`);
}
function kinds(shape: Shape): string {
  return shape.lines.map((l) => l.kind[0]).join("");
}

describe("dialects", () => {
  it("names the family by extension, and nothing for any other file", () => {
    expect(dialectOf("src/a.c")).toBe("c");
    expect(dialectOf("src/a.hpp")).toBe("c");
    expect(dialectOf("src/a.mm")).toBe("c");
    expect(dialectOf("web/a.tsx")).toBe("js");
    expect(dialectOf("web/a.mjs")).toBe("js");
    expect(dialectOf("svc/a.go")).toBe("go");
    expect(dialectOf("app/a.pyi")).toBe("py");
    expect(dialectOf("App.kt")).toBe("jvm");
    expect(dialectOf("lib/a.rb")).toBeNull();
    expect(dialectOf("Makefile")).toBeNull();
    expect(dialectOf("dir.c/README")).toBeNull();
  });

  it("an unrecognised language has no structure and says so", () => {
    const s = shapeOf("lib/a.rb", "def x\n  1\nend\n");
    expect(s.structure).toBeNull();
    expect(s.unknown).toMatch(/not one the structure reads/);
  });
});

describe("C", () => {
  const c = lines(
    "#include <stdio.h>", //                     1
    "static int open_dev(struct dev *d, int flags)", // 2
    "{", //                                       3
    "    int rc = 0;", //                         4
    "    d->state = DEV_OPENING;", //             5
    "#ifdef HAVE_LOCK", //                        6
    "    if (lock(d)) {", //                      7
    "#else", //                                   8
    "    if (trylock(d)) {", //                   9
    "#endif", //                                  10
    "        rc = -EBUSY;", //                    11
    "        goto out;", //                       12
    "    }", //                                   13
    "    char q = '{';", //                       14
    '    const char *s = "}}";', //               15
    "    d->state = DEV_OPEN; /* { */", //        16
    "    return 0;", //                           17
    "out:", //                                    18
    "    d->state = DEV_CLOSED;", //              19
    "    return rc;", //                          20
    "}", //                                       21
    "#define LOCKED(d) { lock(d); }", //          22
  );

  // MUTATION: drop the #if/#else restore (treat a `#` line as plain code, or
  // let both branches' `if (…) {` count) — the braces no longer balance and
  // the structure is unknown, so this fails.
  it("keeps # lines as their own kind and lets one branch of an #if open a block", () => {
    const s = shapeOf("src/dev.c", c);
    expect(s.unknown).toBeUndefined();
    expect(kinds(s)).toBe("pccccpcpcpcccccccccccpb");
    const f = fn(s, "open_dev");
    expect([f.open, f.body, f.end]).toEqual([2, 3, 21]);
    expect(s.lines[11 - 1]!.depth).toBe(2);
    expect(s.lines[14 - 1]!.depth).toBe(1);
  });

  it("blanks char literals, strings and comments, so their braces do not count", () => {
    const s = shapeOf("src/dev.c", c);
    expect(s.lines[14 - 1]!.code).toBe("    char q = '\x01';");
    expect(s.lines[15 - 1]!.code).toBe('    const char *s = "\x01\x01";');
    expect(s.lines[16 - 1]!.code.trimEnd()).toBe("    d->state = DEV_OPEN;");
  });

  it("finds the goto cleanup exit and both returns", () => {
    expect(exits(shapeOf("src/dev.c", c), "open_dev")).toEqual([
      "goto@12",
      "return@17",
      "return@20",
    ]);
  });

  it("a struct in the parameters does not make the head a struct", () => {
    expect(fns(shapeOf("src/dev.c", c)).map((b) => b.name)).toEqual(["open_dev"]);
  });
});

describe("C++", () => {
  const cpp = lines(
    "void Conn::close() {", //                    1
    '  auto raw = R"x(}{)x";', //                 2
    "  int n = 1'000'000;", //                    3
    "  if (fd_ < 0) return;", //                  4
    "#if defined(TLS)", //                        5
    "  if (tls_) {", //                           6
    "    if (!tls_->shutdown()) goto fail;", //   7
    "  }", //                                     8
    "#endif", //                                  9
    "  state_ = State::kClosed;", //              10
    "  cb_();", //                                11
    "  return;", //                               12
    "fail:", //                                   13
    "  state_ = State::kBroken;", //              14
    "}", //                                       15
    "auto Conn::name() const -> std::string {", //16
    "  return name_;", //                         17
    "}", //                                       18
  );

  it("reads raw strings, digit separators, #if blocks and goto cleanup", () => {
    const s = shapeOf("net/conn.cpp", cpp);
    expect(s.unknown).toBeUndefined();
    expect(fns(s).map((b) => [b.name, b.open, b.end])).toEqual([
      ["close", 1, 15],
      ["name", 16, 18],
    ]);
    expect(s.lines[2 - 1]!.code).toBe('  auto raw = R"\x01\x01\x01\x01)x";');
    expect(exits(s, "close")).toEqual(["return@4", "goto@7", "return@12", "end@15"]);
  });

  it("keys a member write with its enum value", () => {
    const s = shapeOf("net/conn.cpp", cpp);
    expect(stmtKey(s.lines[10 - 1]!.code)).toEqual({
      key: "state_ = State::kClosed",
      token: "state_",
      kind: "write",
      deferred: false,
      members: ["state_"],
    });
    expect(stmtKey(s.lines[11 - 1]!.code)?.key).toBe("cb_()");
  });
});

describe("Go", () => {
  const go = lines(
    "package srv", //                                         1
    "", //                                                    2
    "func (s *Server) Start(ctx context.Context) error {", // 3
    "\ts.mu.Lock()", //                                       4
    "\tdefer s.mu.Unlock()", //                               5
    "\tif s.state != stateIdle {", //                         6
    "\t\treturn errBusy", //                                  7
    "\t}", //                                                 8
    "\ts.state = stateStarting", //                           9
    "\tconn, err := dial(`raw {`)", //                        10
    "\tif err != nil {", //                                   11
    "\t\treturn err", //                                      12
    "\t}", //                                                 13
    "\tgo func() {", //                                       14
    "\t\tdefer s.wg.Done()", //                               15
    "\t\tserve(conn)", //                                     16
    "\t}()", //                                               17
    "\tfor i := 0; i < 3; i++ {", //                          18
    "\t\ts.n++", //                                           19
    "\t}", //                                                 20
    "\ts.state = stateRunning", //                            21
    "\treturn nil", //                                        22
    "}", //                                                   23
  );

  it("reads raw strings, a func literal and a three-clause for", () => {
    const s = shapeOf("srv/server.go", go);
    expect(s.unknown).toBeUndefined();
    const blocks = s.structure!.blocks.map((b) => `${b.kind}:${b.keyword}:${b.open}-${b.end}`);
    expect(blocks).toEqual([
      "function:function:3-23",
      "control:if:6-8",
      "control:if:11-13",
      "function:function:14-17",
      "control:for:18-20",
    ]);
    expect(fns(s).map((b) => b.name)).toEqual(["Start", "<anonymous>"]);
  });

  it("finds defer as a handler and every err return, and not the goroutine's own exits", () => {
    const s = shapeOf("srv/server.go", go);
    expect(exits(s, "Start")).toEqual(["defer@5", "return@7", "return@12", "return@22"]);
  });

  it("keys lowercase constants, increments and deferred calls", () => {
    const s = shapeOf("srv/server.go", go);
    expect(stmtKey(s.lines[9 - 1]!.code)?.key).toBe("s.state = stateStarting");
    expect(stmtKey(s.lines[21 - 1]!.code)?.key).toBe("s.state = stateRunning");
    expect(stmtKey(s.lines[19 - 1]!.code)?.key).toBe("s.n ++/--");
    expect(stmtKey(s.lines[5 - 1]!.code)).toMatchObject({ key: "s.mu.Unlock()", deferred: true });
    expect(stmtKey(s.lines[10 - 1]!.code)?.key).toBe('dial("")');
  });
});

describe("TypeScript", () => {
  const ts = lines(
    "export class Store {", //                                        1
    "  private loading = false;", //                                  2
    "  async load(id: string): Promise<void> {", //                   3
    "    this.loading = true;", //                                    4
    "    const re = /[{]+\\/}/g;", //                                 5
    "    const msg = `id ${id} {${ {a: `}`}.a } {`;", //              6
    "    try {", //                                                   7
    "      const r = await api.get(id);", //                          8
    "      if (!r.ok) {", //                                          9
    '        this.error = "bad {";', //                               10
    "        return;", //                                             11
    "      }", //                                                     12
    "      this.items = r.items;", //                                 13
    "    } catch (e) {", //                                           14
    "      throw e;", //                                              15
    "    } finally {", //                                             16
    "      this.loading = false;", //                                 17
    "    }", //                                                       18
    "  }", //                                                         19
    "  render = () => {", //                                          20
    "    return <div onClick={() => { this.go(); }}>{this.n}</div>;", // 21
    "  };", //                                                        22
    "}", //                                                           23
    "useEffect(() => {", //                                           24
    "  const t = setTimeout(tick, 10)", //                            25
    "  return () => clearTimeout(t)", //                              26
    "}, []);", //                                                     27
  );

  // MUTATION: drop the template-literal mode (treat a backtick as a plain
  // character) — the literal `{` at the end of line 6's template counts as a
  // block, the braces no longer balance, and this fails.
  it("reads template literals with nested ${}, regex literals and JSX braces", () => {
    const s = shapeOf("web/store.tsx", ts);
    expect(s.unknown).toBeUndefined();
    expect(fns(s).map((b) => `${b.name}:${b.open}-${b.end}`)).toEqual([
      "load:3-19",
      "render:20-22",
      "<anonymous>:21-21",
      "<callback of useEffect>:24-27",
    ]);
    expect(s.lines[5 - 1]!.code).not.toContain("{");
  });

  it("lists try/catch/finally handlers beside the exits", () => {
    const s = shapeOf("web/store.tsx", ts);
    expect(exits(s, "load")).toEqual(["return@11", "catch@14", "throw@15", "finally@16", "end@19"]);
    expect(exits(s, "<callback of useEffect>")).toEqual(["return@26"]);
  });

  it("keys member writes with their literal and drops declarations without a call", () => {
    const s = shapeOf("web/store.tsx", ts);
    expect(stmtKey(s.lines[4 - 1]!.code)?.key).toBe("loading = true");
    expect(stmtKey(s.lines[17 - 1]!.code)?.key).toBe("loading = false");
    expect(stmtKey(s.lines[10 - 1]!.code)?.key).toBe('error = ""');
    expect(stmtKey(s.lines[8 - 1]!.code)?.key).toBe("api.get(…)");
    expect(stmtKey(s.lines[5 - 1]!.code)).toBeNull();
    expect(stmtKey(s.lines[9 - 1]!.code)).toBeNull();
  });

  it("maps every line to its function, a head line to its own function", () => {
    const s = shapeOf("web/store.tsx", ts);
    const at = lineFunctions(s);
    const name = (line: number): string | undefined => {
      const id = at[line - 1]!;
      return id < 0 ? undefined : s.structure!.blocks[id]!.name;
    };
    expect([name(1), name(3), name(15), name(20), name(25), name(27)]).toEqual([
      undefined,
      "load",
      "load",
      "render",
      "<callback of useEffect>",
      "<callback of useEffect>",
    ]);
    expect(functionAt(s, 3)?.name).toBe("load");
  });
});

describe("Python", () => {
  const py = lines(
    "class Job:", //                                  1
    "    def run(self):", //                          2
    '        """Run it.', //                          3
    "def not_a_def(): {", //                          4
    '        """', //                                 5
    '        self.status = "running"', //             6
    "        try:", //                                7
    "            for x in (1,", //                    8
    "                      2):", //                   9
    "                if x:", //                       10
    "                    continue", //                11
    "            self.save()", //                     12
    "        except Exception as e:", //              13
    "            self.status = 'failed'", //          14
    "            raise", //                           15
    "        finally:", //                            16
    "            self.lock.release()", //             17
    "        return True", //                         18
    "", //                                            19
    "    async def stop(self):", //                   20
    "        with self.lock:", //                     21
    '            self.status = "stopped"', //         22
  );

  // MUTATION: count a line inside a triple-quoted string as a statement (drop
  // the in-literal continuation) — line 4's column-0 text closes every block,
  // line 5 is then indented to no open level, and this fails.
  it("builds blocks from indentation, past triple quotes and bracket continuations", () => {
    const s = shapeOf("app/job.py", py);
    expect(s.unknown).toBeUndefined();
    expect(s.structure!.blocks.map((b) => `${b.keyword}:${b.open}-${b.body}-${b.end}`)).toEqual([
      "class:1-1-22",
      "function:2-2-18",
      "try:7-7-12",
      "for:8-9-11",
      "if:10-10-11",
      "except:13-13-15",
      "finally:16-16-17",
      "function:20-20-22",
      "with:21-21-22",
    ]);
    expect(s.lines[9 - 1]!.cont).toBe(true);
  });

  it("finds raise, continue, except, finally and with, and no fall-off after a return", () => {
    const s = shapeOf("app/job.py", py);
    expect(exits(s, "run")).toEqual([
      "continue@11",
      "except@13",
      "raise@15",
      "finally@16",
      "return@18",
    ]);
    expect(exits(s, "stop")).toEqual(["with@21", "end@22"]);
  });

  it("a dedent to no open block's level is unknown, and so is an opener with no body", () => {
    expect(
      shapeOf("a.py", lines("def f():", "    if x:", "        y = 1", "      z = 2")).unknown,
    ).toMatch(/line 4 is indented to a level no open block has/);
    expect(shapeOf("a.py", lines("def f():", "x = 1")).unknown).toMatch(/has no indented body/);
    expect(shapeOf("a.py", lines("x = (1,", "     2")).unknown).toMatch(/bracket is still open/);
  });
});

describe("honest unknown", () => {
  it("an unclosed brace, a stray closer and an unclosed comment have no structure", () => {
    const open = shapeOf("a.ts", lines("function f() {", "  if (a) {", "    g();", "}"));
    expect(open.structure).toBeNull();
    expect(open.unknown).toMatch(/1 block still open at the end of the file/);
    const stray = shapeOf("a.c", lines("int f() {", "}", "}"));
    expect(stray.unknown).toMatch(/closing brace at line 3 has no opener/);
    const comment = shapeOf("a.go", lines("func f() {", "/* never closed", "}"));
    expect(comment.unknown).toMatch(/block comment does not close/);
    // The code view still serves a name search.
    expect(comment.lines[1]!.kind).toBe("comment");
  });

  it("an unknown structure yields no function and no exits", () => {
    const s = shapeOf("a.ts", lines("function f() {", "  return 1;"));
    expect(functionAt(s, 2)).toBeNull();
    expect(lineFunctions(s)[1]).toBe(-1);
  });
});

describe("statement keys and normal form", () => {
  it("a control line, an exit and a local assignment without a call hold no key", () => {
    expect(stmtKey("  if (x) { go(); }")).toBeNull();
    expect(stmtKey("  return cleanup();")).toBeNull();
    expect(stmtKey("  total = 0;")).toBeNull();
    expect(stmtKey("  total = compute(a);")?.key).toBe("compute(…)");
    expect(stmtKey("  setLoading(false);")?.key).toBe("setLoading(false)");
    expect(stmtKey("  await this.finish();")?.key).toBe("finish()");
    expect(stmtKey("  self._cache[key] = value")?.key).toBe("_cache[…] = value");
  });

  it("abstracts string and number literals, never booleans", () => {
    expect(normalise('  x.status = "\x01\x01\x01";')).toBe('x.status = ""');
    expect(normalise("  retry(3, 0x1F,   true)")).toBe("retry(0, 0, true)");
  });
});

describe("linear and capped", () => {
  const run = " ".repeat(100_000);
  const evil = [
    "if ".repeat(5000),
    "(".repeat(4000) + ")".repeat(4000),
    `x${".a".repeat(3000)} = 1`,
    `${"a->".repeat(3000)}b(`,
    `func ${"(".repeat(3000)}`,
    `return ${"/[".repeat(3000)}`,
    `${"#".repeat(3000)}`,
    `${"`${".repeat(2000)}`,
  ];
  const blanks = [
    `x${run}= 1`,
    `return${run}x`,
    `if${run}(`,
    `a.b${run}(`,
    `defer${run}x`,
    `${run}x = 1`,
  ];

  // A pattern is linear by its shape: no unbounded `.`, no unbounded group,
  // no two blank runs back to back. MUTATION: write `.*` for the bounded
  // index class `[^\]\n]{0,60}` in WRITE_STMT_RE — this fails.
  it("no probe holds an unbounded scan inside another", () => {
    expect(new Set(STATE_SHAPE_PROBES.map((p) => p.id)).size).toBe(STATE_SHAPE_PROBES.length);
    for (const p of STATE_SHAPE_PROBES) {
      expect(p.re.sticky, p.id).toBe(false);
      const source = p.re.source;
      expect(/(?<!\\)\.[*+]/.test(source), `${p.id}: an unbounded dot`).toBe(false);
      expect(/\)(?:[*+]|\{\d+,\})/.test(source), `${p.id}: an unbounded group`).toBe(false);
      expect(/\\s[*+](?:(?:\\.|[^\\()|])\?)*\\s[*+]/.test(source), `${p.id}: two blank runs`).toBe(
        false,
      );
    }
  });

  it("every probe stays fast on pathological lines", () => {
    const all = [...evil.map((l) => l.slice(0, LINE_MAX)), ...blanks];
    const started = performance.now();
    for (const p of STATE_SHAPE_PROBES) for (const l of all) p.re.test(l);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  // A timing bound, not a fence: every lookahead the lexer takes is capped
  // (LINE_MAX for a regex literal, one failed look per line, 18 characters
  // for a raw-string delimiter), so a pass is linear. This catches a pass
  // gone quadratic (seconds); a constant factor (dropping the one-look rule
  // costs ~0.1 s here) is below what a timer can tell under load.
  it("a pathological 256 KiB file shapes in well under a second", () => {
    const big = [
      `const x = [${"[/".repeat(60_000)}];`,
      `const r = R"${'R"'.repeat(20_000)}";`,
      `go ${";".repeat(20_000)}`,
    ];
    for (const [path, text] of [
      ["a.ts", big[0]!],
      ["a.cpp", big[1]!],
      ["a.go", big[2]!],
    ] as const) {
      const started = performance.now();
      shapeOf(path, text);
      expect(performance.now() - started, path).toBeLessThan(1000);
    }
  });
});

describe("fixes from the offline replay", () => {
  // MUTATION: apply the keyword filter to a member's last segment again —
  // `map.delete(` holds no key and this fails.
  it("a member call named by a keyword is a call; the bare keyword is not", () => {
    expect(stmtKey("mcpServerPromptsInternal.delete(mcpServerName);")).toMatchObject({
      kind: "call",
      token: "delete",
    });
    expect(stmtKey("promise.catch(onError);")).toMatchObject({ kind: "call", token: "catch" });
    expect(stmtKey("if (ready) {")).toBeNull();
    expect(stmtKey("delete (obj.key);")).toBeNull();
  });

  // MUTATION: drop the object-pattern branch from the brace count — the
  // `{ a }` of the parameter list opens a block, the body is not inside
  // `Foo`, and `Foo`'s exits are lost.
  it("a destructured parameter list does not end the function's head (TS)", () => {
    const shape = shapeOf(
      "src/view.tsx",
      lines(
        "export function Foo({ a, b = {} }: Props) {",
        "  if (!a) {",
        "    return null;",
        "  }",
        "  done();",
        "  return b;",
        "}",
        "class S {",
        "  async onX({ id }: ArgOf<'x'>) {",
        "    if (id) return;",
        "    release();",
        "  }",
        "}",
        "export default function Bar({",
        "  c,",
        "}: P) {",
        "  return c;",
        "}",
        "const slice = createSlice({ name: 'n', initialState: { a: 1 } });",
      ),
    );
    expect(shape.structure).not.toBeNull();
    expect(fn(shape, "Foo")).toMatchObject({ open: 1, end: 7 });
    expect(exits(shape, "Foo")).toEqual(["return@3", "return@6"]);
    expect(fn(shape, "onX")).toMatchObject({ open: 9, end: 12 });
    expect(exits(shape, "onX")).toEqual(["return@10", "end@12"]);
    expect(fn(shape, "Bar")).toMatchObject({ open: 14, end: 18 });
    // A call's object argument after an assignment still opens a block, as
    // the persisted-shape kind reads a slice's head from it.
    const blocks = shape.structure!.blocks.filter((b) => b.open === 19);
    expect(blocks.some((b) => /createSlice\(/.test(b.head))).toBe(true);
  });

  // MUTATION: count only a return at the function's own level as its last
  // statement — the `with` body's return leaves a false fall-off at the end.
  it("a function whose with or try body ends in a return has no fall-off end", () => {
    const shape = shapeOf(
      "app/io.py",
      lines(
        "def read(path):",
        "    with open(path) as f:",
        "        data = f.read()",
        "        return data",
        "def write(path):",
        "    if path:",
        "        return 1",
      ),
    );
    expect(exits(shape, "read")).toEqual(["with@2", "return@4"]);
    expect(exits(shape, "write")).toEqual(["return@7", "end@7"]);
  });
});

describe("fixes from the second replay", () => {
  // MUTATIONS, each fails this: let only `(` and `,` open a pattern in a
  // parameter list (the `{` of `Request<{ … }>` opens a block, the method's
  // head is lost and line 12 sits in no function); drop the decorator prefix
  // from PARAM_LIST_HEAD_RE (the same-line `@Get('/')` method is lost); drop
  // DECORATOR_LEAD_RE from classifyHead (that method is named `Get`).
  it("a decorated method whose parameter has an object type argument is a function (TS)", () => {
    const shape = shapeOf(
      "src/member.controller.ts",
      lines(
        "@RestController('/teams/:teamId/members')", //       1
        "export class MemberController {", //                       2
        "  @Delete('/:memberId')", //                               3
        "  @Scope('member:remove')", //                      4
        "  async removeMember(", //                                 5
        "    req: AuthRequest<{ teamId: string; memberId: string }>,", // 6
        "    _res: Response,", //                                   7
        "    @Query payload: RemoveMemberDto,", //                  8
        "  ) {", //                                                 9
        "    const { teamId, memberId } = req.params;", //       10
        "    await this.audit.record(memberId);", //             11
        "    await this.members.removeMember(memberId, teamId);", // 12
        "  }", //                                                   13
        "  @Get('/') async list(req: AuthRequest<{ id: string }>) {", // 14
        "    return this.members.list(req.params.id);", //          15
        "  }", //                                                   16
        "}", //                                                     17
      ),
    );
    expect(shape.structure).not.toBeNull();
    expect(fn(shape, "removeMember")).toMatchObject({ open: 5, body: 9, end: 13 });
    expect(functionAt(shape, 12)?.name).toBe("removeMember");
    expect(fn(shape, "list")).toMatchObject({ open: 14, end: 16 });
    expect(functionAt(shape, 15)?.name).toBe("list");
    // A callback's body after `=>` is still a block, not a pattern.
    const cb = shapeOf("src/cb.ts", lines("run(items, (x) => {", "  go(x);", "});"));
    expect(cb.structure!.blocks.some((b) => b.kind === "function" && b.open === 1)).toBe(true);
  });

  // MUTATION: drop the nested-parenthesis alternative from DECORATOR_LEAD_RE
  // (stateshape.ts) — the head's name is read as `UseGuards` and this fails.
  it("a decorator whose argument is itself a call leads the head and is not its name (TS)", () => {
    const shape = shapeOf(
      "src/item.controller.ts",
      lines(
        "export class ItemController {", //                         1
        "  @UseGuards(AuthGuard('jwt')) async findOne(id: string) {", // 2
        "    return this.items.get(id);", //                        3
        "  }", //                                                   4
        "}", //                                                     5
      ),
    );
    expect(functionAt(shape, 3)?.name).toBe("findOne");
  });

  // MUTATION: return only the last segment from chainMembers — `warp`
  // and `views` are not written by the stores through them.
  it("a store through a member chain names every member on its left side", () => {
    expect(stmtKey("cfg->warp.transform.mat = m;")?.members).toEqual(["mat", "transform", "warp"]);
    expect(stmtKey("  a.views[i].scale = 2;")?.members).toEqual(["scale", "views"]);
    expect(stmtKey("  this.state = 1;")?.members).toEqual(["state"]);
    expect(stmtKey("  m_count++;")?.members).toEqual(["m_count"]);
  });

  // MUTATION: drop ATOMIC_FN_RE from receiverWrite — the C11 store names no
  // field and this fails.
  it("names the field a collection or atomic call writes", () => {
    expect(receiverWrite("sessionCache.delete(name);")).toEqual({
      field: "sessionCache",
      how: "collection",
    });
    expect(receiverWrite("this.seen.add(id);")).toEqual({ field: "seen", how: "collection" });
    expect(receiverWrite("active_.fetch_add(1);")).toEqual({ field: "active_", how: "atomic" });
    expect(
      receiverWrite("atomic_fetch_add_explicit(&config.active_conns, 1, memory_order_relaxed);"),
    ).toEqual({ field: "active_conns", how: "atomic" });
    expect(receiverWrite("this.items.get(id);")).toBeNull();
    expect(receiverWrite("settings(x);")).toBeNull();
  });

  // A timing bound, not a fence, at the cap a changed file is read to: the
  // passes are linear, so 1 MiB of the shapes they work hardest on shapes in
  // a few seconds at most; a pass gone quadratic takes minutes.
  it("a pathological 1 MiB C file shapes within a bound", () => {
    const unit = [
      "#if defined(A)",
      "static int f(struct s *a) {",
      "#else",
      "static int f(struct s *a, int b) {",
      "#endif",
      `  a->${"b->".repeat(60)}c = '\\'' + R"x(}{)x"[0];`,
      "  /* { */ if (a) { while (a) { a = a->n; } } // }",
      '  return "}" [0];',
      "}",
    ].join("\n");
    const text = `${Array.from({ length: Math.floor((1024 * 1024) / (unit.length + 1)) }, () => unit).join("\n")}\n`;
    expect(text.length).toBeGreaterThan(1000 * 1024);
    expect(text.length).toBeLessThanOrEqual(1024 * 1024);
    const started = performance.now();
    const s = shapeOf("src/hot.c", text);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(s.structure).not.toBeNull();
  });
});

describe("the token scanner state_explore reads files with", () => {
  const scan = (text: string, table: TokenTable): [number, string, number][] => {
    const out: [number, string, number][] = [];
    scanLines(text, table, (line, cut, bits) => out.push([line, cut, bits]));
    return out;
  };

  it("calls back for the lines that hold a wanted token, with the token's bits", () => {
    const table = new TokenTable();
    table.add("status", 1);
    table.add("Loading", 2, true);
    table.add("not one token", 4);
    const text = "a = 1\r\nx.status = 2\r\nisloading()\nLOADING\nstatus_code\nnot one token\n";
    expect(scan(text, table)).toEqual([
      [2, "x.status = 2", 1],
      [4, "LOADING", 2],
    ]);
    const merged = new TokenTable();
    merged.addAll(table, 8);
    expect(scan("loading status", merged)).toEqual([[1, "loading status", 8]]);
  });

  // A line is read to LINE_MAX characters and the rest is skipped, not read.
  // MUTATION: drop the skip to the next newline in scanLines — a token past
  // the cut is found and the first expectation fails.
  it("reads no token past a line's cut, and the next line still counts", () => {
    const table = new TokenTable();
    table.add("status", 1);
    const long = `${"a ".repeat(LINE_MAX)}status`;
    expect(scan(`${long}\nstatus\n`, table)).toEqual([[2, "status", 1]]);
  });

  // A timing bound, not a fence: one pass per character, each token tested
  // by its outline before a string is made.
  it("a pathological 8 MiB text scans in well under two seconds", () => {
    const table = new TokenTable();
    for (const t of ["status", "state", "loading", "pending"]) table.add(t, 1, true);
    const texts = [
      "a".repeat(8 * 1024 * 1024),
      "a\n".repeat(4 * 1024 * 1024),
      "status ".repeat(1024 * 1024),
      "_"
        .repeat(LINE_MAX - 1)
        .concat("\n")
        .repeat(16 * 1024),
    ];
    const started = performance.now();
    for (const text of texts) scanLines(text, table, () => undefined);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("every column shape stays fast on a cut pathological line", () => {
    const run = " ".repeat(LINE_MAX);
    const all = [
      run,
      `x:${run}`,
      `x:${run}{${run}type:${run}`,
      `t.${"a".repeat(LINE_MAX)}`,
      `gorm:"${"a".repeat(LINE_MAX)}`,
    ].map((l) => l.slice(0, LINE_MAX));
    const started = performance.now();
    for (const shape of COLUMN_SHAPES) for (const l of all) shape.re.test(l);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
