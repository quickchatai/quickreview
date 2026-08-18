#!/usr/bin/env bash
# approve-pr.sh — approve a PR and clear BOTH wake triggers.
#
#   1. POST   /repos/{repo}/pulls/{n}/reviews          {"event":"APPROVE","body":…}
#   2. DELETE /repos/{repo}/issues/{n}/labels/{trigger label}
#   3. DELETE /repos/{repo}/pulls/{n}/requested_reviewers
#             {"reviewers":[],"team_reviewers":["review"]}
#
# The dry-run gate is honored: when `dry_run` is true in config.toml (the
# default until the manual cutover flip) nothing is sent — each intended
# mutation is written to state/dryrun/ as a JSON record with the same shape as
# src/gate.ts writes (recorded_at/kind/method/path/body/note/pr). Live mode
# authenticates with scripts/mint-token.sh (app installation token only).
#
# Approvals are only ever added here; no step retracts or withdraws a review,
# and none may ever be added.
#
# Usage: approve-pr.sh <pr-number> [review-body-file]

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${QCR_CONFIG:-$ROOT/config.toml}"
DRYRUN_DIR="${QCR_DRYRUN_DIR:-$ROOT/state/dryrun}"

die() { echo "approve-pr: $*" >&2; exit 1; }

PR="${1:-}"
BODY_FILE="${2:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "usage: approve-pr.sh <pr-number> [review-body-file]"

if [[ -n "$BODY_FILE" ]]; then
  [[ -r "$BODY_FILE" ]] || die "unreadable review body file: $BODY_FILE"
  REVIEW_BODY="$(cat "$BODY_FILE")"
else
  REVIEW_BODY="Automated review: approved."
fi

# ---- config -----------------------------------------------------------------

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

cfg_sed() {
  local section="$1" key="$2"
  if [[ -n "$section" ]]; then
    sed -n "/^\[$section\]/,/^\[/p" "$CONFIG"
  else
    sed -n '1,/^\[/p' "$CONFIG"
  fi | sed -n "s/^[[:space:]]*$key[[:space:]]*=[[:space:]]*//p" \
     | head -n1 | sed 's/[[:space:]]*#.*$//; s/^"//; s/"$//; s/[[:space:]]*$//'
}

DRY_RUN="$(cfg "" dry_run)"
REPO="$(cfg github repo)"
TRIGGER_LABEL="$(cfg github trigger_label)"
REVIEW_TEAM="$(cfg github review_team)"      # "org/slug" — the API wants the slug
TEAM_SLUG="${REVIEW_TEAM##*/}"
[[ -n "$REPO" ]] || die "config.toml: [github].repo missing"

# Anything other than an explicit `false` is treated as dry-run (fail closed).
[[ "$DRY_RUN" == "false" ]] && LIVE=1 || LIVE=0

SEQ=0
record() { # record <kind> <method> <path> <body-json-or-empty> <note>
  mkdir -p "$DRYRUN_DIR"
  local ts file
  ts="$(date -u +%Y-%m-%dT%H-%M-%S-000Z)"
  file="$DRYRUN_DIR/$ts-$(printf '%04d' "$SEQ")-$1.json"
  SEQ=$(( SEQ + 1 ))
  BODY_JSON="$4" python3 - "$file" "$1" "$2" "$3" "$5" "$PR" <<'PY'
import json, os, sys, datetime
path, kind, method, api_path, note, pr = sys.argv[1:7]
body = os.environ.get("BODY_JSON") or ""
record = {
    "recorded_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "kind": kind,
    "method": method,
    "path": api_path,
    "note": note,
    "pr": int(pr),
}
if body:
    record["body"] = json.loads(body)
with open(path, "w") as fh:
    json.dump(record, fh, indent=2)
PY
  echo "dry-run: $5 -> $file"
}

TOKEN=""
token() {
  [[ -n "$TOKEN" ]] || TOKEN="$("$ROOT/scripts/mint-token.sh")"
  printf '%s' "$TOKEN"
}

call() { # call <method> <path> <body-json-or-empty> <note>
  local out status
  out="$(mktemp)"
  if [[ -n "$3" ]]; then
    status="$(curl -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $(token)" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" \
      -d "$3" "$API$2")"
  else
    status="$(curl -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $(token)" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$API$2")"
  fi
  if [[ "$status" == "401" ]]; then          # stale installation token: re-mint once
    TOKEN="$("$ROOT/scripts/mint-token.sh" --refresh)"
    status="$(curl -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      ${3:+-H "Content-Type: application/json"} ${3:+-d "$3"} "$API$2")"
  fi
  echo "$1 $2 -> $status  ($4)"
  case "$status" in
    2*) rm -f "$out" ;;
    404) echo "  not present, treating as already cleared: $(head -c 200 "$out")"; rm -f "$out" ;;
    *)   echo "  $(head -c 300 "$out")" >&2; rm -f "$out"; die "$1 $2 failed with $status" ;;
  esac
}

