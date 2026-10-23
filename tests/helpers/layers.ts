// The two layers of the review system. Pure functions over a repo root, so
// tests/layers.test.ts can run them on the real tree AND on a planted copy: a
// fence that cannot be made to fail is not one.
//
//   core  the review engine: the pi plugin package, packages/pi-plugin. It
//         imports only core, pi's root specifiers, smol-toml and node:*.
//   app   everything else: the CLI and its verbs, the daemon, workers, TUI,
//         companion, memory, bench, setup, archive. It imports anything.
//
// Membership is the package a file lives in. Runtime edges only: each file is
// transpiled the way tsc emits it, so an import used only as a type is elided
// here exactly as it is in dist/ (a core type import of the app does not
// compile in the core's own project anyway).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import ts from "typescript";

export type Layer = "core" | "app";

/** The core's package: its directory and the name the app imports it by. */
export const CORE_DIR = "packages/pi-plugin/";
export const CORE_NAME = "@quickchatai/pi-quickreview";

/** The layer a repo-relative .ts path belongs to. */
export function layerOf(rel: string): Layer {
  return rel.startsWith(CORE_DIR) ? "core" : "app";
}

/** Every .ts under a tree, recursively, skipping vendored code; [] when absent. */
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "vendor" || e.name === "node_modules"
        ? []
        : tsFilesUnder(join(dir, e.name))
      : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/** The source roots the fence reads. */
export const SOURCE_ROOTS = ["src", "extensions", "packages"];

/** Every fenced .ts file, repo-relative and sorted. */
export function fencedFiles(root: string): string[] {
  return SOURCE_ROOTS.flatMap((d) => tsFilesUnder(join(root, d)))
    .map((f) => relative(root, f))
    .sort();
}

/**
 * The relative specifiers a file loads at RUNTIME: static imports and
 * re-exports that survive tsc's elision, side-effect imports, and dynamic
 * `import()` of a string literal.
 */
export function runtimeSpecifiers(text: string): string[] {
  const js = ts.transpileModule(text, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      removeComments: true,
    },
  }).outputText;
  const out = new Set<string>();
  for (const m of js.matchAll(
    /(?:^|[\n;])\s*(?:import|export)\s*(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    out.add((m[1] ?? m[2])!);
  }
  return [...out];
}

/** Resolve a relative specifier, or one of the core's package specifiers
 * (`@quickchatai/pi-quickreview/src/x.js`, the sources the workspace link
 * serves), from `fromRel` to a repo-relative .ts path, or null. */
export function resolveSpecifier(root: string, fromRel: string, spec: string): string | null {
  const pkg = spec.startsWith(`${CORE_NAME}/`) ? spec.slice(CORE_NAME.length + 1) : null;
  if (pkg === null && !spec.startsWith(".")) return null;
  const abs = pkg !== null ? resolve(root, CORE_DIR, pkg) : resolve(root, dirname(fromRel), spec);
  for (const cand of [abs.replace(/\.js$/, ".ts"), `${abs}.ts`, join(abs, "index.ts")]) {
    if (cand.endsWith(".ts") && existsSync(cand)) return relative(root, cand);
  }
  return null;
}

/** Bare package specifiers core may load at runtime. */
export const CORE_PACKAGES: readonly RegExp[] = [
  /^node:/,
  /^smol-toml$/,
  /^typebox$/,
  /^@earendil-works\/pi-(coding-agent|ai|agent-core|tui)$/,
];

/** One upward edge: `from` (in a lower layer) loads `to` (in a higher one). */
export interface LayerEdge {
  from: string;
  to: string;
}

/**
 * Every runtime edge that points UP the layers (core → app), and every bare
 * package core loads outside CORE_PACKAGES (as `to: "pkg:<name>"`; the
 * app's own package and the core's by name are among them). Sorted, as
 * `from -> to` strings.
 */
export function upwardEdges(root: string): string[] {
  const out: string[] = [];
  for (const rel of fencedFiles(root)) {
    if (layerOf(rel) === "app") continue;
    for (const spec of runtimeSpecifiers(readFileSync(join(root, rel), "utf8"))) {
      if (!spec.startsWith(".")) {
        if (!CORE_PACKAGES.some((re) => re.test(spec))) out.push(`${rel} -> pkg:${spec}`);
        continue;
      }
      const to = resolveSpecifier(root, rel, spec);
      if (to && layerOf(to) === "app") out.push(`${rel} -> ${to}`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * What core never does itself: own the process, read the caller's cwd, home
 * or environment, or talk to a terminal. Each hit is `file: <name>`; a host
 * passes these in instead.
 */
export const CORE_FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "process.exit", re: /\bprocess\.exit\s*\(/ },
  { name: "process.cwd", re: /\bprocess\.cwd\s*\(/ },
  { name: "console", re: /\bconsole\.(log|error|warn|info|debug)\s*\(/ },
  { name: "homedir", re: /\b(os\.)?homedir\s*\(/ },
  { name: "readline", re: /["']node:readline(\/promises)?["']/ },
];

/** Comments removed, so prose that names a forbidden call is not a hit. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

/** Every forbidden call in a core file, as `file: name` strings, sorted. */
export function coreForbiddenCalls(root: string): string[] {
  const out = new Set<string>();
  for (const rel of fencedFiles(root)) {
    if (layerOf(rel) !== "core") continue;
    const code = stripComments(readFileSync(join(root, rel), "utf8"));
    for (const f of CORE_FORBIDDEN) if (f.re.test(code)) out.add(`${rel}: ${f.name}`);
  }
  return [...out].sort();
}
