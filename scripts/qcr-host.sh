#!/bin/sh
# qcr — the host wrapper. The release image writes this file to
# ~/.local/bin/qcr (`docker run … <image> install`, scripts/install-wrapper.sh)
# and pins the image version into it; nothing else of qcr lives on the host.
#
#   qcr review …         one throwaway container per call (`docker run --rm`):
#                        the container is the sandbox, there is no docker.sock
#                        in it and no Docker-in-Docker.
#   qcr review start …   a detached container of its own (P6.8): the target is
#                        claimed in a short call, then the review runs in
#                        `qcr-review-<run id>` until it ends; `status` and
#                        `stop` find it by label. `stop` sends `docker stop -t
#                        <grace>`, then `docker kill`: the container is the
#                        hard-kill backstop for a driver whose loop is frozen.
#   qcr                  a bare qcr opens the operator TUI (tui mode)
#   qcr login [provider] pi's own /login, stored in the qcr-login volume
#   qcr update [version] pull a newer image and repin this file
#
# What a container gets, and nothing else:
#   the repo (the directory you stand in)    /repo               read-only
#   a worktree's common git dir              at its own path     read-only
#   the qcr-state volume                     /opt/qcr/state      read-write
#   the qcr-login volume                     /qcr-login          read-only
#                                            (only `login` mounts it read-write,
#                                            at pi's agent dir; its files are in
#                                            group 4747, which every call joins,
#                                            so a uid change never loses the login)
#   ~/.config/qcr/profiles                   /qcr-config/profiles read-only
#   the GitHub token's one-shot file         /run/qcr-in         read-write
#
# What it never gets: the gh config, the install home that holds
# <install>/secrets/ (only the profiles dir is mounted, D39 amending R12), the
# ssh agent, docker.sock. One call is the exception for the agent, never for
# docker.sock (D35): the TUI container below. There is no GitHub App on a laptop (D14) and so no
# container that mounts secrets: the token is GITHUB_TOKEN, GH_TOKEN or
# `gh auth token`, resolved HERE on the host. It is handed over as a 0600 file
# in a fresh 0700 directory, which the image reads once and unlinks (D39 amending
# R7, src/ghcred.ts); it is never in -e/--env or in any argv.
#
# Model-reaching calls start as root with only CAP_SETUID/CAP_SETGID and drop to
# your uid inside, so the model's tools can run as another uid and the kernel
# keeps them off the process that holds the token (D32, docker/entrypoint.sh).
# Every call: --init, --cap-drop ALL, no-new-privileges.
#
# The TUI (D35) is two containers and no docker.sock anywhere:
#   the companion   started, adopted or recreated HERE, on the host, from the
#                   `docker run` the image prints (`qcr companion plan`, so the
#                   mount list lives in one place, src/tui/companion.ts). It has
#                   no ssh agent, no ~/.ssh and no docker.sock (rule 8). Its tmux
#                   server listens on a socket in the qcr-companion tmux volume.
#   the TUI         shares that volume and drives the companion with `tmux -S`
#                   instead of `docker exec`. It alone gets the ssh agent socket
#                   and ~/.ssh/config and known_hosts, read-only, for the ssh
#                   runner that reaches the VM. When it quits, this wrapper stops
#                   the companion unless another TUI is still using it.
# The owner's dev TUI with hot reload (rule 11) stays on the clone route.
#
# POSIX sh: it runs under macOS's /bin/sh and under dash.
set -eu

# Written by the installer. QCR_IMAGE tries another image without repinning.
QCR_PINNED_IMAGE='@@QCR_IMAGE@@'
IMAGE="${QCR_IMAGE:-$QCR_PINNED_IMAGE}"

# The group that owns the login volume's files, so that a login made under one
# uid is readable under any other (the entrypoint's share_login, P6.7).
LOGIN_GID=4747

PULL_HINT='the image is private: gh auth refresh -s read:packages, then  gh auth token | docker login ghcr.io -u <your github user> --password-stdin'

say() { printf 'qcr: %s\n' "$*" >&2; }
die() {
  printf 'qcr: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH (https://docs.docker.com/get-docker/)"

# ---- small helpers ------------------------------------------------------------

# An image reference docker could not misread as an option.
valid_ref() {
  case "$1" in
    '' | -* | *[!A-Za-z0-9._/:@-]*) return 1 ;;
  esac
  return 0
}

