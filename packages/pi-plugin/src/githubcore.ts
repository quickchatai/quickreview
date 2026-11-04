// The core's half of the GitHub client: what a review route needs to read a
// PR and post through the one gate without the daemon's adapter
// (src/github.ts, which re-exports these).

/** A GitHub request that came back refused: the method, path and status, and
 * how long GitHub asked us to wait, when it said. `detail` is GitHub's own
 * answer, apart from the request line: what a classification reads, so a
 * path that happens to say "rate-limit" never makes a refusal look like one. */
export class GitHubRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${method} ${path} → ${status}: ${detail}`);
    this.name = "GitHubRequestError";
  }
}

export interface PrFileEntry {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
  /** Unified diff for the file when GitHub returns one (absent for binaries). */
  patch?: string;
  /** The path before a rename, when GitHub detected one (renumber detection). */
  previous_filename?: string;
}

/** A paginated read whose snapshot was inconsistent (the advertised total
 * moved between pages, or was never reached). Nothing is wrong with the
 * request: the next read may well be whole, so it classifies as transient.
 * Partial rows are never returned as complete. */
export class IncompleteReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IncompleteReadError";
  }
}

/** A GraphQL answer that came back HTTP 200 with an `errors` array. The
 * message keeps the historical `graphql errors: …` spelling; `errors` is the
 * array as GitHub sent it, for classification. */
export class GitHubGraphQLError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super(`graphql errors: ${JSON.stringify(errors).slice(0, 300)}`);
    this.name = "GitHubGraphQLError";
  }
}

/**
 * What a thrown GitHub call means for whoever retries it:
 *  - `transient`: the request may succeed unchanged later (5xx, 408, a
 *    timeout, a dropped connection, an inconsistent paginated snapshot,
 *    GraphQL's "Something went wrong" / timeout);
 *  - `rate_limited`: GitHub asked us to slow down (429, a rate-limit 403,
 *    GraphQL `RATE_LIMITED`);
 *  - `rejected`: GitHub refused this request (any other 4xx) and will refuse
 *    it again until something changes;
 *  - `unknown`: not a GitHub answer at all (a programming error, say).
 */
export type GitHubFailureKind = "transient" | "rate_limited" | "rejected" | "unknown";

export interface GitHubFailure {
  kind: GitHubFailureKind;
  /** The HTTP status, when an answer came back. */
  status?: number;
  /** How long GitHub asked us to wait, when it said. */
  retryAfterMs?: number;
  /** A short cause for logs: whitespace collapsed, credentials masked, capped. */
  detail: string;
}

/** Connection-level error codes (node's and undici's) that mean the request
 * never got an answer, so trying again unchanged is sound. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);

const DETAIL_CAP = 200;

/** Whitespace collapsed, anything token-shaped masked, capped. */
function sanitizeDetail(text: string): string {
  const clean = text
    .replace(/\s+/g, " ")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1***")
    .replace(/\b(bearer|token)\s+[A-Za-z0-9._-]{8,}/gi, "$1 ***")
    .trim();
  return clean.length > DETAIL_CAP ? `${clean.slice(0, DETAIL_CAP - 1)}…` : clean;
}

const RATE_LIMIT_TEXT = /rate.?limit|secondary.?rate|abuse.?detect/i;
const GRAPHQL_TRANSIENT_TEXT = /something went wrong|timed? ?out|timeout/i;

/** The error, then each `cause` under it (bounded: a cause chain can loop). */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && chain.length < 6 && !chain.includes(cur)) {
    chain.push(cur);
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function field(e: unknown, key: string): unknown {
  return typeof e === "object" && e !== null ? (e as Record<string, unknown>)[key] : undefined;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

/** A message with every `METHOD /path` request line taken out, so the
 * evidence a classification reads is the answer, not the URL asked for. */
function withoutRequestLine(text: string): string {
  return text.replace(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\S+/g, "");
}

/** A status-bearing answer: the kind its status means. */
function kindOfStatus(status: number, text: string): GitHubFailureKind {
  if (status >= 500 || status === 408) return "transient";
  if (status === 429) return "rate_limited";
  if (status === 403 && RATE_LIMIT_TEXT.test(text)) return "rate_limited";
  if (status >= 400) return "rejected";
  return "unknown";
}

/** GraphQL's own error array: RATE_LIMITED first, then GitHub's generic
 * "Something went wrong" / timeout, then a typed refusal. */
function kindOfGraphQLErrors(errors: readonly unknown[]): GitHubFailureKind {
  const text = JSON.stringify(errors);
  if (/"type"\s*:\s*"RATE_LIMITED?"|graphql_rate_limit/i.test(text) || RATE_LIMIT_TEXT.test(text))
    return "rate_limited";
  if (GRAPHQL_TRANSIENT_TEXT.test(text)) return "transient";
  if (errors.some((e) => typeof field(e, "type") === "string")) return "rejected";
  return "unknown";
}

/** One classification of a thrown GitHub call. Structure first (the
 * adapter's own error classes, a timeout's name, a connection error's code
 * anywhere in its cause chain), then the text of a plain error whose message
 * names a GitHub/GraphQL/HTTP status, so a caller or test that throws
 * `new Error("graphql → 502")` classifies the same way. */
export function classifyGitHubFailure(err: unknown): GitHubFailure {
  const detail = sanitizeDetail(messageOf(err));

  // By class, or by shape: a second copy of this module (a package installed
  // beside a checkout) makes its own class, and its errors mean the same.
  const status = field(err, "status");
  if (
    err instanceof GitHubRequestError ||
    (field(err, "name") === "GitHubRequestError" && typeof status === "number")
  ) {
    const s = status as number;
    const retryAfterMs = field(err, "retryAfterMs");
    // The response's own words, never the request line: the method and path
    // are ours, and a repository or branch name may say anything.
    const answer = field(err, "detail");
    return {
      kind: kindOfStatus(s, typeof answer === "string" ? answer : withoutRequestLine(messageOf(err))),
      status: s,
      ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
      detail,
    };
  }
  if (err instanceof IncompleteReadError) return { kind: "transient", detail };
  if (err instanceof GitHubGraphQLError) return { kind: kindOfGraphQLErrors(err.errors), detail };

  for (const e of causeChain(err)) {
    const name = field(e, "name");
    if (name === "TimeoutError" || name === "AbortError")
      return { kind: "transient", detail: sanitizeDetail(`${name}: ${messageOf(e)}`) };
    const code = field(e, "code");
    if (typeof code === "string" && TRANSIENT_CODES.has(code))
      return { kind: "transient", detail: sanitizeDetail(`${code}: ${messageOf(e)}`) };
    if (/socket hang up/i.test(messageOf(e))) return { kind: "transient", detail };
  }
  if (err instanceof TypeError && /fetch failed|terminated|network/i.test(err.message))
    return { kind: "transient", detail };

  const text = withoutRequestLine(messageOf(err));
  if (/graphql_rate_limit|\bRATE_LIMITED?\b/.test(text)) return { kind: "rate_limited", detail };
  const statusText = /(?:graphql|github|http|status|→)[^\n]{0,24}?\b([1-5]\d\d)\b/i.exec(text);
  if (statusText) {
    const status = Number(statusText[1]);
    const kind = kindOfStatus(status, text);
    if (kind !== "unknown") return { kind, status, detail };
  }
  if (/^graphql errors:/i.test(text) && GRAPHQL_TRANSIENT_TEXT.test(text))
    return { kind: "transient", detail };
  if (RATE_LIMIT_TEXT.test(text) && /\b403\b|secondary/i.test(text))
    return { kind: "rate_limited", detail };
  return { kind: "unknown", detail };
}

/**
 * How long a failed response asked the caller to wait, in ms: `retry-after`
 * (seconds or an HTTP date) when present; otherwise the rate-limit window's
 * `x-ratelimit-reset`, but only when `x-ratelimit-remaining` is "0". GitHub
 * sends the reset header on every response, so without that condition a
 * plain 502 would inherit "wait until the hourly window resets".
 */
export function retryAfterFromHeaders(
  headers: Pick<Headers, "get"> | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const ms = /^\d+$/.test(retryAfter.trim())
      ? Number(retryAfter.trim()) * 1000
      : Date.parse(retryAfter) - now;
    return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
  }
  if (headers?.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset");
    if (reset && /^\d+$/.test(reset.trim())) return Math.max(0, Number(reset) * 1000 - now);
  }
  return undefined;
}

/** A read is tried at most this many times in all. */
export const READ_ATTEMPTS = 3;
/** The pause after the first and the second failed attempt, before jitter
 * (each is scaled by a factor in [0.75, 1.25)). */
export const READ_BACKOFF_MS: readonly number[] = [1000, 3000];
/** The longest wait GitHub may ask for that a read still sits out in place.
 * Past it the read throws at once, `retryAfterMs` set, and the durable
 * layers above (the outbox, the reply schedules) defer instead. */
export const READ_RETRY_AFTER_CAP_MS = 20_000;

/** The clock of a bounded read retry, injectable so tests are instant. */
export interface ReadRetryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1): the jitter source. */
  random?: () => number;
}

/**
 * The pause before trying a read again after attempt `attempt` (0-based)
 * failed with `err`, or null when it must not be tried again: the attempts
 * are spent, the failure is neither transient nor rate_limited, or GitHub
 * asked for a wait longer than READ_RETRY_AFTER_CAP_MS.
 */
export function readRetryDelay(
  err: unknown,
  attempt: number,
  random: () => number = Math.random,
): number | null {
  if (attempt + 1 >= READ_ATTEMPTS) return null;
  const failure = classifyGitHubFailure(err);
  if (failure.kind !== "transient" && failure.kind !== "rate_limited") return null;
  const base = READ_BACKOFF_MS[Math.min(attempt, READ_BACKOFF_MS.length - 1)] ?? 1000;
  const backoff = Math.round(base * (0.75 + 0.5 * random()));
  if (failure.retryAfterMs === undefined) return backoff;
  if (failure.retryAfterMs > READ_RETRY_AFTER_CAP_MS) return null;
  return Math.max(backoff, failure.retryAfterMs);
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run one idempotent read, retrying a transient or rate-limited failure on
 * the bounded schedule above. Never wrap a mutation in this. */
export async function withReadRetry<T>(
  read: () => Promise<T>,
  o: ReadRetryOptions = {},
): Promise<T> {
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      const delay = readRetryDelay(err, attempt, random);
      if (delay === null) throw err;
      await sleep(delay);
    }
  }
}

/**
 * The long, bounded schedule a durable caller (a reply decision, a PR
 * conversation answer) waits out a transient or rate-limited GitHub failure
 * on: about 1, 2, 5, 15, 30, 60 and 60 minutes, some three hours in all.
 * These waits do not count toward a caller's strike budget for refusals;
 * when they are spent, the caller's ordinary terminal path runs.
 */
export const TRANSIENT_RETRY_SCHEDULE_MS: readonly number[] = [1, 2, 5, 15, 30, 60, 60].map(
  (m) => m * 60_000,
);

/** The wait after the `n`th (1-based) transient failure in a row, raised to
 * GitHub's own `retryAfterMs` when that is longer; null once the schedule is
 * spent. */
export function transientRetryDelayMs(n: number, retryAfterMs?: number): number | null {
  const base = TRANSIENT_RETRY_SCHEDULE_MS[n - 1];
  if (base === undefined) return null;
  return Math.max(base, retryAfterMs ?? 0);
}
