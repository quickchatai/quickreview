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
  providerMessageKind,
} from "../src/providerfailure.js";
import { modelErrorKind } from "@quickchatai/pi-quickreview/src/engine/roundevents.js";
import {
  AUTH_ERROR_RE,
  MODEL_REFUSED_RE,
  boundedProviderError,
  modelErrorKind as coreModelErrorKind,
  providerErrorKind,
} from "@quickchatai/pi-quickreview/src/modelerrors.js";

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

// One ordered classifier (packages/pi-plugin/src/modelerrors.ts): a spent
// usage window, a rate limit, a refused credential, a refused model, an
// overload, a dropped connection. The texts are the ones the providers' APIs
// and pi itself give.
describe("providerErrorKind: one function, tried in order", () => {
  // MUTATION: add `\\b403\\b` to AUTH_ERROR_RE - a 403 on one model reads
  // as a refused login (the lens child's 403 raises pi_auth_expired in
  // tests/authwatch.test.ts) and the model_refused rows here fail.
  // MUTATION: test AUTH_ERROR_RE before RATE_LIMIT_RE in providerErrorKind - the
  // rate limit that carries "401 errors" as a count reads as auth; this fails.
  // MUTATION: add a bare `\\b402\\b` to USAGE_LIMIT_RE - the rate limit that
  // carries 402 as a count reads as a spent account; this fails.
  it.each([
    // a refused credential
    ["Provided authentication token is expired.", "auth"],
    ["invalid_grant", "auth"],
    ["401 Unauthorized", "auth"],
    ["authentication_error: invalid x-api-key", "auth"],
    ["API key not valid. Please pass a valid API key.", "auth"],
    ["OAuth refresh failed for anthropic", "auth"],
    ["Credential store modify failed for github-copilot", "auth"],
    ["Incorrect API key provided", "auth"],
    ["The access token has been revoked", "auth"],
    ["refresh_token_reused", "auth"],
    ["HTTP 401", "auth"],
    ["request failed with status code 401", "auth"],
    // the credential was taken and the model refused
    ["AccessDeniedException: You don't have access to the model", "model_refused"],
    ["403 Forbidden: model not available in your region", "model_refused"],
    ["DeploymentNotFound", "model_refused"],
    ["The API deployment for this resource does not exist", "model_refused"],
    ["The model `some-model-4.5` does not exist or you do not have access to it.", "model_refused"],
    ["model_not_found", "model_refused"],
    ["PERMISSION_DENIED: the caller may not use this model", "model_refused"],
    // a rate limit is read before any status number
    ["429 Too Many Requests: 403 of 402 requests used in the last minute", "rate_limited"],
    ["429 Too Many Requests: rate limit reached after 401 errors", "rate_limited"],
    [
      "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'",
      "rate_limited",
    ],
    ["RESOURCE_EXHAUSTED", "rate_limited"],
    // the account or the plan is spent
    ["The usage limit has been reached", "usage_limit"],
    ["insufficient_quota", "usage_limit"],
    ["Your credit balance is too low to access the API", "usage_limit"],
    ["402 Payment Required: account blocked", "usage_limit"],
    ["Insufficient credits", "usage_limit"],
    // unchanged
    ["529 Platform overloaded", "overloaded"],
    ["read ECONNRESET", "transport"],
    ["500 internal error", "other"],
  ] as const)("%s is %s", (text, kind) => {
    expect(providerErrorKind(text)).toBe(kind);
    expect(providerMessageKind(text)).toBe(kind);
  });

  it("a status number never decides alone: it counts only beside a word that says it is one", () => {
    for (const text of ["retried 401 times", "read 401 bytes", "sent 403 tokens", "402"])
      expect(providerErrorKind(text), text).toBe("other");
    expect(AUTH_ERROR_RE.test("401")).toBe(false);
    expect(MODEL_REFUSED_RE.test("403")).toBe(false);
    expect(providerErrorKind("HTTP 403")).toBe("model_refused");
    expect(providerErrorKind('{"statusCode":401}')).toBe("auth");
  });

  it("the engine's counts keep three kinds: every other kind is `other` there", () => {
    expect(
      [
        "The usage limit has been reached",
        "429 Too Many Requests",
        "529 Platform overloaded",
        "401 Unauthorized",
        "403 Forbidden: model not available in your region",
        "read ECONNRESET",
      ].map(coreModelErrorKind),
    ).toEqual(["usage_limit", "rate_limited", "overloaded", "other", "other", "other"]);
  });
});

