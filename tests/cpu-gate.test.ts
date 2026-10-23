// P2.11: the offline CPU and RSS gate (scripts/cpu-gate.mjs). The measurement
// itself is run by hand and committed (docs/cpu-gate.md); what is pinned here is
// that the script still works end to end on a tiny run, and that its pass/fail
// verdict follows the limit it is given. The end-to-end cases need a built
// dist/ (the script drives the runtimes from it) and are skipped without one.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  cellProblems,
  lagStats,
  markdownTables,
  parseCpuList,
  percentile,
  startLagSampler,
} from "../scripts/cpu-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "cpu-gate.mjs");
const run = promisify(execFile);

const built = existsSync(
  join(ROOT, "packages", "pi-plugin", "dist", "src", "engine", "sdkruntime.js"),
);
const taskset = existsSync("/usr/bin/taskset") || existsSync("/bin/taskset");

describe("[cpu-gate] cell validity", () => {
  const ok = { offlineViolations: 0, startup: { allStreaming: true }, turnsFinishedBeforeAbort: 0 };
  it("a clean cell has no problems", () => {
    expect(cellProblems(ok)).toEqual([]);
  });
  it("a cell whose sessions finished before the abort measured an idle loop", () => {
    expect(cellProblems({ ...ok, turnsFinishedBeforeAbort: 1 })).toEqual([
      expect.stringContaining("finished before the abort"),
    ]);
  });
});

describe("[cpu-gate] the arithmetic", () => {
  it("percentile is nearest-rank", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.99)).toBe(99);
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile([], 0.99)).toBe(0);
  });

  it("lagStats counts the ticks past 200 ms", () => {
    expect(lagStats([1, 2, 250, 3])).toMatchObject({ n: 4, max: 250, over200: 1 });
  });

  it("parseCpuList reads kernel lists", () => {
    expect(parseCpuList("0,1")).toEqual([0, 1]);
    expect(parseCpuList("0-3,8")).toEqual([0, 1, 2, 3, 8]);
  });

  it("the lag sampler sees a blocked loop", async () => {
    const sampler = startLagSampler();
    sampler.phase("p");
    await new Promise((r) => setTimeout(r, 30));
    const end = Date.now() + 120;
    while (Date.now() < end); // block the loop
    await new Promise((r) => setTimeout(r, 30));
    const p = sampler.stop()["p"] ?? [];
    expect(Math.max(...p)).toBeGreaterThan(80);
  });

  it("the tables name every cell", () => {
    const cell = (mode: string) => ({
      mode,
      sessions: 12,
      startup: { ms: 900, lag: { p99: 5, max: 6 } },
      steady: {
        lag: { p50: 0.2, p99: 3, max: 9, over200: 0 },
        rssMb: 500,
        pssMb: 400,
        processes: 3,
        ourCpuPct: 20,
        pinnedBusyPct: 30,
      },
      abort: { oneMs: [10, 11, 12], allP50Ms: 40, allMaxMs: 50, lagAll: { max: 4 } },
    });
    const md = markdownTables([cell("sdk"), cell("sdk-b")], {
      window: 15,
      warmup: 3,
      cpus: "0,1",
      tps: 100,
      loadavg: "1 1 1",
    });
    expect(md).toContain("| sdk | 12 |");
    expect(md).toContain("| sdk-b | 12 |");
    expect(md).toContain("10 / 11 / 12");
  });
});

describe.skipIf(!built || !taskset)("[cpu-gate] end to end, offline", () => {
  const tiny = ["--sessions", "2", "--window", "2", "--warmup", "1", "--gate-sessions", "2"];

  it("a limit nobody can meet fails the gate", async () => {
    const r = await run("node", [SCRIPT, ...tiny, "--limit-ms", "0"], { cwd: ROOT }).catch(
      (e: { code: number; stdout: string }) => e,
    );
    expect(r).toMatchObject({ code: 1 });
    const out = (r as { stdout: string }).stdout;
    expect(out).toContain("| sdk | 2 |");
    expect(out).toContain("GATE FAIL");
  });

  it("a generous limit passes it", async () => {
    const r = await run("node", [SCRIPT, ...tiny, "--modes", "sdk", "--limit-ms", "100000"], {
      cwd: ROOT,
    });
    expect(r.stdout).toContain("GATE PASS");
  });
});
