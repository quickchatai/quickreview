#!/usr/bin/env bash
# pr-checks.sh — compact read-only CI status for a PR.
#
# One line per check run (name, status/conclusion, url) plus a final
#   SUMMARY: n passed / n failed / n pending
# REST only: GET /pulls/{n} for the head sha, then /commits/{sha}/check-runs.
# Read-only: no gate involvement; token via scripts/mint-token.sh only.
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
# the install locator decides — $QCR_CONFIG, the install's config
# home, then (legacy) the checkout. Never a path built here.
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
TOKEN="$("$ROOT/scripts/mint-token.sh")"

get() { # get <path>  → body in $OUT, dies on non-200
  local status
  status="$(curl -sS -o "$OUT" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$API$1")"
  [[ "$status" == "200" ]] || die "GET $1 -> $status: $(head -c 300 "$OUT")"
}

OUT="$(mktemp)"
FAILING="$(mktemp)"
trap 'rm -f "$OUT" "$FAILING" "$FAILING.output"' EXIT

get "/repos/$REPO/pulls/$PR"
HEAD_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["head"]["sha"])' "$OUT")"

get "/repos/$REPO/commits/$HEAD_SHA/check-runs?per_page=100"

python3 - "$OUT" "$FAILING" <<'PY'
import json, re, sys
runs = json.load(open(sys.argv[1])).get("check_runs", [])
# Latest-run-per-name (the owner, 2026-08-19; mirrors src/cigate.ts
# latestRunPerName, rule stated exactly there): GitHub auto-cancels
# superseded runs — only the most recent run of each check name counts.
# Recency collapses ONLY runs that carry a started_at (latest wins, an equal
# start resolves to the later list position); a run WITHOUT one never competes
# with a timestamped one — it is kept beside it and counts on its own, the last
# such per name. Superseded husks are shown, marked, and excluded from the tally.
timed, untimed = {}, {}
for c in runs:
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
    superseded = id(c) not in current
    tag = "  [superseded — does not count]" if superseded else ""
    print(f"{c['name']}: {state}  {c.get('html_url') or '-'}{tag}")
    if superseded:
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
print(f"SUMMARY: {passed} passed / {failed} failed / {pending} pending (latest run per check only)")
# The one line the Decide step reads. Same table as the daemon gate + guards.sh.
if not latest:
    print("CLASSIFIED: none")
elif pending:
    print("CLASSIFIED: pending")
elif failed:
    print("CLASSIFIED: red")
else:
    succeeded = any((c.get("conclusion") == "success") for c in latest)
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
    code="$(curl -sS -L -o "$OUT" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" "$API/repos/$REPO/actions/jobs/$job/logs" 2>/dev/null || echo 000)"
    if [[ "$code" == "200" ]]; then
      echo "log tail (last 60 lines):"
      sed -e 's/^[0-9-]*T[0-9:.]*Z //' "$OUT" | tail -n 60
    else
      echo "log: not readable (HTTP $code) — the App may lack Actions: read"
    fi
  fi
done < "$FAILING"

