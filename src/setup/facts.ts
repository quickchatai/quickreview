// Deterministic repo facts: what a repo says about itself in files, read
// without a model — the stack, frameworks, CI checks, linters and formatters,
// the design docs and style guides, the agent-directive files, and a
// stack-aware first guess at the unit cut. Free facts must not cost model
// time, and the survey lens and the portrait start from these rather than
// rediscovering them.
//
// Pure: a listing of repo-relative paths plus a reader that answers null for
// anything it cannot read. Nothing here touches a filesystem, so the engine's
// repo port decides what "the repo" is (git-tracked files of the reviewed
// checkout, in production) and tests hand over a map.
//
// Every detection is evidence-carrying: each fact names the file that proves
// it, so the operator can check the facts and the companion can cite them.
// Nothing is inferred from absence — a repo with no CI config has `ci: []`,
// which says "no config file found", not "no CI".
import { DEFAULT_DIRECTIVE_VOCABULARY } from "../severity.js";
import { styleGuideRefsIn } from "../styleguide.js";
import { escapeControls } from "./textsniff.js";

export type RepoRead = (rel: string) => string | null;

export interface Evidence {
  name: string;
  /** Repo-relative path of the file that shows it. */
  evidence: string;
}

export interface LanguageCount {
  language: string;
  files: number;
}

export interface CiFact {
  system: string;
  path: string;
  /** The workflow's `name:` when the file states one. */
  name: string | null;
}

/** Every unit kind — the type and the runtime check (`unitcut.ts`) read this
 * one list. */
