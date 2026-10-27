// A finished PR review's post: the run's own (packages/pi-plugin/src/reviewapi.ts)
// and one the run kept for later (`post.json`, the result's `post_ready`),
// which a host posts once the person says yes. Both are one comment-only
// review through the one gate with the install's dry_run (AGENTS.md
// invariant 6). This module reaches only the post and the credential chain,
// never the review's runtime, so a host that only posts a kept review (the
// app's home) imports it alone.
import { readFileSync } from "node:fs";
import { localPostGate, postReviewToPr, type PostResult, type PostReview } from "./reviewpost.js";
import {
  resolvePostCredential,
  resolvePrCredential,
  type CredentialSource,
  type PrCredentialDeps,
  type PrFetchRequest,
} from "./prtarget.js";

/** The GitHub credential sources and where GitHub is (a test seam). */
export type PostGithub = PrCredentialDeps & Pick<PrFetchRequest, "fetchFn" | "gitBase" | "apiBase">;

/** A finished PR review that was not posted, kept beside the run's files
 * (`<out dir>/post.json`, the result's `post_ready`) so a host that asks the
 * person later posts exactly what `--to pr` would have (`postSavedReview`).
 * No credential is kept: the post resolves its own when it is made. */
export interface SavedPost {
  version: 1;
  repo: string;
  pr: number;
  /** The head the review is of: the post's commit. */
  head_sha: string;
  /** The credential the PR was read with, and the repo's `post_as`. */
  source: CredentialSource;
  post_as: string | null;
  /** Findings the bot had already posted on the PR, left out of `review`. */
  skipped: number;
  review: PostReview;
}

export const SAVED_POST_FILE = "post.json";

/** What a post did: the result's `post` block and its line for a person. */
export interface PostOutcome {
  failed: boolean;
  post: Record<string, unknown>;
  line: string;
}

/** Post one assembled review: one comment-only review through the one gate,
 * with the install's dry_run (AGENTS.md invariant 6). Both the run's own post
 * and a saved one go through here. */
export async function postAssembled(o: {
  repo: string;
  pr: number;
  headSha: string;
  credential: { ok: true; token: string } | { ok: false; error: string };
  review: PostReview;
  skipped: number;
  dryRun: boolean;
  dryrunDir: string;
  github?: PostGithub;
  log?: (line: string) => void;
}): Promise<PostOutcome> {
  const gh = o.github;
  const id = o.credential;
  // Every finding was the bot's already (none left inline or in the body):
  // there is nothing to post, not even a review body to repeat.
  const res: PostResult = !id.ok
    ? id
    : o.skipped > 0 && o.review.comments.length === 0 && !o.review.bodyFindings
      ? { ok: true, posted: 0, skipped: o.skipped, url: null }
      : await postReviewToPr({
          repo: o.repo,
          number: o.pr,
          headSha: o.headSha,
          token: id.token,
          // The one gate, with the install's dry_run: a dry-run install records
          // the review under its dryrun dir and sends nothing (AGENTS.md invariant 6).
          gate: localPostGate({
            dryRun: o.dryRun,
            dryrunDir: o.dryrunDir,
            token: id.token,
            ...(gh?.fetchFn ? { fetchFn: gh.fetchFn } : {}),
            ...(gh?.apiBase ? { apiBase: gh.apiBase } : {}),
            ...(o.log ? { log: (msg: string) => o.log!(`[quickreviewd] ${msg}`) } : {}),
          }),
          review: o.review,
          ...(gh?.fetchFn ? { fetchFn: gh.fetchFn } : {}),
          ...(gh?.apiBase ? { apiBase: gh.apiBase } : {}),
        });
  if (res.ok && res.recorded !== undefined)
    return {
      failed: false,
      post: {
        ok: true,
        posted: 0,
        skipped: res.skipped,
        url: null,
        dry_run: true,
        would_post: res.wouldPost,
        recorded: res.recorded,
      },
      line:
        `Dry run (dry_run = true in this install's config): the review of ${res.wouldPost} ` +
        `comment${res.wouldPost === 1 ? "" : "s"} on PR #${o.pr} was recorded, not posted: ${res.recorded}`,
    };
  if (res.ok)
    return {
      failed: false,
      post: { ok: true, posted: res.posted, skipped: res.skipped, url: res.url },
      line:
        res.posted === 0
          ? `Nothing posted: ${res.skipped} comment${res.skipped === 1 ? " is" : "s are"} already on the PR.`
          : `Posted ${res.posted} comment${res.posted === 1 ? "" : "s"} to PR #${o.pr} (comment-only review)` +
            `${res.skipped ? `, ${res.skipped} already there` : ""}${res.url ? `: ${res.url}` : ""}`,
    };
  return {
    failed: true,
    post: { ok: false, error: res.error },
    line: `Review not posted: ${res.error}`,
  };
}

/** Read a saved post; null when the file is not one. */
function readSavedPost(file: string): SavedPost | null {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedPost>;
    const r = s.review as Partial<PostReview> | undefined;
    if (
      s.version !== 1 ||
      typeof s.repo !== "string" ||
      typeof s.pr !== "number" ||
      typeof s.head_sha !== "string" ||
      typeof s.source !== "string" ||
      typeof s.skipped !== "number" ||
      r === undefined ||
      typeof r.body !== "string" ||
      !Array.isArray(r.comments)
    )
      return null;
    return { ...(s as SavedPost), post_as: typeof s.post_as === "string" ? s.post_as : null };
  } catch {
    return null;
  }
}

/** Post a finished review the run kept for later (`SavedPost`, the result's
 * `post_ready`): the same comment-only review `--to pr` makes, through the
 * same gate with the install's dry_run, posted as the credential found now
 * (or the repo's `post_as`). Never throws: the outcome says what happened. */
export async function postSavedReview(
  file: string,
  o: {
    config: { dry_run: boolean; github: { secrets_dir: string } };
    dryrunDir: string;
    github?: PostGithub;
    log?: (line: string) => void;
  },
): Promise<PostOutcome> {
  const fail = (error: string): PostOutcome => ({
    failed: true,
    post: { ok: false, error },
    line: `Review not posted: ${error}`,
  });
  const saved = readSavedPost(file);
  if (saved === null) return fail(`${file} is not a saved review`);
  const secrets = o.config.github.secrets_dir;
  let credential: { ok: true; token: string } | { ok: false; error: string };
  try {
    const read = await resolvePrCredential(secrets, o.github);
    credential = read.ok
      ? await resolvePostCredential(secrets, saved.post_as, read, o.github)
      : read;
  } catch (err) {
    credential = { ok: false, error: String(err).slice(0, 200) };
  }
  return postAssembled({
    repo: saved.repo,
    pr: saved.pr,
    headSha: saved.head_sha,
    credential,
    review: saved.review,
    skipped: saved.skipped,
    dryRun: o.config.dry_run,
    dryrunDir: o.dryrunDir,
    ...(o.github ? { github: o.github } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
}
