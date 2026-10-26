#!/usr/bin/env bash
# qcr-update — the thin updater that `provision` installs on the VM once
# (/usr/local/sbin/qcr-update, root 0755). Every deploy afterwards is
#
#   tar -C <config home> -cf - config.toml profiles \
#     | ssh vm sudo qcr-update <version>@<daemon index digest> \
#         --memory-digest <memory index digest> [--cutover-ack <version>]
#
# and that is the ONLY thing a deploy runs on the VM (scripts/deploy.sh
# release). Nothing is rsynced, built or installed: the images were built once
# by CI and are pulled by digest.
#
# The config home arrives as a tar on stdin: config.toml and profiles/ only.
# The updater REFUSES a tar with a secrets/ entry (secrets stay with
# provision), with an absolute or `..` path, with a link, or with any other
# top-level name.
#
# Order of a run (a refusal before "stop" changes nothing on the VM):
#   lock            flock, one updater at a time
#   drain           refuse unless status.json says draining=true, running_rounds=0
#   layout          on the legacy layout, refuse without --cutover-ack <version>
#   pull            pull both images BY DIGEST, check the digests and the labels
#   runspec         refuse an image whose qcr.runspec label is newer than
#                   update.conf's: "re-run provision"
#   stage-config    unpack the tar into config-home.next
#   config-check    the NEW image's `qcr config check --json` on it
#   --- from here a failure is RESCUED ---
#   stop            stop the daemon container
#   snapshot        state.db(+wal/shm) and a tar of state/pi-sessions into
#                   <backups>/<version>-<ts>/ (root, 0600; pihome never)
#   preflight       the new image's `daemon --preflight` on a scratch copy of
#                   the snapshot, --network none. Required: an image without
#                   the qcr.preflight label was refused at "pull"
#   seed            legacy layout only: seed the sidecar store once (copy plus
#                   checksum verify; the daemon's old store is left untouched)
#   swap            config-home -> .prev, .next -> config-home
#   sidecar-start / sidecar-ready   start the memory sidecar, wait for /ready
#                   (a long timeout: a re-embed is a boot)
#   recreate        recreate the daemon container on the new image. At the
#                   cutover this is the point of no return: the first boot
#                   migrates forward.
#
# RESCUE (any failure from "stop" up to the recreate): restore the previous
# config, remove the newly started sidecar (and put the old one back), start
# the OLD daemon container, wait for its first reconcile in status.json (a
# healthy legacy boot lifts the drain, and the first reconcile is the
# observable that it ran), re-send `drain on` through the operator channel,
# confirm draining=true, and exit non-zero naming the step. Between the
# auto-lift and the re-sent drain the dispatch pump may already have started
# held pending_wakes rounds: the bot is left drained but rounds may be
# running, and a retry waits for running_rounds 0. A failure AFTER the
# recreate keeps the drain on (a failed first reconcile never lifts it) and is
# fixed forward.
#
#   qcr-update status [--json]   the layout, the image digests and labels, the
#                                run-spec version and fingerprint, the drain
#                                state and the last run
#
# The run spec is /etc/qcr/update.conf (KEY=VALUE, root-owned, rendered by
# `deploy.sh provision` from group_vars). Its RUNSPEC_FINGERPRINT is the
# sha256 of every other KEY=VALUE line, in order; this script recomputes it.
#
# Test seam: run as a non-root user, QCR_UPDATE_CONF, QCR_UPDATE_DOCKER,
# QCR_UPDATE_POLL_S, QCR_UPDATE_NAP_S, QCR_RESCUE_WAIT_S, QCR_DRAIN_RECEIPT_WAIT_S, QCR_MEMORY_READY_TIMEOUT_S and
# QCR_UPDATE_FAIL_AT=<step> are honoured. As root none of
# them is: root reads /etc/qcr/update.conf and runs `docker`. (sudo also resets
# the environment.) tests/qcr-update.test.ts drives it with a fake docker.

set -Eeuo pipefail
umask 077

SELF="qcr-update"

# ---- the seam ----------------------------------------------------------------

TEST_MODE=0
if [[ "$(id -u)" -eq 0 ]]; then
  CONF=/etc/qcr/update.conf
  DOCKER=docker
  POLL_S=5
  FAIL_AT=""
  RESCUE_WAIT_S=300
  DRAIN_WAIT_S=120
  READY_WAIT_S=""
  NAP_S=5
elif [[ -n "${QCR_UPDATE_CONF:-}" ]]; then
  TEST_MODE=1
  CONF="$QCR_UPDATE_CONF"
  DOCKER="${QCR_UPDATE_DOCKER:-docker}"
  POLL_S="${QCR_UPDATE_POLL_S:-5}"
  FAIL_AT="${QCR_UPDATE_FAIL_AT:-}"
  RESCUE_WAIT_S="${QCR_RESCUE_WAIT_S:-300}"
  DRAIN_WAIT_S="${QCR_DRAIN_RECEIPT_WAIT_S:-120}"
  READY_WAIT_S="${QCR_MEMORY_READY_TIMEOUT_S:-}"
  NAP_S="${QCR_UPDATE_NAP_S:-$POLL_S}"
else
  echo "$SELF: must run as root (sudo qcr-update ...)" >&2
  exit 2
fi

LOG_FILE=""
log() {
  local line="$SELF: $*"
  echo "$line" >&2
  [[ -z "$LOG_FILE" ]] || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $line" >>"$LOG_FILE" 2>/dev/null || true
}
die() {
  log "$*"
  exit 1
}

# ---- the run spec -------------------------------------------------------------

