// Path globs for exclusion lists (`[scan] exclude`). Deliberately
// small and gitignore-shaped, so an operator's pattern means what it looks
// like:
//
//   *        any run of characters inside one path segment
//   **       any run of characters, `/` included (`a/**/b`, `**/x.py`)
//   ?        one character inside a segment
//   name     a pattern with no `/` (a trailing one aside) matches that name
//            at ANY depth (`*.pb.go`, `generated/`); one with an inner `/`
//            is anchored at the repo root (`src/legacy/**`, `docs/api`)
//
// A pattern also matches everything under a directory it matches, so
// `generated` excludes `a/generated/x.py`. Nothing else is special: every
// other character is literal.

/** Why `glob` is not a usable pattern, or null when it is. */
export function globProblem(glob: unknown): string | null {
  if (typeof glob !== "string" || glob.trim() === "") return "must be a non-empty string";
  if (glob.startsWith("/")) return "must be repo-relative (no leading /)";
  if (glob.split("/").includes("..")) return "must not contain `..`";
  if (glob.includes("\0")) return "must not contain NUL";
  return null;
}

/** The RegExp a glob compiles to (see the header). */
export function globToRegExp(glob: string): RegExp {
  // A trailing slash adds nothing the `(?:/.*)?` tail does not already say.
  const g = glob.trim().replace(/\/+$/, "");
  const anchored = g.includes("/");
  let body = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          body += "(?:.*/)?";
        } else body += ".*";
      } else body += "[^/]*";
    } else if (c === "?") body += "[^/]";
    else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const lead = anchored ? "^" : "(?:^|/)";
  return new RegExp(`${lead}${body}(?:/.*)?$`);
}

/** A predicate over repo-relative paths: true when any glob matches. */
export function globMatcher(globs: readonly string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}

/** `globMatcher`, failing CLOSED: a list the compiler refuses matches
 * nothing (never everything). */
export function globMatcherOrNothing(globs: readonly string[]): (path: string) => boolean {
  try {
    return globMatcher(globs);
  } catch {
    return () => false;
  }
}
