#!/usr/bin/env bash
# AACR-Bench for quickreviewd — the host side. Everything real happens in the
# `qcr-bench` docker sandbox; this script only builds it and wires the mounts.
#
#   bench/aacr/bench.sh doctor
#   bench/aacr/bench.sh build
#   bench/aacr/bench.sh prefetch [--set smoke10] [--only id,id] [--wait-rate-limit]
#   bench/aacr/bench.sh review   --run ID [--set smoke10] [--only id,id] [--profile NAME]
#                                [--timeout-min 45] [--concurrency 1] [--resume]
#                                [--config models.effort=high,review.sweep=false] [--phase all|init|case|finish]
#              --phase: arm.sh's split of one run into one container per case (init/finish
#              run --network none with no login; see src/bench/cli.ts)
#              --config: config.toml levers for THIS run only, so two arms share one image
#   bench/aacr/bench.sh eval     --run ID [--set smoke10] [--judge mock|openai|codex] [--rounds 3] [--line-k N]
#                                [--shards N] [--variants all,no-nits,blockers]
#              --shards N: split the instances into N harness processes per variant (variants
#              always run side by side) and merge their counts with the harness's own
#              summary functions (eval_shards.py) — same numbers, N× sooner. --variants
#              limits which variants are scored (compare.py reads only `all`)
#              --line-k N (default 1, the published setting): N != 1 is a DIAGNOSTIC that scores a copy of
#              the `all` results in results/all-kN/ and leaves the official numbers untouched
#   bench/aacr/bench.sh judge    --run ID [--set smoke10] [--rounds 1] [--judge-model M] [--concurrency 3] [--resume]
#              THE DEFECT BENCHMARK: did the review find each real defect in
#              bench/aacr/defects/<set>.json, and is each comment true? Works on
#              any run dir (either arm, archived too). → <run>/judge/<label>/report.md
#   bench/aacr/bench.sh judge-report --run ID [--set smoke10] [--label L]   re-score, no model calls
#   QCR_BENCH_RUNS_DIR=DIR   where runs live (default bench/aacr/runs) — keep them outside worktrees
#   QCR_BENCH_OCR_EFFORT=L   the OCR arm's reasoning effort (low|medium|high|xhigh|max; default medium)
#   bench/aacr/bench.sh results  --run ID [--set smoke10]    rebuild scored files from case dirs (no model calls)
#   bench/aacr/bench.sh smoke    [--run ID] [--judge mock|codex]   build → prefetch → review → eval
#   bench/aacr/bench.sh shell    --run ID                            a shell in the review sandbox
#   bench/aacr/bench.sh whatif   --run ID --from RUN_DIR [--set smoke10] [--judge codex] [--rounds 3] [--force]
#                                what-if lever scorer: copy a FINISHED run's files (regular files
#                                only) into whatif/ID/source, build the variants posted /
#                                posted+killed / posted+merged / all-candidates, score them, and
#                                write whatif/ID/report.md
#   bench/aacr/bench.sh whatif-eval   --run ID [--judge codex] [--rounds 3]   re-score the variants
#   bench/aacr/bench.sh whatif-report --run ID                                 re-render the report
#
#   --arm ocr  (build, review, eval, report, shell, smoke): the open-code-review
#              baseline — image qcr-bench-ocr (the same runtime + OCR 1.3.1 + the
#              loopback Codex bridge), `review` runs OCR the way the AACR harness
#              runs it (one case at a time; --ocr-concurrency / --max-tools /
#              --timeout-min = its 8 / 30 / 30), `eval` scores the `all` variant.
#
# What the sandbox can touch on this PC (and nothing else):
#   - bench/aacr/runs/<ID>/                 read-write: prompts, transcripts, results, report
#                                           (bench.sh itself never writes inside it)
#   - bench/aacr/whatif/<ID>/               read-write, what-if runs only: bench.sh copies a
#                                           finished run's regular files into a FRESH source/
#                                           there first, and the sandbox sees only that copy
#   - docker volume qcr-bench-repos         the prefetched repos (read-only during review)
#   - docker volume $QCR_BENCH_AUTH_VOLUME  READ-ONLY, only its agent/ dir, for the pi login;
#     (default companion-pihome)           its sessions/ hidden by an empty tmpfs. The sandbox
#                                           copies the access token into its own tmpfs with the
#                                           refresh token disabled — it never writes the
#                                           companion's config and never rotates its grant.
# Root filesystem read-only, all capabilities dropped, no-new-privileges, non-root uid,
# pids/memory/cpu capped. No docker socket, no ssh agent, no host network namespace, no
# GitHub credential, no posting scripts, no gh. Review and codex-judge containers DO have
# ordinary bridge egress (the model API needs it); every other step runs --network none
# or talks only to github.com.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Where runs live. Default: bench/aacr/runs in this checkout. Point it at a
# directory OUTSIDE any worktree (QCR_BENCH_RUNS_DIR=~/…/qcr-bench-runs/runs)
# so removing a worktree never deletes a run that may be re-judged later.
RUNS_DIR="${QCR_BENCH_RUNS_DIR:-$HERE/runs}"
REPO="$(cd "$HERE/../.." && pwd)"
REPOS_VOLUME="${QCR_BENCH_REPOS_VOLUME:-qcr-bench-repos}"
AUTH_VOLUME="${QCR_BENCH_AUTH_VOLUME:-companion-pihome}"
CPUS="${QCR_BENCH_CPUS:-4}"
MEMORY="${QCR_BENCH_MEMORY:-8g}"

