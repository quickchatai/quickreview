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
# Mouse wheel scrolls the pane HISTORY (tmux copy-mode), not pi's prompt list;
# pi /copy propagates via OSC 52 through set-clipboard. Keep in sync with the
# VM entrypoint template.
set -g mouse on
set -g set-clipboard on
set -as terminal-features 'xterm*:clipboard'
set -g history-limit 50000
# Muted look — no bright greens anywhere (operator order, 2026-08-14).
set -g status-style 'bg=colour235,fg=colour247'
set -g status-left-style 'fg=colour250'
set -g status-right-style 'fg=colour244'
set -g window-status-current-style 'fg=colour252,bold'
set -g message-style 'bg=colour235,fg=colour250'
set -g mode-style 'bg=colour238,fg=colour252'
set -g pane-border-style 'fg=colour238'
set -g pane-active-border-style 'fg=colour245'
TMUXCONF

# Extension discovery for pi-memory. ~/.pi lives on a named volume; the merge
# below preserves every existing key (hand edits win, append-only extensions).
# The "extensions" array is VERIFIED live on the VM (2026-08-14: pi-memory,
# pi-subagents and bash-guard all load from it on 0.84.1).
SETTINGS="$PI_HOME_DIR/agent/settings.json"
mkdir -p "$PI_HOME_DIR/agent"
# Idempotent MERGE (mirrors the VM entrypoint): seed-only-if-absent silently
# skipped pi-memory forever once pi itself had written settings.json.
node <<'PI_EXT_MERGE'
const fs = require("fs");
const path = process.env.HOME + "/.pi/agent/settings.json";
let memoryMain = null;
try {
  const globalRoot = require("child_process").execSync("npm root -g").toString().trim();
  memoryMain = require.resolve("pi-memory", { paths: [globalRoot] });
} catch {}
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
if (!Array.isArray(cfg.extensions)) cfg.extensions = [];
if (memoryMain) {
  if (!cfg.extensions.includes(memoryMain)) cfg.extensions.push(memoryMain);
  console.log("pi extensions registered:", cfg.extensions.join(", "));
} else {
  console.error("WARNING: pi-memory not resolvable — companion runs without memory");
}
// Never block on pi's interactive "Trust project folder?" modal (mirrors the
// VM entrypoint; the owner, 2026-08-20 — pr-5334 stall).
cfg.defaultProjectTrust = "always";
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
PI_EXT_MERGE

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
