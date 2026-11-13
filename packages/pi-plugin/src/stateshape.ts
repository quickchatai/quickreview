// The structure of one source file, read without a parser: which lines are
// code, comment, or a C preprocessor directive; the block depth of every line;
// the blocks themselves (function, control, other) with their extent; the
// exits of a function; the statement a line holds, as a comparable key.
//
// Text in, structure out. Pure: no I/O, no clock.
//
// Two passes, each linear in the file. The lexer walks the text once and
// writes a code view of the same length: comments become blanks, the
// contents of strings, char literals, template literals (with `${}`
// nesting), Python triple-quoted strings, Go raw strings, C++ raw strings and
// JS regex literals become `\x01`, and their delimiters stay. A C `#` line is
// kept as its own line kind (`pp`), never dropped as a comment: its braces do
// not count, and `#if`/`#else`/`#endif` restore the block stack so the two
// sides of a conditional cannot both open a brace. The structure pass then
// counts braces over the code view (brace family) or indentation over its
// logical lines (Python).
//
// Honest unknown. A file whose braces do not balance, whose string or
// comment does not close, whose Python dedent matches no open block, or whose
// depth passes the cap has no structure (`structure: null`) and says why
// (`unknown`): a JS regex literal or JSX text that throws the count off ends
// here, never in a guessed extent. The code view is still served, so a name
// search can tell code from comments in such a file.
//
// Linear. Every regex reads one line cut to `LINE_MAX`; the head of a block
// is cut before it is classified; lookaheads are bounded by the line.

import { LINE_MAX } from "./statetriggers.js";

export type Dialect = "c" | "js" | "go" | "jvm" | "cs" | "rust" | "swift" | "dart" | "php" | "py";

const DIALECT_BY_EXT: Readonly<Record<string, Dialect>> = {
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  hxx: "c",
  m: "c",
  mm: "c",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  go: "go",
  java: "jvm",
  kt: "jvm",
  kts: "jvm",
  scala: "jvm",
  cs: "cs",
  rs: "rust",
  swift: "swift",
  dart: "dart",
  php: "php",
  py: "py",
  pyi: "py",
};

/** The dialect a path's extension names, or null for any other file. */
export function dialectOf(path: string): Dialect | null {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) return null;
  return DIALECT_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Brace family or indentation family. */
export function familyOf(d: Dialect): "brace" | "indent" {
  return d === "py" ? "indent" : "brace";
}

/** The largest block nesting a structure is built for. */
export const SHAPE_MAX_DEPTH = 200;
/** The characters of a block head kept for classifying it. */
const HEAD_MAX = 600;

/** What the structure cannot see, said once in any output that rests on it. */
export const SHAPE_LIMITS =
  "lexical structure, no parser: names are not bound, calls are not followed, macros and the preprocessor's other branches are not expanded, and implicit exits (RAII destructors, an exception from a call, a macro such as RETURN_IF_ERROR, a callback's own flow) are not seen";

export type LineKind = "code" | "blank" | "comment" | "pp";

export interface ShapeLine {
  /** 1-based line number. */
  n: number;
  /** The line as written, cut to `LINE_MAX`, no carriage return. */
  raw: string;
  /** The code view of `raw`, same length: comments blank, literal contents `\x01`. */
  code: string;
  kind: LineKind;
  /** Open blocks at the line's start. */
  depth: number;
  /** The line continues a statement begun above (open bracket, a leading
   * `.`, a trailing operator, a backslash, or a string still open). */
  cont: boolean;
}

export type BlockKind = "function" | "control" | "other";

export interface Block {
  id: number;
  kind: BlockKind;
  /** The first word of a control head (`if`, `else if`, `for`, `case`,
   * `catch`, `try`, `finally`, `except`, `with`, …); `function` for a
   * function; `class`, `struct`, … or `` for other blocks. */
  keyword: string;
  /** A function's name, or `<anonymous>` / `<callback of f>`. */
  name?: string;
  /** The line the head starts on. */
  open: number;
  /** The line holding the block's `{` (or Python's `:`). */
  body: number;
  /** The line of the closing `}` (or the last line of a Python block). */
  end: number;
  /** The head's code, trimmed and cut. */
  head: string;
  /** Parent block id, or -1 at file level. */
  parent: number;
}

export interface Structure {
  blocks: Block[];
  /** Innermost block id at each line's start (index n-1), -1 at file level. */
  lineBlock: Int32Array;
}

export interface Shape {
  path: string;
  dialect: Dialect | null;
  lines: ShapeLine[];
  structure: Structure | null;
  /** Why `structure` is null. */
  unknown?: string;
  /** What the structure chose where the text left a choice. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Lexer

interface LexRules {
  slash: boolean;
  hash: boolean;
  pp: boolean;
  template: boolean;
  goRaw: boolean;
  /** Quote characters that open a triple-quoted string. */
  triple: string;
  single: "string" | "char" | "none";
  /** A plain string may span lines. */
  multiline: boolean;
  regex: boolean;
  cppRaw: boolean;
  verbatim: boolean;
  rustRaw: boolean;
}

const BASE: LexRules = {
  slash: true,
  hash: false,
  pp: false,
  template: false,
  goRaw: false,
  triple: "",
  single: "char",
  multiline: false,
  regex: false,
  cppRaw: false,
  verbatim: false,
  rustRaw: false,
};

const RULES: Readonly<Record<Dialect, LexRules>> = {
  c: { ...BASE, pp: true, cppRaw: true },
  js: { ...BASE, template: true, single: "string", regex: true },
  go: { ...BASE, goRaw: true },
  jvm: { ...BASE, triple: '"' },
  cs: { ...BASE, triple: '"', verbatim: true },
  rust: { ...BASE, multiline: true, rustRaw: true },
  swift: { ...BASE, triple: '"', single: "none" },
  dart: { ...BASE, triple: "\"'", single: "string" },
  php: { ...BASE, hash: true, single: "string", multiline: true },
  py: { ...BASE, slash: false, hash: true, triple: "\"'", single: "string" },
};

const NL = 10;
const BLANK = 32;
const LIT = 1;

function isWord(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
  );
}
function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 11 || c === 12;
}

/** Words after which a JS `/` opens a regex literal, not a division. */
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
]);
/** Characters after which a JS `/` opens a regex literal. */
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split("").map((c) => c.charCodeAt(0)));

interface Lexed {
  code: string;
  /** Per line (index n-1): a `#` directive line (C). */
  pp: boolean[];
  /** Per line: the line started inside a string, comment or template. */
  inLiteral: boolean[];
  /** Per line: the line holds a comment. */
  comment: boolean[];
  /** Why the text could not be lexed whole, if it could not. */
  unknown?: string;
}

