// The files of a unified diff, in the shape GitHub's files API returns.
// A leaf: the setup replay and the regression replay (src/replay.ts) both
// plan lenses from a local `git diff`, and the regression replay may not
// import src/setup/.

import type { PrFileEntry } from "./github.js";

/**
 * The files of a unified diff (`git diff` output) in the shape GitHub's
 * files API returns and `buildPassPlan` reads: path, status, +/- counts and
 * the hunks as `patch` (absent for a binary). Paths come from the `+++`/`---`
 * lines (the `diff --git` header is ambiguous for a path with spaces), and
 * from `rename`/`Binary files` lines when there are none.
 */
export function parseUnifiedDiff(text: string): PrFileEntry[] {
  const out: PrFileEntry[] = [];
  const blocks = text.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  const unq = (p: string): string => {
    let s = p.trim();
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        s = JSON.parse(s) as string;
      } catch {
        s = s.slice(1, -1);
      }
    }
    return s.replace(/^[ab]\//, "");
  };
  for (const block of blocks) {
    const lines = block.split("\n");
    let from: string | null = null;
    let to: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let status = "modified";
    let additions = 0;
    let deletions = 0;
    let hunkAt = -1;
    for (const [i, line] of lines.entries()) {
      if (hunkAt >= 0) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        continue;
      }
      if (line.startsWith("@@")) {
        hunkAt = i;
        continue;
      }
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) renameTo = line.slice("rename to ".length);
      else if (line.startsWith("--- "))
        from = line.slice(4) === "/dev/null" ? null : unq(line.slice(4));
      else if (line.startsWith("+++ "))
        to = line.slice(4) === "/dev/null" ? null : unq(line.slice(4));
      else if (line.startsWith("Binary files ")) {
        const m = /^Binary files (.+?) and (.+?) differ$/.exec(line);
        if (m) {
          from = m[1] === "/dev/null" ? null : unq(m[1]!);
          to = m[2] === "/dev/null" ? null : unq(m[2]!);
        }
      }
    }
    if (renameFrom !== null && renameTo !== null) {
      status = "renamed";
      to ??= renameTo;
      from ??= renameFrom;
    }
    const filename = to ?? from ?? /^diff --git a\/(.+?) b\//.exec(lines[0] ?? "")?.[1] ?? null;
    if (filename === null) continue;
    const entry: PrFileEntry = { filename, additions, deletions, status };
    if (hunkAt >= 0) entry.patch = lines.slice(hunkAt).join("\n").replace(/\n+$/, "");
    if (status === "renamed" && from !== null && from !== filename) entry.previous_filename = from;
    out.push(entry);
  }
  return out;
}
