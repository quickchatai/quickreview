// Session artifact names are shared without importing any runner or report modules.
export const CASE_FILES = {
  comments: "comments.json",
  review: "review.md",
  findings: "findings-record.json",
  outcome: "outcome.json",
} as const;

/** Session comments accept both historical bare arrays and wrapped arrays. */
export function commentsEnvelope(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as { comments?: unknown }).comments))
    return (raw as { comments: unknown[] }).comments;
  return [];
}

/** The shared title/body payload inside each arm's own context framing. */
export function prDescription(meta: { title: string | null; body: string | null }): string[] {
  return [
    `Title: ${meta.title ?? "(unavailable)"}`,
    "",
    "```text",
    (meta.body ?? "(no description)").replaceAll("```", "ʼʼʼ"),
    "```",
  ];
}

export function singleLineComment(path: string, line: number, content: string): {
  path: string; start_line: number; end_line: number; content: string;
} {
  return { path, start_line: line, end_line: line, content };
}
