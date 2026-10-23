// The three layers (the pi plugin and npm CLI refactor). Pure
// functions over a repo root, so tests/layers.test.ts can run them on the real
// tree AND on a planted copy: a fence that cannot be made to fail is not one.
//
//   core  the review engine: what the pi plugin package ships. It imports
//         only core, pi's root specifiers, smol-toml and node:*.
//   cli   the local verbs: what the npm CLI package adds over the core. It
//         imports core and cli, never the app.
//   app   everything else (daemon, workers, TUI, companion, memory, bench,
//         setup, archive). It imports anything.
//
// Runtime edges only: each file is transpiled the way tsc emits it, so an
// import used only as a type is elided here exactly as it is in dist/.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import ts from "typescript";

export type Layer = "core" | "cli" | "app";

/**
 * Core membership: a path ending in `/` is a directory (every .ts under it),
 * anything else one file. Membership is by path until the files move into
 * packages/ (step W2); after that it is the package a file lives in.
 */
export const CORE: readonly string[] = [
  // The engine, less the hosts that belong to the bot, bench and setup.
  "src/engine/",
  // The review planner and the review config (split out of dispatch.ts and
  // config.ts by steps U3 and U4).
  "src/planner.ts",
  "src/reviewconfig.ts",
  // The PR-owned delta a follow-up round is planned from, and the exec seam
  // its git runs through (split out of worktrees.ts and tmux.ts by U3).
  "src/prdelta.ts",
  "src/execfn.ts",
  // The agent build, the prompts and the renderers.
  "src/include.ts",
  "src/templates.ts",
  "src/promptdoc.ts",
  "src/passes.ts",
  "src/passtasks.ts",
  "src/priortasks.ts",
  "src/priorfindings.ts",
  "src/lensresult.ts",
  "src/lenstuning.ts",
  "src/lensids.ts",
  "src/lensplanning.ts",
  "src/launchvocab.ts",
  "src/plankey.ts",
  "src/ledgercarry.ts",
  "src/contextpack.ts",
  "src/depsources.ts",
  "src/severity.ts",
  "src/severityrank.ts",
  "src/styleguide.ts",
  "src/lintconfig.ts",
  "src/loosenedtests.ts",
  "src/ecosystem.ts",
  "src/migrations.ts",
  "src/heuristics.ts",
  "src/profiles.ts",
  "src/profileoverrides.ts",
  "src/reviewrender.ts",
  "src/escalationprompt.ts",
  "src/reviewerstub.ts",
  "src/round-progress.ts",
  "src/round-stage-deadlines.ts",
  "src/followup-mode.ts",
  "src/coverage.ts",
  // Findings, diffs and their keys.
  "src/findingkey.ts",
  "src/finding-row.ts",
  "src/finding-chain.ts",
  "src/findingsrecord.ts",
  "src/dedup.ts",
  "src/doubtwords.ts",
  "src/codespan.ts",
  "src/anchors.ts",
  "src/unifieddiff.ts",
  "src/hunkheader.ts",
  // Posting: the one gate, its policy and guards, the JSON contract.
  "src/gate.ts",
  "src/postingkey.ts",
  "src/guards.ts",
  "src/standing-review.ts",
  "src/cigate.ts",
  "src/postingpolicy.ts",
  "src/contract.ts",
  "src/ghcred.ts",
  "src/githubcore.ts",
  // The LiveEvent log a round writes (viewers stay in the app).
  "src/live/events.ts",
  "src/live/writer.ts",
  // Small shared leaves.
  "src/types.ts",
  "src/glob.ts",
  "src/packing.ts",
  "src/pathinside.ts",
  "src/envstrip.ts",
  "src/casebudget.ts",
  "src/budget.ts",
  "src/authwatch.ts",
  "src/pibuiltins.ts",
  "src/settledread.ts",
  "src/yieldloop.ts",
  "src/pricing.ts",
  "src/pr-identity.ts",
  // The extensions a review session is built with.
  "extensions/lens.ts",
  "extensions/bash-guard.ts",
  "extensions/ledger-pin.ts",
  "extensions/finding-clusters.ts",
  "extensions/pi-tool.ts",
];

/** Engine files that are hosts for the bot, bench or setup: app, not core. */
export const CORE_EXCEPT: readonly string[] = [
  "src/engine/botsdk.ts",
  "src/engine/benchsdk.ts",
  "src/engine/caserunner-sdk.ts",
  "src/engine/debugpi.ts",
  "src/engine/answerguard.ts",
];

/** CLI membership: the local verbs and their modules (step W3 moves them). */
export const CLI: readonly string[] = [
  "src/reviewcli.ts",
  "src/localreview.ts",
  "src/oneshot.ts",
  "src/prtarget.ts",
  "src/reviewstore.ts",
  "src/reviewdetach.ts",
  "src/reviewpost.ts",
  "src/reviewdelta.ts",
  "src/reviewdest.ts",
  "src/reviewstate.ts",
  "src/reviewbotfindings.ts",
  "src/hostroute.ts",
  "src/diffinput.ts",
  "src/picli.ts",
  "src/clonedir.ts",
  "src/homes.ts",
];

function member(rel: string, list: readonly string[]): boolean {
  return list.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

/** The layer a repo-relative .ts path belongs to. */
export function layerOf(rel: string): Layer {
  if (member(rel, CORE) && !CORE_EXCEPT.includes(rel)) return "core";
  if (member(rel, CLI)) return "cli";
  return "app";
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

/** The source roots the fence reads (the packages join them at step W1). */
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

/** Resolve a relative specifier from `fromRel` to a repo-relative .ts path, or null. */
export function resolveSpecifier(root: string, fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const abs = resolve(root, dirname(fromRel), spec);
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

function rank(l: Layer): number {
  return l === "core" ? 0 : l === "cli" ? 1 : 2;
}

/**
 * Every runtime edge that points UP the layers (core → cli/app, cli → app),
 * and every bare package core loads outside CORE_PACKAGES (as `to:
 * "pkg:<name>"`). Sorted, as `from -> to` strings.
 */
export function upwardEdges(root: string): string[] {
  const out: string[] = [];
  for (const rel of fencedFiles(root)) {
    const from = layerOf(rel);
    if (from === "app") continue;
    for (const spec of runtimeSpecifiers(readFileSync(join(root, rel), "utf8"))) {
      if (!spec.startsWith(".")) {
        if (from === "core" && !CORE_PACKAGES.some((re) => re.test(spec))) {
          out.push(`${rel} -> pkg:${spec}`);
        }
        continue;
      }
      const to = resolveSpecifier(root, rel, spec);
      if (to && rank(layerOf(to)) > rank(from)) out.push(`${rel} -> ${to}`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * What core never does itself: own the process, read the caller's cwd, home
 * or environment, or talk to a terminal. Each hit is `file: <name>`; a host
 * passes these in instead (step U8).
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
