// QCR FORK — file added by PATCH 6 (writes that stick, errors that say so).
// Not upstream. S2.
//
// The pure half of three fixes, kept free of pi and of the OV client so
// `tests/openviking-fork.test.ts` can exercise it (`tools.ts` cannot be
// imported from a test: it pulls `typebox` and `@earendil-works/pi-ai`).
//
// 1. A BUSY 409 IS RETRIED, A PRECONDITION 409 IS NOT. The server's
//    batch-write takes a zero-timeout try-lock on its root directory; a
//    second writer into the same directory gets `409 CONFLICT` with
//    `details.conflict_type = "path_busy"` and `retryable: true` — nothing was
//    checked and nothing was written (server/error_mapping.py). The tool used
//    to tell the model "someone else edited the file — re-read it, never
//    retry", for a file nobody had touched: 6 of the 8 EOD writes on
//    2026-10-05 died that way. `withBusyRetry` retries ONLY that answer,
//    jittered and bounded (≤10 s in total); a hash-precondition 409 carries
//    the same status and code but no `path_busy`, and stays a refusal.
// 2. AN ERROR IS NEVER "NO RESULTS". `find()` turned every failure — a
//    refused key included — into an empty list, so `viking_search` said "No
//    results found." through five weeks of `Invalid API Key` (every PR-session
//    memory call in history returned that, or "No content at …").
//    `failureText` names what actually happened, and says plainly that it is
//    an outage, not an empty answer.
// 3. A ROTATED KEY IS PICKED UP. The extension reads its key once, at load;
//    the daemon rewrites the sessions' ovcli.conf when its key changes
//    (S1), but a running session kept sending the dead one.
//    `shouldRekey` is the rule the client applies on an auth failure: re-read
//    the credential once, and retry once only if it actually changed.

/** What a client answer looks like here — the `OVResponse` shape, loosened
 * so this file does not import the client. */
export interface AnswerLike {
  ok: boolean;
  status?: number;
  error?: unknown;
}

/** The `details.conflict_type` the server stamps on a lock it could not take. */
export const BUSY_CONFLICT_TYPE = "path_busy";

/** Retry bound for a busy answer: at most `retries` more attempts, the n-th
 * after a jittered `min(capMs, baseMs·2ⁿ)` wait (half to all of it), never
 * past `budgetMs` from the first attempt. Mirrors the daemon client's
 * `BUSY_RETRY_DEFAULTS` (src/openviking/client.ts) — two processes, one rule. */
export const BUSY_RETRY = Object.freeze({
  retries: 4,
  baseMs: 250,
  capMs: 2000,
  budgetMs: 10_000,
});

/** Is this answer the server's "directory busy, try again"? Keyed on
 * `details.conflict_type` alone — never the message, never the status alone. */
export function isBusy(res: AnswerLike): boolean {
  if (res.ok || res.status !== 409) return false;
  const error = res.error;
  if (!error || typeof error !== "object") return false;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return false;
  return (details as { conflict_type?: unknown }).conflict_type === BUSY_CONFLICT_TYPE;
}

/** Is this answer a precondition refusal — a 409 that is NOT busy? */
export function isPreconditionConflict(res: AnswerLike): boolean {
  return !res.ok && res.status === 409 && !isBusy(res);
}

/** The wait before busy retry `retry` (0-based). Pure — `random` injected. */
export function busyDelay(retry: number, random: () => number = Math.random): number {
  const step = Math.min(BUSY_RETRY.capMs, BUSY_RETRY.baseMs * 2 ** Math.max(0, retry));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(step * (0.5 + r / 2));
}

