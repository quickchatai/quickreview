#!/usr/bin/env bash
# One benchmark ARM, end to end: review a group of PRs with one set of config
# levers, then judge exactly those PRs against the defect ground truth (and,
# with --eval, score AACR-Bench's own metric).
#
#   bench/aacr/arm.sh --prefix low --config review.preset=low --cases fresh10+levers16
#   bench/aacr/arm.sh --prefix base --cases smoke10          # the shipped config
#   bench/aacr/arm.sh --prefix all1 --cases full --eval 1 --eval-variants all   # a whole-benchmark run
#
#   --prefix NAME     runs are named NAME-<set> (e.g. low-fresh10) under $QCR_BENCH_RUNS_DIR
#   --config k=v,...  config.toml levers for this arm (bench.sh --config; e.g. review.preset=max)
#   --cases G+G+...   case groups joined by '+', each one of:
#                       <set>              every PR of bench/aacr/sets/<set>.json
#                       <set>:id,id        those PRs of that set
#                       levers16           the 16 PRs the review levers were measured on
#                       all30              smoke10 + dev10 + holdout10
#                       full               the 196-PR AACR set: judged against every defect
#                                          set it overlaps (the 40 PRs with ground truth)
#   --arm qcr|ocr     QuickReview (default) or the open-code-review baseline (bench.sh --arm ocr;
#                     OCR reviews one case at a time in one container per set, as its harness does)
#   --arm codex       the Codex CLI arm (bench.sh --arm codex; the harness's reviewers/codex.py,
#                     one case at a time in one container per set, like ocr)
#   --arm opencode    OpenCode (bench.sh --arm opencode), one case at a time in one container per
#                     set, like ocr
#   --arm pireview    @zephyrdeng/pi-review (bench.sh --arm pireview), one case at a time in one
#                     container per set, like ocr
#   --arm pragent     PR-Agent (bench.sh --arm pragent; /describe, /review, /improve on gpt-6.1-sol), one case
#                     at a time in one container per set, like ocr
#   --arm claude      Claude Code as a benchmarked reviewer (bench.sh --arm claude; the one sanctioned
#                     place to run Claude Code — inside its sandbox only): the ocr path, one
#                     container per set, the harness's reviewers/claude.py; needs bench/aacr/claude.env
#   --parallel N|auto reviews at once, MACHINE-WIDE (default auto; see "Scheduling" below)
#   --max-parallel N, --concurrency N   other spellings of --parallel N
#   --resume          keep cases already reviewed by the same build and levers; re-run the rest
#   --fresh           start the arm's runs over (their earlier case results are cleared)
#                     — an existing run dir needs one of the two, so a relaunch never wipes hours
#   --retries N       re-run a failed case (not ok, and not unfetchable) up to N more times at
#                     the end of the queue (default 1)
#   --no-judge        review only
#   --judge-concurrency N   defect-judge sessions at once per run (default 4)
#   --eval R          also score AACR-Bench's own metric: bench.sh eval --judge codex --rounds R
#                     (the harness's references; JUDGE_CODEX_MODEL fixes the judge for every arm)
#   --eval-shards N   split each eval into up to N harness processes per variant (default 6;
#                     ~4 PRs per shard at least) — the same numbers, merged by eval_shards.py
#   --eval-variants V comma-separated variants to score (default all three; compare.py reads `all`)
#   --repeat N        N independent runs of the arm, named NAME-r<k>-<set>; compare.py
#                     scores them as NAME=runs+runs
#   --pr-text         the equal-inputs switch (QCR_BENCH_PR_TEXT=1): hand the PR title/body to the
#                     ocr, codex, opencode or pireview arm the way that tool takes review context
#                     (src/bench/prtext.ts). Default off — the published invocation
#
# The third-party arms' other knobs ride the environment (bench.sh header):
# QCR_BENCH_OCR_EFFORT, QCR_BENCH_CODEX_EFFORT, QCR_BENCH_OPENCODE_EFFORT,
# QCR_BENCH_OPENCODE_PROVIDER, QCR_BENCH_PIREVIEW_THINKING, QCR_BENCH_PIREVIEW_PANEL,
# QCR_BENCH_PRAGENT_EFFORT, QCR_BENCH_PRAGENT_MODEL, QCR_BENCH_PRAGENT_NO_PR_TEXT,
# QCR_BENCH_{OCR,CODEX,OPENCODE,PIREVIEW}_MODEL
# — each one set is recorded in <run>.arm.json (`env`).
#
# Scheduling (the QuickReview arm). Every case of every set and every repeat
# goes on ONE queue, longest PR first (the set's change_line_count), and each
# case runs in its OWN hardened container (bench.sh review --phase case), so
# no slot ever idles on a set that finished early. A case takes one of
# --parallel machine-wide slots (flock on $QCR_BENCH_RUNS_DIR/.slots/, shared
# with every other arm.sh on this machine — the model login and the RAM are
# machine-wide, so two arms launched side by side split the slots instead of
# doubling the load). A new review also waits while MemAvailable is short. A
# run's judge (one slot) and eval (one machine-wide eval lock) start the
# moment its last case finishes, while other runs are still reviewing.
#
# `auto` is ADAPTIVE (AIMD): it starts at
# min((MemAvailable - QCR_BENCH_RESERVE_MB) / QCR_BENCH_REVIEW_MB,
# QCR_BENCH_START_PARALLEL) and keeps ONE machine-wide target in
# $QCR_BENCH_RUNS_DIR/.slots/target, shared by every arm.sh (an arm that finds
# another one holding slots adopts its target; one that finds none starts it
# over). While cases are queued, every slot is busy, memory admits one more and
# no rate limit was seen for QCR_BENCH_RAMP_SECS, the target rises by
# QCR_BENCH_RAMP_STEP, up to QCR_BENCH_PARALLEL_CEILING. A case that failed
# under rate limiting halves it (once per QCR_BENCH_HALVE_GAP burst), pauses
# new launches for QCR_BENCH_RATE_LIMIT_PAUSE seconds and is retried. Every
# change is logged (`concurrency N -> M, reason`, also in .slots/concurrency.log).
# A case that hit the PLAN's usage limit (`quota=` on its result line: the
# window is spent, minutes of pause do not cure it) stops new launches for
# every arm on the machine, loudly; `--resume` re-runs what is not ok once the
# window resets. `--parallel N` and an explicitly set QCR_BENCH_MAX_PARALLEL
# are FIXED caps: no ramp, no halving (the pause and retry still apply).
#
#   QCR_BENCH_REVIEW_MB=768      memory budget per concurrent review (auto + the admission check;
#                                measured from cgroup memory.peak of live review
#                                containers: 577-788 MB peak incl. page cache, ~210 MB anon steady)
#   QCR_BENCH_RESERVE_MB=3072    MemAvailable kept free for the rest of the machine
#   QCR_BENCH_START_PARALLEL=10  where adaptive auto starts (never above what memory admits)
#   QCR_BENCH_PARALLEL_CEILING=24  adaptive auto never exceeds this
#   QCR_BENCH_RAMP_SECS=300      quiet time (no rate limit, no change) before a step up
#   QCR_BENCH_RAMP_STEP=2        slots added per step
#   QCR_BENCH_HALVE_GAP=60       rate-limited cases closer than this halve the target once
#   QCR_BENCH_ADAPTIVE=0         auto without the ramp (start value fixed)
#   QCR_BENCH_MAX_PARALLEL=N     auto = min(memory, N), fixed (no ramp, no halving)
#   QCR_BENCH_REVIEW_MEMORY=3g   the hard cap of one case container (QCR_BENCH_MEMORY for it)
#   QCR_BENCH_REVIEW_CPUS=4      its cpu cap
#   QCR_BENCH_EVAL_CPUS=8        the eval container's cpu cap (it runs shards × variants pi judges)
#
# Every arm is judged by the SAME judge on the same image: the defect judge
# always runs in the QuickReview image ($QCR_BENCH_IMAGE), whatever the arm.
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

