// Post-approval delta recheck.
//
// Once a PR is approved, a later change can still regress it. A staleness
// check that re-reviews on every commit after the approval spends most of its
// output concluding nothing changed, so the delta is classified first, and
// the standing verdict is UPHELD BY DEFAULT.
//
// Shape of the mechanism:
//
//   trigger ──► planRecheck() ──► no-op (uphold, nothing posted, nothing spent)
//                             └─► one nudge to the PR's OWN sticky session
//
// Four triggers: a push after an approve, CI completing at the head, the base
// branch advancing, and an author reply. The author reply is deliberately a
// no-op HERE: `src/pingpong.ts` already owns that path (≤3 exchanges, reply +
// optional thread resolve) and a second reply handler would duplicate it.
// With no code delta there is nothing to recheck; the value is the reply,
// which is already owned.
//
// Invariants this module keeps structurally, not by prompting:
//
//  1. **Only APPROVE → REQUEST_CHANGES.** A recheck is planned only when the
//     standing verdict is APPROVE, and the decision file accepts exactly two
//     outcomes: `uphold` and `request_changes`. Anything else — including a
//     literal "APPROVE" or "NEEDS_HUMAN" — is coerced to `uphold` and logged.
//     The path can therefore never re-approve and never park.
//  2. **A trivial or empty delta costs one classification and a no-op.** That
//     is what makes the broad trigger set affordable. A base advance touching
//     no PR-owned file is the loudest instance and resolves to `empty-delta`.
//  3. **An unchanged head with no new evidence is a no-op** — the same rule
//     the gate's guard applies (`guards.hasNewEvidence`), read here off the
//     same single `reviewed_heads` mark. There is no second copy.
//  4. **Single shepherd.** The recheck is a nudge to the PR's existing `pr-<n>`
//     session — no new session, no lens fan-out, no round. It goes through
//     `wakeOrHold`, so a nudge arriving mid-round is held and flushed at round
//     end like any other wake.
//  5. **No GitHub write lives here.** The module reads (compare, files) and
//     writes nothing; the session posts its review through the gated scripts.
//     The MutationGate keeps its monopoly by this module having no mutation.
import { existsSync, mkdirSync, readdirSync, renameSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { readFindingsRecord } from "./findingsrecord.js";
import type { PrFileEntry } from "./github.js";
import { isMigrationPath } from "./heuristics.js";
import { applyEvent } from "./statemachine.js";
import type { StateStore } from "./state.js";
import { normalizeVerdict, recheckPromptMarker, stampPrompt } from "./types.js";
import { standingVerdict } from "./standing-review.js";
import { wakeOrHold, withRepoFacts } from "./wakes.js";
import {
  readSettledJson,
  resolvePartialWritePolicy,
  type PartialWritePolicy,
} from "./settledread.js";

/** What woke the recheck. `author_reply` is listed because it is a decided
 * trigger — its handling is "hand it to ping-pong and do nothing else". */
export type RecheckTrigger = "push" | "ci" | "base_advance" | "author_reply";

/** A changed file as the compare/files APIs report it. */
export type DeltaFile = PrFileEntry & { previous_filename?: string };

/** A file list as the adapter hands it over. `truncated` means GitHub's own
 * cap cut it short (a compare's 300 files, a PR's 3,000): the list is a
 * floor, and nothing may be concluded from a file's ABSENCE from it. */
export type DeltaList = readonly DeltaFile[] & { truncated?: boolean };

// ---- the ONE trivial-delta classifier ------------------------------------

/** Why a file was judged not worth re-reviewing. */
export type TrivialReason =
  | "base-merge"
  | "migration-renumber"
  | "pure-rename"
  | "version-bump"
  | "formatting"
  | "no-content-change";

export interface FileClass {
  filename: string;
  class: "trivial" | "significant";
  /** The trivial rule that fired, or "content" for a real change. */
  reason: TrivialReason | "content";
}

export type DeltaClass = "empty" | "trivial" | "significant";

export interface DeltaClassification {
  class: DeltaClass;
  files: FileClass[];
  /** The subset the session is actually asked to look at. */
  significant: FileClass[];
  /** The delta was cut short by GitHub — significant whatever it shows. */
  truncated?: true;
}

/** Dependency-manifest lockfiles: generated, never reviewed on their content. */
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
]);

/** Manifests whose version field moves on a release bump. */
const VERSION_MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "setup.cfg",
  "VERSION",
  "version.txt",
]);

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Split a migration filename into its number and the rest: `0042_add_foo.py`
 * → `{ num: "0042", rest: "add_foo.py" }`. Null when the file is not a
 * numbered migration.
 */
export function migrationName(path: string): { num: string; rest: string } | null {
  const m = /^(\d+)[_-](.+)$/.exec(baseName(path));
  if (!m || !isMigrationPath(path)) return null;
  return { num: m[1] as string, rest: m[2] as string };
}

/** A rename that only moves a migration's number: `0042_x.py` → `0043_x.py`. */
export function isMigrationRenumber(from: string, to: string): boolean {
  const a = migrationName(from);
  const b = migrationName(to);
  return a !== null && b !== null && a.rest === b.rest && a.num !== b.num;
}

/** One hunk of a unified diff: the text git prints after its `@@ … @@`
 * header (often the enclosing function or table) and its lines in order. */
interface Hunk {
  section: string;
  lines: Array<{ kind: " " | "+" | "-"; text: string }>;
}

/**
 * The hunks of a unified diff. File headers (`---`/`+++`) are recognised only
 * before the first hunk — inside one, `--- x` is a removed line that reads
 * `-- x`. A patch with no `@@` line is one hunk.
 */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      cur = { section: /^@@[^@]*@@ ?(.*)$/.exec(line)?.[1] ?? "", lines: [] };
      hunks.push(cur);
      continue;
    }
    if (cur === null && (line.startsWith("+++") || line.startsWith("---"))) continue;
    const kind = line.charAt(0);
    if (kind !== " " && kind !== "+" && kind !== "-") continue;
    if (cur === null) {
      cur = { section: "", lines: [] };
      hunks.push(cur);
    }
    cur.lines.push({ kind, text: line.slice(1) });
  }
  return hunks;
}

/** One change block: a maximal run of added/removed lines between context
 * lines. A line that moved across unchanged code lands in two blocks, so
 * comparing block by block keeps a reordering around unchanged statements
 * from reading as formatting. */
interface ChangeBlock {
  added: string[];
  removed: string[];
}

function changeBlocks(hunk: Hunk): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let cur: ChangeBlock | null = null;
  for (const line of hunk.lines) {
    if (line.kind === " ") {
      cur = null;
      continue;
    }
    if (cur === null) {
      cur = { added: [], removed: [] };
      blocks.push(cur);
    }
    (line.kind === "+" ? cur.added : cur.removed).push(line.text);
  }
  return blocks;
}

/** Every line of one kind in a patch, prefix kept — a whole added or removed
 * file's text. */
function changedLines(patch: string, kind: "+" | "-"): string[] {
  return parseHunks(patch).flatMap((h) =>
    h.lines.filter((l) => l.kind === kind).map((l) => `${kind}${l.text}`),
  );
}

/** A quoted literal on one line. Whitespace inside one is content, never
 * formatting: `"a b"` → `"ab"` changes the program. */
const QUOTED = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/;

/** Drop whitespace OUTSIDE quoted literals; the literals stay verbatim. */
function stripOutsideQuotes(line: string): string {
  return line
    .split(QUOTED)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+/g, "")))
    .join("");
}

/** Languages whose leading whitespace is syntax — a dedent in Python moves a
 * line out of its block; in YAML it moves a key to another mapping. */
