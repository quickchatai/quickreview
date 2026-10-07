// the archivable event kinds are a CLOSED set pinned against
// every events read site in src/ (docs/archiving.md §9.1, invariant 7).
//
// The archiver moves `ARCHIVE_EVENT_KINDS` rows older than
// `events_after_days` out of the live `events` table. A kind some code reads
// back — a fact the outcome capture, the learner or a per-PR gate re-reads, a
// register whose newest row is a once-per-X mark — must never be in that set:
// archiving it would silently change fates, cases, candidates or wakes. This
// fence parses every file under src/ with the TypeScript compiler and finds
// every events read site:
//
//   - every SQL statement (string literals, templates and their `+`
//     concatenations) that reads `FROM events` / `JOIN events`: the kinds of
//     its `kind = '…'` and `kind IN (…)` predicates, an interpolated
//     `${CONST…}` resolved to the const's strings (inside the list, inside
//     the quotes or bare); anything else built into a kind predicate is a kind
//     it cannot see;
//   - every call of a PARAMETRIC reader — a method whose own SQL takes the
//     kind as a bound parameter (`kind = ?`, or a `?` in a `kind IN (…)`
//     list: `lastEventAt`, `lastEventPayload`, `prEvents`, found by the scan
//     itself) — and `anomalyRaised`: the kind argument, a literal, an array of
//     literals or a const;
//   - every read with NO kind predicate (all kinds): a closed, acknowledged
//     list, each one bounded in a way the archive cannot reach.
//
// Every kind found must be outside the set, and a kind the fence cannot see
// (an unresolvable argument) fails it too. Mutation-verified: a read of
// `recheck_noop` added in any of these shapes fails the fence.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ARCHIVE_EVENT_KINDS } from "../src/archive/kinds.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

/** The parametric readers and which argument carries the kind. A new
 * parametric reader the scan discovers must be added here, or the fence
 * fails — it cannot vouch for callers it does not know how to read. */
const KIND_ARG: Record<string, number> = {
  lastEventAt: 0,
  lastEventPayload: 0,
  prEvents: 1,
  // Reads `kind = 'anomaly'` (a literal the SQL scan sees) and matches the
  // PAYLOAD's kind; checked anyway — it costs nothing.
  anomalyRaised: 0,
};

/** Reads of every kind — each bounded so no archived row is in its reach:
 * the newest-N tail, today's rows, the metrics tally (whose `all` window adds
 * the archived rollup back), and the archiver's own planner. */
const ALL_KINDS_READERS = new Set([
  "src/metrics.ts:readEventKinds",
  "src/state.ts:eventsOn",
  "src/state.ts:recentEvents",
  "src/archive/plan.ts:computePlan",
]);

/** The readers docs/archiving.md §9.1 names: each must exist, so a rename
 * cannot quietly take one out of the fence's view. */
const SPEC_READERS = [
  "lastEventAt",
  "lastEventPayload",
  "prEvents",
  "anomalyRaised",
  "selfRequeueSpend",
  "eventsOn",
];

interface Site {
  where: string; // file:line
  fn: string; // file:enclosing function
  via: "sql" | "call";
  kinds: string[];
  allKinds?: boolean;
  parametric?: boolean;
  unresolved?: string[];
}

interface Scan {
  sites: Site[];
  parametricReaders: Set<string>;
  methods: Set<string>;
}

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const isStringish = (
  n: ts.Node,
): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);

const isPlus = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** Unwrap `as const`, `satisfies`, parentheses. */
function unwrap(n: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n))
      n = n.expression;
    else return n;
  }
}

/** A const's strings: `const X = "a"` or `const X = ["a", "b"] as const`. */
function constStrings(init: ts.Expression): string[] | null {
  const e = unwrap(init);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isArrayLiteralExpression(e)) {
    const out: string[] = [];
    for (const el of e.elements) {
      if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) out.push(el.text);
      else return null;
    }
    return out;
  }
  return null;
}

const MARK = "\u0000";

