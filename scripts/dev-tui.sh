#!/usr/bin/env bash
# qcr tui in reload mode, from one command and one terminal.
#
# The TUI's hot reload (src/tui/reload.ts) watches `dist/` and NEVER builds —
# so without a compiler running, editing `src/` changes nothing on screen. This
# script owns both halves: a `tsc --watch` in the background and the TUI in the
# foreground, in one process group that dies together.
#
# Two things make it safe to run a compiler under a full-screen TUI:
#   1. tsc's output goes to a LOG, never the terminal. A stray compiler line
#      painted into the alt screen corrupts the frame — it does not scroll, it
#      overwrites, and the border never comes back until the next full repaint.
#   2. A blocking build runs FIRST. `tsc --watch` emits its initial build a
#      second or two in, which the dist-watcher would see as a change and
#      re-exec the TUI the moment it finished starting.
#
# That blocking build STAYS (ruling 5) — it is the only thing stopping
# the re-exec above — but it is INCREMENTAL now (`incremental` +
# `tsBuildInfoFile` in tsconfig.json). Measured on this repo: cold 3.6-5.6s of
# blank terminal on every `npm run dev`, warm 1.2-1.6s. Nothing about what is
# checked changed, and an up-to-date tree makes the watcher's first pass emit
# nothing at all, so it cannot trigger a reload either.
#
# The buildinfo lives OUTSIDE dist/ (node_modules/.cache/) on purpose: tsc
# writes it even when the compile fails, and dist/ is watched recursively and
# unfiltered — inside it, a FAILING build would re-exec the TUI, which is the
# opposite of what reload.ts guarantees.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
LOG="$ROOT/state/tsc-watch.log"
mkdir -p "$ROOT/state"

echo "qcr dev: building…" >&2
if ! (cd "$ROOT" && npx tsc -p tsconfig.json); then
  echo "qcr dev: build failed — fix the errors above, then run again." >&2
  exit 1
fi
# "tsc exited 0" is not "dist/ is complete". `incremental` emits from the build
# info, not from what is on disk, so a file deleted after the last successful
# build is never re-emitted and the compiler still reports success — the TUI
# would then die on ERR_MODULE_NOT_FOUND a second after this line.
if ! (cd "$ROOT" && node scripts/verify-dist.mjs); then
  echo "qcr dev: refusing to start the TUI from an incomplete dist/." >&2
  exit 1
fi

# --preserveWatchOutput: without it tsc clears the screen on every rebuild,
# and that clear lands on the TUI even with stdout redirected (it is an escape
# sequence written to the tty tsc inherited, not to the log).
(cd "$ROOT" && exec npx tsc -p tsconfig.json --watch --preserveWatchOutput) >"$LOG" 2>&1 &
WATCH_PID=$!

# The compiler must not outlive the TUI — an orphaned watcher keeps rebuilding
# into a dist nobody is watching, and the next run would start a second one.
cleanup() {
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "qcr dev: watching src/ → dist/ (compiler log: ${LOG/#$HOME/\~})" >&2
echo "qcr dev: edit anything under src/ and the TUI re-execs itself." >&2

# Foreground, sharing this terminal. The TUI re-execs ITSELF on a dist change
# (spawnSync, stdio inherited), so this call does not return until the whole
# chain of re-execs is done — and only then does cleanup run.
node "$ROOT/dist/src/cli.js" tui "$@"
