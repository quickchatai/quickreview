#!/usr/bin/env bash
# AACR-Bench for quickreviewd — the host side. Everything real happens in the
# `qcr-bench` docker sandbox; this script only builds it and wires the mounts.
#
#   bench/aacr/bench.sh doctor
#   bench/aacr/bench.sh build
#   bench/aacr/bench.sh prefetch [--set smoke10] [--only id,id] [--wait-rate-limit]
#   bench/aacr/bench.sh review   --run ID [--set smoke10] [--only id,id] [--profile NAME]
#                                [--timeout-min 45] [--concurrency 1] [--resume]
#   bench/aacr/bench.sh eval     --run ID [--set smoke10] [--judge mock|openai|codex] [--rounds 3]
#   bench/aacr/bench.sh report   --run ID [--set smoke10]
#   bench/aacr/bench.sh results  --run ID [--set smoke10]    rebuild scored files from case dirs (no model calls)
#   bench/aacr/bench.sh smoke    [--run ID] [--judge mock|codex]   build → prefetch → review → eval
#   bench/aacr/bench.sh shell    --run ID                            a shell in the review sandbox
#
# What the sandbox can touch on this PC (and nothing else):
#   - bench/aacr/runs/<ID>/                 read-write: prompts, transcripts, results, report
#                                           (bench.sh itself never writes inside it)
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
REPO="$(cd "$HERE/../.." && pwd)"
IMAGE="${QCR_BENCH_IMAGE:-qcr-bench:latest}"
REPOS_VOLUME="${QCR_BENCH_REPOS_VOLUME:-qcr-bench-repos}"
AUTH_VOLUME="${QCR_BENCH_AUTH_VOLUME:-companion-pihome}"
CPUS="${QCR_BENCH_CPUS:-4}"
MEMORY="${QCR_BENCH_MEMORY:-8g}"

die() { echo "bench: $*" >&2; exit 1; }

cmd="${1:-}"; shift || true
RUN="" SET="smoke10" ONLY="" JUDGE="mock" ROUNDS="" EXTRA=()
while (($#)); do
  case "$1" in
    --run) RUN="$2"; shift 2 ;;
    --set) SET="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --judge) JUDGE="$2"; shift 2 ;;
    --rounds) ROUNDS="$2"; shift 2 ;;
    --profile|--timeout-min|--concurrency) EXTRA+=("$1" "$2"); shift 2 ;;
    --resume|--wait-rate-limit|--keep-tree) EXTRA+=("$1"); shift ;;
    *) die "unknown flag $1 (see the header of $0)" ;;
  esac
done
# First character alphanumeric: `.`, `..` and dotfile ids would mount the wrong dir.
[[ -z "$RUN" || "$RUN" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--run must start with [A-Za-z0-9] and use only [A-Za-z0-9._-]"
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
  local d="$HERE/runs/$RUN"
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
  { echo "# $(date -u +%FT%TZ) $cmd"; printf '%q ' docker run "$@"; echo; } >> "$HERE/runs/$RUN.sandbox-commands.log"
}

case "$cmd" in
  doctor)
    docker version --format 'docker {{.Server.Version}}' || die "docker not reachable"
    docker image inspect "$IMAGE" --format "image $IMAGE {{.Id}} built {{.Created}}" 2>/dev/null || echo "image $IMAGE: not built"
    docker volume inspect "$REPOS_VOLUME" >/dev/null 2>&1 && echo "repos volume $REPOS_VOLUME: present" || echo "repos volume $REPOS_VOLUME: not created yet"
    docker volume inspect "$AUTH_VOLUME" >/dev/null 2>&1 && echo "auth volume $AUTH_VOLUME: present" || echo "auth volume $AUTH_VOLUME: MISSING"
    ;;

  build)
    commit="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    [[ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]] || commit="$commit-dirty"
    # The build context is ASSEMBLED from an explicit allowlist — only what a
    # review round reads. .git, state/, secrets, scripts/ (the posting route),
    # deploy/, docs/, tests/ and every run output never reach the builder.
    ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
    ( cd "$REPO" && tar -cf - --exclude=node_modules --exclude='*.tsbuildinfo' \
        package.json package-lock.json tsconfig.json config.toml AGENTS.md CLAUDE.md .pi \
        src extensions prompts agents profiles \
        bench/aacr/Dockerfile bench/aacr/sets bench/aacr/judge_shim.py bench/aacr/in-container.sh ) \
      | tar -xf - -C "$ctx"
    docker build -t "$IMAGE" --build-arg "QCR_BENCH_COMMIT=$commit" -f "$ctx/bench/aacr/Dockerfile" "$ctx"
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
    d="$(run_dir)"; auth_mounts
    args=("${HARDEN[@]}" "${AUTH[@]}"
      --mount "type=volume,src=$REPOS_VOLUME,dst=/repos,readonly"
      --mount "type=bind,src=$d,dst=/bench-out"
      "$IMAGE" review "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"})
    record "${args[@]}"
    docker run "${args[@]}"
    ;;

  eval)
    need_image
    d="$(run_dir)"
    rounds="${ROUNDS:-$([[ "$JUDGE" == mock ]] && echo 1 || echo 3)}"
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
    docker run "${HARDEN[@]}" --network none --mount "type=bind,src=$d,dst=/bench-out" \
      "$IMAGE" report "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"}
    echo "report: $d/report.md"
    ;;

  results)
    need_image
    d="$(run_dir)"
    docker run "${HARDEN[@]}" --network none --mount "type=bind,src=$d,dst=/bench-out" \
      "$IMAGE" results "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"}
    ;;

  smoke)
    RUN="${RUN:-smoke-$(date -u +%Y%m%d-%H%M%S)}"
    "$0" build
    "$0" prefetch --set "$SET" ${ONLY:+--only "$ONLY"}
    "$0" review --run "$RUN" --set "$SET" ${ONLY:+--only "$ONLY"} ${EXTRA[@]+"${EXTRA[@]}"} || echo "bench: some cases did not finish cleanly — scoring anyway (they count as zero findings)" >&2
    "$0" eval --run "$RUN" --set "$SET" --judge "$JUDGE" ${ONLY:+--only "$ONLY"} ${ROUNDS:+--rounds "$ROUNDS"}
    ;;

  shell)
    need_image
    d="$(run_dir)"; auth_mounts
    docker run -it "${HARDEN[@]}" "${AUTH[@]}" \
      --mount "type=volume,src=$REPOS_VOLUME,dst=/repos,readonly" \
      --mount "type=bind,src=$d,dst=/bench-out" "$IMAGE" shell
    ;;

  *) sed -n '2,26p' "$0"; exit 2 ;;
esac
