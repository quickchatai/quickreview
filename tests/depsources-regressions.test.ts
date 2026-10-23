import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  parsePyprojectDeps,
  planDependencyRequests,
  pyVersionMatches,
  prepareDependencySources,
  renderDependencyNote,
} from "@quickchatai/pi-quickreview/src/depsources.js";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deps-regression-"));
  dirs.push(root);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  }
  return root;
}
it("keeps planning other Python imports when a module names an inherited object property", () => {
  const root = tree({
    "requirements.txt": "requests==2.32.0\n",
    "app.py": "import constructor\nimport requests\n",
  });
  expect(() => planDependencyRequests(root, [{ filename: "app.py" }])).not.toThrow();
  expect(planDependencyRequests(root, [{ filename: "app.py" }])).toMatchObject([
    { name: "requests", version: "2.32.0" },
  ]);
});
it("recognizes a subproject's first-party src layout", () => {
  const root = tree({
    "apps/api/requirements.txt": "requests==2.32.0\n",
    "apps/api/src/requests/__init__.py": "",
    "apps/api/app.py": "import requests\n",
  });
  expect(planDependencyRequests(root, [{ filename: "apps/api/app.py" }])).toEqual([]);
});
it.each(["@private:registry=https://private.example/", "registry=https://private.example/"])(
  "never advertises npmjs sources behind %s",
  (setting) => {
    const root = tree({
      ".npmrc": setting,
      "package.json": JSON.stringify({ dependencies: { "@private/pkg": "^1.0.0" } }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/@private/pkg": { version: "1.0.0" } },
      }),
      "app.js": "import x from '@private/pkg';",
    });
    expect(planDependencyRequests(root, [{ filename: "app.js" }])[0]).toMatchObject({
      name: "@private/pkg",
      version: null,
    });
  },
);
it("prefers npm-shrinkwrap over package-lock", () => {
  const lock = (version: string) =>
    JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/thing": { version } } });
  const root = tree({
    "package.json": JSON.stringify({ dependencies: { thing: "*" } }),
    "package-lock.json": lock("1.0.0"),
    "npm-shrinkwrap.json": lock("2.0.0"),
    "app.js": "import thing from 'thing';",
  });
  expect(planDependencyRequests(root, [{ filename: "app.js" }])[0]).toMatchObject({
    version: "2.0.0",
  });
});
it("a nearer installed copy wins over an ancestor workspace link", () => {
  const root = tree({
    "package.json": JSON.stringify({ dependencies: { thing: "*" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/thing": { link: true, resolved: "packages/thing" } },
    }),
    "apps/api/package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/thing": { version: "2.0.0" } },
    }),
    "apps/api/app.js": "import thing from 'thing';",
  });
  expect(planDependencyRequests(root, [{ filename: "apps/api/app.js" }])[0]).toMatchObject({
    version: "2.0.0",
  });
});
it("a nearer registry copy in the same lockfile wins over a root workspace link", () => {
  const root = tree({
    "package.json": JSON.stringify({ dependencies: { thing: "*" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/thing": { link: true, resolved: "packages/thing" },
        "packages/web": { name: "web", version: "1.0.0" },
        "packages/web/node_modules/thing": { version: "2.0.0" },
      },
    }),
    "packages/web/package.json": JSON.stringify({ dependencies: { thing: "*" } }),
    "packages/web/app.js": "import thing from 'thing';",
  });
  expect(planDependencyRequests(root, [{ filename: "packages/web/app.js" }])[0]).toMatchObject({
    version: "2.0.0",
  });
});
it("a pyproject include-group directive is not a requirement", () => {
  const deps = parsePyprojectDeps(
    '[dependency-groups]\ntest = ["pytest>=8"]\ndev = [{ include-group = "test" }]\n',
  );
  expect([...deps.keys()]).toEqual(["pytest"]);
});
it("compares Python epochs before release numbers", () => {
  expect(pyVersionMatches("2.0", ">=1!1.0")).toBe(false);
  expect(pyVersionMatches("1!1.0", ">=2.0")).toBe(true);
  expect(pyVersionMatches("1!1.0", "==1.0")).toBe(false);
});
it("honors unlocked uv source overrides", () => {
  const root = tree({
    "pyproject.toml":
      '[project]\ndependencies=["requests>=2"]\n[tool.uv.sources]\nrequests={git="https://example.test/fork.git"}\n',
    "app.py": "import requests\n",
  });
  expect(planDependencyRequests(root, [{ filename: "app.py" }])[0]).toMatchObject({
    version: null,
  });
  expect(planDependencyRequests(root, [{ filename: "app.py" }])[0]?.range).not.toBe(">=2");
});
it("cancels rejected HTTP bodies and retains each failed request's version", async () => {
  const root = tree({
    "package.json": JSON.stringify({ dependencies: { thing: "1.2.3" } }),
    "app.js": "import thing from 'thing';",
  });
  let cancelled = 0;
  const manifest = await prepareDependencySources(root, [{ filename: "app.js" }], {
    cacheDir: join(root, "cache"),
    fetch: (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 404 },
      )) as typeof fetch,
  });
  expect(cancelled).toBe(1);
  expect(renderDependencyNote(manifest)).toContain("thing 1.2.3");
});
it("applies scoped registries to integrity-only pnpm locks", () => {
  const root = tree({
    ".npmrc": "@private:registry=https://private.example/",
    "package.json": JSON.stringify({ dependencies: { "@private/pkg": "^1.0.0" } }),
    "app.js": "import x from '@private/pkg';",
    "pnpm-lock.yaml":
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@private/pkg':\n        specifier: ^1.0.0\n        version: 1.0.0\npackages:\n  '@private/pkg@1.0.0':\n    resolution: {integrity: sha512-x}\n",
  });
  expect(planDependencyRequests(root, [{ filename: "app.js" }])[0]).toMatchObject({
    version: null,
  });
});
it("selects the greatest Python epoch through the registry preparation seam", async () => {
  const root = tree({ "requirements.txt": "thing>=0", "app.py": "import thing\n" });
  const urls: string[] = [];
  await prepareDependencySources(root, [{ filename: "app.py" }], {
    cacheDir: join(root, "cache"),
    fetch: (async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.startsWith("https://pypi.org/"))
        return Response.json({
          releases: Object.fromEntries(
            ["1!1.0", "2.0"].map((v) => [
              v,
              [
                {
                  filename: `thing-${v}.tar.gz`,
                  url: `https://files.pythonhosted.org/thing-${v}.tar.gz`,
                },
              ],
            ]),
          ),
        });
      return new Response("", { status: 404 });
    }) as typeof fetch,
  });
  expect(urls).toContain("https://files.pythonhosted.org/thing-1!1.0.tar.gz");
  expect(urls).not.toContain("https://files.pythonhosted.org/thing-2.0.tar.gz");
});
