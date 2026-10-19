#!/usr/bin/env bash
# The release image's one entrypoint (docker/Dockerfile): mode dispatch.
#
#   docker run <img> [MODE] [ARGS...]
#
#   cli        (default) qcr, daemonless: review, scan, version, ... ARGS go to
#              dist/src/cli.js. A first argument that is not a mode name is a
#              cli argument, so `docker run <img> version --json` works.
#   daemon     the always-on bot: dist/src/wire.js under a tmux server.
#   companion  the pi companion container: a tmux server, kept alive.
#   tui        the operator TUI (dist/src/cli.js tui).
#   login      pi's own /login, typed for the user (scanbox loginInPi).
#   mint       a GitHub App installation token on stdout (scripts/mint-token.sh).
#   install    the host wrapper, pinned to this image (scripts/install-wrapper.sh):
#              `-v ~/.local/bin:/out` writes /out/qcr, otherwise `| sh` installs it.
#   worker     the per-round bot worker (a stub until P8.3).
#
# `install where|migrate` and `companion up|down|status|rebuild` are qcr verbs
# that share a mode's name: with arguments they go to the cli.
#
# What every mode does before it hands over:
#   - asserts config.toml [pi] version == the installed pi package's version,
#     and refuses to start otherwise (the pin lives in four places; this is the
#     one that sees the running image);
#   - makes <root>/state writable-or-fatal (the MutationGate's state/dryrun
#     and every other state file live there).
# No npm build, no state symlink: the image is built, /opt/qcr is read-only to
# every runtime uid, and <root>/state is a world-writable mount point.
#
# bash-guard (extensions/bash-guard.ts) is registered in pi's global settings
# by the daemon mode only (the companion never registered it globally either:
# its guard rides per-spawn argv). D32 drops it from the per-call cli mode,
# which runs in a throwaway container that is the sandbox, and puts the model's
# tools under another uid instead, so the kernel keeps them off the
# token-holding Node process (/proc/<pid>/mem and environ):
#   - started as root (--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add
#     SETGID), the cli mode re-executes this script as QCR_RUN_UID:QCR_RUN_GID
#     (default 1000:1000) with CAP_SETUID/CAP_SETGID as ambient capabilities,
#     and exports QCR_TOOL_UID/QCR_TOOL_GID (QCR_TOOLS_AS, default 65534, and the run gid);
#   - the engine's one pi spawn (src/engine/procruntime.ts toolIsolation) then
#     goes through setpriv: pi and every bash it runs get the tool uid, no
#     capabilities and no_new_privs. The tool uid shares the run gid, which is
#     how it reaches the group-writable state and its own pi home; it is a
#     different uid, so /proc/<node pid>/mem and environ are closed to it;
#   - started as any other uid, no separation is possible: the cli mode says
#     so, exports QCR_TOOL_UID_REQUIRED=1, and the engine then refuses to
#     start pi unless QCR_ALLOW_SHARED_TOOL_UID=1 (version, doctor and every
#     other verb that spawns no pi are unaffected).
# The login and tui modes run no engine and hold no GitHub token: they are
# not separated. pi holds its own OAuth token as the tools' uid, which no
# split hides from the tools it runs; the split protects the GitHub token.
#
# The login volume outlives every uid (P6.7). `login` runs as the caller and
# leaves every entry of pi's agent dir in the fixed login group (QCR_LOGIN_GID,
# default 4747) at 0660/2770 when pi exits; the wrapper gives every call that
# mounts the volume that group (--group-add), and the cli mode keeps it across
# its uid drop (setpriv --groups). A review under another uid reads the login
# through the group; the model's tools, which clear their groups, do not; and
# a later login under yet another uid can still rewrite it.
#
# The daemon is the live bot and keeps the guard, the `examples/subagent`
# check and the reviewer context stub it has always had (the VM's retired
# deploy/ansible/templates/entrypoint.sh.j2 and docker/daemon/entrypoint.sh),
# unchanged until the lens tool replaces the subagent example (P9.4). The VM
# runs this image since the P7.10 cutover: deploy/ansible/playbook.yml.
#
# Every mode that reaches pi needs a writable <root>/state and a writable HOME
# (pi settings are merged under ~/.pi on every cli start, `version` included):
# a read-only rootfs without a state mount and a writable HOME is refused here.
#
# Every line this script prints goes to stderr: a cli mode's stdout is the
# command's (--json), never ours.
set -euo pipefail

