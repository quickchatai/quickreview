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
# A host the daemon runs (round worker, answer worker, debug pi) holds no GitHub
# credential and no config: the daemon posts for it. With the worker socket and
# the capability fd in env this script is only a thin client of the daemon's
# post endpoint (src/ipc/postshim.ts), and everything below is not run. The
# shell route below stays for the legacy tmux bot until P9.3 deletes it.
if [[ -n "${QCR_IPC_SOCKET:-}" && -n "${QCR_IPC_CAP_FD:-}" ]]; then
  exec node "$ROOT/dist/src/ipc/postshim.js" approval "$@"
fi
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
cleanup_receipt_lock() { if [[ -n "$RECEIPT_LOCK" ]]; then rm -f "$RECEIPT_LOCK/pid"; rmdir "$RECEIPT_LOCK" 2>/dev/null || true; fi; }
trap cleanup_receipt_lock EXIT
# The lock is recorded for cleanup only once this attempt holds it: a refused
# attempt must never remove the lock another attempt owns.
acquire_receipt_lock() {
  mkdir -p "$RECEIPT_DIR"
  mkdir "$POSTING_RECEIPT.lock" 2>/dev/null || die "another posting attempt owns $POSTING_KEY"
  RECEIPT_LOCK="$POSTING_RECEIPT.lock"
  python3 "$ROOT/scripts/posting-receipt.py" owner "$RECEIPT_LOCK/pid" "$$"
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
  acquire_receipt_lock
  RECEIPT_STATE="$(python3 "$ROOT/scripts/posting-receipt.py" check "$POSTING_RECEIPT" "$POSTING_KEY")"
  case "$RECEIPT_STATE" in
    confirmed) POST_ALREADY_CONFIRMED=1 ;;
    dryrun)
      if [[ "$LIVE" == "0" ]]; then
        POST_ALREADY_CONFIRMED=1
      else
        ARCHIVE_SUFFIX="dryrun-$(date -u +%Y%m%dT%H%M%SZ)"
        mv "$POSTING_RECEIPT" "$POSTING_RECEIPT.$ARCHIVE_SUFFIX"
        QUEUED="${POSTING_RECEIPT%.json}.outbox.json"
        [[ ! -f "$QUEUED" ]] || mv "$QUEUED" "$QUEUED.$ARCHIVE_SUFFIX"
      fi
      ;;
    prepared) die "posting outcome is still unknown for $POSTING_KEY — refusing a duplicate POST; let the daemon reconcile the marker" ;;
    deferred)
      # An earlier attempt got no answer from GitHub and handed this
      # exact approval to the daemon, which owns its delivery now. Never a
      # second POST from here; the triggers were consumed at dispatch.
      echo "posting for $POSTING_KEY is deferred to the daemon (GitHub did not answer an earlier attempt); it delivers this approval itself — nothing to do, finish the round normally"
      exit 0 ;;
    none) : ;;
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
CALL_STATUS=""
# call <method> <path> <body-json-or-empty> <note> [soft]
# With `soft`, a 5xx or no response (curl's 000) returns 75 instead of dying —
# used for the approval POST only, whose caller then asks GitHub whether it
# landed. Every other status keeps its old meaning.
call() {
  local out status soft="${5:-}"
  out="$(mktemp)"
  if [[ -n "$3" ]]; then
    status="$(curl --connect-timeout 10 --max-time 60 -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $(token)" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" \
      -d "$3" "$API$2" || true)"
  else
    status="$(curl --connect-timeout 10 --max-time 60 -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $(token)" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$API$2" || true)"
  fi
  [[ "$status" =~ ^[0-9]{3}$ ]] || status="000"
  if [[ "$status" == "401" ]]; then          # stale installation token: re-mint once
    TOKEN="$("$ROOT/scripts/mint-token.sh" --refresh)"
    status="$(curl --connect-timeout 10 --max-time 60 -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      ${3:+-H "Content-Type: application/json"} ${3:+-d "$3"} "$API$2" || true)"
    [[ "$status" =~ ^[0-9]{3}$ ]] || status="000"
  fi
  CALL_STATUS="$status"
  echo "$1 $2 -> $status  ($4)"
  case "$status" in
    2*) CALL_RESPONSE="$(cat "$out")"; rm -f "$out" ;;
    404)
      if [[ "$1" != "DELETE" ]]; then
        echo "  $(head -c 300 "$out")" >&2; rm -f "$out"; die "$1 $2 failed with404"
      fi
      echo "  not present, treating as already cleared: $(head -c 200 "$out")"; rm -f "$out" ;;
    5*|000)
      echo "  $(head -c 300 "$out" 2>/dev/null)" >&2; rm -f "$out"
      [[ -n "$soft" ]] && return 75
      die "$1 $2 failed with $status" ;;
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