function lex(text: string, rules: LexRules): Lexed {
  const n = text.length;
  const out = new Uint16Array(n);
  const pp: boolean[] = [];
  const inLiteral: boolean[] = [];
  const comment: boolean[] = [];
  let unknown: string | undefined;
  // Modes: 0 code, 1 line comment, 2 block comment, 3 string, 4 triple,
  // 5 template, 6 Go raw, 7 delimited raw (C++ / Rust), 8 C# verbatim.
  let mode = 0;
  let quote = 0;
  let closer = "";
  const tpl: number[] = [];
  let line = 0;
  let lineStart = true;
  let ppLine = false;
  let ppCont = false;
  let lineComment = false;
  let prevSig = -1; // index of the last non-blank code character
  let regexOff = -1; // a line where a regex look already failed
  inLiteral.push(false);

  const newline = (i: number): void => {
    out[i] = NL;
    pp[line] = ppLine;
    comment[line] = lineComment;
    line++;
    // A directive ending in a backslash continues on the next line.
    let k = i - 1;
    if (k >= 0 && text.charCodeAt(k) === 13) k--;
    ppCont = ppLine && k >= 0 && text.charCodeAt(k) === 92;
    ppLine = ppCont;
    lineStart = true;
    lineComment = false;
    inLiteral.push(mode !== 0 && mode !== 1);
  };
  /** Blank `[from, to)` as literal content, newlines kept. */
  const literal = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (text.charCodeAt(k) === NL) newline(k);
      else out[k] = LIT;
    }
  };

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === NL) {
      if (mode === 1) mode = 0;
      if (mode === 3 && !rules.multiline) mode = 0; // an unclosed quote ends at the line
      newline(i);
      continue;
    }
    switch (mode) {
      case 1:
        out[i] = BLANK;
        continue;
      case 2:
        if (c === 42 && text.charCodeAt(i + 1) === 47) {
          out[i] = BLANK;
          out[i + 1] = BLANK;
          i++;
          mode = 0;
        } else out[i] = BLANK;
        continue;
      case 3:
        if (c === 92) {
          out[i] = LIT;
          if (i + 1 < n) {
            if (text.charCodeAt(i + 1) === NL) newline(i + 1);
            else out[i + 1] = LIT;
            i++;
          }
        } else if (c === quote) {
          out[i] = c;
          mode = 0;
        } else out[i] = LIT;
        continue;
      case 4:
        if (c === 92) {
          out[i] = LIT;
          if (i + 1 < n) {
            if (text.charCodeAt(i + 1) === NL) newline(i + 1);
            else out[i + 1] = LIT;
            i++;
          }
        } else if (
          c === quote &&
          text.charCodeAt(i + 1) === quote &&
          text.charCodeAt(i + 2) === quote
        ) {
          out[i] = c;
          out[i + 1] = c;
          out[i + 2] = c;
          i += 2;
          mode = 0;
        } else out[i] = LIT;
        continue;
      case 5:
        if (c === 92) {
          out[i] = LIT;
          if (i + 1 < n) {
            if (text.charCodeAt(i + 1) === NL) newline(i + 1);
            else out[i + 1] = LIT;
            i++;
          }
        } else if (c === 96) {
          out[i] = c;
          mode = 0;
        } else if (c === 36 && text.charCodeAt(i + 1) === 123) {
          out[i] = LIT;
          out[i + 1] = LIT;
          i++;
          tpl.push(0);
          mode = 0;
        } else out[i] = LIT;
        continue;
      case 6:
        if (c === 96) {
          out[i] = c;
          mode = 0;
        } else out[i] = LIT;
        continue;
      case 7: {
        // Delimited raw string: jump to its closer.
        const end = text.indexOf(closer, i);
        if (end < 0) {
          literal(i, n);
          i = n;
          continue;
        }
        literal(i, end);
        for (let k = 0; k < closer.length; k++) out[end + k] = text.charCodeAt(end + k);
        i = end + closer.length - 1;
        mode = 0;
        continue;
      }
      case 8:
        if (c === 34) {
          if (text.charCodeAt(i + 1) === 34) {
            out[i] = LIT;
            out[i + 1] = LIT;
            i++;
          } else {
            out[i] = c;
            mode = 0;
          }
        } else out[i] = LIT;
        continue;
      default:
        break;
    }

    // Code.
    if (isSpace(c)) {
      out[i] = c === 13 ? BLANK : c;
      continue;
    }
    const first = lineStart;
    lineStart = false;
    if (rules.pp && first && c === 35) ppLine = true;
    if (rules.slash && c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) {
        out[i] = BLANK;
        mode = 1;
        lineComment = true;
        continue;
      }
      if (d === 42) {
        out[i] = BLANK;
        out[i + 1] = BLANK;
        i++;
        mode = 2;
        lineComment = true;
        continue;
      }
    }
    if (rules.hash && c === 35 && text.charCodeAt(i + 1) !== 91) {
      out[i] = BLANK;
      mode = 1;
      lineComment = true;
      continue;
    }
    if (tpl.length > 0) {
      const top = tpl.length - 1;
      if (c === 123) tpl[top] = (tpl[top] ?? 0) + 1;
      else if (c === 125) {
        if (tpl[top] === 0) {
          tpl.pop();
          out[i] = LIT;
          mode = 5;
          continue;
        }
        tpl[top] = (tpl[top] ?? 1) - 1;
      }
    }
    if (c === 34 || (c === 39 && rules.single === "string")) {
      if (
        rules.triple.includes(String.fromCharCode(c)) &&
        text.charCodeAt(i + 1) === c &&
        text.charCodeAt(i + 2) === c
      ) {
        out[i] = c;
        out[i + 1] = c;
        out[i + 2] = c;
        i += 2;
        mode = 4;
        quote = c;
        prevSig = i;
        continue;
      }
      if (c === 34) {
        const p = i > 0 ? text.charCodeAt(i - 1) : 0;
        const pp2 = i > 1 ? text.charCodeAt(i - 2) : 0;
        // C++ R"delim( … )delim"
        if (
          rules.cppRaw &&
          p === 82 &&
          !(isWord(pp2) && pp2 !== 56 && pp2 !== 76 && pp2 !== 117 && pp2 !== 85)
        ) {
          let open = -1;
          for (let k = i + 1; k < Math.min(n, i + 18); k++)
            if (text.charCodeAt(k) === 40) {
              open = k;
              break;
            }
          const delim = open < 0 ? "" : text.slice(i + 1, open);
          if (open >= 0 && !/[\s\\)"]/.test(delim)) {
            out[i] = c;
            for (let k = i + 1; k <= open; k++) out[k] = LIT;
            closer = `)${delim}"`;
            i = open;
            mode = 7;
            prevSig = i;
            continue;
          }
        }
        // Rust r"…" / r#"…"#
        if (rules.rustRaw && (p === 114 || p === 35)) {
          let k = i - 1;
          let hashes = 0;
          while (k >= 0 && text.charCodeAt(k) === 35 && hashes < 64) {
            hashes++;
            k--;
          }
          if (k >= 0 && text.charCodeAt(k) === 114 && !(k > 0 && isWord(text.charCodeAt(k - 1)))) {
            out[i] = c;
            closer = `"${"#".repeat(hashes)}`;
            mode = 7;
            prevSig = i;
            continue;
          }
        }
        // C# @"…"
        if (rules.verbatim && (p === 64 || (p === 36 && pp2 === 64))) {
          out[i] = c;
          mode = 8;
          prevSig = i;
          continue;
        }
      }
      out[i] = c;
      mode = 3;
      quote = c;
      prevSig = i;
      continue;
    }
    if (c === 39 && rules.single === "char") {
      // A char literal `'x'` or `'\…'`; anything else (a Rust lifetime, a
      // C++14 digit separator) is not a quote.
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0;
      if (!(prev >= 48 && prev <= 57 && rules.cppRaw)) {
        let end = -1;
        if (text.charCodeAt(i + 1) === 92) {
          for (let k = i + 2; k < Math.min(n, i + 14); k++) {
            const d = text.charCodeAt(k);
            if (d === NL) break;
            if (d === 39) {
              end = k;
              break;
            }
          }
        } else if (text.charCodeAt(i + 2) === 39 && text.charCodeAt(i + 1) !== NL) end = i + 2;
        if (end > 0) {
          out[i] = c;
          for (let k = i + 1; k < end; k++) out[k] = LIT;
          out[end] = c;
          i = end;
          prevSig = i;
          continue;
        }
      }
      out[i] = c;
      prevSig = i;
      continue;
    }
    if (c === 96 && (rules.template || rules.goRaw)) {
      out[i] = c;
      mode = rules.template ? 5 : 6;
      prevSig = i;
      continue;
    }
    if (c === 47 && rules.regex && regexOff !== line && regexStarts(text, out, prevSig)) {
      // A regex literal: its end on this line, past escapes and classes.
      let end = -1;
      let inClass = false;
      for (let k = i + 1; k < Math.min(n, i + LINE_MAX); k++) {
        const d = text.charCodeAt(k);
        if (d === NL) break;
        if (d === 92) {
          k++;
          continue;
        }
        if (d === 91) inClass = true;
        else if (d === 93) inClass = false;
        else if (d === 47 && !inClass) {
          end = k;
          break;
        }
      }
      if (end > 0) {
        out[i] = c;
        for (let k = i + 1; k < end; k++) out[k] = LIT;
        out[end] = c;
        i = end;
        prevSig = i;
        continue;
      }
      // One failed look per line keeps the pass linear.
      regexOff = line;
    }
    out[i] = c;
    prevSig = i;
  }
  pp[line] = ppLine;
  comment[line] = lineComment;
  if (mode === 2) unknown = "a block comment does not close";
  else if (mode === 3 && rules.multiline) unknown = "a string does not close";
  else if (mode >= 4) unknown = "a string or template literal does not close";
  else if (tpl.length > 0) unknown = "a template literal's `${` does not close";

  let code = "";
  for (let i = 0; i < n; i += 8192)
    code += String.fromCharCode.apply(null, Array.from(out.subarray(i, Math.min(n, i + 8192))));
  return { code, pp, inLiteral, comment, ...(unknown !== undefined ? { unknown } : {}) };
}