do_mutation() { # do_mutation <kind> <method> <path> <body> <note>
  if [[ "$LIVE" == "1" ]]; then
    call "$2" "$3" "$4" "$5"
  else
    record "$1" "$2" "$3" "$4" "$5"
  fi
}

urlenc() { python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# ---- guard 3: merged/closed re-check, immediately before posting ---
#
# Four of the predecessor system's reviews landed at or after the merge (one
# approved 13s after it). The daemon enforces this on the MutationGate; this
# shell path is the other posting route, so it mirrors the check the same way
# it mirrors the dry-run gate. One read, right before the mutation; a read is
# never gated. Live mode fails CLOSED — an unverifiable PR state is exactly the
# case those post-merge reviews came out of.

guard_token() {
  if [[ "$LIVE" == "1" ]]; then token; else "$ROOT/scripts/mint-token.sh" 2>/dev/null || true; fi
}

pr_liveness() { # → open | merged | closed | unreadable
  local tok body
  tok="$(guard_token)"
  if [[ -n "$tok" ]]; then
    body="$(curl -sS -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$API/repos/$REPO/pulls/$PR" || true)"
  else
    body="$(curl -sS -H "Accept: application/vnd.github+json" "$API/repos/$REPO/pulls/$PR" || true)"
  fi
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unreadable"); raise SystemExit(0)
if not isinstance(d, dict) or "state" not in d:
    print("unreadable")
elif d.get("merged"):
    print("merged")
elif d.get("state") != "open":
    print("closed")
else:
    print("open")
' || echo unreadable
}

guard_pr_open() {
  local verdict
  verdict="$(pr_liveness)"
  case "$verdict" in
    open) ;;
    merged) die "#$PR is already merged — refusing to post (guard 3)" ;;
    closed) die "#$PR is closed — refusing to post (guard 3)" ;;
    *)
      if [[ "$LIVE" == "1" ]]; then
        die "could not read the state of #$PR — refusing to post (guard 3, fail closed)"
      fi
      echo "guard: #$PR state unreadable; dry-run posts nothing, continuing" >&2
      ;;
  esac
}

guard_pr_open

# ---- 1. approve -------------------------------------------------------------

REVIEW_BODY_JSON="$(REVIEW_BODY="$REVIEW_BODY" python3 -c \
  'import json,os,sys; json.dump({"event":"APPROVE","body":os.environ["REVIEW_BODY"]}, sys.stdout)')"
do_mutation create_review POST "/repos/$REPO/pulls/$PR/reviews" "$REVIEW_BODY_JSON" \
  "approve #$PR"

# ---- 2. clear the label trigger ---------------------------------------------

do_mutation remove_label DELETE \
  "/repos/$REPO/issues/$PR/labels/$(urlenc "$TRIGGER_LABEL")" "" \
  "remove label \"$TRIGGER_LABEL\" from #$PR"

# ---- 3. clear the team-review-request trigger --------------------------------

TEAM_BODY_JSON="$(TEAM_SLUG="$TEAM_SLUG" python3 -c \
  'import json,os,sys; json.dump({"reviewers":[],"team_reviewers":[os.environ["TEAM_SLUG"]]}, sys.stdout)')"
do_mutation delete_team_review_request DELETE \
  "/repos/$REPO/pulls/$PR/requested_reviewers" "$TEAM_BODY_JSON" \
  "clear team review request ($TEAM_SLUG) on #$PR"

# ---- verification read (live only; a read is never gated) --------------------

if [[ "$LIVE" == "1" ]]; then
  remaining="$(curl -sS \
    -H "Authorization: Bearer $(token)" \
    -H "Accept: application/vnd.github+json" \
    "$API/repos/$REPO/pulls/$PR/requested_reviewers" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(t["slug"] for t in d.get("teams",[])))')"
  case ",$remaining," in
    *",$TEAM_SLUG,"*) die "team request on #$PR survived DELETE" ;;
  esac
  echo "verified: no $TEAM_SLUG team request remains on #$PR"
else
  echo "dry-run: $(ls "$DRYRUN_DIR" | wc -l) record(s) in $DRYRUN_DIR — nothing was sent"
fi
