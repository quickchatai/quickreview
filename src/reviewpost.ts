// `qcr review` posting to a PR: one review whose event is always COMMENT.
//
// The body and inline comments come from the production renderer
// (`renderPostedReview`, with the hidden `qcr:f=` finding markers the live
// route adds), and every comment also carries a visible line saying it came
// from qcr. A re-post is deduplicated against the comments already on the PR.
//
// This is the LOCAL route's write, made as the person with the credential
// they already have (CLAUDE.md rule 3 carve-out). The write is a MutationIntent
// through the one MutationGate, with the install's `dry_run`: in dry-run the
// review is recorded under state/dryrun/ and nothing is sent (CLAUDE.md rule
// 1). The reads stay direct, as every read does. The daemon never imports this
// module; its writes go through its own gate.

import { existsSync, readFileSync } from "node:fs";
import { MutationGate, type MutationExecutor, type MutationIntent } from "./gate.js";
import { settingsPath } from "./localreview.js";
import { FINDING_MARKER_RE, parseFindingMarker, stripFindingMarkers } from "./findingkey.js";
import {
  postedRenderOptions,
  renderPostedReview,
  type PostedRenderConfig,
  type RenderedComment,
} from "./reviewrender.js";

/** The line every posted comment (and the review body) shows to a reader. */
export const QCR_VISIBLE_MARKER = "_Posted by qcr (local review)._";

/** The only review event this route ever sends. */
export const POST_EVENT = "COMMENT" as const;

export interface PostReview {
  event: typeof POST_EVENT;
  body: string;
  comments: RenderedComment[];
}

/** Add the visible marker above the hidden finding marker (or at the end). */
function mark(body: string): string {
  const hidden = body.match(new RegExp(`\\n*(${FINDING_MARKER_RE.source})\\s*$`));
  if (!hidden) return `${body.trimEnd()}\n\n${QCR_VISIBLE_MARKER}`;
  return `${body.slice(0, hidden.index).trimEnd()}\n\n${QCR_VISIBLE_MARKER}\n\n${hidden[1]}`;
}

/** The review to post from a findings record: rendered by the production
 * renderer, hidden markers on, every comment marked as qcr's. The verdict in
 * the record never reaches the event. */
export function assemblePostReview(
  record: unknown,
  o: {
    cfg: PostedRenderConfig;
    roundNo: number;
    lenses: readonly string[];
    verdict?: string | null;
    summary?: string | null;
  },
): PostReview {
  const { rendered } = renderPostedReview(record, {
    ...postedRenderOptions(o.cfg, {
      verdict: o.verdict ?? null,
      summary: o.summary ?? null,
      lensesApplied: o.lenses.length ? o.lenses.join(", ") : null,
    }),
    findingMarkers: { roundNo: o.roundNo },
  });
  return {
    event: POST_EVENT,
    body: mark(rendered.body),
    comments: rendered.comments.map((c) => ({ ...c, body: mark(c.body) })),
  };
}

export interface PostRequest {
  repo: string;
  number: number;
  headSha: string;
  /** Reads the PR's existing comments; the write goes through `gate`. */
  token: string;
  review: PostReview;
  /** The gate the review is posted through (see `localPostGate`). */
  gate: MutationGate;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

export type PostResult =
  | { ok: true; posted: number; skipped: number; url: string | null; recorded?: undefined }
  // Dry run: the gate recorded the review to `recorded` and sent nothing.
  | { ok: true; posted: 0; skipped: number; url: null; recorded: string; wouldPost: number }
  | { ok: false; error: string };

/** GitHub answered the gated write with a non-2xx. */
class GitHubRefusal extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`GitHub answered ${status}`);
  }
}

/**
 * The gate for a local or Action review: the install's `dry_run`, its
 * `state/dryrun/` directory, and a REST executor that sends an admitted
 * intent as `token`. The executor is reachable only through `gate.execute`,
 * so nothing here writes around dry-run.
 */
export function localPostGate(o: {
  dryRun: boolean;
  dryrunDir: string;
  token: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
}): MutationGate {
  const fetchFn = o.fetchFn ?? fetch;
  const api = o.apiBase ?? "https://api.github.com";
  const executor: MutationExecutor = async (intent) => {
    const res = await fetchFn(`${api}${intent.path}`, {
      method: intent.method,
      headers: { ...githubHeaders(o.token), "content-type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify(intent.body),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).replaceAll(o.token, "***").slice(0, 200);
      throw new GitHubRefusal(res.status, text);
    }
    return res.json().catch(() => ({}));
  };
  return new MutationGate(o.dryRun, o.dryrunDir, executor);
}

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
});

