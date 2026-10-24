#!/usr/bin/env bash
# worker-rehearsal.sh — the pre-deletion worker rehearsal, the run that writes
# docs/worker-rehearsal.md. It is the worker half of the cutover rehearsal: HEAD's release and
# memory images, run with the cutover run spec's volumes and command over a LEGACY-SHAPED host
# directory, with a scripted stub as the model and as GitHub, on a network that has no way out.
#
#   scripts/worker-rehearsal.sh [--out FILE] [--work DIR] [--reuse-images] [--keep] [--only IDS]
#
#   --out FILE        the report (default docs/worker-rehearsal.md; with --only, <work>/report.md)
#   --work DIR        the scratch directory (default /tmp/claude-$UID/worker-rehearsal-<pid>)
#   --reuse-images    use the images a previous run built (tags qcr-rehearsal/*:head) when they
#                     were built from a commit whose image inputs are HEAD's (only the rehearsal's
#                     own tooling, tests or docs differ); otherwise they are built (build-images.sh)
#   --keep            leave the containers, network and host directory up for a look
#   --adopt FILE      do not build, lay out or start anything: run the scenarios against the world the
#                     cutover rehearsal (scripts/cutover-rehearsal.sh) left standing, the release boot the
#                     real updater made. FILE is a shell file naming H, TLS, LOGS, OPERATOR_TOML,
#                     LEGACY_ORIGINAL and REL_IMG. The setup checks (IMG, NET, MEM, CFG, MIG, DRAIN) are
#                     the cutover rehearsal's; round 1 and the closing checks run as always.
#   --only IDS        run only these scenarios after the shared setup, comma-separated check ids
#                     (ANSWER-1,TAKEOVER-1,DEBUG-1,RESTART-1,BREAKER-1,LOGIN-1). The setup and its
#                     checks (IMG, NET, MEM, CFG, MIG, DRAIN), round 1 (WEBHOOK, RESUME, WAVE,
#                     PERMIT, POST) and the closing checks (BUSY, TREE, STATUS, NETCAP) always run:
#                     every scenario stands on round 1. A partial run is for iterating; the
#                     committed report comes from a full one.
#
# No model and no GitHub: the containers sit on a docker network created with --internal (no
# route out), the model is scripts/worker-rehearsal/stub.mjs, reached through pi's own
# models.json (`local` provider) with no code hook, and the stub also answers as
# api.github.com and auth.openai.com (network aliases, a throwaway CA the containers trust
# through the standard environment variables). The stub logs every request it serves; a
# request to anything else cannot leave the network and shows in the daemon's own log as a
# failed lookup. Both are in the report.
#
# Costs nothing; takes about 10 minutes with the images built (they take 15 more to build).
# Never touches a live bot, a registry or the VM. Exits 0 when every check passed.
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RH="$HERE/worker-rehearsal"
OUT="$ROOT/docs/worker-rehearsal.md"
WORK=""
REUSE=0
KEEP=0
ONLY=""
ADOPT=""
OUT_SET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; OUT_SET=1; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --reuse-images) REUSE=1; shift ;;
    --keep) KEEP=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --adopt) ADOPT="$2"; shift 2 ;;
    *) echo "usage: $0 [--out FILE] [--work DIR] [--reuse-images] [--keep] [--only IDS] [--adopt FILE]" >&2; exit 2 ;;
  esac
done
WORK="${WORK:-/tmp/claude-$(id -u)/worker-rehearsal-$$}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
[[ -n "$ONLY" && "$OUT_SET" == 0 ]] && OUT="$WORK/report.md"
# want <ID>: is this scenario part of the run?
want() { [[ -z "$ONLY" || ",$ONLY," == *",$1,"* ]]; }

# ---- names -------------------------------------------------------------------------------------
# The run spec's names (deploy/qcr-update.sh): the daemon, the sidecar and their network. The
# stub is the rehearsal's own.
DAEMON=quickreview-sandbox
MEMORY=quickreview-memory
STUB=qcr-rehearsal-stub
NET=qcr-rehearsal-net
REL_IMG=qcr-rehearsal/release:head
MEM_IMG=qcr-rehearsal/memory:head
APP_ROOT=/opt/qcr
LEGACY_ROOT=/opt/quickreview/sandbox
H="$WORK/host"
TLS="$WORK/tls"
LOGS="$WORK/logs"
RESULTS="$WORK/results.tsv"
FACTS="$WORK/facts.tsv"
UIDGID="$(id -u):$(id -g)"
PR=7
if [[ -n "$ADOPT" ]]; then
  # shellcheck disable=SC1090
  . "$ADOPT"
  KEEP=1
  cp "$OPERATOR_TOML" "$WORK/operator.toml"
  cp "$LEGACY_ORIGINAL" "$WORK/legacy-original.jsonl"
fi
: >"$RESULTS"; : >"$FACTS"
mkdir -p "$LOGS"

log() { echo "[rehearsal $(date +%H:%M:%S)] $*" >&2; }
die() { echo "[rehearsal] FATAL: $*" >&2; exit 1; }
tab() { printf '%s\t' "$@" | sed 's/\t$//'; }
# check <id> <pass|fail> <title> <detail>
check() {
  local detail; detail="$(printf '%s' "${4:-}" | tr '\n\t' '  ')"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$detail" >>"$RESULTS"
  if [[ "$2" == pass ]]; then log "PASS $1 $3"; else log "FAIL $1 $3 -- $detail"; fi
}
fact() { printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | tr '\n\t' '  ')" >>"$FACTS"; }

cleanup() {
  local rc=$?
  if [[ "$KEEP" == 1 ]]; then log "kept: containers $DAEMON $MEMORY $STUB, network $NET, work $WORK"; return; fi
  docker rm -f "$DAEMON" "$MEMORY" "$STUB" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  # The operator's command files are written as root (docker exec -u 0, the sealed channel),
  # so the host directory is removed the same way.
  docker run --rm -u 0 --entrypoint rm -v "$WORK:/w" "$REL_IMG" -rf /w/host /w/tls >/dev/null 2>&1 || rm -rf "$H" "$TLS"
  return $rc
}
trap cleanup EXIT

command -v docker >/dev/null && command -v sqlite3 >/dev/null && command -v openssl >/dev/null \
  && command -v python3 >/dev/null && command -v node >/dev/null || die "needs docker, sqlite3, openssl, python3 and node"
docker info >/dev/null 2>&1 || die "docker is not reachable"

