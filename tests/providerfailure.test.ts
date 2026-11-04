// The daemon's one reading of a worker's provider failure (src/providerfailure.ts):
// what the breaker, the worker supervisor's requeue, the session-command
// supervisor and the review-failure class all decide from.
import { describe, expect, it } from "vitest";
import {
  PROVIDER_BACKOFF_MIN,
  isOperatorWorkerFailure,
  isProviderTransient,
  isProviderTransientPassError,
  isTransientKind,
  providerBackoffMs,
  providerFailureKind,
} from "../src/providerfailure.js";
import { modelErrorKind } from "@quickchatai/pi-quickreview/src/engine/roundevents.js";
import { modelErrorKind as coreModelErrorKind } from "@quickchatai/pi-quickreview/src/modelerrors.js";

describe("providerFailureKind", () => {
  it.each([
    ["the round: the provider failed the turn: fetch failed", "transport"],
    ["the round: the provider failed the turn: read ECONNRESET", "transport"],
    ["the round: the provider failed the turn: Connection error.", "transport"],
    ["the round: the provider failed the turn: other side closed", "transport"],
    ["the round: the provider failed the turn: terminated", "transport"],
    ["the round: output stream failed: socket hang up", "transport"],
    ["the round: the provider failed the turn: 429 Too Many Requests", "rate_limited"],
    ["the round: the provider failed the turn: 503 Service Unavailable", "overloaded"],
    ["the round: the provider failed the turn: Overloaded", "overloaded"],
    ["the round: the provider failed the turn: The usage limit has been reached", "usage_limit"],
    ["the round: the provider failed the turn: 500 internal error", "other"],
  ] as const)("%s is %s", (text, kind) => {
    expect(providerFailureKind(text)).toBe(kind);
  });

  // MUTATION: drop the botworker prefix from PROVIDER_FAILURE (read any text) — a
  // refused login or a crash that happens to say "terminated" reads transient; this fails.
  it("is no provider failure for text botworker.ts did not word as one", () => {
    for (const text of [
      "the round: the provider refused the login: expired",
      "the round: the wall-clock cap ran out",
      "the worker died of SIGKILL",
      "the worker was terminated",
    ])
      expect(providerFailureKind(text), text).toBeUndefined();
  });
});

describe("isProviderTransient", () => {
  it("is the connection, a rate limit and an overload; never a usage window, an error or nothing", () => {
    expect(isProviderTransient("x: the provider failed the turn: fetch failed")).toBe(true);
    expect(isProviderTransient("x: the provider failed the turn: rate limit exceeded")).toBe(true);
    expect(isProviderTransient("x: the provider failed the turn: 529 overloaded")).toBe(true);
    expect(isProviderTransient("x: the provider failed the turn: usage limit reached")).toBe(false);
    expect(isProviderTransient("x: the provider failed the turn: invalid request")).toBe(false);
    expect(isProviderTransient(null)).toBe(false);
    expect(isProviderTransient("")).toBe(false);
  });
});

describe("isProviderTransientPassError", () => {
  // A lens pass's recorded failure is the provider's bare message.
  it("reads a lens pass's bare provider message, and the worker's wording", () => {
    expect(isProviderTransientPassError("429 Too Many Requests")).toBe(true);
    expect(isProviderTransientPassError("Connection error.")).toBe(true);
    expect(isProviderTransientPassError("overloaded_error: Overloaded")).toBe(true);
    expect(
      isProviderTransientPassError("the round: the provider failed the turn: fetch failed"),
    ).toBe(true);
  });

  it("is never a timeout, a spent usage window, another error or nothing", () => {
    expect(isProviderTransientPassError("pass pass-security--sol-high timed out after 8 min")).toBe(
      false,
    );
    expect(isProviderTransientPassError("You have hit your usage limit has been reached")).toBe(
      false,
    );
    expect(isProviderTransientPassError("invalid_request_error: prompt is too long")).toBe(false);
    expect(isProviderTransientPassError("failed")).toBe(false);
    expect(isProviderTransientPassError(undefined)).toBe(false);
  });
});

describe("isTransientKind", () => {
  // MUTATION: add "usage_limit" to isTransientKind — a spent window retries on
  // the ladder and never parks or drains as the breaker's own; this fails.
  it("is the one transient list: the connection, a rate limit, an overload", () => {
    expect(
      (["transport", "rate_limited", "overloaded", "usage_limit", "other", undefined] as const).map(
        isTransientKind,
      ),
    ).toEqual([true, true, true, false, false, false]);
  });
});

describe("isOperatorWorkerFailure", () => {
  // MUTATION: return false from isOperatorWorkerFailure — a refused login's
  // exhausted round waits on the automatic retry ladder; this fails.
  it("is a refused login, the worker's own refused login check and a spent usage window", () => {
    expect(isOperatorWorkerFailure("the round: the provider refused the login: expired")).toBe(
      true,
    );
    expect(
      isOperatorWorkerFailure("the worker's login was refused: no login in the agent dir"),
    ).toBe(true);
    expect(
      isOperatorWorkerFailure("x: the provider failed the turn: The usage limit has been reached"),
    ).toBe(true);
  });

  it("is never a transient provider failure, a crash or nothing", () => {
    expect(isOperatorWorkerFailure("x: the provider failed the turn: fetch failed")).toBe(false);
    expect(isOperatorWorkerFailure("the worker died of SIGKILL")).toBe(false);
    expect(isOperatorWorkerFailure("the round: the wall-clock cap ran out")).toBe(false);
    expect(isOperatorWorkerFailure(null)).toBe(false);
  });
});

describe("the backoff ladder", () => {
  it("waits 2, 8, then 30 minutes, and 30 for every retry after", () => {
    expect(PROVIDER_BACKOFF_MIN).toEqual([2, 8, 30]);
    expect([0, 1, 2, 3, 9].map(providerBackoffMs)).toEqual(
      [2, 8, 30, 30, 30].map((m) => m * 60_000),
    );
    expect(providerBackoffMs(-1)).toBe(2 * 60_000);
  });
});

describe("one reading of a model error", () => {
  it("the engine's modelErrorKind is the core's, re-exported", () => {
    expect(modelErrorKind).toBe(coreModelErrorKind);
  });
});
