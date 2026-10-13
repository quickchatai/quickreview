#!/usr/bin/env bash
# GLM-5.3 Flash (DigitalOcean Gradient) as QuickReview's reviewer on AACR, Martian
# and Qodo, every PR judged by GPT-6.1 Sol. Runbook: bench/aacr/docs/DIGITALOCEAN.md.
#
#   glm-bench.sh build                 both images from master HEAD in a clean temporary worktree
#   glm-bench.sh preflight             checks only — no inference, no review, no judge
#   glm-bench.sh smoke [--go]          10-PR smoke on the built image (all 10 slots), then
#                                      gate + concurrency report + GPT-6.1 judge
#   glm-bench.sh score-smoke [--go]    gate + GPT-6.1 judge the finished smoke on the built image
#   glm-bench.sh full [--go]           prefetch → review 335 PRs (10 at once) → gate → judge
#   glm-bench.sh score-full [--go]     gate + judge an already reviewed full run (resume / rescore)
#
# Without --go a step that spends model money prints what it would run and exits.
# A benchmark run needs the owner's approval; --go is that approval, never a default.
# Every step resumes. Logs and results go to bench/aacr/artifacts/glm-benchmark/ of the
# MAIN checkout (git-ignored), wherever this script is run from.
#
#   EXT_CACHE / EXT_DATA   the external benchmarks' caches (default: ~/qcr-bench-runs/)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../../.." && pwd)"                     # the checkout this script is in
MAIN="$(dirname "$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)")"
OUT="$MAIN/bench/aacr/artifacts/glm-benchmark"
cd "$SRC"

export QCR_BENCH_RUNS_DIR="$OUT/runs"
export EXT_CACHE="${EXT_CACHE:-$HOME/qcr-bench-runs/ext-cache}"
export EXT_DATA="${EXT_DATA:-$HOME/qcr-bench-runs/ext-data}"
export QCR_BENCH_PRIVATE_SETS="$SRC/bench/aacr/sets"

M=digitalocean/glm-5.3-flash
# GLM on every role and tier (the validator runs at sol-high), 12 lenses per PR.
GLM_CONFIG="models.default=$M,models.conversation=$M,models.overseer=$M,models.tiers.terra-med=$M:medium,models.tiers.sol-med=$M:medium,models.tiers.sol-high=$M:high,pi.subagent_max_concurrency=12,pi.subagent_cache_group=0"
JUDGE=openai-codex/gpt-6.1-sol:high

# The smoke's runs are named after the image's commit, so each build smokes afresh.
SMOKE_PREFIX=glm53-smoke-p10-l12   # the first smoke (2026-10-13, image 21c40ad9-dirty)
SMOKE_SETS=(glm-aacr1 glm-aacr-extra3 glm-martian1 glm-martian-extra2 glm-qodo1 glm-qodo-extra2)
FULL_PREFIX=glm53-full
AACR_SETS=(smoke10 dev10 holdout10 fresh10 rest145)   # the published 185-PR AACR comparison
FULL_SETS=("${AACR_SETS[@]}" martian50 qodo-pr100)

die() { echo "glm-bench: $*" >&2; exit 1; }
log() { echo "$(date +%T) glm-bench: $*"; }
join() { local IFS="$1"; shift; echo "$*"; }
inhibit=(); command -v systemd-inhibit >/dev/null && inhibit=(systemd-inhibit --what=sleep:idle --why="qcr GLM benchmark")
scorer_of() { case "$1" in martian*|glm-martian*) echo martian ;; qodo*|glm-qodo*) echo qodo ;; *) echo aacr ;; esac; }

# The image `build` made: one tag for review AND judge (the ext overlay carries the judge bridge).
use_image() {
  [[ -f "$OUT/image.txt" ]] || die "no image yet — run: $0 build"
  IMAGE="$(cat "$OUT/image.txt")"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE is gone — run: $0 build"
  export QCR_BENCH_IMAGE="$IMAGE" QCR_EXT_IMAGE="$IMAGE" QCR_EXT_JUDGE_IMAGE="$IMAGE"
  SMOKE_PREFIX="glm53-smoke-$(sed -n 's/^qcr-bench:glm53-\([0-9a-f]*\)-ext$/\1/p' <<<"$IMAGE")"
  [[ "$SMOKE_PREFIX" != glm53-smoke- ]] || die "unexpected image tag $IMAGE"
}

# Review containers running, every 10 s, until killed: "<epoch> <count>".
sample_containers() {
  while :; do
    echo "$(date +%s) $(docker ps --filter "ancestor=$IMAGE" --format '{{.ID}}' | wc -l)"
    sleep 10
  done >> "$1"
}

