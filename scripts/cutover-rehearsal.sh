#!/usr/bin/env bash
# cutover-rehearsal.sh — the full cutover rehearsal (P8.20), the run that writes
# docs/cutover-rehearsal.md. The REAL cutover tooling, end to end, against a throwaway legacy-shaped
# "VM" on this machine:
#
#   scripts/cutover-rehearsal.sh [--out FILE] [--work DIR] [--keep] [--skip-worker] [--fresh]
#
#   --out FILE       the report (default docs/cutover-rehearsal.md)
#   --work DIR       the scratch directory (default /tmp/claude-$UID/cutover-rehearsal-<pid>). A directory a
#                    run already filled is REUSED up to the pristine legacy host (the registry, the images
#                    pushed, the stand-in image, the host layout and the legacy store are the slow parts);
#                    the scenarios always start from a copy of that pristine host.
#   --fresh          throw the reused parts away and build them again
#   --keep           leave the containers, the registry, sshd and the host directory up for a look
#   --skip-worker    stop after the login checks: do not run the P8.20a worker scenarios on the release boot
#
# What runs for real (nothing of it is rewritten for the rehearsal):
#   scripts/cutover.sh (the P8.21a wizard) -> scripts/deploy.sh (dry-run, release, verify, provision)
#   -> ssh -> deploy/qcr-update.sh -> docker pull BY DIGEST from a registry -> the release and memory images
#   built from this tree -> `qcr config check` and `daemon --preflight` of the NEW image on the staged
#   config and a snapshot of the legacy state -> the sidecar -> the recreate -> the release daemon's
#   first boot over a state.db the legacy build wrote.
#
# What stands in (a TEST TOOL, none of it ships; docs/cutover-rehearsal.md says what each cannot show):
#   - the host: this machine, reached over a throwaway unprivileged sshd on localhost (a forced command,
#     scripts/cutover-rehearsal/vm-shell.sh). No KVM guest (no qemu here), no dind: docker is this
#     machine's, the "VM" is a directory tree, and `sudo` is a shim that runs the command as the user.
#     qcr-update therefore runs in the test mode its header documents (non-root, QCR_UPDATE_CONF).
#   - the legacy bot: a container with no qcr.layout label running scripts/cutover-rehearsal/legacy-daemon.mjs
#     over the LEGACY build's own StateStore (commit 8169df6f). It is the legacy bot's drain contract, not
#     its code: the heartbeat, the operator channel, the first-reconcile drain lift.
#   - the registry: registry:2 on localhost; both images pushed as single-arch manifests (the P7.16
#     manifest's index digest is that manifest's digest, its platforms entries repeat it).
#   - the model, GitHub and OAuth: scripts/worker-rehearsal/stub.mjs on an --internal network.
#   - `deploy.sh provision`: the playbook needs root, apt and systemd; a stub ansible-playbook installs
#     the run spec deploy.sh rendered, the one task of it this rehearsal needs.
#
# Costs nothing: no model, no GitHub, no ghcr (docker.io's registry:2 is pulled once, anonymously), never
# the live VM or the live bot. Exits 0 only when every check passed.
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RH="$HERE/cutover-rehearsal"
WRH="$HERE/worker-rehearsal"
OUT="$ROOT/docs/cutover-rehearsal.md"
WORK=""
KEEP=0
SKIP_WORKER=0
FRESH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --skip-worker) SKIP_WORKER=1; shift ;;
    --fresh) FRESH=1; shift ;;
    *) echo "usage: $0 [--out FILE] [--work DIR] [--keep] [--skip-worker] [--fresh]" >&2; exit 2 ;;
  esac
done
WORK="${WORK:-/tmp/claude-$(id -u)/cutover-rehearsal-$$}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"

# ---- names ---------------------------------------------------------------------------------------
DAEMON=quickreview-sandbox
MEMORY=quickreview-memory
STUB=qcr-rehearsal-stub
NET=qcr-rehearsal-net
REG=qcr-cutrh-registry
SCRATCH_MEM=qcr-cutrh-scratch-memory
REL_IMG=qcr-rehearsal/release:head
MEM_IMG=qcr-rehearsal/memory:head
LEG_IMG=qcr-cutrh/legacy-standin:1
BROKEN_IMG=qcr-cutrh/memory-never-ready:1
LEGACY_COMMIT=8169df6f
LEGACY_CACHE="${QCR_REHEARSAL_CACHE:-/tmp/qcr-worker-rehearsal-cache}/legacy-$LEGACY_COMMIT"
UIDGID="$(id -u):$(id -g)"
H="$WORK/host"
PRISTINE="$WORK/pristine"
TLS="$WORK/tls"
LOGS="$WORK/logs"
VM="$WORK/vm"
CTL="$WORK/ctl"
RESULTS="$WORK/results.tsv"
FACTS="$WORK/facts.tsv"
VM_HOST=cutover-vm
VERSION=1.0.0
PR=7
exec 8>"$WORK/.lock"
flock -n 8 || { echo "[cutover-rehearsal] another run is using $WORK" >&2; exit 1; }
mkdir -p "$LOGS" "$VM/inject" "$VM/etc/qcr" "$VM/backups" "$VM/lib" "$CTL"
: >"$RESULTS"; : >"$FACTS"

log() { echo "[cutover-rehearsal $(date +%H:%M:%S)] $*" >&2; }
die() { echo "[cutover-rehearsal] FATAL: $*" >&2; exit 1; }
check() {
  local detail; detail="$(printf '%s' "${4:-}" | tr '\n\t' '  ')"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$detail" >>"$RESULTS"
  if [[ "$2" == pass ]]; then log "PASS $1 $3"; else log "FAIL $1 $3 -- $detail"; fi
}
fact() { printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | tr '\n\t' '  ')" >>"$FACTS"; }
# finding <id> <fixed|open|rehearsal> <text>: a finding of this run, carried into the report
finding() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$WORK/findings.tsv"; }

wait_for() {
  local secs="$1" what="$2"; shift 2
  local end=$((SECONDS + secs))
  while ((SECONDS < end)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  log "timed out after ${secs}s waiting for: $what"
  return 1
}

# The root-owned files the operator channel creates (docker exec -u 0) need root to remove.
rm_host() { docker run --rm -u 0 --entrypoint rm -v "$(dirname "$1"):/w" "$REL_IMG" -rf "/w/$(basename "$1")" >/dev/null 2>&1 || rm -rf "$1"; }

SSHD_PID=""
teardown_containers() {
  docker rm -f "$DAEMON" "$DAEMON-prev" "$MEMORY" "$MEMORY-prev" "$STUB" "$SCRATCH_MEM" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
cleanup() {
  local rc=$?
  [[ -z "$SSHD_PID" ]] || kill "$SSHD_PID" 2>/dev/null
  if [[ "$KEEP" == 1 ]]; then log "kept: work $WORK (registry $REG, containers, sshd)"; return; fi
  teardown_containers
  docker rm -f "$REG" >/dev/null 2>&1
  rm_host "$H"; rm_host "$PRISTINE"
  return $rc
}
trap cleanup EXIT

for t in docker sqlite3 openssl python3 node rsync flock ssh ssh-keygen /usr/bin/sshd git curl tar; do
  command -v "$t" >/dev/null || die "needs $t"
done
docker info >/dev/null 2>&1 || die "docker is not reachable"
[[ -d "$LEGACY_CACHE/dist/src" ]] || "$WRH/legacy-db.sh" "$WORK/.legacy-probe.db" >/dev/null 2>&1
[[ -d "$LEGACY_CACHE/dist/src" ]] || die "the legacy build ($LEGACY_COMMIT) is not built: run scripts/worker-rehearsal/legacy-db.sh once"
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || die "deploy.sh refuses a dirty tree: commit first ($(git -C "$ROOT" status --porcelain | head -3 | tr '\n' ' '))"
ss -ltn 2>/dev/null | grep -q ':8787 ' && die "port 8787 is taken on this machine (the release container publishes the webhook port)"

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
dx() { docker exec "$DAEMON" "$@"; }
sql() { sqlite3 -readonly -cmd '.timeout 5000' "$H/state/state.db" "$1" 2>/dev/null; }
label_of() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }
tables() { sqlite3 -readonly "$1" "select count(*) from sqlite_master where type='table'" 2>/dev/null; }
tree_sum() { (cd "$1" && find . -type f ! -name '.seeded-from-daemon' -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-16); }
status_get() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));v=d
for k in sys.argv[2].split('.'): v=(v or {}).get(k) if isinstance(v,dict) else None
print('' if v is None else (json.dumps(v) if not isinstance(v,(str,int,float,bool)) else v))" "$H/state/status.json" "$1" 2>/dev/null; }

# =================================================================================================
# PHASE 1 — the slow, reusable world: images, registry, manifests, the stand-in image, sshd, dist
# =================================================================================================
[[ "$FRESH" == 1 ]] && rm -f "$WORK"/.done-*
phase_done() { [[ -f "$WORK/.done-$1" ]]; }
phase_mark() { : >"$WORK/.done-$1"; }

docker image inspect "$REL_IMG" "$MEM_IMG" >/dev/null 2>&1 || die "build the images first: scripts/worker-rehearsal/build-images.sh $REL_IMG $MEM_IMG"
HEAD_FULL="$(git -C "$ROOT" rev-parse HEAD)"
IMG_SHA="$(label_of "$REL_IMG" qcr.build-sha)"
same_inputs() {
  [[ "$1" =~ ^[0-9a-f]{7,40}$ ]] && git -C "$ROOT" cat-file -e "$1^{commit}" 2>/dev/null \
    && git -C "$ROOT" diff --quiet "$1" HEAD -- . ':(exclude)scripts/worker-rehearsal.sh' ':(exclude)scripts/worker-rehearsal' \
      ':(exclude)scripts/cutover-rehearsal.sh' ':(exclude)scripts/cutover-rehearsal' ':(exclude)scripts/deploy.sh' ':(exclude)scripts/cutover.sh' \
      ':(exclude)tests' ':(exclude)docs'
}
if [[ "$(label_of "$REL_IMG" qcr.layout)" == release && "$(label_of "$REL_IMG" qcr.preflight)" == true \
   && "$IMG_SHA" =~ ^[0-9a-f]{40}$ ]] && same_inputs "$IMG_SHA"; then
  check IMG-1 pass "the release image is built from this tree and carries the labels the updater requires" \
    "qcr.build-sha=$IMG_SHA (HEAD is $HEAD_FULL, differing only in the rehearsal's own tooling, tests and docs); qcr.layout=release qcr.preflight=true qcr.runspec=$(label_of "$REL_IMG" qcr.runspec) qcr.pi=$(label_of "$REL_IMG" qcr.pi)"
