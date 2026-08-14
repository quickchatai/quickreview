#!/usr/bin/env bash
# post-review.sh — post a REQUEST_CHANGES or COMMENT review on a PR.
#
#   POST /repos/{repo}/pulls/{n}/reviews  {"event":…,"body":…[,"comments":…]}
#
# APPROVE is hard-rejected: approvals go through approve-pr.sh only, which also
# clears the wake triggers. This script only ever ADDS a review; it never
# retracts, withdraws, or alters any existing review — no such capability
# exists here (structural invariant, same as src/gate.ts).
#
# Dry-run gate honored exactly like approve-pr.sh: dry_run != false in
# config.toml → the intended mutation is recorded to state/dryrun/ instead of
# being sent. Live mode authenticates via scripts/mint-token.sh only.
#
# Usage: post-review.sh <pr-number> <REQUEST_CHANGES|COMMENT> <body-file> [comments-json-file]
#   comments-json-file: JSON array of {path, line, side?, body} inline comments.

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${QCR_CONFIG:-$ROOT/config.toml}"
DRYRUN_DIR="${QCR_DRYRUN_DIR:-$ROOT/state/dryrun}"

die() { echo "post-review: $*" >&2; exit 1; }
USAGE="usage: post-review.sh <pr-number> <REQUEST_CHANGES|COMMENT> <body-file> [comments-json-file]"

PR="${1:-}"; EVENT="${2:-}"; BODY_FILE="${3:-}"; COMMENTS_FILE="${4:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "$USAGE"
case "$EVENT" in
  REQUEST_CHANGES|COMMENT) ;;
  APPROVE) die "APPROVE is not allowed here — use scripts/approve-pr.sh (it also clears the wake triggers)" ;;
  *) die "$USAGE" ;;
esac
[[ -n "$BODY_FILE" && -r "$BODY_FILE" ]] || die "unreadable review body file: ${BODY_FILE:-<missing>}"
if [[ -n "$COMMENTS_FILE" ]]; then
  [[ -r "$COMMENTS_FILE" ]] || die "unreadable comments file: $COMMENTS_FILE"
fi

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

# Payload: validates comments (path str, line int>0, body str, side RIGHT|LEFT).
PAYLOAD="$(EVENT="$EVENT" python3 - "$BODY_FILE" "$COMMENTS_FILE" <<'PY'
import json, os, sys
payload = {"event": os.environ["EVENT"], "body": open(sys.argv[1]).read()}
if sys.argv[2]:
    comments = json.load(open(sys.argv[2]))
    if not isinstance(comments, list):
        raise SystemExit("post-review: comments file must be a JSON array")
    out = []
    for i, c in enumerate(comments):
        if not isinstance(c, dict) or not isinstance(c.get("path"), str) \
           or not isinstance(c.get("line"), int) or c["line"] < 1 \
           or not isinstance(c.get("body"), str):
            raise SystemExit(f"post-review: comment {i}: need path(str), line(int>0), body(str)")
        if "side" in c and c["side"] not in ("RIGHT", "LEFT"):
            raise SystemExit(f"post-review: comment {i}: side must be RIGHT or LEFT")
        keep = {k: c[k] for k in ("path", "line", "side", "body") if k in c}
        out.append(keep)
    payload["comments"] = out
json.dump(payload, sys.stdout)
PY
)"

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

NOTE="post $EVENT review on #$PR"
if [[ "$LIVE" == "1" ]]; then
  call POST "/repos/$REPO/pulls/$PR/reviews" "$PAYLOAD" "$NOTE"
else
  record create_review POST "/repos/$REPO/pulls/$PR/reviews" "$PAYLOAD" "$NOTE"
fi
