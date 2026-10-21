#!/usr/bin/env bash
# vm-postcutover-cleanup.sh — remove what the release-image cutover left behind
# on the review VM. Owner-run, ON the VM, as root, once the VM runs the release
# layout:
#
#   ssh <vm> 'sudo bash -s' < scripts/vm-postcutover-cleanup.sh
#       the DRY RUN (the default): lists every removal and every kept path
#       with its reason, removes nothing, and prints the plan key
#   ssh <vm> 'sudo bash -s -- --apply <plan key>' < scripts/vm-postcutover-cleanup.sh
#       removes exactly the plan the dry run printed; refuses when the plan has
#       changed since (a new key), so nothing is removed that was not listed first
#
# Idempotent: a run with nothing left to remove says so and exits 0.
#
# What it removes:
#   - the legacy image quickreview-sandbox:v1 and the old images built on the VM
#     (every tag of the local repositories quickreview-sandbox and
#     quickreview-memory: :dev, the legacy memory :v1). Never a ghcr.io release
#     image, never an image any container (running or stopped) still uses, and
#     never by force;
#   - the stale rsynced checkout under <root>/sandbox, through an ALLOWLIST of
#     the names the legacy rsync shipped (the repository's top level, plus
#     node_modules, dist and BUILD_SHA built on the VM). A name not on the
#     allowlist is kept and reported;
#   - all but the newest three updater snapshots, <backups>/<version>-<ts>/,
#     newest by the timestamp. A name of another shape is kept and reported.
#
# What it never touches:
#   - the sandbox/ directories the release containers mount (wt, archive,
#     commands, digest, inject, verdict, pihome and the base clone). The set is
#     DERIVED, every run, as the union of: that baseline; every
#     `$ROOT/sandbox/<dir>` the installed updater (/usr/local/sbin/qcr-update)
#     names, with its run-spec values filled in; and every bind-mount source of
#     every container on the host (running or stopped). A path that is a mount
#     source, lies under one or holds one is kept. A future mount is therefore
#     protected without an edit here; tests/vm-postcutover-cleanup.test.ts fails
#     if it is not;
#   - the legacy runtime data the old rsync excluded (sandbox/state, memory,
#     notes, ledger.md, AGENTS.override.md): reported, kept, the owner's call;
#   - anything outside sandbox/ and the snapshot dir: state/, secrets/,
#     config-home*, pihome/, memory-state/. The daemon's pre-sidecar OpenViking
#     store (state/openviking) and the stores set aside by rescued updates
#     (memory-state.rescued-*) are reported as an OWNER DECISION and kept.
#
# It refuses unless `qcr-update status --json` reports the release layout, and
# it holds the updater's own lock, so it never runs beside a deploy.
#
# Test seam (as for qcr-update: run as a non-root user with QCR_CLEANUP_CONF
# set; root ignores all of it and sudo resets the environment anyway):
#   QCR_CLEANUP_CONF      the run spec (else /etc/qcr/update.conf)
#   QCR_CLEANUP_UPDATER   the updater, read for its mounts and run for its status
#   QCR_CLEANUP_DOCKER    the docker command
# The paths themselves (the root, the snapshot dir) come from the run spec.

set -Eeuo pipefail
umask 077
export LC_ALL=C

SELF="vm-postcutover-cleanup"
KEEP_SNAPSHOTS=3

# The local image repositories the legacy deploys built on the VM.
LEGACY_IMAGE_REPOS=(quickreview-sandbox quickreview-memory)

# The sandbox/ directories the release containers mount (the baseline; the
# updater's mounts and the live containers' mounts are added every run).
BASELINE_RUNTIME=(wt archive commands digest inject verdict pihome)

# Runtime data the legacy rsync excluded (deploy/ansible/playbook.yml before
# the release layout): never checkout content, so never removed here.
LEGACY_RUNTIME=(state memory notes ledger.md AGENTS.override.md)

# The checkout allowlist: the top-level names the legacy rsync shipped (every
# top-level name the repository has tracked, minus the runtime directories
# above) and what the legacy container built in place.
CHECKOUT_ALLOWLIST=(
  .agents .cache .claude-plugin .dockerignore .github .gitignore .pi .prettierignore
  AGENTS.md BUILD_SHA CLAUDE.md CONTEXT.md CONTRIBUTING.md FROZEN-SEED-FENCES.md
  LICENSE MANIFESTO.md README.md RESEED-SUMMARY.md SECURITY.md THIRD-PARTY-NOTICES.md
  action.yml agents bench config.example.toml config.toml deploy dist docker
  docker-compose.yml docs eslint.config.js extensions node_modules package-lock.json
  package.json plugins prettier.config.js profiles prompts publish-manifest.internal.json
  publish-manifest.json schemas scripts seeds skills src tests tsconfig.json
  tsconfig.tests.json vitest.config.ts
)

