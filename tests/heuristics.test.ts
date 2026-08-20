import { describe, expect, it } from "vitest";
import {
  INTENT_MIN_SUBSTANCE_WORDS,
  INTENT_PASS,
  intentSubstanceWords,
  isTestFile,
  meetsIntentBar,
  migrationGate,
  passTier,
  prodStats,
  selectLenses,
  type PrFile,
} from "../src/heuristics.js";
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

// ---- placement / simplicity / backcompat ---------------

describe("selectLenses: pass-placement", () => {
  it("fires on a new code file", () => {
    expect(selectLenses([{ ...f("src/service/limiter.py"), status: "added" }])).toContain("pass-placement");
  });

  it("fires on a moved code file — a move is the purest placement change", () => {
    expect(selectLenses([{ ...f("src/service/limiter.py"), status: "renamed" }])).toContain("pass-placement");
  });

  it("never fires on added docs, config, or assets — nothing to place", () => {
    for (const name of ["README.md", "docs/guide.md", ".pi/settings.json", "assets/logo.png", "package-lock.json"]) {
      expect(selectLenses([{ ...f(name), status: "added" }]), name).not.toContain("pass-placement");
    }
  });

  it("fires on a cross-cutting diff (>= 4 prod files), modified-only", () => {
    const files = ["a", "b", "c", "d"].map((n) => ({ ...f(`src/${n}.py`), status: "modified" }));
    expect(selectLenses(files)).toContain("pass-placement");
  });

  it("stays quiet on small edits-in-place and on new TEST files", () => {
    expect(selectLenses([{ ...f("src/a.py"), status: "modified" }])).not.toContain("pass-placement");
    expect(selectLenses([{ ...f("tests/test_new.py"), status: "added" }])).not.toContain("pass-placement");
    // Four files, but three are tests: prod count is 1.
    const files = [
      { ...f("src/a.py"), status: "modified" },
      { ...f("tests/t1.py"), status: "modified" },
      { ...f("tests/t2.py"), status: "modified" },
      { ...f("tests/t3.py"), status: "modified" },
    ];
    expect(selectLenses(files)).not.toContain("pass-placement");
  });
});

describe("selectLenses: pass-simplicity", () => {
  it("fires on a large code diff", () => {
    expect(selectLenses([{ ...f("src/big.py"), additions: 140, deletions: 15 }])).toContain("pass-simplicity");
  });

  it("counts neither test lines nor docs lines toward the size trigger", () => {
    expect(selectLenses([{ ...f("tests/test_big.py"), additions: 300, deletions: 0 }])).not.toContain(
      "pass-simplicity",
    );
    expect(selectLenses([{ ...f("docs/spec.md"), additions: 300, deletions: 0 }])).not.toContain("pass-simplicity");
  });

  it("stays lean under the small-diff line (aligned with small_diff_lines)", () => {
    expect(selectLenses([{ ...f("src/mid.py"), additions: 120, deletions: 0 }])).not.toContain("pass-simplicity");
  });

  it("counts `} else if` rungs and is not fooled by added blank lines before context branches", () => {
    const rungs = Array.from({ length: 5 }, () => "+  } else if (x) {").join("\n");
    expect(selectLenses([{ ...f("src/branchy.ts"), patch: `@@ -1 +1,10 @@\n${rungs}` }])).toContain(
      "pass-simplicity",
    );
    // Added blank lines followed by UNCHANGED context `if` lines: `\s` must
    // not swallow the newline and count context as added branches.
    const blanks = Array.from({ length: 6 }, () => "+\n if a:").join("\n");
    expect(selectLenses([{ ...f("src/quiet.py"), patch: `@@ -1 +1,12 @@\n${blanks}` }])).not.toContain(
      "pass-simplicity",
    );
  });

  it("fires on deep nesting in added lines", () => {
    const nested = { ...f("src/deep.py"), patch: `@@ -1 +1,2 @@\n+${" ".repeat(20)}return x\n pass` };
    expect(selectLenses([nested])).toContain("pass-simplicity");
  });

  it("fires on a pile of added branches in one file", () => {
    const branches = Array.from({ length: 5 }, (_, i) => `+    if x == ${i}:`).join("\n+        pass\n");
    expect(selectLenses([{ ...f("src/branchy.py"), patch: `@@ -1 +1,10 @@\n${branches}` }])).toContain(
      "pass-simplicity",
    );
  });

  it("stays quiet on a small flat diff", () => {
    const flat = { ...f("src/small.py"), patch: "@@ -1 +1,2 @@\n+x = 1\n pass" };
    expect(selectLenses([flat])).not.toContain("pass-simplicity");
  });
});