# ---- helpers -----------------------------------------------------------------------------------
dx() { docker exec "$DAEMON" "$@"; }
sql() { sqlite3 -readonly -cmd '.timeout 5000' "$H/state/state.db" "$1" 2>/dev/null; }
stub_ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$STUB"; }
stub_post() { curl -fsS -XPOST -d "$2" "http://$(stub_ip):8080$1" >/dev/null; }
stub_mode() { stub_post /admin/mode "{\"mode\":\"$1\"${2:+,$2}}"; }
fx() { node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1]));const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],f);process.stdout.write(String(v))' "$H/fixture.json" "$1"; }
# the operator's qcr on the host (target = local: the same argv the VM route sends over ssh)
op() { QCR_CONFIG="$WORK/operator.toml" node "$ROOT/dist/src/cli.js" "$@"; }
now_ms() { date +%s%3N; }
# wait_for <seconds> <description> <command...>: poll until the command succeeds
wait_for() {
  local secs="$1" what="$2"; shift 2
  local end=$((SECONDS + secs))
  while ((SECONDS < end)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  log "timed out after ${secs}s waiting for: $what"
  return 1
}
# waitx <seconds> <description> <function> [args]: poll a shell function of this script
waitx() {
  local secs="$1" what="$2"; shift 2
  local end=$((SECONDS + secs))
  while ((SECONDS < end)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  log "timed out after ${secs}s waiting for: $what"
  return 1
}
hook() { # <event> <json>
  local body="$2" sig
  sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$(tr -d '\n' <"$H/secrets/webhook_secret")" | sed 's/^.* //')"
  printf '%s' "$body" | docker exec -i "$DAEMON" curl -sS -o /dev/null -w '%{http_code}' -XPOST http://127.0.0.1:8787/webhook \
    -H 'content-type: application/json' -H "x-github-event: $1" -H "x-github-delivery: rh-$(now_ms)" \
    -H "x-hub-signature-256: $sig" --data-binary @-
}
pr_event() { # <action> <head sha> [extra json fields]
  hook pull_request "{\"action\":\"$1\",${3:+$3,}\"pull_request\":{\"number\":$PR,\"title\":\"Add rate limiting\",\"head\":{\"sha\":\"$2\"},\"user\":{\"login\":\"alice\"}},\"sender\":{\"login\":\"alice\",\"type\":\"User\"}}"
}
push_head() { # <n> : the PR's head becomes the fixture's nth commit
  local sha; sha="$(fx "heads.$(($1 - 1))")"
  git -C "$H/remote.git" update-ref "refs/pull/$PR/head" "$sha"
  stub_post /admin/github "{\"head\":\"$sha\",\"triggered\":true}"
  echo "$sha"
}
round_status() { sql "select status from rounds where pr=$PR and round_no=$1"; }
# the round the next trigger starts (a scenario left out by --only does not shift the next one's)
next_round() { echo $(( $(sql "select coalesce(max(round_no),0) from rounds where pr=$PR") + 1 )); }
rounds_done() { [[ "$(round_status "$1")" == done ]]; }
answers_acked() { [[ "$(sql "select count(*) from session_commands where kind='answer' and status='acked'")" -ge "$1" ]]; }
round_running() { [[ "$(sql "select count(*) from session_commands where kind='round' and round_no=$1 and status='running'")" -ge 1 ]]; }
crash_loop_seen() { [[ "$(sql "select count(*) from events where kind='anomaly' and payload like '%worker_crash_loop%'")" -ge 1 ]]; }
round_spend_known() { [[ -n "$(sql "select est_usd from rounds where pr=$PR and round_no=$1 and est_usd is not null")" ]]; }
dryrun_reviews() { find "$H/state/dryrun" -name '*create_review.json' 2>/dev/null | wc -l; }
dryrun_replies() { find "$H/state/dryrun" -name '*create_review_comment_reply.json' 2>/dev/null | wc -l; }
events() { sql "select count(*) from events where kind='$1'"; }
# every pi / node process of the daemon container: pid ppid args
procs() { dx sh -c 'for p in /proc/[0-9]*; do [ -r $p/stat ] || continue; printf "%s %s %s\n" "${p#/proc/}" "$(cut -d" " -f4 $p/stat)" "$(tr "\0" " " <$p/cmdline | cut -c1-200)"; done 2>/dev/null'; }

# boots: how many times the daemon has booted (its worker recovery logs once per boot)
boots() { docker logs "$DAEMON" 2>&1 | grep -c 'workers: recovered'; }
# rebooted <n>: a boot after the first <n>, and a healthy reconcile after that boot's recovery
# (the logs of a restarted container keep the previous boot's lines: a window by time would
# match them)
rebooted() {
  [[ "$(boots)" -gt "$1" ]] && docker logs "$DAEMON" 2>&1 \
    | awk '/workers: recovered/ {ok = 0} /reconcile: open=.* errors=0/ {ok = 1} END {exit !ok}'
}
HEAD_SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
if [[ -z "$ADOPT" ]]; then
# ---- 0. the images --------------------------------------------------------------------------------
label_of() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }
# same_inputs <sha>: does that commit build the image HEAD builds? Only the rehearsal's own
# tooling, the tests and the docs may differ (none of them is an image input that runs).
same_inputs() {
  [[ -n "$1" ]] && git -C "$ROOT" cat-file -e "$1^{commit}" 2>/dev/null \
    && git -C "$ROOT" diff --quiet "$1" HEAD -- . ':(exclude)scripts/worker-rehearsal.sh' \
      ':(exclude)scripts/worker-rehearsal' ':(exclude)scripts/cutover-rehearsal.sh' ':(exclude)scripts/cutover-rehearsal' ':(exclude)scripts/deploy.sh' ':(exclude)scripts/cutover.sh' ':(exclude)tests' ':(exclude)docs'
}
IMG_SHA="$(label_of "$REL_IMG" qcr.build-sha)"
if [[ "$REUSE" == 1 ]] && same_inputs "$IMG_SHA" && docker image inspect "$MEM_IMG" >/dev/null 2>&1; then
  log "reusing the images built from $IMG_SHA (HEAD $HEAD_SHA builds the same image)"
else
  log "building the release and memory images from $HEAD_SHA"
  [[ -z "$(git -C "$ROOT" status --porcelain -- . ':(exclude)docs')" ]] || die "the image is built from HEAD: commit or drop the working tree's changes first"
  "$RH/build-images.sh" "$REL_IMG" "$MEM_IMG" >"$LOGS/build-images.log" 2>&1 || { tail -30 "$LOGS/build-images.log" >&2; die "the image build failed"; }
  IMG_SHA="$(label_of "$REL_IMG" qcr.build-sha)"
fi
fact release_image "$(docker image inspect -f '{{.Id}} {{.Size}}' "$REL_IMG")"
fact memory_image "$(docker image inspect -f '{{.Id}} {{.Size}}' "$MEM_IMG")"
fact build_sha "$IMG_SHA (HEAD $HEAD_SHA)"
fact runspec_label "$(label_of "$REL_IMG" qcr.runspec) layout=$(label_of "$REL_IMG" qcr.layout)"
if [[ "$(label_of "$REL_IMG" qcr.layout)" == release ]] && same_inputs "$IMG_SHA"; then
  SAME="HEAD itself"; [[ "$IMG_SHA" != "$HEAD_SHA" ]] && SAME="HEAD is $HEAD_SHA, which differs from it only in the rehearsal's own tooling, tests and docs"
  check IMG-1 pass "the release image is built from HEAD" "qcr.build-sha=$IMG_SHA ($SAME); qcr.layout=release qcr.runspec=$(label_of "$REL_IMG" qcr.runspec)"
else
  check IMG-1 fail "the release image is built from HEAD" "labels: sha=$IMG_SHA layout=$(label_of "$REL_IMG" qcr.layout); HEAD $HEAD_SHA"
fi
log "building the operator's CLI (dist) at HEAD"
(cd "$ROOT" && npx tsc -b packages/pi-plugin && npx tsc -p tsconfig.json --tsBuildInfoFile "/tmp/claude-$(id -u)/tsbi/rehearsal-op.tsbuildinfo" >"$LOGS/tsc.log" 2>&1 && node scripts/verify-dist.mjs >>"$LOGS/tsc.log" 2>&1) || { tail -20 "$LOGS/tsc.log" >&2; die "tsc failed"; }

# ---- 1. the host, the network, the stub -------------------------------------------------------------
log "laying out the legacy-shaped host directory"
"$RH/layout.sh" "$H" "$TLS" >"$LOGS/layout.log" 2>&1 || { tail -20 "$LOGS/layout.log" >&2; die "layout failed"; }
cp "$H/state/pi-sessions/pr-$PR/"*.jsonl "$WORK/legacy-original.jsonl"
fact legacy_jsonl "$(basename "$H"/state/pi-sessions/pr-$PR/*.jsonl) $(stat -c %s "$WORK/legacy-original.jsonl") bytes"
LEGACY_DRAINING="$(sqlite3 "$H/state/state.db" 'select draining from drain_state')"
LEGACY_TABLES="$(sqlite3 "$H/state/state.db" "select count(*) from sqlite_master where type='table'")"
cp "$H/state/state.db" "$WORK/legacy-state.db"
cp "$H/config-home/config.toml" "$WORK/operator.toml"
node "$RH/patch-toml.mjs" "$WORK/operator.toml" 'tui.target="local"' 'tui.sudo_docker=false' \
  "tui.container=\"$DAEMON\"" "tui.remote_state_dir=\"$APP_ROOT/state\"" "tui.remote_sandbox_root=\"$APP_ROOT\""

docker rm -f "$DAEMON" "$MEMORY" "$STUB" >/dev/null 2>&1
docker network rm "$NET" >/dev/null 2>&1
docker network create --internal "$NET" >/dev/null || die "no network"
: >"$LOGS/stub.jsonl"; chmod 666 "$LOGS/stub.jsonl"
docker run -d --name "$STUB" --network "$NET" --network-alias stub --network-alias api.github.com --network-alias auth.openai.com \
  -v "$RH/stub.mjs:/stub.mjs:ro" -v "$H/fixture.json:/fixture.json:ro" -v "$TLS:/tls:ro" -v "$LOGS:/logs" \
  node:26-bookworm-slim node /stub.mjs /fixture.json /tls /logs/stub.jsonl >/dev/null || die "stub did not start"
wait_for 20 "the stub" grep -q '"port":8080' "$LOGS/stub.jsonl" || die "the stub is not up"

# the network has no way out
INTERNAL="$(docker network inspect -f '{{.Internal}}' "$NET")"
EGRESS="$(docker run --rm --network "$NET" --entrypoint sh "$REL_IMG" -c 'curl -sS -m 5 -o /dev/null -w "%{http_code}" https://example.com 2>&1; echo " rc=$?"; getent hosts example.com >/dev/null 2>&1 && echo resolved || echo unresolved' 2>&1 | tr '\n' ' ')"
VIA_STUB="$(docker run --rm --network "$NET" -v "$TLS/ca.pem:/ca.pem:ro" --entrypoint sh "$REL_IMG" -c 'curl -sS -m 5 --cacert /ca.pem -o /dev/null -w "%{http_code}" https://api.github.com/app/installations' 2>&1)"
BLOCKED_OK=no; [[ "$EGRESS" == *"rc=6"* || "$EGRESS" == *"rc=28"* || "$EGRESS" == *"rc=7"* ]] && BLOCKED_OK=yes
if [[ "$INTERNAL" == true && "$BLOCKED_OK" == yes && "$VIA_STUB" == 200 ]]; then
  check NET-1 pass "the network is internal: example.com is unreachable, api.github.com is the stub" "internal=$INTERNAL; example.com: $EGRESS; api.github.com via the stub: HTTP $VIA_STUB"
else
  check NET-1 fail "the network is internal" "internal=$INTERNAL; example.com: $EGRESS; stub: $VIA_STUB"
fi

# ---- 2. the memory sidecar (the updater's step: seed, start, ready) -----------------------------------------
sidecar_args() {
  echo run -d --name "$MEMORY" --restart unless-stopped --init --cpus 1 --memory 3g --memory-swap 3g --user "$UIDGID" --network "$NET" \
    -v "$H/memory-state:/opt/quickreview/state/openviking" -v "$H/secrets:/opt/quickreview/secrets:ro" -v "$H/config-home:/opt/quickreview/config-home:ro" \
    -e TZ=UTC -e QCR_CONFIG=/opt/quickreview/config-home/config.toml \
    -e QCR_OPENVIKING_HOME=/opt/quickreview/state/openviking -e QCR_OPENVIKING_PORT=1933 -e QCR_OPENVIKING_BIND_HOST=0.0.0.0 \
    -e QCR_OPENVIKING_WORKERS=1 -e QCR_OPENVIKING_QUEUE_CONCURRENCY=2 -e QCR_OPENVIKING_AUTH_MODE=api_key \
    -e QCR_OPENVIKING_EMBEDDING_PROVIDER=local -e QCR_OPENVIKING_LOCAL_EMBEDDER_PORT=1934 -e QCR_OPENVIKING_LOCAL_EMBEDDER_THREADS=1 \
    -e QCR_OPENVIKING_PROVISION_USERS=reviewer,companion "$MEM_IMG"
}
mem_ready() { docker exec "$MEMORY" curl -fsS http://127.0.0.1:1933/ready; }
log "starting the memory sidecar"
# shellcheck disable=SC2046
docker $(sidecar_args) >/dev/null || die "sidecar did not start"
wait_for 240 "the sidecar's /ready" mem_ready || { docker logs --tail 40 "$MEMORY" >&2; die "the sidecar never became ready"; }
# The first boot created the users with keys of the server's own; the onboarding step reads the
# reviewer key back (mintUserKeys never rotates) into the secrets the daemon mounts. Then the
# sidecar restarts, as it does in the cutover, and this time the key authenticates.
read_reviewer_key() {
  docker exec "$MEMORY" sh -c 'cd /opt/qcr && node --input-type=module -e "
import { readFileSync } from \"node:fs\";
const m = await import(\"/opt/qcr/scripts/openviking-provision.mjs\");
const rootKey = readFileSync(\"/opt/quickreview/secrets/openviking_root_key\",\"utf8\").trim();
const r = await m.mintUserKeys({ base: \"http://127.0.0.1:1933\", account: \"default\", users: [\"reviewer\",\"companion\"], rootKey });
process.stdout.write(r.keys.reviewer ?? \"\");
"' >"$H/secrets/openviking_reviewer_key" 2>/dev/null && [[ -s "$H/secrets/openviking_reviewer_key" ]]
}
wait_for 90 "the sidecar's boot provisioning to create the users" read_reviewer_key
chmod 600 "$H/secrets/openviking_reviewer_key"
[[ -s "$H/secrets/openviking_reviewer_key" ]] || die "could not read the reviewer key back"
docker restart "$MEMORY" >/dev/null
wait_for 240 "the sidecar's /ready after the restart" mem_ready || die "the sidecar did not come back"
sleep 3
if docker logs --since 60s "$MEMORY" 2>&1 | grep -q "reviewer key does NOT authenticate"; then
  check MEM-1 fail "the memory sidecar is ready and the reviewer key authenticates" "the sidecar still refuses the reviewer key"
else
  check MEM-1 pass "the memory sidecar is ready and the reviewer key authenticates" "/ready after the seed boot and a restart; image $(docker image inspect -f '{{.Size}}' "$MEM_IMG") bytes"
fi

# the updater's config check, as it runs it (no network)
CHECK="$(docker run --rm --network none --user "$UIDGID" -v "$H/config-home:/cfg:ro" "$REL_IMG" config check --json --config-home /cfg 2>/dev/null | tail -1)"
if [[ "$CHECK" == *'"ok":true'* ]]; then check CFG-1 pass "the new image accepts the new world's config (qcr config check)" "$CHECK"; else check CFG-1 fail "config check" "$CHECK"; fi

# ---- 3. the daemon, with the run spec's volumes and command ----------------------------------------------------
cat >"$WORK/daemon.env" <<ENVF
NODE_EXTRA_CA_CERTS=/rehearsal/ca.pem
SSL_CERT_FILE=/rehearsal/ca.pem
CURL_CA_BUNDLE=/rehearsal/ca.pem
GIT_SSL_CAINFO=/rehearsal/ca.pem
ENVF
daemon_run() {
  # the run spec's tool-uid shape (deploy/qcr-update.sh): the image's setid helper's gate group
  # and the tool gid, SETUID/SETGID only, and the operator channel root's own before the start
  local gate tgid tuid
  gate="$(docker image inspect -f '{{index .Config.Labels "qcr.setid-gid"}}' "$REL_IMG")"
  tgid="$(docker image inspect -f '{{index .Config.Labels "qcr.tool-gid"}}' "$REL_IMG")"
  tuid="$(docker image inspect -f '{{index .Config.Labels "qcr.tool-uid"}}' "$REL_IMG")"
  docker run --rm -u 0 --network none --entrypoint sh -v "$H/sandbox/commands:/c" "$REL_IMG" \
    -c '[ ! -L /c/operator ] && mkdir -p /c/operator && chown -h 0:0 /c/operator && chmod 0755 /c/operator' ||
    die "could not seal the operator channel"
  docker run -d --name "$DAEMON" --restart unless-stopped --init --cpus 2 --memory 8g --memory-swap 8g --user "$UIDGID" --network "$NET" \
    --group-add "$gate" --group-add "$tgid" --cap-drop ALL --cap-add SETUID --cap-add SETGID -e "QCR_TOOLS_AS=$tuid" \
    -v "$H/state:$APP_ROOT/state" -v "$H/secrets:/opt/quickreview/secrets:ro" -v "$H/config-home:/opt/quickreview/config-home:ro" -v "$H/pihome:/home/qcr/.pi" \
    -v "$H/sandbox/wt:$APP_ROOT/wt" -v "$H/sandbox/archive:$APP_ROOT/archive" -v "$H/sandbox/commands:$APP_ROOT/commands" \
    -v "$H/sandbox/digest:$APP_ROOT/digest" -v "$H/sandbox/inject:$APP_ROOT/inject" -v "$H/sandbox/verdict:$APP_ROOT/verdict" \
    -v "$H/sandbox/base-clone:$APP_ROOT/base-clone" -v "$H/sandbox/pihome:$APP_ROOT/pihome" \
    -v "$H/sandbox/wt:$LEGACY_ROOT/wt" -v "$H/sandbox/base-clone:$LEGACY_ROOT/base-clone" \
    -v "$H/remote.git:/rehearsal/remote.git:ro" -v "$TLS/ca.pem:/rehearsal/ca.pem:ro" \
    -e TZ=UTC -e QC_REVIEW_PORT=8787 -e QC_BIND_HOST=0.0.0.0 -e QCR_CONFIG=/opt/quickreview/config-home/config.toml --env-file "$WORK/daemon.env" \
    "$REL_IMG" daemon
}
log "starting the daemon on the legacy host directory"
daemon_run >/dev/null || die "the daemon did not start"
daemon_up() { docker logs "$DAEMON" 2>&1 | grep -q "reconcile: open=.* errors=0"; }
wait_for 180 "the daemon's first healthy reconcile" daemon_up || { docker logs --tail 40 "$DAEMON" >&2; die "the daemon did not reconcile"; }
sleep 3

# ---- A. migrations, the drain, the legacy rows ------------------------------------------------------------------------
python3 - "$WORK/legacy-state.db" "$H/state/state.db" >"$WORK/schema-diff.txt" <<'PY'
import sqlite3, sys
old = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True); new = sqlite3.connect("file:%s?mode=ro" % sys.argv[2], uri=True)
def schema(c):
    out = {}
    for (t,) in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'"):
        out[t] = [r[1] for r in c.execute("pragma table_info(%s)" % t)]
    return out
a, b = schema(old), schema(new)
lost = [t for t in a if t not in b]
lostcols = ["%s.%s" % (t, c) for t in a if t in b for c in a[t] if c not in b[t]]
added = [t for t in b if t not in a]
addedcols = ["%s.%s" % (t, c) for t in b if t in a for c in b[t] if c not in a[t]]
print("legacy_tables=%d migrated_tables=%d" % (len(a), len(b)))
print("tables_added=%s" % ",".join(added) or "none")
print("columns_added=%s" % (",".join(addedcols) or "none"))
print("LOST=%s" % (",".join(lost + lostcols) or "none"))
PY
SCHEMA_LOST="$(grep '^LOST=' "$WORK/schema-diff.txt" | cut -d= -f2)"
LEGACY_ROW="$(sql "select count(*) from events where kind='legacy_fixture'")"
PR6="$(sql "select state from pr_state where number=6")"
if [[ "$SCHEMA_LOST" == none && "$LEGACY_ROW" == 1 && "$PR6" == closed ]]; then
  check MIG-1 pass "the migrations apply to the legacy state.db: nothing lost, the legacy rows kept" "$(tr '\n' ' ' <"$WORK/schema-diff.txt")legacy event and closed PR 6 survive"
else
  check MIG-1 fail "the migrations apply to the legacy state.db" "$(tr '\n' ' ' <"$WORK/schema-diff.txt") legacy_event=$LEGACY_ROW pr6=$PR6"
fi
fact schema_diff "$(tr '\n' ' ' <"$WORK/schema-diff.txt")"
# The release's first boot carries the drain the legacy bot left standing over as the
# operator's HOLD (state.ts migrateDrainHold): the first healthy reconcile keeps it, and only an
# explicit `qcr drain off` lifts it, which is the cutover's own order (scripts/cutover.sh). The
# lift goes through the sealed operator channel, as root, into commands/operator.
DRAIN_NOW="$(sql 'select draining from drain_state')"
HOLD_NOW="$(sql 'select hold from drain_state')"
CARRIED="$(events drain_hold_carried)"
ROUNDS_BEFORE_LIFT="$(sql 'select count(*) from rounds')"
op drain off >"$WORK/drain-off.txt" 2>&1
drained_off() { [[ "$(sql 'select draining from drain_state')" == 0 ]]; }
wait_for 60 "the operator's drain off" drained_off
DRAIN_AFTER="$(sql 'select draining from drain_state')"
if [[ "$LEGACY_DRAINING" == 1 && "$DRAIN_NOW" == 1 && "$HOLD_NOW" == 1 && "$CARRIED" -ge 1 && "$ROUNDS_BEFORE_LIFT" == 0 && "$DRAIN_AFTER" == 0 ]]; then
  check DRAIN-1 pass "the drain the legacy bot left standing is kept as the operator's hold, and the operator's drain off lifts it" "draining 1 -> 1 (hold, drain_hold_carried), no round started; qcr drain off -> draining 0"
else
  check DRAIN-1 fail "the legacy drain is carried as a hold and the operator lifts it" "legacy=$LEGACY_DRAINING now=$DRAIN_NOW hold=$HOLD_NOW carried=$CARRIED rounds=$ROUNDS_BEFORE_LIFT after_off=$DRAIN_AFTER ($(tr '\n' ' ' <"$WORK/drain-off.txt" | cut -c1-200))"
fi

fi # not adopted: the cutover rehearsal made this world

# ---- B/C. a signed webhook starts a round; the worker resumes the legacy session ------------------------------------------
log "triggering PR $PR with a signed webhook"
# round 1 also fires a burst of 24 parallel passes, each answered after 6 s, to put more lenses
# than the ceiling in front of the permit broker
stub_mode round '"burst":24,"burstMs":6000'
HEAD1="$(push_head 2)"
STUB_LINES_BEFORE="$(wc -l <"$LOGS/stub.jsonl")"
CODE="$(hook pull_request "{\"action\":\"labeled\",\"label\":{\"name\":\"AI review requested\"},\"pull_request\":{\"number\":$PR,\"title\":\"Add rate limiting\",\"head\":{\"sha\":\"$HEAD1\"},\"user\":{\"login\":\"alice\"}},\"sender\":{\"login\":\"alice\",\"type\":\"User\"}}")"
if wait_for 240 "round 1 to settle" rounds_done 1; then
  waitx 60 "the round's spend" round_spend_known 1
  check WEBHOOK-1 pass "a signed fake webhook starts a round, and a worker runs it" "webhook HTTP $CODE; round 1 done; worker_spawned=$(events worker_spawned); verdict $(sql "select verdict from rounds where pr=$PR and round_no=1")"
else
  check WEBHOOK-1 fail "a signed fake webhook starts a round" "webhook HTTP $CODE; round 1 status '$(round_status 1)'"
fi
SPAWN="$(sql "select payload from events where kind='worker_spawned' order by id limit 1")"
fact first_worker "$SPAWN"

# the worker resumed the legacy JSONL: same file, same id, every legacy byte first
JDIR="$H/state/pi-sessions/pr-$PR"
NJ="$(find "$JDIR" -name '*.jsonl' | wc -l)"
LEGACY_NAME="$(basename "$(ls "$JDIR"/*.jsonl | head -1)")"
ORIG_BYTES="$(stat -c %s "$WORK/legacy-original.jsonl")"
PREFIX_OK=no; cmp -s -n "$ORIG_BYTES" "$WORK/legacy-original.jsonl" "$JDIR/$LEGACY_NAME" && PREFIX_OK=yes
NOW_BYTES="$(stat -c %s "$JDIR/$LEGACY_NAME")"
WEV="$(ls "$H"/state/workers/*.events.jsonl 2>/dev/null | head -1)"
SESSION_LINE="$(head -1 "$WEV" 2>/dev/null)"
WSID="$(printf '%s' "$SESSION_LINE" | python3 -c 'import json,sys;d=json.loads(sys.stdin.read() or "{}");print(d.get("id",""),d.get("cwd",""))' 2>/dev/null)"
WANT_ID="rh-legacy-$(fx heads.0 | cut -c1-8)"
if [[ "$NJ" == 1 && "$PREFIX_OK" == yes && "$NOW_BYTES" -gt "$ORIG_BYTES" && "$WSID" == "$WANT_ID $LEGACY_ROOT" ]]; then
  check RESUME-1 pass "the worker resumes the PR's legacy session by id, with its legacy cwd" "one JSONL ($LEGACY_NAME), its first $ORIG_BYTES bytes unchanged, grown to $NOW_BYTES; the worker's session id and cwd: $WSID"
else
  check RESUME-1 fail "the worker resumes the legacy session" "jsonl files=$NJ prefix_intact=$PREFIX_OK bytes $ORIG_BYTES -> $NOW_BYTES worker session='$WSID' want '$WANT_ID $LEGACY_ROOT'"
fi

# the wave under the permit broker
python3 - "$LOGS/stub.jsonl" "$STUB_LINES_BEFORE" >"$WORK/wave.txt" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
leaf = [r for r in rows if r.get("kind") == "model" and str(r.get("user", "")).startswith("Task: Task file:")]
ts = sorted(r["t"] for r in leaf)
gaps = [b - a for a, b in zip(ts, ts[1:])]
print("leaf_sessions=%d" % len(leaf))
print("min_gap_ms=%s" % (min(gaps) if gaps else "n/a"))
print("rows=%s" % ",".join(sorted(r["user"].split("tasks/")[-1].split(".md")[0] for r in leaf)))
PY
PERMITS="$(python3 -c "import json;p=json.load(open('$H/state/status.json')).get('permits');print(json.dumps(p))")"
LEAVES="$(grep '^leaf_sessions=' "$WORK/wave.txt" | cut -d= -f2)"
MINGAP="$(grep '^min_gap_ms=' "$WORK/wave.txt" | cut -d= -f2)"
PLAN="$(sql "select payload from events where kind='pass_plan_mismatch' limit 1")"
MISSING="$(printf '%s' "$PLAN" | python3 -c 'import json,sys;t=sys.stdin.read().strip();print(len(json.loads(t).get("missing",[])) if t else 0)' 2>/dev/null)"
fact permits_status "$PERMITS"
fact wave "$(tr '\n' ' ' <"$WORK/wave.txt")"
CEIL_OK=no; [[ "$PERMITS" == *'"ceiling": 20'* || "$PERMITS" == *'"ceiling":20'* ]] && CEIL_OK=yes
if [[ "${LEAVES:-0}" -ge 4 && "$CEIL_OK" == yes && "${MISSING:-0}" == 0 ]]; then
  check WAVE-1 pass "the engine starts the planned wave at round start, the session joins it with lens_wave and the verdict's passes match the plan" "$LEAVES planned lens sessions ran ($(grep '^rows=' "$WORK/wave.txt" | cut -d= -f2)); no pass_plan_mismatch; permits block: $PERMITS"
else
  check WAVE-1 fail "the planned wave runs and is joined" "leaves=$LEAVES permits=$PERMITS missing=$MISSING $(tr '\n' ' ' <"$WORK/wave.txt")"
fi

# the permit broker on the wire: 24 parallel passes against a ceiling of 20, grants staggered
python3 - "$LOGS/stub.jsonl" 6000 >"$WORK/burst.txt" <<'PY'
import json, sys
hold = int(sys.argv[2])
ts = sorted(json.loads(l)["t"] for l in open(sys.argv[1]) if l.strip() and '"kind":"model"' in l and json.loads(l).get("user", "").startswith("Task: Burst"))
n = len(ts)
peak = max((sum(1 for j in ts if j <= t < j + hold) for t in ts), default=0)
gaps = [b - a for a, b in zip(ts, ts[1:])]
first20 = gaps[:19]
print("passes=%d" % n)
print("peak_in_flight=%d" % peak)
print("span_first20_ms=%d" % (ts[19] - ts[0] if n >= 20 else 0))
print("median_gap_first20_ms=%d" % (sorted(first20)[len(first20) // 2] if first20 else 0))
print("start_of_21st_after_first_ms=%d" % (ts[20] - ts[0] if n > 20 else 0))
PY
BURST_N="$(grep '^passes=' "$WORK/burst.txt" | cut -d= -f2)"
BURST_PEAK="$(grep '^peak_in_flight=' "$WORK/burst.txt" | cut -d= -f2)"
BURST_MED="$(grep '^median_gap_first20_ms=' "$WORK/burst.txt" | cut -d= -f2)"
BURST_21="$(grep '^start_of_21st_after_first_ms=' "$WORK/burst.txt" | cut -d= -f2)"
fact burst "$(tr '\n' ' ' <"$WORK/burst.txt")"
if [[ "$BURST_N" == 24 && "$BURST_PEAK" == 20 && "$BURST_MED" -ge 200 && "$BURST_21" -ge 6000 ]]; then
  check PERMIT-1 pass "the permit broker holds the ceiling (20) and staggers its grants (250 ms) across a burst of 24 parallel lens passes" "$(tr '\n' ' ' <"$WORK/burst.txt")- the 21st pass could not start until the first had answered (6000 ms), so no more than 20 were ever alive"
else
  check PERMIT-1 fail "the permit broker holds the ceiling and staggers its grants" "$(tr '\n' ' ' <"$WORK/burst.txt")"
fi

# posting through the gate into state/dryrun, and the verdict
REVIEWS="$(dryrun_reviews)"
EVENT="$(python3 - "$H/state/dryrun" <<'PY'
import glob, json, sys
rows = [json.load(open(f)) for f in sorted(glob.glob(sys.argv[1] + "/*create_review.json"))]
rc = [r for r in rows if r.get("body", {}).get("event") == "REQUEST_CHANGES"]
print(len(rc), rc and "Please bound the retries" in json.dumps(rc[0]))
PY
)"
MUTATIONS="$(grep -c '"kind":"github-mutation"' "$LOGS/stub.jsonl")"
if [[ "$EVENT" == "1 True" && "$MUTATIONS" == 0 && "$(events verdict_applied)" -ge 1 && "$(sql "select verdict from rounds where pr=$PR and round_no=1")" == REQUEST_CHANGES ]]; then
  check POST-1 pass "the worker posts through the gate into state/dryrun and commits the verdict" "1 create_review record for round 1 (REQUEST_CHANGES, the model's body; $REVIEWS records in all); verdict_applied; GitHub mutations reaching the stub: $MUTATIONS"
else
  check POST-1 fail "the worker posts through the gate into state/dryrun" "reviews=$REVIEWS event='$EVENT' mutations=$MUTATIONS verdict_applied=$(events verdict_applied)"
fi

# ---- D. the answer worker, with and without may_post (after round 1: the PR is tracked, has a session
# and a review at its head) -----------------------------------------------------------------------------------
# The operator asks the PR's session to answer the author's thread. Without may_post the worker holds
# no posting tool (no bash: the read-only tools plus chat) and nothing lands; with --may-post it
# holds the three post shims, and its reply goes through the daemon's post IPC and the one gate into
# state/dryrun. A REPLY, not a review: guard 2 (no new evidence) rightly refuses a second review at
# the head round 1 reviewed, and a reply is what an operator's "answer them" asks for.
if want ANSWER-1; then
stub_mode answer_post '"comment":9001'
BEFORE="$(dryrun_replies)"
op message "$PR" "Please answer the author's question about the retry bound." >"$WORK/msg1.txt" 2>&1
waitx 120 "the first answer" answers_acked 1
ANS1="$(sql "select id from session_commands where kind='answer' order by rowid limit 1")"
waitx 30 "the first answer's result file" test -s "$H/state/commands/$ANS1/result.json"
RES1="$(tr '\n' ' ' <"$H/state/commands/$ANS1/result.json" 2>/dev/null | cut -c1-500)"
AFTER1="$(dryrun_replies)"
op message "$PR" --may-post "Please answer the author's question about the retry bound." >"$WORK/msg2.txt" 2>&1
waitx 120 "the second answer" answers_acked 2
ANS2="$(sql "select id from session_commands where kind='answer' order by rowid desc limit 1")"
waitx 30 "the second answer's result file" test -s "$H/state/commands/$ANS2/result.json"
RES2="$(tr '\n' ' ' <"$H/state/commands/$ANS2/result.json" 2>/dev/null | cut -c1-500)"
AFTER2="$(dryrun_replies)"
REPLY_REC="$(find "$H/state/dryrun" -name '*create_review_comment_reply.json' -newer "$WORK/msg1.txt" 2>/dev/null | head -1)"
REPLY_OK=no; [[ -n "$REPLY_REC" ]] && grep -q 'Operator-requested reply' "$REPLY_REC" && grep -q 9001 "$REPLY_REC" && REPLY_OK=yes
fact answer_without "$RES1"
fact answer_with "$RES2"
if [[ "$ANS1" != "$ANS2" && "$AFTER1" == "$BEFORE" && "$RES1" == *'"may_post": false'* && "$RES1" == *'"posted": 0'* \
  && "$AFTER2" == $((BEFORE + 1)) && "$REPLY_OK" == yes && "$RES2" == *'"may_post": true'* && "$RES2" == *'"posted": 1'* ]]; then
  check ANSWER-1 pass "the answer worker works without may_post (it holds no posting tool, nothing lands) and with it (its reply goes through the gate into state/dryrun)" "without: reply records $BEFORE -> $AFTER1, result: ${RES1:0:240}; with --may-post: $AFTER1 -> $AFTER2, $(basename "$REPLY_REC") (reply to comment 9001), result: ${RES2:0:240}"
else
  check ANSWER-1 fail "the answer worker with and without may_post" "reply records $BEFORE/$AFTER1/$AFTER2 record_ok=$REPLY_OK; without: $RES1; with: $RES2; messages: $(cat "$WORK/msg1.txt" "$WORK/msg2.txt" | tr '\n' ' ')"
fi
stub_mode round
fi


# ---- E. takeover in a pty, the fence, release ------------------------------------------------------------------------------
if want TAKEOVER-1; then
op takeover "$PR" >"$WORK/takeover.txt" 2>&1
wait_for 60 "the takeover pane" dx tmux has-session -t "takeover-pr-$PR"
sleep 8
TPROCS="$(procs | grep -E 'takeoverpi| pi *$' | tr '\n' ';' | cut -c1-300)"
stub_mode answer
python3 "$RH/pty-drive.py" --settle 4 --send "say hello from the rehearsal" --expect "Answer from the rehearsal stub" --timeout 60 --detach -- \
  docker exec -it "$DAEMON" tmux attach -t "takeover-pr-$PR" >"$WORK/takeover-pty.txt" 2>&1
PTY_RC=$?
op message "$PR" "are you there?" >"$WORK/fence.txt" 2>&1
FENCE="$(cat "$WORK/fence.txt" | tr '\n' ' ')"
LEASE_ROW="$(sql "select kind||' '||state from pr_host_leases where pr=$PR")"
WORKERS_DURING="$(events worker_spawned)"
op release "$PR" >"$WORK/release.txt" 2>&1
wait_for 60 "the takeover pi to be gone" bash -c "! docker exec $DAEMON tmux has-session -t takeover-pr-$PR 2>/dev/null"
sleep 3
LEASE_AFTER="$(sql "select count(*) from pr_host_leases where pr=$PR")"
PI_LEFT="$(procs | grep -c 'takeoverpi')"
if [[ "$PTY_RC" == 0 && "$FENCE" == *"takeover lease"* && "$LEASE_ROW" == "takeover held" && "$LEASE_AFTER" == 0 && "$PI_LEFT" == 0 ]]; then
  check TAKEOVER-1 pass "takeover works in a pty: the operator talks to the PR's own session, a worker is kept out while it stands, and the pi is gone before the lease frees" "attached with docker exec -it (pty), typed a line and the session answered; lease '$LEASE_ROW'; a message during it: ${FENCE:0:160}; after release: lease rows $LEASE_AFTER, takeover pi processes $PI_LEFT"
else
  check TAKEOVER-1 fail "takeover in a pty" "pty rc=$PTY_RC lease='$LEASE_ROW' fence='$FENCE' lease_after=$LEASE_AFTER pi_left=$PI_LEFT procs: $TPROCS; screen: $(tail -5 "$WORK/takeover-pty.txt" | tr '\n' ' ')"
fi
stub_mode round
fi

# ---- F. debug round in a pty: armed, the next round runs in interactive pi, the fence --------------------------------------
if want DEBUG-1; then
DR="$(next_round)"
D_REVIEWS_BEFORE="$(dryrun_reviews)"
op debug-round "$PR" >"$WORK/debug.txt" 2>&1
DEBUG_ARMED="$(sql "select kind||' '||state from pr_host_leases where pr=$PR")"
HEAD2="$(push_head 3)"
pr_event synchronize "$HEAD2" >/dev/null
wait_for 120 "the debug pane" dx tmux has-session -t "debug-pr-$PR"
pr_runtime() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print([p.get('runtime') for p in d.get('prs',[]) if p.get('number')==$PR][0])" "$H/state/status.json" 2>/dev/null; }
DRUNTIME="unseen"
debug_runtime_seen() { [[ "$(pr_runtime)" == debug ]] && DRUNTIME=debug; }
# the pane's first seconds: does the heartbeat say runtime=debug? (informational; the
# heartbeat's period decides whether one lands inside them)
SECONDS_END=$((SECONDS + 8)); until ((SECONDS >= SECONDS_END)); do debug_runtime_seen && break; sleep 1; done; sleep 2
python3 "$RH/pty-drive.py" --settle 3 --expect "[Rr]ound|lens|verdict|bash" --timeout 20 --detach -- \
  docker exec -it "$DAEMON" tmux attach -t "debug-pr-$PR" >"$WORK/debug-pty.txt" 2>&1
DPTY=$?
wait_for 240 "round $DR (the debug round) to settle" rounds_done "$DR"
# The round ends itself: once the verdict is committed and the pane has been quiet
# DEBUG_VERDICT_SETTLE_MS (15 s), the daemon stops the pi, confirms it gone, then frees the lease.
debug_ended() { ! dx tmux has-session -t "debug-pr-$PR" 2>/dev/null && [[ "$(sql "select count(*) from pr_host_leases where pr=$PR")" == 0 ]]; }
waitx 120 "the debug pi to be stopped and its lease freed after the verdict" debug_ended
DEBUG_GONE=no; dx tmux has-session -t "debug-pr-$PR" 2>/dev/null || DEBUG_GONE=yes
DLEASE="$(sql "select count(*) from pr_host_leases where pr=$PR")"
DEND="$(sql "select payload from events where kind='host_lease_released' order by id desc limit 1")"
DMISMATCH="$(sql "select count(*) from events where kind='pass_plan_mismatch' and payload like '%\"round_no\":$DR,%'")"
fact debug_end "$DEND"
D_REVIEWS="$(dryrun_reviews)"
DCMD="$(sql "select status from session_commands where kind='round' and round_no=$DR order by rowid desc limit 1" 2>/dev/null)"
# the fence: no worker starts between the lease's grant and its release (the pi confirmed gone)
SPAWNS_DURING_DEBUG="$(sql "select count(*) from events where kind='worker_spawned' and pr=$PR and id > (select max(id) from events where kind='host_lease_granted' and pr=$PR) and id < coalesce((select max(id) from events where kind='host_lease_released' and pr=$PR), 1e18)")"
if [[ "$DEBUG_ARMED" == "debug "* && "$DPTY" == 0 && "$DEBUG_GONE" == yes && "$DLEASE" == 0 && "$DEND" != *"by the operator"* && "$(round_status "$DR")" == done && "$D_REVIEWS" == $((D_REVIEWS_BEFORE + 1)) && "$DMISMATCH" == 0 && "$SPAWNS_DURING_DEBUG" == 0 ]]; then
  check DEBUG-1 pass "debug-round runs the PR's next round in interactive pi in a pty, posts through the gate, and keeps every worker out until the pi is confirmed gone" "lease '$DEBUG_ARMED' armed; round $DR ran in tmux debug-pr-$PR (attached in a pty, rc=$DPTY), its review went through the gate (create_review records $D_REVIEWS_BEFORE -> $D_REVIEWS); verdict committed, its passes the plan's (no pass_plan_mismatch); status.json runtime while it ran: $DRUNTIME; the round ended itself ($DEND): pi gone, lease rows $DLEASE; workers spawned while it stood: $SPAWNS_DURING_DEBUG"
else
  check DEBUG-1 fail "debug-round in a pty" "armed='$DEBUG_ARMED' round$DR='$(round_status "$DR")' pi_gone=$DEBUG_GONE lease_rows=$DLEASE end='$DEND' plan_mismatch=$DMISMATCH spawns_during=$SPAWNS_DURING_DEBUG reviews $D_REVIEWS_BEFORE -> $D_REVIEWS cmd=$DCMD pty rc=$DPTY screen: $(tail -6 "$WORK/debug-pty.txt" | tr '\n' ' ')"
fi

# a debug round that did not end leaves its lease; the next scenario needs the PR free
op release "$PR" >/dev/null 2>&1; sleep 3
fi

# ---- G. a daemon restart kills and requeues a worker -----------------------------------------------------------------------------
if want RESTART-1; then
log "restart scenario: a worker mid-round, then the daemon is killed"
RR="$(next_round)"
HEAD3="$(push_head 4)"
stub_mode slow '"ms":300000'
pr_event synchronize "$HEAD3" >/dev/null
waitx 120 "a worker running round $RR" round_running "$RR"
sleep 3
ATT_BEFORE="$(sql "select attempt from session_commands where kind='round' and round_no=$RR order by rowid desc limit 1")"
stub_mode round
BOOTS_BEFORE="$(boots)"
DAEMON_PID="$(procs | awk '/dist\/src\/wire.js/ {print $1; exit}')"
dx sh -c "kill -9 $DAEMON_PID" 2>/dev/null
wait_for 60 "the container to come back" bash -c "docker exec $DAEMON true"
waitx 180 "the restarted daemon's recovery and reconcile" rebooted "$BOOTS_BEFORE"
RECOVER="$(docker logs "$DAEMON" 2>&1 | grep 'workers: recovered' | tail -1)"
wait_for 240 "round $RR to settle after the restart" rounds_done "$RR"
ATT_AFTER="$(sql "select attempt from session_commands where kind='round' and round_no=$RR order by rowid desc limit 1")"
NJ3="$(find "$JDIR" -name '*.jsonl' | wc -l)"
if [[ "$(round_status "$RR")" == done && "${ATT_AFTER:-0}" -gt "${ATT_BEFORE:-0}" && "$NJ3" == 1 && "$RECOVER" == *"requeued=1"* ]]; then
  check RESTART-1 pass "a daemon restart kills and requeues a worker; a fresh one finishes the round over the same JSONL" "worker mid-round, daemon SIGKILLed, container restarted by its policy; boot said: ${RECOVER#*] }; the command's attempt $ATT_BEFORE -> $ATT_AFTER; round $RR done; one JSONL"
else
  check RESTART-1 fail "a daemon restart requeues a worker" "round$RR='$(round_status "$RR")' attempt $ATT_BEFORE -> $ATT_AFTER jsonl=$NJ3 recover='$RECOVER'"
fi
fi

# ---- H. a failing worker trips the breaker -------------------------------------------------------------------------------------
if want BREAKER-1; then
log "breaker scenario: the model fails every request"
BR="$(next_round)"
HEAD4="$(push_head 5)"
SPAWNS_BEFORE="$(events worker_spawned)"
stub_mode fail
pr_event synchronize "$HEAD4" >/dev/null
waitx 240 "the PR to park" crash_loop_seen
sleep 20
SPAWNED="$(( $(events worker_spawned) - SPAWNS_BEFORE ))"
# status.json carries the park (prs[].worker_crash, which the board and the alerts read)
pr_crash() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps([p.get('worker_crash') for p in d['prs'] if p['number']==$PR][0]))" "$H/state/status.json" 2>/dev/null; }
parked_in_status() { [[ "$(pr_crash)" == *parked_at* ]]; }
waitx 60 "status.json to show the park" parked_in_status
PARKED="$(pr_crash | cut -c1-300)"
CRASH="$(sql "select count(*) from events where kind='anomaly' and payload like '%worker_crash_loop%'")"
if [[ "$CRASH" -ge 1 && "$SPAWNED" == 2 && "$PARKED" == *parked_at* ]]; then
  check BREAKER-1 pass "a failing worker trips the breaker: the PR is parked after two failures and no third worker starts" "workers spawned for the round: $SPAWNED; worker_crash_loop anomaly x$CRASH; status.json worker_crash: $PARKED"
else
  check BREAKER-1 fail "a failing worker trips the breaker" "spawned=$SPAWNED crash_loop_anomalies=$CRASH status=$PARKED round$BR=$(round_status "$BR")"
fi
stub_mode round
fi

# ---- I. the refresher --------------------------------------------------------------------------------------------------------------
if want LOGIN-1; then
LOCKED=no; dx flock -n "/home/qcr/.pi/agent/loginrefresh.lock" true 2>/dev/null || LOCKED=yes
OLD_REFRESH="$(python3 -c "import json;print(json.load(open('$H/pihome/agent/auth.json'))['openai-codex']['refresh'])")"
# a login that is due: stop the daemon, make the token expire inside the refresh margin, start it
BOOTS_LOGIN="$(boots)"
docker stop -t 30 "$DAEMON" >/dev/null
python3 - "$H/pihome/agent/auth.json" <<'PY'
import json, sys, time
p = sys.argv[1]; d = json.load(open(p))
d["openai-codex"]["expires"] = int((time.time() + 3600) * 1000)
json.dump(d, open(p, "w"))
PY
docker start "$DAEMON" >/dev/null
refreshed() { [[ "$(python3 -c "import json;print(json.load(open('$H/pihome/agent/auth.json'))['openai-codex']['refresh'])")" != "$OLD_REFRESH" ]]; }
wait_for 120 "the refresh" refreshed
NEW_REFRESH="$(python3 -c "import json;d=json.load(open('$H/pihome/agent/auth.json'))['openai-codex'];print(d['refresh'], d['expires'])")"
sleep 3
LOCKED2=no; dx flock -n "/home/qcr/.pi/agent/loginrefresh.lock" true 2>/dev/null || LOCKED2=yes
SECOND="$(dx node "$APP_ROOT/dist/src/loginrefresh/main.js" 2>&1; echo "exit=$?")"
SECOND_RC="${SECOND##*exit=}"
TOKEN_POSTS="$(grep -c '"path":"/oauth/token"' "$LOGS/stub.jsonl")"
STATUS_LR="$(python3 -c "import json;print(json.dumps(json.load(open('$H/state/status.json')).get('login_refresh')))" 2>/dev/null)"
fact login_refresh "$STATUS_LR"
# NEW_REFRESH is "<refresh token> <expires>": the token alone must have rotated
if [[ "$LOCKED" == yes && "$LOCKED2" == yes && "$SECOND_RC" == 75 && "$TOKEN_POSTS" -ge 1 && "${NEW_REFRESH%% *}" != "$OLD_REFRESH" ]]; then
  check LOGIN-1 pass "the refresher holds loginrefresh.lock; after a real refresh a second refresher is refused" "lock held before and after the refresh; the due token was refreshed through pi-ai's own OAuth refresh against the stub ($TOKEN_POSTS token POST(s), the refresh token rotated); a second refresher exited $SECOND_RC: ${SECOND%%exit=*}"
else
  check LOGIN-1 fail "the refresher and its lock" "locked=$LOCKED/$LOCKED2 second rc=$SECOND_RC ($SECOND) token_posts=$TOKEN_POSTS refresh '$OLD_REFRESH' -> '$NEW_REFRESH'"
fi
waitx 180 "the daemon after the refresher scenario" rebooted "$BOOTS_LOGIN"
fi

# ---- J. SQLITE_BUSY, the process tree, status.json, the network ------------------------------------------------------------------------
sleep 5
BUSY_DAEMON="$(docker logs "$DAEMON" 2>&1 | grep -c -E 'SQLITE_BUSY|database is locked')"
BUSY_WORKERS="$(cat "$H"/state/workers/*.log "$H"/state/workers/*.pi-stderr.log 2>/dev/null | grep -c -E 'SQLITE_BUSY|database is locked')"
BUSY_EVENTS="$(sql "select count(*) from events where payload like '%SQLITE_BUSY%' or payload like '%database is locked%'")"
WORKERS_RUN="$(events worker_spawned)"
if [[ "$BUSY_DAEMON$BUSY_WORKERS$BUSY_EVENTS" == "000" ]]; then
  check BUSY-1 pass "concurrent daemon and worker activity leaves no SQLITE_BUSY" "0 hits in the daemon log, $(ls "$H"/state/workers/*.log | wc -l) worker logs and the events table, over $WORKERS_RUN worker spawns; of ANSWER-1, TAKEOVER-1, DEBUG-1 and RESTART-1 this run executed: $(for s in ANSWER-1 TAKEOVER-1 DEBUG-1 RESTART-1; do want "$s" && printf '%s ' "$s"; done; true)"
else
  check BUSY-1 fail "no SQLITE_BUSY" "daemon log $BUSY_DAEMON, worker logs $BUSY_WORKERS, events $BUSY_EVENTS"
fi

PROCS="$(procs)"
printf '%s\n' "$PROCS" >"$WORK/procs.txt"
TMUXS="$(dx tmux ls 2>/dev/null | cut -d: -f1 | sort | tr '\n' ' ')"
WIRE_PID="$(awk '/dist\/src\/wire.js/ {print $1; exit}' <<<"$PROCS")"
# a PR pi: any pi / worker process that is not the overseer's
PI_ROWS="$(awk '$3=="pi" || $3 ~ /^pi / || $0 ~ /botworker|takeoverpi|debugroundpi/' <<<"$PROCS")"
descends() { # does pid $1 have $2 as an ancestor?
  local p="$1"
  while [[ -n "$p" && "$p" != 0 ]]; do
    [[ "$p" == "$2" ]] && return 0
    p="$(awk -v p="$p" '$1==p {print $2}' <<<"$PROCS")"
  done
  return 1
}
PR_PI=0
while read -r pid ppid _; do
  [[ -z "$pid" ]] && continue
  descends "$pid" "$WIRE_PID" && PR_PI=$((PR_PI + 1))
done <<<"$PI_ROWS"
OVERSEER_PI="$(awk '$3=="pi" || $3 ~ /^pi / {print $1}' <<<"$PROCS" | wc -l)"
fact process_tree_pi "$PI_ROWS"
fact tmux_sessions "$TMUXS"
LONG_LIVED="$(awk '{ $1=""; $2=""; print }' <<<"$PROCS" | grep -E 'wire.js|loginrefresh' | sed 's/^ *//' | cut -c1-80 | tr '\n' ';')"
fact long_lived "$LONG_LIVED"
# The entrypoint still starts a tmux server and one empty `main` shell session (the jump-in surface and the
# host of the takeover and debug panes); that is not a PR session. Anything else, and any pi, is.
if [[ "$PR_PI" == 0 && ( -z "${TMUXS// /}" || "$TMUXS" == "main " ) && "$OVERSEER_PI" == 0 ]]; then
  check TREE-1 pass "the daemon's process tree holds no pi, no PR tmux session and no overseer: the daemon and the login refresher, nothing else long-lived" "pi processes in the container: $OVERSEER_PI (under the daemon: $PR_PI); tmux sessions: ${TMUXS:-none} (the entrypoint's empty shell, no pane runs pi); long-lived: $LONG_LIVED"
else
  check TREE-1 fail "the daemon's process tree holds no pi, no PR tmux session and no overseer" "under daemon: $PR_PI; tmux: ${TMUXS:-none}; pi: $OVERSEER_PI; rows: $(tr '\n' ';' <<<"$PI_ROWS" | cut -c1-300)"
fi

# The heartbeat reports a block only once its source is up: right after the login scenario's
# restart the refresher's block is "not reported" for a heartbeat or two. Read the newest one
# that carries every field, for a bounded while.
status_fields() {
  python3 - "$H/state/status.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
miss = []
for k in ("permits", "login_refresh", "running_rounds", "prs"):
    if k not in d: miss.append(k)
for p in d.get("prs", []):
    if "runtime" not in p: miss.append("prs[%s].runtime" % p.get("number"))
print("ok" if not miss else "missing:" + ",".join(miss))
print(json.dumps({"permits": d.get("permits"), "runtime": {p["number"]: p.get("runtime") for p in d.get("prs", [])}}))
PY
}
status_complete() { [[ "$(status_fields | head -1)" == ok ]]; }
waitx 90 "a heartbeat that carries every runtime field" status_complete
STATUS_OK="$(status_fields)"
fact status_runtime "$(tail -1 <<<"$STATUS_OK")"
if [[ "$(head -1 <<<"$STATUS_OK")" == ok ]]; then
  check STATUS-1 pass "status.json shows the runtime fields" "$(tail -1 <<<"$STATUS_OK")"
else
  check STATUS-1 fail "status.json shows the runtime fields" "$STATUS_OK"
fi

# the capture: what the stub served, and what the containers tried to reach and could not
python3 - "$LOGS/stub.jsonl" >"$WORK/capture.txt" <<'PY'
import json, collections, sys
c = collections.Counter(); unm = collections.Counter(); mut = 0
for l in open(sys.argv[1]):
    try: r = json.loads(l)
    except Exception: continue
    k = r.get("kind")
    if k in ("github", "model", "admin"): c[k] += 1
    if k == "github" and r["path"].startswith("/oauth/token"): c["oauth"] += 1
    if k == "github-unmodelled": unm[r["method"] + " " + r["path"].split("?")[0]] += 1
    if k == "github-mutation": mut += 1
    if k == "oauth": c["oauth"] += 1
print("stub_requests=" + json.dumps(dict(c)))
print("unmodelled=" + json.dumps(dict(unm)))
print("github_mutations=%d" % mut)
PY
BLOCKED="$( { docker logs "$DAEMON" 2>&1; cat "$H"/state/workers/*.log "$H"/state/workers/*.pi-stderr.log 2>/dev/null; docker logs "$MEMORY" 2>&1; } | grep -o -E '(ENOTFOUND|EAI_AGAIN|getaddrinfo [A-Z_]*|Could not resolve host:?) *[A-Za-z0-9._-]*' | sort | uniq -c | sort -rn | head -10 | tr '\n' ';')"
fact capture "$(tr '\n' ' ' <"$WORK/capture.txt")"
fact blocked_lookups "${BLOCKED:-none}"
GHMUT="$(grep '^github_mutations=' "$WORK/capture.txt" | cut -d= -f2)"
MODELREQ="$(grep -c '"kind":"model"' "$LOGS/stub.jsonl")"
if [[ "$GHMUT" == 0 && "$MODELREQ" -gt 0 ]]; then
  check NETCAP-1 pass "no provider and no GitHub call: the network capture shows only the stub" "the network is --internal; $MODELREQ model requests, every GitHub/OAuth request and 0 GitHub mutations were served by the stub; $(sed -n 1,2p "$WORK/capture.txt" | tr '\n' ' ') lookups that could not leave: ${BLOCKED:-none}"
else
  check NETCAP-1 fail "the network capture shows only the stub" "mutations=$GHMUT model_requests=$MODELREQ"
fi

# ---- the report -----------------------------------------------------------------------------------------------------------------------
cp "$LOGS/stub.jsonl" "$WORK/stub.jsonl" 2>/dev/null
docker logs "$DAEMON" >"$LOGS/daemon.log" 2>&1
REPORT_RC=0
node "$RH/report.mjs" "$RESULTS" "$FACTS" "$OUT" "$HEAD_SHA" || { REPORT_RC=1; log "the report failed"; }
FAILS="$(grep -c -P '\tfail\t' "$RESULTS")"
PASSES="$(grep -c -P '\tpass\t' "$RESULTS")"
log "done: $PASSES passed, $FAILS failed; report $OUT"
[[ "$FAILS" == 0 && "$REPORT_RC" == 0 ]]