# The repository part of the image: no tag, no digest.
image_repo() {
  case "${1##*/}" in
    *@*) printf '%s\n' "${1%%@*}" ;;
    *:*) printf '%s\n' "${1%:*}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

in_ci() {
  [ -n "${CI:-}" ] && [ "${CI:-}" != false ] && [ "${CI:-}" != 0 ] && return 0
  [ -n "${GITHUB_ACTIONS:-}" ] && return 0
  return 1
}

# A path --mount can spell.
mountable() {
  case "$1" in
    *,*) die "the path $1 holds a comma, which docker's --mount cannot take — move or link it" ;;
  esac
}

# Run a command, bounded when `timeout` exists (macOS has none by default).
bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; else
    shift
    "$@"
  fi
}

state_dir() { printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/qcr/wrapper"; }

# ---- qcr update ---------------------------------------------------------------

# The version an image reports, from `version --json` (image.version).
image_version() {
  docker run --rm --init --user "$(id -u):$(id -g)" --cap-drop ALL \
    --security-opt no-new-privileges "$1" cli version --json 2>/dev/null |
    sed -n 's/.*"image":{[^}]*"version":"\([^"]*\)".*/\1/p' | head -n 1
}

do_update() { # do_update [version]
  target="${1:-latest}"
  valid_ref "$target" || die "update: \"$target\" is not a version tag"
  repo="$(image_repo "$IMAGE")"
  say "pulling $repo:$target"
  docker pull "$repo:$target" >&2 || die "update: the pull failed — $PULL_HINT"
  if [ "$target" = latest ]; then
    version="$(image_version "$repo:latest")"
    [ -n "$version" ] || die "update: could not read the version of $repo:latest"
  else
    version="$target"
  fi
  new="$repo:$version"
  if [ "$new" != "$repo:$target" ]; then
    docker pull "$new" >&2 || die "update: the pull of $new failed — $PULL_HINT"
  fi
  case "$0" in
    */*) self="$0" ;;
    *) self="$(command -v "$0" 2>/dev/null || true)" ;;
  esac
  [ -n "$self" ] && [ -f "$self" ] || die "update: cannot tell where this wrapper lives ($0)"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/qcr-update.XXXXXX")" || die "update: no temporary directory"
  mountable "$tmp"
  # The new image writes its own wrapper, already pinned to itself.
  docker run --rm --init --user "$(id -u):$(id -g)" --cap-drop ALL \
    --security-opt no-new-privileges -e "QCR_IMAGE=$new" \
    --mount "type=bind,src=$tmp,dst=/out" "$new" install >&2 ||
    {
      rm -rf "$tmp"
      die "update: $new could not write its wrapper"
    }
  [ -x "$tmp/qcr" ] || {
    rm -rf "$tmp"
    die "update: $new wrote no wrapper"
  }
  # mv, not cp: this shell is reading the old file, which keeps its inode.
  mv -f "$tmp/qcr" "$self" || {
    rm -rf "$tmp"
    die "update: could not replace $self"
  }
  rm -rf "$tmp"
  say "now pinned to $new"
}

# ---- the once-a-day notice ----------------------------------------------------

# After a call, on a terminal, never in CI: say when a newer image exists.
# At most one look a day (the stamp is written before the look, so a failed
# look is not retried until tomorrow). Never the cause of a failed call.
maybe_notice() {
  in_ci && return 0
  [ -z "${QCR_NO_UPDATE_NOTICE:-}" ] || return 0
  # A plugin or a script has no terminal on stderr and does not want the line.
  [ -t 2 ] || [ -n "${QCR_NOTICE_ANYWHERE:-}" ] || return 0
  dir="$(state_dir)"
  stamp="$dir/update-notice"
  now="$(date +%s 2>/dev/null)" || return 0
  last=0
  [ -f "$stamp" ] && last="$(cat "$stamp" 2>/dev/null || echo 0)"
  case "$last" in '' | *[!0-9]*) last=0 ;; esac
  [ $((now - last)) -ge 86400 ] || return 0
  mkdir -p "$dir" 2>/dev/null && printf '%s\n' "$now" >"$stamp" 2>/dev/null || return 0
  repo="$(image_repo "$IMAGE")"
  mine="$(bounded 8 docker manifest inspect "$IMAGE" 2>/dev/null)" || return 0
  newest="$(bounded 8 docker manifest inspect "$repo:latest" 2>/dev/null)" || return 0
  if [ -n "$mine" ] && [ -n "$newest" ] && [ "$mine" != "$newest" ]; then
    say "a newer qcr image is available — run \`qcr update\`"
  fi
  return 0
}

# ---- the verb -----------------------------------------------------------------

verb="${1:-}"
if [ "$verb" = update ]; then
  shift
  [ "$#" -le 1 ] || die "usage: qcr update [version]"
  do_update "$@"
  exit 0
fi

# mode: the image's entrypoint mode. tty: the verbs that need a terminal.
# split: a call that can reach a model or GitHub (the D32 root start, a token).
# gh: whether the call is handed the GitHub token (not `open`).
mode=cli
tty=0
split=1
drop=0
gh=1
shared_uid=0
case "$verb" in
  '')
    mode=tui
    tty=1
    split=0
    ;;
  tui)
    mode=tui
    tty=1
    split=0
    drop=1
    ;;
  login)
    mode=login
    tty=1
    split=0
    drop=1
    ;;
  # The model's tools read no GitHub token in an open: pi on a kept session
  # needs none (src/opencli.ts strips it), so the wrapper stages none.
  open)
    tty=1
    gh=0
    ;;
  debug) tty=1 ;;
  review)
    # --debug-pi runs the round in pi's own interactive UI, in this terminal.
    # The model's bash there runs in the Node process's own uid, which the
    # image's tool-uid check (src/engine/tooluid.ts) refuses unless it is told
    # the shared uid is accepted; the person asking to watch has accepted it.
    for a in "$@"; do
      if [ "$a" = --debug-pi ]; then
        tty=1
        shared_uid=1
      fi
    done
    ;;
  version | --version | -V | help | --help | -h | install) split=0 ;;
esac

# A scan runs in the foreground: the container ends with the call, and a
# driver detached inside it would end with the container.
if [ "$verb" = scan ]; then
  fg=0
  case "${2:-}" in
    start) fg=1 ;;
    stage2) [ "${3:-}" != start ] || fg=1 ;;
  esac
  for a in "$@"; do
    [ "$a" != --foreground ] || fg=0
  done
  [ "$fg" = 0 ] || set -- "$@" --foreground
fi

# ---- qcr review start|status|stop: a run is a container (P6.8) --------------------

# phase is set on the two inner calls of a `review start` below: claim (a short
# call that identifies the target, takes the lock and writes the run, with no
# token) and driver (the detached container that is the run).
phase="${QCR_WRAPPER_PHASE:-}"
run_id="${QCR_RUN_ID:-}"
review_container=''
rverb=''
[ "$verb" != review ] || rverb="${2:-}"

# The wrapper's own path, to call itself for the two inner calls.
self_path() {
  case "$0" in
    */*) printf '%s\n' "$0" ;;
    *) command -v "$0" 2>/dev/null || true ;;
  esac
}

