#!/usr/bin/env node
// Which CI jobs a change needs (.github/workflows/ci.yml, the `changes` and
// `ci` jobs). One pure function decides it from the changed paths, so
// tests/ci-changes.test.ts can hold every rule against fixtures; the CLI below
// is the only part that touches git or the runner.
//
// The rules, each job judged by its own inputs:
//   - Everything runs when the change is unknown (no diff, an empty diff) or
//     touches CI's own routing (ci.yml, this file).
//   - `full` (build + the whole suite) unless every path is docs prose; then
//     the test job runs DOCS_SUITE alone, with no build.
//   - `lint` (eslint + prettier) when a path is a file either tool reads.
//   - `image` when a path enters the release image's build context, read from
//     docker/Dockerfile.dockerignore itself, or is the Dockerfile or its smoke.
//   - `clone` unless every path is one the clone route never reads.
// A path no rule names lands in `full` and `clone`: an unknown file costs time,
// never a skipped check.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROUTING = [".github/workflows/ci.yml", ".github/ci/changes.mjs"];

/** classify's keys, each a `changes` job output; every one but `full` names
 * the job it gates. */
export const ROUTES = ["full", "lint", "image", "clone"];

/** Prose a reader reads and no build, image or clone consumes. Markdown inside
 * a code or data directory is not prose: whole-tree fences scan those. */
export const isDocs = (p) =>
  /^docs\/.+\.md$/.test(p) ||
  p.startsWith("docs/media/") ||
  /^[^/]+\.md$/.test(p) ||
  /^\.github\/[^/]+\.md$/.test(p) ||
  p === "memory/README.md";

/** The test files that read docs prose, the whole of a docs-only run. A test
 * that starts reading docs joins this list; tests/ci-changes.test.ts fails a
 * test file that names a docs file and is in neither this list nor its
 * exemptions. context-files and reviewer-context hold the root's agent
 * context files (AGENTS.md present, no AGENTS.override.md). They all pass
 * with no dist/. */
export const DOCS_SUITE = [
  "tests/action.test.ts",
  "tests/ci-clone-smoke.test.ts",
  "tests/companion-memory.test.ts",
  "tests/context-files.test.ts",
  "tests/fences-published.test.ts",
  "tests/fences-tui.test.ts",
  "tests/onboarding-docs.test.ts",
  "tests/publishability.test.ts",
  "tests/release-docs.test.ts",
  "tests/reviewer-context.test.ts",
  "tests/tool-uid.test.ts",
  "tests/tui-surfaces.test.ts",
  "tests/worker-rehearsal-tooling.test.ts",
];

// eslint lints the JS/TS family; prettier checks `**/*.{ts,mjs,js,json,yml,yaml}`
// (package.json `format:check`) and reads its ignore file and .editorconfig.
const LINTED = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|json|ya?ml)$/;
const LINT_CONFIG = new Set([".prettierignore", ".editorconfig"]);

const IMAGE_EXTRA = [
  "docker/Dockerfile",
  "docker/Dockerfile.dockerignore",
  ".github/ci/image-smoke.sh",
];

// What the clone route (.github/ci/clone-smoke.sh: npm ci, npm run build,
// scripts/qcr version and review --preview) never reads.
const NOT_CLONE = [
  /^docs\//,
  /^tests\/(?!fixtures\/seed-manifest\.json$)/,
  /^bench\//,
  /^docker\//,
  /^deploy\//,
  /^skills\//,
  /^\.claude\//,
  /^\.agents\//,
  /^\.github\/(?!ci\/clone-smoke\.sh$)/,
];

/** A .dockerignore as a predicate: is this path in the build context? Docker's
 * rules: the last matching pattern wins, `!` admits, a pattern that matches a
 * directory covers what is under it, and `*` matches dot files too. */
