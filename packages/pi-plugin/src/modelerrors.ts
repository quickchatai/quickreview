// How a model call's error message reads: a spent usage window, a rate limit,
// an overload, or something else. One reading for pi's event stream, its
// stderr and the daemon's view of a worker that failed on the provider.
//
// This module sits outside src/engine/ on purpose: the daemon classifies a
// worker's provider failure too, and the daemon never imports the engine
// (tests/fences-worker-supervisor.test.ts). src/engine/roundevents.ts
// re-exports it, so the engine's readers keep their one import.

/** The plan's usage window is spent (checked before RATE_LIMIT_RE, which it
 * would also match). */
export const USAGE_LIMIT_RE =
  /usage limit has been reached|usage[ _-]?limit[ _-]?reached|insufficient[ _-]?quota|exceeded your current quota/i;
export const RATE_LIMIT_RE = /\b429\b|rate[ _-]?limit|too many requests|usage[ _-]?limit|quota/i;
export const OVERLOAD_RE = /overloaded|\b50[23]\b|\b529\b|capacity/i;

/** A model error message's kind: a spent usage window first (its words would
 * also read as a rate limit), then a rate limit, then an overload. One
 * reading for pi's event stream and its stderr. */
export function modelErrorKind(
  message: string,
): "usage_limit" | "rate_limited" | "overloaded" | "other" {
  if (USAGE_LIMIT_RE.test(message)) return "usage_limit";
  if (RATE_LIMIT_RE.test(message)) return "rate_limited";
  if (OVERLOAD_RE.test(message)) return "overloaded";
  return "other";
}

/** The phrasings of a dropped connection: Node's and undici's (`fetch failed`,
 * the socket errnos, `other side closed`, `terminated`) and the SDKs'
 * (`Connection error`). */
export const TRANSPORT_RE =
  /\b(fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|connection error|other side closed|terminated)\b/i;

/** A provider error message's kind: `modelErrorKind`'s reading, then a
 * dropped connection (`transport`). */
export function providerErrorKind(
  message: string,
): "usage_limit" | "rate_limited" | "overloaded" | "transport" | "other" {
  const kind = modelErrorKind(message);
  if (kind !== "other") return kind;
  return TRANSPORT_RE.test(message) ? "transport" : "other";
}

/** Words that read as each kind, put ahead of a cut that lost its kind. */
const KIND_WORDS = {
  usage_limit: "usage limit reached",
  rate_limited: "rate limit",
  overloaded: "overloaded",
  transport: "connection error",
} as const;

/**
 * A provider error bounded to about `max` characters for display and storage,
 * classified before the cut: a discriminator (a late 429, an ECONNRESET, a
 * usage-limit qualifier) can sit past it. The cut ends on a whole word (one
 * word longer than `max` is cut inside), so it matches nothing the whole
 * message does not; when it alone would read as
 * another kind than the whole message, the whole message's kind is named
 * ahead of it. Every reader of the bounded text then reads the whole
 * message's kind.
 */
export function boundedProviderError(message: string, max = 300): string {
  const whole = message.replace(/\s+/g, " ").trim();
  if (whole.length <= max) return whole;
  const cut = `${whole.slice(0, max + 1).replace(/\s*\S*$/, "") || whole.slice(0, max)}…`;
  const kind = providerErrorKind(whole);
  return kind === "other" || kind === providerErrorKind(cut) ? cut : `(${KIND_WORDS[kind]}) ${cut}`;
}