if [ "$rverb" = start ] && [ -z "$phase" ]; then
  help=0
  for a in "$@"; do
    case "$a" in --help | -h) help=1 ;; esac
  done
  if [ "$help" = 0 ]; then
    self="$(self_path)"
    [ -n "$self" ] && [ -f "$self" ] || die "review start: cannot tell where this wrapper lives ($0)"
    # The id is the wrapper's, so the container can carry it from the first call
    # (the image's own ids look the same: <UTC time>-<6 hex>).
    rand="$(od -An -N3 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
    [ -n "$rand" ] || rand="$$"
    id="$(date -u +%Y%m%d%H%M%S)-$rand"
    rc=0
    QCR_WRAPPER_PHASE=claim QCR_RUN_ID="$id" sh "$self" "$@" || rc=$?
    [ "$rc" = 0 ] || exit "$rc"
    QCR_WRAPPER_PHASE=driver QCR_RUN_ID="$id" sh "$self" "$@" >/dev/null || rc=$?
    if [ "$rc" != 0 ]; then
      # The run is claimed and nothing runs it: free the target.
      sh "$self" review stop "$id" >/dev/null 2>&1 || true
      die "review start: the review container could not be started"
    fi
    maybe_notice
    exit 0
  fi
fi
if [ -n "$phase" ]; then
  case "$phase" in claim | driver) ;; *) die "unknown QCR_WRAPPER_PHASE $phase" ;; esac
  case "$run_id" in
    '' | -* | *[!A-Za-z0-9._-]*) die "a review phase needs QCR_RUN_ID" ;;
  esac
  review_container="qcr-review-$run_id"
  # the driver runs what the claim wrote, not the user's arguments again
  if [ "$phase" = driver ]; then set -- review --container-run "$run_id"; fi
