// The repo's CI-enforced linters and formatters: what plans
// `pass-lint-conformance`. A violation of a lint or format rule that a CI job
// of the repo runs fails that job — a build defect, not taste (a clang-format
// failure, a gci import order, a `cargo fmt` whitespace, a root jsdoc rule).
// The lens judges from the config; it never runs a tool (scoping rule 2).
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
    // Framework CLIs that run eslint without naming it.
    invoked: /\beslint\b|\b(?:next|ng|nuxt|vue-cli-service)\s+lint\b/,
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
  { tool: "gofmt", invoked: /\bgofmt\b|\bgoimports\b/, configs: [], covers: /\.go$/i },
  { tool: "go vet", invoked: /\bgo\s+vet\b/, configs: [], covers: /\.go$/i },
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

/**
 * The real path of `rel` under `root` when it resolves inside `realRoot` (the
 * checkout's own real path), else null: a link that leaves the checkout, a
 * missing path or the root itself are all null.
 */
export function resolveInsideCheckout(root: string, realRoot: string, rel: string): string | null {
  try {
    const real = realpathSync(join(root, rel));
    const r = relative(realRoot, real);
    return r === "" || r.split(sep)[0] === ".." || isAbsolute(r) ? null : real;
  } catch {
    return null;
  }
}

