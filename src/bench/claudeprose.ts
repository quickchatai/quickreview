// Claude Code's `/code-review` prose, read into findings — pure, no imports.
//
// Why this exists. In Claude Code 2.1.283 `/code-review` is a built-in LOCAL
// command (`"local_command": "code_review"`, `num_turns: 0`): it runs its own
// review and never sees the AACR harness's `--append-system-prompt` findings
// requirement or its findings MCP tool. So the harness's `save_result` finds
// no structured findings and stores the review as RAW TEXT in
// `review_output`, which its Claude reader scores as zero comments. The review
// itself is fine — it just says its findings in markdown. This module reads
// them back out, deterministically, from the stored text: no model, no
// re-review.
//
// What counts as a finding (every rule below was read off the 150 real
// outputs of the Claude Code arm; tests/fixtures/claude-prose/ holds the
// golden set):
//   - a TOP-LEVEL list item (`- `, `* `, `+ `, `1. `, `1) `; indent 0–1)
//     whose FIRST LINE carries a location `path:LINE` or `path:A-B` — in a
//     code span, in bold, after a bold title, or bare. The item's first
//     location is its location; later ones (`(and line 352)`, `same bug at
//     x.c:12`) are body text. The finding's text is the whole item: its title,
//     its body, its nested bullets, markdown kept;
//   - an item whose first line starts `Line N` / `Lines A-B` under a lead-in
//     that names exactly ONE file (`…both in \`src/x.c\`:`) — that file;
//   - a PARAGRAPH whose first line STARTS with a location
//     (`pkg/a.ts:372 — ACP mode …`); it takes the list that follows it with
//     no blank line, when none of that list's items has a location of its own.
// What does not:
//   - items with a file but no line (`- **\`src/a.cpp\`:** …`) — no line, no
//     location (counted as `unlocated`);
//   - items under a lead-in that says they are NOT findings: "What I checked:",
//     "chose not to report:", "neither is a bug:", "they are fine:" — or under
//     a neutral lead-in in a review that opens "I found no bugs" (a lead-in
//     that counts issues, "only two low-severity issues:", wins over "no bugs");
//   - a RECAP: a later list whose every located item repeats a location already
//     found ("Summary:" lists, a bare re-listing of numbered findings).
// Two findings at the same location in ONE list both count: that is how the
// reviews report two distinct bugs on one line.

export interface ProseFinding {
  /** The path the harness will match: the PR's changed file it resolved to, or
   * the path as written (normalised) when it resolved to none. */
  path: string;
  /** The path exactly as the review wrote it. */
  written: string;
  start_line: number;
  end_line: number;
  /** The whole item (or paragraph), markdown kept. */
  text: string;
  /** Did the path resolve to a changed file? null: no changed-file list given. */
  matched: boolean | null;
}

export interface ProseParse {
  findings: ProseFinding[];
  /** Items/paragraphs set aside, by reason. */
  skipped: {
    /** Located items under a "not a finding" lead-in. */
    non_finding: number;
    /** Located items of a list that only repeats earlier locations. */
    recap: number;
    /** Items with no location in their first line, under a findings lead-in. */
    unlocated: number;
  };
}

/** Bump when the rules change: the rebuilt result files record it. */
export const PROSE_PARSER_VERSION = 1;

// ---- locations ---------------------------------------------------------------------

// A path: segments of [\w.@+~-] joined by "/", optionally led by "/", "./" or
// "../". It must name a FILE: a "/" in it, or an extension (a letter after the
// last "."), so `10:00`, `v1.2:3` and `x:1` are not paths. Then `:LINE`, an
// optional `-END` / `–END` range, an optional `:COL`.
const LOC_RE =
  /(?<![\w/.:@~+-])((?:\.{1,2}\/|\/)?[\w.@+~-]+(?:\/[\w.@+~-]+)*):(\d+)(?:\s?[-–]\s?:?(\d+))?(?::\d+)?(?![\w/])/g;

function isFileLike(p: string): boolean {
  if (p.includes("://")) return false;
  const last = p.split("/").pop() ?? "";
  if (!last || /^\.+$/.test(last)) return false;
  return p.includes("/") || /\.[A-Za-z][A-Za-z0-9_+-]*$/.test(last);
}

