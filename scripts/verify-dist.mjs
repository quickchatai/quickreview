#!/usr/bin/env node
// Does `dist/` actually contain what the build claims to have produced?
//
// Why this exists: `tsconfig.json` runs `incremental` (so
// `npm run dev`'s blocking typecheck is ~1s instead of ~4s) plus
// `noEmitOnError` (so a failing build cannot re-exec the TUI from a
// half-written dist). Together they leave one hole: tsc decides what to emit
// from its BUILD INFO, not from what is on disk. Delete one emitted file —
//
//     rm dist/src/tui/startup.js && npx tsc -p tsconfig.json   # exit 0
//
// — and tsc says everything is up to date and emits nothing. `npm run build`
// reports success over a `dist/` that is missing a module. The same state
// arrives from an interrupted build, a half-copied tree, or a `find … -delete`
// that went wider than intended.
//
// That is survivable in `dev-tui.sh` (node throws ERR_MODULE_NOT_FOUND on the
// spot). It is not survivable in `deploy.sh`, which rsyncs `dist/` to the VM:
// the missing module ships, and the daemon crashes there instead of here.
//
// So "the build succeeded" means "and the output is on disk". Cheap
// (~180 stats), dependency-free, and runs from a bare checkout.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");

/** tsconfig.json carries `//` comments; JSON.parse does not. */
export function readTsconfig(root = ROOT) {
  const raw = readFileSync(join(root, "tsconfig.json"), "utf8");
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
}

/**
 * Every `.ts` tsc is asked to compile, as repo-relative POSIX paths.
 *
 * Deliberately derived from tsconfig's own `include`/`exclude` rather than
 * hard-coded: the excluded set (e.g. `extensions/inline-bash.ts`, loaded from
 * source by pi's jiti) can change, and a checker that disagrees with the
 * compiler is worse than no checker.
 * `.d.ts` files declare types and emit nothing.
 * The explicit `.mjs` include (allowJs, for the vendored OpenViking helpers)
 * lists those files too: tsc copies them, and the worker needs them in dist/.
 */
export function inputFiles(root = ROOT, cfg = readTsconfig(root)) {
  const includeRoots = (cfg.include ?? [])
    .map((pattern) => pattern.split("/")[0])
    .filter((dir, i, all) => all.indexOf(dir) === i);
  const excluded = new Set((cfg.exclude ?? []).map((p) => p.replace(/\/+$/, "")));
  // A plain-JS tree the include names (`dir/**/*.mjs`, with allowJs) is emitted
  // too, under the same name.
  const jsDirs = (cfg.include ?? [])
    .filter((pattern) => pattern.endsWith(".mjs"))
    .map((pattern) => pattern.split("/**")[0]);
  const out = [];
  const walk = (relDir) => {
    if (excluded.has(relDir)) return;
    let entries;
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return; // an include root that does not exist here is not a failure
    }
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      if (excluded.has(rel)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(rel);
      else if (entry.name.endsWith(".mjs") && jsDirs.some((dir) => rel.startsWith(`${dir}/`)))
        out.push(rel);
    }
  };
  for (const dir of includeRoots) walk(dir);
  return out.sort();
}

/** Where tsc puts a given input. No `rootDir` is set, so the inferred one is
 * the repo root and the tree is mirrored under `outDir` (`dist/src/…`). A `.mjs`
 * keeps its name. */
export function emittedPath(relTs, cfg = readTsconfig()) {
  return `${cfg.compilerOptions?.outDir ?? "dist"}/${relTs.replace(/\.ts$/, ".js")}`;
}

/** Inputs whose compiled output is not on disk. Empty = the build is real. */
export function missingArtifacts(root = ROOT) {
  const cfg = readTsconfig(root);
  return inputFiles(root, cfg)
    .map((rel) => ({ source: rel, emitted: emittedPath(rel, cfg) }))
    .filter(({ emitted }) => !existsSync(join(root, emitted)));
}

function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : ROOT;
  const outDir = join(root, readTsconfig(root).compilerOptions?.outDir ?? "dist");
  if (!existsSync(outDir)) {
    console.error(
      `verify-dist: ${relative(root, outDir) || outDir} does not exist — the build produced nothing.`,
    );
    process.exit(1);
  }
  const missing = missingArtifacts(root);
  if (missing.length === 0) return;
  console.error(
    `verify-dist: the build reported success but ${missing.length} compiled file(s) are missing from dist/:`,
  );
  for (const { source, emitted } of missing.slice(0, 20))
    console.error(`  ${emitted}   (from ${source})`);
  if (missing.length > 20) console.error(`  … and ${missing.length - 20} more`);
  console.error("");
  console.error("This is `incremental`: tsc emits from its build info, not from what is on disk,");
  console.error("so a file deleted after the last successful build is never re-emitted. Fix with:");
  console.error("  rm -rf dist node_modules/.cache && npm run build");
  process.exit(1);
}

// `node scripts/verify-dist.mjs` runs the check; importing it does not.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
