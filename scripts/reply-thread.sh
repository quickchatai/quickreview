#!/usr/bin/env bash
# reply-thread.sh — reply to an existing PR review comment (author ping-pong).
#
#   POST /repos/{repo}/pulls/{n}/comments/{comment-id}/replies  {"body":…}
#
# The comment id is the numeric databaseId shown in brackets by pr-threads.sh.
# This only ever ADDS a reply: no thread is resolved or unresolved, and no
# review is touched in any way (structural invariant, same as src/gate.ts).
#
# Dry-run gate honored exactly like approve-pr.sh: dry_run != false in
# config.toml → the intended mutation is recorded to state/dryrun/ instead of
# being sent. Live mode authenticates via scripts/mint-token.sh only.
#
# Usage: reply-thread.sh <pr-number> <comment-id> <body-file>

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides: $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1
DRYRUN_DIR="${QCR_DRYRUN_DIR:-$ROOT/state/dryrun}"

die() { echo "reply-thread: $*" >&2; exit 1; }
USAGE="usage: reply-thread.sh <pr-number> <comment-id> <body-file>"

PR="${1:-}"; CID="${2:-}"; BODY_FILE="${3:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "$USAGE"
[[ "$CID" =~ ^[0-9]+$ ]] || die "$USAGE (comment-id is the numeric databaseId, see pr-threads.sh)"
[[ -n "$BODY_FILE" && -r "$BODY_FILE" ]] || die "unreadable reply body file: ${BODY_FILE:-<missing>}"

cfg() { # cfg <section-or-empty> <key>  (tomllib, sed fallback — as approve-pr.sh)
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

DRY_RUN="$(cfg "" dry_run)"
REPO="$(cfg github repo)"
[[ -n "$REPO" ]] || die "config.toml: [github].repo missing"
# Anything other than an explicit `false` is treated as dry-run (fail closed).
[[ "$DRY_RUN" == "false" ]] && LIVE=1 || LIVE=0

# Guard 3: a reply is a posting mutation too — the gate applies the
# merged/closed re-check to `create_review_comment_reply`, so this route does
# the same, from the shared mirror. Guards 1 and 2 are about review verdicts
# and have nothing to say about a thread reply.
# shellcheck source=scripts/guards.sh
. "$ROOT/scripts/guards.sh"
guard_require_open

PAYLOAD="$(python3 -c 'import json,sys; json.dump({"body": open(sys.argv[1]).read()}, sys.stdout)' "$BODY_FILE")"
PATH_API="/repos/$REPO/pulls/$PR/comments/$CID/replies"
NOTE="reply to review comment $CID on #$PR"

record() { # record <kind> <method> <path> <body-json> <note> — same shape as src/gate.ts
  mkdir -p "$DRYRUN_DIR"
  local file
  file="$DRYRUN_DIR/$(date -u +%Y-%m-%dT%H-%M-%S-000Z)-0000-$1.json"
  BODY_JSON="$4" python3 - "$file" "$1" "$2" "$3" "$5" "$PR" <<'PY'
import json, os, sys, datetime
path, kind, method, api_path, note, pr = sys.argv[1:7]
record = {
    "recorded_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "kind": kind, "method": method, "path": api_path, "note": note, "pr": int(pr),
}
if os.environ.get("BODY_JSON"):
    record["body"] = json.loads(os.environ["BODY_JSON"])
with open(path, "w") as fh:
    json.dump(record, fh, indent=2)
PY
  echo "dry-run: $5 -> $file — nothing was sent"
}

call() { # call <method> <path> <body-json> <note>
  local out status
  out="$(mktemp)"
  status="$(curl -sS -X "$1" -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $("$ROOT/scripts/mint-token.sh")" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/json" -d "$3" "$API$2")"
  if [[ "$status" == "401" ]]; then          # stale installation token: re-mint once
    status="$(curl -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $("$ROOT/scripts/mint-token.sh" --refresh)" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" -d "$3" "$API$2")"
  fi
  echo "$1 $2 -> $status  ($4)"
  case "$status" in
    2*) rm -f "$out" ;;
    *)  echo "  $(head -c 300 "$out")" >&2; rm -f "$out"; die "$1 $2 failed with $status" ;;
  esac
}

if [[ "$LIVE" == "1" ]]; then
  call POST "$PATH_API" "$PAYLOAD" "$NOTE"
else
  record create_review_comment_reply POST "$PATH_API" "$PAYLOAD" "$NOTE"
fi
