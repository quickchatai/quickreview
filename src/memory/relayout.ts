// The relayout: sort a store that grew flat into the layout's areas
// (src/memory/layout.ts), once, on the operator's word.
//
// `qcr memory relayout --plan` prints where every entry goes — or that it is
// retired, or that it stays — and `--apply` carries the plan out
// (src/openviking/relayout.ts). Nothing here does I/O: this module is the
// PLAN, a pure function of what one complete read of the store returned, so
// the plan the operator reads is exactly the plan that is applied, and it is
// re-derived from scratch on every run. That is what makes `--apply`
// idempotent: run it twice and the second plan is all `stay` and `skip`.
//
// What it decides, in this order (the first rule that matches wins):
//
//   * Anything in the PINNED area stays, untouched — the owner's standing
//     instructions are off-limits to every automatic edit, this one included
//     (the EOD watchdog would rightly call a change there an anomaly).
//   * A RETIRED entry (a retirement or a move's `#moved` stub) is skipped.
//   * The ONE-OFF CURATION retires, in place, entries known to be noise or
//     wrong: confinement probes, `needs-attention` feedback reviews a later
//     adjudication of the same episode superseded, and the adjudications the
//     curation table names (the concrete-injection-evidence rule contradicts
//     them).
//   * `#pinned` in an entry's HEADER → `preferences/pinned/`; `#manual`
//     (or `source=manual`) → `preferences/`.
//   * The feedback family (`#feedback`, `#feedback-review`, `#adjudication`,
//     `kind=feedback`) → `events/`.
//   * The ops family (`#bug`, `#operations`, `#openviking`, `#review-ops`,
//     `kind=bug|ops`, `area=operations`) → `events/`, its header given
//     `kind=bug` when the HEADER already says it is a defect (`#bug`,
//     `kind=bug` or a `filed=` ticket — a `kind=bug` header is what the TUI's
//     auto-filer files, so only a header may grant it), else `kind=ops`, and
//     `area=operations`. One whose tag LINES alone say bug is written
//     `kind=ops` and flagged for a hand decision.
//   * Everything else stays where it is — lessons and conventions in
//     `experiences/` above all.
//
// WHICH TEXT DECIDES. Placement INTO the pinned area or `preferences/` reads
// the header only (src/memory/eventtags.ts), so no quoted body text can pin an
// entry or make it the owner's words. Placement into `events/` also reads the
// entry's TAG LINES — a line made only of `#tags` / `k=v`, or a trailing
// `Tags: #bug #operations` — because the curator wrote half of the ops notes
// with their tags there, where the header parser never looks. That reader is
// tolerant on purpose, but never inside a fenced block (a quoted reply's
// `#bug` line is somebody else's text), it only ever moves an entry OUT of
// the round's search scope, never into a more trusted place, and it never
// mints a `kind=bug` header.
//
// NEVER A DELETE. A move is a new copy plus a `#retired #moved` stub at the
// old address; a retirement is the `#retired` tag. Every write is a
// batch-write with a hash precondition, one per directory.
import { EVENT_TAG_RE, parseEventTags, parseHashTags } from "./eventtags.js";
import {
  EVENTS_AREA,
  PINNED_AREA,
  PREFERENCES_AREA,
  areaOfId,
  isMovedStub,
  nameOfId,
  withHeaderTags,
  withoutHeaderTag,
} from "./layout.js";
import type { MemoryEntry } from "./store.js";

/** What the relayout does with one entry. */
export type RelayoutAction =
  | { kind: "stay"; id: string; why: string }
  | { kind: "skip"; id: string; why: string }
  | {
      kind: "move";
      id: string;
      to: string;
      /** The bytes the new copy holds (the old text, its header edited when
       * `why` says so). */
      text: string;
      expect: string;
      why: string;
      /** The destination holds a move's stub with this hash; the copy
       * replaces it (an entry moving back where it once was). */
      toExpect?: string;
      /** Said beside the line when it matters to the operator. */
      note?: string;
    }
  | { kind: "retire"; id: string; text: string; expect: string; why: string }
  /** Already in its area, its header missing the kind: fixed in place. */
  | {
      kind: "rewrite";
      id: string;
      text: string;
      expect: string;
      why: string;
      /** Said beside the line when it matters to the operator. */
      note?: string;
    }
  | { kind: "blocked"; id: string; to: string; why: string };

export interface RelayoutPlan {
  actions: RelayoutAction[];
  counts: {
    stay: number;
    skip: number;
    move: number;
    retire: number;
    rewrite: number;
    blocked: number;
  };
  /** Moves per destination area. */
  movesTo: Record<string, number>;
}

