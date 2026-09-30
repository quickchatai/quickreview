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
#                       levers16           the 16 PRs the 2026-09-27 levers were measured on
#                       all30              smoke10 + dev10 + holdout10
#                       full               the 196-PR AACR set: judged against every defect
#                                          set it overlaps (the 40 PRs with ground truth)
#   --arm qcr|ocr     quickreviewd (default) or the open-code-review baseline (bench.sh --arm ocr;
#                     OCR reviews one case at a time in one container per set, as its harness does)
#   --arm codex       the Codex CLI arm (bench.sh --arm codex; the harness's reviewers/codex.py,
#                     one case at a time in one container per set, like ocr)
#   --arm opencode    OpenCode (bench.sh --arm opencode), one case at a time in one container per
#                     set, like ocr
#   --arm pireview    @zephyrdeng/pi-review (bench.sh --arm pireview), one case at a time in one
#                     container per set, like ocr
#   --arm pragent     PR-Agent (bench.sh --arm pragent; /review + /improve on gpt-6.1-sol), one case
#                     at a time in one container per set, like ocr
#   --arm claude      Claude Code as a benchmarked reviewer (bench.sh --arm claude; root CLAUDE.md
#                     rule 5's one ratified exception — inside its sandbox only): the ocr path, one
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
#
# Scheduling (the quickreviewd arm). Every case of every set and every repeat
# goes on ONE queue, longest PR first (the set's change_line_count), and each
# case runs in its OWN hardened container (bench.sh review --phase case), so
# no slot ever idles on a set that finished early. A case takes one of
# --parallel machine-wide slots (flock on $QCR_BENCH_RUNS_DIR/.slots/, shared
# with every other arm.sh on this machine — the model login and the RAM are
# machine-wide, so two arms launched side by side split the slots instead of
# doubling the load). `auto` = (MemAvailable - QCR_BENCH_RESERVE_MB) /
# QCR_BENCH_REVIEW_MB, capped at QCR_BENCH_MAX_PARALLEL (the login's share,
# default 10); a new review also waits while MemAvailable is short. A run's
# judge (one slot) and eval (one machine-wide eval lock) start the moment its
# last case finishes, while other runs are still reviewing. A case that failed
# under rate limiting pauses new launches for QCR_BENCH_RATE_LIMIT_PAUSE
# seconds (default 300) and is retried; `--resume` later re-runs only what is
# still not ok.
#
#   QCR_BENCH_REVIEW_MB=1024     memory budget per concurrent review (auto + the admission check;
#                                measured: ~250 MB anon + ~200 MB page cache typical, up to ~1 GB
#                                with 6 lens children at once)
#   QCR_BENCH_RESERVE_MB=3072    MemAvailable kept free for the rest of the machine
#   QCR_BENCH_MAX_PARALLEL=10    auto never exceeds this (the one ChatGPT login)
#   QCR_BENCH_REVIEW_MEMORY=3g   the hard cap of one case container (QCR_BENCH_MEMORY for it)
#   QCR_BENCH_REVIEW_CPUS=4      its cpu cap
#   QCR_BENCH_EVAL_CPUS=8        the eval container's cpu cap (it runs shards × variants pi judges)
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
    *) echo "unknown flag $1 (see the header of $0)" >&2; exit 2 ;;
  esac
done
[[ -n "$PREFIX" && -n "$CASES" ]] || { echo "--prefix and --cases are required" >&2; exit 2; }
[[ "$ARM" == qcr || "$ARM" == ocr || "$ARM" == codex || "$ARM" == opencode || "$ARM" == claude || "$ARM" == pireview || "$ARM" == pragent ]] || { echo "--arm must be qcr | ocr | codex | opencode | pireview | pragent | claude" >&2; exit 2; }
[[ "$ARM" == qcr || -z "$CONFIG" ]] || { echo "--config sets quickreviewd levers; the $ARM arm has none" >&2; exit 2; }
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

REVIEW_MB="${QCR_BENCH_REVIEW_MB:-1024}" RESERVE_MB="${QCR_BENCH_RESERVE_MB:-3072}"
MAX_PAR="${QCR_BENCH_MAX_PARALLEL:-10}" PAUSE="${QCR_BENCH_RATE_LIMIT_PAUSE:-300}"
POLL="${QCR_BENCH_POLL:-2}" GAP="${QCR_BENCH_LAUNCH_GAP:-3}"
SLOTS="$QCR_BENCH_RUNS_DIR/.slots"

# MemAvailable in MB; QCR_BENCH_MEM_AVAILABLE_MB overrides (tests), "" = unknown (not Linux).
mem_avail_mb() {
  if [[ -n "${QCR_BENCH_MEM_AVAILABLE_MB:-}" ]]; then echo "$QCR_BENCH_MEM_AVAILABLE_MB"; return; fi
  awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null
}
if [[ "$PAR" == auto ]]; then
  avail="$(mem_avail_mb)"
  if [[ -z "$avail" ]]; then PAR=4
  else
    PAR=$(( (avail - RESERVE_MB) / REVIEW_MB ))
    (( PAR > MAX_PAR )) && PAR="$MAX_PAR"
    (( PAR < 1 )) && PAR=1
  fi
  [[ "$ARM" == qcr ]] && echo "arm $PREFIX: $PAR review slot(s) — auto: MemAvailable ${avail:-unknown} MB, ${REVIEW_MB} MB per review, ${RESERVE_MB} MB reserve, login cap $MAX_PAR"
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
for j in "${jobs[@]}"; do
  set_name="${j%%|*}"
  [[ -f "$HERE/sets/$set_name.json" ]] || { echo "no case set $set_name" >&2; exit 2; }
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
# Run a command holding one of $PAR machine-wide review slots.
with_slot() { # cmd...
  if ! command -v flock >/dev/null 2>&1; then "$@"; return; fi
  mkdir -p "$SLOTS"
  local s rc got="$(mktemp)"
  rm -f "$got"
  while :; do
    for ((s = 0; s < PAR; s++)); do
      ( flock -n 9 || exit 0; : > "$got"; "$@" ) 9>"$SLOTS/slot.$s.lock"
      rc=$?
      [[ -e "$got" ]] && { rm -f "$got"; return "$rc"; }
    done
    sleep "$POLL"
  done
}

