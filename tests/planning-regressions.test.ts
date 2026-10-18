import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { behaviourDeltaRisk, sweepGroups, type PrFile } from "../src/heuristics.js";
import { findCiLinters } from "../src/lintconfig.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = (filename: string, patch = ""): PrFile => ({
  filename,
  additions: 1,
  deletions: 1,
  status: "modified",
  patch,
});
it.each([
  "*target = value;",
  "* target = value;",
  "total += value;",
  "flags |= mask;",
  "count <<= shift;",
])("keeps a behavior-delta lens for the removed write %s", (line) => {
  expect(behaviourDeltaRisk(file("src/a.cpp", `@@ -1 +1 @@\n-${line}\n+// removed`))).toBe(true);
});
it.each(["README.mdx", "guide.adoc"])("sweeps %s prose only alongside production code", (path) => {
  const doc = file(path);
  expect(sweepGroups([doc], 8).groups).toEqual([]);
  expect(sweepGroups([file("src/a.ts"), doc], 8).groups.flat()).toContain(path);
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "planning-linters-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
it.each([
  "npm run -s lint",
  "node --run lint",
  "pnpm --silent lint",
  "yarn --silent lint",
  "bun run --silent lint",
])("finds the CI linter behind %s", (command) => {
  const dir = repo({
    ".github/workflows/ci.yml": `jobs:\n  lint:\n    steps:\n      - run: ${command}\n`,
    "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
  });
  expect(findCiLinters(dir).map((tool) => tool.tool)).toEqual(["eslint"]);
});
it("a package-script call does not admit an unrelated Makefile", () => {
  const dir = repo({
    ".github/workflows/ci.yml": "jobs:\n  lint:\n    steps:\n      - run: npm run lint\n",
    "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
    Makefile: "lint:\n\truff check .\n",
  });
  expect(findCiLinters(dir).map((tool) => tool.tool)).toEqual(["eslint"]);
});
it("does not attribute an unused Makefile linter to a CI test target", () => {
  const dir = repo({
    ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: make test\n",
    Makefile: "test:\n\tpytest\nlint:\n\truff check .\n",
  });
  expect(findCiLinters(dir)).toEqual([]);
});