/** The text of a string-ish node; an interpolation reads `\0<expr>\0`. */
function textOf(n: ts.Node, sf: ts.SourceFile): string {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n))
    return (
      n.head.text +
      n.templateSpans
        .map((s) => `${MARK}${s.expression.getText(sf)}${MARK}${s.literal.text}`)
        .join("")
    );
  if (isPlus(n)) return textOf(n.left, sf) + textOf(n.right, sf);
  if (ts.isParenthesizedExpression(n)) return textOf(n.expression, sf);
  return `${MARK}${n.getText(sf)}${MARK}`;
}

/** The function a node sits in: a declared function or method, or the
 * variable / property an arrow or function expression is assigned to. */
function enclosingFn(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name)
      return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent) {
      const h = p.parent;
      if (ts.isVariableDeclaration(h) && ts.isIdentifier(h.name)) return h.name.text;
      if (ts.isPropertyAssignment(h)) return h.name.getText();
    }
  }
  return "(top level)";
}

/** Parsed once per (path, text): the mutation tests re-parse only the file
 * they change. */
const parseCache = new Map<string, ts.SourceFile>();
function parse(path: string, text: string): ts.SourceFile {
  const key = `${path}\u0000${text}`;
  let sf = parseCache.get(key);
  if (!sf) {
    sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    parseCache.set(key, sf);
  }
  return sf;
}

interface FileFacts {
  consts: Map<string, string[]>;
  exported: Map<string, string[]>;
  imports: Set<string>;
  methods: Set<string>;
}
const factsCache = new WeakMap<ts.SourceFile, FileFacts>();

/** A file's string consts (and which are exported), its imported names and
 * its method names — one walk per parsed file. */
function factsOf(sf: ts.SourceFile): FileFacts {
  const have = factsCache.get(sf);
  if (have) return have;
  const facts: FileFacts = {
    consts: new Map(),
    exported: new Map(),
    imports: new Set(),
    methods: new Set(),
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = constStrings(n.initializer);
      if (v) {
        facts.consts.set(n.name.text, v);
        const stmt = n.parent?.parent;
        if (
          stmt &&
          ts.isVariableStatement(stmt) &&
          stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        )
          facts.exported.set(n.name.text, v);
      }
    }
    if (ts.isImportSpecifier(n)) facts.imports.add(n.name.text);
    if (ts.isMethodDeclaration(n) && n.name) facts.methods.add(n.name.getText());
    ts.forEachChild(n, visit);
  };
  visit(sf);
  factsCache.set(sf, facts);
  return facts;
}