describe("selectLenses: pass-backcompat", () => {
  it("fires on wire-format, API, queue, migration, and settings surfaces", () => {
    expect(selectLenses([f("app/serializers/user.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("src/api/routes.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("app/views.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("app/urls.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("proto/events.proto")])).toContain("pass-backcompat");
    expect(selectLenses([f("app/migrations/0042_add_col.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("app/tasks/retrain.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("project/settings_prod.py")])).toContain("pass-backcompat");
  });

  it("fires on a feature-flag content signal", () => {
    const flag = { ...f("src/rollout.py"), patch: "@@ -1 +1,2 @@\n+if feature_flag('new_billing'):\n pass" };
    expect(selectLenses([flag])).toContain("pass-backcompat");
  });

  it("stays quiet on internal-only code and on docs under api-shaped dirs", () => {
    expect(selectLenses([f("src/utils/text.py"), f("docs/notes.md")])).not.toContain("pass-backcompat");
    // The dir arm requires a CODE file — a docs page under api/ is not a
    // wire surface.
    expect(selectLenses([f("docs/api/readme.md")])).not.toContain("pass-backcompat");
  });

  it("covers plural and non-Django route shapes", () => {
    expect(selectLenses([f("src/apis/v1/x.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("src/routes/user.ts")])).toContain("pass-backcompat");
    expect(selectLenses([f("src/controllers/billing.ts")])).toContain("pass-backcompat");
  });
});

// ---- pass-intent --------------------------------------------------

const SUBSTANTIVE_BODY =
  "This PR introduces a token-bucket rate limiter for the public API. " +
  "Requests over the limit receive a 429 with a Retry-After header, and the " +
  "bucket refills once per second per client key. No behaviour change for " +
  "authenticated internal traffic.";

describe("intent substance bar", () => {
  it("rejects thin bodies — the lens's only honest output would be NONE", () => {
    expect(meetsIntentBar(undefined)).toBe(false);
    expect(meetsIntentBar(null)).toBe(false);
    expect(meetsIntentBar("")).toBe(false);
    expect(meetsIntentBar("fixes the bug")).toBe(false);
    expect(meetsIntentBar("see JIRA-1234")).toBe(false);
  });

  it("accepts a body with real author prose", () => {
    expect(meetsIntentBar(SUBSTANTIVE_BODY)).toBe(true);
    expect(intentSubstanceWords(SUBSTANTIVE_BODY)).toBeGreaterThanOrEqual(INTENT_MIN_SUBSTANCE_WORDS);
  });

  it("does not count template scaffolding as substance", () => {
    // An unfilled PR template: comments, headings, empty checkboxes, code and
    // links — lots of characters, zero author intent.
    const template = [
      "<!-- Please describe your change below. Explain the motivation, the",
      "approach you took, and anything the reviewer should pay attention to -->",
      "## Description",
      "## Checklist",
      "- [ ]",
      "- [x]",
      "```",
      "npm run build && npm test && make deploy release publish verify lint",
      "```",
      "https://github.com/example-org/example-app/pull/999",
      "`inline_code_identifier`",
    ].join("\n");
    expect(intentSubstanceWords(template)).toBe(0);
    expect(meetsIntentBar(template)).toBe(false);
    // The same template WITH real prose underneath clears the bar.
    expect(meetsIntentBar(`${template}\n${SUBSTANTIVE_BODY}`)).toBe(true);
  });
});

describe("selectLenses: pass-intent", () => {
  const files = [f("app/service.py", 40, 3)];

  it("is keyed on the body, never on the file shape", () => {
    expect(selectLenses(files)).not.toContain(INTENT_PASS);
    expect(selectLenses(files, {})).not.toContain(INTENT_PASS);
    expect(selectLenses(files, { body: "fixes the bug" })).not.toContain(INTENT_PASS);
    expect(selectLenses(files, { body: SUBSTANTIVE_BODY })).toContain(INTENT_PASS);
    // Same body, wildly different file shapes: selection does not move.
    expect(selectLenses([f("infra/main.tf"), f("frontend/x.tsx")], { body: SUBSTANTIVE_BODY })).toContain(INTENT_PASS);
  });

  it("skips the lens on a thin body — cheaper than dispatching a NONE", () => {
    expect(selectLenses(files, { body: "" })).not.toContain(INTENT_PASS);
    expect(selectLenses(files, { body: null })).not.toContain(INTENT_PASS);
  });
});
