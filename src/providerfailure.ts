// What a worker's failure says about the model provider, read off the words
// src/botworker.ts gives it. The daemon, the breaker and the session-command
// supervisor share this one reading, so a provider outage is called the same
// thing wherever it is decided what to do about it.
//
// A transient provider failure — the connection dropped, a rate limit, an
// overload — says nothing about the PR or the review: the same request a few
// minutes later succeeds. So it is retried with backoff, it never parks a PR,
// and once the immediate retries are spent it waits on the automatic retry
// ladder (`retry_wait`) instead of an operator's `u`. A spent usage window is
// not transient in that sense (no pause of minutes cures it) and a refused
// login is the operator's to fix.
//
// This module is a daemon module: it never imports the engine
// (tests/fences-worker-supervisor.test.ts), so the error-message reading is the
// core's src/modelerrors.ts.
import { modelErrorKind } from "@quickchatai/pi-quickreview/src/modelerrors.js";

export type ProviderFailureKind = "transport" | "rate_limited" | "overloaded" | "usage_limit" | "other";

/** The words botworker.ts puts before the provider's own message: a turn the
 * provider ended with an error, and a turn whose output stream broke. */
const PROVIDER_FAILURE = /(?:the provider failed the turn|output stream failed): ([\s\S]*)$/i;

/** The phrasings of a dropped connection: Node's and undici's (`fetch failed`,
 * the socket errnos, `other side closed`, `terminated`) and the SDKs'
 * (`Connection error`). */
const TRANSPORT =
  /\b(fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|connection error|other side closed|terminated)\b/i;

/** What a worker's failure text says about the provider, or undefined when the
 * text is not a provider failure botworker.ts worded (a refused login, a
 * wall-clock cap, a crash). */
export function providerFailureKind(error: string): ProviderFailureKind | undefined {
  const message = PROVIDER_FAILURE.exec(error)?.[1];
  if (message === undefined) return undefined;
  const kind = modelErrorKind(message);
  if (kind !== "other") return kind;
  return TRANSPORT.test(message) ? "transport" : "other";
}

/** A provider failure that a later attempt of the same request cures: the
 * connection, a rate limit, an overload. */
export function isProviderTransient(error: string | null | undefined): boolean {
  if (!error) return false;
  const kind = providerFailureKind(error);
  return kind === "transport" || kind === "rate_limited" || kind === "overloaded";
}

/** The exit code of a worker whose turn a transient provider failure ended
 * (src/botworker.ts `EXIT.provider`). Named here because the worker supervisor
 * that reads it is a daemon module and never imports the worker. */
export const WORKER_EXIT_PROVIDER = 7;

/** The waits before each retry of work a transient provider failure stopped:
 * the first retry after 2 minutes, then 8, then 30, then 30 again. */
export const PROVIDER_BACKOFF_MIN: readonly number[] = [2, 8, 30];

/** The wait before retry number `attempt` (0 = the first retry). */
export function providerBackoffMs(attempt: number): number {
  const steps = PROVIDER_BACKOFF_MIN;
  const index = Math.min(Math.max(0, Math.floor(attempt)), steps.length - 1);
  return steps[index]! * 60_000;
}
