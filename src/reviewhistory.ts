// The review history digest — what setup reads of a repo's past reviews.
//
// Setup reads what a repo's reviews have ALREADY said: the human review
// comments on the last six months of merged PRs, the daemon's own rounds, and
// the `[feedback]` ledger. The VM daemon holds the App credential, so it does
// the reading; the digest it prints is carried to the PC's state home
// (`src/tui/historypull.ts`) and nowhere else — the VM writes no copy, the
// companion reads it there and condenses THEMES, and only themes reach memory
// and the repo portrait (`src/setup/history.ts`). The raw comments are the
// operator's colleagues' names and words; they stay in the state home.
//
// READ-ONLY against GitHub, in the backfill shape (`src/backfill.ts`): paged
// issue searches (one per month of the window) enumerate the PRs, one GraphQL query per PR reads its
// reviews. `ReviewHistorySource` has no method that could write, and nothing
// here imports the gate — `qcr history digest` hands the adapter a dry-run gate
// whose executor throws, exactly as `qcr backfill` does.
//
// Total at the edge: a PR that cannot be read is counted, never fatal; an
// empty repo — no merged PRs, no rounds, no feedback — is an ordinary, EMPTY
// digest, not an error.
import type { Config } from "./config.js";
import type { SearchIssueItem } from "./github.js";
import type { FeedbackSignalRow, RoundRow } from "./state.js";

/** How far back the human half looks, by default. */
export const DEFAULT_HISTORY_MONTHS = 6;
/** One comment body is cut here — a pasted log says nothing about taste. */
export const COMMENT_BODY_MAX = 2000;
/** The whole human half is capped; `truncated` says when it bit. */
export const MAX_HUMAN_COMMENTS = 5000;

export const DIGEST_KIND = "qcr-review-history";
export const DIGEST_VERSION = 1;

// ---- the source (read-only) ------------------------------------------------

export interface HumanReviewAuthor {
  login: string;
  /** GraphQL `__typename`: "User" for a person, "Bot" for an App. */
  type: string;
}

export interface HumanReviewNode {
  author: HumanReviewAuthor | null;
  state: string;
  submitted_at: string | null;
  body: string;
  comments: Array<{ author: HumanReviewAuthor | null; path: string | null; body: string }>;
}

export interface PrReviews {
  number: number;
  title: string;
  author: string;
  merged_at: string | null;
  reviews: HumanReviewNode[];
}

/** The read-only slice of GitHubAdapter the digest needs (test seam). */
export interface ReviewHistorySource {
  searchIssuesPaged(q: string, maxPages?: number): Promise<SearchIssueItem[]>;
  prReviews(n: number): Promise<PrReviews | null>;
}

/** The read-only slice of StateStore the digest needs (test seam). */
export interface ReviewHistoryStore {
  allRounds(): RoundRow[];
  feedbackSignalsSince(since: string): FeedbackSignalRow[];
}

// ---- the digest --------------------------------------------------------------

export interface HumanComment {
  pr: number;
  merged_at: string | null;
  /** `review` = a review's body; `inline` = a comment on a line of a file. */
  kind: "review" | "inline";
  /** The review's state (APPROVED, CHANGES_REQUESTED, COMMENTED). */
  state: string;
  path: string | null;
  author: string;
  body: string;
}

export interface OwnRound {
  pr: number;
  round_no: number;
  verdict: string | null;
  finished_at: string | null;
  /** 1 = imported from GitHub history by `qcr backfill`, not a live round. */
  backfilled: boolean;
  summary: string | null;
}

export interface FeedbackItem {
  pr: number;
  kind: string;
  created_at: string;
  author: string | null;
  body: string | null;
}

export interface ReviewHistoryDigest {
  kind: typeof DIGEST_KIND;
  version: number;
  repo: string;
  generated_at: string;
  window: { since: string; until: string; months: number };
  human: {
    prs_enumerated: number;
    prs_scanned: number;
    prs_missing: number;
    truncated: boolean;
    comments: HumanComment[];
  };
  rounds: OwnRound[];
  feedback: FeedbackItem[];
  /** What could not be read — the rest of the digest is then partial. */
  problems: string[];
}

