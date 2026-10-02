#!/usr/bin/env bash
# render-review.sh — render this round's review body and inline comments from
# its findings record (`[review] render_outputs`, src/reviewrender.ts).
#
#   reads  state/findings/pr-<n>-round-<k>.json
#   writes state/pr-<n>-round-<k>-review.md and state/pr-<n>-round-<k>-comments.json
#
# It posts nothing and reaches nothing outside state/: the session then posts
# those two files through post-review.sh / approve-pr.sh exactly as before, so
# every posting-time guard still applies.
#
# Usage: render-review.sh <pr-number> <round-number>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1

die() { echo "render-review: $*" >&2; exit 1; }
PR="${1:-}"; ROUND="${2:-}"
[[ "$PR" =~ ^[0-9]+$ && "$ROUND" =~ ^[0-9]+$ ]] || die "usage: render-review.sh <pr-number> <round-number>"

BOT="$(sed -n '/^\[github\]/,/^\[/p' "$CONFIG" | sed -n 's/^[[:space:]]*bot_login[[:space:]]*=[[:space:]]*"\{0,1\}\([^"#]*\)"\{0,1\}.*/\1/p' | head -n1 | sed 's/[[:space:]]*$//')"
exec node "$ROOT/dist/src/reviewrendercli.js" "$ROOT" "$PR" "$ROUND" "$BOT"