else
  check IMG-1 fail "the release image is built from this tree" "sha=$IMG_SHA layout=$(label_of "$REL_IMG" qcr.layout) preflight=$(label_of "$REL_IMG" qcr.preflight); rebuild: scripts/worker-rehearsal/build-images.sh $REL_IMG $MEM_IMG"
fi
fact release_image "$(docker image inspect -f '{{.Id}} {{.Size}}' "$REL_IMG")"
fact memory_image "$(docker image inspect -f '{{.Id}} {{.Size}}' "$MEM_IMG")"
fact build_sha "$IMG_SHA (HEAD $HEAD_FULL)"

log "building the operator's CLI (dist) at HEAD"
mkdir -p "/tmp/claude-$(id -u)/tsbi"
(cd "$ROOT" && npx tsc -p tsconfig.json --tsBuildInfoFile "/tmp/claude-$(id -u)/tsbi/cutover-rehearsal.tsbuildinfo" >"$LOGS/tsc.log" 2>&1 && node scripts/verify-dist.mjs >>"$LOGS/tsc.log" 2>&1) \
  || { tail -20 "$LOGS/tsc.log" >&2; die "tsc failed"; }

# ---- the registry, and both images pushed ------------------------------------------------------------
REG_PORT=""
if phase_done registry && docker inspect -f '{{.State.Running}}' "$REG" 2>/dev/null | grep -q true; then
  REG_PORT="$(cat "$WORK/reg-port")"
else
  docker rm -f "$REG" >/dev/null 2>&1
  REG_PORT="$(free_port)"; echo "$REG_PORT" >"$WORK/reg-port"
  log "starting the registry on 127.0.0.1:$REG_PORT"
  docker run -d --name "$REG" -p "127.0.0.1:$REG_PORT:5000" registry:2 >/dev/null || die "registry:2 did not start (docker pull registry:2 needs docker hub once)"
  wait_for 30 "the registry" curl -fsS "http://127.0.0.1:$REG_PORT/v2/" || die "the registry is not up"
  rm -f "$WORK/.done-registry" "$WORK/.done-push"
  phase_mark registry
fi
REPO_D="localhost:$REG_PORT/qcr/quickreview"
REPO_M="localhost:$REG_PORT/qcr/quickreview-memory"
push_digest() { docker push "$1" 2>&1 | tee -a "$LOGS/push.log" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -1; }
if ! phase_done push; then
  log "pushing the release and memory images (and the memory image that never becomes ready)"
  # the memory image that is pulled fine and never answers /ready: the F4 injection
  mkdir -p "$WORK/broken" && printf 'FROM %s\nENTRYPOINT ["sleep","infinity"]\n' "$MEM_IMG" >"$WORK/broken/Dockerfile"
  docker build -q -t "$BROKEN_IMG" "$WORK/broken" >/dev/null || die "could not build the never-ready memory image"
  for v in 0.9.1 0.9.2 0.9.3 $VERSION; do
    docker tag "$REL_IMG" "$REPO_D:$v"; docker tag "$MEM_IMG" "$REPO_M:$v"
  done
  docker tag "$REL_IMG" "$REPO_D:0.9.4"; docker tag "$BROKEN_IMG" "$REPO_M:0.9.4"
  : >"$WORK/digests.tsv"
  for v in 0.9.1 0.9.2 0.9.3 0.9.4 $VERSION; do
    d="$(push_digest "$REPO_D:$v")"; m="$(push_digest "$REPO_M:$v")"
    [[ "$d" =~ ^sha256: && "$m" =~ ^sha256: ]] || die "push of $v gave no digest (daemon '$d', memory '$m')"
    printf '%s\t%s\t%s\n' "$v" "$d" "$m" >>"$WORK/digests.tsv"
  done
  phase_mark push
fi
digest_of() { awk -F'\t' -v v="$1" -v c="$2" '$1==v {print $c}' "$WORK/digests.tsv"; }

# the manifests (deploy/manifest.schema.json): what CI's release workflow emits next to the images
mkdir -p "$CTL/manifests"
for v in 0.9.1 0.9.2 0.9.3 0.9.4 $VERSION; do
  node - "$v" "$(digest_of "$v" 2)" "$(digest_of "$v" 3)" "$REPO_D" "$REPO_M" "$IMG_SHA" "$REL_IMG" "$MEM_IMG" >"$CTL/manifests/deploy-manifest-$v.json" <<'JS'
const [v, dd, md, repoD, repoM, rev, relImg, memImg] = process.argv.slice(2);
const { execFileSync } = await import("node:child_process");
const label = (img, k) => execFileSync("docker", ["inspect", "-f", `{{index .Config.Labels "${k}"}}`, img]).toString().trim();
const img = (repository, d) => ({ repository, index_digest: d, platforms: { "linux/amd64": d, "linux/arm64": d } });
console.log(JSON.stringify({
  schema: 1, version: v, revision: rev,
  images: { daemon: img(repoD, dd), memory: img(repoM, md) },
  pins: {
    pi: label(relImg, "qcr.pi"), openviking: label(memImg, "qcr.openviking"), llama_cpp_python: label(memImg, "qcr.llama-cpp-python"),
    embedder_file: label(memImg, "qcr.embedder-file"), embedder_sha256: label(memImg, "qcr.embedder-sha256"),
    runspec: Number(label(relImg, "qcr.runspec")),
  },
}, null, 2));
JS
  node "$ROOT/scripts/deploy-manifest.mjs" "$CTL/manifests/deploy-manifest-$v.json" "$v" >/dev/null 2>"$LOGS/manifest-$v.err" || die "manifest $v does not validate: $(cat "$LOGS/manifest-$v.err")"
done
cat >"$CTL/release-download.sh" <<EOF
#!/usr/bin/env bash
# stands in for \`gh release download v<version> --pattern deploy-manifest-<version>.json --dir <dir>\`
cp "$CTL/manifests/deploy-manifest-\$1.json" "\$2/"
EOF
cat >"$CTL/tag-digest.sh" <<EOF
#!/usr/bin/env bash
# stands in for \`docker buildx imagetools inspect <repo>:<tag> --format '{{.Manifest.Digest}}'\`: what the tag resolves to
ref="\$1"; name="\${ref%:*}"; tag="\${ref##*:}"; path="\${name#*/}"
curl -fsS -I -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \\
  "http://\${name%%/*}/v2/\$path/manifests/\$tag" | tr -d '\r' | awk 'tolower(\$1)=="docker-content-digest:" {print \$2}'
EOF
chmod +x "$CTL/release-download.sh" "$CTL/tag-digest.sh"
# force a real pull: the images were pushed from this docker, so drop the registry-named refs
for v in 0.9.1 0.9.2 0.9.3 0.9.4 $VERSION; do
  docker rmi "$REPO_D:$v" "$REPO_M:$v" >/dev/null 2>&1
  docker rmi "$REPO_D@$(digest_of "$v" 2)" "$REPO_M@$(digest_of "$v" 3)" >/dev/null 2>&1
done
fact registry "localhost:$REG_PORT; daemon $VERSION $(digest_of $VERSION 2); memory $VERSION $(digest_of $VERSION 3); never-ready memory 0.9.4 $(digest_of 0.9.4 3)"
check REG-1 pass "the images are in a registry and the manifests are in the P7.16 format" \
  "registry:2 on localhost:$REG_PORT; deploy-manifest-<v>.json for 5 versions, each validated by scripts/deploy-manifest.mjs; daemon $VERSION $(digest_of $VERSION 2 | cut -c1-19), memory $(digest_of $VERSION 3 | cut -c1-19); the manifest's platforms entries repeat the single-arch manifest digest (CI's index is multi-arch)"

# ---- the legacy stand-in image: no labels, the legacy dist beside node + better-sqlite3 ------------------
if ! phase_done standin; then
  rm -rf "$WORK/skel" && mkdir -p "$WORK/skel/legacy"
  cp "$LEGACY_CACHE/package.json" "$WORK/skel/legacy/package.json"
  ln -s ../qcr/node_modules "$WORK/skel/legacy/node_modules"
  cid="$(docker create "$REL_IMG")"
  docker cp "$WORK/skel/legacy" "$cid:/opt/legacy" >/dev/null || die "docker cp failed"
  docker export "$cid" | docker import -c 'WORKDIR /opt/qcr' -c 'ENTRYPOINT ["node"]' - "$LEG_IMG" >/dev/null || die "could not make the stand-in image"
  docker rm "$cid" >/dev/null
  phase_mark standin
fi

# ---- the controller: ssh, sshd, shims, inventory, the install's config home -----------------------------------
if ! phase_done ssh; then
  rm -rf "$CTL/ssh" && mkdir -p "$CTL/ssh"
  ssh-keygen -q -t ed25519 -N '' -f "$CTL/ssh/hostkey"
  ssh-keygen -q -t ed25519 -N '' -f "$CTL/ssh/id"
  free_port >"$CTL/ssh/port"
  phase_mark ssh
fi
SSH_PORT="$(cat "$CTL/ssh/port")"
cat >"$VM/env" <<EOF
export QCR_RH_ENV="$VM/env"
export QCR_RH_HOST="$H"
export QCR_RH_VM="$VM"
export QCR_RH_SHIMS="$RH/vm-shims"
export QCR_RH_REPO="$ROOT"
export QCR_RH_CTL="$CTL"
EOF
cat >"$VM/vm-entry.sh" <<EOF
#!/usr/bin/env bash
export QCR_RH_ENV="$VM/env"
exec "$RH/vm-shell.sh"
EOF
chmod +x "$VM/vm-entry.sh"
echo "command=\"$VM/vm-entry.sh\",restrict $(cat "$CTL/ssh/id.pub")" >"$CTL/ssh/authorized_keys"
cat >"$CTL/ssh/sshd_config" <<EOF
Port $SSH_PORT
ListenAddress 127.0.0.1
HostKey $CTL/ssh/hostkey
PidFile $CTL/ssh/sshd.pid
AuthorizedKeysFile $CTL/ssh/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
LogLevel ERROR
EOF
cat >"$CTL/ssh_config" <<EOF
Host $VM_HOST
  HostName 127.0.0.1
  Port $SSH_PORT
  User $(id -un)
  IdentityFile $CTL/ssh/id
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
  BatchMode yes
