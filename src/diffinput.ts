// A unified diff handed to `qcr review --diff`, read into the file list a
// review takes (path, status, added and deleted lines, the file's own patch).
// Accepts what `git diff` / `git format-patch` / `diff -u` print; the headers
// are read leniently and the hunks by their counts, so a removed line that
// itself starts with `--` is not taken for a file header. Pure: no I/O.
import { parseHunkHeader } from "./hunkheader.js";
import type { PrFileEntry } from "./github.js";

export interface ParsedDiff {
  files: PrFileEntry[];
  /** Added plus deleted lines over the diff. */
  lines: number;
}

/** A path as git prints it: quoted with C escapes when it has odd bytes. */
function unquote(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[++i];
    const oct = /^[0-7]{1,3}/.exec(body.slice(i));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += oct[0].length - 1;
    } else if (n === "t") bytes.push(9);
    else if (n === "n") bytes.push(10);
    else if (n !== undefined) bytes.push(...Buffer.from(n, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The path on a `---` / `+++` line: its first tab-separated field (git adds a
 * tab after a name with spaces, `diff -u` a timestamp), unquoted. */
const headerPath = (rest: string): string => unquote(rest.split("\t")[0]!.trimEnd());

const NULL_PATH = "/dev/null";

/** The header lines git puts between `diff --git` and the first hunk. */
const EXTENDED_HEADER =
  /^(index |old mode |new mode |new file mode|deleted file mode|similarity index |dissimilarity index |copy from |copy to |rename from |rename to |Binary files |GIT binary patch)/;

interface Section {
  lines: string[];
  /** How many of `lines` belong to the diff (what trails the last hunk, such as
   * a format-patch signature, does not). */
  keep: number;
  oldPath?: string;
  newPath?: string;
  headerNew?: string;
  added?: boolean;
  removed?: boolean;
  renameFrom?: string;
  renameTo?: string;
  binary?: boolean;
  additions: number;
  deletions: number;
}

/** `a/x` and `b/x` are one path `x`; anything else is left as written. */
function stripPrefix(p: string, side: "a" | "b"): string {
  return p.startsWith(`${side}/`) ? p.slice(2) : p;
}

function entryOf(s: Section): PrFileEntry | null {
  const gone = s.newPath === NULL_PATH;
  const fresh = s.oldPath === NULL_PATH;
  const raw = gone ? s.oldPath : (s.newPath ?? s.renameTo ?? s.headerNew);
  if (raw === undefined || raw === NULL_PATH) return null;
  const filename = s.renameTo ?? (gone ? stripPrefix(raw, "a") : stripPrefix(raw, "b"));
  const status =
    s.removed || gone
      ? "removed"
      : s.added || fresh
        ? "added"
        : s.renameTo
          ? "renamed"
          : "modified";
  const previous =
    s.renameFrom ?? (status === "renamed" && s.oldPath ? stripPrefix(s.oldPath, "a") : undefined);
  const patch = s.binary ? undefined : s.lines.slice(0, s.keep).join("\n") + "\n";
  return {
    filename,
    additions: s.additions,
    deletions: s.deletions,
    status,
    ...(patch ? { patch } : {}),
    ...(previous !== undefined && previous !== filename ? { previous_filename: previous } : {}),
  };
}

/** The files a unified diff changes. Text that holds no file section gives an
 * empty list. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: Section[] = [];
  let cur: Section | null = null;
  const open = (first: string): Section => {
    const s: Section = { lines: [first], keep: 1, additions: 0, deletions: 0 };
    sections.push(s);
    return s;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      cur = open(line);
      const m = /^diff --git (?:"?a\/.+?"?) ("?b\/.+"?)$/.exec(line);
      if (m) cur.headerNew = unquote(m[1]!);
      continue;
    }
    // a plain `diff -u` section starts at its `---` line, when `+++` follows
    // and no git section is still collecting headers for this file
    const plainStart =
      line.startsWith("--- ") &&
      (lines[i + 1] ?? "").startsWith("+++ ") &&
      (cur === null ||
        cur.oldPath !== undefined ||
        cur.additions + cur.deletions > 0 ||
        cur.binary);
    if (plainStart) cur = open(line);
    if (cur === null) continue;
    if (!plainStart) cur.lines.push(line);
    if (plainStart || (line.startsWith("--- ") && cur.oldPath === undefined)) {
      cur.oldPath = headerPath(line.slice(4));
      cur.keep = cur.lines.length;
      continue;
    }
    if (line.startsWith("+++ ") && cur.oldPath !== undefined && cur.newPath === undefined) {
      cur.newPath = headerPath(line.slice(4));
      cur.keep = cur.lines.length;
      continue;
    }
    if (line.startsWith("new file mode")) cur.added = true;
    else if (line.startsWith("deleted file mode")) cur.removed = true;
    else if (line.startsWith("rename from ")) cur.renameFrom = unquote(line.slice(12));
    else if (line.startsWith("rename to ")) cur.renameTo = unquote(line.slice(10));
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))
      cur.binary = true;
    if (EXTENDED_HEADER.test(line)) {
      cur.keep = cur.lines.length;
      continue;
    }
    const h = parseHunkHeader(line);
    if (h === null) continue;
    // the hunk body: counted, so its content never reads as a header
    let oldLeft = h.old_count;
    let newLeft = h.new_count;
    while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
      const b = lines[i + 1]!;
      if (b.startsWith("\\")) {
        cur.lines.push(b);
        i++;
        continue;
      }
      if (b.startsWith("+")) {
        cur.additions++;
        newLeft--;
      } else if (b.startsWith("-")) {
        cur.deletions++;
        oldLeft--;
      } else if (b.startsWith(" ") || b === "") {
        oldLeft--;
        newLeft--;
      } else break;
      cur.lines.push(b);
      i++;
    }
    // a "\ No newline at end of file" marker trails the last line
    while ((lines[i + 1] ?? "").startsWith("\\")) {
      cur.lines.push(lines[i + 1]!);
      i++;
    }
    cur.keep = cur.lines.length;
  }
  const files = sections.map(entryOf).filter((f): f is PrFileEntry => f !== null);
  return { files, lines: files.reduce((n, f) => n + f.additions + f.deletions, 0) };
}
