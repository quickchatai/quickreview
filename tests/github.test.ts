import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../src/config.js";
import { MutationGate } from "@quickchatai/pi-quickreview/src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import { ThreadResolutionRefusal } from "../src/thread-resolution-refusal.js";
import type { FetchFn, TokenMinter } from "@quickchatai/pi-quickreview/src/githubAuth.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg: Config = parseConfig(readFileSync(join(root, "tests/fixtures/config.toml"), "utf8"));

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
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
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

function build(
  handler: (url: string, init: RequestInit) => unknown,
  dryRun = true,
  githubOverride: Partial<Config["github"]> = {},
) {
  const rec = recorder(handler);
  let adapter!: GitHubAdapter;
  const gate = new MutationGate(dryRun, dryrunDir, (intent) => adapter.executeMutation(intent));
  const adapterCfg: Config = { ...cfg, github: { ...cfg.github, ...githubOverride } };
  adapter = new GitHubAdapter(adapterCfg, minter, gate, rec.fetchFn, "https://api.github.com");
  return { adapter, calls: rec.calls };
}

function buildStatus(status: number, payload: unknown) {
  return buildStatusSequence([{ status, payload }]).adapter;
}

function buildStatusSequence(
  responses: Array<{ status: number; payload: unknown }>,
  dryRun = true,
) {
  const calls: string[] = [];
  let index = 0;
  const fetchFn = (async (url: string | URL) => {
    calls.push(String(url));
    const response = responses[Math.min(index++, responses.length - 1)]!;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.payload,
      text: async () => JSON.stringify(response.payload),
    } as Response;
  }) as unknown as FetchFn;
  let adapter!: GitHubAdapter;
  const gate = new MutationGate(dryRun, dryrunDir, (intent) => adapter.executeMutation(intent));
  adapter = new GitHubAdapter(cfg, minter, gate, fetchFn, "https://api.github.com");
  return { adapter, calls };
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

  it("does not expose an awaiting-reviewer search", () => {
    const { adapter } = build(() => ({ items: [] }));
    expect(
      (adapter as unknown as Record<string, unknown>).searchAwaitingEscalationReviewer,
    ).toBeUndefined();
  });

  it("searches open bot-filed issues by label", async () => {
    const { adapter, calls } = build(() => ({ items: [{ number: 9, title: "t" }] }));
    expect(await adapter.listOpenLabelledIssues()).toEqual([{ number: 9, title: "t" }]);
    expect(queryOf(calls[0]!.url)).toContain('label:"bot-filed"');
  });
});