function readInside(root: string, realRoot: string, rel: string): string | null {
  const real = resolveInsideCheckout(root, realRoot, rel);
  if (real === null) return null;
  try {
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
 * Split shell-shaped text into commands of words. Quotes are removed from a
 * word, and the body of every quoted string, `$(…)` and backtick span is ALSO
 * read as commands of its own (`concurrently "npm run lint"`, a YAML `run:`
 * quoted whole). A word built from an expansion keeps its `$`/backtick, so a
 * name a variable supplies stays visibly unresolved. Never throws.
 */
function shellCommands(text: string, out: string[][] = [], depth = 0): string[][] {
  let cmd: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) cmd.push(word);
    word = "";
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (cmd.length > 0) out.push(cmd);
    cmd = [];
  };
  const nested = (body: string) => {
    if (depth < 4) shellCommands(body, out, depth + 1);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === "\\" ? 2 : 1;
      if (j >= text.length) {
        // An unclosed quote (an apostrophe in prose): a literal character.
        word += c;
        inWord = true;
        continue;
      }
      const body = text.slice(i + 1, j);
      word += c === '"' ? body.replace(/\\(["\\$`])/g, "$1") : body;
      inWord = true;
      nested(body);
      i = j;
      continue;
    }
    if (c === "`") {
      const j = text.indexOf("`", i + 1);
      if (j < 0) {
        word += c;
        inWord = true;
        continue;
      }
      nested(text.slice(i + 1, j));
      word += text.slice(i, j + 1);
      inWord = true;
      i = j;
      continue;
    }
    if (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) {
      const open = text[i + 1]!;
      const close = open === "(" ? ")" : "}";
      let level = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === open) level++;
        else if (text[j] === close && --level === 0) break;
      }
      if (j >= text.length) j = text.length - 1;
      nested(text.slice(i + 2, j));
      word += text.slice(i, j + 1);
      inWord = true;
      i = j;
      continue;
    }
    if (c === "\\" && text[i + 1] === "\n") {
      // A line continuation.
      endWord();
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
      word += text[i + 1];
      inWord = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (c === "\n") endCmd();
      else endWord();
      continue;
    }
    if (";&|()".includes(c)) {
      endCmd();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCmd();
  return out;
}

const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUN_ALL_TOOLS = new Set(["npm-run-all", "npm-run-all2", "run-s", "run-p"]);
const RUN_WORDS = new Set(["run", "run-script", "rum", "urn"]);
/**
 * Runner options that run the scripts of ANOTHER package.json (a directory or
 * a workspace): what they run is not in the file this module reads.
 */
const ELSEWHERE_FLAGS = new Set([
  "--prefix",
  "--cwd",
  "-C",
  "--dir",
  "-r",
  "--recursive",
  "--filter",
  "-F",
  "-w",
  "-ws",
  "--workspace",
  "--workspaces",
  "--workspace-root",
  "--include-workspace-root",
]);
/** Runners that fan a script out to the repo's packages. */
const FAN_OUT_TOOLS = new Set(["turbo", "nx", "lerna", "rush", "ultra", "wireit"]);
/** The same, by text, as a belt over the word-level reading. */
const WORKSPACE_RUN = /\b(?:turbo|nx|lerna)\s+[\w-]|\byarn\s+workspaces?\b/;

/** A word a shell would expand: its value is not in the text. */
const EXPANDED = /[$`]/;
/** A runner a variable names: `$(NPM)`, `${PNPM}`, `$npm_execpath`. */
const VARIABLE_WORD = /^\$[({]?([A-Za-z_]\w*)[)}]?$/;

/** A command word's program: `./node_modules/.bin/run-s` → `run-s`; a Makefile's `@npm` → `npm`. */
const base = (word: string): string => word.slice(word.lastIndexOf("/") + 1).replace(/^[@+-]+/, "");

/**
 * The package scripts `text` calls, as names, globs (`lint:*`) or pnpm
 * regexes (`/^lint/`) — or `null` when some call is in a form that cannot be
 * resolved to concrete names: a name or runner a variable supplies, a script
 * run in another package (`--prefix`, `--cwd`, `-r`, `--workspaces`, `yarn
 * workspace`), a fan-out runner (turbo, nx, lerna).
 *
 * Every non-option word after a runner counts as a candidate name — a
 * subcommand or an argument names no script, so it costs nothing — which is
 * what makes a leading option (`npm run -s lint`, `yarn --silent lint`) or an
 * argument after the name harmless.
 */
function scriptCalls(text: string): string[] | null {
  if (WORKSPACE_RUN.test(text)) return null;
  const out: string[] = [];
  for (const cmd of shellCommands(text)) {
    for (let i = 0; i < cmd.length; i++) {
      const w = cmd[i]!;
      const b = base(w);
      // concurrently's shorthand: `npm:lint:*`, `pnpm:check`.
      const short = /^(?:npm|pnpm|yarn|bun):(\S+)/.exec(w);
      if (short) {
        if (EXPANDED.test(short[1]!)) return null;
        out.push(short[1]!);
        continue;
      }
      if (FAN_OUT_TOOLS.has(b)) return null;
      if (b === "node" || b === "deno") {
        // `node --run <name>` runs a package script.
        for (let j = i + 1; j < cmd.length; j++) {
          const t = cmd[j]!;
          if (t === "--run" || t.startsWith("--run=")) {
            const name = t === "--run" ? cmd[j + 1] : t.slice(6);
            if (name === undefined) break;
            if (EXPANDED.test(name)) return null;
            out.push(name);
            break;
          }
          if (!t.startsWith("-")) break;
        }
        continue;
      }
      const runAll = RUN_ALL_TOOLS.has(b);
      const variable = VARIABLE_WORD.exec(w);
      const runner =
        PACKAGE_RUNNERS.has(b) ||
        (variable !== null &&
          (/npm|pnpm|yarn|bun/i.test(variable[1]!) ||
            cmd.slice(i + 1).find((t) => !t.startsWith("-")) === "run"));
      if (!runAll && !runner) continue;
      let first = true;
      for (let j = i + 1; j < cmd.length; j++) {
        const t = cmd[j]!;
        if (t === "--") break;
        if (t.startsWith("-")) {
          if (runner && ELSEWHERE_FLAGS.has(t.split("=")[0]!)) return null;
          continue;
        }
        if (runner && first && /^workspaces?$/.test(t)) return null;
        first = false;
        if (runner && RUN_WORDS.has(t)) continue;
        const name = t.trim().split(/\s+/)[0]!;
        if (EXPANDED.test(name)) return null;
        if (name) out.push(name);
        const inner = /^(?:npm|pnpm|yarn|bun):(\S+)/.exec(name);
        if (inner) out.push(inner[1]!);
      }
      break;
    }
  }
  return out;
}

/** The scripts `name` stands for: itself, a glob's matches, a pnpm regex's matches. */
function expandName(name: string, scripts: Record<string, unknown>): string[] | null {
  const re = /^\/(.+)\/$/.exec(name);
  if (re) {
    try {
      const r = new RegExp(re[1]!);
      return Object.keys(scripts).filter((k) => r.test(k));
    } catch {
      return null;
    }
  }
  if (!name.includes("*")) return [name];
  const glob = new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`);
  return Object.keys(scripts).filter((k) => glob.test(k));
}

/** A script body that runs a repo-local program, whose contents this reading never sees. */
const LOCAL_PROGRAM =
  /(?:^|[\s;&|(])(?:(?:(?:ba|z)?sh|node|tsx|ts-node|bun|zx|python3?)\s+(?:-\S+\s+)*[\w@.-]*\/?[\w@./-]*\.(?:sh|bash|[cm]?[jt]s|py)\b|\.{1,2}\/[\w@./-]+)/;

/**
 * The bodies of the package scripts `callerText` calls, followed through the
 * scripts they call in turn (with their `pre`/`post` hooks), joined; "" when
 * none of them exists. FAILS OPEN — the whole `pkgText`, as if every script
 * ran — whenever the reading is not sure: the package.json does not parse or
 * has no `scripts` object, or the caller or a followed script calls a script
 * in a form `scriptCalls` cannot resolve, or a followed script runs a
 * repo-local program (`sh scripts/lint.sh`, `./lint`).
 */
function calledScripts(pkgText: string, callerText: string): string {
  let scripts: Record<string, unknown>;
  try {
    const s = (JSON.parse(pkgText) as { scripts?: unknown } | null)?.scripts;
    if (typeof s !== "object" || s === null || Array.isArray(s)) return pkgText;
    scripts = s as Record<string, unknown>;
  } catch {
    return pkgText;
  }
  const queue = scriptCalls(callerText);
  if (queue === null) return pkgText;
  const seen = new Set<string>();
  const bodies: string[] = [];
  while (queue.length > 0) {
    const expanded = expandName(queue.shift()!, scripts);
    if (expanded === null) return pkgText;
    for (const n of expanded) {
      for (const name of [`pre${n}`, n, `post${n}`]) {
        if (seen.has(name)) continue;
        seen.add(name);
        const b = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
        if (typeof b !== "string") continue;
        const more = scriptCalls(b);
        if (more === null || LOCAL_PROGRAM.test(b)) return pkgText;
        bodies.push(b);
        queue.push(...more);
      }
    }
  }
  return bodies.join("\n");
}

/**
 * The linters and formatters a CI job of the repo under `root` runs — found
 * by reading the CI definitions and the wrapper scripts they call (a CI step
 * `npm run lint` whose package script runs `eslint` counts). [] when the
 * repo runs none, or the tree cannot be read.
 *
 * `packageJson` = `"whole"` reads a CI-called package.json whole, as this
 * module did before it followed scripts — kept so a test can hold the
 * followed reading to finding everything the whole reading found.
 */
export function findCiLinters(
  root: string,
  packageJson: "called" | "whole" = "called",
): CiLinter[] {
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
  const candidates = WRAPPERS.map((f) => ({ f, text: readInside(root, realRoot, f) })).filter(
    (x): x is { f: string; text: string } => x.text !== null,
  );
  const wrappers: { f: string; text: string }[] = [];
  const invoked = (f: string, text: string): boolean => {
    if (f === "package.json") {
      const calls = scriptCalls(text);
      return calls === null || calls.length > 0;
    }
    if (f === "Makefile") return /\bg?make\s+(lint|format|check|fmt)\b/.test(text);
    const command =
      f === "justfile" ? "just" : f === "tox.ini" ? "tox" : f === "noxfile.py" ? "nox" : "task";
    return new RegExp(`\\b(?:${command})\\b`).test(text);
  };
  // Follow only wrappers reached from CI. An unrelated readable Makefile
  // cannot lend its linter to an npm-only job; reached wrappers may call one another.
  for (;;) {
    const callers = [
      ciText,
      ...wrappers.filter((w) => w.f !== "package.json").map((w) => w.text),
    ].join("\n");
    const pkg = wrappers.find((w) => w.f === "package.json");
    const reachableText = pkg ? `${callers}\n${calledScripts(pkg.text, callers)}` : callers;
    const next = candidates.filter(
      (w) => !wrappers.some((v) => v.f === w.f) && invoked(w.f, reachableText),
    );
    if (next.length === 0) break;
    wrappers.push(...next);
  }
  // A package.json is read only through the scripts that CI, or another
  // wrapper CI calls (a Makefile's `lint:` running `npm run lint`), calls —
  // and the scripts those call: its other scripts and its dependency list run
  // in no CI job. What cannot be resolved to named scripts is read whole.
  const callerText = [
    ciText,
    ...wrappers.filter((w) => w.f !== "package.json").map((w) => w.text),
  ].join("\n");
  if (packageJson === "called")
    for (const w of wrappers)
      if (w.f === "package.json") w.text = calledScripts(w.text, callerText);
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
