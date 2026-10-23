// Duplicate merge (docs/duplicate-merge.md): one comment per root cause.
//
// Two deterministic halves, both pure and both on the code path the live
// round and the benchmark share:
//
//   * `clusterFindings` — the candidate groups a round's validator judges as
//     units. Called by the `cluster_findings` pi tool
//     (extensions/finding-clusters.ts), which the daemon's PR sessions and the
//     bench session both load. Two candidates join a group when ANY one signal
//     holds: the same file with anchors within CLOSE_LINES, a
//     shared named identifier, or the same fix target. "Same consequence" has
//     no deterministic signal: the validator judges it inside a group, so two
//     findings that share no signal are never shown to it as one.
//
//   * `postCheckRecord` — the leftovers after the validator. Run by
//     `renderPostedReview` (src/reviewrender.ts), which both the live render
//     route (scripts/render-review.sh) and the bench runner call: two POSTED
//     findings in the same file whose anchors overlap (±POST_CHECK_LINES, on
//     the same diff side),
//     that share a named identifier and that the validator judged in
//     DIFFERENT groups are one root cause posted twice. Findings it judged in
//     one group, or that carry no group, are never merged here — not through
//     a chain of merges either: the validator's split stands. The
//     higher severity leads; the follower is recorded `merged` (word
//     `post-check`, `merged_into` the lead) and its site is listed in the
//     lead's body. Nothing is deleted: the record keeps every entry.

import {
  entryDisposition,
  findingRecordKey,
  normalizeDisposition,
  recordNumber,
  recordSide,
  recordString,
} from "./findingkey.js";
import { codePath } from "./codespan.js";
import { bareTag, ordinaryPostTag } from "./severity.js";
import { severityRank } from "./severityrank.js";

/** Anchors this many lines apart (or fewer), in one file, form a group. */
export const CLOSE_LINES = 10;
/** Posted anchors this many lines apart (or fewer) count as overlapping. */
export const POST_CHECK_LINES = 3;

export interface ClusterCandidate {
  id: string;
  path?: string | null;
  line?: number | null;
  title?: string | null;
  body?: string | null;
  lens?: string | null;
  severity?: string | null;
  /** `path:line` or a symbol the fix would change, when the lens names one. */
  fix_target?: string | null;
}

/** The signals a group can carry, in the order a group lists them. */
const CLUSTER_SIGNALS = ["close-lines", "shared-identifier", "same-fix-target"] as const;
export type ClusterSignal = (typeof CLUSTER_SIGNALS)[number];

export interface FindingGroup {
  /** Stable: `G<n>` in the order of each group's first member. */
  group: string;
  members: string[];
  /** Why the members were put together (each pair's first matching signal). */
  signals: ClusterSignal[];
  /** The identifiers the members share, when that joined them. */
  identifiers: string[];
}

export interface ClusterResult {
  groups: FindingGroup[];
  /** Candidates no signal joined to any other. */
  singletons: string[];
}

/** Words that sit in code spans but name nothing specific. */
const STOP = new Set([
  "true",
  "false",
  "null",
  "none",
  "nil",
  "undefined",
  "self",
  "this",
  "that",
  "return",
  "returns",
  "const",
  "let",
  "var",
  "def",
  "function",
  "class",
  "async",
  "await",
  "new",
  "await",
  "import",
  "export",
  "default",
  "public",
  "private",
  "static",
  "string",
  "number",
  "boolean",
  "int",
  "str",
  "bool",
  "list",
  "dict",
  "map",
  "set",
  "get",
  "put",
  "post",
  "delete",
  "error",
  "errors",
  "value",
  "values",
  "data",
  "id",
  "ids",
  "key",
  "keys",
  "name",
  "type",
  "types",
  "test",
  "tests",
  "file",
  "path",
  "line",
  "lines",
  "the",
  "and",
  "for",
  "not",
  "with",
  "from",
  "into",
  "when",
  "then",
  "else",
  "elif",
  "while",
  "try",
  "catch",
  "except",
  "finally",
  "throw",
  "raise",
  "yield",
  "pass",
  "break",
  "continue",
  "case",
  "switch",
  "match",
  "object",
  "array",
  "result",
  "results",
  "item",
  "items",
  "index",
  "args",
  "kwargs",
  "options",
  "opts",
  "config",
  "props",
  "state",
  "req",
  "res",
]);
const FILE_LIKE =
  /[\\/]|\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|rs|c|cc|cpp|h|hpp|cs|php|swift|scala|json|ya?ml|toml|md|css|scss|html|sql|sh)$/i;

/** Mixed-case product words that look like identifiers but name nothing in
 * the code. */