EOF
if [[ -f "$CTL/ssh/sshd.pid" ]] && kill -0 "$(cat "$CTL/ssh/sshd.pid")" 2>/dev/null; then kill "$(cat "$CTL/ssh/sshd.pid")"; sleep 1; fi
/usr/bin/sshd -f "$CTL/ssh/sshd_config" -e 2>"$LOGS/sshd.log"
SSHD_PID="$(cat "$CTL/ssh/sshd.pid" 2>/dev/null)"
wait_for 10 "sshd" "$RH/ctl-shims/ssh" "$VM_HOST" true 2>/dev/null || true

# The controller's environment: the shims first on PATH, the rehearsal's own install (never the
# user's: XDG homes of its own), the registry and the manifests as the seams deploy.sh documents.
export QCR_RH_ENV="$VM/env" QCR_RH_CTL="$CTL"
export PATH="$RH/ctl-shims:$PATH"
export XDG_CONFIG_HOME="$CTL/xdg-config" XDG_STATE_HOME="$CTL/xdg-state"
unset QCR_CONFIG QCR_INSTALL QCR_CONFIG_HOME QCR_STATE_HOME GH_TOKEN GITHUB_TOKEN
CFGHOME="$XDG_CONFIG_HOME/qcr/default"
mkdir -p "$CFGHOME" "$XDG_STATE_HOME/qcr/default"
export QC_INVENTORY="$CTL/inventory.ini" QC_VM_HOST="$VM_HOST" QC_NO_MEMORY_FORWARD=1
export QC_RELEASE_DOWNLOAD_CMD="$CTL/release-download.sh \"\$@\"" QC_TAG_DIGEST_CMD="$CTL/tag-digest.sh \"\$@\""
export QCR_GHCR_EXPIRY_FILE="$CTL/ghcr-token-expiry"
date -u -d '+300 days' +%Y-%m-%dT%H:%M:%SZ >"$QCR_GHCR_EXPIRY_FILE"
export QC_HEARTBEAT_WAIT_S=120 QC_MEMORY_WAIT_S=180
cat >"$QC_INVENTORY" <<EOF
[quickreview]
$VM_HOST sandbox_root=$H container_uid=$(id -u) release_image=$REPO_D release_memory_image=$REPO_M memory_network=$NET timezone=UTC memory_state_dir=$H/memory-state openviking_home=$H/state/openviking backup_dir=$VM/backups update_state_dir=$VM/lib memory_ready_timeout_s=240 cloudflared_enabled=false
EOF