interface ExistingComment {
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
}

/** What identifies a comment's finding for a re-post: the text without our
 * markers, whitespace collapsed. */
const textOf = (body: string): string =>
  stripFindingMarkers(body).replace(QCR_VISIBLE_MARKER, "").replace(/\s+/g, " ").trim();

const sameFinding = (c: RenderedComment, e: ExistingComment): boolean => {
  if (e.path !== c.path || typeof e.body !== "string") return false;
  const mc = parseFindingMarker(c.body);
  const me = parseFindingMarker(e.body);
  const eLine = e.line ?? e.original_line ?? null;
  if (mc && me && mc.key === me.key && eLine === c.line) return true;
  return textOf(c.body) === textOf(e.body);
};

export async function postReviewToPr(req: PostRequest): Promise<PostResult> {
  // The guard the whole route hangs on: a payload that is not a plain comment
  // review is refused here, whatever built it.
  if (req.review.event !== POST_EVENT)
    return {
      ok: false,
      error: `refusing to post a ${String(req.review.event)} review: comment only`,
    };
  const fetchFn = req.fetchFn ?? fetch;
  const api = req.apiBase ?? "https://api.github.com";
  const headers = githubHeaders(req.token);
  const where = `${req.repo}#${req.number}`;
  const existing: ExistingComment[] = [];
  try {
    for (let page = 1; page <= 20; page++) {
      const res = await fetchFn(
        `${api}/repos/${req.repo}/pulls/${req.number}/comments?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(60_000) },
      );
      if (!res.ok)
        return {
          ok: false,
          error: `GitHub answered ${res.status} reading the comments on ${where}`,
        };
      const list = (await res.json()) as ExistingComment[];
      existing.push(...list);
      if (list.length < 100) break;
    }
  } catch (err) {
    return {
      ok: false,
      error: `could not read the comments on ${where}: ${String(err).slice(0, 200)}`,
    };
  }
  const fresh = req.review.comments.filter((c) => !existing.some((e) => sameFinding(c, e)));
  const skipped = req.review.comments.length - fresh.length;
  // Everything was already there: a second review would only repeat the body.
  if (fresh.length === 0 && req.review.comments.length > 0)
    return { ok: true, posted: 0, skipped, url: null };
  const intent: MutationIntent = {
    kind: "create_review",
    method: "POST",
    path: `/repos/${req.repo}/pulls/${req.number}/reviews`,
    body: {
      commit_id: req.headSha,
      event: POST_EVENT,
      body: req.review.body,
      comments: fresh,
    },
    note: `qcr review: ${fresh.length} comment${fresh.length === 1 ? "" : "s"} on ${where}`,
    pr: req.number,
  };
  try {
    const out = await req.gate.execute(intent);
    if (out.dryRunFile !== undefined)
      return {
        ok: true,
        posted: 0,
        skipped,
        url: null,
        recorded: out.dryRunFile,
        wouldPost: fresh.length,
      };
    if (!out.executed)
      return { ok: false, error: `the gate did not post the review on ${where} (${out.blocked})` };
    const url = (out.response as { html_url?: string } | undefined)?.html_url;
    return { ok: true, posted: fresh.length, skipped, url: url ?? null };
  } catch (err) {
    if (err instanceof GitHubRefusal)
      return {
        ok: false,
        error: `GitHub refused the review on ${where} (${err.status}) ${err.detail}`.trim(),
      };
    return { ok: false, error: `could not post to ${where}: ${String(err).slice(0, 200)}` };
  }
}

/** The repo's configured posting identity (`post_as` in `.git/qcr-review.json`):
 * which credential source to post as. Null: the credential the PR was read
 * with. Any other value is returned as written; an unrecognised one is
 * rejected at posting time, so a typo never changes who posts. */
export function loadPostIdentity(cwd: string): string | null {
  const path = settingsPath(cwd);
  if (path === null || !existsSync(path)) return null;
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["post_as"];
    return typeof v === "string" && v !== "" ? v : null;
  } catch {
    return null;
  }
}
