#!/bin/sh
# qcr-setup — bring a laptop to a working `qcr`, in this order:
#
#   1. Docker      installed, and the daemon answers
#   2. pull auth   the release image is private: gh auth refresh -s read:packages,
#                  then gh auth token | docker login ghcr.io
#   3. the wrapper docker run … install writes ~/.local/bin/qcr
#   4. login       qcr login (pi's own /login), unless a login or an API key exists
#
# Every step checks first and skips what is already done, so a re-run is safe.
# The steps that need the human (a browser sign-in, pi's /login) run only on a
# terminal. Without one the script prints the exact command and exits 10, so a
# skill can hand it over instead of hanging on a prompt nobody sees.
#
#   exit 0   ready: `qcr version --json` answered with a schema this plugin knows
#   exit 1   a step failed (the message names the fix)
#   exit 10  a step needs the human at a terminal (the command is printed)
#
# Environment: QCR_IMAGE (default ghcr.io/quickchatai/quickreview:<version>, the
# release this plugin ships with — the registry has no `latest` tag; a named
# image is passed to the installer so the wrapper pins it), QCR_SETUP_BIN_DIR
# (default ~/.local/bin), QCR_SETUP_INTERACTIVE=1|0 (default: whether stdin is a
# terminal). It makes no model call.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
# Kept equal to plugin.json's and package.json's version; a test checks it.
RELEASE_VERSION=1.0.7
IMAGE="${QCR_IMAGE:-ghcr.io/quickchatai/quickreview:$RELEASE_VERSION}"
DEST="${QCR_SETUP_BIN_DIR:-$HOME/.local/bin}"
case "${QCR_SETUP_INTERACTIVE:-auto}" in
  1) interactive=1 ;;
  0) interactive=0 ;;
  *) if [ -t 0 ]; then interactive=1; else interactive=0; fi ;;
esac

say() { printf 'qcr-setup: %s\n' "$*"; }
step() { printf '\n[%s/4] %s\n' "$1" "$2"; }
die() {
  printf 'qcr-setup: %s\n' "$*" >&2
  exit 1
}
# A step only the human can take: print what to run, in their terminal, and stop.
needs_human() {
  printf 'qcr-setup: this step needs you at a terminal. Run:\n\n' >&2
  for c in "$@"; do printf '    %s\n' "$c" >&2; done
  printf '\nthen run the setup again.\n' >&2
  exit 10
}

# ---- 1. Docker ----------------------------------------------------------------
step 1 "Docker"
command -v docker >/dev/null 2>&1 ||
  die "docker is not installed or not on PATH — install Docker (https://docs.docker.com/get-docker/), start it, and run the setup again"
docker info >/dev/null 2>&1 ||
  die "docker is installed but its daemon does not answer — start Docker (Docker Desktop, or the docker service) and run the setup again"
say "docker answers"

# ---- 2. pull auth ---------------------------------------------------------------
step 2 "access to $IMAGE"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  say "the image is already on this machine"
elif docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
  say "the registry lets you pull it"
else
  command -v gh >/dev/null 2>&1 ||
    die "cannot pull $IMAGE and the GitHub CLI is not installed — install gh (https://cli.github.com), or docker login ghcr.io with a token that has read:packages, and run the setup again"
  if [ "$interactive" = 0 ]; then
    needs_human 'gh auth refresh -s read:packages' \
      'gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin'
  fi
  say "the image is private; granting this login read:packages"
  gh auth refresh -s read:packages || die "gh auth refresh failed — sign in with: gh auth login"
  user="$(gh api user --jq .login)" || die "gh could not tell who you are — sign in with: gh auth login"
  gh auth token | docker login ghcr.io -u "$user" --password-stdin >/dev/null ||
    die "docker login ghcr.io failed"
  if ! why="$(docker manifest inspect "$IMAGE" 2>&1 >/dev/null)"; then
    die "logged in, but $IMAGE is still not pullable (docker said: $why) — if it is a permission error, ask the owner for access to the package"
  fi
  say "logged in to ghcr.io"
fi

# ---- 3. the wrapper -------------------------------------------------------------
step 3 "the qcr wrapper"
QCR=''
if command -v qcr >/dev/null 2>&1; then QCR="$(command -v qcr)"; fi
if [ -z "$QCR" ] && [ -x "$DEST/qcr" ]; then QCR="$DEST/qcr"; fi
if [ -n "$QCR" ] && QCR_BIN="$QCR" "$HERE/qcr-json" version >/dev/null 2>&1; then
  say "$QCR is installed and answers"
else
  mkdir -p "$DEST"
  # A named image is passed on so the installer pins it; the default pins the
  # version the pulled image reports.
  if [ -n "${QCR_IMAGE:-}" ]; then
    docker run --rm --user "$(id -u):$(id -g)" -e "QCR_IMAGE=$QCR_IMAGE" -v "$DEST:/out" "$IMAGE" install ||
      die "the image could not write its wrapper to $DEST"
  else
    docker run --rm --user "$(id -u):$(id -g)" -v "$DEST:/out" "$IMAGE" install ||
      die "the image could not write its wrapper to $DEST"
  fi
  QCR="$DEST/qcr"
  [ -x "$QCR" ] || die "the installer wrote no $QCR"
  say "wrote $QCR"
fi
case ":$PATH:" in
  *":$(dirname "$QCR"):"*) ;;
  *) say "$(dirname "$QCR") is not on your PATH — add it to your shell profile, or call $QCR" ;;
esac

# ---- 4. login ---------------------------------------------------------------------
step 4 "model login"
have_key=''
for name in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY DIGITALOCEAN_API_KEY; do
  eval "val=\${$name-}"
  [ -z "$val" ] || have_key="$name"
done
val=''
if [ -n "$have_key" ]; then
  say "$have_key is set; a headless run uses it and never logs in"
elif docker run --rm --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --mount type=volume,src=qcr-login,dst=/qcr-login,readonly --entrypoint test "$IMAGE" -s /qcr-login/auth.json >/dev/null 2>&1; then
  say "the qcr-login volume already holds a login"
else
  if [ "$interactive" = 0 ]; then
    needs_human "$QCR login"
  fi
  "$QCR" login || die "qcr login did not finish — run: $QCR login"
fi

# ---- done -------------------------------------------------------------------------
printf '\n'
QCR_BIN="$QCR" "$HERE/qcr-json" version >/dev/null ||
  die "$QCR does not answer \`version --json\` with a schema this plugin knows — run: $QCR update"
say "ready: $("$QCR" version | head -n 1)"