# Judge one run with GPT-6.1 Sol. The reviewer's DigitalOcean route is switched off here.
score_one() {
  local run="$1" set="$2"
  log "scoring $run ($(scorer_of "$set"))"
  case "$(scorer_of "$set")" in
    aacr)    env -u QCR_BENCH_PROVIDER QCR_BENCH_AUTH=login "$SRC/bench/aacr/bench.sh" judge \
               --run "$run" --set "$set" --judge-model "$JUDGE" --resume ;;
    martian) env -u QCR_BENCH_PROVIDER QCR_BENCH_AUTH=login EXT_MARTIAN_REJUDGE= \
               "$SRC/bench/aacr/ext/ext.sh" martian "$run" "$set" ;;
    qodo)    env -u QCR_BENCH_PROVIDER QCR_BENCH_AUTH=login \
               "$SRC/bench/aacr/ext/ext.sh" qodo "$run" "$set" --only-tools quickreview ;;
  esac
}

preflight() {
  local bad=0 key="$MAIN/bench/aacr/digitalocean.env"
  export QCR_BENCH_DIGITALOCEAN_ENV="$key"
  [[ "$(stat -c %a "$key" 2>/dev/null)" == 600 ]] && echo "ok   digitalocean.env 0600" || { echo "FAIL $key missing or not 0600"; bad=1; }
  git -C "$MAIN" check-ignore -q "$key" && echo "ok   key file git-ignored" || { echo "FAIL key file not ignored"; bad=1; }
  if [[ -f "$OUT/image.txt" ]] && docker image inspect "$(cat "$OUT/image.txt")" >/dev/null 2>&1; then
    local img label; img="$(cat "$OUT/image.txt")"
    label="$(docker image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^QCR_BENCH_COMMIT=//p')"
    [[ "$label" != *-dirty ]] && echo "ok   image $img (commit $label)" || { echo "FAIL image $img built from a dirty tree"; bad=1; }
  else echo "FAIL no image — run: $0 build"; bad=1; fi
  docker volume inspect qcr-bench-repos >/dev/null 2>&1 && echo "ok   repo cache volume" || { echo "FAIL qcr-bench-repos volume missing"; bad=1; }
  [[ -d "$EXT_CACHE/martian" && -d "$EXT_CACHE/qodo" && -d "$EXT_DATA" ]] && echo "ok   ext cache + data" || { echo "FAIL $EXT_CACHE or $EXT_DATA incomplete"; bad=1; }
  local s; for s in "${FULL_SETS[@]}" "${SMOKE_SETS[@]}"; do [[ -f "bench/aacr/sets/$s.json" ]] || { echo "FAIL set $s missing"; bad=1; }; done
  echo "ok   sets: ${FULL_SETS[*]}"
  local avail; avail=$(df --output=avail -BG "$MAIN" | tail -1 | tr -dc 0-9)
  echo "info disk free ${avail}G, mem available $(free -g | awk '/Mem/{print $7}')G"
  (( avail >= 40 )) || { echo "FAIL under 40G free disk"; bad=1; }
  if docker ps --format '{{.Image}}' | grep -q '^qcr-bench'; then echo "FAIL a qcr-bench container is already running"; bad=1; else echo "ok   no bench container running"; fi
  return $bad
}

