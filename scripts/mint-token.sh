#!/usr/bin/env bash
# mint-token.sh — GitHub App installation token for the pi sessions' `gh` prefixing.
#
# Shell equivalent of packages/pi-plugin/src/githubAuth.ts:
#   * RS256 app JWT, iat = now-60s, exp = iat+9min (≤10 min ceiling)
#   * installation id resolved via GET /app/installations
#   * POST /app/installations/{id}/access_tokens for the installation token
#   * token + expires_at cached; reused while (expires_at - now) > 5 min
#   * single-flight via an mkdir lock; --refresh re-mints (the 401 path)
#
# The app PEM is the only credential — there is no personal-token path here.
# Prints the bare token to stdout. stdlib tools only: bash, openssl, curl, python3.
#
# Usage:  mint-token.sh [--refresh]
#   e.g.  GH_TOKEN="$(scripts/mint-token.sh)" gh pr view 123
#   On a 401 from gh, re-run with --refresh to drop the cache and re-mint.

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides — $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1
FORCE=0
[[ "${1:-}" == "--refresh" || "${1:-}" == "-f" ]] && FORCE=1

die() { echo "mint-token: $*" >&2; exit 1; }

# ---- config -----------------------------------------------------------------

# Read one key out of config.toml. tomllib when available, sed otherwise.
cfg() { # cfg <section-or-empty> <key>
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

cfg_sed() { # crude fallback: first `key = "value"` inside [section]
  local section="$1" key="$2"
  if [[ -n "$section" ]]; then
    sed -n "/^\[$section\]/,/^\[/p" "$CONFIG"
  else
    sed -n '1,/^\[/p' "$CONFIG"
  fi | sed -n "s/^[[:space:]]*$key[[:space:]]*=[[:space:]]*//p" \
     | head -n1 | sed 's/[[:space:]]*#.*$//; s/^"//; s/"$//; s/[[:space:]]*$//'
}

# The install locator decides — the configured [github] secrets_dir when the
# operator set one, else <config home>/secrets (never the old
# ~/.config/quickreview-bot). The same answer the daemon's loader reaches.
SECRETS_DIR="$(qcr_locate_secrets "$(cfg github secrets_dir || true)")" || exit 1

APP_ID_FILE="$SECRETS_DIR/app_id"
PEM_FILE="$SECRETS_DIR/app.pem"
[[ -r "$APP_ID_FILE" ]] || die "unreadable app id: $APP_ID_FILE"
[[ -r "$PEM_FILE" ]] || die "unreadable app key: $PEM_FILE"
APP_ID="$(tr -d '[:space:]' < "$APP_ID_FILE")"

CACHE_DIR="${XDG_RUNTIME_DIR:-/tmp}"
CACHE="$CACHE_DIR/quickreview-token-$APP_ID.json"
LOCK="$CACHE.lock"
MARGIN=300   # re-mint when fewer than 5 minutes remain

now_epoch() { date -u +%s; }

# Print the cached token if it still has > MARGIN seconds of life.
cached_token() {
  [[ -r "$CACHE" ]] || return 1
  python3 - "$CACHE" "$MARGIN" <<'PY'
import calendar, json, sys, time
try:
    with open(sys.argv[1]) as fh:
        blob = json.load(fh)
    exp = calendar.timegm(time.strptime(blob["expires_at"], "%Y-%m-%dT%H:%M:%SZ"))
except Exception:
    raise SystemExit(1)
if exp - time.time() <= int(sys.argv[2]):
    raise SystemExit(1)
print(blob["token"])
PY
}

if [[ "$FORCE" == "1" ]]; then
  rm -f "$CACHE"
elif token="$(cached_token)"; then
  printf '%s\n' "$token"
  exit 0
fi

# ---- single flight ----------------------------------------------------------

# The lock dir holds its owner's pid. A waiter takes a lock over only when that
# pid is gone, or the lock is older than the longest a mint can run (four
# requests at --max-time 60 plus connects): a live minter is never robbed.
LOCK_TICKS="${QCR_MINT_LOCK_TICKS:-120}"   # 0.5s each: ~60s waiting on a peer
LOCK_STALE_S="${QCR_MINT_LOCK_STALE_S:-300}"

lock_is_stale() {
  local pid born age
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  born="$(python3 -c 'import os,sys; print(int(os.stat(sys.argv[1]).st_mtime))' "$LOCK" 2>/dev/null || now_epoch)"
  age=$(( $(now_epoch) - born ))
  (( age > LOCK_STALE_S ))
}

# Remove the lock only while it is still ours, so a holder whose lock was taken
# over never deletes its successor's.
release_lock() {
  if [[ "$(cat "$LOCK/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$LOCK/pid"
    rmdir "$LOCK" 2>/dev/null || true
  fi
}

acquired=0
for _ in $(seq 1 "$LOCK_TICKS"); do
  if mkdir "$LOCK" 2>/dev/null; then acquired=1; break; fi
  if [[ "$FORCE" != "1" ]] && token="$(cached_token)"; then
    printf '%s\n' "$token"; exit 0
  fi
  if lock_is_stale; then
    rm -rf "$LOCK"
    continue
  fi
  sleep 0.5
done
if [[ "$acquired" != "1" ]]; then
  mkdir "$LOCK" 2>/dev/null || die "could not acquire mint lock $LOCK"
fi
printf '%s\n' "$$" >"$LOCK/pid"
trap release_lock EXIT

# Someone may have minted while we waited for the lock.
if [[ "$FORCE" != "1" ]] && token="$(cached_token)"; then
  printf '%s\n' "$token"
  exit 0
fi

# ---- JWT (RS256) ------------------------------------------------------------

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

app_jwt() {
  local iat exp header payload signing sig
  iat=$(( $(now_epoch) - 60 ))
  exp=$(( iat + 540 ))                     # +9 min, under the 10-min ceiling
  header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)"
  payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$iat" "$exp" "$APP_ID" | b64url)"
  signing="$header.$payload"
  sig="$(printf '%s' "$signing" | openssl dgst -sha256 -sign "$PEM_FILE" -binary | b64url)"
  printf '%s.%s' "$signing" "$sig"
}

RESP="$(mktemp)"
trap 'rm -f "$RESP"; release_lock' EXIT

# api <method> <path> <jwt> — body lands in $RESP, HTTP status on stdout.
api() {
  curl -sS --connect-timeout 10 --max-time 60 -X "$1" -o "$RESP" -w '%{http_code}' \
    -H "Authorization: Bearer $3" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$API$2"
}

mint() {
  local jwt status iid
  jwt="$(app_jwt)"

  status="$(api GET /app/installations "$jwt")"
  if [[ "$status" == "401" ]]; then              # clock skew / stale JWT: one retry
    jwt="$(app_jwt)"
    status="$(api GET /app/installations "$jwt")"
  fi
  [[ "$status" == "200" ]] || die "GET /app/installations -> $status: $(head -c 200 "$RESP")"

  iid="$(python3 -c \
    'import json,sys; d=json.load(open(sys.argv[1])); print(d[0]["id"]) if d else sys.exit(1)' "$RESP")" \
    || die "app has no installations"

  status="$(api POST "/app/installations/$iid/access_tokens" "$jwt")"
  if [[ "$status" == "401" ]]; then
    jwt="$(app_jwt)"
    status="$(api POST "/app/installations/$iid/access_tokens" "$jwt")"
  fi
  [[ "$status" == "201" ]] || die "token mint -> $status: $(head -c 200 "$RESP")"

  python3 -c \
    'import json,sys; d=json.load(open(sys.argv[1])); json.dump({"token": d["token"], "expires_at": d["expires_at"], "installation_id": int(sys.argv[2])}, sys.stdout)' \
    "$RESP" "$iid"
}

tmp="$CACHE.tmp.$$"
( umask 077; mint > "$tmp" )
chmod 600 "$tmp"
mv -f "$tmp" "$CACHE"

python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$CACHE"
