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
# Posting-time guards 1, 2, 3 and 5 run here, from scripts/guards.sh — the
# shell mirror of src/guards.ts, which the MutationGate enforces on the
# daemon's own route. This is the session's route, so it refuses exactly what
# the gate refuses: a merged/closed PR, a head that is no longer the one the
# round reviewed, a head already reviewed with nothing new since, and
# REQUEST_CHANGES over a head a human has already approved (softened to
# COMMENT, findings intact).
#
# Usage: post-review.sh <pr-number> <REQUEST_CHANGES|COMMENT> <body-file> [comments-json-file]
#   comments-json-file: JSON array of {path, line, side?, body} inline comments.

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides: $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1
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

# The replay guard runs before the posting guards: once this exact round/head
# has a confirmed receipt, a retry is an idempotent success even though guard 2
# sees an already-reviewed head.
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
      # exact review to the daemon, which owns its delivery now. Never a
      # second POST from here.
      echo "posting for $POSTING_KEY is deferred to the daemon (GitHub did not answer an earlier attempt); it delivers this review itself — nothing to do, finish the round normally"
      exit 0 ;;
    skipped)
      # This exact round was already refused by guard 2 and the
      # refusal is recorded. Terminal for the key — nothing was posted and
      # nothing will be; a reply landing since belongs to ping-pong, and the
      # daemon has (or will have) closed the round on the record.
      die "posting for $POSTING_KEY was already refused: #$PR head ${RECEIPT_HEAD:0:7} was already reviewed with no author reply since (guard 2). Nothing was posted for this round and nothing will be — record that in the verdict and stop."
      ;;
    none) : ;;
    *) die "invalid or mismatched posting receipt for $POSTING_KEY" ;;
  esac
fi
if [[ "$POST_ALREADY_CONFIRMED" == "1" ]]; then
  echo "posting receipt already confirmed for $POSTING_KEY — skipping duplicate review"
  exit 0
fi
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
[[ -n "$BODY_FILE" && -r "$BODY_FILE" ]] || die "unreadable review body file: ${BODY_FILE:-<missing>}"
if [[ -n "$COMMENTS_FILE" ]]; then
  [[ -r "$COMMENTS_FILE" ]] || die "unreadable comments file: $COMMENTS_FILE"
fi

# Snapshot before any GitHub read, under the same lock as the first POST.
if [[ -n "$POSTING_RECEIPT" && "$POST_ALREADY_CONFIRMED" == "0" ]]; then
  [[ -r "$BODY_FILE" ]] || die "unreadable review body file: $BODY_FILE"
  [[ -z "$COMMENTS_FILE" || -r "$COMMENTS_FILE" ]] || die "unreadable comments file: $COMMENTS_FILE"
  MODE="dryrun"; [[ "$LIVE" != "1" ]] || MODE="live"
  python3 "$ROOT/scripts/posting-receipt.py" enqueue "${POSTING_RECEIPT%.json}.outbox.json" "$POSTING_KEY" "$PR" "$ROUND_NO" "$RECEIPT_HEAD" "$EVENT" "$REPO" "$MODE" "$BODY_FILE" "$COMMENTS_FILE"
fi

# ---- the posting-time guards --------------------------------------------------

