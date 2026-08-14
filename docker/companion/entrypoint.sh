#!/usr/bin/env bash
# Companion container entrypoint. PID 1 owns exactly two jobs:
# start a correctly-configured tmux server and then stay alive. pi itself is
# spawned by the TUI through `docker exec` (src/tui/companion.ts), the same
# adopt-don't-kill shape the VM sessions use — so a pi crash never takes the
# container (and the conversation volume) with it.
set -euo pipefail

PI_HOME_DIR="${HOME}/.pi"
mkdir -p "$PI_HOME_DIR/agent" /workspace /tracker /feed /alerts 2>/dev/null || true

# csi-u extended keys must be configured BEFORE the server starts, or modified
# Enter (Shift/Alt/Ctrl) collapses to plain Enter before reaching pi and the
# TUI's steer/queue keys die. Requires tmux ≥3.5 (built from source in the
# image). Same three lines as the VM entrypoint — keep them in sync.
cat > "$HOME/.tmux.conf" <<'TMUXCONF'
# csi-u extended keys end-to-end (§3E /) — do not remove.
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features 'xterm*:extkeys'
TMUXCONF

# Extension discovery for pi-memory. Seeded only when absent: ~/.pi lives on a
# named volume, so a hand-edited settings.json survives restarts and wins.
# VERIFY-ON-PIN: the "extensions" array key and that a global npm package path
# is an acceptable entry (§5 documents discovery dirs + a settings.json
# array; nothing in this repo has exercised either against 0.84.1).
SETTINGS="$PI_HOME_DIR/agent/settings.json"
if [[ ! -f "$SETTINGS" ]]; then
  memory_main="$(node -e 'try{process.stdout.write(require.resolve("pi-memory"))}catch{}' 2>/dev/null || true)"
  if [[ -n "$memory_main" ]]; then
    printf '{\n  "extensions": ["%s"]\n}\n' "$memory_main" > "$SETTINGS"
  fi
fi

# OpenAI auth: the OAuth route (`/login` once inside a pi session) persists in
# $PI_HOME_DIR/agent/auth.json on the volume and takes precedence over the env
# var. OPENAI_API_KEY is honored when the caller passes one.
# Provider prefix under OAuth is `openai-codex/`, not `openai/`.

# The tmux server is the jump-in surface: `docker exec -it <c> tmux attach -t
# companion`. Panes inherit the SERVER's env, not the client's — per-session
# QCR_* vars ride the pi command line (see spawnPi in src/tui/companion.ts).
tmux start-server

# Stay alive. `docker stop` (the TUI's graceful quit path) delivers SIGTERM;
# exec'ing sleep means PID 1 handles it without a signal-forwarding shim.
exec sleep infinity
