#!/usr/bin/env bash
# Open models on DigitalOcean Gradient as QuickReview's reviewer on AACR, Martian
# and Qodo, every PR judged by GPT-6.1 Sol. Runbook: bench/aacr/docs/DIGITALOCEAN.md.
#
#   [MODEL=<id>] openbench.sh build              both images from master HEAD in a clean temporary worktree
#   [MODEL=<id>] openbench.sh preflight          checks only — no inference, no review, no judge
#   [MODEL=<id>] openbench.sh smoke [--go]       10-PR smoke (all 10 slots), then gate +
#                                                concurrency report + GPT-6.1 judge
#   [MODEL=<id>] openbench.sh score-smoke [--go] gate + GPT-6.1 judge the model's latest smoke
#   openbench.sh watch [--prefix P]              live view of the newest run (Ctrl-C quits; read-only)
#   [MODEL=<id>] openbench.sh full [--go]        prefetch → review 335 PRs (PARALLEL at once) → gate → judge
#   [MODEL=<id>] openbench.sh score-full [--go]  gate + judge an already reviewed full run (resume / rescore)
#
# MODEL is a DigitalOcean model id from models.py (default glm-5.3-flash): glm-5.3-flash,
# gemma-4-31B-it, deepseek-v4.1-flash. It runs EVERY reviewer call.
# Without --go a step that spends model money prints what it would run and exits.
# A benchmark run needs the owner's approval; --go is that approval, never a default.
# Every step resumes. Logs and results go to bench/aacr/artifacts/open-models/ of the
# MAIN checkout (git-ignored), wherever this script is run from.
#
#   PARALLEL=N             PR reviews at once in `full` (default 10; the smoke always runs
#                          its 10 PRs at once). The machine is not the limit — a review
#                          is ~250–800 MB and nearly idle CPU — DigitalOcean's capacity is.
#   TIMEOUT_MIN=N          each review's time limit (default 180). The published GPT-6.1 runs used
#                          75; the open models take 54–66 min on the largest AACR PRs.
#   EXT_CACHE / EXT_DATA   the external benchmarks' caches (default: ~/qcr-bench-runs/)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../../.." && pwd)"                     # the checkout this script is in
MAIN="$(dirname "$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)")"
OUT="$MAIN/bench/aacr/artifacts/open-models"
cd "$SRC"

export QCR_BENCH_RUNS_DIR="$OUT/runs"
export EXT_CACHE="${EXT_CACHE:-$HOME/qcr-bench-runs/ext-cache}"
export EXT_DATA="${EXT_DATA:-$HOME/qcr-bench-runs/ext-data}"
export QCR_BENCH_PRIVATE_SETS="$SRC/bench/aacr/sets"

MODEL="${MODEL:-glm-5.3-flash}"
SLUG="$(python3 -I "$HERE/models.py" slug "$MODEL")" || { echo "openbench: unknown MODEL=$MODEL" >&2; exit 2; }
M="digitalocean/$MODEL"
# The model on every role and tier (the validator runs at sol-high), 12 lenses per PR.
# use_image adds the image config's [models.pass_models] pins (lenses pinned to
# another model, e.g. gpt-6-luna) re-pointed at the model, each keeping its own effort.
MODEL_CONFIG="models.default=$M,models.conversation=$M,models.overseer=$M,models.tiers.terra-med=$M:medium,models.tiers.sol-med=$M:medium,models.tiers.sol-high=$M:high,pi.subagent_max_concurrency=12,pi.subagent_cache_group=0"
JUDGE=openai-codex/gpt-6.1-sol:high

# Each smoke launch gets its own run name (model + image commit + launch time), kept in
# smoke-prefix-<slug>.txt for score-smoke and the live view.
SMOKE_PREFIX=""
SMOKE_SETS=(glm-aacr1 glm-aacr-extra3 glm-martian1 glm-martian-extra2 glm-qodo1 glm-qodo-extra2)
FULL_PREFIX="$SLUG-full"
PARALLEL="${PARALLEL:-10}"
[[ "$PARALLEL" =~ ^[1-9][0-9]?$ ]] || { echo "openbench: PARALLEL must be 1..99" >&2; exit 2; }
TIMEOUT_MIN="${TIMEOUT_MIN:-180}"
[[ "$TIMEOUT_MIN" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "openbench: TIMEOUT_MIN must be minutes" >&2; exit 2; }
AACR_SETS=(smoke10 dev10 holdout10 fresh10 rest145)   # the published 185-PR AACR comparison
FULL_SETS=("${AACR_SETS[@]}" martian50 qodo-pr100)

die() { echo "openbench: $*" >&2; exit 1; }
log() { echo "$(date +%T) openbench[$MODEL]: $*"; }
join() { local IFS="$1"; shift; echo "$*"; }
inhibit=(); command -v systemd-inhibit >/dev/null && inhibit=(systemd-inhibit --what=sleep:idle --why="qcr open-model benchmark")
scorer_of() { case "$1" in martian*|glm-martian*) echo martian ;; qodo*|glm-qodo*) echo qodo ;; *) echo aacr ;; esac; }

