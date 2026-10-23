// Shared fixture of the bench/aacr/arm.sh tests (bench-arm-compare.test.ts and
// bench-arm-scheduler.test.ts): a temp tree holding arm.sh and compare.py, a stub
// bench.sh and a stub `docker`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const A = "o__a@1111111";
export const B = "o__b@2222222";
export const C = "o__c@3333333"; // in `full` only: no ground truth

/** Builds the fixture tree; the caller removes `t` after the test. */
export function setupArmFixture(): { t: string; runs: string } {
  const t = mkdtempSync(join(tmpdir(), "qcr-arm-"));
  const runs = join(t, "runs");
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
  return { t, runs };
}

export const armIn = (t: string, runs: string, args: string[], env: Record<string, string> = {}) =>
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
export const callsIn = (t: string) =>
  existsSync(join(t, "calls.log"))
    ? readFileSync(join(t, "calls.log"), "utf8").trim().split("\n")
    : [];
