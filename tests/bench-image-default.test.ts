// bench.sh scoring a stored run with no image named uses the image the run was
// reviewed on (arm.sh's <run>.arm.json), not qcr-bench:latest — 2026-10-03,
// `judge` on r7-dedup5-aacr failed "no image qcr-bench:latest".
import { describe, expect, it } from "vitest";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const B = join(import.meta.dirname, "..", "bench", "aacr");

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), "bench-img-"));
  const here = join(tmp, "repo", "bench", "aacr");
  mkdirSync(here, { recursive: true });
  cpSync(join(B, "bench.sh"), join(here, "bench.sh"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const log = join(tmp, "docker.log");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const runs = join(tmp, "runs");
  mkdirSync(join(runs, "r3"), { recursive: true });
  writeFileSync(join(runs, "r3.arm.json"), JSON.stringify({ arm: "qcr", image: "qcr-bench:r9" }));
  return { here, bin, log, runs };
}

const run = (t: ReturnType<typeof tree>, env: Record<string, string>, ...args: string[]) =>
  spawnSync("bash", [join(t.here, "bench.sh"), ...args], {
    env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}`, QCR_BENCH_RUNS_DIR: t.runs, ...env },
    encoding: "utf8",
  });
const lastRun = (log: string) =>
  readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("run ")).at(-1) ?? "";

describe("bench.sh: scoring defaults to the run's recorded image", () => {
  it("eval on a run arm.sh recorded uses that run's image", () => {
    const t = tree();
    run(t, {}, "eval", "--run", "r3", "--set", "fresh10", "--judge", "mock");
    expect(lastRun(t.log)).toContain("qcr-bench:r9 eval fresh10 mock");
  });

  it("an explicit QCR_BENCH_IMAGE still wins", () => {
    const t = tree();
    run(t, { QCR_BENCH_IMAGE: "qcr-bench:x" }, "eval", "--run", "r3", "--set", "fresh10", "--judge", "mock");
    expect(lastRun(t.log)).toContain("qcr-bench:x eval fresh10 mock");
  });

  it("a run with no record keeps the :latest default", () => {
    const t = tree();
    run(t, {}, "eval", "--run", "other", "--set", "fresh10", "--judge", "mock");
    expect(lastRun(t.log)).toContain("qcr-bench:latest eval fresh10 mock");
  });
});
