#!/usr/bin/env bash
# The offline smoke of the clone route (a fresh checkout, `npm ci`, `npm run
# build`), run by the `clone` job of .github/workflows/ci.yml:
#
#   .github/ci/clone-smoke.sh
#
# The native developer install is not promised in the user docs, but it stays
# working because this runs on every push: the wrapper (scripts/qcr) answers
# the way the release image does. No docker, no model, no network, no secrets,
# no GitHub token: neither call reaches pi. dist/ must already be built.
#
#   1. version   `scripts/qcr version --json` names the schema versions and the
#                pi pin, and the pin is the one config.example.toml has.
#   2. schema    the review payload of step 3 carries the schema_version that
#                step 1 announced.
#   3. review    `scripts/qcr review --preview --json` on a throwaway fixture
#                repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "::error::clone smoke: $*" >&2
  exit 1
}
step() { echo "== $*" >&2; }

[ -f "$ROOT/dist/src/cli.js" ] || fail "dist/ is not built: run npm run build first"

# One call of the wrapper in a scrubbed environment: a throwaway HOME, the
# baked example as the config (a bare clone has no config.toml), no token.
qcr() {
  env -i PATH="$PATH" HOME="$WORK/home" TMPDIR="$WORK" \
    QCR_CONFIG="$ROOT/config.example.toml" "$ROOT/scripts/qcr" "$@"
}
mkdir "$WORK/home"

# ---- 1. version --------------------------------------------------------------

step "version --json"
want_pi="$(awk '/^\[pi\]/{p=1;next} /^\[/{p=0} p && $1=="version"{gsub(/"/,"",$3);print $3}' "$ROOT/config.example.toml")"
[ -n "$want_pi" ] || fail "no [pi] version in config.example.toml"
version="$(qcr version --json)" || fail "version --json exited non-zero"
echo "$version" >&2
jq -e --arg pi "$want_pi" '
  .schema_version == 1
  and (.image.version | type == "string" and . != "" and . != "unknown")
  and (.schemas.review | type == "number") and (.schemas.scan | type == "number")
  and .pi.version == $pi
' <<<"$version" >/dev/null || fail "version --json is not the expected payload (pi pin $want_pi)"
qcr version >/dev/null || fail "the text version exited non-zero"

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
preview="$(cd "$repo" && qcr review --preview --json)" ||
  fail "review --preview --json exited non-zero"
echo "$preview" >&2

# ---- 2. schema ---------------------------------------------------------------

step "schema versions agree"
want_schema="$(jq -r '.schemas.review' <<<"$version")"
jq -e --argjson v "$want_schema" '
  (keys_unsorted[0] == "schema_version") and .schema_version == $v
  and .ok == true and .preview.branch == "feat"
' <<<"$preview" >/dev/null || fail "the review preview is not a v$want_schema payload for branch feat"

echo "clone smoke: ok" >&2
