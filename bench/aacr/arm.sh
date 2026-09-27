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
#   --concurrency N   reviews at once per set (default 2)
#   --no-judge        review only
#
# Compare arms afterwards with bench/aacr/compare.py. Keep QCR_BENCH_RUNS_DIR
# outside any worktree so runs survive and can be re-judged; one image serves
# every arm of an experiment (QCR_BENCH_IMAGE), the levers ride --config.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR to a directory outside any worktree}"
export QCR_BENCH_RUNS_DIR

PREFIX="" CONFIG="" CASES="" CONC=2 JUDGE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --cases) CASES="$2"; shift 2 ;;
    --concurrency) CONC="$2"; shift 2 ;;
    --no-judge) JUDGE=0; shift ;;
    *) echo "unknown flag $1 (see the header of $0)" >&2; exit 2 ;;
  esac
done
[[ -n "$PREFIX" && -n "$CASES" ]] || { echo "--prefix and --cases are required" >&2; exit 2; }

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
    *:*) jobs+=("${g%%:*}|${g#*:}") ;;
    *) jobs+=("$g|") ;;
  esac
done
for j in "${jobs[@]}"; do
  set_name="${j%%|*}"
  [[ -f "$HERE/sets/$set_name.json" ]] || { echo "no case set $set_name" >&2; exit 2; }
done

one() { # set ids
  local set_name="$1" ids="$2" run="$PREFIX-$1" only=() cfg=()
  [[ -n "$ids" ]] && only=(--only "$ids")
  [[ -n "$CONFIG" ]] && cfg=(--config "$CONFIG")
  "$HERE/bench.sh" review --run "$run" --set "$set_name" ${only[@]+"${only[@]}"} \
    --concurrency "$CONC" ${cfg[@]+"${cfg[@]}"} > "$QCR_BENCH_RUNS_DIR/$run.review.log" 2>&1
  echo "$run: review exit $? $(date +%T)"
  [[ "$JUDGE" == 1 ]] || return 0
  # Judge ONLY this run's own cases — without --only the judge scores every
  # other PR of the set as an empty review.
  local cases
  cases=$(python3 -c "import json,sys; print(','.join(json.load(open(sys.argv[1]))['cases']))" \
    "$QCR_BENCH_RUNS_DIR/$run/run.json")
  "$HERE/bench.sh" judge --run "$run" --set "$set_name" --only "$cases" --concurrency 4 \
    > "$QCR_BENCH_RUNS_DIR/$run.judge.log" 2>&1
  "$HERE/bench.sh" judge --run "$run" --set "$set_name" --only "$cases" --concurrency 4 --resume \
    >> "$QCR_BENCH_RUNS_DIR/$run.judge.log" 2>&1
  echo "$run: $(grep 'judged —' "$QCR_BENCH_RUNS_DIR/$run.judge.log" | tail -1)"
}

for j in "${jobs[@]}"; do one "${j%%|*}" "${j#*|}" & done
wait
echo "arm $PREFIX done $(date +%T)"