function indentSignificant(path: string | undefined): boolean {
  if (!path) return false;
  const base = baseName(path);
  return /\.(py|pyi|ya?ml)$/i.test(base) || base === "Makefile" || /\.mk$/i.test(base);
}

/** Languages where a line break ends a command or statement — in a shell
 * script `a\n-b` runs two commands where `a -b` runs one; Ruby and Go end a
 * statement at most line breaks. */
function lineTerminated(path: string | undefined): boolean {
  if (!path) return false;
  const base = baseName(path);
  return /\.(sh|bash|zsh|ksh|rb|go)$/i.test(base) || base === "Dockerfile" || base === "Gemfile";
}

/**
 * The whitespace-insensitive form of a side of a patch. Whitespace between
 * tokens is dropped (quoted literals kept verbatim) and the lines are
 * concatenated, so a re-indent or a re-flow compares equal. For an
 * indentation-significant file each non-blank line keeps its leading
 * whitespace and stays its own line — a re-flow or re-indent there is not
 * provably meaningless, so it is not formatting. For a file whose line
 * breaks end statements each non-blank line stays its own line, so a re-flow
 * there is not formatting while a re-indent still is.
 */
function squash(lines: string[], path?: string): string {
  if (lineTerminated(path))
    return lines
      .filter((l) => l.trim() !== "")
      .map(stripOutsideQuotes)
      .join("\n");
  if (!indentSignificant(path)) return lines.map(stripOutsideQuotes).join("");
  return lines
    .filter((l) => l.trim() !== "")
    .map((l) => (/^\s*/.exec(l)?.[0] ?? "") + stripOutsideQuotes(l))
    .join("\n");
}

/**
 * The slash-span form of a side of a patch: on each line, the raw text from
 * its first `/` to its last is kept verbatim (delimited), and whitespace
 * elsewhere is dropped. A regex literal never crosses a line, so it always
 * lies inside its line's span; whitespace inside one is content (`/a b/` →
 * `/ab/` changes the program). Telling a regex from a division, a comment or
 * a markup closing tag is not attempted: any whitespace change between the
 * first and last `/` of a line is held significant, so this form can only
 * make a delta less trivial, never more.
 */
function slashSpans(lines: string[]): string {
  return lines
    .map((l) => {
      const i = l.indexOf("/");
      const j = l.lastIndexOf("/");
      if (i === j) return l.replace(/\s+/g, "");
      return `${l.slice(0, i).replace(/\s+/g, "")}\0${l.slice(i, j + 1)}\0${l.slice(j + 1).replace(/\s+/g, "")}`;
    })
    .join("");
}

/** The class of a character for token joining: two characters of one class
 * that whitespace separates would read as ONE token once it is dropped —
 * `const n` → `constn`, `a + ++b` → `a+++b` (the same as `a++ + b`). Null for
 * a character no neighbour joins with (brackets, separators, quotes). */