PREFIX="" CONFIG="" CASES="" PAR=auto JUDGE=1 REPEAT=1 ARM=qcr MODE="" EVAL=0 RETRIES=1
EVAL_SHARDS="${QCR_BENCH_EVAL_SHARDS:-6}" EVAL_VARIANTS="" JCONC=4
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --cases) CASES="$2"; shift 2 ;;
    --parallel|--max-parallel|--concurrency) PAR="$2"; shift 2 ;;
    --no-judge) JUDGE=0; shift ;;
    --judge-concurrency) JCONC="$2"; shift 2 ;;
    --arm) ARM="$2"; shift 2 ;;
    --resume) MODE=resume; shift ;;
    --fresh) MODE=fresh; shift ;;
    --retries) RETRIES="$2"; shift 2 ;;
    --eval) EVAL="$2"; shift 2 ;;
    --eval-shards) EVAL_SHARDS="$2"; shift 2 ;;
    --eval-variants) EVAL_VARIANTS="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    --pr-text) export QCR_BENCH_PR_TEXT=1; shift ;;
    *) echo "unknown flag $1 (see the header of $0)" >&2; exit 2 ;;
  esac
done
[[ -n "$PREFIX" && -n "$CASES" ]] || { echo "--prefix and --cases are required" >&2; exit 2; }
[[ "$ARM" == qcr || "$ARM" == ocr || "$ARM" == codex || "$ARM" == opencode || "$ARM" == claude || "$ARM" == pireview || "$ARM" == pragent ]] || { echo "--arm must be qcr | ocr | codex | opencode | pireview | pragent | claude" >&2; exit 2; }
[[ "$ARM" == qcr || -z "$CONFIG" ]] || { echo "--config sets QuickReview levers; the $ARM arm has none" >&2; exit 2; }
[[ "${QCR_BENCH_PR_TEXT:-}" != 1 || "$ARM" == ocr || "$ARM" == codex || "$ARM" == opencode || "$ARM" == pireview ]] \
  || { echo "--pr-text is for the ocr, codex, opencode and pireview arms (QuickReview and pragent always read the PR text)" >&2; exit 2; }