interface Loc {
  written: string;
  start: number;
  end: number;
  index: number;
}

/** Every location in `s`, in order. */
export function findLocations(s: string): Loc[] {
  const out: Loc[] = [];
  for (const m of s.matchAll(LOC_RE)) {
    const written = m[1]!;
    if (!isFileLike(written)) continue;
    const a = Number(m[2]);
    const b = m[3] !== undefined ? Number(m[3]) : a;
    if (!Number.isSafeInteger(a) || a < 1) continue;
    out.push({ written, start: Math.min(a, b), end: Math.max(a, b), index: m.index ?? 0 });
  }
  return out;
}

/** A single file named in a lead-in (`both in \`src/gpu/x.c\`:`), for items
 * that say only `Line N`. Undefined when it names none or several. */
function soleFile(s: string): string | undefined {
  const seen = new Set<string>();
  for (const m of s.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1]!.replace(/[:.,;]+$/, "");
    if (isFileLike(p) && !/:\d+$/.test(p)) seen.add(p);
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

// ---- paths ---------------------------------------------------------------------------

/** The review's path, as the harness should see it: the sandbox's absolute
 * checkout prefix (`/work/repo/<owner>__<name>/`) and a leading `./` gone. */
export function normalisePath(written: string): string {
  let p = written.trim();
  p = p.replace(/^\/work\/repo\/[^/]+\//, "");
  p = p.replace(/^(\.\/)+/, "");
  return p;
}

/** Resolve a written path to one of the PR's changed files: exact, then with
 * a git `a/`/`b/` prefix dropped, then a UNIQUE suffix match either way (the
 * review wrote `mongo.go`, or an absolute path under an unknown root). An
 * ambiguous or absent match keeps the normalised path, unmatched. */
export function resolvePath(
  written: string,
  changed: readonly string[] | null | undefined,
): { path: string; matched: boolean | null } {
  const p = normalisePath(written);
  if (!changed) return { path: p, matched: null };
  const set = new Set(changed);
  const candidates = [p];
  if (/^[ab]\//.test(p)) candidates.push(p.slice(2));
  const bare = p.replace(/^\/+/, "");
  if (bare !== p) candidates.push(bare);
  for (const c of candidates) if (set.has(c)) return { path: c, matched: true };
  for (const c of candidates) {
    const tail = changed.filter((f) => f.endsWith("/" + c));
    if (tail.length === 1) return { path: tail[0]!, matched: true };
    const head = changed.filter((f) => c.endsWith("/" + f));
    if (head.length === 1) return { path: head[0]!, matched: true };
  }
  return { path: p, matched: false };
}

// ---- lead-ins --------------------------------------------------------------------------

// "These are NOT findings": explicit non-reporting or not-a-bug wording.
const STRONG_NEG =
  /\b(?:didn'?t|did not|not|never|won'?t|chose not to)\s+(?:to\s+)?(?:report|count|flag|list|include)\w*|\bnot reported\b|\bleft\s+(?:\w+\s+)?out\b|\bnot\s+(?:a\s+|real\s+|actual\s+|runtime\s+)?(?:bugs?|problems?|issues?|regressions?|findings?)\b|\b(?:aren'?t|isn'?t|are not|is not)\s+(?:a\s+|real\s+)?(?:bugs?|problems?)\b|\bneither\b[^.:]*\b(?:bugs?|problems?)\b|\bnon-?bugs?\b|\bturned out fine\b|\b(?:to fix (?:it|this|them|both|all \w+)|(?:suggested|possible|proposed|the) fix(?:es)?|fix(?:es)?|how to fix(?: it)?)\s*:\W*$/i;
// "These ARE findings": a count of issues ("found 4 likely bugs", "two
// low-severity issues", "one real problem"), or a bare "Findings:" heading.
const POS =
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|a few|some|these|the following)\s+(?:[\w-]+\s+){0,3}?(?:issues?|bugs?|problems?|findings?|regressions?|defects?|errors?|mistakes?|leaks?|concerns?)\b|^\W*(?:findings?|issues|bugs|problems)\W*$/i;
// "These are what I looked at": weaker, overridden by a count.
const WEAK_NEG =
  /\bno\s+(?:real\s+|correctness\s+|runtime\s+|actual\s+|other\s+)?(?:bugs?|issues?|problems?|findings?)\b|\bfound nothing\b|\bnothing\s+(?:else\s+)?(?:wrong|to (?:report|list))\b|\bnothing else\b[^.]*\b(?:wrong|bugs?|problems?)\b|\bwhat I checked\b|\bI (?:also )?checked\b|\bchecked out\b|\b(?:looks?|looked|are|is|seem|seems)\s+(?:correct|fine|right|good)\b|\bwhat (?:the diff|the change|it|changed) does\b/i;

type Verdict = "findings" | "not-findings" | null;

function judge(s: string): Verdict {
  if (STRONG_NEG.test(s)) return "not-findings";
  if (POS.test(s)) return "findings";
  if (WEAK_NEG.test(s)) return "not-findings";
  return null;
}

function lastSentence(p: string): string {
  const flat = p.replace(/\s+/g, " ").trim();
  const parts = flat.split(/(?<=[.!?])\s+(?=[A-Z*`_(])/);
  return parts[parts.length - 1] ?? flat;
}

/** Is the list after this lead-in a list of findings? A lead-in whose last
 * sentence introduces the list ("…chose not to report:") decides by that
 * sentence; otherwise, or if it says nothing, the whole paragraph (a count of
 * issues wins); then the review's opening paragraph; else it is (a list with
 * no lead-in is too). */
export function leadInSaysFindings(leadIn: string | null, opening: string | null): boolean {
  const steps: Array<() => Verdict> = [];
  if (leadIn !== null) {
    const last = lastSentence(leadIn);
    if (/:\W*$/.test(last)) steps.push(() => judge(last));
    steps.push(() => {
      const flat = leadIn.replace(/\s+/g, " ");
      if (POS.test(flat)) return "findings";
      if (STRONG_NEG.test(flat) || WEAK_NEG.test(flat)) return "not-findings";
      return null;
    });
  }
  if (opening !== null && opening !== leadIn) {
    steps.push(() => {
      const flat = opening.replace(/\s+/g, " ");
      if (POS.test(flat)) return "findings";
      if (WEAK_NEG.test(flat) || STRONG_NEG.test(flat)) return "not-findings";
      return null;
    });
  }
  for (const s of steps) {
    const v = s();
    if (v) return v === "findings";
  }
  return true;
}

// ---- blocks ----------------------------------------------------------------------------

const ITEM_RE = /^ ?(?:([-*+])|(\d{1,3})[.)])\s+/;

interface Block {
  kind: "item" | "para";
  lines: string[];
  /** A blank line came before it. */
  afterBlank: boolean;
  /** Items: "bullet" | "ordered" — a change of kind starts a new list. */
  marker?: "bullet" | "ordered";
  /** Items: the list group they belong to. */
  group?: number;
}

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  let blank = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const m = ITEM_RE.exec(line);
    if (m) {
      cur = { kind: "item", lines: [line], afterBlank: blank, marker: m[1] ? "bullet" : "ordered" };
      out.push(cur);
    } else if (cur && (/^\s{2,}/.test(line) || !blank)) {
      // an indented line continues whatever is open (nested bullets, loose
      // item bodies); so does a lazy continuation with no blank line before it
      cur.lines.push(line);
    } else {
      cur = { kind: "para", lines: [line], afterBlank: blank };
      out.push(cur);
    }
    blank = false;
  }
  // list groups: consecutive items of one marker kind
  let g = -1;
  let prev: Block | null = null;
  for (const b of out) {
    if (b.kind === "item") {
      if (!prev || prev.kind !== "item" || prev.marker !== b.marker) g++;
      b.group = g;
    }
    prev = b;
  }
  return out;
}

const text = (b: Block): string => b.lines.join("\n").trim();
const firstLine = (b: Block): string => b.lines[0]!.replace(ITEM_RE, "");

/** A paragraph that OPENS with a location (after `**`, `` ` ``, `_`). */
function paragraphLocation(first: string): Loc | undefined {
  const lead = /^[\s*_`]*/.exec(first)![0].length;
  const loc = findLocations(first)[0];
  return loc && loc.index <= lead ? loc : undefined;
}

// ---- the parser ------------------------------------------------------------------------

interface Candidate {
  written: string;
  start: number;
  end: number;
  text: string;
  /** The list group it came from; null for a paragraph finding. */
  group: number | null;
}

export function parseClaudeProse(
  review: string,
  changedFiles?: readonly string[] | null,
): ProseParse {
  const bs = blocks(review);
  const skipped = { non_finding: 0, recap: 0, unlocated: 0 };
  const opening = bs[0]?.kind === "para" ? text(bs[0]) : null;
  const cands: Candidate[] = [];
  let leadIn: string | null = null;
  let i = 0;
  while (i < bs.length) {
    const b = bs[i]!;
    if (b.kind === "para") {
      const t = text(b);
      const loc = paragraphLocation(b.lines[0]!);
      i++;
      if (loc && !STRONG_NEG.test(t)) {
        const cand: Candidate = { written: loc.written, start: loc.start, end: loc.end, text: t, group: null };
        cands.push(cand);
        // the list right under it (no blank line), when it has no locations of
        // its own, is its body: "- **Cause:** … - **Effect:** …"
        const next = bs[i];
        if (next?.kind === "item" && !next.afterBlank) {
          const members: Block[] = [];
          for (let k = i; k < bs.length && bs[k]!.kind === "item" && bs[k]!.group === next.group; k++)
            members.push(bs[k]!);
          if (members.every((x) => !findLocations(firstLine(x))[0])) {
            cand.text = [t, ...members.map(text)].join("\n");
            i += members.length;
          }
        }
      }
      leadIn = t;
      continue;
    }
    // one list group
    const g = b.group!;
    const members: Block[] = [];
    while (i < bs.length && bs[i]!.kind === "item" && bs[i]!.group === g) members.push(bs[i++]!);
    const isFindings = leadInSaysFindings(leadIn, opening);
    for (const m of members) {
      const first = firstLine(m);
      const loc = findLocations(first)[0];
      const itemText = [first, ...m.lines.slice(1)].join("\n").trim();
      if (!isFindings) {
        if (loc) skipped.non_finding++;
        continue;
      }
      if (loc) {
        cands.push({ written: loc.written, start: loc.start, end: loc.end, text: itemText, group: g });
        continue;
      }
      // `1. **Line 10533 — …**` under "both in `src/gpu/x.c`:"
      const lineOnly = /^[\s*_]*Lines?\s+(\d+)(?:\s*[-–]\s*(\d+))?\b/.exec(first);
      const file = lineOnly && leadIn !== null ? soleFile(leadIn) : undefined;
      if (lineOnly && file) {
        const a = Number(lineOnly[1]);
        const e = lineOnly[2] ? Number(lineOnly[2]) : a;
        cands.push({ written: file, start: Math.min(a, e), end: Math.max(a, e), text: itemText, group: g });
        continue;
      }
      skipped.unlocated++;
    }
  }

  // A recap list (every located item repeats a location already found) is
  // dropped; two findings at one location inside ONE list both stay.
  const resolved = cands.map((c) => ({ c, r: resolvePath(c.written, changedFiles) }));
  const key = (x: (typeof resolved)[number]) => `${x.r.path}:${x.c.start}-${x.c.end}`;
  const seen = new Set<string>();
  const findings: ProseFinding[] = [];
  const emit = (x: (typeof resolved)[number]) => {
    seen.add(key(x));
    findings.push({
      path: x.r.path,
      written: x.c.written,
      start_line: x.c.start,
      end_line: x.c.end,
      text: x.c.text,
      matched: x.r.matched,
    });
  };
  const done = new Set<number>();
  for (const x of resolved) {
    if (x.c.group === null) {
      emit(x);
      continue;
    }
    if (done.has(x.c.group)) continue;
    done.add(x.c.group);
    const members = resolved.filter((y) => y.c.group === x.c.group);
    if (members.every((y) => seen.has(key(y)))) {
      skipped.recap += members.length;
      continue;
    }
    members.forEach(emit);
  }
  return { findings, skipped };
}
