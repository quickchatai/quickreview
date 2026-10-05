// The repo's CI-enforced linters and formatters (freeze fixes 2, 2026-10-03):
// what plans `pass-lint-conformance`. A violation of a lint or format rule
// that a CI job of the repo runs fails that job — a build defect, not taste —
// and the pre-freeze miss analysis found such defects killed as "style" or
// never raised (a clang-format failure, a gci import order, a `cargo fmt`
// whitespace, a root jsdoc rule). The lens judges from the config; it never
// runs a tool (scoping rule 2).
//
// Pure reading, total: an unreadable tree or file is "no linter".

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** One tool a CI job of the repo runs, with the config that sets its rules. */
export interface CiLinter {
  /** The tool's name as the plan and the lens see it. */
  tool: string;
  /** Repo-relative config files found for it (may be empty: defaults). */
  configs: string[];
  /** Repo-relative CI files that invoke it. */
  ci: string[];
  /** File extensions its rules cover. */
  covers: RegExp;
}

interface ToolSpec {
  tool: string;
  /** How a CI step names it (a command, or a package script that wraps it). */
  invoked: RegExp;
  configs: string[];
  covers: RegExp;
}

const JS_TS = /\.(c|m)?(j|t)sx?$/i;
const TOOLS: readonly ToolSpec[] = [
  {
    tool: "eslint",
    invoked: /\beslint\b/,
    configs: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintrc.yml",
      ".eslintrc.yaml",
    ],
    covers: JS_TS,
  },
  {
    tool: "biome",
    invoked: /\bbiome\b/,
    configs: ["biome.json", "biome.jsonc"],
    covers: /\.(c|m)?(j|t)sx?$|\.jsonc?$|\.css$/i,
  },
  {
    tool: "prettier",
    invoked: /\bprettier\b/,
    configs: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.yml",
      ".prettierrc.yaml",
      "prettier.config.js",
      "prettier.config.mjs",
    ],
    covers: /\.(c|m)?(j|t)sx?$|\.(css|scss|less|json|md|ya?ml|html|vue)$/i,
  },
  {
    tool: "ruff",
    invoked: /\bruff\b/,
    configs: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
    covers: /\.pyi?$/i,
  },
  { tool: "black", invoked: /\bblack\b/, configs: ["pyproject.toml"], covers: /\.pyi?$/i },
  {
    tool: "flake8",
    invoked: /\bflake8\b/,
    configs: [".flake8", "setup.cfg", "tox.ini"],
    covers: /\.py$/i,
  },
  {
    tool: "mypy",
    invoked: /\bmypy\b/,
    configs: ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"],
    covers: /\.pyi?$/i,
  },
  {
    tool: "clippy",
    invoked: /\bcargo\s+clippy\b|\bclippy\b/,
    configs: ["clippy.toml", ".clippy.toml", "Cargo.toml"],
    covers: /\.rs$/i,
  },
  {
    tool: "rustfmt",
    invoked: /\bcargo\s+fmt\b|\brustfmt\b/,
    configs: ["rustfmt.toml", ".rustfmt.toml"],
    covers: /\.rs$/i,
  },
  {
    tool: "golangci-lint",
    invoked: /\bgolangci-lint\b|golangci\/golangci-lint-action/,
    configs: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"],
    covers: /\.go$/i,
  },
  { tool: "gofmt", invoked: /\bgofmt\b|\bgoimports\b|\bgo\s+vet\b/, configs: [], covers: /\.go$/i },
  {
    tool: "clang-format",
    invoked: /\bclang-format\b/,
    configs: [".clang-format", "_clang-format"],
    covers: /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm)$/i,
  },
  {
    tool: "swiftlint",
    invoked: /\bswiftlint\b/,
    configs: [".swiftlint.yml", ".swiftlint.yaml"],
    covers: /\.swift$/i,
  },
  { tool: "ktlint", invoked: /\bktlint\b/, configs: [".editorconfig"], covers: /\.kts?$/i },
  { tool: "rubocop", invoked: /\brubocop\b/, configs: [".rubocop.yml"], covers: /\.rb$/i },
  {
    tool: "dotnet-format",
    invoked: /\bdotnet\s+format\b|EnforceCodeStyleInBuild/,
    configs: [".editorconfig"],
    covers: /\.cs$/i,
  },
];

