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
#       - [openviking] local_embedder_file/_url/_sha256/_port/_threads
#                                           == group_vars openviking_local_embedder_*
#         (S4: the local embedder's model file, baked into the image
#          by a layer that interpolates the group_vars — a changed pin needs
#          `rebuild`)
#   * refuses to ship without a config home: sync|rebuild deliver
#     the install's config home — the located config.toml and the profiles/
#     beside it, never its secrets/ — to the VM by the secrets' route (a
#     playbook task of its own, `-e config_home_src=…`, never the checkout
#     rsync), and the container reads it there. A config that lives only in
#     the checkout is refused (`qcr install migrate` moves it), and so is a
#     `[review] profile` — or any profile it extends — found neither in the
#     home's profiles/ nor among the checkout's generic examples (the two
#     places the VM looks;: no other checkout profile is read).
#     Every pin/drift check below reads that same located config.
#   * refuses a base-clone name (`[github] clone_dir`, else the
#     repo slug's basename — the same rule as githubCloneDir in
#     src/config.ts) that is not one plain path segment, that names a
#     runtime/build dir of the sandbox root, or that names a tracked path.
#     That name is handed to the playbook as
#     `-e base_clone_dir=…`, which is what keeps the VM's clone out of the
#     rsync --delete, and it is written into this checkout's LOCAL ignore
#     (.git/info/exclude, never the tracked .gitignore) so a clone of any
#     name never reads as a dirty tree.
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
#   QCR_CONFIG      config.toml path    (default: the install locator's answer —
#                   the install's config home's config.toml;
#                   scripts/install-locator.sh). Its directory is the
#                   config home sync|rebuild ship; `verify` alone
#                   accepts a QCR_CONFIG inside the checkout
#   (secrets)       the playbook's secrets_src is the install locator's answer
#                   too — [github] secrets_dir, else <config home>/secrets
#                  

set -euo pipefail

SELF="$(basename "${BASH_SOURCE[0]}")"
DEFAULT_ANSIBLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/ansible"

SANDBOX_DIR="${QC_SANDBOX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ANSIBLE_DIR="${QC_ANSIBLE_DIR:-$DEFAULT_ANSIBLE_DIR}"
INVENTORY="${QC_INVENTORY:-$ANSIBLE_DIR/inventory.ini}"
# the pin/drift preflight reads the config the install locator names.
# Sourced from beside THIS script, not from $SANDBOX_DIR: the sandbox may be a
# scratch working copy.
. "$(dirname "${BASH_SOURCE[0]}")/install-locator.sh"
CONFIG="$(qcr_locate_config "$SANDBOX_DIR")" || exit 1
GROUP_VARS="$ANSIBLE_DIR/group_vars/all.yml"
PLAYBOOK="$ANSIBLE_DIR/playbook.yml"
CONTAINER="quickreview-sandbox"
OV_UPSTREAM="$SANDBOX_DIR/extensions/vendor/openviking-pi/upstream.json"

# The playbook (an asset — never edited from here) carries no tags, so "sync"
# is expressed as a start-at-task: everything from the stale-image guard
# onwards (guard → rsync → config home → build context → image → container
# recreate), skipping host packages, cloudflared install and the secrets/seed
# copies. The guard comes first so a sync that needs a rebuild changes nothing.
SYNC_START_TASK="Build context fingerprint"

MODE=""
DRY_RUN=0

die() { echo "$SELF: $*" >&2; exit 1; }
note() { echo "$SELF: $*" >&2; }

