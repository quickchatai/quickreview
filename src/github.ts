// The GitHub adapter. Reads run directly on the installation token; every
// mutation is expressed as a MutationIntent and pushed through the gate
// (dry-run writes it to state/dryrun/ instead of executing). There is no
// review-dismissal function in this adapter, by design — never add one.
import {
  GitHubRequestError,
  type PrFileEntry,
} from "@quickchatai/pi-quickreview/src/githubcore.js";
import { ThreadResolutionRefusal } from "./thread-resolution-refusal.js";
import type { CheckSummary } from "@quickchatai/pi-quickreview/src/cigate.js";
import { reviewTeamSlug, type Config } from "./config.js";
import { CHECK_THIS_RE, DEFERRED_RE } from "@quickchatai/pi-quickreview/src/severity.js";
import {
  APP_SELF_CONFIG_KINDS,
  type MutationGate,
  type MutationIntent,
  type GateResult,
  type ReviewPurpose,
} from "@quickchatai/pi-quickreview/src/gate.js";
import {
  GITHUB_REQUEST_TIMEOUT_MS,
  type GitHubCredential,
  type FetchFn,
} from "@quickchatai/pi-quickreview/src/githubAuth.js";
import {
  excludeOwnAppQualifier,
  isOwnContent,
  isPersonMode,
  ownActorAlias,
} from "@quickchatai/pi-quickreview/src/identity.js";
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
  /** The PR description: pass-intent's whole intent artifact and the
   * substance-bar input. Optional so test fakes of PrRef stay valid; the real
   * adapter always sets it ("" when GitHub returns null). */
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

// A changed file as the files API reports it lives with the core's half.
export type { PrFileEntry };

export interface ReviewFull {
  id: number;
  user: string;
  /** GitHub's account type ("User" | "Bot") — the human/bot discriminator the
   * feedback capture sweep filters on. Optional: not every caller reads it. */
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
  /** GitHub's `line`, which follows the diff as the branch moves and goes
   * null once the comment is outdated — then this adapter's fallback,
   * `original_line`. So a non-null `line` does not mean the comment is
   * current. */
  line: number | null;
  pull_request_review_id: number | null;
  in_reply_to_id: number | null;
  /** When GitHub authored it. Optional for the same reason. */
  created_at?: string | null;
  /** The line in the commit the comment was posted on. Unlike GitHub's
   * `line` it does not move with the diff, so it is what the outcome capture
   * matches a finding's anchor by. Optional: not every caller reads it. */
  original_line?: number | null;
}

/** A pulls-endpoint PR as a `PrRef`. `merged` is the caller's: the single-PR
 * read carries it, the open-PR list does not. */
function toPrRef(pr: any, merged: boolean): PrRef {
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
    merged,
    labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
  };
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
    original_line: c.original_line ?? null,
  };
}

/** One top-level PR conversation comment (the issues API). Read-only; read by
 * the feedback capture sweep. */
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

/** How many newest-first pages `listRecentReviewComments` reads to reach the
 * comment a lost reply answered. */
const RECENT_COMMENTS_MAX_PAGES = 10;

/** GitHub search serves at most 1,000 hits: ten pages of 100. */
const TRIGGER_SEARCH_MAX_PAGES = 10;

/** The trigger events the history importer reconstructs — one list for the
 * first query and every follow-up page. */
const HISTORY_TIMELINE_TYPES =
  "[LABELED_EVENT, REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]";

/** Hard stop for a connection walk — a server that keeps answering
 * hasNextPage with a cursor that never ends cannot loop forever. */
const MAX_CONNECTION_PAGES = 50;

/** Every node of a connection: the first page as already fetched, then each
 * `next(cursor)` until GitHub says there is no next page. A connection still
 * going after `MAX_CONNECTION_PAGES` throws rather than answer a partial
 * history as the whole of it. */
