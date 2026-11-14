// state_explore: structural questions about a pull request's code, answered
// deterministically for the state-machine lenses. Five actions over one
// `ExploreIo` (the head tree, the base and head of a file, the PR's diff):
//
//   anchors    diff-shape signals that point at a line where something may
//              be missing (eight kinds, ranked, capped)
//   writes     every write of a field or variable in the head tree, and the
//              statements that usually sit beside those writes
//   reads      every other mention of it, split by how it is read
//   exits      one function's exits, the branch chain to each, the
//              statements present before some exits and absent before
//              others, and what each early exit skips
//   siblings   a statement's other occurrences, which of its neighbours
//              each occurrence lacks, and which of theirs it lacks
//
// Every answer is a claim of plain code: "where to look", never proof. The
// structure is lexical (stateshape.ts), so the header of every answer that
// rests on it says once what it cannot see. A check that could not run says
// `unknown: <why>`; a sweep that was cut says so; a cut never reads as "none
// found".
//
// Pure apart from awaiting the io: no clock but `opts.now`, no process, no
// network. A long anchors call yields a turn between files (one worker hosts
// every lens session) and stops at the deadline; added lines past a per-call
// budget are not examined, and the kinds that skipped them say so. Every regex reads one line cut to `LINE_MAX`; a name from the
// request is matched by token comparison, never compiled into a pattern.

import type { PrFileEntry } from "./githubcore.js";
import { CODE_FILE_RE, isTestFile } from "./heuristics.js";
import { isMigrationFile, isVendored } from "./scan/facts.js";
import { parsePatch, SCHEMA_PATH_RE } from "./secfacts.js";
import { COLUMN_SHAPES, scanLines, TokenTable } from "./statetokens.js";
import {
  blockOfLine,
  chainOf,
  dialectOf,
  exitKindOf,
  exitsOf,
  familyOf,
  functionAt,
  functionOfLine,
  isWithin,
  LEAVING,
  lineFunctions,
  normalise,
  receiverWrite,
  shapeOf,
  SHAPE_LIMITS,
  stmtKey,
  type Block,
  type Exit,
  type Shape,
  type StmtKey,
} from "./stateshape.js";
import { LINE_MAX } from "./statetriggers.js";

// ---------------------------------------------------------------------------
// Interface

export interface ExploreIo {
  /** Head tree listing (path, size) or null when unreadable. */
  listHead(): Promise<readonly { path: string; size: number }[] | null>;
  readHead(path: string): Promise<string | null>;
  readBase(path: string): Promise<string | null>;
  /** The PR's files, base..head, in the GitHub files-API shape. */
  diff(): Promise<readonly PrFileEntry[] | null>;
  /** Releases what the io holds (a reader process); called once, last. */
  close?(): Promise<void>;
}

export type ExploreAction = "anchors" | "writes" | "reads" | "exits" | "siblings";
export const EXPLORE_ACTIONS: readonly ExploreAction[] = [
  "anchors",
  "writes",
  "reads",
  "exits",
  "siblings",
];

export interface ExploreRequest {
  action: ExploreAction;
  name?: string;
  file?: string;
  line?: number;
}

export interface ExploreOptions {
  deadlineMs?: number;
  maxChars?: number;
  now?: () => number;
}

export const STATE_EXPLORE_TOOL = "state_explore";

export const STATE_EXPLORE_DESCRIPTION =
  'Read-only structural questions about this PR\'s code, computed from the committed base and head (no model, no execution). action "anchors" lists lines where something may be missing (moved calls, exits that lack a statement, co-writes, persisted shapes with no migration, writes with no transaction, calls replaced by a cache, new writers, a new write without what the field\'s other writes do beside it); "writes"/"reads" list every write or read of a name, and "writes" the statements that usually sit beside them; "exits" lists one function\'s exits and the statements present before some and absent before others; "siblings" lists a statement\'s other occurrences, the neighbours each lacks, and what the statement lacks that most of them have. Lexical: it cannot bind names, follow calls or see macros and implicit exits. Open the line before a finding rests on it; "unknown" clears nothing.';

/** The tool's parameters, JSON-schema shaped. */
export const STATE_EXPLORE_PARAMS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...EXPLORE_ACTIONS],
      description: EXPLORE_ACTIONS.join(" | "),
    },
    worktree: {
      type: "string",
      description:
        'Absolute path of the PR worktree (from the task\'s "The code"). Required on the first call; remembered after.',
    },
    base: {
      type: "string",
      description:
        "The merge-base commit, 40 hex (the first sha of the task's `git diff A B`). Required on the first call.",
    },
    head: {
      type: "string",
      description: "The head commit, 40 hex. Required on the first call.",
    },
    name: {
      type: "string",
      description:
        "writes, reads: the field or variable (a dotted or -> path names its last segment).",
    },
    file: {
      type: "string",
      description:
        "exits, siblings: a repo-relative path; writes, reads: an optional path or directory filter.",
    },
    line: {
      type: "integer",
      minimum: 1,
      description: "exits, siblings: a 1-based head line in `file`.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Caps

/** Files one sweep searches. */
export const EXPLORE_MAX_FILES = 1200;
/** A larger file is not read by a tree sweep. */
export const EXPLORE_MAX_FILE_BYTES = 256 * 1024;
/** A file the PR changes is read and shaped up to this size (the git reader
 * hands over no larger blob): its own lines are what the anchors examine.
 * Every pass over it is linear in its lines or capped (the shape, the
 * companions, the alias searches, the functions and moved lines walked), so
 * the larger cap costs time in proportion, never more. */
export const EXPLORE_MAX_CHANGED_FILE_BYTES = 1024 * 1024;
/** A changed file's patch is parsed up to this length: a head and a base
 * within the changed-file cap give no longer one, and a longer one is not
 * held line by line, so its file is named unknown for every kind it feeds. */
const MAX_PATCH_CHARS = 4 * EXPLORE_MAX_CHANGED_FILE_BYTES;
/** Text read in one call. */
export const EXPLORE_MAX_BYTES = 64 * 1024 * 1024;
/** Lines read in one call: a shape keeps an object per line, so a file of
 * short lines costs far more than its bytes. Ordinary code reaches the
 * byte budget first. */
export const EXPLORE_MAX_LINES = 4_000_000;
/** Characters of one answer. */
export const EXPLORE_MAX_CHARS = 12_000;
/** Sites listed per answer or per anchor list. */
export const EXPLORE_MAX_SITES = 40;
/** Anchors listed. */
export const EXPLORE_MAX_ANCHORS = 40;
/** The default per-call deadline. */
export const EXPLORE_DEADLINE_MS = 20_000;
/** Changed files the anchors read whole. */
export const EXPLORE_MAX_CHANGED_FILES = 120;
/** Lines each way around a statement whose neighbours are compared. */
export const SIBLING_WINDOW = 3;
/** Lines each way an occurrence is searched for a missing neighbour. */
export const SIBLING_NEAR = 6;
/** Sweep requests one anchors call makes (co-writes, new writers, caches). */
const MAX_COWRITE_PAIRS = 8;
const MAX_NEW_WRITERS = 10;
/** Written fields one changed file may put into the new-writer sweep. */
const MAX_NEW_WRITERS_PER_FILE = 3;
const MAX_CACHE_PAIRS = 6;
/** A replaced run of lines compared line by line for call-to-cache. */
const MAX_CACHE_RUN = 8;
/** Added lines the co-write and new-writer anchors examine per call: past
 * it they say so, and their kinds clear nothing. */
export const EXPLORE_MAX_ADDED_LINES = 20_000;
/** A field with this many writers is everywhere: its new-writer anchor is
 * left out, and the left-out fields are named. */
const BUSY_FIELD_WRITERS = 30;
/** A co-written statement found at this many sites is an idiom: its anchor
 * is left out, and the count is stated. */
const BUSY_COWRITE_SITES = 20;
/** Changed functions the structural anchors walk. */
const MAX_FUNCTIONS = 60;
/** Moved lines compared one by one per call: each looks over its function,
 * so the count is capped and the cut said. */
const MAX_MOVED_LINES = 200;
/** A function compared exit by exit: lines, exits, statements. */
const MAX_FN_LINES = 3000;
const MAX_FN_EXITS = 200;
const MAX_FN_STMTS = 1500;
/** Paths named when a sweep could not search them. */
const MAX_UNSEARCHED = 10;

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;
const PATH_MAX = 512;

// ---------------------------------------------------------------------------
// Text

/** A line of author code as shown: trimmed, control characters blanked, cut. */
function shown(raw: string, max = 140): string {
  const t = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function span(s: string): string {
  const t = shown(s, 100).replace(/`/g, "'");
  return `\`${t}\``;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function isWordCode(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
  );
}

/** Whether `code` holds `word` as a whole token (no pattern built from it). */
export function holdsWord(code: string, word: string): boolean {
  if (word === "") return false;
  for (let at = code.indexOf(word); at >= 0; at = code.indexOf(word, at + 1)) {
    const before = at > 0 ? code.charCodeAt(at - 1) : 32;
    const after = at + word.length < code.length ? code.charCodeAt(at + word.length) : 32;
    if (!isWordCode(before) && !isWordCode(after)) return true;
  }
  return false;
}

/** Each identifier token of a line with where it starts. A `$` is part of
 * an identifier (`loading$`, `load$state`), as `holdsWord` reads one; a
 * single leading `$` is a sigil (PHP `$count`, JS `$el`), so the token is the
 * name after it, and a bare `$` is no token. */
function* tokensOf(line: string): Generator<{ token: string; at: number }> {
  let start = -1;
  for (let k = 0; k <= line.length; k++) {
    const c = k < line.length ? line.charCodeAt(k) : 32;
    if (isWordCode(c)) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      const at = line.charCodeAt(start) === 36 ? start + 1 : start;
      if (at < k) yield { token: line.slice(at, k), at };
      start = -1;
    }
  }
}

function capFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// The call's reads

type Why = "unread" | "unread-base" | "oversize" | "budget" | "deadline";
type Load = { ok: true; text: string } | { ok: false; why: Why; cap?: number };

interface SweepStats {
  /** Code files the sweep would search (after the filters). */
  kept: number;
  searched: number;
  oversize: number;
  unread: number;
  /** Files past the file cap, the byte budget or the deadline. */
  notReached: number;
  unsearched: string[];
  cut: string[];
}

class Ctx {
  readonly started: number;
  readonly deadline: number;
  bytes = 0;
  lines = 0;
  spent = false;
  timedOut = false;
  private listing: readonly { path: string; size: number }[] | null | undefined;
  private sizes = new Map<string, number>();
  private readonly heads = new Map<string, string | null>();
  private readonly shapes = new Map<string, Shape>();
  /** The paths the PR changes (head and base names), read from the diff
   * once; null until asked. A diff that cannot be read changes no cap. */
  private changed: Set<string> | null = null;

  readonly io: ExploreIo;
  readonly now: () => number;

  constructor(io: ExploreIo, now: () => number, deadlineMs: number) {
    this.io = io;
    this.now = now;
    this.started = now();
    this.deadline = this.started + deadlineMs;
  }

  late(): boolean {
    if (!this.timedOut && this.now() > this.deadline) this.timedOut = true;
    return this.timedOut;
  }

  async list(): Promise<readonly { path: string; size: number }[] | null> {
    if (this.listing !== undefined) return this.listing;
    try {
      this.listing = await this.io.listHead();
    } catch {
      this.listing = null;
    }
    if (this.listing) for (const e of this.listing) this.sizes.set(e.path, e.size);
    return this.listing;
  }

  /** The diff, read once per call; null when it cannot be read. */
  private diffRead: Promise<readonly PrFileEntry[] | null> | null = null;
  diff(): Promise<readonly PrFileEntry[] | null> {
    this.diffRead ??= (async () => {
      try {
        return await this.io.diff();
      } catch {
        return null;
      }
    })();
    return this.diffRead;
  }

  /** The size cap of a path: larger for a file the PR changes. */
  async capOf(path: string): Promise<number> {
    if (this.changed === null) {
      const d = await this.diff();
      this.changed = new Set();
      for (const f of d ?? []) {
        this.changed.add(f.filename);
        if (f.previous_filename !== undefined) this.changed.add(f.previous_filename);
      }
    }
    return this.changed.has(path) ? EXPLORE_MAX_CHANGED_FILE_BYTES : EXPLORE_MAX_FILE_BYTES;
  }

  /** A head file under the caps; `keep` caches it for the rest of the call. */
  async head(path: string, keep = false): Promise<Load> {
    if (this.heads.has(path)) {
      const t = this.heads.get(path)!;
      return t === null ? { ok: false, why: "unread" } : { ok: true, text: t };
    }
    if (this.late()) return { ok: false, why: "deadline" };
    if (this.spent) return { ok: false, why: "budget" };
    const cap = await this.capOf(path);
    // The listing's size tells an oversize file from an unreadable one (the
    // git reader hands over no blob past the changed-file cap).
    if (!this.sizes.has(path)) await this.list();
    const size = this.sizes.get(path);
    if (size !== undefined && size > cap) return { ok: false, why: "oversize", cap };
    let text: string | null;
    try {
      text = await this.io.readHead(path);
    } catch {
      text = null;
    }
    if (text === null) {
      if (keep) this.heads.set(path, null);
      return { ok: false, why: "unread" };
    }
    return this.admit(text, cap, keep ? (t) => this.heads.set(path, t) : undefined);
  }

  async base(path: string): Promise<Load> {
    if (this.late()) return { ok: false, why: "deadline" };
    if (this.spent) return { ok: false, why: "budget" };
    const cap = await this.capOf(path);
    let text: string | null;
    try {
      text = await this.io.readBase(path);
    } catch {
      text = null;
    }
    if (text === null) return { ok: false, why: "unread-base" };
    return this.admit(text, cap);
  }

  private admit(text: string, cap: number, keep?: (t: string) => void): Load {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > cap) return { ok: false, why: "oversize", cap };
    if (this.bytes + bytes > EXPLORE_MAX_BYTES) {
      this.spent = true;
      return { ok: false, why: "budget" };
    }
    let lines = 0;
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines++;
    if (this.lines + lines > EXPLORE_MAX_LINES) {
      this.spent = true;
      return { ok: false, why: "budget" };
    }
    this.lines += lines;
    this.bytes += bytes;
    keep?.(text);
    return { ok: true, text };
  }

  /** The head shape of a file read with `head(path, true)`. */
  /** The shape this call already made of a file, if any. */
  known(path: string): Shape | undefined {
    return this.shapes.get(path);
  }

  shape(path: string, text: string): Shape {
    const known = this.shapes.get(path);
    if (known) return known;
    const s = shapeOf(path, text);
    if (this.shapes.size < 400) this.shapes.set(path, s);
    return s;
  }
}

function whyText(why: Why, cap: number = EXPLORE_MAX_FILE_BYTES): string {
  if (why === "oversize")
    return cap >= 1024 * 1024
      ? `it is over ${cap / (1024 * 1024)} MiB`
      : `it is over ${cap / 1024} KiB`;
  if (why === "budget")
    return `the call had read its ${EXPLORE_MAX_BYTES / (1024 * 1024)} MiB or ${EXPLORE_MAX_LINES} lines`;
  if (why === "deadline") return "the deadline passed";
  if (why === "unread-base")
    return `it could not be read at the base (absent, or over ${EXPLORE_MAX_CHANGED_FILE_BYTES / (1024 * 1024)} MiB there)`;
  return "it could not be read at the head";
}

/** Whether a path is code the tool reads: a file the shape has a dialect
 * for (Objective-C's `.m`, `.mm` among them), or one the planner counts as
 * code. The anchors and every sweep read the same set. */
function isCodePath(path: string): boolean {
  return dialectOf(path) !== null || CODE_FILE_RE.test(path);
}

/** The files a sweep searches, in order: `first`; files in `dirs`; the rest.
 * Code files only; tests and vendored code left out. */
function sweepOrder(
  listing: readonly { path: string }[],
  first: readonly string[],
  dirs: ReadonlySet<string>,
  filter?: (p: string) => boolean,
): string[] {
  const kept: string[] = [];
  const keptSet = new Set<string>();
  for (const { path } of listing) {
    if (!isCodePath(path) || isTestFile(path) || isVendored(path)) continue;
    if (filter && !filter(path)) continue;
    kept.push(path);
    keptSet.add(path);
  }
  const placed = new Set<string>();
  const order: string[] = [];
  for (const p of first)
    if (keptSet.has(p) && !placed.has(p)) {
      placed.add(p);
      order.push(p);
    }
  const rest: string[] = [];
  for (const p of kept) {
    if (placed.has(p)) continue;
    if (dirs.has(dirOf(p))) order.push(p);
    else rest.push(p);
  }
  return order.concat(rest);
}

interface SweepReq {
  /** Tokens searched exactly. */
  tokens: readonly string[];
  /** Each line of a searched file that holds one of the tokens. */
  onHit(path: string, shape: Shape, line: number): void;
}

/** One pass over the sweep set for every request at once: a file is read
 * once, its tokens looked up in one table, and shaped only when it holds a
 * hit. */
async function sweep(
  ctx: Ctx,
  reqs: readonly SweepReq[],
  order: readonly string[],
): Promise<SweepStats> {
  const stats: SweepStats = {
    kept: order.length,
    searched: 0,
    oversize: 0,
    unread: 0,
    notReached: 0,
    unsearched: [],
    cut: [],
  };
  if (reqs.length === 0) return stats;
  const table = new TokenTable();
  reqs.forEach((r, i) => {
    for (const t of r.tokens) table.add(t, 1 << i);
  });
  const files = order.slice(0, EXPLORE_MAX_FILES);
  if (order.length > EXPLORE_MAX_FILES) {
    stats.notReached += order.length - EXPLORE_MAX_FILES;
    stats.cut.push(`the sweep stops at ${EXPLORE_MAX_FILES} of ${order.length} code files`);
  }
  for (let i = 0; i < files.length; i++) {
    const path = files[i]!;
    // A cached head is served without awaiting the io, so the sweep yields
    // and checks the deadline itself.
    await yieldTurn();
    if (ctx.late()) {
      stats.notReached += files.length - i;
      stats.cut.push(
        `${whyText("deadline")} after ${stats.searched} of ${order.length} code files`,
      );
      break;
    }
    const load = await ctx.head(path);
    if (!load.ok) {
      if (load.why === "deadline" || load.why === "budget") {
        stats.notReached += files.length - i;
        stats.cut.push(
          `${whyText(load.why)} after ${stats.searched} of ${order.length} code files`,
        );
        break;
      }
      if (load.why === "oversize") stats.oversize++;
      else stats.unread++;
      if (stats.unsearched.length < MAX_UNSEARCHED)
        stats.unsearched.push(`${path} (${whyText(load.why, load.cap)})`);
      continue;
    }
    stats.searched++;
    const hits: { line: number; bits: number }[] = [];
    scanLines(load.text, table, (line, _text, bits) => hits.push({ line, bits }));
    if (hits.length === 0) continue;
    const shape = ctx.known(path) ?? shapeOf(path, load.text);
    for (const h of hits)
      for (let k = 0; k < reqs.length; k++)
        if ((h.bits & (1 << k)) !== 0) reqs[k]!.onHit(path, shape, h.line);
  }
  return stats;
}

function sweepLine(s: SweepStats): string {
  const parts = [
    `searched ${s.searched} of ${s.kept} code files (tests and vendored code left out)`,
  ];
  if (s.oversize > 0)
    parts.push(
      `${s.oversize} over the size cap not searched (${EXPLORE_MAX_FILE_BYTES / 1024} KiB; ${EXPLORE_MAX_CHANGED_FILE_BYTES / (1024 * 1024)} MiB for a file the PR changes)`,
    );
  if (s.unread > 0) parts.push(`${s.unread} unreadable`);
  for (const c of s.cut) parts.push(`[cut: ${c}]`);
  if (s.unsearched.length > 0) parts.push(`not searched: ${s.unsearched.join(", ")}`);
  return parts.join("; ");
}

function whole(s: SweepStats): boolean {
  return s.searched === s.kept;
}

// ---------------------------------------------------------------------------
// Sites

/** The function id a line belongs to, -1 outside every function or when the
 * structure is unknown. */
function fnIdOf(shape: Shape, line: number): number {
  return lineFunctions(shape)[line - 1] ?? -1;
}

function fnLabel(shape: Shape, line: number): string {
  if (!shape.structure) return "structure unknown";
  const id = fnIdOf(shape, line);
  return id >= 0 ? (shape.structure.blocks[id]!.name ?? "<anonymous>") : "top level";
}

function siteText(path: string, line: number, label: string, raw: string, tag?: string): string {
  return `${path}:${line}  (${label})  ${tag !== undefined ? `[${tag}] ` : ""}${shown(raw)}`;
}

interface Site {
  path: string;
  line: number;
  text: string;
  order: number;
}

/** Sites ordered by sweep position then line, the first `EXPLORE_MAX_SITES`
 * shown, the rest counted per file. */
function renderSites(sites: Site[], max = EXPLORE_MAX_SITES): string[] {
  sites.sort((a, b) => a.order - b.order || a.line - b.line);
  const out = sites.slice(0, max).map((s) => s.text);
  if (sites.length > max) {
    const per = new Map<string, number>();
    for (const s of sites.slice(max)) per.set(s.path, (per.get(s.path) ?? 0) + 1);
    const list = [...per].slice(0, 20).map(([p, n]) => `${p} ${n}`);
    out.push(
      `[cut: ${sites.length - max} more not shown — ${list.join(", ")}${per.size > 20 ? `, and ${per.size - 20} more files` : ""}]`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Names: writes and reads

export interface NameForms {
  name: string;
  /** Spellings of the field itself (C++ and private member forms). */
  forms: Set<string>;
  /** Setter spellings. */
  setters: Set<string>;
}

/** The name a request asks about: its last segment, and its forms. Null for
 * a name that is not one identifier path. */
export function nameFormsOf(raw: string): NameForms | null {
  if (raw.length === 0 || raw.length > 200) return null;
  const last = raw.split(/\.|->|::/).pop() ?? "";
  if (!NAME_RE.test(last)) return null;
  // A leading `$` is a sigil; one inside the name is part of it.
  const name = last.replace(/^\$/, "");
  if (name === "") return null;
  const forms = new Set([name, `${name}_`, `_${name}`, `m_${name}`, `m${capFirst(name)}`]);
  const setters = new Set([`set${capFirst(name)}`, `set_${name}`]);
  return { name, forms, setters };
}

export type Occurrence =
  | { kind: "write"; how: string }
  | { kind: "read"; how: "condition" | "return" | "argument" | "other" };

const ASSIGN_AFTER_RE = /^\s{0,4}(?:(?:[-+*/%|&^]|<<|>>|\?\?|\|\||&&)?=(?![=>~])|:=|\+\+|--)/;
const INCR_BEFORE_RE = /(?:\+\+|--)\s{0,2}(?:[\w$]{1,80}(?:\.|->|\?\.)){0,4}$/;
const MEMBER_BEFORE_RE = /(?:\.|->|\?\.|::)\s{0,2}$/;
const KEY_AFTER_RE = /^\s{0,4}:(?!:)/;
const COND_LEAD_RE =
  /^\s{0,200}(?:\}\s{0,4})?(?:if|elif|else\s{1,4}if|while|switch|case|when|match|guard|unless|until)\b/;
const COND_AFTER_RE = /^\s{0,4}(?:===?|!==?|<=?|>=?|\bin\b|\bnot\s{1,4}in\b|\bis\b|\?(?![.?]))/;
const COND_BEFORE_RE =
  /(?:===?|!==?|<=?|(?<!-)>=?|!|\bnot|&&|\|\||\band|\bor|\bin|\bcase|\?|\.(?:includes|has|contains|indexOf)\(\s{0,4})\s{0,4}(?:[\w$]{1,80}(?:\.|->|\?\.)){0,4}$/;
const RETURN_LEAD_RE = /^\s{0,200}(?:return\b|=>)/;
/** A store through a member chain or an index after the token: `f` in
 * `a->f.g = x`, `a.f[i].g = x`, `a->f.g[i] = x`, `a.f.n++`. */
const CHAIN_ASSIGN_AFTER_RE =
  /^(?:\s{0,2}(?:\.|->|\?\.)\s{0,2}[A-Za-z_$][\w$]{0,80}|\s{0,2}\[[^\]\n]{0,60}\]){1,8}\s{0,4}(?:(?:[-+*/%|&^]|<<|>>|\?\?|\|\||&&)?=(?![=>~])|\+\+|--)/;
/** A mutating method called on the token, maybe through a member chain:
 * a Map/Set write, a C++ atomic store. */
const RECEIVER_METHOD_AFTER_RE =
  /^(?:\s{0,2}(?:\.|->|\?\.)\s{0,2}[A-Za-z_$][\w$]{0,80}){0,4}\s{0,2}(?:\.|->|\?\.)\s{0,2}(set|delete|clear|add|append|extend|pop|push|splice|insert|put|putAll|computeIfAbsent|push_back|push_front|pop_back|pop_front|emplace(?:_back|_front|_hint)?|erase|store|exchange|fetch_(?:add|sub|and|or|xor|max|min)|compare_exchange_(?:weak|strong))(?:_explicit)?\s{0,4}\(/;
/** The methods of `RECEIVER_METHOD_AFTER_RE` that are atomic operations. */
const ATOMIC_METHOD_RE = /^(?:store|exchange|fetch_|compare_exchange_)/;
/** A type annotation ends just before the token (`x: A.B`), not a `::` path. */
const TYPE_BEFORE_RE = /(?<!:):\s{0,4}$/;
/** A name that follows a member-field convention (`m_x`, `mX`, `_x`, `x_`). */
const FIELD_NAME_RE = /^(?:m_|_)[A-Za-z]|^m[A-Z]|[A-Za-z0-9]_$/;
/** The token is (the end of) the first argument of a C11 atomic function. */
const ATOMIC_ARG_BEFORE_RE =
  /(?:\b(?:__)?atomic(?:64|_long)?_(?:store|exchange|init|set|inc|dec|add|sub|fetch_(?:add|sub|and|or|xor)|(?:add|sub|and|or|xor)_fetch|compare_exchange(?:_weak|_strong)?|flag_test_and_set|flag_clear)(?:_explicit|_n|_release|_relaxed)?|\bWRITE_ONCE)\s{0,4}\(\s{0,4}&?\s{0,2}(?:[A-Za-z_$][\w$]{0,80}\s{0,2}(?:\.|->)\s{0,2}){0,6}$/;
const SQL_SET_RE = /\bSET\b/i;
const SQL_WHERE_RE = /\b(?:WHERE|AND|OR|ON|HAVING)\b/i;
const SQL_ANY_RE = /\b(?:SELECT|UPDATE|INSERT|DELETE|WHERE|FROM)\b/i;

/** How the token at `at` (length `len`) on a line is used, or null when it
 * sits in a comment or in prose inside a string. */
export function classifyOccurrence(
  raw: string,
  code: string,
  at: number,
  len: number,
  setter: boolean,
): Occurrence | null {
  const cc = code.charCodeAt(at);
  if (cc === 32 && raw.charCodeAt(at) !== 32) return null; // in a comment
  if (cc === 1) {
    // In a string: an SQL SET target, a key, an index, or a whole-string name.
    const before = raw.slice(Math.max(0, at - 160), at);
    const after = raw.slice(at + len, at + len + 40);
    const set = before.search(SQL_SET_RE);
    if (set >= 0 && /^["`\]]?\s{0,4}=(?!=)/.test(after)) {
      const lastSet = before.toUpperCase().lastIndexOf("SET");
      const where = Math.max(before.toUpperCase().lastIndexOf("WHERE"), -1);
      if (lastSet > where) return { kind: "write", how: "sql" };
      return { kind: "read", how: "condition" };
    }
    const q0 = code.charCodeAt(at - 1);
    const q1 = code.charCodeAt(at + len);
    const quoted = (q0 === 34 || q0 === 39 || q0 === 96) && q1 === q0;
    if (quoted) {
      const rest = code.slice(at + len + 1);
      if (KEY_AFTER_RE.test(rest)) return { kind: "write", how: "key" };
      if (/^\s{0,2}\]\s{0,4}=(?![=>])/.test(rest)) return { kind: "write", how: "index" };
      return { kind: "read", how: argumentOrOther(code, at) };
    }
    if (SQL_ANY_RE.test(raw))
      return { kind: "read", how: SQL_WHERE_RE.test(before) ? "condition" : "other" };
    return null;
  }
  const before = code.slice(0, at);
  const after = code.slice(at + len);
  if (setter) {
    if (/^\s{0,4}\(/.test(after)) return { kind: "write", how: "setter" };
    return { kind: "read", how: argumentOrOther(code, at) };
  }
  const member = MEMBER_BEFORE_RE.test(before);
  if (ASSIGN_AFTER_RE.test(after)) return { kind: "write", how: member ? "member" : "assign" };
  if (INCR_BEFORE_RE.test(before)) return { kind: "write", how: member ? "member" : "assign" };
  // A store into a member of the token is a store into the token when the
  // token is itself long-lived: a member, or a name that follows a field
  // convention. A root variable (a parameter, a local) is only the path to
  // the state, and a type annotation (`x: A.B = …`) is no store at all.
  const typed = TYPE_BEFORE_RE.test(before);
  if (
    !typed &&
    (member || FIELD_NAME_RE.test(code.slice(at, at + len))) &&
    CHAIN_ASSIGN_AFTER_RE.test(after)
  )
    return { kind: "write", how: "chain" };
  const method = typed ? null : RECEIVER_METHOD_AFTER_RE.exec(after);
  if (method)
    return { kind: "write", how: ATOMIC_METHOD_RE.test(method[1]!) ? "atomic" : "collection" };
  if (ATOMIC_ARG_BEFORE_RE.test(before)) return { kind: "write", how: "atomic" };
  if (!member && KEY_AFTER_RE.test(after)) {
    const lead = before.trimEnd();
    const tail = code.trimEnd();
    if (lead === "" || lead.endsWith("{") || lead.endsWith(",") || lead.endsWith("(")) {
      if (
        tail.endsWith(",") ||
        tail.endsWith("{") ||
        /[})]\s*[;,]?$/.test(tail) ||
        before.includes("...")
      )
        return { kind: "write", how: "key" };
      // `name: Type;` — a type member, not a value
      return null;
    }
  }
  if (COND_LEAD_RE.test(code) || COND_AFTER_RE.test(after) || COND_BEFORE_RE.test(before))
    return { kind: "read", how: "condition" };
  if (RETURN_LEAD_RE.test(code)) return { kind: "read", how: "return" };
  return { kind: "read", how: argumentOrOther(code, at) };
}

function argumentOrOther(code: string, at: number): "argument" | "other" {
  let depth = 0;
  let k = at - 1;
  for (; k >= 0; k--) {
    const c = code.charCodeAt(k);
    if (c === 41) depth++;
    else if (c === 40) {
      if (depth === 0) break;
      depth--;
    }
  }
  if (k < 0) return "other";
  let j = k - 1;
  while (j >= 0 && code.charCodeAt(j) === 32) j--;
  return j >= 0 && isWordCode(code.charCodeAt(j)) ? "argument" : "other";
}

interface NameHit {
  path: string;
  line: number;
  occ: Occurrence;
  label: string;
  raw: string;
  /** The function id it sits in, -1 outside one or with no structure. */
  fn?: number;
  /** A write's companions: the partner ids of the statements around it. */
  near?: string[];
}

// Writes through an alias --------------------------------------------------

/** Lines after an address-taking line searched for a write through the
 * alias, in the same function. */
const ALIAS_SCAN_LINES = 200;
/** Address-taking lines one sweep request follows. */
const ALIAS_MAX_SCANS = 64;
/** A store through an alias past `ALIAS_SCAN_LINES` is not looked for: said. */
const ALIAS_WINDOW_NOTE = `[cut: writes through an alias were followed for ${ALIAS_SCAN_LINES} lines after its address was taken; later ones not seen]`;

/** The token closes an address-of expression through at least one member:
 * `&a->f`, `&a.b.f` (the address of a local is no long-lived state). */
const ADDR_BEFORE_RE =
  /(?<![&\w$)\]])&\s{0,2}(?:mut\s{1,4})?(?:[A-Za-z_$][\w$]{0,80}\s{0,2}(?:\.|->)\s{0,2}){1,6}$/;
/** What may follow the token in that expression: more members, then its end. */
const ADDR_END_AFTER_RE =
  /^(?:\s{0,2}(?:\.|->)\s{0,2}[A-Za-z_$][\w$]{0,80}|\s{0,2}\[[^\]\n]{0,60}\]){0,4}\s{0,4}(?:[;,)]|$)/;