die() { echo "bench: $*" >&2; exit 1; }

cmd="${1:-}"; shift || true
RUN="" SET="smoke10" ONLY="" JUDGE="mock" ROUNDS="" LINE_K="1" ARM="qcr" EXTRA=() FROM="" FORCE=0 JARGS=()
PHASE="all" SHARDS="1" VARIANTS=""
while (($#)); do
  case "$1" in
    --run) RUN="$2"; shift 2 ;;
    --arm) ARM="$2"; shift 2 ;;
    --set) SET="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --judge) JUDGE="$2"; shift 2 ;;
    --rounds) ROUNDS="$2"; shift 2 ;;
    --line-k) LINE_K="$2"; shift 2 ;;
    --judge-model) JARGS+=(--model "$2"); shift 2 ;;
    --label) JARGS+=(--label "$2"); shift 2 ;;
    --profile|--timeout-min|--concurrency|--ocr-concurrency|--max-tools|--config) EXTRA+=("$1" "$2"); shift 2 ;;
    --phase) PHASE="$2"; EXTRA+=("$1" "$2"); shift 2 ;;
    --shards) SHARDS="$2"; shift 2 ;;
    --variants) VARIANTS="$2"; shift 2 ;;
    --resume|--wait-rate-limit|--keep-tree) EXTRA+=("$1"); shift ;;
    --from) FROM="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) die "unknown flag $1 (see the header of $0)" ;;
  esac
done
case "$ARM" in
  qcr) IMAGE="${QCR_BENCH_IMAGE:-qcr-bench:latest}"; TARGET=runtime; BASE_ARGS=(); REVIEW_ENTRY=review ;;
  # OCR needs git >= 2.41; bookworm ships 2.39 (Dockerfile header).
  ocr) IMAGE="${QCR_BENCH_OCR_IMAGE:-qcr-bench-ocr:latest}"; TARGET=ocr
       BASE_ARGS=(--build-arg RUNTIME_BASE=node:22-trixie); REVIEW_ENTRY=ocr-review ;;
  *) die "--arm must be qcr | ocr" ;;
