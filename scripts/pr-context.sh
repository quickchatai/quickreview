#!/usr/bin/env bash
# pr-context.sh — one-shot read-only PR bundle for pi review sessions.
#
# Prints labeled plain-text sections: META, FILES, CHECKS, REVIEWS, THREADS
# (unresolved only, last 2 comments each). Files and threads are paginated;
# REST supplies check runs and legacy commit statuses for the same head.
# Read-only: no gate involvement. On a daemon's host the daemon reads
# (src/ghread.ts); elsewhere the token comes from scripts/mint-token.sh only.
#
# Usage: pr-context.sh <pr-number>

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides: $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1

die() { echo "pr-context: $*" >&2; exit 1; }

PR="${1:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "usage: pr-context.sh <pr-number>"

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
OWNER="${REPO%%/*}"; NAME="${REPO##*/}"
# On a host the daemon runs (the worker socket and the capability fd are in env)
# the daemon makes the reads with the App's token (src/ghread.ts): the
# model's tool uid can neither read the App key nor mint a token. Elsewhere the
# reads are our own, with a token from mint-token.sh.
if [[ -n "${QCR_IPC_SOCKET:-}" && -n "${QCR_IPC_CAP_FD:-}" ]]; then
  QCR_CONTEXT_GHREAD="$ROOT/dist/src/ipc/ghreadshim.js" \
    exec python3 "$ROOT/scripts/pr-context.py" "$API" "$REPO" "$PR"
fi
TOKEN="$("$ROOT/scripts/mint-token.sh")"

QCR_CONTEXT_TOKEN="$TOKEN" exec python3 "$ROOT/scripts/pr-context.py" "$API" "$REPO" "$PR"