describe("authoritative per-PR reads", () => {
  it("normalizes getPr and requested reviewers", async () => {
    const { adapter } = build((url) => {
      if (url.endsWith("/pulls/12")) {
        return {
          number: 12,
          title: "T",
          user: { login: "alice" },
          head: { sha: "abc" },
          base: { ref: "master" },
          updated_at: "2026-08-13T10:00:00Z",
          state: "open",
          draft: false,
          merged: false,
          labels: [{ name: "AI review requested" }],
        };
      }
      return { users: [{ login: "mhale" }], teams: [{ slug: "review" }] };
    });

    expect(await adapter.getPr(12)).toEqual({
      number: 12,
      title: "T",
      author: "alice",
      head_sha: "abc",
      base_ref: "master",
      body: "", // no description on the wire normalizes to ""
      updated_at: "2026-08-13T10:00:00Z",
      state: "open",
      draft: false,
      merged: false,
      labels: ["AI review requested"],
    });
    expect(await adapter.getRequestedReviewers(12)).toEqual({
      users: ["mhale"],
      teams: ["review"],
    });
  });

  it("classifies authoritative open, closed and repository-scoped absent PRs", async () => {
    const open = build(() => ({
      number: 12,
      title: "T",
      user: { login: "alice" },
      head: { sha: "abc" },
      base: { ref: "master" },
      updated_at: "2026-08-13T10:00:00Z",
      state: "open",
      draft: false,
      merged: false,
      labels: [],
    })).adapter;
    const closed = build(() => ({
      number: 12,
      title: "T",
      user: { login: "alice" },
      head: { sha: "abc" },
      base: { ref: "master" },
      updated_at: "2026-08-13T10:00:00Z",
      state: "closed",
      draft: false,
      merged: true,
      labels: [],
    })).adapter;

    expect(await open.getPrDisposition(12)).toEqual({ kind: "open", head_sha: "abc" });
    expect(await closed.getPrDisposition(12)).toEqual({ kind: "closed", head_sha: "abc" });
    const absent = buildStatusSequence([
      { status: 404, payload: { message: "Not Found" } },
      { status: 200, payload: { full_name: "example-org/example-app" } },
    ]);
    expect(await absent.adapter.getPrDisposition(999902)).toEqual({ kind: "absent" });
    expect(absent.calls.map((url) => new URL(url).pathname)).toEqual([
      "/repos/example-org/example-app/pulls/999902",
      "/repos/example-org/example-app",
    ]);
  });

  it("does not turn auth, concealed repository access or upstream failures into PR absence", async () => {
    await expect(
      buildStatus(403, { message: "Resource not accessible" }).getPrDisposition(12),
    ).rejects.toThrow("403");
    await expect(buildStatus(500, { message: "upstream" }).getPrDisposition(12)).rejects.toThrow(
      "500",
    );
    const concealed = buildStatusSequence([
      { status: 404, payload: { message: "Not Found" } },
      { status: 404, payload: { message: "Not Found" } },
    ]).adapter;
    await expect(concealed.getPrDisposition(999902)).rejects.toThrow("404");
  });

  it("rejects malformed, cross-PR or mismatched-repository terminal responses", async () => {
    for (const payload of [
      { number: 13, state: "closed", head: { sha: "abc" } },
      { number: 12, state: "closed", head: { sha: "" } },
      { number: 12, state: "closed", head: null },
      { number: 12, state: "mystery", head: { sha: "abc" } },
      null,
    ]) {
      await expect(build(() => payload).adapter.getPrDisposition(12)).rejects.toThrow();
    }
    const wrongRepo = buildStatusSequence([
      { status: 404, payload: { message: "Not Found" } },
      { status: 200, payload: { full_name: "someone/else" } },
    ]).adapter;
    await expect(wrongRepo.getPrDisposition(12)).rejects.toThrow("repository proof mismatch");
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
      {
        number: 1,
        headRefOid: "head1",
        reviews: {
          nodes: [
            { state: "APPROVED", submittedAt: "2026-08-01T00:00:00Z", commit: { oid: "head1" } },
          ],
        },
      },
      {
        number: 2,
        headRefOid: "head2",
        reviews: {
          nodes: [
            { state: "APPROVED", submittedAt: "2026-08-02T00:00:00Z", commit: { oid: "older" } },
          ],
        },
      },
      { number: 3, headRefOid: "head3", reviews: { nodes: [] } }, // never approved by the bot
      {
        number: 4,
        headRefOid: "head4",
        reviews: { nodes: [{ state: "APPROVED", submittedAt: "x", commit: null }] },
      },
      {}, // non-PR search node
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
    await adapter.createIssueComment(3, "answer the objection");
    await adapter.createIssue("t", "b", ["bot-filed"]);
    await adapter.createPull("head", "main", "t", "b");
    await adapter.deleteTeamReviewRequest(3);

    expect(calls).toHaveLength(0);
    const kinds = dryrunRecords()
      .map((r) => r.kind)
      .sort();
    expect(kinds).toEqual(
      [
        "add_label",
        "create_issue",
        "create_pull",
        "create_review",
        "create_review_comment_reply",
        "create_issue_comment",
        "delete_team_review_request",
        "remove_label",
      ].sort(),
    );
    for (const r of dryrunRecords()) {
      expect(typeof r.note).toBe("string");
      expect(["POST", "DELETE", "PATCH", "PUT", "git"]).toContain(r.method);
    }
  });

  it("posts PR-level author answers through the ordinary gate on the issues route", async () => {
    const { adapter, calls } = build(() => ({ id: 999 }), false);
    expect(await adapter.createIssueComment(77, "I concede this finding")).toMatchObject({
      executed: true,
    });
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/example-org/example-app/issues/77/comments",
        method: "POST",
        body: { body: "I concede this finding" },
      },
    ]);
  });

  // Removing an already-absent label 404s — that is idempotent success, not
  // an error to log.
  it("treats a 404 on remove_label as already-removed (live mode)", async () => {
    const { adapter } = buildStatusSequence(
      [{ status: 404, payload: { message: "Label does not exist" } }],
      false,
    );
    const out = await adapter.removeLabel(3, "AI review in progress");
    expect(out.executed).toBe(false);
    expect(out.response).toMatchObject({ already_absent: "AI review in progress" });
  });

  it("still throws non-404 remove_label failures (live mode)", async () => {
    const { adapter } = build(() => {
      throw new Error("DELETE .../labels/x → 500: upstream broke");
    }, false);
    await expect(adapter.removeLabel(3, "AI review in progress")).rejects.toThrow("500");
  });

  it("a 500 on PR #404 is a failure, not an absent label: the status decides, not the path", async () => {
    const { adapter } = buildStatusSequence([{ status: 500, payload: { message: "boom" } }], false);
    await expect(adapter.removeLabel(404, "AI review in progress")).rejects.toThrow("500");
  });

  it("URL-encodes the label in the remove-label path", async () => {
    const { adapter } = build(() => ({}));
    await adapter.removeLabel(3, "AI review requested");
    expect(dryrunRecords()[0]!.path).toBe(
      "/repos/example-org/example-app/issues/3/labels/AI%20review%20requested",
    );
  });
});