/** The alias the address is stored in: `T *p =`, `params.x =`. Group 1 a
 * member hop before the alias, group 2 its name. */
const ALIAS_LHS_RE = /(\.|->)?\s{0,2}([A-Za-z_$][\w$]{0,80})\s{0,4}:?=\s{0,4}$/;
/** A store through the alias starts its statement (`*p = x`); a declarator
 * (`char *p = …`) declares another local of the same name. */
const DEREF_BEFORE_RE = /(?:^|[;{}(,])\s{0,4}\*\s{0,2}$/;
/** After a local's name: it is bound to the address of a member. Group 1
 * the member. */
const ALIAS_BIND_AFTER_RE =
  /^\s{0,4}:?=\s{0,4}&\s{0,2}(?:mut\s{1,4})?(?:[A-Za-z_$][\w$]{0,80}\s{0,2}(?:\.|->)\s{0,2}){1,6}([A-Za-z_$][\w$]{0,80})\s{0,4}(?:\[[^\]\n]{0,60}\]\s{0,4})?(?:[;,)]|$)/;

/** The alias an address-taking line stores the token's address in. */
function aliasOf(code: string, at: number, len: number): { name: string; member: boolean } | null {
  const before = code.slice(0, at);
  const m = ADDR_BEFORE_RE.exec(before);
  if (!m || !ADDR_END_AFTER_RE.test(code.slice(at + len))) return null;
  const lhs = ALIAS_LHS_RE.exec(before.slice(0, m.index));
  if (!lhs) return null;
  return { name: lhs[2]!, member: lhs[1] !== undefined };
}

/** The later lines of the same function that store through the alias
 * (`p->g = x`, `p->g.h[i] = x`, `*p = x`, `p->m.set(…)`), every one within
 * `ALIAS_SCAN_LINES`; the search stops where the alias is bound again.
 * `windowCut`: the function goes on past the window with the alias unbound,
 * so a later store was not looked for. Lexical: a copy of the alias, a call
 * that writes through it and another function's writes are not seen. */
function writesThroughAlias(
  shape: Shape,
  line: number,
  alias: { name: string; member: boolean },
): { lines: number[]; windowCut: boolean } {
  const none = { lines: [], windowCut: false };
  if (!shape.structure) return none;
  const fn = functionOfLine(shape, line);
  if (!fn) return none;
  const out: number[] = [];
  const last = Math.min(fn.end, shape.lines.length);
  const end = Math.min(last, line + ALIAS_SCAN_LINES);
  for (let L = line + 1; L <= end; L++) {
    const code = shape.lines[L - 1]!.code;
    if (shape.lines[L - 1]!.kind !== "code" || !holdsWord(code, alias.name)) continue;
    if (functionOfLine(shape, L)?.id !== fn.id) continue;
    let rebound = false;
    for (let p = code.indexOf(alias.name); p >= 0; p = code.indexOf(alias.name, p + 1)) {
      const e = p + alias.name.length;
      if ((p > 0 && isWordCode(code.charCodeAt(p - 1))) || isWordCode(code.charCodeAt(e))) continue;
      const before = code.slice(0, p);
      const after = code.slice(e);
      if (MEMBER_BEFORE_RE.test(before) !== alias.member) continue;
      if (
        CHAIN_ASSIGN_AFTER_RE.test(after) ||
        RECEIVER_METHOD_AFTER_RE.test(after) ||
        (DEREF_BEFORE_RE.test(before) && ASSIGN_AFTER_RE.test(after))
      ) {
        out.push(L);
        break;
      }
      if (ASSIGN_AFTER_RE.test(after)) {
        rebound = true;
        break;
      }
    }
    if (rebound) return { lines: out, windowCut: false };
  }
  return { lines: out, windowCut: end < last };
}

// Companions: the statements around a write ---------------------------------

/** Write sites whose companions one request gathers. */
const COMPANION_MAX_SITES = 200;
/** A block no larger than this many lines counts whole as a write's
 * surroundings; a larger one only within ±`SIBLING_NEAR` lines. */
const WRITER_BLOCK_MAX = 40;

interface Partner {
  /** As the first site wrote it: `callee(…)` or `target = …`. */
  shown: string;
  key: StmtKey;
}

/** What one request learns of the statements around the writes it finds. */
interface CompanionBook {
  /** Partner id to how it reads. */
  dict: Map<string, Partner>;
  /** Partner id to its statements in the files where it sits beside a write. */
  counts: Map<string, number>;
  counted: Set<string>;
  captured: number;
  /** Writes past `COMPANION_MAX_SITES` were not looked around. */
  cut: boolean;
}

function newBook(): CompanionBook {
  return { dict: new Map(), counts: new Map(), counted: new Set(), captured: 0, cut: false };
}

/** A chain with its root variable dropped and `->` read as `.`: two sites
 * that write `p->status` and `it->second->status` write the same member. */
function dropRoot(chain: string): string {
  const c = chain.replace(/->/g, ".");
  const at = c.indexOf(".");
  return at > 0 && !c.slice(0, at).includes("::") ? c.slice(at) : c;
}

/** A statement's identity across sites, literals abstracted: a write by the
 * member it writes, a call by its callee (a method call by the chain after
 * its receiver, so `order.markDirty()` and `o.markDirty()` are one partner). */
function partnerId(key: StmtKey): string {
  if (key.kind === "write") return `${dropRoot(key.key.slice(0, key.key.indexOf(" ")))} =`;
  const callee = key.key.slice(0, key.key.indexOf("(") >>> 0);
  return `${dropRoot(callee)}(…)`;
}

function partnerShown(key: StmtKey): string {
  if (key.kind === "write") return `${key.key.slice(0, key.key.indexOf(" "))} = …`;
  return `${key.key.slice(0, key.key.indexOf("(") >>> 0)}(…)`;
}

const LINE_KEYS = new WeakMap<Shape, (StmtKey | null | undefined)[]>();

/** The statement key of a line that holds one (no head, no continuation),
 * computed once per shape and line. */
function keyAt(shape: Shape, line: number): StmtKey | null {
  let keys = LINE_KEYS.get(shape);
  if (!keys) {
    keys = new Array<StmtKey | null | undefined>(shape.lines.length);
    LINE_KEYS.set(shape, keys);
  }
  const known = keys[line - 1];
  if (known !== undefined) return known;
  const sl = shape.lines[line - 1];
  const key =
    !sl || sl.kind !== "code" || sl.cont || headLines(shape).has(line) ? null : stmtKey(sl.code);
  keys[line - 1] = key;
  return key;
}

const FILE_PARTNERS = new WeakMap<Shape, Map<string, number>>();

/** How many statements of each partner id a file holds: one pass per file. */
function filePartners(shape: Shape): Map<string, number> {
  let m = FILE_PARTNERS.get(shape);
  if (!m) {
    m = new Map();
    for (let L = 1; L <= shape.lines.length; L++) {
      const k = keyAt(shape, L);
      if (k) {
        const id = partnerId(k);
        m.set(id, (m.get(id) ?? 0) + 1);
      }
    }
    FILE_PARTNERS.set(shape, m);
  }
  return m;
}

/** The object a write stores into (`p->cfg` for `p->cfg->mode = x`), or
 * null for a call or a store into a bare name. */
function objectOf(key: StmtKey): string | null {
  if (key.kind !== "write") return null;
  const target = key.key.slice(0, key.key.indexOf(" ")).replace(/->/g, ".");
  const at = target.lastIndexOf(".");
  return at > 0 ? target.slice(0, at) : null;
}

/** The partner ids of the statements around a write: within ±`SIBLING_NEAR`
 * lines in the same function, and the whole of its block when that block is
 * small; a statement in a sibling block (another branch) is not around it.
 * Each id is entered in the book. */
