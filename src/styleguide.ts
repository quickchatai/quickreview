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
//     lines of content under it;
//   - or style rules the repo wrote for its AGENTS: a style section
//     — the same headings, plus a bare "Conventions", "Style", "Formatting"
//     or "Naming" — of at least SECTION_MIN_LINES lines in an agent-directive
//     file (AGENTS.md / CLAUDE.md at the root, .github/copilot-instructions.md,
//     .github/instructions/*.md), or a whole directive file whose NAME says
//     style or conventions (`.github/instructions/code-style.instructions.md`)
//     with at least SECTION_MIN_LINES lines. What a team already told its
//     agents about style is a written guide; a separate file is not required.
//     A directive file that is a link to another one (CLAUDE.md → AGENTS.md)
//     is read once.
//
// A guide the repo writes WINS over one a profile points the lens at
// (`[lenses.pass-style] guide`, src/lenstuning.ts): that one is used only
// when this finds nothing (src/dispatch.ts buildPassPlan).
//
// Linter and formatter configs are NOT a style guide here: what a tool
// enforces is CI's job, and the review reads CI, it never re-runs it.
// Total: an unreadable tree is "no guide", never an error.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
/** A directive file's style heading: the guide headings above, or a bare
 * "Conventions" / "Style" / "Formatting" / "Naming" — agent files name the
 * section for the agent, not as a guide. */
const DIRECTIVE_HEADING_RE = /\b(style|conventions|formatting|naming)\b/i;
const ROOT_DIRECTIVE_RE = /^(agents|claude)\.md$/i;
const DIRECTIVE_NAME_RE = /(style|conventions)[^/]*\.(md|markdown)$/i;

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
  return styleSections(text, (l) => STYLE_HEADING_RE.test(l))[0] ?? null;
}

/** Every substantial style section of `text` whose heading passes `isStyle`,
 * as 1-based [from, to] lines, in file order; a heading inside a section
 * already taken is part of it, not a section of its own. */
function styleSections(text: string, isStyle: (heading: string) => boolean): [number, number][] {
  const lines = text.split("\n");
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!HEADING_RE.test(l) || !isStyle(l)) continue;
    const level = /^#+/.exec(l)![0].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^(#{1,6})\s+\S/.exec(lines[j]!);
      if (m && m[1]!.length <= level) {
        end = j;
        break;
      }
    }
    // The span ends at its last non-blank line (a file's trailing newline too).
    while (end > i + 1 && lines[end - 1]!.trim() === "") end--;
    if (contentLines(lines.slice(i + 1, end).join("\n")) >= SECTION_MIN_LINES) {
      out.push([i + 1, end]);
      i = end - 1;
    }
  }
  return out;
}

const isDirectiveHeading = (l: string): boolean =>
  STYLE_HEADING_RE.test(l) || DIRECTIVE_HEADING_RE.test(l);

/** Style rules in the repo's agent-directive files, as references:
 * `path:from-to` per style section, `path` for a directive file whose name
 * says style. */
function directiveStyleRules(root: string): string[] {
  const files: string[] = [];
  for (const name of list(root)) if (ROOT_DIRECTIVE_RE.test(name)) files.push(name);
  for (const name of list(join(root, ".github")))
    if (/^copilot-instructions\.md$/i.test(name)) files.push(join(".github", name));
  for (const name of list(join(root, ".github", "instructions")))
    if (/\.(md|markdown)$/i.test(name)) files.push(join(".github", "instructions", name));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rel of files.sort()) {
    const path = join(root, rel);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const text = read(path);
    if (text === null) continue;
    if (rel.startsWith(".github/instructions/") && DIRECTIVE_NAME_RE.test(rel)) {
      if (contentLines(text) >= SECTION_MIN_LINES) out.push(rel);
      continue;
    }
    for (const [from, to] of styleSections(text, isDirectiveHeading))
      out.push(`${rel}:${from}-${to}`);
  }
  return out;
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
  out.push(...directiveStyleRules(root));
  return [...new Set(out)].sort();
}