declare -A C=()
REQUIRED_KEYS=(
  RUNSPEC_VERSION RUNSPEC_FINGERPRINT SANDBOX_ROOT APP_ROOT
  DAEMON_CONTAINER MEMORY_CONTAINER DAEMON_IMAGE_REPO MEMORY_IMAGE_REPO
  MEMORY_NETWORK WEBHOOK_PORT CONTAINER_UID TOOL_UID TOOL_GID TZ
  DAEMON_CPUS DAEMON_MEMORY MEMORY_CPUS MEMORY_MEMORY
  MEMORY_STATE_DIR OPENVIKING_HOME OPENVIKING_PORT BASE_CLONE_DIR LEGACY_SANDBOX_ROOT
  BACKUP_DIR UPDATE_STATE_DIR
)

fingerprint_of() {
  grep -E '^[A-Z][A-Z0-9_]*=' "$1" | grep -v '^RUNSPEC_FINGERPRINT=' | sha256sum | cut -d' ' -f1
}

load_conf() {
  [[ -f "$CONF" ]] || die "no run spec at $CONF — run \`deploy.sh provision\` first"
  if [[ $TEST_MODE -eq 0 ]]; then
    local owner mode
    owner="$(stat -c '%u' "$CONF")"
    mode="$(stat -c '%a' "$CONF")"
    [[ "$owner" == 0 ]] || die "$CONF is not owned by root"
    [[ "${mode: -1}" != [2367] && "${mode: -2:1}" != [2367] ]] || die "$CONF is writable by group or others (mode $mode)"
  fi
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./:@+,-]*)$ ]] || die "$CONF has a line this updater will not read: ${line:0:60}"
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    C["$key"]="$val"
  done <"$CONF"
  for key in "${REQUIRED_KEYS[@]}"; do
    [[ -n "${C[$key]:-}" ]] || die "$CONF lacks $key — re-run provision"
  done
  [[ "$(fingerprint_of "$CONF")" == "${C[RUNSPEC_FINGERPRINT]}" ]] ||
    die "$CONF does not match its RUNSPEC_FINGERPRINT (edited by hand?) — re-run provision"
  [[ "${C[RUNSPEC_VERSION]}" =~ ^[0-9]+$ ]] || die "$CONF RUNSPEC_VERSION is not a number"
}

# ---- docker helpers ------------------------------------------------------------

d() { "$DOCKER" "$@"; }

# Every lookup by name is `container inspect`: a bare `docker inspect` resolves any
# object, and the memory network shares the sidecar's name (the 1.0.2 cutover
# took the network for an old sidecar and failed renaming it).

# A container's label, or "" (a missing container or label is "").
container_label() {
  d container inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null | sed 's/^<no value>$//' || true
}
image_label() {
  d image inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null | sed 's/^<no value>$//' || true
}
container_exists() { d container inspect -f '{{.Id}}' "$1" >/dev/null 2>&1; }
container_running() { [[ "$(d container inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" == true ]]; }

# release | legacy | none — of the daemon container.
detect_layout() {
  if ! container_exists "${C[DAEMON_CONTAINER]}"; then echo none; return; fi
  if [[ "$(container_label "${C[DAEMON_CONTAINER]}" qcr.layout)" == release ]]; then echo release; else echo legacy; fi
}

# ---- the drain ------------------------------------------------------------------

STATUS_JSON() { echo "${C[SANDBOX_ROOT]}/state/status.json"; }

# First `"key": value` of status.json, or "".
status_value() {
  local f; f="$(STATUS_JSON)"
  [[ -f "$f" ]] || return 0
  grep -m1 -o "\"$1\"[[:space:]]*:[[:space:]]*\"\?[^,}\" ]*" "$f" 2>/dev/null | sed -E 's/^[^:]*:[[:space:]]*"?//' || true
}

# ---- status ---------------------------------------------------------------------