export interface BusyRetryHooks {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** What `withBusyRetry` adds to the answer it returns. */
export interface BusyRetryNote {
  /** How many busy answers were retried. */
  busyRetries: number;
  /** True when the LAST answer was still busy — the budget ran out. */
  stillBusy: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `attempt` and retry it while — and only while — it answers busy, within
 * `BUSY_RETRY`. Safe for any request: a busy answer means the server took no
 * lock, so it checked and wrote nothing, and a repeat cannot double a write.
 */
export async function withBusyRetry<T extends AnswerLike>(
  attempt: () => Promise<T>,
  hooks: BusyRetryHooks = {},
): Promise<T & BusyRetryNote> {
  const sleep = hooks.sleep ?? defaultSleep;
  const random = hooks.random ?? Math.random;
  const now = hooks.now ?? Date.now;
  const started = now();
  for (let retry = 0; ; retry += 1) {
    const res = await attempt();
    if (!isBusy(res)) return { ...res, busyRetries: retry, stillBusy: false };
    const delay = busyDelay(retry, random);
    if (retry >= BUSY_RETRY.retries || now() - started + delay > BUSY_RETRY.budgetMs) {
      return { ...res, busyRetries: retry, stillBusy: true };
    }
    await sleep(delay);
  }
}

/** Server error codes that mean "this key does not authenticate here". */
const AUTH_CODES = new Set([
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
  "FORBIDDEN",
  "INVALID_API_KEY",
]);

function errorField(error: unknown, field: "code" | "message"): string {
  if (!error || typeof error !== "object") return "";
  const v = (error as Record<string, unknown>)[field];
  return typeof v === "string" ? v : "";
}

/** A refused key: 401/403, an auth code, or the 0.4.15 server's own words
 * ("Invalid API Key"), which it has been seen to send inside an error
 * envelope. Same rule as the daemon's `isAuthFailure`. */
export function isAuthFailure(res: AnswerLike): boolean {
  if (res.ok) return false;
  if (res.status === 401 || res.status === 403) return true;
  if (AUTH_CODES.has(errorField(res.error, "code").toUpperCase())) return true;
  return /invalid api key|unauthenticated|unauthori[sz]ed/i.test(errorField(res.error, "message"));
}

/** Should an auth failure be retried with a re-read key? Only once, and only
 * when the credential source actually yields a DIFFERENT, non-empty key —
 * re-sending the refused one would just be a second refusal. */
export function shouldRekey(res: AnswerLike, current: string, reread: string): boolean {
  return isAuthFailure(res) && reread !== "" && reread !== current;
}

/** Is this answer a NOT_FOUND — the path is not there (an authenticated
 * answer, not an outage)? */
export function isNotFound(res: AnswerLike): boolean {
  return !res.ok && (res.status === 404 || errorField(res.error, "code") === "NOT_FOUND");
}

/**
 * The honest sentence for a failed call, rendered to the model verbatim.
 * `what` completes "nothing was …" — `searched`, `read`, `listed`, `written`.
 * Never "No results found": an outage must not read like an empty memory.
 */
export function failureText(res: AnswerLike & Partial<BusyRetryNote>, what: string): string {
  const status = res.status ?? 0;
  const code = errorField(res.error, "code");
  const message = errorField(res.error, "message").slice(0, 300);
  const said = [status ? `HTTP ${status}` : "", code].filter((x) => x !== "").join(" ");
  if (isAuthFailure(res)) {
    return (
      `OpenViking REFUSED this session's key (${said || "auth"}${message ? `: ${message}` : ""}) — ` +
      `memory is unavailable to this session, so nothing was ${what}. ` +
      "This is an outage, not an empty result; the daemon's memory health reports it."
    );
  }
  if (isBusy(res) || res.stillBusy) {
    return (
      `OpenViking kept that memory directory busy (409 ${BUSY_CONFLICT_TYPE}) past the retry budget — ` +
      `nothing was ${what}. Nobody's edit was refused: another write held the lock. Try again in a minute.`
    );
  }
  if (status === 0) {
    return (
      `OpenViking did not answer (${message || "no response"}) — nothing was ${what}. ` +
      "This is an outage, not an empty result."
    );
  }
  return `OpenViking error (${said}${message ? `: ${message}` : ""}) — nothing was ${what}.`;
}
