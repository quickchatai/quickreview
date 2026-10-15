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
//   - or style rules the repo wrote for its agents: a style section
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
import { isAbsolute, join, relative, sep } from "node:path";

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
 * section for the agent, not as a guide — or a section of written RULES
 * ("Rules", "Compliance"): what a team tells
 * its agents the code must follow is its written guide whatever the heading
 * says (repos commonly keep naming, header and formatting rules under a
 * heading such as "# Compliance Rules").
 * pass-style still applies only the style rules in it and still skips what a
 * configured tool enforces; the section only decides that the lens runs. */
const DIRECTIVE_HEADING_RE = /\b(style|conventions|formatting|naming|rules|compliance)\b/i;
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

/** Which lines sit inside a fenced code block (the fences included): a
 * `# comment` in a shell example is code, not a heading. A fence opens on
 * three or more backticks or tildes (indented at most three spaces) and
 * closes on a run of the same character at least as long; one left open runs
 * to the end of the file, as Markdown renders it. */
function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: { char: string; len: number } | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (m && !(m[1]![0] === "`" && m[2]!.includes("`")))
        open = { char: m[1]![0]!, len: m[1]!.length };
      out.push(open !== null);
    } else {
      out.push(true);
      if (m && m[1]![0] === open.char && m[1]!.length >= open.len && m[2]!.trim() === "")
        open = null;
    }
  }
  return out;
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
  const fenced = fencedLines(lines);
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (fenced[i] || !HEADING_RE.test(l) || !isStyle(l)) continue;
    const level = /^#+/.exec(l)![0].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const m = fenced[j] ? null : /^(#{1,6})\s+\S/.exec(lines[j]!);
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
 * says style. Over a listing: `identity` names the file a path really is, so a
 * directive file that links to another is read once; null = skip the path. */
function directiveStyleRules(
  listing: readonly string[],
  read: (rel: string) => string | null,
  identity: (rel: string) => string | null,
): string[] {
  const files = listing.filter((rel) => {
    const parts = rel.split("/");
    if (parts.length === 1) return ROOT_DIRECTIVE_RE.test(parts[0]!);
    if (parts.length === 2 && parts[0] === ".github")
      return /^copilot-instructions\.md$/i.test(parts[1]!);
    return (
      parts.length === 3 &&
      parts[0] === ".github" &&
      parts[1] === "instructions" &&
      /\.(md|markdown)$/i.test(parts[2]!)
    );
  });
  const named = (rel: string): boolean =>
    rel.startsWith(".github/instructions/") && DIRECTIVE_NAME_RE.test(rel);
  // A file named for style is read first, so an alias of it that sorts
  // earlier (base.md → code-style.instructions.md) cannot claim the file's
  // identity and read it by headings alone.
  const ordered = [...new Set(files)].sort(
    (a, b) => Number(named(b)) - Number(named(a)) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rel of ordered) {
    const real = identity(rel);
    if (real === null || seen.has(real)) continue;
    seen.add(real);
    const text = read(rel);
    if (text === null) continue;
    if (named(rel)) {
      if (contentLines(text) >= SECTION_MIN_LINES) out.push(rel);
      continue;
    }
    for (const [from, to] of styleSections(text, isDirectiveHeading))
      out.push(`${rel}:${from}-${to}`);
  }
  return out;
}

/**
 * The same rule over a FILE LISTING rather than a directory tree: the
 * setup engine reads the reviewed repo through a port, so it hands over the
 * repo-relative paths it has and a reader that answers null for anything it
 * cannot or will not read (a directory, a file over the size cap). The
 * candidates are exactly the ones `findStyleGuide` lists — the root, `docs/`,
 * `doc/`, `.github/`, and one level down under `docs/`/`doc/` by name only —
 * plus the agent-directive files — so both spellings return the same
 * references for the same tree. `identity` says which file a path really is
 * (findStyleGuide passes realpath); without one a directive file is known by
 * its text, so a link and its target — which read the same — count once.
 */
export function styleGuideRefsIn(
  files: readonly string[],
  read: (rel: string) => string | null,
  identity: (rel: string) => string | null = (rel) => {
    const text = read(rel);
    return text === null ? null : `text:${text}`;
  },
): string[] {
  const out: string[] = [];
  for (const rel of files) {
    const parts = rel.split("/");
    const name = parts[parts.length - 1] as string;
    const dir = parts.slice(0, -1).join("/");
    if (dir === "" || dir === "docs" || dir === "doc" || dir === ".github") {
      if (GUIDE_NAME_RE.test(name) || (dir !== "" && DOCS_NAME_RE.test(name))) {
        const text = read(rel);
        if (text !== null && contentLines(text) >= GUIDE_MIN_LINES) out.push(rel);
      } else if (CONTRIBUTING_RE.test(name)) {
        const text = read(rel);
        const sec = text === null ? null : styleSection(text);
        if (sec) out.push(`${rel}:${sec[0]}-${sec[1]}`);
      }
    } else if (parts.length === 3 && (parts[0] === "docs" || parts[0] === "doc")) {
      if (!DOCS_NAME_RE.test(name)) continue;
      const text = read(rel);
      if (text !== null && contentLines(text) >= GUIDE_MIN_LINES) out.push(rel);
    }
  }
  out.push(...directiveStyleRules(files, read, identity));
  return [...new Set(out)].sort();
}

/**
 * The repo's written style guide(s) under `root`, as repo-relative
 * references — `path` for a whole guide file, `path:from-to` for a style
 * section — or [] when there is none worth a lens.
 */
export function findStyleGuide(root: string): string[] {
  if (!existsSync(root)) return [];
  // Every path read here must RESOLVE inside the checkout: the tree is the
  // PR's, and a guide symlinked (or reached through a symlinked docs/) to a
  // file outside it — a secret the container can read — would be named in
  // the plan and read in full by pass-style. A link that stays inside is fine.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const inside = (rel: string): string | null => {
    try {
      const real = realpathSync(join(root, rel));
      const r = relative(realRoot, real);
      return r === "" || r.split(sep)[0] === ".." || isAbsolute(r) ? null : real;
    } catch {
      return null;
    }
  };
  const listing: string[] = [];
  for (const d of ["", "docs", "doc", ".github", ".github/instructions"]) {
    for (const name of list(join(root, d))) listing.push(relative(root, join(root, d, name)));
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
      for (const name of list(subdir)) listing.push(relative(root, join(subdir, name)));
    }
  }
  return styleGuideRefsIn(
    listing,
    (rel) => {
      const real = inside(rel);
      return real === null ? null : read(real);
    },
    inside,
  );
}