# ---- the seam -------------------------------------------------------------------

TEST_MODE=0
if [[ "$(id -u)" -eq 0 ]]; then
  CONF=/etc/qcr/update.conf
  UPDATER=/usr/local/sbin/qcr-update
  DOCKER=docker
elif [[ -n "${QCR_CLEANUP_CONF:-}" ]]; then
  TEST_MODE=1
  CONF="$QCR_CLEANUP_CONF"
  UPDATER="${QCR_CLEANUP_UPDATER:-/usr/local/sbin/qcr-update}"
  DOCKER="${QCR_CLEANUP_DOCKER:-docker}"
else
  echo "$SELF: must run as root, on the VM (ssh <vm> 'sudo bash -s' < scripts/$SELF.sh)" >&2
  exit 2
fi

die() {
  echo "$SELF: $*" >&2
  exit 1
}
note() { echo "$SELF: $*" >&2; }
d() { "$DOCKER" "$@"; }

usage() {
  echo "usage: $SELF                     the dry run: list the plan and its key, remove nothing" >&2
  echo "       $SELF --apply <plan key>  remove exactly the plan the dry run listed" >&2
  exit 2
}

APPLY=0
APPLY_KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      [[ $# -ge 2 ]] || { echo "$SELF: --apply needs the plan key the dry run printed" >&2; usage; }
      APPLY=1
      APPLY_KEY="$2"
      shift
      ;;
    --dry-run) ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
  shift
done

# ---- the run spec (read-only) ---------------------------------------------------------

declare -A C=()
NEEDED_KEYS=(SANDBOX_ROOT BACKUP_DIR BASE_CLONE_DIR MEMORY_STATE_DIR OPENVIKING_HOME UPDATE_STATE_DIR)

[[ -f "$CONF" ]] || die "no run spec at $CONF: this VM was never provisioned for the release layout"
if [[ $TEST_MODE -eq 0 ]]; then
  [[ "$(stat -c '%u' "$CONF")" == 0 ]] || die "$CONF is not owned by root"
fi
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./:@+,-]*)$ ]] || die "$CONF has a line this script will not read: ${line:0:60}"
  C["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
done <"$CONF"
for key in "${NEEDED_KEYS[@]}"; do
  [[ -n "${C[$key]:-}" ]] || die "$CONF lacks $key"
done
for key in SANDBOX_ROOT BACKUP_DIR MEMORY_STATE_DIR OPENVIKING_HOME UPDATE_STATE_DIR; do
  [[ "${C[$key]}" == /* && "${C[$key]}" != / && "${C[$key]}" != */ && "${C[$key]}" != *..* ]] ||
    die "$CONF $key is not a plain absolute path: ${C[$key]}"
done
[[ "${C[BASE_CLONE_DIR]}" =~ ^[A-Za-z0-9_.-]+$ && "${C[BASE_CLONE_DIR]}" != . && "${C[BASE_CLONE_DIR]}" != .. ]] ||
  die "$CONF BASE_CLONE_DIR is not a plain directory name: ${C[BASE_CLONE_DIR]}"

ROOT="${C[SANDBOX_ROOT]}"
SB="$ROOT/sandbox"
BACKUPS="${C[BACKUP_DIR]}"

# ---- the layout, and the updater's lock -------------------------------------------------

[[ -f "$UPDATER" && -r "$UPDATER" ]] || die "no updater at $UPDATER: this VM is not on the release layout"
status_json="$("$UPDATER" status --json 2>/dev/null)" || die "\`qcr-update status --json\` failed: cannot tell the layout, refusing"
layout="$(printf '%s' "$status_json" | sed -n 's/^{"layout":"\([a-z]*\)".*/\1/p' | head -n1)"
[[ "$layout" == release ]] ||
  die "refusing: qcr-update reports layout '${layout:-unreadable}', not release. This script runs only after the cutover"

mkdir -p "${C[UPDATE_STATE_DIR]}"
exec 9>"${C[UPDATE_STATE_DIR]}/update.lock"
flock -n 9 || die "qcr-update is running (lock ${C[UPDATE_STATE_DIR]}/update.lock): try again once it is done"

[[ ! -L "$SB" ]] || die "$SB is a symlink: refusing"
[[ ! -L "$BACKUPS" ]] || die "$BACKUPS is a symlink: refusing"

# ---- what is live -----------------------------------------------------------------------------

declare -A PROTECT=() # sandbox/<name> -> why it is kept
for n in "${BASELINE_RUNTIME[@]}" "${C[BASE_CLONE_DIR]}"; do
  PROTECT["$n"]="a runtime mount of the release containers"
done

# Every sandbox/ directory the installed updater names. Over-matching only
# protects more; a name it cannot resolve is a refusal, never a guess.
updater_names=0
while IFS= read -r raw; do
  n="${raw#\$ROOT/sandbox/}"
  while [[ "$n" =~ \$\{C\[([A-Z][A-Z0-9_]*)\]\} ]]; do
    key="${BASH_REMATCH[1]}"
    [[ -n "${C[$key]:-}" ]] || die "the updater names $raw, but $CONF has no $key: cannot tell which directory is live, refusing"
    n="${n//"\${C[$key]}"/"${C[$key]}"}"
  done
  [[ "$n" != *'$'* ]] || die "the updater names $raw, which this script cannot resolve: refusing"
  n="${n%%/*}"
  [[ -n "$n" && "$n" != . && "$n" != .. ]] || die "the updater names $raw, which is not a sandbox directory: refusing"
  PROTECT["$n"]="mounted by qcr-update"
  updater_names=$((updater_names + 1))
done < <(grep -oE '\$ROOT/sandbox/[A-Za-z0-9_.${}-]+(\[[A-Z0-9_]+\]\})?' "$UPDATER" || true)
((updater_names > 0)) || die "found no \$ROOT/sandbox/ mount in $UPDATER: cannot tell what is live, refusing"
if grep -qE '\$ROOT/sandbox([^/]|$)|\$ROOT[:"]' "$UPDATER"; then
  die "the updater mounts the whole root or checkout: refusing"
fi

# Every mount source and every image of every container on the host.
MOUNT_SRC=()
MOUNT_OWNER=()
declare -A IMAGE_USER=() # image id -> a container that uses it
container_ids="$(d ps -aq --no-trunc)" || die "\`docker ps -a\` failed: cannot tell what is mounted, refusing"
for id in $container_ids; do
  info="$(d container inspect -f '{{.Name}} {{.Image}}' "$id")" || die "cannot inspect container $id: refusing"
  cname="${info%% *}"
  cname="${cname#/}"
  IMAGE_USER["${info#* }"]="$cname"
  mounts="$(d container inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$id")" ||
    die "cannot read the mounts of container $cname: refusing"
  while IFS= read -r src; do
    [[ -n "$src" ]] || continue
    [[ "$src" == / ]] || src="${src%/}"
    MOUNT_SRC+=("$src")
    MOUNT_OWNER+=("$cname")
  done <<<"$mounts"
