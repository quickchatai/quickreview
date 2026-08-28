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
# All THREE posting-time guards run here, from scripts/guards.sh —
# the shell mirror of src/guards.ts, which the MutationGate enforces on the
# daemon's own route. This is the session's route, so it refuses exactly what
# the gate refuses: a merged/closed PR, a head already reviewed with nothing
# new since, and REQUEST_CHANGES over a head a human has already approved
# (softened to COMMENT, findings intact).
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

# replay guard runs BEFORE posting guards: once this exact round/head
# has a confirmed receipt, retry is idempotent success even though guard 2 now
# (correctly) sees an already-reviewed head.
POSTING_RECEIPT=""
POSTING_MARKER=""
POST_ALREADY_CONFIRMED=0
RECEIPT_LOCK=""
cleanup_receipt_lock() { [[ -z "$RECEIPT_LOCK" ]] || rmdir "$RECEIPT_LOCK" 2>/dev/null || true; }
trap cleanup_receipt_lock EXIT
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
        RECEIPT_LOCK="$POSTING_RECEIPT.lock"
        mkdir -p "$RECEIPT_DIR"
        mkdir "$RECEIPT_LOCK" 2>/dev/null || die "another posting attempt owns $POSTING_KEY"
      fi
      ;;
    prepared) die "posting outcome is still unknown for $POSTING_KEY — refusing a duplicate POST; let the daemon reconcile the marker" ;;
    none)
      RECEIPT_LOCK="$POSTING_RECEIPT.lock"
      mkdir -p "$RECEIPT_DIR"
      mkdir "$RECEIPT_LOCK" 2>/dev/null || die "another posting attempt owns $POSTING_KEY"
      ;;
    *) die "invalid or mismatched posting receipt for $POSTING_KEY" ;;
  esac
fi
if [[ "$POST_ALREADY_CONFIRMED" == "1" ]]; then
  echo "posting receipt already confirmed for $POSTING_KEY — skipping duplicate review"
  exit 0
fi
[[ -n "$BODY_FILE" && -r "$BODY_FILE" ]] || die "unreadable review body file: ${BODY_FILE:-<missing>}"
if [[ -n "$COMMENTS_FILE" ]]; then
  [[ -r "$COMMENTS_FILE" ]] || die "unreadable comments file: $COMMENTS_FILE"
fi

# ---- the posting-time guards --------------------------------------
# All three, from the shared mirror of src/guards.ts — this is the session's
# posting route, so it must refuse exactly what the gate refuses.
# shellcheck source=scripts/guards.sh
. "$ROOT/scripts/guards.sh"

guard_require_open                                        # guard 3
HEAD_SHA="$GUARD_HEAD_SHA"
guard_require_expected_head "$HEAD_SHA"                   # guard 5
guard_require_new_evidence "$HEAD_SHA"                    # guard 2

INTENDED_EVENT="$EVENT"
DOWNGRADE_NOTE=""
APPROVER=""
if [[ "$EVENT" == "REQUEST_CHANGES" ]]; then              # guard 1
  APPROVER="$(guard_human_approver "$HEAD_SHA" "$GUARD_PR_AUTHOR")"
  if [[ -n "$APPROVER" ]]; then
    echo "guard: #$PR REQUEST_CHANGES -> COMMENT (@$APPROVER approved ${HEAD_SHA:0:7})" >&2
    EVENT="COMMENT"
    DOWNGRADE_NOTE="$(guard_downgrade_note "$APPROVER" "$HEAD_SHA")"
  fi
fi

# Payload: validates comments (path str, line int>0, body str, side RIGHT|LEFT).
PAYLOAD="$(EVENT="$EVENT" NOTE_SUFFIX="$DOWNGRADE_NOTE" HEAD_SHA="$HEAD_SHA" POSTING_MARKER="$POSTING_MARKER" \
  python3 - "$BODY_FILE" "$COMMENTS_FILE" <<'PY'
import json, os, sys
body = open(sys.argv[1]).read()
suffix = os.environ.get("NOTE_SUFFIX", "")
if suffix:
    body = f"{body}\n\n{suffix}"
marker = os.environ.get("POSTING_MARKER", "")
if marker:
    body = f"{body}\n\n{marker}"
payload = {"event": os.environ["EVENT"], "body": body}
if os.environ.get("HEAD_SHA"):
    payload["commit_id"] = os.environ["HEAD_SHA"]
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

if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  python3 "$ROOT/scripts/posting-receipt.py" prepare "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$HEAD_SHA" "$INTENDED_EVENT" "$EVENT" "$PAYLOAD"
fi

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

CALL_RESPONSE=""
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
    2*) CALL_RESPONSE="$(cat "$out")"; rm -f "$out" ;;
    *)  echo "  $(head -c 300 "$out")" >&2; rm -f "$out"; die "$1 $2 failed with $status" ;;
  esac
}

NOTE="post $EVENT review on #$PR"
if [[ -n "$DOWNGRADE_NOTE" ]]; then NOTE="$NOTE (downgraded: @$APPROVER approved this head)"; fi
if [[ "$LIVE" == "1" ]]; then
  if [[ "$POST_ALREADY_CONFIRMED" == "0" ]]; then
    call POST "/repos/$REPO/pulls/$PR/reviews" "$PAYLOAD" "$NOTE"
  else
    echo "posting receipt already confirmed for $POSTING_KEY — skipping duplicate review"
  fi
  if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
    QCR_POST_RESPONSE="$CALL_RESPONSE" python3 "$ROOT/scripts/posting-receipt.py" confirm "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$HEAD_SHA" "$INTENDED_EVENT" "$EVENT" "$PAYLOAD"
  fi
  # The reviewed-head mark, stamped only for a review that really reached
  # GitHub — the same after-step the gate runs daemon-side, and what makes
  # guard 2 bite on the next round through this route.
  guard_stamp_reviewed_head "$HEAD_SHA" "$EVENT"
else
  if [[ "$POST_ALREADY_CONFIRMED" == "0" ]]; then
    record create_review POST "/repos/$REPO/pulls/$PR/reviews" "$PAYLOAD" "$NOTE"
  else
    echo "dry-run posting receipt already exists for $POSTING_KEY — skipping duplicate intent"
  fi
  if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
    python3 "$ROOT/scripts/posting-receipt.py" dryrun "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$HEAD_SHA" "$INTENDED_EVENT" "$EVENT" "$PAYLOAD"
  fi
fi