fi

# The review containers that are up, by name: the image has no docker to ask, and
# a run that is a container is alive while its container is.
live_reviews=''
have_live=0
if [ "$phase" != driver ]; then
  case "$rverb:$verb" in
    start:* | status:* | stop:* | *:live)
      if names="$(docker ps --filter label=qcr.role=review --format '{{.Names}}' 2>/dev/null)"; then
        live_reviews="$(printf '%s\n' "$names" | tr '\n' ' ')"
        have_live=1
      fi
      ;;
  esac
fi

# `stop` names the container to stop after the image has marked the run stopped:
# the run id it was given, else the newest review container that is up.
stop_target=''
if [ "$rverb" = stop ] && [ -z "$phase" ]; then
  want=''
  skip=2
  for a in "$@"; do
    if [ "$skip" -gt 0 ]; then
      skip=$((skip - 1))
      continue
    fi
    case "$a" in -*) ;; *) [ -n "$want" ] || want="$a" ;; esac
  done
  if [ -z "$want" ]; then
    want="$(docker ps --filter label=qcr.role=review --format '{{.Label "qcr.review.run"}}' 2>/dev/null | sed -n 1p)"
    [ -z "$want" ] || set -- "$@" "$want"
  fi
  case "$want" in
    '' | -* | *[!A-Za-z0-9._-]*) ;;
    *) stop_target="qcr-review-$want" ;;
  esac
fi

uid="$(id -u)"
gid="$(id -g)"

# ---- clean-up -------------------------------------------------------------------

tokdir=''
companion_name=''

# Stop the companion this call ran, unless another TUI container still uses it.
# Its conversation and login live on volumes, so the next start is a resume.
stop_companion() {
  [ -n "$companion_name" ] || return 0
  name="$companion_name"
  companion_name=''
  others="$(docker ps -q --filter label=qcr.role=tui 2>/dev/null || true)"
  [ -z "$others" ] || return 0
  say "stopping the companion…"
  docker stop "$name" >/dev/null 2>&1 || true
}

# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  [ -z "$tokdir" ] || rm -rf "$tokdir"
  stop_companion
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- the companion (D35) ----------------------------------------------------------

# Start, adopt or recreate the companion container from `qcr companion plan`.
# Sets companion_name, tui_mounts, tui_volumes and tui_env (newline lists) for
# the TUI container. Returns non-zero when the companion cannot be run.
ensure_companion() {
  plan="$(docker run --rm --init --user "$uid:$gid" --cap-drop ALL \
    --security-opt no-new-privileges -e "QCR_IMAGE=$IMAGE" -e "QCR_HOST_HOME=$HOME" \
    -e "QCR_HOST_XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}" \
    -e "QCR_HOST_XDG_STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}" \
    ${QCR_INSTALL:+-e "QCR_INSTALL=$QCR_INSTALL"} \
    "$IMAGE" cli companion plan 2>/dev/null)" || return 1
  [ -n "$plan" ] || return 1
  name=''
  hash=''
  tui_mounts=''
  tui_volumes=''
  tui_env=''
  mkdirs=''
  set --
  while IFS= read -r line; do
    kind="${line%% *}"
    value="${line#* }"
    case "$kind" in
      name) name="$value" ;;
      plan) hash="$value" ;;
      mkdir) mkdirs="$mkdirs$value
" ;;
      tui-mount) tui_mounts="$tui_mounts$value
" ;;
      tui-volume) tui_volumes="$tui_volumes$value
" ;;
      tui-env) tui_env="$tui_env$value
" ;;
      run) set -- "$@" "$value" ;;
    esac
  done <<EOF
