#!/usr/bin/env bash
# pr-threads.sh — unresolved review threads on a PR, read-only.
#
# GraphQL over every page of review threads; per unresolved thread prints the
# thread id, isOutdated, path:line, then every comment as
# `author: <first 400 chars>` plus the comment's databaseId (the id
# reply-thread.sh takes).
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

# Review threads are paged (100 a page, every page read, up to MAX_PAGES); a
# thread's comments are read up to 100, and a thread holding more says how many
# it left out — a partial read is never printed as the whole discussion.
GQL='query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line
        comments(first:100){totalCount nodes{databaseId author{login} body}}}}}}}'
MAX_PAGES=20

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AFTER=""
page=0
truncated=0
while :; do
  page=$((page + 1))
  OUT="$TMP/page-$(printf '%03d' "$page").json"
  REQ="$(GQL="$GQL" OWNER="$OWNER" NAME="$NAME" PR="$PR" AFTER="$AFTER" python3 -c 'import json,os,sys
json.dump({"query": os.environ["GQL"], "variables": {"owner": os.environ["OWNER"],
  "name": os.environ["NAME"], "number": int(os.environ["PR"]),
  "after": os.environ["AFTER"] or None}}, sys.stdout)')"
  status="$(curl -sS -o "$OUT" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$REQ" "$API/graphql")"
  [[ "$status" == "200" ]] || die "graphql -> $status: $(head -c 300 "$OUT")"
  # Prints the next cursor, or nothing on the last page; exits non-zero on an error.
  AFTER="$(python3 - "$OUT" "$PR" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if d.get("errors"):
    raise SystemExit("pr-threads: graphql errors: " + json.dumps(d["errors"])[:300])
pr = d["data"]["repository"]["pullRequest"]
if pr is None:
    raise SystemExit(f"pr-threads: no such PR #{sys.argv[2]}")
info = pr["reviewThreads"].get("pageInfo") or {}
if info.get("hasNextPage"):
    cursor = info.get("endCursor")
    if not cursor:
        raise SystemExit("pr-threads: graphql reported a next page without a cursor")
    print(cursor)
PY
)"
  [[ -n "$AFTER" ]] || break
  if (( page >= MAX_PAGES )); then truncated=1; break; fi
done

python3 - "$PR" "$truncated" "$TMP"/page-*.json <<'PY'
import json, sys
pr_no, truncated, pages = sys.argv[1], sys.argv[2] == "1", sys.argv[3:]
nodes = []
for p in pages:
    nodes += json.load(open(p))["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
threads = [t for t in nodes if not t["isResolved"]]
if truncated:
    print(f"INCOMPLETE: #{pr_no} has more review threads than the {len(nodes)} read;"
          " the list below is partial")
if not threads:
    if truncated:
        print(f"no unresolved review threads among the {len(nodes)} read on #{pr_no}")
    else:
        print(f"no unresolved review threads on #{pr_no}")
for t in threads:
    loc = f"{t.get('path') or '?'}:{t.get('line') or '?'}"
    print(f"== {t['id']}  outdated={str(t['isOutdated']).lower()}  {loc}")
    comments = t["comments"]["nodes"]
    for c in comments:
        author = (c.get("author") or {}).get("login", "?")
        body = " ".join((c.get("body") or "").split())[:400]
        print(f"[{c.get('databaseId')}] {author}: {body}")
    total = t["comments"].get("totalCount") or 0
    if total > len(comments):
        print(f"... {total - len(comments)} later comment(s) on this thread not shown")
PY