record_arm() { # run set ids
  printf '{"arm":"%s","image":"%s","image_id":"%s","config":"%s","cases":"%s","parallel":"%s","started":"%s"}\n' \
    "$ARM" "$IMG" "$IMG_ID" "$CONFIG" "$2:$3" "$PAR" "$(date -u +%FT%TZ)" > "$QCR_BENCH_RUNS_DIR/$1.arm.json"
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
    # `full` run spans several defect sets), always in the quickreviewd image.
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

# ---- the quickreviewd arm: one machine-wide queue, one container per case ----------
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
done < <(for ((i = 0; i < NJ; i++)); do [[ -n "${CASES_OF[$i]}" ]] && echo "$i ${JSET[$i]} ${CASES_OF[$i]}"; done \
  | python3 -c '
import json, os, sys
rows = []
for n, line in enumerate(sys.stdin):
    i, s, ids = line.split()
    size = {c["instance_id"]: c.get("change_line_count") or 0 for c in json.load(open(os.path.join(sys.argv[1], s + ".json")))["cases"]}
    rows += [(-size.get(c, 0), n, k, i, c) for k, c in enumerate(ids.split(","))]
for r in sorted(rows):
    print(r[3], r[4])
' "$HERE/sets")
TOTAL=$(( ${#QUEUE[@]} ))
echo "arm $PREFIX: $TOTAL case(s) in ${NJ} run(s), $PAR at once — $(ts)"

# 2. One case in its own container, holding a machine-wide slot. Its outcome
#    comes from the `result:` line the case prints (never from the run dir).
case_worker() { # seq job id attempt
  local seq="$1" i="$2" id="$3" att="$4" out="$tmp/case.$1.log" line st=error retry=1 lim=0
  with_slot env QCR_BENCH_MEMORY="${QCR_BENCH_REVIEW_MEMORY:-3g}" QCR_BENCH_CPUS="${QCR_BENCH_REVIEW_CPUS:-4}" \
    "$HERE/bench.sh" review --phase case --run "${JRUN[$i]}" --set "${JSET[$i]}" --only "$id" \
    ${CFG[@]+"${CFG[@]}"} > "$out" 2>&1
  line="$(grep -F "result: $id " "$out" | tail -1)"
  if [[ -n "$line" ]]; then
    st="$(sed -E 's/.*result: [^ ]+ ([^ ]+) .*/\1/' <<< "$line")"
    retry="$(sed -E 's/.* retry=([0-9]+).*/\1/' <<< "$line")"
    lim="$(sed -E 's/.* limited=([0-9]+).*/\1/' <<< "$line")"
  fi
  with_lock "$tmp/log.lock" sh -c 'cat "$1" >> "$2"' _ "$out" "$QCR_BENCH_RUNS_DIR/${JRUN[$i]}.review.log"
  echo "$i $id $att $st $retry $lim" > "$tmp/done.$seq.tmp" && mv "$tmp/done.$seq.tmp" "$tmp/done.$seq"
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
LAUNCHED=() POSTS=()
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
    read -r i id att st retry lim < "$f"; rm -f "$f"
    running=$(( running - 1 ))
    if [[ "$st" == ok ]]; then
      ok_n=$(( ok_n + 1 )); finish_case "$i"
    elif [[ "$st" == auth-stop ]]; then
      echo "$(ts) $id: the pi login is about to expire — no new reviews start (log in again, then re-run with --resume)"
      stop=1; bad_n=$(( bad_n + 1 )); finish_case "$i"
    elif [[ "$retry" == 1 && "$att" -le "$RETRIES" && "$stop" == 0 ]]; then
      QUEUE+=("$i $id $(( att + 1 ))")
      echo "$(ts) $id: $st — queued again (retry $att of $RETRIES)"
      if [[ "$lim" -gt 0 ]]; then
        pause_until=$(( $(date +%s) + PAUSE ))
        echo "$(ts) $id: RATE-LIMITED ($lim model error(s)) — no new review starts for ${PAUSE}s"
      fi
      continue
    else
      bad_n=$(( bad_n + 1 )); finish_case "$i"
      echo "$(ts) $id: $st$([[ "$lim" -gt 0 ]] && echo " (RATE-LIMITED)") — not retried"
    fi
    done_n=$(( done_n + 1 ))
    echo "$(ts) $done_n/$TOTAL done (ok $ok_n, not ok $bad_n) — $running running, $(( ${#QUEUE[@]} - qh )) queued"
  done
  if [[ "$stop" == 1 ]]; then
    while (( qh < ${#QUEUE[@]} )); do read -r i id att <<< "${QUEUE[$qh]}"; qh=$(( qh + 1 )); bad_n=$(( bad_n + 1 )); finish_case "$i"; done
  fi
  (( qh >= ${#QUEUE[@]} && running == 0 )) && break
  now=$(date +%s)
  if (( qh < ${#QUEUE[@]} && running < PAR && now >= pause_until && now - last >= GAP )); then
    if mem_ok "$now"; then
      read -r i id att <<< "${QUEUE[$qh]}"; qh=$(( qh + 1 ))
      seq=$(( seq + 1 )); running=$(( running + 1 )); last="$now"; LAUNCHED+=("$now"); waiting=0
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
