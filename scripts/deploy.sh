#!/usr/bin/env bash
# deploy.sh — deploy the review-sandbox VM. The runtime is the RELEASE IMAGE
# (docker/Dockerfile) in `daemon` mode, one Docker container named
# quickreview-sandbox plus the memory sidecar beside it, with cloudflared on the
# host. The images are built ONCE, by CI, from the release tag; the VM pulls
# those exact images by digest. Nothing is rsynced, built or installed on the
# VM by a deploy. Three modes:
#
#   release <version>  the deploy. A controller preflight (the manifest, the
#                      pins, the run spec), then
#                        tar config.toml profiles/ | ssh vm sudo qcr-update ...
#                      and the post-deploy checks. qcr-update
#                      (deploy/qcr-update.sh, installed by provision) is the
#                      only thing that runs on the VM: it takes a flock, refuses
#                      an undrained or busy board, pulls both images by digest,
#                      checks the new image's `qcr config check` on the staged
#                      config, stops the daemon, snapshots state, runs the new
#                      image's `daemon --preflight` on a scratch copy, seeds the
#                      sidecar store (legacy layout only), swaps the config,
#                      starts the sidecar and recreates the daemon -- and
#                      rescues the old version on any failure before the
#                      recreate. See the header of deploy/qcr-update.sh.
#                        --manifest FILE    deploy-manifest-<version>.json, the
#                                           CI artifact (deploy/manifest.schema.json;
#                                           default ./deploy-manifest-<version>.json)
#                        --cutover-ack      the VM still runs the legacy layout:
#                                           this deploy is the cutover, and the
#                                           first boot migrates forward. Without
#                                           it the updater (and this script)
#                                           refuse.
#   provision          ansible installs packages, Docker, cloudflared, secrets,
#                      the directory layout, the updater
#                      (/usr/local/sbin/qcr-update) and its run spec
#                      (/etc/qcr/update.conf, rendered here from group_vars).
#                      It never pulls or starts an image. Re-run it when the
#                      run spec changes (a release whose image needs a newer
#                      run spec is refused with "re-run provision").
#   verify             post-deploy checks on the VM: the docker service (and
#                      cloudflared when the inventory enables it), the
#                      containers, the image stamp, the pi settings and the
#                      reviewer stub, and the state/status.json heartbeat the
#                      status collector reads. It also warns 14 days before the
#                      VM's ghcr pull token expires (the expiry that
#                      scripts/vm-ghcr-login.sh recorded).
#
# `sync`, `dev` and `rebuild` are gone (the on-VM rsync and build are deleted):
# they refuse with a pointer to `release`. A pre-release fix is a release.
#
# There are no systemd units for the daemon: quickreviewd is the container's
# command (`restart: unless-stopped`). The only host service this script cares
# about is cloudflared, and only when `cloudflared_enabled` is true -- the
# playbook installs it on exactly that condition.
#
# Guardrails (all pre-flight, all fatal):
#   * refuses to deploy a dirty working tree -- group_vars and the pins are
#     read from this checkout, so it must be a commit you can point at
#   * refuses when config.toml's [pi] version and the ansible group_vars
#     pi_version disagree, and refuses on the "PIN-ME" placeholder. The pin
#     never floats and this script never bumps it.
#   * refuses on OpenViking pin drift, the same way. Four pins:
#       - [openviking] version              == group_vars openviking_version
#       - [openviking] llama_cpp_python_version
#                                           == group_vars llama_cpp_python_version
#       - [openviking] extension_commit     == extensions/vendor/openviking-pi/
#                                              upstream.json "commit"
#       - [openviking] local_embedder_file/_url/_sha256/_port/_threads
#                                           == group_vars openviking_local_embedder_*
#     A release also holds the pi, openviking, llama-cpp-python and embedder
#     file/sha256 pins to the MANIFEST (the pins the images were built with,
#     which are the images' pin labels) -- a drift means the image is not the
#     build the config and group_vars describe.
#   * refuses endpoint drift, the same way: [openviking] endpoint ==
#     group_vars openviking_endpoint. Under "remote" (the memory sidecar, a
#     second container -- docker/memory/ -- beside the daemon's) the config's
#     [openviking] host and port must also name the sidecar (group_vars
#     memory_container_name, openviking_port). A shipping mode also REFUSES
#     "local": the release image carries no OpenViking.
#   * refuses a config whose [tui] remote_sandbox_root is not the image's app
#     root (group_vars app_root, /opt/qcr)
#   * release refuses to ship without a config home: the located config.toml
#     and the profiles/ beside it (never its secrets/) are the tar the updater
#     takes. A config that lives only in the checkout is refused (`qcr install
#     migrate` moves it), and so is a `[review] profile` -- or any profile it
#     extends -- found neither in the home's profiles/ nor among the checkout's
#     generic examples.
#   * release refuses a run spec the VM does not hold: the fingerprint of
#     /etc/qcr/update.conf (read by `qcr-update status --json`) must equal the
#     one rendered from group_vars -- otherwise "re-run provision"
#   * refuses a base-clone name ([github] clone_dir, else the repo slug's
#     basename -- the same rule as githubCloneDir in src/config.ts) that is not
#     one plain path segment or that names a runtime dir of the sandbox root
#
# This script performs no live run on its own beyond ansible/ssh; every live
# invocation belongs to the operator on a machine with VM access.
#
# Usage:
#   scripts/deploy.sh [--dry-run] release <version> [--manifest FILE] [--cutover-ack]
#   scripts/deploy.sh [--dry-run] provision
#   scripts/deploy.sh [--dry-run] verify
#
# Env:
#   QC_ANSIBLE_DIR  ansible project dir (default: deploy/ansible in this checkout)
#   QC_INVENTORY    inventory file      (default: $QC_ANSIBLE_DIR/inventory.ini)
#   QC_SANDBOX_DIR  sandbox working copy (default: this script's parent)
#   QC_VM_HOST      ssh target (default: the inventory's first host)
#   QC_UPDATE_STATUS_CMD  replaces the ssh `sudo qcr-update status --json` (tests)
#   QC_UPDATE_RUN_CMD     replaces the ssh `sudo qcr-update <args>`; run as
#                   `bash -c "$QC_UPDATE_RUN_CMD" _ <args...>` with the config
#                   tar on stdin (tests)
#   QC_NOW_EPOCH    the clock for the token-expiry warning (tests)
#   QC_NO_MEMORY_FORWARD  skip the host memory-forward restart (tests)
#   QCR_GHCR_EXPIRY_FILE  the recorded token expiry (default: the install's
#                   state home, ghcr-token-expiry)
#   QCR_CONFIG      config.toml path    (default: the install locator's answer --
#                   the install's config home's config.toml;
#                   scripts/install-locator.sh). Its directory is the
#                   config home a release ships; `verify` alone
#                   accepts a QCR_CONFIG inside the checkout
#   QC_MEMORY_PROBE_CMD   replaces the ssh read of the sidecar's /ready (tests)
#   QC_MEMORY_SEARCH_CMD  replaces the ssh run of the post-deploy search check (tests)
#   QC_MEMORY_WAIT_S      how long the sidecar checks wait for a cold boot (default 240)
#   (secrets)       provision's secrets_src is the install locator's answer --
#                   [github] secrets_dir, else <config home>/secrets

set -euo pipefail

SELF="$(basename "${BASH_SOURCE[0]}")"
DEFAULT_ANSIBLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/ansible"

SANDBOX_DIR="${QC_SANDBOX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ANSIBLE_DIR="${QC_ANSIBLE_DIR:-$DEFAULT_ANSIBLE_DIR}"
INVENTORY="${QC_INVENTORY:-$ANSIBLE_DIR/inventory.ini}"
# The pin/drift preflight reads the config the install locator names.
# Sourced from beside this script, not from $SANDBOX_DIR: the sandbox may be a
# scratch working copy.
. "$(dirname "${BASH_SOURCE[0]}")/install-locator.sh"
CONFIG="$(qcr_locate_config "$SANDBOX_DIR")" || exit 1
GROUP_VARS="$ANSIBLE_DIR/group_vars/all.yml"
PLAYBOOK="$ANSIBLE_DIR/playbook.yml"
CONTAINER="quickreview-sandbox"
OV_UPSTREAM="$SANDBOX_DIR/extensions/vendor/openviking-pi/upstream.json"

# The run-spec version this script renders and the images' qcr.runspec label
# must not exceed (docker/Dockerfile; tests/deploy.test.ts pins the two).
RUNSPEC_VERSION=1

# The release images' version spelling: X.Y.Z, optionally -prerelease. No "latest"
# exists. It names an image tag and the manifest.
RELEASE_VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

MODE=""
RELEASE_VERSION=""
DRY_RUN=0
MANIFEST_FILE=""
CUTOVER_ACK=0

die() { echo "$SELF: $*" >&2; exit 1; }
note() { echo "$SELF: $*" >&2; }

# ---- arguments ---------------------------------------------------------------