# ---- arguments ---------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    sync|rebuild|verify) [[ -n "$MODE" ]] && die "two modes given: $MODE and $1"; MODE="$1" ;;
    -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  repo="${repo%.git}"
  while [[ "$repo" == */ ]]; do repo="${repo%/}"; done
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
# a shipping mode ships the install's CONFIG HOME — the located
# config and the profiles/ beside it — to the VM by the secrets' route (its own
# playbook task, never the checkout rsync), and the container reads it there
# ($QCR_CONFIG names the shipped file). So the config must live in such a home:
# a $QCR_CONFIG naming a file inside the checkout is refused, not shipped.
# `verify` ships nothing and still reads whatever the locator found.
SHIPPED_CONFIG="$(qcr_shipped_config "$SANDBOX_DIR")" || exit 1
if [[ "$MODE" != "verify" && -z "$SHIPPED_CONFIG" ]]; then
  die "no config home to ship — the live config is $CONFIG, inside the checkout. Deploy ships the install's config home ($(qcr_config_home 2>/dev/null || echo '$XDG_CONFIG_HOME/qcr/<install>'), or the directory \$QCR_CONFIG names) to the VM, never the checkout's config.toml: move it with \`qcr install migrate\`, then re-run"
fi
CONFIG_HOME_SRC=""
CONFIG_NAME=""
if [[ -n "$SHIPPED_CONFIG" ]]; then
  CONFIG_HOME_SRC="$(dirname "$SHIPPED_CONFIG")"
  CONFIG_NAME="$(basename "$SHIPPED_CONFIG")"
  # Both reach the playbook as `-e k=v`, which splits on whitespace, and
  # ansible templates the values, so a `{`/`}` could render as Jinja.
  if [[ "$MODE" != "verify" && ( "$CONFIG_HOME_SRC" =~ [[:space:]\"\'{}] || "$CONFIG_NAME" =~ [[:space:]\"\'{}] ) ]]; then
    die "the config home path '$SHIPPED_CONFIG' contains whitespace, quotes or braces — the playbook cannot be handed it; set XDG_CONFIG_HOME (or QCR_CONFIG) to a plain path"
  fi
  # The file name is also an rsync filter pattern (`--include=/<name>`): a
  # wildcard in it would ship some other file, or none, and the container's
  # QCR_CONFIG would name a config that is not there — refused, not shipped.
  if [[ "$MODE" != "verify" && ! "$CONFIG_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    die "the config file name '$CONFIG_NAME' is not a plain file name — letters, digits, '.', '_' and '-' only (it becomes an rsync filter pattern and the container's QCR_CONFIG); rename it, or point QCR_CONFIG at one that is"
  fi
fi
# The repo profile the config names, and every profile it `extends`,
# must be found where the VM's daemon will look for it (src/install.ts
# locateProfile, in the container): profiles/ beside the shipped config first,
# then the rsynced checkout's profiles/ — for a generic example ONLY
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
if [[ "$MODE" != "verify" && -n "$DEPLOY_PROFILE" ]]; then
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

# 1a. the base clone. Its name reaches the playbook's rsync exclude,
# so it must be one plain path segment, and it must not name anything this
# tree tracks — excluding `/src` would ship no daemon, and a clone called
# `src` would be deleted by the --delete it was meant to survive.
CLONE_DIR="$(base_clone_dir)"
if [[ ! "$CLONE_DIR" =~ ^[A-Za-z0-9._-]+$ || "$CLONE_DIR" == "." || "$CLONE_DIR" == ".." ]]; then
  die "base clone name '$CLONE_DIR' ([github] clone_dir, else the repo's basename) is not one plain directory name — fix config.toml"
fi
# Nor may it name a directory the daemon or the build already owns at the
# sandbox root — every runtime exclude of the playbook's rsync, plus the build
# output. Those are untracked, so the ls-files check below cannot see them,
# and a repo called `notes` or `wt` would otherwise be cloned into (or over)
# a runtime dir. tests/deploy.test.ts pins this list against the playbook.
BASE_CLONE_RESERVED=(.git .claude node_modules state wt archive commands digest inject verdict memory notes ledger.md AGENTS.override.md pihome dist)
for reserved in "${BASE_CLONE_RESERVED[@]}"; do
  if [[ "$CLONE_DIR" == "$reserved" ]]; then
    die "base clone name '$CLONE_DIR' is a runtime or build directory of the sandbox root — set [github] clone_dir to a free name"
  fi
done
if [[ -n "$(git -C "$SANDBOX_DIR" ls-files -- "$CLONE_DIR" | head -1)" ]]; then
  die "base clone name '$CLONE_DIR' collides with a tracked path in $SANDBOX_DIR — set [github] clone_dir to a free name"
fi
# The clone is untracked by construction, so the ignore rule is local: the
# repo's info/exclude (shared by every worktree), never the tracked
# .gitignore — a per-install name there would itself be a dirty tree. Written
# in every mode, --dry-run included: it is bookkeeping for the check below,
# not a deploy action, and it is idempotent.
if ! git -C "$SANDBOX_DIR" check-ignore -q --no-index "$CLONE_DIR/" 2>/dev/null; then
  CLONE_EXCLUDE="$(git -C "$SANDBOX_DIR" rev-parse --path-format=absolute --git-path info/exclude)"
  mkdir -p "$(dirname "$CLONE_EXCLUDE")"
  # never glue the rule onto a last line that lacks its newline
  if [[ -s "$CLONE_EXCLUDE" && -n "$(tail -c1 "$CLONE_EXCLUDE")" ]]; then echo >>"$CLONE_EXCLUDE"; fi
  printf '/%s/\n' "$CLONE_DIR" >>"$CLONE_EXCLUDE"
  note "base clone '$CLONE_DIR' added to the local ignore ($CLONE_EXCLUDE)"
fi

# 1b. the secrets source: the install locator's answer — the
# configured [github] secrets_dir, else <config home>/secrets — handed to the
# playbook's secrets copy as secrets_src, so group_vars' hand-run default is
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
# changed: a sync now ships the config home, so its flag is the VM's flag.
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
  # the EMBEDDER is mirrored the same way, against the value the boot
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
    # S4 (integration review): read config.toml the way the daemon's
    # parser does (src/config.ts) — under `local`, the previous release's
    # REQUIRED spelling (the engine's built-in Chinese-first model, 512 dims,
    # `RETIRED_LOCAL_EMBEDDING`) means the local English embedder that
    # replaced it (`LOCAL_EMBEDDING`). So the live config.toml needs no edit
    # for this deploy, and the same file keeps loading on the previous release
    # (which refuses the new spelling) — a rollback cannot strand it. Both
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
  # the LOCAL EMBEDDER's model file is a pin like `version` —
  # config.toml == group_vars == the image's model layer (which interpolates
  # these vars, so agreeing here means agreeing in the image). Its port and
  # threads are mirrored the same way: the boot's provisioning step runs the
  # service and renders ov.conf's api_base from the ansible values, the daemon
  # supervises it from config.toml's — a port they disagree on is a search
  # nothing serves. A config.toml that predates the pin names NONE of the five
  # keys: the code defaults are the pin then (held to group_vars by
  # tests/openviking.test.ts) and the check stands down, said aloud. One that
  # names ANY of them is checked key by key — every named key against
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

# 3. sandbox_src must be wired, or the rsync task no-ops
if ! grep -Eq '^[[:space:]]*sandbox_src[[:space:]]*:' "$GROUP_VARS"; then
  die "group_vars/all.yml has no active 'sandbox_src' — uncomment it (it must point at $SANDBOX_DIR) or the working copy is never synced"
fi

# ---- plan --------------------------------------------------------------------

ANSIBLE_CMD=(ansible-playbook -i "$INVENTORY" "$PLAYBOOK")
case "$MODE" in
  sync)    ANSIBLE_CMD+=(--start-at-task "$SYNC_START_TASK" -e force_restart=true -e "base_clone_dir=$CLONE_DIR" -e "config_home_src=$CONFIG_HOME_SRC" -e "config_file_name=$CONFIG_NAME") ;;
  rebuild) ANSIBLE_CMD+=(-e rebuild_image=true -e "base_clone_dir=$CLONE_DIR" -e "secrets_src=$SECRETS_SRC" -e "config_home_src=$CONFIG_HOME_SRC" -e "config_file_name=$CONFIG_NAME") ;;
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

# ---- drain advisory (WARN only — the owner chose warn over refusal) -----------
# A deploy recreates the container; rounds in flight are orphaned mid-review,
# burn self-requeue budget, and the cold boot's reconcile eats GitHub rate
# limit (measured 2026-08-25: three cold boots exhausted the hourly limit).
# The drain valve (`qcr drain on`) hard-stops the webhook and starts no new
# work, so running_rounds converges to 0. This reads the heartbeat and WARNS
# on an undrained deploy while rounds run — it NEVER refuses, and an
# unreadable heartbeat is noted, not fatal. QC_STATUS_JSON_CMD overrides the
# ssh read (tests).
drain_advisory() {
  [[ "$MODE" == "verify" ]] && return 0
  local status=""
  if [[ -n "${QC_STATUS_JSON_CMD:-}" ]]; then
    status="$(bash -c "$QC_STATUS_JSON_CMD" 2>/dev/null || true)"
  elif [[ -n "$VM_HOST" ]]; then
    status="$(ssh -o BatchMode=yes "$VM_HOST" 'sudo cat /opt/quickreview/state/status.json' 2>/dev/null || true)"
  fi
  if [[ -z "$status" ]]; then
    note "drain check: heartbeat unreadable — cannot tell whether rounds are running (WARN-only check, proceeding)"
    return 0
  fi
  local running draining
  running="$(printf '%s' "$status" | grep -o '"running_rounds"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || true)"
  running="${running:-0}"
  draining=0
  printf '%s' "$status" | grep -q '"draining"[[:space:]]*:[[:space:]]*true' && draining=1
  if [[ "$draining" -eq 0 && "$running" -gt 0 ]]; then
    cat >&2 <<EOF
$SELF: WARNING — deploying UNDRAINED while $running round(s) are running.
    Recreating the container orphans them mid-review, burns self-requeue
    budget, and the cold boot's reconcile eats GitHub rate limit.
    Prefer:  qcr drain on   ->  wait for running_rounds 0  ->  deploy.
    (WARN only — proceeding. The drain auto-lifts on the new boot's first
    healthy reconcile pass; re-drain before each step of a multi-deploy
    window.)
EOF
  elif [[ "$draining" -eq 1 && "$running" -gt 0 ]]; then
    note "drain is ON with $running round(s) still finishing — wait for running_rounds 0 before deploying"
  elif [[ "$draining" -eq 1 ]]; then
    note "drain is ON and the board is quiet — good to deploy (auto-lifts on the new boot's first healthy reconcile)"
  fi
}

print_plan() {
  echo "plan — $SELF $MODE"
  echo "  sandbox      $SANDBOX_DIR @ $HEAD_SHA (clean)"
  echo "  ansible      $ANSIBLE_DIR"
  echo "  inventory    $INVENTORY"
  echo "  pi pin       $CFG_PI (config.toml == group_vars, not bumped)"
  if [[ -n "$CFG_OV" ]]; then
    echo "  memory pins  openviking $CFG_OV (config.toml == group_vars == image layer), extension ${CFG_OV_EXT:-<unset>} (config.toml == upstream.json)"
    echo "  memory auth  auth_mode ${CFG_OV_AUTH:-<unset>} (config.toml == group_vars; 'dev' means NO per-user confinement)"
    echo "  memory embed ${CFG_OV_EMBED:-<unset>} (config.toml == ansible effective value; 'local' means no memory text leaves the VM)"
    echo "  local model  ${GV_LE_MODEL:-<code default>} sha256 ${CFG_OV_LE_SHA:-<code default>} (config.toml == group_vars == image layer; a changed pin needs rebuild)"
  else
    echo "  memory pins  <no [openviking] block in config.toml — unverified>"
  fi
  echo "  vm host      ${VM_HOST:-<unset — set QC_VM_HOST>}"
  echo "  base clone   /$CLONE_DIR (kept on the VM by the rsync exclude; locally ignored via info/exclude)"
  if [[ "$MODE" != "verify" ]]; then
    echo "  config home  $CONFIG_HOME_SRC ($CONFIG_NAME + profiles/ -> the VM's read-only /opt/quickreview/config-home, which QCR_CONFIG names; secrets/ never rides it)"
    echo "  profile      ${PROFILE_CHAIN:-<none — the generic registry>}"
  fi
  case "$MODE" in
    rebuild) echo "  secrets      $SECRETS_SRC (copied to the VM's read-only secrets mount)" ;;
    sync)    echo "  secrets      $SECRETS_SRC (not copied — sync starts past the secrets tasks; rebuild ships them)" ;;
  esac
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
  echo "  dry_run      ${CFG_DRY_RUN:-<unset>} in $CONFIG — config.toml dry_run is NOT touched by deploy — the cutover flip is a manual edit"
  if [[ "$MODE" != "verify" ]]; then
    echo "  marker       BUILD_SHA=$HEAD_SHA written before the rsync (gitignored; the qcr tui deploy tab reads it on the VM)"
  fi
}

drain_advisory

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
# memory chain down for longer than that, so the "memory unreachable" alert
# fired on EVERY deploy (the owner, 2026-08-27). The marker below opens the
# watcher's deploy-grace window: it rides the alerts bind mount into the
# companion container, the watcher holds the alert while the marker is
# younger than 10 min, and refresh_memory_forward deletes it the moment the
# chain answers again. Dotfile on purpose — AlertConsumer skips dotfiles.
# (Path matches the config.ts default; an alerts_dir override in config.toml
# would bypass the grace, visibly — the alert would simply return.)
COMPANION_ALERTS_DIR="$SANDBOX_DIR/state/companion/alerts"
DEPLOY_MARKER_FILE="$COMPANION_ALERTS_DIR/.deploy-window.json"

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
  # `npm run build` already chains this; run it again HERE, at the point where
  # the tree becomes something the VM will run. `incremental` emits from the
  # build info rather than from what is on disk, so a targeted delete, an
  # interrupted build or a half-copied tree leaves a dist/ that tsc calls
  # up-to-date and exits 0 over. The rsync would ship exactly that, and the
  # daemon would crash on the VM instead of failing here.
  (cd "$SANDBOX_DIR" && node scripts/verify-dist.mjs) || die "dist/ is incomplete — refusing to rsync a build that is missing compiled files"
  # BUILD_SHA rides the rsync so the VM can answer "what commit runs here?"
  # (the qcr tui deploy tab diffs local HEAD against it). Gitignored, so the
  # clean-tree guard above stays meaningful.
  printf '%s %s %s\n' "$HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" > "$SANDBOX_DIR/BUILD_SHA"
  # Open the deploy-grace window BEFORE the disruptive phase starts.
  mkdir -p "$COMPANION_ALERTS_DIR"
  printf '{"since":"%s","by":"deploy.sh","mode":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" > "$DEPLOY_MARKER_FILE"
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

# The heartbeat must come from THIS boot (scripts/heartbeat-fresh.mjs says
# why: on 2026-10-03 the cat above showed the old daemon's file and the deploy
# reported ok over a crash loop). Polled, because a cold boot spends ~40s on
# OpenViking before the daemon starts, and a sync's restart re-runs the
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

# Refresh the host-side memory forward (2026-08-25, the owner: "this has to
# happen during the deploy"). The forward's long-lived ssh state ages while
# the container underneath it churns — after the 2026-08-25 window every
# relay was exiting 255 and the TUI reported OpenViking down until a manual
# `systemctl --user restart`. So a deploy that touched the container restarts
# the unit itself. Three deliberate softnesses: the unit may not exist or may
# be inactive (the TUI can own the forward instead, adopt-or-bind) —
# skip silently; the restart or the probe failing WARNS and never fails the
# deploy (memory never blocks a deploy, same rule as the boot); verify-only
# runs skip it (no container was touched).
refresh_memory_forward() {
  [[ "$MODE" == "verify" ]] && return 0
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
  # it — the old single probe here raced that boot and WARNed on every deploy
  # even when the chain came up fine a minute later. Up to 3 min covers the
  # boot plus relay churn; only then is a WARN believable.
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

note "deploy ok ($MODE, $HEAD_SHA)"
