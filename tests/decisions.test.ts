// The owner's 2026-10-03 grilling decisions (gap plan): a no-budget line for
// every lens, a narrowed behaviour-delta trigger, a deterministic
// loosened-assertion hint for pass-tests, the repeated-copy design finding and
// the regression-test request. PR builds only; no benchmark names in prompts.
import { describe, expect, it } from "vitest";
import { addendaForPass, PASS_ADDENDA } from "../src/include.js";

const NO_BENCHMARK_NAMES =
  /qodo|martian|swe-?prbench|aacr|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|metaflow|spyder|cal\.com|keycloak|sentry|grafana|discourse|freecad|clickhouse|dbeaver|ollama|lvgl|electron|immich|ragflow|filament|kestra|browser-use|cherry/i;
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;
const ids = (p: string, mode: "pr" | "scan" = "pr") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

describe("no budget", () => {
  it("binds every lens in PR builds, not the validator, not scans", () => {
    for (const p of ["pass-baseline", "pass-sweep", "pass-behaviour-delta", "pass-tests", "pass-security", "pass-style"])
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
    for (const p of ["pass-duplication", "pass-baseline", "pass-sweep"]) expect(ids(p), p).toContain("repeated-copy");
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
  ({ filename: "src/a.py", additions: 3, deletions: 3, status: "modified", patch, ...extra }) as PrFile;

describe("behaviour-delta is planned only where base behaviour is at risk", () => {
  it("a removed or replaced guard, predicate, call, return or value is at risk", () => {
    expect(behaviourDeltaRisk(file("@@ -1,2 +1,2 @@\n-    if x is None:\n+    if x:\n"))).toBe(true);
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-    return cache.get(k)\n+    return k\n"))).toBe(true);
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-    timeout = 30\n+    timeout = 300\n"))).toBe(true);
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-    a && b\n+    a\n"))).toBe(true);
  });
  it("existing code wrapped in a NEW branch is at risk (a rewrapped guard, a value changed in a new else)", () => {
    expect(behaviourDeltaRisk(file("@@ -1,2 +1,4 @@\n-    run()\n+    if enabled:\n+        run()\n+    else:\n+        skip()\n"))).toBe(true);
  });
  it("a statement moved to another position at the same indent is a reorder, and at risk", () => {
    expect(behaviourDeltaRisk(file("@@ -1,3 +1,3 @@\n-        state.mark_done(x)\n         propagate(x)\n+        state.mark_done(x)\n"))).toBe(true);
  });
  it("comments, imports, log lines, blank lines and re-indented copies are not", () => {
    expect(behaviourDeltaRisk(file("@@ -1,2 +1,2 @@\n-# old note\n+# new note\n"))).toBe(false);
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-import os\n+import sys\n"))).toBe(false);
    expect(behaviourDeltaRisk(file("@@ -1 +1 @@\n-    logger.info(\"start %s\", x)\n+    logger.info(\"starting %s\", x)\n"))).toBe(false);
    expect(behaviourDeltaRisk(file("@@ -1,2 +3,2 @@\n-    if ok:\n-        go()\n+        if ok:\n+            go()\n"))).toBe(false); // re-indented, same text
    expect(behaviourDeltaRisk(file("@@ -1,2 +1,3 @@\n     keep()\n+    added()\n"))).toBe(false); // pure addition
  });
  it("no patch, or a deleted file, is never read as no risk", () => {
    expect(behaviourDeltaRisk(file(undefined))).toBe(true);
    expect(behaviourDeltaRisk(file("", {}))).toBe(true);
    expect(behaviourDeltaRisk(file("@@ -1 +0,0 @@\n-x = 1\n", { status: "removed" }))).toBe(true);
  });
  it("the groups keep only at-risk files", () => {
    const files: PrFile[] = [
      { filename: "src/a.py", additions: 1, deletions: 1, status: "modified", patch: "@@ -1 +1 @@\n-    return 1\n+    return 2\n" },
      { filename: "src/b.py", additions: 1, deletions: 1, status: "modified", patch: "@@ -1 +1 @@\n-# x\n+# y\n" },
    ];
    expect(behaviourDeltaGroups(files, 3, 500)).toEqual({ groups: [["src/a.py"]], unread: [] });
  });
});
