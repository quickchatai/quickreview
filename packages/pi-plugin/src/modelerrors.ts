// How a model call's error message reads: a spent usage window, a rate limit,
// a refused credential, a refused model, an overload, a dropped connection, or
// something else. One reading for pi's event stream, its stderr, the auth
// watch, the login owner and the daemon's view of a worker that failed on the
// provider.
//
// pi hands over only the provider's text, so this is a text match of our own,
// and it names no provider: the phrases are the ones the providers' APIs and
// pi itself use. `providerErrorKind` is the one function. It tries the kinds
// in a fixed order, and every reader calls it; none tests a pattern of its own.
//
// This module sits outside src/engine/ on purpose and imports no pi package:
// the daemon classifies a worker's provider failure too, and the daemon never
// imports the engine (tests/fences-worker-supervisor.test.ts).
// src/engine/roundevents.ts re-exports it, so the engine's readers keep their
// one import.

/** A status number, read only beside a word that says it is one: `status`,
 * `http` or `error` before it (with an optional `code`), or one of them, or
 * the status's own word, after it. A bare number is a count as often as a
 * status, so it never decides alone. */
function statusBeside(code: number, word: string): string {
  return (
    `(?:status|http|error)(?:[ _-]?code)?(?:\\/[\\d.]+)?\\W{0,3}${code}\\b` +
    `|\\b${code}\\W{0,3}(?:status|http|error|${word})`
  );
}

/** A stretch inside one sentence: anything but a full stop, where a dot
 * inside a word (a model id's version) is not one. */
const sameSentence = (max: number): string => `(?:[^.]|\\.(?=\\S)){0,${max}}`;

/** The account or the plan is spent: no pause of minutes cures it. Specific
 * phrases only, never a bare status number or a bare `billing`. Checked
 * before RATE_LIMIT_RE, which its words would also match. */
export const USAGE_LIMIT_RE = new RegExp(
  [
    "usage limit has been reached",
    "usage[ _-]?limit[ _-]?reached",
    "insufficient[ _-]?quota",
    "exceeded your current quota",
    "payment required",
    "insufficient[ _](?:credits?|balance|funds)",
    "credit balance",
    "account (?:is )?(?:blocked|suspended|deactivated)",
    "out of (?:budget|credits)",
    "spending limit",
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "subscription_sharing_usage_limit_exceeded",
  ].join("|"),
  "i",
);

/** Too many requests for now: a later attempt of the same request succeeds.
 * Tried before any status number is read, so a rate-limit text that carries
 * another number as a count stays a rate limit. */
export const RATE_LIMIT_RE =
  /\b429\b|rate[ _-]?limit|too many requests|usage[ _-]?limit|quota|resource[ _-]?exhausted/i;

/** The provider refused the credential itself. Credential phrases only: a
 * refusal that names no credential (a 403, `access denied`, a model the
 * account may not use) is MODEL_REFUSED_RE's, because this kind tells the
 * operator to sign in again and stops every review until they do. */
export const AUTH_ERROR_RE = new RegExp(
  [
    "authentication token is expired",
    "invalid_grant",
    "unauthori[sz]ed",
    "unauthenticated",
    "authentication[_ ]error",
    "invalid[_ ](?:x-)?api[_ -]?key",
    "incorrect api key",
    "api key not valid",
    "token (?:is|has) expired",
    "token (?:was |has been )?revoked",
    "oauth refresh failed",
    "refresh_token_(?:reused|expired|invalidated)",
    "credential store modify failed",
    // A borrowed login asked to change (engine/auth.ts AuthRefreshRefused).
    "refusing to \\w+ the \\S+ login",
    statusBeside(401, "unauthori[sz]ed"),
  ].join("|"),
  "i",
);

/** The provider took the credential and refused the model: it does not serve
 * that id, or this account may not use it. The failure is one model's, never
 * the login's. */
export const MODEL_REFUSED_RE = new RegExp(
  [
    `model${sameSentence(60)}(?:not[ _]?found|does not exist|not available|not supported|no access)`,
    `deployment${sameSentence(40)}(?:not[ _]?found|does not exist)`,
    "permission[_ ]denied",
    // Also the exception name some APIs give it (`AccessDeniedException`).
    "access ?denied",
    statusBeside(403, "forbidden"),
  ].join("|"),
  "i",
);

export const OVERLOAD_RE = /overloaded|\b50[23]\b|\b529\b|capacity/i;

/** The phrasings of a dropped connection: Node's and undici's (`fetch failed`,
 * the socket errnos, `other side closed`, `terminated`) and the SDKs'
 * (`Connection error`). */
export const TRANSPORT_RE =
  /\b(fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|connection error|other side closed|terminated)\b/i;

export type ProviderErrorKind =
  "usage_limit" | "rate_limited" | "auth" | "model_refused" | "overloaded" | "transport" | "other";

/**
 * A provider error message's kind. The order is the rule:
 *
 *   1. a spent usage window (its words would also read as a rate limit);
 *   2. a rate limit, before any status number is read;
 *   3. a refused credential (`auth`);
 *   4. a refused model (`model_refused`);
 *   5. an overload, then a dropped connection (`transport`).
 *
 * A wording no row covers is `other`.
 */
export function providerErrorKind(message: string): ProviderErrorKind {
  if (USAGE_LIMIT_RE.test(message)) return "usage_limit";
  if (RATE_LIMIT_RE.test(message)) return "rate_limited";
  if (AUTH_ERROR_RE.test(message)) return "auth";
  if (MODEL_REFUSED_RE.test(message)) return "model_refused";
  if (OVERLOAD_RE.test(message)) return "overloaded";
  if (TRANSPORT_RE.test(message)) return "transport";
  return "other";
}

/** `providerErrorKind`, as the three kinds a run's error counts keep: a spent
 * usage window, a rate limit, an overload. Everything else is `other`. */
export function modelErrorKind(
  message: string,
): "usage_limit" | "rate_limited" | "overloaded" | "other" {
  const kind = providerErrorKind(message);
  return kind === "usage_limit" || kind === "rate_limited" || kind === "overloaded"
    ? kind
    : "other";
}

/** Words that read as each kind, put ahead of a cut that lost its kind. Each
 * reads as its own kind and as none that is tried before it. */
const KIND_WORDS = {
  usage_limit: "usage limit reached",
  rate_limited: "rate limit",
  auth: "unauthorized",
  model_refused: "access denied",
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