function companionsAt(shape: Shape, path: string, line: number, book: CompanionBook): string[] {
  const st = shape.structure;
  const fnId = st ? fnIdOf(shape, line) : -1;
  const own = st ? blockOfLine(shape, line) : null;
  const self = keyAt(shape, line);
  const selfObject = self ? objectOf(self) : null;
  const ids = new Set<string>();
  const take = (k: number): void => {
    if (k === line) return;
    const key = keyAt(shape, k);
    if (!key) return;
    // Another field of the object this line writes is the same
    // initialisation, not a companion of the write.
    if (selfObject !== null && objectOf(key) === selfObject) return;
    if (st) {
      if (fnIdOf(shape, k) !== fnId) return;
      const b = blockOfLine(shape, k);
      if (own && b && !isWithin(st, b, own) && !isWithin(st, own, b)) return;
    }
    const id = partnerId(key);
    if (!book.dict.has(id)) book.dict.set(id, { shown: partnerShown(key), key });
    ids.add(id);
  };
  const lo = Math.max(1, line - SIBLING_NEAR);
  const hi = Math.min(shape.lines.length, line + SIBLING_NEAR);
  for (let k = lo; k <= hi; k++) take(k);
  if (own && own.kind !== "function" && own.end - own.body <= WRITER_BLOCK_MAX)
    for (let k = own.body; k <= own.end; k++) if (k < lo || k > hi) take(k);
  const out = [...ids];
  const counts = filePartners(shape);
  for (const id of out) {
    const once = `${path}\0${id}`;
    if (book.counted.has(once)) continue;
    book.counted.add(once);
    book.counts.set(id, (book.counts.get(id) ?? 0) + (counts.get(id) ?? 0));
  }
  return out;
}

interface PartnerRow {
  id: string;
  partner: Partner;
  /** The sites it sits beside. */
  have: NameHit[];
  /** The writing functions it sits beside (a function counted once). */
  units: number;
}

/** The unit a write is counted in: its function, so three stores in one
 * initialiser count once; a write outside any function counts alone. */
function unitOf(h: NameHit): string {
  return h.fn !== undefined && h.fn >= 0 ? `${h.path}\0${h.fn}` : `${h.path}:${h.line}`;
}

/** The number of writing functions among `sites`. */
function unitCount(sites: readonly NameHit[]): number {
  return new Set(sites.map(unitOf)).size;
}

/** The statements that sit beside the writes of at least two of the writing
 * functions of `sites` and at least two-thirds of them (a function counted
 * once, however many of its lines write). Left out: a log, trace or
 * assertion call, a write or setter of the field itself, and a partner the
 * files hold so often that fewer than half of its statements sit beside a
 * write (an idiom, named in `idioms`). */
function usualPartners(
  forms: NameForms,
  sites: readonly NameHit[],
  book: CompanionBook,
  idioms: string[],
): PartnerRow[] {
  const by = new Map<string, NameHit[]>();
  for (const h of sites)
    for (const id of h.near ?? []) {
      const list = by.get(id) ?? [];
      list.push(h);
      by.set(id, list);
    }
  const all = unitCount(sites);
  const rows: PartnerRow[] = [];
  for (const [id, have] of by) {
    const units = unitCount(have);
    if (units < 2 || units * 3 < all * 2) continue;
    const partner = book.dict.get(id)!;
    const k = partner.key;
    if (isLogCall(k) || isIdiom(k)) continue;
    if (forms.forms.has(k.token) || forms.setters.has(k.token)) continue;
    if ((k.members ?? []).some((m) => forms.forms.has(m))) continue;
    const total = book.counts.get(id) ?? 0;
    if (total >= BUSY_COWRITE_SITES && have.length * 2 < total) {
      if (!idioms.includes(partner.shown)) idioms.push(partner.shown);
      continue;
    }
    rows.push({ id, partner, have, units });
  }
  return rows.sort((a, b) => b.units - a.units || (a.id < b.id ? -1 : 1));
}

/** A sweep request collecting every occurrence of a name's forms. With a
 * book, each write is looked around as it is found, so no file's shape
 * outlives its own visit. An address-taking line (`T *p = &a->f`) is
 * followed to the writes through its alias, reported as writes of the name. */
function nameRequest(
  forms: NameForms,
  out: NameHit[],
  opts: { book?: CompanionBook; flags?: { aliasCut: boolean; aliasWindowCut?: boolean } } = {},
): SweepReq {
  const index = new Map<string, number>();
  let aliasScans = 0;
  const put = (shape: Shape, h: NameHit): void => {
    const k = `${h.path}:${h.line}`;
    const i = index.get(k);
    if (i !== undefined) {
      if (out[i]!.occ.kind === "write" || h.occ.kind !== "write") return;
      out[i] = h;
    } else {
      index.set(k, out.length);
      out.push(h);
    }
    const book = opts.book;
    // A key in a literal is part of the literal's statement: its lines are
    // the literal's other keys, no companion.
    if (h.occ.kind === "write" && book && h.occ.how !== "key") {
      if (book.captured >= COMPANION_MAX_SITES) book.cut = true;
      else {
        book.captured++;
        h.near = companionsAt(shape, h.path, h.line, book);
      }
    }
  };
  return {
    tokens: [...forms.forms, ...forms.setters],
    onHit(path, shape, line) {
      const sl = shape.lines[line - 1];
      if (!sl || sl.kind === "comment" || sl.kind === "blank") return;
      let best: Occurrence | null = null;
      let alias: { name: string; member: boolean } | null = null;
      for (const { token, at } of tokensOf(sl.raw)) {
        const setter = forms.setters.has(token);
        if (!setter && !forms.forms.has(token)) continue;
        // a `$name` token is the name (JS, PHP)
        const occ = classifyOccurrence(sl.raw, sl.code, at, token.length, setter);
        if (occ === null) continue;
        if (occ.kind === "write") {
          best = occ;
          break;
        }
        if (alias === null && !setter) alias = aliasOf(sl.code, at, token.length);
        best ??= occ;
      }
      if (!best) return;
      put(shape, {
        path,
        line,
        occ: best,
        label: fnLabel(shape, line),
        raw: sl.raw,
        fn: fnIdOf(shape, line),
      });
      if (best.kind !== "read" || alias === null) return;
      if (aliasScans >= ALIAS_MAX_SCANS) {
        if (opts.flags) opts.flags.aliasCut = true;
        return;
      }
      aliasScans++;
      const via = writesThroughAlias(shape, line, alias);
      if (via.windowCut && opts.flags) opts.flags.aliasWindowCut = true;
      for (const L of via.lines)
        put(shape, {
          path,
          line: L,
          occ: { kind: "write", how: `via ${alias.name}` },
          label: fnLabel(shape, L),
          raw: shape.lines[L - 1]!.raw,
          fn: fnIdOf(shape, L),
        });
    },
  };
}

// ---------------------------------------------------------------------------
// Coverage: which statements come before which exits

interface Stmt {
  line: number;
  key: StmtKey;
}

interface Coverage {
  fn: Block;
  exits: Exit[];
  stmts: Stmt[];
  /** `firstTokenLine` per token, filled as asked: one pass per token. */
  firstLines: Map<string, number>;
  covers(s: Stmt, e: Exit): boolean;
  /** Where a statement takes effect: a finally block's at its try's head. */
  from(s: Stmt): number;
}

/** Statement lines of `fn` (its own lines, not a nested function's). */
function stmtsOf(shape: Shape, fn: Block): Stmt[] {
  const out: Stmt[] = [];
  const heads = new Set<number>();
  for (const b of shape.structure?.blocks ?? []) if (b.kind === "function") heads.add(b.open);
  for (let L = fn.body; L <= fn.end; L++) {
    const sl = shape.lines[L - 1];
    if (!sl || sl.kind !== "code" || sl.cont || heads.has(L)) continue;
    if (functionOfLine(shape, L)?.id !== fn.id) continue;
    let code = sl.code;
    if (L === fn.end && familyOf(shape.dialect!) === "brace") {
      const at = code.lastIndexOf("}");
      code = at >= 0 ? code.slice(0, at) : code;
    }
    const key = stmtKey(code);
    if (key) out.push({ line: L, key });
  }
  return out;
}

/** Why a function is too large to compare exit by exit, or null. The
 * comparison is statements × exits, so both are capped. */
function tooLarge(fn: Block, cov?: { exits: Exit[]; stmts: Stmt[] }): string | null {
  if (fn.end - fn.body > MAX_FN_LINES)
    return `\`${fn.name ?? "<anonymous>"}\` spans over ${MAX_FN_LINES} lines`;
  if (cov && cov.exits.length > MAX_FN_EXITS)
    return `\`${fn.name ?? "<anonymous>"}\` has over ${MAX_FN_EXITS} exits`;
  if (cov && cov.stmts.length > MAX_FN_STMTS)
    return `\`${fn.name ?? "<anonymous>"}\` has over ${MAX_FN_STMTS} statements`;
  return null;
}

const COVERAGE = new WeakMap<Shape, Map<number, Coverage | string>>();

/** The exit comparison of one function, or the reason it is too large;
 * made once per shape and function. */
function coverageOf(shape: Shape, fn: Block): Coverage | string {
  let known = COVERAGE.get(shape);
  if (!known) {
    known = new Map();
    COVERAGE.set(shape, known);
  }
  const hit = known.get(fn.id);
  if (hit !== undefined) return hit;
  const made = makeCoverage(shape, fn);
  known.set(fn.id, made);
  return made;
}

function makeCoverage(shape: Shape, fn: Block): Coverage | string {
  const big = tooLarge(fn);
  if (big) return big;
  const st = shape.structure!;
  const exits = exitsOf(shape, fn);
  const stmts = stmtsOf(shape, fn);
  const bigger = tooLarge(fn, { exits, stmts });
  if (bigger) return bigger;
  const blockFor = (line: number, isEnd: boolean): Block =>
    isEnd ? fn : (blockOfLine(shape, line) ?? fn);
  // finally blocks: the try block they guard
  const guards: { fin: Block; tryB: Block }[] = [];
  const lastTry = new Map<number, Block>();
  for (const b of st.blocks) {
    if (b.open > fn.end) break;
    if (b.keyword === "try") lastTry.set(b.parent, b);
    if (b.keyword !== "finally" || b.id === fn.id || !isWithin(st, b, fn)) continue;
    const tryB = lastTry.get(b.parent);
    if (tryB) guards.push({ fin: b, tryB });
  }
  return {
    fn,
    exits,
    stmts,
    firstLines: new Map(),
    covers(s, e) {
      const sb = blockFor(s.line, false);
      const eb = blockFor(e.line, e.kind === "end");
      for (const g of guards) {
        // Only a statement directly in the finally block runs on every exit;
        // one under a condition there (`if (ok) reset()`) takes the
        // positional rule like any other.
        if (sb.id !== g.fin.id) continue;
        // A finally block runs before every exit of its try, and before any
        // later exit its try's level reaches.
        if (e.line >= g.tryB.open && e.line < g.fin.open) return true;
        if (e.line > g.fin.end || (e.kind === "end" && e.line >= g.fin.end)) {
          const level = g.fin.parent >= 0 ? st.blocks[g.fin.parent]! : fn;
          return isWithin(st, eb, level);
        }
      }
      if (s.line >= e.line) return false;
      return isWithin(st, eb, sb);
    },
    from(s) {
      const sb = blockFor(s.line, false);
      for (const g of guards) if (sb.id === g.fin.id) return g.tryB.open;
      return s.line;
    },
  };
}

function exitLabel(e: Exit): string {
  return `${e.kind}@L${e.line}`;
}

/** A block's head as the author wrote it, string literals included, when it
 * sits on one line; the lexed head (literals blanked) otherwise. */
function shownHead(shape: Shape, b: Block): string {
  if (b.open === b.body) {
    const raw =
      shape.lines[b.open - 1]?.raw
        .trim()
        .replace(/^\}\s{0,8}/, "")
        .replace(/\{\s{0,8}$/, "")
        .trimEnd() ?? "";
    if (raw !== "" && raw.length <= 400) return raw;
  }
  return b.head;
}

/** The branch chain to a line: block heads, plus a brace-less condition on
 * the line above and a condition on the line itself. */
function chainText(shape: Shape, line: number, fn: Block): string {
  const parts = chainOf(shape, line, fn).map(
    (b) => `${span(shownHead(shape, b).slice(0, 80))} @L${b.open}`,
  );
  const own = blockOfLine(shape, line);
  for (let k = line - 1; k > fn.body; k--) {
    const sl = shape.lines[k - 1]!;
    if (sl.kind !== "code") continue;
    const t = sl.code.trim();
    if (
      blockOfLine(shape, k)?.id === own?.id &&
      /^(?:\}\s{0,4})?(?:if|else|for|while)\b/.test(t) &&
      !/[;{}]$/.test(t)
    )
      parts.push(`${span(t)} @L${k} (no braces)`);
    break;
  }
  const code = shape.lines[line - 1]?.code.trim() ?? "";
  if (/^(?:\}\s{0,4})?(?:if|else|elif|case|when)\b/.test(code))
    parts.push("(condition on the same line)");
  return parts.join(" > ");
}

// ---------------------------------------------------------------------------
// Request validation

function badPath(p: string): string | null {
  if (p.length === 0 || p.length > PATH_MAX)
    return "`file` must be a repo-relative path of at most 512 characters";
  if (
    p.startsWith("/") ||
    p.includes("\0") ||
    p.includes("\\") ||
    p.split("/").some((s) => s === ".." || s === ".")
  )
    return "`file` must be a repo-relative path with no `..`, `.`, backslash or leading `/`";
  return null;
}

/** The request's own fields checked; a refusal text when they do not hold. */
export function exploreRequestRefusal(req: ExploreRequest): string | null {
  if (!EXPLORE_ACTIONS.includes(req.action))
    return `refused: \`action\` must be one of ${EXPLORE_ACTIONS.join(", ")}`;
  if (req.action === "writes" || req.action === "reads") {
    if (typeof req.name !== "string" || nameFormsOf(req.name) === null)
      return "refused: `name` must be an identifier (A-Z, a-z, 0-9, _, $; at most 80 characters), or a dotted/-> path whose last segment is one";
    if (req.file !== undefined) {
      const why = badPath(req.file.replace(/\/$/, ""));
      if (why) return `refused: ${why}`;
    }
  }
  if (req.action === "exits" || req.action === "siblings") {
    if (typeof req.file !== "string")
      return `refused: \`${req.action}\` needs \`file\` and \`line\``;
    const why = badPath(req.file);
    if (why) return `refused: ${why}`;
    if (
      typeof req.line !== "number" ||
      !Number.isInteger(req.line) ||
      req.line < 1 ||
      req.line > 10_000_000
    )
      return "refused: `line` must be a positive whole number";
  }
  return null;
}

// ---------------------------------------------------------------------------
// writes / reads

/** The write shapes the `writes` action reads, said beside a "none": a
 * write through any other shape is not seen, so none clears only these. */
const WRITE_SHAPES =
  "the shapes read: an assignment, ++/--, a setter, a store through a member chain, a collection or atomic method on it (set, add, delete, push, append, insert, put, erase, store, fetch_*, …), an atomic call taking its address, an SQL SET, a key in a literal, and a pointer bound to its address in the same function; a write through a call, a copy of a pointer or a reference is not seen";

async function runName(ctx: Ctx, req: ExploreRequest, mode: "writes" | "reads"): Promise<string[]> {
  const forms = nameFormsOf(req.name!)!;
  const out: string[] = [];
  const formList = [...forms.forms].join(", ");
  const setterList = [...forms.setters].join(", ");
  out.push(
    `${mode} of \`${forms.name}\` — forms ${formList}; setters ${setterList} (by name, not by type)`,
  );
  const listing = await ctx.list();
  if (listing === null) {
    out.push("unknown: the head tree listing could not be read, so nothing was searched");
    return out;
  }
  const diff = await safeDiff(ctx);
  const diffPaths = (diff ?? []).map((f) => f.filename);
  const filterPath = req.file?.replace(/\/$/, "");
  const filter =
    filterPath === undefined
      ? undefined
      : (p: string) => p === filterPath || p.startsWith(`${filterPath}/`);
  const dirs = new Set(
    filterPath !== undefined ? [filterPath, dirOf(filterPath)] : diffPaths.map(dirOf),
  );
  const order = sweepOrder(listing, diffPaths, dirs, filter);
  if (filterPath !== undefined && order.length === 0) {
    out.push(
      `unknown: no code file at or under ${span(filterPath)} in the head tree (tests and vendored code are left out)`,
    );
    return out;
  }
  const pos = new Map(order.map((p, i) => [p, i]));
  const hits: NameHit[] = [];
  const book = mode === "writes" ? newBook() : undefined;
  const flags = { aliasCut: false, aliasWindowCut: false };
  const stats = await sweep(
    ctx,
    [nameRequest(forms, hits, { ...(book ? { book } : {}), flags })],
    order,
  );
  const mine = hits.filter((h) =>
    mode === "writes" ? h.occ.kind === "write" : h.occ.kind === "read",
  );
  const files = new Set(mine.map((h) => h.path));
  out.push(
    `${mine.length} site${mine.length === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"}; ${sweepLine(stats)}`,
  );
  if (mode === "writes") {
    const sites = mine.map((h) => ({
      path: h.path,
      line: h.line,
      order: pos.get(h.path) ?? 0,
      text: siteText(h.path, h.line, h.label, h.raw, h.occ.how),
    }));
    out.push(...renderSites(sites));
    out.push(...usuallyWith(forms, mine, book!, pos, !whole(stats)));
  } else {
    const cats = ["condition", "return", "argument", "other"] as const;
    const counts = cats.map((c) => `${c} ${mine.filter((h) => h.occ.how === c).length}`);
    out.push(`by use: ${counts.join(", ")}`);
    const sites = mine.map((h) => ({
      path: h.path,
      line: h.line,
      order: cats.indexOf(h.occ.how as (typeof cats)[number]) * 1_000_000 + (pos.get(h.path) ?? 0),
      text: siteText(h.path, h.line, h.label, h.raw, h.occ.how),
    }));
    out.push(...renderSites(sites));
  }
  if (mine.length === 0)
    out.push(
      whole(stats)
        ? `none in the files searched${mode === "writes" ? ` — ${WRITE_SHAPES}` : ""}`
        : "none in the files searched — the sweep was cut, so this clears nothing",
    );
  if (flags.aliasCut)
    out.push(
      `[cut: writes through an address-taking alias were followed for the first ${ALIAS_MAX_SCANS} such lines]`,
    );
  if (flags.aliasWindowCut) out.push(ALIAS_WINDOW_NOTE);
  return out;
}

/** The `writes` action's companion table: the statements that sit beside
 * the writes in most writing functions, and the writes they are missing at.
 * A key in a literal is no write here (its neighbours are the literal). */
function usuallyWith(
  forms: NameForms,
  all: readonly NameHit[],
  book: CompanionBook,
  pos: ReadonlyMap<string, number>,
  cut: boolean,
): string[] {
  const head = `usually with — statements beside the writes in at least two-thirds of the writing functions (same block or ±${SIBLING_NEAR} lines, same function; a function counted once; keys in a literal left out; by name, literals abstracted):`;
  if (book.cut)
    return [
      `${head} not compared: the writes past the first ${COMPANION_MAX_SITES} were not looked around`,
    ];
  const writes = all.filter((h) => h.occ.how !== "key");
  const units = unitCount(writes);
  if (units < 3) return [`${head} not compared: fewer than 3 writing functions`];
  const idioms: string[] = [];
  const rows = usualPartners(forms, writes, book, idioms);
  const out = [head];
  if (rows.length === 0)
    out.push(cut ? "none of the writes found (the sweep was cut, so this clears nothing)" : "none");
  for (const r of rows.slice(0, 6)) {
    const covered = new Set(r.have.map(unitOf));
    const lack = writes
      .filter((h) => !covered.has(unitOf(h)))
      .sort((a, b) => (pos.get(a.path) ?? 0) - (pos.get(b.path) ?? 0) || a.line - b.line);
    out.push(
      `- ${span(r.partner.shown)} beside the writes in ${r.units} of ${units} functions${
        lack.length === 0
          ? ""
          : `; not beside: ${lack
              .slice(0, 6)
              .map((h) => `${h.path}:${h.line}`)
              .join(", ")}${lack.length > 6 ? ` and ${lack.length - 6} more` : ""}`
      }`,
    );
  }
  if (rows.length > 6) out.push(`[cut: ${rows.length - 6} more rows not shown]`);
  if (idioms.length > 0)
    out.push(
      `[left out as idioms (${BUSY_COWRITE_SITES} or more statements, most away from these writes): ${idioms
        .slice(0, 4)
        .map(span)
        .join(", ")}]`,
    );
  return out;
}

