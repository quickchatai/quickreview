// The daemon's one reading of a worker's provider failure (src/providerfailure.ts):
// what the breaker, the worker supervisor's requeue, the session-command
// supervisor and the review-failure class all decide from.
import { describe, expect, it } from "vitest";
import {
  PROVIDER_BACKOFF_MIN,
  isProviderTransient,
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
