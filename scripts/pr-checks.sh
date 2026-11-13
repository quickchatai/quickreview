#!/usr/bin/env bash
# pr-checks.sh — compact read-only CI status for a PR.
#
# One line per check run (name, status/conclusion, url) and per commit status
# (`status <context>: <state>`), plus a final
#   SUMMARY: n passed / n failed / n pending
# REST only: GET /pulls/{n} for the head sha, then /commits/{sha}/check-runs
# and /commits/{sha}/status.
# Read-only: no gate involvement. On a daemon's host the daemon reads
# (src/ghread.ts); elsewhere the token comes from scripts/mint-token.sh only.
#
# Usage: pr-checks.sh <pr-number> [--why]
#
# --why: after the summary, for every FAILING latest check-run, print
# what CI itself reported — the check's output title/summary/text, its
# annotations (file:line: message), and for a GitHub Actions job the tail of
# its log — so the review can tie each failure to the changed lines. Still
# GETs only; the review reads CI, it never runs, re-runs or cancels anything.
# The default output (without --why) is unchanged.

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides: $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1

die() { echo "pr-checks: $*" >&2; exit 1; }

PR="${1:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "usage: pr-checks.sh <pr-number> [--why]"
WHY=0
[[ "${2:-}" == "--why" ]] && WHY=1

cfg() { # cfg <section-or-empty> <key>  (tomllib, sed fallback — as mint-token.sh)
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

REPO="$(cfg github repo)"
[[ -n "$REPO" ]] || die "config.toml: [github].repo missing"
# On a host the daemon runs (the worker socket and the capability fd are in env)
# the daemon makes the read with the App's token (src/ghread.ts): the
# model's tool uid can neither read the App key nor mint a token. Elsewhere the
# read is our own, with a token from mint-token.sh.
VIA_DAEMON=0
[[ -n "${QCR_IPC_SOCKET:-}" && -n "${QCR_IPC_CAP_FD:-}" ]] && VIA_DAEMON=1
GHREAD="$ROOT/dist/src/ipc/ghreadshim.js"
TOKEN=""
[[ "$VIA_DAEMON" == 1 ]] || TOKEN="$("$ROOT/scripts/mint-token.sh")"

get() { # get <path>  → body in $OUT, dies on non-200
  local status
  if [[ "$VIA_DAEMON" == 1 ]]; then
    status="$(node "$GHREAD" get "$1" "$OUT")"
  else
    status="$(curl -sS -o "$OUT" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" "$API$1")"
  fi
  [[ "$status" == "200" ]] || die "GET $1 -> $status: $(head -c 300 "$OUT")"
}

OUT="$(mktemp)"
RUNS="$(mktemp)"
FAILING="$(mktemp)"
STATUSES="$(mktemp)"
WORKFLOWS="$(mktemp)"
trap 'rm -f "$OUT" "$RUNS" "$FAILING" "$FAILING.output" "$STATUSES" "$WORKFLOWS"' EXIT

get "/repos/$REPO/pulls/$PR"
HEAD_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["head"]["sha"])' "$OUT")"

# The WORKFLOW RUNS at the head, read BEFORE the check-runs (as src/github.ts
# listChecks reads them): the one source that ties a check-run's suite to its
# workflow, so the husks of a run that a newer run of the same workflow
# superseded are not counted (packages/pi-plugin/src/cigate.ts supersededSuites
# states the rule). Unreadable — no Actions permission, Actions off, any error
# — means nothing is superseded: every check-run counts, stricter, never greener.
echo '{"workflow_runs": []}' >"$WORKFLOWS"
WF_OK=1
for ((page = 1; page <= 10; page++)); do
  (get "/repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100&page=$page") 2>/dev/null \
    || { WF_OK=0; break; }
  # Accumulate; print "<rows on this page> <done>". A snapshot that contradicts
  # itself — total_count moving between pages, more rows than it advertised,
  # or a short page before it — fails, as the adapter's completeCheckPages does.
  out="$(python3 -c '
import json, sys
acc = json.load(open(sys.argv[1]))
page_doc = json.load(open(sys.argv[2]))
rows = page_doc.get("workflow_runs") if isinstance(page_doc, dict) else None
if not isinstance(rows, list):
    raise SystemExit(1)
count = page_doc.get("total_count")
if count is not None:
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise SystemExit(1)
    if acc.get("total_count") is not None and acc["total_count"] != count:
        raise SystemExit(1)
    acc["total_count"] = count
acc["workflow_runs"] += rows
expected = acc.get("total_count")
got = len(acc["workflow_runs"])
if expected is not None and got > expected:
    raise SystemExit(1)
done = len(rows) < 100 or (expected is not None and got == expected)
if done and expected is not None and got != expected:
    raise SystemExit(1)
json.dump(acc, open(sys.argv[1], "w"))
print(len(rows), int(done))' "$WORKFLOWS" "$OUT")" || { WF_OK=0; break; }
  [[ "${out#* }" == 1 ]] && break
  ((page < 10)) || WF_OK=0
