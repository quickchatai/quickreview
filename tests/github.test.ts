import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../src/config.js";
import { MutationGate } from "../src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import type { FetchFn, TokenMinter } from "../src/githubAuth.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg: Config = parseConfig(readFileSync(join(root, "config.toml"), "utf8"));

/** A TokenMinter stand-in — no PEM, no network, no cache logic under test. */
const minter = {
  appJwt: () => "jwt.fake.token",
  installationToken: async () => "ghs_installation",
  invalidate: () => {},
} as unknown as TokenMinter;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function recorder(handler: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    const payload = handler(String(url), init);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

let dryrunDir: string;

beforeEach(() => {
  dryrunDir = mkdtempSync(join(tmpdir(), "qcr-gh-"));
});
afterEach(() => {
  rmSync(dryrunDir, { recursive: true, force: true });
});

function build(handler: (url: string, init: RequestInit) => unknown, dryRun = true) {
  const rec = recorder(handler);
  let adapter!: GitHubAdapter;
  const gate = new MutationGate(dryRun, dryrunDir, (intent) => adapter.executeMutation(intent));
  adapter = new GitHubAdapter(cfg, minter, gate, rec.fetchFn, "https://api.github.com");
  return { adapter, calls: rec.calls };
}

function dryrunRecords() {
  return readdirSync(dryrunDir).map((f) => JSON.parse(readFileSync(join(dryrunDir, f), "utf8")));
}

function queryOf(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
}

describe("triggered-set queries", () => {
  it("excludes the app's own PRs from the label-triggered search", async () => {
    const { adapter, calls } = build(() => ({ items: [{ number: 1 }] }));
    await adapter.searchLabelTriggered();
    const q = queryOf(calls[0]!.url);
    expect(q).toContain("repo:example-org/example-app");
    expect(q).toContain("is:open is:pr");
    expect(q).toContain('label:"AI review requested"');
    expect(q).toContain("-author:app/example-review");
  });

  it("excludes the app's own PRs from the team-requested search", async () => {
    const { adapter, calls } = build(() => ({ items: [] }));
    await adapter.searchTeamTriggered();
    const q = queryOf(calls[0]!.url);
    expect(q).toContain("team-review-requested:example-org/review");
    expect(q).toContain("-author:app/example-review");
  });

  it("replaces the @me qualifier with the named escalation reviewer", async () => {
    const { adapter, calls } = build(() => ({ items: [] }));
    await adapter.searchAwaitingEscalationReviewer();
    const q = queryOf(calls[0]!.url);
    expect(q).toContain("review-requested:mhale");
    expect(q).not.toContain("@me");
  });

  it("searches open bot-filed issues by label", async () => {
    const { adapter, calls } = build(() => ({ items: [{ number: 9, title: "t" }] }));
    expect(await adapter.listOpenBotIssues()).toEqual([{ number: 9, title: "t" }]);
    expect(queryOf(calls[0]!.url)).toContain('label:"bot-filed"');
  });
});

describe("authoritative per-PR reads", () => {
  it("normalizes getPr and requested reviewers", async () => {
    const { adapter } = build((url) => {
      if (url.endsWith("/pulls/12")) {
        return {
          number: 12, title: "T", user: { login: "alice" }, head: { sha: "abc" },
          updated_at: "2026-08-13T10:00:00Z", state: "open", draft: false, merged: false,
          labels: [{ name: "AI review requested" }],
        };
      }
      return { users: [{ login: "mhale" }], teams: [{ slug: "review" }] };
    });

    expect(await adapter.getPr(12)).toEqual({
      number: 12, title: "T", author: "alice", head_sha: "abc",
      updated_at: "2026-08-13T10:00:00Z", state: "open", draft: false, merged: false,
      labels: ["AI review requested"],
    });
    expect(await adapter.getRequestedReviewers(12)).toEqual({ users: ["mhale"], teams: ["review"] });
  });

  it("keeps only the bot's own review comments for the registry backfill", async () => {
    const { adapter } = build(() => [
      { id: 1, user: { login: "example-review[bot]" } },
      { id: 2, user: { login: "alice" } },
      { id: 3, user: { login: "example-review[bot]" } },
    ]);
    expect(await adapter.listBotReviewComments(5)).toEqual([1, 3]);
  });
});

describe("stalenessScan", () => {
  it("keeps only PRs whose approved commit differs from the head", async () => {
    const nodes = [
      { number: 1, headRefOid: "head1", reviews: { nodes: [{ state: "APPROVED", submittedAt: "2026-08-01T00:00:00Z", commit: { oid: "head1" } }] } },
      { number: 2, headRefOid: "head2", reviews: { nodes: [{ state: "APPROVED", submittedAt: "2026-08-02T00:00:00Z", commit: { oid: "older" } }] } },
      { number: 3, headRefOid: "head3", reviews: { nodes: [] } },                       // never approved by the bot
      { number: 4, headRefOid: "head4", reviews: { nodes: [{ state: "APPROVED", submittedAt: "x", commit: null }] } },
      {},                                                                               // non-PR search node
    ];
    const { adapter, calls } = build(() => ({ data: { search: { nodes } } }));

    expect(await adapter.stalenessScan()).toEqual([
      { number: 2, head_sha: "head2", approved_sha: "older", approved_at: "2026-08-02T00:00:00Z" },
    ]);

    const gql = calls[0]!.body as { query: string; variables: Record<string, string> };
    expect(gql.variables.author).toBe("example-review[bot]");
    expect(gql.variables.q).toContain("is:pr is:open sort:updated-desc");
    expect(gql.query).toContain("first: 100");
    expect(gql.query).toContain("states: [APPROVED]");
  });
});

describe("mutations in dry-run", () => {
  it("records the team-request DELETE with the exact JSON body and skips the verify read", async () => {
    const { adapter, calls } = build(() => {
      throw new Error("no fetch may happen in dry-run");
    });

    const result = await adapter.deleteTeamReviewRequest(77);

    expect(result.executed).toBe(false);
    expect(calls).toHaveLength(0);
    const [record] = dryrunRecords();
    expect(record).toMatchObject({
      kind: "delete_team_review_request",
      method: "DELETE",
      path: "/repos/example-org/example-app/pulls/77/requested_reviewers",
      body: { reviewers: [], team_reviewers: ["review"] },
      pr: 77,
    });
  });

  it("routes every mutation through the gate — files written, zero fetches", async () => {
    const { adapter, calls } = build(() => {
      throw new Error("no fetch may happen in dry-run");
    });

    await adapter.addLabel(3, "AI review in progress");
    await adapter.removeLabel(3, "AI review requested");
    await adapter.createReview(3, { commit_id: "sha", event: "REQUEST_CHANGES", body: "b" });
    await adapter.createReviewCommentReply(3, 555, "reply");
    await adapter.createIssue("t", "b", ["bot-filed"]);
    await adapter.createPull("head", "main", "t", "b");
    await adapter.deleteTeamReviewRequest(3);

    expect(calls).toHaveLength(0);
    const kinds = dryrunRecords().map((r) => r.kind).sort();
    expect(kinds).toEqual(
      ["add_label", "create_issue", "create_pull", "create_review", "create_review_comment_reply", "delete_team_review_request", "remove_label"].sort(),
    );
    for (const r of dryrunRecords()) {
      expect(typeof r.note).toBe("string");
      expect(["POST", "DELETE", "PATCH", "PUT", "git"]).toContain(r.method);
    }
  });

  it("URL-encodes the label in the remove-label path", async () => {
    const { adapter } = build(() => ({}));
    await adapter.removeLabel(3, "AI review requested");
    expect(dryrunRecords()[0]!.path).toBe("/repos/example-org/example-app/issues/3/labels/AI%20review%20requested");
  });
});

describe("requestEscalationReview redundancy skips", () => {
  const pr = (author: string) => ({
    number: 8, title: "T", user: { login: author }, head: { sha: "abc" },
    updated_at: "2026-08-13T10:00:00Z", state: "open", draft: false, merged: false, labels: [],
  });

  function harness(author: string, requested: string[], reviewers: string[]) {
    return build((url) => {
      if (url.endsWith("/requested_reviewers")) return { users: requested.map((login) => ({ login })), teams: [] };
      if (url.endsWith("/reviews?per_page=100")) return reviewers.map((login, i) => ({ id: i, user: { login }, state: "COMMENTED", commit_id: "c" }));
      return pr(author);
    });
  }

  it("skips when the PR author is the escalation reviewer", async () => {
    const { adapter } = harness("mhale", [], []);
    expect(await adapter.requestEscalationReview(8)).toEqual({ skipped: "author-is-reviewer" });
    expect(readdirSync(dryrunDir)).toHaveLength(0);
  });

  it("skips when the reviewer is already requested", async () => {
    const { adapter } = harness("alice", ["mhale"], []);
    expect(await adapter.requestEscalationReview(8)).toEqual({ skipped: "already-requested" });
    expect(readdirSync(dryrunDir)).toHaveLength(0);
  });

  it("skips when the reviewer already has a standing review", async () => {
    const { adapter } = harness("alice", [], ["mhale"]);
    expect(await adapter.requestEscalationReview(8)).toEqual({ skipped: "standing-review" });
    expect(readdirSync(dryrunDir)).toHaveLength(0);
  });

  it("records the request when no redundancy applies", async () => {
    const { adapter } = harness("alice", ["bob"], ["carol"]);
    const out = await adapter.requestEscalationReview(8);
    expect(out.skipped).toBeNull();
    expect(out.result!.executed).toBe(false);
    expect(dryrunRecords()[0]).toMatchObject({
      kind: "request_reviewer",
      method: "POST",
      path: "/repos/example-org/example-app/pulls/8/requested_reviewers",
      body: { reviewers: ["mhale"] },
      pr: 8,
    });
  });
});

describe("live mode", () => {
  it("sends the intent through the REST executor and verifies the team DELETE", async () => {
    const { adapter, calls } = build((url) => {
      if (url.endsWith("/requested_reviewers") ) return { users: [], teams: [] };
      return {};
    }, false);

    const result = await adapter.deleteTeamReviewRequest(77);

    expect(result.executed).toBe(true);
    expect(readdirSync(dryrunDir)).toHaveLength(0);
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/example-org/example-app/pulls/77/requested_reviewers",
      method: "DELETE",
      body: { reviewers: [], team_reviewers: ["review"] },
    });
    expect(calls[1]!.method).toBe("GET"); // the verification read
  });

  it("throws when the team request survives the DELETE", async () => {
    const { adapter } = build((url) => {
      if (url.endsWith("/requested_reviewers")) return { users: [], teams: [{ slug: "review" }] };
      return {};
    }, false);
    await expect(adapter.deleteTeamReviewRequest(77)).rejects.toThrow(/survived DELETE/);
  });

  it("refuses to route git pushes through the REST executor", async () => {
    const { adapter } = build(() => ({}), false);
    await expect(
      adapter.gate.execute({ kind: "push_branch", method: "git", path: "refs/heads/x", note: "push" }),
    ).rejects.toThrow(/git pushes/);
  });
});