function joinClass(ch: string): "word" | "op" | null {
  if (/[\w$]/.test(ch) || ch.charCodeAt(0) > 127) return "word";
  if (/[+\-*/%&|^!~<>=?:.@#]/.test(ch)) return "op";
  return null;
}

/** A word after which a line break ends the statement (JavaScript's
 * restricted productions: `return\n(x)` returns undefined). Matched against
 * the last nine characters, one more than the longest word. */
const RESTRICTED_WORD_END = /(?:^|[^\w$])(?:return|throw|break|continue|yield|async)$/;

/**
 * The token-seam form of a side of a patch: whitespace outside quoted
 * literals is dropped EXCEPT where it separates two characters of one join
 * class, where it becomes a single space — or a line break, when the gap
 * holds one. Dropping that whitespace would merge two tokens into one
 * (`a + ++b` and `a++ + b` both squash to `a+++b`), so whether it is there is
 * content. A line break is also kept wherever it can end a statement however
 * the tokens join: after a restricted word (`return\n(x)`) and beside `++` or
 * `--` (`a++\nb` against `a\n++b`). Every line break kept is a `\n` the form
 * holds nowhere else, so compared beside `squash` this form can only make a
 * delta less trivial, never more.
 */
function tokenSeams(lines: string[]): string {
  let out = "";
  let gap = false;
  let lineBreak = false;
  const push = (text: string): void => {
    if (text === "") return;
    const prev = out.slice(-1);
    if (gap && prev !== "") {
      const cls = joinClass(prev);
      const seam = cls !== null && cls === joinClass(text.charAt(0));
      const ends =
        lineBreak &&
        (seam ||
          RESTRICTED_WORD_END.test(out.slice(-9)) ||
          /(?:\+\+|--)$/.test(out.slice(-2)) ||
          /^(?:\+\+|--)/.test(text));
      // A seam keeps its space and gains the break, so deleting every "\n"
      // gives back the form without breaks exactly — before and after
      // `maskSeams` — and the break form only ever refines it.
      if (seam) out += " ";
      if (ends) out += "\n";
    }
    out += text;
    gap = false;
    lineBreak = false;
  };
  for (const line of lines) {
    gap = true;
    lineBreak = true;
    line.split(QUOTED).forEach((part, i) => {
      if (i % 2 === 1) return push(part);
      part.split(/(\s+)/).forEach((chunk, k) => {
        if (k % 2 === 1) gap = true;
        else push(chunk);
      });
    });
  }
  return out;
}

/** Style sheets: whitespace between two selector tokens is a combinator
 * (`a .child` is a descendant, `a.child` a compound), so no whitespace that
 * separates two tokens there may vanish or appear, whatever their classes. */
function selectorWhitespace(path: string | undefined): boolean {
  return path !== undefined && /\.(css|scss|sass|less|styl)$/i.test(baseName(path));
}

/** Every whitespace run inside a line collapsed to one space and the lines
 * joined by one: a re-indent and a re-flow compare equal, a gap that opens or
 * closes between two tokens does not. */
function collapsed(lines: string[]): string {
  return lines
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l !== "")
    .join(" ");
}

/** A heredoc opener: `<<EOF`, `<<-'EOF'`, `<< "EOF"` (shell) and `<<~SQL`
 * (Ruby, no space — `a << b` appends). */
const SHELL_HEREDOC = /<<-?\s*(['"]?)[A-Za-z_]\w*\1/;
const RUBY_HEREDOC = /<<[-~]?(['"]?)[A-Za-z_]\w*\1/;
/** A YAML block scalar indicator closing its line (`key: |`, `- >-`). */
const YAML_BLOCK_SCALAR = /(?:^|:|-)\s*[|>][-+1-9]{0,2}\s*(?:#.*)?$/;

/**
 * May this hunk's changed lines sit inside a literal that spans lines — a
 * template literal, a triple-quoted string, a heredoc, a YAML block scalar?
 * Whitespace inside one is content, and the per-line `QUOTED` rule cannot see
 * a literal that opens or closes on another line. Judged from what the hunk
 * shows (its section text, its context and its changed lines): an unbalanced
 * backtick, any triple quote, or the language's own opener. A literal whose
 * delimiters both lie outside the hunk is beyond what the patch shows.
 */
function mayTouchMultilineLiteral(hunk: Hunk, path: string | undefined): boolean {
  const base = path === undefined ? "" : baseName(path);
  const shell = /\.(sh|bash|zsh|ksh)$/i.test(base) || base === "Dockerfile";
  const ruby = /\.rb$/i.test(base) || base === "Gemfile";
  const yaml = /\.ya?ml$/i.test(base);
  return [hunk.section, ...hunk.lines.map((l) => l.text)].some(
    (text) =>
      text.includes('"""') ||
      text.includes("'''") ||
      (text.replace(/\\./g, "").split("`").length - 1) % 2 === 1 ||
      (shell && SHELL_HEREDOC.test(text)) ||
      (ruby && RUBY_HEREDOC.test(text)) ||
      (yaml && YAML_BLOCK_SCALAR.test(text)),
  );
}

/**
 * One change block is whitespace-only: the added and removed text are
 * identical once insignificant whitespace is dropped (see `squash` — never
 * inside a quoted literal, never leading indentation of a
 * whitespace-significant language), and no line's whitespace changed between
 * its first and last `/` (see `slashSpans` — a regex literal's whitespace is
 * content), and no whitespace that separates two tokens appeared or vanished
 * (see `tokenSeams`; in a style sheet, `collapsed`).
 */
function sameModuloFormatting(block: ChangeBlock, path: string | undefined): boolean {
  const { added, removed } = block;
  if (selectorWhitespace(path) && collapsed(added) !== collapsed(removed)) return false;
  return (
    squash(added, path) === squash(removed, path) &&
    slashSpans(added) === slashSpans(removed) &&
    tokenSeams(added) === tokenSeams(removed)
  );
}

/**
 * Whitespace-only change, judged change block by change block (see
 * `changeBlocks`): within a block, concatenation (not a per-line set) is the
 * comparison, so a re-indent or a re-flow passes while a reordering of real
 * lines does not — and a line moved across unchanged code is two blocks that
 * each differ. A hunk that may touch a multi-line literal is never
 * formatting.
 */
export function formattingOnly(patch: string, path?: string): boolean {
  const hunks = parseHunks(patch);
  const blocks = hunks.flatMap(changeBlocks);
  if (blocks.length === 0) return false;
  if (hunks.some((h) => mayTouchMultilineLiteral(h, path))) return false;
  return blocks.every((b) => sameModuloFormatting(b, path));
}

/** A migration number: a digit run that starts a token and is followed by `_`
 * and a letter — the `NNNN_name` shape a migration filename or `dependencies`
 * entry carries. `1_000` (a numeric literal) is not one. */
const MIGRATION_NUMBER = /(?<![A-Za-z0-9_])\d+(?=_[A-Za-z])/g;

/** Same text once every MIGRATION-NUMBER run is masked — the renumber's
 * content edit (`dependencies = [("app", "0042_x")]` → `"0043_x"`) and nothing
 * else. Only the migration-number shape is masked (`MIGRATION_NUMBER`): a
 * semantic numeric change inside a renamed migration — a batch size, a
 * timeout, a default, `1_000` → `2_000` — does NOT mask away, so it
 * classifies significant. Judged block by block like `formattingOnly`; in a
 * hunk that may touch a multi-line literal the raw lines are compared, so only
 * the numbers may differ there. */
export function digitsOnly(patch: string, path?: string): boolean {
  const masked = (text: string): string => text.replace(MIGRATION_NUMBER, "#");
  return parseHunks(patch).every((hunk) => {
    const literal = mayTouchMultilineLiteral(hunk, path);
    return changeBlocks(hunk).every(({ added, removed }) =>
      literal
        ? masked(added.join("\n")) === masked(removed.join("\n"))
        : masked(squash(added, path)) === masked(squash(removed, path)) &&
          masked(slashSpans(added)) === masked(slashSpans(removed)) &&
          masked(tokenSeams(added)) === masked(tokenSeams(removed)),
    );
  });
}

/** One release-version line and nothing else on it: `"version": "1.2.3",`
 * (package.json) or `version = "1.2.3"` (pyproject/Cargo). The value must
 * look like a version — a digit first, no spaces — so the npm lifecycle
 * script `"version": "npm run build"` does not pass, and a line that merely
 * MENTIONS version (`serde = { version = "1", features = [...] }`, an inline
 * dependency with a `git` source) is not the key itself. */
const RELEASE_VERSION_LINE =
  /^\s*(?:"version"\s*:\s*"v?\d[^"\s]*"\s*,?|version\s*=\s*(?:"v?\d[^"\s]*"|'v?\d[^'\s]*'))\s*$/i;

/** A TOML table header line, its name with surrounding space dropped:
 * `[package]` → `package`; an array table (`[[bin]]`) keeps its brackets. */
const TOML_TABLE = /^\s*(\[?\[[^\]]+\]\]?)\s*(?:#.*)?$/;

/** The TOML tables whose `version` key is the package's own release. */
const RELEASE_TABLES = new Set(["package", "workspace.package", "project", "tool.poetry"]);

function tomlTable(text: string): string | null {
  const m = TOML_TABLE.exec(text);
  if (!m) return null;
  const header = m[1] as string;
  return header.startsWith("[[") ? header : header.slice(1, -1).replace(/\s+/g, "");
}

/** Every changed line is the release-version key itself — the release-bump
 * shape. In a TOML manifest the key must also sit in a release table
 * (`RELEASE_TABLES`) that the hunk shows: `version = "2"` under
 * `[dependencies.serde]` is a dependency requirement, and a line whose table
 * the patch does not show is not proven to be the release. */
export function versionOnly(patch: string, path?: string): boolean {
  const toml = path !== undefined && /\.toml$/i.test(path);
  let changed = 0;
  for (const hunk of parseHunks(patch)) {
    let table = tomlTable(hunk.section);
    for (const line of hunk.lines) {
      table = tomlTable(line.text) ?? table;
      if (line.kind === " ") continue;
      changed++;
      if (!RELEASE_VERSION_LINE.test(line.text)) return false;
      if (toml && (table === null || !RELEASE_TABLES.has(table))) return false;
    }
  }
  return changed > 0;
}

export interface ClassifyOpts {
  /**
   * Files this PR owns — its own diff against its base. A delta file outside
   * that set arrived from the base branch (a master pull, a conflict
   * resolution, a base advance) and is not this PR's to review: "later commits
   * on the base are not yours". Omitted ⇒ ownership is not consulted.
   */
  prFiles?: ReadonlySet<string>;
  /** Files hand-resolved inside a merge commit (their content differs from
   * git's own auto-merge of the parents). A clean base merge is trivial; a
   * conflict RESOLUTION is a human/agent decision and classifies significant
   * even outside prFiles: a resolution can silently drop the base's change. */
  resolvedFiles?: ReadonlySet<string>;
}

/** The PR's own files as an ownership set — or undefined, "ownership not
 * consulted", when the list was truncated: a PR-owned file past GitHub's cap
 * would otherwise read as a base-merge file, which is trivial. */
export function ownershipSet(own: DeltaList): Set<string> | undefined {
  if (own.truncated) return undefined;
  return new Set(
    own.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])),
  );
}

/** Classify one file. The rules are deliberately narrow: anything a rule does
 * not positively recognise is significant. */
export function classifyFile(file: DeltaFile, opts: ClassifyOpts = {}): FileClass {
  const name = file.filename;
  const trivial = (reason: TrivialReason): FileClass => ({
    filename: name,
    class: "trivial",
    reason,
  });

  // A hand-resolved merge conflict is never trivial, wherever the file lives.
  if (opts.resolvedFiles?.has(name))
    return { filename: name, class: "significant", reason: "content" };

  if (
    opts.prFiles &&
    !opts.prFiles.has(name) &&
    !(file.previous_filename && opts.prFiles.has(file.previous_filename))
  )
    return trivial("base-merge");

  const patch = file.patch ?? "";
  const churn = (file.additions ?? 0) + (file.deletions ?? 0);

  if (file.previous_filename && isMigrationRenumber(file.previous_filename, name)) {
    // A missing patch with churn (GitHub omits it on large files) proves
    // nothing — the same reading classifyDelta's delete+add pairing takes.
    if (churn === 0 || (patch && (digitsOnly(patch, name) || formattingOnly(patch, name))))
      return trivial("migration-renumber");
    return { filename: name, class: "significant", reason: "content" };
  }
  if (file.previous_filename && churn === 0) return trivial("pure-rename");

  if (LOCKFILES.has(baseName(name))) return trivial("version-bump");
  if (VERSION_MANIFESTS.has(baseName(name)) && patch && versionOnly(patch, name))
    return trivial("version-bump");

  if (patch && formattingOnly(patch, name)) return trivial("formatting");
  if (!patch && churn === 0) return trivial("no-content-change");

  return { filename: name, class: "significant", reason: "content" };
}

/**
 * Classify the whole delta. Run before the per-file pass: GitHub reports a
 * migration renumber as a rename only when it detects one — a large enough
 * content edit comes back as a delete + an add. That pair is a renumber only
 * when its content, too, differs by migration numbers alone (`digitsOnly`).
 */
export function classifyDelta(files: DeltaList, opts: ClassifyOpts = {}): DeltaClassification {
  const removedMigrations = new Map<string, DeltaFile>();
  for (const f of files) {
    if (f.status !== "removed") continue;
    const m = migrationName(f.filename);
    if (m) removedMigrations.set(m.rest, f);
  }
  const renumbered = new Set<string>();
  for (const f of files) {
    if (f.status !== "added") continue;
    const m = migrationName(f.filename);
    const partner = m ? removedMigrations.get(m.rest) : undefined;
    if (!m || !partner) continue;
    if (migrationName(partner.filename)?.num === m.num) continue;
    // The names only say it MIGHT be a renumber; the content must say it is.
    // GitHub reports a rename as delete + add exactly when similarity is low,
    // so the pair is trivial only when the removed file's text and the added
    // file's text differ by migration numbers alone. A missing patch (GitHub
    // omits it on large files) proves nothing, so it is not a renumber.
    if (!f.patch || !partner.patch) continue;
    const gone = changedLines(partner.patch, "-");
    const came = changedLines(f.patch, "+");
    if (gone.length === 0 && came.length === 0) continue;
    if (!digitsOnly(["@@", ...gone, ...came].join("\n"), f.filename)) continue;
    renumbered.add(f.filename);
    renumbered.add(partner.filename);
  }

  const classified = files.map((f): FileClass => {
    // A hand-resolved conflict beats every trivial rule, renumber included.
    if (opts.resolvedFiles?.has(f.filename))
      return { filename: f.filename, class: "significant", reason: "content" };
    if (renumbered.has(f.filename)) {
      // Ownership still wins: a migration that arrived with the base is a
      // base-merge file whatever its number does.
      const owned = !opts.prFiles || opts.prFiles.has(f.filename);
      return {
        filename: f.filename,
        class: "trivial",
        reason: owned ? "migration-renumber" : "base-merge",
      };
    }
    return classifyFile(f, opts);
  });
  const significant = classified.filter((f) => f.class === "significant");
  // A truncated delta is significant by construction: the files GitHub did not
  // return may be exactly the PR-owned edit, and "all visible files trivial"
  // says nothing about them.
  if (files.truncated)
    return { class: "significant", files: classified, significant, truncated: true };
  const cls: DeltaClass =
    classified.length === 0 ? "empty" : significant.length > 0 ? "significant" : "trivial";
  return { class: cls, files: classified, significant };
}

// ---- the plan -------------------------------------------------------------

/** Why a trigger did not produce a nudge. Every one of these upholds the
 * standing verdict — that is the default, not an outcome. */
export type NoopReason =
  | "disabled"
  | "pingpong-owns-reply"
  | "no-standing-approval"
  | "pr-not-open"
  | "unchanged-head"
  | "empty-delta"
  | "trivial-delta"
  | "already-rechecked"
  | "no-delta-source"
  | "delivery-failed"
  /** Deploy-window drain: no nudge is generated while draining. */
  | "draining";

export interface RecheckPlanInput {
  trigger: RecheckTrigger;
  /** The verdict standing at `last_reviewed_sha` (the reviewed-head mark). */
  standing: string | null | undefined;
  last_reviewed_sha: string;
  head_sha: string;
  delta: DeltaList;
  /** The PR's own changed files (ownership, see ClassifyOpts.prFiles). */
  prFiles?: readonly string[];
  /** Hand-resolved merge files (see ClassifyOpts.resolvedFiles). */
  resolvedFiles?: readonly string[];
  /** CI conclusion for the `ci` trigger, as GitHub spells it. */
  ci?: { conclusion: string | null };
}

export type RecheckPlan =
  | { action: "noop"; reason: NoopReason; class: DeltaClass; classification?: DeltaClassification }
  | { action: "recheck"; class: DeltaClass; evidence: string; classification: DeltaClassification };

/** CI conclusions that carry no bad news. Anything else at an approved head is
 * new evidence (guard 2's sense): something the standing review did not see. */
const CI_BENIGN = new Set(["success", "neutral", "skipped", "cancelled", "stale"]);

export function ciIsAdverse(conclusion: string | null | undefined): boolean {
  if (!conclusion) return false;
  return !CI_BENIGN.has(conclusion.toLowerCase());
}

/** Move a withheld-approval mark to a newer head after an uphold. This is NOT
 * a re-approve — the approval was never posted; the CI-gate retry still
 * demands green CI at the new head before anything posts. No mark, or a mark
 * already at this head, is a silent no-op. */
export function carryWithheldMark(
  store: StateStore,
  pr: number,
  newHead: string,
  via: string,
  log: (msg: string) => void = () => {},
): void {
  const withheld = store.approvalWithheld(pr);
  if (!withheld || withheld.head_sha === newHead) return;
  // Only ever carry TO the PR's current head. Overlapping rechecks finish in
  // any order: an older push's handler finishing after the newer one's would
  // otherwise carry the mark BACK, and the ci_completed retry at the real head
  // then no-ops on "head-moved" with the push backstop already claimed —
  // stranded. Read and write are one synchronous stretch, so nothing can
  // interleave between them.
  const current = store.getPr(pr)?.head_sha;
  if (current && current !== newHead) {
    store.logEvent("approval_withheld_carry_stale", pr, {
      from: withheld.head_sha,
      to: newHead,
      current,
      via,
    });
    log(
      `recheck: #${pr} withheld approval NOT carried to ${newHead.slice(0, 7)} — the PR is at ${current.slice(0, 7)} (${via})`,
    );
    return;
  }
  // The classifier verdict that caused the withhold rides along with the
  // mark — the carried head has no fresher CI read to offer, and the CI-gate
  // retry re-classifies at release time anyway.
  store.recordApprovalWithheld(pr, {
    head_sha: newHead,
    ci_state: withheld.ci_state ?? null,
    reason: withheld.reason ?? "red-ci",
  });
  store.logEvent("approval_withheld_carried", pr, { from: withheld.head_sha, to: newHead, via });
  log(
    `recheck: #${pr} withheld approval carried ${withheld.head_sha.slice(0, 7)} → ${newHead.slice(0, 7)} (${via})`,
  );
}

/**
 * The whole decision, pure. Order matters: the cheap structural refusals come
 * before anything that would cost a classification, and the classification
 * comes before anything that would cost a session turn.
 */
export function planRecheck(input: RecheckPlanInput): RecheckPlan {
  const noop = (reason: NoopReason, classification?: DeltaClassification): RecheckPlan => ({
    action: "noop",
    reason,
    class: classification?.class ?? "empty",
    ...(classification ? { classification } : {}),
  });

  // The author-reply trigger is owned end to end by src/pingpong.ts. Nothing
  // to recheck without a code delta, and a second reply handler would
  // duplicate it.
  if (input.trigger === "author_reply") return noop("pingpong-owns-reply");

  // Only a standing APPROVE can be moved by this path, and only downwards.
  // Everything else (REQUEST_CHANGES, NEEDS_HUMAN, never reviewed) already has
  // a route: the ordinary trigger → round path.
  if (normalizeVerdict(input.standing) !== "APPROVE") return noop("no-standing-approval");

  const adverseCi = input.trigger === "ci" && ciIsAdverse(input.ci?.conclusion);
  // Guard 2's rule, read off the same mark: same head, nothing new ⇒ nothing
  // to do. A base advance is exempt because its delta is on the base side, and
  // an adverse CI conclusion IS the new evidence.
  if (input.trigger !== "base_advance" && input.head_sha === input.last_reviewed_sha && !adverseCi)
    return noop("unchanged-head");

  const classification = classifyDelta(input.delta, {
    ...(input.prFiles ? { prFiles: new Set(input.prFiles) } : {}),
    ...(input.resolvedFiles ? { resolvedFiles: new Set(input.resolvedFiles) } : {}),
  });
  if (adverseCi)
    return {
      action: "recheck",
      class: classification.class,
      evidence: `CI concluded ${input.ci?.conclusion}`,
      classification,
    };
  if (classification.class === "empty") return noop("empty-delta", classification);
  if (classification.class === "trivial") return noop("trivial-delta", classification);
  return {
    action: "recheck",
    class: classification.class,
    evidence: classification.truncated
      ? `GitHub truncated the delta at ${classification.files.length} file(s) — the unseen remainder may hold changes this review has not seen`
      : `${classification.significant.length} changed file(s) this review has not seen`,
    classification,
  };
}

// ---- the order handed to the session --------------------------------------

/** The recheck's own order kind — deliberately NOT a RoundOrder: no round is
 * started, no pass plan exists, and the session is asked one question. */
export interface RecheckOrder {
  pr: number;
  title: string;
  trigger: RecheckTrigger;
  /** Always APPROVE — the only standing verdict this path can act on. */
  standing_verdict: "APPROVE";
  last_reviewed_sha: string;
  head_sha: string;
  worktree: string;
  evidence: string;
  files: FileClass[];
  /** Files hand-resolved inside merge commits of this delta — the session
   * must audit each against BOTH merge parents. */
  resolved_files: string[];
  /** Relative name of the decision file the session must write. */
  decision_file: string;
  issued_at: string;
}

/** `verdict/pr-<n>-recheck-<head12>.json`. */
export function recheckDecisionFile(pr: number, headSha: string): string {
  return `pr-${pr}-recheck-${headSha.slice(0, 12).toLowerCase()}.json`;
}

export const RECHECK_FILE_RE = /^pr-(\d+)-recheck-([0-9a-f]{7,40})\.json$/i;

/** The runaway-guard identity of one recheck question: (trigger, head, ci
 * conclusion, base target). Shared by runRecheck's claim and the reconcile
 * backstop's has-this-been-asked check. */
export function recheckFingerprint(
  req: {
    trigger: RecheckTrigger;
    head_sha?: string;
    ci?: { conclusion?: string | null } | null;
    base?: { after?: string } | null;
  },
  headOverride?: string,
): string {
  const head = headOverride ?? req.head_sha ?? "";
  return [req.trigger, head, req.ci?.conclusion ?? "", req.base?.after ?? ""].join(":");
}

/** Fallback renderer (stub-wired daemon, unit tests): the order as JSON. */
export function defaultRecheckPrompt(order: RecheckOrder): string {
  return JSON.stringify(order, null, 2);
}

// ---- the runner -----------------------------------------------------------

/** Read-only adapter slice. Every call here is a GET; this module never writes
 * to GitHub, so no mutation can escape the gate through it. */
export interface RecheckAdapter {
  getPr(n: number): Promise<{
    base_ref: string;
    head_sha: string;
    state: string;
    merged: boolean;
    title?: string;
  }>;
  listPrFiles(n: number): Promise<DeltaList>;
  /** `GET /compare/<base>...<head>` — the files a range changed. */
  compareFiles(base: string, head: string): Promise<DeltaList>;
}

export interface RecheckDeps {
  cfg: Config;
  store: StateStore;
  /** Partial: a daemon wired without the compare read simply never rechecks
   * (logged). */
  adapter: Partial<RecheckAdapter>;
  /** SessionHooks.inject — the nudge goes to the PR's existing session. */
  inject: (pr: number, message: string) => Promise<void>;
  renderPrompt?: (order: RecheckOrder) => string;
  /**
   * The repo-fact lessons for the delta's files (src/lessonselect.ts
   * `repoFacts`), rendered as a section APPENDED to the
   * nudge — "" unless `[memory] delivery = "on"`, so the nudge is otherwise
   * byte-identical. Bounded by the lesson prefetch's budget; a throw or a
   * rejection is "" (the nudge goes out without it).
   */
  repoFacts?: (q: {
    pr: number;
    title: string;
    paths: readonly string[];
    head_sha: string;
    purpose: "recheck";
  }) => Promise<string>;
  worktreeFor?: (pr: number) => string;
  /** Hand-resolved merge files between two shas (WorktreeManager
   * .resolvedFilesInMerges, wired by the daemon). Absent ⇒ merges classify by
   * the ownership rule alone. */
  resolvedFilesInMerges?: (
    from: string,
    to: string,
    pr?: number,
  ) => Promise<{ files: string[]; degraded: boolean }>;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export interface RecheckRequest {
  pr: number;
  trigger: RecheckTrigger;
  /** The head the trigger is about; defaults to the PR row's head. */
  head_sha?: string;
  ci?: { conclusion: string | null };
  /** The base advance: which branch moved, and between which shas. */
  base?: { branch: string; before: string; after: string };
}

export type RecheckOutcome = RecheckPlan & {
  delivered?: "injected" | "held";
  order?: RecheckOrder;
};

/**
 * The files the PR owns for delta classification: what it owns at the current
 * head PLUS what it owned at the REVIEWED head. A push that
 * restores a reviewed file to its base content drops it from the current diff,
 * yet that is the PR undoing its own reviewed change, not a base merge. The
 * second read happens only when a delta file falls outside today's ownership:
 * `<base_ref>...<reviewed>` is the PR's own diff at the reviewed head. Throws
 * on a read failure — every caller already treats that as "not trivial".
 */
export async function reviewedOwnership(
  adapter: {
    getPr?(n: number): Promise<{ base_ref: string }>;
    compareFiles?(base: string, head: string): Promise<DeltaList>;
  },
  pr: number,
  reviewedHead: string,
  delta: readonly DeltaFile[],
  ownedNow: ReadonlySet<string> | undefined,
): Promise<Set<string> | undefined> {
  // Unknown ownership (a truncated listing) stays unknown.
  if (!ownedNow) return undefined;
  const unowned = delta.some(
    (f) => !ownedNow.has(f.filename) && !(f.previous_filename && ownedNow.has(f.previous_filename)),
  );
  if (!unowned || !adapter.getPr || !adapter.compareFiles) return new Set(ownedNow);
  const { base_ref } = await adapter.getPr(pr);
  if (!base_ref) return new Set(ownedNow);
  const then = ownershipSet(await adapter.compareFiles(base_ref, reviewedHead));
  return then ? new Set([...ownedNow, ...then]) : undefined;
}

/**
 * One trigger, start to finish. Returns the plan so callers (and tests) can see
 * exactly why a trigger cost nothing.
 */
export async function runRecheck(deps: RecheckDeps, req: RecheckRequest): Promise<RecheckOutcome> {
  const { cfg, store } = deps;
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): Date => new Date());

  const done = (plan: RecheckPlan): RecheckOutcome => {
    if (plan.action === "noop")
      store.logEvent("recheck_noop", req.pr, {
        trigger: req.trigger,
        reason: plan.reason,
        delta_class: plan.class,
        files: plan.classification?.files.map((f) => `${f.filename} (${f.reason})`) ?? [],
      });
    return plan;
  };

  // Deploy-window drain: generate no recheck nudge at all —
  // prefer not creating work over hold-then-flush, because the session the
  // nudge would wake is about to be killed by the deploy. The reconcile
  // push-backstop re-raises the trigger after the lift.
  if (store.drainState().draining)
    return done({ action: "noop", reason: "draining", class: "empty" });

  if (!cfg.recheck.enabled || !triggerEnabled(cfg, req.trigger))
    return done({ action: "noop", reason: "disabled", class: "empty" });
  // Cheapest refusal first: ping-pong owns the author reply.
  if (req.trigger === "author_reply")
    return done(planRecheck({ ...emptyPlanInput(req), standing: "APPROVE" }));

  const mark = store.reviewedHead(req.pr);
  if (standingVerdict(mark) !== "APPROVE")
    return done({ action: "noop", reason: "no-standing-approval", class: "empty" });

  const row = store.getPr(req.pr);
  if (!row || row.state === "closed")
    return done({ action: "noop", reason: "pr-not-open", class: "empty" });

  const head = req.head_sha || row.head_sha;
  const lastReviewed = mark!.head_sha;
  const adverseCi = req.trigger === "ci" && ciIsAdverse(req.ci?.conclusion);
  // Refuse before spending a single API call on a head we already decided.
  if (req.trigger !== "base_advance" && head === lastReviewed && !adverseCi)
    return done({ action: "noop", reason: "unchanged-head", class: "empty" });

  if (!deps.adapter.compareFiles || !deps.adapter.listPrFiles)
    return done({ action: "noop", reason: "no-delta-source", class: "empty" });

  let delta: DeltaList;
  let prFiles: Set<string> | undefined;
  try {
    delta =
      req.trigger === "base_advance" && req.base
        ? await deps.adapter.compareFiles(req.base.before, req.base.after)
        : await deps.adapter.compareFiles(lastReviewed, head);
    prFiles = ownershipSet(await deps.adapter.listPrFiles(req.pr));
    // Ownership is the union of the reviewed head's and the current head's —
    // see reviewedOwnership. A base advance leaves the
    // head where it was reviewed, so there is nothing to revert. A truncated
    // listing leaves ownership unknown (undefined): every delta file is then
    // significant.
    if (req.trigger !== "base_advance")
      prFiles = await reviewedOwnership(deps.adapter, req.pr, lastReviewed, delta, prFiles);
  } catch (err) {
    // A read failure is not evidence of anything. Uphold and log: the reconcile
    // poll and the next trigger both come round again.
    log(`recheck: #${req.pr} delta read failed`, err);
    store.logEvent("recheck_delta_failed", req.pr, { trigger: req.trigger, error: String(err) });
    // Durable anomaly row, quiet class: DB-only, reviewed at the daily
    // heartbeat — the reconcile poll retries this on its own.
    store.logAnomaly(
      "recheck_delta_failed",
      req.pr,
      null,
      `delta read failed (${req.trigger}): ${String(err)}`,
    );
    return done({ action: "noop", reason: "no-delta-source", class: "empty" });
  }

  // Conflict resolutions are never trivial: ask git which files in this
  // delta's merges were hand-resolved. Degraded/unknown classifies merges by
  // the ownership rule alone, but is LOGGED — never silently quieter.
  let resolvedFiles: string[] = [];
  if (deps.resolvedFilesInMerges) {
    const from = req.trigger === "base_advance" && req.base ? req.base.before : lastReviewed;
    const to = req.trigger === "base_advance" && req.base ? req.base.after : head;
    const res = await deps.resolvedFilesInMerges(from, to, req.pr);
    resolvedFiles = res.files;
    if (res.degraded) {
      store.logEvent("recheck_merge_verify_degraded", req.pr, { from, to });
      // Durable anomaly record: a degraded check is never silently quieter,
      // and never unqueryable.
      store.logAnomaly(
        "recheck_merge_verify_degraded",
        req.pr,
        null,
        `merge-verify degraded ${from.slice(0, 7)}→${to.slice(0, 7)} — prior (delta-only) classification kept`,
      );
    }
  }

  const plan = planRecheck({
    trigger: req.trigger,
    standing: standingVerdict(mark),
    last_reviewed_sha: lastReviewed,
    head_sha: head,
    delta,
    ...(prFiles ? { prFiles: [...prFiles] } : {}),
    resolvedFiles,
    ...(req.ci ? { ci: req.ci } : {}),
  });
  // Carry-forward: a withheld approval pinned to an old sha would be stranded
  // — the retry no-ops on "head-moved", and the recheck can never approve.
  // When the delta itself upholds (empty/trivial), the never-posted approval
  // moves with the head, so green CI at the NEW head releases it. A
  // significant delta carries only after the session's explicit uphold
  // (watcher below).
  if (plan.action === "noop") {
    if (
      (plan.reason === "empty-delta" || plan.reason === "trivial-delta") &&
      head !== lastReviewed
    ) {
      carryWithheldMark(store, req.pr, head, `recheck-noop:${plan.reason}`, log);
      // A trivial/empty answer is terminal for this head: claim it, so the
      // reconcile backstop (below in reconcile.ts) never re-classifies the
      // same question every sweep. No wake goes out, so no receipt token can
      // ever exist for it: `nudge: false` keeps the undelivered sweep from
      // reading its absence as a lost nudge and releasing it.
      store.claimRecheck(req.pr, recheckFingerprint(req, head), {
        head_sha: head,
        trigger: req.trigger,
        reason: `noop:${plan.reason}`,
        nudge: false,
      });
    }
    return done(plan);
  }

  // The runaway guard: one nudge per (trigger, head, evidence). Without it a
  // reconcile replay or a redelivered webhook re-asks the same question and
  // pays for it every time.
  const fingerprint = recheckFingerprint(req, head);
  if (
    !store.claimRecheck(req.pr, fingerprint, {
      head_sha: head,
      trigger: req.trigger,
      reason: plan.evidence,
    })
  )
    return done({
      action: "noop",
      reason: "already-rechecked",
      class: plan.class,
      classification: plan.classification,
    });

  const order: RecheckOrder = {
    pr: req.pr,
    title: row.title,
    trigger: req.trigger,
    standing_verdict: "APPROVE",
    last_reviewed_sha: lastReviewed,
    head_sha: head,
    worktree: (deps.worktreeFor ?? ((n: number): string => `wt/pr-${n}`))(req.pr),
    evidence: plan.evidence,
    files: plan.classification.files,
    resolved_files: resolvedFiles,
    decision_file: recheckDecisionFile(req.pr, head),
    issued_at: now().toISOString(),
  };
  const render = deps.renderPrompt ?? defaultRecheckPrompt;
  // The repo facts for the files the session must review
  // (the significant ones; every delta file when none is) — "" unless
  // lessons are delivered. Bounded and total: never a reason to hold or lose
  // the nudge.
  let facts = "";
  if (deps.repoFacts) {
    const touched = plan.classification.significant.length
      ? plan.classification.significant.map((f) => f.filename)
      : plan.classification.files.map((f) => f.filename);
    try {
      facts = await deps.repoFacts({
        pr: req.pr,
        title: row.title,
        paths: touched,
        head_sha: head,
        purpose: "recheck",
      });
    } catch (err) {
      log(`recheck: #${req.pr} repo facts unavailable (ignored)`, err);
      facts = "";
    }
    if (typeof facts !== "string") facts = "";
  }
  // Mid-round nudges are held and flushed at round end — the PR's one main
  // pi is never given two instructions at once.
  let delivered: "injected" | "held";
  try {
    delivered = await wakeOrHold(
      { store, inject: deps.inject, log },
      req.pr,
      // The receipt token. A recheck claim is written BEFORE the nudge goes
      // out and released only on a synchronous throw — which a bridge-level
      // drop is not — so the receipt is what lets the reconcile sweep release
      // the claim of a nudge that never arrived.
      stampPrompt(
        withRepoFacts(render(order), facts),
        recheckPromptMarker(req.pr, fingerprint),
      ),
      `recheck:${req.trigger}`,
    );
  } catch (err) {
    // A claim must not outlive a nudge that never reached the session — the
    // fingerprint would otherwise dedupe every retry and the delta is never
    // audited.
    store.releaseRecheck(req.pr, fingerprint);
    store.logEvent("recheck_delivery_failed", req.pr, {
      trigger: req.trigger,
      head_sha: head,
      error: String(err),
    });
    log(`recheck: #${req.pr} delivery failed — claim released for retry`, err);
    return done({
      action: "noop",
      reason: "delivery-failed",
      class: plan.class,
      classification: plan.classification,
    });
  }
  store.logEvent("recheck_nudged", req.pr, {
    trigger: req.trigger,
    head_sha: head,
    last_reviewed_sha: lastReviewed,
    delta_class: plan.class,
    significant: plan.classification.significant.map((f) => f.filename),
    evidence: plan.evidence,
    delivered,
  });
  log(
    `recheck: #${req.pr} nudged (${req.trigger}, ${plan.classification.significant.length} file(s)) — ${delivered}`,
  );
  return { ...plan, delivered, order };
}

function triggerEnabled(cfg: Config, trigger: RecheckTrigger): boolean {
  switch (trigger) {
    case "push":
      return cfg.recheck.on_push;
    case "ci":
      return cfg.recheck.on_ci;
    case "base_advance":
      return cfg.recheck.on_base_advance;
    case "author_reply":
      return true; // always reaches the ping-pong no-op
  }
}

function emptyPlanInput(req: RecheckRequest): RecheckPlanInput {
  return {
    trigger: req.trigger,
    standing: null,
    last_reviewed_sha: "",
    head_sha: req.head_sha ?? "",
    delta: [],
  };
}

/**
 * A base branch moved: fan the advance out to the PRs that target it and hold
 * a standing approval. Every other PR is skipped without an API call.
 */
export async function runBaseAdvance(
  deps: RecheckDeps,
  advance: { branch: string; before: string; after: string },
): Promise<Map<number, RecheckOutcome>> {
  const out = new Map<number, RecheckOutcome>();
  const log = deps.log ?? ((): void => {});
  if (!deps.cfg.recheck.enabled || !deps.cfg.recheck.on_base_advance) return out;
  // Deploy-window drain: skip the whole fan-out before it spends per-PR API
  // calls (runRecheck would refuse each one anyway).
  if (deps.store.drainState().draining) return out;
  for (const row of deps.store.allPrs()) {
    if (row.state === "closed") continue;
    if (standingVerdict(deps.store.reviewedHead(row.number)) !== "APPROVE") continue;
    if (deps.adapter.getPr) {
      try {
        // Called on the adapter, never through a detached reference: the real
        // GitHubAdapter's methods are class methods and need their `this`.
        const ref = await deps.adapter.getPr(row.number);
        if (ref.base_ref && ref.base_ref !== advance.branch) continue;
      } catch (err) {
        log(`recheck: #${row.number} base ref lookup failed`, err);
        continue;
      }
    }
    out.set(
      row.number,
      await runRecheck(deps, { pr: row.number, trigger: "base_advance", base: advance }),
    );
  }
  return out;
}

// ---- the decision file ----------------------------------------------------

/**
 * The session's answer. Two outcomes only — this is where invariant 1 lives.
 * `uphold` posts nothing at all; `request_changes` means the session has
 * posted its review through the gated scripts and the daemon moves the PR to
 * awaiting_author.
 */
export interface RecheckDecision {
  pr: number;
  head_sha: string;
  outcome: "uphold" | "request_changes";
  reason?: string;
}

export interface ParsedRecheckDecision {
  ok: boolean;
  decision?: RecheckDecision;
  error?: string;
  /** An outcome that was not one of the two, folded to `uphold`. */
  coerced?: string;
}

export function validateRecheckDecision(raw: unknown): ParsedRecheckDecision {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const v = raw as Record<string, unknown>;
  if (typeof v.pr === "string" && /^\d+$/.test(v.pr)) v.pr = Number(v.pr);
  if (typeof v.pr !== "number" || !Number.isInteger(v.pr))
    return { ok: false, error: "pr must be an integer" };
  if (typeof v.head_sha !== "string" || v.head_sha.length === 0)
    return { ok: false, error: "head_sha must be a non-empty string" };
  const raw_outcome = typeof v.outcome === "string" ? v.outcome.trim().toLowerCase() : "";
  // NOT a rejection: an unrecognised outcome (including "approve" and
  // "needs_human", which a session may reach for out of round habit) becomes
  // the default — uphold. The recheck path has no other verdict to give.
  const coerced =
    raw_outcome === "uphold" || raw_outcome === "request_changes"
      ? undefined
      : String(v.outcome ?? "");
  const outcome: RecheckDecision["outcome"] =
    raw_outcome === "request_changes" ? "request_changes" : "uphold";
  return {
    ok: true,
    decision: {
      pr: v.pr,
      head_sha: v.head_sha,
      outcome,
      ...(typeof v.reason === "string" ? { reason: v.reason.trim().slice(0, 800) } : {}),
    },
    ...(coerced !== undefined ? { coerced } : {}),
  };
}

export interface RecheckWatcherDeps {
  cfg: Config;
  store: StateStore;
  verdictDir: string;
  /** Ledger freshness enforcement, run after an uphold — the session just
   * examined a significant delta, so its ledger should name the upheld head.
   * Optional: absent (stubs, tests) ⇒ no check. Best-effort — never allowed
   * to disturb the decision (the caller wraps it). */
  checkLedger?: (pr: number, headSha: string) => Promise<void>;
  /**
   * Where the session writes reasoning records — `<root>/state/findings`. A
   * recheck that MOVES the verdict posts real findings, and "how often the
   * review backs down" counts those too, so its record is parsed into the
   * same rows.
   *
   * Deliberately weaker than the round path: read-if-present, never a nudge
   * and never an anomaly. A recheck has no round row and no deadline
   * underneath it, so a claim-then-nudge here would have nothing to bound it.
   * Absent ⇒ nothing happens.
   */
  findingsDir?: string;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  /** Partial-write tolerance (`src/settledread.ts`) — fs.watch
   * fires on creation, before the session's write completes; the same race,
   * and the same reader, as the VerdictWatcher's. `{ windowMs: 0 }` makes one
   * read decide (tests). */
  partialWrite?: Partial<PartialWritePolicy>;
}

/**
 * Consumes `verdict/pr-<n>-recheck-<head12>.json`. It touches GitHub not at
 * all: on `uphold` there is nothing to say, and on `request_changes` the
 * session has already posted the review through the gated scripts — the daemon
 * only moves the lifecycle state.
 *
 * Neither outcome moves the reviewed-head mark. The mark records what was
 * really REVIEWED and posted; an upheld recheck posted nothing, and stamping
 * it would make the no-new-evidence guard swallow a genuine review
 * re-request at that head. The recheck's own runaway guard is the `rechecks`
 * claim table instead.
 */
export class RecheckWatcher {
  private watcher: FSWatcher | null = null;
  private readonly inFlight = new Set<string>();
  private readonly processedDir: string;

  constructor(private readonly deps: RecheckWatcherDeps) {
    this.processedDir = join(deps.verdictDir, "processed");
  }

  start(): void {
    mkdirSync(this.deps.verdictDir, { recursive: true });
    void this.sweep();
    this.watcher = watch(this.deps.verdictDir, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (RECHECK_FILE_RE.test(name)) void this.handleFile(name);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** One PR's decisions in name order, different PRs side by side: a file
   * still being written is waited out for seconds and must not
   * hold another PR's decision behind it. */
  async sweep(): Promise<string[]> {
    if (!existsSync(this.deps.verdictDir)) return [];
    const byPr = new Map<string, string[]>();
    for (const name of readdirSync(this.deps.verdictDir).sort()) {
      const match = RECHECK_FILE_RE.exec(name);
      if (!match) continue;
      byPr.set(match[1]!, [...(byPr.get(match[1]!) ?? []), name]);
    }
    const done: string[] = [];
    await Promise.all(
      [...byPr.values()].map(async (names) => {
        for (const name of names) if (await this.handleFile(name)) done.push(name);
      }),
    );
    return done.sort();
  }

  private archive(name: string): void {
    mkdirSync(this.processedDir, { recursive: true });
    const ts = (this.deps.now ?? ((): Date => new Date()))().toISOString().replace(/[:.]/g, "-");
    try {
      renameSync(join(this.deps.verdictDir, name), join(this.processedDir, `${ts}-${name}`));
    } catch (err) {
      this.deps.log?.(`recheck: could not archive ${name}`, err);
    }
  }

  /**
   * Parse `state/findings/pr-<n>-recheck-<head12>.json` into `round_findings`.
   *
   * A recheck owns no round row, so its entries are attributed to the round
   * whose verdict it just moved — the PR's reviewed-head mark, falling back to
   * its highest round number. Keys are prefixed `recheck:<head12>:` so a
   * recheck's rows can never collide with that round's own.
   */
  private async recordRecheckFindings(pr: number, headSha: string): Promise<void> {
    const dir = this.deps.findingsDir;
    if (!dir) return;
    try {
      const head12 = headSha.slice(0, 12).toLowerCase();
      const path = join(dir, `pr-${pr}-recheck-${head12}.json`);
      const store = this.deps.store;
      const roundNo =
        store.reviewedHead(pr)?.round_no ??
        store.roundsFor(pr).reduce<number>((m, r) => (r.round_no > m ? r.round_no : m), 0);
      const parsed = readFindingsRecord(path, pr, roundNo);
      if (parsed.status !== "ok" || !parsed.record) {
        store.logEvent("recheck_findings_record_absent", pr, {
          head_sha: headSha,
          status: parsed.status,
        });
        this.deps.log?.(
          `recheck: #${pr} moved the verdict with no findings record (${parsed.status}) — decision stands`,
        );
        return;
      }
      const entries = parsed.record.findings.map((f) => ({
        ...f,
        key: `recheck:${head12}:${f.key}`,
      }));
      store.recordRoundFindings(
        { pr, round_id: null, round_no: roundNo, head_sha: headSha },
        entries,
      );
      store.logEvent("recheck_findings_recorded", pr, {
        head_sha: headSha,
        round_no: roundNo,
        entries: entries.length,
      });
    } catch (err) {
      this.deps.log?.(`recheck: #${pr} findings record read failed`, err);
    }
  }

  async handleFile(name: string): Promise<boolean> {
    const match = RECHECK_FILE_RE.exec(name);
    if (!match || this.inFlight.has(name)) return false;
    this.inFlight.add(name);
    try {
      const path = join(this.deps.verdictDir, name);
      if (!existsSync(path)) return false;
      const pr = Number(match[1]);
      // fs.watch fires the moment the file appears, often before the
      // session's write completes, so a single eager read would discard valid
      // decisions as "unparseable". An unparseable file is waited out while
      // it is still moving; one that parses is judged at once.
      const read = await readSettledJson(path, resolvePartialWritePolicy(this.deps.partialWrite));
      if (read.kind === "missing") return false;
      const reads = read.reads;
      const parsed: ParsedRecheckDecision =
        read.kind === "parsed"
          ? validateRecheckDecision(read.value)
          : { ok: false, error: `unparseable: ${read.error}` };
      if (!parsed.ok || !parsed.decision) {
        // Malformed is the safe direction here — the standing verdict simply
        // stays standing. No park, no anomaly round, nothing posted. But say
        // so out loud: a silent drop would hide a partial-read race.
        this.deps.store.logEvent("recheck_decision_malformed", pr, {
          file: name,
          error: parsed.error ?? "unknown",
        });
        this.deps.log?.(
          `recheck: #${pr} decision ${name} malformed after ${reads} read(s) — standing verdict kept (${parsed.error ?? "unknown"})`,
        );
        this.archive(name);
        return true;
      }
      const d = parsed.decision;
      if (
        d.pr !== pr ||
        d.head_sha.slice(0, 12).toLowerCase() !== (match[2] as string).toLowerCase()
      ) {
        this.deps.store.logEvent("recheck_decision_rejected", pr, {
          file: name,
          reason: "pr/head do not match the filename",
        });
        this.archive(name);
        return true;
      }
      if (parsed.coerced !== undefined)
        this.deps.store.logEvent("recheck_outcome_coerced", pr, {
          file: name,
          given: parsed.coerced,
          applied: "uphold",
        });

      if (d.outcome === "request_changes") {
        // The reasoning behind a backed-down approval. Best-effort
        // and strictly additive: a missing record here is logged and nothing
        // else — the decision above is what moves the PR.
        await this.recordRecheckFindings(pr, d.head_sha);
        // Approval is off the table now — a lingering withheld mark would let
        // a later green CI re-queue "for the withheld approval" of a PR whose
        // standing verdict this very decision just flipped.
        this.deps.store.clearApprovalWithheld(pr);
        applyEvent(
          this.deps.store,
          pr,
          { type: "verdict", verdict: "REQUEST_CHANGES" },
          { head_sha: d.head_sha },
          {
            botLogin: this.deps.cfg.github.bot_login,
            ...(this.deps.now ? { now: this.deps.now } : {}),
            reason: "recheck:request-changes",
          },
        );
      }
      if (d.outcome === "uphold") {
        // Session-examined significant delta, verdict upheld: the withheld
        // approval (if any) follows the head.
        carryWithheldMark(this.deps.store, pr, d.head_sha, "recheck-uphold", (m) =>
          this.deps.log?.(m),
        );
        // Ledger freshness after the uphold (optional wiring).
        if (this.deps.checkLedger) {
          try {
            await this.deps.checkLedger(pr, d.head_sha);
          } catch (err) {
            this.deps.log?.(`recheck: ledger check failed on #${pr}`, err);
          }
        }
      }
      this.deps.store.logEvent(
        d.outcome === "request_changes" ? "recheck_request_changes" : "recheck_upheld",
        pr,
        {
          file: name,
          head_sha: d.head_sha,
          reason: d.reason ?? null,
        },
      );
      this.deps.log?.(`recheck: #${pr} ${d.outcome} at ${d.head_sha.slice(0, 7)}`);
      this.archive(name);
      return true;
    } catch (err) {
      this.deps.log?.(`recheck: ${name} failed`, err);
      return false;
    } finally {
      this.inFlight.delete(name);
    }
  }
}
