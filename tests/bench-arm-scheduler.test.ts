// arm.sh's per-case scheduler against a stub bench.sh: slot sizing, the adaptive
// target, rate-limit and usage-limit handling, memory admission. Split from
// bench-arm-compare.test.ts so the two halves run on separate workers; the
// fixture is tests/helpers/arm-fixture.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { A, B, C, armIn, callsIn, setupArmFixture } from "./helpers/arm-fixture.js";

let t: string;
let runs: string;
beforeEach(() => {
  ({ t, runs } = setupArmFixture());
});
afterEach(() => rmSync(t, { recursive: true, force: true }));

const arm = (args: string[], env: Record<string, string> = {}) => armIn(t, runs, args, env);
const calls = () => callsIn(t);

describe("arm.sh scheduler", () => {
  it("each case runs in its own container, longest PR first, never more than --parallel at once", async () => {
    const one = await arm(["--prefix", "q", "--cases", "full", "--parallel", "1", "--no-judge"]);
    expect(one.code).toBe(0);
    const order = calls()
      .filter((x) => x.includes(" review --phase case "))
      .map((x) => /--only (\S+)/.exec(x)![1]);
    expect(order).toEqual([B, C, A]);
    for (const x of calls().filter((y) => y.includes("--phase case")))
      expect(x).toContain("MEM=3g"); // the per-case container cap, not the old 8g
    rmSync(join(t, "calls.log"));
    rmSync(join(t, "conc.log"));
    const two = await arm(
      ["--prefix", "w", "--cases", "full+fresh10", "--parallel", "2", "--no-judge"],
      {
        STUB_CASE_SLEEP: "0.4",
      },
    );
    expect(two.code).toBe(0);
    const conc = readFileSync(join(t, "conc.log"), "utf8").trim().split("\n").map(Number);
    expect(conc.length).toBe(5); // full's 3 + fresh10's 2, one queue
    expect(Math.max(...conc)).toBe(2);
  });

  it("a case --resume skipped does not hold memory admission", async () => {
    // Room for exactly one growing review: (4000 - 3072) / 768 = 1. Without the
    // fix every skipped case counted as a review started in the last five
    // minutes, so the second launch waited 300 s; the test's own timeout catches that.
    for (const id of [A, B, C]) writeFileSync(join(t, "outcomes", id), "ok 0 0 0 skipped\n");
    const r = await arm(["--prefix", "s", "--cases", "full", "--no-judge"], {
      QCR_BENCH_MEM_AVAILABLE_MB: "4000",
      QCR_BENCH_MAX_PARALLEL: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/3\/3 done \(ok 3, not ok 0\)/);
  }, 20000);

  it("auto sizes the slots from MemAvailable, capped by the login's share", async () => {
    const env = { QCR_BENCH_MEM_AVAILABLE_MB: "7000" }; // (7000 - 3072) / 768 = 5
    expect(
      (await arm(["--prefix", "a", "--cases", `fresh10:${A}`, "--no-judge"], env)).out,
    ).toContain("5 review slot(s) to start — adaptive auto");
    const capped = await arm(["--prefix", "b", "--cases", `fresh10:${A}`, "--no-judge"], {
      ...env,
      QCR_BENCH_MAX_PARALLEL: "2",
    });
    expect(capped.out).toContain("2 review slot(s) — auto");
    expect(capped.out).toContain("fixed cap 2");
    // Plenty of memory: adaptive auto starts at QCR_BENCH_START_PARALLEL, not at what RAM admits.
    const big = await arm(["--prefix", "c", "--cases", `fresh10:${A}`, "--no-judge"], {
      QCR_BENCH_START_PARALLEL: "6",
    });
    expect(big.out).toContain("6 review slot(s) to start");
  });

  // The AIMD target (bench/aacr/PERF.md): a full pool with work waiting and no
  // pushback steps up; a rate-limited case halves it; the plan's usage limit
  // stops every launch. Stub cases sleep so the pool is observably full.
  const conc = () => readFileSync(join(t, "conc.log"), "utf8").trim().split("\n").map(Number);
  const adaptive = {
    QCR_BENCH_START_PARALLEL: "1",
    QCR_BENCH_RAMP_SECS: "0",
    QCR_BENCH_RAMP_STEP: "1",
    QCR_BENCH_PARALLEL_CEILING: "2",
    STUB_CASE_SLEEP: "0.5",
  };

  it("adaptive auto steps up while every slot is busy and cases wait, never past the ceiling", async () => {
    const r = await arm(["--prefix", "g", "--cases", "full+fresh10", "--no-judge"], adaptive);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 review slot(s) to start");
    expect(r.out).toMatch(
      /concurrency 1 -> 2, no rate limit for 0s, every slot busy, cases waiting/,
    );
    expect(r.out).not.toContain("-> 3");
    expect(Math.max(...conc())).toBe(2);
    expect(readFileSync(join(runs, ".slots", "concurrency.log"), "utf8")).toContain("1 -> 2");
  });

  it("a fixed cap never ramps: --parallel N, or QCR_BENCH_MAX_PARALLEL set", async () => {
    const fixed = await arm(
      ["--prefix", "h", "--cases", "full", "--parallel", "1", "--no-judge"],
      adaptive,
    );
    expect(fixed.out).not.toContain("concurrency ");
    expect(Math.max(...conc())).toBe(1);
    rmSync(join(t, "conc.log"));
    const capped = await arm(["--prefix", "i", "--cases", "full", "--no-judge"], {
      ...adaptive,
      QCR_BENCH_MAX_PARALLEL: "1",
    });
    expect(capped.out).not.toContain("concurrency ");
    expect(Math.max(...conc())).toBe(1);
  });

  it("a rate-limited case halves the target once per burst, pauses, and is retried", async () => {
    writeFileSync(join(t, "outcomes", A), "no-verdict 1 3\nok 0 0\n");
    const r = await arm(["--prefix", "j", "--cases", "fresh10", "--no-judge"], {
      QCR_BENCH_START_PARALLEL: "4",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`concurrency 4 -> 2, rate-limited case ${A}`);
    expect(r.out).toContain(`${A}: RATE-LIMITED (3 model error(s))`);
    expect(readFileSync(join(runs, ".slots", "target"), "utf8").trim()).toBe("2");
    expect(existsSync(join(runs, ".slots", "last-limit"))).toBe(true);
  });

  it("the plan's usage limit stops every launch, loudly, and is never retried", async () => {
    // B (the longest) runs first and hits the usage window; A must never start.
    writeFileSync(join(t, "outcomes", B), "no-verdict 1 2 2\n");
    const r = await arm(["--prefix", "k", "--cases", "fresh10", "--parallel", "1", "--no-judge"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${B}: USAGE LIMIT of the model login reached (2 call(s) refused)`);
    const reviewed = calls()
      .filter((x) => x.includes(" review --phase case "))
      .map((x) => /--only (\S+)/.exec(x)![1]);
    expect(reviewed).toEqual([B]);
    expect(readFileSync(join(runs, ".slots", "usage-limit"), "utf8")).toContain(B);
    // A later arm on the same machine is not stopped by an OLD marker.
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(runs, ".slots", "usage-limit"), old, old);
    const later = await arm(["--prefix", "l", "--cases", `fresh10:${A}`, "--no-judge"]);
    expect(later.code).toBe(0);
  });

  it("a target left by a finished arm is not adopted: a new arm starts from its own value", async () => {
    mkdirSync(join(runs, ".slots"), { recursive: true });
    writeFileSync(join(runs, ".slots", "target"), "17\n");
    const r = await arm(["--prefix", "m", "--cases", `fresh10:${A}`, "--no-judge"], {
      QCR_BENCH_START_PARALLEL: "3",
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("adopting");
    expect(r.out).toContain("3 at once (adaptive, ceiling 24)");
    expect(readFileSync(join(runs, ".slots", "target"), "utf8").trim()).toBe("3");
  });

  it("a rate-limited case pauses the queue and is retried; an unfetchable one is not", async () => {
    writeFileSync(join(t, "outcomes", A), "no-verdict 1 3\nok 0 0\n");
    writeFileSync(join(t, "outcomes", B), "failed 0 0\n");
    const r = await arm(["--prefix", "x", "--cases", "fresh10", "--parallel", "1", "--no-judge"]);
    expect(r.code).toBe(1); // B never reviewed
    const reviewed = calls()
      .filter((x) => x.includes(" review --phase case "))
      .map((x) => /--only (\S+)/.exec(x)![1]);
    expect(reviewed.filter((x) => x === A).length).toBe(2);
    expect(reviewed.filter((x) => x === B).length).toBe(1);
    expect(r.out).toContain(`${A}: RATE-LIMITED (3 model error(s))`);
    expect(r.out).toContain(`${B}: failed — not retried`);
    expect(r.out).toContain("1/2 ok");
    // The review log is the cases' own output, appended as each finishes.
    expect(readFileSync(join(runs, "x-fresh10.review.log"), "utf8")).toContain(`result: ${A} ok`);
  });
});
