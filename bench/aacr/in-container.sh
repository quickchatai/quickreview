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
#   whatif   <set> [--only ids]   what-if variants from /bench-out/source (a copied run)
#   whatif-eval <set> <judge> <rounds> [--only ids]   score the what-if variants
#   whatif-report <set> [--only ids]
#   shell                          an interactive shell in the same sandbox
#
# The open-code-review baseline arm (image target `ocr`):
#   ocr-review <set> [cli flags…] → the loopback Codex bridge + node cli ocr-review
#   eval / report with BENCH_ARM=ocr score and report that arm: only the `all`
#   variant (OCR comments carry no severity tag), the OCR report.
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
    report_cmd=report; [[ "${BENCH_ARM:-qcr}" == ocr ]] && report_cmd=ocr-report
    exec "${CLI[@]}" "$report_cmd" --set "$(set_file "$set_name")" --out /bench-out "$@" ;;
  ocr-review)
    set_name="$1"; shift
    command -v opencodereview >/dev/null || { echo "this image has no open-code-review — build it with: bench.sh build --arm ocr" >&2; exit 2; }
    # The bridge reads the SAME refresh-disabled token copy the review and the
    # judge use (src/bench/auth.ts); `ocr-review` re-takes it before every case.
    "${CLI[@]}" auth --need-min 40 || { echo "ocr: no usable pi login (see above)" >&2; exit 1; }
    python3 /opt/quickreview/bench/codex_bridge.py --port 8766 \
      --model "${OCR_BRIDGE_MODEL:-gpt-6-sol}" --effort "${OCR_BRIDGE_EFFORT:-medium}" \
      --log /bench-out/bridge.jsonl >> /bench-out/bridge.log 2>&1 &
    bridge_pid=$!
    trap 'kill "$bridge_pid" 2>/dev/null || true' EXIT
    up=0
    for _ in $(seq 1 50); do
      curl -fsS http://127.0.0.1:8766/health >/dev/null 2>&1 && { up=1; break; }
      sleep 0.2
    done
    [[ "$up" == 1 ]] || { echo "codex bridge never answered /health — see bridge.log" >&2; exit 1; }
    status=0
    "${CLI[@]}" ocr-review --set "$(set_file "$set_name")" --store /repos --out /bench-out \
      --bridge http://127.0.0.1:8766 "$@" || status=$?
    exit "$status" ;;
  results)
    set_name="$1"; shift
    exec "${CLI[@]}" results --set "$(set_file "$set_name")" --out /bench-out "$@" ;;
  agents)
    exec "${CLI[@]}" agents "$@" ;;
  eval|whatif-eval)
    set_name="$1"; judge="$2"; rounds="$3"; shift 3
    set_path="$(set_file "$set_name")"
    # Which arm this run dir holds (run.json `reviewer`; quickreviewd runs carry
    # none) must be the arm bench.sh was asked to score.
    arm="${BENCH_ARM:-qcr}"
    run_arm="$(python3 -c 'import json,sys
try: print("ocr" if json.load(open(sys.argv[1])).get("reviewer") == "ocr" else "qcr")
except Exception: print("qcr")' /bench-out/run.json)"
    [[ "$run_arm" == "$arm" ]] || { echo "this run dir holds the $run_arm arm — score it with bench.sh eval --arm $run_arm" >&2; exit 2; }
    if [[ "$cmd" == eval ]]; then
      variants="all no-nits blockers"; report_cmd=report
      [[ "$arm" == ocr ]] && { variants="all"; report_cmd=ocr-report; }
    else
      variants="posted posted+killed posted+merged all-candidates"; report_cmd=whatif-report
    fi
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
    # --line-k N (N != 1) is a DIAGNOSTIC: it separates "found the issue" from
    # "put it within one line of the reference". It scores a copy of the `all`
    # results in results/all-k<N>/ and never touches the official ±1 numbers.
    line_k="${QCR_LINE_K:-1}"
    [[ "$line_k" != 1 ]] && variants="all-k$line_k"
    for variant in $variants; do
      dir="/bench-out/results/$variant"
      if [[ "$line_k" != 1 ]]; then
        [[ -d /bench-out/results/all ]] || { echo "no results for variant all — run review first" >&2; status=1; continue; }
        rm -rf "$dir"; mkdir -p "$dir"
        find /bench-out/results/all -maxdepth 1 -name '*.json' ! -name 'metrics_ocr_*' -exec cp {} "$dir"/ \;
      fi
      [[ -d "$dir" ]] || { echo "no results for variant $variant — run review (or whatif) first" >&2; status=1; continue; }
      rm -f "$dir"/metrics_ocr_*.json
      echo "== eval: $variant ($expected instances, judge $judge, $rounds round(s))" >&2
      ( cd /opt/aacr-bench/evaluation && /opt/aacr-venv/bin/python -m pipeline run --stage eval --reviewer ocr \
          --dataset "$subset" --results-dir "$dir" --eval-rounds "$rounds" --line-k "$line_k" ) \
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
    [[ "$line_k" == 1 ]] && "${CLI[@]}" "$report_cmd" --set "$set_path" --out /bench-out "$@"
    exit "$status" ;;
  whatif)
    set_name="$1"; shift
    exec "${CLI[@]}" whatif --set "$(set_file "$set_name")" --out /bench-out "$@" ;;
  whatif-report)
    set_name="$1"; shift
    exec "${CLI[@]}" whatif-report --set "$(set_file "$set_name")" --out /bench-out "$@" ;;
  shell)
    exec bash ;;
  *)
    sed -n '2,19p' "$0"; exit 2 ;;
esac
