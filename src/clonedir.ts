// The base clone's directory name, derived from the repo — one rule for the
// config (`githubCloneDir`) and the worktree manager, which keeps zero config
// imports. `scripts/deploy.sh` mirrors it in shell (tests/deploy.test.ts holds
// the two together). Pure.

/** A repo slug's or URL's last path segment, `.git` and trailing slashes
 * stripped; "repo" when nothing is left ("owner/name" ⇒ "name"). */
export function repoCloneDirName(repo: string): string {
  const tail = repo
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop();
  return tail || "repo";
}