# The image `build` made: one tag for review AND judge (the ext overlay carries the judge bridge).
use_image() {
  [[ -f "$OUT/image.txt" ]] || die "no image yet — run: $0 build"
  IMAGE="$(cat "$OUT/image.txt")"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE is gone — run: $0 build"
  export QCR_BENCH_IMAGE="$IMAGE" QCR_EXT_IMAGE="$IMAGE" QCR_EXT_JUDGE_IMAGE="$IMAGE"
  [[ -f "$OUT/smoke-prefix-$SLUG.txt" ]] && SMOKE_PREFIX="$(cat "$OUT/smoke-prefix-$SLUG.txt")"
  # Every per-lens model pin in the baked config, re-pointed at the model (its effort kept).
  local pins
  pins="$(docker run --rm --network none --entrypoint cat "$IMAGE" /opt/quickreview/sandbox/config.toml | python3 -I -c '
import sys, tomllib
pm = tomllib.loads(sys.stdin.read()).get("models", {}).get("pass_models", {})
print(",".join(f"models.pass_models.{k}={sys.argv[1]}" + (":" + v.rsplit(":", 1)[1] if ":" in v.split("/")[-1] else "") for k, v in sorted(pm.items())))
' "$M")"
  [[ -z "$pins" || "$MODEL_CONFIG" == *"$pins"* ]] || MODEL_CONFIG="$MODEL_CONFIG,$pins"
}

