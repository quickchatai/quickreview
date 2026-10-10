#!/usr/bin/env bash
# pr-context.sh — one-shot read-only PR bundle for pi review sessions.
#
# Prints labeled plain-text sections: META, FILES, CHECKS, REVIEWS, THREADS
# (unresolved only, last 2 comments each). One GraphQL query covers everything
# except check runs, which come from REST (/commits/{sha}/check-runs).
# Read-only: no gate involvement; token via scripts/mint-token.sh only.
#
# Usage: pr-context.sh <pr-number>

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides: $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1

die() { echo "pr-context: $*" >&2; exit 1; }

PR="${1:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "usage: pr-context.sh <pr-number>"

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
OWNER="${REPO%%/*}"; NAME="${REPO##*/}"
TOKEN="$("$ROOT/scripts/mint-token.sh")"

GQL='query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    title state headRefOid baseRefName author{login}
    files(first:100){nodes{path additions deletions}}
    reviews(last:10){nodes{author{login} state submittedAt}}
    reviewThreads(first:100){nodes{id isResolved isOutdated path line
      comments(last:2){nodes{author{login} body}}}}}}}'

REQ="$(GQL="$GQL" OWNER="$OWNER" NAME="$NAME" PR="$PR" python3 -c 'import json,os,sys
json.dump({"query": os.environ["GQL"], "variables": {"owner": os.environ["OWNER"],
  "name": os.environ["NAME"], "number": int(os.environ["PR"])}}, sys.stdout)')"

OUT="$(mktemp)"; CHK="$(mktemp)"
trap 'rm -f "$OUT" "$CHK"' EXIT
status="$(curl -sS -o "$OUT" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$REQ" "$API/graphql")"
[[ "$status" == "200" ]] || die "graphql -> $status: $(head -c 300 "$OUT")"

HEAD_SHA="$(python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
if d.get("errors"): raise SystemExit("graphql errors: " + json.dumps(d["errors"])[:300])
print(d["data"]["repository"]["pullRequest"]["headRefOid"])' "$OUT")" || die "no such PR #$PR"

status="$(curl -sS -o "$CHK" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$API/repos/$REPO/commits/$HEAD_SHA/check-runs?per_page=100")"
[[ "$status" == "200" ]] || die "check-runs -> $status: $(head -c 300 "$CHK")"

python3 - "$OUT" "$CHK" "$PR" <<'PY'
import json, sys
pr = json.load(open(sys.argv[1]))["data"]["repository"]["pullRequest"]
checks = json.load(open(sys.argv[2])).get("check_runs", [])
n = sys.argv[3]
who = lambda o: (o or {}).get("login", "?")
print(f"== META #{n} ==")
print(f"title: {pr['title']}")
print(f"author: {who(pr['author'])}  state: {pr['state']}")
print(f"head: {pr['headRefOid']}  base: {pr['baseRefName']}")
print("\n== FILES ==")
for f in pr["files"]["nodes"]:
    print(f"+{f['additions']} -{f['deletions']}  {f['path']}")
print("\n== CHECKS ==")
for c in checks:
    print(f"{c['name']}: {c['status']}/{c.get('conclusion') or '-'}")
print("\n== REVIEWS (latest) ==")
for r in pr["reviews"]["nodes"]:
    print(f"{who(r['author'])}: {r['state']}  {r.get('submittedAt') or '-'}")
print("\n== THREADS (unresolved) ==")
for t in pr["reviewThreads"]["nodes"]:
    if t["isResolved"]:
        continue
    loc = f"{t.get('path') or '?'}:{t.get('line') or '?'}"
    print(f"-- {t['id']}  outdated={str(t['isOutdated']).lower()}  {loc}")
    for c in t["comments"]["nodes"]:
        body = " ".join((c.get("body") or "").split())[:400]
        print(f"   {who(c['author'])}: {body}")
PY
