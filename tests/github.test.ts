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

  it("no longer exposes the awaiting-reviewer search (scrapped 2026-08-18)", () => {
    const { adapter } = build(() => ({ items: [] }));
    expect((adapter as unknown as Record<string, unknown>).searchAwaitingEscalationReviewer).toBeUndefined();
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
          number: 12, title: "T", user: { login: "alice" }, head: { sha: "abc" }, base: { ref: "master" },
          updated_at: "2026-08-13T10:00:00Z", state: "open", draft: false, merged: false,
          labels: [{ name: "AI review requested" }],
        };
      }
      return { users: [{ login: "mhale" }], teams: [{ slug: "review" }] };
    });

    expect(await adapter.getPr(12)).toEqual({
      number: 12, title: "T", author: "alice", head_sha: "abc", base_ref: "master",
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

describe("resolveOwnReviewThread ownership gate", () => {
  const threadPayload = (author = cfg.github.bot_login, isResolved = false) => ({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ id: "PRRT_node", isResolved, comments: { nodes: [{ databaseId: 555, author: { login: author } }] } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });

  it("records a gated GraphQL resolve only after verifying a bot-owned root", async () => {
    const { adapter, calls } = build(() => threadPayload());
    const out = await adapter.resolveOwnReviewThread(3, 555);
    expect(out.skipped).toBeNull();
    expect(calls).toHaveLength(1); // ownership read; mutation is dry-run recorded
    expect(dryrunRecords()[0]).toMatchObject({
      kind: "resolve_own_review_thread",
      method: "POST",
      path: "/graphql",
      pr: 3,
      body: { variables: { threadId: "PRRT_node" } },
    });
  });

  it("refuses another identity's thread and skips an already-resolved own thread", async () => {
    const other = build(() => threadPayload("alice"));
    await expect(other.adapter.resolveOwnReviewThread(3, 555)).rejects.toThrow("root author is alice");
    expect(dryrunRecords()).toHaveLength(0);

    const own = build(() => threadPayload(cfg.github.bot_login, true));
    expect(await own.adapter.resolveOwnReviewThread(3, 555)).toEqual({ skipped: "already-resolved" });
    expect(dryrunRecords()).toHaveLength(0);
  });
});

describe("nominating a human reviewer is structurally impossible", () => {
  it("the adapter has no requestEscalationReview method", () => {
    const { adapter } = build(() => ({}));
    expect((adapter as unknown as Record<string, unknown>).requestEscalationReview).toBeUndefined();
  });

  it("the gate rejects a hand-rolled request_reviewer mutation", async () => {
    const { adapter } = build(() => ({}));
    const gate = (adapter as unknown as { gate: { execute: (i: unknown) => Promise<unknown> } }).gate;
    await expect(
      gate.execute({
        kind: "request_reviewer",
        method: "POST",
        path: "/repos/example-org/example-app/pulls/8/requested_reviewers",
        body: { reviewers: ["mhale"] },
        note: "smuggled",
        pr: 8,
      }),
    ).rejects.toThrow();
    expect(readdirSync(dryrunDir)).toHaveLength(0);
  });

  it("base_ref rides along on PR reads (the worktree needs it)", async () => {
    const { adapter } = build(() => ({
      number: 8, title: "T", user: { login: "alice" }, head: { sha: "abc" }, base: { ref: "release/2026-08" },
      updated_at: "2026-08-13T10:00:00Z", state: "open", draft: false, merged: false, labels: [],
    }));
    expect((await adapter.getPr(8)).base_ref).toBe("release/2026-08");
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
