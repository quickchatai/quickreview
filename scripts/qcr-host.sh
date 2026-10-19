#!/bin/sh
# qcr — the host wrapper. The release image writes this file to
# ~/.local/bin/qcr (`docker run … <image> install`, scripts/install-wrapper.sh)
# and pins the image version into it; nothing else of qcr lives on the host.
#
#   qcr review …         one throwaway container per call (`docker run --rm`):
#                        the container is the sandbox, there is no docker.sock
#                        in it and no Docker-in-Docker.
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
# ssh agent, docker.sock. There is no GitHub App on a laptop (D14) and so no
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
mode=cli
tty=0
split=1
drop=0
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
  open | debug) tty=1 ;;
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

# Keep the user's arguments exactly as they are: the docker command is built
# after them and rotated in front (no eval, no quoting).
if [ "$drop" = 1 ]; then shift; fi
nuser=$#

# -t only with a terminal on both ends, or docker refuses to start.
flags='-i'
if [ "$tty" = 1 ] && [ -t 0 ] && [ -t 1 ]; then flags='-it'; fi

uid="$(id -u)"
gid="$(id -g)"

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

tokdir=''
# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  [ -z "$tokdir" ] || rm -rf "$tokdir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$split" = 1 ]; then
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
  set -- "$@" -e QCR_STATE_HOME=/opt/qcr/state/home
  set -- "$@" --mount "type=volume,src=qcr-login,dst=/qcr-login,readonly"

  # The user profile dir, read-only, and ONLY it (D39). Not the install home.
  profiles="${XDG_CONFIG_HOME:-$HOME/.config}/qcr/profiles"
  if [ -d "$profiles" ]; then
    profiles="$(cd "$profiles" && pwd -P)"
    mountable "$profiles"
    set -- "$@" --mount "type=bind,src=$profiles,dst=/qcr-config/profiles,readonly"
    set -- "$@" -e QCR_CONFIG_HOME=/qcr-config
  fi

  # The baked example is the config: a bare image has no config home.
  set -- "$@" -e QCR_CONFIG=/opt/qcr/config.example.toml
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
maybe_notice
exit "$rc"