USAGE="usage: $SELF [--dry-run] release <version> [--manifest FILE] [--cutover-ack] | provision | verify"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    sync|dev|rebuild)
      die "'$1' is gone: nothing is rsynced, built or installed on the VM any more. A deploy is \`$SELF release <version>\` (the image CI built once from the release tag, pulled by digest); the host's packages, secrets and updater are \`$SELF provision\`" ;;
    verify|provision)
      [[ -n "$MODE" ]] && die "two modes given: $MODE and $1"
      MODE="$1" ;;
    release)
      [[ -n "$MODE" ]] && die "two modes given: $MODE and $1"
      MODE=release
      [[ $# -ge 2 ]] || die "release needs a version (usage: $SELF release X.Y.Z)"
      RELEASE_VERSION="$2"
      shift ;;
    --manifest)
      [[ $# -ge 2 ]] || die "--manifest needs a file"
      MANIFEST_FILE="$2"
      shift ;;
    --cutover-ack) CUTOVER_ACK=1 ;;
    -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1' ($USAGE)" ;;
  esac
  shift
done
[[ -n "$MODE" ]] || die "no mode given ($USAGE)"
if [[ "$MODE" != release && ( -n "$MANIFEST_FILE" || $CUTOVER_ACK -eq 1 ) ]]; then
  die "--manifest and --cutover-ack belong to \`release\`"
fi
if [[ "$MODE" == release ]]; then
  [[ "$RELEASE_VERSION" != latest ]] || die "there is no latest tag: name the version (X.Y.Z)"
  [[ "$RELEASE_VERSION" =~ $RELEASE_VERSION_RE ]] ||
    die "release version '$RELEASE_VERSION' is not X.Y.Z (optionally -prerelease): it names an image tag"
fi

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
reconcile the two by hand and cut a new release, so CI builds the image against
the new pin.
EOF
    exit 1
  fi
}

# A `key=value` HOST VAR on the inventory's first host line, or nothing. The
# onboarding wizard writes an operator's answers there precisely so the tracked
# group_vars stay clean; in Ansible's precedence a host var outranks
# group_vars/all, so the EFFECTIVE value of a knob is the host var when one is
# set and the group_vars line otherwise (`effective_var`).
inventory_host_var() {
  [[ -f "$INVENTORY" ]] || return 0
  awk -v key="$1" '
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*\[/   { if (seen_group) exit; seen_group = 1; next }
    NF && seen_group {
      for (i = 2; i <= NF; i++) {
        split($i, kv, "=")
        if (kv[1] == key) { print substr($i, length(key) + 2); exit }
      }
      exit
    }' "$INVENTORY"
}

effective_var() {
  local v
  v="$(inventory_host_var "$1" || true)"
  [[ -n "$v" ]] && { echo "$v"; return 0; }
  group_vars_key "$1"
}

# The effective value, or a default when neither the inventory nor group_vars names it.
effective_var_or() {
  local v
  v="$(effective_var "$1" || true)"
  echo "${v:-$2}"
}

# Drift diagnostics name the source whose precedence actually supplied the value.
effective_var_source() {
  if [[ -n "$(inventory_host_var "$1" || true)" ]]; then
    echo inventory
  else
    echo group_vars
  fi
}

# The base clone's directory name, derived exactly as githubCloneDir
# (src/config.ts) derives it: `[github] clone_dir` when set, else the repo
# slug's basename (`.git` and trailing slashes stripped), else "repo".
# tests/deploy.test.ts pins the two derivations against each other.
base_clone_dir() {
  local explicit repo tail
  explicit="$(config_table_key github clone_dir || true)"
  explicit="$(echo "$explicit" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [[ -n "$explicit" ]]; then echo "$explicit"; return 0; fi
  repo="$(config_table_key github repo || true)"
  while [[ "$repo" == */ ]]; do repo="${repo%/}"; done
  repo="${repo%.git}"
  tail="${repo##*/}"
  echo "${tail:-repo}"
}

first_inventory_host() {
  [[ -f "$INVENTORY" ]] || return 0
  awk '/^[[:space:]]*[#;]/ { next }
       /^[[:space:]]*\[/   { next }
       NF { print $1; exit }' "$INVENTORY"
}

# ---- pre-flight --------------------------------------------------------------

[[ -f "$CONFIG" ]] || die "no config at $CONFIG — the install's config home holds none (run the onboarding wizard, or \`qcr install migrate\` to move a checkout config.toml there: the checkout's is no longer read)"
# A release ships the install's config home — the located config and the
# profiles/ beside it — to the VM as the tar the updater takes (never secrets/),
# and the container reads it there ($QCR_CONFIG names the shipped file). So the
# config must live in such a home: a $QCR_CONFIG naming a file inside the
# checkout is refused, not shipped. `provision` and `verify` ship nothing and
# still read whatever the locator found.
SHIPPED_CONFIG="$(qcr_shipped_config "$SANDBOX_DIR")" || exit 1
if [[ "$MODE" == release && -z "$SHIPPED_CONFIG" ]]; then
  die "no config home to ship — the live config is $CONFIG, inside the checkout. A release ships the install's config home ($(qcr_config_home 2>/dev/null || echo '$XDG_CONFIG_HOME/qcr/<install>'), or the directory \$QCR_CONFIG names) to the VM, never the checkout's config.toml: move it with \`qcr install migrate\`, then re-run"
fi
CONFIG_HOME_SRC=""
CONFIG_NAME=""
if [[ -n "$SHIPPED_CONFIG" ]]; then
  CONFIG_HOME_SRC="$(dirname "$SHIPPED_CONFIG")"
  CONFIG_NAME="$(basename "$SHIPPED_CONFIG")"
  # The tar is built from these paths and handed through ssh: a plain path
  # and a plain file name, so nothing in them is read as shell or as a glob.
  if [[ "$MODE" == release && ( "$CONFIG_HOME_SRC" =~ [[:space:]\"\'{}] || "$CONFIG_NAME" =~ [[:space:]\"\'{}] ) ]]; then
    die "the config home path '$SHIPPED_CONFIG' contains whitespace, quotes or braces — set XDG_CONFIG_HOME (or QCR_CONFIG) to a plain path"
  fi
  # The file ships as config.toml whatever it is called here, but a name with
  # a wildcard or a leading dash is never a file anyone meant to ship.
  if [[ "$MODE" == release && ! "$CONFIG_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    die "the config file name '$CONFIG_NAME' is not a plain file name — letters, digits, '.', '_' and '-' only; rename it, or point QCR_CONFIG at one that is"
  fi
fi
# The repo profile the config names, and every profile it `extends`,
# must be found where the VM's daemon will look for it (src/install.ts
# locateProfile, in the container): profiles/ beside the shipped config first,
# then the image's own profiles/ — for a generic example only
# (`qcr_is_example_profile`, pinned to EXAMPLE_PROFILES). A profile
# found in neither fails the VM's boot, so it fails here. Only presence is checked; the daemon's
# resolver refuses a cycle, so the walk just stops at a name it has seen.
profile_extends() {
  awk '
    /^[[:space:]]*\[/ { exit }
    /^[[:space:]]*extends[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/["'"'"']/, "", line)
      sub(/[[:space:]]*(#.*)?$/, "", line)
      print line
      exit
    }
  ' "$1" 2>/dev/null
}
# The shipped directory holding profile <name>, or nothing.
shipped_profile_dir() {
  [[ -d "$CONFIG_HOME_SRC/profiles/$1" ]] && { echo "$CONFIG_HOME_SRC/profiles/$1"; return 0; }
  qcr_is_example_profile "$1" && [[ -d "$SANDBOX_DIR/profiles/$1" ]] && echo "$SANDBOX_DIR/profiles/$1"
  return 0
}
# A profile name is one plain path segment (the daemon's assertPathSegment):
# anything that could climb out of profiles/ is refused before any lookup.
check_profile_name() {
  if [[ ! "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ || "$1" == *..* ]]; then
    die "$2 \"$1\" is not a plain profile name — letters, digits, '.', '_' and '-' only, no path separators or '..'"
  fi
}
DEPLOY_PROFILE="$(config_table_key review profile)"
PROFILE_CHAIN=""
if [[ "$MODE" == release && -n "$DEPLOY_PROFILE" ]]; then
  check_profile_name "$DEPLOY_PROFILE" "config [review] profile"
  chain_at="$DEPLOY_PROFILE"
  chain_dir="$(shipped_profile_dir "$chain_at")"
  [[ -n "$chain_dir" ]] ||
    die "config [review] profile = \"$DEPLOY_PROFILE\", but the config home does not hold it — looked in $CONFIG_HOME_SRC/profiles/$DEPLOY_PROFILE and the checkout's generic examples. The VM's daemon refuses to boot without its profile: put it in $CONFIG_HOME_SRC/profiles/ (\`qcr install migrate\` moves one left in the checkout), or fix the name"
  chain_seen=" $DEPLOY_PROFILE "
  PROFILE_CHAIN="$DEPLOY_PROFILE"
  while chain_base="$(profile_extends "$chain_dir/profile.toml")" && [[ -n "$chain_base" ]]; do
    [[ "$chain_seen" == *" $chain_base "* ]] && break
    check_profile_name "$chain_base" "profile \"$chain_at\" extends"
    chain_dir="$(shipped_profile_dir "$chain_base")"
    [[ -n "$chain_dir" ]] ||
      die "profile \"$chain_at\" extends \"$chain_base\", but the config home does not hold it — looked in $CONFIG_HOME_SRC/profiles/$chain_base and the checkout's generic examples. The VM's daemon refuses to boot without every profile in the chain"
    chain_seen+="$chain_base "
    PROFILE_CHAIN+=" → $chain_base"
    chain_at="$chain_base"
  done
fi
[[ -d "$ANSIBLE_DIR" ]] || die "no ansible dir at $ANSIBLE_DIR (set QC_ANSIBLE_DIR)"
[[ -f "$GROUP_VARS" ]] || die "no group_vars at $GROUP_VARS"
[[ -f "$PLAYBOOK" ]] || die "no playbook at $PLAYBOOK"

# 1. clean tree
if ! git -C "$SANDBOX_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  die "$SANDBOX_DIR is not a git repository — refusing to deploy an untracked tree"
fi

# 1a. the base clone. Its name becomes a directory under the sandbox root, a
# mount into the container and a run-spec value, so it must be one plain path
# segment.
CLONE_DIR="$(base_clone_dir)"
if [[ ! "$CLONE_DIR" =~ ^[A-Za-z0-9._-]+$ || "$CLONE_DIR" == "." || "$CLONE_DIR" == ".." ]]; then
  die "base clone name '$CLONE_DIR' ([github] clone_dir, else the repo's basename) is not one plain directory name — fix config.toml"
fi
# Nor may it name a directory the daemon already owns at the sandbox root:
# a repo called `notes` or `wt` would otherwise be cloned into (or over) a
# runtime dir. tests/deploy.test.ts pins this list against the updater's mounts.
BASE_CLONE_RESERVED=(.git .claude node_modules state wt archive commands digest inject verdict memory notes ledger.md AGENTS.override.md pihome dist)
for reserved in "${BASE_CLONE_RESERVED[@]}"; do
  if [[ "$CLONE_DIR" == "$reserved" ]]; then
    die "base clone name '$CLONE_DIR' is a runtime or build directory of the sandbox root — set [github] clone_dir to a free name"
  fi
done

# 1b. the secrets source: the install locator's answer — the
# configured [github] secrets_dir, else <config home>/secrets — handed to
# provision's secrets copy as secrets_src, so group_vars' hand-run default is
# never what ships.
SECRETS_SRC="$(qcr_locate_secrets "$(config_table_key github secrets_dir || true)")" || exit 1

DIRTY="$(git -C "$SANDBOX_DIR" status --porcelain)"
if [[ -n "$DIRTY" ]]; then
  echo "$SELF: refusing to deploy — the working tree is dirty:" >&2
  echo "$DIRTY" | sed 's/^/    /' >&2
  echo "$SELF: commit (locally — never push, never master/main) and re-run." >&2
  exit 1
fi
HEAD_SHA="$(git -C "$SANDBOX_DIR" rev-parse --short HEAD 2>/dev/null || echo "no-commits")"

# The dry_run flag as the shipped config carries it — shown in the plan, never
# changed: a release ships the config home, so its flag is the VM's flag.
CFG_DRY_RUN="$(awk '/^\[/ { exit } /^[[:space:]]*dry_run[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]*(#.*)?$/, ""); print; exit }' "$CONFIG")"

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
act: reconcile the two by hand (and package.json's "pi" block) and cut a new
release, so CI builds the image against the new pin.
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
  # The auth posture is mirrored the same way the pins are, and for the same
  # reason — the entrypoint renders group_vars, so a config.toml that says
  # "api_key" while group_vars says "dev" would ship a server with no
  # per-user confinement while every doc claims otherwise. Same for the secret
  # file names the template interpolates and the user list it provisions:
  # drift there is a memory outage or an unprovisioned user, silently.
  CFG_OV_AUTH="$(config_table_key openviking auth_mode || true)"
  if [[ -n "$CFG_OV_AUTH" ]]; then
    check_pin "openviking auth_mode" \
      'config.toml   [openviking] auth_mode' "$CFG_OV_AUTH" \
      "$(effective_var_source openviking_auth_mode)    openviking_auth_mode" "$(effective_var openviking_auth_mode || true)"
    check_pin "openviking root key file" \
      'config.toml   [openviking] root_key_file' "$(config_table_key openviking root_key_file || true)" \
      "$(effective_var_source openviking_root_key_file)    openviking_root_key_file" "$(effective_var openviking_root_key_file || true)"
    check_pin "openviking reviewer key file" \
      'config.toml   [openviking] reviewer_key_file' "$(config_table_key openviking reviewer_key_file || true)" \
      "$(effective_var_source openviking_reviewer_key_file)    openviking_reviewer_key_file" "$(effective_var openviking_reviewer_key_file || true)"
    check_pin "openviking provisioned users" \
      'config.toml   [openviking] provision_users' "$(config_list_key openviking provision_users || true)" \
      "$(effective_var_source openviking_provision_users)    openviking_provision_users" "$(effective_var openviking_provision_users || true)"
  fi
  # The embedder is mirrored the same way, against the value the boot
  # will actually render — a host var on the inventory line (how an opt-in is
  # written) outranks group_vars. This one is not a pin but a vector space: a
  # config.toml that says "openai" over a boot that renders "local" would make
  # the entrypoint's migration check reset the vector store for the wrong
  # embedder on the next start, so the two are refused apart before anything
  # ships.
  CFG_OV_EMBED="$(config_table_key openviking embedding_provider || true)"
  if [[ -n "$CFG_OV_EMBED" ]]; then
    CFG_OV_EMBED_MODEL="$(config_table_key openviking embedding_model || true)"
    CFG_OV_EMBED_DIM="$(config_table_key openviking embedding_dimension || true)"
    # Read config.toml the way the daemon's parser does (src/config.ts):
    # under `local`, the older spelling (the engine's built-in Chinese-first
    # model, 512 dims, `RETIRED_LOCAL_EMBEDDING`) means the local English
    # embedder (`LOCAL_EMBEDDING`). So a config.toml with the older spelling
    # needs no edit, and the same file keeps loading on a release that
    # refuses the new spelling — a rollback cannot strand it. Both
    # pairs are pinned to config.ts by tests/deploy.test.ts.
    RETIRED_LOCAL_EMBED_MODEL="bge-small-zh-v1.5-f16"
    RETIRED_LOCAL_EMBED_DIM="512"
    LOCAL_EMBED_MODEL="bge-small-en-v1.5-f16"
    LOCAL_EMBED_DIM="384"
    if [[ "$CFG_OV_EMBED" == "local" && "$CFG_OV_EMBED_MODEL" == "$RETIRED_LOCAL_EMBED_MODEL" \
          && ( -z "$CFG_OV_EMBED_DIM" || "$CFG_OV_EMBED_DIM" == "$RETIRED_LOCAL_EMBED_DIM" ) ]]; then
      note "config.toml spells the retired local embedder ($RETIRED_LOCAL_EMBED_MODEL/${CFG_OV_EMBED_DIM:-default}) — read as $LOCAL_EMBED_MODEL/$LOCAL_EMBED_DIM, exactly as the daemon's parser reads it"
      CFG_OV_EMBED_MODEL="$LOCAL_EMBED_MODEL"
      CFG_OV_EMBED_DIM="$LOCAL_EMBED_DIM"
    fi
    check_pin "openviking embedding provider" \
      'config.toml   [openviking] embedding_provider' "$CFG_OV_EMBED" \
      'ansible (host var, else group_vars)  openviking_embedding_provider' "$(effective_var openviking_embedding_provider || true)"
    check_pin "openviking embedding model" \
      'config.toml   [openviking] embedding_model' "$CFG_OV_EMBED_MODEL" \
      'ansible (host var, else group_vars)  openviking_embedding_model' "$(effective_var openviking_embedding_model || true)"
    check_pin "openviking embedding dimension" \
      'config.toml   [openviking] embedding_dimension' "$CFG_OV_EMBED_DIM" \
      'ansible (host var, else group_vars)  openviking_embedding_dimension' "$(effective_var openviking_embedding_dimension || true)"
    check_pin "openviking embeddings key file" \
      'config.toml   [openviking] embedding_key_file' "$(config_table_key openviking embedding_key_file || true)" \
      'ansible (host var, else group_vars)  openviking_embedding_key_file' "$(effective_var openviking_embedding_key_file || true)"
  fi
  # The local embedder's model file is a pin like `version` —
  # config.toml == group_vars == the image's model layer (which interpolates
  # these vars, so agreeing here means agreeing in the image). Its port and
  # threads are mirrored the same way: the boot's provisioning step runs the
  # service and renders ov.conf's api_base from the ansible values, the daemon
  # supervises it from config.toml's — a port they disagree on is a search
  # nothing serves. A config.toml that predates the pin names none of the five
  # keys: the code defaults are the pin then (held to group_vars by
  # tests/openviking.test.ts) and the check stands down, said aloud. One that
  # names any of them is checked key by key — every named key against
  # group_vars first, so a drift reads as the drift it is — and a partial block
  # is then refused, never half-verified.
  CFG_OV_LE_FILE="$(config_table_key openviking local_embedder_file || true)"
  CFG_OV_LE_URL="$(config_table_key openviking local_embedder_url || true)"
  CFG_OV_LE_SHA="$(config_table_key openviking local_embedder_sha256 || true)"
  CFG_OV_LE_PORT="$(config_table_key openviking local_embedder_port || true)"
  CFG_OV_LE_THREADS="$(config_table_key openviking local_embedder_threads || true)"
  if [[ -n "$CFG_OV_LE_FILE$CFG_OV_LE_URL$CFG_OV_LE_SHA$CFG_OV_LE_PORT$CFG_OV_LE_THREADS" ]]; then
    GV_LE_DIR="$(effective_var openviking_local_embedder_dir || true)"
    GV_LE_MODEL="$(effective_var openviking_local_embedder_model || true)"
    GV_LE_FILE=""
    [[ -n "$GV_LE_DIR" && -n "$GV_LE_MODEL" ]] && GV_LE_FILE="$GV_LE_DIR/$GV_LE_MODEL.gguf"
    [[ -z "$CFG_OV_LE_FILE" ]] || check_pin "local embedder model file" \
      'config.toml   [openviking] local_embedder_file' "$CFG_OV_LE_FILE" \
      'ansible       openviking_local_embedder_dir/<model>.gguf' "$GV_LE_FILE"
    [[ -z "$CFG_OV_LE_URL" ]] || check_pin "local embedder model url" \
      'config.toml   [openviking] local_embedder_url' "$CFG_OV_LE_URL" \
      'ansible       openviking_local_embedder_url' "$(effective_var openviking_local_embedder_url || true)"
    [[ -z "$CFG_OV_LE_SHA" ]] || check_pin "local embedder model sha256" \
      'config.toml   [openviking] local_embedder_sha256' "$CFG_OV_LE_SHA" \
      'ansible       openviking_local_embedder_sha256' "$(effective_var openviking_local_embedder_sha256 || true)"
    [[ -z "$CFG_OV_LE_PORT" ]] || check_pin "local embedder port" \
      'config.toml   [openviking] local_embedder_port' "$CFG_OV_LE_PORT" \
      'ansible       openviking_local_embedder_port' "$(effective_var openviking_local_embedder_port || true)"
    [[ -z "$CFG_OV_LE_THREADS" ]] || check_pin "local embedder threads" \
      'config.toml   [openviking] local_embedder_threads' "$CFG_OV_LE_THREADS" \
      'ansible       openviking_local_embedder_threads' "$(effective_var openviking_local_embedder_threads || true)"
    LE_MISSING=""
    [[ -n "$CFG_OV_LE_FILE" ]] || LE_MISSING+=" local_embedder_file"
    [[ -n "$CFG_OV_LE_URL" ]] || LE_MISSING+=" local_embedder_url"
    [[ -n "$CFG_OV_LE_SHA" ]] || LE_MISSING+=" local_embedder_sha256"
    [[ -n "$CFG_OV_LE_PORT" ]] || LE_MISSING+=" local_embedder_port"
    [[ -n "$CFG_OV_LE_THREADS" ]] || LE_MISSING+=" local_embedder_threads"
    [[ -z "$LE_MISSING" ]] || die "config.toml [openviking] names only part of the local embedder pin — it lacks${LE_MISSING}. Name all five (the block in config.example.toml) or none, so this preflight can verify them"
  else
    note "config.toml names no [openviking] local_embedder_* pin — the code defaults apply (tests hold them to group_vars); add the block from config.example.toml to have this preflight verify it"
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

# 2c. who runs OpenViking. Mirrored like the pins: the entrypoint (which skips
# the memory boot under "remote") follows group_vars, the daemon (which probes a
# sidecar instead of supervising a child) follows config.toml, and the two
# disagreeing is either two writers on one store or a daemon probing a server
# nobody started. Both default to "local" (a config.toml or group_vars that
# predates the sidecar names neither key).
CFG_OV_ENDPOINT="$(config_table_key openviking endpoint || true)"
CFG_OV_ENDPOINT="${CFG_OV_ENDPOINT:-local}"
OV_ENDPOINT="$(effective_var openviking_endpoint || true)"
OV_ENDPOINT="${OV_ENDPOINT:-local}"
[[ "$OV_ENDPOINT" == local || "$OV_ENDPOINT" == remote ]] ||
  die "openviking_endpoint is \"$OV_ENDPOINT\" ($(effective_var_source openviking_endpoint)) — it must be \"local\" or \"remote\""
check_pin "openviking endpoint" \
  'config.toml   [openviking] endpoint' "$CFG_OV_ENDPOINT" \
  "$(effective_var_source openviking_endpoint)    openviking_endpoint" "$OV_ENDPOINT"
MEMORY_CONTAINER="$(effective_var memory_container_name || true)"
MEMORY_CONTAINER="${MEMORY_CONTAINER:-quickreview-memory}"
OV_PORT="$(effective_var openviking_port || true)"
OV_PORT="${OV_PORT:-1933}"
OV_REVIEWER_KEY_FILE="$(effective_var openviking_reviewer_key_file || true)"
OV_REVIEWER_KEY_FILE="${OV_REVIEWER_KEY_FILE:-openviking_reviewer_key}"
if [[ "$OV_ENDPOINT" == remote ]]; then
  # The name reaches docker's DNS and the verify commands' shell.
  [[ "$MEMORY_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
    die "memory_container_name \"$MEMORY_CONTAINER\" is not a plain container name — letters, digits, '.', '_' and '-' only"
  [[ "$MEMORY_CONTAINER" != "$CONTAINER" ]] ||
    die "memory_container_name is the daemon's own container name ($CONTAINER) — the sidecar needs a name of its own"
  check_pin "memory sidecar host" \
    'config.toml   [openviking] host' "$(config_table_key openviking host || true)" \
    "$(effective_var_source memory_container_name)    memory_container_name" "$MEMORY_CONTAINER"
  check_pin "memory sidecar port" \
    'config.toml   [openviking] port' "$(CFG_P="$(config_table_key openviking port || true)"; echo "${CFG_P:-1933}")" \
    "$(effective_var_source openviking_port)    openviking_port" "$OV_PORT"
fi

# 2c'. the daemon container's name: the verify commands and the run spec name
# it here, group_vars' image_name is the playbook's. One name or none.
GV_IMAGE_NAME="$(effective_var image_name || true)"
[[ -z "$GV_IMAGE_NAME" || "$GV_IMAGE_NAME" == "$CONTAINER" ]] ||
  die "image_name is \"$GV_IMAGE_NAME\" ($(effective_var_source image_name)) but this script and the run spec name the daemon container $CONTAINER"

# 2d. the release image runs the daemon and nothing else: OpenViking is the
# sidecar's. A shipping mode on a "local" endpoint would boot a daemon that
# supervises a server the image does not have.
if [[ "$MODE" != verify && "$OV_ENDPOINT" != remote ]]; then
  die "openviking endpoint is \"$OV_ENDPOINT\" — the release image carries no OpenViking, so $MODE needs the memory sidecar: set group_vars/inventory openviking_endpoint AND config.toml [openviking] endpoint to \"remote\" (and [openviking] host to the sidecar's name). The way back to \"local\" is the legacy image and the old playbook (deploy/ansible/README.md, Rollback)"
fi

# 2e. the TUI finds the app root inside the container by itself: it reads the
# running container's qcr.layout label (src/tui/layout.ts), release = the
# image's app root, so no [tui] key is edited for a release or for the cutover.
# An EXPLICIT [tui] remote_sandbox_root wins over that, so one that names another
# root points the TUI at a path the release container does not have: warn, do
# not refuse (the key is the operator's, and the release does not read it).
APP_ROOT="$(effective_var app_root || true)"
APP_ROOT="${APP_ROOT:-/opt/qcr}"
if [[ "$MODE" == release ]]; then
  CFG_TUI_ROOT="$(config_table_key tui remote_sandbox_root || true)"
  if [[ -n "$CFG_TUI_ROOT" && "$CFG_TUI_ROOT" != "$APP_ROOT" ]]; then
    cat >&2 <<EOF
$SELF: warning: [tui] remote_sandbox_root = "$CFG_TUI_ROOT" is set explicitly in $CONFIG, and the release image keeps the app at $APP_ROOT.
    An explicit key wins over the TUI's own layout detection, so the TUI will look for the deploy marker,
    the operator channel, messages and the digest under "$CFG_TUI_ROOT". Delete the key (or set it to
    "$APP_ROOT") unless that is what you want.
EOF
  fi
fi

# Slack tokens ride the secrets mount under their configured flat filenames.
SLACK_ENABLED="$(config_table_key slack enabled)"
SLACK_BOT_TOKEN_FILE="$(config_table_key slack bot_token_file)"
SLACK_APP_TOKEN_FILE="$(config_table_key slack app_token_file)"
SLACK_BOT_TOKEN_FILE="${SLACK_BOT_TOKEN_FILE:-slack_bot_token}"
SLACK_APP_TOKEN_FILE="${SLACK_APP_TOKEN_FILE:-slack_app_token}"
if [[ "$MODE" == provision ]]; then
  for token_key in bot_token_file app_token_file; do
    token_name="$SLACK_BOT_TOKEN_FILE"
    [[ "$token_key" == app_token_file ]] && token_name="$SLACK_APP_TOKEN_FILE"
    if [[ ! "$token_name" =~ ^[A-Za-z0-9_.-]+$ || "$token_name" == . || "$token_name" == .. ]]; then
      if [[ "$SLACK_ENABLED" == true ]]; then
        die "[slack] $token_key must be a flat filename for VM deployment; move the token into the configured secrets directory and use its filename"
      fi
      # Disabled Slack's unused host paths never widen the secrets copy.
      if [[ "$token_key" == app_token_file ]]; then
        SLACK_APP_TOKEN_FILE=slack_app_token
      else
        SLACK_BOT_TOKEN_FILE=slack_bot_token
      fi
    fi
  done
fi

# ---- plan --------------------------------------------------------------------

# provision is the only mode that runs ansible, and the whole playbook runs: the
# host packages, Docker, cloudflared, the secrets, the directory layout, the
# updater and its run spec. No tags, no start-at-task. The run spec is rendered
# here (render_runspec) into a file the playbook installs as /etc/qcr/update.conf.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qcr-deploy.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
UPDATE_CONF_SRC="$WORK_DIR/update.conf"
ANSIBLE_CMD=()
if [[ "$MODE" == provision ]]; then
  ANSIBLE_CMD=(ansible-playbook -i "$INVENTORY" "$PLAYBOOK"
    -e "base_clone_dir=$CLONE_DIR" -e "secrets_src=$SECRETS_SRC"
    -e "slack_bot_token_file=$SLACK_BOT_TOKEN_FILE" -e "slack_app_token_file=$SLACK_APP_TOKEN_FILE"
    -e "update_conf_src=$UPDATE_CONF_SRC")
fi

# Ansible's `| bool`: its BOOLEANS_TRUE set (quoted or not, any case) is true,
# everything else false — the same reading src/onboard/steps/inventory.ts's
# ansibleBool gives the onboarding check.
ansible_bool() {
  local v="$1"
  v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  v="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
  case "$v" in
    y|yes|on|1|true|t|1.0) return 0 ;;
    *) return 1 ;;
  esac
}

# The playbook installs and starts cloudflared only under `cloudflared_enabled`
# (an inventory host var over the group_vars default), so the service is
# required exactly when that effective value is true. An unreadable value
# counts as the tracked default, true.
CLOUDFLARED_ENABLED="$(effective_var cloudflared_enabled || true)"
CLOUDFLARED_ENABLED="${CLOUDFLARED_ENABLED:-true}"
VM_HOST="${QC_VM_HOST:-$(first_inventory_host)}"
VERIFY_CMDS=()
if ansible_bool "$CLOUDFLARED_ENABLED"; then
  VERIFY_CMDS+=("systemctl is-active cloudflared")
fi
VERIFY_CMDS+=(
  "systemctl is-active docker"
  "sudo docker ps --filter name=$CONTAINER --format '{{.Names}} {{.Status}}'"
)
# The memory sidecar is a second container: it must be listed AND running (a
# `docker ps` that finds nothing still exits 0, so the check reads the state).
if [[ "$OV_ENDPOINT" == remote ]]; then
  VERIFY_CMDS+=(
    "sudo docker ps --filter name=$MEMORY_CONTAINER --format '{{.Names}} {{.Status}}'"
    "test \"\$(sudo docker inspect -f '{{.State.Running}}' $MEMORY_CONTAINER)\" = true"
  )
fi
# What runs, and that it is the release layout: the image's build stamp (the
# deploy tab reads the same label), then — once the heartbeat shows the
# entrypoint has finished — the global bash-guard registration the daemon mode
# merges into pi's settings on the pihome volume, and the 12-line reviewer stub
# every session loads instead of the contributor guide.
VERIFY_CMDS+=(
  "sudo docker inspect -f '{{.Config.Image}} build {{index .Config.Labels \"qcr.build-sha\"}}' $CONTAINER"
  "sudo docker inspect -f '{{.Config.Image}} {{index .Config.Labels \"qcr.build-sha\"}}' $CONTAINER | grep -Eq ' [0-9a-f]{7,40}\$'"
  "sudo docker exec $CONTAINER tmux ls || echo 'no tmux sessions yet'"
  "cat /opt/quickreview/state/status.json | head -20   # heartbeat for the status collector"
)
BOOT_CMDS=(
  "sudo docker exec $CONTAINER grep -q bash-guard /home/qcr/.pi/agent/settings.json"
  "sudo docker exec $CONTAINER sh -c 'test \"\$(stat -c %a $APP_ROOT/AGENTS.override.md)\" = 444 && grep -q \"session context\" $APP_ROOT/AGENTS.override.md'"
)

# The sidecar's post-deploy checks, run over ssh like the others. /ready is the
# server's own readiness (the embedder it probes included); the search runs from
# the DAEMON's container, as a round would make it: the sidecar's name resolves,
# the reviewer key authenticates, a vector search answers
# (scripts/memory-search-check.mjs, which the image carries).
memory_ready_cmd() {
  echo "sudo docker exec $MEMORY_CONTAINER curl -fsS http://127.0.0.1:$OV_PORT/ready"
}
memory_search_cmd() {
  echo "sudo docker exec $CONTAINER node $APP_ROOT/scripts/memory-search-check.mjs --base http://$MEMORY_CONTAINER:$OV_PORT --key-file /opt/quickreview/secrets/$OV_REVIEWER_KEY_FILE"
}

# ---- the run spec ---------------------------------------------------------------
# /etc/qcr/update.conf on the VM, rendered HERE from group_vars (and the
# inventory's host vars over them, as effective_var reads) so the playbook has
# nothing to template and the controller can recompute the same bytes: a release
# compares this fingerprint with the one the VM's updater reports, and refuses a
# drift with "re-run provision". KEY=VALUE only, every value from the plain
# charset qcr-update reads. The fingerprint is the sha256 of every other
# KEY=VALUE line, in this order. The defaults are group_vars/all.yml's.

runspec_value() { effective_var_or "$1" "$2"; }

runspec_body() {
  local v
  v() { runspec_value "$1" "$2"; }
  printf 'RUNSPEC_VERSION=%s\n' "$RUNSPEC_VERSION"
  printf 'SANDBOX_ROOT=%s\n' "$(v sandbox_root /opt/quickreview)"
  printf 'APP_ROOT=%s\n' "$APP_ROOT"
  printf 'DAEMON_CONTAINER=%s\n' "$CONTAINER"
  printf 'MEMORY_CONTAINER=%s\n' "$MEMORY_CONTAINER"
  printf 'DAEMON_IMAGE_REPO=%s\n' "$(v release_image ghcr.io/quickchatai/quickreview)"
  printf 'MEMORY_IMAGE_REPO=%s\n' "$(v release_memory_image ghcr.io/quickchatai/quickreview-memory)"
  printf 'MEMORY_NETWORK=%s\n' "$(v memory_network quickreview-memory)"
  printf 'WEBHOOK_PORT=%s\n' "$(v webhook_port 8787)"
  printf 'CONTAINER_UID=%s\n' "$(v container_uid 1001)"
  printf 'TZ=%s\n' "$(v timezone Europe/Warsaw)"
  printf 'DAEMON_CPUS=%s\n' "$(v container_cpus 2)"
  printf 'DAEMON_MEMORY=%s\n' "$(v container_memory 8g)"
  printf 'MEMORY_CPUS=%s\n' "$(v memory_container_cpus 1)"
  printf 'MEMORY_MEMORY=%s\n' "$(v memory_container_memory 3g)"
  printf 'MEMORY_STATE_DIR=%s\n' "$(v memory_state_dir /opt/quickreview/memory-state)"
  printf 'OPENVIKING_HOME=%s\n' "$(v openviking_home /opt/quickreview/state/openviking)"
  printf 'OPENVIKING_PORT=%s\n' "$OV_PORT"
  printf 'BASE_CLONE_DIR=%s\n' "$CLONE_DIR"
  printf 'LEGACY_SANDBOX_ROOT=%s\n' "$(v legacy_sandbox_root /opt/quickreview/sandbox)"
  printf 'BACKUP_DIR=%s\n' "$(v backup_dir /var/backups/qcr)"
  printf 'UPDATE_STATE_DIR=%s\n' "$(v update_state_dir /var/lib/qcr-update)"
  printf 'MEMORY_READY_TIMEOUT_S=%s\n' "$(v memory_ready_timeout_s 1800)"
  # The sidecar's boot knobs: docker/memory/entrypoint.sh renders ov.conf from
  # these, the values config.toml [openviking] is held equal to above.
  printf 'SIDECAR_ENV_TZ=%s\n' "$(v timezone Europe/Warsaw)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_HOME=%s\n' "$(v openviking_home /opt/quickreview/state/openviking)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_PORT=%s\n' "$OV_PORT"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_BIND_HOST=0.0.0.0\n'
  printf 'SIDECAR_ENV_QCR_OPENVIKING_WORKERS=%s\n' "$(v openviking_workers 1)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_QUEUE_CONCURRENCY=%s\n' "$(v openviking_queue_concurrency 2)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_AUTH_MODE=%s\n' "$(v openviking_auth_mode api_key)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_EMBEDDING_PROVIDER=%s\n' "$(v openviking_embedding_provider local)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_EMBEDDING_MODEL=%s\n' "$(v openviking_embedding_model bge-small-en-v1.5-f16)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_EMBEDDING_DIMENSION=%s\n' "$(v openviking_embedding_dimension 384)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_EMBEDDING_KEY_FILE=%s\n' "$(v openviking_embedding_key_file openai_embeddings_api_key)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_LOCAL_EMBEDDER_MODEL=%s\n' "$(v openviking_local_embedder_model bge-small-en-v1.5-f16)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_LOCAL_EMBEDDER_DIMENSION=%s\n' "$(v openviking_local_embedder_dimension 384)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_LOCAL_EMBEDDER_DIR=%s\n' "$(v openviking_local_embedder_dir /opt/openviking/models)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_LOCAL_EMBEDDER_SHA256=%s\n' "$(v openviking_local_embedder_sha256 f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_LOCAL_EMBEDDER_PORT=%s\n' "$(v openviking_local_embedder_port 1934)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_LOCAL_EMBEDDER_THREADS=%s\n' "$(v openviking_local_embedder_threads 1)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_ROOT_KEY_FILE=%s\n' "$(v openviking_root_key_file openviking_root_key)"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_REVIEWER_KEY_FILE=%s\n' "$OV_REVIEWER_KEY_FILE"
  printf 'SIDECAR_ENV_QCR_OPENVIKING_PROVISION_USERS=%s\n' "$(v openviking_provision_users reviewer,companion)"
}

# Rendered once, here, at the top level (a die inside a command substitution
# would only end the substitution): every line must be a KEY=VALUE qcr-update
# will read, so a group_vars value with a space, quote or `$` stops the run.
RUNSPEC_BODY=""
RUNSPEC_FP=""
if [[ "$MODE" != verify ]]; then
  RUNSPEC_BODY="$(runspec_body)"
  bad_line="$(printf '%s\n' "$RUNSPEC_BODY" | grep -vE '^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:@+,-]*$' | head -1 || true)"
  [[ -z "$bad_line" ]] ||
    die "the run spec cannot carry \"$bad_line\" — group_vars values ride /etc/qcr/update.conf, which allows letters, digits and _ . / : @ + , - only"
  RUNSPEC_FP="$(printf '%s\n' "$RUNSPEC_BODY" | sha256sum | cut -d' ' -f1)"
fi
runspec_fingerprint() { echo "$RUNSPEC_FP"; }

runspec_file() {
  echo "# /etc/qcr/update.conf -- rendered by scripts/deploy.sh provision from group_vars."
  echo "# Root-owned. Do not edit: qcr-update checks RUNSPEC_FINGERPRINT."
  printf '%s\n' "$RUNSPEC_BODY"
  printf 'RUNSPEC_FINGERPRINT=%s\n' "$RUNSPEC_FP"
}

# ---- the deploy manifest (release) ---------------------------------------------------
# deploy-manifest-<version>.json: CI's record of what it built (the schema is
# deploy/manifest.schema.json, the parser scripts/deploy-manifest.mjs).
declare -A MF=()
load_manifest() {
  [[ "$MODE" == release ]] || return 0
  MANIFEST_FILE="${MANIFEST_FILE:-./deploy-manifest-$RELEASE_VERSION.json}"
  [[ -f "$MANIFEST_FILE" ]] ||
    die "no deploy manifest at $MANIFEST_FILE — the release workflow emits deploy-manifest-$RELEASE_VERSION.json next to the images (deploy/manifest.schema.json); download it, or name it with --manifest"
  local out line
  out="$(node "$(dirname "${BASH_SOURCE[0]}")/deploy-manifest.mjs" "$MANIFEST_FILE" "$RELEASE_VERSION" 2>&1)" ||
    die "refusing the release — $MANIFEST_FILE: $out"
  while IFS= read -r line; do MF["${line%%=*}"]="${line#*=}"; done <<<"$out"

  # The images are the ones group_vars names.
  check_pin "daemon image repository" \
    "manifest $MANIFEST_FILE" "${MF[DAEMON_REPOSITORY]}" \
    'group_vars    release_image' "$(effective_var_or release_image ghcr.io/quickchatai/quickreview)"
  check_pin "memory image repository" \
    "manifest $MANIFEST_FILE" "${MF[MEMORY_REPOSITORY]}" \
    'group_vars    release_memory_image' "$(effective_var_or release_memory_image ghcr.io/quickchatai/quickreview-memory)"
  # Rule 7, kept: the pins the images were BUILT with (their pin labels, copied
  # into the manifest) must be the ones config.toml and group_vars hold. A drift
  # here is an image that is not the build this config describes.
  check_pin "pi (manifest)" \
    "manifest pins.pi" "${MF[PIN_PI]}" \
    'config.toml   [pi] version' "$CFG_PI"
  if [[ -n "$CFG_OV" ]]; then
    check_pin "openviking (manifest)" \
      "manifest pins.openviking" "${MF[PIN_OPENVIKING]}" \
      'config.toml   [openviking] version' "$CFG_OV"
    check_pin "llama-cpp-python (manifest)" \
      "manifest pins.llama_cpp_python" "${MF[PIN_LLAMA_CPP_PYTHON]}" \
      'config.toml   [openviking] llama_cpp_python_version' "$(config_table_key openviking llama_cpp_python_version || true)"
  fi
  local gv_dir gv_model gv_sha
  gv_dir="$(effective_var openviking_local_embedder_dir || true)"
  gv_model="$(effective_var openviking_local_embedder_model || true)"
  gv_sha="$(effective_var openviking_local_embedder_sha256 || true)"
  if [[ -n "$gv_dir" && -n "$gv_model" ]]; then
    check_pin "local embedder model file (manifest)" \
      "manifest pins.embedder_file" "${MF[PIN_EMBEDDER_FILE]}" \
      'ansible       openviking_local_embedder_dir/<model>.gguf' "$gv_dir/$gv_model.gguf"
  fi
  if [[ -n "$gv_sha" ]]; then
    check_pin "local embedder model sha256 (manifest)" \
      "manifest pins.embedder_sha256" "${MF[PIN_EMBEDDER_SHA256]}" \
      'ansible       openviking_local_embedder_sha256' "$gv_sha"
  fi
  if (( MF[PIN_RUNSPEC] > RUNSPEC_VERSION )); then
    die "refusing the release — its images need run spec v${MF[PIN_RUNSPEC]} but this checkout renders v$RUNSPEC_VERSION: update this checkout, then re-run provision"
  fi
}

# ---- what the VM runs now (the updater's own report) -----------------------------------
# `sudo qcr-update status --json`, over ssh: the layout, the run spec the VM
# holds (version + fingerprint) and the drain. QC_UPDATE_STATUS_CMD stands in
# for the ssh (tests). Unreadable is UNKNOWN: a plan says so, a real run refuses.
VM_STATUS=""
VM_LAYOUT="unknown"
VM_FINGERPRINT=""
VM_DRAINING=""
VM_ROUNDS=""
vm_status_read() {
  [[ "$MODE" == release ]] || return 0
  if [[ -n "${QC_UPDATE_STATUS_CMD:-}" ]]; then
    VM_STATUS="$(bash -c "$QC_UPDATE_STATUS_CMD" 2>/dev/null)" || VM_STATUS=""
  elif [[ -n "$VM_HOST" ]]; then
    VM_STATUS="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$VM_HOST" 'sudo qcr-update status --json' 2>/dev/null)" || VM_STATUS=""
  fi
  grep -q '"layout"' <<<"$VM_STATUS" || { VM_STATUS=""; return 0; }
  VM_LAYOUT="$(grep -o '"layout":"[^"]*"' <<<"$VM_STATUS" | head -1 | cut -d'"' -f4)"
  VM_FINGERPRINT="$(grep -o '"fingerprint":"[^"]*"' <<<"$VM_STATUS" | head -1 | cut -d'"' -f4)"
  VM_DRAINING="$(grep -o '"draining":[a-z]*' <<<"$VM_STATUS" | head -1 | cut -d: -f2)"
  VM_ROUNDS="$(grep -o '"running_rounds":[0-9a-z]*' <<<"$VM_STATUS" | head -1 | cut -d: -f2)"
}

# A run spec the VM does not hold is fatal in any run (the plan included): the
# updater would refuse the image, or run a stale container shape.
EXPECTED_FINGERPRINT=""
runspec_drift() {
  [[ "$MODE" == release ]] || return 0
  EXPECTED_FINGERPRINT="$(runspec_fingerprint)"
  [[ -n "$VM_STATUS" ]] || return 0
  if [[ "$VM_FINGERPRINT" != "$EXPECTED_FINGERPRINT" ]]; then
    die "refusing the release — the VM's run spec (fingerprint ${VM_FINGERPRINT:-none}) differs from the one group_vars renders ($EXPECTED_FINGERPRINT): re-run provision (\`$SELF provision\`). Nothing was changed"
  fi
}

# Things a real run refuses and a plan reports (the updater refuses them too):
# the layout needs the ack, the board must be drained and idle. Prints the first.
release_problem() {
  [[ "$MODE" == release ]] || return 0
  if [[ -z "$VM_STATUS" ]]; then
    echo "the VM's \`qcr-update status\` could not be read (ssh, or provision never installed the updater), so its layout, run spec and drain are unknown"
    return 0
  fi
  if [[ "$VM_LAYOUT" == legacy && $CUTOVER_ACK -eq 0 ]]; then
    echo "the VM still runs the legacy layout: this deploy is the cutover (the first boot migrates forward). Re-run with --cutover-ack"
    return 0
  fi
  if [[ "$VM_DRAINING" != true ]]; then
    echo "the bot is not drained (draining=${VM_DRAINING:-unknown}): run \`qcr drain on\`, wait for running_rounds 0, then deploy"
    return 0
  fi
  if [[ "$VM_ROUNDS" != 0 ]]; then
    echo "the board is busy (running_rounds=${VM_ROUNDS:-unknown}): wait for running_rounds 0, then deploy"
    return 0
  fi
}

# The VM's ghcr pull token expires (1 year, by ruling), and a lapsed one fails
# the updater's pull. scripts/vm-ghcr-login.sh records the expiry on this
# controller; release and verify read it back. Within GHCR_WARN_DAYS of it
# (or past it) the plan line starts with WARNING. Warn only, never a refusal.
GHCR_WARN_DAYS=14
GHCR_EXPIRY_LINE=""
GHCR_EXPIRY_WARNS=0
ghcr_expiry_status() {
  [[ "$MODE" == verify || "$MODE" == release ]] || return 0
  local file iso epoch now days
  file="$(qcr_ghcr_expiry_file 2>/dev/null)" || file=""
  if [[ -z "$file" || ! -s "$file" ]]; then
    GHCR_EXPIRY_LINE="no recorded expiry for the VM's ghcr pull token (scripts/vm-ghcr-login.sh records it when the owner logs the VM in)"
    return 0
  fi
  iso="$(head -1 "$file" | tr -d '[:space:]')"
  epoch="$(date -u -d "$iso" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s 2>/dev/null || true)"
  if [[ -z "$epoch" ]]; then
    GHCR_EXPIRY_LINE="WARNING — the recorded ghcr token expiry in $file ('$iso') is not a date; re-run scripts/vm-ghcr-login.sh"
    GHCR_EXPIRY_WARNS=1
    return 0
  fi
  now="${QC_NOW_EPOCH:-$(date -u +%s)}"
  days=$(( (epoch - now) / 86400 ))
  if (( epoch <= now )); then
    GHCR_EXPIRY_LINE="WARNING — the VM's ghcr pull token EXPIRED at $iso: create a new classic read:packages token and run scripts/vm-ghcr-login.sh"
    GHCR_EXPIRY_WARNS=1
  elif (( days <= GHCR_WARN_DAYS )); then
    GHCR_EXPIRY_LINE="WARNING — the VM's ghcr pull token expires at $iso, in $days day(s) (warned from $GHCR_WARN_DAYS days out): create a new classic read:packages token and run scripts/vm-ghcr-login.sh"
    GHCR_EXPIRY_WARNS=1
  else
    GHCR_EXPIRY_LINE="the VM's ghcr pull token expires at $iso, in $days days"
  fi
}

# The updater's argv, minus `sudo qcr-update`.
update_args() {
  local args=("$RELEASE_VERSION@${MF[DAEMON_INDEX_DIGEST]}" --memory-digest "${MF[MEMORY_INDEX_DIGEST]}")
  [[ $CUTOVER_ACK -eq 0 ]] || args+=(--cutover-ack "$RELEASE_VERSION")
  printf '%s ' "${args[@]}"
}

print_plan() {
  echo "plan — $SELF $MODE${RELEASE_VERSION:+ $RELEASE_VERSION}"
  echo "  sandbox      $SANDBOX_DIR @ $HEAD_SHA (clean)"
  echo "  ansible      $ANSIBLE_DIR"
  echo "  inventory    $INVENTORY"
  echo "  pi pin       $CFG_PI (config.toml == group_vars, not bumped)"
  if [[ -n "$CFG_OV" ]]; then
    echo "  memory pins  openviking $CFG_OV (config.toml == group_vars == image layer), extension ${CFG_OV_EXT:-<unset>} (config.toml == upstream.json)"
    echo "  memory auth  auth_mode ${CFG_OV_AUTH:-<unset>} (config.toml == group_vars; 'dev' means NO per-user confinement)"
    echo "  memory embed ${CFG_OV_EMBED:-<unset>} (config.toml == ansible effective value; 'local' means no memory text leaves the VM)"
    echo "  local model  ${GV_LE_MODEL:-<code default>} sha256 ${CFG_OV_LE_SHA:-<code default>} (config.toml == group_vars == image layer; a changed pin needs a new release)"
  else
    echo "  memory pins  <no [openviking] block in config.toml — unverified>"
  fi
  if [[ "$OV_ENDPOINT" == remote ]]; then
    echo "  containers   $CONTAINER (daemon) + $MEMORY_CONTAINER (memory sidecar: OpenViking + local embedder, network $(effective_var_or memory_network quickreview-memory), port $OV_PORT unpublished)"
    echo "  memory       endpoint remote (config.toml == ansible): the daemon only probes $MEMORY_CONTAINER:$OV_PORT; the sidecar owns provisioning and the re-embed"
    echo "  memory store the sidecar's own copy at $(effective_var_or memory_state_dir /opt/quickreview/memory-state), copied from the daemon's and checksum-verified ONCE by the updater on the legacy layout (the daemon container stopped for it), never wiped; the old directory is the rollback"
  else
    echo "  containers   $CONTAINER only (endpoint local: OpenViking is the daemon's child; a shipping mode refuses this — the release image carries no OpenViking)"
  fi
  echo "  vm host      ${VM_HOST:-<unset — set QC_VM_HOST>}"
  echo "  base clone   /$CLONE_DIR (mounted from the sandbox root, outside every image)"
  if [[ "$MODE" == release ]]; then
    echo "  config home  $CONFIG_HOME_SRC ($CONFIG_NAME as config.toml + profiles/ -> the tar on stdin; the VM's read-only /opt/quickreview/config-home, which QCR_CONFIG names; secrets/ never rides it)"
    echo "  profile      ${PROFILE_CHAIN:-<none — the generic registry>}"
  fi
  case "$MODE" in
    provision)
      echo "  secrets      $SECRETS_SRC (copied to the VM's read-only secrets mount)"
      echo "  action       the whole playbook: host packages, Docker, cloudflared, secrets, the directory layout, /usr/local/sbin/qcr-update and /etc/qcr/update.conf. It pulls and starts no image"
      echo "  run spec     v$RUNSPEC_VERSION, fingerprint $(runspec_fingerprint) (rendered from group_vars into $UPDATE_CONF_SRC)" ;;
    release)
      echo "  manifest     $MANIFEST_FILE: version ${MF[VERSION]}, revision ${MF[REVISION]} (checkout HEAD $(git -C "$SANDBOX_DIR" rev-parse HEAD 2>/dev/null || echo unknown))"
      echo "  images       daemon ${MF[DAEMON_REPOSITORY]}@${MF[DAEMON_INDEX_DIGEST]}"
      echo "               memory ${MF[MEMORY_REPOSITORY]}@${MF[MEMORY_INDEX_DIGEST]}"
      echo "  manifest pins  pi ${MF[PIN_PI]}, openviking ${MF[PIN_OPENVIKING]}, llama-cpp-python ${MF[PIN_LLAMA_CPP_PYTHON]}, embedder ${MF[PIN_EMBEDDER_FILE]} sha256 ${MF[PIN_EMBEDDER_SHA256]}, run spec v${MF[PIN_RUNSPEC]} (== config.toml == group_vars)"
      echo "  run spec     v$RUNSPEC_VERSION, fingerprint $EXPECTED_FINGERPRINT (== the VM's: ${VM_FINGERPRINT:-unread})"
      echo "  vm now       layout $VM_LAYOUT, draining ${VM_DRAINING:-?}, running_rounds ${VM_ROUNDS:-?}"
      echo "  steps        1. read the manifest (this script)         2. tar config.toml profiles/ | ssh ${VM_HOST:-<vm>} sudo qcr-update $(update_args)"
      echo "               on the VM, in order:"
      echo "                 flock; refuse unless draining=true and running_rounds=0; legacy layout needs --cutover-ack"
      echo "                 pull both images by digest and check them (qcr.layout, qcr.build-sha, qcr.preflight, qcr.runspec <= update.conf)"
      echo "                 stage the config to config-home.next; the NEW image's \`qcr config check --json\` on it"
      echo "                 stop the daemon container; snapshot state.db(-wal/-shm) and state/pi-sessions to $(effective_var_or backup_dir /var/backups/qcr)/<version>-<ts>/"
      echo "                 the new image's \`daemon --preflight\` on a scratch copy of the snapshot (--network none)"
      echo "                 seed the sidecar store once (legacy layout only; copy + checksum verify)"
      echo "                 swap the config (current -> .prev, .next -> current)"
      echo "                 start the memory sidecar, wait for /ready; recreate the daemon container on the new image"
      echo "               any failure from the stop to the recreate is RESCUED: previous config back, old containers started, drain re-sent and confirmed, non-zero exit"
      echo "  no rsync, no build, no install on the VM"
      local problem
      problem="$(release_problem)"
      if [[ -n "$problem" ]]; then
        echo "  REFUSED in a real run: $problem"
      elif [[ "$VM_LAYOUT" == legacy ]]; then
        echo "  cutover      first run on the legacy layout, acknowledged (--cutover-ack $RELEASE_VERSION): the first boot migrates forward"
      fi
      echo "  rollback     the legacy image quickreview-sandbox:v1 stays on the VM until the owner removes it; the updater also keeps the previous container as $CONTAINER-prev and the state snapshot under $(effective_var_or backup_dir /var/backups/qcr)/. A release is undone by 'release <previous version>' (drain first)" ;;
    verify)  echo "  action       post-deploy checks over ssh only (no ansible)" ;;
  esac
  if [[ "$MODE" == release ]]; then
    echo "  container    release image in daemon mode as uid $(effective_var_or container_uid 1001): app root $APP_ROOT read-only; state, pihome, secrets, config-home and wt/archive/commands/digest/inject/verdict/$CLONE_DIR mounted from /opt/quickreview"
  fi
  if [[ ${#ANSIBLE_CMD[@]} -gt 0 ]]; then
    echo "  command      ${ANSIBLE_CMD[*]}"
  fi
  [[ -z "$GHCR_EXPIRY_LINE" ]] || echo "  ghcr login   $GHCR_EXPIRY_LINE"
  if [[ "$MODE" != provision ]]; then
    echo "  then verify  ssh ${VM_HOST:-<vm>}:"
    local c
    for c in "${VERIFY_CMDS[@]}"; do echo "                 $c"; done
    for c in "${BOOT_CMDS[@]}"; do echo "                 (after the heartbeat) $c"; done
    if [[ "$OV_ENDPOINT" == remote ]]; then
      echo "                 (polled) $(memory_ready_cmd)"
      echo "                 (polled) $(memory_search_cmd)"
    fi
    ansible_bool "$CLOUDFLARED_ENABLED" ||
      echo "                 (cloudflared not checked — cloudflared_enabled=$CLOUDFLARED_ENABLED, so the playbook does not install it)"
  fi
  echo "  dry_run      ${CFG_DRY_RUN:-<unset>} in $CONFIG — config.toml dry_run is NOT touched by deploy — the cutover flip is a manual edit"
  if [[ "$MODE" == release ]]; then
    echo "  stamp        BUILD_SHA is CI's, in the image (qcr.build-sha label, $APP_ROOT/BUILD_SHA). The qcr tui deploy tab reads it in the container"
  fi
}

load_manifest
vm_status_read
runspec_drift
ghcr_expiry_status

if [[ $DRY_RUN -eq 1 ]]; then
  print_plan
  echo
  echo "(--dry-run: nothing executed)"
  exit 0
fi

# ---- execute -----------------------------------------------------------------

print_plan >&2
echo >&2

# The companion's memory-health watcher (docker/companion/memory-health.mjs)
# alerts after 3 failed probes — and a deploy's container recreate takes the
# memory chain down for longer than that, so without a grace window the
# "memory unreachable" alert would fire on every deploy. The marker below opens
# the watcher's deploy-grace window: it rides the alerts bind mount into the
# companion container, the watcher holds the alert while the marker is
# younger than 10 min, and refresh_memory_forward deletes it the moment the
# chain answers again. Dotfile on purpose — AlertConsumer skips dotfiles.
# (Path matches the config.ts default; an alerts_dir override in config.toml
# would bypass the grace, visibly — the alert would simply return.)
COMPANION_ALERTS_DIR="$SANDBOX_DIR/state/companion/alerts"
DEPLOY_MARKER_FILE="$COMPANION_ALERTS_DIR/.deploy-window.json"

if [[ "$MODE" == provision ]]; then
  command -v ansible-playbook >/dev/null 2>&1 || die "ansible-playbook not on PATH — run this from the controller machine"
  [[ -f "$INVENTORY" ]] || die "no inventory at $INVENTORY (cp inventory.example.ini inventory.ini, then edit; or set QC_INVENTORY)"
  runspec_file >"$UPDATE_CONF_SRC"
  note "running: ${ANSIBLE_CMD[*]}"
  "${ANSIBLE_CMD[@]}"
  note "provision ok ($HEAD_SHA): the updater and run spec v$RUNSPEC_VERSION are on the VM; no image was pulled or started. Deploy with: $SELF release <version>"
  exit 0
fi

if [[ "$MODE" == release ]]; then
  [[ -n "$VM_HOST" ]] || die "no VM host resolved — set QC_VM_HOST: the release runs qcr-update over ssh"
  release_refusal="$(release_problem)"
  [[ -z "$release_refusal" ]] || die "refusing the release — $release_refusal"
  # The config home as the tar the updater takes: config.toml and profiles/,
  # dereferenced (a symlinked profile ships as the files it points at), never
  # secrets/. Staged first so the tar is exactly these two names.
  STAGE="$WORK_DIR/config-home"
  mkdir -p "$STAGE"
  cp -L "$CONFIG_HOME_SRC/$CONFIG_NAME" "$STAGE/config.toml"
  TAR_NAMES=(config.toml)
  if [[ -d "$CONFIG_HOME_SRC/profiles" ]]; then
    cp -RL "$CONFIG_HOME_SRC/profiles" "$STAGE/profiles"
    TAR_NAMES+=(profiles)
  fi
  # Open the deploy-grace window before the disruptive phase starts.
  mkdir -p "$COMPANION_ALERTS_DIR"
  printf '{"since":"%s","by":"deploy.sh","mode":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" > "$DEPLOY_MARKER_FILE"
  read -r -a UPDATE_ARGV <<<"$(update_args)"
  note "running: tar ${TAR_NAMES[*]} | ssh $VM_HOST sudo qcr-update ${UPDATE_ARGV[*]}"
  if [[ -n "${QC_UPDATE_RUN_CMD:-}" ]]; then
    tar -C "$STAGE" -cf - "${TAR_NAMES[@]}" | bash -c "$QC_UPDATE_RUN_CMD" _ "${UPDATE_ARGV[@]}" ||
      die "qcr-update failed — read its output above: any step before the recreate was rescued (the previous version runs, the bot is drained)"
  else
    tar -C "$STAGE" -cf - "${TAR_NAMES[@]}" | ssh -o BatchMode=yes "$VM_HOST" "sudo qcr-update ${UPDATE_ARGV[*]}" ||
      die "qcr-update failed — read its output above: any step before the recreate was rescued (the previous version runs, the bot is drained)"
  fi
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

# The heartbeat must come from this boot (scripts/heartbeat-fresh.mjs says
# why: the status.json the cat above shows may be the old daemon's). Polled,
# because a cold boot spends ~40s on OpenViking before the daemon starts, and a sync's restart re-runs the
# entrypoint's dist rebuild. QC_HEARTBEAT_PROBE_CMD stands in for the ssh
# read (tests); QC_HEARTBEAT_WAIT_S bounds the wait.
heartbeat_probe() {
  if [[ -n "${QC_HEARTBEAT_PROBE_CMD:-}" ]]; then
    bash -c "$QC_HEARTBEAT_PROBE_CMD"
  else
    ssh -o BatchMode=yes "$VM_HOST" \
      "sudo docker inspect -f '{{.State.StartedAt}}' $CONTAINER; date -u +%Y-%m-%dT%H:%M:%SZ; sudo cat /opt/quickreview/state/status.json"
  fi
}
check_heartbeat_fresh() {
  local wait_s="${QC_HEARTBEAT_WAIT_S:-240}" waited=0 verdict=""
  echo "--- heartbeat written by this boot (waits up to ${wait_s}s)"
  while :; do
    verdict="$(heartbeat_probe 2>/dev/null | node "$(dirname "${BASH_SOURCE[0]}")/heartbeat-fresh.mjs")" && {
      echo "$verdict"
      return 0
    }
    (( waited >= wait_s )) && break
    sleep 10
    waited=$((waited + 10))
  done
  echo "$verdict"
  echo "$SELF: CHECK FAILED: no fresh heartbeat after ${waited}s — the daemon is not running on this boot; read 'sudo docker logs --tail 100 $CONTAINER'" >&2
  return 1
}
check_heartbeat_fresh || FAILED=1

# The checks that need the entrypoint to have run: it merges bash-guard into
# pi's settings and re-installs the stub, both before it starts the daemon.
for cmd in "${BOOT_CMDS[@]}"; do
  echo "--- $cmd"
  if ! ssh -o BatchMode=yes "$VM_HOST" "$cmd"; then
    FAILED=1
    echo "$SELF: CHECK FAILED: $cmd" >&2
  fi
done

# The memory sidecar answers /ready and a reviewer-key search works from the
# daemon's container. Polled like the heartbeat: a cold sidecar spends minutes
# on the embedder before /ready passes. QC_MEMORY_PROBE_CMD / QC_MEMORY_SEARCH_CMD
# stand in for the ssh reads (tests); QC_MEMORY_WAIT_S bounds the wait.
memory_probe() {
  local which="$1" cmd
  if [[ "$which" == ready ]]; then
    cmd="${QC_MEMORY_PROBE_CMD:-}"
    [[ -n "$cmd" ]] && { bash -c "$cmd"; return; }
    ssh -o BatchMode=yes "$VM_HOST" "$(memory_ready_cmd)"
  else
    cmd="${QC_MEMORY_SEARCH_CMD:-}"
    [[ -n "$cmd" ]] && { bash -c "$cmd"; return; }
    ssh -o BatchMode=yes "$VM_HOST" "$(memory_search_cmd)"
  fi
}
check_memory_sidecar() {
  local wait_s="${QC_MEMORY_WAIT_S:-240}" waited=0 which out=""
  for which in ready search; do
    echo "--- memory sidecar $which (waits up to ${wait_s}s)"
    while :; do
      out="$(memory_probe "$which" 2>&1)" && { echo "$out"; break; }
      if (( waited >= wait_s )); then
        echo "$out"
        echo "$SELF: CHECK FAILED: memory sidecar $which — the daemon would run memory-less; read 'sudo docker logs --tail 100 $MEMORY_CONTAINER'" >&2
        return 1
      fi
      sleep 10
      waited=$((waited + 10))
    done
  done
}
if [[ "$OV_ENDPOINT" == remote ]]; then
  check_memory_sidecar || FAILED=1
fi

if [[ $FAILED -ne 0 ]]; then
  cat >&2 <<'EOF'
One or more post-deploy checks failed. Triage order (README §fallback):
  1. cloudflared inactive (when enabled) -> systemctl restart cloudflared; journalctl -u cloudflared -n 50
  2. container not running       -> docker logs quickreview-sandbox --tail 100
  3. stale/absent status.json    -> the daemon is not writing its heartbeat; docker logs, then restart the container
  4. memory sidecar check failed -> docker logs quickreview-memory --tail 100
  5. wrong image / bad release    -> 'release <previous version>', or the legacy image (deploy/ansible/README.md, Rollback);
                                    the old state, pihome and host directories are the same ones, untouched
While the sandbox is down, run manual laptop ticks (`/auto-review <n>`) —
NEVER concurrently with a live sandbox.
EOF
  exit 1
fi

# Refresh the host-side memory forward. Its long-lived ssh state goes stale
# when the container underneath it is recreated (every relay exits 255 and the
# TUI reports OpenViking down until a restart), so a deploy that touched the
# container restarts the unit itself. Three deliberate softnesses: the unit
# may not exist or may be inactive (the TUI can own the forward instead,
# adopt-or-bind) — skip silently; the restart or the probe failing warns and
# never fails the deploy (memory never blocks a deploy, same rule as the boot); verify-only
# runs skip it (no container was touched).
refresh_memory_forward() {
  [[ "$MODE" == "verify" ]] && return 0
  # tests: a stubbed run never restarts the developer's own user unit
  [[ -z "${QC_NO_MEMORY_FORWARD:-}" ]] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  if ! systemctl --user is-active --quiet qcr-memory-forward 2>/dev/null; then
    note "memory forward: systemd unit not active (TUI-owned or absent) — not restarted"
    # Still close the grace window if the chain already answers (a TUI-owned
    # forward recovers by itself); otherwise the marker expires on its own.
    curl -s -m 5 -o /dev/null "http://198.51.100.1:1933/health" && rm -f "$DEPLOY_MARKER_FILE"
    return 0
  fi
  note "memory forward: restarting qcr-memory-forward (its ssh state predates this deploy's container)"
  if ! systemctl --user restart qcr-memory-forward 2>/dev/null; then
    note "WARNING — memory forward restart failed; memory stays degraded until 'systemctl --user restart qcr-memory-forward' succeeds"
    return 0
  fi
  # Poll, don't probe once: right after the ansible run the VM container is
  # still booting OpenViking (~40s) and the forward's first relays die against
  # it — a single probe would race that boot and warn on every deploy even
  # when the chain comes up a minute later. Up to 3 min covers the boot plus
  # relay churn; only then is a warning believable.
  local waited=0
  while (( waited < 180 )); do
    if curl -s -m 5 -o /dev/null "http://198.51.100.1:1933/health"; then
      note "memory forward: answering on the qcr-memory bridge (${waited}s after restart)"
      rm -f "$DEPLOY_MARKER_FILE"
      return 0
    fi
    sleep 10
    waited=$((waited + 10))
  done
  note "WARNING — memory forward still not answering after ${waited}s; check 'journalctl --user -u qcr-memory-forward -n 20' (deploy-grace marker left to expire so a real outage still alerts)"
}
refresh_memory_forward

# Said again at the end, where a long verify's output is read.
[[ $GHCR_EXPIRY_WARNS -eq 0 ]] || note "$GHCR_EXPIRY_LINE"

note "deploy ok ($MODE, $HEAD_SHA)"
