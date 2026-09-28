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
#   3. the checkout's legacy <root>/config.toml — the expand step's fallback
#   4. nothing anywhere: the config-home path (where a new config belongs)
# `<install>` is $QCR_INSTALL, default `default`, a plain name only.
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

qcr_config_home() {
  local name
  name="$(qcr_install_name)" || return 1
  printf '%s\n' "$(_qcr_xdg_base "${XDG_CONFIG_HOME:-}" .config)/qcr/$name"
}

qcr_state_home() {
  local name
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