export const UNIT_KINDS = [
  "django-app",
  "js-package",
  "python-package",
  "go-module",
  "rust-crate",
  "directory",
  "rest",
  "custom",
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** One candidate unit: a name, the path prefixes it owns, and why. */
export interface UnitCandidate {
  name: string;
  roots: string[];
  kind: UnitKind;
  reason: string;
}

export interface RepoFacts {
  files: number;
  languages: LanguageCount[];
  /** Package-manager manifests, as evidence per ecosystem. */
  manifests: Evidence[];
  frameworks: Evidence[];
  ci: CiFact[];
  /** Linters, formatters and type checkers whose config is in the repo. */
  linters: Evidence[];
  /** Design docs read in full by the survey: README, CONTRIBUTING, DESIGN… */
  guides: string[];
  /** Written style guides, in `findStyleGuide`'s reference grammar. */
  style_guides: string[];
  /** First-party agent-directive files (AGENTS.md, CLAUDE.md, rules dirs…). */
  agent_files: string[];
  /** The deterministic first guess at the unit cut — the companion's input. */
  unit_candidates: UnitCandidate[];
}

// ---- helpers -----------------------------------------------------------------

function base(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Vendored trees are someone else's repo: never evidence about this one. */
export function isVendored(path: string): boolean {
  return path
    .split("/")
    .some((s) => DEFAULT_DIRECTIVE_VOCABULARY.vendoredSegments.has(s.toLowerCase()));
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  py: "Python",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  swift: "Swift",
  m: "Objective-C",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  clj: "Clojure",
  lua: "Lua",
  sh: "Shell",
  bash: "Shell",
  sql: "SQL",
  vue: "Vue",
  svelte: "Svelte",
  html: "HTML",
  css: "CSS",
  scss: "CSS",
  less: "CSS",
  tf: "Terraform",
};

function languages(files: readonly string[]): LanguageCount[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const b = base(f);
    const dot = b.lastIndexOf(".");
    if (dot <= 0) continue;
    const lang = LANGUAGE_BY_EXT[b.slice(dot + 1).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, n]) => ({ language, files: n }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

/** Manifest basename → ecosystem. */
const MANIFESTS: Record<string, string> = {
  "package.json": "npm",
  "pnpm-workspace.yaml": "pnpm workspace",
  "pyproject.toml": "python (pyproject)",
  "setup.py": "python (setuptools)",
  "setup.cfg": "python (setuptools)",
  "requirements.txt": "python (pip)",
  Pipfile: "python (pipenv)",
  "go.mod": "go modules",
  "Cargo.toml": "cargo",
  Gemfile: "bundler",
  "pom.xml": "maven",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  "composer.json": "composer",
  "mix.exs": "mix",
  "pubspec.yaml": "pub",
  "Package.swift": "swiftpm",
};

function manifests(files: readonly string[]): Evidence[] {
  const out: Evidence[] = [];
  for (const f of files) {
    const b = base(f);
    const eco = MANIFESTS[b] ?? (/^requirements[-_.][\w.-]*\.txt$/.test(b) ? "python (pip)" : null);
    if (eco) out.push({ name: eco, evidence: f });
  }
  return out;
}

/** A Python dependency line naming exactly `dep` (any version spec, extras,
 * or a Poetry `dep = "…"` table entry) — `flask-cors` is not Flask. */
function pyDep(dep: string): RegExp {
  return new RegExp(`^\\s*${dep}(\\[[^\\]]*\\])?\\s*([<>=~!;,"'@]|$)`, "im");
}

/** Framework → the dependency spelling that proves it, per manifest family. */
const PY_FRAMEWORKS: Array<[string, RegExp]> = [
  ["Django", pyDep("django")],
  ["Django REST framework", pyDep("djangorestframework")],
  ["Flask", pyDep("flask")],
  ["FastAPI", pyDep("fastapi")],
  ["Celery", pyDep("celery")],
  ["SQLAlchemy", pyDep("sqlalchemy")],
  ["pytest", pyDep("pytest")],
  ["Pydantic", pyDep("pydantic")],
];

const JS_FRAMEWORKS: Array<[string, string]> = [
  ["React", "react"],
  ["Next.js", "next"],
  ["Vue", "vue"],
  ["Nuxt", "nuxt"],
  ["Svelte", "svelte"],
  ["SvelteKit", "@sveltejs/kit"],
  ["Angular", "@angular/core"],
  ["Express", "express"],
  ["NestJS", "@nestjs/core"],
  ["Fastify", "fastify"],
  ["Tailwind CSS", "tailwindcss"],
  ["Vite", "vite"],
  ["Jest", "jest"],
  ["Vitest", "vitest"],
  ["Playwright", "@playwright/test"],
  ["Electron", "electron"],
  ["React Native", "react-native"],
];

const OTHER_FRAMEWORKS: Array<[string, string, RegExp]> = [
  ["Rails", "Gemfile", /^\s*gem\s+["']rails["']/m],
  ["Spring", "pom.xml", /spring-boot|springframework/],
  ["Spring", "build.gradle", /spring-boot|springframework/],
  ["Spring", "build.gradle.kts", /spring-boot|springframework/],
  ["Laravel", "composer.json", /"laravel\/framework"/],
  ["Phoenix", "mix.exs", /:phoenix\b/],
  ["Gin", "go.mod", /github\.com\/gin-gonic\/gin/],
  ["Echo", "go.mod", /github\.com\/labstack\/echo/],
  ["Actix", "Cargo.toml", /^\s*actix-web\s*=/m],
  ["Axum", "Cargo.toml", /^\s*axum\s*=/m],
];

function packageDeps(text: string): Set<string> {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const deps = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = pkg[key];
      if (block && typeof block === "object") for (const d of Object.keys(block)) deps.add(d);
    }
    return deps;
  } catch {
    return new Set();
  }
}

function frameworks(files: readonly string[], read: RepoRead): Evidence[] {
  const seen = new Map<string, string>();
  const note = (name: string, evidence: string): void => {
    if (!seen.has(name)) seen.set(name, evidence);
  };
  for (const f of files) {
    const b = base(f);
    if (b === "manage.py") {
      const text = read(f);
      if (text !== null && /django/i.test(text)) note("Django", f);
    } else if (
      b === "pyproject.toml" ||
      b === "Pipfile" ||
      b === "setup.py" ||
      b === "setup.cfg" ||
      /^requirements([-_.][\w.-]*)?\.txt$/.test(b)
    ) {
      const text = read(f);
      if (text === null) continue;
      // pyproject/setup.py list deps inside quoted arrays — one per line, or
      // inline (`dependencies = ["fastapi", "django>=4"]`); strip a leading
      // quote and put every quoted string on a line of its own, so the
      // line-anchored patterns see `django>=4` either way.
      const quoted = [...text.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]!);
      const lines = [text.replace(/^\s*["']/gm, ""), ...quoted].join("\n");
      for (const [name, re] of PY_FRAMEWORKS) if (re.test(lines)) note(name, f);
    } else if (b === "package.json") {
      const text = read(f);
      if (text === null) continue;
      const deps = packageDeps(text);
      for (const [name, dep] of JS_FRAMEWORKS) if (deps.has(dep)) note(name, f);
    } else {
      for (const [name, file, re] of OTHER_FRAMEWORKS) {
        if (b !== file) continue;
        const text = read(f);
        if (text !== null && re.test(text)) note(name, f);
      }
    }
  }
  return [...seen.entries()].map(([name, evidence]) => ({ name, evidence }));
}

function ciFacts(files: readonly string[], read: RepoRead): CiFact[] {
  const out: CiFact[] = [];
  for (const f of files) {
    let system: string | null = null;
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) system = "GitHub Actions";
    else if (f === ".gitlab-ci.yml") system = "GitLab CI";
    else if (f === ".circleci/config.yml") system = "CircleCI";
    else if (f === "Jenkinsfile") system = "Jenkins";
    else if (f === "azure-pipelines.yml") system = "Azure Pipelines";
    else if (f === ".travis.yml") system = "Travis CI";
    else if (f === "bitbucket-pipelines.yml") system = "Bitbucket Pipelines";
    else if (/^\.buildkite\/[^/]+\.ya?ml$/.test(f)) system = "Buildkite";
    if (!system) continue;
    const text = system === "GitHub Actions" ? read(f) : null;
    // The name reaches the portrait and the companion's prompt: a control
    // byte in the workflow file (a stray NUL is still text) is escaped.
    const raw = text === null ? null : (/^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? null);
    const name = raw === null ? null : escapeControls(raw);
    out.push({ system, path: f, name });
  }
  return out;
}

/** Tool → config basenames that prove it (anywhere in the tree). */
const LINTER_FILES: Array<[string, RegExp]> = [
  ["Ruff", /^\.?ruff\.toml$/],
  ["Flake8", /^\.flake8$/],
  ["Pylint", /^\.?pylintrc$/],
  ["mypy", /^\.?mypy\.ini$/],
  ["Black", /^\.black$/],
  ["isort", /^\.isort\.cfg$/],
  ["ESLint", /^(\.eslintrc(\.(js|cjs|json|ya?ml))?|eslint\.config\.(js|mjs|cjs|ts))$/],
  ["Prettier", /^(\.prettierrc(\.(js|cjs|json|ya?ml|toml))?|prettier\.config\.(js|mjs|cjs))$/],
  ["Biome", /^biome\.jsonc?$/],
  ["Stylelint", /^(\.stylelintrc(\.(js|json|ya?ml))?|stylelint\.config\.(js|cjs|mjs))$/],
  ["TypeScript compiler", /^tsconfig\.json$/],
  ["golangci-lint", /^\.golangci\.ya?ml$/],
  ["rustfmt", /^\.?rustfmt\.toml$/],
  ["Clippy", /^\.?clippy\.toml$/],
  ["RuboCop", /^\.rubocop\.yml$/],
  ["EditorConfig", /^\.editorconfig$/],
  ["pre-commit", /^\.pre-commit-config\.yaml$/],
  ["Checkstyle", /^checkstyle\.xml$/],
  ["Spotless", /^\.spotless$/],
];

/** `[tool.X]` sections in a pyproject.toml / setup.cfg. */
const PY_TOOL_SECTIONS: Array<[string, RegExp]> = [
  ["Ruff", /^\[tool\.ruff[\].]/m],
  ["Black", /^\[tool\.black\]/m],
  ["isort", /^\[(tool\.)?isort\]/m],
  ["mypy", /^\[(tool\.)?mypy[\].-]/m],
  ["Pylint", /^\[tool\.pylint[\].]/m],
  ["Flake8", /^\[flake8\]/m],
  ["pyright", /^\[tool\.pyright\]/m],
];

function linters(files: readonly string[], read: RepoRead): Evidence[] {
  const seen = new Map<string, string>();
  const note = (name: string, evidence: string): void => {
    if (!seen.has(name)) seen.set(name, evidence);
  };
  for (const f of files) {
    const b = base(f);
    for (const [name, re] of LINTER_FILES) if (re.test(b)) note(name, f);
    if (b === "pyproject.toml" || b === "setup.cfg" || b === "tox.ini") {
      const text = read(f);
      if (text !== null)
        for (const [name, re] of PY_TOOL_SECTIONS) if (re.test(text)) note(name, f);
    } else if (b === "package.json") {
      const text = read(f);
      if (text === null) continue;
      try {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        if (pkg.eslintConfig) note("ESLint", f);
        if (pkg.prettier) note("Prettier", f);
      } catch {
        // Not JSON: nothing to read, and no reason to fail the whole facts call.
      }
    }
  }
  return [...seen.entries()].map(([name, evidence]) => ({ name, evidence }));
}

/** Design docs the survey reads in full — the repo's stated intent. */
const GUIDE_RE =
  /^(readme|contributing|design|product|architecture|overview|development|hacking|security|conventions|styleguide|style[-_]guide)(\.[a-z]+)?$/i;

function guides(files: readonly string[]): string[] {
  return files
    .filter((f) => {
      const d = dirOf(f);
      return (d === "" || d === "docs" || d === "doc" || d === ".github") && GUIDE_RE.test(base(f));
    })
    .sort();
}

/** Agent-directive files: what the repo's team already told agents. Broader
 * than the review's `isFirstPartyDirectivePath` on purpose — that predicate
 * decides a finding's provenance and keeps its shipped vocabulary; this one is
 * a reading list, so it also takes the other tools' rule files. */
const AGENT_BASENAMES = new Set([
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
]);

export function isAgentFile(path: string): boolean {
  if (isVendored(path)) return false;
  if (AGENT_BASENAMES.has(base(path))) return true;
  if (path === ".github/copilot-instructions.md") return true;
  if (/^\.github\/instructions\/.+\.md$/.test(path)) return true;
  if (/(^|\/)\.cursor\/rules\//.test(path)) return true;
  if (/(^|\/)\.clinerules\//.test(path)) return true;
  if (/(^|\/)\.claude\/.+\.md$/.test(path)) return true;
  return false;
}

/** The shallowest vendored directories in the listing (`web/node_modules`,
 * `third_party`) — what a proposed cut ignores by default. */
export function vendoredRoots(files: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const f of files) {
    const segs = f.split("/");
    const i = segs.findIndex((s) =>
      DEFAULT_DIRECTIVE_VOCABULARY.vendoredSegments.has(s.toLowerCase()),
    );
    if (i >= 0 && i < segs.length - 1) roots.add(segs.slice(0, i + 1).join("/"));
  }
  return [...roots].filter((r) => ![...roots].some((o) => o !== r && r.startsWith(`${o}/`))).sort();
}

// ---- unit candidates ---------------------------------------------------------

/** The longest unit name. */
const UNIT_NAME_MAX = 64;

/** A unit name: one plain segment (the state files and reports key on it). */
export const UNIT_NAME_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${UNIT_NAME_MAX - 1}}$`);

function slug(path: string): string {
  const s = path.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "");
  return (s || "root").slice(0, UNIT_NAME_MAX);
}

/** Directories never offered as units of their own (they ride "rest"). */
const NON_UNIT_TOP =
  /^(\..*|docs?|scripts?|tools?|bin|ci|examples?|fixtures|assets|static|public)$/i;

/**
 * The stack-aware first guess at the unit cut. Markers, most specific first:
 * a Django app (`apps.py`), a JS package (a nested `package.json`), a Python
 * package with its own `pyproject.toml`/`setup.py`, a Go module, a Rust crate.
 * Top-level directories holding code that no marker claimed become
 * `directory` units, and a `rest` unit at the repo root catches the remainder
 * so the guess is always a complete partition. The companion reshapes this;
 * it is evidence, not the answer.
 */
export function unitCandidates(files: readonly string[]): UnitCandidate[] {
  const out: UnitCandidate[] = [];
  const roots = new Set<string>();
  const add = (root: string, kind: UnitKind, reason: string): void => {
    if (roots.has(root)) return;
    roots.add(root);
    out.push({ name: "", roots: [root], kind, reason });
  };
  const sorted = [...files].filter((f) => !isVendored(f)).sort();
  for (const f of sorted) {
    const b = base(f);
    const d = dirOf(f);
    if (d === "") continue;
    if (b === "apps.py") add(d, "django-app", `${f} declares a Django app`);
    else if (b === "package.json") add(d, "js-package", `${f} declares a package`);
    else if (b === "pyproject.toml" || b === "setup.py")
      add(d, "python-package", `${f} declares a Python package`);
    else if (b === "go.mod") add(d, "go-module", `${f} declares a Go module`);
    else if (b === "Cargo.toml") add(d, "rust-crate", `${f} declares a crate`);
  }
  const covered = (f: string): boolean => [...roots].some((r) => f === r || f.startsWith(`${r}/`));
  const tops = new Map<string, number>();
  for (const f of sorted) {
    const i = f.indexOf("/");
    if (i < 0 || covered(f) || !/\.[A-Za-z0-9]+$/.test(f)) continue;
    const top = f.slice(0, i);
    if (NON_UNIT_TOP.test(top)) continue;
    const ext = f.slice(f.lastIndexOf(".") + 1).toLowerCase();
    if (LANGUAGE_BY_EXT[ext]) tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  for (const [top, n] of [...tops.entries()].sort()) {
    add(
      top,
      "directory",
      `top-level directory with ${n} code file${n === 1 ? "" : "s"} no package marker claims`,
    );
  }
  // Names: the last segment, widened with its parents only where two collide.
  const byLast = new Map<string, number>();
  for (const c of out) {
    const last = base(c.roots[0]!);
    byLast.set(last, (byLast.get(last) ?? 0) + 1);
  }
  const taken = new Set<string>(["rest"]);
  for (const c of out) {
    const root = c.roots[0]!;
    let name = slug(byLast.get(base(root))! > 1 ? root : base(root));
    // The suffix must fit UNIT_NAME_MAX too, or the whole candidate cut is
    // refused for one long colliding path.
    for (let i = 2; taken.has(name); i++)
      name = `${slug(root).slice(0, UNIT_NAME_MAX - `-${i}`.length)}-${i}`;
    taken.add(name);
    c.name = name;
  }
  out.push({ name: "rest", roots: [""], kind: "rest", reason: "everything no other unit claims" });
  return out;
}

// ---- the whole read ----------------------------------------------------------

export function repoFacts(files: readonly string[], read: RepoRead): RepoFacts {
  const own = files.filter((f) => !isVendored(f));
  return {
    files: files.length,
    languages: languages(own),
    manifests: manifests(own),
    frameworks: frameworks(own, read),
    ci: ciFacts(own, read),
    linters: linters(own, read),
    guides: guides(own),
    style_guides: styleGuideRefsIn(own, read),
    agent_files: own.filter(isAgentFile).sort(),
    unit_candidates: unitCandidates(own),
  };
}