[[ "$EVAL" =~ ^[0-9]+$ ]] || { echo "--eval takes a round count" >&2; exit 2; }
[[ "$PAR" == auto || "$PAR" =~ ^[1-9][0-9]*$ ]] || { echo "--parallel takes a count or auto" >&2; exit 2; }
[[ "$RETRIES" =~ ^[0-9]+$ && "$JCONC" =~ ^[1-9][0-9]*$ && "$EVAL_SHARDS" =~ ^[1-9][0-9]?$ ]] \
  || { echo "--retries, --judge-concurrency and --eval-shards take counts" >&2; exit 2; }
QIMG="${QCR_BENCH_IMAGE:-qcr-bench:latest}" OIMG="${QCR_BENCH_OCR_IMAGE:-qcr-bench-ocr:latest}"
IMG="$QIMG"; [[ "$ARM" == ocr ]] && IMG="$OIMG"
[[ "$ARM" == codex ]] && IMG="${QCR_BENCH_CODEX_IMAGE:-qcr-bench-codex:latest}"
[[ "$ARM" == opencode ]] && IMG="${QCR_BENCH_OPENCODE_IMAGE:-qcr-bench-opencode:latest}"
[[ "$ARM" == claude ]] && IMG="${QCR_BENCH_CLAUDE_IMAGE:-qcr-bench-claude:latest}"
[[ "$ARM" == pireview ]] && IMG="${QCR_BENCH_PIREVIEW_IMAGE:-qcr-bench-pireview:latest}"
[[ "$ARM" == pragent ]] && IMG="${QCR_BENCH_PRAGENT_IMAGE:-qcr-bench-pragent:latest}"
IMG_ID="$(docker image inspect "$IMG" --format '{{.Id}}' 2>/dev/null)" || { echo "no image $IMG — build it: bench.sh build --arm $ARM" >&2; exit 2; }
# An image built before the per-case scheduler ignores --phase, and its
# "init" container would review every case with no network. Refuse it (and
# an older image of the judge/eval side, which lacks the eval sharding).
docker run --rm --network none --entrypoint test "$QIMG" -f /opt/quickreview/bench/eval_shards.py >/dev/null 2>&1 \
  || { echo "image $QIMG predates the per-case scheduler (no eval_shards.py) — rebuild it: bench.sh build" >&2; exit 2; }
# The Claude Code arm is judged in $QIMG too, which must read its result shape.
if [[ "$ARM" == claude ]]; then
  docker run --rm --network none --entrypoint test "$QIMG" -f /opt/quickreview/sandbox/dist/src/bench/claudeshape.js >/dev/null 2>&1 \
    || { echo "image $QIMG cannot read a Claude Code run (no claudeshape.js) — rebuild it: bench.sh build" >&2; exit 2; }
fi

REVIEW_MB="${QCR_BENCH_REVIEW_MB:-768}" RESERVE_MB="${QCR_BENCH_RESERVE_MB:-3072}"
MAX_PAR="${QCR_BENCH_MAX_PARALLEL:-}" PAUSE="${QCR_BENCH_RATE_LIMIT_PAUSE:-300}"
START_PAR="${QCR_BENCH_START_PARALLEL:-10}" CEIL="${QCR_BENCH_PARALLEL_CEILING:-24}"
RAMP_SECS="${QCR_BENCH_RAMP_SECS:-300}" STEP="${QCR_BENCH_RAMP_STEP:-2}" HALVE_GAP="${QCR_BENCH_HALVE_GAP:-60}"
POLL="${QCR_BENCH_POLL:-2}" GAP="${QCR_BENCH_LAUNCH_GAP:-3}"
SLOTS="$QCR_BENCH_RUNS_DIR/.slots"
for v in REVIEW_MB START_PAR CEIL STEP; do
  [[ "${!v}" =~ ^[1-9][0-9]*$ ]] || { echo "arm.sh: $v must be a positive count" >&2; exit 2; }
done
[[ -z "$MAX_PAR" || "$MAX_PAR" =~ ^[1-9][0-9]*$ ]] || { echo "QCR_BENCH_MAX_PARALLEL must be a positive count" >&2; exit 2; }
[[ "$RAMP_SECS" =~ ^[0-9]+$ && "$HALVE_GAP" =~ ^[0-9]+$ ]] || { echo "QCR_BENCH_RAMP_SECS and QCR_BENCH_HALVE_GAP take seconds" >&2; exit 2; }

