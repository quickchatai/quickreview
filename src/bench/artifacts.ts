// Session artifact names are shared without importing any runner or report modules.
// The case dir's file names and the PR description payload are the offline
// round's own (packages/pi-plugin/src/engine/caseout.ts).
export { CASE_FILES, prDescription } from "@quickchatai/pi-quickreview/src/engine/caseout.js";

/** Session comments accept both historical bare arrays and wrapped arrays. */
export function commentsEnvelope(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { comments?: unknown }).comments)
  )
    return (raw as { comments: unknown[] }).comments;
  return [];
}

export function singleLineComment(
  path: string,
  line: number,
  content: string,
): {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
} {
  return { path, start_line: line, end_line: line, content };
}
