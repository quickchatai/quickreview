#!/usr/bin/env bash
# External benchmarks for QuickReview — Martian's offline code-review benchmark
# and SWE-PRBench — each scored by ITS OWN evaluation code, unmodified, with
# QuickReview plugged in as one more tool. bench/aacr/EXTERNAL-BENCHMARKS.md is
# the design, the deviations and the results; this script is every command.
#
#   ext.sh build                      the three images (reviewer overlay, Martian, SWE-PRBench)
#   ext.sh prefetch SET               per-case stores for SET (martian-*, sweprbench-*), from the
#                                     local caches first ($EXT_CACHE), read-only
#   ext.sh review SET [arm.sh flags]  QuickReview `default` on gpt-6.1-sol, exactly the final
#                                     comparison's arm (image qcr-bench:pi099-ext, --config $DEFAULT)
#   ext.sh martian RUN SET            step 1 adapter + Martian's steps 2/2.5/3 + score_profiles,
#                                     judge gpt-6.1-sol; also re-judges three published tools
#   ext.sh sweprbench RUN SET         export + replay + SWE-PRBench's run_eval.py, judge gpt-6.1-sol
#   ext.sh qodo RUN|none SET          Qodo PR-Review-Bench: QuickReview (RUN) and the nine published
#                                     vendor runs, ONE judge (gpt-6.1-sol) for all — qodo_judge.py
#   A RUN of a third-party arm (pragent, opencode, … — its <run>.arm.json) is scored under that
#   arm's tool name (martian_ingest.py ARM_TOOLS) with the same steps; add `--only-tools <name>`
#   to qodo and EXT_MARTIAN_REJUDGE= (empty) to martian to judge that tool alone.
#
#   QCR_BENCH_RUNS_DIR   where runs live (required; outside any worktree)
#   EXT_CACHE            the local bare git caches (default $QCR_BENCH_RUNS_DIR/../ext-cache)
#   EXT_DATA             the pinned benchmark data (default $QCR_BENCH_RUNS_DIR/../ext-data)
#   EXT_JUDGE_EFFORT     the judge's reasoning effort (default low — see EXTERNAL-BENCHMARKS.md)
#
# Sandboxing: every container runs read-only, all capabilities dropped,
# no-new-privileges, as your uid. The two scoring containers have NO network
# but an `--internal` docker network shared with the judge (and, for
# SWE-PRBench, the replay); only the judge container has egress, for the
# model API, holding the refresh-disabled copy of the pi login.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AACR="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$AACR/../.." && pwd)"
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR (outside any worktree)}"
export QCR_BENCH_RUNS_DIR
ROOTDIR="$(cd "$QCR_BENCH_RUNS_DIR/.." && pwd)"
EXT_CACHE="${EXT_CACHE:-$ROOTDIR/ext-cache}"
EXT_DATA="${EXT_DATA:-$ROOTDIR/ext-data}"
QIMG="${QCR_EXT_IMAGE:-qcr-bench:pi099-ext}"
# The judge (ext_judge.py) and the Qodo scorer (qodo_judge.py) run on the ext
# OVERLAY image, whatever QCR_EXT_IMAGE names for the REVIEW: a review image
# built from master carries neither script (2026-10-03, the r6 Qodo judge
# failed to start on qcr-bench:r6). QCR_EXT_JUDGE_IMAGE overrides.
JIMG="${QCR_EXT_JUDGE_IMAGE:-qcr-bench:pi099-ext}"
BASE_IMG="${QCR_EXT_BASE:-qcr-bench:pi099}"
MIMG="qcr-ext-martian:e616e84"
SIMG="qcr-ext-sweprbench:379f0bf"
AUTH_VOLUME="${QCR_BENCH_AUTH_VOLUME:-companion-pihome}"
JUDGE_MODEL="gpt-6.1-sol"
JUDGE_EFFORT="${EXT_JUDGE_EFFORT:-low}"
NET_INTERNAL="qcr-ext-internal"
NET_EGRESS="qcr-ext-egress"
M=openai-codex/gpt-6.1-sol
DEFAULT="models.default=$M,models.conversation=$M,models.overseer=$M,models.tiers.terra-med=$M:medium,models.tiers.sol-med=$M:medium,models.tiers.sol-high=$M:high"