export function dockerContext(dockerignore) {
  const rules = dockerignore
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const admit = l.startsWith("!");
      const glob = (admit ? l.slice(1) : l).replace(/^\/+|\/+$/g, "");
      let re = "";
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
          re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
          i += glob[i + 2] === "/" ? 2 : 1;
        } else if (c === "*") re += "[^/]*";
        else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      return { admit, re: new RegExp(`^${re}(?:/.*)?$`) };
    });
  return (p) => {
    let inside = true;
    for (const r of rules) if (r.re.test(p)) inside = r.admit;
    return inside;
  };
}

const ALL = { full: true, lint: true, image: true, clone: true };

/** paths: the changed files, or null when they are unknown. */
export function classify(paths, { dockerignore }) {
  if (!paths || paths.length === 0) return { ...ALL };
  if (paths.some((p) => ROUTING.includes(p))) return { ...ALL };
  const inImage = dockerContext(dockerignore);
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  return {
    full: !paths.every(isDocs),
    lint: paths.some((p) => LINTED.test(p) || LINT_CONFIG.has(base(p))),
    image: paths.some((p) => IMAGE_EXTRA.includes(p) || inImage(p)),
    clone: !paths.every((p) => isDocs(p) || NOT_CLONE.some((re) => re.test(p))),
  };
}

/** The `ci` job's verdict over its needs (toJSON(needs)): `changes` passed
 * with every route a plain true or false, every job that ran passed, and
 * every job that was skipped had a route saying it was not needed. A job no
 * route names (`test`, or one added later) is always needed. */
export function gate(needs) {
  const changes = needs.changes;
  if (changes?.result !== "success") return [`changes: ${changes?.result ?? "missing"}`];
  const outputs = changes.outputs ?? {};
  const bad = ROUTES.filter((k) => outputs[k] !== "true" && outputs[k] !== "false");
  if (bad.length)
    return bad.map((k) => `changes: output ${k} is ${JSON.stringify(outputs[k] ?? null)}`);
  const problems = [];
  for (const [job, { result }] of Object.entries(needs)) {
    if (job === "changes") continue;
    const wanted = !(job in outputs) || outputs[job] === "true";
    if (result === "success" || (result === "skipped" && !wanted)) continue;
    problems.push(`${job}: ${result}${wanted ? " (needed)" : ""}`);
  }
  return problems;
}

// ---- CLI (run from the checkout's root) ----------------------------------------

/** The changed paths between base and HEAD, or null when base is unknown or
 * cannot be fetched. Renames count as a delete and an add. NUL-separated, so
 * a name with a newline or a non-ASCII byte arrives as itself, not quoted. */
function changedPaths(base) {
  if (!base || /^0+$/.test(base)) return null;
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  try {
    try {
      git("cat-file", "-e", `${base}^{commit}`);
    } catch {
      git("fetch", "--no-tags", "--depth=1", "origin", base);
    }
    return git("diff", "-z", "--name-only", "--no-renames", base, "HEAD")
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

function main([cmd, arg]) {
  if (cmd === "docs-suite") return void process.stdout.write(DOCS_SUITE.join("\n") + "\n");
  if (cmd === "classify") {
    const paths = changedPaths(arg);
    const dockerignore = readFileSync("docker/Dockerfile.dockerignore", "utf8");
    const out = classify(paths, { dockerignore });
    // Each name as a JSON string: a file named `::add-mask::…` must not reach
    // the runner as a workflow command.
    console.log(
      paths
        ? `${paths.length} changed path(s):\n${paths.map((p) => `  ${JSON.stringify(p)}`).join("\n")}`
        : "changes unknown: running everything",
    );
    console.log(JSON.stringify(out));
    const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
    return;
  }
  if (cmd === "gate") {
    const problems = gate(JSON.parse(process.env.NEEDS ?? "{}"));
    for (const p of problems) console.log(`::error::${p}`);
    if (problems.length) process.exitCode = 1;
    else console.log("every needed job passed");
    return;
  }
  console.error("usage: changes.mjs classify <base-sha> | gate (NEEDS in env) | docs-suite");
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
