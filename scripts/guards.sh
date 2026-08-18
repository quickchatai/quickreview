# guards.sh — the posting-time guards, shell mirror of src/guards.ts.
#
# Sourced, never executed. The daemon posts through the single MutationGate,
# where src/guards.ts installs the three guards; the PR sessions post through
# scripts/post-review.sh, approve-pr.sh and reply-thread.sh, which do not go
# through the gate. This file is the mirror for that route, exactly as those
# scripts already mirror the dry-run gate — so no posting route reaches GitHub
# around a guard. The two halves are kept behaviourally identical on purpose;
# tests/guards-shell.test.ts runs the real scripts against a loopback stub, and
# tests/guards.test.ts runs the real gate, over the same cases.
#
#   1. A non-author human APPROVED at this head ⇒ REQUEST_CHANGES becomes
#      COMMENT, findings untouched, with a note saying why.
#   2. Same head as the last review and no author reply since ⇒ post nothing.
#   3. Merged/closed re-check immediately before the mutation; in live mode an
#      unreadable state fails CLOSED.
#
# Nothing here dismisses, retracts or edits any existing review. A guard can
# only refuse a post or soften REQUEST_CHANGES to COMMENT.
#
# Contract for the sourcing script: it must already define `die`, `cfg`, and
# the variables API, ROOT, CONFIG, REPO, PR, LIVE.

GUARD_STATE_DB="${QCR_STATE_DB:-$ROOT/state/state.db}"

guard_enabled() { # guard_enabled <config key> — on unless [guards] says false
  local v
  v="$(cfg guards "$1" 2>/dev/null || true)"
  [[ "$v" == "false" ]] && return 1 || return 0
}

guard_token() {
  # Live mode must authenticate; in dry-run a missing credential is fine — the
  # read is best-effort there because nothing is going to be sent anyway.
  if [[ "$LIVE" == "1" ]]; then "$ROOT/scripts/mint-token.sh"; else "$ROOT/scripts/mint-token.sh" 2>/dev/null || true; fi
}

guard_api_get() { # guard_api_get <path> — response body on stdout, "" on failure
  local tok
  tok="$(guard_token)"
  if [[ -n "$tok" ]]; then
    curl -sS -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$API$1" || true
  else
    curl -sS -H "Accept: application/vnd.github+json" "$API$1" || true
  fi
}

# ---- guard 3: is the PR still open, right now? ------------------------------

GUARD_PR_STATE=""   # open | merged | closed | unreadable
GUARD_HEAD_SHA=""
GUARD_PR_AUTHOR=""

guard_read_pr() { # one REST read, immediately before the mutation
  local body parsed
  body="$(guard_api_get "/repos/$REPO/pulls/$PR")"
  parsed="$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = None
if not isinstance(d, dict) or "state" not in d:
    print("unreadable\t\t")
    raise SystemExit(0)
if d.get("merged"):
    state = "merged"
elif d.get("state") != "open":
    state = "closed"
else:
    state = "open"
head = (d.get("head") or {}).get("sha") or ""
author = (d.get("user") or {}).get("login") or ""
print("\t".join([state, head, author]))
' || printf 'unreadable\t\t')"
  IFS=$'\t' read -r GUARD_PR_STATE GUARD_HEAD_SHA GUARD_PR_AUTHOR <<<"$parsed"
  [[ -n "$GUARD_PR_STATE" ]] || GUARD_PR_STATE="unreadable"
}