done
# Unreadable or inconsistent: no runs, so nothing is superseded.
[[ "$WF_OK" == 1 ]] || echo '{"workflow_runs": []}' >"$WORKFLOWS"

# Every page, as src/github.ts listChecks and guards.sh read them: a failing
# or pending run past row 100 is still a check at this head. Up to 10 pages; a
# short page ends it, and a malformed page or an exhausted limit dies (no
# CLASSIFIED line) rather than classifying part of the evidence. The pages accumulate into $RUNS as one {check_runs: [...]}.
echo '{"check_runs": []}' >"$RUNS"
for ((page = 1; page <= 10; page++)); do
  get "/repos/$REPO/commits/$HEAD_SHA/check-runs?per_page=100&page=$page"
  n="$(python3 -c '
import json, sys
acc = json.load(open(sys.argv[1]))
page_doc = json.load(open(sys.argv[2]))
rows = page_doc.get("check_runs") if isinstance(page_doc, dict) else None
if not isinstance(rows, list):
    raise SystemExit("check-runs page has no check_runs list")
acc["check_runs"] += rows
json.dump(acc, open(sys.argv[1], "w"))
print(len(rows))' "$RUNS" "$OUT")" || die "check-runs page $page unreadable"
  if ((n < 100)); then break; fi
done
((n < 100)) || die "incomplete check-runs: page limit reached"

# The COMMIT STATUSES at the head, every page, as listChecks and guards.sh read
# them, so a failing status (a deploy preview, an external CI that reports
# through the status API) classifies red here exactly as guard 4 does. A status
# is its own check: never collapsed with a check-run of its context, nor with
# another status (the packages/pi-plugin/src/cigate.ts latestRunPerName rule).
echo '{"statuses": []}' >"$STATUSES"
for ((page = 1; page <= 10; page++)); do
  get "/repos/$REPO/commits/$HEAD_SHA/status?per_page=100&page=$page"
  n="$(python3 -c '
import json, sys
acc = json.load(open(sys.argv[1]))
page_doc = json.load(open(sys.argv[2]))
rows = page_doc.get("statuses") if isinstance(page_doc, dict) else None
if not isinstance(rows, list):
    raise SystemExit("statuses page has no statuses list")
acc["statuses"] += rows
json.dump(acc, open(sys.argv[1], "w"))
print(len(rows))' "$STATUSES" "$OUT")" || die "statuses page $page unreadable"
  if ((n < 100)); then break; fi
done
((n < 100)) || die "incomplete statuses: page limit reached"

python3 - "$RUNS" "$FAILING" "$STATUSES" "$WORKFLOWS" "$HEAD_SHA" <<'PY'
import json, re, sys
runs = json.load(open(sys.argv[1])).get("check_runs", [])
statuses = json.load(open(sys.argv[3])).get("statuses", [])
workflows = json.load(open(sys.argv[4])).get("workflow_runs", [])
head_sha = sys.argv[5].lower()
# Superseded workflow runs (mirrors packages/pi-plugin/src/cigate.ts
# supersededSuites): runs group by workflow AND event; the newest of a group
# (latest created_at, then higher id) supersedes the others only once it has
# completed with `success` and its own check-runs are in the read, and only an
# older run that concluded `cancelled` is superseded.
present = set(
    (c.get("check_suite") or {}).get("id")
    for c in runs
    if isinstance((c.get("check_suite") or {}).get("id"), int)
)
wf = [
    w for w in workflows
    if isinstance(w, dict) and isinstance(w.get("id"), int) and isinstance(w.get("workflow_id"), int)
    and isinstance(w.get("created_at"), str)
    and (not isinstance(w.get("head_sha"), str) or w["head_sha"].lower() == head_sha)
]
newest = {}
for w in wf:
    k = (w["workflow_id"], w.get("event") or "")
    p = newest.get(k)
    if p is None or (w["created_at"], w["id"]) > (p["created_at"], p["id"]):
        newest[k] = w
superseded = {}
for w in wf:
    top = newest[(w["workflow_id"], w.get("event") or "")]
    if top is w or not isinstance(w.get("check_suite_id"), int):
        continue
    if (top.get("status") or "").lower() != "completed" or (w.get("status") or "").lower() != "completed":
        continue
    if (top.get("conclusion") or "").lower() != "success" or top.get("check_suite_id") not in present:
        continue
    if (w.get("conclusion") or "").lower() != "cancelled":
        continue
    superseded[w["check_suite_id"]] = top["id"]
def husk(c):
    suite = (c.get("check_suite") or {}).get("id")
    return isinstance(suite, int) and suite in superseded
