// A posted finding's identity, shared by the two ends that must agree on it
// for outcome capture: the findings-record PARSER, which turns the
// session's record into `round_findings` rows keyed by `(pr, round_no,
// finding_key)`, and the live RENDER route, which stamps that key into every
// inline comment it renders so the comment can be linked back to its row.
// Beside it, the readings of a record entry every consumer must share: its
// numbers and strings, its disposition (is it `posted`?) and its diff side.
//
// A leaf on purpose — no imports. `packages/pi-plugin/src/reviewrender.ts` is also the bench's
// render step, and the bench must not pull the daemon's modules in with it.

/** A record field as a non-empty trimmed string, else null. */
export function recordString(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const t = val.trim();
  return t.length > 0 ? t : null;
}

/** The record's entry array: `findings` first, else the legacy `candidates`
 * spelling, else null. The ONE precedence the parser and the renderer share. */
export function recordEntries(rec: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(rec.findings)) return rec.findings;
  return Array.isArray(rec.candidates) ? rec.candidates : null;
}

/** A record field as a number — a finite number, or a decimal string a
 * session wrote (`"0.7"`, `"12"`) — else null. The ONE coercion: the parser
 * stores what the renderer posts, so a value both read must read alike. */
export function recordNumber(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val.trim())) {
    const number = Number(val.trim());
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

const str = recordString;
const num = recordNumber;

/** The diff side a record entry's anchor counts on: `LEFT` in any case, else
 * `RIGHT` (the default). The renderer posts on it and the post-check compares
 * by it, so both read one side. */
export function recordSide(val: unknown): "LEFT" | "RIGHT" {
  return recordString(val)?.toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
}

/**
 * What happened to a candidate finding. Closed set — the record is only
 * countable if the disposition is.
 *
 * - `posted` — it survived validation and went out on the PR (the RAISE side,
 *   the half adjudication actually needs).
 * - `killed` — the validator vetoed it.
 * - `downgraded` — the validator moved it (severity, confidence or
 *   reachability). A `downgrade` survivor still goes out: recorded with its
 *   `posted_as` it reads as posted (`entryDisposition`); without one it
 *   is never posted, and the renderer reports it.
 * - `doubted` — the validator could not stand behind the CLAIM (`DOUBT_WORDS`:
 *   refuted, unverifiable, bad anchor). A validity veto is a mark, not a
 *   deletion — kept here as "may not be valid", never posted on the PR,
 *   shown in the TUI for the operator to judge.
 * - `merged` / `folded` — merge-stage attrition: the same defect
 *   collapsed into another finding, or a different defect carried as a
 *   paragraph under one. Attrition here counts like a kill; it must never
 *   vanish silently.
 * - `withheld` — the session itself dropped it before the validator saw it,
 *   or the profile's `[posting]` policy kept a survivor off the PR (a word
 *   from `WITHHOLD_WORDS`: `over-budget`, `nits-off`, …) — kept, never posted.
 * - `conceded` — REFUTED AND CONCEDED: previously posted, the author refuted
 *   it and the reviewer accepted the refutation. This is the state that lets a
 *   later round tell "escalating an open finding" (legitimate — blocking late
 *   beats never) from "resurrecting a settled one" (not legitimate). Nothing
 *   else in the system records it.
 */
const DISPOSITION_VALUES = [
  "posted",
  "killed",
  "doubted",
  "downgraded",
  "merged",
  "folded",
  "withheld",
  "conceded",
] as const;

export type FindingDisposition = (typeof DISPOSITION_VALUES)[number] | "unknown";

const DISPOSITIONS: ReadonlySet<string> = new Set(DISPOSITION_VALUES);

/** Spellings a session plausibly writes, folded onto the closed set. Tolerant
 * input, exactly like the verdict file's digit-string coercion — never a
 * rejection reason. */
const DISPOSITION_ALIASES: Readonly<Record<string, FindingDisposition>> = {
  post: "posted",
  survive: "posted",
  survived: "posted",
  kill: "killed",
  vetoed: "killed",
  doubt: "doubted",
  "may-not-be-valid": "doubted",
  downgrade: "downgraded",
  demoted: "downgraded",
  capped: "downgraded",
  merge: "merged",
  fold: "folded",
  withhold: "withheld",
  dropped: "withheld",
  concede: "conceded",
  "refuted-and-conceded": "conceded",
  refuted_and_conceded: "conceded",
};

/** A disposition as the closed set, under every spelling the aliases fold. */
export function normalizeDisposition(raw: unknown): FindingDisposition {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (DISPOSITIONS.has(v)) return v as FindingDisposition;
  return DISPOSITION_ALIASES[v] ?? "unknown";
}

/**
 * The disposition a record ENTRY acts on. A validator `downgrade` keeps the
 * finding at the severity it names (packages/pi-plugin/src/templates.ts
 * renderValidatorOutputNote), so a `downgraded` entry that went out under a
 * tag (`posted_as`) is a posted survivor: the downgrade's `word` and `axis`
 * stay on the entry, and it counts, renders and dedups as `posted`. Without a
 * `posted_as` it stays `downgraded`, never posted. Every reader that asks
 * "was this entry posted?" of a raw entry asks it here.
 */
export function entryDisposition(entry: Record<string, unknown>): FindingDisposition {
  const d = normalizeDisposition(entry.disposition);
  if (d !== "downgraded") return d;
  const tag = entry.posted_as;
  return typeof tag === "string" && tag.trim() !== "" ? "posted" : d;
}

/**
 * The per-round key of the record entry at `index` of its `findings` array:
 * the session's own handle (`id`, else `key`), and when it wrote neither, the
 * stable fallback `<lens>@<path>:<line>#<index>`. This IS the parser's rule
 * (`parseFindingsRecord` calls it), so a key computed here from the same
 * record always names the same row.
 */
export function findingRecordKey(entry: Record<string, unknown>, index: number): string {
  const lens = str(entry.lens) ?? str(entry.name) ?? "";
  const path = str(entry.path);
  const line = num(entry.line);
  return str(entry.id) ?? str(entry.key) ?? `${lens || "?"}@${path ?? "?"}:${line ?? "?"}#${index}`;
}

/**
 * The hidden marker the live render route appends to an inline comment:
 * `<!-- qcr:f=<round_no>:<finding key> -->`. GitHub renders an HTML comment
 * as nothing, so the reader never sees it. The key is percent-encoded down to
 * `[A-Za-z0-9%._~]`, so no session-written key can close the comment early
 * (`-->`), break the line, or collide with the separator. Never throws: the
 * render route has no catch around it.
 */
export function findingMarker(roundNo: number, key: string): string {
  return `<!-- qcr:f=${Math.trunc(roundNo)}:${encodeMarkerKey(key)} -->`;
}

/** A lone UTF-16 surrogate — what `encodeURIComponent` throws `URIError` on. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function encodeMarkerKey(key: string): string {
  // A session-written key (a JSON `"\ud800"` escape parses) may hold a lone
  // surrogate. It becomes U+FFFD first — what `String.prototype.toWellFormed`
  // does, and what the key reads back as from the state database, whose UTF-8
  // storage makes the same replacement — so the marker still names its row.
  return encodeURIComponent(key.replace(LONE_SURROGATE, "�")).replace(
    /[!'()*-]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** Matches a marker anywhere in a comment body. */
export const FINDING_MARKER_RE = /<!--\s*qcr:f=(\d+):([A-Za-z0-9%._~]+)\s*-->/;

const FINDING_MARKER_ALL_RE = new RegExp(FINDING_MARKER_RE.source, "g");

/**
 * The marker a comment body carries, if any. A malformed one is no marker.
 *
 * The LAST marker in the body is the real one: the render route appends it
 * after the finding's text (`reviewrender.ts`), and that text is the
 * reviewer's, which may quote PR content — a marker-shaped string a PR
 * carries (or this repo's own tests, in a self-review) and the finding
 * quotes comes BEFORE it. Taking the first match would link the comment to
 * whatever finding the quoted text names.
 */
export function parseFindingMarker(
  body: string | null | undefined,
): { round_no: number; key: string } | null {
  if (typeof body !== "string") return null;
  let m: RegExpExecArray | null = null;
  for (const hit of body.matchAll(FINDING_MARKER_ALL_RE)) m = hit;
  if (!m) return null;
  try {
    const key = decodeURIComponent(m[2]!);
    return key ? { round_no: Number(m[1]), key } : null;
  } catch {
    return null;
  }
}

/** Every marker in a body, with the newlines the render route put before it. */
const FINDING_MARKER_STRIP_RE = new RegExp(`\\n*${FINDING_MARKER_RE.source}`, "g");

/** A body with every marker removed — what the comment reads as without it. */
export function stripFindingMarkers(body: string): string {
  return body.replace(FINDING_MARKER_STRIP_RE, "");
}

/** A recheck head as the recheck's own key: its first 12 characters,
 * lowercased — so a full sha and its prefix are one head. */
export function recheckHead12(head: string): string {
  return head.slice(0, 12).toLowerCase();
}

/** The `finding_key` prefix of a recheck's own findings at `head`
 * (`recheck:<head12>:`): the recheck writes its rows under it and the learner
 * reads them back by it. */
export function recheckKeyPrefix(head: string): string {
  return `recheck:${recheckHead12(head)}:`;
}
