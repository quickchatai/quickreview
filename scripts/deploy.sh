#!/usr/bin/env bash
# deploy.sh — push this working copy to the review-sandbox VM, through the
# ansible. Spec §9 (revised): the runtime is ONE Docker container with
# cloudflared on the host, so "deploy" means
#
#   sync    rsync the sandbox working copy into /opt/quickreview/sandbox and
#           recreate the container (no image rebuild — pins untouched)
#   rebuild the same, but force the image rebuild (-e rebuild_image=true) —
#           the deliberate act after bumping a pin
#   verify  post-deploy checks on the VM: cloudflared + docker services, the
#           container, and the state/status.json heartbeat the status collector
#           reads
#
# There are no systemd units for the daemon any more: quickreviewd is the
# container entrypoint (`restart: unless-stopped`). The only host service this
# script cares about is cloudflared.
#
# Guardrails (all pre-flight, all fatal):
#   * refuses to deploy a dirty working tree — what runs on the VM must be a
#     commit you can point at
#   * refuses when config.toml's [pi] version and the ansible group_vars
#     pi_version disagree, and refuses on the "PIN-ME" placeholder. The pin
#     never floats and this script never bumps it (spec §9).
#   * refuses on OpenViking pin drift, the same way. Three pins,
#     two mirrors:
#       - [openviking] version              == group_vars openviking_version
#       - [openviking] llama_cpp_python_version
#                                           == group_vars llama_cpp_python_version
#         (the Dockerfile venv layer interpolates the group_vars, never a
#          literal — so agreeing here means agreeing in the image)
#       - [openviking] extension_commit     == extensions/vendor/openviking-pi/
#                                              upstream.json "commit"
#         (the vendored fork rides the rsync, not the image)
#
# This script performs NO live run on its own beyond ansible/ssh; every live
# invocation belongs to the owner on a machine with VM access.
#
# Usage:
#   scripts/deploy.sh [--dry-run] [sync|rebuild|verify]
#
# Env:
#   QC_ANSIBLE_DIR  ansible project dir (default: the asset path)
#   QC_INVENTORY    inventory file      (default: $QC_ANSIBLE_DIR/inventory.ini)
#   QC_SANDBOX_DIR  sandbox working copy (default: this script's parent)
#   QC_VM_HOST      ssh target for `verify` (default: the inventory's first host)
#   QCR_CONFIG      config.toml path    (default: $QC_SANDBOX_DIR/config.toml)

set -euo pipefail

SELF="$(basename "${BASH_SOURCE[0]}")"
DEFAULT_ANSIBLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/ansible"

SANDBOX_DIR="${QC_SANDBOX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ANSIBLE_DIR="${QC_ANSIBLE_DIR:-$DEFAULT_ANSIBLE_DIR}"
INVENTORY="${QC_INVENTORY:-$ANSIBLE_DIR/inventory.ini}"
CONFIG="${QCR_CONFIG:-$SANDBOX_DIR/config.toml}"
GROUP_VARS="$ANSIBLE_DIR/group_vars/all.yml"
PLAYBOOK="$ANSIBLE_DIR/playbook.yml"
CONTAINER="quickreview-sandbox"
OV_UPSTREAM="$SANDBOX_DIR/extensions/vendor/openviking-pi/upstream.json"

# The playbook (an asset — never edited from here) carries no tags, so "sync"
# is expressed as a start-at-task: everything from the working-copy rsync
# onwards (rsync → build context → image → container recreate), skipping host
# packages, cloudflared install and the secrets/seed copies.
SYNC_START_TASK="Sync the local sandbox working copy (daemon, extensions) when present"

MODE=""
DRY_RUN=0

die() { echo "$SELF: $*" >&2; exit 1; }
note() { echo "$SELF: $*" >&2; }

# ---- arguments ---------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    sync|rebuild|verify) [[ -n "$MODE" ]] && die "two modes given: $MODE and $1"; MODE="$1" ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1' (usage: $SELF [--dry-run] [sync|rebuild|verify])" ;;
  esac
  shift
done
MODE="${MODE:-sync}"

# ---- helpers -----------------------------------------------------------------

