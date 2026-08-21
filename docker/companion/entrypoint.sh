#!/usr/bin/env bash
# Companion container entrypoint. PID 1 owns exactly two jobs:
# start a correctly-configured tmux server and then stay alive. pi itself is
# spawned by the TUI through `docker exec` (src/tui/companion.ts), the same
# adopt-don't-kill shape the VM sessions use — so a pi crash never takes the
# container (and the conversation volume) with it.
set -euo pipefail

PI_HOME_DIR="${HOME}/.pi"
mkdir -p "$PI_HOME_DIR/agent" /workspace /tracker /feed /alerts 2>/dev/null || true

# Durability guard. pi writes its OAuth token, settings and trust
# store under $HOME/.pi. If that is NOT the mounted volume, every one of them
# lives on the container's writable layer and dies with the next recreate — the
# login silently stops persisting, and nobody finds out until they are asked to
# log in again. That is exactly what a uid collision did here for a week.
# Loud, never fatal: a companion that starts is worth more than one that is
# right, and the operator can see this line.
# /proc/mounts, not `mountpoint`: util-linux is not guaranteed in the base
# image, and a guard that reports a false alarm when its own tool is missing
# teaches you to ignore it.
if ! awk -v d="$PI_HOME_DIR" '$2 == d { found = 1 } END { exit !found }' /proc/mounts; then
  echo "!! $PI_HOME_DIR is NOT a mount point — pi's OAuth token and settings will"
  echo "!! NOT survive a container recreate. Expected the companion-pihome volume"
  echo "!! here. HOME=$HOME; check the Dockerfile's ENV HOME against"
  echo "!! CONTAINER.piHome in src/tui/companion.ts."
else
  echo "pi home on the volume: $PI_HOME_DIR (OAuth + conversation are durable)"
fi

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

# Git identity. The companion commits its own work to the mounted
# repo with a `[companion]` prefix, and git refuses to commit at all without an
# identity ("Please tell me who you are"). ~/.gitconfig lives on the container's
# writable layer, NOT the pihome volume, so it is rewritten every start rather
# than seeded once. Author, not committer-of-record for anyone else: the name
# says plainly which hands made the commit.
# `|| true` on every one: `set -e` is on, and a git that exits
# non-zero here would take the CONTAINER down at boot. That is not theoretical
# — mounting a git WORKTREE at /workspace does it, because its `.git` is a file
# pointing at a path that does not exist inside the container, and git fails
# while discovering the repo. An unusable git identity degrades the companion's
# committing; it must never stop the companion from starting.
git config --global user.name "QCR Companion" || true
git config --global user.email "companion@quickchat.ai" || true
# The repo is bind-mounted from the host and owned by the same uid, so
# safe.directory is not needed — but a uid mismatch (a rebuilt image with a
# different COMPANION_UID) would otherwise wedge every git call with a
# confusing ownership error rather than a permission one.
git config --global --add safe.directory /workspace || true

# pi settings. ~/.pi lives on a named volume; the merge below preserves every
# existing key (hand edits win, append-only extensions).
#
# NO MEMORY EXTENSION IS REGISTERED HERE. pi-memory retired with the
# hand-rolled engine; the companion's memory is OpenViking on the VM, and its
# vendored+patched extension is passed per spawn with `--extension` by
# src/tui/companion.ts — a per-spawn flag, not a global registration.
SETTINGS="$PI_HOME_DIR/agent/settings.json"
mkdir -p "$PI_HOME_DIR/agent"
# Idempotent MERGE (mirrors the VM entrypoint): seed-only-if-absent silently
# skipped keys forever once pi itself had written settings.json.
node <<'PI_EXT_MERGE'
const fs = require("fs");
const path = process.env.HOME + "/.pi/agent/settings.json";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
if (!Array.isArray(cfg.extensions)) cfg.extensions = [];
// Never block on pi's interactive "Trust project folder?" modal (mirrors the
// VM entrypoint; the owner, 2026-08-20 — pr-5334 stall).
cfg.defaultProjectTrust = "always";
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
console.log("pi settings merged (extensions: " + (cfg.extensions.join(", ") || "none registered globally") + ")");

// Braces to that belt (mirrors the VM entrypoint): pre-seed the trust store
// for the workspace, so even a settings regression — or a pihome volume
// carrying an older settings.json — cannot re-surface the modal. The third
// layer is `--approve` on the spawn itself (src/tui/companion.ts piArgv).
// /workspace, not /opt/quickreview: that is where the repo is mounted here.
const trustFile = process.env.HOME + "/.pi/agent/trust.json";
let trust = {};
try { trust = JSON.parse(fs.readFileSync(trustFile, "utf8")); } catch {}
if (trust["/workspace"] !== true) {
  trust["/workspace"] = true;
  fs.writeFileSync(trustFile, JSON.stringify(trust, null, 2) + "\n");
}
console.log("pi project trust: defaultProjectTrust=always, /workspace pre-trusted");
PI_EXT_MERGE

# OpenAI auth: the OAuth route (`/login` once inside a pi session) persists in
# $PI_HOME_DIR/agent/auth.json on the volume and takes precedence over the env
# var. OPENAI_API_KEY is honored when the caller passes one.
# Provider prefix under OAuth is `openai-codex/`, not `openai/`.

# memory health watcher: probes OpenViking through the host-owned
# forward and drops an alert file into /alerts when it stops answering (and a
# notice when it comes back). Backgrounded and non-fatal by construction — an
# unwired or unreachable memory path degrades the companion, it never wedges
# it. With no QCR_MEMORY_ENDPOINT in the env the watcher exits immediately.
if [ -n "${QCR_MEMORY_ENDPOINT:-}${OPENVIKING_URL:-}" ] && [ -f /usr/local/lib/qcr/memory-health.mjs ]; then
  node /usr/local/lib/qcr/memory-health.mjs &
else
  echo "memory watcher idle: no OpenViking endpoint configured for this container"
fi

# The tmux server is the jump-in surface: `docker exec -it <c> tmux attach -t
# companion`. Panes inherit the SERVER's env, not the client's — per-session
# QCR_* vars ride the pi command line (see spawnPi in src/tui/companion.ts).
tmux start-server

# Stay alive, and DIE PROMPTLY when asked.
#
# This used to `exec sleep infinity`, on the theory that PID 1 would handle
# SIGTERM without a forwarding shim. It does not: PID 1 has no default signal
# dispositions, so a signal with no explicit handler is ignored outright.
# `docker stop` therefore waited its full 10s timeout and then SIGKILLed —
# measured at 10.1s, every single quit. The TUI runs that stop AFTER restoring
# the terminal, so those 10 seconds were a dead terminal: the board gone, the
# shell prompt not yet back, nothing responding.
#
# A trap gives PID 1 the handler it never had. `sleep &` + `wait` rather than
# `exec`, because a foreground child would block the trap until it returned.
term() {
  kill "$child" 2>/dev/null || true
  exit 0
}
trap term TERM INT
sleep infinity &
child=$!
# `|| true`: a signal makes `wait` return 128+N, and under `set -e` that status
# would end the script before the trap's own `exit 0` — the container then
# recorded "Exited (128)" on every clean stop, which reads like a crash in
# `docker ps -a` and is the first thing anyone debugging this would chase.
wait "$child" || true
exit 0
