// Maintainer-only text inside prompt files that must never reach a model.
//
// Two shapes, both kept in the SOURCE because people and tests read them:
//   - the leading `> Sandbox file: …` doc header (which file this is, who
//     loads it, which placeholders it takes) — rendering it sent the
//     placeholder list a second time, the whole lens plan included;
//   - the `<!-- RATIFIED … -->` / `<!-- /RATIFIED … -->` fence marker lines,
//     which tests/invariant-fences.test.ts pins in the source.
// Every load path that hands a prompt file to a model strips them here.

const FENCE_MARKER_LINE = /^[ \t]*<!--[ \t]*\/?RATIFIED\b[^\n]*?-->[ \t]*(?:\r?\n|$)/gm;
// The header blockquote, the blank lines after it, and an optional `---` rule
// (with its trailing blank lines) that separated it from the body.
const DOC_HEADER = /(^|\n)> Sandbox file:[^\n]*\n(?:>[^\n]*\n)*(?:[ \t]*\n)*(?:---[ \t]*\n(?:[ \t]*\n)*)?/;

/** The prompt text a model should read: no doc header, no fence markers. */
export function stripModelDocs(text: string): string {
  return text.replace(DOC_HEADER, "$1").replace(FENCE_MARKER_LINE, "");
}
