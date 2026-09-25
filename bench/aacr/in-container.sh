#!/usr/bin/env bash
# Entrypoint of the qcr-bench image. bench.sh (on the host) decides the mounts
# and the network; this script only dispatches, inside them.
#
#   prefetch <set> [cli flags…]   → node cli prefetch
#   review   <set> [cli flags…]   → node cli review --out /bench-out
#   eval     <set> <judge> <rounds> [--only ids]
#   report   <set> [--only ids]
#   results  <set> [--only ids]   rebuild the scored files from the case dirs
#   agents   [--profile NAME]
#   shell                          an interactive shell in the same sandbox
set -euo pipefail

ROOT=/opt/quickreview/sandbox
CLI=(node "$ROOT/dist/src/bench/cli.js")
SETS=/opt/quickreview/bench/sets
mkdir -p "$HOME"
# Seed the project .pi/ (a tmpfs under the read-only root) from the baked copy.
if [[ -w "$ROOT/.pi" && ! -e "$ROOT/.pi/settings.json" ]]; then
  cp -r /opt/quickreview/bench/pi-project/. "$ROOT/.pi/"
  mkdir -p "$ROOT/.pi/agents"
fi

set_file() {
  local f="$SETS/$1.json"
  [[ -f "$f" ]] || { echo "unknown set '$1' (have: $(ls "$SETS" | sed 's/\.json$//' | tr '\n' ' '))" >&2; exit 2; }
  echo "$f"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  prefetch)
    set_name="$1"; shift
    exec "${CLI[@]}" prefetch --set "$(set_file "$set_name")" --store /repos "$@" ;;
  review)
    set_name="$1"; shift
    exec "${CLI[@]}" review --set "$(set_file "$set_name")" --store /repos --out /bench-out "$@" ;;
  report)
    set_name="$1"; shift
    exec "${CLI[@]}" report --set "$(set_file "$set_name")" --out /bench-out "$@" ;;
  results)
    set_name="$1"; shift
    exec "${CLI[@]}" results --set "$(set_file "$set_name")" --out /bench-out "$@" ;;
  agents)
    exec "${CLI[@]}" agents "$@" ;;
  eval)
    set_name="$1"; judge="$2"; rounds="$3"; shift 3
    set_path="$(set_file "$set_name")"
    mkdir -p /bench-out/eval
    subset="/bench-out/eval/aacr_bench_v1_${set_name}.jsonl"
    "${CLI[@]}" subset --set "$set_path" --dataset /opt/aacr-data/aacr_bench_v1.jsonl --out "$subset" "$@"
    expected="$(grep -c . "$subset")"
    shim_pid=""
    case "$judge" in
      mock)
        export JUDGE_USE_MOCK=true
        echo "MOCK — the harness's local string similarity. Plumbing check only; these numbers mean nothing." > /bench-out/judge.txt ;;
      openai)
        : "${JUDGE_BASE_URL:?openai judge needs JUDGE_BASE_URL (bench/aacr/judge.env)}"
        : "${JUDGE_API_KEY:?openai judge needs JUDGE_API_KEY (bench/aacr/judge.env)}"
        : "${JUDGE_MODEL:?openai judge needs JUDGE_MODEL (bench/aacr/judge.env)}"
        export JUDGE_USE_MOCK=false
        echo "\`${JUDGE_MODEL}\` via an OpenAI-compatible endpoint, temperature 0.7 (the harness default), ${rounds} round(s) averaged" > /bench-out/judge.txt ;;
      codex)
        model="${JUDGE_CODEX_MODEL:-openai-codex/gpt-5.6-terra:low}"
        # The same read-only, refresh-disabled token copy the review uses.
        "${CLI[@]}" auth --need-min 180 || { echo "judge: no usable pi login (see above)" >&2; exit 1; }
        python3 /opt/quickreview/bench/judge_shim.py --port 8765 --model "$model" > /bench-out/eval/judge-shim.log 2>&1 &
        shim_pid=$!
        up=0
        for _ in $(seq 1 50); do
          curl -fsS http://127.0.0.1:8765/health >/dev/null 2>&1 && { up=1; break; }
          sleep 0.2
        done
        [[ "$up" == 1 ]] || { echo "judge shim never answered /health — see eval/judge-shim.log" >&2; kill "$shim_pid" 2>/dev/null || true; exit 1; }
        export JUDGE_USE_MOCK=false JUDGE_BASE_URL=http://127.0.0.1:8765/v1 JUDGE_API_KEY=local JUDGE_MODEL="$model"
        echo "\`${model}\` through the local pi shim (NOT the paper's Qwen3-235B judge — same prompt, different model), ${rounds} round(s) averaged" > /bench-out/judge.txt ;;
      *) echo "judge must be mock | openai | codex" >&2; exit 2 ;;
    esac
    status=0
    for variant in all no-nits blockers; do
      dir="/bench-out/results/$variant"
      [[ -d "$dir" ]] || { echo "no results for variant $variant — run review first" >&2; status=1; continue; }
      rm -f "$dir"/metrics_ocr_*.json
      echo "== eval: $variant ($expected instances, judge $judge, $rounds round(s))" >&2
      ( cd /opt/aacr-bench/evaluation && /opt/aacr-venv/bin/python -m pipeline run --stage eval --reviewer ocr \
          --dataset "$subset" --results-dir "$dir" --eval-rounds "$rounds" --line-k 1 ) \
        > "/bench-out/eval/harness-$variant.log" 2>&1 || { echo "harness failed for $variant — see eval/harness-$variant.log" >&2; status=1; continue; }
      # A judge call that errors is scored by the harness as a NON-match
      # (judge.py) and the run still exits 0 — deflated numbers that look
      # real. Count them and refuse to call the result clean.
      errs="$(grep -c '裁判模型调用失败' "/bench-out/eval/harness-$variant.log" || true)"
      if [[ "${errs:-0}" != "0" ]]; then
        echo "JUDGE ERRORS for $variant: $errs call(s) failed and were scored as non-matches" >&2
        echo "- WARNING ($variant): $errs judge call(s) FAILED and were scored as non-matches — the semantic numbers are deflated (eval/harness-$variant.log)" >> /bench-out/judge.txt
        status=1
      fi
      # The scorer silently skips an instance with no result file; refuse a
      # number built on fewer instances than the set has — in EVERY round
      # (the averaged file carries floats, so the per-round files are read).
      got="$(python3 - "$dir" "$rounds" <<'PY'
import glob, json, sys
files = [f for f in sorted(glob.glob(sys.argv[1] + "/metrics_ocr_*.json")) if "average" not in f]
if len(files) != int(sys.argv[2]):
    print(f"{len(files)}-of-{sys.argv[2]}-rounds")
else:
    print(min(int(json.load(open(f))["summary"]["evaluated_instances"]) for f in files))
PY
)"
      if [[ "$got" != "$expected" ]]; then
        echo "EVAL INCOMPLETE for $variant: scored $got of $expected instances" >&2
        echo "- WARNING ($variant): EVAL INCOMPLETE — scored $got of $expected instances" >> /bench-out/judge.txt
        status=1
      fi
    done
    [[ -n "$shim_pid" ]] && kill "$shim_pid" 2>/dev/null || true
    "${CLI[@]}" report --set "$set_path" --out /bench-out "$@"
    exit "$status" ;;
  shell)
    exec bash ;;
  *)
    sed -n '2,12p' "$0"; exit 2 ;;
esac