# Guard 2's refusal is recorded as a guarded no-op bound to this
# round's posting identity, so the daemon can close the round as "nothing to
# post" instead of reading the missing receipt as a lost POST. Written only for
# a receipt-keyed round, only when the refused head IS the head the key names,
# and only by posting-receipt.py, which refuses to write it over any attempted
# post (prepared/confirmed/dryrun). It carries the mark the guard read. The
# receipt lock is still held here, so no concurrent attempt can race it. A
# failure to record is loud and changes nothing: the guard still refuses.
guard_on_no_new_evidence() { # guard_on_no_new_evidence <refused-head> <standing-mark-json>
  local head="${1:-}" mark="${2:-}"
  [[ -n "$POSTING_RECEIPT" ]] || return 0          # legacy round: no identity to bind to
  if [[ -z "$mark" ]]; then
    echo "post-review: WARNING — guard 2 refused $POSTING_KEY but handed back no standing mark; recording nothing" >&2
    return 0
  fi
  if [[ "${head,,}" != "${RECEIPT_HEAD,,}" ]]; then
    echo "post-review: WARNING — guard 2 refused at ${head:0:7} but $POSTING_KEY is keyed to ${RECEIPT_HEAD:0:7}; recording nothing" >&2
    return 0
  fi
  local mode="dryrun"
  [[ "$LIVE" == "1" ]] && mode="live"
  if python3 "$ROOT/scripts/posting-receipt.py" skip "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$head" "$EVENT" "$mode" "$mark"; then
    echo "post-review: recorded guarded no-op (no-new-evidence) for $POSTING_KEY — nothing was posted" >&2
  else
    echo "post-review: WARNING — could not record the guarded no-op for $POSTING_KEY; the daemon will treat this round's outcome as unknown" >&2
  fi
}

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
CALL_STATUS=""
# call <method> <path> <body-json> <note> [soft]
# A 2xx returns with CALL_RESPONSE set. With `soft`, a 5xx or no response at
# all (curl's 000: connect failure, timeout, reset) returns 75 instead of
# dying — the caller then asks GitHub whether the review landed.
# Every other status dies, as before.
call() {
  local out status soft="${5:-}"
  out="$(mktemp)"
  status="$(curl --connect-timeout 10 --max-time 60 -sS -X "$1" -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $("$ROOT/scripts/mint-token.sh")" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/json" -d "$3" "$API$2" || true)"
  [[ "$status" =~ ^[0-9]{3}$ ]] || status="000"
  if [[ "$status" == "401" ]]; then          # stale installation token: re-mint once
    status="$(curl --connect-timeout 10 --max-time 60 -sS -X "$1" -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $("$ROOT/scripts/mint-token.sh" --refresh)" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/json" -d "$3" "$API$2" || true)"
    [[ "$status" =~ ^[0-9]{3}$ ]] || status="000"
  fi
  CALL_STATUS="$status"
  echo "$1 $2 -> $status  ($4)"
  case "$status" in
    2*) CALL_RESPONSE="$(cat "$out")"; rm -f "$out" ;;
    5*|000)
      echo "  $(head -c 300 "$out" 2>/dev/null)" >&2; rm -f "$out"
      [[ -n "$soft" ]] && return 75
      die "$1 $2 failed with $status" ;;
    *)  echo "  $(head -c 300 "$out")" >&2; rm -f "$out"; die "$1 $2 failed with $status" ;;
  esac
}

# GitHub answered the review POST with a 5xx or not at all. The
# review may still have landed, so GitHub is asked first: a bot review
# carrying this round's marker at this head means it did — confirm the
# receipt from it, exactly as from a 2xx. Otherwise the POST is handed to the
# daemon: the outbox job beside the receipt already holds the exact payload,
# the receipt becomes `deferred`, and the daemon retries it through the ONE
# MutationGate on its schedule (state.db posting_retries), reading the marker
# again before every attempt. The script then exits 0 so the session finishes
# its round normally — and it stamps nothing: no review exists yet.
handoff_unanswered_post() { # handoff_unanswered_post <intended> <actual> <payload>
  local intended="$1" actual="$2" payload="$3" found
  found="$(guard_marker_review "$HEAD_SHA" "$POSTING_MARKER")"
  case "$found" in
    multiple)
      die "GitHub answered $CALL_STATUS and more than one bot review carries $POSTING_KEY — refusing to guess; the daemon reconciles this loud" ;;
    none|unreadable|"")
      python3 "$ROOT/scripts/posting-receipt.py" defer "$POSTING_RECEIPT" "$POSTING_KEY" "$PR" "$ROUND_NO" "$HEAD_SHA" "$intended" "$actual" "$payload" "GitHub answered $CALL_STATUS; marker read: ${found:-unreadable}"
      echo "posting deferred: GitHub answered $CALL_STATUS to the review POST and the review is not on GitHub (marker read: ${found:-unreadable})."
      echo "The daemon now owns its delivery: it retries this exact review through the gate on its schedule and confirms it from GitHub before every attempt."
      echo "Do NOT run the posting script again for this round — finish the round normally (verdict file, ledger)."
      exit 0 ;;
    *)
      CALL_RESPONSE="$found"
      echo "GitHub answered $CALL_STATUS but the review landed (marker found) — confirming the receipt from GitHub" ;;
  esac
}

NOTE="post $EVENT review on #$PR"
if [[ -n "$DOWNGRADE_NOTE" ]]; then NOTE="$NOTE (downgraded: @$APPROVER approved this head)"; fi
if [[ "$LIVE" == "1" ]]; then
  if [[ "$POST_ALREADY_CONFIRMED" == "0" && -n "$POSTING_RECEIPT" ]]; then
    POST_RC=0
    call POST "/repos/$REPO/pulls/$PR/reviews" "$PAYLOAD" "$NOTE" soft || POST_RC=$?
    if [[ "$POST_RC" == "75" ]]; then
      handoff_unanswered_post "$INTENDED_EVENT" "$EVENT" "$PAYLOAD"
    elif [[ "$POST_RC" != "0" ]]; then
      die "review POST failed"
    fi
  elif [[ "$POST_ALREADY_CONFIRMED" == "0" ]]; then
    call POST "/repos/$REPO/pulls/$PR/reviews" "$PAYLOAD" "$NOTE"   # legacy unkeyed: no receipt, no handoff
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