# MemAvailable in MB; QCR_BENCH_MEM_AVAILABLE_MB overrides (tests), "" = unknown (not Linux).
mem_avail_mb() {
  if [[ -n "${QCR_BENCH_MEM_AVAILABLE_MB:-}" ]]; then echo "$QCR_BENCH_MEM_AVAILABLE_MB"; return; fi
  awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null
}
# ADAPT=1: the slot count is the machine-wide AIMD target (header), not a constant.
ADAPT=0
if [[ "$PAR" == auto ]]; then
  avail="$(mem_avail_mb)"
  if [[ -z "$avail" ]]; then PAR=4
  else
    PAR=$(( (avail - RESERVE_MB) / REVIEW_MB ))
    if [[ -n "$MAX_PAR" ]]; then
      (( PAR > MAX_PAR )) && PAR="$MAX_PAR"
    else
      (( PAR > START_PAR )) && PAR="$START_PAR"
      [[ "${QCR_BENCH_ADAPTIVE:-1}" != 0 ]] && command -v flock >/dev/null 2>&1 && ADAPT=1
    fi
    (( PAR < 1 )) && PAR=1
  fi
  if [[ "$ARM" == qcr ]]; then
    if [[ "$ADAPT" == 1 ]]; then
      echo "arm $PREFIX: $PAR review slot(s) to start — adaptive auto: MemAvailable ${avail:-unknown} MB, ${REVIEW_MB} MB per review, ${RESERVE_MB} MB reserve, ramps to at most $CEIL while the login does not push back"
    else
      echo "arm $PREFIX: $PAR review slot(s) — auto: MemAvailable ${avail:-unknown} MB, ${REVIEW_MB} MB per review, ${RESERVE_MB} MB reserve${MAX_PAR:+, fixed cap $MAX_PAR}"
    fi
  fi
fi

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
# A set lives in sets/, or (a private replay set) in
# QCR_BENCH_PRIVATE_SETS, which bench.sh mounts read-only for the containers.
set_json() {
  if [[ -f "$HERE/sets/$1.json" ]]; then echo "$HERE/sets/$1.json"
  elif [[ -n "${QCR_BENCH_PRIVATE_SETS:-}" && -f "$QCR_BENCH_PRIVATE_SETS/$1.json" ]]; then echo "$QCR_BENCH_PRIVATE_SETS/$1.json"
  else return 1; fi
}
for j in "${jobs[@]}"; do
  set_name="${j%%|*}"
  set_json "$set_name" >/dev/null || { echo "no case set $set_name" >&2; exit 2; }
done

# Every (repeat, job) is one run: JRUN/JSET/JIDS indexed alike.
JRUN=() JSET=() JIDS=()
for ((k = 1; k <= REPEAT; k++)); do
  p="$PREFIX"; [[ "$REPEAT" -gt 1 ]] && p="$PREFIX-r$k"
  for j in "${jobs[@]}"; do
    JRUN+=("$p-${j%%|*}"); JSET+=("${j%%|*}"); JIDS+=("${j#*|}")
  done
