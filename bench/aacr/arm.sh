#!/usr/bin/env bash
# One benchmark ARM, end to end: review a group of PRs with one set of config
# levers, then judge exactly those PRs against the defect ground truth. Sets
# run in parallel (one bench.sh container each); the judge re-runs once with
# --resume, because a judge answer is occasionally malformed and one retry
# clears it.
#
#   bench/aacr/arm.sh --prefix low --config review.preset=low --cases fresh10+levers16
#   bench/aacr/arm.sh --prefix base --cases smoke10          # the shipped config
#
#   --prefix NAME     runs are named NAME-<set> (e.g. low-fresh10) under $QCR_BENCH_RUNS_DIR
#   --config k=v,...  config.toml levers for this arm (bench.sh --config; e.g. review.preset=max)
#   --cases G+G+...   case groups joined by '+', each one of:
#                       <set>              every PR of bench/aacr/sets/<set>.json
#                       <set>:id,id        those PRs of that set
#                       levers16           the 16 PRs the 2026-09-27 levers were measured on
#                       all30              smoke10 + dev10 + holdout10
#                       full               the 196-PR AACR set: judged against every defect
#                                          set it overlaps (the 40 PRs with ground truth)
#   --arm qcr|ocr     quickreviewd (default) or the open-code-review baseline (bench.sh --arm ocr;
#                     OCR reviews one case at a time, --concurrency does not apply)
#   --concurrency N   reviews at once per set (default 2)
#   --resume          keep cases already reviewed by the same build and levers (bench.sh --resume)
#   --no-judge        review only
#   --eval R          also score AACR-Bench's own metric: bench.sh eval --judge codex --rounds R
#                     (the harness's references; JUDGE_CODEX_MODEL fixes the judge for every arm)
#   --repeat N        N independent runs of the arm, named NAME-r<k>-<set>, one
#                     repeat after another; compare.py scores them as NAME=runs+runs
#
# Every arm is judged by the SAME judge on the same image: the defect judge
# always runs in the quickreviewd image ($QCR_BENCH_IMAGE), whatever the arm.
# $QCR_BENCH_RUNS_DIR/<run>.arm.json records the arm, image id and levers.
# Exits non-zero when any review, judge or eval step failed.
#
# Compare arms afterwards with bench/aacr/compare.py. Keep QCR_BENCH_RUNS_DIR
# outside any worktree so runs survive and can be re-judged; one image serves
# every arm of an experiment (QCR_BENCH_IMAGE), the levers ride --config.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR to a directory outside any worktree}"
export QCR_BENCH_RUNS_DIR

PREFIX="" CONFIG="" CASES="" CONC=2 JUDGE=1 REPEAT=1 ARM=qcr RESUME=() EVAL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --cases) CASES="$2"; shift 2 ;;
    --concurrency) CONC="$2"; shift 2 ;;
    --no-judge) JUDGE=0; shift ;;
    --arm) ARM="$2"; shift 2 ;;
    --resume) RESUME=(--resume); shift ;;
    --eval) EVAL="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    *) echo "unknown flag $1 (see the header of $0)" >&2; exit 2 ;;
  esac
done
[[ -n "$PREFIX" && -n "$CASES" ]] || { echo "--prefix and --cases are required" >&2; exit 2; }
[[ "$ARM" == qcr || "$ARM" == ocr ]] || { echo "--arm must be qcr | ocr" >&2; exit 2; }
[[ "$ARM" == qcr || -z "$CONFIG" ]] || { echo "--config sets quickreviewd levers; the ocr arm has none" >&2; exit 2; }
[[ "$EVAL" =~ ^[0-9]+$ ]] || { echo "--eval takes a round count" >&2; exit 2; }
QIMG="${QCR_BENCH_IMAGE:-qcr-bench:latest}" OIMG="${QCR_BENCH_OCR_IMAGE:-qcr-bench-ocr:latest}"
IMG="$QIMG"; [[ "$ARM" == ocr ]] && IMG="$OIMG"
IMG_ID="$(docker image inspect "$IMG" --format '{{.Id}}' 2>/dev/null)" || { echo "no image $IMG — build it: bench.sh build --arm $ARM" >&2; exit 2; }

LEVERS16_SMOKE=cline__cline@7d18fb9,linera-io__linera-protocol@3535ddb,lvgl__lvgl@4a57db3,ollama__ollama@b6002f6,dbeaver__dbeaver@bc3ac7b,mrdoob__three.js@96ab072
LEVERS16_DEV=CherryHQ__cherry-studio@83a2594,bluewave-labs__Checkmate@29e03a6,mpv-player__mpv@0729afe,FreeCAD__FreeCAD@699b45c,openai__codex@8c952af,alibaba__spring-ai-alibaba@4bc7305
LEVERS16_HOLDOUT=libsdl-org__SDL@1526727,keycloak__keycloak@805c204,n8n-io__n8n@9321691,PowerShell__PowerShell@ec952ce

