// bench/aacr/rerun-all.sh — one plan, one arm, each set on its own scorer —
// against stub arm.sh / bench.sh / ext.sh / docker. Nothing real runs.
import { describe, expect, it } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const B = join(import.meta.dirname, "..", "bench", "aacr");
const HEAD = "a".repeat(40);

function tree(label = HEAD) {
  const tmp = mkdtempSync(join(tmpdir(), "rerun-"));
  const here = join(tmp, "repo", "bench", "aacr");
  mkdirSync(join(here, "sets"), { recursive: true });
  mkdirSync(join(here, "ext"), { recursive: true });
  for (const f of ["rerun-all.sh", "rerun_plan.py", "dup_stats.py", "lens_yield.py"]) cpSync(join(B, f), join(here, f));
  writeFileSync(join(here, "ext", "RUNS.md"), "| Run | Kind | Cases ok | Score |\n|---|---|---|---|\n");
  const set = (name: string, ids: string[]) =>
    writeFileSync(join(here, "sets", `${name}.json`), JSON.stringify({ name, cases: ids.map((instance_id) => ({ instance_id })) }));
  set("qa", ["o__a@1", "o__b@2"]);
  set("ma", ["o__c@3"]);
  set("qa-rep", ["o__a@1"]);
  const runs = join(tmp, "runs");
  mkdirSync(runs);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const calls = join(tmp, "calls.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // arm.sh: writes one result per case of every set into <prefix>-<set>.
  stub(
    "arm.sh",
    `prefix=""; cases=""; while (($#)); do case "$1" in --prefix) prefix="$2"; shift 2;; --cases) cases="$2"; shift 2;; *) shift;; esac; done
for s in \${cases//+/ }; do d="$QCR_BENCH_RUNS_DIR/$prefix-$s/results/all"; mkdir -p "$d"
  for id in $(python3 -c 'import json,sys; print(" ".join(c["instance_id"] for c in json.load(open(sys.argv[1]))["cases"]))' "${here}/sets/$s.json"); do echo '{}' > "$d/$id.json"; done; done`,
  );
  stub("bench.sh", "");
  stub("ext.sh", "");
  stub("docker", `echo "QCR_BENCH_COMMIT=${label}"`);
  stub("systemd-inhibit", 'while [[ "$1" == --* ]]; do shift; done; exec "$@"');
  const plan = join(tmp, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      name: "t",
      image: "qcr-bench:t",
      prefix: "p",
      config: "models.default=x",
      sets: [
        { set: "qa", scorer: "qodo" },
        { set: "ma", scorer: "martian" },
        { set: "qa-rep", scorer: "aacr", repeat_of: "qa" },
      ],
    }),
  );
  return { here, runs, bin, calls, plan, tmp };
}

const go = (t: ReturnType<typeof tree>, ...args: string[]) =>
  spawnSync("bash", [join(t.here, "rerun-all.sh"), t.plan, ...args], {
    env: {
      ...process.env,
      PATH: `${t.bin}:${process.env.PATH}`,
      QCR_BENCH_RUNS_DIR: t.runs,
      QCR_RERUN_ARM: join(t.bin, "arm.sh"),
      QCR_RERUN_BENCH: join(t.bin, "bench.sh"),
      QCR_RERUN_EXT: join(t.bin, "ext.sh"),
      QCR_RERUN_SKIP_BUILD: "1",
      QCR_RERUN_HEAD: HEAD,
    },
    encoding: "utf8",
  });
const calls = (t: ReturnType<typeof tree>) =>
  existsSync(t.calls) ? readFileSync(t.calls, "utf8").trim().split("\n") : [];

describe("rerun-all.sh", () => {
  it("without --go prints the plan and the estimate and runs nothing", () => {
    const t = tree();
    const r = go(t);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("plan t: image qcr-bench:t, run prefix p");
    expect(r.stdout).toMatch(/total: 4 reviews, about \$\d+/);
    expect(r.stdout).toContain("nothing run — pass --go");
    expect(calls(t)).toEqual([]);
  });

  it("with --go: one arm over every set, then each set on its own scorer, and a RUNS.md row per set", () => {
    const t = tree();
    const r = go(t, "--go");
    expect(r.status, r.stderr).toBe(0);
    const c = calls(t);
    const arms = c.filter((l) => l.startsWith("arm.sh "));
    expect(arms).toHaveLength(1);
    expect(arms[0]).toContain("--prefix p --config models.default=x --cases qa+ma+qa-rep --no-judge --parallel auto");
    expect(c).toContain("ext.sh qodo p-qa qa --only-tools quickreview");
    expect(c).toContain("ext.sh martian p-ma ma");
    expect(c).toContain("bench.sh judge --run p-qa-rep --set qa-rep");
    const runs = readFileSync(join(t.here, "ext", "RUNS.md"), "utf8");
    expect(runs).toContain("| p-qa | rerun-all t, qodo, image qcr-bench:t @ aaaaaaa | 2/2 |");
    expect(runs).toContain("| p-qa-rep | rerun-all t, aacr, image qcr-bench:t @ aaaaaaa | 1/1 |");
    expect(existsSync(join(t.runs, "rerun-t", "dup_stats.md"))).toBe(true);
  });

  it("refuses an image whose label is not HEAD, before any review", () => {
    const t = tree("b".repeat(40));
    const r = go(t, "--go");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not HEAD");
    expect(calls(t).filter((l) => l.startsWith("arm.sh "))).toEqual([]);
  });

  it("refuses a plan whose repeat set is not a subset of the set it repeats", () => {
    const t = tree();
    writeFileSync(join(t.here, "sets", "qa-rep.json"), JSON.stringify({ name: "qa-rep", cases: [{ instance_id: "o__z@9" }] }));
    const r = go(t);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not a subset");
  });
});

describe("the freeze-validation plan", () => {
  it("names no held-out set and checks clean against the real sets", () => {
    const plan = JSON.parse(readFileSync(join(B, "plans", "freeze-validation.json"), "utf8"));
    const names = plan.sets.map((s: { set: string }) => s.set);
    for (const held of ["martian-test30", "holdout10", "fresh10"]) expect(names).not.toContain(held);
    const r = spawnSync("python3", [join(B, "rerun_plan.py"), "check", join(B, "plans", "freeze-validation.json"), join(B, "sets")], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