function safeDiff(ctx: Ctx): Promise<readonly PrFileEntry[] | null> {
  return ctx.diff();
}

// ---------------------------------------------------------------------------
// exits

async function loadShape(ctx: Ctx, file: string, out: string[]): Promise<Shape | null> {
  const listing = await ctx.list();
  if (listing !== null && !listing.some((e) => e.path === file)) {
    out.push(`unknown: ${span(file)} is not a file in the head tree`);
    return null;
  }
  const load = await ctx.head(file, true);
  if (!load.ok) {
    out.push(`unknown: ${span(file)} was not read: ${whyText(load.why, load.cap)}`);
    return null;
  }
  return ctx.shape(file, load.text);
}

async function runExits(ctx: Ctx, req: ExploreRequest): Promise<string[]> {
  const out: string[] = [];
  const file = req.file!;
  const line = req.line!;
  const shape = await loadShape(ctx, file, out);
  if (!shape) return out;
  if (line > shape.lines.length)
    return [
      `unknown: ${span(file)} has ${shape.lines.length} lines at the head; line ${line} is past its end`,
    ];
  if (!shape.structure)
    return [
      `unknown: the structure of ${span(file)} could not be read: ${shape.unknown ?? "unknown reason"}`,
    ];
  const fn = functionAt(shape, line);
  if (!fn)
    return [
      `unknown: line ${line} of ${span(file)} is not inside a function the structure recognises`,
    ];
  const cov = coverageOf(shape, fn);
  if (typeof cov === "string") return [`unknown: ${cov}; the comparison is not made`];
  out.push(
    `exits of \`${fn.name ?? "<anonymous>"}\` — ${file} lines ${fn.open}–${fn.end}; head: ${span(shownHead(shape, fn))}`,
  );
  out.push(`[limits: ${SHAPE_LIMITS}]`);
  for (const n of shape.notes) out.push(`[note: ${n}]`);
  for (const e of cov.exits) {
    const own = blockOfLine(shape, e.line);
    const ownId = e.kind === "end" ? fn.id : own?.id;
    const before = cov.stmts
      .filter((s) => s.line < e.line && blockOfLine(shape, s.line)?.id === ownId)
      .slice(-6)
      .map((s) => `${span(s.key.key)} L${s.line}`);
    const chain = e.kind === "end" ? "" : chainText(shape, e.line, fn);
    out.push(
      `- ${exitLabel(e)}${e.handler ? " (handler)" : ""}${chain ? ` — via ${chain}` : ""}${before.length > 0 ? ` — before it in its block: ${before.join(", ")}` : ""}`,
    );
  }
  const leaving = cov.exits.filter((e) => LEAVING.has(e.kind) && !e.handler);
  const rows = companionRows(cov, leaving);
  out.push(
    "companions — statements before some exits and not others, among the exits after the statement's first line (a statement counts for an exit when an earlier line of a block holding the exit has it; a finally block counts for the exits of its try):",
  );
  if (leaving.length < 2) out.push("none: the function has fewer than two exits that leave it");
  else if (rows.length === 0)
    out.push(
      "none among exits after each statement's first line (an exit above a statement skips it: see the skipped tails below)",
    );
  else out.push(...rows.slice(0, EXPLORE_MAX_SITES));
  if (rows.length > EXPLORE_MAX_SITES)
    out.push(`[cut: ${rows.length - EXPLORE_MAX_SITES} more companion rows not shown]`);
  // What an early exit jumps over: the function's own-level statements after
  // it, terminal calls first.
  const tails: string[] = [];
  for (const e of leaving) {
    if (e.kind === "end") continue;
    const tail = skippedTail(shape, cov, e);
    if (tail.length === 0) continue;
    tails.push(
      `- ${exitLabel(e)} skips ${tail
        .slice(0, 6)
        .map((s) => `${span(s.key.key)} L${s.line}`)
        .join(", ")}${tail.length > 6 ? ` and ${tail.length - 6} more` : ""}`,
    );
  }
  out.push(
    "skipped tails — statements at the function's own level after an exit, which that exit does not reach (terminal calls first):",
  );
  if (tails.length === 0) out.push("none");
  else out.push(...tails.slice(0, EXPLORE_MAX_SITES));
  if (tails.length > EXPLORE_MAX_SITES)
    out.push(`[cut: ${tails.length - EXPLORE_MAX_SITES} more skipped tails not shown]`);
  return out;
}

/** The asymmetry table: per statement key, the leaving exits it comes
 * before and the ones it does not, among exits after the key's first line. */
function companionRows(cov: Coverage, leaving: readonly Exit[]): string[] {
  const byKey = new Map<string, Stmt[]>();
  for (const s of cov.stmts) {
    const list = byKey.get(s.key.key) ?? [];
    list.push(s);
    byKey.set(s.key.key, list);
  }
  const rows: string[] = [];
  for (const [key, list] of byKey) {
    const first = firstTokenLine(cov, list[0]!.key.token);
    const relevant = leaving.filter((e) => e.line > first);
    const have = relevant.filter((e) => list.some((s) => cov.covers(s, e)));
    const lack = relevant.filter((e) => !list.some((s) => cov.covers(s, e)));
    if (have.length === 0 || lack.length === 0) continue;
    rows.push(
      `- ${span(key)} (L${list.map((s) => s.line).join(", L")}): before ${have.map(exitLabel).join(", ")}; missing before ${lack.map(exitLabel).join(", ")}`,
    );
  }
  return rows;
}

/** The first line of the function that touches the token: exits before it
 * leave before the state was entered. */
function firstTokenLine(cov: Coverage, token: string): number {
  const known = cov.firstLines.get(token);
  if (known !== undefined) return known;
  let first = Number.POSITIVE_INFINITY;
  for (const s of cov.stmts) if (s.key.token === token) first = Math.min(first, cov.from(s));
  const line = first === Number.POSITIVE_INFINITY ? cov.fn.body : first;
  cov.firstLines.set(token, line);
  return line;
}

// ---------------------------------------------------------------------------
// siblings

/** The identifier a statement is searched by: its longest token that is not
 * a keyword. */
const SEARCH_STOP = new Set([
  "this",
  "self",
  "return",
  "const",
  "let",
  "var",
  "await",
  "async",
  "true",
  "false",
  "null",
  "nil",
  "None",
  "undefined",
  "new",
  "if",
  "else",
  "for",
  "while",
  "function",
  "func",
  "def",
  "err",
]);

function searchToken(code: string): string | null {
  let best: string | null = null;
  for (const { token } of tokensOf(code)) {
    if (token.length < 3 || SEARCH_STOP.has(token) || /^\d/.test(token)) continue;
    if (best === null || token.length > best.length) best = token;
  }
  return best;
}

interface Neighbour {
  line: number;
  key: StmtKey;
}

const HEAD_LINES = new WeakMap<Shape, Set<number>>();

/** The lines that open a block (a head is not a statement); built once per
 * shape. */
function headLines(shape: Shape): Set<number> {
  let out = HEAD_LINES.get(shape);
  if (!out) {
    out = new Set<number>();
    for (const b of shape.structure?.blocks ?? []) out.add(b.open);
    HEAD_LINES.set(shape, out);
  }
  return out;
}

/** The statements within `SIBLING_WINDOW` lines of `line`, nearest first:
 * the same function's own lines, block heads and the line itself left out. */
function neighboursOf(shape: Shape, line: number): Neighbour[] {
  const out: Neighbour[] = [];
  const fn = shape.structure ? functionOfLine(shape, line) : null;
  const heads = headLines(shape);
  for (let d = 1; d <= SIBLING_WINDOW; d++)
    for (const k of [line - d, line + d]) {
      const sl = shape.lines[k - 1];
      if (!sl || sl.kind !== "code" || sl.cont || heads.has(k)) continue;
      if (shape.structure && functionOfLine(shape, k)?.id !== fn?.id) continue;
      const key = stmtKey(sl.code);
      if (key) out.push({ line: k, key });
    }
  return out;
}

/** Whether a statement within `SIBLING_NEAR` lines of `line`, in the same
 * function when the structure is known, has the partner id `id`. */
function nearHoldsId(shape: Shape, line: number, id: string): boolean {
  const fn = shape.structure ? functionOfLine(shape, line) : null;
  for (
    let k = Math.max(1, line - SIBLING_NEAR);
    k <= Math.min(shape.lines.length, line + SIBLING_NEAR);
    k++
  ) {
    if (k === line) continue;
    const key = keyAt(shape, k);
    if (!key || partnerId(key) !== id) continue;
    if (shape.structure && functionOfLine(shape, k)?.id !== fn?.id) continue;
    return true;
  }
  return false;
}

/** Whether a code line within `SIBLING_NEAR` lines of `line`, in the same
 * function when the structure is known, holds `token`. */
function nearHolds(shape: Shape, line: number, token: string): boolean {
  const fn = shape.structure ? functionOfLine(shape, line) : null;
  for (
    let k = Math.max(1, line - SIBLING_NEAR);
    k <= Math.min(shape.lines.length, line + SIBLING_NEAR);
    k++
  ) {
    if (k === line) continue;
    const sl = shape.lines[k - 1]!;
    if (sl.kind !== "code" || !holdsWord(sl.code, token)) continue;
    if (shape.structure && functionOfLine(shape, k)?.id !== fn?.id) continue;
    return true;
  }
  return false;
}

interface Occ {
  path: string;
  line: number;
  label: string;
  raw: string;
  fnId: number;
  /** The wanted neighbour tokens not found near it. */
  missing: string[];
  /** Its own neighbours' partner ids (±`SIBLING_WINDOW`), when asked for. */
  around?: string[];
}

/** A sweep request for the other lines whose normalised code equals `norm`;
 * each occurrence is checked for `near` tokens as it is found, so no file's
 * shape outlives its own visit. */
function shapeRequest(
  token: string,
  norm: string,
  self: { path: string; line: number },
  near: readonly string[],
  out: Occ[],
  book?: CompanionBook,
): SweepReq {
  return {
    tokens: [token],
    onHit(path, shape, line) {
      if (path === self.path && line === self.line) return;
      const sl = shape.lines[line - 1];
      if (!sl || sl.kind !== "code") return;
      if (normalise(sl.code) !== norm) return;
      out.push({
        path,
        line,
        label: fnLabel(shape, line),
        raw: sl.raw,
        fnId: fnIdOf(shape, line),
        missing: near.filter((t) => !nearHolds(shape, line, t)),
        ...(book
          ? {
              around: [
                ...new Set(
                  neighboursOf(shape, line).map((n) => {
                    const id = partnerId(n.key);
                    if (!book.dict.has(id))
                      book.dict.set(id, { shown: partnerShown(n.key), key: n.key });
                    return id;
                  }),
                ),
              ],
            }
          : {}),
      });
    },
  };
}

async function runSiblings(ctx: Ctx, req: ExploreRequest): Promise<string[]> {
  const out: string[] = [];
  const file = req.file!;
  const line = req.line!;
  const shape = await loadShape(ctx, file, out);
  if (!shape) return out;
  const sl = shape.lines[line - 1];
  if (!sl)
    return [
      `unknown: ${span(file)} has ${shape.lines.length} lines at the head; line ${line} is past its end`,
    ];
  if (sl.kind !== "code")
    return [`unknown: line ${line} of ${span(file)} holds no code (${sl.kind})`];
  const norm = normalise(sl.code);
  const token = searchToken(sl.code);
  out.push(`siblings of ${file}:${line} (${fnLabel(shape, line)}): ${span(sl.raw)}`);
  out.push(`[limits: ${SHAPE_LIMITS}]`);
  if (!shape.structure)
    out.push(
      `[note: the structure of this file is unknown (${shape.unknown}); the function column says so]`,
    );
  const neighbours = neighboursOf(shape, line);
  out.push(
    neighbours.length > 0
      ? `its neighbours (±${SIBLING_WINDOW} lines): ${neighbours.map((n) => `${span(n.key.key)} L${n.line}`).join(", ")}`
      : `its neighbours (±${SIBLING_WINDOW} lines): none hold a call or a member write`,
  );
  if (token === null) {
    out.push("unknown: the statement holds no identifier to search by");
    return out;
  }
  const listing = await ctx.list();
  if (listing === null) {
    out.push("unknown: the head tree listing could not be read, so no occurrence was searched");
    return out;
  }
  const occs: Occ[] = [];
  const diff = await safeDiff(ctx);
  const order = sweepOrder(
    listing,
    [file, ...(diff ?? []).map((f) => f.filename)],
    new Set([dirOf(file)]),
  );
  const pos = new Map(order.map((p, i) => [p, i]));
  const nearTokens = [...new Set(neighbours.map((n) => n.key.token))];
  const book = newBook();
  const stats = await sweep(
    ctx,
    [shapeRequest(token, norm, { path: file, line }, nearTokens, occs, book)],
    order,
  );
  const fnId = fnIdOf(shape, line);
  const sameFn = occs.filter((o) => o.path === file && fnId >= 0 && o.fnId === fnId).length;
  const sameFile = occs.filter((o) => o.path === file).length;
  out.push(
    `other occurrences — same function: ${sameFn}, same file: ${sameFile}, tree: ${occs.length}; ${sweepLine(stats)}`,
  );
  const sites: Site[] = occs.map((o) => {
    const missing = neighbours
      .filter((n) => o.missing.includes(n.key.token))
      .map((n) => span(n.key.key));
    return {
      path: o.path,
      line: o.line,
      order: (o.path === file ? 0 : 1) * 1_000_000 + (pos.get(o.path) ?? 0),
      text: `${siteText(o.path, o.line, o.label, o.raw)} — ${neighbours.length === 0 ? "(no neighbours to compare)" : missing.length > 0 ? `missing near it (±${SIBLING_NEAR}): ${missing.join(", ")}` : "all neighbours present"}`,
    };
  });
  out.push(...renderSites(sites));
  if (occs.length === 0)
    out.push(
      whole(stats)
        ? "no other occurrence in the files searched"
        : "no other occurrence in the files searched — the sweep was cut, so this clears nothing",
    );
  else out.push(originalLacks(shape, file, line, occs, book, !whole(stats)));
  return out;
}

/** The other direction: what sits beside more than half of the other
 * occurrences (±`SIBLING_WINDOW`) and is not within ±`SIBLING_NEAR` lines of
 * the statement asked about, so the answer does not depend on which of two
 * sites was asked. */
function originalLacks(
  shape: Shape,
  file: string,
  line: number,
  occs: readonly Occ[],
  book: CompanionBook,
  cut: boolean,
): string {
  const by = new Map<string, number>();
  for (const o of occs) for (const id of o.around ?? []) by.set(id, (by.get(id) ?? 0) + 1);
  const own = keyAt(shape, line);
  const self = own ? partnerId(own) : "";
  const rows = [...by]
    .filter(([id, n]) => id !== self && n * 2 > occs.length && !nearHoldsId(shape, line, id))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const head = `what ${file}:${line} lacks — statements beside more than half of the other occurrences (±${SIBLING_WINDOW}) and not within ±${SIBLING_NEAR} lines of it:`;
  if (rows.length === 0)
    return `${head} none${cut ? " among the occurrences found (the sweep was cut, so this clears nothing)" : ""}`;
  return `${head} ${rows
    .slice(0, 6)
    .map(([id, n]) => `${span(book.dict.get(id)!.shown)} (beside ${n} of ${occs.length})`)
    .join(", ")}${rows.length > 6 ? ` and ${rows.length - 6} more` : ""}`;
}

// ---------------------------------------------------------------------------
// anchors

export type AnchorKind =
  | "moved-call"
  | "exit-gap"
  | "cowrite-gap"
  | "persisted-shape"
  | "writes-no-tx"
  | "call-to-cache"
  | "new-writer"
  | "writer-companion";

export const ANCHOR_KINDS: readonly AnchorKind[] = [
  "moved-call",
  "exit-gap",
  "cowrite-gap",
  "persisted-shape",
  "writes-no-tx",
  "call-to-cache",
  "new-writer",
  "writer-companion",
];

interface Anchor {
  kind: AnchorKind;
  rank: number;
  path: string;
  line: number;
  fn: string;
  text: string;
  fileOrder: number;
}

interface Changed {
  entry: PrFileEntry;
  order: number;
  path: string;
  basePath: string;
  added: Map<number, string>;
  removed: Map<number, string>;
  /** Head lines next to a removal. */
  touched: Set<number>;
  /** Runs of removed then added lines: [base line, head line] pairs in order. */
  runs: { removed: { line: number; text: string }[]; added: { line: number; text: string }[] }[];
  head: Shape | null;
  headWhy?: string;
  /** Why the patch was not read (over `MAX_PATCH_CHARS`): its lines are empty. */
  patchWhy?: string;
  base: Shape | null;
  baseWhy?: string;
  code: boolean;
  test: boolean;
}

/** Callees whose place in the flow is the state's exit: a moved one ranks first. */
const TERMINAL_PARTS = [
  "unlock",
  "release",
  "close",
  "free",
  "dispose",
  "destroy",
  "cancel",
  "finish",
  "complete",
  "done",
  "resolve",
  "reject",
  "cleanup",
  "teardown",
  "notify",
  "signal",
  "emit",
  "dispatch",
  "unsubscribe",
  "decref",
  "callback",
  "reset",
];
const TERMINAL_WHOLE = new Set(["cb", "next", "end", "stop", "off", "done", "Done"]);
const TERMINAL_SETTER_RE =
  /^set\w{0,40}(?:Loading|Busy|Pending|Saving|Submitting|Running|Fetching|Processing|Syncing|InFlight|InProgress)$/;

export function isTerminalCallee(token: string): boolean {
  if (TERMINAL_WHOLE.has(token) || TERMINAL_SETTER_RE.test(token)) return true;
  const low = token.toLowerCase();
  return TERMINAL_PARTS.some((p) => low.includes(p));
}

