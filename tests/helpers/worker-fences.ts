// The scan behind the bot worker's fence: src/botworker.ts never opens
// state.db. A pure function over a repo root, so tests/botworker-fence.test.ts
// runs it on the real tree AND on a planted one.
//
// The daemon is the only SQLite writer (the live SQLITE_BUSY lock is why).
// A worker that opened the store would add a writer per round, so the worker's
// RUNTIME import closure must not contain the state store or a SQLite binding.
// Type-only imports are erased at build and load nothing, so they are not edges.
// The closure crosses into the review core (packages/pi-plugin) through the
// core's package specifiers, which name its sources.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stripComments, tsFilesUnder } from "./engine-fences.js";
import { CORE_NAME, CORE_PACKAGE, EXTENSION_DIRS, SRC_DIRS } from "./source-trees.js";

/** The packages that open a SQLite file. */
const SQLITE_PACKAGES = /^(?:better-sqlite3|node:sqlite|sqlite3|sqlite)$/;
/** The module that owns the store. */
const STATE_STORE = "src/state.ts";

/** The runtime import specifiers of a module: static imports, re-exports,
 * dynamic imports and side-effect imports, never `import type` / `export type`
 * (nor a statement whose every specifier is a `type` one). */
export function runtimeSpecifiers(text: string): string[] {
  const code = stripComments(text)
    .replace(/\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'][^"']+["']\s*;?/g, "")
    .replace(
      /\b(?:import|export)\s*\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}\s*from\s*["'][^"']+["']\s*;?/g,
      "",
    );
  return [
    ...code.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g),
    ...code.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g),
    ...code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]!);
}

/**
 * Chains "src/botworker.ts > ... > src/state.ts" (or "... > better-sqlite3"),
 * one per offending module, from the entry's runtime import closure. Empty when
 * the fence holds.
 */
export function workerReachesStateStore(root: string, entry = "src/botworker.ts"): string[] {
  const files = new Set(
    [...SRC_DIRS, ...EXTENSION_DIRS].flatMap((d) => tsFilesUnder(join(root, d))),
  );
  const start = join(root, entry);
  if (!files.has(start)) throw new Error(`${entry} does not exist under ${root}`);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const hits: string[] = [];
  const chain = (f: string, tail?: string): string => {
    const out: string[] = [];
    for (let c: string | null = f; c; c = parent.get(c) ?? null) out.unshift(relative(root, c));
    return [...out, ...(tail ? [tail] : [])].join(" > ");
  };
  while (queue.length > 0) {
    const f = queue.shift()!;
    if (relative(root, f) === STATE_STORE) {
      hits.push(chain(f));
      continue; // report the way in, not the store's own imports
    }
    for (const spec of runtimeSpecifiers(readFileSync(f, "utf8"))) {
      if (SQLITE_PACKAGES.test(spec)) {
        hits.push(chain(f, spec));
        continue;
      }
      const inCore = spec.startsWith(`${CORE_NAME}/`)
        ? join(root, CORE_PACKAGE, spec.slice(CORE_NAME.length + 1))
        : null;
      if (inCore === null && !spec.startsWith(".")) continue;
      const next = (inCore ?? resolve(dirname(f), spec)).replace(/\.js$/, ".ts");
      if (!files.has(next) || parent.has(next)) continue;
      parent.set(next, f);
      queue.push(next);
    }
  }
  return [...new Set(hits)].sort();
}

/** Words that name the store in the worker's own code (comments removed). */
export function workerNamesTheStore(root: string, entry = "src/botworker.ts"): string[] {
  const file = join(root, entry);
  if (!existsSync(file)) return [];
  const code = stripComments(readFileSync(file, "utf8"));
  return ["state.db", "QCR_STATE_DB", "StateStore", "better-sqlite3"].filter((w) =>
    code.includes(w),
  );
}