# config.toml [pi] version, without a TOML parser: take the `version = "…"`
# that follows the [pi] table header.
config_pi_version() {
  awk '
    /^\[pi\]/            { in_pi = 1; next }
    /^\[/                { in_pi = 0 }
    in_pi && /^[[:space:]]*version[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/["'"'"']/, "", line)
      sub(/[[:space:]]*(#.*)?$/, "", line)
      print line
      exit
    }
  ' "$CONFIG"
}

# A `<key>: "<value>"` scalar out of the ansible group_vars.
group_vars_key() {
  awk -v key="$1" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*:" {
      line = $0
      sub(/^[^:]*:[[:space:]]*/, "", line)
      gsub(/["'"'"']/, "", line)
      sub(/[[:space:]]*(#.*)?$/, "", line)
      print line
      exit
    }
  ' "$GROUP_VARS"
}

group_vars_pi_version() { group_vars_key pi_version; }

# A `<key> = "<value>"` scalar out of a named config.toml table.
config_table_key() {
  awk -v table="$1" -v key="$2" '
    $0 ~ "^\\[" table "\\]"  { in_t = 1; next }
    /^\[/                    { in_t = 0 }
    in_t && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/["'"'"']/, "", line)
      sub(/[[:space:]]*(#.*)?$/, "", line)
      print line
      exit
    }
  ' "$CONFIG"
}

# A `<key> = ["a", "b"]` ARRAY out of a named config.toml table, normalised to
# the comma-joined spelling group_vars carries (`openviking_provision_users`).
# One line only: every list this compares is one line by convention.
config_list_key() {
  local raw
  raw="$(config_table_key "$1" "$2")"
  [[ -n "$raw" ]] || return 0
  raw="${raw#[}"
  raw="${raw%]}"
  echo "$raw" | tr -d ' ' | sed 's/,$//'
}

# upstream.json's "commit" — the vendored fork's base commit (mirror 2 of 2).
upstream_commit() {
  [[ -f "$OV_UPSTREAM" ]] || return 0
  awk -F'"' '/^[[:space:]]*"commit"[[:space:]]*:/ { print $4; exit }' "$OV_UPSTREAM"
}

# One pin, two spellings that must agree. Empty on EITHER side is fatal: a pin
# we cannot read is a pin we cannot verify, and this script never guesses.
check_pin() {
  local label="$1" a_where="$2" a="$3" b_where="$4" b="$5"
  [[ -n "$a" ]] || die "$a_where has no $label pin — cannot verify it"
  [[ -n "$b" ]] || die "$b_where has no $label pin — cannot verify it"
  if [[ "$a" != "$b" ]]; then
    cat >&2 <<EOF
$SELF: $label pin mismatch — refusing to deploy.

    $a_where = "$a"
    $b_where = "$b"

Deploying would change a pinned version on the VM. That is a deliberate act:
reconcile the two by hand, then run
    $SELF rebuild
so the image is rebuilt against the new pin.
EOF
    exit 1
  fi
}

first_inventory_host() {
  [[ -f "$INVENTORY" ]] || return 0
  awk '/^[[:space:]]*[#;]/ { next }
       /^[[:space:]]*\[/   { next }
       NF { print $1; exit }' "$INVENTORY"
}

# ---- pre-flight --------------------------------------------------------------

[[ -f "$CONFIG" ]] || die "no config.toml at $CONFIG"
[[ -d "$ANSIBLE_DIR" ]] || die "no ansible dir at $ANSIBLE_DIR (set QC_ANSIBLE_DIR)"
[[ -f "$GROUP_VARS" ]] || die "no group_vars at $GROUP_VARS"
[[ -f "$PLAYBOOK" ]] || die "no playbook at $PLAYBOOK"

# 1. clean tree
if ! git -C "$SANDBOX_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  die "$SANDBOX_DIR is not a git repository — refusing to deploy an untracked tree"
fi
DIRTY="$(git -C "$SANDBOX_DIR" status --porcelain)"
if [[ -n "$DIRTY" ]]; then
  echo "$SELF: refusing to deploy — the working tree is dirty:" >&2
  echo "$DIRTY" | sed 's/^/    /' >&2
  echo "$SELF: commit (locally — never push, never master/main) and re-run." >&2
  exit 1
fi
HEAD_SHA="$(git -C "$SANDBOX_DIR" rev-parse --short HEAD 2>/dev/null || echo "no-commits")"

# 2. the pi pin must agree, and must not be the placeholder
CFG_PI="$(config_pi_version || true)"
GV_PI="$(group_vars_pi_version || true)"
[[ -n "$CFG_PI" ]] || die "config.toml has no [pi] version key — cannot verify the pin"
[[ -n "$GV_PI" ]] || die "group_vars/all.yml has no pi_version key — cannot verify the pin"

if [[ "$GV_PI" == "PIN-ME" ]]; then
  cat >&2 <<EOF
$SELF: the ansible pin is still the placeholder.

    $GROUP_VARS
        pi_version: "PIN-ME"     ->  pi_version: "$CFG_PI"

Confirm the package name against assets/findings.md, set the exact
version by hand, then re-run. The image never floats and this script never
bumps a pin for you.
EOF
  exit 1
fi

if [[ "$CFG_PI" != "$GV_PI" ]]; then
  cat >&2 <<EOF
$SELF: pi version mismatch — refusing to deploy.

    config.toml   [pi] version = "$CFG_PI"
    group_vars    pi_version   = "$GV_PI"

Deploying would change the pinned pi version on the VM. That is a deliberate
act: reconcile the two by hand (and package.json's "pi" block), then run
    $SELF rebuild
so the image is rebuilt against the new pin.
EOF
  exit 1
fi

# 2b. the OpenViking pins must agree too. Same discipline as pi: the
# memory engine never floats, and a rebase of the vendored fork that nobody
# recorded in config.toml is exactly the drift `extension_commit` exists to
# catch. `[openviking]` is fully defaulted in code, so an older config.toml may
# genuinely carry no block — in that case there is nothing to compare and the
# check stands down rather than inventing a mismatch.
CFG_OV="$(config_table_key openviking version || true)"
if [[ -n "$CFG_OV" ]]; then
  check_pin "openviking" \
    'config.toml   [openviking] version' "$CFG_OV" \
    'group_vars    openviking_version' "$(group_vars_key openviking_version || true)"
  check_pin "llama-cpp-python" \
    'config.toml   [openviking] llama_cpp_python_version' "$(config_table_key openviking llama_cpp_python_version || true)" \
    'group_vars    llama_cpp_python_version' "$(group_vars_key llama_cpp_python_version || true)"
  # the auth posture is mirrored the same way the pins are, and for
  # the same reason — the entrypoint renders group_vars, so a config.toml that
  # says "api_key" while group_vars says "dev" would ship a server with NO
  # per-user confinement while every doc claims otherwise. Same for the secret
  # FILE NAMES the template interpolates and the user list it provisions:
  # drift there is a memory outage or an unprovisioned user, silently.
  CFG_OV_AUTH="$(config_table_key openviking auth_mode || true)"
  if [[ -n "$CFG_OV_AUTH" ]]; then
    check_pin "openviking auth_mode" \
      'config.toml   [openviking] auth_mode' "$CFG_OV_AUTH" \
      'group_vars    openviking_auth_mode' "$(group_vars_key openviking_auth_mode || true)"
    check_pin "openviking root key file" \
      'config.toml   [openviking] root_key_file' "$(config_table_key openviking root_key_file || true)" \
      'group_vars    openviking_root_key_file' "$(group_vars_key openviking_root_key_file || true)"
    check_pin "openviking reviewer key file" \
      'config.toml   [openviking] reviewer_key_file' "$(config_table_key openviking reviewer_key_file || true)" \
      'group_vars    openviking_reviewer_key_file' "$(group_vars_key openviking_reviewer_key_file || true)"
    check_pin "openviking provisioned users" \
      'config.toml   [openviking] provision_users' "$(config_list_key openviking provision_users || true)" \
      'group_vars    openviking_provision_users' "$(group_vars_key openviking_provision_users || true)"
  fi
  CFG_OV_EXT="$(config_table_key openviking extension_commit || true)"
  if [[ -n "$CFG_OV_EXT" ]]; then
    check_pin "openviking pi-extension base commit" \
      'config.toml   [openviking] extension_commit' "$CFG_OV_EXT" \
      'upstream.json "commit"' "$(upstream_commit || true)"
  fi
else
  note "config.toml carries no [openviking] block — memory-engine pins not verified"
fi

# 3. sandbox_src must be wired, or the rsync task no-ops
if ! grep -Eq '^[[:space:]]*sandbox_src[[:space:]]*:' "$GROUP_VARS"; then
  die "group_vars/all.yml has no active 'sandbox_src' — uncomment it (it must point at $SANDBOX_DIR) or the working copy is never synced"
fi

# ---- plan --------------------------------------------------------------------

ANSIBLE_CMD=(ansible-playbook -i "$INVENTORY" "$PLAYBOOK")
case "$MODE" in
  sync)    ANSIBLE_CMD+=(--start-at-task "$SYNC_START_TASK" -e force_restart=true) ;;
  rebuild) ANSIBLE_CMD+=(-e rebuild_image=true) ;;
  verify)  ANSIBLE_CMD=() ;;
esac

VM_HOST="${QC_VM_HOST:-$(first_inventory_host)}"
VERIFY_CMDS=(
  "systemctl is-active cloudflared"
  "systemctl is-active docker"
  "sudo docker ps --filter name=$CONTAINER --format '{{.Names}} {{.Status}}'"
  "sudo docker exec $CONTAINER tmux ls || echo 'no tmux sessions yet'"
  "cat /opt/quickreview/state/status.json | head -20   # heartbeat for the status collector"
)

print_plan() {
  echo "plan — $SELF $MODE"
  echo "  sandbox      $SANDBOX_DIR @ $HEAD_SHA (clean)"
  echo "  ansible      $ANSIBLE_DIR"
  echo "  inventory    $INVENTORY"
  echo "  pi pin       $CFG_PI (config.toml == group_vars, not bumped)"
  if [[ -n "$CFG_OV" ]]; then
    echo "  memory pins  openviking $CFG_OV (config.toml == group_vars == image layer), extension ${CFG_OV_EXT:-<unset>} (config.toml == upstream.json)"
    echo "  memory auth  auth_mode ${CFG_OV_AUTH:-<unset>} (config.toml == group_vars; 'dev' means NO per-user confinement)"
  else
    echo "  memory pins  <no [openviking] block in config.toml — unverified>"
  fi
  echo "  vm host      ${VM_HOST:-<unset — set QC_VM_HOST>}"
  case "$MODE" in
    sync)    echo "  action       mirror-rsync working copy -> /opt/quickreview/sandbox (--delete, runtime dirs kept), restart container (no image rebuild)" ;;
    rebuild) echo "  action       full playbook with -e rebuild_image=true (image rebuilt against the pins)" ;;
    verify)  echo "  action       post-deploy checks over ssh only (no ansible)" ;;
  esac
  if [[ ${#ANSIBLE_CMD[@]} -gt 0 ]]; then
    echo "  command      ${ANSIBLE_CMD[*]}"
  fi
  echo "  then verify  ssh ${VM_HOST:-<vm>}:"
  local c
  for c in "${VERIFY_CMDS[@]}"; do echo "                 $c"; done
  echo "  dry_run      config.toml dry_run is NOT touched by deploy — the cutover flip is a manual edit"
  if [[ "$MODE" != "verify" ]]; then
    echo "  marker       BUILD_SHA=$HEAD_SHA written before the rsync (gitignored; the qcr tui deploy tab reads it on the VM)"
  fi
}

if [[ $DRY_RUN -eq 1 ]]; then
  print_plan
  echo
  echo "(--dry-run: nothing executed)"
  exit 0
fi

# ---- execute -----------------------------------------------------------------

print_plan >&2
echo >&2

if [[ "$MODE" != "verify" ]]; then
  command -v ansible-playbook >/dev/null 2>&1 || die "ansible-playbook not on PATH — run this from the controller machine"
  [[ -f "$INVENTORY" ]] || die "no inventory at $INVENTORY (cp inventory.example.ini inventory.ini, then edit; or set QC_INVENTORY)"
  # Rebuild dist HERE, against the exact tree being shipped. The rsync mirrors
  # dist/ and the container entrypoint rebuilds only when package-lock.json
  # changes — so a stale local dist ships stale COMPILED code under a fresh
  # BUILD_SHA. Bit us live 2026-08-18: three fix deploys shipped source whose
  # dist was still the pre-fix build (builds had run in worktrees, never in
  # this checkout), and the daemon kept spawning sessions with the old argv.
  note "building dist against $HEAD_SHA"
  (cd "$SANDBOX_DIR" && npm run build) || die "npm run build failed — refusing to ship a tree whose dist cannot be rebuilt"
  # BUILD_SHA rides the rsync so the VM can answer "what commit runs here?"
  # (the qcr tui deploy tab diffs local HEAD against it). Gitignored, so the
  # clean-tree guard above stays meaningful.
  printf '%s %s %s\n' "$HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" > "$SANDBOX_DIR/BUILD_SHA"
  note "running: ${ANSIBLE_CMD[*]}"
  "${ANSIBLE_CMD[@]}"
fi

[[ -n "$VM_HOST" ]] || die "no VM host resolved — set QC_VM_HOST to run the post-deploy checks"
note "post-deploy checks on $VM_HOST"
FAILED=0
for cmd in "${VERIFY_CMDS[@]}"; do
  echo "--- $cmd"
  if ! ssh -o BatchMode=yes "$VM_HOST" "$cmd"; then
    FAILED=1
    echo "$SELF: CHECK FAILED: $cmd" >&2
  fi
done

if [[ $FAILED -ne 0 ]]; then
  cat >&2 <<'EOF'
One or more post-deploy checks failed. Triage order (README §fallback):
  1. cloudflared inactive        -> systemctl restart cloudflared; journalctl -u cloudflared -n 50
  2. container not running       -> docker logs quickreview-sandbox --tail 100
  3. stale/absent status.json    -> the daemon is not writing its heartbeat; docker logs, then restart the container
While the sandbox is down, run manual laptop ticks (`/auto-review <n>`) —
NEVER concurrently with a live sandbox.
EOF
  exit 1
fi
note "deploy ok ($MODE, $HEAD_SHA)"