/**
 * The one-off curation table: entries that are wrong, not merely
 * misplaced, and are retired in place. Matched on the entry's HEADER tags
 * only — a `#hash` tag plus `k=v` values — never on prose.
 */
export const RELAYOUT_CURATION: ReadonlyArray<{
  hash: string;
  kv: Readonly<Record<string, string>>;
  why: string;
}> = [
  {
    hash: "adjudication",
    kv: { pr: "5359", attribution: "accepted-policy-cost" },
    why:
      "contradicted by the concrete-injection-evidence rule: it records a carve-out as " +
      "rejected policy, and that policy was reversed",
  },
];

/** The curation entry an entry's header matches, if any. */
function curationFor(
  headHash: ReadonlySet<string>,
  headKv: Readonly<Record<string, string>>,
): (typeof RELAYOUT_CURATION)[number] | undefined {
  return RELAYOUT_CURATION.find(
    (c) => headHash.has(c.hash) && Object.entries(c.kv).every(([k, v]) => headKv[k] === v),
  );
}

/** A confinement probe's whole text (scripts/companion-memory-forward.mjs
 * `verify`). */
const PROBE_RE = /^confinement probe [\w:.-]+$/;

const FEEDBACK_HASH = new Set(["feedback", "feedback-review", "adjudication"]);
const OPS_HASH = new Set(["bug", "operations", "openviking", "review-ops"]);

const HASH_TOKEN = /^#([^\s#]+)$/;

/**
 * The tags an entry carries ANYWHERE it states them: its header (the leading
 * run), any line made only of `#tag` / `k=v` tokens, and a `Tags:` line. The
 * relayout's tolerant reader — see the module header for why it exists and
 * why it may decide nothing but a move into `events/`.
 */
export function looseTags(text: string): { hash: Set<string>; kv: Record<string, string> } {
  const hash = new Set(parseHashTags(text));
  const kv: Record<string, string> = { ...parseEventTags(text) };
  // An open fence: its marker character and length (CommonMark: a closing
  // fence is the same character, at least as long).
  let fence: { ch: string; len: number } | null = null;
  for (const raw of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (marker && marker[1]![0] === fence.ch && marker[1]!.length >= fence.len && raw.trim() === marker[1])
        fence = null;
      continue;
    }
    if (marker) {
      fence = { ch: marker[1]![0]!, len: marker[1]!.length };
      continue;
    }
    const line = raw.trim().replace(/^Tags:\s*/i, "");
    if (line === "") continue;
    const tokens = line.split(/\s+/);
    if (!tokens.every((t) => HASH_TOKEN.test(t) || EVENT_TAG_RE.test(t))) continue;
    for (const t of tokens) {
      const h = HASH_TOKEN.exec(t);
      if (h) {
        hash.add(h[1]!.toLowerCase());
        continue;
      }
      const m = EVENT_TAG_RE.exec(t);
      if (m && !(m[1]! in kv)) kv[m[1]!] = m[2]!;
    }
  }
  return { hash, kv };
}

type Decision =
  | { dest: "stay"; why: string }
  | { dest: "retire"; why: string }
  | { dest: string; why: string; text?: string; note?: string };

function decide(e: MemoryEntry, adjudicated: ReadonlySet<string>): Decision {
  const area = areaOfId(e.id);
  if (area === PINNED_AREA) return { dest: "stay", why: "pinned area — never touched" };
  const headHash = new Set(parseHashTags(e.text));
  const headKv = parseEventTags(e.text);

  if (PROBE_RE.test(e.text.trim())) return { dest: "retire", why: "confinement probe" };
  const curated = curationFor(headHash, headKv);
  if (curated) return { dest: "retire", why: curated.why };
  if (
    headHash.has("feedback-review") &&
    headKv["status"] === "needs-attention" &&
    adjudicated.has(`${headKv["pr"] ?? ""}|${headKv["episode"] ?? ""}`)
  )
    return { dest: "retire", why: "needs-attention note superseded by the episode's adjudication" };

  if (headHash.has("pinned")) return { dest: PINNED_AREA, why: "#pinned standing instruction" };
  if (headHash.has("manual") || headKv["source"] === "manual")
    return { dest: PREFERENCES_AREA, why: "the owner's own words (#manual)" };

  const loose = looseTags(e.text);
  if ([...FEEDBACK_HASH].some((t) => headHash.has(t)) || headKv["kind"] === "feedback")
    return { dest: EVENTS_AREA, why: "feedback event" };
  const ops =
    [...OPS_HASH].some((t) => loose.hash.has(t)) ||
    loose.kv["kind"] === "bug" ||
    loose.kv["kind"] === "ops" ||
    loose.kv["area"] === "operations";
  if (ops) {
    // Only the HEADER may make an entry a defect: a `kind=bug` header is what
    // the TUI's auto-filer files (src/tui/memory.ts `isDefect`, header-only
    // for exactly this reason), and a tag line in the body is text.
    const headerDefect =
      headHash.has("bug") || headKv["kind"] === "bug" || headKv["filed"] !== undefined;
    const bodySaysBug =
      loose.hash.has("bug") || loose.kv["kind"] === "bug" || loose.kv["filed"] !== undefined;
    const kind = headerDefect ? "bug" : "ops";
    const text = withHeaderTags(withoutHeaderTag(withoutHeaderTag(e.text, "kind"), "area"), { kind, area: "operations" });
    return {
      dest: EVENTS_AREA,
      why: `ops note (kind=${kind})`,
      ...(text !== e.text.trim() ? { text } : {}),
      ...(!headerDefect && bodySaysBug
        ? {
            note: "its tag lines say bug but its header does not — written kind=ops; make it kind=bug by hand if it is a defect (the TUI's auto-filer then files it)",
          }
        : {}),
    };
  }
  return { dest: "stay", why: area === "" ? "outside the layout — left as it is" : "lesson or note" };
}