die() { echo "ext: $*" >&2; exit 1; }
# The arm that reviewed RUN (its <run>.arm.json; qcr when absent) and the tool
# name its scores carry — martian_ingest.py ARM_TOOLS is the one table.
run_arm() { # run
  python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("arm") or "qcr")
except FileNotFoundError: print("qcr")' "$QCR_BENCH_RUNS_DIR/$1.arm.json"
}
arm_tool() { # arm
  python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); from martian_ingest import ARM_TOOLS; print(ARM_TOOLS[sys.argv[2]])' "$HERE" "$1"
}
log() { echo "$(date +%T) ext: $*"; }

HARDEN=(
  --read-only --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 4096 --user "$(id -u):$(id -g)"
  --tmpfs /tmp:rw,exec,nosuid,size=2g,mode=1777
)

ensure_networks() {
  docker network inspect "$NET_INTERNAL" >/dev/null 2>&1 || docker network create --internal "$NET_INTERNAL" >/dev/null
  docker network inspect "$NET_EGRESS" >/dev/null 2>&1 || docker network create "$NET_EGRESS" >/dev/null
}

wait_health() { # container port
  local i
  for i in $(seq 1 90); do
    docker exec "$1" python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$2/health', timeout=2)" \
      >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs "$1" 2>&1 | tail -20
  die "$1 never answered /health on :$2"
}

# The judge: gpt-6.1-sol through ext_judge.py in the reviewer image, holding the
# refresh-disabled login copy; egress for the model API, plus the internal
# network under a per-run alias `judge-<tag>`. EXT_JUDGE=mock: the plumbing stub instead.
start_judge() { # work tag
  local work="$1" name="qcr-ext-judge-$2"
  # A per-run alias: two scorings at once must never share a judge name
  # (docker DNS would round-robin between their judges).
  JUDGE_HOST="judge-$2"
  ensure_networks
  mkdir -p "$work/judge"
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [[ "${EXT_JUDGE:-}" == mock ]]; then
    docker run -d --rm --name "$name" "${HARDEN[@]}" --network "$NET_INTERNAL" --network-alias "$JUDGE_HOST" \
      --mount "type=bind,src=$HERE/mock_judge.py,dst=/opt/qcr-ext/mock_judge.py,readonly" \
      "$SIMG" python /opt/qcr-ext/mock_judge.py >/dev/null
    echo "MOCK judge — plumbing only; these numbers mean nothing" > "$work/judge/JUDGE.txt"
  else
    docker run -d --rm --name "$name" "${HARDEN[@]}" --memory 2g --cpus 2 --network "$NET_EGRESS" \
      --mount "type=volume,src=$AUTH_VOLUME,dst=/pi-agent-src,volume-subpath=agent,readonly" \
      --mount "type=tmpfs,dst=/pi-agent-src/sessions" \
      --mount "type=bind,src=$work/judge,dst=/judge-out" \
      --entrypoint bash "$JIMG" -c "mkdir -p \"\$HOME\" && node /opt/quickreview/sandbox/dist/src/bench/cli.js auth --need-min 120 \
        && exec python3 /opt/quickreview/bench/ext_judge.py --host 0.0.0.0 --port 8765 --model $JUDGE_MODEL \
           --effort $JUDGE_EFFORT --max-inflight 64 --probe-temperature --log /judge-out/judge.jsonl" >/dev/null
    docker network connect --alias "$JUDGE_HOST" "$NET_INTERNAL" "$name"
    echo "$JUDGE_MODEL, reasoning effort $JUDGE_EFFORT, via bench/aacr/ext/ext_judge.py (ChatGPT login, refresh-disabled copy)" > "$work/judge/JUDGE.txt"
  fi
  wait_health "$name" 8765
  log "judge $name up ($(cat "$work/judge/JUDGE.txt"))"
}

stop_judge() { # tag work
  local name="qcr-ext-judge-$1"
  docker logs "$name" > "$2/judge/container.log" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
}

