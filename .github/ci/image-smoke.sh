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
#   4. wrapper      `install` prints the host wrapper's installer; piped to sh
#                   with HOME in a temp dir it must write an executable
#                   ~/.local/bin/qcr that parses and is pinned to this image.
#   5. ptrace_scope the runner's kernel.yama.ptrace_scope, seen from the host
#                   and from inside a container, recorded in the job summary
#                   (it decides whether a child can read its parent's
#                   memory, and a GitHub runner's value is not documented).
#                   Recording never fails the job.
#   6. setid helper the bot's helper switches the bot's uid to the
#                   tool uid with its gate group, and does not run without it.
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
# The image cannot see its own tag from inside: the caller names it.
wrapper="$(qcr -e "QCR_IMAGE=$IMAGE" "$IMAGE" install 2>"$WORK/install.err")" ||
  fail "install exited non-zero: $(cat "$WORK/install.err")"
[ -n "$wrapper" ] || fail "install printed nothing"
HOME="$home" sh -c "$wrapper" >&2 || fail "the installer script failed"
[ -x "$home/.local/bin/qcr" ] || fail "the installer did not write an executable ~/.local/bin/qcr"
sh -n "$home/.local/bin/qcr" || fail "the installed wrapper does not parse"
grep -qF "$IMAGE" "$home/.local/bin/qcr" || fail "the installed wrapper is not pinned to $IMAGE"

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

# ---- 6. the bot's setid helper -------------------------------------------------
# the always-on bot runs as its own uid and reaches the tool uid through
# /usr/local/libexec/qcr/qcr-setid, whose CAP_SETUID/CAP_SETGID are FILE
# capabilities (docker/Dockerfile). A build or a registry that drops the xattr
# leaves a helper that switches nothing, and the bot refuses to start; this is
# where that is caught, in the run spec's shape (deploy/qcr-update.sh).

step "the bot's setid helper switches to the tool identity, and to nothing else"
helper=/usr/local/libexec/qcr/qcr-setid
label() { docker image inspect --format "{{index .Config.Labels \"$1\"}}" "$IMAGE"; }
gate="$(label qcr.setid-gid)" && tuid="$(label qcr.tool-uid)" && tgid="$(label qcr.tool-gid)" ||
  fail "cannot read the image's labels"
for v in "$gate" "$tuid" "$tgid"; do
  [[ "$v" =~ ^[1-9][0-9]*$ ]] || fail "the image lacks a numeric qcr.setid-gid / qcr.tool-uid / qcr.tool-gid label ($gate/$tuid/$tgid)"
done
bot() {
  docker run --rm --network none --user 1001:1001 --cap-drop ALL --cap-add SETUID --cap-add SETGID \
    "$@"
}
sw() { printf '%s\n' --reuid="$1" --regid="$2" --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs; }
mapfile -t to_tool < <(sw "$tuid" "$tgid")
as_tool="$(bot --group-add "$gate" --entrypoint "$helper" "$IMAGE" "${to_tool[@]}" -- sh -c 'id -u; id -g; id -G')" ||
  fail "the setid helper did not run as the bot's uid with its gate group"
[ "$as_tool" = "$tuid
$tgid
$tgid" ] || fail "the setid helper switched to '$(echo $as_tool)', not $tuid:$tgid with no other group"
if bot --entrypoint "$helper" "$IMAGE" "${to_tool[@]}" -- true >/dev/null 2>&1; then
  fail "the setid helper runs without its gate group"
fi
# the helper must not reach any other identity: root above all
for other in "0 0" "0 $tgid" "$tuid 0" "1001 1001"; do
  mapfile -t to_other < <(sw $other)
  if bot --group-add "$gate" --entrypoint "$helper" "$IMAGE" "${to_other[@]}" -- true >/dev/null 2>&1; then
    fail "the setid helper switched to $other: it must switch to $tuid:$tgid only"
  fi
done

echo "image smoke: ok" >&2
