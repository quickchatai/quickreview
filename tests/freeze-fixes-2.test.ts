// Freeze fixes 2 (2026-10-03): the cross-benchmark miss analysis — general
// bug-class rules, PR builds only, no benchmark names in any prompt text.
import { describe, expect, it } from "vitest";
import { addendaForPass, PASS_ADDENDA } from "../src/include.js";

const NO_BENCHMARK_NAMES =
  /qodo|martian|swe-?prbench|aacr|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|spyder|cal\.com|keycloak|sentry|grafana|discourse|freecad|clickhouse|dbeaver|ollama|lvgl|electron|immich|ragflow|filament/i;
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;
const ids = (p: string, mode: "pr" | "scan" = "pr") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

describe("exhaust the site", () => {
  it("binds baseline, sweep, widened and behaviour-delta, PR builds only", () => {
    for (const p of ["pass-baseline", "pass-sweep", "pass-widened", "pass-behaviour-delta"])
      expect(ids(p), p).toContain("exhaust-the-site");
    expect(ids("pass-security")).not.toContain("exhaust-the-site");
    expect(ids("pass-baseline", "scan")).not.toContain("exhaust-the-site");
  });
  it("names siblings, twins, every consequence and the other failures, one finding per fix", () => {
    const t = text("exhaust-the-site");
    expect(t).toMatch(/Siblings of the same shape/);
    expect(t).toMatch(/The twin/);
    expect(t).toMatch(/Every consequence/);
    expect(t).toMatch(/other calls in that loop/);
    expect(t).toMatch(/needs its OWN fix as its own finding/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { behaviourDeltaGroups, BEHAVIOUR_DELTA_PASS } from "../src/heuristics.js";
import type { PrFileEntry } from "../src/github.js";

const cfg = (): Config => parseConfig(readFileSync(resolve("tests/fixtures/config.toml"), "utf8"));
const f = (filename: string, additions: number, deletions: number, status = "modified") =>
  ({ filename, additions, deletions, changes: additions + deletions, status }) as unknown as PrFileEntry;

describe("pass-behaviour-delta", () => {
  it("groups only non-test code that modifies or deletes lines, packed by changed lines", () => {
    const files = [
      f("src/a.py", 10, 4),
      f("src/new.py", 80, 0, "added"), // pure addition: not this lens's
      f("tests/test_a.py", 5, 5), // a test: not this lens's
      f("README.md", 3, 3), // prose: not this lens's
      f("src/gone.go", 0, 40, "removed"), // a deleted file IS a behaviour change
      f("src/big.ts", 300, 300),
    ];
    const { groups, unread } = behaviourDeltaGroups(files, 3, 500);
    expect(groups).toEqual([["src/a.py", "src/gone.go"], ["src/big.ts"]]);
    expect(unread).toEqual([]);
    expect(behaviourDeltaGroups(files, 1, 500)).toEqual({ groups: [["src/a.py", "src/gone.go"]], unread: ["src/big.ts"] });
  });

  it("is planned before the validator with focus files and a reason, and the knob turns it off", () => {
    const c = cfg();
    const files = [f("src/a.py", 10, 4)];
    const { pass_plan } = buildPassPlan(c, files);
    const rows = pass_plan.filter((r) => r.lens === BEHAVIOUR_DELTA_PASS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.focus).toEqual(["src/a.py"]);
    expect(rows[0]!.why).toMatch(/modifies or deletes existing code/);
    expect(pass_plan.at(-1)!.lens).toBe("pass-validate");
    const off = structuredClone(c);
    off.review = { ...off.review, behaviour_delta: false };
    expect(buildPassPlan(off, files).pass_plan.some((r) => r.lens === BEHAVIOUR_DELTA_PASS)).toBe(false);
    // A pure addition plans no behaviour-delta row.
    expect(buildPassPlan(c, [f("src/new.py", 50, 0, "added")]).pass_plan.some((r) => r.lens === BEHAVIOUR_DELTA_PASS)).toBe(false);
  });

  it("its brief enumerates every modifying hunk, covers removed guards, defaults to a question, names no benchmark", () => {
    const body = readFileSync(resolve("agents/pass-behaviour-delta.md"), "utf8");
    expect(body).toMatch(/Enumerate\. Write ONE line in your notes for EVERY hunk/);
    expect(body).toMatch(/a removed or weakened guard/);
    expect(body).toMatch(/Default to a `question`/);
    expect(body).toMatch(/states as its intent is not a finding/);
    expect(body).not.toMatch(NO_BENCHMARK_NAMES);
  });
});
