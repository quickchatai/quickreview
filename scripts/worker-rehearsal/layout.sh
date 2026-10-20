#!/usr/bin/env bash
# Lay out a LEGACY-SHAPED host directory for the worker rehearsal (P8.20a): what the VM's
# /opt/quickreview looks like the moment before the cutover, in the shape deploy/qcr-update.sh's
# run spec mounts.
#
#   scripts/worker-rehearsal/layout.sh <host-dir> <tls-dir>
#
#   <host>/state/state.db         a state db at the pre-cutover schema (legacy-db.sh), drained
#   <host>/state/pi-sessions/     the P8.4 snapshot's shape: PR 7's legacy interactive-pi JSONL,
#                                 its header cwd the LEGACY sandbox root, where the legacy tmux session ran
#   <host>/sandbox/{wt,archive,commands,digest,inject,verdict,base-clone}
#                                 the legacy mounts; base-clone is the base clone (github.clone_dir), its origin
#                                 a local bare repo (the fixture's "GitHub", for git only)
#   <host>/pihome/agent/          a far-future FAKE login, and models.json pointing pi's `local`
#                                 provider at the scripted stub (no code hook, no real provider)
#   <host>/config-home/           config.toml (dry_run = true) for the new world
#   <host>/secrets/               a generated App key, ids and OpenViking keys; nothing real
#   <host>/memory-state/          the sidecar's store, empty
#   <host>/fixture.json           the facts the stub and the checks share
#
# Everything is owned by the invoking uid; the rehearsal runs the containers as that uid.
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
H="$(mkdir -p "${1:?usage: layout.sh <host-dir> <tls-dir>}" && cd "$1" && pwd)"
TLS="$(mkdir -p "${2:?usage: layout.sh <host-dir> <tls-dir>}" && cd "$2" && pwd)"

REPO="example-org/example-app"
PR=7
LEGACY_ROOT=/opt/quickreview/sandbox
git_id=(-c user.email=rehearsal@example.test -c user.name=rehearsal -c init.defaultBranch=master)

