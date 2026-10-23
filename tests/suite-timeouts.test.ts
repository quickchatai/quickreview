// The suite has to stay green on a loaded machine without hiding a real hang
// (tests/AGENTS.md, "Timeouts under load"). Two budgets, and this file pins
// which test gets which:
//
//   - a test file that spawns real processes (shell scripts, git, tsc, node
//     children, stub binaries) runs in the `spawning` project with
//     PROCESS_TIMEOUT_MS: under load a child's wall time is set by the
//     scheduler, not by the code under test;
//   - everything else keeps vitest's 5s default, so an in-process hang still
//     fails in five seconds. The in-process tests that sweep a large space,
//     import a large module graph mid-test, or drive the whole dispatch pump
//     carry HEAVY_TIMEOUT_MS on the test itself — never on the file.
//
// The static half of "spawns" is checkable, so it is checked here: a test
// file that imports node:child_process and is not in PROCESS_SUITES would run
// on the 5s budget and go red the first time the machine is busy.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";
import { HEAVY_TIMEOUT_MS, PROCESS_SUITES, PROCESS_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");
const TESTS = readdirSync(join(ROOT, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `tests/${f}`);

const IMPORTS_CHILD_PROCESS = /(?:from|import\()\s*["'](?:node:)?child_process["']/;

interface ProjectShape {
  test?: {
    name?: string;
    include?: string[];
    exclude?: string[];
    testTimeout?: number;
    hookTimeout?: number;
  };
}

function projects(): ProjectShape[] {
  const test = (config as { test?: { projects?: unknown[] } }).test;
  return (test?.projects ?? []) as ProjectShape[];
}

describe("which tests get a longer timeout", () => {
  it("every test file that imports child_process runs on the process budget", () => {
    const spawning = TESTS.filter((f) =>
      IMPORTS_CHILD_PROCESS.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(spawning.length).toBeGreaterThan(20);
    const missing = spawning.filter((f) => !PROCESS_SUITES.includes(f));
    expect(missing, "add these to PROCESS_SUITES in tests/helpers/suite-timeouts.ts").toEqual([]);
  });

  it("every PROCESS_SUITES entry is a real test file, listed once", () => {
    // A suite the publish manifest dropped from this tree is absent by design.
    const manifest = JSON.parse(readFileSync(join(ROOT, "publish-manifest.json"), "utf8")) as {
      exclude?: { path: string }[];
      applied_exclusions?: { path: string }[];
    };
    const dropped = new Set(
      [...(manifest.exclude ?? []), ...(manifest.applied_exclusions ?? [])].map((e) => e.path),
    );
    for (const f of PROCESS_SUITES)
      expect(existsSync(join(ROOT, f)) || dropped.has(f), f).toBe(true);
    expect(new Set(PROCESS_SUITES).size).toBe(PROCESS_SUITES.length);
    expect([...PROCESS_SUITES].sort()).toEqual([...PROCESS_SUITES]);
  });

  it("the config runs PROCESS_SUITES on the process budget, first, and nothing else on it", () => {
    // A root `include` would be CONCATENATED onto each project's own by
    // `extends: true` — the process project would collect every file.
    expect((config as { test?: { include?: unknown } }).test?.include).toBeUndefined();
    const ps = projects();
    // In this order, and the order is load-bearing: vitest's BaseSequencer
    // queues whole projects by NAME, and the spawning files are the suite's
    // longest (guards-shell, the typecheck fence, deploy). Named so they sort
    // last, they started after every unit file and set the wall time.
    expect(ps.map((p) => p.test?.name)).toEqual(["spawning", "unit"]);
    expect(["unit", "spawning"].sort()).toEqual(["spawning", "unit"]);
    const proc = ps.find((p) => p.test?.name === "spawning")!.test!;
    expect(proc.include).toEqual([...PROCESS_SUITES]);
    expect(proc.testTimeout).toBe(PROCESS_TIMEOUT_MS);
    expect(proc.hookTimeout).toBe(PROCESS_TIMEOUT_MS);
    const unit = ps.find((p) => p.test?.name === "unit")!.test!;
    expect(unit.include).toEqual(["tests/**/*.test.ts"]);
    expect(unit.exclude).toEqual(expect.arrayContaining([...PROCESS_SUITES]));
  });

  it("in-process tests keep vitest's 5s default — a hang there still fails fast", () => {
    const unit = projects().find((p) => p.test?.name === "unit")!.test!;
    expect(unit.testTimeout).toBeUndefined();
    expect(unit.hookTimeout).toBeUndefined();
    const root = (config as { test?: { testTimeout?: number; hookTimeout?: number } }).test!;
    expect(root.testTimeout).toBeUndefined();
    expect(root.hookTimeout).toBeUndefined();
    // No file-wide escape hatch in an in-process file: a longer budget there
    // is per test, named HEAVY_TIMEOUT_MS, so it stays visible at the test.
    for (const f of TESTS.filter((t) => !PROCESS_SUITES.includes(t))) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/setConfig\(\s*\{[^}]*(testTimeout|hookTimeout)/);
    }
  });

  it("every unit test that drives the whole dispatch pump carries HEAVY_TIMEOUT_MS", () => {
    // dispatchOnce builds a full round order (plan, templates, memory seeding,
    // the pre-check) — ~100ms alone, the heaviest in-process call the suite
    // makes, and under 2x-cores load the one class that still crossed 5s
    // (drain, dispatch, three separate runs). A test that calls it is heavy
    // by construction, so the budget follows the call, not a measurement.
    const bare: string[] = [];
    const self = "tests/suite-timeouts.test.ts"; // names the call in its own title
    for (const f of TESTS.filter((t) => !PROCESS_SUITES.includes(t) && t !== self)) {
      const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)it\(/.exec(lines[i]!);
        if (!m) continue;
        const indent = m[1]!.length;
        let j = i + 1;
        while (
          j < lines.length &&
          !(
            lines[j]!.startsWith(" ".repeat(indent) + "}") &&
            !lines[j]!.startsWith(" ".repeat(indent + 1))
          )
        )
          j++;
        const body = lines.slice(i, j + 1).join("\n");
        // The options sit before the callback's arrow, on the it( line or —
        // once Prettier wraps a long title — on a line of their own.
        const header = body.slice(0, Math.max(0, body.indexOf("=>")));
        if (body.includes("dispatchOnce(") && !/timeout: HEAVY_TIMEOUT_MS/.test(header))
          bare.push(`${f}:${i + 1}`);
        i = j;
      }
    }
    expect(bare, "add { timeout: HEAVY_TIMEOUT_MS } to these tests").toEqual([]);
  });

  it("the budgets are ordered: default < heavy < process", () => {
    expect(5_000).toBeLessThan(HEAVY_TIMEOUT_MS);
    expect(HEAVY_TIMEOUT_MS).toBeLessThanOrEqual(PROCESS_TIMEOUT_MS);
  });
});
