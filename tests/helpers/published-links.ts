// The shipped-link check: every relative link in a tracked Markdown file must
// land on a tracked path, so the repository never carries a dead link (a moved
// artefact, a deleted doc, a file that was never committed).
//
// Pure over (tracked paths, file texts) so its own test can feed it plants.

import { posix } from "node:path";

export interface DeadLink {
  file: string;
  line: number;
  target: string;
  resolved: string;
}

/** Blank out fenced code blocks and inline code spans, keeping line numbers. */
function stripCode(text: string): string {
  const lines = text.split("\n");
  let fence: string | null = null;
  return lines
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
        return "";
      }
      if (m) {
        fence = m[1]!;
        return "";
      }
      return line.replace(/(`+)[^`]*?\1/g, "");
    })
    .join("\n");
}

const LINK_PATTERNS: RegExp[] = [
  // [text](target "title") and ![alt](target)
  /\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g,
  // [label]: target
  /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm,
  // <img src="…">, <a href="…">
  /\b(?:src|href)\s*=\s*["']([^"']+)["']/g,
];

/** Every relative link target in `text` with its 1-based line. */
export function relativeLinks(text: string): { line: number; target: string }[] {
  const body = stripCode(text);
  const out: { line: number; target: string }[] = [];
  for (const re of LINK_PATTERNS) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) {
      const target = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//"))
        continue;
      const line = body.slice(0, m.index).split("\n").length;
      out.push({ line, target });
    }
  }
  return out;
}

/** The repo path a link resolves to (GitHub semantics: `/x` is repo-root). */
export function resolveLink(fromFile: string, target: string): string {
  let t = target.replace(/[#?].*$/, "");
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep it as written */
  }
  const joined = t.startsWith("/") ? t.slice(1) : posix.join(posix.dirname(fromFile), t);
  return posix.normalize(joined).replace(/\/+$/, "").replace(/^\.$/, "");
}

export function deadLinks(o: {
  tracked: readonly string[];
  files: readonly { path: string; text: string }[];
}): DeadLink[] {
  const trackedSet = new Set(o.tracked);
  const isTracked = (r: string) =>
    r === "" || trackedSet.has(r) || o.tracked.some((p) => p.startsWith(r + "/"));
  const out: DeadLink[] = [];
  for (const f of o.files) {
    if (!f.path.endsWith(".md")) continue;
    for (const { line, target } of relativeLinks(f.text)) {
      const resolved = resolveLink(f.path, target);
      if (!resolved.startsWith("..") && isTracked(resolved)) continue;
      out.push({ file: f.path, line, target, resolved });
    }
  }
  return out;
}
