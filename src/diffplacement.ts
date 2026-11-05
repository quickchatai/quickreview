// Where a review's inline comments can go on GitHub's diff of the PR, and
// how the ones that cannot go there are carried in the review body instead.
//
// GitHub refuses a whole review (422 "Line could not be resolved") when one
// of its inline comments names a line GitHub cannot place on the PR's diff,
// and it does not say which one. Two cases are known:
//   - a file GitHub serves with no patch at all (a diff too large to show,
//     such as a generated translation file of several thousand lines), which
//     no comment can be placed on;
//   - a very large PR, where GitHub cannot place lines even in some files the
//     files API does serve a patch for. That case cannot be read in advance.
// `splitByDiff` catches the first case before the POST, keeping every other
// comment inline. The post op answers the second case after GitHub's 422 by
// posting once more with every comment in the body (`foldIntoBody`). Either
// way the review and its findings reach the author, rather than a refused
// POST losing the whole review.
//
// Pure: no I/O.

import { parseHunkHeader } from "@quickchatai/pi-quickreview/src/hunkheader.js";
import type { FileList } from "./github.js";
import type { InlineComment } from "./posting.js";

/** The longest a review body may be once comments are folded into it. GitHub
 * refuses a body over 65,536 characters; the margin leaves room for the
 * posting marker and the security-gap lines appended after this. */
export const FOLDED_BODY_MAX = 60_000;

/** Why comments were moved before the POST: GitHub serves no diff GitHub
 * can place them on. */
export const NOT_ON_DIFF_NOTE =
  "GitHub shows no diff it can place these on (the file's diff is too large to show, or the lines fall outside it), so they are given here.";

/** Why comments were moved after a 422: GitHub could not place them and did
 * not say which. */
export const UNRESOLVED_NOTE =
  "GitHub could not place one or more of these on its diff of this pull request (it does not say which), so they are all given here.";

/** A hunk's line span on one side: first and last line, empty when count is 0. */
interface Span {
  first: number;
  last: number;
}

/** Each hunk's span on each side, from a files-API `patch`. */
function hunkSpans(patch: string): Array<{ RIGHT: Span; LEFT: Span }> {
  const out: Array<{ RIGHT: Span; LEFT: Span }> = [];
  for (const raw of patch.split("\n")) {
    const h = raw.startsWith("@@") ? parseHunkHeader(raw) : null;
    if (!h) continue;
    out.push({
      RIGHT: { first: h.new_start, last: h.new_start + h.new_count - 1 },
      LEFT: { first: h.old_start, last: h.old_start + h.old_count - 1 },
    });
  }
  return out;
}

/**
 * Whether GitHub can place the comment on the diff: its file is listed with a
 * patch, and its line (and `start_line`, for a range) lie inside one hunk on
 * its side. Context lines inside a hunk count: GitHub places a comment on any
 * line its diff shows. `undefined` when the list cannot tell (a list GitHub
 * cut short that does not name the file, or a range spanning both sides).
 */
export function placeable(files: FileList, c: InlineComment): boolean | undefined {
  const entry = files.find((f) => f.filename === c.path);
  if (!entry) return files.truncated ? undefined : false;
  if (typeof entry.patch !== "string" || entry.patch === "") return false;
  const side = c.side ?? "RIGHT";
  const startSide = (c as { start_side?: string }).start_side ?? side;
  if (startSide !== side) return undefined;
  const start = c.start_line ?? c.line;
  return hunkSpans(entry.patch).some((h) => {
    const s = h[side];
    return s.first <= start && start <= c.line && c.line <= s.last;
  });
}

/** Split comments into those GitHub can place and those it cannot. A comment
 * the list cannot judge stays inline: GitHub's own answer decides it. */
export function splitByDiff(
  comments: InlineComment[],
  files: FileList,
): { placed: InlineComment[]; folded: InlineComment[] } {
  const placed: InlineComment[] = [];
  const folded: InlineComment[] = [];
  for (const c of comments) (placeable(files, c) === false ? folded : placed).push(c);
  return { placed, folded };
}

/** Where a comment was anchored, as the body names it. */
function where(c: InlineComment): string {
  const range = c.start_line !== undefined && c.start_line !== c.line ? `${c.start_line}–` : "";
  const removed = (c.side ?? "RIGHT") === "LEFT" ? " (a removed line)" : "";
  return `\`${c.path}:${range}${c.line}\`${removed}`;
}

/**
 * The review body with `folded` appended: one section naming why, then each
 * comment's place and its full text. The section stops before the body
 * would pass `max`, and says how many were left out.
 */
export function foldIntoBody(
  text: string,
  folded: InlineComment[],
  note: string,
  max = FOLDED_BODY_MAX,
): string {
  if (folded.length === 0) return text;
  let out = `${text.trimEnd()}\n\n### Comments given here instead of inline\n\n${note}`;
  for (const [i, c] of folded.entries()) {
    const item = `\n\n---\n\n**${where(c)}**\n\n${c.body.trim()}`;
    const left = folded.length - i;
    const tail = `\n\n_${left} more comment(s) did not fit in the review body._`;
    if (out.length + item.length + tail.length > max) return out + tail;
    out += item;
  }
  return out;
}

/** GitHub's validation text says an inline comment could not be placed. */
export function isAnchorRejection(validation: string): boolean {
  return /could not be resolved|must be part of the (diff|same hunk)|pull_request_review_thread/i.test(
    validation,
  );
}
