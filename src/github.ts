// The GitHub adapter. Reads run directly on the installation token; every
// mutation is expressed as a MutationIntent and pushed through the gate
// (dry-run writes it to state/dryrun/ instead of executing). There is no
// review-dismissal function in this adapter, by design — never add one.
import type { CheckSummary } from "./cigate.js";
import type { Config } from "./config.js";
import { CHECK_THIS_RE, DEFERRED_RE } from "./severity.js";
import { MutationGate, type MutationIntent, type GateResult } from "./gate.js";
import { TokenMinter, type FetchFn } from "./githubAuth.js";

export interface PrConversation {
  body: string;
  labels: string[];
  comments: Array<{ author: string; body: string; created_at: string }>;
}

export interface PrRef {
  number: number;
  title: string;
  author: string;
  head_sha: string;
  /** The branch the PR targets (`base.ref`) — what the review compares against
   * and the branch the worktree keeps fresh each round. */
  base_ref: string;
  /** The PR description: pass-intent's whole intent artifact and
   * the substance-bar input. Optional so long-standing PrRef fakes stay
   * valid; the real adapter always sets it ("" when GitHub returns null). */
  body?: string;
  updated_at: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  labels: string[];
}

export interface RequestedReviewers {
  users: string[];
  teams: string[];
}

export interface StalePr {
  number: number;
  head_sha: string;
  approved_sha: string;
  approved_at: string;
}

export interface PrFileEntry {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
  /** Unified diff for the file when GitHub returns one (absent for binaries). */
  patch?: string;
  /** The path before a rename, when GitHub detected one (renumber detection). */
  previous_filename?: string;
}

export interface ReviewFull {
  id: number;
  user: string;
  /** GitHub's account type ("User" | "Bot") — the human/bot discriminator the
   * capture sweep filters on. Optional: older callers never read it. */
  user_type?: string;
  state: string;
  body: string;
  commit_id: string;
  submitted_at: string | null;
}

export interface ReviewCommentFull {
  id: number;
  user: string;
  /** GitHub's account type — see ReviewFull.user_type. */
  user_type?: string;
  body: string;
  path: string;
  line: number | null;
  pull_request_review_id: number | null;
  in_reply_to_id: number | null;
  /** When GitHub authored it. Optional for the same reason. */
  created_at?: string | null;
}

/** One top-level PR conversation comment (the issues API). Read-only, added
 * for the capture sweep. */
export interface IssueCommentFull {
  id: number;
  user: string;
  user_type: string;
  body: string;
  created_at: string | null;
}

/** One past review by the bot identity, as the importer sees it. */
export interface PrReviewRecord {
  database_id: number;
  state: string;
  submitted_at: string | null;
  body: string;
  commit_oid: string | null;
}

/** A timeline item relevant to trigger reconstruction. */
export interface PrTimelineRecord {
  type: string;
  created_at: string;
  label: string | null;
  actor: string | null;
  requested_team: string | null;
  requested_user: string | null;
}

export interface PrReviewHistory {
  number: number;
  title: string;
  author: string;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merged: boolean;
  reviews: PrReviewRecord[];
  timeline: PrTimelineRecord[];
}

interface RawReviewNode {
  databaseId?: number;
  state?: string;
  submittedAt?: string | null;
  body?: string;
  commit?: { oid?: string } | null;
}

interface RawTimelineNode {
  __typename?: string;
  createdAt?: string;
  label?: { name?: string } | null;
  actor?: { login?: string } | null;
  requestedReviewer?: { slug?: string; login?: string } | null;
}

interface RawPrHistory {
  number?: number;
  title?: string;
  createdAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  merged?: boolean;
  author?: { login?: string } | null;
  reviews?: { nodes?: Array<RawReviewNode | null> } | null;
  timelineItems?: { nodes?: Array<RawTimelineNode | null> } | null;
}

export interface SearchIssueItem {
  number: number;
  title: string;
  user: { login: string; type: string };
  updated_at: string;
  created_at: string;
}

/** One files-API entry (pulls/files and compare share the shape). */
function fileEntry(f: any): PrFileEntry {
  return {
    filename: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    status: f.status,
    ...(typeof f.patch === "string" ? { patch: f.patch } : {}),
    ...(typeof f.previous_filename === "string" ? { previous_filename: f.previous_filename } : {}),
  };
}

