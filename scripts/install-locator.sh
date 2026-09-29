# shellcheck shell=bash
# install-locator.sh — the install locator's shell mirror.
#
# `src/install.ts` is the reference; this is the same rule for the scripts that
# cannot import it (the posting route, mint-token, deploy.sh, the bench). The
# two are run over the same cases by `tests/install-shell.test.ts`, so they
# cannot drift apart silently.
#
# SOURCE it, never run it:
#
#   . "$ROOT/scripts/install-locator.sh"
#   CONFIG="$(qcr_locate_config "$ROOT")" || exit 1
#
# The rule, in order:
#   1. $QCR_CONFIG, taken as given (a missing file is the caller's error)
#   2. the install's config home: ${XDG_CONFIG_HOME:-$HOME/.config}/qcr/<install>/config.toml,
#      whether or not it exists (a missing file is the caller's error too)
#      ($QCR_CONFIG_HOME, when set and absolute, IS the config home)
# `<install>` is $QCR_INSTALL, default `default`, a plain name only. The
# checkout's own config.toml is never read — `qcr install migrate`
# moves it. The <checkout-root> argument is kept for the profile lookup.
#
# Repo profiles: `qcr_profile_dirs <root>` prints the directories a
# profile is looked up in, highest priority first — the config home's
# profiles/, then profiles/ beside $QCR_CONFIG when it is set, then the
# checkout's, which serves ONLY the generic examples (`QCR_EXAMPLE_PROFILES`,
# pinned to src/install.ts EXAMPLE_PROFILES): `qcr_profile_dir` applies that.

qcr_install_name() {
  local name="${QCR_INSTALL:-}"
  name="${name#"${name%%[![:space:]]*}"}"
  name="${name%"${name##*[![:space:]]}"}"
  if [[ -z "$name" ]]; then
    printf '%s\n' default
    return 0
  fi
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ || "$name" == *..* ]]; then
    echo "install-locator: QCR_INSTALL \"$name\" is not a plain name — letters, digits, '.', '_' and '-' only, no path separators or '..'" >&2
    return 1
  fi
  printf '%s\n' "$name"
}

