# guards.sh — the posting-time guards, shell mirror of src/guards.ts.
#
# Sourced, never executed. The daemon posts through the single MutationGate,
# where src/guards.ts installs the guards; the PR sessions post through
# scripts/post-review.sh, approve-pr.sh and reply-thread.sh, which do not go
# through the gate. This file is the mirror for that route, exactly as those
# scripts already mirror the dry-run gate — so no posting route reaches GitHub
# around a guard. The two halves are kept behaviourally identical on purpose;
# tests/guards-shell-*.test.ts runs the real scripts against a loopback stub, and
# tests/guards.test.ts runs the real gate, over the same cases.
#
#   1. A non-author human APPROVED at this head ⇒ REQUEST_CHANGES becomes
#      COMMENT, findings untouched, with a note saying why.
#   2. Same head as the last review and no author reply since ⇒ post nothing.
#   3. Merged/closed re-check immediately before the mutation; in live mode an
#      unreadable state fails CLOSED.
#   4. No green CI at this head ⇒ APPROVE is unavailable (approve-pr.sh
#      only — post-review.sh cannot approve). Refuses; the review is posted as a
#      COMMENT with approval withheld instead.
#   5. The live head must be the head the round actually reviewed. The
#      session sets QCR_EXPECTED_HEAD — the sha its round prompt cites — as a
#      prefix on the posting call; a mismatch refuses the post. A missing
#      expectation (session on an older prompt) warns and proceeds —
#      belt-and-braces, never a wedge.
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
    curl --connect-timeout 10 --max-time 60 -sS -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$API$1" || true
  else
    curl --connect-timeout 10 --max-time 60 -sS -H "Accept: application/vnd.github+json" "$API$1" || true
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

# ---- guard 5: the head the round reviewed must still be the head -----------
#
# The PR can advance between the round's validation and its posting step, and
# a review posted then would land on a head it never read. The expected sha is
# the one the round prompt cites; the session sets it as QCR_EXPECTED_HEAD, an
# env prefix on the posting call (the exec policy refuses `export`).
# On a mismatch the only correct move is to post nothing: a fresh-head rerun
# is the daemon's job, never the session's.

guard_require_expected_head() { # guard_require_expected_head <live-head-sha>
  guard_enabled refuse_on_head_drift || return 0
  local live="${1:-}" expected="${QCR_EXPECTED_HEAD:-}"
  if [[ -z "$expected" ]]; then
    # Older round prompts do not set the expectation. Warn, but never refuse:
    # wedging every legacy session is worse than the drift race.
    echo "guard: WARNING — QCR_EXPECTED_HEAD is not set; cannot verify that #$PR's live head (${live:0:7}) is the sha this round reviewed (guard 5). Prefix the posting call with QCR_EXPECTED_HEAD=<reviewed head sha> (never export it)." >&2
    return 0
  fi
  # An unreadable live head is guard 3's case, not this one's.
  [[ -n "$live" ]] || return 0
  if [[ "${live,,}" != "${expected,,}" ]]; then
    die "#$PR head moved: this round reviewed ${expected:0:7} but the PR is now at ${live:0:7} — refusing to post a stale review (guard 5). Post nothing further; write the round's verdict file with \"outcome\": \"head_moved\" in place of a verdict (see the round prompt) and end the round — re-reviewing the new head is the daemon's job, not yours."
  fi
}

# ---- guard 2: no new evidence ----------------------------------------------

# The refusal is final, and it leaves evidence: the standing mark the guard
# read is handed to `guard_on_no_new_evidence` when the sourcing script
# defines it, so post-review.sh can write an identity-bound guarded-no-op
# record before the exit. Without that record the daemon could not tell "POST
# was forbidden and never attempted" from "POST may have been lost", and read the missing receipt
# as infrastructure failure. The hook runs before die and its failure never
# changes the guard's answer.

GUARD_STANDING_MARK_JSON=""   # the mark guard 2 refused on, as JSON (set on refusal)

