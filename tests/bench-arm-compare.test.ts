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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const kase = (id: string) => ({
    instance_id: id,
    repo: "o/x",
    base_commit: "b",
    head_commit: "h",
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
  // writes run.json unless told to fail.
  writeFileSync(
    join(b, "bench.sh"),
    `#!/usr/bin/env bash
echo "IMG=\${QCR_BENCH_IMAGE:-} $*" >> "${t}/calls.log"
cmd="$1"; shift; run=""; set_name=""; only=""
while (($#)); do case "$1" in --run) run="$2"; shift 2;; --set) set_name="$2"; shift 2;; --only) only="$2"; shift 2;; *) shift;; esac; done
if [[ "$cmd" == review ]]; then
  [[ -n "\${STUB_REVIEW_FAIL:-}" ]] && exit 3
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
  writeFileSync(join(t, "bin", "docker"), '#!/bin/sh\necho "sha256:img-$3"\n');
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
    const r = await arm(["--prefix", "p", "--cases", `fresh10:${A}`], { STUB_REVIEW_FAIL: "1" });
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

  it("a full run is judged against every defect set it overlaps, never as `full`", async () => {
    const r = await arm(["--prefix", "f", "--cases", "full"]);
    expect(r.code).toBe(0);
    const judges = calls().filter((x) => x.includes(" judge "));
    expect(judges.length).toBe(2); // the run and its --resume retry
    for (const j of judges) expect(j).toContain(`--run f-full --set fresh10 --only ${A},${B}`);
  });

  it("repeats run one after another and --resume reaches bench.sh", async () => {
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
    const reviews = calls().filter((x) => x.includes(" review "));
    expect(reviews.map((x) => /--run (\S+)/.exec(x)![1])).toEqual(["r-r1-fresh10", "r-r2-fresh10"]);
    for (const x of reviews) expect(x).toContain("--resume");
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
    expect(out).toContain("| x | 2/3 (67%) |");
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

  it("warns when arms were reviewed by different builds, and reports the AACR metric's judge", async () => {
    for (const [dir, commit] of [
      ["p", "aaa"],
      ["q", "bbb"],
    ] as const) {
      judgement(dir, A, found(["D1"]));
      judgement(dir, B, found([]));
      writeFileSync(join(runs, dir, "run.json"), JSON.stringify({ qcr_commit: commit }));
      mkdirSync(join(runs, dir, "results", "all"), { recursive: true });
      writeFileSync(
        join(runs, dir, "results", "all", "metrics_ocr_average.json"),
        JSON.stringify({
          summary: {
            evaluated_instances: 2,
            expected_notes: 10,
            generated_notes: 4,
            matched_semantic_notes: 2,
            matched_line_notes: 3,
          },
        }),
      );
      writeFileSync(join(runs, dir, "judge.txt"), `judge-${dir}\n`);
    }
    const out = await compare("--aacr", "p=p", "q=q");
    expect(out).toContain("DIFFERENT builds");
    expect(out).toContain("| p | 2.0/10 (20.0%) | 2.0/4 (50.0%) |");
    expect(out).toContain("NOT COMPARABLE — the AACR evals used different judges");
  });
});
