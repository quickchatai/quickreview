// The provenance fence: code comments state what IS, never who decided it,
// when, or under which ticket. Ticket ids, owner attributions with a date and
// ruling references rot in place — git history carries provenance, the comment
// carries the rule.
//
// What is read: COMMENTS ONLY, in the tracked source tree (`git ls-files`, as
// tests/publishability.test.ts lists it) under src/, extensions/ (not the
// vendored fork), scripts/, deploy/, docker/, tests/ (not fixtures) and the
// bench's code files. TS/JS comments come from the TypeScript scanner with
// trivia, so a string or template literal is never read as a comment. Shell,
// Python, YAML, TOML, Dockerfile and j2 comments are `#` comments outside
// quotes, shebangs and heredoc bodies excluded; a Python docstring counts as a
// comment, any other triple-quoted string is data.
//
// A legitimate hit — a format example, an id another fence locates by text, a
// real file path — goes in ALLOWLIST with its file, its exact matched text and
// the reason. An entry whose file no longer carries that text fails as stale.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PROVENANCE_PATTERNS: readonly RegExp[] = [
  /\bFT-\d{4}\b/g,
  /\bOwnerName\b/gi,
  /\bowner\b[^\n]{0,20}\b20\d{2}-\d{2}-\d{2}\b/gi,
  /\(\s*(?:the owner|the owner)[^)]*20\d{2}/gi,
  /\bruling R\d+\b/gi,
  /\bratified (?:in-session|by)\b/gi,
];

interface AllowEntry {
  file: string;
  token: string;
  reason: string;
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "src/memory/eventtags.ts",
    token: "FT-9999",
    reason: "a format example: the `filed=` tag a quoted comment must not be able to mint",
  },
  {
    file: "src/tui/autofile.ts",
    token: "FT-9999",
    reason: "a format example: the `filed=` tag prose may quote without minting one",
  },
  {
    file: "src/tui/issuesink.ts",
    token: "FT-0123",
    reason: "a format example of the tracker handle a filing returns",
  },
  {
    file: "src/severity.ts",
    token: "FT-0113",
    reason: "tests/fences.test.ts locates the directive-provenance paragraph by this id",
  },
  {
    file: "src/severity.ts",
    token: "FT-0256",
    reason: "tests/fences.test.ts asserts this id in the directive-provenance paragraph",
  },
  {
    file: "src/wire.ts",
    token: "owner_legacy",
    reason: "the legacy file name owner-legacy.log, which still exists on disk",
  },
  {
    file: "tests/legacy-acceptance.test.ts",
    token: "owner_legacy",
    reason: 'the retired wire spellings (tier "owner_legacy", flag-owner-legacy) the folds accept',
  },
  {
    file: "tests/slack-appendix-schemas.test.ts",
    token: "owner_legacy",
    reason:
      'the retired wire spellings (tier "owner_legacy", flag-owner-legacy) the appendix must not advertise',
  },
  {
    file: "bench/aacr/export_runs.py",
    token: "owner_legacy",
    reason: "the export scrubber's docstring names the strings it replaces",
  },
  {
    file: "bench/aacr/export_runs.py",
    token: "the owner",
    reason: "the export scrubber's docstring names the strings it replaces",
  },
];

// ---------------------------------------------------------------------------
// Which files, in which comment grammar.
// ---------------------------------------------------------------------------

type Grammar = "ts" | "hash" | "python";

const TS_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const HASH_EXT = /\.(?:sh|bash|ya?ml|toml|j2)$/;

function inScope(path: string): boolean {
  if (path.startsWith("extensions/vendor/")) return false;
  if (path.startsWith("tests/fixtures/")) return false;
  if (path.startsWith("bench/")) return /\.(?:py|sh|ts|mjs)$/.test(path);
  return ["src/", "extensions/", "scripts/", "deploy/", "docker/", "tests/"].some((d) =>
    path.startsWith(d),
  );
}