mkdir -p "$QCR_BENCH_RUNS_DIR"
export QCR_BENCH_DIGITALOCEAN_ENV="$MAIN/bench/aacr/digitalocean.env"
cmd="${1:-}"; go=0; [[ "${2:-}" == --go ]] && go=1
case "$cmd" in
  build)
    head="$(git -C "$MAIN" rev-parse master)"
    base="qcr-bench:glm53-${head:0:8}"; ext="$base-ext"
    wt="$(mktemp -d)"; rmdir "$wt"
    git -C "$MAIN" worktree add --detach "$wt" "$head" >/dev/null
    trap 'git -C "$MAIN" worktree remove --force "$wt" 2>/dev/null || true' EXIT
    ln -s "$MAIN/node_modules" "$wt/node_modules"
    log "building $base from master $head"
    ( cd "$wt" && QCR_BENCH_IMAGE="$base" bash bench/aacr/bench.sh build )
    log "building the judge/scorer overlay $ext"
    ( cd "$wt" && QCR_EXT_BASE="$base" QCR_EXT_IMAGE="$ext" bash bench/aacr/ext/ext.sh build )
    for i in "$base" "$ext"; do
      label="$(docker image inspect "$i" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^QCR_BENCH_COMMIT=//p')"
      [[ "$label" == "$head" ]] || die "$i is labelled '$label', not master $head"
    done
    echo "$ext" > "$OUT/image.txt"
    log "image $ext (master $head) → $OUT/image.txt" ;;

  preflight) preflight ;;

  smoke)
    preflight || die "preflight failed"
    use_image
    if (( ! go )); then
      echo "would run on $IMAGE: arm.sh --prefix $SMOKE_PREFIX --cases $(join + "${SMOKE_SETS[@]}") --parallel 10 --retries 0 --resume --no-judge"
      echo "  (10 PRs: 4 AACR, 3 Martian, 3 Qodo — every slot busy), then: $0 score-smoke --go"
      echo "glm-bench: nothing run — add --go (needs the owner's approval)"; exit 0
    fi
    for s in "${SMOKE_SETS[@]}"; do
      case "$(scorer_of "$s")" in
        aacr) "$SRC/bench/aacr/bench.sh" prefetch --set "$s" ;;
        *)    "$SRC/bench/aacr/ext/ext.sh" prefetch "$s" ;;
      esac
    done
    samples="$OUT/containers-$SMOKE_PREFIX.log"
    sample_containers "$samples" & sampler=$!
    trap 'kill "$sampler" 2>/dev/null || true' EXIT
    log "reviewing $(join + "${SMOKE_SETS[@]}") on $IMAGE"
    QCR_BENCH_PROVIDER=digitalocean ${inhibit[@]+"${inhibit[@]}"} "$SRC/bench/aacr/arm.sh" \
      --prefix "$SMOKE_PREFIX" --config "$GLM_CONFIG" --cases "$(join + "${SMOKE_SETS[@]}")" \
      --parallel 10 --no-judge --retries 0 --resume > "$OUT/reviews-$SMOKE_PREFIX.log" 2>&1 \
      || log "arm.sh reported failures"
    kill "$sampler" 2>/dev/null || true
    python3 -I "$HERE/concurrency.py" --runs-dir "$QCR_BENCH_RUNS_DIR" --prefix "$SMOKE_PREFIX" \
      --sets "$(join , "${SMOKE_SETS[@]}")" --samples "$samples" | tee "$OUT/concurrency-$SMOKE_PREFIX.txt"
    exec "$0" score-smoke --go ;;

  score-smoke)
    use_image
    python3 -I "$HERE/gate.py" --runs-dir "$QCR_BENCH_RUNS_DIR" --prefix "$SMOKE_PREFIX" \
      --sets "$(join , "${SMOKE_SETS[@]}")" --strict --out "$OUT/gate-$SMOKE_PREFIX.json"
    (( go )) || { echo "glm-bench: gate passed; nothing judged — add --go"; exit 0; }
    for s in glm-martian1 glm-martian-extra2 glm-qodo1 glm-qodo-extra2; do "$SRC/bench/aacr/ext/ext.sh" prefetch "$s"; done
    for s in "${SMOKE_SETS[@]}"; do
      score_one "$SMOKE_PREFIX-$s" "$s" > "$OUT/score-$SMOKE_PREFIX-$s.log" 2>&1 || log "$s: scoring failed (score-$SMOKE_PREFIX-$s.log)"
    done
    log "smoke scored — score-$SMOKE_PREFIX-*.log; reports under $QCR_BENCH_RUNS_DIR/$SMOKE_PREFIX-*" ;;

  full)
    preflight || die "preflight failed"
    use_image
    if (( ! go )); then
      echo "would run on $IMAGE: prefetch ${FULL_SETS[*]};"
      echo "  arm.sh --prefix $FULL_PREFIX --cases $(join + "${FULL_SETS[@]}") --parallel 10 --retries 1 --resume --no-judge (QCR_BENCH_PROVIDER=digitalocean)"
      echo "  then: $0 score-full --go"
      echo "glm-bench: nothing run — add --go (needs the owner's approval)"; exit 0
    fi
    for s in "${AACR_SETS[@]}"; do "$SRC/bench/aacr/bench.sh" prefetch --set "$s"; done
    "$SRC/bench/aacr/ext/ext.sh" prefetch martian50
    "$SRC/bench/aacr/ext/ext.sh" prefetch qodo-pr100
    log "reviewing $(join + "${FULL_SETS[@]}") on $IMAGE"
    QCR_BENCH_PROVIDER=digitalocean ${inhibit[@]+"${inhibit[@]}"} "$SRC/bench/aacr/arm.sh" \
      --prefix "$FULL_PREFIX" --config "$GLM_CONFIG" --cases "$(join + "${FULL_SETS[@]}")" \
      --parallel 10 --no-judge --retries 1 --resume > "$OUT/reviews-full.log" 2>&1 \
      || log "arm.sh reported failures — gating and scoring what finished"
    exec "$0" score-full --go ;;

  score-full)
    use_image
    # A reviewer call on any model but GLM → exit 1 here and nothing is scored.
    python3 -I "$HERE/gate.py" --runs-dir "$QCR_BENCH_RUNS_DIR" --prefix "$FULL_PREFIX" \
      --sets "$(join , "${FULL_SETS[@]}")" --out "$OUT/gate-full.json"
    (( go )) || { echo "glm-bench: nothing judged — add --go"; exit 0; }
    for s in "${FULL_SETS[@]}"; do
      score_one "$FULL_PREFIX-$s" "$s" > "$OUT/score-full-$s.log" 2>&1 || log "$s: scoring failed (score-full-$s.log)"
    done
    runs=(); yield=()
    for s in "${FULL_SETS[@]}"; do runs+=(--run "$FULL_PREFIX-$s"); yield+=(--run "$(scorer_of "$s"):$FULL_PREFIX-$s"); done
    python3 bench/aacr/dup_stats.py --runs-dir "$QCR_BENCH_RUNS_DIR" "${runs[@]}" > "$OUT/full-dup_stats.md" 2>&1 || true
    python3 bench/aacr/lens_yield.py --runs-dir "$QCR_BENCH_RUNS_DIR" "${yield[@]}" > "$OUT/full-lens_yield.md" 2>&1 || true
    log "done — gate-full.json (cost, time, failures), score-full-*.log, full-*.md" ;;

  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
