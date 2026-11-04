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
import { providerErrorKind } from "@quickchatai/pi-quickreview/src/modelerrors.js";

export type ProviderFailureKind =
  "transport" | "rate_limited" | "overloaded" | "usage_limit" | "other";

/** The words botworker.ts puts before the provider's own message: a turn the
 * provider ended with an error, and a turn whose output stream broke. */
const PROVIDER_FAILURE = /(?:the provider failed the turn|output stream failed): ([\s\S]*)$/i;

/** What a worker's failure text says about the provider, or undefined when the
 * text is not a provider failure botworker.ts worded (a refused login, a
 * wall-clock cap, a crash). */
export function providerFailureKind(error: string): ProviderFailureKind | undefined {
  const message = PROVIDER_FAILURE.exec(error)?.[1];
  if (message === undefined) return undefined;
  return providerMessageKind(message);
}

/** What the provider's own error message says, unwrapped: a lens pass's
 * recorded failure (its `errorMessage`, as round-progress keeps it) is the
 * provider's words with no worker prefix. */
export function providerMessageKind(message: string): ProviderFailureKind {
  return providerErrorKind(message);
}

/** The kinds a later attempt of the same request cures: the connection, a
 * rate limit, an overload. The one list the worker's exit, the required-pass
 * gap and the breaker all read, so they cannot disagree about a kind. */
export function isTransientKind(kind: ProviderFailureKind | undefined): boolean {
  return kind === "transport" || kind === "rate_limited" || kind === "overloaded";
}

/** A provider failure that a later attempt of the same request cures: the
 * connection, a rate limit, an overload. */
export function isProviderTransient(error: string | null | undefined): boolean {
  if (!error) return false;
  return isTransientKind(providerFailureKind(error));
}

/** A lens pass's recorded failure is a transient provider failure: either
 * the worker's wording of one, or the provider's bare message reading as the
 * connection, a rate limit or an overload (a pass the per-pass deadline ended
 * while pi was retrying the provider names the provider's error too). A
 * timeout with no provider error, a crash or an empty error is not. */
export function isProviderTransientPassError(error: string | null | undefined): boolean {
  if (!error) return false;
  if (isProviderTransient(error)) return true;
  return isTransientKind(providerMessageKind(error));
}

/** The words of a worker failure only an operator cures, whatever stage it
 * surfaced at: the provider refused the login (src/botworker.ts), the
 * worker's own login check refused it before work started (`EXIT.auth`, which
 * src/workersupervisor.ts words this way), or the plan's usage window is
 * spent. Such a failure never waits on the automatic retry ladder. */
const OPERATOR_FAILURE = /the provider refused the login|the worker's login was refused/i;

/** A worker failure an automatic retry cannot cure (`OPERATOR_FAILURE`, or a
 * spent usage window): its incident stays the operator's. */
export function isOperatorWorkerFailure(error: string | null | undefined): boolean {
  if (!error) return false;
  return OPERATOR_FAILURE.test(error) || providerFailureKind(error) === "usage_limit";
}

/** The exit code of a worker whose own login check refused it before work
 * started (src/botworker.ts `EXIT.auth`). */
export const WORKER_EXIT_AUTH = 4;

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