# state/findings and state/ledgers: the legacy bot's state carried both (a round writes its findings record and
# ledger-pin mirrors the ledger there)
mkdir -p "$H"/{state/pi-sessions/pr-$PR,state/findings,state/ledgers,secrets,config-home,memory-state,pihome/agent}
mkdir -p "$H"/sandbox/{wt,archive,commands,digest,inject,verdict}
chmod 0755 "$H" "$H/sandbox" "$H"/sandbox/*

# ---- the fixture repository ---------------------------------------------------------------------
W="$H/fixture-work"
rm -rf "$W" "$H/remote.git" "$H/sandbox/base-clone"
git "${git_id[@]}" init -q "$W"
mkdir -p "$W/src"
printf 'export function handle(req: string): string {\n  return req;\n}\n' >"$W/src/app.ts"
git -C "$W" "${git_id[@]}" add . && git -C "$W" "${git_id[@]}" commit -qm "base"
BASE_SHA="$(git -C "$W" rev-parse HEAD)"
git -C "$W" "${git_id[@]}" checkout -qb feat/rate-limit
printf 'export function handle(req: string): string {\n  for (;;) { try { return call(req); } catch {} }\n}\nfunction call(r: string): string { return r; }\n' >"$W/src/app.ts"
git -C "$W" "${git_id[@]}" commit -qam "Add rate limiting"
HEAD_SHA="$(git -C "$W" rev-parse HEAD)"
# More commits on the branch: the "pushes" the later scenarios make (each is a new head).
HEADS=("$HEAD_SHA")
for n in 2 3 4 5; do
  printf '// revision %s\n' "$n" >>"$W/src/app.ts"
  git -C "$W" "${git_id[@]}" commit -qam "Revision $n"
  HEADS+=("$(git -C "$W" rev-parse HEAD)")
done
git clone -q --bare "$W" "$H/remote.git"
git -C "$H/remote.git" update-ref "refs/pull/$PR/head" "$HEAD_SHA"
for i in 1 2 3 4; do git -C "$H/remote.git" update-ref "refs/rehearsal/head$((i + 1))" "${HEADS[$i]}"; done
git -C "$H/remote.git" update-ref "refs/heads/master" "$BASE_SHA"
git -C "$H/remote.git" symbolic-ref HEAD refs/heads/master
git -C "$H/remote.git" update-ref -d refs/heads/feat/rate-limit
# The base clone: origin is the in-container path of the bare repo (mounted at /rehearsal/remote.git).
git clone -q "$H/remote.git" "$H/sandbox/base-clone"
git -C "$H/sandbox/base-clone" remote set-url origin /rehearsal/remote.git
rm -rf "$W"
chmod -R a+rX "$H/remote.git" "$H/sandbox/base-clone"

cat >"$H/fixture.json" <<JSON
{"repo":"$REPO","pr":$PR,"title":"Add rate limiting","author":"alice","app_slug":"example-review",
 "trigger_label":"AI review requested","head_sha":"$HEAD_SHA","heads":["${HEADS[0]}","${HEADS[1]}","${HEADS[2]}","${HEADS[3]}","${HEADS[4]}"],"base_sha":"$BASE_SHA",
 "files":[{"filename":"src/app.ts","additions":3,"deletions":1,"changes":4,"status":"modified","sha":"$HEAD_SHA"}]}
JSON

# ---- the legacy state db and the P8.4-shaped JSONL snapshot --------------------------------------------
"$HERE/legacy-db.sh" "$H/state/state.db" >&2
SID="rh-legacy-$(printf '%s' "$HEAD_SHA" | cut -c1-8)"
sed -e "s#{ROOT}#$LEGACY_ROOT#g" -e "s#5409#$PR#g" -e "s#fx-live-golden#$SID#" \
  "$ROOT/tests/fixtures/live-events/pr-session.jsonl" >"$H/state/pi-sessions/pr-$PR/2026-10-18T10-00-00-000Z_$SID.jsonl"
# the header's cwd is what the legacy tmux session ran in: the legacy sandbox root
node -e '
  const fs = require("fs"); const f = process.argv[1];
  const ls = fs.readFileSync(f, "utf8").split("\n");
  const h = JSON.parse(ls[0]); h.cwd = process.argv[2];
  ls[0] = JSON.stringify(h); fs.writeFileSync(f, ls.join("\n"));
' "$H/state/pi-sessions/pr-$PR/"*.jsonl "$LEGACY_ROOT"
mkdir -p "$H/sandbox/wt/pr-$PR"

# ---- secrets: generated, nothing real -----------------------------------------------------------------
[[ -f "$H/secrets/app.pem" ]] || openssl genrsa -out "$H/secrets/app.pem" 2048 2>/dev/null
printf '1\n' >"$H/secrets/app_id"
printf 'rehearsal-webhook-secret\n' >"$H/secrets/webhook_secret"
for k in openviking_root_key openviking_reviewer_key openviking_companion_key; do
  [[ -f "$H/secrets/$k" ]] || openssl rand -hex 24 >"$H/secrets/$k"
done
chmod 0600 "$H"/secrets/*

# ---- the TLS identity of the stub's api.github.com ---------------------------------------------------------
if [[ ! -f "$TLS/ca.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS/ca.key" -out "$TLS/ca.pem" -days 30 -subj "/CN=rehearsal-ca" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout "$TLS/leaf.key" -out "$TLS/leaf.csr" -subj "/CN=api.github.com" 2>/dev/null
  printf 'subjectAltName=DNS:api.github.com,DNS:github.com,DNS:auth.openai.com\n' >"$TLS/ext.cnf"
  openssl x509 -req -in "$TLS/leaf.csr" -CA "$TLS/ca.pem" -CAkey "$TLS/ca.key" -CAcreateserial -out "$TLS/leaf.crt" -days 30 -extfile "$TLS/ext.cnf" 2>/dev/null
  chmod a+r "$TLS"/*
fi

# ---- pi's home: a far-future FAKE login, and the `local` provider on the stub ------------------------------------
EXPIRES=$(( ($(date +%s) + 10 * 365 * 86400) * 1000 ))
cat >"$H/pihome/agent/auth.json" <<JSON
{"openai-codex":{"type":"oauth","access":"rehearsal-access-token","refresh":"rehearsal-refresh-token","expires":$EXPIRES}}
JSON
cat >"$H/pihome/agent/models.json" <<'JSON'
{"providers":{"local":{"baseUrl":"http://stub:8080/v1","api":"openai-completions","apiKey":"not-a-key",
 "models":[{"id":"m","name":"m","reasoning":false,"input":["text"],"cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0},"contextWindow":32000,"maxTokens":4000}]}}}
JSON
chmod 0600 "$H/pihome/agent/auth.json"

# ---- config.toml for the new world -------------------------------------------------------------------------------
CFG="$H/config-home/config.toml"
cp "$ROOT/config.example.toml" "$CFG"
node "$HERE/patch-toml.mjs" "$CFG" \
  'dry_run=true' \
  'ops.timezone="UTC"' \
  "github.repo=\"$REPO\"" 'github.app_slug="example-review"' 'github.bot_login="example-review[bot]"' \
  'github.review_team="example-org/reviewers"' 'github.base_branch="master"' 'github.clone_dir="base-clone"' \
  'owner.name="Rehearsal"' 'owner.github_login="alice"' \
  'openviking.endpoint="remote"' 'openviking.host="quickreview-memory"' 'openviking.port=1933' \
  'models.default="local/m"' 'models.conversation="local/m"' 'models.overseer="local/m"' \
  'models.tiers."terra-med"="local/m"' 'models.tiers."sol-med"="local/m"' 'models.tiers."sol-high"="local/m"' \
  'daemon.poll_interval_s=30' 'daemon.lens_permits=20' \
  'login_refresh.enabled=true'
echo "host dir laid out at $H (head $HEAD_SHA, base $BASE_SHA)" >&2