# An XDG base dir: the variable when set AND absolute, else $HOME/<fallback>.
_qcr_xdg_base() { # _qcr_xdg_base <value> <fallback-under-home>
  local value="$1" fallback="$2"
  if [[ -n "$value" && "$value" == /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "${HOME:-$(cd ~ && pwd)}/$fallback"
  fi
}

# A whole-home override ($QCR_CONFIG_HOME / $QCR_STATE_HOME, — the
# companion container points them at its mounts): taken only when set AND
# absolute, trailing slashes dropped. Prints nothing when it does not apply.
_qcr_home_override() { # _qcr_home_override <value>
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  [[ -n "$v" && "$v" == /* ]] || return 0
  while [[ "$v" == */ && "$v" != / ]]; do v="${v%/}"; done
  printf '%s\n' "$v"
}

qcr_config_home() {
  local name over
  over="$(_qcr_home_override "${QCR_CONFIG_HOME:-}")"
  if [[ -n "$over" ]]; then
    printf '%s\n' "$over"
    return 0
  fi
  name="$(qcr_install_name)" || return 1
  printf '%s\n' "$(_qcr_xdg_base "${XDG_CONFIG_HOME:-}" .config)/qcr/$name"
}

qcr_state_home() {
  local name over
  over="$(_qcr_home_override "${QCR_STATE_HOME:-}")"
  if [[ -n "$over" ]]; then
    printf '%s\n' "$over"
    return 0
  fi
  name="$(qcr_install_name)" || return 1
  printf '%s\n' "$(_qcr_xdg_base "${XDG_STATE_HOME:-}" .local/state)/qcr/$name"
}

qcr_locate_config() { # qcr_locate_config [checkout-root]
  local override="${QCR_CONFIG:-}" home
  override="${override#"${override%%[![:space:]]*}"}"
  override="${override%"${override##*[![:space:]]}"}"
  if [[ -n "$override" ]]; then
    [[ "$override" == /* ]] || override="$PWD/$override"
    printf '%s\n' "$override"
    return 0
  fi
  home="$(qcr_config_home)" || return 1
  printf '%s\n' "$home/config.toml"
}

# The generic profiles the checkout ships — the only ones read from there.
QCR_EXAMPLE_PROFILES=(default example-django minimal)

qcr_is_example_profile() { # qcr_is_example_profile <name>
  local p
  for p in "${QCR_EXAMPLE_PROFILES[@]}"; do [[ "$p" == "$1" ]] && return 0; done
  return 1
}

qcr_profile_dirs() { # qcr_profile_dirs <checkout-root>
  local root="$1" override="${QCR_CONFIG:-}" home dir seen=""
  override="${override#"${override%%[![:space:]]*}"}"
  override="${override%"${override##*[![:space:]]}"}"
  home="$(qcr_config_home)" || return 1
  local -a dirs=("$home/profiles")
  if [[ -n "$override" ]]; then
    [[ "$override" == /* ]] || override="$PWD/$override"
    dirs+=("$(dirname "$override")/profiles")
  fi
  dirs+=("$root/profiles")
  for dir in "${dirs[@]}"; do
    [[ "$seen" == *$'\n'"$dir"$'\n'* ]] && continue
    seen+=$'\n'"$dir"$'\n'
    printf '%s\n' "$dir"
  done
}

# The directory holding profile <name> — src/install.ts `locateProfile`: the
# first of qcr_profile_dirs that has it, the checkout's only for an example
# (a directory reached first as "beside $QCR_CONFIG" is not the checkout's,
# even when it is the same path). Prints nothing when none does.
qcr_profile_dir() { # qcr_profile_dir <checkout-root> <name>
  local root="$1" name="$2" dir override="${QCR_CONFIG:-}" beside=""
  override="$(_qcr_trim "$override")"
  if [[ -n "$override" ]]; then
    [[ "$override" == /* ]] || override="$PWD/$override"
    beside="$(dirname "$override")/profiles"
  fi
  while IFS= read -r dir; do
    if [[ "$dir" == "$root/profiles" && "$dir" != "$beside" ]] && ! qcr_is_example_profile "$name"; then
      continue
    fi
    if [[ -d "$dir/$name" ]]; then
      printf '%s\n' "$dir/$name"
      return 0
    fi
  done < <(qcr_profile_dirs "$root")
  return 0
}

# ---- secrets -------------------------------------------------------
#
#   SECRETS_DIR="$(qcr_locate_secrets "$configured" "${QC_SECRETS_DIR:-}")" || exit 1
#
# The rule, in order (src/install.ts `locateSecrets`):
#   1. the configured [github] secrets_dir, unless empty or the old default
#      spelling (~/.config/quickreview-bot) — taken as given, ~ expanded
#   2. the caller's override (the wizards' $QC_SECRETS_DIR), ~ expanded
#   3. <config home>/secrets, whether or not it exists
# The old ~/.config/quickreview-bot dir itself is never read.

qcr_secrets_home() {
  local home
  home="$(qcr_config_home)" || return 1
  printf '%s\n' "$home/secrets"
}

_qcr_home_dir() { printf '%s\n' "${HOME:-$(cd ~ && pwd)}"; }

_qcr_expand_home() { # _qcr_expand_home <path>
  local p="$1"
  if [[ "$p" == "~" ]]; then
    _qcr_home_dir
  elif [[ "$p" == "~/"* ]]; then
    printf '%s\n' "$(_qcr_home_dir)/${p#\~/}"
  else
    printf '%s\n' "$p"
  fi
}

_qcr_trim() { # _qcr_trim <text>
  local t="$1"
  t="${t#"${t%%[![:space:]]*}"}"
  printf '%s\n' "${t%"${t##*[![:space:]]}"}"
}

# The old default's spelling, only to recognise it in a configured value.
_qcr_old_secrets_dir() { printf '%s\n' "$(_qcr_home_dir)/.config/quickreview-bot"; }

qcr_locate_secrets() { # qcr_locate_secrets [configured] [override]
  local configured override home stripped
  configured="$(_qcr_trim "${1:-}")"
  override="$(_qcr_trim "${2:-}")"
  if [[ -n "$configured" ]]; then
    stripped="$configured"
    while [[ "$stripped" == */ ]]; do stripped="${stripped%/}"; done
    if [[ "$stripped" != "~/.config/quickreview-bot" && "$(_qcr_expand_home "$stripped")" != "$(_qcr_old_secrets_dir)" ]]; then
      _qcr_expand_home "$configured"
      return 0
    fi
  fi
  if [[ -n "$override" ]]; then
    _qcr_expand_home "$override"
    return 0
  fi
  home="$(qcr_secrets_home)" || return 1
  printf '%s\n' "$home"
}

# The companion's OpenViking key file (src/install.ts `locateKeysFile`):
# $QCR_OPENVIKING_KEYS, else $XDG_CONFIG_HOME/qcr-operator/<install>/ — whether
# or not it exists. Deliberately OUTSIDE the config home, which a container
# mounts.
qcr_locate_keys_file() {
  local override name
  override="$(_qcr_trim "${QCR_OPENVIKING_KEYS:-}")"
  if [[ -n "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  name="$(qcr_install_name)" || return 1
  printf '%s\n' "$(_qcr_xdg_base "${XDG_CONFIG_HOME:-}" .config)/qcr-operator/$name/openviking-keys.env"
}

# ---- the shipped config home ---------------------------------------
#
#   SHIPPED="$(qcr_shipped_config "$ROOT")" || exit 1
#
# The located config when it is one `deploy.sh sync|rebuild` can ship: the file
# exists and its directory — the config home, with the profiles/ beside it —
# lies outside the checkout. Prints NOTHING (status 0) when there is none: no
# config at all, or a $QCR_CONFIG naming a file inside the checkout, which
# deploy never ships (it rides no route but the checkout rsync, and the VM
# reads the shipped home).
# Status 1 only on a locator error.
qcr_shipped_config() { # qcr_shipped_config <checkout-root>
  local root="$1" config dir rootp
  config="$(qcr_locate_config "$root")" || return 1
  [[ -f "$config" ]] || return 0
  dir="$(cd "$(dirname "$config")" 2>/dev/null && pwd -P)" || return 0
  rootp="$(cd "$root" 2>/dev/null && pwd -P)" || return 1
  [[ "$dir" == "$rootp" || "$dir" == "$rootp"/* ]] && return 0
  printf '%s/%s\n' "$dir" "$(basename "$config")"
}

_qcr_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# What a config home ships, as two hashes: `config=<sha256> profiles=<sha256>`.
# The config file's bytes; and every file under profiles/ beside it (symlinks
# followed, as the ship copies them), listed `<sha256>  <relative path>` in
# byte order and hashed again — so a renamed, added or removed file changes it
# as surely as an edited one. The same function runs on the PC over the home it
# would ship and in the container over the home it was shipped; the deploy
# tab's "profile changed, not deployed" is those two answers disagreeing.
qcr_config_fingerprint() { # qcr_config_fingerprint <config-file>
  local config="$1" dir cfg_h prof_h
  dir="$(dirname "$config")"
  cfg_h="$(_qcr_sha256 <"$config")" || return 1
  prof_h="$(
    cd "$dir" || exit 1
    if [[ -d profiles ]]; then
      find -L profiles -type f -print0 | LC_ALL=C sort -z |
        while IFS= read -r -d '' f; do
          printf '%s  %s\n' "$(_qcr_sha256 <"$f")" "$f"
        done
    fi | _qcr_sha256
  )" || return 1
  printf 'config=%s profiles=%s\n' "$cfg_h" "$prof_h"
}
