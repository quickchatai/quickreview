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
