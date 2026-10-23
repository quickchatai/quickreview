import { isAbsolute, relative } from "node:path";

/** Whether `child` is `parent` or lies under it, by path text alone (no
 * symlink resolution). A first segment that merely starts with two dots, such
 * as `..runs`, is a name inside `parent`; only `..` itself leaves it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