# A required pass (pass-baseline or a risk lens) that failed and never
# completed: post NOTHING — checked before the outbox snapshot, so nothing is
# queued for later delivery either. The daemon requeues the round
# (scripts/required-passes.py, the mirror of src/requiredpasses.ts).
if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  REQUIRED_RC=0
  REQUIRED_PASSES="$(python3 "$ROOT/scripts/required-passes.py" "${QCR_STATE_DB:-$ROOT/state/state.db}" \
    "${QCR_ROUND_PROGRESS_DIR:-$ROOT/state/round-progress}" "$PR" "$ROUND_NO")" || REQUIRED_RC=$?
  [[ "$REQUIRED_RC" != "3" ]] || die "required pass missing for #$PR round $ROUND_NO — ${REQUIRED_PASSES#missing: }. Nothing was posted and nothing may be: do not retry or post another way; commit your verdict file as decided and stop — the daemon requeues the round."
fi

# Snapshot before any GitHub read, under the same lock as the first POST.
if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  [[ -z "$BODY_FILE" || -r "$BODY_FILE" ]] || die "unreadable review body file: $BODY_FILE"
  [[ -z "$COMMENTS_FILE" || -r "$COMMENTS_FILE" ]] || die "unreadable comments file: $COMMENTS_FILE"
  MODE="dryrun"; [[ "$LIVE" != "1" ]] || MODE="live"
  python3 "$ROOT/scripts/posting-receipt.py" enqueue "${POSTING_RECEIPT%.json}.outbox.json" "$POSTING_KEY" "$PR" "$ROUND_NO" "$RECEIPT_HEAD" "APPROVE" "$REPO" "$MODE" "$BODY_FILE" "$COMMENTS_FILE"
fi

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
# Guard 4's refusal takes back the snapshot queued above: the session answers
# it with a COMMENT under the same round key, which a pending APPROVE job would
# refuse, and the daemon's outbox would deliver the refused approval once CI
# went green. Only while no receipt exists (posting-receipt.py checks it again);
# the receipt lock is still held here. A failure is loud and changes nothing:
# the guard still refuses.
guard_on_approval_refused() {
  [[ -n "$POSTING_RECEIPT" ]] || return 0          # legacy round: nothing was queued
  if python3 "$ROOT/scripts/posting-receipt.py" withdraw "$POSTING_RECEIPT" "$POSTING_KEY"; then
    echo "approve-pr: withdrew the queued approval for $POSTING_KEY — nothing was posted" >&2
  else
    echo "approve-pr: WARNING — could not withdraw the queued approval for $POSTING_KEY; a COMMENT under the same key will be refused" >&2
  fi
}

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
        if "start_line" in c and (type(c["start_line"]) is not int or not 1 <= c["start_line"] <= c["line"]):
            raise SystemExit("invalid multiline anchor")
        if "start_side" in c and ("start_line" not in c or c["start_side"] not in ("RIGHT", "LEFT")):
            raise SystemExit("invalid multiline side")
        out.append({k: c[k] for k in ("path", "line", "side", "start_line", "start_side", "body") if k in c})
    payload["comments"] = out
json.dump(payload, sys.stdout)
PY
)"
fi
if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  python3 "$ROOT/scripts/posting-receipt.py" prepare "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$GUARD_HEAD_SHA" "APPROVE" "APPROVE" "$REVIEW_BODY_JSON"
fi
if [[ "$POST_ALREADY_CONFIRMED" == "0" && "$LIVE" == "1" && -n "$POSTING_RECEIPT" ]]; then
  POST_RC=0
  call POST "/repos/$REPO/pulls/$PR/reviews" "$REVIEW_BODY_JSON" "approve #$PR" soft || POST_RC=$?
  if [[ "$POST_RC" == "75" ]]; then
    # GitHub answered 5xx or nothing. Did the approval land anyway?
    FOUND="$(guard_marker_review "$GUARD_HEAD_SHA" "$POSTING_MARKER")"
    case "$FOUND" in
      multiple)
        die "GitHub answered $CALL_STATUS and more than one bot review carries $POSTING_KEY — refusing to guess; the daemon reconciles this loud" ;;
      none|unreadable|"")
        # Hand it to the daemon: the outbox job holds the exact payload, the
        # receipt becomes `deferred`, and the daemon retries through the gate
        # (marker read and posting guards before every attempt). Nothing is
        # stamped — no approval exists yet — and the trigger cleanup below is
        # skipped: dispatch already consumed both triggers.
        python3 "$ROOT/scripts/posting-receipt.py" defer "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$GUARD_HEAD_SHA" "APPROVE" "APPROVE" "$REVIEW_BODY_JSON" "GitHub answered $CALL_STATUS; marker read: ${FOUND:-unreadable}"
        echo "posting deferred: GitHub answered $CALL_STATUS to the approval POST and the approval is not on GitHub (marker read: ${FOUND:-unreadable})."
        echo "The daemon now owns its delivery: it retries this exact approval through the gate on its schedule and confirms it from GitHub before every attempt."
        echo "Do NOT run the posting script again for this round — finish the round normally (verdict file, ledger)."
        exit 0 ;;
      *)
        CALL_RESPONSE="$FOUND"
        echo "GitHub answered $CALL_STATUS but the approval landed (marker found) — confirming the receipt from GitHub" ;;
    esac
  elif [[ "$POST_RC" != "0" ]]; then
    die "approval POST failed"
  fi
elif [[ "$POST_ALREADY_CONFIRMED" == "0" ]]; then
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
if [[ "$LIVE" == "1" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then guard_stamp_reviewed_head "$GUARD_HEAD_SHA" "APPROVE"; fi

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
