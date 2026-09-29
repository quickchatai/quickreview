// Deterministic repo facts (src/setup/facts.ts): what a repo says
// about itself in files, read without a model. Driven over an in-memory
// listing — the function is pure; the engine's repo port supplies the real one.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAgentFile,
  repoFacts,
  UNIT_NAME_RE,
  unitCandidates,
  vendoredRoots,
} from "../src/setup/facts.js";
import { findStyleGuide, styleGuideRefsIn } from "../src/styleguide.js";

function repo(files: Record<string, string>): { files: string[]; read: (p: string) => string | null } {
  return { files: Object.keys(files).sort(), read: (p) => files[p] ?? null };
}

const DJANGO = repo({
  "README.md": "# app\n",
  "CONTRIBUTING.md": "how to\n",
  "docs/DESIGN.md": "design\n",
  "AGENTS.md": "agents\n",
  "backend/CLAUDE.md": "claude\n",
  ".github/copilot-instructions.md": "x\n",
  ".github/instructions/py.instructions.md": "x\n",
  ".cursor/rules/style.mdc": "x\n",
  ".github/workflows/ci.yml": "name: Backend CI\non: push\n",
  ".github/workflows/lint.yaml": "on: push\n",
  ".pre-commit-config.yaml": "repos: []\n",
  "backend/pyproject.toml": '[project]\ndependencies = [\n  "Django>=4.2",\n  "celery==5",\n  "flask-cors",\n]\n[tool.ruff]\nline-length = 100\n',
  "backend/requirements.txt": "djangorestframework==3.14\npytest\n",
  "backend/manage.py": "import django\n",
  "backend/payments/apps.py": "class PaymentsConfig: ...\n",
  "backend/payments/models.py": "x = 1\n",
  "backend/users/apps.py": "x\n",
  "backend/users/views.py": "x\n",
  "backend/settings.py": "x\n",
  "frontend/package.json": JSON.stringify({ dependencies: { react: "18", next: "14" }, devDependencies: { tailwindcss: "3", eslint: "9" }, prettier: {} }),
  "frontend/src/app.tsx": "x\n",
  "frontend/src/page.tsx": "x\n",
  "frontend/eslint.config.js": "export default []\n",
  "frontend/node_modules/react/package.json": JSON.stringify({ dependencies: { vue: "3" } }),
  "frontend/node_modules/react/CLAUDE.md": "vendored\n",
  "infra/main.tf": "x\n",
  "scripts/deploy.sh": "x\n",
  "third_party/lib/x.py": "x\n",
});

describe("repoFacts", () => {
  const facts = repoFacts(DJANGO.files, DJANGO.read);

  it("counts languages over the repo's own files, vendored trees excluded", () => {
    const py = facts.languages.find((l) => l.language === "Python");
    expect(py?.files).toBe(6); // third_party/lib/x.py is not the repo's
    expect(facts.languages.find((l) => l.language === "TypeScript")?.files).toBe(2);
    expect(facts.files).toBe(DJANGO.files.length);
  });

  it("names every framework with the file that proves it — exact dependency names only", () => {
    const names = Object.fromEntries(facts.frameworks.map((f) => [f.name, f.evidence]));
    expect(names.Django).toBe("backend/manage.py");
    expect(names.Celery).toBe("backend/pyproject.toml");
    expect(names["Django REST framework"]).toBe("backend/requirements.txt");
    expect(names.pytest).toBe("backend/requirements.txt");
    expect(names.React).toBe("frontend/package.json");
    expect(names["Next.js"]).toBe("frontend/package.json");
    expect(names["Tailwind CSS"]).toBe("frontend/package.json");
    // flask-cors is not Flask; the vendored package.json's vue is not ours.
    expect(names.Flask).toBeUndefined();
    expect(names.Vue).toBeUndefined();
  });

  it("finds CI with the workflow's stated name, linters from files and config sections", () => {
    expect(facts.ci).toEqual([
      { system: "GitHub Actions", path: ".github/workflows/ci.yml", name: "Backend CI" },
      { system: "GitHub Actions", path: ".github/workflows/lint.yaml", name: null },
    ]);
    const linters = Object.fromEntries(facts.linters.map((l) => [l.name, l.evidence]));
    expect(linters.Ruff).toBe("backend/pyproject.toml");
    expect(linters.ESLint).toBe("frontend/eslint.config.js");
    expect(linters.Prettier).toBe("frontend/package.json");
    expect(linters["pre-commit"]).toBe(".pre-commit-config.yaml");
  });

  it("lists design docs and agent-directive files, never a vendored one", () => {
    expect(facts.guides).toEqual(["CONTRIBUTING.md", "README.md", "docs/DESIGN.md"]);
    expect(facts.agent_files).toEqual([
      ".cursor/rules/style.mdc",
      ".github/copilot-instructions.md",
      ".github/instructions/py.instructions.md",
      "AGENTS.md",
      "backend/CLAUDE.md",
    ]);
    expect(isAgentFile("frontend/node_modules/react/CLAUDE.md")).toBe(false);
  });

  it("reports absence as an empty list, never an invented fact", () => {
    const empty = repoFacts(["main.go"], () => null);
    expect(empty.ci).toEqual([]);
    expect(empty.linters).toEqual([]);
    expect(empty.frameworks).toEqual([]);
    expect(empty.agent_files).toEqual([]);
  });
});