const PROSE_CAMEL = new Set([
  "javascript",
  "typescript",
  "github",
  "gitlab",
  "postgresql",
  "mysql",
  "mongodb",
  "macos",
  "ios",
  "iphone",
  "ipad",
  "openapi",
  "graphql",
  "nodejs",
  "devops",
  "youtube",
  "linkedin",
  "wordpress",
]);
/** An identifier written without backticks (lenses rarely backtick names, so
 * code spans alone would leave the shared-identifier signal silent):
 * camelCase or PascalCase with an inner capital, snake_case,
 * SCREAMING_CASE, or a name called as `name(` / reached as `a.b`. */
const BARE_IDENT_RE =
  /\b(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Za-z_$][A-Za-z0-9_$]*(?=\()|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\b/g;

/** A qualified token and each of its `.` / `::` parts, kept when long enough
 * and not a stop word — the baseline both the prose and the code-span reading
 * admit by. */
function qualifiedParts(tok: string): string[] {
  return [tok, ...tok.split(/\.|::/)].filter(
    (part) => part.length >= 3 && !STOP.has(part.toLowerCase()),
  );
}

/** A backtick code span on one line; group 1 is its content. */
const CODE_SPAN_RE = /`([^`\n]{1,200})`/;

/** The named identifiers a finding's title and body name — in code spans,
 * and bare in the prose. */
export function identifiersOf(text: string): Set<string> {
  const out = new Set<string>();
  const prose = text.replace(new RegExp(CODE_SPAN_RE, "g"), " ");
  for (const t of prose.matchAll(BARE_IDENT_RE)) {
    const tok = t[0];
    if (FILE_LIKE.test(tok)) continue;
    for (const part of qualifiedParts(tok)) {
      if (PROSE_CAMEL.has(part.toLowerCase())) continue;
      // A plain English word reached only through `word(` or `a.b` (e.g. "i.e") is not an identifier.
      if (/^[a-z]+$/.test(part) && part.length < 4) continue;
      out.add(part);
    }
  }
  for (const m of text.matchAll(new RegExp(CODE_SPAN_RE, "g"))) {
    const span = m[1]!;
    if (FILE_LIKE.test(span.trim()) && !/\s/.test(span.trim())) continue;
    for (const t of span.matchAll(
      /[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)*/g,
    )) {
      for (const part of qualifiedParts(t[0])) out.add(part);
    }
  }
  return out;
}

function normFixTarget(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().replace(/^`|`$/g, "");
  return s ? s.toLowerCase() : null;
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a === b;
}

/** The candidate groups a validator judges as units (any one signal joins
 * two candidates; union-find, so groups are transitive). */
export function clusterFindings(candidates: readonly ClusterCandidate[]): ClusterResult {
  const n = candidates.length;
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const ids = candidates.map((c) => identifiersOf(`${c.title ?? ""}\n${c.body ?? ""}`));
  const fix = candidates.map((c) => normFixTarget(c.fix_target));
  const pairSignals = new Map<number, Set<ClusterSignal>>();
  const shared = new Map<number, Set<string>>();
  const note = (i: number, j: number, s: ClusterSignal, idents: string[] = []) => {
    union(i, j);
    for (const k of [i, j]) {
      const set = pairSignals.get(k) ?? new Set<ClusterSignal>();
      set.add(s);
      pairSignals.set(k, set);
      if (idents.length) {
        const si = shared.get(k) ?? new Set<string>();
        for (const x of idents) si.add(x);
        shared.set(k, si);
      }
    }
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (
        samePath(a.path, b.path) &&
        typeof a.line === "number" &&
        typeof b.line === "number" &&
        Math.abs(a.line - b.line) <= CLOSE_LINES
      ) {
        note(i, j, "close-lines");
        continue;
      }
      const common = [...ids[i]!].filter((x) => ids[j]!.has(x));
      if (common.length) {
        note(i, j, "shared-identifier", common);
        continue;
      }
      if (fix[i] && fix[i] === fix[j]) note(i, j, "same-fix-target");
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    byRoot.set(r, [...(byRoot.get(r) ?? []), i]);
  }
  const groups: FindingGroup[] = [];
  const singletons: string[] = [];
  for (const members of [...byRoot.values()].sort((x, y) => x[0]! - y[0]!)) {
    if (members.length === 1) {
      singletons.push(candidates[members[0]!]!.id);
      continue;
    }
    const sig = new Set<ClusterSignal>();
    const idents = new Set<string>();
    for (const m of members) {
      for (const s of pairSignals.get(m) ?? []) sig.add(s);
      for (const x of shared.get(m) ?? []) idents.add(x);
    }
    groups.push({
      group: `G${groups.length + 1}`,
      members: members.map((m) => candidates[m]!.id),
      signals: CLUSTER_SIGNALS.filter((s) => sig.has(s)),
      identifiers: [...idents].sort(),
    });
  }
  return { groups, singletons };
}

/** The tool's answer, as the validator task string carries it. */
export function renderGroups(
  result: ClusterResult,
  byId: ReadonlyMap<string, ClusterCandidate>,
): string {
  if (!result.groups.length) return "No candidate groups: every candidate stands alone.";
  const L: string[] = [];
  for (const g of result.groups) {
    const why = [
      ...g.signals,
      ...(g.identifiers.length ? [`identifiers: ${g.identifiers.slice(0, 8).join(", ")}`] : []),
    ].join("; ");
    L.push(`- **${g.group}** (${why})`);
    for (const id of g.members) {
      const c = byId.get(id);
      const at = c?.path
        ? ` ${codePath(`${c.path}${typeof c.line === "number" ? `:${c.line}` : ""}`)}`
        : "";
      L.push(
        `  - ${id}${at} [${c?.severity ?? "?"}] ${c?.lens ?? "?"} — ${(c?.title ?? "").slice(0, 160)}`,
      );
    }
  }
  if (result.singletons.length) L.push(`- Alone: ${result.singletons.join(", ")}`);
  return L.join("\n");
}

// ---- the post-check over a findings record ---------------------------------

const TAG_RANK: Record<string, number> = { blocker: 0, question: 1, nit: 2 };

function s(v: unknown): string {
  return recordString(v) ?? "";
}
/** Ranked by the ORDINARY tag the entry posts under (`ordinaryPostTag`), so
 * an `[ask your human]` or `[deferred]` P1 ranks as the blocker it is. */
function rank(e: Record<string, unknown>): number {
  const confidence = recordNumber(e.confidence);
  const tag = ordinaryPostTag(
    bareTag(s(e.posted_as)),
    s(e.severity) || null,
    confidence,
    s(e.reachability) || null,
  );
  return (TAG_RANK[tag ?? ""] ?? 3) * 10 + (severityRank(s(e.severity)) ?? 5);
}

/** Both findings carry a validator group and the groups differ: the
 * validator never compared them, so a post-check merge cannot overrule it. */
export function distinctGroups(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ga = s(a.group);
  const gb = s(b.group);
  return !!ga && !!gb && ga !== gb;
}

export interface PostCheckMerge {
  follower: string;
  lead: string;
  path: string;
  line: number;
}

/**
 * The deterministic post-check: over the record's POSTED
 * entries, two in the same file whose anchors are within POST_CHECK_LINES on
 * the same diff side, that share a named identifier and that speak for
 * disjoint validator groups are one root cause posted twice. Returns a
 * NEW record (the input is not mutated) where each follower is `merged`
 * (word `post-check`, `merged_into` the lead, `withheld_as` its old tag) and
 * the lead's body names the follower's site. A follower row the session
 * already linked (`same_as`) is left alone. Order of entries is preserved.
 */
export function postCheckRecord(record: unknown): { record: unknown; merges: PostCheckMerge[] } {
  if (typeof record !== "object" || record === null) return { record, merges: [] };
  const rec = record as Record<string, unknown>;
  if (!Array.isArray(rec.findings)) return { record, merges: [] };
  const entries = (rec.findings as unknown[]).map((e) =>
    typeof e === "object" && e !== null ? { ...(e as Record<string, unknown>) } : e,
  );
  const posted = entries
    .map((e, i) => ({ e, i }))
    .filter(
      (x): x is { e: Record<string, unknown>; i: number } =>
        typeof x.e === "object" &&
        x.e !== null &&
        entryDisposition(x.e as Record<string, unknown>) === "posted" &&
        !s((x.e as Record<string, unknown>).same_as) &&
        !!s((x.e as Record<string, unknown>).path) &&
        recordNumber((x.e as Record<string, unknown>).line) !== null,
    );
  const ids = posted.map((x) => identifiersOf(`${s(x.e.title)}\n${s(x.e.body)}\n${s(x.e.reason)}`));
  const gone = new Set<number>();
  // Lines each posted entry carries as a lead: its own, then every follower's
  // (and that follower's own absorbed lines) — so a lead later merged into a
  // stronger one hands all of them on, and the surviving comment names every site.
  const sites = posted.map((x) => [recordNumber(x.e.line)!]);
  // The validator groups each posted entry speaks for: its own, then every
  // absorbed follower's — so a chain of merges never fuses two findings the
  // validator judged in one group and kept apart.
  const groupsOf = posted.map((x) => (s(x.e.group) ? [s(x.e.group)] : []));
  // A record rendered before already holds merged followers: each one's group
  // stays with the posted entry its `merged_into` chain ends at, so a second
  // render protects the same splits the first did.
  const keys = entries.map((e, i) =>
    typeof e === "object" && e !== null ? findingRecordKey(e as Record<string, unknown>, i) : "",
  );
  const postedAt = new Map(posted.map((x, p) => [keys[x.i]!, p]));
  const byKey = new Map(
    entries.flatMap((e, i) =>
      typeof e === "object" && e !== null ? [[keys[i]!, e as Record<string, unknown>]] : [],
    ),
  );
  for (const e of byKey.values()) {
    if (normalizeDisposition(e.disposition) !== "merged") continue;
    let into = s(e.merged_into);
    for (let hops = 0; into && !postedAt.has(into) && hops < entries.length; hops++) {
      const next = byKey.get(into);
      into = next && normalizeDisposition(next.disposition) === "merged" ? s(next.merged_into) : "";
    }
    const at = postedAt.get(into);
    if (at === undefined) continue;
    if (s(e.group) && !groupsOf[at]!.includes(s(e.group))) groupsOf[at]!.push(s(e.group));
    // Its site rides with the lead too, so a later merge names it on the survivor.
    const line = recordNumber(e.line);
    if (line !== null && s(e.path) === s(posted[at]!.e.path) && !sites[at]!.includes(line))
      sites[at]!.push(line);
  }
  const merges: PostCheckMerge[] = [];
  for (let a = 0; a < posted.length; a++) {
    if (gone.has(a)) continue;
    for (let b = a + 1; b < posted.length; b++) {
      if (gone.has(b) || gone.has(a)) continue;
      const A = posted[a]!.e;
      const B = posted[b]!.e;
      if (s(A.path) !== s(B.path)) continue;
      // LEFT lines number the base file, RIGHT lines the head: never compared.
      if (recordSide(A.side) !== recordSide(B.side)) continue;
      if (Math.abs(recordNumber(A.line)! - recordNumber(B.line)!) > POST_CHECK_LINES) continue;
      if (![...ids[a]!].some((x) => ids[b]!.has(x))) continue;
      // Never undo the validator: two posted findings it judged in one group
      // were kept distinct on purpose, and two with no group recorded cannot
      // be told apart from that — so the post-check merges only survivors of
      // different recorded groups, the leftovers the validator never compared.
      if (!distinctGroups(A, B)) continue;
      if (groupsOf[a]!.some((g) => groupsOf[b]!.includes(g))) continue;
      // The lower `rank` leads (ordinary posting tag first, then severity); equal → the earlier entry.
      const [lead, fol, folIdx] = rank(B) < rank(A) ? [B, A, a] : [A, B, b];
      const leadIdx = folIdx === a ? b : a;
      gone.add(folIdx);
      const leadId = keys[posted[leadIdx]!.i]!;
      const folId = keys[posted[folIdx]!.i]!;
      fol.withheld_as = fol.posted_as;
      delete fol.posted_as;
      fol.disposition = "merged";
      fol.word = "post-check";
      fol.merged_into = leadId;
      for (const entry of byKey.values()) if (s(entry.same_as) === folId) entry.same_as = leadId;
      fol.reason =
        `Merged by the post-check into ${leadId}: same file, anchors within ${POST_CHECK_LINES} lines, a shared identifier. ${s(fol.reason)}`.trim();
      const folLine = recordNumber(fol.line)!;
      const leadLine = recordNumber(lead.line)!;
      for (const line of sites[folIdx]!) {
        if (line === leadLine || sites[leadIdx]!.includes(line)) continue;
        sites[leadIdx]!.push(line);
        const site = codePath(`${s(fol.path)}:${line}`);
        // The comment's body, or the reason the renderer posts in its place.
        const body = s(lead.body) || s(lead.reason);
        if (body && !body.includes(site)) lead.body = `${body}\n\nAlso at ${site}.`;
      }
      for (const g of groupsOf[folIdx]!)
        if (!groupsOf[leadIdx]!.includes(g)) groupsOf[leadIdx]!.push(g);
      merges.push({ follower: folId, lead: leadId, path: s(fol.path), line: folLine });
    }
  }
  if (!merges.length) return { record, merges };
  const next: Record<string, unknown> = { ...rec, findings: entries };
  if (typeof rec.comments_posted === "number")
    next.comments_posted = Math.max(0, rec.comments_posted - merges.length);
  return { record: next, merges };
}