done
# A relaunch must say what it means: an existing run is hours of reviews.
exists=()
for r in "${JRUN[@]}"; do [[ -e "$QCR_BENCH_RUNS_DIR/$r/run.json" ]] && exists+=("$r"); done
if [[ ${#exists[@]} -gt 0 && -z "$MODE" ]]; then
  echo "run(s) already exist: ${exists[*]} — pass --resume to continue them (only cases not yet ok are reviewed) or --fresh to start them over" >&2
  exit 2
fi
RESUME=(); [[ "$MODE" == resume ]] && RESUME=(--resume)
CFG=(); [[ -n "$CONFIG" ]] && CFG=(--config "$CONFIG")

# Run a command holding a lock file (blocking); without flock (not Linux), just run it.
with_lock() { # lockfile cmd...
  local f="$1"; shift
  if ! command -v flock >/dev/null 2>&1; then "$@"; return; fi
  mkdir -p "$(dirname "$f")"
  ( flock 9; "$@" ) 9>"$f"
}
# The machine-wide adaptive state (ADAPT=1), in $SLOTS: `target` (the slot
# count; its mtime is the last change), `last-limit` (touched on every
# rate-limited case), `usage-limit` (the plan's window is spent: no arm
# launches a review after it), `concurrency.log` (every change).
TARGET="$SLOTS/target" LASTLIM="$SLOTS/last-limit" QUOTA="$SLOTS/usage-limit"
mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
# The slot count now: the shared target when adaptive, else the fixed $PAR.
cur_par() {
  local v
  if [[ "$ADAPT" == 1 ]]; then
    v="$(cat "$TARGET" 2>/dev/null)"
    [[ "$v" =~ ^[1-9][0-9]*$ ]] && { echo "$v"; return; }
  fi
  echo "$PAR"
}
set_par() { # new reason — call under the target lock
  local old new="$1"
  old="$(cur_par)"
  [[ "$new" == "$old" ]] && return 0
  echo "$new" > "$TARGET.$$" && mv -f "$TARGET.$$" "$TARGET"
  echo "$(date +%T) concurrency $old -> $new, $2" | tee -a "$SLOTS/concurrency.log"
}
# How many of the first N slots are held right now (by any arm on the machine).
slots_busy() { # n
  local s busy=0
  for ((s = 0; s < $1; s++)); do ( flock -n 9 ) 9>"$SLOTS/slot.$s.lock" || busy=$(( busy + 1 )); done
  echo "$busy"
}
halve_par() { # reason — under the target lock; one halving per burst of rate limits
  local c now
  now=$(date +%s); c="$(cur_par)"
  if (( now - $(mtime "$LASTLIM") >= HALVE_GAP )); then set_par $(( c / 2 < 1 ? 1 : c / 2 )) "$1"; fi
  touch "$LASTLIM"
}
ramp_par() { # now cur — under the target lock: re-checked, another arm may have moved it
  local c
  c="$(cur_par)"
  [[ "$c" == "$2" ]] || return 0
  (( $1 - $(mtime "$TARGET") >= RAMP_SECS && $1 - $(mtime "$LASTLIM") >= RAMP_SECS )) || return 0
  set_par $(( c + STEP > CEIL ? CEIL : c + STEP )) "no rate limit for ${RAMP_SECS}s, every slot busy, cases waiting"
}

# Run a command holding one of the machine-wide review slots (cur_par of them).
with_slot() { # cmd...
  if ! command -v flock >/dev/null 2>&1; then "$@"; return; fi
  mkdir -p "$SLOTS"
  local s rc got="$(mktemp)"
  rm -f "$got"
  while :; do
    for ((s = 0; s < $(cur_par); s++)); do
      ( flock -n 9 || exit 0; : > "$got"; "$@" ) 9>"$SLOTS/slot.$s.lock"
      rc=$?
      [[ -e "$got" ]] && { rm -f "$got"; return "$rc"; }
    done
    sleep "$POLL"
  done
}

# The arm knobs that ride the environment, as a JSON object (only those set).
arm_env_json() {
  python3 -c 'import json, os, sys; print(json.dumps({k: os.environ[k] for k in sys.argv[1:] if os.environ.get(k)}, sort_keys=True))' \
    QCR_BENCH_PR_TEXT QCR_BENCH_OCR_EFFORT QCR_BENCH_CODEX_EFFORT QCR_BENCH_OPENCODE_EFFORT \
    QCR_BENCH_OPENCODE_PROVIDER QCR_BENCH_PIREVIEW_THINKING QCR_BENCH_PIREVIEW_PANEL \
    QCR_BENCH_PRAGENT_EFFORT QCR_BENCH_PRAGENT_MODEL QCR_BENCH_PRAGENT_NO_PR_TEXT \
    QCR_BENCH_OCR_MODEL QCR_BENCH_CODEX_MODEL QCR_BENCH_OPENCODE_MODEL QCR_BENCH_PIREVIEW_MODEL
}
record_arm() { # run set ids
  printf '{"arm":"%s","image":"%s","image_id":"%s","config":"%s","cases":"%s","parallel":"%s","env":%s,"started":"%s"}\n' \
    "$ARM" "$IMG" "$IMG_ID" "$CONFIG" "$2:$3" "$PAR" "$(arm_env_json)" "$(date -u +%FT%TZ)" > "$QCR_BENCH_RUNS_DIR/$1.arm.json"
}

# The cases THIS invocation wrote into a run's run.json: one older than START
# (a review that died before writing one) would judge someone else's reviews.
run_cases() { # run
  python3 -c "import json,os,sys; f=sys.argv[1]; assert os.path.getmtime(f) >= float(sys.argv[2]); print(','.join(json.load(open(f))['cases']))" \
    "$QCR_BENCH_RUNS_DIR/$1/run.json" "$START" 2>/dev/null
}

# Judge (and --eval score) one run's own cases. Returns non-zero on failure.
judge_and_eval() { # run set cases
  local run="$1" set_name="$2" cases="$3" rc=0 arm=() defs n shards var=()
  [[ "$ARM" != qcr ]] && arm=(--arm "$ARM")
  if [[ "$JUDGE" == 1 ]]; then
    # Judge ONLY this run's own cases, per ground truth that has them (a
    # `full` run spans several defect sets), always in the QuickReview image.
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
      # The judge draws on the login like a review, so it takes a slot.
      $SLOT env QCR_BENCH_IMAGE="$QIMG" "$HERE/bench.sh" judge --run "$run" --set "$dset" --only "$dids" --concurrency "$JCONC" \
        >> "$QCR_BENCH_RUNS_DIR/$run.judge.log" 2>&1
      $SLOT env QCR_BENCH_IMAGE="$QIMG" "$HERE/bench.sh" judge --run "$run" --set "$dset" --only "$dids" --concurrency "$JCONC" --resume \
        >> "$QCR_BENCH_RUNS_DIR/$run.judge.log" 2>&1 || { echo "$run: judge ($dset) FAILED — see $run.judge.log"; rc=1; }
    done <<< "$defs"
    echo "$run: $(grep 'judged —' "$QCR_BENCH_RUNS_DIR/$run.judge.log" | tail -1)"
  fi
  if [[ "$EVAL" -gt 0 ]]; then
    n=$(( $(tr ',' '\n' <<< "$cases" | grep -c .) ))
    shards=$(( (n + 3) / 4 )); (( shards > EVAL_SHARDS )) && shards="$EVAL_SHARDS"; (( shards < 1 )) && shards=1
    [[ -n "$EVAL_VARIANTS" ]] && var=(--variants "$EVAL_VARIANTS")
    # One eval at a time on the machine: it runs shards × variants judges at once.
    with_lock "$SLOTS/eval.lock" env QCR_BENCH_CPUS="${QCR_BENCH_EVAL_CPUS:-8}" \
      "$HERE/bench.sh" eval ${arm[@]+"${arm[@]}"} --run "$run" --set "$set_name" --only "$cases" --judge codex --rounds "$EVAL" \
      --shards "$shards" ${var[@]+"${var[@]}"} > "$QCR_BENCH_RUNS_DIR/$run.eval.log" 2>&1 \
      || { echo "$run: AACR eval FAILED — see $run.eval.log"; rc=1; }
    echo "$run: AACR eval done $(date +%T)"
  fi
  return "$rc"
}

START=$(date +%s)
fail=0

# ---- the open-code-review, Codex, OpenCode, Claude Code, pi-review and PR-Agent arms: one container per set, as their harness runs --
if [[ "$ARM" == ocr || "$ARM" == codex || "$ARM" == opencode || "$ARM" == claude || "$ARM" == pireview || "$ARM" == pragent ]]; then
  SLOT=""
  one() { # index
    local i="$1" run="${JRUN[$1]}" set_name="${JSET[$1]}" ids="${JIDS[$1]}" only=() rc=0 cases
    [[ -n "$ids" ]] && only=(--only "$ids")
    record_arm "$run" "$set_name" "$ids"
    "$HERE/bench.sh" review --arm "$ARM" --run "$run" --set "$set_name" ${only[@]+"${only[@]}"} \
      ${RESUME[@]+"${RESUME[@]}"} > "$QCR_BENCH_RUNS_DIR/$run.review.log" 2>&1 || rc=$?
    echo "$run: review exit $rc $(date +%T)"
    cases=$(run_cases "$run") || cases=""
    [[ -n "$cases" ]] || { echo "$run: FAILED — the review wrote no run.json (see $run.review.log)"; return 1; }
    judge_and_eval "$run" "$set_name" "$cases" || rc=1
    return "$rc"
  }
  # Repeats one after another (sets within a repeat in parallel).
  per=${#jobs[@]}
  for ((k = 0; k < REPEAT; k++)); do
    START=$(date +%s); pids=()
    for ((i = k * per; i < (k + 1) * per; i++)); do one "$i" & pids+=($!); done
    for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
  done
  echo "arm $PREFIX done $(date +%T)$([[ $fail == 1 ]] && echo ' — WITH FAILURES (see above)')"
  exit "$fail"
fi

# ---- the QuickReview arm: one machine-wide queue, one container per case ----------
SLOT=with_slot
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
trap 'kill $(jobs -p) 2>/dev/null; exit 130' INT TERM
ts() { date +%T; }

# 1. Set every run up (run.json; a fresh run's old results cleared) and queue
#    its cases.
NJ=${#JRUN[@]} LEFT=() QUEUE=() qh=0 RUNFAIL=() CASES_OF=()
for ((i = 0; i < NJ; i++)); do
  run="${JRUN[$i]}" LEFT[$i]=0 RUNFAIL[$i]=0 CASES_OF[$i]=""
  only=(); [[ -n "${JIDS[$i]}" ]] && only=(--only "${JIDS[$i]}")
  record_arm "$run" "${JSET[$i]}" "${JIDS[$i]}"
  [[ "$MODE" == resume ]] || : > "$QCR_BENCH_RUNS_DIR/$run.review.log"
  "$HERE/bench.sh" review --phase init --run "$run" --set "${JSET[$i]}" ${only[@]+"${only[@]}"} \
    ${CFG[@]+"${CFG[@]}"} ${RESUME[@]+"${RESUME[@]}"} >> "$QCR_BENCH_RUNS_DIR/$run.review.log" 2>&1
  cases=$(run_cases "$run") || cases=""
  if [[ -z "$cases" ]]; then
    echo "$run: FAILED — the review wrote no run.json (see $run.review.log)"; fail=1; LEFT[$i]=-1; continue
  fi
  CASES_OF[$i]="$cases"
done
# Longest PR first across every run (the set's change_line_count), so the
# slowest reviews start early and the tail is short.
while read -r i id; do
  [[ -n "$id" ]] || continue
  QUEUE+=("$i $id 1"); LEFT[$i]=$(( LEFT[$i] + 1 ))
done < <(for ((i = 0; i < NJ; i++)); do [[ -n "${CASES_OF[$i]}" ]] && echo "$i $(set_json "${JSET[$i]}") ${CASES_OF[$i]}"; done \
  | python3 -c '
import json, os, sys
rows = []
for n, line in enumerate(sys.stdin):
    i, rest = line.split(None, 1)
    s, ids = rest.rstrip("\n").rsplit(None, 1)
    size = {c["instance_id"]: c.get("change_line_count") or 0 for c in json.load(open(s))["cases"]}
    rows += [(-size.get(c, 0), n, k, i, c) for k, c in enumerate(ids.split(","))]
for r in sorted(rows):
    print(r[3], r[4])
')
TOTAL=$(( ${#QUEUE[@]} ))
if [[ "$ADAPT" == 1 ]]; then
  mkdir -p "$SLOTS"
  # Another arm holding slots owns the live target: adopt it. None: start over
  # from this arm's own start value (a target left by a finished arm is stale).
  if [[ -s "$TARGET" && "$(slots_busy "$CEIL")" -gt 0 ]]; then
    echo "arm $PREFIX: adopting the machine-wide concurrency target $(cur_par) (another arm is reviewing)"
  else
    with_lock "$SLOTS/target.lock" set_par "$PAR" "arm $PREFIX starts" >/dev/null
    touch "$TARGET"
  fi
fi
echo "arm $PREFIX: $TOTAL case(s) in ${NJ} run(s), $(cur_par) at once$([[ "$ADAPT" == 1 ]] && echo " (adaptive, ceiling $CEIL)") — $(ts)"

# 2. One case in its own container, holding a machine-wide slot. Its outcome
#    comes from the `result:` line the case prints (never from the run dir).
case_worker() { # seq job id attempt
  local seq="$1" i="$2" id="$3" att="$4" out="$tmp/case.$1.log" line st=error retry=1 lim=0 quota=0 skipped=0
  with_slot env QCR_BENCH_MEMORY="${QCR_BENCH_REVIEW_MEMORY:-3g}" QCR_BENCH_CPUS="${QCR_BENCH_REVIEW_CPUS:-4}" \
    "$HERE/bench.sh" review --phase case --run "${JRUN[$i]}" --set "${JSET[$i]}" --only "$id" \
    ${CFG[@]+"${CFG[@]}"} > "$out" 2>&1
  line="$(grep -F "result: $id " "$out" | tail -1)"
  if [[ -n "$line" ]]; then
    st="$(sed -E 's/.*result: [^ ]+ ([^ ]+) .*/\1/' <<< "$line")"
    retry="$(sed -E 's/.* retry=([0-9]+).*/\1/' <<< "$line")"
    lim="$(sed -E 's/.* limited=([0-9]+).*/\1/' <<< "$line")"
    [[ "$line" =~ \ quota=([0-9]+) ]] && quota="${BASH_REMATCH[1]}"
    [[ "$line" =~ \ skipped($|\ ) ]] && skipped=1
  fi
  with_lock "$tmp/log.lock" sh -c 'cat "$1" >> "$2"' _ "$out" "$QCR_BENCH_RUNS_DIR/${JRUN[$i]}.review.log"
  echo "$i $id $att $st $retry $lim $quota $skipped" > "$tmp/done.$seq.tmp" && mv "$tmp/done.$seq.tmp" "$tmp/done.$seq"
}

# 3. A run whose last case finished: close it, judge it, score it — while the
#    queue keeps other runs reviewing.
post_run() { # job
  local i="$1" run="${JRUN[$1]}" rc=0
  "$HERE/bench.sh" review --phase finish --run "$run" --set "${JSET[$i]}" --only "${CASES_OF[$i]}" \
    >> "$QCR_BENCH_RUNS_DIR/$run.review.log" 2>&1 || rc=$?
  echo "$run: review exit $rc $(ts) — $(grep -E 'review: [0-9]+/[0-9]+ ok' "$QCR_BENCH_RUNS_DIR/$run.review.log" | tail -1 | sed -E 's/^\[[^]]*\] //')"
  judge_and_eval "$run" "${JSET[$i]}" "${CASES_OF[$i]}" || rc=1
  echo "$rc" > "$tmp/post.$i"
}

running=0 seq=0 last=0 pause_until=0 stop=0 done_n=0 ok_n=0 bad_n=0 waiting=0
# Launch time per case seq. A case `--resume` skipped (already reviewed) is
# dropped at once: it never grew, so it must not hold memory admission for
# five minutes (a resume of many done cases would otherwise admit new reviews
# one a minute however much memory is free).
declare -A LAUNCHED=(); POSTS=()
mem_ok() { # room for one more review, counting the ones launched in the last 5 min as still growing
  local a now=$1 recent=0 t
  a="$(mem_avail_mb)"; [[ -n "$a" ]] || return 0
  for t in ${LAUNCHED[@]+"${LAUNCHED[@]}"}; do (( now - t < 300 )) && recent=$(( recent + 1 )); done
  (( a - RESERVE_MB >= REVIEW_MB * (1 + recent) ))
}
finish_case() { # job
  LEFT[$1]=$(( LEFT[$1] - 1 ))
  if [[ "${LEFT[$1]}" == 0 ]]; then post_run "$1" & POSTS+=($!); fi
}
while :; do
  for f in "$tmp"/done.*; do
    [[ -e "$f" && "$f" != *.tmp ]] || continue
    read -r i id att st retry lim quota skipped < "$f"; rm -f "$f"
    [[ "${skipped:-0}" == 1 ]] && unset "LAUNCHED[${f##*.}]"
    running=$(( running - 1 ))
    if [[ "$st" == ok ]]; then
      ok_n=$(( ok_n + 1 )); finish_case "$i"
    elif [[ "$st" == auth-stop ]]; then
      echo "$(ts) $id: the pi login is about to expire — no new reviews start (log in again, then re-run with --resume)"
      stop=1; bad_n=$(( bad_n + 1 )); finish_case "$i"
    elif [[ "${quota:-0}" -gt 0 ]]; then
      # The plan's usage window is spent: every arm on the machine stops launching.
      [[ "$ADAPT" == 1 || -d "$SLOTS" ]] && { mkdir -p "$SLOTS"; echo "$(date -u +%FT%TZ) $id" > "$QUOTA"; }
      echo "$(ts) $id: USAGE LIMIT of the model login reached ($quota call(s) refused) — NO new review starts on this machine; re-run with --resume once the plan window resets"
      stop=1; bad_n=$(( bad_n + 1 )); finish_case "$i"
    elif [[ "$retry" == 1 && "$att" -le "$RETRIES" && "$stop" == 0 ]]; then
      QUEUE+=("$i $id $(( att + 1 ))")
      echo "$(ts) $id: $st — queued again (retry $att of $RETRIES)"
      if [[ "$lim" -gt 0 ]]; then
        pause_until=$(( $(date +%s) + PAUSE ))
        echo "$(ts) $id: RATE-LIMITED ($lim model error(s)) — no new review starts for ${PAUSE}s"
        [[ "$ADAPT" == 1 ]] && with_lock "$SLOTS/target.lock" halve_par "rate-limited case $id"
      fi
      continue
    else
      bad_n=$(( bad_n + 1 )); finish_case "$i"
      echo "$(ts) $id: $st$([[ "$lim" -gt 0 ]] && echo " (RATE-LIMITED)") — not retried"
      [[ "$lim" -gt 0 && "$ADAPT" == 1 ]] && with_lock "$SLOTS/target.lock" halve_par "rate-limited case $id"
    fi
    done_n=$(( done_n + 1 ))
    echo "$(ts) $done_n/$TOTAL done (ok $ok_n, not ok $bad_n) — $running running, $(( ${#QUEUE[@]} - qh )) queued"
  done
  if [[ "$stop" == 1 ]]; then
    while (( qh < ${#QUEUE[@]} )); do read -r i id att <<< "${QUEUE[$qh]}"; qh=$(( qh + 1 )); bad_n=$(( bad_n + 1 )); finish_case "$i"; done
  fi
  (( qh >= ${#QUEUE[@]} && running == 0 )) && break
  now=$(date +%s)
  # Another arm hit the plan's usage limit after this one started: stop too.
  if [[ "$stop" == 0 && -e "$QUOTA" ]] && (( $(mtime "$QUOTA") >= START )); then
    echo "$(ts) USAGE LIMIT of the model login reached by another arm ($(cat "$QUOTA" 2>/dev/null)) — no new review starts; re-run with --resume once the plan window resets"
    stop=1; continue
  fi
  cp="$(cur_par)"
  # Step up when the pool is full, work is waiting and memory admits more
  # (the cheap clock checks first; the slot probe and the lock only then).
  if [[ "$ADAPT" == 1 ]] && (( qh < ${#QUEUE[@]} && cp < CEIL && now >= pause_until \
      && now - $(mtime "$TARGET") >= RAMP_SECS && now - $(mtime "$LASTLIM") >= RAMP_SECS )); then
    if (( $(slots_busy "$cp") >= cp )) && mem_ok "$now"; then
      with_lock "$SLOTS/target.lock" ramp_par "$now" "$cp"
      cp="$(cur_par)"
    fi
  fi
  if (( qh < ${#QUEUE[@]} && running < cp && now >= pause_until && now - last >= GAP )); then
    if mem_ok "$now"; then
      read -r i id att <<< "${QUEUE[$qh]}"; qh=$(( qh + 1 ))
      seq=$(( seq + 1 )); running=$(( running + 1 )); last="$now"; LAUNCHED[$seq]="$now"; waiting=0
      case_worker "$seq" "$i" "$id" "$att" &
      continue
    elif [[ "$waiting" == 0 ]]; then
      echo "$(ts) waiting for memory: MemAvailable $(mem_avail_mb) MB, need $(( RESERVE_MB + REVIEW_MB )) MB plus ${REVIEW_MB} MB per review started in the last 5 min"
      waiting=1
    fi
  fi
  sleep "$POLL"
done
for p in ${POSTS[@]+"${POSTS[@]}"}; do wait "$p"; done
for ((i = 0; i < NJ; i++)); do
  [[ "${LEFT[$i]}" == -1 ]] && continue
  [[ "$(cat "$tmp/post.$i" 2>/dev/null || echo 1)" == 0 ]] || fail=1
done
[[ "$bad_n" -gt 0 ]] && fail=1
echo "arm $PREFIX done $(ts) — $ok_n/$TOTAL ok$([[ $fail == 1 ]] && echo ' — WITH FAILURES (see above; --resume re-runs only what is not ok)')"
exit "$fail"
