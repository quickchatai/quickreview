#!/usr/bin/env bash
# The npm packages' trusted publishers, set by an npm owner of the quickchatai
# org with 2FA (each npm call asks for it). Each package trusts one workflow
# in one environment, and only to stage: release.yml's `npm` job, in the
# npm-publish environment, on this repository. A staged version is public
# only after a maintainer approves it with 2FA.
#
#   .github/npm-trust.sh            print the calls, change nothing
#   .github/npm-trust.sh --apply    make them
#
# With both publishers set, it deletes any NPM_TOKEN secret left in the
# npm-publish environment, which release.yml no longer reads; revoke that
# token on npmjs as well (Access Tokens). npm sets a publisher only on a
# package that already exists, and a second run asks npm to add the same
# publisher again: `npm trust list <package>` shows what is set.
set -euo pipefail

REPO=quickchatai/quickreview
WORKFLOW=release.yml
ENVIRONMENT=npm-publish
# The plugin first, as release.yml stages them.
PACKAGES=(@quickchatai/pi-quickreview @quickchatai/quickreview)
APPLY=false
for a in "$@"; do
  case "$a" in
    --apply) APPLY=true ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

# An npm without `npm trust github --allow-stage-publish` cannot set these.
npm trust github --help 2>/dev/null | grep -q -- --allow-stage-publish ||
  { echo "npm $(npm --version) cannot set a stage-only trusted publisher; update npm" >&2; exit 1; }

failed=0
for pkg in "${PACKAGES[@]}"; do
  cmd=(npm trust github "$pkg" --file "$WORKFLOW" --repository "$REPO"
    --environment "$ENVIRONMENT" --allow-stage-publish --yes)
  echo "${cmd[*]}"
  $APPLY || continue
  if ! "${cmd[@]}"; then
    echo "  refused for $pkg; \`npm trust list $pkg\` shows what is set" >&2
    failed=1
  fi
done

echo "gh secret delete NPM_TOKEN --repo $REPO --env $ENVIRONMENT  (when it exists)"
$APPLY || exit 0
if [ "$failed" = 1 ]; then
  echo "a publisher was refused: NPM_TOKEN is kept" >&2
  exit 1
fi
if gh secret list --repo "$REPO" --env "$ENVIRONMENT" --json name --jq '.[].name' | grep -qx NPM_TOKEN; then
  gh secret delete NPM_TOKEN --repo "$REPO" --env "$ENVIRONMENT"
  echo "deleted NPM_TOKEN from $ENVIRONMENT; revoke it on npmjs too (Access Tokens)"
fi
