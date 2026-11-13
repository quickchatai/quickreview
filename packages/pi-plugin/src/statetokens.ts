// The token scanner `state_explore` reads files with, and the column shapes
// it finds a schema's columns by.
//
// `scanLines` makes one pass over a text and calls back only for the lines
// that hold a wanted token. A token is `[A-Za-z0-9_]+`, tested first by its
// outline (first character, last character, length) against a table of 4096
// bytes, so a token of no interest costs no string. What lies past a line's
// `LINE_MAX` characters is skipped, not read: the cost is linear in the text,
// and no pattern is ever built from author text. Every `COLUMN_SHAPES` regex
// runs on a cut line only.

import { LINE_MAX } from "./statetriggers.js";

const WORD_RE = /\w+/;

/** A column declaration; group 1 is the column's name. `ext` limits a shape
 * to files of one extension. In the Sequelize shape a run of blanks is read
 * by one quantifier only (`:\s*(?:\{\s*)?`), so a line of blanks costs one
 * scan. */
export const COLUMN_SHAPES: readonly { id: string; re: RegExp; ext?: string }[] = [
  { id: "column-sql-add", re: /\bADD\s+(?:COLUMN\s+)?["`]?(\w{1,60})["`]?\s/ },
  { id: "column-sql-line", re: /^\s*["`]?(\w{1,60})["`]?\s+[A-Za-z]/, ext: ".sql" },
  { id: "column-rails-table", re: /\bt\.\w+\s+[:"'](\w{1,60})\b/ },
  { id: "column-rails-add", re: /\badd_column\s+:\w+,\s*:(\w{1,60})\b/ },
  { id: "column-orm-call", re: /^\s*(\w{1,60})\s*=\s*(?:\w+\.)?\w*(?:Field|Column)\(/ },
  { id: "column-orm-mapped", re: /^\s*(\w{1,60})\s*:\s*Mapped\[/ },
  { id: "column-prisma", re: /^\s*(\w{1,60})\s+[A-Z]\w*/, ext: ".prisma" },
  { id: "column-entity", re: /^\s*(\w{1,60})\s*[?!]?:\s*\w/ },
  {
    id: "column-sequelize",
    re: /\b(\w{1,60})\s*:\s*(?:\{\s*)?(?:type\s*:\s*)?(?:DataTypes|Sequelize)\./,
  },
  { id: "column-ecto", re: /\bfield\s+:(\w{1,60})\b/ },
  { id: "column-go-tag", re: /\b(?:gorm:"[^"]{0,80}column:|db:")(\w{1,60})\b/ },
];

/** A line as every regex reads it: its first `LINE_MAX` characters, with no
 * carriage return. */
function cut(line: string): string {
  const c = line.length > LINE_MAX ? line.slice(0, LINE_MAX) : line;
  return c.endsWith("\r") ? c.slice(0, -1) : c;
}

const WORD_CHAR = new Uint8Array(128);
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
  WORD_CHAR[c.charCodeAt(0)] = 1;

/** A letter's lower-case code; any other code as it is. */
function lowerCode(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

/** A token's outline: its first character, its last character and its
 * length, as an index into a table of 4096 bytes. */
function outline(first: number, last: number, length: number): number {
  return ((first * 131) ^ (last * 31) ^ length) & 4095;
}

/** The tokens one pass looks for, each with the bits of what wants it. A
 * token is first tested by its outline, so a token of no interest costs no
 * string. */
export class TokenTable {
  private readonly exact = new Map<string, number>();
  private readonly lowered = new Map<string, number>();
  /** One byte per outline: set when some wanted token has it. The tokens
   * matched whatever their case have their own table, of folded outlines. */
  private readonly exactOutlines = new Uint8Array(4096);
  private readonly loweredOutlines = new Uint8Array(4096);

  /** `lower`: the token is matched whatever its case. A token that is not
   * one identifier is never matched, and is not added. */
  add(token: string, bits: number, lower = false): void {
    if (WORD_RE.exec(token)?.[0] !== token) return;
    const key = lower ? token.toLowerCase() : token;
    const map = lower ? this.lowered : this.exact;
    map.set(key, (map.get(key) ?? 0) | bits);
    const slot = outline(key.charCodeAt(0), key.charCodeAt(key.length - 1), key.length);
    (lower ? this.loweredOutlines : this.exactOutlines)[slot] = 1;
  }

  /** Every token of `other`, wanted here with `bits`. */
  addAll(other: TokenTable, bits: number): void {
    for (const token of other.exact.keys()) this.add(token, bits);
    for (const token of other.lowered.keys()) this.add(token, bits, true);
  }

  /** The bits of the token `text[start, end)`; 0 for a token nobody wants. */
  bitsAt(text: string, start: number, end: number): number {
    const first = text.charCodeAt(start);
    const last = text.charCodeAt(end - 1);
    const length = end - start;
    let bits = 0;
    if (this.exactOutlines[outline(first, last, length)] === 1)
      bits = this.exact.get(text.slice(start, end)) ?? 0;
    if (this.loweredOutlines[outline(lowerCode(first), lowerCode(last), length)] === 1)
      bits |= this.lowered.get(text.slice(start, end).toLowerCase()) ?? 0;
    return bits;
  }
}

/** One pass over `text`: `onLine` for each line that holds a wanted token,
 * with its head line number, the cut line and the bits of its tokens. A
 * token is `[A-Za-z0-9_]+`; what lies past a line's `LINE_MAX` characters
 * is skipped, not read. Linear in the text. */
export function scanLines(
  text: string,
  table: TokenTable,
  onLine: (line: number, text: string, bits: number) => void,
): void {
  const n = text.length;
  // The cut, read once: the loop below runs once per character.
  const max = LINE_MAX;
  let line = 1;
  let lineStart = 0;
  let tokenStart = -1;
  let bits = 0;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? text.charCodeAt(i) : 10;
    if (c < 128 && WORD_CHAR[c] === 1) {
      if (tokenStart < 0) tokenStart = i;
      continue;
    }
    if (tokenStart >= 0) {
      bits |= table.bitsAt(text, tokenStart, i);
      tokenStart = -1;
    }
    if (c === 10) {
      if (bits !== 0) onLine(line, cut(text.slice(lineStart, Math.min(i, lineStart + max))), bits);
      line++;
      lineStart = i + 1;
      bits = 0;
    } else if (i - lineStart >= max) {
      const end = text.indexOf("\n", i);
      i = (end < 0 ? n : end) - 1;
    }
  }
}