APP="${QCR_APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE="$APP/state"

say() { echo "qcr-entrypoint: $*" >&2; }
die() {
  echo "qcr-entrypoint: FATAL: $*" >&2
  exit 1
}

# ---- mode ---------------------------------------------------------------------

# The group that owns the login volume's files (see the header).
LOGIN_GID="${QCR_LOGIN_GID:-4747}"
[[ "$LOGIN_GID" =~ ^[1-9][0-9]*$ ]] || die "QCR_LOGIN_GID must be a non-zero numeric group id ($LOGIN_GID)"

mode=cli
if [ "$#" -gt 0 ]; then
  case "$1" in
    install | mint | cli | daemon | worker | tui | companion | login)
      mode="$1"
      shift
      ;;
  esac
fi
case "$mode" in
  install | companion)
    if [ "$#" -gt 0 ]; then
      set -- "$mode" "$@"
      mode=cli
    fi
    ;;
esac

# ---- D32: the model's tools run as another uid ---------------------------------

# Only the cli mode runs the engine. See the header for the contract; the
# host wrapper (P6.6) owns the docker flags that make the root start possible.
isolate_tools() {
  [ "$mode" = cli ] || return 0
  if [ -n "${QCR_TOOLS_ISOLATED:-}" ]; then
    # Second pass, already the run uid. Group-writable files are how the tool
    # uid (same gid, different uid) shares state and pi's home with this one.
    umask 002
    return 0
  fi
  # Whatever the caller exported, only a split made here counts.
  unset QCR_TOOL_UID QCR_TOOL_GID
  if [ "$(id -u)" != 0 ]; then
    export QCR_TOOL_UID_REQUIRED=1
    return 0
  fi
  local run_uid="${QCR_RUN_UID:-1000}" run_gid="${QCR_RUN_GID:-1000}" tool_uid="${QCR_TOOLS_AS:-65534}"
  [[ "$run_uid$run_gid$tool_uid" =~ ^[0-9]+$ && "$run_uid" != 0 && "$run_gid" != 0 && "$tool_uid" != 0 ]] ||
    die "QCR_RUN_UID/QCR_RUN_GID/QCR_TOOLS_AS must be non-zero numeric ids"
  [ "$run_uid" != "$tool_uid" ] || die "the tool uid must differ from the run uid ($run_uid)"
  command -v setpriv >/dev/null || die "setpriv (util-linux) is needed for the tool uid split"
  export QCR_TOOLS_ISOLATED=1 QCR_TOOL_UID="$tool_uid" QCR_TOOL_GID="$run_gid"
  exec setpriv --reuid="$run_uid" --regid="$run_gid" --groups="$LOGIN_GID" \
    --inh-caps=+setuid,+setgid --ambient-caps=+setuid,+setgid \
    -- "${BASH_SOURCE[0]}" cli "$@"
}

isolate_tools "$@"

# ---- the token handoff (D39) ------------------------------------------------------

# A GitHub token is never env or argv in this image. The caller bind-mounts a
# 0700 dir at /run/qcr-in holding a 0600 file and names it in QCR_GH_TOKEN_FILE;
# src/ghcred.ts reads and unlinks it as the first thing cli.js does, before any
# pi or bash child exists, and drops the variable. This script never reads it.
# What keeps the model's bash off the Node process that then holds the token:
#   - the tools' uid (above) where the split is possible;
#   - Yama kernel.yama.ptrace_scope >= 1, under which a child cannot ptrace-attach
#     to its ancestor (host-wide: 1 on the owner's PC, unknown on Docker Desktop
#     VMs and GitHub runners);
#   - bash-guard's /proc environ/mem/cmdline deny and its program allowlist,
#     where the guard runs.
# --cap-drop ALL and no-new-privileges are hardening, not that block: same-uid
# access to /proc/<ppid>/mem needs no CAP_SYS_PTRACE. So the value is recorded
# at start (QCR_DEBUG=1), for the CI smoke and the macOS checklist to compare.
debug_ptrace_scope() {
  [ "${QCR_DEBUG:-}" = 1 ] || return 0
  say "debug: kernel.yama.ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo absent)"
}