/** Whether a JS `/` at this point opens a regex literal: the last code
 * character is an operator or opener, or ends one of the keywords. */
function regexStarts(text: string, out: Uint16Array, prevSig: number): boolean {
  if (prevSig < 0) return true;
  const p = out[prevSig]!;
  if (REGEX_AFTER.has(p)) return true;
  if (!isWord(p)) return false;
  let k = prevSig;
  while (k >= 0 && prevSig - k < 12 && isWord(out[k]!)) k--;
  return REGEX_AFTER_WORDS.has(text.slice(k + 1, prevSig + 1));
}

// ---------------------------------------------------------------------------
// Lines

function cut(s: string): string {
  const c = s.length > LINE_MAX ? s.slice(0, LINE_MAX) : s;
  return c.endsWith("\r") ? c.slice(0, -1) : c;
}

const BLANK_LINE_RE = /^\s*$/;
const LEADING_RE = /^\s*/;

// ---------------------------------------------------------------------------
// Heads

/** Control heads: the block they open is a branch, a loop or a handler. */
const CONTROL_WORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "try",
  "catch",
  "finally",
  "case",
  "default",
  "select",
  "loop",
  "match",
  "unsafe",
  "guard",
  "when",
  "with",
  "synchronized",
  "using",
  "lock",
  "foreach",
  "repeat",
  "defer",
  "except",
  "elif",
  "checked",
  "fixed",
]);
/** Words before `(` that are not a function's name. */
const NOT_NAME = new Set([
  ...CONTROL_WORDS,
  "sizeof",
  "return",
  "typeof",
  "new",
  "throw",
  "await",
  "yield",
  "delete",
  "alignof",
  "decltype",
  "static_assert",
  "assert",
  "function",
  "func",
  "fn",
  "fun",
  "def",
]);
/** Words that open a block that is neither a function nor a branch. */
const OTHER_WORDS = new Set([
  "class",
  "struct",
  "interface",
  "enum",
  "namespace",
  "impl",
  "trait",
  "object",
  "union",
  "extern",
  "module",
  "type",
  "record",
  "extension",
  "protocol",
  "package",
  "mod",
]);
const FUNCTION_WORD: Readonly<Record<Dialect, readonly string[]>> = {
  c: [],
  js: ["function"],
  go: ["func"],
  jvm: ["fun", "def"],
  cs: [],
  rust: ["fn"],
  swift: ["func"],
  dart: [],
  php: ["function"],
  py: ["def"],
};

const WORDS_RE = /[A-Za-z_$][\w$]{0,80}/g;
const FIRST_WORD_RE = /^[}\s]*(?:else\s+if|[A-Za-z_$][\w$]{0,80})/;
const GO_FUNC_NAME_RE = /^func\s{0,8}(?:\([^()]{0,160}\)\s{0,8})?([A-Za-z_]\w{0,80})/;
const ASSIGNED_NAME_RE =
  /([A-Za-z_$][\w$]{0,80})\s{0,8}(?::[^=:]{0,80})?[:=]\s{0,8}(?:async\b\s{0,8})?(?:function\b|\(|[A-Za-z_$][\w$]{0,80}\s{0,8}=>)/;
const KEYWORD_NAME_RE = /\b(?:function\*?|func|fn|fun|def)\s{1,8}\*?\s{0,8}([A-Za-z_$][\w$]{0,80})/;

function firstWord(head: string): string {
  const m = FIRST_WORD_RE.exec(head);
  if (!m) return "";
  return m[0].replace(/^[}\s]*/, "").replace(/\s+/g, " ");
}

/** Whether the head holds one of the dialect's function keywords. */
function hasFunctionWord(head: string, d: Dialect): boolean {
  const words = FUNCTION_WORD[d];
  if (words.length === 0) return false;
  for (const m of head.matchAll(WORDS_RE)) if (words.includes(m[0])) return true;
  return false;
}

/** The index of the `(` matching the `)` at `close`, or -1. */
function openOf(head: string, close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const c = head.charCodeAt(k);
    if (c === 41) depth++;
    else if (c === 40 && --depth === 0) return k;
  }
  return -1;
}

/** The first `(` at bracket depth 0 in the head, or -1. */
function firstTopOpen(head: string): number {
  let depth = 0;
  for (let k = 0; k < head.length; k++) {
    const c = head.charCodeAt(k);
    if (c === 40) {
      if (depth === 0) return k;
      depth++;
    } else if (c === 41) depth--;
  }
  return -1;
}

/** The identifier ending right before `at` (spaces and a generic `<…>` skipped). */
function identBefore(head: string, at: number): string {
  let k = at - 1;
  while (k >= 0 && isSpace(head.charCodeAt(k))) k--;
  if (k >= 0 && head.charCodeAt(k) === 62) {
    // skip a generic argument list
    let depth = 0;
    for (; k >= 0; k--) {
      const c = head.charCodeAt(k);
      if (c === 62) depth++;
      else if (c === 60 && --depth === 0) {
        k--;
        break;
      }
    }
    while (k >= 0 && isSpace(head.charCodeAt(k))) k--;
  }
  const end = k + 1;
  while (k >= 0 && end - k <= 80 && (isWord(head.charCodeAt(k)) || head.charCodeAt(k) === 126)) k--;
  return head.slice(k + 1, end);
}

/** A C-like function head: `ident(…) qualifiers {`, the identifier not a
 * control word, nothing assigned after the parameters. */
