#!/usr/bin/env bash
# approve-pr.sh — approve a PR and clear BOTH wake triggers.
#
#   1. POST   /repos/{repo}/pulls/{n}/reviews          {"event":"APPROVE","body":…}
#   2. DELETE /repos/{repo}/issues/{n}/labels/{trigger label}
#   3. DELETE /repos/{repo}/pulls/{n}/requested_reviewers
#             {"reviewers":[],"team_reviewers":["review"]}
#
# The dry-run gate is honored: when `dry_run` is true in config.toml (anything
# but an explicit `false` counts as true) nothing is sent — each intended
# mutation is written to state/dryrun/ as a JSON record with the same shape as
# src/gate.ts writes (recorded_at/kind/method/path/body/note/pr). Live mode
# authenticates with scripts/mint-token.sh (app installation token only).
#
# Approvals are only ever added here; no step retracts or withdraws a review,
# and none may ever be added.
#
# Usage: approve-pr.sh <pr-number> [review-body-file] [comments-json-file]
# comments-json-file: inline comments in the SAME approval, never a second review.

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides — $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1
DRYRUN_DIR="${QCR_DRYRUN_DIR:-$ROOT/state/dryrun}"

die() { echo "approve-pr: $*" >&2; exit 1; }

PR="${1:-}"
BODY_FILE="${2:-}"
COMMENTS_FILE="${3:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "usage: approve-pr.sh <pr-number> [review-body-file] [comments-json-file]"

REVIEW_BODY=""

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

# The replay guard precedes the posting guards: a confirmed approval retry must
# resume idempotent trigger cleanup even if CI/head/state changed afterwards.
POSTING_RECEIPT=""
POSTING_MARKER=""
POST_ALREADY_CONFIRMED=0
RECEIPT_LOCK=""
cleanup_receipt_lock() { [[ -z "$RECEIPT_LOCK" ]] || rmdir "$RECEIPT_LOCK" 2>/dev/null || true; }
trap cleanup_receipt_lock EXIT
# The lock is recorded for cleanup only once this attempt holds it: a refused
# attempt must never remove the lock another attempt owns.
acquire_receipt_lock() {
  mkdir -p "$RECEIPT_DIR"
  mkdir "$POSTING_RECEIPT.lock" 2>/dev/null || die "another posting attempt owns $POSTING_KEY"
  RECEIPT_LOCK="$POSTING_RECEIPT.lock"
}
ROUND_NO="${QCR_ROUND_NO:-}"
if [[ -n "$ROUND_NO" || -n "${QCR_POSTING_KEY:-}" ]]; then
  [[ "$ROUND_NO" =~ ^[0-9]+$ ]] || die "QCR_ROUND_NO must be an integer"
  RECEIPT_HEAD="${QCR_EXPECTED_HEAD:-}"
  [[ -n "$RECEIPT_HEAD" ]] || die "QCR_EXPECTED_HEAD is required for a receipt-keyed round"
  EXPECTED_KEY="v1:$PR:$ROUND_NO:${RECEIPT_HEAD,,}"
  POSTING_KEY="${QCR_POSTING_KEY:-$EXPECTED_KEY}"
  [[ "$POSTING_KEY" == "$EXPECTED_KEY" ]] || die "QCR_POSTING_KEY mismatch (expected $EXPECTED_KEY)"
  POSTING_MARKER="<!-- qcr-post:$POSTING_KEY -->"
  RECEIPT_DIR="${QCR_POSTING_RECEIPT_DIR:-$ROOT/state/posting-receipts}"
  POSTING_RECEIPT="$RECEIPT_DIR/pr-$PR-round-$ROUND_NO.json"
  RECEIPT_STATE="$(python3 "$ROOT/scripts/posting-receipt.py" check "$POSTING_RECEIPT" "$POSTING_KEY")"
  case "$RECEIPT_STATE" in
    confirmed) POST_ALREADY_CONFIRMED=1 ;;
    dryrun)
      if [[ "$LIVE" == "0" ]]; then
        POST_ALREADY_CONFIRMED=1
      else
        mv "$POSTING_RECEIPT" "$POSTING_RECEIPT.dryrun-$(date -u +%Y%m%dT%H%M%SZ)"
        acquire_receipt_lock
      fi
      ;;
    prepared) die "posting outcome is still unknown for $POSTING_KEY — refusing a duplicate POST; let the daemon reconcile the marker" ;;
    none) acquire_receipt_lock ;;
    *) die "invalid or mismatched posting receipt for $POSTING_KEY" ;;
  esac
fi

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