describe("unitCandidates — the stack-aware first guess", () => {
  it("proposes Django apps, packages and code directories, and a catch-all rest", () => {
    const own = DJANGO.files.filter((f) => !f.includes("node_modules") && !f.startsWith("third_party"));
    const units = unitCandidates(own);
    const byName = Object.fromEntries(units.map((u) => [u.name, u]));
    expect(byName.payments).toMatchObject({ roots: ["backend/payments"], kind: "django-app" });
    expect(byName.users).toMatchObject({ roots: ["backend/users"], kind: "django-app" });
    expect(byName.backend).toMatchObject({ roots: ["backend"], kind: "python-package" });
    expect(byName.frontend).toMatchObject({ roots: ["frontend"], kind: "js-package" });
    expect(byName.infra).toMatchObject({ roots: ["infra"], kind: "directory" });
    // scripts/ is not offered as a unit of its own; it rides rest.
    expect(byName.scripts).toBeUndefined();
    expect(units.at(-1)).toMatchObject({ name: "rest", roots: [""], kind: "rest" });
  });

  it("widens colliding names with their parents, and stays name-safe", () => {
    const units = unitCandidates(["a/core/apps.py", "b/core/apps.py", "c d/x.py"]);
    const names = units.map((u) => u.name);
    expect(names).toContain("a-core");
    expect(names).toContain("b-core");
    expect(names).toContain("c-d");
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it("keeps a collision suffix inside the 64-character name limit", () => {
    const long = "x".repeat(70);
    const units = unitCandidates([`${long}a/core/apps.py`, `${long}b/core/apps.py`]);
    const names = units.map((u) => u.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(UNIT_NAME_RE);
  });
});

describe("vendoredRoots", () => {
  it("returns the shallowest vendored directories", () => {
    expect(
      vendoredRoots(["web/node_modules/a/b.js", "web/node_modules/a/node_modules/c.js", "third_party/x.py", "src/vendor.py"]),
    ).toEqual(["third_party", "web/node_modules"]);
  });
});

describe("styleGuideRefsIn — the listing twin of findStyleGuide", () => {
  it("returns exactly what findStyleGuide returns for the same tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-style-twin-"));
    try {
      const guide = Array.from({ length: 20 }, (_, i) => `rule ${i}`).join("\n");
      const section = ["# Project", "intro", "## Code style", ...Array.from({ length: 10 }, (_, i) => `- rule ${i}`), "## Other", "x"].join("\n");
      const tree: Record<string, string> = {
        "STYLEGUIDE.md": guide,
        "CONTRIBUTING.md": section,
        "docs/coding-standards.md": guide,
        "docs/web/style-guide.md": guide,
        "docs/short/style-guide.md": "one line",
        ".github/CONVENTIONS.md": guide,
        "src/STYLE.md": guide, // not a guide location
        // Agent-directive style rules; CLAUDE.md links to AGENTS.md.
        "AGENTS.md": section,
        ".github/instructions/code-style.instructions.md": guide,
      };
      for (const [p, t] of Object.entries(tree)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
      symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
      const listing: Record<string, string> = { ...tree, "CLAUDE.md": section };
      const listed = styleGuideRefsIn(Object.keys(listing), (p) => listing[p] ?? null);
      expect(listed).toEqual(findStyleGuide(dir));
      expect(listed).toEqual([
        ".github/CONVENTIONS.md",
        ".github/instructions/code-style.instructions.md",
        "AGENTS.md:3-13",
        "CONTRIBUTING.md:3-13",
        "STYLEGUIDE.md",
        "docs/coding-standards.md",
        "docs/web/style-guide.md",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