function grammarOf(path: string, text: string): Grammar | null {
  if (TS_EXT.test(path)) return "ts";
  if (path.endsWith(".py")) return "python";
  if (HASH_EXT.test(path)) return "hash";
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^Dockerfile/.test(base)) return "hash";
  if (!base.includes(".")) {
    const first = text.slice(0, text.indexOf("\n"));
    if (/^#!.*\bpython/.test(first)) return "python";
    if (/^#!.*\b(?:ba|z)?sh\b/.test(first)) return "hash";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comment extraction. Every comment is returned with the 1-based line it
// starts on; a multi-line comment keeps its newlines so a hit's own line is
// recoverable.
// ---------------------------------------------------------------------------

interface Comment {
  line: number;
  text: string;
}

function tsComments(path: string, text: string): Comment[] {
  const variant = /\.(?:tsx|jsx)$/.test(path)
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, text);
  const out: Comment[] = [];
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  // The scanner alone cannot tell `/` (divide) from a regex, nor resume a
  // template after `}` — so re-scan in those two places the way the parser
  // would: a `/` after something that cannot end an expression is a regex,
  // and a `}` that closes a template substitution continues the template.
  let prev: ts.SyntaxKind = ts.SyntaxKind.Unknown;
  const templateDepth: number[] = [];
  let braceDepth = 0;
  for (;;) {
    let kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (
      (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) &&
      !endsExpression(prev)
    ) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === ts.SyntaxKind.OpenBraceToken) braceDepth++;
    if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braceDepth) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) templateDepth.pop();
      } else {
        braceDepth--;
      }
    }
    if (kind === ts.SyntaxKind.TemplateHead) templateDepth.push(braceDepth);
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenStart();
      out.push({ line: lineOf(start), text: scanner.getTokenText() });
      continue;
    }
    if (
      kind === ts.SyntaxKind.WhitespaceTrivia ||
      kind === ts.SyntaxKind.NewLineTrivia ||
      kind === ts.SyntaxKind.ShebangTrivia
    ) {
      continue;
    }
    prev = kind;
  }
  return out;
}

function endsExpression(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.PrivateIdentifier:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.CloseParenToken:
    case ts.SyntaxKind.CloseBracketToken:
    case ts.SyntaxKind.CloseBraceToken:
    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.SuperKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.ExclamationToken:
      return true;
    default:
      return false;
  }
}

/** The `#` comment on one line, if any: a `#` at the start or after
 * whitespace, outside single or double quotes. */
function hashCommentOn(line: string): string | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(i);
  }
  return null;
}

const HEREDOC = /(?<!<)<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

function hashComments(text: string): Comment[] {
  const lines = text.split("\n");
  const out: Comment[] = [];
  const pending: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (pending.length > 0) {
      // Inside a heredoc body: data, not comments.
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    if (i === 0 && line.startsWith("#!")) continue;
    const comment = hashCommentOn(line);
    if (comment !== null) out.push({ line: i + 1, text: comment });
    const code = comment === null ? line : line.slice(0, line.length - comment.length);
    for (const m of code.matchAll(HEREDOC)) pending.push(m[2]!);
  }
  return out;
}