guard_require_new_evidence() { # guard_require_new_evidence <head-sha>
  guard_enabled skip_unchanged_head || return 0
  local head="${1:-}" answer answer_kind
  [[ -n "$head" ]] || return 0   # unknown head: guessing would suppress a real review
  answer="$(python3 - "$GUARD_STATE_DB" "$PR" "$head" <<'PY' 2>/dev/null || echo new
import json, os, sqlite3, sys
db, pr, head = sys.argv[1], int(sys.argv[2]), sys.argv[3]
if not os.path.exists(db):
    print("new"); raise SystemExit(0)
try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = con.execute(
        "SELECT head_sha, reviewed_at, last_author_reply_at, verdict, posted_event, round_no FROM reviewed_heads WHERE pr = ?",
        (pr,),
    ).fetchone()
except Exception:
    print("new"); raise SystemExit(0)
# The undecided carve-out, mirroring src/guards.ts hasNewEvidence: a
# NEEDS_HUMAN (legacy spelling ESCALATE, folded by normalizeVerdict) mark is an
# UNDECIDED review, and undecided is not reviewed-and-decided — it must never
# suppress a re-run or a posting.
if row is not None and (row[3] or "").strip().upper() in ("NEEDS_HUMAN", "ESCALATE"):
    print("new")
elif row is None or row[0] != head:
    print("new")
elif row[2] and row[2] >= row[1]:
    # `>=`, not `>`: an ambiguous reply reads as new evidence (as in guards.ts).
    print("new")
else:
    # stale, plus the mark itself on the same line: the record the daemon
    # settles from must be the evidence the guard actually read, not a second
    # read taken later by another process.
    mark = {
        "head_sha": row[0], "reviewed_at": row[1], "last_author_reply_at": row[2],
        "verdict": row[3], "posted_event": row[4], "round_no": row[5],
    }
    print("stale\t" + json.dumps(mark, separators=(",", ":")))
PY
)"
  answer_kind="${answer%%$'\t'*}"
  if [[ "$answer_kind" == "stale" ]]; then
    GUARD_STANDING_MARK_JSON="${answer#*$'\t'}"
    [[ "$GUARD_STANDING_MARK_JSON" == "$answer" ]] && GUARD_STANDING_MARK_JSON=""
    if declare -F guard_on_no_new_evidence >/dev/null; then
      guard_on_no_new_evidence "$head" "$GUARD_STANDING_MARK_JSON" || true
    fi
    die "#$PR head ${head:0:7} was already reviewed and there is no author reply since — refusing to post (guard 2)"
  fi
}

# ---- guard 1: a human already approved this head ---------------------------

guard_array_pages() { # guard_array_pages <path?per_page=100> — every page of a bare-array list as ONE JSON array, "" when unreadable
  # Mirrors pagedArray in src/github.ts: a short page ends it, 30 pages bound
  # it, and any page that is not an array makes the whole read unreadable —
  # a truncated list is never passed off as the list.
  local path="$1" page body rows="" n
  for ((page = 1; page <= 30; page++)); do
    body="$(guard_api_get "${path}&page=${page}")"
    body="$(printf '%s' "$body" | jq -c 'select(type == "array")' 2>/dev/null)" || body=""
    [[ -n "$body" ]] || return 0
    rows+="$body"$'\n'
    n="$(printf '%s' "$body" | jq 'length')"
    if ((n < 100)); then break; fi
  done
  printf '%s' "$rows" | jq -cs 'add'
}