describe("resolveOwnReviewThread ownership gate", () => {
  const threadPayload = (
    author = cfg.github.bot_login,
    isResolved = false,
    body = "[blocker] something",
  ) => ({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "PRRT_node",
                isResolved,
                comments: { nodes: [{ databaseId: 555, author: { login: author }, body }] },
              },
            ],
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

  it("accepts the configured bare App actor spelling for the same bot-owned root", async () => {
    const { adapter } = build(() => threadPayload(cfg.github.app_slug));
    expect((await adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
    expect(dryrunRecords()[0]).toMatchObject({ kind: "resolve_own_review_thread", pr: 3 });
  });

  it("does not trust an independently drifted app_slug as an owner alias", async () => {
    const drifted = build(() => threadPayload("alice"), true, { app_slug: "alice" });
    await expect(drifted.adapter.resolveOwnReviewThread(3, 555)).rejects.toThrow(
      "root author is alice",
    );
    expect(dryrunRecords()).toHaveLength(0);
  });

  it.each(["foreign-owner", "missing-root"] as const)(
    "classifies a %s refusal for retry callers",
    async (reason) => {
      const { adapter } = build(() => threadPayload("alice"));
      await expect(
        adapter.resolveOwnReviewThread(3, reason === "missing-root" ? 999 : 555),
      ).rejects.toBeInstanceOf(ThreadResolutionRefusal);
      expect(dryrunRecords()).toHaveLength(0);
    },
  );

  it("refuses another identity's thread and skips an already-resolved own thread", async () => {
    const other = build(() => threadPayload("alice"));
    await expect(other.adapter.resolveOwnReviewThread(3, 555)).rejects.toThrow(
      "root author is alice",
    );
    expect(dryrunRecords()).toHaveLength(0);

    const own = build(() => threadPayload(cfg.github.bot_login, true));
    expect(await own.adapter.resolveOwnReviewThread(3, 555)).toEqual({
      skipped: "already-resolved",
    });
    expect(dryrunRecords()).toHaveLength(0);
  });

  // A [check this] thread is resolved
  // by a human, never by the reviewer — the repo merge rule (every
  // conversation resolved) is what forces human eyes onto it.
  it("never resolves a [check this] thread — human-only, even when bot-owned and unresolved", async () => {
    for (const body of [
      "[check this] auth boundary judgment",
      "  [Check This] casing and leading space",
      "**[check this]** bolded tag",
    ]) {
      const own = build(() => threadPayload(cfg.github.bot_login, false, body));
      expect(await own.adapter.resolveOwnReviewThread(3, 555)).toEqual({
        skipped: "check-this-human-only",
      });
      expect(dryrunRecords()).toHaveLength(0);
    }
    // A mention deeper in the body is not the tag: an ordinary finding whose
    // prose references check-this still resolves normally.
    const ordinary = build(() =>
      threadPayload(cfg.github.bot_login, false, "[question] please [check this] value"),
    );
    expect((await ordinary.adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
  });

  // The sibling tag is author-resolvable. What a
  // human owes an [ask your human] thread is the answer, not the resolution —
  // [check this]'s human-only machinery is not used because it would
  // force a person into every thread. The only caller is ping-pong, so this
  // path is reached only after the author replied.
  it("DOES resolve an [ask your human] thread — that tag is author-resolvable, not human-only", async () => {
    for (const body of [
      "[ask your human] why does this file exist?",
      "[ask your human] [blocker] if the deploy assumes X, writes are dropped",
    ]) {
      const own = build(() => threadPayload(cfg.github.bot_login, false, body));
      expect((await own.adapter.resolveOwnReviewThread(3, 555)).skipped, body).toBeNull();
    }
  });

  it("still refuses when BOTH markers somehow appear — [check this] wins, human-only", async () => {
    const own = build(() =>
      threadPayload(cfg.github.bot_login, false, "[check this] [ask your human] mixed"),
    );
    expect((await own.adapter.resolveOwnReviewThread(3, 555)).skipped).toBe(
      "check-this-human-only",
    );
  });

  // An ignored deferral must not be tidied away by the bot, or a
  // deferral is free again — the exact thing the mechanism exists to stop. Same
  // structural refusal as [check this], its own distinct reason string.
  it("never resolves a [deferred] thread — human-only, with its own reason", async () => {
    for (const body of [
      "[deferred] too big for this PR — ticket drafted below",
      "  [Deferred] casing and leading space",
      "**[deferred]** [question] bolded tag",
    ]) {
      const own = build(() => threadPayload(cfg.github.bot_login, false, body));
      expect(await own.adapter.resolveOwnReviewThread(3, 555)).toEqual({
        skipped: "deferred-human-only",
      });
      expect(dryrunRecords()).toHaveLength(0);
    }
    // A mention deeper in the body is not the tag.
    const ordinary = build(() =>
      threadPayload(cfg.github.bot_login, false, "[nit] this was [deferred] once"),
    );
    expect((await ordinary.adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
  });

  it("keeps the three markers' refusals distinct — none is a spelling of another", async () => {
    const check = build(() =>
      threadPayload(cfg.github.bot_login, false, "[check this] verify the boundary"),
    );
    const deferred = build(() =>
      threadPayload(cfg.github.bot_login, false, "[deferred] not this PR's code"),
    );
    const ask = build(() =>
      threadPayload(cfg.github.bot_login, false, "[ask your human] why does this exist?"),
    );
    expect((await check.adapter.resolveOwnReviewThread(3, 555)).skipped).toBe(
      "check-this-human-only",
    );
    expect((await deferred.adapter.resolveOwnReviewThread(3, 555)).skipped).toBe(
      "deferred-human-only",
    );
    expect((await ask.adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
  });
});

// Reviewer nomination is the optional escalation feature's second delivery
// shape. What this pins is that it is ordinary — a gated mutation with no
// special case anywhere. The guarantee that matters is that nothing here can
// dismiss a review (rule 2, pinned elsewhere).
describe("requesting a human reviewer is an ORDINARY gated mutation", () => {
  it("goes through the gate as request_reviewer, POSTing to requested_reviewers", async () => {
    const { adapter, calls } = build(() => ({}));
    const result = await adapter.requestEscalationReview(8, ["@teammate-one"]);
    // dry_run in this harness ⇒ suppressed to state/dryrun, like every other
    // ordinary kind. Nothing reached GitHub.
    expect(result.executed).toBe(false);
    expect(calls.some((c) => c.url.includes("requested_reviewers"))).toBe(false);
    const files = readdirSync(dryrunDir).filter((f) => f.endsWith("-request_reviewer.json"));
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(dryrunDir, files[0]!), "utf8"));
    expect(rec).toMatchObject({
      kind: "request_reviewer",
      method: "POST",
      path: "/repos/example-org/example-app/pulls/8/requested_reviewers",
      // The leading "@" an operator or a session may write is stripped here,
      // not at the API.
      body: { reviewers: ["teammate-one"] },
      pr: 8,
    });
  });

  it("forceLive still throws on it — the dry-run bypass did not widen", async () => {
    const { adapter } = build(() => ({}));
    const gate = (adapter as unknown as { gate: { execute: (i: unknown) => Promise<unknown> } })
      .gate;
    await expect(
      gate.execute({
        kind: "request_reviewer",
        method: "POST",
        path: "/repos/example-org/example-app/pulls/8/requested_reviewers",
        body: { reviewers: ["teammate-one"] },
        note: "forced",
        pr: 8,
        forceLive: true,
      }),
    ).rejects.toThrow(/forceLive is not allowed/);
  });

  it("dismissing a review is STILL structurally impossible — that half never moved", async () => {
    const { adapter } = build(() => ({}));
    const gate = (adapter as unknown as { gate: { execute: (i: unknown) => Promise<unknown> } })
      .gate;
    for (const kind of ["dismiss_review", "delete_review", "update_review"]) {
      await expect(
        gate.execute({
          kind,
          method: "PUT",
          path: "/repos/o/r/pulls/8/reviews/1/dismissals",
          note: "smuggled",
          pr: 8,
        }),
      ).rejects.toThrow(/unknown mutation kind/);
    }
  });

  it("base_ref rides along on PR reads (the worktree needs it)", async () => {
    const { adapter } = build(() => ({
      number: 8,
      title: "T",
      user: { login: "alice" },
      head: { sha: "abc" },
      base: { ref: "release/2026-08" },
      updated_at: "2026-08-13T10:00:00Z",
      state: "open",
      draft: false,
      merged: false,
      labels: [],
    }));
    expect((await adapter.getPr(8)).base_ref).toBe("release/2026-08");
  });
});

describe("live mode", () => {
  it("sends the intent through the REST executor and verifies the team DELETE", async () => {
    const { adapter, calls } = build((url) => {
      if (url.endsWith("/requested_reviewers")) return { users: [], teams: [] };
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
      adapter.gate.execute({
        kind: "push_branch",
        method: "git",
        path: "refs/heads/x",
        note: "push",
      }),
    ).rejects.toThrow(/git pushes/);
  });
});

describe("the App's own webhook config (app-self-config class)", () => {
  /** Header-aware recorder — the auth split (JWT vs installation) is the point. */
  function buildWithHeaders(handler: (url: string, init: RequestInit) => unknown, dryRun = true) {
    const calls: Array<Call & { auth: string }> = [];
    const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        auth: headers.authorization ?? "",
      });
      const payload = handler(String(url), init);
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    }) as unknown as FetchFn;
    let adapter!: GitHubAdapter;
    const gate = new MutationGate(
      dryRun,
      dryrunDir,
      (intent) => adapter.executeMutation(intent),
      undefined,
      undefined,
      () => {},
    );
    adapter = new GitHubAdapter(cfg, minter, gate, fetchFn, "https://api.github.com");
    return { adapter, calls };
  }

  it("reads GET /app/hook/config directly on the App JWT (never an installation token)", async () => {
    const { adapter, calls } = buildWithHeaders(() => ({
      url: "https://old.example.com/webhook",
      content_type: "json",
      insecure_ssl: "0",
    }));
    const config = await adapter.getAppWebhookConfig();
    expect(config).toEqual({
      url: "https://old.example.com/webhook",
      content_type: "json",
      insecure_ssl: "0",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/app/hook/config",
      method: "GET",
      auth: "Bearer jwt.fake.token",
    });
  });

  it("updateOwnWebhookUrl PATCHes through the gate on the App JWT — and EXECUTES in dry-run (app-self-config)", async () => {
    const { adapter, calls } = buildWithHeaders(
      () => ({ url: "https://new.trycloudflare.com/webhook" }),
      true,
    );
    const result = await adapter.updateOwnWebhookUrl(
      "https://new.trycloudflare.com/webhook",
      "https://old.example.com/webhook",
    );
    // The app-self-config exception (CLAUDE.md rule 1): real execution despite dry-run, no dryrun record.
    expect(result.executed).toBe(true);
    expect(readdirSync(dryrunDir)).toHaveLength(0);
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/app/hook/config",
      method: "PATCH",
      body: { url: "https://new.trycloudflare.com/webhook" },
      auth: "Bearer jwt.fake.token",
    });
  });

  it("the intent's note names old and new URL (the gate's loud line rides it)", async () => {
    const { adapter } = buildWithHeaders(() => ({}));
    const seen: string[] = [];
    const originalExecute = adapter.gate.execute.bind(adapter.gate);
    (adapter.gate as { execute: typeof originalExecute }).execute = async (intent) => {
      seen.push(intent.note);
      return originalExecute(intent);
    };
    await adapter.updateOwnWebhookUrl(
      "https://new.trycloudflare.com/webhook",
      "https://old.example.com/webhook",
    );
    expect(seen[0]).toContain("https://old.example.com/webhook");
    expect(seen[0]).toContain("https://new.trycloudflare.com/webhook");
  });
});

// ---- list reads read every page ------------------------------------------
// Each of these must not read one page (or a fixed ten) and hand the truncated
// list on as the whole. The stub serves `total` rows, 100 per page, and the
// assertion is that every row arrives.

function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get("page") ?? "1");
}

