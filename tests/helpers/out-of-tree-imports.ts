// The files the build reads from outside its own trees. An image that runs
// `tsc -b` copies src/, extensions/ and packages/; a source file that imports
// past them (the installer's types from plugins/qcr/) compiles in a checkout
// and fails in the image unless that file is copied too. This finds them by
// reading the imports, so a new one is seen without naming it here.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { EXTENSION_DIRS, SRC_DIRS } from "./source-trees.js";

/** The trees an image's build copies whole. */
export const BUILD_TREES = ["src", "extensions", "packages"] as const;

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
}

/** The file tsc reads for an import of `abs`: its declaration sibling when
 * there is one (render.mjs is typed by render.d.mts), else the file. */
function typeInput(abs: string): string {
  const decl = abs.replace(/\.mjs$/, ".d.mts").replace(/\.js$/, ".d.ts");
  return decl !== abs && existsSync(decl) ? decl : abs;
}

/** Repo-relative paths, sorted, of every file outside BUILD_TREES that a
 * source file under them imports (a static `from` or a literal `import()`). */
export function outOfTreeTypeInputs(root: string): string[] {
  const files: string[] = [];
  for (const d of [...SRC_DIRS, ...EXTENSION_DIRS]) walk(join(root, d), files);
  const found = new Set<string>();
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const specs = [
      ...code.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']/g),
      ...code.matchAll(/\bimport\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g),
    ].map((m) => m[1]!);
    for (const spec of specs) {
      const rel = relative(root, join(file, "..", spec));
      if (rel.startsWith("..")) continue;
      if (BUILD_TREES.some((t) => rel === t || rel.startsWith(`${t}/`))) continue;
      found.add(relative(root, typeInput(join(root, rel))));
    }
  }
  return [...found].sort();
}

/** Whether a Dockerfile's instructions copy `rel` (itself or a parent
 * folder) into the same path before its `RUN npx tsc -b`. */
export function copiedBeforeTsc(instructions: readonly string[], rel: string): boolean {
  const tsc = instructions.findIndex((l) => l.startsWith("RUN npx tsc -b"));
  if (tsc < 0) return false;
  return instructions.slice(0, tsc).some((l) => {
    if (!l.startsWith("COPY ") || l.includes("--from=")) return false;
    const parts = l.split(/\s+/).slice(1);
    const dest = parts.at(-1)!;
    return parts
      .slice(0, -1)
      .some((src) => (src === rel && dest === rel) || (rel.startsWith(`${src}/`) && dest === src));
  });
}