guard_human_approver() { # guard_human_approver <head-sha> <pr-author> — login or ""
  local head="${1:-}" author="${2:-}" bot
  guard_enabled downgrade_on_human_approval || return 0
  [[ -n "$head" ]] || return 0
  bot="$(cfg github bot_login 2>/dev/null || true)"
  # Every page: reviews are oldest-first, so on a long PR the human approval
  # at this head is exactly what a first-page read misses (listReviews twin).
  guard_array_pages "/repos/$REPO/pulls/$PR/reviews?per_page=100" | python3 -c '
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

# ---- guard 4: no green CI at this head ⇒ no approval -----------------------
#
# Mirrors src/cigate.ts `classifyCi`. Only approve-pr.sh sources this one —
# post-review.sh hard-rejects APPROVE already, so it has nothing to withhold.
# The shell half refuses instead of softening: this script can only approve, so
# the session posts the full review as a COMMENT through post-review.sh (with
# approval_withheld in its verdict file) exactly as the round template says.
#
# CI is read here and nowhere triggered or re-run. An unreadable CI is not
# evidence of red: it never blocks, for the same reason guard 1's failed read
# never blocks — a GitHub outage must not turn into a pile of withheld
# approvals.

guard_ci_pages() { # guard_ci_pages <path?per_page=100> <key> — every page's <key> rows as ONE compact {<key>: [...]} line
  # Mirrors the page loop in src/github.ts listChecks: guard 4 classifies what
  # it is handed, so a failing or pending check past row 100 must reach it —
  # a first-page read of a big matrix classified green. Up to 10 pages, a
  # short page ends it. Any page that cannot be read makes the whole read
  # unreadable (""), exactly as a throw anywhere in listChecks does: a
  # truncated list is never passed off as the list.
  local path="$1" key="$2" page body page_rows rows="" n
  for ((page = 1; page <= 10; page++)); do
    body="$(guard_api_get "${path}&page=${page}")"
    # On page 1 an error object counts as no rows.
    # A later page must actually carry the <key> array: an error body there
    # (rate limit, 5xx JSON) would otherwise read as a short page and pass a
    # truncated list off as the whole — src/github.ts throws on it instead.
    page_rows="$(printf '%s' "$body" | jq -c --arg k "$key" --argjson p "$page" \
      'select(type == "object")
       | if $p > 1 then (.[$k] | select(type == "array"))
         else (.[$k] // []) | if type == "array" then . else [] end end' \
      2>/dev/null)" || page_rows=""
    [[ -n "$page_rows" ]] || return 0
    rows+="$page_rows"$'\n'
    n="$(printf '%s' "$page_rows" | jq 'length')"
    if ((n < 100)); then break; fi
  done
  printf '%s' "$rows" | jq -cs --arg k "$key" '{($k): add}'
}

guard_ci_state() { # guard_ci_state <head-sha> — green|red|pending|none|unknown
  local head="${1:-}" runs status
  [[ -n "$head" ]] || { echo unknown; return 0; }
  runs="$(guard_ci_pages "/repos/$REPO/commits/$head/check-runs?per_page=100" check_runs)"
  status="$(guard_ci_pages "/repos/$REPO/commits/$head/status?per_page=100" statuses)"
  # Mirrors src/cigate.ts classifyCi — keep the two in step.
  # Latest-run-per-name (rule stated exactly on src/cigate.ts
  # latestRunPerName): GitHub auto-cancels superseded runs; only the most
  # recent run of each check name counts. Recency collapses only check-runs
  # that carry a started_at (latest wins, equal start → later list position);
  # a run without one never competes with a timestamped one —
  # it is kept beside it and counts on its own, the last such per name. Commit
  # statuses carry no time and are never grouped with check-runs at all: a
  # status under the same context as a check-run is a second check, and a
  # failing one must never be masked by a passing run of that name.
  # The two docs ride stdin, one line each — never the environment, where
  # a page of full check-run objects can pass the kernel's per-string cap.
  printf '%s\n%s\n' "$runs" "$status" | jq -rRn '
    [inputs | select(. != "") | try fromjson catch empty] as $docs
    | if ($docs | length) == 0 then "unknown"
      else
        ( [ [ $docs[] | select(type == "object") | (.check_runs? // [])[] ]
            | to_entries | map(.value + { qcr_idx: .key })
            | group_by(.name // "check")[]
            | ( [ .[] | select((.started_at // "") != "") ] | select(length > 0) | max_by([.started_at, .qcr_idx]) ),
              ( [ .[] | select((.started_at // "") == "") ] | select(length > 0) | max_by(.qcr_idx) )
            | [ ((.status // "") | tostring | ascii_downcase),
                ((.conclusion // "") | tostring | ascii_downcase) ] ]
        + [ $docs[] | select(type == "object") | (.statuses? // [])[]
            | ((.state // "") | tostring) as $s
            | if $s == "pending" then ["pending", ""]
              else ["completed", (if $s == "success" then "success" else "failure" end)]
              end ] ) as $checks
        | if ($checks | length) == 0 then "none"
          else
            ["queued", "in_progress", "waiting", "pending", "requested"] as $unfinished
            | ["skipped", "neutral"] as $inert
            | ($checks | map(.[0] as $st | .[1] as $c | select(
                (($unfinished | index($st)) == null)
                and (($st == "completed") or ($c != ""))))) as $finished
            | if any($finished[]; .[1] as $c | ($c != "success") and (($inert | index($c)) == null)) then "red"
              elif ($checks | length) > ($finished | length) then "pending"
              elif any($finished[]; .[1] == "success") then "green"
              else "red"
              end
          end
      end' 2>/dev/null || echo unknown
}

guard_require_green_ci() { # guard_require_green_ci <head-sha>
  guard_enabled block_approve_on_red_ci || return 0
  local head="${1:-}" state
  # Guard 3 usually has the head already; if it was switched off, read it here.
  [[ -n "$head" ]] || { guard_read_pr; head="$GUARD_HEAD_SHA"; }
  state="$(guard_ci_state "$head")"
  case "$state" in
    red|pending)
      die "CI is ${state} at ${head:0:7} on #$PR — APPROVE is unavailable (guard 4). Post the full review as a COMMENT via scripts/post-review.sh, say plainly that no blockers were found and that approval is withheld pending green CI, and set \"approval_withheld\": true in the verdict file."
      ;;
    none)
      # In a CI-running repo, zero checks at the head
      # (conflicted PR, CI not started) is no execution evidence — withhold.
      if [[ "$(cfg guards no_checks_is_red 2>/dev/null || true)" == "true" ]]; then
        die "no CI has run at ${head:0:7} on #$PR — APPROVE is unavailable (guard 4, no_checks_is_red). Post the full review as a COMMENT via scripts/post-review.sh, say approval is withheld until checks run green, and set \"approval_withheld\": true in the verdict file."
      fi
      ;;
    *) ;;   # green, unknown: the guard blocks only what it can see
  esac
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

# ---- the posting-marker read ---------------------------------------

guard_marker_review() { # guard_marker_review <head-sha> <marker> — the ONE bot review carrying the marker at that head (JSON), or none|multiple|unreadable
  # The read the shell route makes after a review POST that GitHub answered
  # 5xx (or not at all): did the review land anyway? Every page, the bot's own
  # identities only (bot_login and <app_slug>[bot]), the exact head — the same
  # filter src/verdicts.ts postingProof and src/posting-outbox.ts apply. An
  # unreadable list is `unreadable`, never `none`.
  local head="${1:-}" marker="${2:-}" bot slug rows
  bot="$(cfg github bot_login 2>/dev/null || true)"
  slug="$(cfg github app_slug 2>/dev/null || true)"
  rows="$(guard_array_pages "/repos/$REPO/pulls/$PR/reviews?per_page=100")"
  if [[ -z "$rows" ]]; then echo "unreadable"; return 0; fi
  printf '%s' "$rows" | python3 -c '
import json, sys
head, marker, bot, slug = sys.argv[1].lower(), sys.argv[2], sys.argv[3], sys.argv[4]
try:
    reviews = json.load(sys.stdin)
except Exception:
    print("unreadable"); raise SystemExit(0)
if not isinstance(reviews, list):
    print("unreadable"); raise SystemExit(0)
ids = {i for i in (bot, f"{slug}[bot]" if slug else "") if i}
hits = [r for r in reviews if isinstance(r, dict)
        and ((r.get("user") or {}).get("login") or "") in ids
        and str(r.get("commit_id") or "").lower() == head
        and marker in str(r.get("body") or "")]
if len(hits) > 1:
    print("multiple")
elif hits:
    print(json.dumps(hits[0]))
else:
    print("none")
' "$head" "$marker" "$bot" "$slug" 2>/dev/null || echo "unreadable"
}
