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
#   2. the install's config home: ${XDG_CONFIG_HOME:-$HOME/.config}/qcr/<install>/config.toml
#      ($QCR_CONFIG_HOME, when set and absolute, IS the config home)
#   3. the checkout's legacy <root>/config.toml — the expand step's fallback
#   4. nothing anywhere: the config-home path (where a new config belongs)
# `<install>` is $QCR_INSTALL, default `default`, a plain name only.
#
# Repo profiles: `qcr_profile_dirs <root>` prints the directories a
# profile is looked up in, highest priority first — the config home's
# profiles/, then profiles/ beside $QCR_CONFIG when it is set, then the
# checkout's (the generic examples, and the legacy place).
#
# The legacy fallback is announced on stderr when a human is watching (stderr
# is a terminal). Machine callers stay quiet on purpose: git's credential
# helper runs mint-token on every fetch, and the daemon — which logs the
# fallback itself, once, at boot — hands each session its resolved path as
# $QCR_CONFIG, so a session's scripts never reach step 3 at all.

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

qcr_locate_config() { # qcr_locate_config <checkout-root>
  local root="$1" override="${QCR_CONFIG:-}" home
  override="${override#"${override%%[![:space:]]*}"}"
  override="${override%"${override##*[![:space:]]}"}"
  if [[ -n "$override" ]]; then
    [[ "$override" == /* ]] || override="$PWD/$override"
    printf '%s\n' "$override"
    return 0
  fi
  home="$(qcr_config_home)" || return 1
  if [[ -e "$home/config.toml" ]]; then
    printf '%s\n' "$home/config.toml"
  elif [[ -e "$root/config.toml" ]]; then
    if [[ -t 2 ]]; then
      echo "qcr: reading the LEGACY checkout config $root/config.toml — the install's config home is $home; move it there with \`qcr install migrate\`" >&2
    fi
    printf '%s\n' "$root/config.toml"
  else
    printf '%s\n' "$home/config.toml"
  fi
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

# ---- secrets -------------------------------------------------------
#
#   SECRETS_DIR="$(qcr_locate_secrets "$configured" "${QC_SECRETS_DIR:-}")" || exit 1
#
# The rule, in order (src/install.ts `locateSecrets`):
#   1. the configured [github] secrets_dir, unless empty or the legacy default
#      spelling (~/.config/quickreview-bot) — taken as given, ~ expanded
#   2. the caller's override (the wizards' $QC_SECRETS_DIR), ~ expanded
#   3. <config home>/secrets when it exists
#   4. the legacy ~/.config/quickreview-bot when it exists — announced on a tty
#   5. nothing anywhere: <config home>/secrets (where new secrets belong)

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

qcr_legacy_secrets_dir() { printf '%s\n' "$(_qcr_home_dir)/.config/quickreview-bot"; }

qcr_locate_secrets() { # qcr_locate_secrets [configured] [override]
  local configured override home legacy stripped
  configured="$(_qcr_trim "${1:-}")"
  override="$(_qcr_trim "${2:-}")"
  legacy="$(qcr_legacy_secrets_dir)"
  if [[ -n "$configured" ]]; then
    stripped="$configured"
    while [[ "$stripped" == */ ]]; do stripped="${stripped%/}"; done
    if [[ "$stripped" != "~/.config/quickreview-bot" && "$(_qcr_expand_home "$stripped")" != "$legacy" ]]; then
      _qcr_expand_home "$configured"
      return 0
    fi
  fi
  if [[ -n "$override" ]]; then
    _qcr_expand_home "$override"
    return 0
  fi
  home="$(qcr_secrets_home)" || return 1
  if [[ -e "$home" ]]; then
    printf '%s\n' "$home"
  elif [[ -e "$legacy" ]]; then
    if [[ -t 2 ]]; then
      echo "qcr: reading secrets from the LEGACY dir $legacy — the install's secrets home is $home; move them there with \`qcr install migrate\`" >&2
    fi
    printf '%s\n' "$legacy"
  else
    printf '%s\n' "$home"
  fi
}

# The companion's OpenViking key file (src/install.ts `locateKeysFile`):
# $QCR_OPENVIKING_KEYS, else $XDG_CONFIG_HOME/qcr-operator/<install>/, else the
# legacy ~/.config/quickreview-bot/, else the operator home. Deliberately OUTSIDE
# the config home, which a container mounts.
qcr_locate_keys_file() {
  local override name primary legacy
  override="$(_qcr_trim "${QCR_OPENVIKING_KEYS:-}")"
  if [[ -n "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  name="$(qcr_install_name)" || return 1
  primary="$(_qcr_xdg_base "${XDG_CONFIG_HOME:-}" .config)/qcr-operator/$name/openviking-keys.env"
  legacy="$(qcr_legacy_secrets_dir)/openviking-keys.env"
  if [[ -e "$primary" ]]; then
    printf '%s\n' "$primary"
  elif [[ -e "$legacy" ]]; then
    printf '%s\n' "$legacy"
  else
    printf '%s\n' "$primary"
  fi
}

# ---- the shipped config home ---------------------------------------
#
#   SHIPPED="$(qcr_shipped_config "$ROOT")" || exit 1
#
# The located config when it is one `deploy.sh sync|rebuild` can ship: the file
# exists and its directory — the config home, with the profiles/ beside it —
# lies outside the checkout. Prints NOTHING (status 0) when there is none: no
# config at all, or the legacy checkout config.toml, which deploy never ships
# (it rides no route but the checkout rsync, and the VM reads the shipped home).
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
