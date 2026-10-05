// The shipped-link check: every relative link in a PUBLISHED
// Markdown file must land on a PUBLISHED path. "Published" is the tracked tree
// minus publish-manifest.json's exclusions — the same rule the snapshot
// assembly (scripts/publish-snapshot.sh) applies — so a link into an excluded
// path (a lab notebook, a moved artefact, a private doc) fails here, in the
// private checkout, before the snapshot ships a dead link. In an ASSEMBLED
// tree the manifest's `exclude` is empty and the excluded files are simply
// absent, so the same check reads "the target exists".
//
// Pure over (published paths, file texts) so its own test can feed it plants.

import { posix } from "node:path";

export interface ManifestEntry {
  path: string;
}

/** A manifest `path` ending in "/" is a directory prefix; otherwise exact. */
export function matchesEntry(path: string, entry: ManifestEntry): boolean {
  return entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path;
}

export interface DeadLink {
  file: string;
  line: number;
  target: string;
  resolved: string;
  /** `excluded`: the target exists in the checkout but the snapshot drops it.
   * `missing`: the target is not in the tracked tree at all. */
  kind: "excluded" | "missing";
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
  exclude: readonly ManifestEntry[];
  files: readonly { path: string; text: string }[];
}): DeadLink[] {
  const excluded = (p: string) => o.exclude.some((e) => matchesEntry(p, e));
  const published = o.tracked.filter((p) => !excluded(p));
  const pubSet = new Set(published);
  const trackedSet = new Set(o.tracked);
  const isPublished = (r: string) =>
    r === "" || pubSet.has(r) || published.some((p) => p.startsWith(r + "/"));
  const isTracked = (r: string) =>
    trackedSet.has(r) || o.tracked.some((p) => p.startsWith(r + "/"));
  const out: DeadLink[] = [];
  for (const f of o.files) {
    if (!f.path.endsWith(".md") || excluded(f.path)) continue;
    for (const { line, target } of relativeLinks(f.text)) {
      const resolved = resolveLink(f.path, target);
      if (resolved.startsWith("..")) {
        out.push({ file: f.path, line, target, resolved, kind: "missing" });
        continue;
      }
      if (isPublished(resolved)) continue;
      out.push({
        file: f.path,
        line,
        target,
        resolved,
        kind: isTracked(resolved) ? "excluded" : "missing",
      });
    }
  }
  return out;
}
