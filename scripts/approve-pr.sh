#!/usr/bin/env bash
# approve-pr.sh — approve a PR (the daemon clears the wake triggers).
#
# A thin client of the daemon's post endpoint (src/ipc/postshim.ts). The host
# a session runs on holds no GitHub credential and no config: the daemon
# builds the payload, runs the posting-time guards and posts through the one
# MutationGate with the install's dry_run. This script keeps its seeded name
# and arguments and does nothing else; without the worker socket and the
# capability fd in env the client refuses.
#
# Usage: approve-pr.sh <pr-number> [review-body-file] [comments-json-file]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/dist/src/ipc/postshim.js" approval "$@"
