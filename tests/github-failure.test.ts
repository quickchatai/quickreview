import { describe, expect, it } from "vitest";
import {
  classifyGitHubFailure,
  GitHubGraphQLError,
  GitHubRequestError,
  IncompleteReadError,
} from "@quickchatai/pi-quickreview/src/githubcore.js";

const rest = (status: number, detail = "{}", retryAfterMs?: number) =>
  new GitHubRequestError("GET", "/repos/o/r/commits/abc/check-runs", status, detail, retryAfterMs);

function networkError(code: string): TypeError {
  const cause = Object.assign(new Error(`connect ${code} api.github.com`), { code });
  return new TypeError("fetch failed", { cause });
}

describe("classifyGitHubFailure — one classification of a thrown GitHub call", () => {
  it.each([500, 502, 503, 504, 408])("a %i is transient, its status kept", (status) => {
    expect(classifyGitHubFailure(rest(status))).toMatchObject({ kind: "transient", status });
  });

  it("a 429 is rate_limited, and the wait GitHub asked for rides along", () => {
    expect(classifyGitHubFailure(rest(429, "{}", 30_000))).toEqual({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 30_000,
      detail: expect.stringContaining("429"),
    });
  });

  it("a 403 is rate_limited only when GitHub's words say rate limit", () => {
    expect(
      classifyGitHubFailure(rest(403, '{"message":"You have exceeded a secondary rate limit"}'))
        .kind,
    ).toBe("rate_limited");
    expect(
      classifyGitHubFailure(rest(403, '{"message":"API rate limit exceeded for installation"}'))
        .kind,
    ).toBe("rate_limited");
    expect(
      classifyGitHubFailure(rest(403, '{"message":"Resource not accessible by integration"}')).kind,
    ).toBe("rejected");
  });

  // MUTATION: classify a GitHubRequestError by its whole message (request line
  // included) instead of its `detail` — this fails.
  it("a 403 whose request path says rate-limit is still a refusal: the evidence is GitHub's answer", () => {
    const refused = new GitHubRequestError(
      "GET",
      "/repos/o/rate-limit-demo/commits/abc/check-runs",
      403,
      '{"message":"Resource not accessible by integration"}',
    );
    expect(classifyGitHubFailure(refused).kind).toBe("rejected");
    // A plain error that quotes the same request line reads the same way.
    expect(classifyGitHubFailure(new Error(refused.message)).kind).toBe("rejected");
    // A second copy of the class (no `detail` it can trust by type) too.
    const foreign = Object.assign(new Error(refused.message), {
      name: "GitHubRequestError",
      status: 403,
    });
    expect(classifyGitHubFailure(foreign).kind).toBe("rejected");
  });

  it.each([400, 401, 404, 410, 422])("any other 4xx (%i) is rejected", (status) => {
    expect(classifyGitHubFailure(rest(status)).kind).toBe("rejected");
  });

  it("a GitHubRequestError from a second copy of the module classifies by shape", () => {
    const foreign = Object.assign(new Error("GET /x → 502: bad gateway"), {
      name: "GitHubRequestError",
      status: 502,
      retryAfterMs: 1000,
    });
    expect(classifyGitHubFailure(foreign)).toMatchObject({
      kind: "transient",
      status: 502,
      retryAfterMs: 1000,
    });
  });

  it("a timeout or an abort is transient", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(classifyGitHubFailure(timeout).kind).toBe("transient");
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(classifyGitHubFailure(abort).kind).toBe("transient");
  });

  it.each(["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET"])(
    "fetch failed over %s is transient, the code named in the detail",
    (code) => {
      const f = classifyGitHubFailure(networkError(code));
      expect(f.kind).toBe("transient");
      expect(f.detail).toContain(code);
    },
  );

  it("a bare fetch TypeError and a socket hang up are transient", () => {
    expect(classifyGitHubFailure(new TypeError("fetch failed")).kind).toBe("transient");
    expect(classifyGitHubFailure(new Error("socket hang up")).kind).toBe("transient");
  });

  it("an inconsistent paginated snapshot is transient", () => {
    expect(classifyGitHubFailure(new IncompleteReadError("check runs moved")).kind).toBe(
      "transient",
    );
  });

  it("GraphQL 200-with-errors: RATE_LIMITED, Something went wrong, a typed refusal", () => {
    expect(classifyGitHubFailure(new GitHubGraphQLError([{ type: "RATE_LIMITED" }])).kind).toBe(
      "rate_limited",
    );
    expect(
      classifyGitHubFailure(
        new GitHubGraphQLError([{ message: "Something went wrong while executing your query." }]),
      ).kind,
    ).toBe("transient");
    expect(
      classifyGitHubFailure(new GitHubGraphQLError([{ message: "Timeout on validation of query" }]))
        .kind,
    ).toBe("transient");
    expect(
      classifyGitHubFailure(
        new GitHubGraphQLError([{ type: "NOT_FOUND", message: "Could not resolve to a node" }]),
      ).kind,
    ).toBe("rejected");
  });

  it("a plain error that names a GitHub status classifies by that status", () => {
    expect(classifyGitHubFailure(new Error("graphql → 502")).kind).toBe("transient");
    expect(classifyGitHubFailure(new Error("graphql → 429")).kind).toBe("rate_limited");
    expect(classifyGitHubFailure(new Error("graphql → 404: Not Found")).kind).toBe("rejected");
    expect(
      classifyGitHubFailure(new Error('graphql errors: [{"code":"graphql_rate_limit"}]')).kind,
    ).toBe("rate_limited");
    expect(
      classifyGitHubFailure(new Error('graphql errors: [{"message":"Something went wrong"}]')).kind,
    ).toBe("transient");
  });

  it("anything else is unknown — a programming error is not a GitHub answer", () => {
    expect(classifyGitHubFailure(new TypeError("x is not a function")).kind).toBe("unknown");
    expect(classifyGitHubFailure("boom").kind).toBe("unknown");
    expect(classifyGitHubFailure(undefined).kind).toBe("unknown");
  });

  it("the detail is short and never carries a credential", () => {
    const f = classifyGitHubFailure(
      new Error(`graphql → 502: ghs_abcdefghijklmnop0123 ${"x".repeat(500)}`),
    );
    expect(f.detail.length).toBeLessThanOrEqual(200);
    expect(f.detail).not.toContain("ghs_abcdefghijklmnop0123");
    const g = classifyGitHubFailure(new Error("auth Bearer abc.def.ghi123 failed → 401"));
    expect(g.detail).not.toContain("abc.def.ghi123");
    expect(g.detail).not.toMatch(/\s{2,}/);
  });
});