json_str() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037"\\')"; }
json_bool_or_null() { case "$1" in true|false) printf '%s' "$1" ;; *) printf null ;; esac; }
json_num_or_null() { if [[ "$1" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf null; fi; }

image_block() {
  local container="$1" img id
  if ! container_exists "$container"; then printf null; return; fi
  img="$(d container inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  printf '{"container":%s,"running":%s,"image":%s,"layout":%s,"build_sha":%s,"runspec":%s,"preflight":%s,"pi":%s}' \
    "$(json_str "$container")" "$(container_running "$container" && echo true || echo false)" \
    "$(json_str "$img")" "$(json_str "$(container_label "$container" qcr.layout)")" \
    "$(json_str "$(container_label "$container" qcr.build-sha)")" \
    "$(json_str "$(container_label "$container" qcr.runspec)")" \
    "$(json_str "$(container_label "$container" qcr.preflight)")" \
    "$(json_str "$(container_label "$container" qcr.pi)")"
}

cmd_status() {
  local json="$1"
  load_conf
  local layout draining rounds last="null" fpfile
  layout="$(detect_layout)"
  draining="$(status_value draining)"
  rounds="$(status_value running_rounds)"
  fpfile="${C[UPDATE_STATE_DIR]}/last-run.json"
  [[ -s "$fpfile" ]] && last="$(cat "$fpfile")"
  if [[ "$json" -eq 1 ]]; then
    printf '{"layout":%s,"daemon":%s,"memory":%s,"runspec":{"version":%s,"fingerprint":%s},"drain":{"draining":%s,"running_rounds":%s},"last_run":%s}\n' \
      "$(json_str "$layout")" "$(image_block "${C[DAEMON_CONTAINER]}")" "$(image_block "${C[MEMORY_CONTAINER]}")" \
      "$(json_str "${C[RUNSPEC_VERSION]}")" "$(json_str "${C[RUNSPEC_FINGERPRINT]}")" \
      "$(json_bool_or_null "$draining")" "$(json_num_or_null "$rounds")" "$last"
  else
    echo "layout        $layout"
    echo "runspec       v${C[RUNSPEC_VERSION]} ${C[RUNSPEC_FINGERPRINT]}"
    echo "drain         draining=${draining:-unknown} running_rounds=${rounds:-unknown}"
    echo "daemon        $(image_block "${C[DAEMON_CONTAINER]}")"
    echo "memory        $(image_block "${C[MEMORY_CONTAINER]}")"
    echo "last run      $last"
  fi
}

# ---- arguments --------------------------------------------------------------------

VERSION=""
DAEMON_DIGEST=""
MEMORY_DIGEST=""
ACK=""

usage() {
  echo "usage: $SELF <version>@<sha256:daemon-index-digest> --memory-digest <sha256:...> [--cutover-ack <version>] < config.tar" >&2
  echo "       $SELF status [--json]" >&2
  exit 2
}

VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'

if [[ "${1:-}" == status ]]; then
  shift
  json=0
  [[ "${1:-}" == --json ]] && { json=1; shift; }
  [[ $# -eq 0 ]] || usage
  cmd_status "$json"
  exit 0
fi

[[ $# -ge 1 ]] || usage
if [[ "$1" =~ ^([^@]+)@(.+)$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
  DAEMON_DIGEST="${BASH_REMATCH[2]}"
else
  usage
fi
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --memory-digest) [[ $# -ge 2 ]] || usage; MEMORY_DIGEST="$2"; shift ;;
    --cutover-ack) [[ $# -ge 2 ]] || usage; ACK="$2"; shift ;;
    *) usage ;;
  esac
  shift
done
[[ "$VERSION" =~ $VERSION_RE ]] || die "'$VERSION' is not a version (X.Y.Z); there is no latest tag"
[[ "$DAEMON_DIGEST" =~ $DIGEST_RE ]] || die "the daemon digest must be sha256:<64 hex> (got '$DAEMON_DIGEST')"
[[ "$MEMORY_DIGEST" =~ $DIGEST_RE ]] || die "--memory-digest sha256:<64 hex> is required (got '${MEMORY_DIGEST:-nothing}')"

load_conf

# ---- state of this run -----------------------------------------------------------

TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${C[UPDATE_STATE_DIR]}"
LOG_FILE="${C[UPDATE_STATE_DIR]}/update.log"
STEP="start"
PHASE=init          # init -> rescuable (the stop) -> committed (the recreate)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/qcr-update.XXXXXX")"
ROOT="${C[SANDBOX_ROOT]}"
CFG="$ROOT/config-home"
UID_GID="${C[CONTAINER_UID]}:${C[CONTAINER_UID]}"
DAEMON="${C[DAEMON_CONTAINER]}"
MEM="${C[MEMORY_CONTAINER]}"
DAEMON_REF="${C[DAEMON_IMAGE_REPO]}@$DAEMON_DIGEST"
MEMORY_REF="${C[MEMORY_IMAGE_REPO]}@$MEMORY_DIGEST"
# 0: untouched; 1: config-home moved to .prev; 2: .next is config-home
SWAP_STATE=0
LOCKED=0
OLD_DAEMON_RENAMED=0
OLD_MEM_RENAMED=0
OLD_MEM_STOPPED=0
NEW_MEM_STARTED=0
SEEDED=0
RESCUE_OK=1
SWAP_MARKER="${C[UPDATE_STATE_DIR]}/swap-pending"
# the SQLite files the snapshot and the preflight scratch copy both carry
STATE_DB_FILES=(state.db state.db-wal state.db-shm)
NEW_DAEMON_STARTED=0
DAEMON_STOPPED=0
LAYOUT=none
CONFIG_PATH_IN_CONTAINER="/opt/quickreview/config-home/config.toml"

step() {
  STEP="$1"
  log "step: $1"
  [[ -z "$FAIL_AT" || "$FAIL_AT" != "$1" ]] || die "injected failure at step '$1' (test seam)"
}

record_last_run() {
  local result="$1" detail="$2"
  printf '{"version":%s,"at":%s,"result":%s,"step":%s,"detail":%s}\n' \
    "$(json_str "$VERSION")" "$(json_str "$TS")" "$(json_str "$result")" "$(json_str "$STEP")" "$(json_str "$detail")" \
    >"${C[UPDATE_STATE_DIR]}/last-run.json" 2>/dev/null || true
}

# ---- the operator channel (drain) -----------------------------------------------------

OPERATOR_DIR="$ROOT/sandbox/commands/operator"
RESULTS_DIR="$ROOT/sandbox/commands/results"

# The operator channel's directory, made and sealed by root here, while no
# container runs: commands/operator, root-owned 0755. The bot holds no
# capability that lets root inside it create or take over a directory in the
# daemon's commands/, so the operator's `docker exec -u 0` writes only
# into this one, which root owns. A symlink in its place is refused, never
# followed.
ensure_operator_channel() {
  local parent="$ROOT/sandbox/commands"
  [[ -d "$parent" && ! -L "$parent" ]] || return 0
  [[ ! -L "$OPERATOR_DIR" ]] || die "$OPERATOR_DIR is a symlink — refusing to seal the operator channel through it"
  [[ -e "$OPERATOR_DIR" ]] || mkdir "$OPERATOR_DIR"
  [[ -d "$OPERATOR_DIR" ]] || die "$OPERATOR_DIR is not a directory — cannot seal the operator channel"
  if [[ $TEST_MODE -eq 0 ]]; then
    chown -h 0:0 "$OPERATOR_DIR" && chmod 0755 "$OPERATOR_DIR"
  fi
}

# Write one `drain on` command as root into the sealed operator directory and
# wait for the daemon's receipt. 0 only when the receipt says draining=true.
send_drain_on() {
  local name base waited=0 wait_s="${1:-120}" result
  [[ -d "$ROOT/sandbox/commands" ]] || { log "no commands dir at $ROOT/sandbox/commands — cannot send drain on"; return 1; }
  mkdir -p "$OPERATOR_DIR"
  if [[ $TEST_MODE -eq 0 ]]; then
    chown 0:0 "$OPERATOR_DIR" && chmod 0755 "$OPERATOR_DIR"
  fi
  base="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)-qcr-update-drain"
  name="$base.json"
  printf '{"command":"drain","on":true}\n' >"$OPERATOR_DIR/.$name.tmp"
  chmod 0644 "$OPERATOR_DIR/.$name.tmp"
  mv "$OPERATOR_DIR/.$name.tmp" "$OPERATOR_DIR/$name"
  result="$RESULTS_DIR/$base.result.json"
  while (( waited <= wait_s )); do
    if [[ -f "$result" ]] && grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$result" &&
       grep -Eq '"draining"[[:space:]]*:[[:space:]]*true' "$result"; then
      return 0
    fi
    if [[ -f "$result" ]] && grep -Eq '"ok"[[:space:]]*:[[:space:]]*false' "$result"; then
      log "the daemon refused drain on: $(head -c 300 "$result" | tr -d '\n')"
      return 1
    fi
    sleep "$NAP_S"
    waited=$((waited + POLL_S))
  done
  log "no receipt for drain on within ${wait_s}s"
  return 1
}

# The old container's first reconcile, as status.json shows it: a heartbeat
# written by this boot (after the container's StartedAt) with the drain lifted,
# which is what a healthy first reconcile does. The daemon writes `draining`
# only while draining and omits the key once lifted, so lifted = absent (or false). A boot whose first reconcile
# fails leaves the drain standing, so the wait also ends at the timeout.
wait_first_reconcile() {
  local container="$1" wait_s="${2:-300}" waited=0 started written draining
  started="$(d container inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null | cut -c1-19 || true)"
  while (( waited <= wait_s )); do
    written="$(status_value written_at | cut -c1-19)"
    draining="$(status_value draining)"
    if [[ -n "$started" && -n "$written" && ! "$written" < "$started" && "$draining" != true ]]; then
      log "the old daemon's first reconcile has run (heartbeat $written, drain lifted)"
      return 0
    fi
    sleep "$NAP_S"
    waited=$((waited + POLL_S))
  done
  log "no first reconcile from the old daemon within ${wait_s}s (the drain may be standing already)"
  return 0
}

# ---- rescue ---------------------------------------------------------------------------

rescue() {
  set +e
  trap - ERR
  log "RESCUE after failure at step '$STEP': restoring the previous config and the old containers"
  local ok=1
  [[ $SWAP_STATE -ge 1 ]] || rm -f "$SWAP_MARKER"
  if [[ $SWAP_STATE -ge 1 ]]; then
    # the new config is set aside as .failed, the previous one is current again
    rm -rf "$CFG.failed"
    if [[ -e "$CFG" ]]; then mv "$CFG" "$CFG.failed" || ok=0; fi
    if mv "$CFG.prev" "$CFG"; then rm -f "$SWAP_MARKER"; else log "RESCUE: could not restore $CFG.prev"; ok=0; fi
  fi
  if [[ $NEW_MEM_STARTED -eq 1 || $OLD_MEM_RENAMED -eq 1 ]]; then
    d rm -f "$MEM" >/dev/null 2>&1
    if [[ $OLD_MEM_RENAMED -eq 1 ]]; then
      d rename "$MEM-prev" "$MEM" >/dev/null 2>&1 || { log "RESCUE: could not put the old sidecar back"; ok=0; }
    fi
  fi
  if [[ $OLD_MEM_STOPPED -eq 1 ]]; then
    d start "$MEM" >/dev/null 2>&1 || { log "RESCUE: the old sidecar did not start"; ok=0; }
  fi
  if [[ $SEEDED -eq 1 ]]; then
    # The legacy daemon owns its store again, so the copy this run seeded goes stale from
    # here on: it is set aside (never deleted) and the next run seeds afresh.
    local aside="${C[MEMORY_STATE_DIR]}.rescued-$TS"
    if mv "${C[MEMORY_STATE_DIR]}" "$aside"; then
      log "RESCUE: the sidecar store this run seeded is set aside at $aside; the next run seeds afresh"
    else
      log "RESCUE: could not set aside ${C[MEMORY_STATE_DIR]}: move it away before the next run, or it boots a stale store"
      ok=0
    fi
  fi
  if [[ $NEW_DAEMON_STARTED -eq 1 || $OLD_DAEMON_RENAMED -eq 1 ]]; then
    d rm -f "$DAEMON" >/dev/null 2>&1
    if [[ $OLD_DAEMON_RENAMED -eq 1 ]]; then
      d rename "$DAEMON-prev" "$DAEMON" >/dev/null 2>&1 || { log "RESCUE: could not put the old daemon container back"; ok=0; }
    fi
  fi
  if [[ $DAEMON_STOPPED -eq 1 && "$LAYOUT" != none ]]; then
    d start "$DAEMON" >/dev/null 2>&1 || { log "RESCUE: the old daemon container did not start"; ok=0; }
    wait_first_reconcile "$DAEMON" "$RESCUE_WAIT_S"
    if send_drain_on "$DRAIN_WAIT_S"; then
      log "RESCUE: drain on confirmed. Rounds may be running (held wakes started after the auto-lift): retry once running_rounds is 0"
    else
      log "RESCUE: COULD NOT CONFIRM drain on — drain by hand (qcr drain on) before anything else"
      ok=0
    fi
  fi
  RESCUE_OK=$ok
  [[ $ok -eq 1 ]] && log "RESCUE complete: the previous version is running again" || log "RESCUE INCOMPLETE — look at the VM"
  return 0
}

# Only the run that holds the lock may touch the staging directory.
cleanup() {
  rm -rf "$WORK"
  [[ $LOCKED -ne 1 ]] || rm -rf "$CFG.next"
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [[ $rc -ne 0 ]]; then
    if [[ "$PHASE" == rescuable ]]; then
      rescue
      if [[ $RESCUE_OK -eq 1 ]]; then
        record_last_run "rescued" "failed at $STEP; previous version restored"
      else
        record_last_run "rescue-incomplete" "failed at $STEP; the rescue did not complete, look at the VM"
      fi
    elif [[ "$PHASE" == committed ]]; then
      log "FAILED at step '$STEP' AFTER the recreate: the drain stays on (a failed first reconcile never lifts it); fix forward"
      record_last_run "failed-forward" "failed at $STEP after the recreate"
    else
      log "FAILED at step '$STEP' — nothing was changed on the VM"
      record_last_run "refused" "failed at $STEP before the stop"
    fi
    cleanup
    log "exit $rc: step '$STEP'"
    exit "$rc"
  fi
  cleanup
}
trap on_exit EXIT
trap 'exit 1' ERR

# ---- 1. the lock ------------------------------------------------------------------------

step lock
exec 9>"${C[UPDATE_STATE_DIR]}/update.lock"
flock -n 9 || die "another qcr-update is running (lock ${C[UPDATE_STATE_DIR]}/update.lock)"
LOCKED=1
[[ ! -e "$SWAP_MARKER" ]] ||
  die "a previous qcr-update was interrupted between the config swap and the recreate ($SWAP_MARKER): $CFG.prev holds the config the running daemon was started on. Put it back by hand (mv $CFG $CFG.failed; mv $CFG.prev $CFG), remove the marker, then retry"

# The config tar, spooled first so a refusal below needs no stdin.
step read-config
cat >"$WORK/config.tar"
[[ -s "$WORK/config.tar" ]] || die "no config tar on stdin (config.toml and profiles/)"

# ---- 2. the drain --------------------------------------------------------------------------

step drain
# A first install has nothing to drain: no daemon container, no heartbeat, no
# state database. Anything less than all three is an existing install (a lost
# container over live state), and keeps the drain requirement.
FRESH=0
if [[ "$(detect_layout)" == none && ! -e "$(STATUS_JSON)" && ! -e "${C[SANDBOX_ROOT]}/state/state.db" ]]; then
  FRESH=1
  log "fresh install: no daemon container, heartbeat or state database; nothing to drain or snapshot"
fi
draining="$(status_value draining)"
rounds="$(status_value running_rounds)"
[[ $FRESH -eq 1 ]] || [[ "$draining" == true ]] || die "refusing: the bot is not drained (draining=${draining:-unreadable}). Run \`qcr drain on\`, wait for running_rounds 0, retry"
[[ $FRESH -eq 1 ]] || [[ "$rounds" =~ ^[0-9]+$ ]] || die "refusing: running_rounds is unreadable in status.json"
[[ $FRESH -eq 1 ]] || [[ "$rounds" -eq 0 ]] || die "refusing: $rounds round(s) still running. Wait for running_rounds 0, retry"

# ---- 3. the layout ------------------------------------------------------------------------------

step layout
LAYOUT="$(detect_layout)"
log "layout: $LAYOUT"
# No container of this name, yet a running container writes this state: the run
# spec names the wrong daemon, and a second daemon would share its state.db.
if [[ "$LAYOUT" == none && $FRESH -eq 0 ]]; then
  for id in $(d ps -q); do
    if d container inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null | tr ' ' '\n' | grep -qx "${C[SANDBOX_ROOT]}/state"; then
      die "refusing: no container ${C[DAEMON_CONTAINER]}, but the running container $(d container inspect -f '{{.Name}}' "$id" | tr -d /) mounts ${C[SANDBOX_ROOT]}/state. The run spec names the wrong daemon: set image_name (and memory_container_name) to the containers this host runs, then provision again"
    fi
  done
fi
if [[ "$LAYOUT" == legacy && "$ACK" != "$VERSION" ]]; then
  die "refusing: the VM still runs the legacy layout, so this deploy is the cutover (the first boot migrates forward). Re-run with --cutover-ack $VERSION"
fi

# ---- 4. pull both images by digest, check them ----------------------------------------------------------

step pull
d pull "$DAEMON_REF" >/dev/null || die "could not pull $DAEMON_REF (the release images are public: check the VM reaches ghcr.io and the digest is published; a private mirror needs the VM logged in, scripts/vm-ghcr-login.sh)"
d pull "$MEMORY_REF" >/dev/null || die "could not pull $MEMORY_REF"

step check-images
check_digest() {
  local ref="$1" digest="$2" digests
  digests="$(d image inspect -f '{{range .RepoDigests}}{{.}} {{end}}' "$ref" 2>/dev/null || true)"
  [[ "$digests" == *"@$digest"* ]] || die "the pulled image $ref does not carry the digest $digest (RepoDigests: ${digests:-none})"
}
check_digest "$DAEMON_REF" "$DAEMON_DIGEST"
check_digest "$MEMORY_REF" "$MEMORY_DIGEST"
[[ "$(image_label "$DAEMON_REF" qcr.layout)" == release ]] || die "$DAEMON_REF is not a release-layout image (no qcr.layout=release label)"
sha_label="$(image_label "$DAEMON_REF" qcr.build-sha)"
[[ -n "$sha_label" && "$sha_label" != unstamped ]] || die "$DAEMON_REF carries no CI build stamp (qcr.build-sha)"
[[ "$(image_label "$DAEMON_REF" qcr.preflight)" == true ]] ||
  die "$DAEMON_REF has no qcr.preflight label: the required \`daemon --preflight\` step cannot run, so the image is refused"

step runspec
image_runspec="$(image_label "$DAEMON_REF" qcr.runspec)"
[[ "$image_runspec" =~ ^[0-9]+$ ]] || die "$DAEMON_REF has no numeric qcr.runspec label"
if [[ "$image_runspec" -gt "${C[RUNSPEC_VERSION]}" ]]; then
  die "refusing: the image needs run spec v$image_runspec but $CONF is v${C[RUNSPEC_VERSION]} — re-run provision"
fi
# The gate group of the image's setid helper (docker/Dockerfile): the
# bot is given it, and the helper is what runs the model's tools as TOOL_UID. An
# image from before the helper (run spec v1) has no label and needs no group.
SETID_GID="$(image_label "$DAEMON_REF" qcr.setid-gid)"
if [[ "$image_runspec" -ge 2 || -n "$SETID_GID" ]]; then
  [[ "$SETID_GID" =~ ^[1-9][0-9]*$ ]] || die "$DAEMON_REF needs run spec v$image_runspec but has no numeric qcr.setid-gid label"
  [[ "$SETID_GID" != "${C[CONTAINER_UID]}" ]] || die "$DAEMON_REF's setid gate group $SETID_GID is the container uid's own group"
fi
[[ "${C[TOOL_UID]}" =~ ^[1-9][0-9]*$ && "${C[TOOL_UID]}" != "${C[CONTAINER_UID]}" ]] ||
  die "$CONF TOOL_UID (${C[TOOL_UID]}) must be a non-zero uid other than CONTAINER_UID — re-run provision"
[[ "${C[TOOL_GID]}" =~ ^[1-9][0-9]*$ && "${C[TOOL_GID]}" != "${C[CONTAINER_UID]}" ]] ||
  die "$CONF TOOL_GID (${C[TOOL_GID]}) must be a non-zero gid other than the container's — re-run provision"
# The helper switches to the identity compiled into the image and nothing else
# (docker/setid/qcr-setid.c): the run spec must name that same identity.
if [[ -n "$SETID_GID" ]]; then
  for k in uid gid; do
    want="$(image_label "$DAEMON_REF" "qcr.tool-$k")"
    have="${C[TOOL_${k^^}]}"
    [[ "$want" == "$have" ]] ||
      die "$DAEMON_REF runs the model's tools as tool $k ${want:-?}, but $CONF says TOOL_${k^^}=$have — re-run provision"
  done
fi

# ---- 5. stage the config and check it with the NEW image ---------------------------------------------------

step stage-config
# Names only: no secrets/, no absolute or `..` paths, no links, nothing but
# config.toml and profiles/.
bad=""
while IFS= read -r entry; do
  e="${entry#./}"
  e="${e%/}"
  [[ -z "$e" || "$e" == . ]] && continue
  top="${e%%/*}"
  if [[ "$e" == /* || "$e" == *..* ]]; then bad="$entry (absolute or parent path)"; break; fi
  if [[ "$top" == secrets ]]; then bad="$entry (secrets/ never rides the config tar — secrets stay with provision)"; break; fi
  if [[ "$top" != config.toml && "$top" != profiles ]]; then bad="$entry (only config.toml and profiles/ are accepted)"; break; fi
  if [[ "$top" == config.toml && "$e" != config.toml ]]; then bad="$entry"; break; fi
done < <(tar -tf "$WORK/config.tar")
[[ -z "$bad" ]] || die "refusing the config tar: $bad"
if tar -tvf "$WORK/config.tar" | grep -Eq '^[lh]'; then
  die "refusing the config tar: it holds a link (the controller ships profiles dereferenced)"
fi
rm -rf "$CFG.next"
mkdir -p "$CFG.next"
tar -xf "$WORK/config.tar" --no-same-owner --no-same-permissions -C "$CFG.next"
[[ -f "$CFG.next/config.toml" ]] || die "the config tar holds no config.toml"
chmod -R u+rwX,go+rX,go-w "$CFG.next"
if [[ $TEST_MODE -eq 0 ]]; then chown -R "$UID_GID" "$CFG.next"; fi

step config-check
check_out="$WORK/config-check.json"
if ! d run --rm --network none --user "$UID_GID" -v "$CFG.next:/cfg:ro" "$DAEMON_REF" config check --json --config-home /cfg >"$check_out" 2>"$WORK/config-check.err"; then
  log "$(head -c 2000 "$check_out" | tr '\n' ' ')"
  log "$(head -c 500 "$WORK/config-check.err" | tr '\n' ' ')"
  die "refusing: the new image's \`qcr config check\` fails on this config home. Nothing was changed"
fi

# The network is a precondition that changes nothing running.
if ! d network inspect "${C[MEMORY_NETWORK]}" >/dev/null 2>&1; then
  d network create "${C[MEMORY_NETWORK]}" >/dev/null
fi

# ---- 6. from here a failure is rescued ----------------------------------------------------------------------------

BACKUP="${C[BACKUP_DIR]}/$VERSION-$TS"
STATE="$ROOT/state"

PHASE=rescuable
# Marked before the stop, so a stop that fails half way is rescued like any
# other step: the old container is started (a no-op if it runs) and re-drained.
[[ "$LAYOUT" == none ]] || DAEMON_STOPPED=1
step stop
if [[ "$LAYOUT" != none ]]; then
  d stop -t 90 "$DAEMON" >/dev/null
fi

step snapshot
mkdir -p "$BACKUP"
chmod 0700 "${C[BACKUP_DIR]}" "$BACKUP"
[[ $FRESH -eq 1 || -f "$STATE/state.db" ]] || die "no $STATE/state.db to snapshot"
for f in "${STATE_DB_FILES[@]}"; do
  [[ -f "$STATE/$f" ]] && cp -p "$STATE/$f" "$BACKUP/$f"
done
if [[ -d "$STATE/pi-sessions" ]]; then
  tar -C "$STATE" -czf "$BACKUP/pi-sessions.tar.gz" pi-sessions
fi
chmod 0600 "$BACKUP"/* 2>/dev/null || true
log "snapshot in $BACKUP"

step preflight
# The scratch copy: the snapshot's db files and the sessions, owned by the
# container uid, mounted as the app's state dir. --network none: the preflight
# reads, it reaches nothing. `daemon --preflight` is the image's own check
#: migrate the scratch db forward, resume the live JSONLs offline.
SCRATCH="$WORK/preflight-state"
mkdir -p "$SCRATCH"
for f in "${STATE_DB_FILES[@]}"; do
  [[ -f "$BACKUP/$f" ]] && cp -p "$BACKUP/$f" "$SCRATCH/$f"
done
[[ -f "$BACKUP/pi-sessions.tar.gz" ]] && tar -xzf "$BACKUP/pi-sessions.tar.gz" -C "$SCRATCH"
if [[ $TEST_MODE -eq 0 ]]; then chown -R "$UID_GID" "$SCRATCH"; fi
chmod -R go+rX "$SCRATCH"
d run --rm --network none --user "$UID_GID" \
  -e "QCR_CONFIG=$CONFIG_PATH_IN_CONTAINER" \
  -v "$SCRATCH:${C[APP_ROOT]}/state" -v "$CFG.next:/opt/quickreview/config-home:ro" \
  -v "$ROOT/pihome:/home/qcr/.pi:ro" \
  "$DAEMON_REF" daemon --preflight >"$WORK/preflight.out" 2>&1 ||
  { tail -n 20 "$WORK/preflight.out" >&2 || true; die "the new image's \`daemon --preflight\` failed on a scratch copy of the snapshot"; }
rm -rf "$SCRATCH"

step seed
if [[ "$LAYOUT" == legacy ]]; then
  marker="${C[MEMORY_STATE_DIR]}/.seeded-from-daemon"
  if [[ ! -e "$marker" ]]; then
    mkdir -p "${C[MEMORY_STATE_DIR]}" "${C[OPENVIKING_HOME]}"
    chmod 0700 "${C[MEMORY_STATE_DIR]}"
    if [[ $TEST_MODE -eq 0 ]]; then chown "$UID_GID" "${C[MEMORY_STATE_DIR]}"; fi
    # a copy that fails part way is already a stale partial store: marked before the
    # copy, so the rescue sets it aside and the retry seeds from an empty directory
    SEEDED=1
    # additive: no --delete, nothing on either side is removed
    rsync -a "${C[OPENVIKING_HOME]}/" "${C[MEMORY_STATE_DIR]}/"
    diff_out="$(rsync -a --checksum --dry-run --itemize-changes "${C[OPENVIKING_HOME]}/" "${C[MEMORY_STATE_DIR]}/")"
    [[ -z "$diff_out" ]] || die "the sidecar store copy does not verify by checksum: ${diff_out:0:200}"
    printf 'seeded from %s on %s\n' "${C[OPENVIKING_HOME]}" "$TS" >"$marker"
    chmod 0600 "$marker"
    if [[ $TEST_MODE -eq 0 ]]; then chown "$UID_GID" "$marker"; fi
    log "sidecar store seeded from ${C[OPENVIKING_HOME]} (copy verified; the old store is untouched)"
  else
    log "sidecar store already seeded"
  fi
fi

step swap
rm -rf "$CFG.prev"
printf '%s\n' "$TS" >"$SWAP_MARKER"
if [[ -d "$CFG" ]]; then mv "$CFG" "$CFG.prev"; else mkdir -p "$CFG.prev"; fi
SWAP_STATE=1
mv "$CFG.next" "$CFG"
SWAP_STATE=2

step sidecar-start
mem_args=(
  run -d --name "$MEM" --restart unless-stopped --init
  --user "$UID_GID"
  --cpus "${C[MEMORY_CPUS]}" --memory "${C[MEMORY_MEMORY]}" --memory-swap "${C[MEMORY_MEMORY]}"
  --network "${C[MEMORY_NETWORK]}"
  # no published port: OpenViking answers on the container network only
  -v "${C[MEMORY_STATE_DIR]}:${C[OPENVIKING_HOME]}"
  -v "$ROOT/secrets:/opt/quickreview/secrets:ro"
  -v "$ROOT/config-home:/opt/quickreview/config-home:ro"
  -e "TZ=${C[TZ]}" -e "QCR_CONFIG=$CONFIG_PATH_IN_CONTAINER"
)
for key in "${!C[@]}"; do
  [[ "$key" == SIDECAR_ENV_* ]] && mem_args+=(-e "${key#SIDECAR_ENV_}=${C[$key]}")
done
mem_args+=("$MEMORY_REF")
if container_exists "$MEM"; then
  # one writer on the store: the old sidecar stops before the new one starts
  if container_running "$MEM"; then OLD_MEM_STOPPED=1; d stop -t 90 "$MEM" >/dev/null; fi
  d rm -f "$MEM-prev" >/dev/null 2>&1 || true
  d rename "$MEM" "$MEM-prev"
  OLD_MEM_RENAMED=1
fi
NEW_MEM_STARTED=1
d "${mem_args[@]}" >/dev/null

step sidecar-ready
ready_wait="${READY_WAIT_S:-${C[MEMORY_READY_TIMEOUT_S]:-1800}}"
waited=0
until d exec "$MEM" curl -fsS "http://127.0.0.1:${C[OPENVIKING_PORT]}/ready" >/dev/null 2>&1; do
  (( waited < ready_wait )) || die "the memory sidecar was not ready within ${ready_wait}s (a re-embed is a boot; read: docker logs --tail 100 $MEM)"
  sleep "$NAP_S"
  waited=$((waited + POLL_S))
done
log "memory sidecar ready after ${waited}s"

step recreate
daemon_args=(
  run -d --name "$DAEMON" --restart unless-stopped --init
  --cpus "${C[DAEMON_CPUS]}" --memory "${C[DAEMON_MEMORY]}" --memory-swap "${C[DAEMON_MEMORY]}"
  --user "$UID_GID"
  # the model's tools run as TOOL_UID:TOOL_GID (QCR_TOOLS_AS), which cannot
  # read secrets/ or pi's login; the bot reaches it through the image's setid
  # helper, which switches to that one identity only, given by the --group-add
  # below. The bot stays this uid, so a `docker exec` lands as it. No
  # capability beyond SETUID/SETGID, the helper's file capabilities: the
  # operator channel's `docker exec -u 0` writes into commands/operator, which
  # is root's own (ensure_operator_channel), and needs none.
  # no-new-privileges stays off: it would void the helper's file capabilities;
  # the model's tools carry no_new_privs of their own.
  --cap-drop ALL --cap-add SETUID --cap-add SETGID
  -e "QCR_TOOLS_AS=${C[TOOL_UID]}"
  -p "127.0.0.1:${C[WEBHOOK_PORT]}:${C[WEBHOOK_PORT]}"
  --network "${C[MEMORY_NETWORK]}"
  -v "$ROOT/state:${C[APP_ROOT]}/state"
  -v "$ROOT/secrets:/opt/quickreview/secrets:ro"
  -v "$ROOT/config-home:/opt/quickreview/config-home:ro"
  -v "$ROOT/pihome:/home/qcr/.pi"
  -v "$ROOT/sandbox/wt:${C[APP_ROOT]}/wt"
  -v "$ROOT/sandbox/archive:${C[APP_ROOT]}/archive"
  -v "$ROOT/sandbox/commands:${C[APP_ROOT]}/commands"
  -v "$ROOT/sandbox/digest:${C[APP_ROOT]}/digest"
  -v "$ROOT/sandbox/inject:${C[APP_ROOT]}/inject"
  -v "$ROOT/sandbox/verdict:${C[APP_ROOT]}/verdict"
  # the sessions' own HOME (<root>/pihome: their ovcli.conf, recall hints, retired
  # list and pinned git config), the directory the legacy container kept beside them
  -v "$ROOT/sandbox/pihome:${C[APP_ROOT]}/pihome"
  -v "$ROOT/sandbox/${C[BASE_CLONE_DIR]}:${C[APP_ROOT]}/${C[BASE_CLONE_DIR]}"
  # path continuity for what the legacy container recorded
  -v "$ROOT/sandbox/wt:${C[LEGACY_SANDBOX_ROOT]}/wt"
  -v "$ROOT/sandbox/${C[BASE_CLONE_DIR]}:${C[LEGACY_SANDBOX_ROOT]}/${C[BASE_CLONE_DIR]}"
  -e "TZ=${C[TZ]}" -e "QC_REVIEW_PORT=${C[WEBHOOK_PORT]}" -e QC_BIND_HOST=0.0.0.0
  -e "QCR_CONFIG=$CONFIG_PATH_IN_CONTAINER"
)
if [[ -n "$SETID_GID" ]]; then
  # the helper's gate group, and the tool gid the shared directories belong to
  daemon_args+=(--group-add "$SETID_GID" --group-add "${C[TOOL_GID]}")
fi
if [[ -n "${C[DAEMON_ENV_FILE]:-}" && -f "${C[DAEMON_ENV_FILE]}" ]]; then
  daemon_args+=(--env-file "${C[DAEMON_ENV_FILE]}")
fi
daemon_args+=("$DAEMON_REF" daemon)
if container_exists "$DAEMON"; then
  d rm -f "$DAEMON-prev" >/dev/null 2>&1 || true
  d rename "$DAEMON" "$DAEMON-prev"
  OLD_DAEMON_RENAMED=1
fi
ensure_operator_channel
NEW_DAEMON_STARTED=1
d "${daemon_args[@]}" >/dev/null

# ---- the point of no return ---------------------------------------------------------------------------------------------
PHASE=committed
rm -f "$SWAP_MARKER"
step post-recreate
d tag "$DAEMON_REF" "${C[DAEMON_IMAGE_REPO]}:$VERSION" >/dev/null 2>&1 || true
d tag "$MEMORY_REF" "${C[MEMORY_IMAGE_REPO]}:$VERSION" >/dev/null 2>&1 || true
container_running "$DAEMON" || die "the new daemon container is not running right after the recreate (docker logs --tail 100 $DAEMON)"
STEP="done"
record_last_run "ok" "updated to $VERSION ($sha_label); the drain stays on until the first healthy reconcile lifts it"
log "updated to $VERSION (build $sha_label). The drain stays on: the new boot's first healthy reconcile lifts it (cutover: the owner triggers and checks one worker round first)"
