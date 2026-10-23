// The files of a unified diff, in the shape GitHub's files API returns.
// A leaf: the setup replay and the regression replay (src/replay.ts) both
// plan lenses from a local `git diff`, and the regression replay may not
// import src/setup/.

import type { PrFileEntry } from "./github.js";

/** Git's C-style quoting of a path, undone. A name with a special or (under
 * the default `core.quotePath`) non-ASCII byte comes double-quoted, each such
 * byte an escape (`"a\tb\303\251"`); the escapes name BYTES, so octal runs
 * are decoded as UTF-8 together. An unquoted string comes back as is; a
 * malformed one is null. The one decoder: worktrees.ts reads patch sections
 * with it too. */
export function unquoteGitPath(s: string): string | null {
  if (!s.startsWith('"')) return s;
  if (s.length < 2 || !s.endsWith('"')) return null;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      // A whole code point: a supplementary character is two UTF-16 units.
      const cp = String.fromCodePoint(body.codePointAt(i)!);
      for (const b of Buffer.from(cp, "utf8")) bytes.push(b);
      i += cp.length - 1;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) return null;
    if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (!oct) return null;
      bytes.push(parseInt(oct[0], 8));
      i += 3;
      continue;
    }
    const v = simple[n];
    if (v === undefined) return null;
    bytes.push(v);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function headerPath(raw: string, prefix: string): string | null {
  const path = unquoteGitPath(raw);
  return path?.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** The two paths of a `diff --git` header line's tail. */
export function gitDiffHeaderPaths(tail: string): { a: string | null; b: string | null } {
  if (tail.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") (.*)$/.exec(tail);
    if (!m) return { a: null, b: null };
    return { a: headerPath(m[1]!, "a/"), b: headerPath(m[2]!, "b/") };
  }
  if (tail.endsWith('"')) {
    const m = /^(.*?) ("(?:[^"\\]|\\.)*")$/.exec(tail);
    if (!m) return { a: null, b: null };
    return { a: headerPath(m[1]!, "a/"), b: headerPath(m[2]!, "b/") };
  }
  // Unquoted: unambiguous only when both sides spell the same path.
  const n = (tail.length - 5) / 2;
  if (Number.isInteger(n) && n > 0 && tail.startsWith("a/") && tail.slice(2 + n, 5 + n) === " b/") {
    const a = tail.slice(2, 2 + n);
    if (a === tail.slice(5 + n)) return { a, b: a };
  }
  return { a: null, b: null };
}

/**
 * The two sides of a `Binary files <a> and <b> differ` line (the text between
 * `Binary files ` and ` differ`). A name may itself contain ` and `, so the
 * split is chosen: a split whose sides spell the same path wins, then the first
 * split whose sides carry git's `a/` and `b/` prefixes (or `/dev/null`), then
 * the first split.
 */
function binarySides(rest: string): [string, string] | null {
  const splits: Array<[string, string]> = [];
  for (let i = rest.indexOf(" and "); i >= 0; i = rest.indexOf(" and ", i + 1))
    splits.push([rest.slice(0, i), rest.slice(i + 5)]);
  const bare = (p: string): string => p.replace(/^"?[ab]\//, "");
  const prefixed = (a: string, b: string): boolean =>
    (a === "/dev/null" || /^"?a\//.test(a)) && (b === "/dev/null" || /^"?b\//.test(b));
  return (
    splits.find(([a, b]) => a !== "/dev/null" && b !== "/dev/null" && bare(a) === bare(b)) ??
    splits.find(([a, b]) => prefixed(a, b)) ??
    splits[0] ??
    null
  );
}

/**
 * The files of a unified diff (`git diff` output) in the shape GitHub's
 * files API returns and `buildPassPlan` reads: path, status, +/- counts and
 * the hunks as `patch` (absent for a binary). Paths come from the `+++`/`---`
 * lines (the `diff --git` header is ambiguous for a path with spaces), and
 * from `rename`/`Binary files` lines when there are none.
 */
export function parseUnifiedDiff(text: string): PrFileEntry[] {
  const out: PrFileEntry[] = [];
  const blocks = text.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  // A path with a space carries a trailing tab in a `---`/`+++` line; only
  // that tab goes, never a space the name itself ends with.
  const unquote = (p: string): string => unquoteGitPath(p) ?? p;
  const unq = (p: string): string => unquote(p.replace(/\t$/, "")).replace(/^[ab]\//, "");
  for (const block of blocks) {
    const lines = block.split("\n");
    let from: string | null = null;
    let to: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let status = "modified";
    let additions = 0;
    let deletions = 0;
    let hunkAt = -1;
    for (const [i, line] of lines.entries()) {
      if (hunkAt >= 0) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        continue;
      }
      if (line.startsWith("@@")) {
        hunkAt = i;
        continue;
      }
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from "))
        renameFrom = unquote(line.slice("rename from ".length));
      else if (line.startsWith("rename to ")) renameTo = unquote(line.slice("rename to ".length));
      else if (line.startsWith("--- "))
        from = line.slice(4) === "/dev/null" ? null : unq(line.slice(4));
      else if (line.startsWith("+++ "))
        to = line.slice(4) === "/dev/null" ? null : unq(line.slice(4));
      else if (line.startsWith("Binary files ")) {
        const sides = binarySides(line.slice("Binary files ".length, -" differ".length));
        if (line.endsWith(" differ") && sides) {
          from = sides[0] === "/dev/null" ? null : unq(sides[0]);
          to = sides[1] === "/dev/null" ? null : unq(sides[1]);
        }
      }
    }
    if (renameFrom !== null && renameTo !== null) {
      status = "renamed";
      to ??= renameTo;
      from ??= renameFrom;
    }
    const filename =
      to ?? from ?? gitDiffHeaderPaths((lines[0] ?? "").slice("diff --git ".length)).b;
    if (filename === null) continue;
    const entry: PrFileEntry = { filename, additions, deletions, status };
    if (hunkAt >= 0) entry.patch = lines.slice(hunkAt).join("\n").replace(/\n+$/, "");
    if (status === "renamed" && from !== null && from !== filename) entry.previous_filename = from;
    out.push(entry);
  }
  return out;
}
