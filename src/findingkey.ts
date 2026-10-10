// A posted finding's identity, shared by the two ends that must agree on it
// for outcome capture: the findings-record PARSER, which turns the
// session's record into `round_findings` rows keyed by `(pr, round_no,
// finding_key)`, and the live RENDER route, which stamps that key into every
// inline comment it renders so the comment can be linked back to its row.
//
// A leaf on purpose — no imports. `src/reviewrender.ts` is also the bench's
// render step, and the bench must not pull the daemon's modules in with it.

function str(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const t = val.trim();
  return t.length > 0 ? t : null;
}

function num(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val.trim())) return Number(val.trim());
  return null;
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

/** A body with every marker removed — what the comment reads as without it. */
export function stripFindingMarkers(body: string): string {
  return body.replace(/\n*<!--\s*qcr:f=\d+:[A-Za-z0-9%._~]+\s*-->/g, "");
}