# Latest-run-per-name (mirrors packages/pi-plugin/src/cigate.ts latestRunPerName, where the rule
# is stated exactly): GitHub auto-cancels superseded runs, so only the most
# recent run of each check name counts.
# Recency collapses ONLY runs that carry a started_at (latest wins, an equal
# start resolves to the later list position); a run WITHOUT one never competes
# with a timestamped one — it is kept beside it and counts on its own, the last
# such per name. Superseded husks are shown, marked, and excluded from the tally.
timed, untimed = {}, {}
for c in runs:
    if husk(c):
        continue
    key = c.get("name") or "check"
    at = c.get("started_at") or None
    if at is None:
        untimed[key] = c
    elif key not in timed or at >= timed[key].get("started_at"):
        timed[key] = c
latest = list(timed.values()) + list(untimed.values())
current = set(id(c) for c in latest)
passed = failed = pending = 0
for c in runs:
    concl = c.get("conclusion")
    state = f"{c['status']}/{concl or '-'}"
    dropped = id(c) not in current
    tag = (
        f"  [superseded run — run {superseded[c['check_suite']['id']]} replaced it; does not count]"
        if husk(c)
        else "  [superseded — does not count]" if dropped else ""
    )
    print(f"{c['name']}: {state}  {c.get('html_url') or '-'}{tag}")
    if dropped:
        continue
    if c["status"] != "completed":
        pending += 1
    elif concl in ("success", "neutral", "skipped"):
        passed += 1
    else:
        failed += 1
        # For --why: the check-run id, the Actions job id when it is one, the name,
        # and what the check reported about itself.
        m = re.search(r"/job/(\d+)", c.get("details_url") or c.get("html_url") or "")
        with open(sys.argv[2], "a") as fh:
            fh.write(f"{c['id']}\t{m.group(1) if m else '-'}\t{c['name']}\n")
        out = c.get("output") or {}
        with open(sys.argv[2] + ".output", "a") as fh:
            fh.write(json.dumps({"id": c["id"], "title": out.get("title"), "summary": out.get("summary"), "text": out.get("text")}) + "\n")
for s in statuses:
    st = s.get("state") or ""
    desc = (s.get("description") or "").strip()
    print(f"status {s.get('context') or 'status'}: {st or '-'}  {s.get('target_url') or '-'}" + (f"  ({desc[:200]})" if desc else ""))
    if st == "pending":
        pending += 1
    elif st == "success":
        passed += 1
    else:
        failed += 1
print(f"SUMMARY: {passed} passed / {failed} failed / {pending} pending (latest run per check only)")
# The one line the Decide step reads. Same table as the daemon gate + guards.sh:
# check-runs (latest per name) and commit statuses (each its own check). A
# failure decides red even while another check still runs — packages/pi-plugin/src/cigate.ts
# classifyCi and guards.sh's jq both put red first.
if not latest and not statuses:
    print("CLASSIFIED: none")
elif failed:
    print("CLASSIFIED: red")
elif pending:
    print("CLASSIFIED: pending")
else:
    succeeded = any((c.get("conclusion") == "success") for c in latest) or any(
        (s.get("state") == "success") for s in statuses
    )
    print("CLASSIFIED: green" if succeeded else "CLASSIFIED: red")
PY

[[ "$WHY" == 1 && -s "$FAILING" ]] || exit 0
echo
echo "WHY — what CI reported for each failing check (read it; tie each failure to the changed lines):"
while IFS=$'\t' read -r id job name; do
  echo
  echo "=== $name (check-run $id)"
  python3 - "$FAILING.output" "$id" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    o = json.loads(line)
    if str(o["id"]) != sys.argv[2]:
        continue
    for k in ("title", "summary", "text"):
        v = (o.get(k) or "").strip()
        if v:
            print(f"{k}: {v[:1500]}{' …' if len(v) > 1500 else ''}")
PY
  if (get "/repos/$REPO/check-runs/$id/annotations?per_page=50") 2>/dev/null; then
    python3 - "$OUT" <<'PY'
import json, sys
anns = json.load(open(sys.argv[1]))
for a in anns[:30]:
    print(f"annotation {a.get('path')}:{a.get('start_line')} [{a.get('annotation_level')}] {(a.get('title') or '').strip()} {(a.get('message') or '').strip()[:400]}")
if len(anns) > 30:
    print(f"(+{len(anns) - 30} more annotations)")
PY
  else
    echo "annotations: not readable"
  fi
  if [[ "$job" != "-" ]]; then
    # The log endpoint redirects to storage; curl drops the Authorization
    # header on the cross-host redirect by default, which is what storage wants.
    if [[ "$VIA_DAEMON" == 1 ]]; then
      code="$(node "$GHREAD" get "/repos/$REPO/actions/jobs/$job/logs" "$OUT" 2>/dev/null || echo 000)"
    else
      code="$(curl -sS -L -o "$OUT" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" "$API/repos/$REPO/actions/jobs/$job/logs" 2>/dev/null || echo 000)"
    fi
    if [[ "$code" == "200" ]]; then
      echo "log tail (last 60 lines):"
      sed -e 's/^[0-9-]*T[0-9:.]*Z //' "$OUT" | tail -n 60
    else
      echo "log: not readable (HTTP $code) — the App may lack Actions: read"
    fi
  fi
done < "$FAILING"