# =================================================================================================
# PHASE 2 — the pristine legacy host: layout, the stub's identity, the legacy store
# =================================================================================================
make_pristine() {
  log "laying out the legacy-shaped host directory"
  teardown_containers
  rm_host "$H"; rm_host "$TLS"; rm_host "$PRISTINE"
  mkdir -p "$TLS"
  "$WRH/layout.sh" "$H" "$TLS" >"$LOGS/layout.log" 2>&1 || { tail -20 "$LOGS/layout.log" >&2; die "layout failed"; }
  # The base clone's origin and the fixture "GitHub" live inside the state mount (the updater's recreate
  # has no extra mounts), the stub's CA beside them.
  mkdir -p "$H/state/rehearsal"
  mv "$H/remote.git" "$H/state/rehearsal/remote.git"
  ln -s state/rehearsal/remote.git "$H/remote.git"
  git -C "$H/sandbox/base-clone" remote set-url origin /opt/qcr/state/rehearsal/remote.git
  cp "$TLS/ca.pem" "$H/state/rehearsal/ca.pem"
  chmod -R a+rX "$H/state/rehearsal"
  cat >"$VM/daemon.env" <<ENVF
NODE_EXTRA_CA_CERTS=/opt/qcr/state/rehearsal/ca.pem
SSL_CERT_FILE=/opt/qcr/state/rehearsal/ca.pem
CURL_CA_BUNDLE=/opt/qcr/state/rehearsal/ca.pem
GIT_SSL_CAINFO=/opt/qcr/state/rehearsal/ca.pem
ENVF
  cp "$H/state/pi-sessions/pr-$PR/"*.jsonl "$WORK/legacy-original.jsonl"
  cp "$H/state/state.db" "$WORK/legacy-state.db"

  # Two configs. The controller's is the NEW world's (what runbook A.5 edits the config home to) and
  # carries the operator's [tui] block (the ssh target, as the owner's, and — like the owner's — no
  # remote_sandbox_root and no remote_state_dir). The legacy host's own is the OLD world's.
  cp "$H/config-home/config.toml" "$CFGHOME/config.toml"
  # the sidecar's supervisor reads its OpenViking home from config.toml and the entrypoint from the run
  # spec: the host directory stands at its real path inside the sidecar, so config.toml names that path
  # (on the real VM both are /opt/quickreview/state/openviking)
  node "$WRH/patch-toml.mjs" "$CFGHOME/config.toml" "openviking.home=\"$H/state/openviking\""
  node "$WRH/patch-toml.mjs" "$CFGHOME/config.toml" 'tui.target="ssh"' 'tui.sudo_docker=true' "tui.ssh_host=\"$VM_HOST\"" "tui.container=\"$DAEMON\""
  cp "$CFGHOME/config.toml" "$CTL/operator.toml"
  cp "$CFGHOME/config.toml" "$WORK/new-world-config.toml"
  cp "$H/config-home/config.toml" "$H/config-home/config.toml.new"; rm "$H/config-home/config.toml.new"
  node "$WRH/patch-toml.mjs" "$H/config-home/config.toml" 'openviking.endpoint="local"' 'daemon.lens_permits=0'
  printf '\n# the legacy world (before runbook A.5)\n[engine]\nruntime = "proc"\n' >>"$H/config-home/config.toml"
  sed -i '/^lens_permits *= *0/d' "$H/config-home/config.toml"
  rm -rf "$CFGHOME/profiles"
  # PR 7 is not in the legacy db (the webhook creates it); the legacy store is made by a sidecar boot below
  mkdir -p "$H/memory-state"

  log "making the legacy OpenViking store (a sidecar boot on the layout's secrets, as the legacy daemon's own store was)"
  docker network create --internal "$NET" >/dev/null || die "no network"
  local scr="$WORK/scratch-store"; rm_host "$scr"; mkdir -p "$scr"
  docker run -d --name "$SCRATCH_MEM" --user "$UIDGID" --network "$NET" \
    -v "$scr:$H/state/openviking" -v "$H/secrets:/opt/quickreview/secrets:ro" -v "$CFGHOME:/opt/quickreview/config-home:ro" \
    -e TZ=UTC -e QCR_CONFIG=/opt/quickreview/config-home/config.toml \
    -e QCR_OPENVIKING_HOME="$H/state/openviking" -e QCR_OPENVIKING_PORT=1933 -e QCR_OPENVIKING_BIND_HOST=0.0.0.0 \
    -e QCR_OPENVIKING_WORKERS=1 -e QCR_OPENVIKING_QUEUE_CONCURRENCY=2 -e QCR_OPENVIKING_AUTH_MODE=api_key \
    -e QCR_OPENVIKING_EMBEDDING_PROVIDER=local -e QCR_OPENVIKING_LOCAL_EMBEDDER_PORT=1934 -e QCR_OPENVIKING_LOCAL_EMBEDDER_THREADS=1 \
    -e QCR_OPENVIKING_PROVISION_USERS=reviewer,companion "$MEM_IMG" >/dev/null || die "scratch sidecar did not start"
  scratch_ready() { docker exec "$SCRATCH_MEM" curl -fsS http://127.0.0.1:1933/ready; }
  wait_for 300 "the scratch sidecar's /ready" scratch_ready || { docker logs --tail 40 "$SCRATCH_MEM" >&2; die "scratch sidecar never ready"; }
  read_key() {
    docker exec "$SCRATCH_MEM" sh -c 'cd /opt/qcr && node --input-type=module -e "
import { readFileSync } from \"node:fs\";
const m = await import(\"/opt/qcr/scripts/openviking-provision.mjs\");
const rootKey = readFileSync(\"/opt/quickreview/secrets/openviking_root_key\",\"utf8\").trim();
const r = await m.mintUserKeys({ base: \"http://127.0.0.1:1933\", account: \"default\", users: [\"reviewer\",\"companion\"], rootKey });
process.stdout.write(r.keys.reviewer ?? \"\");
"' >"$H/secrets/openviking_reviewer_key" 2>/dev/null && [[ -s "$H/secrets/openviking_reviewer_key" ]]
  }
  wait_for 90 "the scratch sidecar's users" read_key || die "could not read the reviewer key back"
  chmod 600 "$H/secrets/openviking_reviewer_key"
  docker restart "$SCRATCH_MEM" >/dev/null
  wait_for 300 "the scratch sidecar after its restart" scratch_ready || die "scratch sidecar did not come back"
  sleep 3
  docker stop -t 60 "$SCRATCH_MEM" >/dev/null && docker rm "$SCRATCH_MEM" >/dev/null
  docker network rm "$NET" >/dev/null
  cp -a "$scr/." "$H/state/openviking/" 2>/dev/null || { mkdir -p "$H/state/openviking" && cp -a "$scr/." "$H/state/openviking/"; }
  rm_host "$scr"
  chmod 700 "$H/state/openviking"
  fact legacy_store "$(find "$H/state/openviking" -type f | wc -l) files, $(du -sh "$H/state/openviking" | cut -f1); checksum $(tree_sum "$H/state/openviking")"

  log "saving the pristine host"
  cp -a "$H" "$PRISTINE"
  phase_mark pristine
}
if [[ "$FRESH" == 1 ]] || ! phase_done pristine || [[ ! -d "$PRISTINE" ]]; then make_pristine; fi

reset_host() {
  log "resetting the host to the pristine legacy state"
  teardown_containers
  rm_host "$H"
  cp -a "$PRISTINE" "$H"
  rm -f "$VM/lib/"* "$VM/etc/qcr/update.conf" "$VM/inject/"* "$VM/ssh-commands.log"
  rm -rf "$VM/backups" && mkdir -p "$VM/backups"
  rm -f "$CTL/wizard.state"
  cp "$WORK/new-world-config.toml" "$CFGHOME/config.toml"
  : >"$LOGS/stub.jsonl"; chmod 666 "$LOGS/stub.jsonl"
}

# =================================================================================================
# PHASE 3 — the cutover
# =================================================================================================
op() { QCR_CONFIG="$CTL/operator.toml" node "$ROOT/dist/src/cli.js" "$@"; }
export CUTOVER_QCR="$CTL/qcr-op"
cat >"$CTL/qcr-op" <<EOF
#!/usr/bin/env bash
# scripts/qcr for the rehearsal's operator: \`config check --config-home\` as given, everything else on the [tui] ssh target
if [[ "\${1:-}" == config ]]; then exec node "$ROOT/dist/src/cli.js" "\$@"; fi
QCR_CONFIG="$CTL/operator.toml" exec node "$ROOT/dist/src/cli.js" "\$@"
EOF
chmod +x "$CTL/qcr-op"
DEPLOY="$ROOT/scripts/deploy.sh"
vm() { "$RH/ctl-shims/ssh" "$VM_HOST" "$@"; }
vmstatus() { vm 'sudo qcr-update status --json' 2>/dev/null; }
vmfield() { python3 -c "import json,sys;d=json.load(sys.stdin);v=d
for k in sys.argv[1].split('.'): v=(v or {}).get(k) if isinstance(v,dict) else None
print('' if v is None else v)" "$1" 2>/dev/null; }

start_stub() {
  docker network create --internal "$NET" >/dev/null 2>&1
  docker rm -f "$STUB" >/dev/null 2>&1
  docker run -d --name "$STUB" --network "$NET" --network-alias stub --network-alias api.github.com --network-alias auth.openai.com \
    -v "$WRH/stub.mjs:/stub.mjs:ro" -v "$H/fixture.json:/fixture.json:ro" -v "$TLS:/tls:ro" -v "$LOGS:/logs" \
    node:22-bookworm-slim node /stub.mjs /fixture.json /tls /logs/stub.jsonl >/dev/null || die "stub did not start"
  wait_for 20 "the stub" grep -q '"port":8080' "$LOGS/stub.jsonl" || die "the stub is not up"
}
start_legacy() {
  docker run -d --name "$DAEMON" --restart unless-stopped --init --network none --user "$UIDGID" \
    -v "$H/state:/opt/quickreview/state" -v "$H/sandbox:/opt/quickreview/sandbox" -v "$H/config-home:/opt/quickreview/config-home:ro" \
    -v "$H/secrets:/opt/quickreview/secrets:ro" -v "$H/pihome:/home/qcr/.pi" \
    -v "$LEGACY_CACHE/dist:/opt/legacy/dist:ro" -v "$RH/legacy-daemon.mjs:/opt/legacy/daemon.mjs:ro" \
    "$LEG_IMG" /opt/legacy/daemon.mjs >/dev/null
}
legacy_boots() { docker logs "$DAEMON" 2>&1 | grep -c 'legacy-standin.*booted'; }
legacy_lifts() { docker logs "$DAEMON" 2>&1 | grep -c 'drain_lifted'; }
legacy_drains() { docker logs "$DAEMON" 2>&1 | grep -c 'drain on by the operator'; }
hb_drained() { [[ "$(status_get draining)" == True && "$(status_get running_rounds)" == 0 ]]; }
hb_not_drained() { [[ -z "$(status_get draining)" || "$(status_get draining)" == False ]] && [[ -n "$(status_get written_at)" ]]; }

run_release() { # <version> <log>: deploy.sh release, QCR_CUTOVER_ACK set as the wizard sets it
  QCR_CUTOVER_ACK="$1" "$DEPLOY" release "$1" >"$2" 2>&1
}
last_run() { python3 -c "import json;d=json.load(open('$VM/lib/last-run.json'));print(d['result'],d['step'])" 2>/dev/null; }

# the facts of the legacy host that an injected failure must leave alone
legacy_snapshot() { # <label>
  local f="$WORK/snap-$1"
  {
    echo "container=$(docker inspect -f '{{.Id}}' "$DAEMON" 2>/dev/null | cut -c1-12)"
    echo "started=$(docker inspect -f '{{.State.StartedAt}}' "$DAEMON" 2>/dev/null)"
    echo "config=$(sha256sum "$H/config-home/config.toml" | cut -c1-16)"
    echo "store=$(tree_sum "$H/state/openviking")"
    echo "tables=$(tables "$H/state/state.db")"
    echo "boots=$(legacy_boots)"
  } >"$f"
}
snap_get() { sed -n "s/^$2=//p" "$WORK/snap-$1"; }

# check_rescued <id> <title> <version> <expected last-run> <restarted: 0|1> <extra detail>: the common post-conditions of an injected failure
check_rescued() {
  local id="$1" title="$2" ver="$3" want="$4" restarted="$5" extra="$6" rc="${7:-}" problems="" lr
  legacy_snapshot after
  [[ "$rc" != 0 && -n "$rc" ]] || problems+="exit code was '$rc' (want non-zero); "
  lr="$(last_run)"
  [[ "$lr" == "$want" ]] || problems+="last run '$lr' (want '$want'); "
  [[ "$(docker inspect -f '{{.State.Running}}' "$DAEMON" 2>/dev/null)" == true ]] || problems+="the legacy container is not running; "
  [[ "$(label_of "$DAEMON" qcr.layout)" == "" ]] || problems+="the running container is not the legacy one; "
  [[ "$(snap_get before container)" == "$(snap_get after container)" ]] || problems+="the legacy container was REPLACED (id changed); "
  [[ "$(snap_get before config)" == "$(snap_get after config)" ]] || problems+="the legacy config changed; "
  [[ "$(snap_get before store)" == "$(snap_get after store)" ]] || problems+="the legacy OpenViking store changed; "
  [[ "$(snap_get before tables)" == "$(snap_get after tables)" ]] || problems+="the legacy state.db schema changed; "
  docker inspect "$MEMORY" >/dev/null 2>&1 && problems+="a sidecar container is left behind; "
  docker inspect "$DAEMON-prev" >/dev/null 2>&1 && problems+="a $DAEMON-prev container is left behind; "
  [[ -d "$H/config-home.next" ]] && problems+="config-home.next is left behind; "
  [[ -e "$H/config-home.prev" ]] && problems+="config-home.prev is left behind (the swap was not undone); "
  local lifts_before drains_before
  if [[ "$restarted" == 1 ]]; then
    [[ "$(snap_get after boots)" -eq $(( $(snap_get before boots) + 1 )) ]] || problems+="the legacy bot booted $(( $(snap_get after boots) - $(snap_get before boots) )) time(s) (want 1); "
    [[ "$(legacy_lifts)" -gt "${LIFTS_BEFORE:-0}" ]] || problems+="the legacy boot's first reconcile did not lift the drain; "
    [[ "$(legacy_drains)" -gt "${DRAINS_BEFORE:-0}" ]] || problems+="no drain on was re-sent after the first reconcile; "
  else
    [[ "$(snap_get after boots)" == "$(snap_get before boots)" ]] || problems+="the legacy bot was restarted (it must not be: nothing had changed); "
    [[ "$(snap_get before started)" == "$(snap_get after started)" ]] || problems+="the legacy container's start time moved; "
  fi
  # drained: the heartbeat (a fresh one) and the db row, by the operator
  sleep 3
  local d_db; d_db="$(sql 'select draining||issued_by from drain_state')"
  [[ "$(status_get draining)" == True && "$(status_get draining_by)" == operator && "$(status_get running_rounds)" == 0 ]] || problems+="the heartbeat does not show the operator's drain; "
  [[ "$d_db" == 1operator ]] || problems+="drain_state row is '$d_db'; "
  if [[ -z "$problems" ]]; then
    check "$id" pass "$title" "$extra; exit $rc, last run '$lr'; the legacy container $(snap_get after container) kept its id, config (sha $(snap_get after config)), OpenViking store (checksum $(snap_get after store)) and legacy schema ($(snap_get after tables) tables); no sidecar, no -prev container, no .next/.prev; drained by the operator again with 0 rounds; legacy bot boots $(snap_get before boots) -> $(snap_get after boots), drain lifts $LIFTS_BEFORE -> $(legacy_lifts), drain-on commands $DRAINS_BEFORE -> $(legacy_drains)"
  else
    check "$id" fail "$title" "$problems $extra (see $LOGS)"
  fi
}

reset_host
log "starting the legacy world: the legacy bot, the network and the stub"
start_stub
start_legacy || die "the legacy stand-in did not start"
wait_for 60 "the legacy bot's first reconcile" bash -c "docker logs $DAEMON 2>&1 | grep -q 'reconcile: open=0'" || { docker logs --tail 20 "$DAEMON" >&2; die "the legacy stand-in never reconciled"; }
sleep 3

# ---- NET-1: the world has no way out ---------------------------------------------------------------------
INTERNAL="$(docker network inspect -f '{{.Internal}}' "$NET")"
EGRESS="$(docker run --rm --network "$NET" --entrypoint sh "$REL_IMG" -c 'curl -sS -m 5 -o /dev/null -w "%{http_code}" https://example.com 2>&1; echo " rc=$?"; getent hosts example.com >/dev/null 2>&1 && echo resolved || echo unresolved' 2>&1 | tr '\n' ' ')"
VIA_STUB="$(docker run --rm --network "$NET" -v "$TLS/ca.pem:/ca.pem:ro" --entrypoint sh "$REL_IMG" -c 'curl -sS -m 5 --cacert /ca.pem -o /dev/null -w "%{http_code}" https://api.github.com/app/installations' 2>&1)"
BLOCKED_OK=no; [[ "$EGRESS" == *"rc=6"* || "$EGRESS" == *"rc=28"* || "$EGRESS" == *"rc=7"* ]] && BLOCKED_OK=yes
if [[ "$INTERNAL" == true && "$BLOCKED_OK" == yes && "$VIA_STUB" == 200 ]]; then
  check NET-1 pass "the containers' network is internal: example.com is unreachable, api.github.com is the stub" "internal=$INTERNAL; example.com: $EGRESS; api.github.com via the stub: HTTP $VIA_STUB; the legacy stand-in runs --network none"
else
  check NET-1 fail "the containers' network is internal" "internal=$INTERNAL; example.com: $EGRESS; stub: $VIA_STUB"
fi

# ---- HOST-1 / PROV-1: provision, and the updater answers -----------------------------------------------------
LEGACY_TABLES="$(tables "$H/state/state.db")"
PROVISION_LOG="$LOGS/provision.log"
"$DEPLOY" provision >"$PROVISION_LOG" 2>&1; PROV_RC=$?
ST="$(vmstatus)"
LAYOUT="$(vmfield layout <<<"$ST")"
FP_VM="$(vmfield runspec.fingerprint <<<"$ST")"
FP_CONF="$(sed -n 's/^RUNSPEC_FINGERPRINT=//p' "$VM/etc/qcr/update.conf" 2>/dev/null)"
if [[ "$PROV_RC" == 0 && "$LAYOUT" == legacy && -n "$FP_VM" && "$FP_VM" == "$FP_CONF" && -f "$VM/ansible-playbook.log" ]]; then
  check PROV-1 pass "deploy.sh provision installs the run spec; \`sudo qcr-update status --json\` answers over ssh and shows layout=legacy" "provision rc 0 (ansible-playbook is a stub that installs the rendered update.conf); layout=$LAYOUT; run spec v$(vmfield runspec.version <<<"$ST") fingerprint $(printf '%s' "$FP_VM" | cut -c1-16)…; the stand-in container has no qcr.layout label ($(label_of "$DAEMON" qcr.layout | sed 's/^$/none/'))"
else
  check PROV-1 fail "deploy.sh provision and qcr-update status" "rc=$PROV_RC layout='$LAYOUT' fp_vm='$FP_VM' fp_conf='$FP_CONF'; $(tail -5 "$PROVISION_LOG" | tr '\n' ' ')"
fi
check HOST-1 pass "the legacy host: a legacy-shaped bot is running over a state.db the LEGACY build wrote, with the legacy config and a populated OpenViking store" \
  "container $DAEMON (image $LEG_IMG, no qcr.layout label), state.db $LEGACY_TABLES tables (the legacy schema), config-home holds the old-world config ([engine] runtime = \"proc\", openviking.endpoint local), $(find "$H/state/openviking" -type f | wc -l) store files; no sidecar yet"

# ---- DRAIN-0: the operator drains (wizard stage 2) ------------------------------------------------------------------
op drain on >"$WORK/drain-on.txt" 2>&1; DRC=$?
wait_for 30 "the drain in the heartbeat" hb_drained
if [[ "$DRC" == 0 && "$(status_get draining_by)" == operator && "$(status_get draining_hold)" == "" ]]; then
  check DRAIN-0 pass "qcr drain on drains the legacy bot (the operator's plain drain: the legacy daemon cannot spell a hold)" "$(tr '\n' ' ' <"$WORK/drain-on.txt" | cut -c1-240) draining_by=operator running_rounds=0 pending_wakes=$(status_get pending_wakes)"
else
  check DRAIN-0 fail "qcr drain on drains the legacy bot" "rc=$DRC $(cat "$WORK/drain-on.txt" | tr '\n' ' ')"
fi
legacy_snapshot before
LIFTS_BEFORE="$(legacy_lifts)"; DRAINS_BEFORE="$(legacy_drains)"

# ---- PLAN-1: the dry run -----------------------------------------------------------------------------------------------
QCR_CUTOVER_ACK="$VERSION" "$DEPLOY" --dry-run release "$VERSION" >"$LOGS/plan.log" 2>&1; PLAN_RC=$?
want_in_plan() { grep -qE -- "$1" "$LOGS/plan.log" && echo "" || echo "missing: $2; "; }
MISS=""
MISS+="$(want_in_plan 'layout legacy' 'the legacy layout')"
MISS+="$(want_in_plan "daemon localhost:$REG_PORT/qcr/quickreview@sha256:[0-9a-f]{64}" 'the daemon image by digest')"
MISS+="$(want_in_plan "memory localhost:$REG_PORT/qcr/quickreview-memory@sha256:[0-9a-f]{64}" 'the memory image by digest')"
MISS+="$(want_in_plan 'pull both images by digest' 'a pull by digest')"
MISS+="$(want_in_plan 'qcr config check' 'the config check by the new image')"
MISS+="$(want_in_plan 'stop the daemon container; snapshot' 'stop then snapshot')"
MISS+="$(want_in_plan 'daemon --preflight' 'the preflight')"
MISS+="$(want_in_plan 'seed the sidecar store' 'the sidecar seed')"
MISS+="$(want_in_plan 'swap the config' 'the config swap')"
MISS+="$(want_in_plan 'wait for /ready; recreate the daemon container' 'the sidecar /ready then the recreate')"
MISS+="$(want_in_plan 'cutover +first run on the legacy layout, acknowledged' 'the cutover acknowledgement')"
MISS+="$(want_in_plan 'POINT OF NO RETURN' 'the recreate named as the point of no return')"
if [[ "$PLAN_RC" == 0 && -z "$MISS" ]]; then
  check PLAN-1 pass "the dry-run plan shows what runbook C.11 asks for" "legacy layout, the manifest digests and a pull by digest, the new image's config check, stop then snapshot then preflight, the seed, the swap, sidecar /ready, the recreate named as the point of no return; nothing executed"
else
  check PLAN-1 fail "the dry-run plan shows what runbook C.11 asks for" "rc=$PLAN_RC ${MISS}(see $LOGS/plan.log)"
fi

# =================================================================================================
# the four injected failures, each from a drained legacy state
# =================================================================================================

# ---- INJ-1: a failed config check: nothing changes ----------------------------------------------------------------------------
log "INJ-1: the config check fails (a retired key in the shipped config)"
cp "$CFGHOME/config.toml" "$WORK/config.good"
printf '\n[engine]\nruntime = "proc"\n' >>"$CFGHOME/config.toml"
run_release 0.9.1 "$LOGS/inj1-release.log"; RC1=$?
cp "$WORK/config.good" "$CFGHOME/config.toml"
CC_LINE="$(grep -m1 "config check" "$LOGS/inj1-release.log" | cut -c1-200)"
if [[ "$RC1" != 0 ]] && grep -qE "(deploy.sh|deploy): .*(refusing|qcr-update failed)|step 'config-check'" "$LOGS/inj1-release.log"; then
  check_rescued INJ-1 "a failed config check changes nothing: the legacy bot is never stopped and stays drained" 0.9.1 "refused config-check" 0 "the new image's config check refused the shipped config (a retired [engine] runtime key): ${CC_LINE:-see log}" "$RC1"
else
  check INJ-1 fail "a failed config check changes nothing" "rc=$RC1: $(tail -5 "$LOGS/inj1-release.log" | tr '\n' ' ')"
fi
LIFTS_BEFORE="$(legacy_lifts)"; DRAINS_BEFORE="$(legacy_drains)"; legacy_snapshot before

# ---- INJ-2: a failed preflight ----------------------------------------------------------------------------------------------------
log "INJ-2: the preflight fails (an open PR whose session cannot be resumed)"
docker exec "$DAEMON" node --input-type=module -e '
  const { StateStore } = await import("/opt/legacy/dist/src/state.js");
  const s = new StateStore("/opt/quickreview/state/state.db");
  s.upsertPr({ number: 8, state: "tracked", head_sha: "8".repeat(40), title: "A PR whose session is damaged", author: "carol", trigger_ts: "2026-10-18T09:30:00.000Z", stale_recheck: 0, escalation_worthy: 0, migration_gate: 0 });
  s.db.close();' >/dev/null 2>&1
mkdir -p "$H/state/pi-sessions/pr-8"
printf '{"type":"session","version":3,"id":"rh-damaged","cwd":"/opt/quickreview/sandbox"}\n{"type":"message", this line was cut off by a full disk\n' >"$H/state/pi-sessions/pr-8/2026-10-18T09-30-00-000Z_rh-damaged.jsonl"
legacy_snapshot before
LIFTS_BEFORE="$(legacy_lifts)"; DRAINS_BEFORE="$(legacy_drains)"
run_release 0.9.2 "$LOGS/inj2-release.log"; RC2=$?
PF_LINE="$(grep -m1 -E "cannot be resumed|resume" "$LOGS/inj2-release.log" | cut -c1-220)"
check_rescued INJ-2 "a failed preflight is rescued: the legacy bot is restarted on its old config and drained after its first reconcile" 0.9.2 "rescued preflight" 1 "daemon --preflight of the new image refused the scratch copy of the snapshot: ${PF_LINE:-see log}; the snapshot stayed under the backup dir ($(ls "$VM/backups" | tr '\n' ' '))" "$RC2"
# put the host back: the damaged PR was only the injection
sqlite3 "$H/state/state.db" "delete from pr_state where number=8" 2>/dev/null
rm -rf "$H/state/pi-sessions/pr-8"

# ---- INJ-3: a failed store copy -----------------------------------------------------------------------------------------------------
log "INJ-3: the sidecar store copy fails its checksum verification"
: >"$VM/inject/rsync-corrupt"
legacy_snapshot before
LIFTS_BEFORE="$(legacy_lifts)"; DRAINS_BEFORE="$(legacy_drains)"
run_release 0.9.3 "$LOGS/inj3-release.log"; RC3=$?
rm -f "$VM/inject/rsync-corrupt"
SEED_LINE="$(grep -m1 "does not verify by checksum" "$LOGS/inj3-release.log" | cut -c1-200)"
SEEDED=no; [[ -e "$H/memory-state/.seeded-from-daemon" ]] && SEEDED=yes
check_rescued INJ-3 "a failed store copy is rescued: the legacy bot is restarted on its old config and drained after its first reconcile" 0.9.3 "rescued seed" 1 "the updater's checksum verification caught a byte flipped in the copy: ${SEED_LINE:-see log}; the 'seeded' marker written: $SEEDED; the config swap had not happened" "$RC3"
[[ "$SEEDED" == no ]] || check INJ-3b fail "a store copy that failed verification leaves no seeded marker" "marker present"

# ---- INJ-4: a sidecar that never becomes ready ----------------------------------------------------------------------------------------
log "INJ-4: the memory sidecar never becomes ready"
echo 25 >"$VM/inject/ready-timeout"
legacy_snapshot before
LIFTS_BEFORE="$(legacy_lifts)"; DRAINS_BEFORE="$(legacy_drains)"
run_release 0.9.4 "$LOGS/inj4-release.log"; RC4=$?
rm -f "$VM/inject/ready-timeout"
RDY_LINE="$(grep -m1 "not ready within" "$LOGS/inj4-release.log" | cut -c1-200)"
check_rescued INJ-4 "a sidecar that never becomes ready is rescued: config swapped back, the sidecar removed, the legacy bot restarted and drained after its first reconcile" 0.9.4 "rescued sidecar-ready" 1 "the sidecar from the never-ready memory image ($BROKEN_IMG) was pulled and started, the config had been SWAPPED and the store SEEDED: ${RDY_LINE:-see log}; seeded marker $( [[ -e "$H/memory-state/.seeded-from-daemon" ]] && echo present || echo absent ) (the retry will say 'already seeded'); config-home.failed kept for the post-mortem: $( [[ -d "$H/config-home.failed" ]] && echo yes || echo no )" "$RC4"
fact backups "$(ls "$VM/backups" | tr '\n' ' ')"
fact update_log "$(grep -c . "$VM/lib/update.log" 2>/dev/null) lines in the updater's update.log across the four rescues and the clean run"
legacy_snapshot before
LIFTS_BEFORE="$(legacy_lifts)"; DRAINS_BEFORE="$(legacy_drains)"

# =================================================================================================
# the clean run: the wizard, stage by stage
# =================================================================================================
log "the clean run: scripts/cutover.sh $VERSION"
# the wizard's seams: a local bare 'origin' named like the real one, with the tag on it
GITD="$CTL/git"; rm -rf "$GITD"; mkdir -p "$GITD/quickchatai"
git init -q --bare "$GITD/quickchatai/quickreview.git"
git clone -q "$GITD/quickchatai/quickreview.git" "$GITD/checkout" 2>/dev/null
git -C "$GITD/checkout" -c user.email=r@example.test -c user.name=rehearsal commit -q --allow-empty -m "release $VERSION"
git -C "$GITD/checkout" tag "v$VERSION"
git -C "$GITD/checkout" push -q origin HEAD:refs/heads/main "v$VERSION" 2>/dev/null
export CUTOVER_GIT_DIR="$GITD/checkout" CUTOVER_STATE="$CTL/wizard.state" CUTOVER_POLL_S=2 CUTOVER_MAX_POLLS=90
export CUTOVER_PRS_CMD="echo '$PR $(python3 -c "import json;print(json.load(open('$H/fixture.json'))['head_sha'])")'"
export QC_RELEASE_REPO=quickchatai/quickreview

# run A: preconditions, drain, plan, the release (the typed go), verify, the first reconcile, the backstop, the surfaces;
# it stops at stage 9, which asks whether a worker round was checked (EOF: not answered).
python3 "$RH/answer.py" --timeout 300 \
  --on 'Ready to start\?=>\n' --on 'Does the plan show all of that\?.*\[y/N\]=>y\n' --on "Type the version.*=>$VERSION\n" \
  --on 'Does verify show all of that\?.*\[y/N\]=>y\n' --on 'Both done\?.*\[y/N\]=>y\n' \
  --on 'PR number for the commands below.*=>\n' --on 'Was the worker round checked and is it good\?.*\[y/N\]=>n\n' \
  -- "$ROOT/scripts/cutover.sh" "$VERSION" >"$LOGS/wizard-a.log" 2>&1; WA_RC=$?
sed -i 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$LOGS/wizard-a.log"
STAGES_DONE="$(grep -o 'done:[a-z_0-9]*' "$CTL/wizard.state" 2>/dev/null | sed 's/done://' | tr '\n' ' ')"
fact wizard_a "rc=$WA_RC; stages recorded: $STAGES_DONE"
log "wizard run A: rc=$WA_RC; stages done: $STAGES_DONE"
tail -22 "$LOGS/wizard-a.log" | sed 's/^/    | /' >&2

A_MISSING=""
for st in preconditions drain plan release verify reconcile backstop surfaces; do
  grep -qx "done:$st" "$CTL/wizard.state" 2>/dev/null || A_MISSING+="$st "
done
if [[ -z "$A_MISSING" && "$WA_RC" == 1 ]] && grep -q "Stopped at stage 9" "$LOGS/wizard-a.log"; then
  check WIZ-A pass "scripts/cutover.sh runs stages 1-8 (preconditions, drain, plan, release, verify, first reconcile, backstop, surfaces) and stops at stage 9" "stages recorded: $STAGES_DONE; stopped at stage 9 with the drain held (no answer to the worker-round question)"
else
  check WIZ-A fail "scripts/cutover.sh runs stages 1-8 and stops at stage 9" "rc=$WA_RC missing stages: ${A_MISSING:-none}; log $LOGS/wizard-a.log"
fi

# ---- CUT-1: the point of no return, as it stands ------------------------------------------------------------------------------
ST="$(vmstatus)"
D_IMG="$(docker inspect -f '{{.Config.Image}}' "$DAEMON" 2>/dev/null)"; M_IMG="$(docker inspect -f '{{.Config.Image}}' "$MEMORY" 2>/dev/null)"
P=""
[[ "$(vmfield layout <<<"$ST")" == release ]] || P+="layout is '$(vmfield layout <<<"$ST")'; "
[[ "$D_IMG" == "$REPO_D@$(digest_of $VERSION 2)" ]] || P+="the daemon runs '$D_IMG', not the manifest's digest; "
[[ "$M_IMG" == "$REPO_M@$(digest_of $VERSION 3)" ]] || P+="the sidecar runs '$M_IMG', not the manifest's digest; "
[[ "$(label_of "$DAEMON" qcr.build-sha)" == "$IMG_SHA" ]] || P+="build-sha label '$(label_of "$DAEMON" qcr.build-sha)'; "
[[ "$(docker inspect -f '{{.State.Running}}' "$DAEMON" "$MEMORY" | tr '\n' ' ')" == "true true " ]] || P+="not both containers running; "
[[ "$(docker inspect -f '{{.State.Running}}' "$DAEMON-prev" 2>/dev/null)" == false && -z "$(label_of "$DAEMON-prev" qcr.layout)" ]] || P+="the legacy container is not kept stopped as $DAEMON-prev; "
[[ "$(last_run | cut -d' ' -f1)" == ok ]] || P+="last run '$(last_run)'; "
[[ "$(sha256sum "$H/config-home/config.toml" | cut -c1-16)" == "$(sha256sum "$CFGHOME/config.toml" | cut -c1-16)" ]] || P+="config-home is not the shipped config; "
[[ "$(sha256sum "$H/config-home.prev/config.toml" | cut -c1-16)" == "$(snap_get before config)" ]] || P+="config-home.prev is not the legacy config; "
grep -qE "sidecar store (seeded from .*copy verified|already seeded)" "$VM/lib/update.log" || P+="the updater did not log a verified store copy; "
[[ "$(tree_sum "$H/state/openviking")" == "$(snap_get before store)" ]] || P+="the daemon's old store changed; "
BK="$(ls -d "$VM/backups/$VERSION-"* 2>/dev/null | tail -1)"
[[ -f "$BK/state.db" && -f "$BK/pi-sessions.tar.gz" ]] || P+="no snapshot of state.db and the sessions under $VM/backups; "
if [[ -z "$P" ]]; then
  check CUT-1 pass "the clean run passes the point of no return: both containers recreated by digest from the registry, config swapped, store seeded, snapshot kept" \
    "daemon $D_IMG (qcr.build-sha $(label_of "$DAEMON" qcr.build-sha | cut -c1-12)) and sidecar $M_IMG running; the legacy container kept stopped as $DAEMON-prev; config-home = the shipped config, config-home.prev = the legacy config; sidecar store = the legacy store (verified copy, original untouched); snapshot $(basename "$BK"): $(ls "$BK" | tr '\n' ' ')modes $(stat -c %a "$BK/state.db"); last run: $(cat "$VM/lib/last-run.json" | cut -c1-160)"
else
  check CUT-1 fail "the clean run passes the point of no return" "$P"
fi

# ---- MIG-1: the first boot migrated the legacy db forward, nothing lost -------------------------------------------------------------
python3 - "$BK/state.db" "$H/state/state.db" >"$WORK/schema-diff.txt" <<'PY'
import sqlite3, sys
old = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True); new = sqlite3.connect("file:%s?mode=ro" % sys.argv[2], uri=True)
def schema(c):
    return {t: [r[1] for r in c.execute("pragma table_info(%s)" % t)] for (t,) in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")}
a, b = schema(old), schema(new)
lost = [t for t in a if t not in b] + ["%s.%s" % (t, c) for t in a if t in b for c in a[t] if c not in b[t]]
print("legacy_tables=%d migrated_tables=%d" % (len(a), len(b)))
print("tables_added=%d" % len([t for t in b if t not in a]))
print("LOST=%s" % (",".join(lost) or "none"))
PY
if [[ "$(grep '^LOST=' "$WORK/schema-diff.txt" | cut -d= -f2)" == none && "$(sql "select count(*) from events where kind='legacy_fixture'")" == 1 && "$(sql 'select state from pr_state where number=6')" == closed ]]; then
  check MIG-1 pass "the release's first boot migrated the legacy state.db forward: nothing lost, the legacy rows kept" "$(tr '\n' ' ' <"$WORK/schema-diff.txt")legacy event and closed PR 6 survive; the snapshot the updater took ($(basename "$BK")) is still the legacy file ($(tables "$BK/state.db") tables)"
else
  check MIG-1 fail "the first boot migrated the legacy db forward" "$(tr '\n' ' ' <"$WORK/schema-diff.txt")"
fi

# ---- VERIFY-1: deploy.sh verify, as the wizard ran it at stage 5 ----------------------------------------------------------------
if ! grep -q "CHECK FAILED" "$LOGS/wizard-a.log" && grep -q "heartbeat written by this boot" "$LOGS/wizard-a.log" && grep -q "memory sidecar search" "$LOGS/wizard-a.log"; then
  check VERIFY-1 pass "deploy.sh verify (the wizard's stage 5) passes: both containers up, build stamp, fresh heartbeat, pi settings and the AGENTS.override stub, sidecar ready and a memory search from the daemon's container" "no CHECK FAILED in the wizard's output; $(grep -c '^--- ' "$LOGS/wizard-a.log") checks ran"
else
  check VERIFY-1 fail "deploy.sh verify passes" "$(grep -E 'CHECK FAILED' "$LOGS/wizard-a.log" | head -3 | tr '\n' ' ')"
fi
check_verify_extra() {
  local ps; ps="$(dx sh -c 'for p in /proc/[0-9]*; do [ -r $p/stat ] || continue; printf "%s %s\n" "${p#/proc/}" "$(tr "\0" " " <$p/cmdline | cut -c1-120)"; done')"
  local pi tmuxn
  pi="$(grep -cE ' (pi|.*/pi) |bin/pi|pi-coding-agent' <<<"$ps")"
  # the entrypoint still starts a tmux server and one empty `main` shell session (the jump-in surface and
  # the host of takeover/debug panes): that is not a PR session; anything else is
  tmuxn="$(dx tmux ls 2>/dev/null | grep -vc '^main:')"
  fact process_tree "$(awk '{ $1=""; print }' <<<"$ps" | grep -E 'node|flock|sleep' | cut -c1-90 | tr '\n' ';')"
  echo "$pi $tmuxn"
}
read -r PI_N TMUX_N <<<"$(check_verify_extra)"
# the process tree at rest, right after the boot: no pi, no tmux, no overseer (runbook 13)
if [[ "$PI_N" == 0 && "${TMUX_N:-1}" == 0 ]]; then
  check TREE-0 pass "right after the release boot the daemon container holds no pi, no PR tmux session and no overseer" "pi processes $PI_N, tmux sessions other than the entrypoint's empty \`main\` shell: $TMUX_N ($(dx tmux ls 2>&1 | tr '\n' ' ')); the process tree is in the run notes"
else
  check TREE-0 fail "the release boot holds no pi, PR tmux session or overseer" "pi=$PI_N tmux=$TMUX_N"
fi

# ---- HOLD-1: the operator's drain survives the release boot as the hold ----------------------------------------------------------------
CARRIED="$(sql "select count(*) from events where kind='drain_hold_carried'")"
KEPT="$(docker logs "$DAEMON" 2>&1 | grep -c drain_hold_kept)"
LIFTED="$(sql "select count(*) from events where kind='drain_lifted'")"
DS="$(sql 'select * from drain_state' | tr '\n' ' ')"
if [[ "$CARRIED" -ge 1 && "$KEPT" -ge 1 && "$LIFTED" == 0 && "$(status_get draining)" == True && "$(status_get draining_hold)" == True && "$(status_get draining_by)" == operator ]]; then
  check HOLD-1 pass "the operator's plain drain survives the release boot as the HOLD: drain_hold_carried at the boot, drain_hold_kept at the first healthy reconcile, no drain_lifted" \
    "drain_hold_carried x$CARRIED (events), drain_hold_kept x$KEPT (daemon log), drain_lifted x$LIFTED; status.json: draining=true draining_by=operator draining_hold=true; drain_state row: $DS"
else
  check HOLD-1 fail "the drain survives the boot as the hold" "carried=$CARRIED kept=$KEPT lifted=$LIFTED status draining=$(status_get draining) hold=$(status_get draining_hold) by=$(status_get draining_by); row: $DS"
fi
# The operator's tools, with the owner's [tui] block (ssh target, no remote_sandbox_root, no remote_state_dir):
# the board's own read of the heartbeat (statusArgv, over the same ssh), and `qcr status` read where the daemon is.
TUI_ARGV="$(node --input-type=module -e '
  const { loadConfig } = await import(process.argv[1] + "/dist/src/config.js");
  const { statusArgv } = await import(process.argv[1] + "/dist/src/tui/remote.js");
  const cfg = loadConfig(process.argv[2]);
  process.stdout.write(statusArgv(cfg.tui).join(" "));
' "$ROOT" "$CTL/operator.toml" 2>/dev/null)"
TUI_HB="$(vm "$TUI_ARGV" 2>/dev/null)"
vm "sudo docker exec $DAEMON node /opt/qcr/dist/src/cli.js status" >"$WORK/status-held.txt" 2>&1
if [[ "$TUI_HB" == *'"draining_hold": true'* || "$TUI_HB" == *'"draining_hold":true'* ]] && grep -q "HELD by the operator" "$WORK/status-held.txt"; then
  check SURFACE-1 pass "the operator's read paths reach the release boot with the owner's [tui] config: the board's status read ($TUI_ARGV over ssh) shows the hold, and the daemon's own qcr status says HELD" "$(grep -m1 DRAINING "$WORK/status-held.txt" | cut -c1-220)"
else
  check SURFACE-1 fail "the operator's read paths reach the release boot" "argv '$TUI_ARGV' -> $(printf '%s' "$TUI_HB" | head -c 200); status: $(head -3 "$WORK/status-held.txt" | tr '\n' ' ' | cut -c1-300)"
fi

# the hold outlasts later reconcile passes and a daemon restart
RECS0="$(docker logs "$DAEMON" 2>&1 | grep -c 'reconcile: open=')"
log "waiting for two more reconcile passes under the hold"
passes_more() { [[ "$(docker logs "$DAEMON" 2>&1 | grep -c 'reconcile: open=')" -ge $((RECS0 + 2)) ]]; }
wait_for 150 "two more reconcile passes" passes_more
RECS1="$(docker logs "$DAEMON" 2>&1 | grep -c 'reconcile: open=')"
STILL1="$(status_get draining)/$(status_get draining_hold)"
BOOTS0="$(docker logs "$DAEMON" 2>&1 | grep -c 'workers: recovered')"
docker restart "$DAEMON" >/dev/null
reboot_done() { [[ "$(docker logs "$DAEMON" 2>&1 | grep -c 'workers: recovered')" -gt "$BOOTS0" ]] && docker logs "$DAEMON" 2>&1 | awk '/workers: recovered/ {ok=0} /reconcile: open=.* errors=0/ {ok=1} END {exit !ok}'; }
wait_for 180 "the restarted daemon's first reconcile" reboot_done
sleep 3
STILL2="$(status_get draining)/$(status_get draining_hold)"
KEPT2="$(docker logs "$DAEMON" 2>&1 | grep -c drain_hold_kept)"
if [[ "$STILL1" == True/True && "$STILL2" == True/True && "$(sql "select count(*) from events where kind='drain_lifted'")" == 0 && "$KEPT2" -gt "$KEPT" ]]; then
  check HOLD-2 pass "no later reconcile pass and no daemon restart lifts the hold" "reconcile passes $RECS0 -> $RECS1 with the drain standing ($STILL1); after docker restart of the release container and its first healthy reconcile: $STILL2, drain_hold_kept x$KEPT -> x$KEPT2, drain_lifted x0"
else
  check HOLD-2 fail "the hold outlasts reconcile passes and a restart" "after passes $STILL1; after restart $STILL2; kept $KEPT -> $KEPT2; lifted $(sql "select count(*) from events where kind='drain_lifted'")"
fi

# ---- HOLD-3: under the hold a trigger starts nothing -------------------------------------------------------------------------------------
hook() { # <event> <json>, signed, from inside the container (the webhook binds there)
  local body="$2" sig
  sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$(tr -d '\n' <"$H/secrets/webhook_secret")" | sed 's/^.* //')"
  printf '%s' "$body" | docker exec -i "$DAEMON" curl -sS -o /dev/null -w '%{http_code}' -XPOST http://127.0.0.1:8787/webhook \
    -H 'content-type: application/json' -H "x-github-event: $1" -H "x-github-delivery: rh-$(date +%s%3N)" \
    -H "x-hub-signature-256: $sig" --data-binary @-
}
HEAD1="$(python3 -c "import json;print(json.load(open('$H/fixture.json'))['heads'][1])")"
git -C "$H/remote.git" update-ref "refs/pull/$PR/head" "$HEAD1"
DROPPED0="$(status_get drained_deliveries)"
CODE="$(hook pull_request "{\"action\":\"labeled\",\"label\":{\"name\":\"AI review requested\"},\"pull_request\":{\"number\":$PR,\"title\":\"Add rate limiting\",\"head\":{\"sha\":\"$HEAD1\"},\"user\":{\"login\":\"alice\"}},\"sender\":{\"login\":\"alice\",\"type\":\"User\"}}")"
op debug-round "$PR" >"$WORK/debug-held.txt" 2>&1
sleep 45
ROUNDS="$(sql 'select count(*) from rounds')"; CMDS="$(sql "select count(*) from session_commands where kind='round'")"
SPAWNED="$(sql "select count(*) from events where kind='worker_spawned'")"
fact trigger_under_hold "webhook HTTP $CODE; drained_deliveries $DROPPED0 -> $(status_get drained_deliveries); debug-round said: $(tr '\n' ' ' <"$WORK/debug-held.txt" | cut -c1-240); rounds $ROUNDS, round commands $CMDS, workers spawned $SPAWNED"
if [[ "$ROUNDS" == 0 && "$CMDS" == 0 && "$SPAWNED" == 0 ]]; then
  check HOLD-3 pass "under the hold a signed trigger and a debug-round request start nothing: no round, no command, no worker" "webhook HTTP $CODE (the delivery is dropped, drained_deliveries $DROPPED0 -> $(status_get drained_deliveries)); debug-round: $(tr '\n' ' ' <"$WORK/debug-held.txt" | cut -c1-200)"
else
  check HOLD-3 fail "under the hold nothing starts" "rounds=$ROUNDS commands=$CMDS spawned=$SPAWNED"
fi
op release "$PR" >/dev/null 2>&1

# ---- LIFT-1: only drain off lifts it --------------------------------------------------------------------------------------------------------
op drain off >"$WORK/drain-off.txt" 2>&1; OFFRC=$?
hb_cleared() { local d; d="$(status_get draining)"; [[ -z "$d" || "$d" == False ]]; }
wait_for 60 "the heartbeat to drop the drain" hb_cleared
DRAIN_HB="$(status_get draining)"
if [[ "$OFFRC" == 0 && "$(sql 'select draining from drain_state')" == 0 && ( -z "$DRAIN_HB" || "$DRAIN_HB" == False ) ]]; then
  check LIFT-1 pass "qcr drain off (the owner's go) lifts the hold, and it is the only thing that did" "$(tr '\n' ' ' <"$WORK/drain-off.txt" | cut -c1-200); drain_state draining=0; the heartbeat no longer shows draining; no round started by the lift itself ($(sql 'select count(*) from rounds') rounds)"
else
  check LIFT-1 fail "qcr drain off lifts the hold" "rc=$OFFRC $(cat "$WORK/drain-off.txt" | tr '\n' ' ') db=$(sql 'select draining from drain_state')"
fi

if grep -q "/opt/qcr/commands/" "$WORK/drain-off.txt" && grep -q "/opt/quickreview/sandbox/commands/" "$LOGS/wizard-a.log"; then
  check SURFACE-2 pass "the operator's command channel follows the recreate with no [tui] edit: the drain on at stage 2 went to the legacy container's /opt/quickreview/sandbox/commands, the drain off to the release container's /opt/qcr/commands (the layout resolver reads the container's qcr.layout label)" "$(grep -m1 'drain on →' "$LOGS/wizard-a.log" | sed 's/^ *//' | cut -c1-120); $(grep -m1 'drain off →' "$WORK/drain-off.txt" | cut -c1-120)"
else
  check SURFACE-2 fail "the command channel follows the recreate" "$(grep -m1 'drain on' "$LOGS/wizard-a.log"); $(grep -m1 'drain off' "$WORK/drain-off.txt")"
fi

# ---- REFRESH-1: the refresher took over the existing login ------------------------------------------------------------------------------------
PIHOME_SUM_NOW="$(sha256sum "$H/pihome/agent/auth.json" | cut -c1-16)"
PIHOME_SUM_0="$(sha256sum "$PRISTINE/pihome/agent/auth.json" | cut -c1-16)"
LOCKED=no; dx flock -n /home/qcr/.pi/agent/auth.json.lock true 2>/dev/null || LOCKED=yes
LR="$(status_get login_refresh)"
EXP="$(python3 -c "import json,sys;d=json.loads(sys.argv[1] or '{}');print(d.get('expires_at') or d.get('expiresAt') or '')" "$LR" 2>/dev/null)"
fact login_refresh "$LR"
REFRESHER_PS="$(dx sh -c 'for p in /proc/[0-9]*; do tr "\0" " " <$p/cmdline 2>/dev/null; echo; done' | grep -c loginrefresh)"
if [[ "$LOCKED" == yes && "$PIHOME_SUM_NOW" == "$PIHOME_SUM_0" && -n "$LR" && "$LR" != null ]]; then
  check REFRESH-1 pass "the login refresher took over the existing pihome login: it holds auth.json.lock, reports expires_at, and left the login file untouched (nothing was due)" "lock held: $LOCKED; auth.json sha $PIHOME_SUM_NOW == the legacy pihome's; status.json login_refresh: $(echo "$LR" | cut -c1-200); refresher processes: $REFRESHER_PS"
else
  check REFRESH-1 fail "the refresher took over the existing login" "locked=$LOCKED sum $PIHOME_SUM_NOW vs $PIHOME_SUM_0 login_refresh=$LR"
fi

# ---- LOGIN-PTY-1: an owner-style login through the entrypoint in a pty pauses and resumes the refresher -------------------------------------------
STATUS_F="$H/pihome/agent/loginrefresh.status.json"
paused_now() { grep -q '"paused": true' "$STATUS_F" 2>/dev/null; }
not_paused() { ! paused_now && [[ ! -e "$H/pihome/agent/auth.json.pause" ]]; }
python3 "$WRH/pty-drive.py" --settle 14 --expect "Select|login|Login|authentication|provider" --timeout 60 --detach -- \
  docker exec -it "$DAEMON" /opt/qcr/docker/entrypoint.sh login >"$WORK/login-pty.txt" 2>&1 &
PTY_PID=$!
wait_for 40 "the refresher to pause" paused_now; SAW_PAUSE=$?
PAUSE_FILE_SEEN=no; [[ -e "$H/pihome/agent/auth.json.pause" ]] && PAUSE_FILE_SEEN=yes
LOCK_DURING=no; dx flock -n /home/qcr/.pi/agent/auth.json.lock true 2>/dev/null || LOCK_DURING=yes
wait "$PTY_PID"; PTY_RC=$?
wait_for 40 "the refresher to resume" not_paused; RESUMED=$?
dx tmux kill-server >/dev/null 2>&1
SUM_AFTER="$(sha256sum "$H/pihome/agent/auth.json" | cut -c1-16)"
if [[ "$SAW_PAUSE" == 0 && "$LOCK_DURING" == yes && "$RESUMED" == 0 && "$PTY_RC" == 0 && "$SUM_AFTER" == "$PIHOME_SUM_0" ]]; then
  check LOGIN-PTY-1 pass "docker exec -it … entrypoint.sh login in a pty pauses the refresher (it keeps the lock) while pi's /login is open, and resumes it when the login ends; no OAuth was completed" \
    "pty rc $PTY_RC; during: loginrefresh.status.json paused=true, pause file $PAUSE_FILE_SEEN, lock still held; after the pty was detached: paused cleared, pause file removed; auth.json unchanged. Screen: $(sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$WORK/login-pty.txt" | tr -s '\n ' ' ' | cut -c1-240)"
else
  check LOGIN-PTY-1 fail "an owner-style login pauses and resumes the refresher" "paused_seen=$SAW_PAUSE lock_during=$LOCK_DURING resumed=$RESUMED pty_rc=$PTY_RC sum_same=$([[ $SUM_AFTER == $PIHOME_SUM_0 ]] && echo y || echo n) screen: $(tail -c 600 "$WORK/login-pty.txt" | tr '\n' ' ')"
fi

# =================================================================================================
# the P8.20a worker checks, on THIS release boot
# =================================================================================================
if [[ "$SKIP_WORKER" == 0 ]]; then
  cat >"$WORK/world.env" <<EOF
H="$H"
TLS="$TLS"
LOGS="$LOGS"
OPERATOR_TOML="$CTL/operator.toml"
LEGACY_ORIGINAL="$WORK/legacy-original.jsonl"
REL_IMG="$REL_IMG"
EOF
  log "the worker checks (scripts/worker-rehearsal.sh --adopt) on the release boot the updater made"
  "$ROOT/scripts/worker-rehearsal.sh" --adopt "$WORK/world.env" --work "$WORK/worker" --out "$WORK/worker-report.md" >"$LOGS/worker.log" 2>&1; WORKER_RC=$?
  tail -5 "$LOGS/worker.log" | sed 's/^/    | /' >&2
  cat "$WORK/worker/results.tsv" >>"$RESULTS" 2>/dev/null
  fact worker_run "rc=$WORKER_RC; $(grep -c -P '\tpass\t' "$WORK/worker/results.tsv") passed, $(grep -c -P '\tfail\t' "$WORK/worker/results.tsv") failed; $(cat "$WORK/worker/facts.tsv" | grep -E '^(permits_status|burst|first_worker)' | cut -c1-200 | tr '\n' ' ')"
fi

# ---- wizard run B: stages 9-11 -----------------------------------------------------------------------------------------------------------------
python3 "$RH/answer.py" --timeout 300 \
  --on 'Ready to start\?=>\n' --on 'PR number for the commands below.*=>'"$PR"'\n' --on 'Was the worker round checked and is it good\?.*\[y/N\]=>y\n' \
  --on 'Lift the drain now.*\[y/N\]=>y\n' --on 'Answer worker replied.*\[y/N\]=>y\n' \
  -- "$ROOT/scripts/cutover.sh" "$VERSION" >"$LOGS/wizard-b.log" 2>&1; WB_RC=$?
sed -i 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$LOGS/wizard-b.log"
STAGES_DONE="$(grep -o 'done:[a-z_0-9]*' "$CTL/wizard.state" 2>/dev/null | sed 's/done://' | tr '\n' ' ')"
tail -12 "$LOGS/wizard-b.log" | sed 's/^/    | /' >&2
if [[ "$WB_RC" == 0 ]] && grep -q "already done, skipped" "$LOGS/wizard-b.log" && [[ "$STAGES_DONE" == *first_round*idle_pr* ]] && grep -q "The 4-hour check is due at" "$LOGS/wizard-b.log"; then
  check WIZ-B pass "the resumed wizard skips the finished stages (never repeats the release), records the owner's lift and the idle-PR answer, and schedules the 4-hour check" "rc 0; stages recorded: $STAGES_DONE; $(grep -m1 'The 4-hour check is due' "$LOGS/wizard-b.log" | sed 's/^ *//')"
else
  check WIZ-B fail "the resumed wizard finishes stages 9-11" "rc=$WB_RC stages: $STAGES_DONE; $(tail -5 "$LOGS/wizard-b.log" | tr '\n' ' ')"
fi
[[ "$(grep -c 'step: ' "$LOGS/wizard-b.log")" == 0 ]] || check WIZ-B2 fail "the resumed wizard did not re-run the release" "the log shows updater steps"

# =================================================================================================
# the report
# =================================================================================================
cp "$LOGS/stub.jsonl" "$WORK/stub.jsonl" 2>/dev/null
docker logs "$DAEMON" >"$LOGS/daemon.log" 2>&1
fact ssh_commands "$(wc -l <"$VM/ssh-commands.log") commands crossed the throwaway sshd"
node "$RH/report.mjs" "$RESULTS" "$FACTS" "$OUT" "$HEAD_FULL" "$RH/findings.md" || log "the report failed"
FAILS="$(grep -c -P '\tfail\t' "$RESULTS")"; PASSES="$(grep -c -P '\tpass\t' "$RESULTS")"
log "done: $PASSES passed, $FAILS failed; report $OUT"
[[ "$FAILS" == 0 ]]