/**
 * The plan for one complete read of a store: `entries` (live) and `retired`
 * (retirements and stubs — see `MemorySweep.retired`). Pure and total; the
 * caller refuses to plan over a partial read.
 */
export function planRelayout(input: {
  entries: readonly MemoryEntry[];
  retired: readonly MemoryEntry[];
}): RelayoutPlan {
  const byId = new Map<string, MemoryEntry>();
  for (const e of [...input.entries, ...input.retired]) byId.set(e.id, e);
  // Episodes an adjudication answered — what makes a needs-attention note
  // superseded. Live adjudications only: a retired one answers nothing, and
  // neither does one this plan retires as contradicted.
  const adjudicated = new Set<string>();
  for (const e of input.entries) {
    const hash = new Set(parseHashTags(e.text));
    if (!hash.has("adjudication")) continue;
    const kv = parseEventTags(e.text);
    if (curationFor(hash, kv)) continue;
    if (kv["pr"] && kv["episode"]) adjudicated.add(`${kv["pr"]}|${kv["episode"]}`);
  }
  const actions: RelayoutAction[] = [];
  for (const e of input.retired)
    actions.push({ kind: "skip", id: e.id, why: "already retired (or a moved stub)" });
  const claimed = new Set<string>();
  for (const e of input.entries) {
    const d = decide(e, adjudicated);
    if (d.dest === "stay") {
      actions.push({ kind: "stay", id: e.id, why: d.why });
      continue;
    }
    if (d.dest === "retire") {
      actions.push({
        kind: "retire",
        id: e.id,
        text: `#retired ${e.text.trim()}`,
        expect: e.hash,
        why: d.why,
      });
      continue;
    }
    const text = "text" in d && d.text !== undefined ? d.text : e.text.trim();
    if (areaOfId(e.id) === d.dest) {
      if (text === e.text.trim()) actions.push({ kind: "stay", id: e.id, why: d.why });
      // Already in its area but its header is missing the kind: rewritten in
      // place (a `move` onto itself would be refused as a self-collision).
      else
        actions.push({
          kind: "rewrite",
          id: e.id,
          text,
          expect: e.hash,
          why: d.why,
          ...("note" in d && d.note ? { note: d.note } : {}),
        });
      continue;
    }
    const to = `${d.dest}/${nameOfId(e.id)}`;
    const there = byId.get(to);
    const stub = there !== undefined && isMovedStub(there.text);
    if ((there && !stub && there.text.trim() !== text) || claimed.has(to)) {
      actions.push({
        kind: "blocked",
        id: e.id,
        to,
        why: `${to} already holds another entry — moved nowhere; resolve it by hand`,
      });
      continue;
    }
    claimed.add(to);
    actions.push({
      kind: "move",
      id: e.id,
      to,
      text,
      expect: e.hash,
      why: d.why,
      ...(stub && there ? { toExpect: there.hash } : {}),
      ...("note" in d && d.note ? { note: d.note } : {}),
    });
  }
  const counts = { stay: 0, skip: 0, move: 0, retire: 0, rewrite: 0, blocked: 0 };
  const movesTo: Record<string, number> = {};
  for (const a of actions) {
    counts[a.kind] += 1;
    if (a.kind === "move") {
      const area = areaOfId(a.to);
      movesTo[area] = (movesTo[area] ?? 0) + 1;
    }
  }
  return { actions, counts, movesTo };
}
