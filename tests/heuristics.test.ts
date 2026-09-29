import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  EMPTY_HEURISTICS,
  INTENT_MIN_SUBSTANCE_WORDS,
  INTENT_PASS,
  intentSubstanceWords,
  isTestFile,
  meetsIntentBar,
  migrationGate,
  passTier,
  PROFILE_EXTENDABLE_LENSES,
  prodStats,
  selectLenses,
  type PrFile,
} from "../src/heuristics.js";
import { loadProfileHeuristics } from "../src/profiles.js";
import type { PrFileEntry } from "../src/github.js";
import { stageFixtureProfile } from "./helpers/tracked-profiles.js";

const sandbox = join(import.meta.dirname, "..");
/** The quickchat profile's heuristics.toml — the predicates moved out
 * of the compiled-in core — as the frozen fixture copy
 * (tests/fixtures/profiles/quickchat,: the live pack now lives in the
 * install's config home). These tests are the equivalence proof for those
 * bytes. The fixture is dropped from the assembled snapshots, so the
 * proofs self-skip (HAS_QC) there — and only there: in the source tree a
 * missing fixture throws (tests/helpers/tracked-profiles.ts). */
const HAS_QC = stageFixtureProfile(sandbox, "quickchat");
const QC = HAS_QC ? loadProfileHeuristics(sandbox, "quickchat") : EMPTY_HEURISTICS;

