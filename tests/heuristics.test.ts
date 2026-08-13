import { describe, expect, it } from "vitest";
import { escalationWorthy, isTestFile, migrationGate, prodStats, selectLenses, type PrFile } from "../src/heuristics.js";

const f = (filename: string, additions = 1, deletions = 0): PrFile => ({ filename, additions, deletions });

describe("isTestFile (the ported jq exclusion)", () => {
  it("matches test locations and test-named files", () => {
    for (const name of [
      "tests/test_api.py",
      "test/helpers.js",
      "app/__tests__/thing.tsx",
      "pkg/test_client.go",
      "pkg/client_test.go",
      "src/foo.test.ts",
      "src/foo.spec.js",
      "backend/conftest.py",
      "app/fixtures/users.json",
    ]) {
      expect(isTestFile(name), name).toBe(true);
    }
  });

  it("leaves production files alone", () => {
    for (const name of [
      "src/api/routes.py",
      "src/latest.ts",
      "docs/testing.md",
      "src/contest.py",
      "app/protest/views.py",
    ]) {
      expect(isTestFile(name), name).toBe(false);
    }
  });
});

describe("prodStats", () => {
  it("counts only non-test files and sums both sides of the diff", () => {
    expect(
      prodStats([f("src/a.py", 10, 5), f("tests/test_a.py", 100, 100), f("src/b.ts", 1, 1)]),
    ).toEqual({ prod_files: 2, prod_lines: 17 });
  });

  it("is zero for a test-only PR", () => {
    expect(prodStats([f("tests/test_a.py", 50, 50)])).toEqual({ prod_files: 0, prod_lines: 0 });
  });
});

describe("escalationWorthy", () => {
  it("is false for a small production change", () => {
    expect(escalationWorthy([f("src/a.py", 10, 2)])).toEqual({ worthy: false, reasons: [] });
  });

  it("flags infra-shaped paths", () => {
    for (const name of ["infra/main.tf", "ansible/site.yml", ".github/workflows/ci.yml", "deploy/prod.tf", "setup.sh"]) {
      const out = escalationWorthy([f(name)]);
      expect(out.worthy, name).toBe(true);
      expect(out.reasons[0]).toContain("infra paths");
    }
  });

  it("flags size over the prod-lines and prod-files thresholds", () => {
    expect(escalationWorthy([f("src/a.py", 300, 201)]).reasons).toEqual(["prod_lines 501 > 500"]);
    expect(escalationWorthy([f("src/a.py", 250, 250)]).worthy).toBe(false); // exactly 500 is fine
    const many = Array.from({ length: 16 }, (_, i) => f(`src/m${i}.py`));
    expect(escalationWorthy(many).reasons).toEqual(["prod_files 16 > 15"]);
  });

  it("ignores test churn when sizing", () => {
    expect(escalationWorthy([f("tests/test_big.py", 5000, 5000)]).worthy).toBe(false);
  });
});

describe("migrationGate", () => {
  it("trips on any migrations/ path", () => {
    expect(migrationGate([f("app/migrations/0007_add_col.py")])).toBe(true);
    expect(migrationGate([f("migrations/001.sql")])).toBe(true);
    expect(migrationGate([f("src/models.py")])).toBe(false);
  });
});

describe("selectLenses", () => {
  it("always includes the baseline lens", () => {
    expect(selectLenses([f("README.md")])).toEqual(["pass-baseline"]);
  });

  it("adds conditional lenses from the changed-file shape", () => {
    expect(selectLenses([f("frontend/App.tsx")])).toContain("pass-ui");
    expect(selectLenses([f("src/api/routes.py")])).toContain("pass-contracts");
    expect(selectLenses([f("app/migrations/001.py")])).toContain("pass-data-safety");
    expect(selectLenses([f("src/auth/login.py")])).toContain("pass-security");
    expect(selectLenses([f("src/token_store.py")])).toContain("pass-security");
    expect(selectLenses([f("src/workers/queue.py")])).toContain("pass-statelessness");
    expect(selectLenses([f("infra/main.tf")])).toContain("pass-prod-risk");
    expect(selectLenses([f("src/notifications/send.py")])).toContain("pass-delivery");
  });

  it("is deterministic and de-duplicated", () => {
    const files = [f("frontend/a.tsx"), f("frontend/b.tsx"), f("src/api/x.py")];
    const first = selectLenses(files);
    expect(selectLenses(files)).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first[0]).toBe("pass-baseline");
  });
});