$plan
EOF
  [ -n "$name" ] && [ -n "$hash" ] && [ "$#" -gt 0 ] || return 1
  # The host dirs the companion and the TUI share, made as you: docker would
  # invent a missing bind source root-owned.
  while IFS= read -r dir; do
    [ -z "$dir" ] || mkdir -p "$dir" || return 1
  done <<EOF
$mkdirs
EOF
  while IFS= read -r dir; do
    [ -z "$dir" ] || mountable "$dir"
  done <<EOF
$tui_mounts
EOF
  # What exists, and whether it is the container this plan describes.
  have="$(docker inspect --format '{{.State.Running}} {{index .Config.Labels "qcr.plan"}}' "$name" 2>/dev/null || true)"
  create=1
  case "$have" in
    "true $hash") create=0 ;;
    "false $hash")
      if docker start "$name" >/dev/null 2>&1; then create=0; else docker rm -f "$name" >/dev/null 2>&1 || true; fi
      ;;
    '') ;;
    *)
      say "the companion no longer matches this image or its mounts — recreating it"
      docker rm -f "$name" >/dev/null 2>&1 || return 1
      ;;
  esac
  if [ "$create" = 1 ]; then docker "$@" >/dev/null || return 1; fi
  companion_name="$name"
}

# The TUI starts its companion first; --no-companion (or QCR_NO_COMPANION) skips
# it, and so does a plan that cannot be had: the TUI then runs without one.
companion=0
if [ "$mode" = tui ]; then
  companion=1
  for a in "$@"; do
    [ "$a" != --no-companion ] || companion=0
  done
  [ -z "${QCR_NO_COMPANION:-}" ] || companion=0
fi
tui_mounts=''
tui_volumes=''
tui_env=''
if [ "$companion" = 1 ]; then
  if ! ensure_companion; then
    say "the companion could not be started — the TUI runs without it"
    companion=0
    set -- "$@" --no-companion
  fi
fi

# Keep the user's arguments exactly as they are: the docker command is built
# after them and rotated in front (no eval, no quoting).
if [ "$drop" = 1 ]; then shift; fi
nuser=$#

# -t only with a terminal on both ends, or docker refuses to start. The driver
# of a review run is detached.
flags='-i'
if [ "$tty" = 1 ] && [ -t 0 ] && [ -t 1 ]; then flags='-it'; fi
if [ "$phase" = driver ]; then flags='-d'; fi

# ---- the repo -----------------------------------------------------------------

if root="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$root" ]; then
  root="$(cd "$root" && pwd -P)"
else
  root="$(pwd -P)"
fi
here="$(pwd -P)"
rel="${here#"$root"}"
mountable "$root"

