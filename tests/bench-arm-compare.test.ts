// bench/aacr/arm.sh and compare.py, run for real: arm.sh against a stub
// bench.sh and a stub `docker` (no container, no model), compare.py on fixture
// run dirs. What they must guarantee is that arms are comparable — every arm
// judged by the same judge in the same image, a failed step never scored as a
// reviewer's miss, and a score that says when it is incomplete.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A = "o__a@1111111";
const B = "o__b@2222222";
const C = "o__c@3333333"; // in `full` only: no ground truth

let t: string;
let runs: string;
beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), "qcr-arm-"));
  runs = join(t, "runs");
  mkdirSync(runs);
  const b = join(t, "bench", "aacr");
  mkdirSync(join(b, "sets"), { recursive: true });
  mkdirSync(join(b, "defects"));
  for (const f of ["arm.sh", "compare.py"])
    copyFileSync(join(ROOT, "bench", "aacr", f), join(b, f));
  // change_line_count: the scheduler queues the longest PR first (B, C, A).
  const size: Record<string, number> = { [A]: 10, [B]: 50, [C]: 30 };
  const kase = (id: string) => ({
    instance_id: id,
    repo: "o/x",
    base_commit: "b",
    head_commit: "h",
    change_line_count: size[id],
  });
  writeFileSync(join(b, "sets", "fresh10.json"), JSON.stringify({ cases: [kase(A), kase(B)] }));
  writeFileSync(
    join(b, "sets", "full.json"),
    JSON.stringify({ cases: [kase(A), kase(B), kase(C)] }),
  );
  writeFileSync(
    join(b, "defects", "fresh10.json"),
    JSON.stringify({
      version: "1",
      cases: {
        [A]: {
          defects: [
            { id: "D1", severity: "high" },
            { id: "D2", severity: "low" },
          ],
        },
        [B]: { defects: [{ id: "D1", severity: "medium", benchmark_limitation: "CI gate" }] },
      },
    }),
  );
  // The stub bench.sh: logs every call with the image it was given; `review`
  // writes run.json unless told to fail (whole-run or --phase init); a
  // --phase case call counts how many cases run at once and answers with the
  // next scripted outcome from outcomes/<id> ("status retry limited"), ok by
  // default.
  mkdirSync(join(t, "outcomes"));
  mkdirSync(join(t, "running"));
  writeFileSync(
    join(b, "bench.sh"),
    `#!/usr/bin/env bash
echo "IMG=\${QCR_BENCH_IMAGE:-} MEM=\${QCR_BENCH_MEMORY:-} $*" >> "${t}/calls.log"
cmd="$1"; shift; run=""; set_name=""; only=""; phase=all
while (($#)); do case "$1" in --run) run="$2"; shift 2;; --set) set_name="$2"; shift 2;; --only) only="$2"; shift 2;; --phase) phase="$2"; shift 2;; *) shift;; esac; done
if [[ "$cmd" == review ]]; then
  [[ -n "\${STUB_REVIEW_FAIL:-}" ]] && exit 3
  if [[ "$phase" == case ]]; then
    : > "${t}/running/$run.$only"
    ls "${t}/running" | wc -l >> "${t}/conc.log"
    sleep "\${STUB_CASE_SLEEP:-0}"
    rm -f "${t}/running/$run.$only"
    o="ok 0 0"
    if [[ -s "${t}/outcomes/$only" ]]; then o="$(head -1 "${t}/outcomes/$only")"; sed -i '1d' "${t}/outcomes/$only"; fi
    read -r st rt lm q sk <<< "$o"
    echo "[00:00:00] result: $only $st retry=$rt limited=$lm\${q:+ quota=$q}\${sk:+ skipped}"
    exit 0
  fi
  if [[ "$phase" == finish ]]; then echo "[00:00:00] review: 1/1 ok (ok 1) — results in /bench-out/results"; exit 0; fi
  mkdir -p "$QCR_BENCH_RUNS_DIR/$run"
  ids="$only"; [[ -z "$ids" ]] && ids=$(python3 -c "import json,sys; print(','.join(c['instance_id'] for c in json.load(open(sys.argv[1]))['cases']))" "$(dirname "$0")/sets/$set_name.json")
  python3 -c "import json,sys; json.dump({'cases': sys.argv[1].split(','), 'qcr_commit': 'abc'}, open(sys.argv[2], 'w'))" "$ids" "$QCR_BENCH_RUNS_DIR/$run/run.json"
fi
[[ "$cmd" == judge ]] && echo "defect-judge: 1/1 judged — recall 0%"
exit 0
`,
  );
  chmodSync(join(b, "bench.sh"), 0o755);
  mkdirSync(join(t, "bin"));
  // The stub docker: `image inspect` answers an id; the image probe for
  // eval_shards.py fails when STUB_OLD_IMAGE is set (an image from before the
  // per-case scheduler).
  writeFileSync(
    join(t, "bin", "docker"),
    '#!/bin/sh\ncase "$*" in *eval_shards.py*) [ -n "$STUB_OLD_IMAGE" ] && exit 1; exit 0;; esac\necho "sha256:img-$3"\n',
  );
  chmodSync(join(t, "bin", "docker"), 0o755);
});
afterEach(() => rmSync(t, { recursive: true, force: true }));