/** Parse every file: its consts, its imports, its SQL sites and its calls. */
function scan(files: Array<[string, string]>): Scan {
  const parsed = files.map(([path, text]) => ({
    rel: relative(ROOT, path),
    sf: parse(path, text),
    // Only a file that names the table can hold a statement reading it (a
    // table name split across a `+` still leaves the word whole).
    sqlCandidate: /\bevents\b/.test(text),
    text,
  }));
  // Consts: per file, and the exported ones by name across src.
  const local = new Map<string, Map<string, string[]>>();
  const imported = new Map<string, Set<string>>();
  const exported = new Map<string, string[]>();
  const methods = new Set<string>();
  for (const { rel, sf } of parsed) {
    const facts = factsOf(sf);
    for (const [name, v] of facts.exported)
      exported.set(name, [...(exported.get(name) ?? []), ...v]);
    for (const m of facts.methods) methods.add(m);
    local.set(rel, facts.consts);
    imported.set(rel, facts.imports);
  }
  const resolve = (rel: string, name: string): string[] | null =>
    local.get(rel)?.get(name) ??
    (imported.get(rel)?.has(name) ? (exported.get(name) ?? null) : null);

  const sites: Site[] = [];
  const parametricReaders = new Set<string>();
  // ---- SQL read sites ---------------------------------------------------------
  for (const { rel, sf, sqlCandidate } of parsed) {
    if (!sqlCandidate) continue;
    const seen = new Set<ts.Node>();
    const visit = (n: ts.Node): void => {
      if (isStringish(n)) {
        let top: ts.Node = n;
        while (top.parent && (isPlus(top.parent) || ts.isParenthesizedExpression(top.parent)))
          top = top.parent;
        if (!seen.has(top)) {
          seen.add(top);
          const sql = textOf(top, sf);
          if (/\b(FROM|JOIN)\s+events\b/i.test(sql) && /\bSELECT\b/i.test(sql)) {
            const site: Site = {
              where: `${rel}:${sf.getLineAndCharacterOfPosition(top.getStart()).line + 1}`,
              fn: `${rel}:${enclosingFn(top)}`,
              via: "sql",
              kinds: [],
            };
            // Interpolations become `@@<i>@@` tokens, so a `kind IN (${…})`
            // body has no parentheses of its own to trip the match.
            const exprs: string[] = [];
            const flat = sql.replace(
              new RegExp(`${MARK}([^${MARK}]*)${MARK}`, "g"),
              (_m, e: string) => {
                exprs.push(e);
                return `@@${exprs.length - 1}@@`;
              },
            );
            let predicate = false;
            /** An interpolation token's const strings, or null. */
            const constOf = (token: string): string[] | null => {
              const expr = exprs[Number(/@@(\d+)@@/.exec(token)![1])]!.trim();
              const ident = /^([A-Za-z_$][\w$]*)/.exec(expr)?.[1];
              return ident ? resolve(rel, ident) : null;
            };
            /** What the code says, its interpolations put back. */
            const shown = (t: string): string =>
              t.replace(/@@(\d+)@@/g, (_m, i: string) => `\${${exprs[Number(i)]!.trim()}}`);
            const unresolved = (what: string): void => {
              (site.unresolved ??= []).push(shown(what));
            };
            for (const m of flat.matchAll(/\bkind\s*=\s*'([^']*)'/gi)) {
              predicate = true;
              const lit = m[1]!;
              if (!/@@\d+@@/.test(lit)) site.kinds.push(lit);
              // `kind = '${K}'`: only a quote holding exactly one const is
              // readable; anything else built inside the quotes is unknown.
              else if (/^@@\d+@@$/.test(lit) && constOf(lit)) site.kinds.push(...constOf(lit)!);
              else unresolved(`kind = '${lit}'`);
            }
            // `kind = ${K}` (the quotes inside the const).
            for (const m of flat.matchAll(/\bkind\s*=\s*(@@\d+@@)/gi)) {
              predicate = true;
              const v = constOf(m[1]!);
              if (v) site.kinds.push(...v.map((k) => k.replace(/^'(.*)'$/, "$1")));
              else unresolved(`kind = ${m[1]!}`);
            }
            if (/\bkind\s*=\s*\?/i.test(flat)) {
              predicate = true;
              site.parametric = true;
            }
            for (const m of flat.matchAll(/\bkind\s+IN\s*\(([^)]*)\)/gi)) {
              predicate = true;
              const body = m[1]!;
              for (const lit of body.matchAll(/'([^']*)'/g)) site.kinds.push(lit[1]!);
              // A bound parameter in the list: the kinds come from the caller.
              if (body.includes("?")) site.parametric = true;
              for (const tok of body.matchAll(/@@(\d+)@@/g)) {
                const v = constOf(tok[0]);
                if (v) site.kinds.push(...v);
                else site.parametric = true;
              }
            }
            if (!predicate) site.allKinds = true;
            if (site.parametric) parametricReaders.add(enclosingFn(top));
            sites.push(site);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // ---- calls of the parametric readers ------------------------------------------
  const readers = new Set([...parametricReaders, ...Object.keys(KIND_ARG)]);
  const callCandidate = new RegExp(`\\b(${[...readers].join("|")})\\s*\\(`);
  for (const { rel, sf, text } of parsed) {
    if (!callCandidate.test(text)) continue;
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        readers.has(n.expression.name.text)
      ) {
        const name = n.expression.name.text;
        const idx = KIND_ARG[name];
        const site: Site = {
          where: `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
          fn: `${rel}:${enclosingFn(n)}`,
          via: "call",
          kinds: [],
        };
        const unresolved: string[] = [];
        const arg = idx === undefined ? undefined : n.arguments[idx];
        if (idx === undefined) unresolved.push(`${name}(): no KIND_ARG entry`);
        else if (!arg) unresolved.push(`${name}(): no argument ${idx}`);
        else {
          const a = unwrap(arg);
          if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
            site.kinds.push(a.text);
          else if (ts.isArrayLiteralExpression(a)) {
            for (const el of a.elements) {
              const e = unwrap(el as ts.Expression);
              if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
                site.kinds.push(e.text);
              else if (ts.isIdentifier(e) && resolve(rel, e.text))
                site.kinds.push(...resolve(rel, e.text)!);
              else unresolved.push(e.getText(sf));
            }
          } else if (ts.isIdentifier(a) && resolve(rel, a.text))
            site.kinds.push(...resolve(rel, a.text)!);
          else unresolved.push(a.getText(sf));
        }
        if (unresolved.length) site.unresolved = unresolved;
        sites.push(site);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sites, parametricReaders, methods };
}

/** What the fence refuses, in words a person reads. */
function violations(s: Scan): string[] {
  const out: string[] = [];
  for (const site of s.sites) {
    for (const k of site.kinds)
      if (ARCHIVE_EVENT_KINDS.has(k))
        out.push(`${site.where} (${site.fn}) reads the archivable kind "${k}"`);
    for (const u of site.unresolved ?? [])
      out.push(`${site.where} (${site.fn}): cannot see which kind \`${u}\` reads`);
    if (site.allKinds && !ALL_KINDS_READERS.has(site.fn))
      out.push(
        `${site.where} (${site.fn}) reads events of EVERY kind — an unacknowledged reader; ` +
          "check it never needs an archived row, then add it to ALL_KINDS_READERS",
      );
    if (site.parametric && site.via === "sql" && !(site.fn.split(":")[1]! in KIND_ARG))
      out.push(
        `${site.where} (${site.fn}) takes the kind as a parameter — add it to KIND_ARG so its callers are read`,
      );
  }
  return out;
}

const REAL: Array<[string, string]> = srcFiles(SRC).map((p) => [p, readFileSync(p, "utf8")]);

/** The real sources with one file's text replaced. */
function mutated(rel: string, edit: (text: string) => string): Array<[string, string]> {
  let hit = false;
  const out = REAL.map(([p, text]): [string, string] => {
    if (relative(ROOT, p) !== rel) return [p, text];
    const next = edit(text);
    expect(next, `the mutation of ${rel} must change it`).not.toBe(text);
    hit = true;
    return [p, next];
  });
  expect(hit, `${rel} exists`).toBe(true);
  return out;
}

describe("the archivable kinds are a closed set outside every events read site", () => {
  it("the set is exactly the eight reader-less kinds of §9.1", () => {
    expect([...ARCHIVE_EVENT_KINDS].sort()).toEqual(
      [
        "base_advanced",
        "ci_completed",
        "exec_policy_violation",
        "pingpong_decision_failed",
        "reconcile_pass",
        "recheck_noop",
        "wakes_stranded",
        "webhook_event",
      ].sort(),
    );
  });

  it(
    "every events read site in src/ reads only kinds outside the set",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const s = scan(REAL);
      expect(violations(s)).toEqual([]);
      // The scan sees what it must — a fence that sees nothing passes vacuously.
      expect(s.sites.filter((x) => x.via === "sql").length).toBeGreaterThanOrEqual(20);
      const kinds = new Set(s.sites.flatMap((x) => x.kinds));
      for (const k of [
        "head_push", // lastEventAt("head_push") in daemon.ts
        "pr_closed", // eligibility + the learner's merges
        "round_self_requeued", // selfRequeueSpend's IN (…)
        "pr_transition", // metrics' METRIC_EVENT_KINDS, resolved through the const
        "pingpong_thread_resolved", // outcomes' prEvents([...]) and its "+"-joined signature SQL
        "findings_recorded",
        "memory_provision_woken", // lastEventPayload(PROVISION_WOKEN_EVENT), an imported const
        "migration_collision_comment",
        "comment_sweep",
        "overseer_heartbeat",
        "memory_incident",
        "round_memory_seeded",
      ])
        expect(kinds, k).toContain(k);
      // The parametric readers it found are the ones KIND_ARG reads.
      expect([...s.parametricReaders].sort()).toEqual([
        "lastEventAt",
        "lastEventPayload",
        "prEvents",
      ]);
      // Every reader §9.1 names exists (a rename cannot slip out of view).
      for (const m of SPEC_READERS) expect(s.methods, m).toContain(m);
      // And every acknowledged all-kinds reader is still one.
      const all = new Set(s.sites.filter((x) => x.allKinds).map((x) => x.fn));
      expect([...all].sort()).toEqual([...ALL_KINDS_READERS].sort());
    },
  );

  describe("mutation: a read of recheck_noop fails the fence, in every shape", () => {
    const fails = (files: Array<[string, string]>): string[] =>
      violations(scan(files)).filter((v) => v.includes("recheck_noop"));

    it("a parametric reader called with it (lastEventAt)", { timeout: HEAVY_TIMEOUT_MS }, () => {
      expect(
        fails(
          mutated("src/daemon.ts", (t) =>
            t.replace(
              'store.lastEventAt("head_push", e.pr)',
              'store.lastEventAt("recheck_noop", e.pr)',
            ),
          ),
        ),
      ).toHaveLength(1);
    });

    it("an array handed to prEvents", { timeout: HEAVY_TIMEOUT_MS }, () => {
      expect(
        fails(
          mutated("src/outcomes.ts", (t) =>
            t.replace(
              'this.store.prEvents(pr, ["findings_recorded"])',
              'this.store.prEvents(pr, ["findings_recorded", "recheck_noop"])',
            ),
          ),
        ),
      ).toHaveLength(1);
    });

    it("a literal `kind = '…'` in a statement", { timeout: HEAVY_TIMEOUT_MS }, () => {
      expect(
        fails(
          mutated("src/state.ts", (t) =>
            t.replace(
              "WHERE kind = 'comment_sweep' AND pr = ?",
              "WHERE kind = 'recheck_noop' AND pr = ?",
            ),
          ),
        ),
      ).toHaveLength(1);
    });

    it("a `kind IN (…)` split over a `+` concatenation", { timeout: HEAVY_TIMEOUT_MS }, () => {
      expect(
        fails(
          mutated("src/outcomes.ts", (t) =>
            t.replace(
              "'head_push','pr_closed','findings_recorded')",
              "'head_push','pr_closed','findings_recorded','recheck_noop')",
            ),
          ),
        ),
      ).toHaveLength(1);
    });

    it("a const the statement interpolates", { timeout: HEAVY_TIMEOUT_MS }, () => {
      expect(
        fails(
          mutated("src/metrics.ts", (t) =>
            t.replace(
              '"head_push", "pr_closed"] as const;',
              '"head_push", "pr_closed", "recheck_noop"] as const;',
            ),
          ),
        ),
      ).toHaveLength(1);
    });

    it("a new reader in a new file", { timeout: HEAVY_TIMEOUT_MS }, () => {
      const added: Array<[string, string]> = [
        ...REAL,
        [
          join(SRC, "mutant.ts"),
          "export const n = (db: any) => db.prepare(\"SELECT COUNT(*) FROM events WHERE kind IN ('ci_completed', 'recheck_noop')\").get();\n",
        ],
      ];
      const v = violations(scan(added));
      expect(v.filter((x) => x.includes("recheck_noop"))).toHaveLength(1);
      expect(v.filter((x) => x.includes("ci_completed"))).toHaveLength(1);
    });

    it(
      "a const interpolated inside the quotes, and one without them",
      { timeout: HEAVY_TIMEOUT_MS },
      () => {
        for (const sql of ["kind = '${K}'", "kind = ${Q}"]) {
          const added: Array<[string, string]> = [
            ...REAL,
            [
              join(SRC, "mutant.ts"),
              'const K = "recheck_noop";\nconst Q = "\'recheck_noop\'";\n' +
                `export const f = (db: any) => db.prepare(\`SELECT * FROM events WHERE ${sql}\`).all();\n`,
            ],
          ];
          expect(fails(added), sql).toHaveLength(1);
        }
      },
    );

    it("a quote the fence cannot resolve is refused", { timeout: HEAVY_TIMEOUT_MS }, () => {
      const added: Array<[string, string]> = [
        ...REAL,
        [
          join(SRC, "mutant.ts"),
          "export const f = (db: any, k: string) => db.prepare(`SELECT * FROM events WHERE kind = '${k}'`).all();\n",
        ],
      ];
      expect(violations(scan(added))).toEqual([
        expect.stringContaining("cannot see which kind `kind = '${k}'` reads"),
      ]);
    });

    it(
      "a bound-parameter `kind IN (?)` is a parametric reader the fence must be told about",
      { timeout: HEAVY_TIMEOUT_MS },
      () => {
        for (const list of ["?", "?, ?"]) {
          const added: Array<[string, string]> = [
            ...REAL,
            [
              join(SRC, "mutant.ts"),
              `export function f(db: any) { return db.prepare("SELECT * FROM events WHERE kind IN (${list})").all("ci_completed", "recheck_noop"); }\n`,
            ],
          ];
          expect(violations(scan(added)), list).toEqual([
            expect.stringContaining("src/mutant.ts:f) takes the kind as a parameter"),
          ]);
        }
      },
    );

    it("a reader of every kind that nobody acknowledged", { timeout: HEAVY_TIMEOUT_MS }, () => {
      const added: Array<[string, string]> = [
        ...REAL,
        [
          join(SRC, "mutant.ts"),
          'export function tally(db: any) { return db.prepare("SELECT kind FROM events").all(); }\n',
        ],
      ];
      expect(violations(scan(added))).toEqual([
        expect.stringContaining("src/mutant.ts:tally) reads events of EVERY kind"),
      ]);
    });

    it(
      "a kind the fence cannot see is refused, never assumed safe",
      { timeout: HEAVY_TIMEOUT_MS },
      () => {
        const added: Array<[string, string]> = [
          ...REAL,
          [
            join(SRC, "mutant.ts"),
            "export const f = (store: any, k: string) => store.lastEventAt(k, 1);\n",
          ],
        ];
        expect(violations(scan(added))).toEqual([
          expect.stringContaining("cannot see which kind `k` reads"),
        ]);
      },
    );
  });
});

describe("the archive's own fences", () => {
  it(
    "nothing in src/ runs VACUUM (§9.6) — deleted pages go to the freelist",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const hits: string[] = [];
      for (const [p, text] of REAL) {
        if (!/vacuum/i.test(text)) continue;
        const sf = parse(p, text);
        const visit = (n: ts.Node): void => {
          if (isStringish(n) && /\bVACUUM\b/i.test(textOf(n, sf))) hits.push(relative(ROOT, p));
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
      expect(hits).toEqual([]);
    },
  );

  it("no module outside src/archive/ reaches the archive databases or their primitives (§10)", () => {
    const offenders = REAL.filter(
      ([p, text]) =>
        !relative(SRC, p).startsWith("archive/") &&
        /from\s+["'][^"']*archive\/(archivedb|dbmove|seal|fsutil)\.js["']/.test(text),
    ).map(([p]) => relative(ROOT, p));
    expect(offenders).toEqual([]);
  });
});
