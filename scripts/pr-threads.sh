#!/usr/bin/env bash
# pr-threads.sh — unresolved review threads on a PR, read-only.
#
# One GraphQL query; per unresolved thread prints the thread id, isOutdated,
# path:line, then every comment as `author: <first 400 chars>` plus the
# comment's databaseId (the id reply-thread.sh takes).
# Read-only: no gate involvement; token via scripts/mint-token.sh only.
#
# Usage: pr-threads.sh <pr-number>

set -euo pipefail

API="${GITHUB_API:-https://api.github.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The install locator decides: $QCR_CONFIG, else the install's config home.
# Never a path built here.
. "$ROOT/scripts/install-locator.sh"
CONFIG="$(qcr_locate_config "$ROOT")" || exit 1

die() { echo "pr-threads: $*" >&2; exit 1; }

PR="${1:-}"
[[ "$PR" =~ ^[0-9]+$ ]] || die "usage: pr-threads.sh <pr-number>"

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
    reviewThreads(first:100){nodes{id isResolved isOutdated path line
      comments(first:50){nodes{databaseId author{login} body}}}}}}}'

REQ="$(GQL="$GQL" OWNER="$OWNER" NAME="$NAME" PR="$PR" python3 -c 'import json,os,sys
json.dump({"query": os.environ["GQL"], "variables": {"owner": os.environ["OWNER"],
  "name": os.environ["NAME"], "number": int(os.environ["PR"])}}, sys.stdout)')"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
status="$(curl -sS -o "$OUT" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$REQ" "$API/graphql")"
[[ "$status" == "200" ]] || die "graphql -> $status: $(head -c 300 "$OUT")"

python3 - "$OUT" "$PR" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if d.get("errors"):
    raise SystemExit("pr-threads: graphql errors: " + json.dumps(d["errors"])[:300])
pr = d["data"]["repository"]["pullRequest"]
if pr is None:
    raise SystemExit(f"pr-threads: no such PR #{sys.argv[2]}")
threads = [t for t in pr["reviewThreads"]["nodes"] if not t["isResolved"]]
if not threads:
    print(f"no unresolved review threads on #{sys.argv[2]}")
for t in threads:
    loc = f"{t.get('path') or '?'}:{t.get('line') or '?'}"
    print(f"== {t['id']}  outdated={str(t['isOutdated']).lower()}  {loc}")
    for c in t["comments"]["nodes"]:
        author = (c.get("author") or {}).get("login", "?")
        body = " ".join((c.get("body") or "").split())[:400]
        print(f"[{c.get('databaseId')}] {author}: {body}")
PY
