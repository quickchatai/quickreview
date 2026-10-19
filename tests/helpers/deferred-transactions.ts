// Static scan for better-sqlite3 transactions that are invoked DEFERRED yet
// read before they write — the shape that cannot wait in busy_timeout.
//
// `db.transaction(fn)()` is BEGIN DEFERRED. Under WAL it takes a read snapshot
// on the first read; when the first write then tries to upgrade that snapshot
// and another connection holds (or has moved past) the write lock, SQLite
// returns SQLITE_BUSY at once — the busy handler is not consulted for an
// upgrade. `.immediate()` takes the write lock up front, so the same wait
// happens inside busy_timeout, exactly like an autocommit statement.
//
// The scan is type-aware: it asks the compiler which declaration each call
// resolves to, so `Map.get` is not a read and a helper two calls away that
// does `.all()` is. A call counts as
//   - a READ  when it resolves to better-sqlite3's Statement `get`/`all`/
//             `iterate`/`pluck`;
//   - a WRITE when it resolves to Statement `run` or Database `exec`;
//   - the effects of its body when it resolves to a function or method in
//     this repo's own sources (a "known read/write helper", transitively).
// A callee the compiler could not type (an `any` receiver) is judged by name.
import { join, relative } from "node:path";
import ts from "typescript";

export type TxMode = "deferred" | "immediate" | "exclusive";

export interface TxSite {
  /** Repo-relative path. */
  file: string;
  /** `Class.method`, a function name, or `<module>`. */
  fn: string;
  line: number;
  mode: TxMode;
  /** Evidence of the reads / writes the callback performs, deduplicated. */
  reads: string[];
  writes: string[];
  /** The callback could not be resolved to a body, so nothing is proven safe. */
  unresolved: boolean;
}

/** A deferred transaction whose callback (statically) reads and writes. */
export function isFlagged(s: TxSite): boolean {
  return s.mode === "deferred" && (s.unresolved || (s.reads.length > 0 && s.writes.length > 0));
}

const READ_NAMES = new Set(["get", "all", "iterate", "pluck"]);
const WRITE_NAMES = new Set(["run", "exec"]);
const MODES = new Set<string>(["deferred", "immediate", "exclusive"]);

/** The project's own build config, as a program over `src/` and `extensions/`. */
export function programOfRepo(root: string): ts.Program {
  const cfgPath = join(root, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, incremental: false, noEmit: true },
  });
}

/** A program over one in-memory file at `<root>/<relPath>`, for planted cases.
 * It sees the repo's node_modules, so `import Database from "better-sqlite3"`
 * resolves to the real typings. */
export function programOfSource(root: string, relPath: string, text: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2023.d.ts"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const virtual = join(root, relPath);
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getCurrentDirectory = () => root;
  host.fileExists = (f) => f === virtual || fileExists.call(host, f);
  host.readFile = (f) => (f === virtual ? text : readFile.call(host, f));
  host.getSourceFile = (f, lang, onError, shouldCreate) =>
    f === virtual
      ? ts.createSourceFile(f, text, lang, true)
      : getSourceFile.call(host, f, lang, onError, shouldCreate);
  return ts.createProgram({ rootNames: [virtual], options, host });
}

interface Effects {
  reads: Set<string>;
  writes: Set<string>;
}

const emptyEffects = (): Effects => ({ reads: new Set(), writes: new Set() });

