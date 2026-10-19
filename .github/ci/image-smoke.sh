#!/usr/bin/env bash
# The offline smoke of the release image (docker/Dockerfile), run by the
# `image` job of .github/workflows/ci.yml:
#
#   .github/ci/image-smoke.sh <image>
#
# No model, no network, no secrets, no GitHub token: every call runs the way
# the host wrapper runs one (--rm --init, the caller's uid, --cap-drop ALL,
# no-new-privileges, the repo mounted read-only) and none of them reaches pi.
#
#   1. version      `version --json` names the image, the schema versions and
#                   the pi pin, and the pin is the one config.example.toml has.
#   2. schema       the review payload of step 3 carries the schema_version
#                   that step 1 announced (and validates in tests/json-contract).
#   3. review       `review --preview --json` on a throwaway fixture repo.
#   4. wrapper      `install` prints the host wrapper; piped to sh with HOME in
#                   a temp dir it must write an executable ~/.local/bin/qcr.
#                   Until the image ships the wrapper (P6.6) `install` says so
#                   and exits 64: that exact answer is a skip, any other
#                   failure is not.
#   5. ptrace_scope the runner's kernel.yama.ptrace_scope, seen from the host
#                   and from inside a container, recorded in the job summary
#                   (P6.5b: it decides whether a child can read its parent's
#                   memory, and a GitHub runner's value is not documented).
#                   Recording never fails the job.
set -euo pipefail

IMAGE="${1:?usage: image-smoke.sh <image>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "::error::image smoke: $*" >&2
  exit 1
}
step() { echo "== $*" >&2; }

# One per-call container, as the wrapper starts it.
qcr() {
  docker run --rm -i --init --user "$(id -u):$(id -g)" \
    --cap-drop ALL --security-opt no-new-privileges "$@"
}

# ---- 1. version --------------------------------------------------------------

step "version --json"
want_pi="$(awk '/^\[pi\]/{p=1;next} /^\[/{p=0} p && $1=="version"{gsub(/"/,"",$3);print $3}' "$ROOT/config.example.toml")"
[ -n "$want_pi" ] || fail "no [pi] version in config.example.toml"
version="$(qcr "$IMAGE" version --json)" || fail "version --json exited non-zero"
echo "$version" >&2
jq -e --arg pi "$want_pi" '
  .schema_version == 1
  and (.image.version | type == "string" and . != "" and . != "unknown")
  and (.schemas.review | type == "number") and (.schemas.scan | type == "number")
  and .pi.version == $pi
' <<<"$version" >/dev/null || fail "version --json is not the expected payload (pi pin $want_pi)"
qcr "$IMAGE" version >/dev/null || fail "the text version exited non-zero"

# ---- 3. review --preview on a fixture ------------------------------------------

step "review --preview --json on a fixture repo"
repo="$WORK/repo"
mkdir "$repo"
git_fixture() { git -C "$repo" -c user.email=smoke@example.com -c user.name=smoke "$@"; }
git_fixture init -q -b main
printf 'a\n' >"$repo/a.txt"
git_fixture add .
git_fixture commit -qm base
git_fixture checkout -qb feat
printf 'a\nb\n' >"$repo/a.txt"
git_fixture commit -qam feat
chmod -R a+rX "$repo"
# A bare image has no config home: the baked example is the config here.
preview="$(qcr -v "$repo:/repo:ro" -w /repo -e QCR_CONFIG=/opt/qcr/config.example.toml \
  "$IMAGE" review --preview --json)" ||
  fail "review --preview --json exited non-zero"
echo "$preview" >&2

# ---- 2. schema ---------------------------------------------------------------

step "schema versions agree"
want_schema="$(jq -r '.schemas.review' <<<"$version")"
jq -e --argjson v "$want_schema" '
  (keys_unsorted[0] == "schema_version") and .schema_version == $v
  and .ok == true and .preview.branch == "feat"
' <<<"$preview" >/dev/null || fail "the review preview is not a v$want_schema payload for branch feat"

# ---- 4. the wrapper into a temp dir --------------------------------------------

step "wrapper install into a temp dir"
home="$WORK/home"
mkdir "$home"
set +e
wrapper="$(qcr "$IMAGE" install 2>"$WORK/install.err")"
rc=$?
set -e
if [ "$rc" = 64 ] && grep -q "not shipped in this image yet" "$WORK/install.err"; then
  echo "::notice::image smoke: the image does not ship the host wrapper yet (P6.6): wrapper step skipped" >&2
else
  [ "$rc" = 0 ] || fail "install exited $rc: $(cat "$WORK/install.err")"
  [ -n "$wrapper" ] || fail "install printed nothing"
  HOME="$home" sh -c "$wrapper" >&2 || fail "the installer script failed"
  [ -x "$home/.local/bin/qcr" ] || fail "the installer did not write an executable ~/.local/bin/qcr"
  sh -n "$home/.local/bin/qcr" || fail "the installed wrapper does not parse"
fi

# ---- 5. ptrace_scope -----------------------------------------------------------

step "kernel.yama.ptrace_scope"
yama=/proc/sys/kernel/yama/ptrace_scope
host_scope="$(cat "$yama" 2>/dev/null || echo absent)"
box_scope="$(qcr --entrypoint cat "$IMAGE" "$yama" 2>/dev/null || echo absent)"
line="kernel.yama.ptrace_scope: runner host=$host_scope, inside the container=$box_scope ($(uname -sr))"
echo "$line" >&2
echo "::notice::$line" >&2
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Image smoke\n\n- %s\n' "$line" >>"$GITHUB_STEP_SUMMARY"
fi

echo "image smoke: ok" >&2