/** Rows `from..to` of a list that is `total` long, in 100-row pages. */
function page<T>(url: string, total: number, row: (i: number) => T): T[] {
  const start = (pageOf(url) - 1) * 100;
  return Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, k) =>
    row(start + k),
  );
}

describe("list reads are paginated", () => {
  it("the triggered-set search reads past the first 100 hits (f904ff07)", async () => {
    const { adapter } = build((url) => ({ items: page(url, 130, (i) => ({ number: i + 1 })) }));
    expect(await adapter.searchLabelTriggered()).toHaveLength(130);
    expect(await adapter.searchTeamTriggered()).toHaveLength(130);
  });

  it("the triggered-set search fails rather than answer a partial set", async () => {
    const incomplete = build(() => ({ incomplete_results: true, items: [{ number: 1 }] })).adapter;
    await expect(incomplete.searchLabelTriggered()).rejects.toThrow(/incomplete/);
    const capped = build((url) => ({
      items: page(url, 5_000, (i) => ({ number: i + 1 })),
    })).adapter;
    await expect(capped.searchTeamTriggered()).rejects.toThrow(/exceeded 10 pages/);
  });

  it("listOpenPrs fails rather than answer a list its page bound cut short", async () => {
    const { adapter } = build((url) =>
      page(url, 5_000, (i) => ({
        number: i + 1,
        title: "t",
        user: { login: "alice" },
        head: { sha: `sha${i}` },
        state: "open",
      })),
    );
    await expect(adapter.listOpenPrs()).rejects.toThrow(/pagination bound/);
  });

  it("the registry backfill reads newest first, so the page bound drops the oldest", async () => {
    const { adapter, calls } = build((url) =>
      page(url, 5_000, (i) => ({ id: 5_000 - i, user: { login: "example-review[bot]" } })),
    );
    const ids = await adapter.listBotReviewComments(7);
    expect(ids[0]).toBe(5_000);
    expect(new URL(calls[0]!.url).searchParams.get("direction")).toBe("desc");
  });

  it("listOpenPrs reads every open PR, not only the newest 100 (c9663a36)", async () => {
    const { adapter } = build((url) =>
      page(url, 250, (i) => ({
        number: i + 1,
        title: "t",
        user: { login: "alice" },
        head: { sha: `sha${i}` },
        state: "open",
        updated_at: "2026-09-01T00:00:00Z",
      })),
    );
    const prs = await adapter.listOpenPrs();
    expect(prs).toHaveLength(250);
    expect(prs.at(-1)!.number).toBe(250);
  });

  it("listPrFiles reads every file GitHub serves — up to its 3,000, not 1,000 (a78c7cba)", async () => {
    const { adapter } = build((url) =>
      page(url, 1_234, (i) => ({
        filename: `f${i}.py`,
        additions: 1,
        deletions: 0,
        status: "modified",
      })),
    );
    const files = await adapter.listPrFiles(7);
    expect(files).toHaveLength(1_234);
    expect(files.at(-1)!.filename).toBe("f1233.py");
  });

  it("listReviews reads every page — a human approval on page 2 still counts for guard 1 (91382fae)", async () => {
    const { adapter } = build((url) =>
      page(url, 140, (i) => ({
        id: i,
        user: { login: i === 139 ? "alex" : "example-review[bot]" },
        state: i === 139 ? "APPROVED" : "COMMENTED",
        commit_id: "head",
      })),
    );
    const reviews = await adapter.listReviews(7);
    expect(reviews).toHaveLength(140);
    expect(reviews.at(-1)).toMatchObject({ user: "alex", state: "APPROVED" });
  });

  it("the comment sweep's issue and inline reads cover every page (cfaf62bf)", async () => {
    const { adapter } = build((url) =>
      page(url, 205, (i) => ({ id: i, user: { login: "alice", type: "User" }, body: `c${i}` })),
    );
    expect(await adapter.listIssueComments(7)).toHaveLength(205);
    expect(await adapter.listReviewCommentsFull(7)).toHaveLength(205);
  });

  it("listReviews has no page bound — a human approval past 3,000 reviews still counts for guard 1", async () => {
    const { adapter } = build((url) =>
      page(url, 3_001, (i) => ({
        id: i,
        user: { login: i === 3_000 ? "alex" : "example-review[bot]" },
        state: i === 3_000 ? "APPROVED" : "COMMENTED",
        commit_id: "head",
      })),
    );
    const reviews = await adapter.listReviews(7);
    expect(reviews).toHaveLength(3_001);
    expect(reviews.at(-1)).toMatchObject({ user: "alex", state: "APPROVED" });
  });

  it("an inline-comment list past the page bound throws — never a partial list the sweep would watermark", async () => {
    const { adapter } = build((url) =>
      page(url, 3_001, (i) => ({ id: i, user: { login: "alice", type: "User" }, body: `c${i}` })),
    );
    await expect(adapter.listReviewCommentsFull(7)).rejects.toThrow(
      /exceeded the pagination bound/,
    );
  });

  it("the newest-first reply lookup reads back to the comment it was given, not one page", async () => {
    // 250 comments, newest first: ids 249 … 0. The reply answers comment 10.
    const { adapter, calls } = build((url) =>
      page(url, 250, (i) => ({ id: 249 - i, user: { login: "alice" }, body: `c${249 - i}` })),
    );
    const all = await adapter.listRecentReviewComments(7, 10);
    expect(all.map((c) => c.id)).toContain(11);
    expect(calls).toHaveLength(3);
    // Without an id: the newest page only.
    expect(await adapter.listRecentReviewComments(7)).toHaveLength(100);
  });

  it("the reply lookup throws when its page bound ends before the comment it was given", async () => {
    const { adapter } = build((url) =>
      page(url, 5_000, (i) => ({ id: 10_000 - i, user: { login: "alice" }, body: "x" })),
    );
    await expect(adapter.listRecentReviewComments(7, 10)).rejects.toThrow(/exceeded 10 pages/);
  });

  it("the registry backfill sees the bot's newest inline comments too (6796b994)", async () => {
    const { adapter } = build((url) =>
      page(url, 150, (i) => ({
        id: i,
        user: { login: i >= 100 ? "example-review[bot]" : "alice" },
      })),
    );
    expect(await adapter.listBotReviewComments(7)).toHaveLength(50);
  });
});

