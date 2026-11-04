// The core's half of the GitHub client: what a review route needs to read a
// PR and post through the one gate without the daemon's adapter
// (src/github.ts, which re-exports these).

/** A GitHub request that came back refused: the method, path and status, and
 * how long GitHub asked us to wait, when it said. */
export class GitHubRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string,
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
    .replace(/\b(bearer|token)\s+[A-Za-z0-9._\-]{8,}/gi, "$1 ***")
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
    return {
      kind: kindOfStatus(s, messageOf(err)),
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

  const text = messageOf(err);
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