gitdir=''
if common="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" && [ -n "$common" ]; then
  case "$common" in
    /*) ;;
    *) common="$root/$common" ;;
  esac
  if [ -d "$common" ]; then
    common="$(cd "$common" && pwd -P)"
    case "$common" in
      "$root" | "$root"/*) ;;
      *)
        mountable "$common"
        gitdir="$common"
        ;;
    esac
  fi
fi

# ---- the GitHub token (D14: GITHUB_TOKEN, GH_TOKEN, gh; no App on a laptop) -----

# The claim call only reads git: it needs no token, and a token file is read once.
if [ "$split" = 1 ] && [ "$gh" = 1 ] && [ "$phase" != claim ]; then
  token="${GITHUB_TOKEN:-}"
  [ -n "$token" ] || token="${GH_TOKEN:-}"
  if [ -z "$token" ] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null || true)"
  fi
  if [ -n "$token" ]; then
    # A tmpfs on Linux, the user's temp dir elsewhere. 0700 dir, 0600 file; the
    # token goes through a redirection, never through an argument list.
    base="${TMPDIR:-/tmp}"
    if [ "$(uname -s)" = Linux ]; then
      case "${XDG_RUNTIME_DIR:-}" in
        /*) if [ -d "$XDG_RUNTIME_DIR" ]; then base="$XDG_RUNTIME_DIR"; fi ;;
      esac
    fi
    tokdir="$(umask 077 && mktemp -d "$base/qcr-in.XXXXXX")" || die "no private directory for the GitHub token under $base"
    mountable "$tokdir"
    (umask 077 && printf '%s' "$token" >"$tokdir/gh-token") || die "could not stage the GitHub token"
  fi
  token=''
fi

# ---- the docker command ---------------------------------------------------------

set -- "$@" docker run --rm "$flags" --init
if [ "$phase" = driver ]; then
  # Found by label (status, stop) and by name (docker stop).
  set -- "$@" --name "$review_container" --label qcr.role=review --label "qcr.review.run=$run_id"
fi
if [ "$split" = 1 ]; then
  run_uid="$uid"
  run_gid="$gid"
  # The image refuses a root run uid; a root host runs the review as 1000.
  [ "$run_uid" != 0 ] || run_uid=1000
  [ "$run_gid" != 0 ] || run_gid=1000
  set -- "$@" --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID
  set -- "$@" -e "QCR_RUN_UID=$run_uid" -e "QCR_RUN_GID=$run_gid"
else
  set -- "$@" --user "$uid:$gid" --cap-drop ALL
fi
set -- "$@" --security-opt no-new-privileges
# Every call that can touch the login volume is in its group.
set -- "$@" --group-add "$LOGIN_GID" -e "QCR_LOGIN_GID=$LOGIN_GID"

if [ "$mode" = login ]; then
  # pi's own /login, written to the login volume: the only read-write mount of
  # it. A login needs no repo, no state and no profiles.
  set -- "$@" --mount "type=volume,src=qcr-login,dst=/home/qcr/.pi/agent"
else
  # The repo, read-only; a worktree's common git dir at its own path.
  set -- "$@" --mount "type=bind,src=$root,dst=/repo,readonly" -w "/repo$rel"
  if [ -n "$gitdir" ]; then
    set -- "$@" --mount "type=bind,src=$gitdir,dst=$gitdir,readonly"
  fi

  # State and login. The state volume mounts over the image's world-writable
  # <root>/state, so a new volume starts writable by any uid.
  set -- "$@" --mount "type=volume,src=qcr-state,dst=/opt/qcr/state"
  # With a companion the state home is the host's own dir, which the companion
  # mounts too (the plan names it), not the volume.
  [ "$companion" = 1 ] || set -- "$@" -e QCR_STATE_HOME=/opt/qcr/state/home
  set -- "$@" --mount "type=volume,src=qcr-login,dst=/qcr-login,readonly"

  # The user profile dir, read-only, and ONLY it (D39). Not the install home.
  profiles="${XDG_CONFIG_HOME:-$HOME/.config}/qcr/profiles"
  if [ -d "$profiles" ]; then
    profiles="$(cd "$profiles" && pwd -P)"
    mountable "$profiles"
    set -- "$@" --mount "type=bind,src=$profiles,dst=/qcr-config/profiles,readonly"
    set -- "$@" -e QCR_CONFIG_HOME=/qcr-config
  fi

  # The baked example is the config: a bare image has no config home. The TUI
  # alone reads the install's own config.toml when there is one (its [tui]
  # target and ssh_host), the one file, read-only, never the config home.
  cfgfile=''
  if [ "$mode" = tui ]; then
    cfgfile="${QCR_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/qcr/${QCR_INSTALL:-default}/config.toml}"
    [ -f "$cfgfile" ] || cfgfile=''
  fi
  if [ -n "$cfgfile" ]; then
    mountable "$cfgfile"
    set -- "$@" --mount "type=bind,src=$cfgfile,dst=/qcr-config/config.toml,readonly"
    set -- "$@" -e QCR_CONFIG=/qcr-config/config.toml
  else
    set -- "$@" -e QCR_CONFIG=/opt/qcr/config.example.toml
  fi
fi

# ---- the TUI container (D35) --------------------------------------------------------

if [ "$mode" = tui ]; then
  set -- "$@" --label qcr.role=tui
  # The ssh runner reaches the VM through the agent and the user's ssh config:
  # this container alone gets them, read-only. The companion never does.
  agent=''
  if [ "$(uname -s)" = Darwin ]; then
    # Docker Desktop relays the host agent at a fixed path inside its VM.
    [ -z "${SSH_AUTH_SOCK:-}" ] || agent=/run/host-services/ssh-auth.sock
  elif [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then
    agent="$SSH_AUTH_SOCK"
    mountable "$agent"
  fi
  if [ -n "$agent" ]; then
    set -- "$@" --mount "type=bind,src=$agent,dst=/run/qcr-ssh-agent"
    set -- "$@" -e SSH_AUTH_SOCK=/run/qcr-ssh-agent
  fi
  for f in config known_hosts; do
    if [ -f "$HOME/.ssh/$f" ]; then
      mountable "$HOME/.ssh/$f"
      set -- "$@" --mount "type=bind,src=$HOME/.ssh/$f,dst=/home/qcr/.ssh/$f,readonly"
    fi
  done
fi
if [ "$companion" = 1 ]; then
  # The tmux socket volume and the host dirs the TUI shares with the companion,
  # each at its own host path, so both sides resolve the same config.
  set -- "$@" -e QCR_TUI_COMPANION=tmux-socket
  while IFS= read -r v; do
    [ -z "$v" ] || set -- "$@" --mount "type=volume,src=${v%%:*},dst=${v#*:}"
  done <<EOF
$tui_volumes
EOF
  while IFS= read -r p; do
    [ -z "$p" ] || set -- "$@" --mount "type=bind,src=$p,dst=$p"
  done <<EOF
$tui_mounts
EOF
  while IFS= read -r e; do
    [ -z "$e" ] || set -- "$@" -e "$e"
  done <<EOF
$tui_env
EOF
fi

if [ "$mode" = cli ]; then
  if [ "$verb" = scan ]; then
    # The container is the scan sandbox (src/scanbox.ts IN_SANDBOX_ENV): the
    # scan runs in this process, never in a container of its own (no docker
    # here). It re-takes a refresh-disabled copy of the login before each case.
    set -- "$@" -e QCR_IN_SCAN_SANDBOX=1 -e QCR_REVIEWED_REPO=/repo
    set -- "$@" -e QCR_SCAN_AUTH_SRC=/qcr-login
  else
    # The login volume is only a source: the review copies it, refresh disabled.
    set -- "$@" -e PI_CODING_AGENT_DIR=/qcr-login
  fi
  if [ "$shared_uid" = 1 ]; then set -- "$@" -e QCR_ALLOW_SHARED_TOOL_UID=1; fi
  if [ -n "$phase" ]; then
    set -- "$@" -e "QCR_RUN_ID=$run_id" -e "QCR_REVIEW_CONTAINER=$review_container"
  fi
  if [ "$have_live" = 1 ]; then set -- "$@" -e "QCR_LIVE_REVIEWS=$live_reviews"; fi
fi

if [ -n "$tokdir" ]; then
  set -- "$@" --mount "type=bind,src=$tokdir,dst=/run/qcr-in"
  set -- "$@" -e QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token
fi

# Model keys for a headless run: the NAME only, docker reads the value from
# this process's environment, so no key is ever in an argument list.
for name in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY DIGITALOCEAN_API_KEY QCR_DEBUG; do
  eval "val=\${$name-}"
  [ -z "$val" ] || set -- "$@" -e "$name"
done
val=''
if [ "$flags" = '-it' ]; then set -- "$@" -e TERM; fi

set -- "$@" "$IMAGE" "$mode"

# The user's arguments were first; rotate them behind the command.
i=0
while [ "$i" -lt "$nuser" ]; do
  a="$1"
  shift
  set -- "$@" "$a"
  i=$((i + 1))
done

rc=0
"$@" || rc=$?
if [ "$rc" = 125 ]; then say "docker could not start the container — $PULL_HINT"; fi

# `review stop`: the image has marked the run stopped (and freed its target);
# now end its container. docker stop gives the driver QCR_STOP_GRACE seconds
# (default 10) to abort its sessions and unwind, then kills the container
# itself; docker kill follows for a container that stop could not end. The
# container is the hard-kill backstop for a driver whose loop is frozen.
if [ "$rc" = 0 ] && [ -n "$stop_target" ]; then
  grace="${QCR_STOP_GRACE:-10}"
  case "$grace" in '' | *[!0-9]*) grace=10 ;; esac
  docker stop -t "$grace" "$stop_target" >/dev/null 2>&1 || true
  docker kill "$stop_target" >/dev/null 2>&1 || true
fi
[ -n "$phase" ] || maybe_notice
exit "$rc"