// What each kind does once the worker has worded it (src/botworker.ts).
describe("a refused credential and a refused model, as the daemon reads them", () => {
  const login = "the round: the provider refused the login: 401 Unauthorized";
  const model =
    "the round: Faux refused the model faux/faux-1. Run on another: qcr model use " +
    "<provider[/model]>, or pin one with [models] model. The provider said: " +
    "403 Forbidden: model not available in your region";

  it("neither is a provider failure a later attempt cures", () => {
    for (const text of [login, model]) {
      expect(providerFailureKind(text), text).toBeUndefined();
      expect(isProviderTransient(text), text).toBe(false);
    }
    expect((["auth", "model_refused"] as const).map(isTransientKind)).toEqual([false, false]);
    expect(isProviderTransientPassError("401 Unauthorized")).toBe(false);
    expect(isProviderTransientPassError("403 Forbidden: model not available")).toBe(false);
  });

  // MUTATION: add "refused the model" to OPERATOR_FAILURE in
  // src/providerfailure.ts - a refused model reads as a refused login's hold;
  // this fails.
  it("a refused login is the operator's hold; a refused model is not the login's", () => {
    expect(isOperatorWorkerFailure(login)).toBe(true);
    expect(isOperatorWorkerFailure(model)).toBe(false);
  });

  it("an output stream that failed on either reads as its own kind, never transient", () => {
    expect(providerFailureKind("the round: output stream failed: 401 Unauthorized")).toBe("auth");
    expect(providerFailureKind("the round: output stream failed: 403 Forbidden")).toBe(
      "model_refused",
    );
    expect(isProviderTransient("the round: output stream failed: 403 Forbidden")).toBe(false);
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
    expect(isProviderTransientPassError("pass pass-security--deep timed out after 8 min")).toBe(
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

describe("boundedProviderError", () => {
  const preamble = "upstream request failed while streaming the response body ".repeat(8);

  // MUTATION: return the plain cut in boundedProviderError (never name the
  // whole message's kind) — a late 429, ECONNRESET or usage-limit qualifier
  // is lost to the cut and the bounded words read as another kind; this fails.
  it.each([
    [`${preamble}: 429 Too Many Requests`, "rate_limited"],
    [`${preamble}: read ECONNRESET`, "transport"],
    [`429 Too Many Requests: ${preamble} the usage limit has been reached`, "usage_limit"],
    [`503 ${preamble} 500 internal error`, "overloaded"],
    [`${preamble} 500 internal error`, "other"],
    [`${preamble} 401 Unauthorized`, "auth"],
    [`${preamble} 403 Forbidden: model not available in your region`, "model_refused"],
  ] as const)("a long message keeps its kind when cut: %#", (message, kind) => {
    const bounded = boundedProviderError(message);
    expect(bounded.length).toBeLessThanOrEqual(330);
    expect(providerMessageKind(message)).toBe(kind);
    expect(providerMessageKind(bounded)).toBe(kind);
  });

  // MUTATION: cut at exactly `max` characters — a 4291 cut to 429 reads as a
  // rate limit the whole message never named; this fails.
  it("cuts on a whole word, so the cut matches nothing the message does not", () => {
    const message = `${"x".repeat(296)} 4291 bytes`;
    expect(providerMessageKind(message)).toBe("other");
    expect(providerMessageKind(boundedProviderError(message))).toBe("other");
  });

  it("leaves a short message whole, its spacing folded", () => {
    expect(boundedProviderError("429  Too Many\nRequests")).toBe("429 Too Many Requests");
  });
});
