// The docker suites run the repo's dist/ inside a container and need its
// node_modules at the same path. A checkout's node_modules is one of:
//   - a real directory (a plain clone);
//   - a symlink to another checkout's directory (readlink -f lands there);
//   - a real directory of per-entry symlinks into another tree (a worktree
//     set up that way): the directory alone mounts, but every entry is a
//     dangling link inside the container, so each distinct target parent must
//     be mounted too, at its own path.
// Every mount is read-only, so the sandbox properties the suites pin hold.
import { readdirSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The distinct directories that must exist, read-only and at their own path, for `root`'s node_modules to resolve. */
export function nodeModulesDirs(root: string): string[] {
  const nm = realpathSync(join(root, "node_modules"));
  const dirs = new Set<string>([nm]);
  for (const entry of readdirSync(nm)) {
    const p = join(nm, entry);
    if (!lstatSync(p).isSymbolicLink()) continue;
    const parent = dirname(realpathSync(p));
    if (parent !== nm) dirs.add(parent);
  }
  return [...dirs];
}

/** `--mount` argv pairs for `docker run`. */
export function nodeModulesMounts(root: string): string[] {
  return nodeModulesDirs(root).flatMap((d) => ["--mount", `type=bind,src=${d},dst=${d},readonly`]);
}