export interface CollectOptions {
  months?: number;
  /** Cap the PRs read (smoke runs); unset = every PR the search returns. */
  limit?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

/** `months` calendar months before `now`, as an ISO instant. */
export function windowStart(now: Date, months: number): string {
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(d.getTime());
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  d.setUTCDate(Math.min(day, last.getUTCDate()));
  return d.toISOString();
}

/** The enumeration query: merged PRs from `since` (to `until`, both days
 * inclusive, when given), the App's own excluded. */
export function mergedPrsQuery(cfg: Config, since: string, until?: string): string {
  const range =
    until === undefined
      ? `>=${since.slice(0, 10)}`
      : `${since.slice(0, 10)}..${until.slice(0, 10)}`;
  return `repo:${cfg.github.repo} is:pr is:merged merged:${range} -author:app/${cfg.github.app_slug}`;
}

/**
 * The window cut into one-month slices, oldest first. GitHub's search returns
 * at most 1000 results per query, and six months of a busy repo is more than
 * that — one query would silently keep an arbitrary subset. Per month, the cap
 * is only reached by a repo merging 1000+ PRs a month, and then the digest
 * says so. The last slice is open-ended (`merged:>=`), so a PR merged today
 * is never lost to a day boundary; adjacent slices share a boundary day and
 * the caller deduplicates.
 */
export function mergedPrsQueries(cfg: Config, now: Date, months: number): string[] {
  if (months <= 1) return [mergedPrsQuery(cfg, windowStart(now, months))];
  const out: string[] = [];
  for (let m = months; m > 1; m--)
    out.push(mergedPrsQuery(cfg, windowStart(now, m), windowStart(now, m - 1)));
  out.push(mergedPrsQuery(cfg, windowStart(now, 1)));
  return out;
}

function clip(body: string): string {
  const t = body.trim();
  return t.length > COMMENT_BODY_MAX ? `${t.slice(0, COMMENT_BODY_MAX)}…` : t;
}

/** A human, and not the PR's own author (their replies answer a review; they
 * are not one) nor this App under either spelling. `[feedback]` comments are
 * left out here: they are the feedback half, read from the ledger. */
function humanReviewer(a: HumanReviewAuthor | null, pr: PrReviews, cfg: Config): string | null {
  if (!a || a.type !== "User" || a.login === "") return null;
  if (a.login === pr.author) return null;
  if (a.login === cfg.backfill.bot_login || a.login === cfg.backfill.bot_actor) return null;
  return a.login;
}

/** Pure: one PR's reviews → the human comments the digest keeps. */
export function humanCommentsOf(pr: PrReviews, cfg: Config): HumanComment[] {
  const out: HumanComment[] = [];
  const keep = (body: string): boolean => body.trim() !== "" && !/^\s*\[feedback\]/i.test(body);
  for (const r of pr.reviews) {
    const reviewer = humanReviewer(r.author, pr, cfg);
    if (reviewer !== null && keep(r.body)) {
      out.push({
        pr: pr.number,
        merged_at: pr.merged_at,
        kind: "review",
        state: r.state,
        path: null,
        author: reviewer,
        body: clip(r.body),
      });
    }
    for (const c of r.comments) {
      const who = humanReviewer(c.author, pr, cfg);
      if (who === null || !keep(c.body)) continue;
      out.push({
        pr: pr.number,
        merged_at: pr.merged_at,
        kind: "inline",
        state: r.state,
        path: c.path,
        author: who,
        body: clip(c.body),
      });
    }
  }
  return out;
}

async function mapPool<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, worker));
  return out;
}

/** Read the whole history and assemble the digest. Never throws for a
 * GitHub failure — it lands in `problems`, and what could be read is kept. */
export async function collectReviewHistory(
  source: ReviewHistorySource,
  store: ReviewHistoryStore,
  cfg: Config,
  opts: CollectOptions = {},
): Promise<ReviewHistoryDigest> {
  const log = opts.log ?? ((): void => {});
  const now = (opts.now ?? (() => new Date()))();
  const months = opts.months ?? DEFAULT_HISTORY_MONTHS;
  const since = windowStart(now, months);
  const problems: string[] = [];

  const numbers = new Set<number>();
  for (const q of mergedPrsQueries(cfg, now, months)) {
    try {
      const found = await source.searchIssuesPaged(q, cfg.backfill.max_search_pages);
      for (const i of found) if (Number.isInteger(i.number)) numbers.add(i.number);
      if (found.length >= Math.min(cfg.backfill.max_search_pages * 100, 1000)) {
        problems.push(
          `the search returned its cap (${found.length} PRs) for ${q} — some merged PRs in that month were not read`,
        );
      }
    } catch (err) {
      problems.push(`merged-PR search failed (${q}): ${String(err)}`);
    }
  }
  // Newest first: `--limit` and the comment cap both keep the recent team.
  let prs = [...numbers].sort((a, b) => b - a);
  const enumerated = prs.length;
  if (opts.limit !== undefined && opts.limit >= 0) prs = prs.slice(0, opts.limit);
  log(
    `history: ${enumerated} merged PRs since ${since.slice(0, 10)}${prs.length !== enumerated ? ` · ${prs.length} after --limit` : ""}`,
  );

  let scanned = 0;
  let missing = 0;
  const comments: HumanComment[] = [];
  const read = await mapPool(prs, cfg.backfill.concurrency, async (n) => {
    try {
      return { n, pr: await source.prReviews(n), error: null };
    } catch (err) {
      return { n, pr: null, error: String(err) };
    }
  });
  for (const { n, pr, error } of read) {
    if (error !== null) problems.push(`#${n}: ${error}`);
    if (!pr) {
      // An answer with no pull request leaves the history as partial as a
      // failed read does, and is said the same way.
      if (error === null) problems.push(`#${n}: GitHub returned no pull request — not read`);
      missing++;
      continue;
    }
    scanned++;
    comments.push(...humanCommentsOf(pr, cfg));
  }
  const truncated = comments.length > MAX_HUMAN_COMMENTS;
  // Newest PRs are the ones kept when the cap bites: they describe the team now.
  comments.sort((a, b) => b.pr - a.pr);

  const rounds: OwnRound[] = store
    .allRounds()
    .filter((r) => r.finished_at !== null && r.finished_at >= since && r.verdict !== null)
    .map((r) => ({
      pr: r.pr,
      round_no: r.round_no,
      verdict: r.verdict,
      finished_at: r.finished_at,
      backfilled: r.backfilled === 1,
      summary: r.summary,
    }));
  const feedback: FeedbackItem[] = store.feedbackSignalsSince(since).map((f) => ({
    pr: f.pr,
    kind: f.kind,
    created_at: f.created_at,
    author: f.author,
    body: f.body === null ? null : clip(f.body),
  }));
  log(
    `history: ${scanned} PRs read · ${comments.length} human comments · ${rounds.length} rounds · ${feedback.length} feedback signals`,
  );

  return {
    kind: DIGEST_KIND,
    version: DIGEST_VERSION,
    repo: cfg.github.repo,
    generated_at: now.toISOString(),
    window: { since, until: now.toISOString(), months },
    human: {
      prs_enumerated: enumerated,
      prs_scanned: scanned,
      prs_missing: missing,
      truncated,
      comments: comments.slice(0, MAX_HUMAN_COMMENTS),
    },
    rounds,
    feedback,
    problems,
  };
}

