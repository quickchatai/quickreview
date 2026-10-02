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

# Reviewed-repo mount. The reviewed repo's source arrives READ-ONLY
# at /reviewed-repo (a generic path since — it used to be named after
# one repo) so the companion can read the code a review is about. It is
# conditional by design (src/tui/companion.ts runArgv): a host without the
# checkout gets no mount, and that must leave the companion under-equipped
# rather than unable to start — same degrade discipline as the skills dir and
# the vendored extension. Never `mkdir` it as a fallback: an empty tree reads
# as "the code says nothing", which is worse than a plainly absent mount.
if [ -d /reviewed-repo ] && [ -n "$(ls -A /reviewed-repo 2>/dev/null)" ]; then
  echo "reviewed repo mounted READ-ONLY at /reviewed-repo (read it; you can never write it)"
else
  echo "!! /reviewed-repo is not mounted — no reviewed-repo source to read."
  echo "!! Set [companion] reviewed_repo_dir to the reviewed repo's checkout on this host."
fi

# Evidence store. Finished-round artefacts the TUI copied down from
# the VM arrive READ-ONLY at /evidence. Say which world this boot is in: an
# empty store (no rounds copied yet) and an absent mount look identical from
# inside the conversation, and only one of them is a misconfiguration.
if [ -d /evidence ]; then
  echo "round evidence mounted READ-ONLY at /evidence ($(ls -1 /evidence 2>/dev/null | wc -l) PR dirs)"
else
  echo "!! /evidence is not mounted — no finished-round transcripts to read."
  echo "!! Set [companion] evidence_dir and restart the TUI (qcr companion rebuild not needed)."
fi

# Read-only GitHub token. The TUI mints it on the host and re-mints
# it into /github-read before it expires; only the file's PRESENCE is echoed,
# never a value. Absent = the TUI has no App credential or is not running.
if [ -s /github-read/github-read.env ]; then
  echo "read-only GitHub token file at /github-read/github-read.env (source it; it cannot write)"
else
  echo "!! no read-only GitHub token yet — GitHub reads unavailable until the TUI mints one."
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
// pi 1.0 made the interactive TUI fullscreen by default. Sessions run under
// tmux and the operator TUI mirrors and scrolls their panes, so keep the
// terminal's normal scrollback (pi 0.99's default) — src/pibuiltins.ts PI_TUI_MODE.
cfg.tuiMode = "regular";
// pi 0.99's built-in extensions (mcp, codemode, tool-search, llama.cpp) are
// switched OFF, as on the VM: MCP launches server processes from any trusted
// mcp.json — a path around companion-guard, which vetoes TOOL CALLS — and the
// other three change the tool/provider set (reasons per built-in:
// src/pibuiltins.ts, the list this mirrors). Documented switch: a
// `-builtin:<name>` entry in the global `extensions`. This one key overrides
// "hand edits win": any other global `builtin:` entry is dropped first.
const DISABLED_BUILTINS = ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"];
cfg.extensions = cfg.extensions.filter((p) => !/^[-+!]?builtin:/.test(p)).concat(DISABLED_BUILTINS);

// Skills (2026-08-21). The repo carries the vendored mattpocock set at
// /workspace/.claude/skills/ — wayfinder, grilling, domain-modeling and 22
// more. pi supports SKILL.md natively, but `.claude/skills` is NOT one of the
// paths it looks in on its own (~/.pi/agent/skills, ~/.agents/skills,
// .pi/skills and .agents/skills in cwd+ancestors, package skills/ dirs). Until
// this registration they were plain files the system prompt had to name by
// hand, one at a time, with no progressive disclosure: the companion could
// only use a skill it had already been told existed.
//
// The settings `skills` array is pi's documented interop hook for exactly this
// — the docs' own example is ["~/.claude/skills", "~/.codex/skills"]
//. VERIFY-ON-PIN: array-of-directories form, and that a
// registered dir is scanned one level deep for <name>/SKILL.md.
//
// COMPANION ONLY — deliberately not mirrored into the VM entrypoint. Reviewer
// lens passes are leaves (rule 9) and a charting/planning skill set is nothing
// a lens should be able to reach for mid-round.
//
// Registered only when the dir is really there: an unmounted /workspace must
// leave the companion under-equipped, never unable to start. Same degrade
// discipline as the vendored OpenViking extension in piArgv.
const skillsDir = "/workspace/.claude/skills";
if (!Array.isArray(cfg.skills)) cfg.skills = [];
const skillsPresent = fs.existsSync(skillsDir);
if (skillsPresent && !cfg.skills.includes(skillsDir)) cfg.skills.push(skillsDir);