function cLikeFunction(head: string): boolean {
  const close = head.lastIndexOf(")");
  if (close < 0) return false;
  const tail = head.slice(close + 1).replace(/=>|->/g, "");
  if (/[=;]/.test(tail)) return false;
  const open = openOf(head, close);
  if (open < 0) return false;
  let k = open - 1;
  while (k >= 0 && isSpace(head.charCodeAt(k))) k--;
  if (k >= 0 && head.charCodeAt(k) === 93) return true; // C++ lambda `[&](…) {`
  const ident = identBefore(head, open);
  if (ident === "" || NOT_NAME.has(ident)) return false;
  const before = head.slice(0, open - ident.length).trimEnd();
  if (/\bnew$/.test(before)) return false; // an anonymous class
  if (/[=(,]$/.test(before) && !/^[\w$.:<>*&\s~]*$/.test(before)) return false;
  return true;
}

function functionName(head: string, d: Dialect): string {
  if (d === "go") {
    const m = GO_FUNC_NAME_RE.exec(head.trim());
    if (m) return m[1]!;
  }
  const kw = KEYWORD_NAME_RE.exec(head);
  if (kw && kw[1] !== undefined) return kw[1];
  const assigned = ASSIGNED_NAME_RE.exec(head);
  if (assigned && !NOT_NAME.has(assigned[1]!)) return assigned[1]!;
  const open = firstTopOpen(head);
  if (open > 0) {
    const ident = identBefore(head, open);
    if (ident !== "" && !NOT_NAME.has(ident)) {
      // A callback passed to a call (`useEffect(() => {`) is named by it.
      if (
        /=>\s*$|\bfunction\b|\bfunc\b|\bfn\b|->\s*$/.test(head.slice(open)) &&
        open < head.lastIndexOf("(")
      )
        return `<callback of ${ident}>`;
      return ident;
    }
  }
  return "<anonymous>";
}

/** Decorators or annotations that lead a head on its own line
 * (`@Get('/') async list(…)`, `@UseGuards(AuthGuard('jwt')) find(…)`,
 * `@Override public void f()`): not the name. One level of nested
 * parentheses in an argument list is read. */
const DECORATOR_LEAD_RE =
  /^(?:@[\w$.]{1,80}(?:\s{0,4}\((?:[^()\n]|\([^()\n]{0,100}\)){0,200}\))?\s{1,8}){1,6}/;

/** Classifies the head of a block (the code from the last statement
 * boundary up to its `{`); leading decorators are not part of it. */
export function classifyHead(
  head: string,
  d: Dialect,
): { kind: BlockKind; keyword: string; name?: string } {
  const h = d === "py" ? head.trim() : head.trim().replace(DECORATOR_LEAD_RE, "");
  const word = firstWord(h);
  if (/(?:=>|->)$/.test(h) || hasFunctionWord(h, d))
    return { kind: "function", keyword: "function", name: functionName(h, d) };
  const lead = word.split(" ")[0] ?? "";
  if (CONTROL_WORDS.has(lead))
    return { kind: "control", keyword: word === "else if" ? "else if" : lead };
  // `class X`, `struct S`, `impl T` before any parameter list or value.
  const open = firstTopOpen(h);
  const eq = h.indexOf("=");
  const lead2 = h.slice(0, Math.min(open < 0 ? h.length : open, eq < 0 ? h.length : eq, 200));
  for (const m of lead2.matchAll(WORDS_RE))
    if (OTHER_WORDS.has(m[0])) return { kind: "other", keyword: m[0] };
  if (d !== "py" && cLikeFunction(h))
    return { kind: "function", keyword: "function", name: functionName(h, d) };
  return { kind: "other", keyword: "" };
}

function clipHead(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > HEAD_MAX ? `${t.slice(0, 200)} … ${t.slice(t.length - 380)}` : t;
}

// ---------------------------------------------------------------------------
// Brace structure

const PP_DIRECTIVE_RE = /^\s*#\s*(\w{1,16})/;
const CONT_END_RE = /(?:[,([=+\-*/&|?<>!%^~.]|&&|\|\|)\s*$/;
const GO_CONTROL = new Set(["if", "for", "switch", "select", "else"]);
/** Dialects whose statements may end at a newline. */
const ASI: ReadonlySet<Dialect> = new Set(["js", "go", "swift", "jvm"]);

interface Frame {
  stack: number[];
  pds: number[];
  pd: number;
}

/** A statement that opens a parameter or argument list a `{` inside is an
 * object pattern or literal, not a block: `function F({ a }: P) {`,
 * `async onX({ id }) {`, `f({ a: 1 })`. */
const PARAM_LIST_HEAD_RE =
  /^\s{0,200}(?:@[\w$.]{1,80}(?:\((?:[^()\n]|\([^()\n]{0,100}\)){0,200}\))?\s{1,8}){0,4}(?:(?:export|async|static|public|private|protected|readonly|override|get|set)\s{1,8}|default\s{1,8}(?=function\b|async\b)){0,6}(?:function\b[\s*]{0,8}(?:[A-Za-z_$][\w$]{0,80})?|[A-Za-z_$][\w$]{0,80})\s{0,8}(?:<[^()]{0,120}>)?\s{0,8}\(/;

/** The characters after which a `{` inside a parameter list opens a
 * pattern or a type, never a block: `(` `,` (a destructured parameter),
 * `<` (a type argument, `Request<{ id: string }>`), `:` `|` `&` (a type
 * literal), `=` (a default). `=>` and `)` are left out: a callback's body
 * after them is a block. */
const PATTERN_AFTER: ReadonlySet<number> = new Set([40, 44, 60, 58, 124, 38, 61]);

function opensObjectPattern(head: string): boolean {
  const t = head.trimEnd();
  const last = t.charCodeAt(t.length - 1);
  if (!PATTERN_AFTER.has(last)) return false;
  // `==`, `>=`, `<=`, `!=` and `=>` end in `=` or `>`; only a lone `=` is a default.
  if (last === 61 && /[=!<>]$/.test(t.slice(0, -1))) return false;
  const m = PARAM_LIST_HEAD_RE.exec(t.slice(0, 600));
  if (!m) return false;
  const word =
    /[A-Za-z_$][\w$]{0,80}(?=\s{0,8}(?:<[^()]{0,120}>)?\s{0,8}\($)/.exec(m[0])?.[0] ?? "";
  return !CONTROL_WORDS.has(word);
}

function braceStructure(
  lines: ShapeLine[],
  fullCode: string[],
  d: Dialect,
): { structure: Structure | null; unknown?: string; notes: string[] } {
  const blocks: Block[] = [];
  const lineBlock = new Int32Array(lines.length).fill(-1);
  const notes: string[] = [];
  let stack: number[] = [];
  let pds: number[] = [];
  let pd = 0;
  /** Object patterns open inside a parameter list (js): the paren depth
   * each opened at, and the block depth it belongs to. */
  const pats: { pd: number; depth: number }[] = [];
  let segs: { line: number; text: string }[] = [];
  const pps: { snap: Frame; first: Frame | null; line: number }[] = [];
  let prevEnd = "";
  let prevKind: LineKind = "blank";

  const frame = (): Frame => ({ stack: stack.slice(), pds: pds.slice(), pd });
  const restore = (f: Frame): void => {
    stack = f.stack.slice();
    pds = f.pds.slice();
    pd = f.pd;
  };

  for (let li = 0; li < lines.length; li++) {
    const sl = lines[li]!;
    const L = sl.n;
    lineBlock[li] = stack.length > 0 ? stack[stack.length - 1]! : -1;
    sl.depth = stack.length;
    const trimmed = sl.code.trim();
    if (sl.kind === "pp") {
      sl.cont = false;
      const m = PP_DIRECTIVE_RE.exec(sl.raw);
      const dir = m?.[1] ?? "";
      if (dir === "if" || dir === "ifdef" || dir === "ifndef")
        pps.push({ snap: frame(), first: null, line: L });
      else if (dir === "elif" || dir === "else" || dir === "elifdef" || dir === "elifndef") {
        const top = pps[pps.length - 1];
        if (top) {
          if (top.first === null) top.first = frame();
          else if (top.first.stack.length !== stack.length)
            notes.push(
              `the branches of the #if at line ${top.line} open different blocks; the first branch's are used`,
            );
          restore(top.snap);
        }
      } else if (dir === "endif") {
        const top = pps.pop();
        if (top && top.first !== null) {
          if (top.first.stack.length !== stack.length)
            notes.push(
              `the branches of the #if at line ${top.line} open different blocks; the first branch's are used`,
            );
          for (const id of stack) if (!top.first.stack.includes(id)) blocks[id]!.end = L;
          restore(top.first);
        }
      }
      continue;
    }
    if (sl.kind === "blank" || sl.kind === "comment") {
      sl.cont = pd > 0;
      continue;
    }
    sl.cont =
      pd > 0 ||
      trimmed.startsWith(".") ||
      trimmed.startsWith("?.") ||
      (prevKind === "code" &&
        CONT_END_RE.test(prevEnd) &&
        !prevEnd.endsWith("++") &&
        !prevEnd.endsWith("--"));
    // A statement ends at the line's end in a dialect without mandatory
    // semicolons, unless the next line continues it or opens its block.
    if (ASI.has(d) && !sl.cont && !trimmed.startsWith("{")) segs = [];
    const s = fullCode[li]!;
    let segStart = 0;
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 40 || c === 91) pd++;
      else if (c === 41 || c === 93) {
        if (pd > 0) pd--;
      } else if (c === 59) {
        if (pd === 0) {
          if (d === "go") {
            const lead = segs.length > 0 ? segs[0]!.text : s.slice(segStart, segStart + 80);
            if (GO_CONTROL.has(firstWord(lead.trim()).split(" ")[0] ?? "")) continue;
          }
          segs = [];
          segStart = j + 1;
        }
      } else if (
        c === 123 &&
        d === "js" &&
        pd > 0 &&
        // inside an open pattern every brace is the pattern's (`{ b = {} }`)
        ((pats.length > 0 && pats[pats.length - 1]!.depth === stack.length) ||
          opensObjectPattern(segs.map((g) => g.text).join(" ") + " " + s.slice(segStart, j)))
      ) {
        pats.push({ pd, depth: stack.length });
        pd++;
      } else if (
        c === 125 &&
        pats.length > 0 &&
        pats[pats.length - 1]!.depth === stack.length &&
        pats[pats.length - 1]!.pd === pd - 1
      ) {
        pats.pop();
        pd--;
      } else if (c === 123) {
        const headText = segs.map((g) => g.text).join(" ") + " " + s.slice(segStart, j);
        const headLine = segs.find((g) => g.text.trim() !== "")?.line ?? L;
        const head = clipHead(headText);
        const cls = classifyHead(head, d);
        const id = blocks.length;
        blocks.push({
          id,
          kind: cls.kind,
          keyword: cls.keyword,
          ...(cls.name !== undefined ? { name: cls.name } : {}),
          open: head === "" ? L : headLine,
          body: L,
          end: 0,
          head,
          parent: stack.length > 0 ? stack[stack.length - 1]! : -1,
        });
        stack.push(id);
        pds.push(pd);
        pd = 0;
        if (stack.length > SHAPE_MAX_DEPTH)
          return { structure: null, unknown: `blocks nest deeper than ${SHAPE_MAX_DEPTH}`, notes };
        segs = [];
        segStart = j + 1;
      } else if (c === 125) {
        const id = stack.pop();
        if (id === undefined)
          return { structure: null, unknown: `a closing brace at line ${L} has no opener`, notes };
        blocks[id]!.end = L;
        pd = pds.pop() ?? 0;
        segs = [];
        segStart = j + 1;
      }
    }
    const rest = s.slice(segStart);
    if (rest.trim() !== "" || segs.length > 0) {
      segs.push({ line: L, text: rest.length > 300 ? rest.slice(rest.length - 300) : rest });
      if (segs.length > 8) segs.shift();
    }
    prevEnd = trimmed;
    prevKind = "code";
  }
  if (stack.length > 0) {
    const b = blocks[stack[stack.length - 1]!]!;
    return {
      structure: null,
      unknown: `${stack.length} block${stack.length === 1 ? "" : "s"} still open at the end of the file (the innermost opened at line ${b.body})`,
      notes,
    };
  }
  return { structure: { blocks, lineBlock }, notes };
}

// ---------------------------------------------------------------------------
// Python structure

const PY_OPENERS = new Set([
  "def",
  "async",
  "class",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "try",
  "except",
  "finally",
  "with",
  "match",
  "case",
]);

function indentWidth(raw: string): number {
  let w = 0;
  for (let k = 0; k < raw.length; k++) {
    const c = raw.charCodeAt(k);
    if (c === 32) w++;
    else if (c === 9) w = w + 8 - (w % 8);
    else if (c === 12) w = 0;
    else break;
  }
  return w;
}

function pyStructure(
  lines: ShapeLine[],
  fullCode: string[],
  inLiteral: boolean[],
): {
  structure: Structure | null;
  unknown?: string;
  notes: string[];
} {
  const blocks: Block[] = [];
  const lineBlock = new Int32Array(lines.length).fill(-1);
  const stack: { id: number; indent: number }[] = [];
  let bd = 0;
  let backslash = false;
  let pending: Block | null = null;
  let pendingIndent = 0;
  let headLine = 0;
  let headText = "";
  let lastCode = 0;
  for (let li = 0; li < lines.length; li++) {
    const sl = lines[li]!;
    const L = sl.n;
    const cont = bd > 0 || backslash || inLiteral[li] === true;
    if (!cont && (sl.kind === "blank" || sl.kind === "comment")) {
      lineBlock[li] = stack.length > 0 ? stack[stack.length - 1]!.id : -1;
      sl.depth = stack.length;
      sl.cont = false;
      continue;
    }
    if (!cont) {
      const indent = indentWidth(sl.raw);
      if (pending !== null) {
        if (indent <= pendingIndent)
          return {
            structure: null,
            unknown: `the block opened at line ${pending.body} has no indented body`,
            notes: [],
          };
        blocks.push(pending);
        stack.push({ id: pending.id, indent });
        pending = null;
      } else {
        while (stack.length > 0 && indent < stack[stack.length - 1]!.indent) {
          blocks[stack.pop()!.id]!.end = lastCode;
        }
        const want = stack.length > 0 ? stack[stack.length - 1]!.indent : 0;
        if (indent !== want)
          return {
            structure: null,
            unknown: `line ${L} is indented to a level no open block has`,
            notes: [],
          };
      }
      headLine = L;
      headText = "";
    }
    lineBlock[li] = stack.length > 0 ? stack[stack.length - 1]!.id : -1;
    sl.depth = stack.length;
    sl.cont = cont;
    const s = fullCode[li]!;
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 40 || c === 91 || c === 123) bd++;
      else if ((c === 41 || c === 93 || c === 125) && bd > 0) bd--;
    }
    const t = sl.code.trimEnd();
    backslash = t.endsWith("\\");
    if (headText.length < HEAD_MAX) headText += ` ${sl.code.trim()}`;
    lastCode = L;
    if (bd === 0 && !backslash && inLiteral[li + 1] !== true && t.endsWith(":")) {
      const head = clipHead(headText);
      const w = /^[A-Za-z_]\w{0,20}/.exec(head)?.[0] ?? "";
      if (PY_OPENERS.has(w)) {
        const isDef = /^(?:async\s+)?def\b/.test(head);
        const kw = w === "async" ? (/^async\s+(\w+)/.exec(head)?.[1] ?? "async") : w;
        pending = {
          id: blocks.length,
          kind: isDef ? "function" : w === "class" ? "other" : "control",
          keyword: isDef ? "function" : kw,
          ...(isDef ? { name: /def\s+([A-Za-z_]\w{0,80})/.exec(head)?.[1] ?? "<anonymous>" } : {}),
          open: headLine,
          body: L,
          end: 0,
          head,
          parent: stack.length > 0 ? stack[stack.length - 1]!.id : -1,
        };
        pendingIndent = indentWidth(lines[headLine - 1]?.raw ?? "");
        if (stack.length >= SHAPE_MAX_DEPTH)
          return {
            structure: null,
            unknown: `blocks nest deeper than ${SHAPE_MAX_DEPTH}`,
            notes: [],
          };
      }
    }
  }
  if (pending !== null)
    return {
      structure: null,
      unknown: `the block opened at line ${pending.body} has no body`,
      notes: [],
    };
  if (bd !== 0)
    return {
      structure: null,
      unknown: "a bracket is still open at the end of the file",
      notes: [],
    };
  while (stack.length > 0) blocks[stack.pop()!.id]!.end = lastCode;
  blocks.sort((a, b) => a.id - b.id);
  return { structure: { blocks, lineBlock }, notes: [] };
}

// ---------------------------------------------------------------------------
// The shape

/** The shape of one file: its lines and, when it can be read whole, its
 * structure. */
export function shapeOf(path: string, text: string): Shape {
  const dialect = dialectOf(path);
  const rawLines = text.split("\n");
  if (dialect === null) {
    const lines = rawLines.map((r, i): ShapeLine => {
      const raw = cut(r);
      return {
        n: i + 1,
        raw,
        code: raw,
        kind: BLANK_LINE_RE.test(raw) ? "blank" : "code",
        depth: 0,
        cont: false,
      };
    });
    return {
      path,
      dialect,
      lines,
      structure: null,
      unknown: "the language of this file is not one the structure reads",
      notes: [],
    };
  }
  const lexed = lex(text, RULES[dialect]);
  const codeLines = lexed.code.split("\n");
  const lines: ShapeLine[] = rawLines.map((r, i) => {
    const raw = cut(r);
    const code = cut(codeLines[i] ?? "");
    let kind: LineKind;
    if (BLANK_LINE_RE.test(raw)) kind = "blank";
    else if (lexed.pp[i] === true) kind = "pp";
    else if (BLANK_LINE_RE.test(code)) kind = "comment";
    else kind = "code";
    return { n: i + 1, raw, code, kind, depth: 0, cont: false };
  });
  if (lexed.unknown !== undefined)
    return { path, dialect, lines, structure: null, unknown: lexed.unknown, notes: [] };
  const built =
    dialect === "py"
      ? pyStructure(lines, codeLines, lexed.inLiteral)
      : braceStructure(lines, codeLines, dialect);
  return {
    path,
    dialect,
    lines,
    structure: built.structure,
    ...(built.unknown !== undefined ? { unknown: built.unknown } : {}),
    notes: built.notes,
  };
}

// ---------------------------------------------------------------------------
// Queries over a shape

const FUNCTION_LINES = new WeakMap<Shape, Int32Array>();

/** The function each line belongs to (index n-1): the function whose body
 * holds it, or whose head it is; -1 outside every function. Built once per
 * shape, linear in lines and blocks. */
export function lineFunctions(shape: Shape): Int32Array {
  const known = FUNCTION_LINES.get(shape);
  if (known) return known;
  const out = new Int32Array(shape.lines.length).fill(-1);
  const st = shape.structure;
  if (st) {
    // A parent is made before its children, so one pass in id order holds.
    const fnOf = new Int32Array(st.blocks.length).fill(-1);
    for (const b of st.blocks)
      fnOf[b.id] = b.kind === "function" ? b.id : b.parent >= 0 ? fnOf[b.parent]! : -1;
    for (let i = 0; i < out.length; i++) {
      const at = st.lineBlock[i]!;
      out[i] = at >= 0 ? fnOf[at]! : -1;
    }
    for (const b of st.blocks)
      if (b.kind === "function")
        for (let L = b.open; L <= b.body && L <= out.length; L++) out[L - 1] = b.id;
  }
  FUNCTION_LINES.set(shape, out);
  return out;
}

/** The innermost block holding `line` (by extent), or null. A block's head
 * and closing lines count as inside it. */
export function innermostAt(shape: Shape, line: number): Block | null {
  const st = shape.structure;
  if (!st || line < 1 || line > shape.lines.length) return null;
  // Blocks are made in head order, so the last one that holds the line is
  // the deepest.
  let best: Block | null = null;
  for (const b of st.blocks) {
    if (b.open > line) break;
    if (b.end >= line && (best === null || isWithin(st, b, best))) best = b;
  }
  return best;
}

/** Whether `inner` is `outer` or nested in it. */
export function isWithin(st: Structure, inner: Block, outer: Block): boolean {
  for (
    let b: Block | undefined = inner;
    b !== undefined;
    b = b.parent >= 0 ? st.blocks[b.parent] : undefined
  )
    if (b.id === outer.id) return true;
  return false;
}

/** The innermost block holding the line's code (its own head excluded). */
export function blockOfLine(shape: Shape, line: number): Block | null {
  const st = shape.structure;
  if (!st || line < 1 || line > shape.lines.length) return null;
  const at = st.lineBlock[line - 1]!;
  return at >= 0 ? st.blocks[at]! : null;
}

/** The innermost function enclosing `line`: a function whose head is on the
 * line counts. */
export function functionAt(shape: Shape, line: number): Block | null {
  const st = shape.structure;
  if (!st) return null;
  for (
    let b = innermostAt(shape, line);
    b !== null;
    b = b.parent >= 0 ? st.blocks[b.parent]! : null
  )
    if (b.kind === "function") return b;
  return null;
}

/** The function whose body holds the line's code. */
export function functionOfLine(shape: Shape, line: number): Block | null {
  const st = shape.structure;
  if (!st) return null;
  for (
    let b = blockOfLine(shape, line);
    b !== null;
    b = b.parent >= 0 ? st.blocks[b.parent]! : null
  )
    if (b.kind === "function") return b;
  return null;
}

/** The blocks from `fn` (exclusive) down to the block holding `line`. */
export function chainOf(shape: Shape, line: number, fn: Block): Block[] {
  const st = shape.structure;
  if (!st) return [];
  const chain: Block[] = [];
  for (
    let b = blockOfLine(shape, line);
    b !== null && b.id !== fn.id;
    b = b.parent >= 0 ? st.blocks[b.parent]! : null
  )
    chain.unshift(b);
  return chain;
}

export type ExitKind =
  | "return"
  | "throw"
  | "raise"
  | "goto"
  | "panic"
  | "exit"
  | "fatal"
  | "break"
  | "continue"
  | "end"
  | "catch"
  | "except"
  | "finally"
  | "defer"
  | "with";

export interface Exit {
  kind: ExitKind;
  line: number;
  /** A handler (catch/except/finally/defer/with), not a way out. */
  handler: boolean;
}

/** Exits that leave the function. */
export const LEAVING: ReadonlySet<ExitKind> = new Set([
  "return",
  "throw",
  "raise",
  "goto",
  "panic",
  "exit",
  "fatal",
  "end",
]);

const EXIT_PROBES: readonly {
  kind: ExitKind;
  re: RegExp;
  only?: readonly Dialect[];
  not?: readonly Dialect[];
}[] = [
  { kind: "return", re: /\breturn\b/ },
  { kind: "throw", re: /\bthrow\b/, not: ["py", "go"] },
  { kind: "raise", re: /\braise\b/, only: ["py"] },
  { kind: "goto", re: /\bgoto\s{1,8}[A-Za-z_]/, only: ["c", "go", "cs", "php"] },
  { kind: "panic", re: /\bpanic!?\s{0,4}\(/, only: ["go", "rust"] },
  {
    kind: "exit",
    re: /\b(?:os\.Exit|process\.exit|sys\.exit|System\.exit|std::exit|std::abort|std::terminate|os\._exit|fatalError)\s{0,4}\(|(?<![.\w])(?:abort|exit|_exit|_Exit|quick_exit)\s{0,4}\(/,
  },
  {
    kind: "fatal",
    re: /\blog\.(?:Fatal|Fatalf|Fatalln|Panic|Panicf|Panicln)\s{0,4}\(/,
    only: ["go"],
  },
  { kind: "break", re: /\bbreak\b/ },
  { kind: "continue", re: /\bcontinue\b/ },
];
const HANDLER_PROBES: readonly { kind: ExitKind; re: RegExp; only?: readonly Dialect[] }[] = [
  { kind: "catch", re: /\bcatch\b/, only: ["c", "js", "jvm", "cs", "swift", "dart", "php"] },
  { kind: "except", re: /^\s*except\b/, only: ["py"] },
  { kind: "finally", re: /\bfinally\b/ },
  { kind: "defer", re: /^\s*defer\b/, only: ["go", "swift"] },
  { kind: "with", re: /^\s*(?:async\s{1,8})?with\b/, only: ["py"] },
];

/** The kind of exit a code line holds, if any. */
export function exitKindOf(code: string, d: Dialect): { kind: ExitKind; handler: boolean } | null {
  for (const p of EXIT_PROBES) {
    if (p.only && !p.only.includes(d)) continue;
    if (p.not && p.not.includes(d)) continue;
    if (p.re.test(code)) return { kind: p.kind, handler: false };
  }
  for (const p of HANDLER_PROBES) {
    if (p.only && !p.only.includes(d)) continue;
    if (p.re.test(code)) return { kind: p.kind, handler: true };
  }
  return null;
}

/** Blocks every path through runs to their end: a last statement inside
 * one that leaves the function leaves no fall-off after it (a Python
 * function whose `with` body ends in `return`). */
const STRAIGHT_BLOCKS: ReadonlySet<string> = new Set([
  "with",
  "try",
  "using",
  "synchronized",
  "lock",
  "unsafe",
]);

/** Every exit of `fn`, in line order: lines whose own function is `fn`, and
 * the fall-off at its end when its last statement does not leave. */
export function exitsOf(shape: Shape, fn: Block): Exit[] {
  const d = shape.dialect;
  if (!d || !shape.structure) return [];
  const out: Exit[] = [];
  let lastStmt: { line: number; leaves: boolean } | null = null;
  for (let L = fn.body; L <= fn.end; L++) {
    const sl = shape.lines[L - 1]!;
    if (sl.kind !== "code") continue;
    const own = functionOfLine(shape, L);
    const headHere = L === fn.body && familyOf(d) === "brace";
    if (own?.id !== fn.id && !headHere) continue;
    let code = sl.code;
    if (L === fn.body) {
      if (familyOf(d) === "indent") continue;
      // only what follows the function's own `{`
      const at = code.indexOf("{");
      code = at >= 0 ? code.slice(at + 1) : "";
    }
    if (L === fn.end && familyOf(d) === "brace") {
      const at = code.lastIndexOf("}");
      code = at >= 0 ? code.slice(0, at) : code;
    }
    if (code.trim() === "" || code.trim() === "}") continue;
    const k = exitKindOf(code, d);
    if (k) out.push({ kind: k.kind, line: L, handler: k.handler });
    if (!sl.cont && !/^\s*[})\]]+\s*[;,]?\s*$/.test(code))
      lastStmt = {
        line: L,
        leaves:
          k !== null &&
          LEAVING.has(k.kind) &&
          !k.handler &&
          (L === fn.body || chainOf(shape, L, fn).every((b) => STRAIGHT_BLOCKS.has(b.keyword))),
      };
  }
  if (!(lastStmt?.leaves ?? false)) out.push({ kind: "end", line: fn.end, handler: false });
  return out;
}

// ---------------------------------------------------------------------------
// Statements

export interface StmtKey {
  /** Comparable text: `callee(literal)` / `callee(…)` / `lhs = literal` / `lhs =`. */
  key: string;
  /** The callee's or the written field's last identifier. */
  token: string;
  kind: "call" | "write";
  /** A Go `defer` or Swift `defer` call. */
  deferred: boolean;
  /** A write: every member on the target's chain, last first. A store
   * through `a->f.g` or `a.f[i].g` writes into `f` as well as `g`; the root
   * variable is no member (`this`/`self` neither). */
  members?: string[];
}

const CHAIN_SPLIT_RE = /\s{0,4}(?:\.|->|::|\?\.)\s{0,4}/;

/** The members a store to `lhs` writes, last first: every segment after the
 * root, index brackets dropped; a lone name (`m_x`, `x_`) is its own member. */
export function chainMembers(lhs: string): string[] {
  const segs = lhs
    .replace(/\[[^\]]{0,60}\]/g, "")
    .replace(/^\s{0,8}\*\s{0,4}/, "")
    .split(CHAIN_SPLIT_RE)
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (segs.length <= 1) return segs;
  return segs.slice(1).reverse();
}

/** Lines that open with these words hold no companion statement. */
const NOT_STATEMENT = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "default",
  "return",
  "throw",
  "raise",
  "break",
  "continue",
  "goto",
  "do",
  "try",
  "catch",
  "finally",
  "except",
  "def",
  "func",
  "function",
  "fn",
  "fun",
  "class",
  "struct",
  "elif",
  "with",
  "import",
  "from",
  "export",
  "package",
  "using",
  "namespace",
  "select",
  "match",
  "when",
  "guard",
  "assert",
  "yield",
  "type",
  "interface",
  "enum",
  "async",
]);
const NOT_CALLEE = new Set([
  ...NOT_NAME,
  "function",
  "func",
  "fn",
  "fun",
  "def",
  "if",
  "super",
  "this",
  "self",
  "print",
  "require",
  "import",
]);