const TRIPLE = /^[rRbBuUfF]{0,2}("""|''')/;

function pythonComments(text: string): Comment[] {
  const lines = text.split("\n");
  const out: Comment[] = [];
  // The last code line seen, to recognise a docstring: the first statement
  // of the module, or the statement after a `def`/`class` header's colon.
  let lastCode: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 && line.startsWith("#!")) continue;
    const trimmed = line.trim();
    const triple = TRIPLE.exec(trimmed);
    if (triple) {
      const delim = triple[1]!;
      const isDoc = lastCode === null || /^(?:async\s+def|def|class)\b[\s\S]*:\s*$/.test(lastCode);
      const startLine = i;
      const body: string[] = [trimmed];
      let rest = trimmed.slice(triple[0].length);
      while (!rest.includes(delim) && i + 1 < lines.length) {
        i++;
        body.push(lines[i]!);
        rest = lines[i]!;
      }
      if (isDoc) out.push({ line: startLine + 1, text: body.join("\n") });
      lastCode = "<string>";
      continue;
    }
    const comment = hashCommentOn(line);
    if (comment !== null) out.push({ line: i + 1, text: comment });
    const code = (comment === null ? line : line.slice(0, line.length - comment.length)).trim();
    if (code.length > 0) {
      // A multi-line `def f(\n a,\n):` header: join its continuation lines.
      lastCode = lastCode !== null && /[(,[]\s*$/.test(lastCode) ? `${lastCode} ${code}` : code;
      // A triple-quoted string that is not a statement start (an argument, an
      // assignment) is data; skip it whole so its lines are not read as code.
      const embedded = /("""|''')/.exec(code);
      if (embedded && code.split(embedded[1]!).length === 2) {
        const delim = embedded[1]!;
        while (i + 1 < lines.length) {
          i++;
          if (lines[i]!.includes(delim)) break;
        }
      }
    }
  }
  return out;
}

export function commentsOf(path: string, text: string): Comment[] {
  const g = grammarOf(path, text);
  if (g === "ts") return tsComments(path, text);
  if (g === "python") return pythonComments(text);
  if (g === "hash") return hashComments(text);
  return [];
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

interface Hit {
  file: string;
  line: number;
  match: string;
}

export function provenanceHits(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const c of commentsOf(file, text)) {
    for (const re of PROVENANCE_PATTERNS) {
      for (const m of c.text.matchAll(re)) {
        const line = c.line + (c.text.slice(0, m.index).match(/\n/g)?.length ?? 0);
        hits.push({ file, line, match: m[0] });
      }
    }
  }
  return hits;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((p) => p.length > 0);
}

const allowed = (h: Hit): boolean =>
  ALLOWLIST.some((a) => a.file === h.file && a.token === h.match);

const ADVICE = "state the rule, not who decided it or which ticket; git history carries provenance";

describe("no decision provenance in code comments", () => {
  const files = trackedFiles().filter(inScope);
  const hitsByFile = new Map<string, Hit[]>();
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, f), "utf8");
    } catch {
      continue; // tracked but deleted in the working tree
    }
    const hits = provenanceHits(f, text);
    if (hits.length > 0) hitsByFile.set(f, hits);
  }

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("no comment names a ticket, an owner with a date, or a ruling", () => {
    const bad = [...hitsByFile.values()].flat().filter((h) => !allowed(h));
    const report = bad.map((h) => `${h.file}:${h.line}: ${JSON.stringify(h.match)}`).join("\n");
    expect(bad, `${report}\n— ${ADVICE}`).toEqual([]);
  });

  it("every allowlist entry is real, reasoned, unique, and still needed", () => {
    const seen = new Set<string>();
    for (const a of ALLOWLIST) {
      const key = `${a.file}\0${a.token}`;
      expect(seen.has(key), `duplicate allowlist entry ${a.file} ${a.token}`).toBe(false);
      seen.add(key);
      expect(a.reason.trim().length, `${a.file}: reason required`).toBeGreaterThan(10);
      const hits = hitsByFile.get(a.file) ?? [];
      expect(
        hits.some((h) => h.match === a.token),
        `stale allowlist entry: ${a.file} no longer carries ${JSON.stringify(a.token)} in a comment — remove it`,
      ).toBe(true);
    }
  });
});

describe("the extractor reads comments and only comments", () => {
  it("TS: line and block comments bite; strings, templates and regexes do not", () => {
    const src = [
      'const a = "FT-0001 the owner";',
      "const b = `x ${y /* FT-0002 */} FT-0003 ${`FT-0004`}`;",
      "const r = /FT-0005/g; // ruling R7",
      "/* the owner, 2026-08-19 (the owner, 2026) */",
      "const c = a / b; // ratified by someone",
    ].join("\n");
    const hits = provenanceHits("src/x.ts", src);
    expect(hits.map((h) => [h.line, h.match])).toEqual([
      [2, "FT-0002"],
      [3, "ruling R7"],
      [4, "the owner"],
      [4, "owner, 2026-08-19"],
      [4, "(the owner, 2026"],
      [5, "ratified by"],
    ]);
  });

  it("shell: comments bite; shebang, quoted text and heredoc bodies do not", () => {
    const src = [
      "#!/usr/bin/env bash  FT-0009",
      'echo "# FT-0010"',
      "x=1 # FT-0011",
      "cat <<'EOF'",
      "# FT-0012",
      "EOF",
      "# the owner",
      "n=${#arr[@]}",
    ].join("\n");
    expect(provenanceHits("scripts/x.sh", src).map((h) => [h.line, h.match])).toEqual([
      [3, "FT-0011"],
      [7, "the owner"],
    ]);
  });

  it("python: docstrings and comments bite; other strings do not", () => {
    const src = [
      '"""Module FT-0020."""',
      "def f():",
      '    """FT-0021',
      '    more"""',
      '    x = """FT-0022',
      '    """',
      '    return "# FT-0023"  # FT-0024',
    ].join("\n");
    expect(provenanceHits("bench/x.py", src).map((h) => [h.line, h.match])).toEqual([
      [1, "FT-0020"],
      [3, "FT-0021"],
      [7, "FT-0024"],
    ]);
  });
});