cmd="${1:-}"; shift || true
case "$cmd" in
  build)
    # 1. The reviewer overlay: the base image + two compiled harness files + data.
    (cd "$REPO" && npm run build >/dev/null)
    ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
    mkdir -p "$ctx/dist-bench" "$ctx/sets"
    cp "$REPO/dist/src/bench/aacr.js" "$REPO/dist/src/bench/prefetch.js" "$ctx/dist-bench/"
    cp "$AACR"/sets/martian*.json "$AACR"/sets/sweprbench*.json "$ctx/sets/"
    cp "$AACR/codex_bridge.py" "$HERE/ext_judge.py" "$ctx/"
    cp "$HERE/Dockerfile.qcr" "$ctx/Dockerfile"
    commit="$(git -C "$REPO" rev-parse HEAD)"
    [[ -z "$(git -C "$REPO" status --porcelain -- src bench/aacr/sets bench/aacr/ext bench/aacr/codex_bridge.py)" ]] || commit="$commit-dirty"
    docker build -q -t "$QIMG" --build-arg "BASE=$BASE_IMG" --build-arg "QCR_EXT_COMMIT=$commit" "$ctx"
    # What the overlay changed in the one file the review path imports: the diff
    # against the base image's compiled aacr.js (prefetch.js runs only in prefetch).
    mkdir -p "$ROOTDIR/ext-images"
    docker run --rm --network none --entrypoint cat "$BASE_IMG" /opt/quickreview/sandbox/dist/src/bench/aacr.js > "$ctx/base-aacr.js"
    diff -u "$ctx/base-aacr.js" "$ctx/dist-bench/aacr.js" > "$ROOTDIR/ext-images/aacr-overlay.diff" || true
    { echo "image $QIMG $(docker image inspect "$QIMG" --format '{{.Id}}')"; echo "base $BASE_IMG $(docker image inspect "$BASE_IMG" --format '{{.Id}}')"; echo "overlay commit $commit"; } > "$ROOTDIR/ext-images/qcr.txt"
    log "built $QIMG (overlay diff: $ROOTDIR/ext-images/aacr-overlay.diff)"
    # 2. The two benchmarks' own harnesses.
    docker build -q -t "$MIMG" -f "$HERE/Dockerfile.martian" "$HERE"
    docker build -q -t "$SIMG" -f "$HERE/Dockerfile.sweprbench" "$HERE"
    docker run --rm --network none --entrypoint cat "$SIMG" /opt/swepr-pip-freeze.txt > "$ROOTDIR/ext-images/sweprbench-pip-freeze.txt"
    for i in "$MIMG" "$SIMG"; do echo "image $i $(docker image inspect "$i" --format '{{.Id}}')"; done >> "$ROOTDIR/ext-images/qcr.txt"
    log "built $MIMG and $SIMG"
    ;;

  prefetch)
    set_name="${1:?usage: ext.sh prefetch SET}"; shift
    f="$AACR/sets/$set_name.json"; [[ -f "$f" ]] || die "no set $f"
    # fetch repo → its cache under $EXT_CACHE (read-only mount at /mirrors).
    mirrors="$(python3 - "$f" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
repos = {}
for c in s["cases"]:
    if "martian" in c:
        repos[c["fetch_repo"]] = f"martian/{c['martian']['project']}.git"
    elif c.get("pr_category") == "qodo-injected":
        repos[c["repo"]] = f"qodo/git/{c['repo'].replace('/', '__')}.git"
    else:
        repos[c["repo"]] = f"sweprbench/{c['repo'].replace('/', '__')}.git"