/** An assignment that starts the line: group 1 the target, group 2 the operator. */
export const WRITE_STMT_RE =
  /^\s{0,200}(?:\*\s{0,4})?((?:this|self|[A-Za-z_$][\w$]{0,80})(?:\s{0,4}(?:\.|->|::|\?\.)\s{0,4}[A-Za-z_$][\w$]{0,80}|\[[^\]\n]{0,60}\]){0,8})\s{0,4}([-+*/%|&^]|<<|>>|\?\?|\|\||&&)?=(?![=>])/;
const INCR_STMT_RE =
  /^\s{0,200}(?:(?:\+\+|--)\s{0,4}((?:this|self|[A-Za-z_$][\w$]{0,80})(?:(?:\.|->|\?\.)[A-Za-z_$][\w$]{0,80}){0,8})|((?:this|self|[A-Za-z_$][\w$]{0,80})(?:(?:\.|->|\?\.)[A-Za-z_$][\w$]{0,80}){0,8})\s{0,4}(?:\+\+|--))/;
/** A call: group 1 the callee chain. The lookbehind keeps a match at the
 * chain's start. */
export const CALL_RE =
  /(?<![\w$.>:])((?:[A-Za-z_$][\w$]{0,80})(?:(?:\.|->|::|\?\.)[A-Za-z_$][\w$]{0,80}){0,6})\s{0,4}!?\(/;
const LITERAL_RE =
  /^\s{0,8}(?:true|false|null|nil|None|undefined|True|False|NULL|nullptr|-?\d{1,20}|"\x01{0,400}"|'\x01{0,400}'|`\x01{0,400}`|\[\]|\{\}|[A-Z][A-Z0-9_]{0,60}|[A-Za-z_]\w{0,40}(?:\.|::)[A-Za-z_]\w{0,40})\s{0,8}$/;
const DEFER_RE = /^\s{0,200}defer\b/;

/** A single identifier: a lowercase constant or a variable, named in a key
 * so `s.state = stateIdle` and `s.state = stateRunning` stay two statements. */
const IDENT_VALUE_RE = /^\s{0,8}[A-Za-z_$][\w$]{0,40}\s{0,8}$/;

function literalOf(text: string): string | null {
  if (!LITERAL_RE.test(text)) return null;
  const t = text.trim();
  return /^["'`]/.test(t) ? '""' : t;
}

/** The text between the `(` at `open` and its matching `)`, on the line;
 * null when it does not close there. */
function argsAt(code: string, open: number): string | null {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    const c = code.charCodeAt(k);
    if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return code.slice(open + 1, k);
  }
  return null;
}

function bareTarget(lhs: string): string {
  return lhs
    .replace(/\s+/g, "")
    .replace(/\?\./g, ".")
    .replace(/^(?:this|self)(?:\.|->)/, "")
    .replace(/\[[^\]]{0,60}\]/g, "[…]");
}