const f = (filename: string, additions = 1, deletions = 0): PrFile => ({
  filename,
  additions,
  deletions,
});
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
    expect(selectLenses([f("frontend/App.tsx"), f("app/migrations/001.py")])).not.toContain(
      "pass-validate",
    );
  });

  it("adds conditional lenses from the changed-file shape", () => {
    expect(selectLenses([f("frontend/App.tsx")])).toContain("pass-ui");
    expect(selectLenses([f("src/components/Button.tsx")])).toContain("pass-ui");
    expect(selectLenses([f("app/serializers/user.py")])).toContain("pass-contracts");
    expect(selectLenses([f("integrations/stripe/client.py")])).toContain("pass-contracts");
    expect(selectLenses([f("api/events.proto")])).toContain("pass-contracts");
    expect(selectLenses([f("app/migrations/001.py")])).toContain("pass-data-safety");
    expect(selectLenses([f("db/schema_change.sql")])).toContain("pass-data-safety");
    expect(selectLenses([f("src/auth/login.py")])).toContain("pass-security");
    expect(selectLenses([f("src/token_store.py")])).toContain("pass-security");
    expect(selectLenses([f("package-lock.json")])).toContain("pass-security");
    // A deletion-only manifest change adds no dependency — no sol-high pass.
    expect(selectLenses([f("docs/package-lock.json", 0, 40)])).not.toContain("pass-security");
    // A lockfile that ADDS lines with no package.json change still fires.
    expect(selectLenses([f("package-lock.json", 3, 3)])).toContain("pass-security");
    expect(selectLenses([f("backend/requirements.txt")])).toContain("pass-security");
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
    const lru = {
      ...f("src/utils.py"),
      patch: "@@ -1,2 +1,4 @@\n+import functools\n+@functools.lru_cache\n def g():",
    };
    expect(selectLenses([lru])).toContain("pass-statelessness");
    const moduleDict = {
      ...f("src/utils.py"),
      patch: "@@ -1 +1,2 @@\n+_SEEN: dict[str, int] = {}\n pass",
    };
    expect(selectLenses([moduleDict])).toContain("pass-statelessness");
    // Removed-only or absent patches trip nothing.
    const removed = { ...f("src/utils.py"), patch: "@@ -1,2 +1 @@\n-@functools.lru_cache\n pass" };
    expect(selectLenses([removed])).not.toContain("pass-statelessness");
  });

  it.skipIf(!HAS_QC)(
    "repo-shaped predicates moved to the quickchat profile fire only WITH it",
    () => {
      const profileCases: Array<[PrFile, string]> = [
        [f("project/settings_prod.py"), "pass-security"],
        [f("app/management/commands/backfill_users.py"), "pass-data-safety"],
        [
          {
            ...f("src/handlers.py"),
            patch: "@@ -1 +1,2 @@\n+@background_decorator\n def handle():",
          },
          "pass-delivery",
        ],
        [f("app/views.py"), "pass-backcompat"],
        [f("app/urls.py"), "pass-backcompat"],
        [f("project/settings_prod.py"), "pass-backcompat"],
        [
          {
            ...f("src/rollout.py"),
            patch: "@@ -1 +1,2 @@\n+if waffle.flag_is_active(r, 'x'):\n pass",
          },
          "pass-backcompat",
        ],
      ];
      for (const [file, lens] of profileCases) {
        // With the quickchat extension: selected (today's live behaviour).
        expect(selectLenses([file], undefined, QC), `${file.filename} + quickchat`).toContain(lens);
        // Generic core alone (no profile / the minimal profile): not selected.
        expect(selectLenses([file]), `${file.filename} bare`).not.toContain(lens);
      }
    },
  );

  it("does not fire lenses on out-of-focus paths (the tightened rules)", () => {
    // Backend-only python in generic web dirs: no UI, no contracts.
    const backend = selectLenses([
      f("src/api/routes.py"),
      f("src/views/user.py"),
      f("src/controllers/x.py"),
    ]);
    expect(backend).not.toContain("pass-ui");
    expect(backend).not.toContain("pass-contracts");
    // models/ without a migration is not a data-safety trigger anymore.
    expect(selectLenses([f("src/models.py"), f("app/models/user.py")])).not.toContain(
      "pass-data-safety",
    );
    // A plain worker/task file with no patch signals is delivery, not statelessness.
    expect(selectLenses([f("src/workers/queue.py")])).not.toContain("pass-statelessness");
    // "deploy"/"docker" as a mere substring no longer trips prod-risk.
    expect(selectLenses([f("docs/deployment_notes.md")])).not.toContain("pass-prod-risk");
    // Email/notification content dirs are no longer a delivery trigger.
    expect(selectLenses([f("src/notifications/send.py"), f("src/email/render.py")])).not.toContain(
      "pass-delivery",
    );
    // Generic ui/templates dirs without frontend files are not pass-ui.
    expect(selectLenses([f("src/ui/helpers.py"), f("app/templates_config.py")])).not.toContain(
      "pass-ui",
    );
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
  it("fires on a new code file of 30+ lines (the default preset's floor)", () => {
    expect(selectLenses([{ ...f("src/service/limiter.py", 40), status: "added" }])).toContain(
      "pass-placement",
    );
    // A tiny new file rarely poses a placement question (2026-09-27 lean plan)…
    expect(selectLenses([{ ...f("src/service/limiter.py", 5), status: "added" }])).not.toContain(
      "pass-placement",
    );
    // …unless the floor is lowered, as the max preset does.
    expect(
      selectLenses([{ ...f("src/service/limiter.py", 5), status: "added" }], undefined, undefined, {
        placementMinNewFileLines: 0,
      }),
    ).toContain("pass-placement");
  });

  it("fires on a moved code file — a move is the purest placement change", () => {
    expect(selectLenses([{ ...f("src/service/limiter.py", 40), status: "renamed" }])).toContain(
      "pass-placement",
    );
  });

  it("never fires on added docs, config, or assets — nothing to place", () => {
    for (const name of [
      "README.md",
      "docs/guide.md",
      ".pi/settings.json",
      "assets/logo.png",
      "package-lock.json",
    ]) {
      expect(selectLenses([{ ...f(name), status: "added" }]), name).not.toContain("pass-placement");
    }
  });

  it("fires on a cross-cutting diff (>= 8 prod files by default), modified-only", () => {
    const eight = ["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => ({
      ...f(`src/${n}.py`),
      status: "modified",
    }));
    expect(selectLenses(eight)).toContain("pass-placement");
    const four = eight.slice(0, 4);
    expect(selectLenses(four)).not.toContain("pass-placement");
    expect(selectLenses(four, undefined, undefined, { placementMinCodeFiles: 4 })).toContain(
      "pass-placement",
    );
  });

  it("stays quiet on small edits-in-place and on new TEST files", () => {
    expect(selectLenses([{ ...f("src/a.py"), status: "modified" }])).not.toContain(
      "pass-placement",
    );
    expect(selectLenses([{ ...f("tests/test_new.py"), status: "added" }])).not.toContain(
      "pass-placement",
    );
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
    expect(selectLenses([{ ...f("src/big.py"), additions: 140, deletions: 15 }])).toContain(
      "pass-simplicity",
    );
  });

  it("counts neither test lines nor docs lines toward the size trigger", () => {
    expect(
      selectLenses([{ ...f("tests/test_big.py"), additions: 300, deletions: 0 }]),
    ).not.toContain("pass-simplicity");
    expect(selectLenses([{ ...f("docs/spec.md"), additions: 300, deletions: 0 }])).not.toContain(
      "pass-simplicity",
    );
  });

  it("stays lean under the small-diff line (aligned with small_diff_lines)", () => {
    expect(selectLenses([{ ...f("src/mid.py"), additions: 120, deletions: 0 }])).not.toContain(
      "pass-simplicity",
    );
  });

  it("counts `} else if` rungs and is not fooled by added blank lines before context branches", () => {
    const rungs = Array.from({ length: 5 }, () => "+  } else if (x) {").join("\n");
    expect(selectLenses([{ ...f("src/branchy.ts"), patch: `@@ -1 +1,10 @@\n${rungs}` }])).toContain(
      "pass-simplicity",
    );
    // Added blank lines followed by UNCHANGED context `if` lines: `\s` must
    // not swallow the newline and count context as added branches.
    const blanks = Array.from({ length: 6 }, () => "+\n if a:").join("\n");
    expect(
      selectLenses([{ ...f("src/quiet.py"), patch: `@@ -1 +1,12 @@\n${blanks}` }]),
    ).not.toContain("pass-simplicity");
  });

  it("fires on deep nesting in added lines", () => {
    const nested = {
      ...f("src/deep.py"),
      patch: `@@ -1 +1,2 @@\n+${" ".repeat(20)}return x\n pass`,
    };
    expect(selectLenses([nested])).toContain("pass-simplicity");
  });

  it("fires on a pile of added branches in one file", () => {
    const branches = Array.from({ length: 5 }, (_, i) => `+    if x == ${i}:`).join(
      "\n+        pass\n",
    );
    expect(
      selectLenses([{ ...f("src/branchy.py"), patch: `@@ -1 +1,10 @@\n${branches}` }]),
    ).toContain("pass-simplicity");
  });

  it("stays quiet on a small flat diff", () => {
    const flat = { ...f("src/small.py"), patch: "@@ -1 +1,2 @@\n+x = 1\n pass" };
    expect(selectLenses([flat])).not.toContain("pass-simplicity");
  });
});