print(json.dumps({"root": "/mirrors", "repos": repos}))
PY
)"
    QCR_BENCH_IMAGE="$QIMG" QCR_BENCH_PREFETCH_MIRROR="$EXT_CACHE" QCR_BENCH_MIRRORS="$mirrors" \
      "$AACR/bench.sh" prefetch --set "$set_name" "$@"
    ;;

  review)
    set_name="${1:?usage: ext.sh review SET [arm.sh flags]}"; shift
    QCR_BENCH_IMAGE="$QIMG" systemd-inhibit --what=sleep:idle --why="qcr external bench review" \
      "$AACR/arm.sh" --prefix ext-g61 --config "$DEFAULT" --cases "$set_name" --no-judge "$@"
    ;;

  qodo)
    run="${1:?usage: ext.sh qodo RUN|none SET}"; set_name="${2:?usage: ext.sh qodo RUN|none SET}"; shift 2
    f="$AACR/sets/$set_name.json"; [[ -f "$f" ]] || die "no set $f"
    data="$EXT_CACHE/qodo"
    [[ -f "$data/tool-comments.json" ]] || die "no $data/tool-comments.json — run qodo_scrape.py --cache $data build first"
    got="$(sha256sum "$data/git_code_review_bench_100_w_open_prs.jsonl" | cut -d' ' -f1)"
    want="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dataset"]["sha256"])' "$f")"
    [[ "$got" == "$want" ]] || die "the Qodo dataset under $data does not match the set's pin"
    runargs=()
    if [[ "$run" == none ]]; then work="$QCR_BENCH_RUNS_DIR/ext-qodo-vendors-$set_name.qodo"
    else
      [[ -d "$QCR_BENCH_RUNS_DIR/$run/results/all" && ! -L "$QCR_BENCH_RUNS_DIR/$run" ]] || die "no finished run $run"
      work="$QCR_BENCH_RUNS_DIR/$run.qodo"; runargs=(--run /run --run-tool "$(arm_tool "$(run_arm "$run")")")
    fi
    [[ "${EXT_JUDGE:-}" == mock ]] && work="$work-MOCK"
    mkdir -p "$work"   # resumable: qodo_judge.py caches every judgement in $work/judgements.jsonl
    start_judge "$work" "q-$$"
    trap 'stop_judge "q-$$" "$work"' EXIT
    mounts=(--mount "type=bind,src=$HERE,dst=/ext,readonly" --mount "type=bind,src=$f,dst=/set.json,readonly"
            --mount "type=bind,src=$data,dst=/data,readonly" --mount "type=bind,src=$work,dst=/work")
    [[ "$run" != none ]] && mounts+=(--mount "type=bind,src=$QCR_BENCH_RUNS_DIR/$run,dst=/run,readonly")
    log "Qodo PR-Review-Bench judge (gpt-6.1-sol @ $JUDGE_EFFORT, one judge for every tool) in $work"
    docker run --rm "${HARDEN[@]}" --memory 2g --network "$NET_INTERNAL" "${mounts[@]}" --entrypoint python3 "$JIMG" \
      /ext/qodo_judge.py --set /set.json --gt /data/git_code_review_bench_100_w_open_prs.jsonl \
        --tools /data/tool-comments.json ${runargs[@]+"${runargs[@]}"} \
        --endpoint "http://$JUDGE_HOST:8765/v1/chat/completions" --out /work "$@" | tee -a "$work/judge.log"
    ;;

  martian)
    run="${1:?usage: ext.sh martian RUN|none SET}"; set_name="${2:?usage: ext.sh martian RUN|none SET}"
    f="$AACR/sets/$set_name.json"; [[ -f "$f" ]] || die "no set $f"
    # Unset: re-judge the three published comparators beside RUN; set empty: none.
    tools="${EXT_MARTIAN_REJUDGE-qodo-extended-v2,cubic-v2,claude-code}"
    rej=""; for t in ${tools//,/ }; do rej="$rej,rejudged-$t"; done
    if [[ "$run" == none ]]; then work="$QCR_BENCH_RUNS_DIR/ext-calibration-$set_name${EXT_CALIB_TAG:+-$EXT_CALIB_TAG}.martian"; qr=(--no-quickreview)
    else
      [[ -d "$QCR_BENCH_RUNS_DIR/$run/cases" && ! -L "$QCR_BENCH_RUNS_DIR/$run" ]] || die "no run $run"
      work="$QCR_BENCH_RUNS_DIR/$run.martian"; qr=(--arm "$(run_arm "$run")")
    fi
    [[ "${EXT_JUDGE:-}" == mock ]] && work="$work-MOCK"
    [[ ! -e "$work" ]] || die "$work exists — move it away first (scores are never overwritten)"
    mkdir -p "$work/results" "$work/logs"
    # Step 1, QuickReview's: the record step1_download_prs.py builds from GitHub.
    docker run --rm --network none --entrypoint cat "$MIMG" /opt/martian/offline/results/benchmark_data.json > "$work/published-benchmark_data.json"
    python3 "$HERE/martian_ingest.py" --run "$QCR_BENCH_RUNS_DIR/$run" --set "$f" \
      --published "$work/published-benchmark_data.json" --out "$work/results/benchmark_data.json" \
      --rejudge "$tools" ${qr[@]+"${qr[@]}"} | tee "$work/logs/ingest.log"
    start_judge "$work" "m-$$"
    trap 'stop_judge "m-$$" "$work"' EXIT
    # Steps 2, 2.5, 3 and the profile scorer — THEIR code, run as their README
    # says, in their image, with the judge as the only reachable host. Step 2
    # and step 3 are incremental and re-run until they report no errors (their
    # README: "Re-run to retry"), at most three times each.
    log "Martian pipeline (judge $JUDGE_MODEL @ $JUDGE_EFFORT) in $work"
    docker run --rm "${HARDEN[@]}" --memory 4g --cpus 4 --network "$NET_INTERNAL" \
      -e MARTIAN_API_KEY=local -e "MARTIAN_BASE_URL=http://$JUDGE_HOST:8765/v1" -e "MARTIAN_MODEL=$JUDGE_MODEL" \
      -e "TOOLS=$tools" -e "MODEL=$JUDGE_MODEL" \
      --mount "type=bind,src=$work,dst=/work" \
      --mount "type=bind,src=$HERE/martian_report.py,dst=/opt/qcr-ext/martian_report.py,readonly" \
      "$MIMG" bash -c '
        set -euo pipefail
        cd /work
        cp -r /opt/martian/offline/golden_comments golden_comments
        for i in 1 2 3; do
          python -m code_review_benchmark.step2_extract_comments > logs/step2-$i.log 2>&1
          e=$(grep -E "^  Errors: [0-9]+" logs/step2-$i.log | grep -oE "[0-9]+$" || echo 0)
          echo "step2 pass $i: $e error(s)"; [[ "$e" == 0 ]] && break
        done
        python -m code_review_benchmark.step2_5_dedup_candidates > logs/step2_5.log 2>&1
        grep -E "Succeeded|Fallbacks" logs/step2_5.log || true
        for i in 1 2 3; do
          python -m code_review_benchmark.step3_judge_comments --dedup-groups "results/$MODEL/dedup_groups.json" > logs/step3-$i.log 2>&1
          n=$(python -c "import json; e=json.load(open(\"results/$MODEL/evaluations.json\")); print(sum(int(v.get(\"errors_count\",0)) for t in e.values() for v in t.values()))")
          echo "step3 pass $i: $n judge-call error(s) left"; [[ "$n" == 0 ]] && break
        done
        python -m analysis.score_profiles --results-dir results --model "$MODEL" --all-profiles --beta 2 > score_profiles.txt
        cd /work && PYTHONPATH=/opt/martian/offline python /opt/qcr-ext/martian_report.py --results results \
          --model-dir "$MODEL" --tools "$TOOLS" --out martian-scores.json > martian-report.md
      ' 2>&1 | tee "$work/logs/pipeline.log"
    cat "$work/score_profiles.txt" "$work/martian-report.md"
    ;;

  sweprbench)
    run="${1:?usage: ext.sh sweprbench RUN SET}"; set_name="${2:?usage: ext.sh sweprbench RUN SET}"
    f="$AACR/sets/$set_name.json"; [[ -f "$f" ]] || die "no set $f"
    [[ -d "$QCR_BENCH_RUNS_DIR/$run/results/all" && ! -L "$QCR_BENCH_RUNS_DIR/$run" ]] || die "no finished run $run"
    data="$EXT_DATA/swe-prbench-b87f579"
    (cd "$data" && sha256sum --quiet -c "$HERE/sweprbench/dataset-manifest.sha256") \
      || die "the SWE-PRBench data under $data does not match the pinned manifest"
    work="$QCR_BENCH_RUNS_DIR/$run.sweprbench"
    [[ "${EXT_JUDGE:-}" == mock ]] && work="$work-MOCK"
    [[ ! -e "$work" ]] || die "$work exists — move it away first (scores are never overwritten)"
    mkdir -p "$work"
    python3 "$HERE/sweprbench_export.py" --run "$QCR_BENCH_RUNS_DIR/$run" --set "$f" --data "$data/dataset" \
      --out "$work/replay-table.json" | tee "$work/export.log"
    ids="$(python3 -c 'import json,sys; print(" ".join(c["task_id"] for c in json.load(open(sys.argv[1]))["cases"]))' "$f")"
    # The harness's model config: its own format, our two endpoints (THEIR
    # run_eval.py reads it; defaults.judge_model fixes the judge as theirs does).
    cat > "$work/model_endpoints.yaml" <<YAML
