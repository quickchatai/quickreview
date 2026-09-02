#!/usr/bin/env bash
# pr-checks.sh — compact read-only CI status for a PR.
#
# One line per check run (name, status/conclusion, url) plus a final
#   SUMMARY: n passed / n failed / n pending
# REST only: GET /pulls/{n} for the head sha, then /commits/{sha}/check-runs.
# Read-only: no gate involvement; token via scripts/mint-token.sh only.
#
# Usage: pr-checks.sh <pr-number>

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${QCR_CONFIG:-$ROOT/config.toml}"

die() { echo "pr-checks: $*" >&2; exit 1; }

PR="${1:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "usage: pr-checks.sh <pr-number>"

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
trap 'rm -f "$OUT"' EXIT

get "/repos/$REPO/pulls/$PR"
HEAD_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["head"]["sha"])' "$OUT")"

get "/repos/$REPO/commits/$HEAD_SHA/check-runs?per_page=100"

python3 - "$OUT" <<'PY'
import json, sys
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