esac
# First character alphanumeric: `.`, `..` and dotfile ids would mount the wrong dir.
[[ -z "$RUN" || "$RUN" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--run must start with [A-Za-z0-9] and use only [A-Za-z0-9._-]"
[[ "$LINE_K" =~ ^[0-9]{1,3}$ ]] || die "--line-k must be a small non-negative integer"
[[ "$PHASE" =~ ^(all|init|case|finish)$ ]] || die "--phase must be all | init | case | finish"
[[ "$SHARDS" =~ ^[1-9][0-9]?$ ]] || die "--shards must be 1..99"
[[ -z "$VARIANTS" || "$VARIANTS" =~ ^[a-z+,-]+$ ]] || die "--variants takes variant names joined by ','"
ONLY_ARGS=(); [[ -n "$ONLY" ]] && ONLY_ARGS=(--only "$ONLY")
# `${a[@]+"${a[@]}"}` everywhere below: an empty array under `set -u` aborts
# bash < 4.4 (stock macOS bash 3.2).

HARDEN=(
  --rm --init --read-only
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 4096 --memory "$MEMORY" --cpus "$CPUS"
  --user "$(id -u):$(id -g)"
  --tmpfs /tmp:rw,exec,nosuid,size=4g,mode=1777
  --tmpfs /opt/quickreview/sandbox/state:rw,nosuid,size=64m,mode=1777
  --tmpfs /opt/quickreview/sandbox/.pi:rw,nosuid,size=64m,mode=1777
  --mount type=volume,dst=/opt/quickreview/sandbox/wt
)

need_image() { docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image $IMAGE — run: $0 build"; }

run_dir() {
  [[ -n "$RUN" ]] || die "--run <id> is required"
  local d="$RUNS_DIR/$RUN"
  # The container writes freely inside the run dir, so the host never writes
  # or follows anything in it; the dir itself must not be a planted symlink.
  [[ ! -L "$d" ]] || die "$d is a symlink — refusing to mount it"
  mkdir -p "$d"
  echo "$d"
}

auth_mounts() {
  docker volume inspect "$AUTH_VOLUME" >/dev/null 2>&1 \
    || die "docker volume $AUTH_VOLUME not found — it must hold a pi login (agent/auth.json). Set QCR_BENCH_AUTH_VOLUME."
  docker run --rm --entrypoint test --user "$(id -u):$(id -g)" --network none \
    --mount "type=volume,src=$AUTH_VOLUME,dst=/p,volume-subpath=agent,readonly" "$IMAGE" -r /p/auth.json \
    || die "$AUTH_VOLUME has no readable agent/auth.json for uid $(id -u) — log pi in there first (the companion's /login)"
  AUTH=(
    --mount "type=volume,src=$AUTH_VOLUME,dst=/pi-agent-src,volume-subpath=agent,readonly"
    --mount "type=tmpfs,dst=/pi-agent-src/sessions"
  )
}

# The reproduction log lives NEXT TO the run dir, never inside it: a host-side
# append into a dir the container writes would follow a planted symlink.
record() {
  { echo "# $(date -u +%FT%TZ) $cmd"; printf '%q ' docker run "$@"; echo; } >> "$RUNS_DIR/$RUN.sandbox-commands.log"
}
record_whatif() {
  { echo "# $(date -u +%FT%TZ) $cmd"; printf '%q ' docker run "$@"; echo; } >> "$HERE/whatif/$RUN.sandbox-commands.log"
}

# The judge's network, env and mounts, shared by `eval` and `whatif-eval`.
judge_args() {
  envs=(); mounts=(); net=()
  case "$JUDGE" in
    mock) net=(--network none) ;;
    openai)
      [[ -f "$HERE/judge.env" ]] || die "judge openai needs bench/aacr/judge.env (JUDGE_BASE_URL, JUDGE_API_KEY, JUDGE_MODEL) — see README"
      envs=(--env-file "$HERE/judge.env") ;;
    codex)
      auth_mounts; mounts=("${AUTH[@]}")
      [[ -n "${JUDGE_CODEX_MODEL:-}" ]] && envs=(-e "JUDGE_CODEX_MODEL=$JUDGE_CODEX_MODEL") ;;
    *) die "--judge must be mock | openai | codex" ;;
  esac
  return 0
}

