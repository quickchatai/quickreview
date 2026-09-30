/**
 * Author-controlled text rendered as Markdown DATA. A leaf module (no imports)
 * so any renderer can use it without pulling in the prompt templates — the
 * round prompts (`templates.ts`) and the escalation note (`escalation.ts`)
 * both render repository paths, and both must keep them literal.
 */

/** Control characters (newlines included) as visible `\\uXXXX` escapes, so
 * author-controlled text can never start a new line of prompt. */
export function flatControls(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * A repository path as an inline code span that stays DATA. Git paths may hold
 * backticks, pipes and newlines, and they are author-controlled: rendered raw
 * they could close the span, split a plan-table row, or open a new line of
 * daemon-authored prompt text. Control characters are shown as `\uXXXX`,
 * and the fence is one backtick longer than any run inside the name
 * (CommonMark), so the name reads back exactly otherwise. Pipes are escaped
 * only for a TABLE cell (`table`): GFM un-escapes `\|` there, even inside a
 * code span, but everywhere else the backslash would read back as part of
 * the path.
 */
export function codePath(path: string, opts: { table?: boolean } = {}): string {
  let flat = flatControls(path);
  if (opts.table) flat = flat.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((r) => r.length));
  if (longest === 0) return `\`${flat}\``;
  const fence = "`".repeat(longest + 1);
  return `${fence} ${flat} ${fence}`;
}

/**
 * Author-derived text quoted inside a daemon-authored `("…")` in prompt text.
 * It must not be able to close that quotation or start a new line of
 * instructions: control characters collapse to a space and a double quote
 * becomes a single one. No length cap — the caller owns the length (the round
 * memory query is clamped at its own 600-character budget, and quoting it
 * must not silently cut what the daemon actually asked).
 */
export function promptQuoted(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/"/g, "'");
}

/**
 * A PR title quoted inside daemon-authored prompt text (`("{{title}}")` in the
 * conversation system prompt and the round templates): `promptQuoted`, capped
 * at 256 characters as GitHub caps titles.
 */
export function promptTitle(title: string): string {
  return promptQuoted(title).slice(0, 256);
}