CALL_RESPONSE=""
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
    2*) CALL_RESPONSE="$(cat "$out")"; rm -f "$out" ;;
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

# ---- the posting-time guards ------------------------------------------------
#
# The daemon enforces these on the MutationGate; this shell path is the other
# posting route, so it mirrors them the same way it mirrors the dry-run gate —
# scripts/guards.sh is that mirror. One read, right before the mutation; a read
# is never gated. Live mode fails closed: a PR whose state cannot be read may
# already be merged or closed, so it gets no approval.
#
# Guards 3, 4 and 5 apply here. Guard 1 softens REQUEST_CHANGES and has nothing to
# say about an approval; guard 2 deliberately does not gate an approval — this
# script also clears both wake triggers, so refusing it would leave a PR
# triggered with nothing left able to clear it. Guard 4 is only ever about
# approvals, so it belongs here: no green CI at this head and the approval is
# refused, whatever the findings.
# shellcheck source=scripts/guards.sh
. "$ROOT/scripts/guards.sh"

if [[ "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  guard_require_open
  guard_require_expected_head "$GUARD_HEAD_SHA"   # guard 5
  guard_require_green_ci "$GUARD_HEAD_SHA"
  if [[ -n "$BODY_FILE" ]]; then
    [[ -r "$BODY_FILE" ]] || die "unreadable review body file: $BODY_FILE"
    REVIEW_BODY="$(cat "$BODY_FILE")"
  else
    REVIEW_BODY="Automated review: approved."
  fi
  if [[ -n "$COMMENTS_FILE" ]]; then
    [[ -r "$COMMENTS_FILE" ]] || die "unreadable comments file: $COMMENTS_FILE"
  fi
  [[ -z "$POSTING_MARKER" ]] || REVIEW_BODY="$REVIEW_BODY

$POSTING_MARKER"
else
  GUARD_HEAD_SHA="$RECEIPT_HEAD"
fi

# ---- 1. approve -------------------------------------------------------------

# Confirmed retries resume cleanup even if the original scratch files are gone.
REVIEW_BODY_JSON=""
if [[ "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  REVIEW_BODY_JSON="$(REVIEW_BODY="$REVIEW_BODY" REVIEW_HEAD="$GUARD_HEAD_SHA" \
    python3 - "$COMMENTS_FILE" <<'PY'
import json, os, sys
payload = {"event": "APPROVE", "body": os.environ["REVIEW_BODY"], "commit_id": os.environ["REVIEW_HEAD"]}
if sys.argv[1]:
    comments = json.load(open(sys.argv[1]))
    if not isinstance(comments, list):
        raise SystemExit("approve-pr: comments file must be a JSON array")
    out = []
    for i, c in enumerate(comments):
        if not isinstance(c, dict) or not isinstance(c.get("path"), str) \
           or type(c.get("line")) is not int or c["line"] < 1 \
           or not isinstance(c.get("body"), str):
            raise SystemExit(f"approve-pr: comment {i}: need path(str), line(int>0), body(str)")
        if "side" in c and c["side"] not in ("RIGHT", "LEFT"):
            raise SystemExit(f"approve-pr: comment {i}: side must be RIGHT or LEFT")
        out.append({k: c[k] for k in ("path", "line", "side", "body") if k in c})
    payload["comments"] = out
json.dump(payload, sys.stdout)
PY
)"
fi
if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  python3 "$ROOT/scripts/posting-receipt.py" prepare "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$GUARD_HEAD_SHA" "APPROVE" "APPROVE" "$REVIEW_BODY_JSON"
fi
if [[ "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  do_mutation create_review POST "/repos/$REPO/pulls/$PR/reviews" "$REVIEW_BODY_JSON" \
    "approve #$PR"
else
  echo "posting receipt already exists for $POSTING_KEY — skipping duplicate approval"
fi
if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  if [[ "$LIVE" == "1" ]]; then
    QCR_POST_RESPONSE="$CALL_RESPONSE" python3 "$ROOT/scripts/posting-receipt.py" confirm "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$GUARD_HEAD_SHA" "APPROVE" "APPROVE" "$REVIEW_BODY_JSON"
  else
    python3 "$ROOT/scripts/posting-receipt.py" dryrun "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$GUARD_HEAD_SHA" "APPROVE" "APPROVE" "$REVIEW_BODY_JSON"
  fi
fi
# The reviewed-head mark, only for an approval that really reached GitHub (the
# same rule the gate's after-step follows). The post-approval recheck reads it.
if [[ "$LIVE" == "1" ]]; then guard_stamp_reviewed_head "$GUARD_HEAD_SHA" "APPROVE"; fi

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