# A what-if run's own dir: whatif/<ID>/, never inside runs/.
whatif_dir() {
  [[ -n "$RUN" ]] || die "--run <id> is required"
  local d="$HERE/whatif/$RUN"
  [[ ! -L "$HERE/whatif" && ! -L "$d" ]] || die "$d (or whatif/) is a symlink — refusing it"
  echo "$d"
}

# Copy what the what-if scorer reads from a finished run into a FRESH
# whatif/<ID>/source. The source was written by a review sandbox, so nothing
# in it is followed: only regular, non-symlink files at known names are
# copied, case dirs must look like instance ids, and `cp -P` never
# dereferences. The container then sees only this copy.
copy_source() {
  local src="$1" dst="$2/source" c id f n
  [[ -d "$src" && ! -L "$src" && -d "$src/cases" && ! -L "$src/cases" \
     && -d "$src/results/all" && ! -L "$src/results" && ! -L "$src/results/all" ]] \
    || die "--from $src is not a finished run dir (cases/ and results/all/, no symlinks)"
  mkdir -p "$dst/cases" "$dst/results/all"
  for f in run.json judge.txt; do
    if [[ -f "$src/$f" && ! -L "$src/$f" ]]; then cp -P -- "$src/$f" "$dst/$f"; fi
  done
  for c in "$src"/cases/*; do
    id="$(basename "$c")"
    [[ "$id" =~ ^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+@[0-9a-f]{7}$ && -d "$c" && ! -L "$c" ]] || continue
    mkdir -p "$dst/cases/$id"
    for f in pi-events.jsonl findings-record.json comments.json review.md case-summary.json outcome.json; do
      if [[ -f "$c/$f" && ! -L "$c/$f" ]]; then cp -P -- "$c/$f" "$dst/cases/$id/$f"; fi
    done
  done
  for f in "$src"/results/all/*.json; do
    n="$(basename "$f")"
    if [[ "$n" =~ ^[A-Za-z0-9_.@-]+\.json$ && -f "$f" && ! -L "$f" ]]; then
      cp -P -- "$f" "$dst/results/all/$n"
    fi
  done
  printf '%s\n' "$src" > "$dst/ORIGIN"
}

case "$cmd" in
  doctor)
    docker version --format 'docker {{.Server.Version}}' || die "docker not reachable"
    docker image inspect "$IMAGE" --format "image $IMAGE {{.Id}} built {{.Created}}" 2>/dev/null || echo "image $IMAGE: not built (arm $ARM)"
    docker volume inspect "$REPOS_VOLUME" >/dev/null 2>&1 && echo "repos volume $REPOS_VOLUME: present" || echo "repos volume $REPOS_VOLUME: not created yet"
    docker volume inspect "$AUTH_VOLUME" >/dev/null 2>&1 && echo "auth volume $AUTH_VOLUME: present" || echo "auth volume $AUTH_VOLUME: MISSING"
    ;;

  build)
    commit="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    [[ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]] || commit="$commit-dirty"
    # The build context is ASSEMBLED from an explicit allowlist — only what a
    # review round reads. .git, state/, secrets, scripts/ (the posting route),
    # deploy/ (bar the reviewer context stub production installs at boot),
    # docs/, tests/ and every run output never reach the builder.
    ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
    ( cd "$REPO" && tar -cf - --exclude=node_modules --exclude='*.tsbuildinfo' \
        package.json package-lock.json tsconfig.json config.toml AGENTS.md CLAUDE.md .pi \
        src extensions prompts agents profiles \
        bench/aacr/Dockerfile bench/aacr/sets bench/aacr/defects bench/aacr/judge_shim.py \
        bench/aacr/in-container.sh bench/aacr/codex_bridge.py bench/aacr/eval_shards.py \
        deploy/reviewer/AGENTS.override.md ) \
      | tar -xf - -C "$ctx"
    docker build --target "$TARGET" -t "$IMAGE" ${BASE_ARGS[@]+"${BASE_ARGS[@]}"} \
      --build-arg "QCR_BENCH_COMMIT=$commit" -f "$ctx/bench/aacr/Dockerfile" "$ctx"
    ;;

  prefetch)
    need_image
    # Network: github.com only in practice (anonymous https + the public API).
    docker run "${HARDEN[@]}" \
      --mount "type=volume,src=$REPOS_VOLUME,dst=/repos" \
      "$IMAGE" prefetch "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"}
    ;;

  review)
    need_image
    d="$(run_dir)"
    if [[ "$PHASE" == init || "$PHASE" == finish ]]; then
      # Bookkeeping only (run.json, the outcome tally): no model, no repos.
      [[ "$ARM" == qcr ]] || die "--phase belongs to the quickreviewd arm"
      args=("${HARDEN[@]}" --network none --mount "type=bind,src=$d,dst=/bench-out"
        "$IMAGE" review "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"})
      record "${args[@]}"
      exec docker run "${args[@]}"
    fi
    auth_mounts
    # The OCR arm's reasoning effort (its bridge's --effort; default medium).
    oe=(); [[ "$ARM" == ocr && -n "${QCR_BENCH_OCR_EFFORT:-}" ]] && oe=(-e "OCR_BRIDGE_EFFORT=$QCR_BENCH_OCR_EFFORT")
    args=("${HARDEN[@]}" "${AUTH[@]}" ${oe[@]+"${oe[@]}"}
      --mount "type=volume,src=$REPOS_VOLUME,dst=/repos,readonly"
      --mount "type=bind,src=$d,dst=/bench-out"
      "$IMAGE" "$REVIEW_ENTRY" "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"})
    record "${args[@]}"
    docker run "${args[@]}"
    ;;

  judge|judge-report)
    # The defect benchmark (src/bench/defects.ts): did the review FIND the real
    # defects, and is what it says true? Ground truth bench/aacr/defects/<set>.json
    # is mounted read-only, so a corrected truth needs no rebuild. judge-report
    # re-scores saved verdicts with no model call and no network.
    need_image
    d="$(run_dir)"
    [[ -f "$HERE/defects/$SET.json" ]] || die "no ground truth for $SET (bench/aacr/defects/$SET.json)"
    jm=(--mount "type=bind,src=$HERE/defects,dst=/opt/quickreview/bench/defects,readonly")
    jn=(--network none)
    if [[ "$cmd" == judge ]]; then
      auth_mounts; jm+=("${AUTH[@]}" --mount "type=volume,src=$REPOS_VOLUME,dst=/repos,readonly"); jn=()
    fi
    args=("${HARDEN[@]}" ${jn[@]+"${jn[@]}"} "${jm[@]}" -e "QCR_RUN_ID=$RUN"
      --mount "type=bind,src=$d,dst=/bench-out"
      "$IMAGE" "$cmd" "$SET" "${ROUNDS:-1}" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"} ${JARGS[@]+"${JARGS[@]}"})
    record "${args[@]}"
    docker run "${args[@]}"
    echo "report: $d/judge/*/report.md"
    ;;

  eval)
    need_image
    d="$(run_dir)"
    rounds="${ROUNDS:-$([[ "$JUDGE" == mock ]] && echo 1 || echo 3)}"
    judge_args
    envs+=(-e "BENCH_ARM=$ARM" -e "QCR_EVAL_SHARDS=$SHARDS")
    [[ -n "$VARIANTS" ]] && envs+=(-e "QCR_EVAL_VARIANTS=$VARIANTS")
    [[ "$LINE_K" != 1 ]] && envs+=(-e "QCR_LINE_K=$LINE_K")
    args=("${HARDEN[@]}" ${net[@]+"${net[@]}"} ${envs[@]+"${envs[@]}"} ${mounts[@]+"${mounts[@]}"}
      --mount "type=bind,src=$d,dst=/bench-out"
      "$IMAGE" eval "$SET" "$JUDGE" "$rounds" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"})
    record "${args[@]}"
    docker run "${args[@]}"
    echo "report: $d/report.md"
    ;;

  report)
    need_image
    d="$(run_dir)"
    docker run "${HARDEN[@]}" --network none -e "BENCH_ARM=$ARM" --mount "type=bind,src=$d,dst=/bench-out" \
      "$IMAGE" report "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"}
    echo "report: $d/report.md"
    ;;

  results)
    [[ "$ARM" == qcr ]] || die "results rebuilds the quickreviewd arm's scored files; the ocr arm writes its result files directly"
    need_image
    d="$(run_dir)"
    docker run "${HARDEN[@]}" --network none --mount "type=bind,src=$d,dst=/bench-out" \
      "$IMAGE" results "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"}
    ;;

  smoke)
    RUN="${RUN:-smoke-$(date -u +%Y%m%d-%H%M%S)}"
    "$0" build --arm "$ARM"
    "$0" prefetch --arm "$ARM" --set "$SET" ${ONLY:+--only "$ONLY"}
    "$0" review --arm "$ARM" --run "$RUN" --set "$SET" ${ONLY:+--only "$ONLY"} ${EXTRA[@]+"${EXTRA[@]}"} || echo "bench: some cases did not finish cleanly — scoring anyway (they count as zero findings)" >&2
    "$0" eval --arm "$ARM" --run "$RUN" --set "$SET" --judge "$JUDGE" ${ONLY:+--only "$ONLY"} ${ROUNDS:+--rounds "$ROUNDS"}
    ;;

  whatif|whatif-eval)
    need_image
    d="$(whatif_dir)"
    if [[ "$cmd" == whatif ]]; then
      [[ -n "$FROM" ]] || die "--from <finished run dir> is required"
      if [[ -e "$d" ]]; then
        [[ "$FORCE" == 1 ]] || die "$d exists — pick a new --run, or --force to replace it"
        rm -rf -- "$d"
      fi
      mkdir -p "$d"
      copy_source "$(cd "$FROM" && pwd -P)" "$d"
      args=("${HARDEN[@]}" --network none --mount "type=bind,src=$d,dst=/bench-out"
        "$IMAGE" whatif "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"})
      record_whatif "${args[@]}"
      docker run "${args[@]}"
    fi
    [[ -d "$d/results/posted" ]] || die "no what-if variants in $d — run: $0 whatif --run $RUN --from <run dir>"
    rounds="${ROUNDS:-$([[ "$JUDGE" == mock ]] && echo 1 || echo 3)}"
    judge_args
    args=("${HARDEN[@]}" ${net[@]+"${net[@]}"} ${envs[@]+"${envs[@]}"} ${mounts[@]+"${mounts[@]}"}
      --mount "type=bind,src=$d,dst=/bench-out"
      "$IMAGE" whatif-eval "$SET" "$JUDGE" "$rounds" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"})
    record_whatif "${args[@]}"
    docker run "${args[@]}"
    echo "report: $d/report.md"
    ;;

  whatif-report)
    need_image
    d="$(whatif_dir)"
    docker run "${HARDEN[@]}" --network none --mount "type=bind,src=$d,dst=/bench-out" \
      "$IMAGE" whatif-report "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"}
    echo "report: $d/report.md"
    ;;

  shell)
    need_image
    d="$(run_dir)"; auth_mounts
    docker run -it "${HARDEN[@]}" "${AUTH[@]}" \
      --mount "type=volume,src=$REPOS_VOLUME,dst=/repos,readonly" \
      --mount "type=bind,src=$d,dst=/bench-out" "$IMAGE" shell
    ;;

  *) sed -n '2,42p' "$0"; exit 2 ;;
esac
