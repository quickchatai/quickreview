// State-machine triggers: which lenses of the state-machine family
// (packages/pi-plugin/src/passes.ts `STATE_FAMILY`) a PR's content plans.
//
// An implicit state machine has no filename: it is a flag beside two others,
// a status written without a look at the old one, a member added to an
// enumeration three files dispatch on. So each trigger is a probe over what
// the diff SAYS — its added lines, its removed lines, a migration's added
// lines, or the PR's own words — never over where the file lives.
//
// Two strengths, as for the security family:
//   strong   a shape that is a state-machine question on its own: a check of
//            the current state taken away, a member added to an existing
//            enumeration, two status flags added side by side, a transient
//            state entered with nothing in the file that leaves it on every
//            exit, an effect that only copies state, a migration that
//            changes a stored state, a PR that says
//            "double submit" or "out of order", a profile probe. These plan
//            in the default profile (`[state_machines] triggers = "strong"`).
//   weak     a surface where such a defect may live: a status write, a
//            dispatch over a state-like value, an event handler, a lifecycle
//            method. Planned only with `triggers = "all"` (the state-machines
//            profile).
//
// `selectStateLenses` never plans a lens a profile switched off; the planner
// applies `enabled = false` and `skip_lenses` after it, as for every lens.
//
// Linear by construction: every probe reads ONE line at a time, cut to
// `LINE_MAX` characters, and no pattern nests an unbounded scan in another.
// The text is the PR author's, of any length, and a probe runs synchronously
// in the dispatch pump (tests/state-triggers.test.ts times every probe
// against pathological input).
//
// Pure: the planner passes the files and the PR's words in.

import type { PrFileEntry } from "./githubcore.js";
import {
  CODE_FILE_RE,
  diffSide,
  EMPTY_HEURISTICS,
  isTestFile,
  type HeuristicsExtension,
} from "./heuristics.js";
import { parseHunkHeader } from "./hunkheader.js";
import { STATE_FAMILY } from "./passes.js";
import type { StateTriggerMode } from "./reviewconfig.js";

/** The longest prefix of a line a probe reads. A longer line is generated or
 * minified text; what a person wrote about a state fits well inside it. */
export const LINE_MAX = 400;

export interface StateTrigger {
  /** A stable name, for tests and for the docs' table. */
  id: string;
  lens: string;
  strength: "strong" | "weak";
  /** What the probe reads, one line at a time:
   *  - `added`    the added lines of a non-test code file;
   *  - `removed`  the removed lines of one — and a line counts only when its
   *               matched text is not added back in the same file (a moved
   *               check is not a removed one);
   *  - `stored`   the added lines of a migration, schema or SQL file
   *               (`STORED_FILE_RE`), code or not;
   *  - `text`     the PR's title and body. */
  probe: "added" | "removed" | "stored" | "text";
  /** Tested against one line (sign stripped, cut to `LINE_MAX`). Never
   * global, never sticky. */
  re: RegExp;
  /** How many lines of one file must match (default 1). */
  min?: number;
  /** The file does not fire when any of its added lines matches this: the
   * change itself carries the thing whose absence is the signal. */
  unless?: RegExp;
  /** What fired, for the plan: "<why> in <file>". */
  why: string;
}

/** Where a stored state is declared or changed: migrations, schema files and
 * SQL, by name. */
export const STORED_FILE_RE =
  /(^|\/)(?:migrations?|migrate|alembic|versions|schema|schemas|db)\/|(^|\/)schema\.(?:rb|prisma|sql|graphql)$|\.sql$|\.prisma$/i;

/** The field names that hold a state. Every trigger reads this one list. */
const STATE_NAMES = ["status", "state", "phase", "stage", "lifecycle", "step"] as const;

/** A name that holds which state a thing is in, as a pattern. */
const STATE_NAME = `(?:${STATE_NAMES.join("|")})`;

/** A word that names a state a thing passes through and must leave, as a
 * pattern source. */