async function walkConnection<N>(
  first: Connection<N> | null | undefined,
  next: (after: string) => Promise<Connection<N> | null | undefined>,
): Promise<N[]> {
  const out: N[] = [];
  let conn = first;
  for (let page = 1; conn; page++) {
    out.push(...(conn.nodes ?? []).filter((n): n is N => n !== null && n !== undefined));
    const info = conn.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    if (page >= MAX_CONNECTION_PAGES)
      throw new Error(
        `connection exceeded ${MAX_CONNECTION_PAGES} pages — history would be partial`,
      );
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

// The error a refused request throws is the review core's (packages/pi-plugin/src/githubcore.ts).
export { GitHubRequestError };

export interface SearchIssueItem {
  number: number;
  title: string;
  user: { login: string; type: string };
  updated_at: string;
  created_at: string;
}

/** How much of a raw read's body is kept (GitHubAdapter.readText). */
export interface RawReadOptions {
  maxBytes: number;
  /** Keep the end instead of the head (a job log's tail). */
  tail?: boolean;
}

/** A raw read as GitHub answered it. */
export interface RawReadAnswer {
  status: number;
  body: string;
  /** Bytes past `maxBytes` were dropped. */
  truncated: boolean;
}

/** A response body as UTF-8 text, at most `max` bytes of it, read as a stream so
 * a large log never sits in memory whole: the first `max` bytes, or with `tail`
 * the last. A cut that splits a character loses that character only. */
export async function cappedText(
  res: Response,
  max: number,
  tail: boolean,
): Promise<{ text: string; truncated: boolean }> {
  if (res.body === null) return { text: "", truncated: false };
  const chunks: Buffer[] = [];
  let held = 0;
  let truncated = false;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = Buffer.from(value);
    if (!tail) {
      if (held + chunk.length > max) {
        chunk = chunk.subarray(0, max - held);
        truncated = true;
      }
      chunks.push(chunk);
      held += chunk.length;
      if (truncated) {
        await reader.cancel().catch(() => {});
        break;
      }
      continue;
    }
    chunks.push(chunk);
    held += chunk.length;
    while (held > max && chunks.length > 0) {
      truncated = true;
      const first = chunks[0]!;
      const over = held - max;
      if (first.length <= over) {
        chunks.shift();
        held -= first.length;
      } else {
        chunks[0] = first.subarray(over);
        held -= over;
      }
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
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
    /** The one credential source: the App's minter, or under
     * `[github] auth = "user"` the person's token file (githubAuth.ts). */
    private readonly credential: GitHubCredential,
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
  ): Promise<T> {
    const send = (token: string): Promise<Response> =>
      this.fetchFn(`${this.apiBase}${path}`, {
        method,
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    const res =
      auth === "jwt" ? await send(await this.appJwt(path)) : await this.sendInstallation(send);
    if (!res.ok) {
      const retryAfter = res.headers?.get("retry-after");
      const reset = res.headers?.get("x-ratelimit-reset");
      const retryAfterMs = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : reset
          ? Math.max(0, Number(reset) * 1000 - Date.now())
          : undefined;
      throw new GitHubRequestError(
        method,
        path,
        res.status,
        (await res.text()).slice(0, 300),
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** The App JWT, for the App's own routes only. Absent under the person's
   * credential, where there is no App: refused before anything is sent. */
  private async appJwt(path: string): Promise<string> {
    if (!this.credential.appJwt || isPersonMode(this.cfg.github))
      throw new Error(
        `${path} needs the GitHub App's JWT, and [github] auth = "user" has no App — this route is off in that mode`,
      );
    return this.credential.appJwt();
  }

  /** Send with an installation token; on a 401 drop the rejected response
   * body, invalidate the cached token and send once more with a fresh one.
   * The one owner of the installation-token 401 policy. */
  private async sendInstallation(send: (token: string) => Promise<Response>): Promise<Response> {
    let res = await send(await this.credential.installationToken());
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      this.credential.invalidate();
      res = await send(await this.credential.installationToken());
    }
    return res;
  }

  private graphqlFetch(
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Response> {
    return this.fetchFn(`${this.apiBase}/graphql`, {
      method: "POST",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  }

  /** One GraphQL query, with REST's deadline and its one re-mint on a 401. */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.sendInstallation((token) => this.graphqlFetch(token, query, variables));
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        // No readable body: the status alone.
      }
      throw new Error(`graphql → ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const payload = (await res.json()) as { data?: T; errors?: unknown[] };
    if (payload.errors?.length)
      throw new Error(`graphql errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
    return payload.data as T;
  }

  /**
   * A session helper's read, served by the daemon (src/ghread.ts): one
   * GET of `path` with the installation token, redirects followed (fetch drops
   * the Authorization header on a cross-origin hop, which is what the Actions
   * log storage wants), answered as GitHub answered it — the status and at most
   * `maxBytes` of the body as text, the head or, with `tail`, the end. An HTTP
   * error status is an answer, not a throw; only a request that never got one
   * throws. The caller has already checked `path` is a read of the reviewed repo.
   */
  async readText(path: string, o: RawReadOptions): Promise<RawReadAnswer> {
    return this.rawAnswer(o, (token) =>
      this.fetchFn(`${this.apiBase}${path}`, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      }),
    );
  }

  /** The same for one GraphQL read: the caller supplies a query it holds itself
   * (src/ghread.ts GH_READ_QUERIES), never one a session wrote. */
  async graphqlText(
    query: string,
    variables: Record<string, unknown>,
    o: RawReadOptions,
  ): Promise<RawReadAnswer> {
    return this.rawAnswer(o, (token) => this.graphqlFetch(token, query, variables));
  }

  /** One raw request with REST's one re-mint on a 401, its body capped. */
  private async rawAnswer(
    o: RawReadOptions,
    send: (token: string) => Promise<Response>,
  ): Promise<RawReadAnswer> {
    const res = await this.sendInstallation(send);
    const { text, truncated } = await cappedText(res, o.maxBytes, o.tail === true);
    return { status: res.status, body: text, truncated };
  }

  /** The mutation executor the gate runs when it decides a mutation is real —
   * every kind in live mode, and the app-self-config class in dry-run too.
   * The gate, never a call site, makes that decision. */
  executeMutation = async (intent: MutationIntent): Promise<unknown> => {
    if (intent.method === "git")
      throw new Error("git pushes are executed by the caller, not the REST executor");
    // The brace under the posting guard's person-mode step: on the person's
    // own account no review reaches GitHub as an APPROVE or REQUEST_CHANGES,
    // even from a gate with no guard installed.
    if (isPersonMode(this.cfg.github) && intent.kind === "create_review") {
      const raw = (intent.body as { event?: unknown } | undefined)?.event;
      const event = typeof raw === "string" ? raw : "";
      if (event.toUpperCase() !== "COMMENT")
        throw new Error(
          `[github] auth = "user" posts every review as a COMMENT; refusing a ${event || "(no event)"} review on #${intent.pr ?? "?"}`,
        );
    }
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
    // App-self-config intents address the App's own configuration:
    // GitHub authenticates those routes with the App JWT, not an installation
    // token — the same auth split request() already carries for the
    // /app/hook/deliveries read.
    const auth = (APP_SELF_CONFIG_KINDS as readonly string[]).includes(intent.kind)
      ? "jwt"
      : "installation";
    return this.request(intent.method, intent.path, intent.body, auth);
  };

  // ---- triggered-set queries (reads) -------------------------------------

  /** One page of issue search (100 hits). GitHub's search may time out and
   * answer a partial set; absence read from it would be invented, so the read
   * fails with `incompleteMessage` rather than answers. */
  private async searchIssuePage(
    q: string,
    page: number,
    incompleteMessage: string,
  ): Promise<SearchIssueItem[]> {
    const res = await this.request<{ items?: SearchIssueItem[]; incomplete_results?: boolean }>(
      "GET",
      `/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
    );
    if (res.incomplete_results === true) throw new Error(incompleteMessage);
    return res.items ?? [];
  }

  /** Every hit, not the first 100: the reconcile pass reads a PR missing from
   * this list as trigger-ABSENT, so a truncated page would fake an absent →
   * present edge the moment search order reshuffled it back in. */
  private async searchIssues(q: string): Promise<SearchIssueItem[]> {
    const out: SearchIssueItem[] = [];
    for (let page = 1; page <= TRIGGER_SEARCH_MAX_PAGES; page++) {
      const items = await this.searchIssuePage(
        q,
        page,
        `trigger search "${q}" answered incomplete results`,
      );
      out.push(...items);
      if (items.length < 100) return out;
    }
    throw new Error(`trigger search "${q}" exceeded ${TRIGGER_SEARCH_MAX_PAGES} pages`);
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

  /** Paginated issue search — read-only, used by the history importer.
   * Stops on a short page or after `maxPages` (search caps at 1,000 hits). */
  async searchIssuesPaged(q: string, maxPages = 10): Promise<SearchIssueItem[]> {
    const out: SearchIssueItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.searchIssuePage(q, page, "incomplete history search results");
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  /** Read-only GraphQL per PR: the reviews `author` submitted plus the
   * timeline items the backfill importer reconstructs triggers from — one
   * query, then one more per further page of either connection. Returns null
   * when the PR is gone. */
  async prReviewHistory(n: number, author: string): Promise<PrReviewHistory | null> {
    const data = await this.graphql<{ repository?: { pullRequest?: RawPrHistory | null } | null }>(
      `query ($owner: String!, $repo: String!, $number: Int!, $author: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            number title createdAt closedAt mergedAt merged
            author { login }
            reviews(author: $author, first: 100) { ${HISTORY_REVIEWS_BODY} }
            timelineItems(itemTypes: ${HISTORY_TIMELINE_TYPES}, first: 100) { ${HISTORY_TIMELINE_BODY} }
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
              timelineItems(itemTypes: ${HISTORY_TIMELINE_TYPES}, first: 100, after: $after) { ${HISTORY_TIMELINE_BODY} }
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

  /** Read-only GraphQL per PR for the review history digest: every author's
   * reviews, each with its inline comments, and the author's type so the
   * digest can keep people and drop Apps — one query, then one more per
   * further page of reviews or of one review's comments. Returns null when
   * the PR is gone. */
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
        const d = await this.graphql<{
          node?: { comments?: Connection<RawComment> | null } | null;
        }>(
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
   * can never approve its own PRs. */
  async searchLabelTriggered(): Promise<SearchIssueItem[]> {
    const q = `repo:${this.cfg.github.repo} is:open is:pr label:"${this.cfg.github.trigger_label}"${excludeOwnAppQualifier(this.cfg.github)}`;
    return this.searchIssues(q);
  }

  /** PRs with a pending review-team request. The team trigger is optional:
   * with no `[github] review_team` there is nothing to search, and the bare
   * `team-review-requested:` qualifier is a 422 that would fail the whole
   * triggered-set pass, the label search with it. */
  async searchTeamTriggered(): Promise<SearchIssueItem[]> {
    if (this.cfg.github.review_team.trim() === "") return [];
    const q = `repo:${this.cfg.github.repo} is:open is:pr team-review-requested:${this.cfg.github.review_team}${excludeOwnAppQualifier(this.cfg.github)}`;
    return this.searchIssues(q);
  }

  // ---- authoritative per-PR reads ----------------------------------------

  async getPr(n: number): Promise<PrRef> {
    const pr = await this.request<any>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}`);
    return toPrRef(pr, Boolean(pr.merged));
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

  /** Read-only conversation surface for the TUI detail pane:
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
    const { rows: prs, truncated } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100`,
    );
    // A PR past the bound would silently miss every head refresh: a partial
    // list fails the read instead.
    if (truncated) throw new Error("open PRs exceeded the pagination bound");
    // An open PR is not merged; the list endpoint does not carry `merged`.
    return prs.map((pr) => toPrRef(pr, false));
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
   * A behind/diverged comparison is merge-base-relative rather than the two
   * reviewed trees; it also cannot prove an empty post-approval delta.
   */
  async compareFiles(base: string, head: string): Promise<FileList> {
    const res = await this.request<{ files?: any[]; status?: string }>(
      "GET",
      `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=1`,
    );
    const files = res.files ?? [];
    const out: FileList = files.map(fileEntry);
    if (files.length >= COMPARE_FILES_CAP || res.status === "behind" || res.status === "diverged")
      out.truncated = true;
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
    const runs = await this.completeCheckPages<any>(
      `/repos/${this.owner}/${this.repo}/commits/${enc}/check-runs`,
      "check_runs",
    );
    for (const r of runs)
      out.push({
        name: r.name ?? "check",
        source: "check_run",
        status: r.status ?? "",
        conclusion: r.conclusion ?? null,
        started_at: r.started_at ?? null,
      });
    const statuses = await this.completeCheckPages<any>(
      `/repos/${this.owner}/${this.repo}/commits/${enc}/status`,
      "statuses",
    );
    for (const s of statuses)
      out.push({
        name: s.context ?? "status",
        source: "status",
        status: s.state === "pending" ? "pending" : "completed",
        conclusion: s.state === "pending" ? null : s.state === "success" ? "success" : "failure",
      });
    return out;
  }

  /** Complete CI evidence, or an unreadable result that callers classify unknown. */
  private async completeCheckPages<T>(path: string, field: string): Promise<T[]> {
    const rows: T[] = [];
    let expected: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const result = await this.request<Record<string, unknown>>(
        "GET",
        `${path}?per_page=100&page=${page}`,
      );
      const count = result.total_count;
      if (count !== undefined) {
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
          throw new Error(`unreadable ${field} total_count`);
        if (expected !== undefined && expected !== count)
          throw new Error(`incomplete ${field}: count changed while reading`);
        expected = count;
      }
      const batch = result[field];
      if (!Array.isArray(batch)) throw new Error(`unreadable ${field} page`);
      rows.push(...(batch as T[]));
      if (expected !== undefined && rows.length > expected)
        throw new Error(`incomplete ${field}: rows exceed advertised count`);
      if (batch.length < 100 || (expected !== undefined && rows.length === expected)) {
        if (expected !== undefined && rows.length !== expected)
          throw new Error(`incomplete ${field}: advertised count not reached`);
        return rows;
      }
    }
    throw new Error(`incomplete ${field}: page limit reached`);
  }

  async listReviews(
    n: number,
  ): Promise<Array<{ id: number; user: string; state: string; commit_id: string }>> {
    // Every page, with no page bound: reviews are oldest-first and every
    // thread reply is one, so on a long PR the human approval at the head is
    // exactly what a bounded read misses — and guard 1 would then not soften
    // over it. A short page ends the read, as for listReviewsFull.
    return (await this.listReviewsFull(n)).map((r) => ({
      id: r.id,
      user: r.user,
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

  /** Top-level PR conversation comments — read-only, the feedback capture
   * sweep's third source (the issues API is where GitHub keeps them). */
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

  /** Every inline review comment, oldest first — read-only: the reconcile
   * comment sweep, the case writer's backfill, the compare harness. A list
   * past the pagination bound throws rather than answer its oldest part as
   * the whole: a sweep that read a partial list would stamp its watermark and
   * never look for the newer comments again. */
  async listReviewCommentsFull(n: number): Promise<ReviewCommentFull[]> {
    const { rows: res, truncated } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?per_page=100`,
    );
    if (truncated) throw new Error(`inline comments on #${n} exceeded the pagination bound`);
    return res.map(toReviewCommentFull);
  }

  /** The NEWEST inline review comments, newest first — read-only. The
   * ping-pong retry path reads this to learn whether a reply whose POST
   * response was lost actually landed, so the newest comments are the ones
   * it needs. With `newerThan`, pages continue until one reaches a comment at
   * or below that id (ids grow with creation, so every comment created after
   * it has then been read) — or throw past `RECENT_COMMENTS_MAX_PAGES`, never
   * answer a window that may have missed the reply. Without it, one page. */
  async listRecentReviewComments(n: number, newerThan?: number): Promise<ReviewCommentFull[]> {
    const out: ReviewCommentFull[] = [];
    for (let page = 1; page <= RECENT_COMMENTS_MAX_PAGES; page++) {
      const res = await this.request<any[]>(
        "GET",
        `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?sort=created&direction=desc&per_page=100&page=${page}`,
      );
      out.push(...res.map(toReviewCommentFull));
      if (newerThan === undefined || res.length < 100) return out;
      if (res.some((c) => typeof c.id === "number" && c.id <= newerThan)) return out;
    }
    throw new Error(
      `inline comments on #${n} newer than ${newerThan} exceeded ${RECENT_COMMENTS_MAX_PAGES} pages`,
    );
  }

  /** Review comments the bot authored on a PR — the registry backfill source.
   * Read newest first, so a PR past the page bound loses its OLDEST comments
   * (registered by earlier passes), never the newest. */
  async listBotReviewComments(n: number): Promise<number[]> {
    const { rows: res } = await this.pagedArray<any>(
      `/repos/${this.owner}/${this.repo}/pulls/${n}/comments?sort=created&direction=desc&per_page=100`,
    );
    // Person mode: the person's own inline comments are a human's, not the
    // reviewer's — only marker-bearing ones join the bot-comment registry.
    return res.filter((c) => isOwnContent(this.cfg.github, c.user?.login, c.body)).map((c) => c.id);
  }

  // ---- staleness scan (GraphQL) -------------------------------------------

  /** Open PRs whose latest bot APPROVED review no longer matches the head:
   * `first: 100`, `UPDATED_AT DESC`, review author the configured
   * `[github] bot_login`. */
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

  // ---- the App's own webhook configuration -------------------------------

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
   * The one member of the app-self-config gate class (AGENTS.md invariant 6): it
   * touches only the App's own
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
      // 404 ("Label does not exist") is idempotent success, not an error —
      // e.g. a label consumed by an earlier failed-dispatch cycle.
      if (err instanceof GitHubRequestError && err.status === 404)
        return { executed: false, response: { already_absent: label } };
      throw err;
    }
  }

  /** Consume the team trigger: DELETE with the JSON body, then verify. */
  async deleteTeamReviewRequest(n: number): Promise<GateResult> {
    const teamSlug = reviewTeamSlug(this.cfg.github.review_team);
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
   * Put named people in this PR's review-requested queue — the second
   * delivery shape of the optional escalation feature (the never-hand-to-a-human rule), an
   * ordinary gated mutation.
   *
   * Three things this is not:
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
    options?: { purpose?: ReviewPurpose; postingRetry?: string },
  ): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_review",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews`,
      body: payload,
      note: `post ${payload.event} review on #${n}${options?.postingRetry ? " (deferred delivery)" : ""}`,
      pr: n,
      reviewPurpose: options?.purpose,
      ...(options?.postingRetry !== undefined ? { postingRetry: options.postingRetry } : {}),
    });
  }

  /** A claimed PR-level author response; ordinary posting guards and dry-run apply. */
  async createIssueComment(n: number, body: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_issue_comment",
      method: "POST",
      path: `/repos/${this.owner}/${this.repo}/issues/${n}/comments`,
      body: { body },
      note: `answer the author in PR #${n}'s conversation`,
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

    if (!found)
      throw new ThreadResolutionRefusal(
        `comment ${rootCommentId} is not a review-thread root on #${n}`,
      );
    // GitHub exposes the same App actor with two spellings: review-author
    // filters use the `[bot]` login, while review-thread GraphQL actors use the
    // bare App slug. Both values are independently configured; recognize
    // exactly that pair here and nowhere else. Every unrelated identity stays
    // structurally refused. In person mode the root must also carry the
    // reviewer's marker: a thread the person opened by hand is theirs.
    const bareAppActor = ownActorAlias(this.cfg.github);
    const ownActors = new Set(
      [this.cfg.github.bot_login, bareAppActor].filter((v): v is string => v !== undefined),
    );
    const own = isPersonMode(this.cfg.github)
      ? isOwnContent(this.cfg.github, found.author, found.body)
      : ownActors.has(found.author);
    if (!own) {
      throw new ThreadResolutionRefusal(
        `refusing to resolve thread ${rootCommentId} on #${n}: root author is ${found.author || "unknown"}`,
      );
    }
    // A "[check this]" thread exists to force a human's eyes before merge (repo
    // rule: every conversation must be resolved). The reviewer never resolves
    // one — the author or another human only.
    if (CHECK_THIS_RE.test(found.body)) return { skipped: "check-this-human-only" };
    // A "[deferred]" thread says this finding is real and this PR is not where
    // it gets fixed. If the author ignores the drafted ticket, the reviewer
    // must not be able to tidy the thread away — that would make a deferral
    // free again, which is the exact thing this mechanism exists to stop. So it
    // takes the same structural refusal as "[check this]", and the repo's merge
    // rule (every conversation resolved) puts a person in front of it. Distinct
    // marker, distinct reason string: the two are never conflated, here or
    // anywhere.
    if (DEFERRED_RE.test(found.body)) return { skipped: "deferred-human-only" };
    // An "[ask your human]" thread is deliberately not refused here. It is the
    // sibling marker, not a second spelling of the one above: it addresses the
    // PR author's AI implementer ("do not answer this yourself — ask a person
    // and bring the answer back"), so what a human owes the thread is the
    // answer, not the resolution. Making it human-only would force a person
    // into every such thread, and the ordinary path already lands in the right
    // place — ping-pong resolves such a thread only after the author replied
    // and the session judged the reply settles it, and the prior-finding
    // resolver only for a finding a later round reported fixed or obsolete.
    // Rule 2 is
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

  /** Every open issue carrying the configured label, whoever filed it. */
  async listOpenLabelledIssues(): Promise<Array<{ number: number; title: string }>> {
    const q = `repo:${this.cfg.github.repo} is:open is:issue label:"${this.cfg.github.issue_label}"`;
    return (await this.searchIssues(q)).map((i) => ({ number: i.number, title: i.title }));
  }

  /** Recover only an exact daemon marker posted by our configured identity.
   * Absence is not permission to repeat an uncertain creation. */
  async findFiledItem(
    kind: "issue" | "improvement_pr",
    marker: string,
    branch?: { head: string; base: string },
  ): Promise<number | null> {
    const path =
      kind === "issue"
        ? `/repos/${this.owner}/${this.repo}/issues?state=all&per_page=100`
        : `/repos/${this.owner}/${this.repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${this.owner}:${branch!.head}`)}&base=${encodeURIComponent(branch!.base)}`;
    const { rows, truncated } = await this.pagedArray<any>(path);
    if (truncated) throw new Error("filing reconciliation exceeded pagination bound");
    const matches = rows.filter(
      (row) =>
        row.user?.login === this.cfg.github.bot_login &&
        typeof row.body === "string" &&
        row.body.split(/\r?\n/).includes(marker) &&
        (kind === "issue"
          ? !row.pull_request
          : row.head?.ref === branch?.head && row.base?.ref === branch?.base),
    );
    if (matches.length > 1) throw new Error("ambiguous filing markers");
    if (matches.length === 0) return null;
    const number: unknown = matches[0].number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
      throw new Error("invalid filing receipt number");
    return number;
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
