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

describe("bench.sh judge: a derived set's key is cut from its parent's", () => {
  const derivedTree = () => {
    const t = tree();
    cpSync(join(B, "derive_defects.py"), join(t.here, "derive_defects.py"));
    mkdirSync(join(t.here, "defects"));
    mkdirSync(join(t.here, "sets"));
    writeFileSync(
      join(t.here, "defects", "parent.json"),
      JSON.stringify({
        set: "parent",
        version: "2",
        method: "m",
        cases: { "o__a@1": { defects: [{ id: "D1" }] }, "o__b@2": { defects: [{ id: "D2" }] } },
      }),
    );
    writeFileSync(
      join(t.here, "sets", "kid.json"),
      JSON.stringify({ name: "kid", defects_from: "parent", cases: [{ instance_id: "o__b@2" }] }),
    );
    return t;
  };

  it("judges on the parent's key cut to the set's cases, from a scratch dir — never written into defects/", () => {
    const t = derivedTree();
    const r = run(t, {}, "judge-report", "--run", "r3", "--set", "kid");
    expect(r.stderr).toContain("kid judged on parent's key cut to its cases");
    const line = lastRun(t.log);
    const src = /type=bind,src=([^,]+),dst=\/opt\/quickreview\/bench\/defects/.exec(line)?.[1];
    expect(src).toBeDefined();
    expect(src).not.toBe(join(t.here, "defects"));
    const key = JSON.parse(readFileSync(join(src!, "kid.json"), "utf8"));
    expect(Object.keys(key.cases)).toEqual(["o__b@2"]);
    expect(key.cases["o__b@2"]).toEqual({ defects: [{ id: "D2" }] });
    expect(key.set).toBe("kid");
    expect(() => readFileSync(join(t.here, "defects", "kid.json"))).toThrow();
  });

  it("a committed defects/<set>.json wins over defects_from", () => {
    const t = derivedTree();
    writeFileSync(join(t.here, "defects", "kid.json"), "{}");
    run(t, {}, "judge-report", "--run", "r3", "--set", "kid");
    expect(lastRun(t.log)).toContain(`type=bind,src=${join(t.here, "defects")},dst=/opt/quickreview/bench/defects`);
  });

  it("a set with no key and no defects_from still refuses", () => {
    const t = derivedTree();
    writeFileSync(join(t.here, "sets", "lone.json"), JSON.stringify({ name: "lone", cases: [] }));
    const r = run(t, {}, "judge-report", "--run", "r3", "--set", "lone");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no ground truth for lone");
  });
});

describe("ext.sh: the judge runs on the ext overlay, not the review image", () => {
  it("start_judge and the Qodo scorer use JIMG, which QCR_EXT_IMAGE does not move", () => {
    const ext = readFileSync(join(B, "ext", "ext.sh"), "utf8");
    expect(ext).toContain('JIMG="${QCR_EXT_JUDGE_IMAGE:-qcr-bench:pi099-ext}"');
    expect(ext).toContain('--entrypoint bash "$JIMG" -c "mkdir -p');
    expect(ext).toMatch(/--entrypoint python3 "\$JIMG" \\\n\s+\/ext\/qodo_judge\.py/);
    expect(ext).not.toMatch(/"\$QIMG"[^\n]*\n[^\n]*ext_judge\.py/);
  });
});
