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
#   QCR_BENCH_PR_TEXT=1      hand the PR title/body to the ocr/codex/opencode/pireview arm the way
#                            that tool takes review context (src/bench/prtext.ts; default off)
#   QCR_BENCH_PI_VERSION=V   `build`: install pi V in the image instead of the Dockerfile's pin
#   QCR_BENCH_{OCR,OPENCODE,CODEX,PIREVIEW}_MODEL=ID   `review`: the model that third-party arm
#                            runs, a Codex model id (default gpt-6-sol, the published runs); e.g.
#                            gpt-6.1-sol — pi-review then needs an image on pi >= 0.99 (its catalog)
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
#   --arm opencode (build, review, eval, report, shell, smoke): OpenCode (image
#              qcr-bench-opencode, `opencode-ai` pinned by OPENCODE_VERSION + sha256 in the
#              Dockerfile; QCR_BENCH_OPENCODE_VERSION + QCR_BENCH_OPENCODE_SHA256 build another)
#              run in the shape of the harness's codex runner — its built-in /review over
#              base...head, findings through the harness's MCP findings server, the model
#              through the loopback Codex bridge; one case at a time; `eval` scores `all`.
#              QCR_BENCH_OPENCODE_EFFORT=L its reasoning effort (default medium)
#              QCR_BENCH_OPENCODE_PROVIDER=native: OpenCode's OWN ChatGPT provider (no bridge;
#              its built-in /review as shipped, subtask:true; a refresh-disabled auth.json)
#   --arm pireview (build, review, eval, report, shell, smoke): @zephyrdeng/pi-review (image
#              qcr-bench-pireview; the npm tarball pinned by PIREVIEW_VERSION + sha512 in the
#              Dockerfile; QCR_BENCH_PIREVIEW_VERSION + QCR_BENCH_PIREVIEW_SHA512 build another)
#              on the image's pi (1.0.0): its CLI, single reviewer, mode code, over
#              `git diff base...head` attached as @file, gpt-6-sol through pi's openai-codex
#              provider on the refresh-disabled login copy; one case at a time; `eval` scores
#              `all`. QCR_BENCH_PIREVIEW_THINKING=L its --thinking (default medium);
#              QCR_BENCH_PIREVIEW_PANEL=code-experts the 3-reviewer panel /rv runs
#   --arm pragent (build, review, eval, report, shell, smoke): PR-Agent (qodo-ai/pr-agent; image
#              qcr-bench-pragent, pip `pr-agent` pinned by PRAGENT_VERSION + the wheel's sha256 in the
#              Dockerfile; QCR_BENCH_PRAGENT_VERSION + QCR_BENCH_PRAGENT_SHA256 build another) — its CLI
#              `describe`, `review`, `improve` (the GitHub App default) on its local git provider over base...head, the PR's title and
#              description as its GitHub provider gives them, gpt-6.1-sol through the loopback Codex
#              bridge; one case at a time; `eval` scores `all`. QCR_BENCH_PRAGENT_EFFORT=L the bridge's
#              reasoning effort (default medium = PR-Agent's own default); QCR_BENCH_PRAGENT_MODEL=ID the
#              model the bridge serves (default gpt-6.1-sol; gpt-6-sol for parity); QCR_BENCH_PRAGENT_NO_PR_TEXT=1
#              withholds the title/description (the local provider's own stand-ins instead)
#   --arm ocr  (build, review, eval, report, shell, smoke): the open-code-review
#              baseline — image qcr-bench-ocr (the same runtime + OCR 1.3.1 + the
#              loopback Codex bridge), `review` runs OCR the way the AACR harness
#              runs it (one case at a time; --ocr-concurrency / --max-tools /
#              --timeout-min = its 8 / 30 / 30), `eval` scores the `all` variant.
#   --arm codex (build, review, eval, report, shell): the Codex CLI — image qcr-bench-codex
#              (the same runtime + @openai/codex, pinned), `review` runs the AACR harness's own
#              reviewers/codex.py (one case at a time; --timeout-min = its 30), `eval` scores
#              the `all` variant. QCR_BENCH_CODEX_EFFORT=L sets the reasoning effort (medium).
#              QCR_BENCH_CODEX_VERSION + QCR_BENCH_CODEX_SHA256 (the linux-x64 binary's) build another
#              Codex CLI — gpt-6.1-sol needs >= 0.159 (0.158.0's requests for it are refused by the
#              ChatGPT backend: "not supported when using Codex with a ChatGPT account")
#   --arm claude (build, review, eval, report, judge): Claude Code as a BENCHMARKED
#              REVIEWER — root CLAUDE.md rule 5's one ratified exception; `claude` exists
#              only in image qcr-bench-claude and runs only in its review container.
#              `review` runs the AACR harness's own reviewers/claude.py (`claude -p
#              '/code-review <base>...<head> '` …, one case at a time, --timeout-min 30);
#              `eval` scores `all` with the harness's OCR reader on each result file's
#              `review` view (2.1.283's /code-review ignores the harness's findings tool, so
#              the view is read out of its markdown by src/bench/claudeprose.ts).
#              `claude-rebuild --run ID [--set S] [--only ids]` rebuilds that view for a
#              finished run (--network none, no model call). Its credential is its
#              OWN: bench/aacr/claude.env (gitignored; QCR_BENCH_CLAUDE_ENV=FILE overrides)
#              holding CLAUDE_CODE_OAUTH_TOKEN=… (`claude setup-token`) or ANTHROPIC_API_KEY=…,
#              passed with --env-file — never the host's login, never on an argv.
#              QCR_BENCH_CLAUDE_MODEL=ID pins the model (ANTHROPIC_MODEL), e.g. claude-opus-5-5.
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
JUDGE_MODEL="" RUN="" SET="smoke10" ONLY="" JUDGE="mock" ROUNDS="" LINE_K="1" ARM="qcr" EXTRA=() FROM="" FORCE=0 JARGS=()
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
    --judge-model) JARGS+=(--model "$2"); JUDGE_MODEL="$2"; shift 2 ;;
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
  # Codex CLI arm: the harness's own reviewers/codex.py (Dockerfile target `codex`).
  codex) IMAGE="${QCR_BENCH_CODEX_IMAGE:-qcr-bench-codex:latest}"; TARGET=codex; BASE_ARGS=(); REVIEW_ENTRY=codex-review
       [[ -n "${QCR_BENCH_CODEX_VERSION:-}" ]] && BASE_ARGS=(--build-arg "CODEX_VERSION=$QCR_BENCH_CODEX_VERSION" --build-arg "CODEX_SHA256_LINUX_X64=${QCR_BENCH_CODEX_SHA256:?set QCR_BENCH_CODEX_SHA256 with QCR_BENCH_CODEX_VERSION}") ;;
  # OpenCode: its own target on the same runtime (OPENCODE_VERSION build arg, Dockerfile).
  opencode) IMAGE="${QCR_BENCH_OPENCODE_IMAGE:-qcr-bench-opencode:latest}"; TARGET=opencode
       BASE_ARGS=(); REVIEW_ENTRY=opencode-review
       [[ -n "${QCR_BENCH_OPENCODE_VERSION:-}" ]] && BASE_ARGS=(--build-arg "OPENCODE_VERSION=$QCR_BENCH_OPENCODE_VERSION" --build-arg "OPENCODE_SHA256_LINUX_X64=${QCR_BENCH_OPENCODE_SHA256:?set QCR_BENCH_OPENCODE_SHA256 with QCR_BENCH_OPENCODE_VERSION}") ;;
  # --- the Claude Code arm (rule 5's ratified exception: inside this image only) ---
  # trixie as for OCR: the classic builder builds every stage before the target, ocr's included.
  claude) IMAGE="${QCR_BENCH_CLAUDE_IMAGE:-qcr-bench-claude:latest}"; TARGET=claude
       BASE_ARGS=(--build-arg RUNTIME_BASE=node:22-trixie); REVIEW_ENTRY=claude-review ;;
  # pi-review: its own target on the same runtime (PIREVIEW_VERSION build arg, Dockerfile).
  pireview) IMAGE="${QCR_BENCH_PIREVIEW_IMAGE:-qcr-bench-pireview:latest}"; TARGET=pireview
       BASE_ARGS=(); REVIEW_ENTRY=pireview-review
       [[ -n "${QCR_BENCH_PIREVIEW_VERSION:-}" ]] && BASE_ARGS=(--build-arg "PIREVIEW_VERSION=$QCR_BENCH_PIREVIEW_VERSION" --build-arg "PIREVIEW_SHA512=${QCR_BENCH_PIREVIEW_SHA512:?set QCR_BENCH_PIREVIEW_SHA512 with QCR_BENCH_PIREVIEW_VERSION}") ;;
  # PR-Agent: its own target; pr-agent needs Python >= 3.12, so the runtime is trixie's (3.13),
  # as for ocr/claude (the classic builder builds every stage above the target on that base).
  pragent) IMAGE="${QCR_BENCH_PRAGENT_IMAGE:-qcr-bench-pragent:latest}"; TARGET=pragent
       BASE_ARGS=(--build-arg RUNTIME_BASE=node:22-trixie); REVIEW_ENTRY=pragent-review
       [[ -n "${QCR_BENCH_PRAGENT_VERSION:-}" ]] && BASE_ARGS+=(--build-arg "PRAGENT_VERSION=$QCR_BENCH_PRAGENT_VERSION" --build-arg "PRAGENT_SHA256=${QCR_BENCH_PRAGENT_SHA256:?set QCR_BENCH_PRAGENT_SHA256 with QCR_BENCH_PRAGENT_VERSION}") ;;
  *) die "--arm must be qcr | ocr | codex | opencode | pireview | pragent | claude" ;;