# ---- the pi pin ----------------------------------------------------------------

# shellcheck source=../scripts/install-locator.sh
. "$APP/scripts/install-locator.sh"

# A key of the [pi] table of a config file, unquoted; nothing when absent.
toml_pi() { # toml_pi <file> <key>
  awk -v key="$2" '
    /^\[/ { in_pi = ($0 ~ /^\[pi\][[:space:]]*(#.*)?$/); next }
    in_pi && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]*#.*$/, ""); gsub(/"/, ""); print; exit
    }
  ' "$1"
}

# The version of a pi package directory, or nothing.
pkg_version() { # pkg_version <package dir>
  [ -f "$1/package.json" ] || return 0
  node -p 'require(process.argv[1]).version' "$1/package.json" 2>/dev/null || true
}

# The config the pin is read from: the install locator's (the daemon's own
# config, and the one every session is handed), else the example the image
# bakes, whose pin the build checked. A daemon never falls back: a missing
# config is a mount that was not made, and the boot names it.
PI_VERSION_PINNED=""
PI_PACKAGE_PINNED=""
assert_pi_pin() {
  local cfg ver pkg have example="$APP/config.example.toml"
  cfg="$(qcr_locate_config "$APP")" || exit 1
  if [ ! -f "$cfg" ]; then
    [ "$mode" != daemon ] || die "config not found: $cfg (is the install's config home mounted?)"
    cfg="$example"
  fi
  [ -f "$cfg" ] || die "config not found: $cfg"
  ver="$(toml_pi "$cfg" version)"
  pkg="$(toml_pi "$cfg" package)"
  [ -n "$ver" ] || ver="$(toml_pi "$example" version 2>/dev/null || true)"
  [ -n "$pkg" ] || pkg="$(toml_pi "$example" package 2>/dev/null || true)"
  [ -n "$ver" ] && [ -n "$pkg" ] || die "$cfg has no [pi] package/version and neither has $example"
  [[ "$pkg" =~ ^@?[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$ && "$pkg" != *..* ]] ||
    die "$cfg [pi] package \"$pkg\" is not an npm package name"
  have="$(pkg_version "$APP/node_modules/$pkg")"
  [ -n "$have" ] || die "pi is not installed: no $APP/node_modules/$pkg/package.json"
  [ "$have" = "$ver" ] ||
    die "pi version mismatch: $cfg [pi] version is $ver but $pkg $have is installed — refusing to start (bump config.toml, package.json and the image together)"
  PI_VERSION_PINNED="$ver"
  PI_PACKAGE_PINNED="$pkg"
}

# ---- state ---------------------------------------------------------------------

assert_state_writable() {
  { mkdir -p "$STATE" 2>/dev/null && [ -d "$STATE" ] && [ -w "$STATE" ]; } ||
    die "$STATE is not writable by uid $(id -u) — mount a volume there (the image ships it world-writable)"
}

# ---- pi settings ----------------------------------------------------------------

# Registers pi's global settings under $HOME/.pi/agent. Idempotent MERGE, safe
# on every boot: the file carries keys pi itself and the user wrote. Env knobs:
#   QCR_PI_REQUIRE_EXT   colon-separated extension paths to register; one that
#                        is not on disk is FATAL (a silently unregistered
#                        bash-guard would mean unguarded sessions). Daemon only.
#   QCR_PI_TRUST_DIR     a directory pre-seeded into pi's trust store.
#   QCR_PI_AGENTS_TARGET where $HOME/.pi/agent/agents links (the native
#                        subagent extension's user-scope discovery).
# The extensions that rides per-spawn argv (subagents glue, memory) are NOT
# registered globally: a global entry would arm every lens leaf with fan-out
# (rule 9) or ambient memory work.
provision_pi_settings() {
  node <<'PI_EXT_MERGE'
const fs = require("fs");
const path = require("path");

const file = path.join(process.env.HOME, ".pi", "agent", "settings.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
let settings = {};
if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(settings.extensions)) settings.extensions = [];

const wanted = (process.env.QCR_PI_REQUIRE_EXT || "").split(":").filter(Boolean);
for (const p of wanted) {
  if (!fs.existsSync(p)) {
    console.error("FATAL: pi extension missing: " + p);
    process.exit(1);
  }
  if (!settings.extensions.includes(p)) settings.extensions.push(p);
}
// settings.json lives on a PERSISTENT pihome volume on the bot, so entries
// written by an older image survive a rebuild. Prune anything that is not on
// disk. A `builtin:` override (below) names no file, so it is never "stale".
const isBuiltinEntry = (p) => /^[-+!]?builtin:/.test(p);
const stale = settings.extensions.filter((p) => !isBuiltinEntry(p) && !fs.existsSync(p));
if (stale.length) {
  settings.extensions = settings.extensions.filter((p) => isBuiltinEntry(p) || fs.existsSync(p));
  console.log("pi extensions pruned (not on disk): " + stale.join(", "));
}
// Never block on pi's interactive "Trust project folder?" modal. Belt: trust
// every project by default. Braces: pre-seed the trust store for the app root.
// Third layer: sessions.ts passes --approve on every spawn.
settings.defaultProjectTrust = "always";
// pi 1.0 made the interactive TUI fullscreen by default. Sessions run under
// tmux and the operator TUI mirrors and scrolls their panes, so keep the
// terminal's normal scrollback (pi 0.99's default) — src/pibuiltins.ts PI_TUI_MODE.
settings.tuiMode = "regular";
// pi 0.99's built-in extensions (mcp, codemode, tool-search, llama.cpp) are
// switched OFF, reasons per built-in in src/pibuiltins.ts, the list this
// mirrors. Any other global `builtin:` entry is dropped first, so this list is
// the only word the user settings say about built-ins.
const DISABLED_BUILTINS = ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"];
settings.extensions = settings.extensions.filter((p) => !isBuiltinEntry(p)).concat(DISABLED_BUILTINS);

function atomicJsonWrite(target, value) {
  const tmp = `${target}.tmp-${process.pid}-${require("node:crypto").randomUUID()}`;
  try {
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
    fs.renameSync(tmp, target);
  } finally { fs.rmSync(tmp, { force: true }); }
}
atomicJsonWrite(file, settings);
console.log("pi extensions registered: " + (settings.extensions.join(", ")));

const trustDir = process.env.QCR_PI_TRUST_DIR || "";
if (trustDir) {
  const trustFile = path.join(process.env.HOME, ".pi", "agent", "trust.json");
  let trust = {};
  if (fs.existsSync(trustFile)) trust = JSON.parse(fs.readFileSync(trustFile, "utf8"));
  if (trust[trustDir] !== true) {
    trust[trustDir] = true;
    atomicJsonWrite(trustFile, trust);
  }
  console.log("pi project trust: defaultProjectTrust=always, " + trustDir + " pre-trusted");
}

// Agent discovery for the native subagent extension: its default "user" scope
// reads $HOME/.pi/agent/agents. Symlink-or-absent only: a REAL directory here
// is someone's own agents and is never clobbered — loud log instead.
const agentsTarget = process.env.QCR_PI_AGENTS_TARGET || "";
if (agentsTarget) {
  const agentsLink = path.join(process.env.HOME, ".pi", "agent", "agents");
  try {
    const st = fs.lstatSync(agentsLink, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink()) {
      console.error("WARNING: " + agentsLink + " exists and is not a symlink — NOT touching it; lens agents will not resolve");
    } else {
      if (st) fs.unlinkSync(agentsLink);
      fs.symlinkSync(agentsTarget, agentsLink);
      console.log("pi user agents dir -> " + agentsTarget);
    }
  } catch (e) {
    console.error("WARNING: could not link " + agentsLink + ": " + e.message);
  }
}
PI_EXT_MERGE
}

# pi's own examples/extensions/subagent, in the GLOBAL pi CLI (the one every
# spawn resolves on PATH): a pi release that dropped it fails the boot, not a
# session. The global CLI must also be the pinned version. Daemon and
# companion only - they are the ones that load it.
assert_subagent_example() {
  local groot gpkg
  groot="${QCR_PI_GLOBAL_ROOT:-$(npm root -g)}"
  gpkg="$groot/$PI_PACKAGE_PINNED"
  [ -f "$gpkg/examples/extensions/subagent/index.ts" ] ||
    die "pi $PI_VERSION_PINNED does not ship examples/extensions/subagent ($gpkg)"
  [ "$(pkg_version "$gpkg")" = "$PI_VERSION_PINNED" ] ||
    die "the global pi CLI is $(pkg_version "$gpkg"), not the pinned $PI_VERSION_PINNED"
}

# ---- modes -------------------------------------------------------------------

mode_daemon() {
  # The key a pi OAuth /login does not provide: exported so the tmux server and
  # every pi process inherit it.
  local secrets="${QCR_SECRETS_MOUNT:-/opt/quickreview/secrets}"
  export QCR_SECRETS_MOUNT="$secrets"
  # The code resolves secrets through the install locator: an empty (or
  # old-default) config.toml [github].secrets_dir means <config home>/secrets -
  # point that at the secrets mount. A SET [github] secrets_dir names a host
  # path this container cannot see: QCR_SECRETS_MOUNT answers that instead, for
  # the daemon, every session it spawns and mint-token.sh alike.
  local xdg="${XDG_CONFIG_HOME:-}" secrets_home
  [[ "$xdg" == /* ]] || xdg="$HOME/.config"
  secrets_home="$xdg/qcr/${QCR_INSTALL:-default}/secrets"
  mkdir -p "$(dirname "$secrets_home")"
  [[ -L "$secrets_home" ]] || ln -sfn "$secrets" "$secrets_home"
  if [[ -r "$secrets/openai_api_key" ]]; then
    OPENAI_API_KEY="$(<"$secrets/openai_api_key")"
    export OPENAI_API_KEY
  fi

  assert_subagent_example

  # The global registration: bash-guard ONLY (see provision_pi_settings), a
  # missing file is FATAL.
  QCR_PI_REQUIRE_EXT="$APP/extensions/bash-guard.ts" \
    QCR_PI_TRUST_DIR="$APP" \
    QCR_PI_AGENTS_TARGET="$STATE/agents" \
    provision_pi_settings >&2

  # Private-repo git auth (reviewed-repo clone + per-PR fetches): the app
  # installation token over HTTPS - never a personal credential (rule 3).
  git config --global credential.helper \
    "!f() { echo username=x-access-token; echo \"password=\$(\"$APP/scripts/mint-token.sh\")\"; }; f"

  # Reviewer context: pi loads the FIRST of AGENTS.override.md / AGENTS.md /
  # CLAUDE.md from the cwd into every session and every lens pass, and they all
  # run here - so without the stub the contributor guide would ride every turn.
  # The image bakes it 0444 in $APP (read-only to this uid); a tree that was
  # synced instead gets it installed. Never into a repo checkout: $APP is the
  # image's own tree.
  local stub_src="$APP/deploy/reviewer/AGENTS.override.md" stub="$APP/AGENTS.override.md"
  [ -f "$stub_src" ] || stub_src="$stub"
  if [ -f "$stub_src" ] && ! { cmp -s "$stub_src" "$stub" && [ "$(stat -c %a "$stub")" = 444 ]; }; then
    install -m 0444 "$stub_src" "$stub" ||
      say "WARNING: reviewer context stub not installed - sessions will load the full AGENTS.md"
  elif [ ! -f "$stub_src" ]; then
    say "WARNING: reviewer context stub not found - sessions will load the full AGENTS.md"
  fi

  # tmux server = the jump-in surface. The csi-u lines must exist before the
  # server starts or modified keys (Shift-Enter etc.) collapse before reaching pi.
  [ -f "$APP/docker/vm/tmux.conf" ] || die "$APP/docker/vm/tmux.conf missing"
  cp "$APP/docker/vm/tmux.conf" "$HOME/.tmux.conf"
  tmux start-server
  tmux has-session -t main 2>/dev/null || tmux new-session -d -s main

  exec node "$APP/dist/src/wire.js" "$@"
}

# The companion's pi settings on top of the common merge: its skills, its
# default model, its agent set, the /workspace trust.
provision_companion_settings() {
  node <<'PI_COMPANION_MERGE'
const fs = require("fs");
const path = require("path");
const home = process.env.HOME;
const file = path.join(home, ".pi", "agent", "settings.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
// Skills: the vendored set and our own, each registered only when really
// there. An unmounted /workspace leaves the companion under-equipped, never
// unable to start.
if (!Array.isArray(cfg.skills)) cfg.skills = [];
const skillDirs = ["/workspace/.claude/skills", "/workspace/skills/companion"];
for (const d of skillDirs) {
  if (fs.existsSync(d)) {
    if (!cfg.skills.includes(d)) cfg.skills.push(d);
  } else {
    console.log("!! " + d + " is missing - its skills are not registered.");
  }
}
// `/skill:<name>` from pi's own input line.
cfg.enableSkillCommands = true;
// The configured model ("provider/model[:thinking]") is pi's default on every start.
const defMatch = /^([^/:\s]+)\/([^:\s]+)(?::([a-z]+))?$/.exec(process.env.QCR_PI_DEFAULT_MODEL || "");
if (defMatch) {
  cfg.defaultProvider = defMatch[1];
  cfg.defaultModel = defMatch[2];
  if (defMatch[3]) cfg.defaultThinkingLevel = defMatch[3];
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log("pi skills registered: " + (cfg.skills.join(", ") || "none"));

const trustFile = path.join(home, ".pi", "agent", "trust.json");
let trust = {};
try { trust = JSON.parse(fs.readFileSync(trustFile, "utf8")); } catch {}
if (trust["/workspace"] !== true) {
  trust["/workspace"] = true;
  fs.writeFileSync(trustFile, JSON.stringify(trust, null, 2) + "\n");
}
console.log("pi project trust: /workspace pre-trusted");

// Agent discovery for the native subagent extension: link the user-scope agents
// dir at the companion agent set riding the /workspace mount. Symlink-or-absent
// only: a REAL directory here is someone's own agents and is never clobbered.
const agentsLink = path.join(home, ".pi", "agent", "agents");
const companionAgents = "/workspace/docker/companion/agents";
try {
  const st = fs.lstatSync(agentsLink, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    console.log("!! " + agentsLink + " exists and is not a symlink - NOT touching it; the companion agent set is not discoverable");
  } else {
    if (st) fs.unlinkSync(agentsLink);
    fs.symlinkSync(companionAgents, agentsLink);
    console.log("pi user agents dir -> " + companionAgents);
  }
} catch (e) {
  console.log("!! could not link " + agentsLink + ": " + e.message);
}
PI_COMPANION_MERGE
}

mode_companion() {
  local pi_home="$HOME/.pi"
  mkdir -p "$pi_home/agent" /workspace /tracker /feed /alerts 2>/dev/null || true

  # Durability guard: pi writes its OAuth token, settings and trust store under
  # $HOME/.pi. If that is NOT the mounted volume, every one of them dies with
  # the next recreate. Loud, never fatal. /proc/mounts, not `mountpoint`.
  if ! awk -v d="$pi_home" '$2 == d { found = 1 } END { exit !found }' /proc/mounts 2>/dev/null; then
    say "!! $pi_home is NOT a mount point - pi's OAuth token and settings will NOT survive a container recreate (HOME=$HOME)"
  else
    say "pi home on the volume: $pi_home (OAuth + conversation are durable)"
  fi

  if [ -d /reviewed-repo ] && [ -n "$(ls -A /reviewed-repo 2>/dev/null)" ]; then
    say "reviewed repo mounted READ-ONLY at /reviewed-repo"
  else
    say "!! /reviewed-repo is not mounted - no reviewed-repo source to read."
  fi
  if [ -d /evidence ]; then
    say "round evidence mounted READ-ONLY at /evidence ($(ls -1 /evidence 2>/dev/null | wc -l) PR dirs)"
  else
    say "!! /evidence is not mounted - no finished-round transcripts to read."
  fi
  if [ -s /github-read/github-read.env ]; then
    say "read-only GitHub token file at /github-read/github-read.env"
  else
    say "!! no read-only GitHub token yet - GitHub reads unavailable until the TUI mints one."
  fi

  assert_subagent_example

  # The companion registers no global extension (companion-guard rides per-spawn
  # argv); the common merge and the companion's own keys.
  [ -f "$APP/docker/vm/tmux.conf" ] || die "$APP/docker/vm/tmux.conf missing"
  cp "$APP/docker/vm/tmux.conf" "$HOME/.tmux.conf"
  provision_pi_settings >&2
  provision_companion_settings >&2

  # The companion commits its own work to the mounted repo; git refuses without
  # an identity. `|| true`: an unusable git identity degrades committing, it
  # must never stop the companion from starting.
  git config --global user.name "QCR Companion" || true
  git config --global user.email "companion@quickchat.ai" || true
  git config --global --add safe.directory /workspace || true

  # Memory health watcher: backgrounded and non-fatal by construction.
  local watcher="$APP/docker/companion/memory-health.mjs"
  [ -f "$watcher" ] || watcher=/usr/local/lib/qcr/memory-health.mjs
  if [ -n "${QCR_MEMORY_ENDPOINT:-}${OPENVIKING_URL:-}" ] && [ -f "$watcher" ]; then
    node "$watcher" &
  else
    say "memory watcher idle: no OpenViking endpoint configured for this container"
  fi

  tmux start-server

  # Stay alive, and DIE PROMPTLY when asked: PID 1 has no default signal
  # dispositions, so without a trap `docker stop` waits its full timeout.
  # `sleep &` + `wait`, because a foreground child would block the trap.
  local child
  term() {
    kill "$child" 2>/dev/null || true
    exit 0
  }
  trap term TERM INT
  sleep infinity &
  child=$!
  # `|| true`: a signal makes `wait` return 128+N, which under `set -e` would
  # end the script before the trap's own `exit 0`.
  wait "$child" || true
  exit 0
}

mode_login() {
  # pi itself with `/login` typed and sent for the user: the one script
  # scanbox.ts `loginInPi` builds (it validates the provider name too).
  local script
  script="$(node --input-type=module -e '
    const { loginInPi } = await import(process.argv[1] + "/dist/src/scanbox.js");
    process.stdout.write(loginInPi(process.argv[2] || undefined)[2]);
  ' "$APP" "${1:-}")" || die "login: could not build the pi login command"
  # Not exec: the login is shared with the login group once pi has written it,
  # however the session ended.
  local rc=0
  sh -c "$script" || rc=$?
  share_login
  exit "$rc"
}

# Leave pi's agent dir (the login volume) readable by a later run under any
# uid, and writable by a later login under any uid: the login group, files
# 0660, directories 2770. Best effort per entry - what another uid wrote in an
# earlier login was shared by that login already, and this uid may not own it.
share_login() {
  local dir="$HOME/.pi/agent"
  [ -d "$dir" ] || return 0
  find "$dir" -mindepth 1 ! -group "$LOGIN_GID" -exec chgrp -h "$LOGIN_GID" {} + 2>/dev/null || true
  find "$dir" -mindepth 1 -type d -exec chmod 2770 {} + 2>/dev/null || true
  find "$dir" -mindepth 1 -type f -exec chmod 0660 {} + 2>/dev/null || true
}

# ---- dispatch -----------------------------------------------------------------

assert_pi_pin

case "$mode" in
  install)
    # Stdout is the wrapper's (or the installer `| sh` runs) and nothing else.
    exec "$APP/scripts/install-wrapper.sh"
    ;;
  worker)
    say "worker: the per-round bot worker is not shipped in this image yet (P8.3)"
    exit 64
    ;;
esac

case "$mode" in
  mint)
    # An installation token on stdout and nothing else; touches no state.
    exec "$APP/scripts/mint-token.sh" "$@"
    ;;
esac

assert_state_writable
debug_ptrace_scope

case "$mode" in
  cli)
    QCR_PI_TRUST_DIR="$APP" provision_pi_settings >&2
    # pi's home is read by the tool uid (settings, trust, auth), written by pi.
    [ -z "${QCR_TOOLS_ISOLATED:-}" ] || chmod -R g+rwX "$HOME/.pi" 2>/dev/null || true
    exec node "$APP/dist/src/cli.js" "$@"
    ;;
  tui)
    exec node "$APP/dist/src/cli.js" tui "$@"
    ;;
  login)
    QCR_PI_TRUST_DIR="$APP" provision_pi_settings >&2
    mode_login "$@"
    ;;
  daemon)
    mode_daemon "$@"
    ;;
  companion)
    mode_companion
    ;;
esac
