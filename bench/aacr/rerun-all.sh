#!/usr/bin/env bash
# One benchmark rerun from a plan file (bench/aacr/rerun_plan.py has the format).
#
#   bench/aacr/rerun-all.sh PLAN          print the plan and its estimated cost and time; run NOTHING
#   bench/aacr/rerun-all.sh PLAN --go     build → review → score → log
#
# With --go:
#   1. builds the plan's image from master HEAD in a clean temporary worktree
#      (bench.sh build) and refuses unless its QCR_BENCH_COMMIT label is HEAD;
#   2. reviews every set in ONE arm.sh (shared adaptive slots), run names
#      <prefix>-<set>;
#   3. scores each set with its own scorer — aacr: bench.sh judge; martian /
#      qodo / swepr: ext/ext.sh martian | qodo --only-tools quickreview |
#      sweprbench;
#   4. writes dup_stats.py and lens_yield.py over all of them to
#      $QCR_BENCH_RUNS_DIR/rerun-<plan name>/ and appends one row per set to
#      bench/aacr/ext/RUNS.md.
# A benchmark run needs the owner's explicit approval; --go is that approval
# made explicit on the command line, never a default.
#
#   QCR_BENCH_RUNS_DIR   required (outside any worktree)
#   QCR_RERUN_SKIP_BUILD=1   use an already built image (its label is still checked)
#   QCR_RERUN_ARM / QCR_RERUN_BENCH / QCR_RERUN_EXT / QCR_RERUN_HEAD   test seams
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
die() { echo "rerun-all: $*" >&2; exit 1; }
log() { echo "$(date +%T) rerun-all: $*"; }

PLAN="${1:-}"; [[ -n "$PLAN" && -f "$PLAN" ]] || die "usage: rerun-all.sh PLAN [--go]"
GO=0; [[ "${2:-}" == "--go" ]] && GO=1
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR (outside any worktree)}"
export QCR_BENCH_RUNS_DIR
ARM="${QCR_RERUN_ARM:-$HERE/arm.sh}"
BENCH="${QCR_RERUN_BENCH:-$HERE/bench.sh}"
EXT="${QCR_RERUN_EXT:-$HERE/ext/ext.sh}"
PLANPY=(python3 "$HERE/rerun_plan.py")

"${PLANPY[@]}" check "$PLAN" "$HERE/sets" || die "bad plan"
NAME="$("${PLANPY[@]}" field "$PLAN" name)"
IMAGE="$("${PLANPY[@]}" field "$PLAN" image)"
PREFIX="$("${PLANPY[@]}" field "$PLAN" prefix)"
CONFIG="$("${PLANPY[@]}" field "$PLAN" config)"
mapfile -t SETS < <("${PLANPY[@]}" sets "$PLAN")

"${PLANPY[@]}" show "$PLAN" "$HERE/sets" "$QCR_BENCH_RUNS_DIR"
if [[ "$GO" != 1 ]]; then
  echo "rerun-all: nothing run — pass --go to build, review and score (a benchmark run needs the owner's approval)"
  exit 0
fi

# 1. The image, from master HEAD in a clean worktree (the main checkout is the
#    companion's desk: a build there is labelled -dirty).
HEAD_SHA="${QCR_RERUN_HEAD:-$(git -C "$REPO" rev-parse HEAD)}"
if [[ "${QCR_RERUN_SKIP_BUILD:-}" != 1 ]]; then
  wt="$(mktemp -d)"; rmdir "$wt"
  git -C "$REPO" worktree add --detach "$wt" "$HEAD_SHA" >/dev/null
  log "building $IMAGE from $HEAD_SHA"
  ( cd "$wt" && QCR_BENCH_IMAGE="$IMAGE" bash bench/aacr/bench.sh build ) || { git -C "$REPO" worktree remove --force "$wt"; die "build failed"; }
  git -C "$REPO" worktree remove --force "$wt"
fi
label="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^QCR_BENCH_COMMIT=//p')"
[[ "$label" == "$HEAD_SHA" ]] || die "$IMAGE is labelled '$label', not HEAD $HEAD_SHA"

# 2. One arm over every set.
cases="$(printf '%s\n' "${SETS[@]}" | awk '{print $1}' | paste -sd+)"
inhibit=(); command -v systemd-inhibit >/dev/null && inhibit=(systemd-inhibit --what=sleep:idle --why="qcr rerun $NAME")
log "reviewing $cases on $IMAGE"
QCR_BENCH_IMAGE="$IMAGE" ${inhibit[@]+"${inhibit[@]}"} "$ARM" --prefix "$PREFIX" --config "$CONFIG" \
  --cases "$cases" --no-judge --parallel auto || log "arm.sh reported failures — scoring what finished"

# 3. Each set on its own scorer.
OUT="$QCR_BENCH_RUNS_DIR/rerun-$NAME"; mkdir -p "$OUT"
dup=() yield=()
for line in "${SETS[@]}"; do
  read -r set scorer <<< "$line"
  run="$PREFIX-$set"
  log "scoring $run ($scorer)"
  case "$scorer" in
    aacr) "$BENCH" judge --run "$run" --set "$set" > "$OUT/$set.score.log" 2>&1 || log "$run: scoring failed (see $OUT/$set.score.log)" ;;
    martian) "$EXT" martian "$run" "$set" > "$OUT/$set.score.log" 2>&1 || log "$run: scoring failed" ;;
    qodo) "$EXT" qodo "$run" "$set" --only-tools quickreview > "$OUT/$set.score.log" 2>&1 || log "$run: scoring failed" ;;
    swepr) "$EXT" sweprbench "$run" "$set" > "$OUT/$set.score.log" 2>&1 || log "$run: scoring failed" ;;
  esac
  dup+=(--run "$run"); yield+=(--run "$scorer:$run")
done

# 4. Duplicates and lens yield over the whole rerun, and one RUNS.md row per set.
python3 "$HERE/dup_stats.py" --runs-dir "$QCR_BENCH_RUNS_DIR" "${dup[@]}" > "$OUT/dup_stats.md" 2>&1 || true
python3 "$HERE/lens_yield.py" --runs-dir "$QCR_BENCH_RUNS_DIR" "${yield[@]}" > "$OUT/lens_yield.md" 2>&1 || true
for line in "${SETS[@]}"; do
  read -r set scorer <<< "$line"
  run="$PREFIX-$set"
  ok="$(ls "$QCR_BENCH_RUNS_DIR/$run/results/all" 2>/dev/null | wc -l)"
  total="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["cases"]))' "$HERE/sets/$set.json")"
  echo "| $run | rerun-all $NAME, $scorer, image $IMAGE @ ${HEAD_SHA:0:7} | $ok/$total | scored: rerun-$NAME/$set.score.log |" >> "$HERE/ext/RUNS.md"
done
log "done — $OUT"