esac
# The Claude Code arm's own credential file (never the host's interactive login).
CLAUDE_ENV="${QCR_BENCH_CLAUDE_ENV:-$HERE/claude.env}"
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

# The Claude Code arm's credential: its OWN token file, handed to docker with
# --env-file so no value ever reaches an argv or the reproduction log. Only the
# key NAMES are read here, never a value.
claude_env_args() {
  local how="create it (it is gitignored) with ONE of:
    CLAUDE_CODE_OAUTH_TOKEN=<token>   # from: claude setup-token  (run it yourself, in your own terminal)
    ANTHROPIC_API_KEY=<key>           # an Anthropic API key
  then chmod 600 it. Its own credential only — never copy the host's interactive login."
  [[ -e "$CLAUDE_ENV" ]] || die "the Claude Code arm needs its own credential in $CLAUDE_ENV — $how"
  [[ -f "$CLAUDE_ENV" && ! -L "$CLAUDE_ENV" ]] || die "$CLAUDE_ENV must be a regular file, not a symlink"
  local n
  n="$(grep -cE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$CLAUDE_ENV" || true)"
  [[ "$n" == 1 ]] || die "$CLAUDE_ENV must set exactly one of CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY (found $n) — $how"
  CENV=(--env-file "$CLAUDE_ENV")
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
        package.json package-lock.json tsconfig.json AGENTS.md CLAUDE.md .pi \
        src extensions prompts agents \
        bench/aacr/Dockerfile bench/aacr/sets bench/aacr/defects bench/aacr/judge_shim.py \
        bench/aacr/in-container.sh bench/aacr/codex_bridge.py bench/aacr/eval_shards.py \
        bench/aacr/codex_arm.py \
        bench/aacr/claude_driver.py bench/aacr/pragent_driver.py \
        deploy/reviewer/AGENTS.override.md ) \
      | tar -xf - -C "$ctx"
    # The production config is the operator's live one, wherever the install
    # locator finds it — baked in as the image's config.toml.
    . "$REPO/scripts/install-locator.sh"
    live_config="$(qcr_locate_config "$REPO")" || exit 1
    [[ -f "$live_config" ]] || die "no config.toml at $live_config — the bench reviews with the production config"
    cp "$live_config" "$ctx/config.toml"
    # …and so are the profiles: the checkout's generic examples
    # only (no other checkout profile is read, so none is baked);
    # a profile in a higher-priority place (the config home, or beside
    # $QCR_CONFIG) REPLACES an example of the same name — whole, never
    # merged — so the image's profiles/ holds exactly what the locator reads.
    # Lowest priority first, so a higher place overwrites (no `tac`: macOS).
    mkdir -p "$ctx/profiles"
    for p in "${QCR_EXAMPLE_PROFILES[@]}"; do
      if [[ -d "$REPO/profiles/$p" ]]; then cp -R "$REPO/profiles/$p" "$ctx/profiles/$p"; fi
    done
    pdirs=()
    while IFS= read -r pdir; do pdirs=("$pdir" ${pdirs[@]+"${pdirs[@]}"}); done \
      < <(qcr_profile_dirs "$REPO")
    for pdir in ${pdirs[@]+"${pdirs[@]}"}; do
      [[ "$pdir" == "$REPO/profiles" || ! -d "$pdir" ]] && continue
      for p in "$pdir"/*/; do
        [[ -d "$p" ]] || continue
        p="${p%/}"
        rm -rf "${ctx:?}/profiles/${p##*/}"
        cp -R "$p" "$ctx/profiles/${p##*/}"
      done
    done
    # QCR_BENCH_PI_VERSION rebuilds on another pi (the image's reviewer runtime
    # and eval judge client) — e.g. the pi an earlier run's image carried, so a
    # re-run differs from it only in what it sets out to change.
    if [[ -n "${QCR_BENCH_PI_VERSION:-}" ]]; then
      [[ "$QCR_BENCH_PI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "QCR_BENCH_PI_VERSION must be x.y.z"
      BASE_ARGS+=(--build-arg "PI_VERSION=$QCR_BENCH_PI_VERSION")
    fi
    docker build --target "$TARGET" -t "$IMAGE" ${BASE_ARGS[@]+"${BASE_ARGS[@]}"} \
      --build-arg "QCR_BENCH_COMMIT=$commit" -f "$ctx/bench/aacr/Dockerfile" "$ctx"
    ;;

  prefetch)
    need_image
    # Optional local git mirror (external benchmarks): bare repos the commits
    # are fetched from first, READ-ONLY, in this prefetch container only —
    # never in a review. QCR_BENCH_MIRRORS maps fetch repo → path under it
    # (src/bench/prefetch.ts mirrorsFromEnv).
    mir=()
    if [[ -n "${QCR_BENCH_PREFETCH_MIRROR:-}" ]]; then
      [[ -d "$QCR_BENCH_PREFETCH_MIRROR" ]] || die "QCR_BENCH_PREFETCH_MIRROR=$QCR_BENCH_PREFETCH_MIRROR is not a directory"
      [[ -n "${QCR_BENCH_MIRRORS:-}" ]] || die "QCR_BENCH_PREFETCH_MIRROR needs QCR_BENCH_MIRRORS (the repo → path map)"
      mir=(--mount "type=bind,src=$QCR_BENCH_PREFETCH_MIRROR,dst=/mirrors,readonly" -e "QCR_BENCH_MIRRORS=$QCR_BENCH_MIRRORS")
    fi
    # Network: github.com only in practice (anonymous https + the public API).
    docker run "${HARDEN[@]}" ${mir[@]+"${mir[@]}"} \
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
    if [[ "$ARM" == claude ]]; then
      # No pi login: Claude Code's own credential, and a disk-backed /work for
      # the case repos (no CLAUDE.md above it — Claude Code reads parent dirs).
      claude_env_args
      AUTH=("${CENV[@]}" --mount type=volume,dst=/work)
      # QCR_BENCH_CLAUDE_MODEL pins the model (Claude Code reads ANTHROPIC_MODEL, as
      # the harness's own runner sets it); unset = Claude Code's default for the
      # credential. Reasoning stays Claude Code's default. The case records the
      # model that actually ran.
      if [[ -n "${QCR_BENCH_CLAUDE_MODEL:-}" ]]; then
        [[ "$QCR_BENCH_CLAUDE_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "QCR_BENCH_CLAUDE_MODEL must be a model id"
        AUTH+=(-e "ANTHROPIC_MODEL=$QCR_BENCH_CLAUDE_MODEL")
      fi
    else
      auth_mounts
      # quickreviewd on an Anthropic model (--config models.*=anthropic/…): pi's
      # anthropic provider needs an ANTHROPIC_API_KEY — the same dedicated
      # credential file as the Claude Code arm, by --env-file, never an argv.
      if [[ "$ARM" == qcr && " ${EXTRA[*]-} " == *anthropic/* ]]; then
        claude_env_args
        grep -qE '^ANTHROPIC_API_KEY=.+' "$CLAUDE_ENV" || die "an anthropic/ model arm needs ANTHROPIC_API_KEY in $CLAUDE_ENV (pi does not take the Claude Code OAuth token)"
        AUTH+=("${CENV[@]}")
      fi
    fi
    # The OCR arm's reasoning effort (its bridge's --effort; default medium).
    oe=(); [[ "$ARM" == ocr && -n "${QCR_BENCH_OCR_EFFORT:-}" ]] && oe=(-e "OCR_BRIDGE_EFFORT=$QCR_BENCH_OCR_EFFORT")
    # Codex arm: its effort, and seccomp=unconfined so Codex's OWN command sandbox
    # (bubblewrap: user namespaces, which docker's default seccomp profile refuses)
    # works as the harness runs it (--sandbox workspace-write, no network for
    # commands). Every other hardening flag above still applies. README "Codex CLI arm".
    if [[ "$ARM" == codex ]]; then
      oe+=(--security-opt seccomp=unconfined)
      [[ -n "${QCR_BENCH_CODEX_EFFORT:-}" ]] && oe+=(-e "QCR_CODEX_EFFORT=$QCR_BENCH_CODEX_EFFORT")
    fi
    [[ "$ARM" == opencode && -n "${QCR_BENCH_OPENCODE_EFFORT:-}" ]] && oe+=(-e "OPENCODE_BRIDGE_EFFORT=$QCR_BENCH_OPENCODE_EFFORT")
    # The model a third-party arm runs: QCR_BENCH_<ARM>_MODEL, a Codex model id
    # (e.g. gpt-6.1-sol). Unset = the arm's published default (gpt-6-sol); the
    # run.json records what ran. pi-review needs a pi whose catalog has the id
    # (gpt-6.1-sol: pi >= 0.99 — QCR_BENCH_PI_VERSION at build time).
    mvar=""
    case "$ARM" in
      ocr) mvar=QCR_BENCH_OCR_MODEL ;;
      opencode) mvar=QCR_BENCH_OPENCODE_MODEL ;;
      codex) mvar=QCR_BENCH_CODEX_MODEL ;;
      pireview) mvar=QCR_BENCH_PIREVIEW_MODEL ;;
    esac
    if [[ -n "$mvar" && -n "${!mvar:-}" ]]; then
      m="${!mvar}"
      [[ "$m" =~ ^gpt-[A-Za-z0-9.-]+$ ]] || die "$mvar must be a Codex model id (e.g. gpt-6.1-sol)"
      case "$ARM" in
        ocr) oe+=(-e "OCR_BRIDGE_MODEL=$m") ;;
        # the bridge's model, and the native provider's (src/bench/opencode.ts)
        opencode) oe+=(-e "OPENCODE_BRIDGE_MODEL=$m" -e "QCR_OPENCODE_MODEL=$m") ;;
        codex) oe+=(-e "QCR_CODEX_MODEL=$m") ;;
        pireview) oe+=(-e "QCR_PIREVIEW_MODEL=openai-codex/$m") ;;
      esac
    fi
    # OpenCode on its OWN ChatGPT provider instead of the bridge (src/bench/opencode.ts).
    if [[ "$ARM" == opencode && -n "${QCR_BENCH_OPENCODE_PROVIDER:-}" ]]; then
      [[ "$QCR_BENCH_OPENCODE_PROVIDER" == native || "$QCR_BENCH_OPENCODE_PROVIDER" == bridge ]] \
        || die "QCR_BENCH_OPENCODE_PROVIDER must be native | bridge"
      oe+=(-e "QCR_OPENCODE_PROVIDER=$QCR_BENCH_OPENCODE_PROVIDER")
    fi
    # The equal-inputs switch (src/bench/prtext.ts): the PR title/body to a
    # third-party CLI arm, the way that tool takes review context. Default off.
    if [[ "${QCR_BENCH_PR_TEXT:-}" == 1 ]]; then
      [[ "$ARM" == ocr || "$ARM" == codex || "$ARM" == opencode || "$ARM" == pireview ]] \
        || die "QCR_BENCH_PR_TEXT=1 is wired for the ocr, codex, opencode and pireview arms (quickreviewd and pragent always read the PR text)"
      oe+=(-e "QCR_BENCH_PR_TEXT=1")
    fi
    # pi-review: a disk-backed /work for the case trees — NOT under the sandbox
    # root, whose AGENTS.md/CLAUDE.md pi would load from every ancestor dir.
    if [[ "$ARM" == pragent ]]; then
      [[ -n "${QCR_BENCH_PRAGENT_EFFORT:-}" ]] && oe+=(-e "PRAGENT_BRIDGE_EFFORT=$QCR_BENCH_PRAGENT_EFFORT")
      if [[ -n "${QCR_BENCH_PRAGENT_MODEL:-}" ]]; then
        [[ "$QCR_BENCH_PRAGENT_MODEL" =~ ^gpt-[A-Za-z0-9.-]+$ ]] || die "QCR_BENCH_PRAGENT_MODEL must be a Codex model id (e.g. gpt-6-sol)"
        oe+=(-e "PRAGENT_BRIDGE_MODEL=$QCR_BENCH_PRAGENT_MODEL")
      fi
      [[ "${QCR_BENCH_PRAGENT_NO_PR_TEXT:-}" == 1 ]] && EXTRA+=(--no-pr-text)
    fi
    if [[ "$ARM" == pireview ]]; then
      oe+=(--mount type=volume,dst=/work)
      [[ -n "${QCR_BENCH_PIREVIEW_THINKING:-}" ]] && oe+=(-e "QCR_PIREVIEW_THINKING=$QCR_BENCH_PIREVIEW_THINKING")
      # A named panel preset — `code-experts` is what /rv runs inside Pi.
      if [[ -n "${QCR_BENCH_PIREVIEW_PANEL:-}" ]]; then
        [[ "$QCR_BENCH_PIREVIEW_PANEL" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "QCR_BENCH_PIREVIEW_PANEL must be a preset name"
        oe+=(-e "QCR_PIREVIEW_PANEL=$QCR_BENCH_PIREVIEW_PANEL")
      fi
    fi
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
      # An Anthropic judge (--judge-model anthropic/…) uses the Claude arm's OWN
      # credential file (--env-file; never an argv, never the host's login). Its
      # verdicts land under judge/v<version>-<model>/, beside the GPT judge's.
      if [[ "${JUDGE_MODEL:-}" == anthropic/* ]]; then claude_env_args; jm+=("${CENV[@]}"); fi
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

  claude-rebuild)
    # The Claude Code arm: rebuild each result file's OCR-shaped view from what
    # the harness stored (the prose parser for raw text) — no model call, no
    # network, the prefetched store read-only for the PR's changed files.
    [[ "$ARM" == claude ]] || die "claude-rebuild belongs to the Claude Code arm — pass --arm claude"
    need_image
    d="$(run_dir)"
    args=("${HARDEN[@]}" --network none
      --mount "type=volume,src=$REPOS_VOLUME,dst=/repos,readonly"
      --mount "type=bind,src=$d,dst=/bench-out"
      "$IMAGE" claude-rebuild "$SET" ${ONLY_ARGS[@]+"${ONLY_ARGS[@]}"})
    record "${args[@]}"
    docker run "${args[@]}"
    ;;

  results)
    [[ "$ARM" == qcr ]] || die "results rebuilds the quickreviewd arm's scored files; the $ARM arm writes its result files directly"
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

  *) sed -n '2,60p' "$0"; exit 2 ;;
esac