// ---- the one parser -----------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Validate a digest's text — the PC checks what it is about to write into the
 * state home with it, and the companion's engine reads the file back through
 * it. Structure only, and strict: a digest this version cannot read is
 * refused, never half-used.
 */
export function parseDigest(
  text: string,
): { ok: true; digest: ReviewHistoryDigest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  const d = raw as Partial<ReviewHistoryDigest> | null;
  if (typeof d !== "object" || d === null) return { ok: false, error: "not an object" };
  if (d.kind !== DIGEST_KIND)
    return { ok: false, error: `not a review history digest (kind ${JSON.stringify(d.kind)})` };
  if (d.version !== DIGEST_VERSION)
    return { ok: false, error: `unknown digest version ${JSON.stringify(d.version)}` };
  if (!isStr(d.repo) || !isStr(d.generated_at))
    return { ok: false, error: "missing repo / generated_at" };
  const w = d.window;
  if (!w || !isStr(w.since) || !isStr(w.until) || !isInt(w.months))
    return { ok: false, error: "bad window" };
  const h = d.human;
  if (
    !h ||
    !isInt(h.prs_enumerated) ||
    !isInt(h.prs_scanned) ||
    !isInt(h.prs_missing) ||
    typeof h.truncated !== "boolean" ||
    !Array.isArray(h.comments)
  ) {
    return { ok: false, error: "bad human section" };
  }
  for (const [i, c] of h.comments.entries()) {
    if (
      !c ||
      !isInt(c.pr) ||
      (c.kind !== "review" && c.kind !== "inline") ||
      !isStr(c.author) ||
      !isStr(c.body) ||
      !isStrOrNull(c.path) ||
      !isStr(c.state) ||
      !isStrOrNull(c.merged_at)
    ) {
      return { ok: false, error: `human.comments[${i}] is not a comment` };
    }
  }
  if (!Array.isArray(d.rounds)) return { ok: false, error: "no rounds array" };
  for (const [i, r] of d.rounds.entries()) {
    if (
      !r ||
      !isInt(r.pr) ||
      !isInt(r.round_no) ||
      typeof r.backfilled !== "boolean" ||
      !isStrOrNull(r.summary) ||
      !isStrOrNull(r.verdict) ||
      !isStrOrNull(r.finished_at)
    ) {
      return { ok: false, error: `rounds[${i}] is not a round` };
    }
  }
  if (!Array.isArray(d.feedback)) return { ok: false, error: "no feedback array" };
  for (const [i, f] of d.feedback.entries()) {
    if (
      !f ||
      !isInt(f.pr) ||
      !isStr(f.kind) ||
      !isStr(f.created_at) ||
      !isStrOrNull(f.body) ||
      !isStrOrNull(f.author)
    ) {
      return { ok: false, error: `feedback[${i}] is not a feedback signal` };
    }
  }
  if (!Array.isArray(d.problems) || !d.problems.every(isStr))
    return { ok: false, error: "no problems array" };
  return { ok: true, digest: d as ReviewHistoryDigest };
}
