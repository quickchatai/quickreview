// Review-quality addenda: a no-budget line for every lens, a narrowed
// behaviour-delta trigger, a deterministic loosened-assertion hint for
// pass-tests, the repeated-copy design finding and the regression-test
// request. PR builds only; no benchmark names in prompts.
import { describe, expect, it } from "vitest";
import { addendaForPass, PASS_ADDENDA } from "../src/include.js";

const NO_BENCHMARK_NAMES =
  /qodo|martian|swe-?prbench|aacr|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|metaflow|spyder|cal\.com|keycloak|sentry|grafana|discourse|freecad|clickhouse|dbeaver|ollama|lvgl|electron|immich|ragflow|filament|kestra|browser-use|cherry/i;
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;
const ids = (p: string, mode: "pr" | "scan" = "pr") =>
  addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

describe("no budget", () => {
  it("binds every lens in PR builds, not the validator, not scans", () => {
    for (const p of [
      "pass-baseline",
      "pass-sweep",
      "pass-behaviour-delta",
      "pass-tests",
      "pass-security",
      "pass-style",
    ])
      expect(ids(p), p).toContain("no-budget");
    expect(ids("pass-validate")).not.toContain("no-budget");
    expect(ids("pass-baseline", "scan")).not.toContain("no-budget");
  });
  it("says there is no budget and to report every real issue — and nothing more", () => {
    const t = text("no-budget");
    expect(t).toMatch(/No token, time or finding budget/);
    expect(t).toMatch(/Report every real issue/);
    expect(t).not.toMatch(/per hunk|enumerate|checked:/i);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("repeated copies the PR adds", () => {
  it("binds duplication, baseline and sweep, with a validator half", () => {
    for (const p of ["pass-duplication", "pass-baseline", "pass-sweep"])
      expect(ids(p), p).toContain("repeated-copy");
    expect(ids("pass-validate")).toContain("repeated-copy-validate");
    expect(ids("pass-security")).not.toContain("repeated-copy");
  });
  it("is one P2 finding naming every site; a question when no abstraction is obvious; never taste", () => {
    const t = text("repeated-copy");
    expect(t).toMatch(/three or more near-identical copies/);
    expect(t).toMatch(/names every site/);
    expect(t).toMatch(/Cap it at `P2`/);
    expect(t).toMatch(/\[question\]/);
    expect(t).toMatch(/base already had are not/);
    const v = text("repeated-copy-validate");
    expect(v).toMatch(/design preference/);
    expect(v).toMatch(/do not demand a regression/);
    for (const x of [t, v]) expect(x).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("regression-test request on a bug fix", () => {
  it("binds pass-tests, with a validator half, PR builds only", () => {
    expect(ids("pass-tests")).toContain("regression-test-ask");
    expect(ids("pass-validate")).toContain("regression-test-ask-validate");
    expect(ids("pass-baseline")).not.toContain("regression-test-ask");
    expect(ids("pass-tests", "scan")).not.toContain("regression-test-ask");
  });
  it("asks once, as a question or nit naming the fixed path; never on refactors or features", () => {
    const t = text("regression-test-ask");
    expect(t).toMatch(/says it FIXES a bug/);
    expect(t).toMatch(/naming the function or branch/);
    expect(t).toMatch(/Not on refactors, features/);
    const v = text("regression-test-ask-validate");
    expect(v).toMatch(/Kill it only when such a test exists/);
    for (const x of [t, v]) expect(x).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

import { behaviourDeltaGroups, behaviourDeltaRisk, type PrFile } from "../src/heuristics.js";

const file = (patch: string | undefined, extra: Partial<PrFile> = {}): PrFile =>
  ({
    filename: "src/a.py",
    additions: 3,
    deletions: 3,
    status: "modified",
    patch,
    ...extra,
  }) as PrFile;

describe("behaviour-delta is planned only where base behaviour is at risk", () => {
  it("a removed or replaced guard, predicate, call, return or value is at risk", () => {
    expect(behaviourDeltaRisk(file("@@ -1,2 +1,2 @@\n-    if x is None:\n+    if x:\n"))).toBe(
      true,
    );
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-    return cache.get(k)\n+    return k\n"))).toBe(
      true,
    );
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-    timeout = 30\n+    timeout = 300\n"))).toBe(
      true,
    );
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-    a && b\n+    a\n"))).toBe(true);
  });
  it("existing code wrapped in a NEW branch is at risk (a rewrapped guard, a value changed in a new else)", () => {
    expect(
      behaviourDeltaRisk(
        file(
          "@@ -1,2 +1,4 @@\n-    run()\n+    if enabled:\n+        run()\n+    else:\n+        skip()\n",
        ),
      ),
    ).toBe(true);
  });
  it("a statement moved to another position at the same indent is a reorder, and at risk", () => {
    expect(
      behaviourDeltaRisk(
        file(
          "@@ -1,3 +1,3 @@\n-        state.mark_done(x)\n         propagate(x)\n+        state.mark_done(x)\n",
        ),
      ),
    ).toBe(true);
  });
  it("comments, imports, log lines, blank lines and re-indented copies are not", () => {
    expect(behaviourDeltaRisk(file("@@ -1,2 +1,2 @@\n-# old note\n+# new note\n"))).toBe(false);
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-import os\n+import sys\n"))).toBe(false);
    expect(
      behaviourDeltaRisk(
        file('@@ -1 +1 @@\n-    logger.info("start %s", x)\n+    logger.info("starting %s", x)\n'),
      ),
    ).toBe(false);
    expect(
      behaviourDeltaRisk(
        file("@@ -1,2 +3,2 @@\n-    if ok:\n-        go()\n+        if ok:\n+            go()\n"),
      ),
    ).toBe(false); // re-indented, same text
    expect(behaviourDeltaRisk(file("@@ -1,2 +1,3 @@\n     keep()\n+    added()\n"))).toBe(false); // pure addition
  });
  it("no patch, or a deleted file, is never read as no risk", () => {
    expect(behaviourDeltaRisk(file(undefined))).toBe(true);
    expect(behaviourDeltaRisk(file("", {}))).toBe(true);
    expect(behaviourDeltaRisk(file("@@ -1 +0,0 @@\n-x = 1\n", { status: "removed" }))).toBe(true);
  });
  it("the groups keep only at-risk files", () => {
    const files: PrFile[] = [
      {
        filename: "src/a.py",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch: "@@ -1 +1 @@\n-    return 1\n+    return 2\n",
      },
      {
        filename: "src/b.py",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch: "@@ -1 +1 @@\n-# x\n+# y\n",
      },
    ];
    expect(behaviourDeltaGroups(files, 3, 500)).toEqual({ groups: [["src/a.py"]], unread: [] });
  });
});

import { readFileSync as readFile } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { detectLoosenedAssertions, loosenedReason } from "../src/loosenedtests.js";
import type { PrFileEntry } from "../src/github.js";

const t = (filename: string, patch: string): PrFile => ({
  filename,
  additions: 1,
  deletions: 1,
  status: "modified",
  patch,
});

describe("the loosened-test hint", () => {
  it("finds an exact check turned into a bound — with or without an assert keyword", () => {
    const hits = detectLoosenedAssertions([
      t(
        "tests/test_pool.py",
        '@@ -70,3 +70,3 @@\n         "SlotsAcquired",\n-        lambda x: x == 100,\n+        lambda x: x >= 1 and x <= 100,\n',
      ),
    ]);
    expect(hits).toEqual([{ file: "tests/test_pool.py", line: 71, kind: "exact-to-bound" }]);
  });
  it("finds a lower bound lowered and an upper bound raised", () => {
    expect(
      detectLoosenedAssertions([
        t(
          "tests/q.sql",
          "@@ -11 +11 @@\n-select length(ids) >= 16 from log;\n+select length(ids) >= 1 from log;\n",
        ),
      ]),
    ).toEqual([{ file: "tests/q.sql", line: 11, kind: "bound-relaxed" }]);
    expect(
      detectLoosenedAssertions([
        t(
          "src/a.test.ts",
          "@@ -5 +5 @@\n-  expect(ms).toBeLessThan(50);\n+  expect(ms).toBeLessThan(500);\n",
        ),
      ]).map((h) => h.kind),
    ).toEqual(["bound-relaxed"]);
  });
  it("finds a tolerance widened, a timeout lengthened and a count lowered", () => {
    const kinds = detectLoosenedAssertions([
      t(
        "tests/test_m.py",
        "@@ -1,3 +1,3 @@\n-    assert abs(a - b) < tol(1e-6)\n+    assert abs(a - b) < tol(1e-3)\n-    wait_for(done, timeout=5)\n+    wait_for(done, timeout=60)\n-    assert len(rows) == 10\n+    assert len(rows) == 3\n",
      ),
    ]).map((h) => h.kind);
    expect(kinds).toEqual(["tolerance-widened", "timeout-lengthened", "count-lowered"]);
  });
  it("finds an exact check turned into contains, an assert removed or commented out, and a skip added", () => {
    const kinds = detectLoosenedAssertions([
      t(
        "tests/test_x.py",
        '@@ -1,2 +1,2 @@\n-    assert msg == "exact"\n+    assert "exa" in msg\n',
      ),
      t("tests/test_y.py", "@@ -1,2 +1,1 @@\n     run()\n-    assert state.ok\n"),
      t("tests/test_z.py", "@@ -1 +1 @@\n-    assert state.ok\n+    # assert state.ok\n"),
      t("tests/test_w.py", '@@ -1 +1,2 @@\n+@pytest.mark.skip(reason="flaky")\n def test_w():\n'),
    ]).map((h) => h.kind);
    expect(kinds).toEqual([
      "exact-to-contains",
      "assert-removed",
      "assert-commented",
      "skip-added",
    ]);
  });
  it("ignores production files, tightened checks and unchanged text", () => {
    expect(
      detectLoosenedAssertions([
        t("src/pool.py", "@@ -1 +1 @@\n-    assert x == 1\n+    assert x >= 1\n"),
      ]),
    ).toEqual([]);
    expect(
      detectLoosenedAssertions([
        t("tests/test_a.py", "@@ -1 +1 @@\n-    assert n >= 1\n+    assert n >= 5\n"),
      ]),
    ).toEqual([]);
    expect(
      detectLoosenedAssertions([
        t("tests/test_a.py", "@@ -1 +1 @@\n-    assert n == 1\n+    assert n == 1  # same\n"),
      ]),
    ).toEqual([]);
  });

  const cfg = (): Config =>
    parseConfig(readFile(resolvePath("tests/fixtures/config.toml"), "utf8"));
  const weakened = [
    {
      filename: "tests/test_pool.py",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: "@@ -70 +70 @@\n-        lambda x: x == 100,\n+        lambda x: x >= 1,\n",
    },
  ] as unknown as PrFileEntry[];
  it("hands the hits to pass-tests' plan reason, and their presence plans it", () => {
    const { pass_plan } = buildPassPlan(cfg(), weakened);
    const row = pass_plan.find((r) => r.lens === "pass-tests");
    expect(row?.why).toMatch(
      /weaken existing test assertions — tests\/test_pool\.py:70 \(an exact check became a bound\)/,
    );
    expect(row?.why).toMatch(/report THAT change at the production line/);
  });
  it("the knob turns the hint off: the reason is the old one", () => {
    const c = cfg();
    c.review.loosened_test_hint = false;
    const row = buildPassPlan(c, weakened).pass_plan.find((r) => r.lens === "pass-tests");
    expect(row?.why ?? "").not.toMatch(/weaken/);
  });
  it("names at most twelve sites in the reason", () => {
    const hits = Array.from({ length: 15 }, (_, i) => ({
      file: "tests/t.py",
      line: i + 1,
      kind: "assert-removed" as const,
    }));
    expect(loosenedReason(hits)).toMatch(/and 3 more/);
  });
});

import { applyConfigOverrides } from "../src/bench/runner.js";

describe("the decisions-validation plans", () => {
  const plan = (n: string) =>
    JSON.parse(readFile(resolvePath(`bench/aacr/plans/${n}.json`), "utf8"));
  it("arm B differs from arm A only by the three lenses pinned to the high tier, on the same image and PRs", () => {
    const a = plan("decisions-validation");
    const b = plan("decisions-validation-hi");
    expect(b.image).toBe(a.image);
    expect(b.sets).toEqual(a.sets);
    expect(b.prefix).not.toBe(a.prefix);
    expect(b.config.startsWith(a.config + ",")).toBe(true);
    expect(
      b.config
        .slice(a.config.length + 1)
        .split(",")
        .sort(),
    ).toEqual([
      "models.pass_tiers.pass-baseline=sol-high",
      "models.pass_tiers.pass-behaviour-delta=sol-high",
      "models.pass_tiers.pass-sweep=sol-high",
    ]);
  });
  it("arm B's --config is accepted and pins exactly those lenses at the high-effort tier", () => {
    const b = plan("decisions-validation-hi");
    const base = parseConfig(readFile(resolvePath("tests/fixtures/config.toml"), "utf8"));
    const c = applyConfigOverrides(base, b.config);
    expect(c.models.pass_tiers).toEqual({
      "pass-baseline": "sol-high",
      "pass-sweep": "sol-high",
      "pass-behaviour-delta": "sol-high",
    });
    expect(c.models.tiers["sol-high"]).toMatch(/:high$/);
    const { pass_plan } = buildPassPlan(c, [
      {
        filename: "src/a.py",
        status: "modified",
        additions: 3,
        deletions: 2,
        changes: 5,
        patch: "@@ -1 +1 @@\n-    return 1\n+    return 2\n",
      },
    ] as unknown as PrFileEntry[]);
    for (const r of pass_plan.filter((r) =>
      ["pass-baseline", "pass-sweep", "pass-behaviour-delta"].includes(r.lens),
    ))
      expect(r.tier, r.lens).toBe("sol-high");
  });
  it("uses no held-out set", () => {
    for (const n of ["decisions-validation", "decisions-validation-hi"])
      for (const s of plan(n).sets) expect(s.set).not.toMatch(/test30|holdout|fresh10/);
  });
});
