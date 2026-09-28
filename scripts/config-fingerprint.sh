#!/usr/bin/env bash
# config-fingerprint.sh — the fingerprint of the config home a deploy ships
#, for the deploy tab's "profile changed, not deployed".
#
#   scripts/config-fingerprint.sh --located <checkout-root>
#
# Locates the config exactly as deploy.sh does (scripts/install-locator.sh,
# `qcr_shipped_config`) and prints one line:
#
#   config=<sha256> profiles=<sha256>   the home a sync ships (or shipped)
#   none                                no shippable home: no config, or only
#                                       the legacy checkout config.toml
#
# The TUI runs it twice — here, over the home a sync WOULD ship, and inside the
# VM container (whose QCR_CONFIG names the home a sync DID ship). Read-only.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/install-locator.sh"

if [[ $# -ne 2 || "$1" != "--located" ]]; then
  echo "usage: $(basename "$0") --located <checkout-root>" >&2
  exit 2
fi
SHIPPED="$(qcr_shipped_config "$2")" || exit 1
if [[ -z "$SHIPPED" ]]; then
  echo none
  exit 0
fi
qcr_config_fingerprint "$SHIPPED"
