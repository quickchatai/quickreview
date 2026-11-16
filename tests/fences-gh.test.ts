// No module but `qcr action install` spawns gh for a write.
//
// Every GitHub write goes through the one mutation gate (AGENTS.md invariant
// 1). `qcr action install` (src/actioncli.ts) is the named exception: the
// person's own gh, through one function, `runGh`, over a closed list that
// tests/action-install.test.ts holds (ADR 0003). This fence holds the rest of
// the source, both trees (tests/helpers/source-trees.ts), to gh reads.
//
// What it reads, by TypeScript's own parse: every place that starts gh,
//
//   (a) a call whose first argument is the program gh, with more after it:
//       the literal "gh", or a name `gh`, `ghPath` or `ghBin`
//       (`runner.run(gh, [...])`, `execFileSync("gh", [...])`; a lone
//       `which("gh")` starts nothing);
//   (b) an array literal that starts with "gh", an argv kept for later.
//
// Each place's arguments must be a literal array, and a read:
//
//   - `api` with none of -X, --method, -f, -F, --field, --raw-field, --input;
//   - `pr list`, `pr view`, `repo list`, `repo view`, `auth status`,
//     `auth token`.
//
// The one exception is src/actioncli.ts, whose one place is runGh's. The
// modules that start gh are pinned by SET EQUALITY, each with what it reads:
// a new one fails until it is named here, and one that stopped fails too.
//
// What it does not see: gh inside a shell string (`sh -c "gh …"`), or a
// program name kept under another name or built at run time. A module that
// does either is refused in review, as any write around the gate is.
//
// Verified by mutation, in this file: the scan runs on the real tree and on
// planted code that must fail.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EXTENSION_DIRS, SRC_DIRS } from "./helpers/source-trees.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

/** The modules that start gh, and what for. Only actioncli.ts writes. */
const GH_MODULES: Readonly<Record<string, string>> = {
  "src/actioncli.ts": "qcr action install: runGh, over the closed list of ADR 0003",
  "src/home/adapters.ts": "the home: the gh account, the open pull requests, one in the browser",
  "src/home/setupadapters.ts": "the home's setup: recent repositories, one repository, the account",
  "src/githubtoken.ts": "the person's token: gh auth token",
  "src/tui/deploytab.ts": "the deploy tab: the published versions",
  "packages/pi-plugin/src/ghcred.ts": "the review's GitHub credential: gh auth token",
  "packages/pi-plugin/src/plugin/setup.ts": "the plugin's setup: gh auth status",
};

/** The one module that may write, and the one function it does it in. */
const WRITER = { file: "src/actioncli.ts", fn: "runGh" };

/** An argument that is a spread: nothing can be said about what it holds. */
const SPREAD = Symbol("spread");
type Arg = string | null | typeof SPREAD;

interface GhSite {
  line: number;
  /** The arguments after the program, each a literal's text, null for any
   * other expression; null for the whole when they are not an array literal. */
  args: Arg[] | null;
  /** The function the place is in, when it is a named one. */
  fn: string | null;
}

const PROGRAM_NAMES = new Set(["gh", "ghPath", "ghBin"]);

function literal(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function argsOf(elements: readonly ts.Expression[]): Arg[] {
  return elements.map((e) => (ts.isSpreadElement(e) ? SPREAD : literal(e)));
}

function enclosingFn(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent)
    if (ts.isFunctionDeclaration(n)) return n.name?.text ?? null;
  return null;
}

/** Every place in `text` that starts gh. */
function ghSites(text: string): GhSite[] {
  const source = ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: GhSite[] = [];
  const at = (node: ts.Node, args: Arg[] | null): void => {
    sites.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      args,
      fn: enclosingFn(node),
    });
  };
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 1) {
      const first = node.arguments[0]!;
      const name = ts.isIdentifier(first)
        ? first.text
        : ts.isPropertyAccessExpression(first)
          ? first.name.text
          : null;
      if (literal(first) === "gh" || (name !== null && PROGRAM_NAMES.has(name))) {
        const second = node.arguments[1];
        at(
          node,
          second !== undefined && ts.isArrayLiteralExpression(second)
            ? argsOf(second.elements)
            : null,
        );
      }
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0) {
      if (literal(node.elements[0]!) === "gh") at(node, argsOf(node.elements.slice(1)));
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return sites;
}