# Refuse a config where any reviewer model spec would still name another model.
check_models() {
  docker run --rm --network none --entrypoint cat "$IMAGE" /opt/quickreview/sandbox/config.toml | python3 -I -c '
import sys, tomllib
m = tomllib.loads(sys.stdin.read()).get("models", {})
over = dict(p.split("=", 1) for p in sys.argv[1].split(","))
want = sys.argv[2]
specs = {f"models.{k}": m.get(k) for k in ("default", "conversation", "overseer")}
specs |= {f"models.tiers.{k}": v for k, v in m.get("tiers", {}).items()}
specs |= {f"models.pass_models.{k}": v for k, v in m.get("pass_models", {}).items()}
bad = [k for k, v in specs.items() if v and not (over.get(k, v) == want or over.get(k, v).startswith(want + ":"))]
print("ok   every reviewer model spec is %s (%d specs, %d per-lens pins re-pointed)" % (want, len(specs), len(m.get("pass_models", {}))) if not bad else "FAIL not %s: %s" % (want, ", ".join(bad)))
sys.exit(1 if bad else 0)
' "$MODEL_CONFIG" "$M"
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
  echo "info model $M (runs named $SLUG-…)"
  [[ "$(stat -c %a "$key" 2>/dev/null)" == 600 ]] && echo "ok   digitalocean.env 0600" || { echo "FAIL $key missing or not 0600"; bad=1; }
  git -C "$MAIN" check-ignore -q "$key" && echo "ok   key file git-ignored" || { echo "FAIL key file not ignored"; bad=1; }
  if [[ -f "$OUT/image.txt" ]] && docker image inspect "$(cat "$OUT/image.txt")" >/dev/null 2>&1; then
    local img label; img="$(cat "$OUT/image.txt")"
    label="$(docker image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^QCR_BENCH_COMMIT=//p')"
    [[ "$label" != *-dirty ]] && echo "ok   image $img (commit $label)" || { echo "FAIL image $img built from a dirty tree"; bad=1; }
    use_image; check_models || bad=1
    docker run --rm --network none --entrypoint sh "$img" -c "grep -q '\"$MODEL\"' /opt/quickreview/sandbox/dist/src/bench/auth.js" \
      && echo "ok   image registers $MODEL with the provider" || { echo "FAIL image does not register $MODEL — rebuild"; bad=1; }
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
    base="qcr-bench:openbench-${head:0:8}"; ext="$base-ext"
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

  watch) exec python3 -I "$HERE/watch.py" --out "$OUT" "${@:2}" ;;

  smoke)
    preflight || die "preflight failed"
    use_image
    SMOKE_PREFIX="$SLUG-smoke-$(sed -n 's/^qcr-bench:openbench-\([0-9a-f]*\)-ext$/\1/p' <<<"$IMAGE")-$(date +%m%d-%H%M)"
    if (( ! go )); then
      echo "would run $M on $IMAGE: arm.sh --prefix $SMOKE_PREFIX --cases $(join + "${SMOKE_SETS[@]}") --parallel 10 --timeout-min $TIMEOUT_MIN --retries 0 --resume --no-judge"
      echo "  (10 PRs: 4 AACR, 3 Martian, 3 Qodo — every slot busy), then: MODEL=$MODEL $0 score-smoke --go"
      echo "openbench: nothing run — add --go (needs the owner's approval)"; exit 0
    fi
    echo "$SMOKE_PREFIX" > "$OUT/smoke-prefix-$SLUG.txt"
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
      --prefix "$SMOKE_PREFIX" --config "$MODEL_CONFIG" --cases "$(join + "${SMOKE_SETS[@]}")" \
      --parallel 10 --timeout-min "$TIMEOUT_MIN" --no-judge --retries 0 --resume > "$OUT/reviews-$SMOKE_PREFIX.log" 2>&1 \
      || log "arm.sh reported failures"
    kill "$sampler" 2>/dev/null || true
    python3 -I "$HERE/concurrency.py" --runs-dir "$QCR_BENCH_RUNS_DIR" --prefix "$SMOKE_PREFIX" \
      --sets "$(join , "${SMOKE_SETS[@]}")" --samples "$samples" | tee "$OUT/concurrency-$SMOKE_PREFIX.txt"
    exec "$0" score-smoke --go ;;

  score-smoke)
    use_image
    [[ -n "$SMOKE_PREFIX" ]] || die "no smoke launched yet for $MODEL (smoke-prefix-$SLUG.txt)"
    python3 -I "$HERE/gate.py" --runs-dir "$QCR_BENCH_RUNS_DIR" --model "$MODEL" --prefix "$SMOKE_PREFIX" \
      --sets "$(join , "${SMOKE_SETS[@]}")" --strict --out "$OUT/gate-$SMOKE_PREFIX.json"
    (( go )) || { echo "openbench: gate passed; nothing judged — add --go"; exit 0; }
    for s in glm-martian1 glm-martian-extra2 glm-qodo1 glm-qodo-extra2; do "$SRC/bench/aacr/ext/ext.sh" prefetch "$s"; done
    for s in "${SMOKE_SETS[@]}"; do
      score_one "$SMOKE_PREFIX-$s" "$s" > "$OUT/score-$SMOKE_PREFIX-$s.log" 2>&1 || log "$s: scoring failed (score-$SMOKE_PREFIX-$s.log)"
    done
    log "smoke scored — score-$SMOKE_PREFIX-*.log; reports under $QCR_BENCH_RUNS_DIR/$SMOKE_PREFIX-*" ;;

  full)
    preflight || die "preflight failed"
    use_image
    if (( ! go )); then
      echo "would run $M on $IMAGE: prefetch ${FULL_SETS[*]};"
      echo "  arm.sh --prefix $FULL_PREFIX --cases $(join + "${FULL_SETS[@]}") --parallel $PARALLEL --timeout-min $TIMEOUT_MIN --retries 1 --resume --no-judge (QCR_BENCH_PROVIDER=digitalocean)"
      echo "  then: MODEL=$MODEL $0 score-full --go"
      echo "openbench: nothing run — add --go (needs the owner's approval)"; exit 0
    fi
    for s in "${AACR_SETS[@]}"; do "$SRC/bench/aacr/bench.sh" prefetch --set "$s"; done
    "$SRC/bench/aacr/ext/ext.sh" prefetch martian50
    "$SRC/bench/aacr/ext/ext.sh" prefetch qodo-pr100
    log "reviewing $(join + "${FULL_SETS[@]}") on $IMAGE"
    QCR_BENCH_PROVIDER=digitalocean ${inhibit[@]+"${inhibit[@]}"} "$SRC/bench/aacr/arm.sh" \
      --prefix "$FULL_PREFIX" --config "$MODEL_CONFIG" --cases "$(join + "${FULL_SETS[@]}")" \
      --parallel "$PARALLEL" --timeout-min "$TIMEOUT_MIN" --no-judge --retries 1 --resume > "$OUT/reviews-$FULL_PREFIX.log" 2>&1 \
      || log "arm.sh reported failures — gating and scoring what finished"
    exec "$0" score-full --go ;;

  score-full)
    use_image
    # A reviewer call on any other model → exit 1 here and nothing is scored.
    python3 -I "$HERE/gate.py" --runs-dir "$QCR_BENCH_RUNS_DIR" --model "$MODEL" --prefix "$FULL_PREFIX" \
      --sets "$(join , "${FULL_SETS[@]}")" --out "$OUT/gate-$FULL_PREFIX.json"
    (( go )) || { echo "openbench: nothing judged — add --go"; exit 0; }
    for s in "${FULL_SETS[@]}"; do
      score_one "$FULL_PREFIX-$s" "$s" > "$OUT/score-$FULL_PREFIX-$s.log" 2>&1 || log "$s: scoring failed (score-$FULL_PREFIX-$s.log)"
    done
    runs=(); yield=()
    for s in "${FULL_SETS[@]}"; do runs+=(--run "$FULL_PREFIX-$s"); yield+=(--run "$(scorer_of "$s"):$FULL_PREFIX-$s"); done
    python3 bench/aacr/dup_stats.py --runs-dir "$QCR_BENCH_RUNS_DIR" "${runs[@]}" > "$OUT/$FULL_PREFIX-dup_stats.md" 2>&1 || true
    python3 bench/aacr/lens_yield.py --runs-dir "$QCR_BENCH_RUNS_DIR" "${yield[@]}" > "$OUT/$FULL_PREFIX-lens_yield.md" 2>&1 || true
    log "done — gate-$FULL_PREFIX.json (cost, time, failures), score-$FULL_PREFIX-*.log, $FULL_PREFIX-*.md" ;;

  *) sed -n '2,21p' "$0"; exit 2 ;;
esac
