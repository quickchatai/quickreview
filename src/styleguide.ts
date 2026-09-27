// Does this repo write its code style down? (`[review] style_lens`)
//
// Style is the one review concern with no universal answer: every repo has
// its own, and a reviewer's taste is not it. So the style lens runs only
// where the repo has a WELL-DEFINED written guide, and it judges only against
// that guide. "Well defined" is structural and cheap to check here, before a
// round is planned:
//
//   - a dedicated guide file — STYLEGUIDE / STYLE_GUIDE / STYLE / CODE_STYLE /
//     CODING_STYLE / CODING_STANDARDS / CODING_GUIDELINES / CONVENTIONS, as
//     .md/.rst/.txt/.adoc, at the root or under docs/, doc/ or .github/ (or a
//     docs file whose NAME says style guide / coding standards) — with at
//     least GUIDE_MIN_LINES lines of content;
//   - or a style section in CONTRIBUTING (a heading such as "Code style",
//     "Coding standards", "Style guide") with at least SECTION_MIN_LINES
//     lines of content under it.
//
// Linter and formatter configs are NOT a style guide here: what a tool
// enforces is CI's job, and the review reads CI, it never re-runs it.
// Total: an unreadable tree is "no guide", never an error.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const GUIDE_MIN_LINES = 15;
export const SECTION_MIN_LINES = 8;
const MAX_GUIDE_BYTES = 512 * 1024;

const GUIDE_NAME_RE =
  /^(style[-_ ]?guide|style|code[-_ ]?style|coding[-_ ]?(style|standards|guidelines|conventions)|conventions)(\.(md|markdown|rst|txt|adoc))$/i;
const DOCS_NAME_RE =
  /(style[-_ ]?guide|code[-_ ]?style|coding[-_ ]?(style|standards|guidelines|conventions))[^/]*\.(md|markdown|rst|txt|adoc)$/i;
const CONTRIBUTING_RE = /^contributing\.(md|markdown|rst|txt|adoc)$/i;
const STYLE_HEADING_RE =
  /^(#{1,6}\s+|=+\s*$|-+\s*$)?.*\b(code|coding)\s+(style|standards|conventions|guidelines)\b|\bstyle\s*guide\b/i;
const HEADING_RE = /^#{1,6}\s+\S/;

function contentLines(text: string): number {
  return text.split("\n").filter((l) => l.trim() && !/^[#=\-*_`\s]+$/.test(l.trim())).length;
}

function read(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_GUIDE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The style section of a CONTRIBUTING file as 1-based [from, to] lines, when
 * it is substantial enough to be a guide. Markdown headings only. */
export function styleSection(text: string): [number, number] | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!HEADING_RE.test(l) || !STYLE_HEADING_RE.test(l)) continue;
    const level = /^#+/.exec(l)![0].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^(#{1,6})\s+\S/.exec(lines[j]!);
      if (m && m[1]!.length <= level) {
        end = j;
        break;
      }
    }
    if (contentLines(lines.slice(i + 1, end).join("\n")) >= SECTION_MIN_LINES) return [i + 1, end];
  }
  return null;
}

/**
 * The repo's written style guide(s) under `root`, as repo-relative
 * references — `path` for a whole guide file, `path:from-to` for a style
 * section — or [] when there is none worth a lens.
 */
export function findStyleGuide(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const dirs = ["", "docs", "doc", ".github"];
  for (const d of dirs) {
    const base = join(root, d);
    for (const name of list(base)) {
      const path = join(base, name);
      const rel = relative(root, path);
      if (GUIDE_NAME_RE.test(name) || (d !== "" && DOCS_NAME_RE.test(name))) {
        const text = read(path);
        if (text !== null && contentLines(text) >= GUIDE_MIN_LINES) out.push(rel);
      } else if (CONTRIBUTING_RE.test(name)) {
        const text = read(path);
        const sec = text === null ? null : styleSection(text);
        if (sec) out.push(`${rel}:${sec[0]}-${sec[1]}`);
      }
    }
  }
  // docs/<sub>/ one level down, by name only (a docs site's style page).
  for (const d of ["docs", "doc"]) {
    for (const sub of list(join(root, d))) {
      const subdir = join(root, d, sub);
      let isDir = false;
      try {
        isDir = statSync(subdir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      for (const name of list(subdir)) {
        if (!DOCS_NAME_RE.test(name)) continue;
        const text = read(join(subdir, name));
        if (text !== null && contentLines(text) >= GUIDE_MIN_LINES)
          out.push(relative(root, join(subdir, name)));
      }
    }
  }
  return [...new Set(out)].sort();
}