/** Whether an assignment target is state worth comparing: a member, a
 * dereference, or a C++ member spelling (`m_x`, `x_`). */
function memberTarget(lhs: string): boolean {
  return (
    /\.|->|::|\[|^\s*\*/.test(lhs) ||
    /^(?:m_\w|_\w|\w+_$)/.test(lhs.trim()) ||
    /^(?:this|self)$/.test(lhs)
  );
}

/** The statement a code line holds, as a key two sites can compare: a
 * write to a member (with its literal value when it has one), else the
 * line's first call (with its single literal argument when it has one).
 * Control lines, exits and declarations without a call give none. */
export function stmtKey(code: string): StmtKey | null {
  let text = code;
  let deferred = false;
  if (DEFER_RE.test(text)) {
    deferred = true;
    text = text.replace(/^\s*defer\b/, "");
  }
  const lead = /^\s*(?:\}\s*)?([A-Za-z_$][\w$]{0,40})/.exec(text)?.[1] ?? "";
  if (!deferred && NOT_STATEMENT.has(lead)) return null;
  text = text.replace(/^\s*(?:await|go|void)\s+/, "");
  const w = WRITE_STMT_RE.exec(text);
  if (w && memberTarget(w[1]!)) {
    const target = bareTarget(w[1]!);
    const op = w[2] ?? "";
    const rhs = text.slice(w.index + w[0].length).replace(/[;,]\s*$/, "");
    const lit =
      op === "" ? (literalOf(rhs) ?? (IDENT_VALUE_RE.test(rhs) ? rhs.trim() : null)) : null;
    const token = /([A-Za-z_$][\w$]{0,80})(?:\[…\])?$/.exec(target)?.[1] ?? target;
    return {
      key: `${target} ${op}=${lit !== null ? ` ${lit}` : ""}`,
      token,
      kind: "write",
      deferred,
      members: chainMembers(w[1]!),
    };
  }
  const inc = INCR_STMT_RE.exec(text);
  if (inc) {
    const raw = inc[1] ?? inc[2] ?? "";
    if (memberTarget(raw)) {
      const target = bareTarget(raw);
      const token = /([A-Za-z_$][\w$]{0,80})$/.exec(target)?.[1] ?? target;
      return { key: `${target} ++/--`, token, kind: "write", deferred, members: chainMembers(raw) };
    }
  }
  let from = 0;
  for (let guard = 0; guard < 16 && from < text.length; guard++) {
    const m = CALL_RE.exec(text.slice(from));
    if (!m) break;
    const at = from + m.index;
    const chain = m[1]!;
    const last = /([A-Za-z_$][\w$]{0,80})$/.exec(chain)?.[1] ?? chain;
    const before = text.slice(Math.max(0, at - 5), at);
    // A keyword is not a callee when it stands alone (`if (`, `delete (`);
    // as a member it is a method (`map.delete(`, `p.catch(`).
    if (
      (chain !== last || !NOT_CALLEE.has(last)) &&
      !NOT_CALLEE.has(chain) &&
      !/\bnew\s$/.test(before)
    ) {
      const callee = bareTarget(chain);
      const args = argsAt(text, at + m[0].length - 1);
      const lit = args === null ? null : args.trim() === "" ? "" : literalOf(args);
      const shown = lit === null ? `${callee}(…)` : `${callee}(${lit})`;
      return { key: shown, token: last, kind: "call", deferred };
    }
    from = at + Math.max(1, m[0].length);
  }
  return null;
}