export class GitHubAdapter {
  readonly owner: string;
  readonly repo: string;

  constructor(
    private readonly cfg: Config,
    private readonly minter: TokenMinter,
    readonly gate: MutationGate,
    private readonly fetchFn: FetchFn = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {
    const [owner, repo] = cfg.github.repo.split("/");
    if (!owner || !repo) throw new Error(`bad repo: ${cfg.github.repo}`);
    this.owner = owner;
    this.repo = repo;
  }

  // ---- plumbing ----------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown, auth: "installation" | "jwt" = "installation", retried = false): Promise<T> {
    const token = auth === "jwt" ? this.minter.appJwt() : await this.minter.installationToken();
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && auth === "installation" && !retried) {
      this.minter.invalidate();
      return this.request(method, path, body, auth, true);
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.minter.installationToken();
    const res = await this.fetchFn(`${this.apiBase}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`graphql → ${res.status}`);
    const payload = (await res.json()) as { data?: T; errors?: unknown[] };
    if (payload.errors?.length) throw new Error(`graphql errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
    return payload.data as T;
  }

  /** The mutation executor wired into the gate when dry_run is off. */
  executeMutation = async (intent: MutationIntent): Promise<unknown> => {
    if (intent.method === "git") throw new Error("git pushes are executed by the caller, not the REST executor");
    if (intent.path === "/graphql") {
      const body = intent.body as { query?: unknown; variables?: unknown } | undefined;
      if (typeof body?.query !== "string" || typeof body.variables !== "object" || body.variables === null) {
        throw new Error(`invalid GraphQL mutation intent for ${intent.kind}`);
      }
      return this.graphql(body.query, body.variables as Record<string, unknown>);
    }
    return this.request(intent.method, intent.path, intent.body);
  };

  // ---- triggered-set queries (reads) -------------------------------------

  private async searchIssues(q: string): Promise<SearchIssueItem[]> {
    const res = await this.request<{ items: SearchIssueItem[] }>(
      "GET",
      `/search/issues?q=${encodeURIComponent(q)}&per_page=100`,
    );
    return res.items;
  }

  /** Paginated issue search — read-only, used by the history importer (M2).
   * Stops on a short page or after `maxPages` (search caps at 1,000 hits). */
  async searchIssuesPaged(q: string, maxPages = 10): Promise<SearchIssueItem[]> {
    const out: SearchIssueItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request<{ items: SearchIssueItem[] }>(
        "GET",
        `/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
      );
      const items = res.items ?? [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  /** One read-only GraphQL query per PR: the reviews `author` submitted plus
   * the timeline items the backfill importer reconstructs triggers from
   * (§1.1). Returns null when the PR is gone. */
  async prReviewHistory(n: number, author: string): Promise<PrReviewHistory | null> {
    const data = await this.graphql<{ repository?: { pullRequest?: RawPrHistory | null } | null }>(
      `query ($owner: String!, $repo: String!, $number: Int!, $author: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            number title createdAt closedAt mergedAt merged
            author { login }
            reviews(author: $author, first: 100) {
              nodes { databaseId state submittedAt body commit { oid } }
            }
            timelineItems(itemTypes: [LABELED_EVENT, REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT], first: 100) {
              nodes {
                __typename
                ... on LabeledEvent { createdAt label { name } actor { login } }
                ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on Team { slug } ... on User { login } } }
                ... on HeadRefForcePushedEvent { createdAt }
              }
            }
          }
        }
      }`,
      { owner: this.owner, repo: this.repo, number: n, author },
    );
    const pr = data.repository?.pullRequest;
    if (!pr) return null;
    return {
      number: pr.number ?? n,
      title: pr.title ?? "",
      author: pr.author?.login ?? "",
      created_at: pr.createdAt ?? "",
      closed_at: pr.closedAt ?? null,
      merged_at: pr.mergedAt ?? null,
      merged: Boolean(pr.merged),
      reviews: (pr.reviews?.nodes ?? []).filter((r): r is RawReviewNode => Boolean(r)).map((r) => ({
        database_id: r.databaseId ?? 0,
        state: r.state ?? "",
        submitted_at: r.submittedAt ?? null,
        body: r.body ?? "",
        commit_oid: r.commit?.oid ?? null,
      })),
      timeline: (pr.timelineItems?.nodes ?? []).filter((t): t is RawTimelineNode => Boolean(t?.createdAt)).map((t) => ({
        type: t.__typename ?? "",
        created_at: t.createdAt!,
        label: t.label?.name ?? null,
        actor: t.actor?.login ?? null,
        requested_team: t.requestedReviewer?.slug ?? null,
        requested_user: t.requestedReviewer?.login ?? null,
      })),
    };
  }

  /** PRs carrying the trigger label. Bot-authored PRs are excluded — the app
   * can never approve its own PRs (§2). */
  async searchLabelTriggered(): Promise<SearchIssueItem[]> {
    const q = `repo:${this.cfg.github.repo} is:open is:pr label:"${this.cfg.github.trigger_label}" -author:app/${this.cfg.github.app_slug}`;
    return this.searchIssues(q);
  }

  /** PRs with a pending review-team request. */
  async searchTeamTriggered(): Promise<SearchIssueItem[]> {
    const q = `repo:${this.cfg.github.repo} is:open is:pr team-review-requested:${this.cfg.github.review_team} -author:app/${this.cfg.github.app_slug}`;
    return this.searchIssues(q);
  }

  // searchAwaitingEscalationReviewer() was removed on 2026-08-18 with the rest
  // of the escalation mechanics: nothing requests a reviewer any more, so
  // scanning for one told the reconcile pass nothing it owns.

  // ---- authoritative per-PR reads ----------------------------------------

  async getPr(n: number): Promise<PrRef> {
    const pr = await this.request<any>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}`);
    return {
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      head_sha: pr.head.sha,
      base_ref: pr.base?.ref ?? "",
      body: pr.body ?? "",
      updated_at: pr.updated_at,
      state: pr.state,
      draft: pr.draft,
      merged: Boolean(pr.merged),
      labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
    };
  }

  /** Read-only conversation surface for the TUI detail pane (QOL):
   * PR description, labels, and the newest issue comments, oldest-first. */
  async prConversation(n: number, commentCount = 3): Promise<PrConversation> {
    const pr = await this.request<any>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}`);
    const comments = await this.request<any[]>(
      "GET",
      `/repos/${this.owner}/${this.repo}/issues/${n}/comments?per_page=${commentCount}&sort=created&direction=desc`,
    );
    return {
      body: pr.body ?? "",
      labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
      comments: comments
        .map((c) => ({ author: c.user?.login ?? "?", body: c.body ?? "", created_at: c.created_at ?? "" }))
        .reverse(),
    };
  }

  async listOpenPrs(): Promise<PrRef[]> {
    const prs = await this.request<any[]>("GET", `/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100`);
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      head_sha: pr.head.sha,
      base_ref: pr.base?.ref ?? "",
      body: pr.body ?? "",
      updated_at: pr.updated_at,
      state: pr.state,
      draft: pr.draft,
      merged: false,
      labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
    }));
  }

  async getRequestedReviewers(n: number): Promise<RequestedReviewers> {
    const res = await this.request<{ users: Array<{ login: string }>; teams: Array<{ slug: string }> }>(
      "GET",
      `/repos/${this.owner}/${this.repo}/pulls/${n}/requested_reviewers`,
    );
    return { users: res.users.map((u) => u.login), teams: res.teams.map((t) => t.slug) };
  }

  async listPrFiles(n: number): Promise<PrFileEntry[]> {
    const out: PrFileEntry[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<any[]>(
        "GET",
        `/repos/${this.owner}/${this.repo}/pulls/${n}/files?per_page=100&page=${page}`,
      );
      out.push(...batch.map(fileEntry));
      if (batch.length < 100) break;
    }
    return out;
  }

  /**
   * Files a commit range changed (`GET /compare/<base>...<head>`) — the delta
   * source for the post-approval recheck. Read-only, and paginated
   * the same way listPrFiles is; GitHub caps a compare at 300 files, which is
   * far past the point where a delta is "significant" anyway.
   */
  async compareFiles(base: string, head: string): Promise<PrFileEntry[]> {
    const out: PrFileEntry[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.request<{ files?: any[] }>(
        "GET",
        `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
      );
      const batch = res.files ?? [];
      out.push(...batch.map(fileEntry));
      if (batch.length < 100) break;
    }
    return out;
  }

  /**
   * Checks at a ref — check-runs plus the legacy commit statuses, since a repo
   * can gate on either (guard 4). Read-only: CI is consulted, never
   * triggered or re-run.
   */
  async listChecks(ref: string): Promise<CheckSummary[]> {
    const out: CheckSummary[] = [];
    const enc = encodeURIComponent(ref);
    const runs = await this.request<{ check_runs?: any[] }>(
      "GET",
      `/repos/${this.owner}/${this.repo}/commits/${enc}/check-runs?per_page=100`,
    );
    for (const r of runs.check_runs ?? [])
      out.push({ name: r.name ?? "check", status: r.status ?? "", conclusion: r.conclusion ?? null, started_at: r.started_at ?? null });
    const status = await this.request<{ statuses?: any[] }>(
      "GET",
      `/repos/${this.owner}/${this.repo}/commits/${enc}/status?per_page=100`,
    );
    for (const s of status.statuses ?? [])
      // A commit status has no status/conclusion split: `pending` is unfinished,
      // `success`/`failure`/`error` are its conclusions.
      out.push({
        name: s.context ?? "status",
        status: s.state === "pending" ? "pending" : "completed",
        conclusion: s.state === "pending" ? null : s.state === "success" ? "success" : "failure",
      });
    return out;
  }

  async listReviews(n: number): Promise<Array<{ id: number; user: string; state: string; commit_id: string }>> {
    const res = await this.request<any[]>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews?per_page=100`);
    return res.map((r) => ({ id: r.id, user: r.user?.login ?? "", state: r.state, commit_id: r.commit_id }));
  }

  /** Full review rows (bodies included) — read-only, for the compare harness. */
  async listReviewsFull(n: number): Promise<ReviewFull[]> {
    const res = await this.request<any[]>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews?per_page=100`);
    return res.map((r) => ({
      id: r.id,
      user: r.user?.login ?? "",
      user_type: r.user?.type ?? "User",
      state: r.state,
      body: r.body ?? "",
      commit_id: r.commit_id,
      submitted_at: r.submitted_at ?? null,
    }));
  }

  /** Top-level PR conversation comments — read-only, the sweep's
   * third source (the issues API is where GitHub keeps them). */
  async listIssueComments(n: number): Promise<IssueCommentFull[]> {
    const res = await this.request<any[]>("GET", `/repos/${this.owner}/${this.repo}/issues/${n}/comments?per_page=100`);
    return res.map((c) => ({
      id: c.id,
      user: c.user?.login ?? "",
      user_type: c.user?.type ?? "User",
      body: c.body ?? "",
      created_at: c.created_at ?? null,
    }));
  }

  /** Full inline review comments — read-only, for the compare harness. */
  async listReviewCommentsFull(n: number): Promise<ReviewCommentFull[]> {
    const res = await this.request<any[]>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?per_page=100`);
    return res.map((c) => ({
      id: c.id,
      user: c.user?.login ?? "",
      user_type: c.user?.type ?? "User",
      body: c.body ?? "",
      path: c.path ?? "",
      line: c.line ?? c.original_line ?? null,
      pull_request_review_id: c.pull_request_review_id ?? null,
      in_reply_to_id: c.in_reply_to_id ?? null,
      created_at: c.created_at ?? null,
    }));
  }

  /** Review comments the bot authored on a PR — the registry backfill source. */
  async listBotReviewComments(n: number): Promise<number[]> {
    const res = await this.request<any[]>(
      "GET",
      `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?per_page=100`,
    );
    return res.filter((c) => c.user?.login === this.cfg.github.bot_login).map((c) => c.id);
  }

  // ---- staleness scan (GraphQL, ported query) ----------------------------

  /** Open PRs whose latest bot APPROVED review no longer matches the head.
   * Ported from the old flow: `first: 100`, `UPDATED_AT DESC`, review author
   * `example-review[bot]`. */
  async stalenessScan(): Promise<StalePr[]> {
    const q = `repo:${this.cfg.github.repo} is:pr is:open sort:updated-desc`;
    const data = await this.graphql<{
      search: { nodes: Array<{ number?: number; headRefOid?: string; reviews?: { nodes: Array<{ state: string; submittedAt: string; commit: { oid: string } | null }> } }> };
    }>(
      `query ($q: String!, $author: String!) {
        search(query: $q, type: ISSUE, first: 100) {
          nodes {
            ... on PullRequest {
              number
              headRefOid
              reviews(author: $author, states: [APPROVED], last: 1) {
                nodes { state submittedAt commit { oid } }
              }
            }
          }
        }
      }`,
      { q, author: this.cfg.github.bot_login },
    );
    const stale: StalePr[] = [];
    for (const node of data.search.nodes) {
      if (!node.number || !node.headRefOid) continue;
      const review = node.reviews?.nodes?.[0];
      if (!review?.commit) continue;
      if (review.commit.oid !== node.headRefOid) {
        stale.push({ number: node.number, head_sha: node.headRefOid, approved_sha: review.commit.oid, approved_at: review.submittedAt });
      }
    }
    return stale;
  }

  // ---- webhook redeliveries (JWT) ----------------------------------------

  async listWebhookDeliveries(perPage = 100): Promise<Array<{ id: number; guid: string; status: string; delivered_at: string }>> {
    return this.request("GET", `/app/hook/deliveries?per_page=${perPage}`, undefined, "jwt");
  }

  // ---- mutations (all through the gate) ----------------------------------

  async addLabel(n: number, label: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "add_label",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/issues/${n}/labels`,
      body: { labels: [label] },
      note: `add label "${label}" to #${n}`,
      pr: n,
    });
  }

  async removeLabel(n: number, label: string): Promise<GateResult> {
    try {
      return await this.gate.execute({
        kind: "remove_label",
        method: "DELETE",
        path: `/repos/${this.owner}/${this.repo}/issues/${n}/labels/${encodeURIComponent(label)}`,
        note: `remove label "${label}" from #${n}`,
        pr: n,
      });
    } catch (err) {
      // Removing an already-absent label is the outcome we wanted — GitHub's
      // 404 ("Label does not exist") is idempotent success, not an error.
      // Recurring live noise: a label consumed by an earlier failed-dispatch
      // cycle 404s on the retry (#5309/#5314, 2026-08-19).
      if (String(err).includes("404")) return { executed: false, response: { already_absent: label } };
      throw err;
    }
  }

  /** Consume the team trigger: DELETE with the JSON body, then verify. */
  async deleteTeamReviewRequest(n: number): Promise<GateResult> {
    const teamSlug = this.cfg.github.review_team.split("/")[1] ?? this.cfg.github.review_team;
    const result = await this.gate.execute({
      kind: "delete_team_review_request",
      method: "DELETE",
      path: `/repos/${this.owner}/${this.repo}/pulls/${n}/requested_reviewers`,
      body: { reviewers: [], team_reviewers: [teamSlug] },
      note: `clear team review request (${teamSlug}) on #${n}`,
      pr: n,
    });
    if (result.executed) {
      const after = await this.getRequestedReviewers(n);
      if (after.teams.includes(teamSlug)) throw new Error(`team request on #${n} survived DELETE`);
    }
    return result;
  }

  // requestEscalationReview() was removed on 2026-08-18 (the owner: scrap the
  // escalation mechanics). The daemon no longer nominates a human on GitHub;
  // a PR it cannot decide is parked on `awaiting_human` daemon-side and
  // surfaced through the TUI and Slack. The `request_reviewer` gate kind is
  // consequently unreachable — see gate.ts.

  async createReview(n: number, payload: { commit_id: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string; comments?: unknown[] }): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_review",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews`,
      body: payload,
      note: `post ${payload.event} review on #${n}`,
      pr: n,
    });
  }

  async createReviewCommentReply(n: number, commentId: number, body: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_review_comment_reply",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/pulls/${n}/comments/${commentId}/replies`,
      body: { body },
      note: `reply in thread ${commentId} on #${n}`,
      pr: n,
    });
  }

  /** Resolve one inline review thread, but only after a read verifies that the
   * numeric root comment belongs to this PR and was authored by this app.
   * There is intentionally no generic resolve-thread mutation surface. */
  async resolveOwnReviewThread(
    n: number,
    rootCommentId: number,
  ): Promise<{ skipped: "already-resolved" | "check-this-human-only" | "deferred-human-only" | null; result?: GateResult }> {
    const query = `query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            nodes { id isResolved comments(first: 1) { nodes { databaseId author { login } body } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
    type ThreadPage = {
      repository?: { pullRequest?: { reviewThreads?: {
        nodes: Array<{ id: string; isResolved: boolean; comments: { nodes: Array<{ databaseId: number; author?: { login?: string }; body?: string }> } }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } } };
    };
    let after: string | null = null;
    let found: { id: string; isResolved: boolean; author: string; body: string } | undefined;
    do {
      const data: ThreadPage = await this.graphql(query, { owner: this.owner, repo: this.repo, number: n, after });
      const threads = data.repository?.pullRequest?.reviewThreads;
      if (!threads) throw new Error(`review threads unavailable for #${n}`);
      for (const thread of threads.nodes) {
        const root = thread.comments.nodes[0];
        if (root?.databaseId === rootCommentId) {
          found = { id: thread.id, isResolved: thread.isResolved, author: root.author?.login ?? "", body: root.body ?? "" };
          break;
        }
      }
      if (found || !threads.pageInfo.hasNextPage) break;
      after = threads.pageInfo.endCursor;
    } while (after);

    if (!found) throw new Error(`comment ${rootCommentId} is not a review-thread root on #${n}`);
    // GitHub exposes the same App actor with two spellings: review-author
    // filters use the `[bot]` login, while review-thread GraphQL actors use the
    // bare App slug. Both values are independently configured; recognize
    // exactly that pair here and nowhere else. Every unrelated identity stays
    // structurally refused.
    const bareAppActor = this.cfg.github.bot_login === `${this.cfg.github.app_slug}[bot]`
      ? this.cfg.github.app_slug
      : undefined;
    const ownActors = new Set([this.cfg.github.bot_login, bareAppActor].filter((v): v is string => v !== undefined));
    if (!ownActors.has(found.author)) {
      throw new Error(`refusing to resolve thread ${rootCommentId} on #${n}: root author is ${found.author || "unknown"}`);
    }
    // addendum (the owner, 2026-08-19): a "[check this]" thread exists to
    // force a human's eyes before merge (repo rule: every conversation must be
    // resolved). The reviewer NEVER resolves one — author or another human only.
    if (CHECK_THIS_RE.test(found.body)) return { skipped: "check-this-human-only" };
    // (the owner, deferral economics): a "[deferred]" thread says this
    // finding is real and this PR is not where it gets fixed. If the author
    // ignores the drafted ticket, the reviewer must not be able to tidy the
    // thread away — that would make a deferral free again, which is the exact
    // thing this mechanism exists to stop. So it takes the same structural
    // refusal as "[check this]", and the repo's merge rule (every conversation
    // resolved) puts a person in front of it. Distinct marker, distinct reason
    // string: the two are never conflated, here or anywhere.
    if (DEFERRED_RE.test(found.body)) return { skipped: "deferred-human-only" };
    // an "[ask your human]" thread is deliberately NOT refused here.
    // It is the sibling marker, not a second spelling of the one above: it
    // addresses the PR author's AI implementer ("do not answer this yourself —
    // ask a person and bring the answer back"), so what a human owes the thread
    // is the ANSWER, not the resolution. the owner rejected borrowing the
    // human-only machinery for it (§5: it "forces a person into every
    // thread"), and the ordinary path already lands in the right place — the
    // only caller is ping-pong, so the bot resolves such a thread only after
    // the author replied and the session judged the reply settles it. Rule 2 is
    // unaffected: this resolves the bot's OWN finding thread and never
    // dismisses or edits any review, anyone's.
    if (found.isResolved) return { skipped: "already-resolved" };

    const mutation = `mutation ($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
    }`;
    const result = await this.gate.execute({
      kind: "resolve_own_review_thread",
      method: "POST",
      path: "/graphql",
      body: { query: mutation, variables: { threadId: found.id } },
      note: `resolve own review thread ${rootCommentId} on #${n}`,
      pr: n,
    });
    return { skipped: null, result };
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_issue",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/issues`,
      body: { title, body, labels },
      note: `file issue "${title}"`,
    });
  }

  async listOpenBotIssues(): Promise<Array<{ number: number; title: string }>> {
    const q = `repo:${this.cfg.github.repo} is:open is:issue label:"${this.cfg.github.issue_label}"`;
    return (await this.searchIssues(q)).map((i) => ({ number: i.number, title: i.title }));
  }

  async createPull(head: string, base: string, title: string, body: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_pull",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/pulls`,
      body: { head, base, title, body },
      note: `open PR ${head} → ${base}: "${title}"`,
    });
  }
}