defaults:
  judge_model: gpt_6_1_sol
  configs: [A, B, C]
  batch_api: false
providers: {}
judge:
  gpt_6_1_sol:
    provider: openai
    model: $JUDGE_MODEL
    base_url: http://JUDGE_HOST_PLACEHOLDER:8765/v1
    api_key_env: JUDGE_API_KEY
    note: "gpt-6.1-sol @ $JUDGE_EFFORT through bench/aacr/ext/ext_judge.py (the published judge is GPT-5.2)"
models:
  quickreview:
    provider: openai_compatible
    model: quickreview-default-gpt-6.1-sol
    base_url: http://REPLAY_HOST_PLACEHOLDER:8790/v1
    api_key_env: REPLAY_API_KEY
    note: "QuickReview default preset, reviewed beforehand (run $run), replayed by bench/aacr/ext/replay_server.py"
YAML
    docker run --rm --network none --entrypoint cat "$SIMG" /opt/swepr-pip-freeze.txt > "$work/pip-freeze.txt"
    start_judge "$work" "s-$$"
    rname="qcr-ext-replay-s-$$"
    sed -i "s/JUDGE_HOST_PLACEHOLDER/$JUDGE_HOST/; s/REPLAY_HOST_PLACEHOLDER/replay-s-$$/" "$work/model_endpoints.yaml"
    trap 'docker logs "$rname" > "$work/replay-container.log" 2>&1 || true; docker rm -f "$rname" >/dev/null 2>&1 || true; stop_judge "s-$$" "$work"' EXIT
    docker run -d --rm --name "$rname" "${HARDEN[@]}" --memory 1g --network "$NET_INTERNAL" --network-alias "replay-s-$$" \
      --mount "type=bind,src=$work,dst=/work" "$SIMG" \
      python /opt/qcr-ext/replay_server.py --table /work/replay-table.json --log /work/replay.jsonl >/dev/null
    wait_health "$rname" 8790
    log "SWE-PRBench run_eval.py (judge $JUDGE_MODEL @ $JUDGE_EFFORT) in $work"
    docker run --rm "${HARDEN[@]}" --memory 6g --cpus 4 --network "$NET_INTERNAL" \
      -e HF_HOME=/hf -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e JUDGE_API_KEY=local -e REPLAY_API_KEY=local \
      -e "IDS=$ids" \
      --mount "type=bind,src=$data/dataset,dst=/data,readonly" \
      --mount "type=bind,src=$EXT_CACHE/hf,dst=/hf,readonly" \
      --mount "type=bind,src=$work,dst=/work" \
      "$SIMG" bash -c '
        set -euo pipefail
        # The harness falls back to LEXICAL similarity, silently, when the
        # embedding model does not load. Prove it loads, offline, first.
        python -c "
from eval_harness.matching import SEMANTIC_EMBEDDING_MODEL, _get_embedding_model
m = _get_embedding_model(); v = m.encode([\"x\"])
assert v.shape[1] == 768, v.shape
print(\"embedding model loaded:\", SEMANTIC_EMBEDDING_MODEL, v.shape)"
        python eval_harness/run_eval.py --contexts /data/contexts --annotations /data/annotations \
          --prs /data/prs.jsonl --output /work/runs --model-config /work/model_endpoints.yaml \
          --model quickreview --task-ids $IDS --configs A B C --concurrency 4
      ' > "$work/run_eval.log" 2>&1 || { tail -30 "$work/run_eval.log"; die "run_eval failed (see $work/run_eval.log)"; }
    grep -m1 'embedding model loaded' "$work/run_eval.log"
    python3 "$HERE/sweprbench_report.py" "$work" "$set_name" | tee "$work/table8.md"
    ;;

  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