guard_require_open() { # refuses on merged/closed; fails closed in live mode
  if ! guard_enabled recheck_pr_state_before_post; then
    GUARD_PR_STATE="open"
    return 0
  fi
  guard_read_pr
  case "$GUARD_PR_STATE" in
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

# ---- guard 2: no new evidence ----------------------------------------------

guard_require_new_evidence() { # guard_require_new_evidence <head-sha>
  guard_enabled skip_unchanged_head || return 0
  local head="${1:-}" verdict
  [[ -n "$head" ]] || return 0   # unknown head: guessing would suppress a real review
  verdict="$(python3 - "$GUARD_STATE_DB" "$PR" "$head" <<'PY' 2>/dev/null || echo new
import os, sqlite3, sys
db, pr, head = sys.argv[1], int(sys.argv[2]), sys.argv[3]
if not os.path.exists(db):
    print("new"); raise SystemExit(0)
try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = con.execute(
        "SELECT head_sha, reviewed_at, last_author_reply_at FROM reviewed_heads WHERE pr = ?",
        (pr,),
    ).fetchone()
except Exception:
    print("new"); raise SystemExit(0)
if row is None or row[0] != head:
    print("new")
elif row[2] and row[2] >= row[1]:
    # `>=`, not `>`: an ambiguous reply reads as new evidence (as in guards.ts).
    print("new")
else:
    print("stale")
PY
)"
  if [[ "$verdict" == "stale" ]]; then
    die "#$PR head ${head:0:7} was already reviewed and there is no author reply since — refusing to post (guard 2)"
  fi
}

# ---- guard 1: a human already approved this head ---------------------------

guard_human_approver() { # guard_human_approver <head-sha> <pr-author> — login or ""
  local head="${1:-}" author="${2:-}" bot
  guard_enabled downgrade_on_human_approval || return 0
  [[ -n "$head" ]] || return 0
  bot="$(cfg github bot_login 2>/dev/null || true)"
  guard_api_get "/repos/$REPO/pulls/$PR/reviews?per_page=100" | python3 -c '
import json, sys
head, author, bot = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    reviews = json.load(sys.stdin)
except Exception:
    reviews = []
if not isinstance(reviews, list):
    reviews = []
# The latest verdict-bearing review per person wins: a later CHANGES_REQUESTED
# or DISMISSED retires an approval. COMMENTED/PENDING carry no verdict.
latest = {}
for r in reviews:
    if not isinstance(r, dict):
        continue
    state = str(r.get("state") or "").upper()
    if state not in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
        continue
    user = ((r.get("user") or {}).get("login")) or ""
    if not user:
        continue
    latest[user] = (state, r.get("commit_id") or "")
for user, (state, commit) in latest.items():
    if state != "APPROVED" or commit != head:
        continue
    if user == author:            # GitHub forbids it, but never trust that
        continue
    if user == bot or user.endswith("[bot]"):
        continue
    print(user)
    break
' "$head" "$author" "$bot" 2>/dev/null || true
}

guard_downgrade_note() { # guard_downgrade_note <approver> <head-sha>
  printf '_Not blocking: **@%s** has already approved this head (`%s`). The findings above are reported for information only — this review does not request changes._' \
    "$1" "${2:0:7}"
}

# ---- the reviewed-head mark -------------------------------------------------

guard_stamp_reviewed_head() { # guard_stamp_reviewed_head <head-sha> <event>
  # Mirrors StateStore.recordReviewedHead: a NEW head replaces the row, the
  # SAME head keeps verdict/round_no and clears the author-reply memory. Only
  # ever called after a review really reached GitHub — a dry-run record posted
  # nothing, so nothing has been reviewed.
  local head="${1:-}" event="${2:-}"
  [[ -n "$head" ]] || return 0
  python3 - "$GUARD_STATE_DB" "$PR" "$head" "$event" <<'PY' 2>/dev/null || true
import datetime, os, sqlite3, sys
db, pr, head, event = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
if not os.path.exists(db):
    raise SystemExit(0)
con = sqlite3.connect(db, timeout=5)
have = con.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='reviewed_heads'"
).fetchone()
if not have:
    raise SystemExit(0)
row = con.execute("SELECT head_sha, verdict, round_no FROM reviewed_heads WHERE pr = ?", (pr,)).fetchone()
same = bool(row) and row[0] == head
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
con.execute(
    """INSERT INTO reviewed_heads (pr, head_sha, reviewed_at, verdict, posted_event, round_no, last_author_reply_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(pr) DO UPDATE SET
         head_sha=excluded.head_sha, reviewed_at=excluded.reviewed_at, verdict=excluded.verdict,
         posted_event=excluded.posted_event, round_no=excluded.round_no, last_author_reply_at=NULL""",
    (pr, head, now, row[1] if same else None, event or None, row[2] if same else None),
)
con.commit()
PY
}
