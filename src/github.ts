// The GitHub adapter. Reads run directly on the installation token; every
// mutation is expressed as a MutationIntent and pushed through the gate
// (dry-run writes it to state/dryrun/ instead of executing). There is no
// review-dismissal function in this adapter, by design — never add one.
import type { CheckSummary } from "./cigate.js";
import type { Config } from "./config.js";
import { CHECK_THIS_RE, DEFERRED_RE } from "./severity.js";
import {
  APP_SELF_CONFIG_KINDS,
  type MutationGate,
  type MutationIntent,
  type GateResult,
} from "./gate.js";
import { type TokenMinter, type FetchFn } from "./githubAuth.js";
import type { PrReviews } from "./reviewhistory.js";

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

/** The App's own webhook configuration (`GET /app/hook/config`, JWT-authed). */
export interface AppWebhookConfig {
  url: string;
  content_type: string;
  insecure_ssl: string;
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

function toReviewCommentFull(c: any): ReviewCommentFull {
  return {
    id: c.id,
    user: c.user?.login ?? "",
    user_type: c.user?.type ?? "User",
    body: c.body ?? "",
    path: c.path ?? "",
    line: c.line ?? c.original_line ?? null,
    pull_request_review_id: c.pull_request_review_id ?? null,
    in_reply_to_id: c.in_reply_to_id ?? null,
    created_at: c.created_at ?? null,
  };
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

/** A GraphQL connection as the history queries request it: nodes plus the
 * cursor to continue from. */
interface Connection<N> {
  nodes?: Array<N | null>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/** Hard stop for a connection walk — a server that keeps answering
 * hasNextPage with a cursor that never ends cannot loop forever. */
const MAX_CONNECTION_PAGES = 50;

/** Every node of a connection: the first page as already fetched, then each
 * `next(cursor)` until GitHub says there is no next page. */
async function walkConnection<N>(
  first: Connection<N> | null | undefined,
  next: (after: string) => Promise<Connection<N> | null | undefined>,
): Promise<N[]> {
  const out: N[] = [];
  let conn = first;
  for (let page = 0; conn && page < MAX_CONNECTION_PAGES; page++) {
    out.push(...(conn.nodes ?? []).filter((n): n is N => n !== null && n !== undefined));
    const info = conn.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    conn = await next(info.endCursor);
  }
  return out;
}

/** Selection sets shared by a history query's first page and its follow-ups,
 * so the two can never request different fields. */
const HISTORY_REVIEWS_BODY =
  "pageInfo { hasNextPage endCursor } nodes { databaseId state submittedAt body commit { oid } }";
const HISTORY_TIMELINE_BODY = `pageInfo { hasNextPage endCursor }
              nodes {
                __typename
                ... on LabeledEvent { createdAt label { name } actor { login } }
                ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on Team { slug } ... on User { login } } }
                ... on HeadRefForcePushedEvent { createdAt }
              }`;
const DIGEST_COMMENTS_BODY =
  "pageInfo { hasNextPage endCursor } nodes { author { __typename login } path body }";
const DIGEST_REVIEWS_BODY = `pageInfo { hasNextPage endCursor }
              nodes {
                id author { __typename login } state submittedAt body
                comments(first: 100) { ${DIGEST_COMMENTS_BODY} }
              }`;

/** GitHub serves a compare's changed files on its first page only, capped at
 * this many. A list that long is a floor, not the delta. */
export const COMPARE_FILES_CAP = 300;

/** GitHub serves at most this many pages of 100 from `pulls/<n>/files`. */
const PR_FILES_MAX_PAGES = 30;

/** A file list that may have been cut short by GitHub's own cap. */
export type FileList = PrFileEntry[] & { truncated?: boolean };

interface RawPrHistory {
  number?: number;
  title?: string;
  createdAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  merged?: boolean;
  author?: { login?: string } | null;
  reviews?: Connection<RawReviewNode> | null;
  timelineItems?: Connection<RawTimelineNode> | null;
}

export type PrDisposition = { kind: "open" | "closed"; head_sha: string } | { kind: "absent" };

export class GitHubRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${method} ${path} → ${status}: ${detail}`);
    this.name = "GitHubRequestError";
  }
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    auth: "installation" | "jwt" = "installation",
    retried = false,
  ): Promise<T> {
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
    if (!res.ok)
      throw new GitHubRequestError(method, path, res.status, (await res.text()).slice(0, 300));
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
    if (payload.errors?.length)
      throw new Error(`graphql errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
    return payload.data as T;
  }

  /** The mutation executor the gate runs when it decides a mutation is real —
   * every kind in live mode, and the app-self-config class in
   * dry-run too. The gate, never a call site, makes that decision. */
  executeMutation = async (intent: MutationIntent): Promise<unknown> => {
    if (intent.method === "git")
      throw new Error("git pushes are executed by the caller, not the REST executor");
    if (intent.path === "/graphql") {
      const body = intent.body as { query?: unknown; variables?: unknown } | undefined;
      if (
        typeof body?.query !== "string" ||
        typeof body.variables !== "object" ||
        body.variables === null
      ) {
        throw new Error(`invalid GraphQL mutation intent for ${intent.kind}`);
      }
      return this.graphql(body.query, body.variables as Record<string, unknown>);
    }
    // App-self-config intents address the App's OWN configuration:
    // GitHub authenticates those routes with the App JWT, not an installation
    // token — the same auth split request() already carries for the
    // /app/hook/deliveries read.
    const auth = (APP_SELF_CONFIG_KINDS as readonly string[]).includes(intent.kind)
      ? "jwt"
      : "installation";
    return this.request(intent.method, intent.path, intent.body, auth);
  };

  // ---- triggered-set queries (reads) -------------------------------------

  /** Every hit, not the first 100: the reconcile pass reads a PR missing from
   * this list as trigger-ABSENT, so a truncated page would fake an absent →
   * present edge the moment search order reshuffled it back in. */
  private async searchIssues(q: string): Promise<SearchIssueItem[]> {
    return this.searchIssuesPaged(q);
  }

  /** Every page of a list endpoint that answers a bare JSON array. `path`
   * carries `per_page=100`; a short page ends the read and `maxPages` bounds
   * it — `truncated` says the bound, not the list, ended it. */
  private async pagedArray<T = any>(
    path: string,
    maxPages = 30,
  ): Promise<{ rows: T[]; truncated: boolean }> {
    const rows: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<T[]>("GET", `${path}&page=${page}`);
      rows.push(...batch);
      if (batch.length < 100) return { rows, truncated: false };
    }
    return { rows, truncated: true };
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
            reviews(author: $author, first: 100) { ${HISTORY_REVIEWS_BODY} }
            timelineItems(itemTypes: [LABELED_EVENT, REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT], first: 100) { ${HISTORY_TIMELINE_BODY} }
          }
        }
      }`,
      { owner: this.owner, repo: this.repo, number: n, author },
    );
    const pr = data.repository?.pullRequest;
    if (!pr) return null;
    // A long PR's bot reviews run past 100 (every thread reply is a review):
    // follow the cursors, or the importer silently loses the NEWEST ones.
    const vars = { owner: this.owner, repo: this.repo, number: n, author };
    const reviews = await walkConnection(pr.reviews, async (after) => {
      const d = await this.graphql<{ repository?: { pullRequest?: RawPrHistory | null } | null }>(
        `query ($owner: String!, $repo: String!, $number: Int!, $author: String!, $after: String!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(author: $author, first: 100, after: $after) { ${HISTORY_REVIEWS_BODY} }
            }
          }
        }`,
        { ...vars, after },
      );
      return d.repository?.pullRequest?.reviews;
    });
    const timeline = await walkConnection(pr.timelineItems, async (after) => {
      const d = await this.graphql<{ repository?: { pullRequest?: RawPrHistory | null } | null }>(
        `query ($owner: String!, $repo: String!, $number: Int!, $after: String!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              timelineItems(itemTypes: [LABELED_EVENT, REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT], first: 100, after: $after) { ${HISTORY_TIMELINE_BODY} }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, number: n, after },
      );
      return d.repository?.pullRequest?.timelineItems;
    });
    return {
      number: pr.number ?? n,
      title: pr.title ?? "",
      author: pr.author?.login ?? "",
      created_at: pr.createdAt ?? "",
      closed_at: pr.closedAt ?? null,
      merged_at: pr.mergedAt ?? null,
      merged: Boolean(pr.merged),
      reviews: reviews.map((r) => ({
          database_id: r.databaseId ?? 0,
          state: r.state ?? "",
          submitted_at: r.submittedAt ?? null,
          body: r.body ?? "",
          commit_oid: r.commit?.oid ?? null,
        })),
      timeline: timeline
        .filter((t) => Boolean(t.createdAt))
        .map((t) => ({
          type: t.__typename ?? "",
          created_at: t.createdAt!,
          label: t.label?.name ?? null,
          actor: t.actor?.login ?? null,
          requested_team: t.requestedReviewer?.slug ?? null,
          requested_user: t.requestedReviewer?.login ?? null,
        })),
    };
  }

  /** One read-only GraphQL query per PR for the review history digest
   *: EVERY author's reviews, each with its inline comments, and the
   * author's type so the digest can keep people and drop Apps. Returns null
   * when the PR is gone. */
  async prReviews(n: number): Promise<PrReviews | null> {
    interface RawAuthor {
      __typename?: string;
      login?: string;
    }
    interface RawComment {
      author?: RawAuthor | null;
      path?: string | null;
      body?: string;
    }
    interface RawReview {
      id?: string;
      author?: RawAuthor | null;
      state?: string;
      submittedAt?: string | null;
      body?: string;
      comments?: Connection<RawComment> | null;
    }
    interface RawPr {
      number?: number;
      title?: string;
      mergedAt?: string | null;
      author?: { login?: string } | null;
      reviews?: Connection<RawReview> | null;
    }
    const data = await this.graphql<{ repository?: { pullRequest?: RawPr | null } | null }>(
      `query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            number title mergedAt
            author { login }
            reviews(first: 100) { ${DIGEST_REVIEWS_BODY} }
          }
        }
      }`,
      { owner: this.owner, repo: this.repo, number: n },
    );
    const pr = data.repository?.pullRequest;
    if (!pr) return null;
    // Reviews come oldest-first, so a truncated read drops the NEWEST human
    // feedback — follow the cursors, and each long review's comment cursor.
    const rawReviews = await walkConnection(pr.reviews, async (after) => {
      const d = await this.graphql<{ repository?: { pullRequest?: RawPr | null } | null }>(
        `query ($owner: String!, $repo: String!, $number: Int!, $after: String!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $after) { ${DIGEST_REVIEWS_BODY} }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, number: n, after },
      );
      return d.repository?.pullRequest?.reviews;
    });
    const commentsOf = (r: RawReview): Promise<RawComment[]> =>
      walkConnection(r.comments, async (after) => {
        if (!r.id) return null;
        const d = await this.graphql<{ node?: { comments?: Connection<RawComment> | null } | null }>(
          `query ($id: ID!, $after: String!) {
            node(id: $id) { ... on PullRequestReview { comments(first: 100, after: $after) { ${DIGEST_COMMENTS_BODY} } } }
          }`,
          { id: r.id, after },
        );
        return d.node?.comments;
      });
    const reviews: Array<{ r: RawReview; comments: RawComment[] }> = [];
    for (const r of rawReviews) reviews.push({ r, comments: await commentsOf(r) });
    const author = (a: RawAuthor | null | undefined): { login: string; type: string } | null =>
      a ? { login: a.login ?? "", type: a.__typename ?? "" } : null;
    return {
      number: pr.number ?? n,
      title: pr.title ?? "",
      author: pr.author?.login ?? "",
      merged_at: pr.mergedAt ?? null,
      reviews: reviews.map(({ r, comments }) => ({
        author: author(r.author),
        state: r.state ?? "",
        submitted_at: r.submittedAt ?? null,
        body: r.body ?? "",
        comments: comments.map((c) => ({
          author: author(c.author),
          path: c.path ?? null,
          body: c.body ?? "",
        })),
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

  /** Authoritative terminality read for operator debt cleanup. A PR-endpoint
   * 404 is not enough by itself: GitHub also conceals inaccessible private
   * repositories as 404. Absence therefore requires a second installation-
   * authenticated read proving access to this exact repository. */
  async getPrDisposition(n: number): Promise<PrDisposition> {
    const path = `/repos/${this.owner}/${this.repo}/pulls/${n}`;
    try {
      const raw = await this.request<unknown>("GET", path);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`malformed PR #${n} response`);
      }
      const pr = raw as { number?: unknown; state?: unknown; head?: { sha?: unknown } | null };
      if (pr.number !== n)
        throw new Error(`PR endpoint #${n} returned number ${String(pr.number)}`);
      if (pr.state !== "open" && pr.state !== "closed")
        throw new Error(`unexpected PR #${n} state ${String(pr.state)}`);
      const head = pr.head?.sha;
      if (typeof head !== "string" || head.length === 0)
        throw new Error(`malformed PR #${n} head sha`);
      return { kind: pr.state, head_sha: head };
    } catch (error) {
      if (!(
        error instanceof GitHubRequestError &&
        error.method === "GET" &&
        error.path === path &&
        error.status === 404
      ))
        throw error;
      const repoPath = `/repos/${this.owner}/${this.repo}`;
      const rawRepo = await this.request<unknown>("GET", repoPath);
      if (typeof rawRepo !== "object" || rawRepo === null || Array.isArray(rawRepo)) {
        throw new Error(`malformed repository proof for ${this.owner}/${this.repo}`, {
          cause: error,
        });
      }
      const fullName = (rawRepo as { full_name?: unknown }).full_name;
      const expected = `${this.owner}/${this.repo}`;
      if (typeof fullName !== "string" || fullName.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`repository proof mismatch for ${expected}`, { cause: error });
      }
      return { kind: "absent" };
    }
  }

  /** Read-only conversation surface for the TUI detail pane (QOL):
   * PR description, labels, and the newest issue comments, oldest-first.
   *
   * The per-issue comments endpoint ignores `sort`/`direction` (those belong
   * to the repo-wide listing) and always answers oldest-first, so the newest
   * comments are on the LAST page: its index comes off the PR's own comment
   * count, and the page before it is read too when the last one is short. */
  async prConversation(n: number, commentCount = 3): Promise<PrConversation> {
    const pr = await this.request<any>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}`);
    const path = `/repos/${this.owner}/${this.repo}/issues/${n}/comments?per_page=100`;
    let comments: any[];
    if (typeof pr.comments === "number") {
      const last = Math.max(1, Math.ceil(pr.comments / 100));
      comments = await this.request<any[]>("GET", `${path}&page=${last}`);
      if (comments.length < commentCount && last > 1)
        comments = [...(await this.request<any[]>("GET", `${path}&page=${last - 1}`)), ...comments];
    } else {
      comments = (await this.pagedArray(path)).rows;
    }
    return {
      body: pr.body ?? "",
      labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
      comments: comments.slice(-commentCount).map((c) => ({
        author: c.user?.login ?? "?",
        body: c.body ?? "",
        created_at: c.created_at ?? "",
      })),
    };
  }

  /** EVERY open PR: the list is newest-first, so a first-page read drops the
   * oldest tracked PRs out of reconcile step 1 entirely. */
  async listOpenPrs(): Promise<PrRef[]> {
    const { rows: prs } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100`,
    );
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
    const res = await this.request<{
      users: Array<{ login: string }>;
      teams: Array<{ slug: string }>;
    }>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}/requested_reviewers`);
    return { users: res.users.map((u) => u.login), teams: res.teams.map((t) => t.slug) };
  }

  /** Every file GitHub will list for the PR (it serves 3,000 at most). A list
   * that reaches that cap is flagged `truncated`: it is a floor, and ownership
   * decisions made off it must not treat a missing file as not-the-PR's. */
  async listPrFiles(n: number): Promise<FileList> {
    const { rows, truncated } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls/${n}/files?per_page=100`,
      PR_FILES_MAX_PAGES,
    );
    const out: FileList = rows.map(fileEntry);
    if (truncated) out.truncated = true;
    return out;
  }

  /**
   * Files a commit range changed (`GET /compare/<base>...<head>`) — the delta
   * source for the post-approval recheck. Read-only. GitHub serves
   * the files on the FIRST page only (later pages page the commits) and caps
   * them at COMPARE_FILES_CAP, so a list that long is flagged `truncated`: the
   * classifier must not read an unseen remainder as "nothing PR-owned".
   */
  async compareFiles(base: string, head: string): Promise<FileList> {
    const res = await this.request<{ files?: any[] }>(
      "GET",
      `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=1`,
    );
    const files = res.files ?? [];
    const out: FileList = files.map(fileEntry);
    if (files.length >= COMPARE_FILES_CAP) out.truncated = true;
    return out;
  }

  /**
   * Checks at a ref — check-runs plus the legacy commit statuses, since a repo
   * can gate on either (guard 4). Read-only: CI is consulted, never
   * triggered or re-run. Both endpoints are paginated the way listPrFiles is:
   * guard 4 classifies what it is handed, so a failing or pending check past
   * the first 100 rows must reach it, or a truncated list reads green.
   */
  async listChecks(ref: string): Promise<CheckSummary[]> {
    const out: CheckSummary[] = [];
    const enc = encodeURIComponent(ref);
    for (let page = 1; page <= 10; page++) {
      const runs = await this.request<{ check_runs?: any[] }>(
        "GET",
        `/repos/${this.owner}/${this.repo}/commits/${enc}/check-runs?per_page=100&page=${page}`,
      );
      const batch = runs.check_runs ?? [];
      for (const r of batch)
        out.push({
          name: r.name ?? "check",
          source: "check_run",
          status: r.status ?? "",
          conclusion: r.conclusion ?? null,
          started_at: r.started_at ?? null,
        });
      if (batch.length < 100) break;
    }
    for (let page = 1; page <= 10; page++) {
      const status = await this.request<{ statuses?: any[] }>(
        "GET",
        `/repos/${this.owner}/${this.repo}/commits/${enc}/status?per_page=100&page=${page}`,
      );
      const batch = status.statuses ?? [];
      for (const s of batch)
        // A commit status has no status/conclusion split: `pending` is unfinished,
        // `success`/`failure`/`error` are its conclusions.
        out.push({
          name: s.context ?? "status",
          source: "status",
          status: s.state === "pending" ? "pending" : "completed",
          conclusion: s.state === "pending" ? null : s.state === "success" ? "success" : "failure",
        });
      if (batch.length < 100) break;
    }
    return out;
  }

  async listReviews(
    n: number,
  ): Promise<Array<{ id: number; user: string; state: string; commit_id: string }>> {
    // Every page: reviews are oldest-first and every thread reply is one, so
    // on a long PR the human approval at the head is exactly what page one
    // misses — and guard 1 would then not soften over it.
    const { rows } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews?per_page=100`,
    );
    return rows.map((r) => ({
      id: r.id,
      user: r.user?.login ?? "",
      state: r.state,
      commit_id: r.commit_id,
    }));
  }

  /** Full review rows (bodies included) — read-only, for compare and
   * posting-marker reconciliation. Paginated so long-lived PRs cannot hide the
   * accepted review beyond the first 100 rows. */
  async listReviewsFull(n: number): Promise<ReviewFull[]> {
    const { rows } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews?per_page=100`,
      Number.POSITIVE_INFINITY,
    );
    return rows.map((r) => ({
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
    const { rows: res, truncated } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/issues/${n}/comments?per_page=100`,
    );
    // A conversation retry must not read a partial list as proof that its
    // earlier POST did not land. Capture callers already treat failure as unknown.
    if (truncated) throw new Error(`issue comments on #${n} exceeded the pagination bound`);
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
    const { rows: res } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?per_page=100`,
    );
    return res.map(toReviewCommentFull);
  }

  /** The NEWEST inline review comments, newest first — read-only. The
   * ping-pong retry path reads this to learn whether a reply whose POST
   * response was lost actually landed; the plain listing above returns the
   * OLDEST page, which on a busy PR never reaches a just-posted reply. */
  async listRecentReviewComments(n: number): Promise<ReviewCommentFull[]> {
    const res = await this.request<any[]>(
      "GET",
      `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?sort=created&direction=desc&per_page=100`,
    );
    return res.map(toReviewCommentFull);
  }

  /** Review comments the bot authored on a PR — the registry backfill source. */
  async listBotReviewComments(n: number): Promise<number[]> {
    const { rows: res } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?per_page=100`,
    );
    return res.filter((c) => c.user?.login === this.cfg.github.bot_login).map((c) => c.id);
  }

  // ---- staleness scan (GraphQL, ported query) ----------------------------

  /** Open PRs whose latest bot APPROVED review no longer matches the head.
   * Ported from the old flow: `first: 100`, `UPDATED_AT DESC`, review author
   * the configured `[github] bot_login`. */
  async stalenessScan(): Promise<StalePr[]> {
    const q = `repo:${this.cfg.github.repo} is:pr is:open sort:updated-desc`;
    const data = await this.graphql<{
      search: {
        nodes: Array<{
          number?: number;
          headRefOid?: string;
          reviews?: {
            nodes: Array<{ state: string; submittedAt: string; commit: { oid: string } | null }>;
          };
        }>;
      };
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
        stale.push({
          number: node.number,
          head_sha: node.headRefOid,
          approved_sha: review.commit.oid,
          approved_at: review.submittedAt,
        });
      }
    }
    return stale;
  }

  // ---- webhook redeliveries (JWT) ----------------------------------------

  async listWebhookDeliveries(
    perPage = 100,
  ): Promise<Array<{ id: number; guid: string; status: string; delivered_at: string }>> {
    return this.request("GET", `/app/hook/deliveries?per_page=${perPage}`, undefined, "jwt");
  }

  // ---- the App's own webhook configuration ---------------------

  /** The App's own webhook config — the self-heal's read-back source. Direct
   * JWT read, like the deliveries listing above. */
  async getAppWebhookConfig(): Promise<AppWebhookConfig> {
    const res = await this.request<{ url?: string; content_type?: string; insecure_ssl?: string }>(
      "GET",
      "/app/hook/config",
      undefined,
      "jwt",
    );
    return {
      url: res.url ?? "",
      content_type: res.content_type ?? "",
      insecure_ssl: res.insecure_ssl ?? "",
    };
  }

  /**
   * Re-point the App's OWN webhook URL (`PATCH /app/hook/config`, JWT-authed).
   * The one member of the app-self-config gate class (ratified rule-1
   * amendment, the owner, 2026-08-30): it touches only the App's own
   * configuration, never the reviewed repo, and the gate executes it for real
   * even in dry-run — loudly logged, with the note naming old and new URL.
   */
  async updateOwnWebhookUrl(newUrl: string, oldUrl: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "update_own_webhook_url",
      method: "PATCH",
      path: "/app/hook/config",
      body: { url: newUrl },
      note: `re-point own App webhook URL ${oldUrl || "(unknown)"} → ${newUrl}`,
    });
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
      if (String(err).includes("404"))
        return { executed: false, response: { already_absent: label } };
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

  /**
   * Put ONE named person in this PR's review-requested queue — the second
   * delivery shape of the optional escalation feature (the ratified
   * rule-10 amendment of 2026-08-31). Removed on 2026-08-18 with the old
   * escalation mechanics; back as an ordinary gated mutation.
   *
   * Three things this is NOT, and none of them changed:
   *   * It is not a way to hand the review back. `src/escalation.ts` calls it
   *     only after the round's verdict has been decided and applied, and only
   *     alongside a comment that names the ONE thing being asked about —
   *     GitHub words the queue entry "review this pull request", which is
   *     exactly the framing the comment exists to correct.
   *   * It is not a dry-run exception. `request_reviewer` is an ordinary
   *     `MutationKind`: suppressed to `state/dryrun/` like everything else,
   *     `forceLive` throws on it, and it is not in `APP_SELF_CONFIG_KINDS`.
   *   * It is not review-dismissing. Rule 2 is untouched; requesting a review
   *     adds a reviewer and changes no existing review.
   *
   * Needs no new App permission: this is a POST on the same
   * `/pulls/{n}/requested_reviewers` route the team-request DELETE already
   * uses, and both are Pull requests: write, which the App manifest grants.
   */
  async requestEscalationReview(n: number, logins: string[]): Promise<GateResult> {
    const reviewers = logins.map((l) => l.trim().replace(/^@/, "")).filter(Boolean);
    return this.gate.execute({
      kind: "request_reviewer",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/pulls/${n}/requested_reviewers`,
      body: { reviewers },
      note: `escalation: request review from ${reviewers.map((r) => `@${r}`).join(", ")} on #${n}`,
      pr: n,
    });
  }

  async createReview(
    n: number,
    payload: {
      commit_id: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: unknown[];
    },
    options?: { purpose?: "migration_precheck" | "escalation" },
  ): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_review",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews`,
      body: payload,
      note: `post ${payload.event} review on #${n}`,
      pr: n,
      reviewPurpose: options?.purpose,
    });
  }

  /** A claimed PR-level author response; ordinary posting guards and dry-run apply. */
  async createIssueComment(n: number, body: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_issue_comment", method: "POST",
      path: `/repos/${this.owner}/${this.repo}/issues/${n}/comments`,
      body: { body }, note: `answer the author in PR #${n}'s conversation`, pr: n,
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
  ): Promise<{
    skipped: "already-resolved" | "check-this-human-only" | "deferred-human-only" | null;
    result?: GateResult;
  }> {
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
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              comments: {
                nodes: Array<{ databaseId: number; author?: { login?: string }; body?: string }>;
              };
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    };
    let after: string | null = null;
    let found: { id: string; isResolved: boolean; author: string; body: string } | undefined;
    do {
      const data: ThreadPage = await this.graphql(query, {
        owner: this.owner,
        repo: this.repo,
        number: n,
        after,
      });
      const threads = data.repository?.pullRequest?.reviewThreads;
      if (!threads) throw new Error(`review threads unavailable for #${n}`);
      for (const thread of threads.nodes) {
        const root = thread.comments.nodes[0];
        if (root?.databaseId === rootCommentId) {
          found = {
            id: thread.id,
            isResolved: thread.isResolved,
            author: root.author?.login ?? "",
            body: root.body ?? "",
          };
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
    const bareAppActor =
      this.cfg.github.bot_login === `${this.cfg.github.app_slug}[bot]`
        ? this.cfg.github.app_slug
        : undefined;
    const ownActors = new Set(
      [this.cfg.github.bot_login, bareAppActor].filter((v): v is string => v !== undefined),
    );
    if (!ownActors.has(found.author)) {
      throw new Error(
        `refusing to resolve thread ${rootCommentId} on #${n}: root author is ${found.author || "unknown"}`,
      );
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
    // is the ANSWER, not the resolution. The owner rejected borrowing the
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