/** CI definitions a job runs from. */
const CI_DIRS = [".github/workflows", ".circleci", ".buildkite"];
const CI_FILES = [
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  ".travis.yml",
  "Jenkinsfile",
  "bitbucket-pipelines.yml",
];
/** Wrapper scripts a CI step commonly calls (`npm run lint`, `make lint`). */
const WRAPPERS = ["package.json", "Makefile", "justfile", "tox.ini", "noxfile.py", "Taskfile.yml"];
const MAX_READ = 512 * 1024;

function readInside(root: string, realRoot: string, rel: string): string | null {
  try {
    const real = realpathSync(join(root, rel));
    const r = relative(realRoot, real);
    if (r === "" || r.split(sep)[0] === ".." || isAbsolute(r)) return null;
    if (statSync(real).size > MAX_READ) return null;
    return readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

function listDir(root: string, rel: string): string[] {
  try {
    return readdirSync(join(root, rel)).map((n) => (rel ? `${rel}/${n}` : n));
  } catch {
    return [];
  }
}

/**
 * The linters and formatters a CI job of the repo under `root` runs — found
 * by reading the CI definitions and the wrapper scripts they call (a CI step
 * `npm run lint` whose package script runs `eslint` counts). [] when the
 * repo runs none, or the tree cannot be read.
 */
export function findCiLinters(root: string): CiLinter[] {
  if (!existsSync(root)) return [];
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const ciFiles = [
    ...CI_DIRS.flatMap((d) => listDir(root, d).filter((p) => /\.(ya?ml|json)$/i.test(p))),
    ...CI_FILES.filter((f) => existsSync(join(root, f))),
  ];
  const ci = ciFiles
    .map((f) => ({ f, text: readInside(root, realRoot, f) }))
    .filter((x): x is { f: string; text: string } => x.text !== null);
  if (ci.length === 0) return [];
  // A wrapper counts only when a CI step calls it (`run lint`, `make lint`, `tox`).
  const ciText = ci.map((x) => x.text).join("\n");
  const wrappers = WRAPPERS.map((f) => ({ f, text: readInside(root, realRoot, f) })).filter(
    (x): x is { f: string; text: string } =>
      x.text !== null &&
      (/(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|format|check|fmt)/.test(ciText) ||
        /\bmake\s+(lint|format|check|fmt)/.test(ciText) ||
        /\b(tox|nox|just|task)\b/.test(ciText)),
  );
  const out: CiLinter[] = [];
  for (const spec of TOOLS) {
    const direct = ci.filter((x) => spec.invoked.test(x.text)).map((x) => x.f);
    const viaWrapper = wrappers.filter((x) => spec.invoked.test(x.text)).map((x) => x.f);
    if (direct.length === 0 && viaWrapper.length === 0) continue;
    const configs = spec.configs.filter((c) => {
      const text = readInside(root, realRoot, c);
      if (text === null) return false;
      // pyproject/setup.cfg/tox.ini/Cargo.toml are shared files: they count
      // only when they carry the tool's own section.
      if (/^(pyproject\.toml|setup\.cfg|tox\.ini|Cargo\.toml)$/.test(c))
        return new RegExp(`\\[(tool\\.)?${spec.tool.replace(/-/g, "[-_]")}|\\[lints`).test(text);
      return true;
    });
    out.push({ tool: spec.tool, configs, ci: [...direct, ...viaWrapper], covers: spec.covers });
  }
  return out;
}

/** The CI linters whose rules cover at least one changed file. */
export function lintersForFiles(
  linters: readonly CiLinter[],
  filenames: readonly string[],
): CiLinter[] {
  return linters.filter((l) => filenames.some((f) => l.covers.test(f)));
}