export function scanTransactions(
  program: ts.Program,
  root: string,
  include: (relPath: string) => boolean = (p) => p.startsWith("src/"),
): TxSite[] {
  const checker = program.getTypeChecker();
  const sites: TxSite[] = [];
  const memo = new Map<ts.Node, Effects>();

  const isDriverDecl = (d: ts.Node | undefined): boolean =>
    d !== undefined && d.getSourceFile().fileName.includes("/better-sqlite3/");
  const isOwnDecl = (d: ts.Node): boolean => {
    const sf = d.getSourceFile();
    return !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/");
  };

  const unwrap = (e: ts.Node): ts.Node => {
    let n = e;
    while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))
      n = n.expression;
    return n;
  };
  const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n);
  const calleeName = (call: ts.CallExpression): string | undefined => {
    const e = unwrap(call.expression);
    return ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : undefined;
  };
  const isTransactionCall = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(unwrap(n.expression)) &&
    calleeName(n) === "transaction";

  /** Bodies that run when `decl` is called. A `const tx = db.transaction(cb)`
   * runs `cb`; a `const f = () => ...` runs its arrow. */
  function bodiesOfDeclaration(decl: ts.Node): ts.Node[] {
    if (isFunctionLike(decl)) return decl.body ? [decl.body] : [];
    if (ts.isVariableDeclaration(decl) && decl.initializer)
      return bodiesOfExpression(decl.initializer);
    if (ts.isPropertyDeclaration(decl) && decl.initializer)
      return bodiesOfExpression(decl.initializer);
    return [];
  }
  /** `undefined` when the expression is not something we can follow. */
  function bodiesOfExpression(expr: ts.Node): ts.Node[] {
    const n = unwrap(expr);
    if (isFunctionLike(n)) return n.body ? [n.body] : [];
    if (ts.isIdentifier(n)) {
      const sym = checker.getSymbolAtLocation(n);
      return (sym?.declarations ?? []).flatMap(bodiesOfDeclaration);
    }
    if (isTransactionCall(n) && n.arguments[0]) return bodiesOfExpression(n.arguments[0]);
    return [];
  }

  function effectsOfBody(body: ts.Node): Effects {
    const cached = memo.get(body);
    if (cached) return cached;
    const fx = emptyEffects();
    memo.set(body, fx); // a cycle sees the partial result: enough for a ratchet
    visit(body, fx);
    return fx;
  }

  function merge(into: Effects, from: Effects, via: string): void {
    for (const r of from.reads) into.reads.add(via ? `${via}>${r}` : r);
    for (const w of from.writes) into.writes.add(via ? `${via}>${w}` : w);
  }

  function visit(node: ts.Node, fx: Effects): void {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const decl = checker.getResolvedSignature(node)?.declaration;
      if (name !== undefined) {
        const callee = unwrap(node.expression);
        if (decl === undefined || isDriverDecl(decl)) {
          // An untyped receiver is judged by name; a typed driver call exactly.
          if (ts.isPropertyAccessExpression(callee)) {
            if (READ_NAMES.has(name)) fx.reads.add(`.${name}`);
            else if (WRITE_NAMES.has(name)) fx.writes.add(`.${name}`);
          }
        }
        // A local `const tx = db.transaction(cb)` called inside: its callback runs.
        const targets: ts.Node[] = [];
        if (decl !== undefined && isOwnDecl(decl)) targets.push(decl);
        if (ts.isIdentifier(callee) && (decl === undefined || isDriverDecl(decl)))
          for (const d of checker.getSymbolAtLocation(callee)?.declarations ?? []) targets.push(d);
        for (const t of targets)
          for (const b of bodiesOfDeclaration(t)) merge(fx, effectsOfBody(b), name);
      }
    }
    ts.forEachChild(node, (c) => visit(c, fx));
  }

  /** How the transaction function is invoked, following `const tx = ...`. */
  function modeOf(call: ts.CallExpression): TxMode {
    let node: ts.Node = call;
    while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent))
      node = node.parent;
    const parent = node.parent;
    const called = (n: ts.Node): TxMode | undefined => {
      // `n` is the transaction function; how is it called?
      let cur = n;
      while (ts.isParenthesizedExpression(cur.parent)) cur = cur.parent;
      const p = cur.parent;
      if (ts.isCallExpression(p) && p.expression === cur) return "deferred";
      if (ts.isPropertyAccessExpression(p) && p.expression === cur && MODES.has(p.name.text)) {
        const g = p.parent;
        if (ts.isCallExpression(g) && g.expression === p) return p.name.text as TxMode;
      }
      return undefined;
    };
    const direct = called(node);
    if (direct) return direct;
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name)
    ) {
      const sym = checker.getSymbolAtLocation(parent.name);
      const modes: TxMode[] = [];
      let escapes = false;
      const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n !== parent.name && checker.getSymbolAtLocation(n) === sym) {
          const m = called(n);
          if (m) modes.push(m);
          else escapes = true;
        }
        ts.forEachChild(n, walk);
      };
      walk(parent.getSourceFile());
      if (escapes || modes.length === 0 || modes.includes("deferred")) return "deferred";
      return modes.includes("exclusive") && !modes.includes("immediate")
        ? "exclusive"
        : "immediate";
    }
    // Returned, stored or passed on: we cannot see the call, so assume the worst.
    return "deferred";
  }

  function nameOfEnclosing(node: ts.Node): string {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      const cls = (m: ts.Node): string | undefined => {
        const c = m.parent;
        return c && (ts.isClassDeclaration(c) || ts.isClassExpression(c))
          ? c.name?.text
          : undefined;
      };
      if (
        ts.isMethodDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n)
      )
        return [cls(n), n.name.getText()].filter(Boolean).join(".");
      if (ts.isConstructorDeclaration(n)) return [cls(n), "constructor"].filter(Boolean).join(".");
      if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
      if (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        ts.isVariableDeclaration(n.parent) &&
        ts.isIdentifier(n.parent.name)
      )
        return n.parent.name.text;
      if (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        ts.isPropertyDeclaration(n.parent)
      )
        return [cls(n.parent), n.parent.name.getText()].filter(Boolean).join(".");
    }
    return "<module>";
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const rel = relative(root, sf.fileName);
    if (!include(rel)) continue;
    const found: ts.CallExpression[] = [];
    const find = (n: ts.Node): void => {
      if (isTransactionCall(n)) {
        const d = checker.getResolvedSignature(n)?.declaration;
        if (d === undefined || isDriverDecl(d)) found.push(n);
      }
      ts.forEachChild(n, find);
    };
    find(sf);
    for (const call of found) {
      const arg = call.arguments[0];
      const bodies = arg ? bodiesOfExpression(arg) : [];
      const fx = emptyEffects();
      for (const b of bodies) merge(fx, effectsOfBody(b), "");
      sites.push({
        file: rel,
        fn: nameOfEnclosing(call),
        line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1,
        mode: modeOf(call),
        reads: [...fx.reads].sort(),
        writes: [...fx.writes].sort(),
        unresolved: bodies.length === 0,
      });
    }
  }
  return sites;
}