describe("selectLenses: pass-backcompat", () => {
  it("fires on wire-format, API, queue, and migration surfaces (generic core)", () => {
    expect(selectLenses([f("app/serializers/user.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("src/api/routes.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("proto/events.proto")])).toContain("pass-backcompat");
    expect(selectLenses([f("app/migrations/0042_add_col.py")])).toContain("pass-backcompat");
    expect(selectLenses([f("app/tasks/retrain.py")])).toContain("pass-backcompat");
  });

  it.skipIf(!HAS_QC)(
    "fires on DRF filename vocabulary and settings via the quickchat profile",
    () => {
      expect(selectLenses([f("app/views.py")], undefined, QC)).toContain("pass-backcompat");
      expect(selectLenses([f("app/urls.py")], undefined, QC)).toContain("pass-backcompat");
      expect(selectLenses([f("project/settings_prod.py")], undefined, QC)).toContain(
        "pass-backcompat",
      );
    },
  );

  it("fires on a feature-flag content signal", () => {
    const flag = {
      ...f("src/rollout.py"),
      patch: "@@ -1 +1,2 @@\n+if feature_flag('new_billing'):\n pass",
    };
    expect(selectLenses([flag])).toContain("pass-backcompat");
  });

  it("stays quiet on internal-only code and on docs under api-shaped dirs", () => {
    expect(selectLenses([f("src/utils/text.py"), f("docs/notes.md")])).not.toContain(
      "pass-backcompat",
    );
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
  "authenticated internal traffic. The limiter lives in the middleware layer " +
  "so every public route shares it, the per-key budget comes from settings, " +
  "and a burst allowance keeps short spikes from being rejected while a " +
  "sustained flood is throttled.";

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
    expect(intentSubstanceWords(SUBSTANTIVE_BODY)).toBeGreaterThanOrEqual(
      INTENT_MIN_SUBSTANCE_WORDS,
    );
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
    expect(
      selectLenses([f("infra/main.tf"), f("frontend/x.tsx")], { body: SUBSTANTIVE_BODY }),
    ).toContain(INTENT_PASS);
  });

  it("skips the lens on a thin body — cheaper than dispatching a NONE", () => {
    expect(selectLenses(files, { body: "" })).not.toContain(INTENT_PASS);
    expect(selectLenses(files, { body: null })).not.toContain(INTENT_PASS);
  });
});

// ---- equivalence proof ----------------------------------------------
//
// The heart of the slice: `legacySelectLenses` below is a FROZEN, verbatim
// copy of the legacy compiled-in selection (constants inlined so nothing
// tracks future source drift). Over the corpus, selection with the REAL
// quickchat heuristics.toml must equal the legacy selection EXACTLY — same
// lenses, same order — and the empty extension (no profile / the minimal
// profile) must fire only the generic core.

const LEGACY_CODE_FILE_RE =
  /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|kts|rs|c|cc|cpp|h|hpp|cs|php|swift|scala|ex|exs|vue|svelte)$/i;
