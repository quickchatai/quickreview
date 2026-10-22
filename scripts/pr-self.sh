#!/usr/bin/env bash
# pr-self.sh — the session's sanctioned READ-ONLY self-verification helper.
#
# One entry point for the four questions a review session keeps asking about
# its own PR:
#   reviews  the bot's posted reviews on this PR (id, state, commit, when)
#   threads  unresolved review threads with ids   (delegates to pr-threads.sh)
#   head     the PR's current head sha
#   checks   CI rollup at the head                (delegates to pr-checks.sh)
#
# READ-ONLY BY CONSTRUCTION. This file performs GET requests only — no method
# overrides, no request bodies — and its two delegates are the sibling
# read-only scripts. There is no gate involvement because there is no mutation
# path: posting always goes through post-review.sh / approve-pr.sh /
# reply-thread.sh (which source guards.sh). Never add a write here.
# On a daemon's host the daemon reads (src/ghread.ts); elsewhere the
# token comes from scripts/mint-token.sh only (app credential; never GH_TOKEN); when
# no credential is available (test stubs) the read goes out unauthenticated.
#
# Usage: pr-self.sh <pr-number> <reviews|threads|head|checks>

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides: $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1

die() { echo "pr-self: $*" >&2; exit 1; }
usage() { die "usage: pr-self.sh <pr-number> <reviews|threads|head|checks>"; }

PR="${1:-}"
SUB="${2:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || usage
[[ -n "$SUB" ]] || usage

# The delegating subcommands hand off wholesale to the sibling read scripts.
case "$SUB" in
  threads) exec "$ROOT/scripts/pr-threads.sh" "$PR" ;;
  checks)  exec "$ROOT/scripts/pr-checks.sh" "$PR" ;;
  reviews|head) ;;
  *) usage ;;
esac

cfg() { # cfg <section-or-empty> <key>  (tomllib, sed fallback — as mint-token.sh)
  local section="$1" key="$2"
  python3 - "$CONFIG" "$section" "$key" <<'PY' 2>/dev/null || cfg_sed "$section" "$key"
import sys
try:
    import tomllib
except ModuleNotFoundError:
    raise SystemExit(1)
path, section, key = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "rb") as fh:
    data = tomllib.load(fh)
node = data[section] if section else data
val = node[key]
print("true" if val is True else "false" if val is False else val)
PY
}
cfg_sed() {
  local section="$1" key="$2"
  if [[ -n "$section" ]]; then sed -n "/^\[$section\]/,/^\[/p" "$CONFIG"
  else sed -n '1,/^\[/p' "$CONFIG"; fi \
    | sed -n "s/^[[:space:]]*$key[[:space:]]*=[[:space:]]*//p" \
    | head -n1 | sed 's/[[:space:]]*#.*$//; s/^"//; s/"$//; s/[[:space:]]*$//'
}

REPO="$(cfg github repo)"
[[ -n "$REPO" ]] || die "config.toml: [github].repo missing"

# On a host the daemon runs (the worker socket and the capability fd are in env)
# the daemon makes the read with the App's token (src/ghread.ts): the
# model's tool uid can neither read the App key nor mint a token. Elsewhere the
# read is our own, with a token from mint-token.sh.
VIA_DAEMON=0
[[ -n "${QCR_IPC_SOCKET:-}" && -n "${QCR_IPC_CAP_FD:-}" ]] && VIA_DAEMON=1
GHREAD="$ROOT/dist/src/ipc/ghreadshim.js"
# App credential when present; unauthenticated read otherwise (loopback stubs).
TOKEN=""
[[ "$VIA_DAEMON" == 1 ]] || TOKEN="$("$ROOT/scripts/mint-token.sh" 2>/dev/null || true)"

OUT="$(mktemp)"
ALL="$(mktemp)"
trap 'rm -f "$OUT" "$ALL"' EXIT

get() { # get <path>  → body in $OUT, dies on non-200. GET only, ever.
  local status
  local -a auth=()
  if [[ "$VIA_DAEMON" == 1 ]]; then
    status="$(node "$GHREAD" get "$1" "$OUT")"
  else
    [[ -n "$TOKEN" ]] && auth=(-H "Authorization: Bearer $TOKEN")
    status="$(curl -sS -o "$OUT" -w '%{http_code}' \
      "${auth[@]}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$API$1")"
  fi
  [[ "$status" == "200" ]] || die "GET $1 -> $status: $(head -c 300 "$OUT")"
}

case "$SUB" in
  head)
    get "/repos/$REPO/pulls/$PR"
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["head"]["sha"])' "$OUT"
    ;;
  reviews)
    BOT="$(cfg github bot_login)"
    [[ -n "$BOT" ]] || die "config.toml: [github].bot_login missing"
    # Every page, as guards.sh and src/github.ts listReviews read them: reviews
    # are oldest-first, so on a long PR the bot's latest reviews are exactly
    # what a first-page read misses. Up to 30 pages; a short page ends it. A
    # page that is not an array is an error, never an empty page.
    echo '[]' >"$ALL"
    for ((page = 1; page <= 30; page++)); do
      get "/repos/$REPO/pulls/$PR/reviews?per_page=100&page=$page"
      n="$(python3 -c '
import json, sys
acc = json.load(open(sys.argv[1]))
rows = json.load(open(sys.argv[2]))
if not isinstance(rows, list):
    raise SystemExit("reviews page is not a list")
acc += rows
json.dump(acc, open(sys.argv[1], "w"))
print(len(rows))' "$ALL" "$OUT")" || die "reviews page $page unreadable"
      if ((n < 100)); then break; fi
    done
    ((n < 100)) || die "incomplete review history: page limit reached"
    python3 - "$ALL" "$BOT" "$PR" <<'PY'
import json, sys
reviews = json.load(open(sys.argv[1]))
bot, pr = sys.argv[2], sys.argv[3]
mine = [r for r in reviews if (r.get("user") or {}).get("login") == bot]
if not mine:
    print(f"no reviews posted by {bot} on #{pr}")
for r in mine:
    body = " ".join((r.get("body") or "").split())[:200]
    print(f"[{r.get('id')}] {r.get('state')} @ {r.get('commit_id')} "
          f"({r.get('submitted_at') or '-'}) {body}")
PY
    ;;
esac