done

# The container mounting <path>, a path under it, or a directory holding it; "" if none.
mounted_by() {
  local p="$1" i s
  for i in "${!MOUNT_SRC[@]}"; do
    s="${MOUNT_SRC[$i]}"
    if [[ "$s" == / || "$s" == "$p" || "$s" == "$p"/* || "$p" == "$s"/* ]]; then
      printf '%s' "${MOUNT_OWNER[$i]}"
      return 0
    fi
  done
  return 0
}

in_list() {
  local x="$1"
  shift
  local y
  for y in "$@"; do [[ "$x" == "$y" ]] && return 0; done
  return 1
}

# ---- the plan -----------------------------------------------------------------------------------

REMOVE=() # "<kind> <what>"
KEEP=()   # "<kind> <what> — <why>"

remove() { REMOVE+=("$1 $2"); }
keep() { KEEP+=("$1 $2 — $3"); }

# 1. images
images="$(d image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}')" || die "\`docker image ls\` failed: refusing"
while IFS= read -r row; do
  [[ -n "$row" ]] || continue
  ref="${row%% *}"
  iid="${row#* }"
  repo="${ref%:*}"
  tag="${ref##*:}"
  in_list "$repo" "${LEGACY_IMAGE_REPOS[@]}" || continue
  [[ "$tag" != "<none>" ]] || continue
  if [[ -n "${IMAGE_USER[$iid]:-}" ]]; then
    keep image "$ref" "in use by container ${IMAGE_USER[$iid]} (remove that container first, then run again)"
  else
    remove image "$ref"
  fi
done <<<"$images"

# 2. the checkout
if [[ -d "$SB" ]]; then
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    owner="$(mounted_by "$path")"
    if [[ -n "${PROTECT[$name]:-}" ]]; then
      keep runtime "$path" "${PROTECT[$name]}"
    elif [[ -n "$owner" ]]; then
      keep runtime "$path" "mounted by container $owner"
    elif in_list "$name" "${LEGACY_RUNTIME[@]}"; then
      keep legacy "$path" "runtime data of the legacy container, not checkout content: owner decision"
    elif in_list "$name" "${CHECKOUT_ALLOWLIST[@]}"; then
      remove checkout "$path"
    else
      keep unknown "$path" "not on the checkout allowlist: look at it by hand"
    fi
  done < <(find "$SB" -mindepth 1 -maxdepth 1 -print0 | sort -z)
fi

# 3. the updater's snapshots, newest first by their timestamp
if [[ -d "$BACKUPS" ]]; then
  SNAP_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?-([0-9]{8}T[0-9]{6}Z)$'
  snaps=()
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    if [[ -d "$path" && ! -L "$path" && "$name" =~ $SNAP_RE ]]; then
      snaps+=("${BASH_REMATCH[2]} $name")
    else
      keep unknown "$path" "not an updater snapshot (<version>-<ts>/)"
    fi
  done < <(find "$BACKUPS" -mindepth 1 -maxdepth 1 -print0 | sort -z)
  rank=0
  while IFS= read -r row; do
    [[ -n "$row" ]] || continue
    path="$BACKUPS/${row#* }"
    rank=$((rank + 1))
    owner="$(mounted_by "$path")"
    if ((rank <= KEEP_SNAPSHOTS)); then
      keep snapshot "$path" "one of the newest $KEEP_SNAPSHOTS"
    elif [[ -n "$owner" ]]; then
      keep snapshot "$path" "mounted by container $owner"
    else
      remove snapshot "$path"
    fi
  done < <(if ((${#snaps[@]} > 0)); then printf '%s\n' "${snaps[@]}" | sort -r; fi)
fi

# 4. the owner's decisions, reported and kept
[[ ! -e "${C[OPENVIKING_HOME]}" ]] ||
  keep owner "${C[OPENVIKING_HOME]}" "the daemon's pre-sidecar OpenViking store: a separate owner decision"
for path in "${C[MEMORY_STATE_DIR]}".rescued-*; do
  [[ -e "$path" ]] || continue
  keep owner "$path" "a sidecar store set aside by a rescued update: owner decision"
done

PLAN_KEY="$(if ((${#REMOVE[@]} > 0)); then printf '%s\n' "${REMOVE[@]}"; fi | sha256sum | cut -c1-16)"

print_plan() {
  local row
  for row in "${REMOVE[@]+"${REMOVE[@]}"}"; do
    printf 'remove  %-9s %s\n' "${row%% *}" "${row#* }"
  done
  for row in "${KEEP[@]+"${KEEP[@]}"}"; do
    printf 'keep    %-9s %s\n' "${row%% *}" "${row#* }"
  done
}

# ---- the dry run ----------------------------------------------------------------------------------

if [[ $APPLY -eq 0 ]]; then
  echo "$SELF: DRY RUN on the release layout. Nothing is removed."
  print_plan
  if ((${#REMOVE[@]} == 0)); then
    echo "nothing to remove"
    exit 0
  fi
  echo "plan key: $PLAN_KEY"
  echo "to remove exactly the ${#REMOVE[@]} item(s) listed: --apply $PLAN_KEY"
  exit 0
fi

# ---- apply ----------------------------------------------------------------------------------------

if ((${#REMOVE[@]} == 0)); then
  echo "$SELF: nothing to remove"
  exit 0
fi
[[ "$APPLY_KEY" == "$PLAN_KEY" ]] ||
  die "refusing: the plan is not the one the dry run listed (its key is now $PLAN_KEY). Run the dry run again and read it"

# One path, re-checked at the moment of removal: a direct child of the checkout
# or of the snapshot dir, not protected, not mounted.
rm_path() {
  local path="$1" parent="${1%/*}" name="${1##*/}"
  [[ "$parent" == "$SB" || "$parent" == "$BACKUPS" ]] || { note "not removing $path: outside $SB and $BACKUPS"; return 1; }
  [[ -n "$name" && "$name" != . && "$name" != .. ]] || { note "not removing $path"; return 1; }
  if [[ "$parent" == "$SB" && -n "${PROTECT[$name]:-}" ]]; then note "not removing $path: ${PROTECT[$name]}"; return 1; fi
  [[ -z "$(mounted_by "$path")" ]] || { note "not removing $path: a container mounts it"; return 1; }
  [[ -e "$path" || -L "$path" ]] || return 0
  rm -rf --one-file-system -- "$path"
}

failed=0
for row in "${REMOVE[@]}"; do
  kind="${row%% *}"
  what="${row#* }"
  case "$kind" in
    image) d image rm "$what" >/dev/null || { note "could not remove the image $what"; failed=1; continue; } ;;
    checkout | snapshot) rm_path "$what" || { note "could not remove $what"; failed=1; continue; } ;;
    *) die "internal: unknown plan row $row" ;;
  esac
  echo "removed $kind $what"
done
if [[ $failed -ne 0 ]]; then
  die "some removals failed (above); the rest is done. Run the dry run again to see what is left"
fi
echo "$SELF: done. A dry run now lists nothing to remove."