const LEGACY_PLACEMENT_STATUSES = new Set(["added", "renamed", "copied"]);
const LEGACY_DEPS_MANIFEST_RE =
  /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|pyproject\.toml|Pipfile(\.lock)?|go\.(mod|sum)|Gemfile(\.lock)?|Cargo\.(toml|lock))$/;
const LEGACY_DEEP_INDENT_RE = /^\+(?: {20,}|\t{5,})\S/m;
const LEGACY_BRANCH_RE = /^\+[ \t]*[)\]}]*[ \t]*(if|elif|else[ \t]+if|case|when)\b/gm;

/** Verbatim legacy selectLenses (src/heuristics.ts at commit 50ca772). */
/** The thresholds the frozen legacy selection was written with (before the
 * 2026-09-27 default preset raised them): the proof is about the
 * profile's PREDICATES, so it holds the thresholds at the legacy values. */
const LEGACY_TUNING = { intentMinWords: 20, placementMinCodeFiles: 4, placementMinNewFileLines: 0 };

function legacySelectLenses(files: PrFile[], intent?: { body?: string | null }): string[] {
  const lenses = new Set<string>(["pass-baseline"]);
  const names = files.map((x) => x.filename);
  const any = (re: RegExp) => names.some((n) => re.test(n));
  const added = (re: RegExp) => files.some((x) => x.patch !== undefined && re.test(x.patch));

  if (any(/\.(tsx|jsx|vue|svelte|css|scss|less|html)$/) || any(/(^|\/)frontend\//))
    lenses.add("pass-ui");
  if (
    any(/(^|\/)(serializers?|schemas?|integrations?|providers?|connectors?)\//) ||
    any(/\.(proto|graphql)$/)
  )
    lenses.add("pass-contracts");
  if (
    any(/(^|\/)migrations\//) ||
    any(/\.sql$/) ||
    any(/(^|\/)backfills?\//) ||
    any(/(^|\/)management\/commands\//)
  )
    lenses.add("pass-data-safety");
  if (
    any(/(^|\/)(auth|authn|authz|security|permissions|middleware|throttling)\//) ||
    any(/(secret|token|passw|crypt|oauth|jwt|csrf|cors)/i) ||
    any(/(^|\/)\.env(\.[^/]+)?$/) ||
    any(/(^|\/)settings[^/]*\.py$/) ||
    any(LEGACY_DEPS_MANIFEST_RE)
  )
    lenses.add("pass-security");
  if (
    added(/^\+.*(@lru_cache|functools\.(cache|lru_cache))/m) ||
    added(/^\+.*threading\.(Lock|local)\(/m) ||
    added(
      /^\+[A-Za-z_][A-Za-z0-9_]*\s*(?::[^=\n]+)?=\s*(\{\}|\[\]|set\(\)|dict\(\)|defaultdict\()/m,
    ) ||
    any(/(^|\/)[^/]*(cache|singleton|registry)[^/]*\.[a-z]+$/i)
  )
    lenses.add("pass-statelessness");
  if (
    any(/(^|\/)(infra|ansible|terraform|helm|k8s|kubernetes)\//) ||
    any(/(^|\/)\.github\/workflows\//) ||
    any(/\.tf$/) ||
    any(/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/)
  )
    lenses.add("pass-prod-risk");
  if (
    any(/(^|\/)(webhooks?|tasks|jobs|workers?|crons?|consumers?|subscribers?)\//) ||
    any(/(pubsub|pub_sub|cloud_tasks|celery)/i) ||
    added(/^\+.*@background_decorator/m)
  )
    lenses.add("pass-delivery");

  const code = files.filter((x) => !isTestFile(x.filename) && LEGACY_CODE_FILE_RE.test(x.filename));
  if (code.some((x) => LEGACY_PLACEMENT_STATUSES.has(x.status ?? "")) || code.length >= 4)
    lenses.add("pass-placement");

  const codeLines = code.reduce((n, x) => n + x.additions + x.deletions, 0);
  if (
    codeLines >= 150 ||
    code.some((x) => x.patch !== undefined && LEGACY_DEEP_INDENT_RE.test(x.patch)) ||
    code.some((x) => (x.patch?.match(LEGACY_BRANCH_RE)?.length ?? 0) >= 5)
  )
    lenses.add("pass-simplicity");

  const codeIn = (re: RegExp) => code.some((x) => re.test(x.filename));
  if (
    codeIn(
      /(^|\/)(serializers?|schemas?|apis?|views?|endpoints?|routes?|controllers?|handlers?)\//,
    ) ||
    any(/(^|\/)(serializers?|views?|urls?|apis?)[^/]*\.py$/) ||
    any(/\.(proto|graphql)$/) ||
    any(/(^|\/)migrations\//) ||
    codeIn(/(^|\/)(tasks|jobs|workers?|consumers?|queues?)\//) ||
    any(/(^|\/)settings[^/]*\.py$/) ||
    added(/^\+.*(feature.?flag|waffle|launch.?darkly|unleash)/im)
  )
    lenses.add("pass-backcompat");

  if (meetsIntentBar(intent?.body, LEGACY_TUNING.intentMinWords)) lenses.add(INTENT_PASS);
  return [...lenses];
}

const BODY =
  "This PR introduces a token-bucket rate limiter for the public API. " +
  "Requests over the limit receive a 429 with a Retry-After header, and the " +
  "bucket refills once per second per client key. No behaviour change for " +
  "authenticated internal traffic.";

/** Representative corpus: every predicate's trigger cases (core and moved),
 * the non-triggers the tightened rules pin, and realistic mixed PRs. */
const CORPUS: Array<{ name: string; files: PrFile[]; body?: string | null }> = [
  { name: "docs only", files: [f("README.md")] },
  { name: "frontend tsx", files: [f("frontend/App.tsx")] },
  { name: "component tsx", files: [f("src/components/Button.tsx")] },
  { name: "serializers dir", files: [f("app/serializers/user.py")] },
  { name: "integration client", files: [f("integrations/stripe/client.py")] },
  { name: "proto", files: [f("api/events.proto")] },
  { name: "migration", files: [f("app/migrations/001.py")] },
  { name: "raw sql", files: [f("db/schema_change.sql")] },
  { name: "management command", files: [f("app/management/commands/backfill_users.py")] },
  { name: "auth dir", files: [f("src/auth/login.py")] },
  { name: "token-named file", files: [f("src/token_store.py")] },
  { name: "lockfile", files: [f("package-lock.json")] },
  { name: "requirements", files: [f("backend/requirements.txt")] },
  { name: "settings module", files: [f("project/settings_prod.py")] },
  { name: "bare settings.py", files: [f("settings.py")] },
  { name: "dotenv", files: [f(".env.example")] },
  { name: "cache-named file", files: [f("src/scenario_cache.py")] },
  { name: "terraform", files: [f("infra/main.tf")] },
  { name: "workflow", files: [f(".github/workflows/ci.yml")] },
  { name: "dockerfile", files: [f("docker/Dockerfile")] },
  { name: "webhooks dir", files: [f("src/webhooks/meta.py")] },
  { name: "workers dir", files: [f("src/workers/queue.py")] },
  { name: "tasks dir", files: [f("app/tasks/retrain.py")] },
  { name: "celery-named", files: [f("src/celery_config.py")] },
  { name: "views.py", files: [f("app/views.py")] },
  { name: "urls.py", files: [f("app/urls.py")] },
  { name: "api module .py", files: [f("src/apis/v1/x.py")] },
  { name: "routes ts", files: [f("src/routes/user.ts")] },
  { name: "controllers ts", files: [f("src/controllers/billing.ts")] },
  {
    name: "lru_cache patch",
    files: [
      {
        ...f("src/utils.py"),
        patch: "@@ -1,2 +1,4 @@\n+import functools\n+@functools.lru_cache\n def g():",
      },
    ],
  },
  {
    name: "module dict patch",
    files: [{ ...f("src/utils.py"), patch: "@@ -1 +1,2 @@\n+_SEEN: dict[str, int] = {}\n pass" }],
  },
  {
    name: "threading lock patch",
    files: [{ ...f("src/svc.py"), patch: "@@ -1 +1,2 @@\n+_LOCK = threading.Lock()\n pass" }],
  },
  {
    name: "removed-only lru patch",
    files: [{ ...f("src/utils.py"), patch: "@@ -1,2 +1 @@\n-@functools.lru_cache\n pass" }],
  },
  {
    name: "background decorator patch",
    files: [
      { ...f("src/handlers.py"), patch: "@@ -1 +1,2 @@\n+@background_decorator\n def handle():" },
    ],
  },
  {
    name: "feature flag patch",
    files: [
      { ...f("src/rollout.py"), patch: "@@ -1 +1,2 @@\n+if feature_flag('new_billing'):\n pass" },
    ],
  },
  {
    name: "waffle patch",
    files: [
      {
        ...f("src/rollout.py"),
        patch: "@@ -1 +1,2 @@\n+if waffle.flag_is_active(request, 'x'):\n pass",
      },
    ],
  },
  {
    name: "launchdarkly patch",
    files: [
      { ...f("src/rollout.ts"), patch: "@@ -1 +1,2 @@\n+import { LaunchDarkly } from 'ld';\n" },
    ],
  },
  { name: "new code file", files: [{ ...f("src/service/limiter.py"), status: "added" }] },
  { name: "renamed code file", files: [{ ...f("src/service/limiter.py"), status: "renamed" }] },
  { name: "new test file", files: [{ ...f("tests/test_new.py"), status: "added" }] },
  {
    name: "cross-cutting diff",
    files: ["a", "b", "c", "d"].map((n) => ({ ...f(`src/${n}.py`), status: "modified" })),
  },
  { name: "large code diff", files: [{ ...f("src/big.py"), additions: 140, deletions: 15 }] },
  { name: "large test diff", files: [{ ...f("tests/test_big.py"), additions: 300, deletions: 0 }] },
  {
    name: "deep indent patch",
    files: [{ ...f("src/deep.py"), patch: `@@ -1 +1,2 @@\n+${" ".repeat(20)}return x\n pass` }],
  },
  {
    name: "branchy patch",
    files: [
      {
        ...f("src/branchy.py"),
        patch: `@@ -1 +1,10 @@\n${Array.from({ length: 5 }, (_, i) => `+    if x == ${i}:`).join("\n+        pass\n")}`,
      },
    ],
  },
  {
    name: "backend-only generic dirs",
    files: [f("src/api/routes.py"), f("src/views/user.py"), f("src/controllers/x.py")],
  },
  { name: "models without migration", files: [f("src/models.py"), f("app/models/user.py")] },
  { name: "deploy docs", files: [f("docs/deployment_notes.md")] },
  {
    name: "notification content dirs",
    files: [f("src/notifications/send.py"), f("src/email/render.py")],
  },
  { name: "docs under api dir", files: [f("docs/api/readme.md")] },
  { name: "internal-only utils", files: [f("src/utils/text.py"), f("docs/notes.md")] },
  { name: "substantive body", files: [f("app/service.py", 40, 3)], body: BODY },
  { name: "thin body", files: [f("app/service.py", 40, 3)], body: "fixes the bug" },
  {
    name: "realistic django PR",
    files: [
      f("app/serializers/user.py", 60, 10),
      f("project/settings_prod.py", 3, 1),
      f("app/migrations/0042_add_col.py", 20, 0),
      f("tests/test_user.py", 80, 5),
    ],
    body: BODY,
  },
  {
    name: "realistic frontend PR",
    files: [
      f("frontend/App.tsx", 90, 12),
      f("frontend/api.ts", 30, 2),
      f("package-lock.json", 400, 380),
    ],
  },
  {
    name: "realistic worker PR",
    files: [
      {
        ...f("app/tasks/sync.py", 120, 40),
        patch: "@@ -1 +1,3 @@\n+@background_decorator\n+def sync():\n pass",
      },
      f("app/management/commands/resync.py", 30, 0),
    ],
  },
];

describe("equivalence: quickchat heuristics.toml == the pre-lift compiled-in selection", () => {
  it.skipIf(!HAS_QC)(
    "matches the frozen legacy selection EXACTLY (lenses and order) over the corpus",
    () => {
      for (const c of CORPUS) {
        const intent = c.body !== undefined ? { body: c.body } : undefined;
        expect(selectLenses(c.files, intent, QC, LEGACY_TUNING), c.name).toEqual(
          legacySelectLenses(c.files, intent),
        );
      }
    },
  );

  it("with no extension (minimal profile), only the generic core fires — never more than legacy", () => {
    for (const c of CORPUS) {
      const intent = c.body !== undefined ? { body: c.body } : undefined;
      const bare = selectLenses(c.files, intent, undefined, LEGACY_TUNING);
      const legacy = legacySelectLenses(c.files, intent);
      for (const lens of bare) expect(legacy, `${c.name}: ${lens}`).toContain(lens);
      // Explicit third-arg EMPTY_HEURISTICS is byte-identical to omitting it.
      expect(selectLenses(c.files, intent, EMPTY_HEURISTICS, LEGACY_TUNING), c.name).toEqual(bare);
    }
  });

  it("the minimal profile really is the empty extension", () => {
    expect(loadProfileHeuristics(sandbox, "minimal")).toEqual({ paths: {}, addedLines: {} });
    expect(loadProfileHeuristics(sandbox, "")).toEqual({ paths: {}, addedLines: {} });
  });

  it.skipIf(!HAS_QC)("the quickchat extension touches only profile-extendable lenses", () => {
    for (const lens of [...Object.keys(QC.paths), ...Object.keys(QC.addedLines)]) {
      expect(PROFILE_EXTENDABLE_LENSES, lens).toContain(lens);
    }
    // And it is non-empty — the moved predicates really live there.
    expect(Object.keys(QC.paths).length + Object.keys(QC.addedLines).length).toBeGreaterThan(0);
  });
});
