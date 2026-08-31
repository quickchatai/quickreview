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

function build(handler: (url: string, init: RequestInit) => unknown, dryRun = true, githubOverride: Partial<Config["github"]> = {}) {
  const rec = recorder(handler);
  let adapter!: GitHubAdapter;
  const gate = new MutationGate(dryRun, dryrunDir, (intent) => adapter.executeMutation(intent));
  const adapterCfg: Config = { ...cfg, github: { ...cfg.github, ...githubOverride } };
  adapter = new GitHubAdapter(adapterCfg, minter, gate, rec.fetchFn, "https://api.github.com");
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
      body: "", //: no description on the wire normalizes to ""
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

  // Live noise fix (2026-08-19, #5309/#5314): removing an already-absent
  // label 404s — that is idempotent success, not an error to log.
  it("treats a 404 on remove_label as already-removed (live mode)", async () => {
    const { adapter } = build(() => {
      const err = new Error('DELETE .../labels/x → 404: {"message":"Label does not exist"}');
      throw err;
    }, false);
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

  it("URL-encodes the label in the remove-label path", async () => {
    const { adapter } = build(() => ({}));
    await adapter.removeLabel(3, "AI review requested");
    expect(dryrunRecords()[0]!.path).toBe("/repos/example-org/example-app/issues/3/labels/AI%20review%20requested");
  });
});

describe("resolveOwnReviewThread ownership gate", () => {
  const threadPayload = (author = cfg.github.bot_login, isResolved = false, body = "[blocker] something") => ({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ id: "PRRT_node", isResolved, comments: { nodes: [{ databaseId: 555, author: { login: author }, body }] } }],
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
    await expect(drifted.adapter.resolveOwnReviewThread(3, 555)).rejects.toThrow("root author is alice");
    expect(dryrunRecords()).toHaveLength(0);
  });

  it("refuses another identity's thread and skips an already-resolved own thread", async () => {
    const other = build(() => threadPayload("alice"));
    await expect(other.adapter.resolveOwnReviewThread(3, 555)).rejects.toThrow("root author is alice");
    expect(dryrunRecords()).toHaveLength(0);

    const own = build(() => threadPayload(cfg.github.bot_login, true));
    expect(await own.adapter.resolveOwnReviewThread(3, 555)).toEqual({ skipped: "already-resolved" });
    expect(dryrunRecords()).toHaveLength(0);
  });

  // addendum (the owner, 2026-08-19): a [check this] thread is resolved
  // by a human, never by the reviewer — the repo merge rule (every
  // conversation resolved) is what forces human eyes onto it.
  it("never resolves a [check this] thread — human-only, even when bot-owned and unresolved", async () => {
    for (const body of ["[check this] auth boundary judgment", "  [Check This] casing and leading space", "**[check this]** bolded tag"]) {
      const own = build(() => threadPayload(cfg.github.bot_login, false, body));
      expect(await own.adapter.resolveOwnReviewThread(3, 555)).toEqual({ skipped: "check-this-human-only" });
      expect(dryrunRecords()).toHaveLength(0);
    }
    // A mention deeper in the body is not the tag: an ordinary finding whose
    // prose references check-this still resolves normally.
    const ordinary = build(() => threadPayload(cfg.github.bot_login, false, "[question] please [check this] value"));
    expect((await ordinary.adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
  });

  // (decided §5): the sibling tag is AUTHOR-RESOLVABLE. What a
  // human owes an [ask your human] thread is the ANSWER, not the resolution —
  // borrowing [check this]'s human-only machinery was rejected because it
  // forces a person into every thread. The only caller is ping-pong, so this
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
    const own = build(() => threadPayload(cfg.github.bot_login, false, "[check this] [ask your human] mixed"));
    expect((await own.adapter.resolveOwnReviewThread(3, 555)).skipped).toBe("check-this-human-only");
  });

  // an IGNORED deferral must not be tidied away by the bot, or a
  // deferral is free again — the exact thing the mechanism exists to stop. Same
  // structural refusal as [check this], its own distinct reason string.
  it("never resolves a [deferred] thread — human-only, with its own reason", async () => {
    for (const body of [
      "[deferred] too big for this PR — ticket drafted below",
      "  [Deferred] casing and leading space",
      "**[deferred]** [question] bolded tag",
    ]) {
      const own = build(() => threadPayload(cfg.github.bot_login, false, body));
      expect(await own.adapter.resolveOwnReviewThread(3, 555)).toEqual({ skipped: "deferred-human-only" });
      expect(dryrunRecords()).toHaveLength(0);
    }
    // A mention deeper in the body is not the tag.
    const ordinary = build(() => threadPayload(cfg.github.bot_login, false, "[nit] this was [deferred] once"));
    expect((await ordinary.adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
  });

  it("keeps the three markers' refusals distinct — none is a spelling of another", async () => {
    const check = build(() => threadPayload(cfg.github.bot_login, false, "[check this] verify the boundary"));
    const deferred = build(() => threadPayload(cfg.github.bot_login, false, "[deferred] not this PR's code"));
    const ask = build(() => threadPayload(cfg.github.bot_login, false, "[ask your human] why does this exist?"));
    expect((await check.adapter.resolveOwnReviewThread(3, 555)).skipped).toBe("check-this-human-only");
    expect((await deferred.adapter.resolveOwnReviewThread(3, 555)).skipped).toBe("deferred-human-only");
    expect((await ask.adapter.resolveOwnReviewThread(3, 555)).skipped).toBeNull();
  });
});

// (2026-08-31): reviewer nomination came back as the optional
// escalation feature's second delivery shape, and this describe changed with
// it. What it pins now is that the return is ORDINARY — a gated mutation with
// no special case anywhere — because "the gate rejects it" is no longer the
// guarantee. It never was the interesting one: the interesting one is that
// nothing here can dismiss a review (rule 2, unchanged and pinned elsewhere).
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
    const gate = (adapter as unknown as { gate: { execute: (i: unknown) => Promise<unknown> } }).gate;
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
    const gate = (adapter as unknown as { gate: { execute: (i: unknown) => Promise<unknown> } }).gate;
    for (const kind of ["dismiss_review", "delete_review", "update_review"]) {
      await expect(
        gate.execute({ kind, method: "PUT", path: "/repos/o/r/pulls/8/reviews/1/dismissals", note: "smuggled", pr: 8 }),
      ).rejects.toThrow(/unknown mutation kind/);
    }
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
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
    }) as unknown as FetchFn;
    let adapter!: GitHubAdapter;
    const gate = new MutationGate(dryRun, dryrunDir, (intent) => adapter.executeMutation(intent), undefined, undefined, () => {});
    adapter = new GitHubAdapter(cfg, minter, gate, fetchFn, "https://api.github.com");
    return { adapter, calls };
  }

  it("reads GET /app/hook/config directly on the App JWT (never an installation token)", async () => {
    const { adapter, calls } = buildWithHeaders(() => ({ url: "https://old.example.com/webhook", content_type: "json", insecure_ssl: "0" }));
    const config = await adapter.getAppWebhookConfig();
    expect(config).toEqual({ url: "https://old.example.com/webhook", content_type: "json", insecure_ssl: "0" });
    expect(calls[0]).toMatchObject({ url: "https://api.github.com/app/hook/config", method: "GET", auth: "Bearer jwt.fake.token" });
  });

  it("updateOwnWebhookUrl PATCHes through the gate on the App JWT — and EXECUTES in dry-run (app-self-config)", async () => {
    const { adapter, calls } = buildWithHeaders(() => ({ url: "https://new.trycloudflare.com/webhook" }), true);
    const result = await adapter.updateOwnWebhookUrl("https://new.trycloudflare.com/webhook", "https://old.example.com/webhook");
    // The ratified rule-1 amendment: real execution despite dry-run, no dryrun record.
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
    await adapter.updateOwnWebhookUrl("https://new.trycloudflare.com/webhook", "https://old.example.com/webhook");
    expect(seen[0]).toContain("https://old.example.com/webhook");
    expect(seen[0]).toContain("https://new.trycloudflare.com/webhook");
  });
});