const TRANSIENT = String.raw`(?:loading|submitting|saving|pending|busy|processing|fetching|uploading|syncing|running|locked|starting|stopping|connecting|in[_-]?progress|in[_-]?flight)`;

export const STATE_TRIGGERS: readonly StateTrigger[] = [
  // ---- pass-sm-states: which combinations can exist ----------------------
  {
    id: "flags-side-by-side",
    lens: "pass-sm-states",
    strength: "strong",
    probe: "added",
    min: 2,
    re: new RegExp(
      String.raw`\b(?:is|has|was|did|should|can)(?:[A-Z]\w{1,40}|_[a-z]\w{1,40})\b.{0,40}(?::\s*bool(?:ean)?\b|=\s*(?:true|false|True|False)\b|BooleanField|Column\(\s*Boolean|useState(?:<boolean>)?\(\s*(?:true|false))`,
    ),
    why: "two or more status flags are added side by side",
  },
  {
    id: "flag",
    lens: "pass-sm-states",
    strength: "weak",
    probe: "added",
    re: new RegExp(
      String.raw`\b(?:is|has|was|did|should|can)(?:[A-Z]\w{1,40}|_[a-z]\w{1,40})\b.{0,40}(?::\s*bool(?:ean)?\b|=\s*(?:true|false|True|False)\b|BooleanField|Column\(\s*Boolean|useState(?:<boolean>)?\(\s*(?:true|false))`,
    ),
    why: "a status flag is added",
  },
  {
    id: "nullable-marker",
    lens: "pass-sm-states",
    strength: "weak",
    probe: "added",
    re: /\b\w{2,40}(?:_at|At|_on|_by|By)\b\??\s*[:=].{0,60}(?:\bnull\b|\bNone\b|\bOptional\b|\bnil\b|undefined|null=True|nullable)/,
    why: "a nullable marker field (a timestamp or an actor that is set only in some states) is added",
  },

  // ---- pass-sm-transitions: who may move it, from where -------------------
  {
    id: "state-check-removed",
    lens: "pass-sm-transitions",
    strength: "strong",
    probe: "removed",
    re: new RegExp(
      String.raw`\b(?:if|elif|else if|unless|when|while|guard|assert|require|ensure|raise|throw|return)\b.{0,120}\b\w{0,40}${STATE_NAME}\w{0,20}\b\s*(?:===?|!==?|\bnot in\b|\bin\b|\bis not\b|\bis\b|\.equals\(|\.includes\()`,
      "i",
    ),
    why: "a check of the current state is removed",
  },
  {
    id: "state-write",
    lens: "pass-sm-transitions",
    strength: "weak",
    probe: "added",
    re: new RegExp(
      String.raw`(?:\.|\b)${STATE_NAME}\s*=(?!=)|\bset(?:Status|State|Phase|Stage|Step)\(|\btransition(?:_to|To)?\(|\b${STATE_NAME}\s*:\s*['"A-Z]`,
    ),
    why: "a state is written",
  },
  {
    id: "says-transition",
    lens: "pass-sm-transitions",
    strength: "weak",
    probe: "text",
    re: /\bstate[- ]machine|\b(?:state|status)\s+transitions?\b|\btransitions?\s+(?:from|to|between)\b|\bworkflow\s+(?:state|step)/i,
    why: "the PR text speaks of a state machine or a transition",
  },

  // ---- pass-sm-exhaustive: every place that dispatches on it --------------
  // `member-added` is not a line probe: see `memberAddedHit`.
  {
    id: "dispatch",
    lens: "pass-sm-exhaustive",
    strength: "weak",
    probe: "added",
    re: new RegExp(
      String.raw`\b(?:switch|match|when)\b.{0,80}\b\w{0,40}(?:${STATE_NAME}|kind|type|mode|variant)\b|\bcase\b.{0,60}\b(?:Status|State|Phase|Stage|Kind|Mode)\.[A-Za-z_]\w{0,40}`,
    ),
    why: "a dispatch over a state-like value is added or changed",
  },

  // ---- pass-sm-stuck: every exit of a state that must be left -------------
  {
    id: "transient-entered-no-exit",
    lens: "pass-sm-stuck",
    strength: "strong",
    probe: "added",
    re: new RegExp(
      String.raw`\bset(?:Is)?(?:Loading|Submitting|Saving|Pending|Busy|Processing|Fetching|Uploading|Syncing|Running|Locked)\(\s*true\s*\)|\b(?:is_?)?${TRANSIENT}\s*=\s*(?:true|True)\b`,
      "i",
    ),
    unless:
      /\bfinally\b|\.finally\(|\bensure\b|\bdefer\b|\bwith\s+\w|\busing\b|\btry\s*\{|\bexcept\b|\bcatch\b|\brescue\b/,
    why: "a transient state is entered and no added line of the file handles a failure after it",
  },
  {
    id: "transient-entered",
    lens: "pass-sm-stuck",
    strength: "weak",
    probe: "added",
    re: new RegExp(
      String.raw`\bset(?:Is)?(?:Loading|Submitting|Saving|Pending|Busy|Processing|Fetching|Uploading|Syncing|Running|Locked)\(\s*true\s*\)|\b(?:is_?)?${TRANSIENT}\s*=\s*(?:true|True)\b|\b${STATE_NAME}\b.{0,24}[=:(,]\s*[\w.]{0,40}['"]?${TRANSIENT}\b`,
      "i",
    ),
    why: "a transient state is entered",
  },
  {
    id: "says-stuck",
    lens: "pass-sm-stuck",
    strength: "weak",
    probe: "text",
    re: /\bstuck\b|\bnever\s+(?:reset|cleared|released|finishe[sd]|completed?)\b|\bhangs?\b|\bspinner\b|\bstays?\s+(?:in|on|disabled|locked|pending)\b/i,
    why: "the PR text speaks of something stuck or never reset",
  },

  // ---- pass-sm-events: what arrives when it is not expected ---------------
  {
    id: "says-duplicate-or-order",
    lens: "pass-sm-events",
    strength: "strong",
    probe: "text",
    re: /\bdouble[- ]?(?:submit|click|charge|send|fire|booking|spend)|\bduplicate[ds]?\s+(?:event|deliver|webhook|message|request|callback|job)|\bout[- ]of[- ]order\b|\bre-?entran|\bidempoten|\bfires?\s+twice\b|\bcalled\s+twice\b|\blate\s+(?:callback|response|event)/i,
    why: "the PR text speaks of a duplicate, late or out-of-order event",
  },
  {
    id: "handler",
    lens: "pass-sm-events",
    strength: "weak",
    probe: "added",
    re: /\baddEventListener\(|\.on\(\s*['"]|\.once\(\s*['"]|@receiver\b|@(?:EventListener|KafkaListener|RabbitListener|SqsListener|OnEvent|Subscribe)\b|\bsubscribe\(|\bon(?:Message|Event|Webhook)\b|\b(?:def|function|func|fn)\s+(?:handle|on)_?[A-Za-z]\w{1,60}\s*\(|\bon[A-Z]\w{1,40}\s*=\s*(?:async\s*)?\(/,
    why: "an event handler is added or changed",
  },

  // ---- pass-sm-derived: a stored copy of something computable -------------
  {
    id: "effect-syncs-state",
    lens: "pass-sm-derived",
    strength: "strong",
    probe: "added",
    re: /\buseEffect\(\s*\(\s*\)\s*=>\s*\{?\s*set[A-Z]\w{0,40}\(/,
    why: "an effect whose body only sets state is added (a value kept in step by hand)",
  },
  {
    id: "stored-summary",
    lens: "pass-sm-derived",
    strength: "weak",
    probe: "added",
    re: /\b(?:cached|total|num|last|prev|previous)(?:[A-Z]\w{1,40}|_[a-z]\w{1,40})\s*[:=](?!=)|\b\w{2,40}(?:Count|Total|Cache|_count|_total|_cache|_cached)\b\s*[:=](?!=)/,
    why: "a stored count, total, cache or last-value field is written",
  },

  // ---- pass-sm-lifecycle: the order calls must come in --------------------
  {
    id: "lifecycle-check-removed",
    lens: "pass-sm-lifecycle",
    strength: "strong",
    probe: "removed",
    re: /\b(?:if|elif|unless|when|while|guard|assert|require|ensure|raise|throw)\b.{0,120}\b_?(?:is_?)?(?:initiali[sz]ed|closed|disposed|destroyed|started|stopped|connected|opened|ready|mounted|released|shut_?down|torn_?down)\b/i,
    why: "a check of an object's lifecycle phase is removed",
  },
  {
    id: "lifecycle-method",
    lens: "pass-sm-lifecycle",
    strength: "weak",
    probe: "added",
    re: /\b(?:def|function|func|fn|void|async|public|private|protected)\s+(?:\w+\s+){0,3}(?:init|initiali[sz]e|start|stop|open|close|connect|disconnect|dispose|destroy|shutdown|teardown|setup|cleanup|release|acquire|begin|finish|commit|rollback|mount|unmount)\w{0,30}\s*\(|\b(?:componentWillUnmount|ngOnDestroy|onDestroy|__enter__|__exit__|__aenter__|__aexit__|Dispose|Drop\s+for)\b/,
    why: "a lifecycle method (start, stop, open, close, dispose, …) is added or changed",
  },

  // ---- pass-sm-durable: the state that outlives the process ---------------
  {
    id: "stored-state-changed",
    lens: "pass-sm-durable",
    strength: "strong",
    probe: "stored",
    re: new RegExp(
      String.raw`\b\w{0,40}${STATE_NAME}\b|\bALTER\s+TYPE\b.{0,80}\bADD\s+VALUE\b|\bCREATE\s+TYPE\b.{0,80}\bAS\s+ENUM\b`,
      "i",
    ),
    why: "a migration or schema adds or changes a stored state",
  },
  {
    id: "stored-state-write",
    lens: "pass-sm-durable",
    strength: "weak",
    probe: "added",
    re: new RegExp(
      String.raw`\bUPDATE\b.{0,80}\bSET\b.{0,120}\b${STATE_NAME}\b|\.(?:update|update_all|updateMany|update_one|updateOne|upsert|filter)\(.{0,160}\b${STATE_NAME}\b\s*[=:]|\bupdate_fields\b.{0,80}['"]${STATE_NAME}['"]`,
      "i",
    ),
    why: "a stored state is written",
  },
];

export interface StateSelection {
  lens: string;
  /** The first reason that fired — a strong one before a weak one. */
  why: string;
  strength: "strong" | "weak";
  /** The files whose content fired a trigger for this lens. */
  files?: string[];
}

export interface StateSelectionOpts {
  mode: StateTriggerMode;
  /** The PR's own words: the `text` probes read them. */
  intent?: { title?: string | null; body?: string | null };
  /** The profile's `heuristics.toml` probes for a family lens. */
  extension?: HeuristicsExtension;
}

interface Hit {
  lens: string;
  strength: "strong" | "weak";
  why: string;
  file?: string;
}

/** A patch side's lines, signs stripped, each cut to `LINE_MAX`. */
function sideLines(patch: string, sign: "+" | "-"): string[] {
  const side = diffSide(patch, sign);
  if (side === "") return [];
  return side.split("\n").map((l) => l.slice(1, 1 + LINE_MAX));
}

/** The matched line as the plan shows it: trimmed, at most 80 characters. */
function shown(line: string): string {
  const t = line.trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

/** A changed file the code probes read: patched, code, not a test. */
export const isSourceCode = (f: PrFileEntry): boolean =>
  f.patch !== undefined && CODE_FILE_RE.test(f.filename) && !isTestFile(f.filename);

const isStored = (f: PrFileEntry): boolean =>
  f.patch !== undefined && STORED_FILE_RE.test(f.filename) && !isTestFile(f.filename);

/** The substring scans of the added side one file may cost a `removed`
 * trigger. Past it, a removed check that no added line holds verbatim counts
 * as removed: a capped look never reads as "added back". */
export const ADD_BACK_SCANS_MAX = 32;

/** The first file one line probe fires on, or null. */
function lineHit(files: readonly PrFileEntry[], t: StateTrigger): Hit | null {
  const population = files.filter(t.probe === "stored" ? isStored : isSourceCode);
  for (const f of population) {
    const patch = f.patch as string;
    const added = sideLines(patch, "+");
    const lines = t.probe === "removed" ? sideLines(patch, "-") : added;
    if (lines.length === 0) continue;
    if (t.unless && added.some((l) => t.unless!.test(l))) continue;
    const matched: string[] = [];
    // removed: the matched texts of the added side, built once per file, so a
    // moved block of checks costs one lookup a line.
    let addedBack: Set<string> | null = null;
    let scans = 0;
    for (const line of lines) {
      const m = t.re.exec(line);
      if (!m) continue;
      // removed: only what the file does not add back.
      if (t.probe === "removed") {
        const needle = m[0].trim();
        addedBack ??= new Set(
          added.flatMap((a) => {
            const back = t.re.exec(a);
            return back ? [back[0].trim()] : [];
          }),
        );
        // A moved or re-indented check; else an edited line that still holds
        // it, looked for by a scan of the added side, under the cap.
        let back = addedBack.has(needle);
        if (!back && scans < ADD_BACK_SCANS_MAX) {
          scans++;
          back = added.some((a) => a.includes(needle));
        }
        if (back) continue;
      }
      matched.push(line);
      if (matched.length >= (t.min ?? 1)) break;
    }
    if (matched.length >= (t.min ?? 1))
      return {
        lens: t.lens,
        strength: t.strength,
        why: `${t.why} in ${f.filename} (\`${shown(matched[0]!)}\`)`,
        file: f.filename,
      };
  }
  return null;
}

/** A `text` probe over the PR's title and body, line by line. */
function textHit(t: StateTrigger, intent: StateSelectionOpts["intent"]): Hit | null {
  const text = `${intent?.title ?? ""}\n${intent?.body ?? ""}`;
  for (const raw of text.split("\n")) {
    const line = raw.slice(0, LINE_MAX);
    if (t.re.test(line)) return { lens: t.lens, strength: t.strength, why: t.why };
  }
  return null;
}

// ---- a member added to an existing enumeration -----------------------------

/** A declaration that enumerates named alternatives, in any of the languages
 * the reviewer reads. */
const ENUM_DECL_RE =
  /\benum\b|\b(?:Str|Int|Flag)?Enum\b|\b(?:Text|Integer)?Choices\b|\bsealed\s+(?:class|interface|trait)\b|\biota\b|\bLiteral\[/;

/** One member of an enumeration on a line of its own: `ACTIVE = "active",`,
 * `Active,`, `case active`, `Active(String),`, `ACTIVE = auto()`. A match
 * arm (`_ => None,`) is not one: `=` followed by `>` assigns nothing.
 *
 * Each optional part carries its own leading whitespace, and the value of an
 * assignment starts at its first non-blank character, so a run of blanks is
 * read by one quantifier only: a line of blanks costs one scan, not one per
 * way of splitting it. */
export const ENUM_MEMBER_RE =
  /^\s*(?:case\s+)?[A-Za-z_][A-Za-z0-9_]{0,40}(?:\s*\([^()]{0,60}\))?(?:\s*=(?!>)(?:\s*[^=;{}\s][^=;{}]{0,59}|\s))?(?:\s*[,;])?\s*(?:(?:\/\/|#).{0,120})?$/;

/** One member of a union of string literals on a line of its own:
 * `| "active"`. The blanks after an optional `;` belong to it, so a run of
 * blanks is read by one quantifier only. */
const UNION_MEMBER_RE = /^\s*\|\s*['"][\w .:/-]{1,40}['"]\s*(?:;\s*)?$/;

/** Lines that look like a member but are not one. */
const NOT_MEMBER_RE =
  /^\s*(?:return|break|continue|pass|else|default|import|from|export|const|let|var|if|for|while|try|finally|end|fi|done|\}|\)|\])\b|^\s*[A-Za-z_]\w*\s*=\s*(?:\{|\[|new\b|function\b|async\b|\()/;

/** A line that declares nothing, whatever word it holds: a comment, an
 * attribute or preprocessor line, an import, the `} from "…"` that closes an
 * import list. */
const NOT_DECL_RE =
  /^\s*(?:\/\/|\/\*|\*|#|--\s|(?:\}\s*)?(?:from|import|use|using|require|include)\b)/;
/** A comment that ends a line of code: `//` anywhere, `#` at the line's start
 * or after a blank (so the `#` of a quoted `"#fff"` is not one). */
const TRAILING_COMMENT_RE = new RegExp(String.raw`(?:\/\/|(?:^|\s)#).{0,${LINE_MAX}}$`);
const IOTA_RE = /\biota\b/;

/** A cut line's code: the line without its trailing comment. */
function codeOf(text: string): string {
  return text.replace(TRAILING_COMMENT_RE, "");
}

/** Whether a line declares an enumeration: its code holds a declaration word
 * and the line is no comment, attribute or import line. The one answer for a
 * hunk's header scope, its body lines and the naming of a type. Reads the
 * line's first `LINE_MAX` characters. */
function declaresEnum(text: string): boolean {
  const line = text.slice(0, LINE_MAX);
  return !NOT_DECL_RE.test(line) && ENUM_DECL_RE.test(codeOf(line));
}

/** The word that makes a Python class an enumeration, inside its bases. */
const ENUM_BASE_RE = /(?:Enum|Choices)\b/;
const CLASS_NAME_RE = /\bclass\s+([A-Za-z_]\w{0,60})\s*\(([^()]{0,200})\)/;
const ENUM_NAME_RE = /\benum\s+(?:(?:class|struct)\s+)?(?!(?:class|struct)\b)([A-Za-z_]\w{0,60})\b/;
const SEALED_NAME_RE = /\bsealed\s+(?:class|interface|trait)\s+([A-Za-z_]\w{0,60})\b/;
const UNION_NAME_RE = /\btype\s+([A-Za-z_]\w{0,60})\s*=/;
const LITERAL_NAME_RE = /\b([A-Za-z_]\w{0,60})\s*=\s*Literal\[/;
const IOTA_NAME_RE = /^\s*[A-Za-z_]\w{0,60}\s+([A-Za-z_]\w{0,60})\s*=\s*iota\b/;

/** The type an enumeration's declaration line names, by the shape of the
 * declaration; undefined when the shape names none (`typedef enum {`, a Go
 * `const (`, a bare `Member = iota`):
 *   `class X(...)` whose bases hold the `Enum` or `Choices` word   X
 *   `enum X`, `enum class X`, `enum struct X`                       X
 *   `sealed class X`, `sealed interface X`, `sealed trait X`        X
 *   `type X =`, `X = Literal[`                                      X
 *   a Go `Member X = iota` line                                     X
 * Reads the line's first `LINE_MAX` characters. */
function enumTypeName(line: string): string | undefined {
  const cut = line.slice(0, LINE_MAX);
  const cls = CLASS_NAME_RE.exec(cut);
  if (cls && ENUM_BASE_RE.test(cls[2]!)) return cls[1];
  for (const re of [ENUM_NAME_RE, SEALED_NAME_RE, UNION_NAME_RE, LITERAL_NAME_RE, IOTA_NAME_RE]) {
    const m = re.exec(cut);
    if (m) return m[1];
  }
  return undefined;
}

/** An added line that grows an enumeration which already had members. */
export interface MemberCandidate {
  file: string;
  /** The added line, sign stripped, cut to `LINE_MAX`. */
  text: string;
}

interface HunkLine {
  sign: "+" | "-" | " ";
  /** Sign stripped, cut to `LINE_MAX`. */
  text: string;
}

/** A patch as hunks: each header (cut) and its body lines. Text before the
 * first header belongs to no hunk; an empty line and a `\ No newline` marker
 * are no line of either side. */
function hunksOf(patch: string): { header: string; lines: HunkLine[] }[] {
  const hunks: { header: string; lines: HunkLine[] }[] = [];
  let cur: { header: string; lines: HunkLine[] } | null = null;
  for (const raw of patch.split("\n")) {
    const cut = raw.slice(0, 1 + LINE_MAX);
    if (parseHunkHeader(cut)) {
      cur = { header: cut, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || raw === "" || raw.startsWith("\\")) continue;
    const sign = raw[0] === "+" ? "+" : raw[0] === "-" ? "-" : " ";
    cur.lines.push({ sign, text: cut.slice(1) });
  }
  return hunks;
}

/** What a hunk header says after its second `@@`: the enclosing declaration,
 * in most languages. */
function scopeOf(header: string): string {
  const end = header.indexOf("@@", 2);
  return end < 0 ? "" : header.slice(end + 2);
}

/** Whether a line opens an enumeration's declaration. A member line that
 * only holds the word (`RED = enum.auto()`) opens none and keeps the
 * declaration above it; a bare `X = iota` opens a block that names no type. */
function opensEnum(text: string, member: boolean): boolean {
  if (!declaresEnum(text)) return false;
  const code = codeOf(text);
  return enumTypeName(code) !== undefined || !member || IOTA_RE.test(code);
}

function memberKind(text: string): "union" | "enum" | null {
  if (NOT_MEMBER_RE.test(text)) return null;
  if (UNION_MEMBER_RE.test(text)) return "union";
  if (ENUM_MEMBER_RE.test(text)) return "enum";
  return null;
}

/**
 * Every added line that grows an existing enumeration, in `files` order, then
 * hunk order, then line order. The probe (`member-added`) reads this list.
 *
 * Per hunk of a source-code file:
 *  - a union candidate is an added `| "literal"` line beside a context or
 *    removed line of the same shape. It needs no declaration word;
 *  - an enumeration candidate is an added member line beside a context or
 *    removed member line, in a hunk whose header scope or body declares an
 *    enumeration (`declaresEnum`: a declaration word in a line's code, on a
 *    line that is no comment, attribute or import). A word elsewhere in the
 *    patch does not count: it says nothing about this hunk's lines.
 * A wholly new enumeration or union yields nothing, whatever lines sit beside
 * it in the hunk: every dispatch over it is written in the same change. A
 * declaration is new when its line is added and replaces no removed
 * declaration; a declaration line edited in place (`class Status(Enum)` to
 * `class Status(StrEnum)`) is the old enumeration still.
 *
 * Linear in the patch: each line is classified once, and the declaration a
 * candidate belongs to is carried forward through the hunk, never searched
 * for per candidate.
 */
export function memberCandidates(files: readonly PrFileEntry[]): MemberCandidate[] {
  const out: MemberCandidate[] = [];
  for (const f of files) {
    if (!isSourceCode(f)) continue;
    for (const h of hunksOf(f.patch as string)) {
      const kinds = h.lines.map((l) => memberKind(l.text));
      const declared = declaresEnum(scopeOf(h.header)) || h.lines.some((l) => declaresEnum(l.text));
      const existing = { union: false, enum: false };
      h.lines.forEach((l, i) => {
        const kind = kinds[i];
        if (l.sign !== "+" && kind) existing[kind] = true;
      });
      // The nearest declaration at or above a line, on the head side; the
      // header's scope until the body shows one. `fresh`: that declaration is
      // an added line that replaces none, so its members are new with it.
      // `replaced`: a declaration was removed since the last context line or
      // declaration.
      const enums = { fresh: false };
      const unions = { fresh: false };
      const replaced = { union: false, enum: false };
      h.lines.forEach((l, i) => {
        const opened = opensEnum(l.text, kinds[i] !== null);
        const union = !NOT_DECL_RE.test(l.text) && UNION_NAME_RE.test(codeOf(l.text));
        if (l.sign === "-") {
          if (opened) replaced.enum = true;
          if (union) replaced.union = true;
          return;
        }
        if (opened) enums.fresh = l.sign === "+" && !replaced.enum;
        if (union) unions.fresh = l.sign === "+" && !replaced.union;
        if (opened || l.sign === " ") replaced.enum = false;
        if (union || l.sign === " ") replaced.union = false;
        if (l.sign !== "+") return;
        const kind = kinds[i];
        if (!kind || !existing[kind]) return;
        if (kind === "enum" && (!declared || enums.fresh)) return;
        if (kind === "union" && unions.fresh) return;
        out.push({ file: f.filename, text: l.text });
      });
    }
  }
  return out;
}

/** The `member-added` probe: the first candidate, as a strong hit. */
function memberAddedHit(files: readonly PrFileEntry[]): Hit | null {
  const first = memberCandidates(files)[0];
  if (first === undefined) return null;
  return {
    lens: "pass-sm-exhaustive",
    strength: "strong",
    why: `a member is added to an existing enumeration in ${first.file} (\`${shown(first.text)}\`)`,
    file: first.file,
  };
}

/** A profile's `heuristics.toml` probes for a family lens: strong, since an
 * operator wrote them for this repository. */
function extensionHits(files: readonly PrFileEntry[], ext: HeuristicsExtension): Hit[] {
  const out: Hit[] = [];
  const patched = files.filter((f) => f.patch !== undefined);
  for (const lens of STATE_FAMILY) {
    for (const re of ext.paths[lens] ?? []) {
      const f = files.find((x) => re.test(x.filename));
      if (f)
        out.push({
          lens,
          strength: "strong",
          why: `the profile's path signal matches ${f.filename}`,
          file: f.filename,
        });
    }
    for (const re of ext.addedLines[lens] ?? []) {
      const f = patched.find((x) => re.test(x.patch as string));
      if (f)
        out.push({
          lens,
          strength: "strong",
          why: `the profile's added-line signal matches in ${f.filename}`,
          file: f.filename,
        });
    }
  }
  return out;
}

/**
 * The state-machine-family lenses this PR's content plans, in family order,
 * one entry per lens with the first reason that fired (a strong reason before
 * a weak one) and the files that fired it.
 *
 * `mode`: `off` plans nothing; `strong` reads the strong probes and the
 * profile's probes; `all` adds the weak probes.
 */
export function selectStateLenses(
  files: readonly PrFileEntry[],
  opts: StateSelectionOpts,
): StateSelection[] {
  if (opts.mode === "off") return [];
  const hits: Hit[] = [];
  for (const t of STATE_TRIGGERS) {
    if (t.strength === "weak" && opts.mode !== "all") continue;
    const hit = t.probe === "text" ? textHit(t, opts.intent) : lineHit(files, t);
    if (hit) hits.push(hit);
  }
  const member = memberAddedHit(files);
  if (member) hits.push(member);
  hits.push(...extensionHits(files, opts.extension ?? EMPTY_HEURISTICS));

  const out: StateSelection[] = [];
  for (const lens of STATE_FAMILY) {
    const mine = hits.filter((h) => h.lens === lens);
    if (mine.length === 0) continue;
    const first = mine.find((h) => h.strength === "strong") ?? mine[0]!;
    const named = [...new Set(mine.flatMap((h) => (h.file !== undefined ? [h.file] : [])))];
    out.push({
      lens,
      why: first.why,
      strength: first.strength,
      ...(named.length > 0 ? { files: named } : {}),
    });
  }
  return out;
}