/** A mutating method on a receiver: a Map/Set `.set(` `.delete(` `.clear(`
 * `.add(`, a C++ atomic `.store(` `.exchange(` `.fetch_*(` `.compare_exchange_*(`.
 * Group 1 the receiver chain, group 2 the method. */
export const RECEIVER_WRITE_RE =
  /(?<![\w$.>:])((?:[A-Za-z_$][\w$]{0,80})(?:\s{0,2}(?:\.|->|\?\.)\s{0,2}[A-Za-z_$][\w$]{0,80}){0,8})\s{0,2}(?:\.|->|\?\.)\s{0,2}(set|delete|clear|add|store|exchange|fetch_(?:add|sub|and|or|xor|max|min)|compare_exchange_(?:weak|strong))(?:_explicit)?\s{0,4}\(/;
/** A C11 atomic function: group 1 the object whose address is its first
 * argument. */
export const ATOMIC_FN_RE =
  /\batomic_(?:store|exchange|init|fetch_(?:add|sub|and|or|xor)|compare_exchange_(?:weak|strong)|flag_test_and_set|flag_clear)(?:_explicit)?\s{0,4}\(\s{0,4}&?\s{0,2}((?:[A-Za-z_$][\w$]{0,80}\s{0,2}(?:\.|->)\s{0,2}){0,6}[A-Za-z_$][\w$]{0,80})/;

/** The field a line writes by a call rather than an assignment: the receiver
 * of a mutating collection or atomic method, or the object a C11 atomic
 * function stores to. Lexical: the receiver's type is not known, so a
 * `.set(` on any object counts. */
export function receiverWrite(
  code: string,
): { field: string; how: "collection" | "atomic" } | null {
  const a = ATOMIC_FN_RE.exec(code);
  if (a) {
    const segs = a[1]!.split(CHAIN_SPLIT_RE);
    return { field: segs[segs.length - 1]!.trim(), how: "atomic" };
  }
  const m = RECEIVER_WRITE_RE.exec(code);
  if (!m) return null;
  const segs = m[1]!.split(CHAIN_SPLIT_RE).map((x) => x.trim());
  const field = segs[segs.length - 1]!;
  if (field === "this" || field === "self" || field === "") return null;
  const method = m[2]!;
  return {
    field,
    how: /^(?:set|delete|clear|add)$/.test(method) ? "collection" : "atomic",
  };
}

/** A line's code with literals abstracted and blanks collapsed: two sites of
 * the same statement compare equal. */
export function normalise(code: string): string {
  return code
    .trim()
    .replace(/(["'`])\x01{0,400}\1/g, '""')
    .replace(/\b\d[\w.]{0,40}/g, "0")
    .replace(/\s+/g, " ")
    .replace(/\s?;$/, "");
}

/** Every regex this module runs, for the linear-time test. */
export const STATE_SHAPE_PROBES: readonly { id: string; re: RegExp }[] = [
  { id: "first-word", re: FIRST_WORD_RE },
  { id: "go-func-name", re: GO_FUNC_NAME_RE },
  { id: "assigned-name", re: ASSIGNED_NAME_RE },
  { id: "keyword-name", re: KEYWORD_NAME_RE },
  { id: "pp-directive", re: PP_DIRECTIVE_RE },
  { id: "cont-end", re: CONT_END_RE },
  { id: "write-stmt", re: WRITE_STMT_RE },
  { id: "incr-stmt", re: INCR_STMT_RE },
  { id: "call", re: CALL_RE },
  { id: "param-list-head", re: PARAM_LIST_HEAD_RE },
  { id: "literal", re: LITERAL_RE },
  { id: "ident-value", re: IDENT_VALUE_RE },
  { id: "defer", re: DEFER_RE },
  { id: "receiver-write", re: RECEIVER_WRITE_RE },
  { id: "decorator-lead", re: DECORATOR_LEAD_RE },
  { id: "atomic-fn", re: ATOMIC_FN_RE },
  { id: "chain-split", re: CHAIN_SPLIT_RE },
  { id: "leading", re: LEADING_RE },
  ...EXIT_PROBES.map((p) => ({ id: `exit-${p.kind}`, re: p.re })),
  ...HANDLER_PROBES.map((p) => ({ id: `handler-${p.kind}`, re: p.re })),
];