describe("compareFiles says when GitHub truncated the delta (5bd5d43c)", () => {
  // The compare endpoint serves files on page 1 only, capped at 300: a delta
  // that size is a floor, not the delta.
  it("a 300-file compare is flagged truncated", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}`,
      additions: 1,
      deletions: 0,
      status: "modified",
    }));
    const { adapter } = build((url) => ({ files: pageOf(url) === 1 ? files : [] }));
    const delta = await adapter.compareFiles("a", "b");
    expect(delta).toHaveLength(300);
    expect(delta.truncated).toBe(true);
  });

  it("a small compare is not", async () => {
    const { adapter } = build(() => ({
      files: [{ filename: "x", additions: 1, deletions: 0, status: "modified" }],
    }));
    const delta = await adapter.compareFiles("a", "b");
    expect(delta).toHaveLength(1);
    expect(delta.truncated).toBeFalsy();
  });
});

describe("prConversation shows the NEWEST comments (0f257255)", () => {
  // The per-issue comments endpoint ignores sort/direction: it is always
  // oldest-first, so the newest N live on the LAST page.
  it("reads the last page and returns the newest N, oldest-first", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({
      user: { login: "alice" },
      body: `c${i}`,
      created_at: `t${String(i).padStart(3, "0")}`,
    }));
    const { adapter } = build((url) => {
      if (url.includes("/issues/7/comments")) {
        const u = new URL(url);
        const per = Number(u.searchParams.get("per_page") ?? "30");
        const p = Number(u.searchParams.get("page") ?? "1");
        return all.slice((p - 1) * per, p * per);
      }
      return { body: "b", labels: [], comments: 250 };
    });
    const conv = await adapter.prConversation(7, 3);
    expect(conv.comments.map((c) => c.body)).toEqual(["c247", "c248", "c249"]);
  });

  it("straddles a page boundary when the last page is short", async () => {
    const all = Array.from({ length: 201 }, (_, i) => ({ user: { login: "a" }, body: `c${i}` }));
    const { adapter } = build((url) => {
      if (url.includes("/issues/7/comments")) {
        const u = new URL(url);
        const per = Number(u.searchParams.get("per_page") ?? "30");
        const p = Number(u.searchParams.get("page") ?? "1");
        return all.slice((p - 1) * per, p * per);
      }
      return { body: "", labels: [], comments: 201 };
    });
    const conv = await adapter.prConversation(7, 3);
    expect(conv.comments.map((c) => c.body)).toEqual(["c198", "c199", "c200"]);
  });
});

describe("the history GraphQL reads follow pageInfo (990c4c6a, 47b3d525)", () => {
  function graphqlPages(handler: (query: string, vars: Record<string, unknown>) => unknown) {
    return build((_url, init) => {
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      return { data: handler(body.query, body.variables) };
    });
  }

  it("prReviewHistory reads every bot review and every timeline item", async () => {
    const { adapter } = graphqlPages((query, vars) => {
      const reviewsPage = (after: unknown) =>
        after === "r1"
          ? {
              pageInfo: { hasNextPage: false, endCursor: "r2" },
              nodes: [{ databaseId: 2, state: "APPROVED" }],
            }
          : {
              pageInfo: { hasNextPage: true, endCursor: "r1" },
              nodes: [{ databaseId: 1, state: "COMMENTED" }],
            };
      const timelinePage = (after: unknown) =>
        after === "t1"
          ? {
              pageInfo: { hasNextPage: false, endCursor: "t2" },
              nodes: [{ __typename: "LabeledEvent", createdAt: "2" }],
            }
          : {
              pageInfo: { hasNextPage: true, endCursor: "t1" },
              nodes: [{ __typename: "LabeledEvent", createdAt: "1" }],
            };
      const pr: Record<string, unknown> = { number: 7 };
      if (/reviews\(/.test(query)) pr.reviews = reviewsPage(vars.reviewsAfter ?? vars.after);
      if (/timelineItems\(/.test(query))
        pr.timelineItems = timelinePage(vars.timelineAfter ?? vars.after);
      return { repository: { pullRequest: pr } };
    });
    const h = await adapter.prReviewHistory(7, "bot");
    expect(h!.reviews.map((r) => r.database_id)).toEqual([1, 2]);
    expect(h!.timeline.map((t) => t.created_at)).toEqual(["1", "2"]);
  });

  it("a connection still going after the page bound throws rather than answer part of the history", async () => {
    let n = 0;
    const { adapter } = graphqlPages(() => ({
      repository: {
        pullRequest: {
          number: 7,
          reviews: {
            // 60 pages in all: past the bound, but finite.
            pageInfo: { hasNextPage: ++n < 60, endCursor: `r${n}` },
            nodes: [{ databaseId: n, state: "COMMENTED" }],
          },
          timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    }));
    await expect(adapter.prReviewHistory(7, "bot")).rejects.toThrow(/exceeded 50 pages/);
    expect(n).toBe(50);
  });

  it("prReviews reads every review, and every inline comment of a long review", async () => {
    const { adapter } = graphqlPages((query, vars) => {
      if (/node\(id:/.test(query)) {
        return {
          node: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: "c2" },
              nodes: [{ body: "second" }],
            },
          },
        };
      }
      const pr =
        vars.after === "r1"
          ? {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: "r2" },
                nodes: [{ id: "R2", state: "APPROVED", body: "newest", comments: { nodes: [] } }],
              },
            }
          : {
              number: 7,
              reviews: {
                pageInfo: { hasNextPage: true, endCursor: "r1" },
                nodes: [
                  {
                    id: "R1",
                    state: "COMMENTED",
                    body: "oldest",
                    comments: {
                      pageInfo: { hasNextPage: true, endCursor: "c1" },
                      nodes: [{ body: "first" }],
                    },
                  },
                ],
              },
            };
      return { repository: { pullRequest: pr } };
    });
    const r = await adapter.prReviews(7);
    expect(r!.reviews.map((x) => x.body)).toEqual(["oldest", "newest"]);
    expect(r!.reviews[0]!.comments.map((c) => c.body)).toEqual(["first", "second"]);
  });
});

describe("GraphQL rides REST's transport rules", () => {
  function graphqlSequence(responses: Array<{ status: number; payload: unknown }>) {
    const signals: Array<AbortSignal | null | undefined> = [];
    let invalidated = 0;
    let index = 0;
    const fetchFn = (async (_url: string | URL, init: RequestInit = {}) => {
      signals.push(init.signal);
      const r = responses[Math.min(index++, responses.length - 1)]!;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.payload,
        text: async () => JSON.stringify(r.payload),
      } as Response;
    }) as unknown as FetchFn;
    const counting = {
      appJwt: () => "jwt.fake.token",
      installationToken: async () => "ghs_installation",
      invalidate: () => {
        invalidated++;
      },
    } as unknown as TokenMinter;
    let adapter!: GitHubAdapter;
    const gate = new MutationGate(true, dryrunDir, (intent) => adapter.executeMutation(intent));
    adapter = new GitHubAdapter(cfg, counting, gate, fetchFn, "https://api.github.com");
    return { adapter, signals, invalidated: () => invalidated };
  }
  const history = {
    data: {
      repository: {
        pullRequest: {
          number: 7,
          reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
          timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  };

  it("carries a deadline, like every REST request", async () => {
    const { adapter, signals } = graphqlSequence([{ status: 200, payload: history }]);
    await adapter.prReviewHistory(7, "bot");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("a 401 drops the cached token and retries once", async () => {
    const { adapter, invalidated } = graphqlSequence([
      { status: 401, payload: { message: "Bad credentials" } },
      { status: 200, payload: history },
    ]);
    expect((await adapter.prReviewHistory(7, "bot"))?.number).toBe(7);
    expect(invalidated()).toBe(1);
  });

  it("a second 401 fails, and a failure keeps GitHub's own words", async () => {
    const twice = graphqlSequence([{ status: 401, payload: { message: "Bad credentials" } }]);
    await expect(twice.adapter.prReviewHistory(7, "bot")).rejects.toThrow(
      /graphql → 401: .*Bad credentials/,
    );
    expect(twice.invalidated()).toBe(1);
  });
});

describe("filing command reconciliation", () => {
  const marker = "<!-- qcr-filing:abc -->";
  const own = {
    number: 55,
    user: { login: cfg.github.bot_login },
    body: `text\n${marker}`,
    head: { ref: "bot/improve-docs" },
    base: { ref: "main" },
  };
  it("requires our actor, a complete standalone marker, and the exact improvement branch", async () => {
    const { adapter, calls } = build(() => [
      { ...own, number: 1, user: { login: "someone-else" } },
      { ...own, number: 2, body: `quoted ${marker}` },
      { ...own, number: 3, head: { ref: "other" } },
      own,
    ]);
    expect(
      await adapter.findFiledItem("improvement_pr", marker, {
        head: "bot/improve-docs",
        base: "main",
      }),
    ).toBe(55);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls[0]?.url).toContain("state=all");
  });
  it("refuses multiple matching bot receipts and excludes pull requests from issue recovery", async () => {
    const ambiguous = build(() => [own, { ...own, number: 56 }]);
    await expect(ambiguous.adapter.findFiledItem("issue", marker)).rejects.toThrow(
      "ambiguous filing markers",
    );
    const pr = build(() => [{ ...own, pull_request: {} }]);
    expect(await pr.adapter.findFiledItem("issue", marker)).toBeNull();
  });
});

describe("complete GitHub evidence", () => {
  it.each(["check-runs", "status"])(
    "refuses a missing %s array instead of proving empty CI",
    async (endpoint) => {
      const { adapter } = build((url) =>
        url.includes(`/${endpoint}?`) ? {} : { check_runs: [], statuses: [] },
      );
      await expect(adapter.listChecks("a")).rejects.toThrow(/unreadable|incomplete/i);
    },
  );
  it("refuses check rows beyond the declared total count", async () => {
    const { adapter } = build(() => ({
      total_count: 0,
      check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
      statuses: [],
    }));
    await expect(adapter.listChecks("a")).rejects.toThrow(/count/i);
  });
  it("refuses history search explicitly marked incomplete even on a short page", async () => {
    const { adapter } = build(() => ({ incomplete_results: true, items: [] }));
    await expect(adapter.searchIssuesPaged("repo:o/r")).rejects.toThrow(/incomplete/i);
  });
  it.each(["check-runs", "status"])("refuses a saturated %s pagination bound", async (endpoint) => {
    const { adapter } = build((url) =>
      url.includes(`/${endpoint}?`)
        ? endpoint === "check-runs"
          ? {
              check_runs: Array.from({ length: 100 }, () => ({
                name: "ci",
                status: "completed",
                conclusion: "success",
              })),
            }
          : {
              statuses: Array.from({ length: 100 }, () => ({
                context: "legacy-ci",
                state: "success",
              })),
            }
        : { check_runs: [], statuses: [] },
    );
    await expect(adapter.listChecks("a")).rejects.toThrow(/incomplete|page limit/i);
  });
  it("refuses a short checks page that contradicts the advertised count", async () => {
    const { adapter } = build(() => ({ total_count: 101, check_runs: [], statuses: [] }));
    await expect(adapter.listChecks("a")).rejects.toThrow(/incomplete|count/i);
  });
  it.each(["behind", "diverged"])(
    "does not treat %s compare output as a complete two-head delta",
    async (status) => {
      const { adapter } = build(() => ({ status, files: [] }));
      const files = await adapter.compareFiles("approved-head", "rewritten-head");
      expect(files.truncated).toBe(true);
    },
  );
});