// OUR OWN skills, a SECOND registered directory. `.claude/skills` is
// a pinned vendored copy (see .claude/skills/VENDORED.md — it is re-copied
// wholesale on an upstream bump), so a companion skill we author cannot live
// there: the next vendor pass would either clobber it or make the folder no
// longer a clean mirror. It gets its own tree at /workspace/skills/companion/,
// scanned one level deep for <name>/SKILL.md exactly like the vendored one —
// which is why this is a second ARRAY ENTRY and not a merged parent dir.
// Guarded independently and the same way: a missing dir leaves the companion
// under-equipped (it keeps the vendored set), never unable to start.
const ourSkillsDir = "/workspace/skills/companion";
const ourSkillsPresent = fs.existsSync(ourSkillsDir);
if (ourSkillsPresent && !cfg.skills.includes(ourSkillsDir)) cfg.skills.push(ourSkillsDir);
// `/skill:<name>` from pi's own input line. The embedded companion column is a
// TERMINAL (rule: every byte goes to pi), so the owner's `/` commands reach pi
// directly — this is what makes the set invocable by hand as well as by the
// model. Set unconditionally, like defaultProjectTrust: seed-only-if-absent is
// how keys silently stopped landing once pi had written settings.json itself.
cfg.enableSkillCommands = true;

fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
console.log("pi settings merged (extensions: " + (cfg.extensions.join(", ") || "none registered globally") + ")");
console.log(
  cfg.skills.length
    ? "pi skills registered: " + cfg.skills.join(", ") + " (/skill:<name> enabled)"
    : "!! no skills registered. Is /workspace mounted?",
);
// Each missing dir says so on its own line: the two degrade independently, and
// "the vendored set is there" must never read as "adjudicate is there".
if (!skillsPresent) console.log("!! " + skillsDir + " is missing — the vendored skill set is not registered.");
if (!ourSkillsPresent) console.log("!! " + ourSkillsDir + " is missing — our own skills (adjudicate) are not registered.");

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

// agent discovery for the native subagent extension (loaded by the
// first-party glue extensions/subagents.ts — the vendored pi-subagents is
// removed). The native default "user" scope reads $HOME/.pi/agent/agents;
// link that at the companion agent set (explore/evidence/study) riding the
// /workspace mount. Same degrade discipline as the skills dirs: a missing
// /workspace leaves the link dangling and discovery simply finds no agents —
// an under-equipped companion, never one that won't start. Symlink-or-absent
// only: a REAL directory here is someone's own agents and is never clobbered.
const agentsLink = process.env.HOME + "/.pi/agent/agents";
const companionAgents = "/workspace/docker/companion/agents";
try {
  const st = fs.lstatSync(agentsLink, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    console.log("!! " + agentsLink + " exists and is not a symlink — NOT touching it; the companion agent set is not discoverable");
  } else {
    if (st) fs.unlinkSync(agentsLink);
    fs.symlinkSync(companionAgents, agentsLink);
    console.log("pi user agents dir -> " + companionAgents);
  }
} catch (e) {
  console.log("!! could not link " + agentsLink + ": " + e.message);
}
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