const READ_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["pr", "list"],
  ["pr", "view"],
  ["repo", "list"],
  ["repo", "view"],
  ["auth", "status"],
  ["auth", "token"],
];
const API_WRITE_FLAG = /^(-X|--method|-f|-F|--field|--raw-field|--input)/;

/** Is this gh call a read? Not when its arguments cannot be read. */
function ghReads(args: Arg[] | null): boolean {
  if (args === null || args.includes(SPREAD)) return false;
  const [a, b] = args;
  if (a === "api") return args.every((x) => typeof x !== "string" || !API_WRITE_FLAG.test(x));
  return READ_VERBS.some(([x, y]) => x === a && y === b);
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

describe("gh, outside qcr action install", () => {
  // MUTATION: add `await runner.run("gh", ["pr", "merge", String(pr), "-R",
  // repo])` to src/home/adapters.ts. That place is no read, and this fails.
  // MUTATION: add `spawnSync("gh", ["api", "-X", "POST", "x"])` to a module
  // that starts no gh today. The module set changes, and this fails.
  it(
    "is started only by the modules named here, and only to read",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const found: Record<string, GhSite[]> = {};
      for (const dir of [...SRC_DIRS, ...EXTENSION_DIRS])
        for (const file of tsFiles(dir)) {
          const sites = ghSites(readFileSync(file, "utf8"));
          if (sites.length > 0) found[relative(ROOT, file)] = sites;
        }
      expect(Object.keys(found).sort()).toEqual(Object.keys(GH_MODULES).sort());
      for (const [file, sites] of Object.entries(found)) {
        if (file === WRITER.file) {
          // one door: every gh call goes through it
          expect(sites.map((s) => s.fn)).toEqual([WRITER.fn]);
          continue;
        }
        for (const s of sites)
          expect(
            ghReads(s.args),
            `${file}:${s.line} starts gh for something other than a read`,
          ).toBe(true);
      }
    },
  );

  // The scanner on planted code: each write must be seen as one.
  // MUTATION: drop -X from API_WRITE_FLAG. The POST reads as a read, and
  // this fails.
  it("sees a write, a spread and an argv it cannot read, and lets a read through", () => {
    const writes = [
      `await runner.run("gh", ["pr", "merge", String(pr), "-R", repo]);`,
      `spawnSync("gh", ["api", "-X", "POST", "repos/a/b/git/refs"]);`,
      `execFileSync('gh', ['api', 'repos/a/b/labels', '-f', 'name=x']);`,
      'const ARGV = [`gh`, "secret", "set", "K"];',
      `run(gh, ["label", "create", "x"]);`,
      `o.runner.run(o.gh, ["repo", "delete", "a/b"]);`,
      `run(ghPath, ["api", "--method", "DELETE", "x"]);`,
      `run("gh", args);`,
      `run("gh", ["api", ...extra]);`,
      `run("gh", ["pr", view]);`,
    ];
    for (const code of writes) {
      const sites = ghSites(code);
      expect(sites, code).toHaveLength(1);
      expect(ghReads(sites[0]!.args), code).toBe(false);
    }
    const reads = [
      `run("gh", ["api", "user", "--jq", ".login"]);`,
      `run("gh", ["pr", "list", "-R", repo, "--json", FIELDS]);`,
      `const A = ["gh", "api", "--paginate", \`orgs/\${org}/packages\`];`,
      `execFileSync("gh", ["auth", "token"], { encoding: "utf8" });`,
    ];
    for (const code of reads) {
      const sites = ghSites(code);
      expect(sites, code).toHaveLength(1);
      expect(ghReads(sites[0]!.args), code).toBe(true);
    }
    // a name, not a start: nothing to read
    for (const code of [
      `which("gh");`,
      `if (prog === "gh") return;`,
      `const ALLOWED = ["git", "gh"];`,
      `// run("gh", ["pr", "merge"])`,
      `const s = "run('gh', ['pr', 'merge'])";`,
    ])
      expect(ghSites(code), code).toEqual([]);
  });
});