const VERSION_LINE_RE =
  /\bversion\s{0,4}[:=]\s{0,4}\d|\bcreateMigrate\b|\bmigrations?\s{0,4}[:={(]|\buser_version\b|\.version\s{0,4}\(\s{0,4}\d|\bschema_version\b|\bSCHEMA_VERSION\b|\bDB_VERSION\b|\bindexedDB\.open\s{0,4}\(/i;
const SLICE_HEAD_RE =
  /\binitialState\b|\binterface\s{1,4}\w{0,60}State\b|\btype\s{1,4}\w{0,60}State\s{0,4}=|\bState\s{0,4}=\s{0,4}\{|createSlice\s{0,4}\(/;
const PERSIST_TOKENS = ["persistReducer", "persistStore", "persistConfig", "createMigrate"];
const STORE_HEAD_RE = /\b(?:schema|defaults)\b/;
const DEXIE_RE = /\.stores\s{0,4}\(|\.version\s{0,4}\(\s{0,4}\d{1,6}\s{0,4}\)/;
const IDB_STORE_RE = /\b(?:createObjectStore|createIndex|deleteObjectStore|deleteIndex)\s{0,4}\(/;
const IDB_OPEN_RE = /\bindexedDB\.open\s{0,4}\(/;
const DDL_RE =
  /\b(?:CREATE\s{1,8}TABLE|ALTER\s{1,8}TABLE|ADD\s{1,8}COLUMN|DROP\s{1,8}COLUMN|RENAME\s{1,8}COLUMN)\b/i;
const PROTO_FIELD_RE =
  /^\s{0,40}(?:(?:optional|required|repeated)\s{1,8})?([\w.<>, ]{1,120}?)\s{1,8}(\w{1,80})\s{0,4}=\s{0,4}(\d{1,9})\b/;
const LOCAL_STORE_RE =
  /\b(?:localStorage|sessionStorage|AsyncStorage|setItem\s{0,4}\(|getItem\s{0,4}\()/;
const FIELD_DECL_RE = /^\s{0,40}(?:readonly\s{1,4})?[\w$]{1,60}\??\s{0,4}:/;
/** The block keywords of a record type whose fields may be serialized. */
const STRUCT_KEYWORDS: ReadonlySet<string> = new Set(["struct", "class"]);
const VERSION_WORD_RE = /\bversion\b/i;

/** Write calls, any language: an ORM or store write, a file write, an SQL
 * statement. */
const WRITE_CALL_RE =
  /\.(?:save|update|updateOne|updateMany|create|insert|insertOne|insertMany|delete|deleteOne|deleteMany|destroy|put|upsert|bulkCreate|bulk_create|bulk_update|setItem|removeItem|Exec|ExecContext|execute|executemany|executescript|persist|merge|flush)\s{0,4}\(|\b(?:fs\.(?:writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|appendFile|appendFileSync)|os\.(?:WriteFile|Rename|Remove)|ioutil\.WriteFile|sqlite3_exec|fwrite|rename|unlink)\s{0,4}\(/;
const SQL_WRITE_RE =
  /\b(?:INSERT\s{1,8}INTO|UPDATE\s{1,8}[\w"`.]{1,80}\s{1,8}SET|DELETE\s{1,8}FROM|REPLACE\s{1,8}INTO)\b/i;
const TX_RE =
  /transaction\.atomic|@atomic|\batomic\s{0,4}\(|session\.begin|\.begin\s{0,4}\(\s{0,4}\)|\.transaction\s{0,4}\(|\$transaction|\bBeginTx\b|\.Begin\s{0,4}\(|\.Commit\s{0,4}\(|@Transactional|\bBEGIN\b|\bCOMMIT\b|\bWriteBatch\b|\bwithTransaction\b|\bdb\.batch\b|\.batch\s{0,4}\(\s{0,4}\)|\btransaction\b|\bwith_transaction\b|\bsavepoint\b/i;
const CACHE_PREFIX_RE =
  /^(?:get|fetch|load|read|compute|calc|calculate|find|query|lookup|resolve)_?/i;

function changedFiles(diff: readonly PrFileEntry[]): Changed[] {
  const out: Changed[] = [];
  diff.forEach((entry, order) => {
    if (entry.patch === undefined) return;
    const added = new Map<number, string>();
    const removed = new Map<number, string>();
    const touched = new Set<number>();
    const runs: Changed["runs"] = [];
    const over = entry.patch.length > MAX_PATCH_CHARS;
    for (const h of over ? [] : parsePatch(entry.patch)) {
      let pending = false;
      let lastHead = 0;
      let run: Changed["runs"][number] | null = null;
      for (const l of h.lines) {
        if (l.kind === "-") {
          removed.set(l.line, l.text);
          pending = true;
          if (!run || run.added.length > 0) {
            run = { removed: [], added: [] };
            runs.push(run);
          }
          run.removed.push({ line: l.line, text: l.text });
          continue;
        }
        if (pending) {
          touched.add(l.line);
          pending = false;
        }
        if (l.kind === "+") {
          added.set(l.line, l.text);
          if (run) run.added.push({ line: l.line, text: l.text });
        } else run = null;
        lastHead = l.line;
      }
      if (pending && lastHead > 0) touched.add(lastHead);
    }
    out.push({
      entry,
      order,
      path: entry.filename,
      basePath: entry.previous_filename ?? entry.filename,
      added,
      removed,
      touched,
      runs,
      head: null,
      ...(over
        ? { patchWhy: `its patch is over ${MAX_PATCH_CHARS / (1024 * 1024)} MiB, not read` }
        : {}),
      base: null,
      code: isCodePath(entry.filename),
      test: isTestFile(entry.filename),
    });
  });
  return out;
}

/** The functions of the head the diff changes. */
function changedFunctions(c: Changed): Block[] {
  if (!c.head?.structure) return [];
  const seen = new Map<number, Block>();
  // The function whose body holds the line, else the one whose head it is
  // (lineFunctions, one lookup): never a walk over every block per line.
  const fnOf = lineFunctions(c.head);
  for (const L of [...c.added.keys(), ...c.touched]) {
    const id = fnOf[L - 1] ?? -1;
    const fn = functionOfLine(c.head, L) ?? (id >= 0 ? c.head.structure.blocks[id]! : null);
    if (fn) seen.set(fn.id, fn);
  }
  return [...seen.values()].sort((a, b) => a.open - b.open);
}

interface AnchorRun {
  anchors: Anchor[];
  unknown: Map<AnchorKind, string[]>;
  notes: string[];
  /** Moved lines still to compare one by one (`MAX_MOVED_LINES` per call). */
  movedLeft: number;
}

function addUnknown(run: AnchorRun, kind: AnchorKind, why: string): void {
  const list = run.unknown.get(kind) ?? [];
  if (!list.includes(why)) list.push(why);
  run.unknown.set(kind, list);
}

function anchor(
  run: AnchorRun,
  c: Changed,
  kind: AnchorKind,
  rank: number,
  line: number,
  text: string,
): void {
  const fn = c.head ? fnLabel(c.head, line) : "structure unknown";
  run.anchors.push({ kind, rank, path: c.path, line, fn, text, fileOrder: c.order });
}

// moved-call ---------------------------------------------------------------

function movedCalls(run: AnchorRun, c: Changed): void {
  const head = c.head;
  const base = c.base;
  if (!head || !base) return;
  const byText = new Map<string, { base: number[]; head: number[] }>();
  for (const [L, t] of c.removed) {
    const k = t.trim();
    if (k.length < 3) continue;
    const e = byText.get(k) ?? { base: [], head: [] };
    e.base.push(L);
    byText.set(k, e);
  }
  for (const [L, t] of c.added) {
    const e = byText.get(t.trim());
    if (e) e.head.push(L);
  }
  const pairs: { text: string; b: number; h: number }[] = [];
  for (const [text, e] of byText) {
    if (e.head.length === 0) continue;
    e.base.sort((x, y) => x - y);
    e.head.sort((x, y) => x - y);
    for (let i = 0; i < Math.min(e.base.length, e.head.length); i++)
      pairs.push({ text, b: e.base[i]!, h: e.head[i]! });
  }
  if (pairs.length === 0) return;
  const removedTexts = new Set(byText.keys());
  if (!head.structure || !base.structure) {
    addUnknown(
      run,
      "moved-call",
      `${c.path}: ${!head.structure ? `head structure unknown (${head.unknown})` : `base structure unknown (${base.unknown})`}; ${pairs.length} line${pairs.length === 1 ? "" : "s"} moved, depth not compared`,
    );
    return;
  }
  const moved: {
    text: string;
    b: number;
    h: number;
    key: StmtKey | null;
    exit: boolean;
    opener: Block | null;
    delta: number;
  }[] = [];
  for (const p of pairs) {
    const bl = base.lines[p.b - 1];
    const hl = head.lines[p.h - 1];
    if (!bl || !hl || hl.kind !== "code") continue;
    const key = stmtKey(hl.code);
    const exit = exitKindOf(hl.code, head.dialect!) !== null;
    if (!key && !exit) continue;
    const bo = blockOfLine(base, p.b);
    const ho = blockOfLine(head, p.h);
    const delta = hl.depth - bl.depth;
    const sameOpener = normalise(bo?.head ?? "") === normalise(ho?.head ?? "");
    if (delta === 0 && sameOpener) continue;
    let opener = ho;
    if (sameOpener) {
      // The line kept its own opener: the block around it moved, not the
      // line. It joins the wrap of the opener the diff added around it, or
      // it is a re-indent and no anchor at all.
      const wrap = addedAncestor(head, ho, c, removedTexts);
      if (!wrap) continue;
      opener = wrap;
    } else if (delta === 0) {
      // The opener's own line was edited in place (`if (a)` → `if (a && b)`,
      // a function renamed): the line stayed where it was.
      if (bo && ho && c.removed.has(bo.open) && c.added.has(ho.open)) continue;
    }
    moved.push({ text: p.text, b: p.b, h: p.h, key, exit, opener, delta });
  }
  // A block wrapped in a new opener: one anchor, never N moved lines.
  const groups = new Map<string, typeof moved>();
  for (const m of moved) {
    const g = `${m.opener?.id ?? -1}:${m.delta}`;
    const list = groups.get(g) ?? [];
    list.push(m);
    groups.set(g, list);
  }
  for (const list of groups.values()) {
    const opener = list[0]!.opener;
    const wrapped =
      list.length >= 3 &&
      opener !== null &&
      newOpener(head, c, opener.open, removedTexts) &&
      list[0]!.delta > 0;
    if (wrapped) {
      const terminal = list.filter((m) => m.key && isTerminalCallee(m.key.token));
      const holds =
        terminal.length > 0
          ? `; it holds ${terminal.map((m) => `${span(m.key!.key)} L${m.h}`).join(", ")}`
          : "";
      anchor(
        run,
        c,
        "moved-call",
        terminal.length > 0 || opener.kind === "function" ? 1 : 4,
        opener.open,
        opener.kind === "function"
          ? `${list.length} lines moved into the new callback ${span(shownHead(head, opener))}${holds} — they now run when it runs, not where they stood: does the code after it rely on them having run?`
          : `${list.length} lines wrapped in ${span(shownHead(head, opener))} (a re-indent: the block moved in whole)${holds} — do the paths that skip the new opener still reach what it now guards?`,
      );
      continue;
    }
    for (const m of list) {
      if (run.movedLeft <= 0) {
        addUnknown(
          run,
          "moved-call",
          `moved lines past the first ${MAX_MOVED_LINES} were not compared one by one`,
        );
        break;
      }
      run.movedLeft--;
      movedOne(run, c, m);
    }
  }
}

/** Whether the diff wrote the opener at `line` new: added, and not a
 * removed line re-indented (no removed line has its text). */
function newOpener(shape: Shape, c: Changed, line: number, moved: ReadonlySet<string>): boolean {
  return c.added.has(line) && !moved.has(shape.lines[line - 1]?.raw.trim() ?? "");
}

/** The nearest block around `b` (itself excluded) whose opener the diff
 * wrote new: a branch, or a callback the block was moved into (code that
 * now runs when the callback runs). The search stops at a function that is
 * not new. */
function addedAncestor(
  shape: Shape,
  b: Block | null,
  c: Changed,
  moved: ReadonlySet<string>,
): Block | null {
  const st = shape.structure;
  if (!st || !b) return null;
  for (
    let a = b.parent >= 0 ? st.blocks[b.parent]! : null;
    a;
    a = a.parent >= 0 ? st.blocks[a.parent]! : null
  ) {
    if (newOpener(shape, c, a.open, moved)) return a;
    if (a.kind === "function") return null;
  }
  return null;
}

function movedOne(
  run: AnchorRun,
  c: Changed,
  m: {
    text: string;
    b: number;
    h: number;
    key: StmtKey | null;
    exit: boolean;
    opener: Block | null;
    delta: number;
  },
): void {
  const head = c.head!;
  const st = head.structure!;
  const fn = functionOfLine(head, m.h);
  const where =
    m.opener && m.opener.kind !== "function"
      ? `${span(shownHead(head, m.opener))} @L${m.opener.open}`
      : "the function's own level";
  const parts = [
    `${span(m.text)} moved from base L${m.b} (depth ${head.lines[m.h - 1]!.depth - m.delta}) to depth ${head.lines[m.h - 1]!.depth} under ${where}`,
  ];
  if (fn) {
    const copies: number[] = [];
    for (let L = fn.body; L <= fn.end; L++) {
      if (L === m.h) continue;
      const sl = head.lines[L - 1]!;
      if (sl.kind !== "code" || sl.raw.trim() !== m.text) continue;
      if (
        m.opener &&
        m.opener.kind !== "function" &&
        isWithin(st, blockOfLine(head, L) ?? fn, m.opener)
      )
        continue;
      copies.push(L);
    }
    parts.push(
      copies.length > 0
        ? `a copy remains at L${copies.join(", L")}`
        : "no copy remains outside the new branch",
    );
    if (m.opener && m.opener.kind === "control" && m.key) {
      const siblings = st.blocks.filter(
        (b) =>
          b.parent === m.opener!.parent &&
          b.id !== m.opener!.id &&
          b.open >= m.opener!.open - 1 &&
          b.open <= m.opener!.end + 1 &&
          /^(?:else|else if|elif|catch|except|finally|case|default)$/.test(b.keyword),
      );
      const lacking = siblings.filter((b) => {
        for (let L = b.body; L <= b.end; L++)
          if (holdsWord(head.lines[L - 1]?.code ?? "", m.key!.token)) return false;
        return true;
      });
      if (lacking.length > 0)
        parts.push(
          `sibling branches without it: ${lacking.map((b) => `${span(shownHead(head, b).slice(0, 60))} @L${b.open}`).join(", ")}`,
        );
      const cov = coverageOf(head, fn);
      const stmt = typeof cov === "string" ? undefined : cov.stmts.find((s) => s.line === m.h);
      if (stmt && typeof cov !== "string") {
        const all = cov.stmts.filter((s) => s.key.key === stmt.key.key);
        const lack = cov.exits.filter(
          (e) =>
            LEAVING.has(e.kind) &&
            !e.handler &&
            e.line > firstTokenLine(cov, stmt.key.token) &&
            !all.some((s) => cov.covers(s, e)),
        );
        if (lack.length > 0)
          parts.push(`exits that do not pass it: ${lack.slice(0, 8).map(exitLabel).join(", ")}`);
      }
    }
  }
  const terminal = (m.key && isTerminalCallee(m.key.token)) || m.exit;
  anchor(
    run,
    c,
    "moved-call",
    terminal ? 0 : 3,
    m.h,
    `${parts.join("; ")} — does every path that reached it before still reach it?`,
  );
}

// exit-gap -----------------------------------------------------------------

/** A logging call: it leaves no state behind, so its place among the exits
 * is not a gap. */
const LOG_CALLEE_RE =
  /^(?:(?:console|logger|logging|log|klog|slog|glog|Log|LOG|Logger|this\.log(?:ger)?|self\.log(?:ger)?|self\._?logger|this\._?logger)(?:\.|::|->)\w{1,40}|printf|fprintf|puts|print|println|eprintln|eprint|NSLog|(?:LV_)?(?:LOG|TRACE)_\w{1,20}|[A-Z][A-Z0-9]{0,10}_Log[A-Z]?\w{0,20}|D?V?LOG|AL?OG[EWDIV]|log_\w{1,20}|qDebug|qWarning|qCritical)$/;

function isLogCall(key: StmtKey): boolean {
  if (key.kind !== "call") return false;
  const at = key.key.indexOf("(");
  return LOG_CALLEE_RE.test(at >= 0 ? key.key.slice(0, at) : key.key);
}

/** The statements at the function's own level after `e` that the exit
 * skips and the companion table leaves out (their token first appears after
 * the exit): terminal callees first, then the function's last statements
 * (what its normal path ends with) back to front. */
function skippedTail(shape: Shape, cov: Coverage, e: Exit): Stmt[] {
  const fnLevel = (line: number): boolean => (blockOfLine(shape, line) ?? cov.fn).id === cov.fn.id;
  // A statement whose token the function touches before the exit is
  // compared in the companion table; this lists the ones it leaves out.
  const tail = cov.stmts.filter(
    (s) =>
      s.line > e.line &&
      fnLevel(s.line) &&
      !isLogCall(s.key) &&
      firstTokenLine(cov, s.key.token) > e.line,
  );
  return tail.sort(
    (a, b) =>
      Number(isTerminalCallee(b.key.token)) - Number(isTerminalCallee(a.key.token)) ||
      b.line - a.line,
  );
}

function exitGaps(run: AnchorRun, c: Changed, fns: readonly Block[]): void {
  const head = c.head!;
  for (const fn of fns) {
    const cov = coverageOf(head, fn);
    if (typeof cov === "string") {
      addUnknown(run, "exit-gap", `${c.path}: ${cov}`);
      continue;
    }
    const leaving = cov.exits.filter((e) => LEAVING.has(e.kind) && !e.handler);
    // An exit the diff adds after the function has started its work, that
    // jumps over a terminal call the function's later path reaches (an exit
    // with statements after it is a conditional one, braces or not).
    for (const e of leaving) {
      if (e.kind === "end" || !c.added.has(e.line)) continue;
      if (!cov.stmts.some((s) => s.line < e.line && !isLogCall(s.key))) continue;
      const tail = skippedTail(head, cov, e);
      if (!tail.some((s) => isTerminalCallee(s.key.token))) continue;
      anchor(
        run,
        c,
        "exit-gap",
        0,
        e.line,
        `${exitLabel(e)} (added) leaves before ${tail
          .slice(0, 4)
          .map((s) => `${span(s.key.key)} L${s.line}`)
          .join(
            ", ",
          )}${tail.length > 4 ? ` and ${tail.length - 4} more` : ""}, which the function's later path reaches — does this exit leave the state right?`,
      );
    }
    if (leaving.length < 2) continue;
    const seen = new Set<string>();
    for (const s of cov.stmts) {
      if (!c.added.has(s.line) || seen.has(s.key.key) || isLogCall(s.key)) continue;
      seen.add(s.key.key);
      const all = cov.stmts.filter((t) => t.key.key === s.key.key);
      const first = firstTokenLine(cov, s.key.token);
      const relevant = leaving.filter((e) => e.line > first);
      const have = relevant.filter((e) => all.some((t) => cov.covers(t, e)));
      const lack = relevant.filter((e) => !all.some((t) => cov.covers(t, e)));
      if (have.length === 0 || lack.length === 0) continue;
      const added = all.filter((t) => c.added.has(t.line)).length;
      anchor(
        run,
        c,
        "exit-gap",
        isTerminalCallee(s.key.token) ? 0 : 1,
        s.line,
        `${span(s.key.key)} (${added === all.length ? "added" : "added beside an existing copy"}) comes before ${have.map(exitLabel).join(", ")}; not before ${lack.slice(0, 8).map(exitLabel).join(", ")}${lack.length > 8 ? ` and ${lack.length - 8} more` : ""} — do the exits that lack it leave the state right?`,
      );
    }
  }
}

// writes-no-tx -------------------------------------------------------------

/** A method on a record store: group 1 the receiver, group 2 a method
 * whose name starts with a write verb (`save`, `saveAll`, `deleteFolder`,
 * Go's `UpdateStatus`; never `settings`). `set…` is left out: on a client
 * or a store class it configures (`setHeader`, `setLoading`) more often
 * than it stores. */
const STORE_CALL_RE =
  /(?<![\w$])([A-Za-z_$][\w$]{0,60})\s{0,2}(?:\?\.|\.|->|::)\s{0,2}((?:[Ss]ave|[Uu]pdate|[Ii]nsert|[Cc]reate|[Dd]elete|[Rr]emove|[Aa]rchive|[Mm]ove|[Uu]psert|[Pp]ut|[Pp]atch|[Rr]estore|[Tt]ransfer)(?![a-z0-9$])[\w$]{0,60})\s{0,4}\(/;
/** A receiver whose last name says it stores records. */
const STORE_RECEIVER_RE = /(?:repository|repo|service|store|db|dao|manager|client)$/i;
/** A method that builds a query or a statement rather than running it. */
const BUILDER_METHOD_RE = /(?:Builder|Query)$/;
const CLASS_NAME_RE = /\bclass\s{1,8}([A-Za-z_$][\w$]{0,80})/;
/** A write call whose verb an in-memory container shares (a Set's
 * `insert`, a dict's `update`, a Map's `delete`): inside a loop it is a
 * per-item store write only on a receiver named for a store. */
const CONTAINER_VERB_RE =
  /^\.(?:update|insert|delete|put|merge|create|destroy|flush|execute)\s{0,4}\($/;
/** A callback a collection method calls once per item. */
const PER_ITEM_CALLBACK_RE =
  /^<callback of (?:forEach|each|for_each|map|flatMap|forEachAsync|mapSeries|eachSeries)>$/;
/** A statement that leaves the loop. */
const LOOP_EXIT_RE = /^\s{0,200}(?:\}\s{0,4})?(?:break|return)\b/;
const LOOP_WORDS: ReadonlySet<string> = new Set([
  "for",
  "while",
  "do",
  "foreach",
  "loop",
  "repeat",
]);

/** The write a call on a record store makes on this line: a method named
 * for a write on a receiver named for a store (`this.orderRepository.save(`,
 * `db.insert(`), or on `this`/`self` inside a class named for one. */
function storeCall(code: string, className: string | null): string | null {
  let from = 0;
  for (let guard = 0; guard < 8 && from < code.length; guard++) {
    const m = STORE_CALL_RE.exec(code.slice(from));
    if (!m) return null;
    const recv = m[1]!;
    const method = m[2]!;
    const self = recv === "this" || recv === "self";
    if (
      !BUILDER_METHOD_RE.test(method) &&
      (self
        ? className !== null && STORE_RECEIVER_RE.test(className)
        : STORE_RECEIVER_RE.test(recv))
    )
      return `${recv}.${method}(`;
    from += m.index + Math.max(1, m[0].length);
  }
  return null;
}

/** The receiver chain that ends a text (`prisma.order` in `prisma.order`). */
const RECEIVER_CHAIN_END_RE =
  /([A-Za-z_$][\w$]{0,60}(?:\s{0,2}(?:\?\.|\.|->)\s{0,2}[A-Za-z_$][\w$]{0,60}){0,4})\s{0,2}$/;
/** A receiver segment named for a database handle or a model's manager. */
const DB_SEGMENT_RE = /^(?:prisma|knex|db|database|session|em|entityManager|orm|objects|tx|trx)$/;
/** A receiver segment with a word naming stored data in it (`table_instance`,
 * `usersCollection`, `cursor`, `redisConn`). */
const STORE_WORD_RE =
  /(?:^|_)(?:table|collection|cursor|conn|connection|bucket|redis|mongo|dynamo|firestore)(?:_|[A-Z0-9]|s?$)|[a-z0-9](?:Table|Collection|Cursor|Conn|Connection|Bucket|Redis|Mongo|Dynamo|Firestore)(?:_|[A-Z0-9]|s?$)/;

/** Whether the receiver chain before a container verb names a store: a
 * segment named for one (`orderRepository`, `prisma`, `objects`,
 * `table_instance`), or a
 * model class (`Order.create(`); a lower-case local (`seen`, `out`) is a
 * container in memory. */
function storeReceiver(before: string): boolean {
  const chain = RECEIVER_CHAIN_END_RE.exec(before)?.[1];
  if (chain === undefined) return false;
  const segs = chain.split(/\s{0,2}(?:\?\.|\.|->)\s{0,2}/);
  return segs.some(
    (g) =>
      STORE_RECEIVER_RE.test(g) ||
      DB_SEGMENT_RE.test(g) ||
      STORE_WORD_RE.test(g) ||
      (/^[A-Z][a-z]\w{0,60}$/.test(g) && !BUILTIN_CLASSES.has(g)),
  );
}
const BUILTIN_CLASSES: ReadonlySet<string> = new Set([
  "Object",
  "Array",
  "Promise",
  "Reflect",
  "Symbol",
  "Date",
  "Math",
  "String",
  "Number",
  "Buffer",
  "Map",
  "Set",
]);

/** The last line of each block in a function that leaves a loop (a `break`
 * or `return`), by block id (-1 at file level). One walk per function: a
 * write is left right after when its own block's last exit lies below it,
 * and the own block of a write in a loop sits inside that loop, so the
 * lookup is the same as a rescan of the loop after each write. */
function lastExits(shape: Shape, fn: Block): Map<number, number> {
  const out = new Map<number, number>();
  for (let k = fn.body; k <= fn.end; k++) {
    const sl = shape.lines[k - 1];
    if (!sl || sl.kind !== "code" || !LOOP_EXIT_RE.test(sl.code)) continue;
    out.set(blockOfLine(shape, k)?.id ?? -1, k);
  }
  return out;
}

/** The class a function sits in, by its head's name, or null. */
function classOf(shape: Shape, fn: Block): string | null {
  const st = shape.structure;
  for (let b = fn.parent >= 0 ? st?.blocks[fn.parent] : undefined; b;) {
    if (b.keyword === "class") return CLASS_NAME_RE.exec(b.head)?.[1] ?? null;
    b = b.parent >= 0 ? st?.blocks[b.parent] : undefined;
  }
  return null;
}

/** The writes of one function with no transaction marker in it or above its
 * head: two or more write statements (a chained statement over several
 * lines, a query builder's `.update().set().execute()`, is one), or a write
 * inside a loop, one per item. */
function writesNoTx(run: AnchorRun, c: Changed, fns: readonly Block[]): void {
  const head = c.head!;
  for (const fn of fns) {
    const writes: { line: number; what: string; loop: Block | null; stored: boolean }[] = [];
    const className = classOf(head, fn);
    let tx = false;
    let stmt = 0;
    let lastStmt = -1;
    let exits: Map<number, number> | undefined;
    for (let L = Math.max(1, fn.open - 3); L <= fn.end; L++) {
      const sl = head.lines[L - 1]!;
      if (sl.kind === "comment" || sl.kind === "blank") continue;
      if (TX_RE.test(sl.raw)) {
        tx = true;
        break;
      }
      if (!sl.cont) stmt = L;
      if (L < fn.body || functionOfLine(head, L)?.id !== fn.id) continue;
      const sql = SQL_WRITE_RE.exec(sl.raw);
      const call = WRITE_CALL_RE.exec(sl.code);
      const store = storeCall(sl.code, className);
      const w = call ?? sql;
      const what = w ? w[0].replace(/\s+/g, " ").slice(0, 40) : store;
      if (what === null) continue;
      // One statement continued over lines is one write.
      if (stmt === lastStmt) continue;
      lastStmt = stmt;
      // A per-item write: inside a loop, or inside a callback a collection
      // method calls per item; a loop the write's own block leaves right
      // after it (a retry until one write succeeds) is no per-item write.
      let loop: Block | null =
        chainOf(head, L, fn).find((b) => LOOP_WORDS.has(b.keyword)) ??
        (PER_ITEM_CALLBACK_RE.test(fn.name ?? "") ? fn : null);
      if (loop !== null) {
        exits ??= lastExits(head, fn);
        if ((exits.get(blockOfLine(head, L)?.id ?? -1) ?? 0) > L) loop = null;
      }
      // A container's verb in a loop is an in-memory write unless the
      // receiver is named for a store.
      const stored =
        store !== null ||
        sql !== null ||
        (call !== null &&
          (!CONTAINER_VERB_RE.test(call[0].replace(/\s+/g, "")) ||
            storeReceiver(sl.code.slice(0, call.index))));
      writes.push({ line: L, what, loop, stored });
    }
    // A container's verb on a receiver not named for a store is an
    // in-memory write: it is neither a per-item store write nor one of a
    // sequence of stored writes.
    const stored = writes.filter((w) => w.stored);
    if (tx || stored.length === 0) continue;
    const looped = stored.find((w) => w.loop !== null);
    if (looped) {
      const loop = looped.loop!;
      const where =
        loop.id === fn.id
          ? `the per-item callback ${span(shownHead(head, loop).slice(0, 80))} @L${loop.open}`
          : `${span(shownHead(head, loop).slice(0, 80))} @L${loop.open} in ${span(fn.name ?? "<anonymous>")}`;
      anchor(
        run,
        c,
        "writes-no-tx",
        2,
        looped.line,
        `L${looped.line} ${span(looped.what)} writes once per item inside ${where}, and no transaction marker in it or above its head — what is stored if the process stops partway through the items?`,
      );
    }
    // A single loop body's writes are the loop anchor's; more is a sequence.
    if (stored.length < 2 || (looped && stored.every((w) => w.loop?.id === looped.loop!.id)))
      continue;
    const a = stored[0]!;
    const b = stored[stored.length - 1]!;
    anchor(
      run,
      c,
      "writes-no-tx",
      2,
      a.line,
      `${stored.length} writes in ${span(fn.name ?? "<anonymous>")} (${stored
        .slice(0, 6)
        .map((w) => `L${w.line} ${span(w.what)}`)
        .join(
          ", ",
        )}) and no transaction marker in it or above its head — what is stored if the process stops between line ${a.line} and line ${b.line}?`,
    );
  }
}

// persisted-shape ----------------------------------------------------------

interface PersistCtx {
  migration: boolean;
  versionTouched: boolean;
  persistSites: { path: string; line: number }[];
}

function blockHeadsAt(shape: Shape | null, line: number): string[] {
  if (!shape?.structure) return [];
  const heads: string[] = [];
  for (
    let b = blockOfLine(shape, line);
    b;
    b = b.parent >= 0 ? shape.structure.blocks[b.parent]! : null
  )
    heads.push(b.head);
  return heads;
}

function changedLines(c: Changed): { side: "+" | "-"; line: number; text: string }[] {
  return [
    ...[...c.added].map(([line, text]) => ({ side: "+" as const, line, text })),
    ...[...c.removed].map(([line, text]) => ({ side: "-" as const, line, text })),
  ];
}

function persistedShapes(run: AnchorRun, c: Changed, p: PersistCtx, headText: string | null): void {
  if (isMigrationFile(c.path)) return;
  const at = (side: "+" | "-", line: number): number =>
    side === "+" ? line : ([...c.touched][0] ?? 1);
  const cut = (t: string): string => (t.length > LINE_MAX ? t.slice(0, LINE_MAX) : t);
  const lines = changedLines(c);
  const ext = c.path.slice(c.path.lastIndexOf("."));
  const question = "what does the new reader do with data the old code stored?";
  // a) ORM model / schema / SQL columns
  if (SCHEMA_PATH_RE.test(c.path) && !p.migration) {
    for (const l of lines) {
      const t = cut(l.text);
      // An import names a type; it declares no column.
      if (/^\s{0,40}(?:import|from|#\s{0,4}include|using|require)\b/.test(t)) continue;
      const shape = COLUMN_SHAPES.find(
        (s) => (s.ext === undefined || s.ext === ext) && s.re.test(t),
      );
      if (!shape) continue;
      const col = shape.re.exec(t)?.[1] ?? "?";
      anchor(
        run,
        c,
        "persisted-shape",
        1,
        at(l.side, l.line),
        `column ${span(col)} ${l.side === "+" ? "added or changed" : "removed or changed"} in a model or schema file and no migration in the diff — ${question}`,
      );
      return;
    }
  }
  if (headText === null) return;
  const js = dialectOf(c.path) === "js";
  // b) redux-persist slice state
  if (
    js &&
    /createSlice\s{0,4}\(|\binitialState\b|Reducer\b/.test(headText.slice(0, 200_000)) &&
    !p.versionTouched
  ) {
    for (const l of lines) {
      const heads = blockHeadsAt(l.side === "+" ? c.head : c.base, l.line);
      if (!heads.some((h) => SLICE_HEAD_RE.test(h))) continue;
      if (p.persistSites.length === 0) break;
      anchor(
        run,
        c,
        "persisted-shape",
        1,
        at(l.side, l.line),
        `slice state ${l.side === "+" ? "gains or changes" : "loses or changes"} ${span(l.text)} in a store persisted by redux-persist (${p.persistSites
          .slice(0, 3)
          .map((s) => `${s.path}:${s.line}`)
          .join(", ")}) and the diff changes no \`version\` or \`createMigrate\` — ${question}`,
      );
      return;
    }
  }
  // c) electron-store schema / defaults
  if (js && /electron-store|new\s{1,4}Store\s{0,4}\(/.test(headText) && !p.versionTouched) {
    for (const l of lines) {
      const heads = blockHeadsAt(l.side === "+" ? c.head : c.base, l.line);
      if (!heads.some((h) => STORE_HEAD_RE.test(h))) continue;
      anchor(
        run,
        c,
        "persisted-shape",
        1,
        at(l.side, l.line),
        `electron-store \`schema\`/\`defaults\` change ${span(l.text)} with no \`migrations\` change — ${question}`,
      );
      return;
    }
  }
  // d) Dexie stores without a new version
  for (const l of lines) {
    if (!DEXIE_RE.test(cut(l.text)) || p.versionTouched) continue;
    if (/\.version\s{0,4}\(/.test(l.text)) continue;
    anchor(
      run,
      c,
      "persisted-shape",
      1,
      at(l.side, l.line),
      `Dexie \`.stores(…)\` changed and no \`.version(n)\` added — ${question}`,
    );
    return;
  }
  // e) IndexedDB object stores without a version change
  if (
    lines.some((l) => IDB_STORE_RE.test(cut(l.text))) &&
    !lines.some((l) => IDB_OPEN_RE.test(cut(l.text)))
  ) {
    const l = lines.find((x) => IDB_STORE_RE.test(cut(x.text)))!;
    anchor(
      run,
      c,
      "persisted-shape",
      1,
      at(l.side, l.line),
      `IndexedDB object stores or indexes changed and \`indexedDB.open(name, version)\` did not — ${question}`,
    );
    return;
  }
  // f) SQLite DDL in code with no user_version or migration
  if (!p.migration && !p.versionTouched && dialectOf(c.path) !== null) {
    const l = lines.find((x) => DDL_RE.test(cut(x.text)));
    if (l) {
      anchor(
        run,
        c,
        "persisted-shape",
        1,
        at(l.side, l.line),
        `table DDL changed in code (${span(l.text)}) with no migration and no \`user_version\` change — ${question}`,
      );
      return;
    }
  }
  // h) keyed JSON in local storage
  if (js && LOCAL_STORE_RE.test(headText) && !p.versionTouched) {
    const l = lines.find((x) => FIELD_DECL_RE.test(cut(x.text)));
    if (l) {
      anchor(
        run,
        c,
        "persisted-shape",
        3,
        at(l.side, l.line),
        `a field ${l.side === "+" ? "added or changed" : "removed"} in a file that stores JSON in local storage (weak: the stored object is not traced) — ${question}`,
      );
      return;
    }
  }
  // i) a serialized struct with a version field: a struct's own body, never
  // a function whose head names a struct type; each body read once.
  const d = dialectOf(c.path);
  if ((d === "c" || d === "go" || d === "rust") && c.head?.structure) {
    const versioned = new Map<number, boolean>();
    for (const l of lines) {
      if (l.side !== "+") continue;
      const b = blockOfLine(c.head, l.line);
      if (!b || b.kind !== "other" || !STRUCT_KEYWORDS.has(b.keyword)) continue;
      let flagged = versioned.get(b.id);
      if (flagged === undefined) {
        let hasVersion = false;
        let versionChanged = false;
        for (let L = b.body; L <= b.end; L++) {
          if (VERSION_WORD_RE.test(c.head.lines[L - 1]?.code ?? "")) {
            hasVersion = true;
            if (c.added.has(L)) versionChanged = true;
          }
        }
        flagged = hasVersion && !versionChanged;
        versioned.set(b.id, flagged);
      }
      if (!flagged) continue;
      anchor(
        run,
        c,
        "persisted-shape",
        3,
        l.line,
        `a field added to a struct that carries a version field, and the version line is unchanged (weak: whether it is serialized is not traced) — ${question}`,
      );
      return;
    }
  }
}

/** The highest protobuf field number, what `max` means in a reservation. */
const PROTO_MAX_FIELD = 536_870_911;
const PROTO_SCOPE_RE = /\b(message|enum|service|extend)\s{1,8}([\w.]{1,120})\s{0,8}$/;

/** Each line's protobuf scope, 1-based: the enclosing `message`/`enum`
 * names dot-joined (`Outer.Inner`), taken where the line's first statement
 * ends. A `oneof` or option block adds no name: its fields are the message's. */
function protoScopes(text: string): string[] {
  const out: string[] = [""];
  const stack: (string | null)[] = [];
  const now = (): string => stack.filter((n) => n !== null).join(".");
  for (const raw of text.split("\n")) {
    const code = raw.slice(0, LINE_MAX);
    let at: string | null = null;
    let quote = "";
    for (let i = 0; i < code.length; i++) {
      const ch = code[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "/" && code[i + 1] === "/") break;
      else if (ch === "{") {
        const m = PROTO_SCOPE_RE.exec(code.slice(0, i));
        stack.push(m ? (m[1] === "extend" ? `(extend ${m[2]!})` : m[2]!) : null);
      } else if (ch === "}") stack.pop();
      else if (ch === ";" && at === null) at = now();
    }
    out.push(at ?? now());
  }
  return out;
}

/** The field numbers a `reserved` statement covers, as closed ranges; quoted
 * names cover none. Null when the line reserves nothing. */
function protoReserved(text: string): [number, number][] | null {
  const m = /^\s{0,40}reserved\b([^;]{0,400})/.exec(text.slice(0, LINE_MAX));
  if (!m) return null;
  const out: [number, number][] = [];
  for (const part of m[1]!.split(",")) {
    const r = /^\s{0,8}(\d{1,10})(?:\s{1,8}to\s{1,8}(\d{1,10}|max))?\s{0,8}$/.exec(part);
    if (!r) continue;
    const lo = Number(r[1]);
    out.push([lo, r[2] === undefined ? lo : r[2] === "max" ? PROTO_MAX_FIELD : Number(r[2])]);
  }
  return out;
}

/** A removed or renumbered protobuf field. Field numbers are unique within
 * one message, so a removal pairs with an addition, and a reservation covers
 * it, only within the same message: `baseText`/`headText` give the scopes. */
function protoShapes(run: AnchorRun, c: Changed, baseText: string, headText: string): void {
  const baseScope = protoScopes(baseText);
  const headScope = protoScopes(headText);
  const removed = new Map<string, { num: string; was: string }>();
  const addedNums = new Map<string, { name: string; line: number }>();
  const reserved = new Map<string, [number, number][]>();
  for (const [L, t] of c.removed) {
    const m = PROTO_FIELD_RE.exec(t.slice(0, LINE_MAX));
    if (m)
      removed.set(`${baseScope[L] ?? ""}\0${m[3]!}`, {
        num: m[3]!,
        was: `${m[1]!.trim()} ${m[2]!}`,
      });
  }
  for (const [L, t] of c.added) {
    const scope = headScope[L] ?? "";
    const r = protoReserved(t);
    if (r) {
      reserved.set(scope, [...(reserved.get(scope) ?? []), ...r]);
      continue;
    }
    const m = PROTO_FIELD_RE.exec(t.slice(0, LINE_MAX));
    if (m) addedNums.set(`${scope}\0${m[3]!}`, { name: `${m[1]!.trim()} ${m[2]!}`, line: L });
  }
  for (const [key, { num, was }] of removed) {
    const now = addedNums.get(key);
    if (now && now.name !== was) {
      anchor(
        run,
        c,
        "persisted-shape",
        1,
        now.line,
        `protobuf field number ${num} changes from ${span(was)} to ${span(now.name)} — what does the new reader do with data the old code stored?`,
      );
      return;
    }
    const n = Number(num);
    const scope = key.slice(0, key.indexOf("\0"));
    if (!now && !(reserved.get(scope) ?? []).some(([lo, hi]) => n >= lo && n <= hi)) {
      anchor(
        run,
        c,
        "persisted-shape",
        1,
        [...c.touched][0] ?? 1,
        `protobuf field ${span(was)} = ${num} removed and its number not reserved — what does the new reader do with data the old code stored?`,
      );
      return;
    }
  }
}

/** Reads the sides a `.proto` change needs (its removed fields the base,
 * its added lines the head) and checks its field numbers; a side that cannot
 * be read leaves the file unknown. */
async function protoFile(ctx: Ctx, run: AnchorRun, c: Changed): Promise<void> {
  if (!c.path.endsWith(".proto")) return;
  if (![...c.removed.values()].some((t) => PROTO_FIELD_RE.test(t.slice(0, LINE_MAX)))) return;
  const b = await ctx.base(c.basePath);
  if (!b.ok) {
    addUnknown(run, "persisted-shape", `${c.path}: not read (${whyText(b.why, b.cap)})`);
    return;
  }
  let headText = "";
  if (c.added.size > 0) {
    const h = await ctx.head(c.path, true);
    if (!h.ok) {
      addUnknown(run, "persisted-shape", `${c.path}: not read (${whyText(h.why, h.cap)})`);
      return;
    }
    headText = h.text;
  }
  protoShapes(run, c, b.text, headText);
}

// call-to-cache ------------------------------------------------------------

interface CachePair {
  c: Changed;
  line: number;
  callee: string;
  field: string;
}

/** The stem a getter's name shares with the field it reads: a leading
 * verb stripped (`getSize`), or a getter word inside the name
 * (`lv_text_get_size`, `GetTextSize` after a prefix). */
function cacheStem(token: string): string {
  const lead = token.replace(CACHE_PREFIX_RE, "");
  const mid = /(?:_get_|[a-z0-9]Get)(?=[A-Za-z_])/.exec(lead);
  return lowerFirst(mid ? lead.slice(mid.index + mid[0].length) : lead);
}

/** Type and keyword names a getter's stem can equal (`GetString` →
 * `string`): never a cached field. */
const TYPE_WORDS: ReadonlySet<string> = new Set([
  "string",
  "str",
  "int",
  "bool",
  "boolean",
  "byte",
  "bytes",
  "float",
  "double",
  "char",
  "number",
  "object",
  "any",
  "void",
  "err",
  "error",
  "list",
  "dict",
]);

/** A local that reads as a cache of the stem: a variable name (lowercase
 * first) that starts or ends with it once a cache affix is stripped
 * (`size`, `sizeCache`, `cachedSize`, `textSize`), never a type
 * (`ModelLibraryLocal`, `JobName`). */
function cacheNamed(name: string, stemLow: string): boolean {
  if (!/^[a-z_$]/.test(name) || TYPE_WORDS.has(name.toLowerCase())) return false;
  const bare = name
    .replace(/^(?:_{1,2}|cached?_?)/i, "")
    .replace(/_?cached?$/i, "")
    .toLowerCase();
  return bare.startsWith(stemLow) || bare.endsWith(stemLow);
}

function cachePairs(c: Changed): CachePair[] {
  const out: CachePair[] = [];
  for (const r of c.runs) {
    // A replacement may change the line count (a three-line call read back
    // in one line): every removed line meets every added line of a short run.
    const removed = r.removed.slice(0, MAX_CACHE_RUN);
    const added = r.added.slice(0, MAX_CACHE_RUN);
    const seen = new Set<number>();
    // One pair per removed line and per added line, the first that holds.
    for (const rl of removed)
      pairing: for (const al of added) {
        if (seen.has(al.line)) continue;
        const was = rl.text.slice(0, LINE_MAX);
        const now = al.text.slice(0, LINE_MAX);
        for (const { token, at } of tokensOf(was)) {
          if (
            was.charCodeAt(at + token.length) !== 40 &&
            !/^\s{0,4}\(/.test(was.slice(at + token.length))
          )
            continue;
          const stem = cacheStem(token);
          // Nothing stripped (`Connect` → `connect`): not a getter.
          if (stem.length < 3 || stem.toLowerCase() === token.toLowerCase()) continue;
          if (holdsWord(now, token)) continue;
          const want = stem.toLowerCase();
          // A token the old line did not hold, not itself called; a member first.
          const fresh = [...tokensOf(now)].filter(
            (t) =>
              t.token !== token &&
              !holdsWord(was, t.token) &&
              t.token.toLowerCase().includes(want) &&
              !/^\s{0,4}\(/.test(now.slice(t.at + t.token.length)),
          );
          // The read is a member (`label->text_size`, `this.size`), or it
          // shares an argument or receiver with the call it replaced: a fresh
          // local that only happens to share the stem is not a cache.
          const callArgs = new Set(
            [...tokensOf(was.slice(0, at)), ...tokensOf(was.slice(at + token.length))].map(
              (t) => t.token,
            ),
          );
          const overlap = [...tokensOf(now)].some(
            (t) => t.token.length > 2 && callArgs.has(t.token),
          );
          const field =
            fresh.find(
              (t) =>
                /(?:\.|->)\s{0,2}$/.test(now.slice(0, t.at)) &&
                !TYPE_WORDS.has(t.token.toLowerCase()),
            ) ?? (overlap ? fresh.find((t) => cacheNamed(t.token, want)) : undefined);
          if (!field) continue;
          out.push({ c, line: al.line, callee: token, field: field.token });
          seen.add(al.line);
          break pairing;
        }
      }
  }
  return out;
}

// cowrite / new-writer -----------------------------------------------------

interface CowritePair {
  c: Changed;
  s: { line: number; key: StmtKey };
  w: { line: number; key: StmtKey; norm: string; token: string };
  occs: Occ[];
}

/** Added lines the per-call budget still allows; `cut` once it ran out. */
interface LineBudget {
  left: number;
  cut: boolean;
  /** Alias look-backs still allowed (`ALIAS_MAX_SCANS` per call). */
  aliases?: number;
  /** A look-back was wanted after they ran out. */
  aliasCut?: boolean;
}

/** Statements that sit beside everything, so their sites say nothing: an
 * unused-parameter mark, an assertion, a deferred cancel. */
const IDIOM_RE =
  /^(?:(?:LV_|Q_|Py_)?UNUSED(?:_PARAM(?:ETER)?)?|(?:[A-Z][A-Z0-9]{0,10}_)?(?:ASSERT\w{0,20}|[DVP]?CHECK(?:_\w{1,20})?)|(?:static_)?assert\w{0,20}|cancel\w{0,20}|t\.Helper|wg\.Wait)$/;

function isIdiom(key: StmtKey): boolean {
  if (key.kind !== "call") return false;
  const callee = key.key.slice(0, key.key.indexOf("(") >>> 0);
  return IDIOM_RE.test(callee) || IDIOM_RE.test(key.token);
}

/** The co-write pairs of a changed file, lazily: the caller stops at its cap. */
function* cowritePairs(c: Changed, budget: LineBudget): Generator<Omit<CowritePair, "occs">> {
  const head = c.head;
  if (!head) return;
  const heads = headLines(head);
  for (const [L] of c.added) {
    if (budget.left <= 0) {
      budget.cut = true;
      return;
    }
    budget.left--;
    const sl = head.lines[L - 1];
    if (!sl || sl.kind !== "code" || sl.cont) continue;
    const s = stmtKey(sl.code);
    // A log line leaves no state: neither side of a co-write.
    if (!s || heads.has(L) || isLogCall(s)) continue;
    for (const n of neighboursOf(head, L)) {
      if (c.added.has(n.line) || n.key.token === s.token || isIdiom(n.key) || isLogCall(n.key))
        continue;
      const wl = head.lines[n.line - 1]!;
      const token = searchToken(wl.code);
      if (!token) continue;
      yield {
        c,
        s: { line: L, key: s },
        w: { line: n.line, key: n.key, norm: normalise(wl.code), token },
      };
      break;
    }
  }
}

interface WriterField {
  c: Changed;
  line: number;
  field: string;
  forms: NameForms;
  hits: NameHit[];
  book: CompanionBook;
}

/** Names too short or too generic to sweep for: they collide across files. */
function genericField(name: string): boolean {
  return name.length <= 3 || /^__\w{1,40}__$/.test(name);
}

/** The local `root` bound to the address of a member (`T *root = &a->f`)
 * earlier in the same function, within `ALIAS_SCAN_LINES`: the member `f`,
 * or null. Lexical, like the forward search. */
function aliasTargetBack(shape: Shape, line: number, root: string): string | null {
  if (!shape.structure) return null;
  const fn = functionOfLine(shape, line);
  if (!fn) return null;
  for (let L = line - 1; L >= Math.max(fn.body, line - ALIAS_SCAN_LINES); L--) {
    const code = shape.lines[L - 1]!.code;
    if (shape.lines[L - 1]!.kind !== "code" || !holdsWord(code, root)) continue;
    for (let p = code.indexOf(root); p >= 0; p = code.indexOf(root, p + 1)) {
      const e = p + root.length;
      if ((p > 0 && isWordCode(code.charCodeAt(p - 1))) || isWordCode(code.charCodeAt(e))) continue;
      if (MEMBER_BEFORE_RE.test(code.slice(0, p))) continue;
      const after = code.slice(e);
      const bind = ALIAS_BIND_AFTER_RE.exec(after);
      if (bind) return bind[1]!;
      // bound to something else: no alias of a member
      if (ASSIGN_AFTER_RE.test(after)) return null;
    }
  }
  return null;
}

/** The fields the diff's added lines write, in two rounds: first the field
 * each write names last (`g` in `a->f.g = x`), a setter's field, the
 * receiver of a collection or atomic write; then the rest of each chain
 * (`f`) and the member a local alias points at (`f` for `p->g = x` after
 * `T *p = &a->f`). The caller keeps the first fields its caps allow. */
const POINTER_DIALECTS: ReadonlySet<string> = new Set(["c", "go", "rust"]);

function newWriterFields(c: Changed, budget: LineBudget): { line: number; field: string }[] {
  const head = c.head;
  if (!head) return [];
  const out: { line: number; field: string }[] = [];
  const later: { line: number; field: string }[] = [];
  // Only a language with pointers binds a local to a member's address.
  const pointers = POINTER_DIALECTS.has(dialectOf(c.path) ?? "py");
  for (const [L] of c.added) {
    if (budget.left <= 0) {
      budget.cut = true;
      break;
    }
    budget.left--;
    const sl = head.lines[L - 1];
    if (!sl || sl.kind !== "code") continue;
    const k = stmtKey(sl.code);
    if (!k) continue;
    if (k.kind === "write") {
      out.push({ line: L, field: k.token });
      for (const m of (k.members ?? []).slice(1)) later.push({ line: L, field: m });
      const root = pointers ? /^[A-Za-z_$][\w$]{0,80}(?=->|\.)/.exec(k.key)?.[0] : undefined;
      if (root !== undefined && (budget.aliases ?? 0) <= 0) budget.aliasCut = true;
      else if (root !== undefined) {
        budget.aliases = (budget.aliases ?? 0) - 1;
        const target = aliasTargetBack(head, L, root);
        if (target !== null) later.push({ line: L, field: target });
      }
      continue;
    }
    if (/^set[A-Z]\w{0,60}$/.test(k.token)) {
      out.push({ line: L, field: lowerFirst(k.token.slice(3)) });
      continue;
    }
    const r = receiverWrite(sl.code);
    if (r) out.push({ line: L, field: r.field });
  }
  return out.concat(later);
}

// writer-companion ---------------------------------------------------------

/** New writes of a field per field anchored, and partners per write. */
const MAX_COMPANION_WRITES = 3;
/** Writing functions a partner must sit beside before its absence is a
 * lead: two of three is a coincidence as often as a convention. */
const MIN_COMPANION_UNITS = 3;
/** What may stand before a name a line declares: a declaring keyword, or a
 * type (with qualifiers, a namespace, template arguments, `*` or `&`). */
const DECL_LEAD_RE =
  /^\s{0,200}(?:(?:static|final|const|register|volatile|unsigned|signed|mut|pub|private|public|protected|readonly|struct|enum|union)\s{1,8}){0,6}(?:(?:let|const|var|val|auto)\s{1,8}(?:mut\s{1,4})?|[A-Za-z_$][\w$]{0,80}(?:::[A-Za-z_$][\w$]{0,80}){0,4}(?:<[^<>;=\n]{0,80}>)?(?:\s{1,8}|\s{0,4}[*&]{1,4}\s{0,4}))$/;
/** Words that lead a statement without declaring anything. */
const NOT_DECL_WORDS: ReadonlySet<string> = new Set([
  "return",
  "else",
  "case",
  "do",
  "throw",
  "yield",
  "await",
  "delete",
  "new",
  "typeof",
  "goto",
  "in",
]);

/** The member a write stores into below the field (`Logger` for a write
 * of `container` through `h.container.Logger = x`), `""` for a store into
 * the field itself, null when the line is no plain store of it (a setter, a
 * collection call, a store through an alias). */
function subOf(h: NameHit, forms: NameForms): string | null {
  return subOfCode(h.raw, forms);
}

function subOfCode(code: string, forms: NameForms): string | null {
  const k = stmtKey(code);
  if (!k || k.kind !== "write") return null;
  const members = k.members ?? [];
  const at = members.findIndex((m) => forms.forms.has(m));
  return at < 0 ? null : members.slice(0, at).reverse().join(".");
}

/** A line that runs its write later, in a closure or a cleanup block: Go's
 * `defer func() { … }()`, a test's `t.Cleanup(func() { … })`, a one-line
 * `finally { … }`. Bounded quantifiers only: the line is author text. */
const DEFERRED_BLOCK_RE =
  /^\s{0,200}(?:defer\b|[\w$.]{0,80}\bCleanup\s{0,8}\(|\}?\s{0,8}finally\b)/;

/** Whether a write of the field sits in a deferred closure or block. */
function deferredWrite(raw: string): boolean {
  return stmtKey(raw)?.deferred === true || DEFERRED_BLOCK_RE.test(raw);
}

/** The member a deferred closure's own statement stores into below the
 * field: the text after the closure's last `{` or `=>`, with the closer
 * (`}()`, `})`, `}`, `;`) taken off, read as a statement. Null when that
 * statement is no plain store of the field. */
function deferredSubOf(raw: string, forms: NameForms): string | null {
  const brace = raw.lastIndexOf("{");
  const arrow = raw.lastIndexOf("=>");
  const from = Math.max(brace < 0 ? -1 : brace + 1, arrow < 0 ? -1 : arrow + 2);
  if (from < 0) return null;
  let inner = raw.slice(from);
  for (let i = 0; i < 4; i++) {
    const next = inner.replace(/(?:\}\s{0,8}\(\s{0,8}\)|\}\s{0,8}\)|\}|;)\s{0,200}$/, "");
    if (next === inner) break;
    inner = next;
  }
  return inner.trim() === "" ? null : subOfCode(inner, forms);
}

/** Whether the line declares a local of that name (`int n = 0`, `let n =`,
 * `n := 0`): a new local is no new write of a field. */
export function declaresLocal(raw: string, name: string): boolean {
  for (let at = raw.indexOf(name); at >= 0; at = raw.indexOf(name, at + 1)) {
    const end = at + name.length;
    if ((at > 0 && isWordCode(raw.charCodeAt(at - 1))) || isWordCode(raw.charCodeAt(end))) continue;
    const after = raw.slice(end, end + 8);
    const before = raw.slice(0, at);
    if (/^\s{0,4}:=/.test(after) && /^\s{0,200}(?:[\w$]{1,80}\s{0,4},\s{0,4}){0,6}$/.test(before))
      return true;
    if (!/^\s{0,4}=(?![=>])/.test(after)) return false;
    if (!DECL_LEAD_RE.test(before)) return false;
    const lead = /^\s{0,200}([A-Za-z_$][\w$]{0,80})/.exec(before)?.[1] ?? "";
    return !NOT_DECL_WORDS.has(lead);
  }
  return false;
}
const MAX_PARTNERS_PER_WRITE = 2;
/** Other writers a new write's own file must hold to be its peers alone. */
const FILE_PEERS = 3;

/** A field the diff writes, whose other writers (two at least, in the
 * changed file's language; those of the new write's own file when it holds
 * three or more, else the head tree's) mostly sit beside a statement the new
 * write does not: the dirty mark, the notify, the persist call that the
 * other writes of the field make and this one leaves out. */
function writerCompanions(
  run: AnchorRun,
  writers: readonly WriterField[],
  read: readonly Changed[],
  cutNote: string,
  busy: string[],
  idioms: string[],
): void {
  const byPath = new Map(read.map((c) => [c.path, c]));
  const isNew = (h: NameHit): boolean => byPath.get(h.path)?.added.has(h.line) === true;
  const seen = new Set<string>();
  for (const w of writers) {
    const family = familyKey(w.c.path);
    // A key in a literal is part of the literal's statement, and a line that
    // declares a local of the name writes no field.
    const ws = w.hits.filter(
      (h) => h.occ.kind === "write" && h.occ.how !== "key" && familyKey(h.path) === family,
    );
    const fresh = ws.filter((h) => isNew(h) && !declaresLocal(h.raw, w.field));
    const allOthers = ws.filter((h) => !isNew(h));
    if (fresh.length === 0 || unitCount(allOthers) < MIN_COMPANION_UNITS) continue;
    if (ws.length >= BUSY_FIELD_WRITERS) {
      busy.push(`${w.field} (${ws.length})`);
      continue;
    }
    if (w.book.cut || ws.some((h) => h.near === undefined)) {
      addUnknown(
        run,
        "writer-companion",
        `\`${w.field}\`: writes past the first ${COMPANION_MAX_SITES} were not looked around`,
      );
      continue;
    }
    // The peers a new write is held to: the other writes into the same
    // member of the field (`f.a = x` is no peer of `f.b = y`), those of its
    // own file when it holds `FILE_PEERS` of them (a file keeps its own
    // convention), else every such writer in the head tree.
    const rowsBy = new Map<string, { scope: string; peers: NameHit[]; rows: PartnerRow[] }>();
    // A write in a deferred closure is held strictly: its peers store into
    // the same member, with no unread member on either side standing in for
    // one, since the closure's own member is the only one it touches.
    const peersOf = (
      path: string,
      sub: string | null,
      strict: boolean,
    ): { scope: string; peers: NameHit[]; rows: PartnerRow[] } => {
      const others = allOthers.filter((o) => {
        const s = subOf(o, w.forms);
        if (strict) return s !== null && s === sub;
        return sub === null || s === null || s === sub;
      });
      const local = others.filter((o) => o.path === path);
      const key = `${unitCount(local) >= FILE_PEERS ? path : ""}\0${sub ?? ""}\0${strict ? "strict" : ""}`;
      let known = rowsBy.get(key);
      if (!known) {
        const tree = key.startsWith("\0");
        const peers = tree ? others : local;
        known = {
          scope: tree ? "in the head tree" : "in this file",
          peers,
          rows: usualPartners(w.forms, peers, w.book, idioms),
        };
        rowsBy.set(key, known);
      }
      return known;
    };
    for (const h of fresh.slice(0, MAX_COMPANION_WRITES)) {
      const c = byPath.get(h.path)!;
      const deferred = deferredWrite(h.raw);
      const sub = deferred ? deferredSubOf(h.raw, w.forms) : subOf(h, w.forms);
      if (deferred && sub === null) {
        addUnknown(
          run,
          "writer-companion",
          `\`${w.field}\` at ${h.path}:${h.line}: a write in a deferred closure whose member could not be read`,
        );
        continue;
      }
      const { scope, peers, rows } = peersOf(h.path, sub, deferred);
      if (unitCount(peers) < MIN_COMPANION_UNITS) continue;
      const missing = rows.filter(
        (r) => r.units >= MIN_COMPANION_UNITS && !(h.near ?? []).includes(r.id),
      );
      for (const r of missing.slice(0, MAX_PARTNERS_PER_WRITE)) {
        const once = `${h.path}:${h.line}:${r.id}`;
        if (seen.has(once)) continue;
        seen.add(once);
        const sites = r.have
          .slice(0, 4)
          .map((o) => `${o.path}:${o.line}`)
          .join(", ");
        anchor(
          run,
          c,
          "writer-companion",
          1,
          h.line,
          `${span(w.field)} written here without ${span(r.partner.shown)}, which sits beside the writes of ${span(w.field)} in ${r.units} of ${unitCount(peers)} other functions that write it ${scope}${scope === "in the head tree" ? cutNote : ""} (${sites}${r.have.length > 4 ? ` and ${r.have.length - 4} more` : ""}) — does this write need it?`,
        );
      }
    }
  }
}

// the anchors action -------------------------------------------------------

/** The kinds an unread changed file leaves unknown, beside the two the
 * structural check already names. */
const UNREAD_KINDS = [
  "moved-call",
  "cowrite-gap",
  "new-writer",
  "call-to-cache",
  "writer-companion",
] as const;

/** One event-loop turn: the worker hosts every lens session, so a long
 * anchors call yields between files. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A language family for comparing names across files: the dialect, or the
 * extension when the structure does not know the language. */
function familyKey(path: string): string {
  return dialectOf(path) ?? path.slice(path.lastIndexOf(".") + 1);
}

async function runAnchors(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  const run: AnchorRun = {
    anchors: [],
    unknown: new Map(),
    notes: [],
    movedLeft: MAX_MOVED_LINES,
  };
  const diff = await safeDiff(ctx);
  out.push(
    "anchors — lines where something may be missing, from the diff's shape (where to look, not proof)",
  );
  out.push(`[limits: ${SHAPE_LIMITS}]`);
  if (diff === null) {
    for (const k of ANCHOR_KINDS) out.push(`[${k}] unknown: the PR's diff could not be read`);
    return out;
  }
  const all = changedFiles(diff);
  const changed = all.filter((c) => !c.test);
  const codeChanged = changed.filter((c) => c.code);
  // A patch too long to read clears no kind its lines feed: each says so.
  for (const c of changed)
    if (c.patchWhy !== undefined)
      for (const k of c.code ? ANCHOR_KINDS : (["persisted-shape"] as const))
        addUnknown(run, k, `${c.path}: ${c.patchWhy}`);
  if (codeChanged.length > EXPLORE_MAX_CHANGED_FILES)
    run.notes.push(
      `[cut: the anchors read ${EXPLORE_MAX_CHANGED_FILES} of ${codeChanged.length} changed code files whole]`,
    );
  const read = codeChanged.slice(0, EXPLORE_MAX_CHANGED_FILES);
  const heads = new Map<string, string | null>();
  for (const c of read) {
    if (c.entry.status !== "removed") {
      const h = await ctx.head(c.path, true);
      if (h.ok) {
        c.head = ctx.shape(c.path, h.text);
        heads.set(c.path, h.text);
      } else c.headWhy = whyText(h.why, h.cap);
    } else c.headWhy = "the file is removed at the head";
    if (c.entry.status !== "added") {
      const b = await ctx.base(c.basePath);
      if (b.ok) c.base = shapeOf(c.basePath, b.text);
      else c.baseWhy = whyText(b.why, b.cap);
    }
  }
  const structural = (kind: AnchorKind, c: Changed): boolean => {
    if (!c.head) {
      if (c.added.size > 0 || c.removed.size > 0)
        addUnknown(run, kind, `${c.path}: not read (${c.headWhy ?? "unknown"})`);
      return false;
    }
    if (!c.head.structure) {
      addUnknown(run, kind, `${c.path}: structure unknown (${c.head.unknown})`);
      return false;
    }
    return true;
  };

  // Structural kinds over the changed files.
  let fnBudget = MAX_FUNCTIONS;
  let fnsLeft = 0;
  for (const c of read) {
    if (ctx.late()) break;
    await yieldTurn();
    // A changed file that was not read clears no kind: each says so.
    if (!c.head && c.entry.status !== "removed" && (c.added.size > 0 || c.removed.size > 0))
      for (const k of UNREAD_KINDS)
        addUnknown(run, k, `${c.path}: not read (${c.headWhy ?? "unknown"})`);
    if (c.head && c.entry.status !== "added") {
      if (c.base === null) {
        if (c.removed.size > 0)
          addUnknown(run, "moved-call", `${c.path}: base not read (${c.baseWhy ?? "unknown"})`);
      } else movedCalls(run, c);
    }
    if (!structural("exit-gap", c)) {
      structural("writes-no-tx", c);
      continue;
    }
    const every = changedFunctions(c);
    const fns = every.slice(0, fnBudget);
    fnBudget -= fns.length;
    fnsLeft += every.length - fns.length;
    exitGaps(run, c, fns);
    writesNoTx(run, c, fns);
  }
  // Functions past the walk's cap clear neither structural kind.
  if (fnsLeft > 0)
    for (const k of ["exit-gap", "writes-no-tx"] as const)
      addUnknown(
        run,
        k,
        `${fnsLeft} changed functions past the first ${MAX_FUNCTIONS} were not walked`,
      );

  // Persisted shapes: diff-wide facts first.
  const p: PersistCtx = {
    migration: all.some((c) => isMigrationFile(c.path)),
    versionTouched: all.some((c) =>
      changedLines(c).some((l) => VERSION_LINE_RE.test(l.text.slice(0, LINE_MAX))),
    ),
    persistSites: [],
  };

  // One sweep for every tree question.
  const listing = await ctx.list();
  const cow: CowritePair[] = [];
  const writers: WriterField[] = [];
  const caches: (CachePair & { hits: NameHit[] })[] = [];
  const reqs: SweepReq[] = [];
  let pairsCut = false;
  const cowBudget: LineBudget = { left: EXPLORE_MAX_ADDED_LINES, cut: false };
  const writerBudget: LineBudget = {
    left: EXPLORE_MAX_ADDED_LINES,
    cut: false,
    aliases: ALIAS_MAX_SCANS,
  };
  for (const c of read) {
    if (pairsCut || ctx.late()) break;
    await yieldTurn();
    for (const pr of cowritePairs(c, cowBudget)) {
      if (cow.length >= MAX_COWRITE_PAIRS) {
        pairsCut = true;
        break;
      }
      const occs: Occ[] = [];
      cow.push({ ...pr, occs });
      reqs.push(
        shapeRequest(
          pr.w.token,
          pr.w.norm,
          { path: c.path, line: pr.w.line },
          [pr.s.key.token],
          occs,
        ),
      );
    }
  }
  // A field is swept once per language family (the anchor reads only its
  // own family's hits), and a field one file's quota turned away stays open
  // to a later file that writes it.
  const seenField = new Set<string>();
  const leftPerFile = new Set<string>();
  const aliasFlags = { aliasCut: false, aliasWindowCut: false };
  let writersCut = 0;
  for (const c of read) {
    if (ctx.late()) break;
    await yieldTurn();
    let fromFile = 0;
    for (const f of newWriterFields(c, writerBudget)) {
      const key = `${familyKey(c.path)}\0${f.field}`;
      if (seenField.has(key) || genericField(f.field)) continue;
      const forms = nameFormsOf(f.field);
      if (!forms) {
        seenField.add(key);
        continue;
      }
      if (writers.length >= MAX_NEW_WRITERS) {
        seenField.add(key);
        writersCut++;
        continue;
      }
      if (fromFile >= MAX_NEW_WRITERS_PER_FILE) {
        leftPerFile.add(key);
        continue;
      }
      seenField.add(key);
      fromFile++;
      const hits: NameHit[] = [];
      const book = newBook();
      writers.push({ c, line: f.line, field: forms.name, forms, hits, book });
      reqs.push(nameRequest(forms, hits, { book, flags: aliasFlags }));
    }
  }
  if (cowBudget.cut)
    addUnknown(
      run,
      "cowrite-gap",
      `added lines past the first ${EXPLORE_MAX_ADDED_LINES} were not examined`,
    );
  if (writerBudget.cut)
    for (const k of ["new-writer", "writer-companion"] as const)
      addUnknown(run, k, `added lines past the first ${EXPLORE_MAX_ADDED_LINES} were not examined`);
  for (const c of read)
    for (const cp of cachePairs(c)) {
      if (caches.length >= MAX_CACHE_PAIRS) break;
      const forms = nameFormsOf(cp.field);
      if (!forms) continue;
      const hits: NameHit[] = [];
      caches.push({ ...cp, hits });
      reqs.push(nameRequest(forms, hits));
    }
  const jsSlice = read.some((c) => dialectOf(c.path) === "js");
  if (jsSlice)
    reqs.push({
      tokens: PERSIST_TOKENS,
      onHit(path, shape, line) {
        const sl = shape.lines[line - 1];
        if (
          sl &&
          sl.kind === "code" &&
          p.persistSites.length < 20 &&
          !p.persistSites.some((x) => x.path === path)
        )
          p.persistSites.push({ path, line });
      },
    });
  let stats: SweepStats | null = null;
  if (listing === null) {
    for (const k of ["cowrite-gap", "new-writer", "call-to-cache", "writer-companion"] as const)
      addUnknown(run, k, "the head tree listing could not be read, so nothing was swept");
    if (jsSlice)
      addUnknown(
        run,
        "persisted-shape",
        "the head tree listing could not be read, so redux-persist configs were not searched",
      );
  } else if (reqs.length > 0 && !ctx.late()) {
    const order = sweepOrder(
      listing,
      read.map((c) => c.path),
      new Set(read.map((c) => dirOf(c.path))),
    );
    stats = await sweep(ctx, reqs, order);
  } else if (reqs.length > 0) {
    for (const k of ["cowrite-gap", "new-writer", "call-to-cache", "writer-companion"] as const)
      addUnknown(run, k, "the deadline passed before the sweep");
  }
  const swept = stats !== null;
  const cutNote = stats && !whole(stats) ? " (of the files searched; the sweep was cut)" : "";

  for (const c of changed) {
    if (ctx.late()) {
      addUnknown(
        run,
        "persisted-shape",
        `${c.path} and the files after it: ${whyText("deadline")}`,
      );
      break;
    }
    persistedShapes(run, c, p, heads.get(c.path) ?? null);
    await protoFile(ctx, run, c);
  }

  const busyCowrites: string[] = [];
  const busyFields: string[] = [];
  const busyCompanionFields: string[] = [];
  const companionIdioms: string[] = [];
  if (swept) {
    for (const pr of cow) {
      if (pr.occs.length === 0) continue;
      const lacking = pr.occs.filter((o) => o.missing.length > 0);
      if (lacking.length === 0) continue;
      if (pr.occs.length >= BUSY_COWRITE_SITES) {
        busyCowrites.push(`${pr.c.path}:${pr.s.line}`);
        continue;
      }
      anchor(
        run,
        pr.c,
        "cowrite-gap",
        2,
        pr.s.line,
        `${span(pr.s.key.key)} added beside ${span(pr.w.norm)} (L${pr.w.line}); that statement occurs at ${pr.occs.length} other site${pr.occs.length === 1 ? "" : "s"}${cutNote}, ${lacking.length} without ${span(pr.s.key.token)} within ±${SIBLING_NEAR} lines: ${lacking
          .slice(0, 5)
          .map((o) => `${o.path}:${o.line}`)
          .join(
            ", ",
          )}${lacking.length > 5 ? ` and ${lacking.length - 5} more` : ""} — do these sites need it too?`,
      );
    }
    for (const w of writers) {
      // Writers and readers in the changed file's own language: the same
      // name in another language is another field.
      const family = familyKey(w.c.path);
      const same = w.hits.filter((h) => familyKey(h.path) === family);
      const ws = same.filter((h) => h.occ.kind === "write");
      const rs = same.filter((h) => h.occ.kind === "read");
      const others = ws.filter((h) => !(h.path === w.c.path && w.c.added.has(h.line)));
      if (others.length === 0 && rs.length === 0) continue;
      // The write the anchor stands on was not read as one: no count to give.
      if (ws.length === others.length) continue;
      if (ws.length >= BUSY_FIELD_WRITERS) {
        busyFields.push(`${w.field} (${ws.length})`);
        continue;
      }
      const files = new Set(ws.map((h) => h.path)).size;
      anchor(
        run,
        w.c,
        "new-writer",
        others.length >= 3 ? 3 : 4,
        w.line,
        `${span(w.field)} written here; the head tree holds ${ws.length} writer${ws.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} (the diff adds ${ws.length - others.length}) and ${rs.length} reader${rs.length === 1 ? "" : "s"}${cutNote}${
          others.length > 0
            ? `; other writers: ${others
                .slice(0, 4)
                .map((h) => `${h.path}:${h.line}`)
                .join(", ")}`
            : ""
        } — does this write keep what the other writers and the readers assume?`,
      );
    }
    writerCompanions(run, writers, read, cutNote, busyCompanionFields, companionIdioms);
    for (const cp of caches) {
      const ws = cp.hits.filter((h) => h.occ.kind === "write");
      anchor(
        run,
        cp.c,
        "call-to-cache",
        2,
        cp.line,
        `${span(`${cp.callee}(…)`)} replaced by a read of ${span(cp.field)}; ${span(cp.field)} has ${ws.length} writer${ws.length === 1 ? "" : "s"}${cutNote}${
          ws.length > 0
            ? `: ${ws
                .slice(0, 5)
                .map((h) => `${h.path}:${h.line}`)
                .join(", ")}`
            : ""
        } — who keeps it fresh on every path that changed the source?`,
      );
    }
  }
  if (pairsCut)
    run.notes.push(`[cut: co-write pairs past the first ${MAX_COWRITE_PAIRS} not swept]`);
  if (busyCowrites.length > 0)
    run.notes.push(
      `[cowrite-gap: ${busyCowrites.length} pair${busyCowrites.length === 1 ? "" : "s"} beside a statement found at ${BUSY_COWRITE_SITES} or more sites left out (an idiom, not a partner): ${busyCowrites.slice(0, 4).join(", ")}]`,
    );
  if (busyFields.length > 0)
    run.notes.push(
      `[new-writer: fields with ${BUSY_FIELD_WRITERS} or more writers left out: ${busyFields.slice(0, 6).join(", ")}]`,
    );
  if (writersCut > 0)
    run.notes.push(
      `[cut: ${writersCut} written fields past the first ${MAX_NEW_WRITERS} not swept]`,
    );
  const writersCutPerFile = [...leftPerFile].filter((k) => !seenField.has(k)).length;
  if (writersCutPerFile > 0)
    run.notes.push(
      `[cut: ${writersCutPerFile} written fields past the first ${MAX_NEW_WRITERS_PER_FILE} of their changed file not swept]`,
    );
  if (writerBudget.aliasCut)
    run.notes.push(
      `[cut: added writes through a local pointer were traced to the member it points at for the first ${ALIAS_MAX_SCANS}]`,
    );
  if (aliasFlags.aliasCut)
    run.notes.push(
      `[cut: writes through an address-taking alias were followed for the first ${ALIAS_MAX_SCANS} such lines per field]`,
    );
  if (aliasFlags.aliasWindowCut) run.notes.push(ALIAS_WINDOW_NOTE);
  if (busyCompanionFields.length > 0)
    run.notes.push(
      `[writer-companion: fields with ${BUSY_FIELD_WRITERS} or more writers left out: ${busyCompanionFields.slice(0, 6).join(", ")}]`,
    );
  if (companionIdioms.length > 0)
    run.notes.push(
      `[writer-companion: partners left out as idioms (${BUSY_COWRITE_SITES} or more statements, most away from the writes): ${companionIdioms
        .slice(0, 4)
        .map(span)
        .join(", ")}]`,
    );

  // Render.
  run.anchors.sort((a, b) => a.rank - b.rank || a.fileOrder - b.fileOrder || a.line - b.line);
  for (const a of run.anchors.slice(0, EXPLORE_MAX_ANCHORS))
    out.push(`[${a.kind}] ${a.path}:${a.line} (${a.fn}) — ${a.text}`);
  if (run.anchors.length > EXPLORE_MAX_ANCHORS) {
    const rest = new Map<string, number>();
    for (const a of run.anchors.slice(EXPLORE_MAX_ANCHORS))
      rest.set(a.kind, (rest.get(a.kind) ?? 0) + 1);
    out.push(
      `[cut: ${run.anchors.length - EXPLORE_MAX_ANCHORS} more anchors not shown — ${[...rest].map(([k, n]) => `${k} ${n}`).join(", ")}]`,
    );
  }
  for (const k of ANCHOR_KINDS)
    for (const why of (run.unknown.get(k) ?? []).slice(0, 6)) out.push(`[${k}] unknown: ${why}`);
  out.push(...run.notes);
  const found = new Set(run.anchors.map((a) => a.kind));
  // A kind whose anchors were left out by name is not silent.
  if (busyCowrites.length > 0) found.add("cowrite-gap");
  if (busyFields.length > 0) found.add("new-writer");
  if (busyCompanionFields.length > 0 || companionIdioms.length > 0) found.add("writer-companion");
  const silent = ANCHOR_KINDS.filter((k) => !found.has(k) && !run.unknown.has(k));
  const summary = [
    `swept: ${changed.length} changed file${changed.length === 1 ? "" : "s"} (${codeChanged.length} code; ${all.length - changed.length} test files left out)`,
    stats
      ? `tree: ${sweepLine(stats)}`
      : listing === null
        ? "tree: the listing could not be read"
        : reqs.length === 0
          ? "tree: nothing to sweep"
          : "tree: not swept (the deadline passed)",
    ctx.timedOut ? "[cut: the deadline passed; later kinds may be partial]" : "",
    silent.length > 0
      ? `no anchor: ${silent.join(", ")}${stats && !whole(stats) ? " (the sweep was cut, so this clears nothing for the swept kinds)" : ""}${codeChanged.length > read.length ? ` (${codeChanged.length - read.length} changed code files were not read, so this clears nothing)` : ""}`
      : "",
  ].filter((s) => s !== "");
  out.push(summary.join("; "));
  return out;
}

// ---------------------------------------------------------------------------
// Entry

function clip(lines: readonly string[], maxChars: number): string {
  let used = 0;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (used + l.length + 1 > maxChars - 120) {
      kept.push(
        `[cut: output over ${maxChars} characters; ${lines.length - i} more lines not shown]`,
      );
      break;
    }
    kept.push(l);
    used += l.length + 1;
  }
  return kept.join("\n");
}

/** Runs one request. Never throws: a failure is a line of the answer. */
export async function runStateExplore(
  req: ExploreRequest,
  io: ExploreIo,
  opts: ExploreOptions = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? EXPLORE_MAX_CHARS;
  const refusal = exploreRequestRefusal(req);
  if (refusal) {
    await io.close?.().catch(() => undefined);
    return refusal;
  }
  const ctx = new Ctx(io, opts.now ?? Date.now, opts.deadlineMs ?? EXPLORE_DEADLINE_MS);
  let lines: string[];
  try {
    if (req.action === "anchors") lines = await runAnchors(ctx);
    else if (req.action === "writes" || req.action === "reads")
      lines = await runName(ctx, req, req.action);
    else if (req.action === "exits") lines = await runExits(ctx, req);
    else lines = await runSiblings(ctx, req);
  } catch (err) {
    lines = [
      `unknown: the ${req.action} action failed on this input (${err instanceof Error ? err.message.slice(0, 200) : "error"})`,
    ];
  } finally {
    await io.close?.().catch(() => undefined);
  }
  if (ctx.timedOut && !lines.some((l) => l.includes("deadline")))
    lines.push(
      `[cut: the ${Math.round((opts.deadlineMs ?? EXPLORE_DEADLINE_MS) / 1000)} s deadline passed; the answer covers what was read before it]`,
    );
  return clip(lines, maxChars);
}

/** Every regex this module runs, for the linear-time test. */
export const STATE_EXPLORE_PROBES: readonly { id: string; re: RegExp }[] = [
  { id: "assign-after", re: ASSIGN_AFTER_RE },
  { id: "incr-before", re: INCR_BEFORE_RE },
  { id: "member-before", re: MEMBER_BEFORE_RE },
  { id: "key-after", re: KEY_AFTER_RE },
  { id: "cond-lead", re: COND_LEAD_RE },
  { id: "cond-after", re: COND_AFTER_RE },
  { id: "cond-before", re: COND_BEFORE_RE },
  { id: "return-lead", re: RETURN_LEAD_RE },
  { id: "chain-assign-after", re: CHAIN_ASSIGN_AFTER_RE },
  { id: "receiver-method-after", re: RECEIVER_METHOD_AFTER_RE },
  { id: "atomic-arg-before", re: ATOMIC_ARG_BEFORE_RE },
  { id: "atomic-method", re: ATOMIC_METHOD_RE },
  { id: "type-before", re: TYPE_BEFORE_RE },
  { id: "field-name", re: FIELD_NAME_RE },
  { id: "decl-lead", re: DECL_LEAD_RE },
  { id: "sql-set", re: SQL_SET_RE },
  { id: "sql-where", re: SQL_WHERE_RE },
  { id: "sql-any", re: SQL_ANY_RE },
  { id: "version-line", re: VERSION_LINE_RE },
  { id: "slice-head", re: SLICE_HEAD_RE },
  { id: "store-head", re: STORE_HEAD_RE },
  { id: "dexie", re: DEXIE_RE },
  { id: "idb-store", re: IDB_STORE_RE },
  { id: "idb-open", re: IDB_OPEN_RE },
  { id: "ddl", re: DDL_RE },
  { id: "proto-field", re: PROTO_FIELD_RE },
  { id: "local-store", re: LOCAL_STORE_RE },
  { id: "field-decl", re: FIELD_DECL_RE },
  { id: "version-word", re: VERSION_WORD_RE },
  { id: "write-call", re: WRITE_CALL_RE },
  { id: "sql-write", re: SQL_WRITE_RE },
  { id: "tx", re: TX_RE },
  { id: "cache-prefix", re: CACHE_PREFIX_RE },
  { id: "store-call", re: STORE_CALL_RE },
  { id: "store-receiver", re: STORE_RECEIVER_RE },
  { id: "builder-method", re: BUILDER_METHOD_RE },
  { id: "class-name", re: CLASS_NAME_RE },
  { id: "addr-before", re: ADDR_BEFORE_RE },
  { id: "addr-end-after", re: ADDR_END_AFTER_RE },
  { id: "alias-lhs", re: ALIAS_LHS_RE },
  { id: "deref-before", re: DEREF_BEFORE_RE },
  { id: "alias-bind-after", re: ALIAS_BIND_AFTER_RE },
  { id: "terminal-setter", re: TERMINAL_SETTER_RE },
  { id: "idiom", re: IDIOM_RE },
  { id: "container-verb", re: CONTAINER_VERB_RE },
  { id: "receiver-chain-end", re: RECEIVER_CHAIN_END_RE },
  { id: "db-segment", re: DB_SEGMENT_RE },
  { id: "store-word", re: STORE_WORD_RE },
  { id: "per-item-callback", re: PER_ITEM_CALLBACK_RE },
  { id: "loop-exit", re: LOOP_EXIT_RE },
  { id: "log-callee", re: LOG_CALLEE_RE },
];

export type { Exit };