const arm = (args: string[], env: Record<string, string> = {}) =>
  run("bash", [join(t, "bench", "aacr", "arm.sh"), ...args], {
    env: {
      ...process.env,
      PATH: `${join(t, "bin")}:${process.env.PATH}`,
      QCR_BENCH_RUNS_DIR: runs,
      QCR_BENCH_IMAGE: "qcr-bench:x",
      QCR_BENCH_OCR_IMAGE: "qcr-bench-ocr:x",
      QCR_BENCH_POLL: "0.05",
      QCR_BENCH_LAUNCH_GAP: "0",
      QCR_BENCH_RATE_LIMIT_PAUSE: "0",
      QCR_BENCH_MEM_AVAILABLE_MB: "64000",
      ...env,
    },
  }).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
  );
const calls = () =>
  existsSync(join(t, "calls.log"))
    ? readFileSync(join(t, "calls.log"), "utf8").trim().split("\n")
    : [];

describe("arm.sh", () => {
  it("a failed review is a failed arm: nothing is judged and the exit is non-zero", async () => {
    const r = await arm(["--prefix", "p", "--cases", `fresh10:${A}`], { STUB_REVIEW_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAILED — the review wrote no run.json");
    expect(calls().filter((c) => c.includes(" judge "))).toEqual([]);
  });

  it("a run.json left over from an earlier run is never judged as this one", async () => {
    mkdirSync(join(runs, "p-fresh10"));
    writeFileSync(join(runs, "p-fresh10", "run.json"), JSON.stringify({ cases: [A] }));
    const old = new Date(Date.now() - 3600_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(runs, "p-fresh10", "run.json"), old, old);
    const r = await arm(["--prefix", "p", "--cases", `fresh10:${A}`, "--fresh"], {
      STUB_REVIEW_FAIL: "1",
    });
    expect(r.code).toBe(1);
    expect(calls().filter((c) => c.includes(" judge "))).toEqual([]);
  });

  it("the OCR arm reviews in its own image and is judged in the quickreviewd image, like every arm", async () => {
    const r = await arm([
      "--prefix",
      "o",
      "--arm",
      "ocr",
      "--cases",
      `fresh10:${A},${B}`,
      "--eval",
      "2",
    ]);
    expect(r.code).toBe(0);
    const c = calls();
    const review = c.find((x) => x.includes(" review "))!;
    expect(review).toContain("--arm ocr");
    expect(review).not.toContain("--concurrency");
    for (const j of c.filter((x) => x.includes(" judge "))) {
      expect(j.startsWith("IMG=qcr-bench:x ")).toBe(true);
      expect(j).not.toContain("--arm");
      expect(j).toContain(`--set fresh10 --only ${A},${B}`);
    }
    expect(c.find((x) => x.includes(" eval "))).toContain(
      `--arm ocr --run o-fresh10 --set fresh10 --only ${A},${B} --judge codex --rounds 2`,
    );
    const rec = JSON.parse(readFileSync(join(runs, "o-fresh10.arm.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(rec.arm).toBe("ocr");
    expect(rec.image).toBe("qcr-bench-ocr:x");
    expect(rec.image_id).toBe("sha256:img-qcr-bench-ocr:x");
  });

  it("the PR-Agent arm reviews in its own image, one container per set, and is judged in the quickreviewd image", async () => {
    const r = await arm(["--prefix", "pa", "--arm", "pragent", "--cases", `fresh10:${A},${B}`], {
      QCR_BENCH_PRAGENT_IMAGE: "qcr-bench-pragent:x",
    });
    expect(r.code).toBe(0);
    const c = calls();
    const reviews = c.filter((x) => x.includes(" review "));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain("--arm pragent --run pa-fresh10 --set fresh10");
    expect(reviews[0]).not.toContain("--phase");
    for (const j of c.filter((x) => x.includes(" judge ")))
      expect(j.startsWith("IMG=qcr-bench:x ")).toBe(true);
    const rec = JSON.parse(readFileSync(join(runs, "pa-fresh10.arm.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(rec.arm).toBe("pragent");
    expect(rec.image).toBe("qcr-bench-pragent:x");
  });

  it("--pr-text: the equal-inputs switch reaches a CLI arm and its arm.json, and is refused for quickreviewd", async () => {
    const refused = await arm(["--prefix", "q", "--cases", `fresh10:${A}`, "--pr-text"]);
    expect(refused.code).toBe(2);
    expect(calls()).toEqual([]);
    const r = await arm(
      ["--prefix", "t", "--arm", "ocr", "--cases", `fresh10:${A}`, "--pr-text", "--no-judge"],
      { QCR_BENCH_OCR_EFFORT: "high" },
    );
    expect(r.code).toBe(0);
    const rec = JSON.parse(readFileSync(join(runs, "t-fresh10.arm.json"), "utf8")) as {
      env: Record<string, string>;
    };
    expect(rec.env).toEqual({ QCR_BENCH_OCR_EFFORT: "high", QCR_BENCH_PR_TEXT: "1" });
    const plain = await arm([
      "--prefix",
      "u",
      "--arm",
      "ocr",
      "--cases",
      `fresh10:${A}`,
      "--no-judge",
    ]);
    expect(plain.code).toBe(0);
    expect(JSON.parse(readFileSync(join(runs, "u-fresh10.arm.json"), "utf8")).env).toEqual({});
  });

  it("a full run is judged against every defect set it overlaps, never as `full`", async () => {
    const r = await arm(["--prefix", "f", "--cases", "full"]);
    expect(r.code).toBe(0);
    const judges = calls().filter((x) => x.includes(" judge "));
    expect(judges.length).toBe(2); // the run and its --resume retry
    for (const j of judges) expect(j).toContain(`--run f-full --set fresh10 --only ${A},${B}`);
  });

  it("repeats share the one queue, and --resume reaches every run's set-up", async () => {
    const r = await arm([
      "--prefix",
      "r",
      "--cases",
      `fresh10:${A}`,
      "--repeat",
      "2",
      "--resume",
      "--no-judge",
    ]);
    expect(r.code).toBe(0);
    const inits = calls().filter((x) => x.includes(" review --phase init "));
    expect(inits.map((x) => /--run (\S+)/.exec(x)![1])).toEqual(["r-r1-fresh10", "r-r2-fresh10"]);
    for (const x of inits) expect(x).toContain("--resume");
    const cases = calls().filter((x) => x.includes(" review --phase case "));
    expect(cases.map((x) => /--run (\S+)/.exec(x)![1]).sort()).toEqual([
      "r-r1-fresh10",
      "r-r2-fresh10",
    ]);
  });

  it("refuses an image built before the per-case scheduler (it would ignore --phase)", async () => {
    const r = await arm(["--prefix", "o", "--cases", `fresh10:${A}`], { STUB_OLD_IMAGE: "1" });
    expect(r.code).toBe(2);
    expect(calls()).toEqual([]);
  });

  it("refuses to relaunch over an existing run unless told --resume or --fresh", async () => {
    mkdirSync(join(runs, "p-fresh10"));
    writeFileSync(join(runs, "p-fresh10", "run.json"), JSON.stringify({ cases: [A] }));
    const r = await arm(["--prefix", "p", "--cases", `fresh10:${A}`]);
    expect(r.code).toBe(2);
    expect(calls()).toEqual([]);
  });

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

  it("a case --resume skipped does not hold memory admission (2026-10-02 resume stall)", async () => {
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

  it("--retries 0 leaves a failed case for --resume", async () => {
    writeFileSync(join(t, "outcomes", A), "timeout 1 0\n");
    const r = await arm([
      "--prefix",
      "y",
      "--cases",
      `fresh10:${A}`,
      "--retries",
      "0",
      "--no-judge",
    ]);
    expect(r.code).toBe(1);
    expect(calls().filter((x) => x.includes(" review --phase case ")).length).toBe(1);
    expect(r.out).toContain("--resume re-runs only what is not ok");
  });

  it("a finished run is closed, judged and sharded-evaluated", async () => {
    const r = await arm([
      "--prefix",
      "e",
      "--cases",
      "fresh10",
      "--eval",
      "3",
      "--eval-shards",
      "6",
      "--eval-variants",
      "all",
    ]);
    expect(r.code).toBe(0);
    const c = calls();
    const at = (s: string) => c.findIndex((x) => x.includes(s));
    expect(at(" review --phase finish ")).toBeGreaterThan(at(" review --phase case "));
    expect(at(" judge ")).toBeGreaterThan(at(" review --phase finish "));
    // 2 PRs → 1 shard (at least ~4 PRs a shard), the variants passed through.
    expect(c.find((x) => x.includes(" eval "))).toContain(
      `--run e-fresh10 --set fresh10 --only ${A},${B} --judge codex --rounds 3 --shards 1 --variants all`,
    );
  });
});

describe("compare.py", () => {
  const judgement = (dir: string, id: string, body: object) => {
    const d = join(runs, dir, "judge", "v1-gpt-6-sol-high");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.r1.json`), JSON.stringify(body));
  };
  const compare = (...args: string[]) =>
    run("python3", [join(t, "bench", "aacr", "compare.py"), "--cases", "fresh10", ...args], {
      env: { ...process.env, QCR_BENCH_RUNS_DIR: runs },
    }).then((r) => r.stdout);
  const found = (ids: string[]) => ({
    defects: ids.map((id) => ({ id, verdict: "found" })),
    comments: [{ verdict: "correct-valuable" }],
  });

  it("an errored or missing judgement stays in the denominator, and the row says INCOMPLETE", async () => {
    judgement("x", A, found(["D1", "D2"]));
    judgement("x", B, { defects: [], comments: [], error: "malformed" });
    const out = await compare("x=x");
    expect(out).toContain("| x | 2/3 | 67% |");
    expect(out).toContain("1/2 INCOMPLETE |");
    expect(out).toContain("1 judgement(s) are ERROR files");
  });

  it("the OCR arm is priced from its bridge tokens at pi's rates, not $0", async () => {
    judgement("o", A, found(["D1"]));
    judgement("o", B, found([]));
    for (const id of [A, B]) {
      mkdirSync(join(runs, "o", "cases", id), { recursive: true });
      writeFileSync(
        join(runs, "o", "cases", id, "case-summary.json"),
        JSON.stringify({
          duration_seconds: 60,
          bridge: { input_tokens: 1_000_000, cached_tokens: 500_000, output_tokens: 100_000 },
        }),
      );
    }
    // 0.5M × $2 + 0.5M × $0.20 + 0.1M × $10 = $2.10
    expect(await compare("o=o")).toContain("| $2.10 | 1.0 | 2/2 |");
  });

  it("a gpt-6.1-sol bridge arm (PR-Agent) is priced at ITS model's rates", async () => {
    judgement("g", A, found(["D1"]));
    judgement("g", B, found([]));
    for (const id of [A, B]) {
      mkdirSync(join(runs, "g", "cases", id), { recursive: true });
      writeFileSync(
        join(runs, "g", "cases", id, "case-summary.json"),
        JSON.stringify({
          arm: "pragent",
          model: "gpt-6.1-sol",
          duration_seconds: 60,
          bridge: { input_tokens: 1_000_000, cached_tokens: 500_000, output_tokens: 100_000 },
        }),
      );
    }
    // 0.5M × $2 + 0.5M × $0.10 + 0.1M × $10 = $2.05
    expect(await compare("g=g")).toContain("| $2.05 | 1.0 | 2/2 |");
  });

  it("a slim-bundle case (no pi-events.jsonl) is priced from its precomputed bench_cost_usd, every arm", async () => {
    judgement("slim", A, found(["D1"]));
    judgement("slim", B, found([]));
    for (const [id, cost] of [
      [A, 1.25],
      [B, 0.75],
    ] as const) {
      mkdirSync(join(runs, "slim", "cases", id), { recursive: true });
      writeFileSync(
        join(runs, "slim", "cases", id, "case-summary.json"),
        // A pi-review case also carries its own cost_usd: the export's price wins.
        JSON.stringify({
          arm: "pireview",
          cost_usd: 99,
          duration_seconds: 60,
          bench_cost_usd: cost,
        }),
      );
    }
    expect(await compare("slim=slim")).toContain("| $1.00 | 1.0 | 2/2 |");
  });

  // The harness's per-round file: every reference of a PR with its match
  // flag; and the result file whose comments it scored.
  const ref = (n: number) => ({ path: "f.py", from_line: n, to_line: n, note: `ref ${n}` });
  const evalRound = (dir: string, file: string, matched: Record<string, number[]>) => {
    const d = join(runs, dir, "results", "all");
    mkdirSync(d, { recursive: true });
    const eval_res = Object.entries(matched).map(([id, hits]) => ({
      instance_id: id,
      comments: [1, 2, 3].map((n) => ({ ...ref(n), semantic_match: hits.includes(n) })),
    }));
    writeFileSync(join(d, file), JSON.stringify({ summary: {}, eval_res }));
    for (const id of Object.keys(matched))
      writeFileSync(join(d, `${id}.json`), JSON.stringify({ review: { comments: [{}, {}] } }));
  };
  // The benchmark's own labels for those references (references.json).
  const labels = () => {
    const key = (n: number) =>
      `f.py:${n}-${n}:${createHash("sha1").update(`ref ${n}`).digest("hex").slice(0, 12)}`;
    const per = {
      [key(1)]: ["Code Defect", "Diff Level"],
      [key(2)]: ["Code Defect", "Repo Level"],
      [key(3)]: ["Performance", "File Level"],
    };
    writeFileSync(
      join(t, "bench", "aacr", "references.json"),
      JSON.stringify({ references: { [A]: per, [B]: per } }),
    );
  };

  it("leads both tables with problems found, and breaks the benchmark's down by its own labels", async () => {
    labels();
    judgement("p", A, found(["D1"]));
    judgement("p", B, found([]));
    evalRound("p", "metrics_ocr_1_round_1.json", { [A]: [1], [B]: [] });
    evalRound("p", "metrics_ocr_1_round_2.json", { [A]: [1, 3], [B]: [] });
    const out = await compare("p=p");
    expect(out).toContain("| Arm | Problems found | Recall | High | Medium | Low | Weighted |");
    expect(out).toContain("| p | 1/3 | 33% | 1/1 | 0/1 | 0/1 |");
    expect(out).toContain("| Arm | References found | Recall | Precision | F1 | Code defect |");
    // A: ref 1 in both rounds, ref 3 in one of two → 1.5 of 6; 4 comments scored.
    expect(out).toContain("| p | 1.5/6 | 25.0% | 37.5% (4 comments) |");
    // Code defect 1.0/4, Maintainability 0/0, Performance 0.5/2, Security 0/0, Diff 1.0/2, File 0.5/2, Repo 0/2
    expect(out).toContain("| 1.0/4 | 0.0/0 | 0.5/2 | 0.0/0 | 1.0/2 | 0.5/2 | 0.0/2 | 2/2 |");
  });

  it("warns when arms were reviewed by different builds or evaluated by different judges", async () => {
    labels();
    for (const [dir, commit] of [
      ["p", "aaa"],
      ["q", "bbb"],
    ] as const) {
      judgement(dir, A, found(["D1"]));
      judgement(dir, B, found([]));
      writeFileSync(join(runs, dir, "run.json"), JSON.stringify({ qcr_commit: commit }));
      evalRound(dir, "metrics_ocr_1.json", { [A]: [1], [B]: [] });
      writeFileSync(join(runs, dir, "judge.txt"), `judge-${dir}\n`);
    }
    const out = await compare("p=p", "q=q");
    expect(out).toContain("DIFFERENT builds");
    expect(out).toContain("NOT COMPARABLE — the AACR evals used different judges");
  });

  it("--exclude-refs re-scores without those references; a comment matching only one is unmatched, or dropped", async () => {
    labels();
    judgement("p", A, found(["D1"]));
    judgement("p", B, found([]));
    const d = join(runs, "p", "results", "all");
    mkdirSync(d, { recursive: true });
    // A: comment c1 matches refs 1 and 2, comment c2 matches ref 3 only.
    const hit = { 1: "c1", 2: "c1", 3: "c2" } as Record<number, string>;
    writeFileSync(
      join(d, "metrics_ocr_1_round_1.json"),
      JSON.stringify({
        summary: {},
        eval_res: [
          {
            instance_id: A,
            comments: [1, 2, 3].map((n) => ({
              ...ref(n),
              semantic_match: true,
              matched_note: hit[n],
            })),
          },
          {
            instance_id: B,
            comments: [1, 2, 3].map((n) => ({
              ...ref(n),
              semantic_match: false,
              matched_note: "",
            })),
          },
        ],
      }),
    );
    for (const id of [A, B])
      writeFileSync(join(d, `${id}.json`), JSON.stringify({ review: { comments: [{}, {}] } }));
    const key = (n: number) =>
      `f.py:${n}-${n}:${createHash("sha1").update(`ref ${n}`).digest("hex").slice(0, 12)}`;
    const ex = join(t, "exclude.json");
    writeFileSync(ex, JSON.stringify({ references: { [A]: { [key(2)]: {}, [key(3)]: {} } } }));
    const plain = await compare("p=p");
    expect(plain).not.toContain("references removed");
    const out = await compare("--exclude-refs", ex, "p=p");
    // The published table is untouched.
    expect(out).toContain("| p | 3.0/6 | 50.0% | 75.0% (4 comments) | 60.0% |");
    // After: ref 1 of 4 kept; c2 matched only a removed ref → 1/4 unmatched, 1/3 dropped.
    expect(out).toContain(
      "| p | 3.0/6 → 1.0/4 | 50.0% → 25.0% | 75.0% → 25.0% / 33.3% (1.0 comments matched only a removed reference) | 60.0% → 25.0% / 28.6% |",
    );
  });

  it("scores `set:id,id` cases only — in both tables", async () => {
    labels();
    judgement("s", A, found(["D1"]));
    evalRound("s", "metrics_ocr_1.json", { [A]: [2], [B]: [1, 2, 3] });
    const out = await run(
      "python3",
      [join(t, "bench", "aacr", "compare.py"), "--cases", `fresh10:${A}`, "s=s"],
      { env: { ...process.env, QCR_BENCH_RUNS_DIR: runs } },
    ).then((r) => r.stdout);
    expect(out).toContain("1 PRs, 2 defects");
    expect(out).toContain("| s | 1/2 | 50% |");
    expect(out).toContain("| s | 1.0/3 | 33.3% | 50.0% (2 comments) |");
  });
});

// eval_shards.py, run for real against a stand-in harness dir holding the
// harness's own two summary functions VERBATIM (evaluation/evaluate.py
// _compute_summary + _compute_f1, evaluation/pipeline.py _average_summaries at
// the pinned 68a5697): a sharded eval must merge into exactly the files one
// harness process writes.
describe("eval_shards.py", () => {
  const HARNESS_EVALUATE = `
def _compute_f1(precision: float, recall: float) -> float:
    if (precision + recall) <= 0:
        return 0.0
    return round(2 * precision * recall / (precision + recall), 3)


def _compute_summary(stats):
    expected = stats["expected_notes"]
    generated = stats["generated_notes"]
    sem_p = round(stats["matched_semantic_notes"] / generated, 3) if generated else 0.0
    line_p = round(stats["matched_line_notes"] / generated, 3) if generated else 0.0
    sem_r = round(stats["matched_semantic_notes"] / expected, 3) if expected else 0.0
    line_r = round(stats["matched_line_notes"] / expected, 3) if expected else 0.0

    evaluated = stats["evaluated_instances"]
    total_duration = stats.get("total_duration_seconds", 0)
    total_input_tokens = stats.get("total_input_tokens", 0)
    total_output_tokens = stats.get("total_output_tokens", 0)

    return {
        "total_instances": stats["total_instances"],
        "candidate_instances": stats["candidate_instances"],
        "evaluated_instances": evaluated,
        "missing_instances": stats["missing_instances"],
        "expected_notes": expected,
        "generated_notes": generated,
        "matched_line_notes": stats["matched_line_notes"],
        "matched_semantic_notes": stats["matched_semantic_notes"],
        "semantic_match_rate": sem_p,
        "line_match_rate": line_p,
        "semantic_recall_rate": sem_r,
        "line_recall_rate": line_r,
        "semantic_f1": _compute_f1(sem_p, sem_r),
        "line_f1": _compute_f1(line_p, line_r),
        "total_duration_seconds": round(total_duration, 2),
        "avg_duration_seconds": round(total_duration / evaluated, 2) if evaluated else 0,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "total_tokens": total_input_tokens + total_output_tokens,
        "avg_input_tokens": round(total_input_tokens / evaluated) if evaluated else 0,
        "avg_output_tokens": round(total_output_tokens / evaluated) if evaluated else 0,
    }
`;
  const HARNESS_PIPELINE = `
def _average_summaries(summaries):
    if not summaries:
        return {}
    numeric_keys = [
        key for key, value in summaries[0].items() if isinstance(value, (int, float))
    ]
    averaged = {}
    for key in numeric_keys:
        values = [s.get(key, 0) for s in summaries]
        averaged[key] = round(sum(values) / len(values), 4)
    return averaged
`;
  const py = (...args: string[]) =>
    run("python3", [join(ROOT, "bench", "aacr", "eval_shards.py"), ...args]).then((r) => r.stdout);
  // Five PRs with 5, 1, 4, 2, 0 references; E has no result file.
  const ids = ["o/a@1", "o/b@2", "o/c@3", "o/d@4", "o/e@5"];
  const refs = [5, 1, 4, 2, 0];
  const dataset = () => {
    const d = join(t, "subset.jsonl");
    writeFileSync(
      d,
      ids
        .map((id, i) =>
          JSON.stringify({
            instance_id: id,
            reference_comments: Array(refs[i]).fill({ note: "r" }),
          }),
        )
        .join("\n") + "\n",
    );
    const res = join(t, "results");
    mkdirSync(res, { recursive: true });
    for (const id of ids.slice(0, 4))
      writeFileSync(join(res, `${id.replace("/", "__")}.json`), JSON.stringify({ id }));
    return { d, res };
  };

  it("splits by reference count and copies only the shard's own result files", async () => {
    const { d, res } = dataset();
    const work = join(t, "work");
    expect(
      (await py("split", "--dataset", d, "--results", res, "--shards", "2", "--into", work)).trim(),
    ).toBe("2");
    const shard = (k: number) =>
      readFileSync(join(work, String(k), "dataset.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { instance_id: string }).instance_id);
    // Heaviest first onto the lighter shard: a(5) → 0, c(4) → 1, d(2) → 1, b(1) → 0, e(0) → 0;
    // each shard keeps dataset order.
    expect(shard(0)).toEqual(["o/a@1", "o/b@2", "o/e@5"]);
    expect(shard(1)).toEqual(["o/c@3", "o/d@4"]);
    expect(existsSync(join(work, "0", "o__a@1.json"))).toBe(true);
    expect(existsSync(join(work, "0", "o__e@5.json"))).toBe(false); // missing stays missing
    expect(existsSync(join(work, "1", "o__a@1.json"))).toBe(false);
    // Never more shards than PRs.
    expect(
      (
        await py(
          "split",
          "--dataset",
          d,
          "--results",
          res,
          "--shards",
          "9",
          "--into",
          join(t, "w9"),
        )
      ).trim(),
    ).toBe("5");
  });

  it("merges round files into the harness's own numbers, and averages rounds as the harness does", async () => {
    const { d } = dataset();
    const harness = join(t, "harness");
    mkdirSync(harness);
    writeFileSync(join(harness, "evaluate.py"), HARNESS_EVALUATE);
    writeFileSync(join(harness, "pipeline.py"), HARNESS_PIPELINE);
    const counts = (
      evald: number,
      missing: number,
      exp: number,
      gen: number,
      sem: number,
      line: number,
    ) => ({
      total_instances: evald + missing,
      candidate_instances: evald + missing,
      evaluated_instances: evald,
      missing_instances: missing,
      expected_notes: exp,
      generated_notes: gen,
      matched_semantic_notes: sem,
      matched_line_notes: line,
      total_duration_seconds: 100,
      total_input_tokens: 1000,
      total_output_tokens: 10,
    });
    const shardFile = (k: number, r: number, summary: object, res: string[], missing: string[]) => {
      const dir = join(t, "work", String(k));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `metrics_ocr_2026010${k}_000000_round_${r}.json`),
        JSON.stringify({
          ex_info: { start_time: `2026-01-0${k + 1}`, missing_instance_ids: missing },
          summary,
          eval_res: res.map((instance_id) => ({ instance_id, comments: [] })),
        }),
      );
      writeFileSync(join(dir, "metrics_ocr_average.json"), "{}"); // a shard's own average is ignored
    };
    shardFile(0, 1, counts(2, 1, 10, 8, 4, 5), ["o/a@1", "o/b@2"], ["o/e@5"]);
    shardFile(1, 1, counts(2, 0, 6, 4, 2, 1), ["o/c@3", "o/d@4"], []);
    shardFile(0, 2, counts(2, 1, 10, 8, 2, 5), ["o/a@1", "o/b@2"], ["o/e@5"]);
    shardFile(1, 2, counts(2, 0, 6, 4, 2, 1), ["o/c@3", "o/d@4"], []);
    const out = join(t, "out");
    mkdirSync(out);
    await py(
      "merge",
      "--dataset",
      d,
      "--out",
      out,
      "--rounds",
      "2",
      "--harness",
      harness,
      join(t, "work", "1"),
      join(t, "work", "0"),
    );
    const files = readdirSync(out).sort();
    expect(files.filter((f) => /_round_1\.json$/.test(f)).length).toBe(1);
    expect(files.filter((f) => /_round_2\.json$/.test(f)).length).toBe(1);
    expect(files).toContain("metrics_ocr_average.json");
    const r1 = JSON.parse(
      readFileSync(
        join(
          out,
          files.find((f) => f.endsWith("_round_1.json"))!,
        ),
        "utf8",
      ),
    );
    // 6 of 12 generated match, 6 of 16 expected: P .5, R .375, F1 .429 — one process's numbers.
    expect(r1.summary).toMatchObject({
      evaluated_instances: 4,
      missing_instances: 1,
      total_instances: 5,
      expected_notes: 16,
      generated_notes: 12,
      semantic_match_rate: 0.5,
      semantic_recall_rate: 0.375,
      semantic_f1: 0.429,
      line_f1: 0.429,
      avg_duration_seconds: 50,
    });
    expect(r1.eval_res.map((e: { instance_id: string }) => e.instance_id)).toEqual(ids.slice(0, 4));
    expect(r1.ex_info.missing_instance_ids).toEqual(["o/e@5"]);
    const avg = JSON.parse(readFileSync(join(out, "metrics_ocr_average.json"), "utf8"));
    // round 2: 4/12, 4/16 → .333/.25 → F1 .286; mean (.429 + .286) / 2
    expect(avg.eval_rounds).toBe(2);
    expect(avg.summary.semantic_f1).toBe(0.3575);
    expect(avg.summary.evaluated_instances).toBe(4);
  });

  it("refuses a shard that is missing a round rather than scoring fewer PRs", async () => {
    const { d } = dataset();
    const harness = join(t, "harness");
    mkdirSync(harness);
    writeFileSync(join(harness, "evaluate.py"), HARNESS_EVALUATE);
    writeFileSync(join(harness, "pipeline.py"), HARNESS_PIPELINE);
    mkdirSync(join(t, "work", "0"), { recursive: true });
    const r = await run("python3", [
      join(ROOT, "bench", "aacr", "eval_shards.py"),
      "merge",
      "--dataset",
      d,
      "--out",
      t,
      "--rounds",
      "1",
      "--harness",
      harness,
      join(t, "work", "0"),
    ]).then(
      () => 0,
      (e: { code: number; stderr: string }) => (expect(e.stderr).toContain("expected 1"), e.code),
    );
    expect(r).not.toBe(0);
  });
});