# Expand the groups into "set|ids" jobs ("" ids = the whole set).
jobs=()
IFS='+' read -r -a groups <<< "$CASES"
for g in "${groups[@]}"; do
  case "$g" in
    levers16) jobs+=("smoke10|$LEVERS16_SMOKE" "dev10|$LEVERS16_DEV" "holdout10|$LEVERS16_HOLDOUT") ;;
    all30) jobs+=("smoke10|" "dev10|" "holdout10|") ;;
    full) jobs+=("full|") ;;
    *:*) jobs+=("${g%%:*}|${g#*:}") ;;
    *) jobs+=("$g|") ;;
  esac
done
for j in "${jobs[@]}"; do
  set_name="${j%%|*}"
  [[ -f "$HERE/sets/$set_name.json" ]] || { echo "no case set $set_name" >&2; exit 2; }
done

one() { # set ids run-prefix
  local set_name="$1" ids="$2" run="$3-$1" only=() cfg=() arm=() conc=() rc=0
  [[ -n "$ids" ]] && only=(--only "$ids")
  [[ -n "$CONFIG" ]] && cfg=(--config "$CONFIG")
  [[ "$ARM" == ocr ]] && arm=(--arm ocr) || conc=(--concurrency "$CONC")
  printf '{"arm":"%s","image":"%s","image_id":"%s","config":"%s","cases":"%s","started":"%s"}\n' \
    "$ARM" "$IMG" "$IMG_ID" "$CONFIG" "$set_name:$ids" "$(date -u +%FT%TZ)" > "$QCR_BENCH_RUNS_DIR/$run.arm.json"
  "$HERE/bench.sh" review ${arm[@]+"${arm[@]}"} --run "$run" --set "$set_name" ${only[@]+"${only[@]}"} \
    ${conc[@]+"${conc[@]}"} ${cfg[@]+"${cfg[@]}"} ${RESUME[@]+"${RESUME[@]}"} > "$QCR_BENCH_RUNS_DIR/$run.review.log" 2>&1 || rc=$?
  echo "$run: review exit $rc $(date +%T)"
  # Score only what THIS review wrote: a run.json older than this job (a
  # review that died before writing one) would judge someone else's reviews.
  local cases
  cases=$(python3 -c "import json,os,sys; f=sys.argv[1]; assert os.path.getmtime(f) >= float(sys.argv[2]); print(','.join(json.load(open(f))['cases']))" \
    "$QCR_BENCH_RUNS_DIR/$run/run.json" "$START" 2>/dev/null) || cases=""
  [[ -n "$cases" ]] || { echo "$run: FAILED — the review wrote no run.json (see $run.review.log)"; return 1; }
  if [[ "$JUDGE" == 1 ]]; then
    # Judge ONLY this run's own cases, per ground truth that has them (a
    # `full` run spans several defect sets), always in the quickreviewd image.
    local defs
    defs=$(python3 - "$HERE/defects" "$cases" <<'PY'
import json, os, sys
want = set(sys.argv[2].split(","))
for f in sorted(os.listdir(sys.argv[1])):
    if f.endswith(".json") and not f.startswith("_"):
        try:
            ids = [i for i in json.load(open(os.path.join(sys.argv[1], f)))["cases"] if i in want]
        except Exception:
            continue
        if ids:
            print(f[:-5], ",".join(ids))
PY
)
    [[ -n "$defs" ]] || echo "$run: no ground truth covers these cases — not judged"
    : > "$QCR_BENCH_RUNS_DIR/$run.judge.log"
    while read -r dset dids; do
      [[ -n "$dset" ]] || continue
      QCR_BENCH_IMAGE="$QIMG" "$HERE/bench.sh" judge --run "$run" --set "$dset" --only "$dids" --concurrency 4 \
        >> "$QCR_BENCH_RUNS_DIR/$run.judge.log" 2>&1
      QCR_BENCH_IMAGE="$QIMG" "$HERE/bench.sh" judge --run "$run" --set "$dset" --only "$dids" --concurrency 4 --resume \
        >> "$QCR_BENCH_RUNS_DIR/$run.judge.log" 2>&1 || { echo "$run: judge ($dset) FAILED — see $run.judge.log"; rc=1; }
    done <<< "$defs"
    echo "$run: $(grep 'judged —' "$QCR_BENCH_RUNS_DIR/$run.judge.log" | tail -1)"
  fi
  if [[ "$EVAL" -gt 0 ]]; then
    "$HERE/bench.sh" eval ${arm[@]+"${arm[@]}"} --run "$run" --set "$set_name" --only "$cases" --judge codex --rounds "$EVAL" \
      > "$QCR_BENCH_RUNS_DIR/$run.eval.log" 2>&1 || { echo "$run: AACR eval FAILED — see $run.eval.log"; rc=1; }
    echo "$run: AACR eval done $(date +%T)"
  fi
  return "$rc"
}

# Repeats run one after another (sets within a repeat in parallel), so a
# repeat never competes with its own twin for the one login.
fail=0
for ((k = 1; k <= REPEAT; k++)); do
  p="$PREFIX"; [[ "$REPEAT" -gt 1 ]] && p="$PREFIX-r$k"
  START=$(date +%s); pids=()
  for j in "${jobs[@]}"; do one "${j%%|*}" "${j#*|}" "$p" & pids+=($!); done
  for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
done
echo "arm $PREFIX done $(date +%T)$([[ $fail == 1 ]] && echo ' — WITH FAILURES (see above)')"
exit "$fail"
