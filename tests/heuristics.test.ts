import { describe, expect, it } from "vitest";
import { isTestFile, migrationGate, passTier, prodStats, selectLenses, type PrFile } from "../src/heuristics.js";
import type { PrFileEntry } from "../src/github.js";

const f = (filename: string, additions = 1, deletions = 0): PrFile => ({ filename, additions, deletions });
const fe = (filename: string, additions = 1, deletions = 0): PrFileEntry => ({
  filename,
  additions,
  deletions,
  status: "modified",
});

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

describe("escalationWorthy is gone", () => {
  it("exports no escalation heuristic at all (scrapped 2026-08-18)", async () => {
    const mod = (await import("../src/heuristics.js")) as Record<string, unknown>;
    for (const name of ["escalationWorthy", "ESCALATION_PATH_PATTERNS", "escalationReasons"]) {
      expect(mod[name], name).toBeUndefined();
    }
  });
});

describe("migrationGate", () => {
  it("trips on any migrations/ path", () => {
    expect(migrationGate([f("app/migrations/0007_add_col.py")])).toBe(true);
    expect(migrationGate([f("migrations/001.sql")])).toBe(true);
    expect(migrationGate([f("src/models.py")])).toBe(false);
  });
});

describe("passTier", () => {
  const opts = { migrationGate: false, smallDiffLines: 150 };

  it("starts small quiet diffs at terra-med", () => {
    expect(passTier([fe("src/a.py", 100, 49)], opts)).toBe("terra-med");
    expect(passTier([], opts)).toBe("terra-med");
  });

  it("goes sol-med at exactly smallDiffLines (strict less-than)", () => {
    expect(passTier([fe("src/a.py", 100, 50)], opts)).toBe("sol-med");
    expect(passTier([fe("src/a.py", 100, 49), fe("src/b.py", 1, 0)], opts)).toBe("sol-med");
  });

  it("goes sol-med on the migration gate, however small", () => {
    expect(passTier([fe("src/a.py", 1, 0)], { ...opts, migrationGate: true })).toBe("sol-med");
  });

  it("no longer raises the tier for infra paths (the escalation heuristic is gone)", () => {
    expect(passTier([fe("infra/main.tf", 1, 0)], opts)).toBe("terra-med");
  });

  it("counts additions plus deletions across all files, tests included", () => {
    expect(passTier([fe("tests/test_a.py", 200, 0)], opts)).toBe("sol-med");
    expect(passTier([fe("src/a.py", 10, 10)], { ...opts, smallDiffLines: 21 })).toBe("terra-med");
  });
});

describe("selectLenses", () => {
  it("always includes the baseline lens", () => {
    expect(selectLenses([f("README.md")])).toEqual(["pass-baseline"]);
  });

  it("never selects pass-validate (dispatch appends it)", () => {
    expect(selectLenses([f("frontend/App.tsx"), f("app/migrations/001.py")])).not.toContain("pass-validate");
  });

  it("adds conditional lenses from the changed-file shape", () => {
    expect(selectLenses([f("frontend/App.tsx")])).toContain("pass-ui");
    expect(selectLenses([f("src/components/Button.tsx")])).toContain("pass-ui");
    expect(selectLenses([f("app/serializers/user.py")])).toContain("pass-contracts");
    expect(selectLenses([f("integrations/stripe/client.py")])).toContain("pass-contracts");
    expect(selectLenses([f("api/events.proto")])).toContain("pass-contracts");
    expect(selectLenses([f("app/migrations/001.py")])).toContain("pass-data-safety");
    expect(selectLenses([f("db/schema_change.sql")])).toContain("pass-data-safety");
    expect(selectLenses([f("app/management/commands/backfill_users.py")])).toContain("pass-data-safety");
    expect(selectLenses([f("src/auth/login.py")])).toContain("pass-security");
    expect(selectLenses([f("src/token_store.py")])).toContain("pass-security");
    expect(selectLenses([f("package-lock.json")])).toContain("pass-security");
    expect(selectLenses([f("backend/requirements.txt")])).toContain("pass-security");
    expect(selectLenses([f("project/settings_prod.py")])).toContain("pass-security");
    expect(selectLenses([f(".env.example")])).toContain("pass-security");
    expect(selectLenses([f("src/scenario_cache.py")])).toContain("pass-statelessness");
    expect(selectLenses([f("infra/main.tf")])).toContain("pass-prod-risk");
    expect(selectLenses([f(".github/workflows/ci.yml")])).toContain("pass-prod-risk");
    expect(selectLenses([f("docker/Dockerfile")])).toContain("pass-prod-risk");
    expect(selectLenses([f("src/webhooks/meta.py")])).toContain("pass-delivery");
    expect(selectLenses([f("src/workers/queue.py")])).toContain("pass-delivery");
    expect(selectLenses([f("app/tasks/retrain.py")])).toContain("pass-delivery");
  });

  it("uses added-line patch signals for statelessness and delivery", () => {
    const lru = { ...f("src/utils.py"), patch: "@@ -1,2 +1,4 @@\n+import functools\n+@functools.lru_cache\n def g():" };
    expect(selectLenses([lru])).toContain("pass-statelessness");
    const moduleDict = { ...f("src/utils.py"), patch: "@@ -1 +1,2 @@\n+_SEEN: dict[str, int] = {}\n pass" };
    expect(selectLenses([moduleDict])).toContain("pass-statelessness");
    const bg = { ...f("src/handlers.py"), patch: "@@ -1 +1,2 @@\n+@background_decorator\n def handle():" };
    expect(selectLenses([bg])).toContain("pass-delivery");
    // Removed-only or absent patches trip nothing.
    const removed = { ...f("src/utils.py"), patch: "@@ -1,2 +1 @@\n-@functools.lru_cache\n pass" };
    expect(selectLenses([removed])).not.toContain("pass-statelessness");
  });

  it("does not fire lenses on out-of-focus paths (the tightened rules)", () => {
    // Backend-only python in generic web dirs: no UI, no contracts.
    const backend = selectLenses([f("src/api/routes.py"), f("src/views/user.py"), f("src/controllers/x.py")]);
    expect(backend).not.toContain("pass-ui");
    expect(backend).not.toContain("pass-contracts");
    // models/ without a migration is not a data-safety trigger anymore.
    expect(selectLenses([f("src/models.py"), f("app/models/user.py")])).not.toContain("pass-data-safety");
    // A plain worker/task file with no patch signals is delivery, not statelessness.
    expect(selectLenses([f("src/workers/queue.py")])).not.toContain("pass-statelessness");
    // "deploy"/"docker" as a mere substring no longer trips prod-risk.
    expect(selectLenses([f("docs/deployment_notes.md")])).not.toContain("pass-prod-risk");
    // Email/notification content dirs are no longer a delivery trigger.
    expect(selectLenses([f("src/notifications/send.py"), f("src/email/render.py")])).not.toContain("pass-delivery");
    // Generic ui/templates dirs without frontend files are not pass-ui.
    expect(selectLenses([f("src/ui/helpers.py"), f("app/templates_config.py")])).not.toContain("pass-ui");
  });

  it("is deterministic and de-duplicated", () => {
    const files = [f("frontend/a.tsx"), f("frontend/b.tsx"), f("app/serializers/x.py")];
    const first = selectLenses(files);
    expect(selectLenses(files)).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first[0]).toBe("pass-baseline");
  });
});
