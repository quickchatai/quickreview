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
# bash-guard (extensions/cli/bash-guard.ts) is no longer registered in pi's global
# settings (P9.5): every lens and worker session gets it from the factory, and
# the takeover and debug pi load it by path. D32's per-call cli mode runs in a
# throwaway container that is the sandbox, and puts the model's
# tools under another uid, so the kernel keeps them off the
# token-holding Node process (/proc/<pid>/mem and environ):
#   - started as root (--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add
#     SETGID), the cli mode re-executes this script as QCR_RUN_UID:QCR_RUN_GID
#     (default 1000:1000) with CAP_SETUID/CAP_SETGID as ambient capabilities,
#     and exports QCR_TOOL_UID/QCR_TOOL_GID (QCR_TOOLS_AS, default 65534, and the run gid);
#   - the engine then runs everything that executes the model's commands
#     through setpriv (src/engine/tooluid.ts): the SDK session's bash tool
#     (src/engine/pisdk.ts), a pi child (toolIsolation), a debug round's
#     interactive pi (src/engine/debugpi.ts). They get the tool uid, no
#     capabilities and no_new_privs. The SDK session's file tools (read, grep,
#     find, ls, edit, write) run in the engine's own uid, so they are fenced off
#     /proc, /run/qcr-in and the agent dir (src/engine/toolfence.ts). The tool
#     uid shares the run gid, which is how it reaches the group-writable state;
#     it is a different uid, so /proc/<node pid>/mem and environ are closed to it;
#   - started as any other uid, no separation is possible: the cli mode says
#     so, exports QCR_TOOL_UID_REQUIRED=1, and the engine then refuses to
#     run the model's tools unless QCR_ALLOW_SHARED_TOOL_UID=1 (version, doctor
#     and every other verb that runs none are unaffected).
# The daemon mode (the always-on bot) makes the same split from a
# NON-root start, so `docker exec` into the bot keeps landing as its uid: the
# image's setid helper (/usr/local/libexec/qcr/qcr-setid, file capabilities, gate
# group QCR_SETID_GID) is probed, and the daemon exports QCR_TOOL_UID (QCR_TOOLS_AS,
# default 65534), QCR_TOOL_GID (its own gid) and QCR_SETPRIV_BIN; its workers run
# every model command through the helper (src/engine/tooluid.ts setidHelperOf).
# A probe that fails refuses the start (QCR_ALLOW_SHARED_TOOL_UID=1 accepts the
# shared uid). Started as root instead, the daemon drops to QCR_RUN_UID the way
# the cli mode does. Either way the daemon opens the directories the model's
# scripts write to its group (share_tool_dirs) and nothing else: the secrets
# mount and pi's login stay unreadable to the tool uid.
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
# The daemon is the live bot and keeps the guard, the pinned-CLI check and the
# reviewer context stub it has always had (the VM's retired
# deploy/ansible/templates/entrypoint.sh.j2).
# The VM runs this image since the P7.10 cutover: deploy/ansible/playbook.yml.
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

# The cli mode and the daemon mode run the engine (`daemon --preflight` reads
# mounts and runs none). See the header for the contract; the host wrapper
# (P6.6) owns the docker flags that make the cli's root start possible, and the
# VM's updater (deploy/qcr-update.sh) the daemon's.
isolate_tools() {
  case "$mode" in
    cli) ;;
    daemon) [ "${1:-}" != --preflight ] || return 0 ;;
    *) return 0 ;;
  esac
  if [ -n "${QCR_TOOLS_ISOLATED:-}" ]; then
    # Second pass, already the run uid. Group-writable files are how the tool
    # uid (same gid, different uid) shares state and pi's home with this one.
    # The daemon keeps its umask: its workers set the group-writable one for
    # what the model's tools share (src/botworker.ts), and what the daemon
    # writes for a session to read stays its own.
    [ "$mode" != cli ] || umask 002
    return 0
  fi
  # Whatever the caller exported, only a split made here counts.
  unset QCR_TOOL_UID QCR_TOOL_GID QCR_SETPRIV_BIN
  if [ "$(id -u)" != 0 ]; then
    if [ "$mode" = daemon ]; then
      daemon_setid_helper
      return 0
    fi
    export QCR_TOOL_UID_REQUIRED=1
    return 0
  fi
  local run_uid="${QCR_RUN_UID:-1000}" run_gid="${QCR_RUN_GID:-1000}" tool_uid="${QCR_TOOLS_AS:-65534}"
  [[ "$run_uid$run_gid$tool_uid" =~ ^[0-9]+$ && "$run_uid" != 0 && "$run_gid" != 0 && "$tool_uid" != 0 ]] ||
    die "QCR_RUN_UID/QCR_RUN_GID/QCR_TOOLS_AS must be non-zero numeric ids"
  [ "$run_uid" != "$tool_uid" ] || die "the tool uid must differ from the run uid ($run_uid)"
  command -v setpriv >/dev/null || die "setpriv (util-linux) is needed for the tool uid split"
  export QCR_TOOLS_ISOLATED=1 QCR_TOOL_UID="$tool_uid" QCR_TOOL_GID="$run_gid"
  # The cli keeps the login group (the login volume); the daemon runs as a
  # plain uid, as it does when docker starts it as one.
  local groups="--groups=$LOGIN_GID"
  [ "$mode" = cli ] || groups="--clear-groups"
  exec setpriv --reuid="$run_uid" --regid="$run_gid" "$groups" \
    --inh-caps=+setuid,+setgid --ambient-caps=+setuid,+setgid \
    -- "${BASH_SOURCE[0]}" "$mode" "$@"
}

# The always-on bot. It runs as its own uid, not root, so every
# `docker exec` into it (the TUI's reads and messages, `tmux` for a takeover's
# pane, `qcr` in the container) keeps landing as that uid, and docker cannot
# give a non-root uid ambient capabilities. Its way to the tool uid is the
# image's setid helper (docker/Dockerfile): a copy of setpriv carrying
# CAP_SETUID/CAP_SETGID as file capabilities, runnable only by the gate group
# (QCR_SETID_GID, 4748), which the run spec gives the bot with --group-add. The
# model's tools run with no_new_privs and without that group, so the helper is
# nothing to them. The probe below proves the helper works here (it switches to
# the tool uid and runs `true`); where it does not, the bot refuses to start
# rather than run the model's tools in the uid that reads secrets/, unless
# QCR_ALLOW_SHARED_TOOL_UID=1 accepts that.
SETID_HELPER="${QCR_SETID_HELPER:-/usr/local/libexec/qcr/qcr-setid}"
daemon_setid_helper() {
  local tool_uid="${QCR_TOOLS_AS:-${QCR_IMAGE_TOOL_UID:-65534}}" tool_gid="${QCR_IMAGE_TOOL_GID:-}" uid
  uid="$(id -u)"
  [[ "$tool_uid" =~ ^[1-9][0-9]*$ ]] || die "QCR_TOOLS_AS must be a non-zero numeric id ($tool_uid)"
  [ "$tool_uid" != "$uid" ] || die "the tool uid must differ from the daemon's uid ($uid)"
  if [[ "$tool_gid" =~ ^[1-9][0-9]*$ ]] && [ -x "$SETID_HELPER" ] &&
    "$SETID_HELPER" --reuid="$tool_uid" --regid="$tool_gid" --clear-groups \
      --inh-caps=-all --ambient-caps=-all --no-new-privs -- true 2>/dev/null; then
    # The daemon shares the directories the model's scripts write through the
    # tool's own group, so it must be a member of it (the run spec's second
    # --group-add); a daemon outside it could not read what the tools write.
    id -G | tr ' ' '\n' | grep -qx "$tool_gid" ||
      die "the daemon (uid $uid) is not in the tool gid $tool_gid: start it with --group-add $tool_gid (re-run provision)"
    export QCR_TOOL_UID="$tool_uid" QCR_TOOL_GID="$tool_gid" QCR_SETPRIV_BIN="$SETID_HELPER"
    say "the model's tools run as uid $tool_uid gid $tool_gid through $SETID_HELPER; the daemon keeps uid $uid"
    return 0
  fi
  if [ "${QCR_ALLOW_SHARED_TOOL_UID-}" = 1 ]; then
    say "WARNING: the model's tools run as the daemon's own uid $uid, which reads the secrets mount (QCR_ALLOW_SHARED_TOOL_UID is 1)"
    return 0
  fi
  die "the model's tools cannot run as another uid: $SETID_HELPER is not runnable by uid $uid or cannot switch to $tool_uid:${tool_gid:-?} here (it switches to the image's tool identity only). Start the bot with --group-add ${QCR_SETID_GID:-4748} (the helper's gate group) and without no-new-privileges, or as root (--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID -e QCR_RUN_UID -e QCR_RUN_GID); setting QCR_ALLOW_SHARED_TOOL_UID to 1 accepts the shared uid"
}

# What the model's tools write through the sanctioned scripts, as the tool uid:
# the round's rendered review (render-review.sh, state/), a findings record, the
# verdicts (commit-verdict.sh), the ledgers a debug round's pi pins, the
# session commands. Those directories, and only those, are handed to the tool's
# own gid, setgid so every entry made in them stays in that group (the daemon
# reads what the tools write, the tools what the daemon leaves there for them).
# state/ and commands/ are also sticky: the tool uid may add entries but never
# rename or remove one it does not own (state.db, the IPC run dir, the built
# agents, status.json, the root-owned commands/operator seal). verdict/ is not:
# commit-verdict.sh, run as the tool uid, publishes by renaming the file the
# session's own write tool staged as the daemon's uid. The rest of the tree,
# secrets/ and pi's login stay out of the tool's group.
share_tool_dirs() {
  [ -n "${QCR_TOOL_UID:-}" ] || return 0
  local d gid="${QCR_TOOL_GID}"
  for d in "$STATE" "$STATE/findings" "$STATE/ledgers" "$APP/verdict" "$APP/commands"; do
    { mkdir -p "$d" && chgrp "$gid" "$d" && chmod g+rwxs "$d"; } 2>/dev/null ||
      say "WARNING: $d could not be opened to the tool gid $gid: the model's scripts cannot write there"
  done
  for d in "$STATE" "$APP/commands"; do
    chmod +t "$d" 2>/dev/null || say "WARNING: $d could not be made sticky: the tool uid could rename the daemon's entries in it"
  done
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
#   QCR_PI_TRUST_DIR     a directory pre-seeded into pi's trust store.
#   QCR_PI_AGENTS_TARGET where $HOME/.pi/agent/agents links (the lens tool's
#                        agent discovery, <agent dir>/agents).
# No extension is registered globally (P9.5): bash-guard rides every lens and
# worker session as a factory, and the takeover and debug pi load it by path.
# A global entry would arm every lens leaf with ambient extension work.
provision_pi_settings() {
  node <<'PI_EXT_MERGE'
const fs = require("fs");
const path = require("path");

const file = path.join(process.env.HOME, ".pi", "agent", "settings.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
let settings = {};
if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(settings.extensions)) settings.extensions = [];

// bash-guard is no longer a global registration. The pihome volume still
// carries the entry an older image merged, and a global entry would load the
// guard a second time beside the factory's, so it is dropped here.
const retiredGuard = (p) => /(^|[\\/])extensions[\\/](cli[\\/])?bash-guard\.ts$/.test(p);
const retired = settings.extensions.filter(retiredGuard);
if (retired.length) {
  settings.extensions = settings.extensions.filter((p) => !retiredGuard(p));
  console.log("pi extensions pruned (bash-guard is no longer global): " + retired.join(", "));
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

// Agent discovery for the lens tool: its agent dir's `agents` is
// $HOME/.pi/agent/agents. Symlink-or-absent only: a REAL directory here
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

# ---- modes -------------------------------------------------------------------

mode_daemon() {
  # `daemon --preflight` (P8.4b): the updater's check on a scratch copy, run with
  # --network none. It starts nothing (no tmux, no git config, no pi settings):
  # it reads the mounts and prints one JSON report.
  if [ "${1:-}" = "--preflight" ]; then
    exec node "$APP/dist/src/preflight.js"
  fi
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

  share_tool_dirs

  # No global extension registration (P9.5, see provision_pi_settings).
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
# default model, its agent set, the /workspace trust. The agent set is the
# image's (QCR_COMPANION_AGENTS, default $APP/docker/companion/agents): the
# companion runs the image's code (D20), not the checkout's.
provision_companion_settings() {
  QCR_COMPANION_AGENTS="${QCR_COMPANION_AGENTS:-$APP/docker/companion/agents}" node <<'PI_COMPANION_MERGE'
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

// Agent discovery for the lens tool (extensions/lens.ts reads the agents dir
// under pi's agent dir): link it at the companion agent set in the image.
// Symlink-or-absent only: a REAL directory here is someone's own agents and is
// never clobbered.
const agentsLink = path.join(home, ".pi", "agent", "agents");
const companionAgents = process.env.QCR_COMPANION_AGENTS;
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
  # Full ssh to the VM (rule 8): the agent socket and the ssh config are
  # mounted read-only; ssh needs a passwd entry for this uid to use them.
  if [ -n "${SSH_AUTH_SOCK:-}" ]; then
    tui_identity
    say "ssh agent mounted at $SSH_AUTH_SOCK (the companion may reach the VM; no key is in this container)"
  fi

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

  # The companion registers no global extension (companion-guard and the lens
  # tool ride per-spawn argv); the common merge and the companion's own keys.
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
  if [ -n "${QCR_MEMORY_ENDPOINT:-}${OPENVIKING_URL:-}${OPENVIKING_BASE_URL:-}" ] && [ -f "$watcher" ]; then
    node "$watcher" &
  else
    say "memory watcher idle: no OpenViking endpoint configured for this container"
  fi

  # Stay alive, and DIE PROMPTLY when asked: PID 1 has no default signal
  # dispositions, so without a trap `docker stop` waits its full timeout. The
  # trap goes in before anything is started, and `child` is set up front: a
  # TERM landing before `sleep` is forked would otherwise hit an unbound
  # variable under `set -u` and exit 1.
  # `sleep &` + `wait`, because a foreground child would block the trap.
  local child=""
  term() {
    [ -z "$child" ] || kill "$child" 2>/dev/null || true
    exit 0
  }
  trap term TERM INT

  if [ -n "${QCR_TMUX_SOCKET:-}" ]; then
    # D35: the server listens on a socket in the volume the containerised TUI
    # shares (`tmux -S`), and stays up with no session so the TUI can find it
    # before pi is spawned. A socket left by an earlier run is stale.
    mkdir -p "$(dirname "$QCR_TMUX_SOCKET")" 2>/dev/null || true
    rm -f "$QCR_TMUX_SOCKET"
    tmux -S "$QCR_TMUX_SOCKET" start-server \; set -s exit-empty off
  else
    tmux start-server
  fi

  sleep infinity &
  child=$!
  # `|| true`: a signal makes `wait` return 128+N, which under `set -e` would
  # end the script before the trap's own `exit 0`.
  wait "$child" || true
  exit 0
}

mode_login() {
  # pi itself with `/login` typed and sent for the user: the one script
  # scanbox.ts `loginInPi` builds (it validates the provider name too), run on
  # the image's one pi, node_modules/.bin/pi (there is no pi on the PATH, P9.9b).
  local script
  script="$(node --input-type=module -e '
    const { loginInPi } = await import(process.argv[1] + "/dist/src/scanbox.js");
    process.stdout.write(loginInPi(process.argv[2] || undefined, process.argv[1] + "/node_modules/.bin/pi")[2]);
  ' "$APP" "${1:-}")" || die "login: could not build the pi login command"
  # The bot's login has ONE refresher (src/loginrefresh/, P8.22); when this
  # container runs it, it stands down for the login and takes over again after.
  login_handover_begin
  # Not exec: the login is shared with the login group once pi has written it,
  # however the session ended, and the refresher is released after that.
  local rc=0
  sh -c "$script" || rc=$?
  share_login
  login_handover_end
  exit "$rc"
}

# The handover between pi's /login and the bot container's login refresher
# (P8.22). The refresher holds an exclusive flock on <agent>/auth.json.lock for
# its whole life: when that lock is held, a refresher is running, and a login
# rewriting auth.json beside it would race its refresh. So the login asks it to
# pause - writes <agent>/auth.json.pause - and waits for `"paused": true` in
# its status file. A paused refresher neither refreshes nor writes, but KEEPS
# the lock, so no second refresher can start during the login. login_handover_end
# removes the pause file and the refresher re-reads the new login and resumes (a
# pause file left behind is lifted by the refresher after 15 minutes). Where
# nobody holds the lock (a laptop, the companion) nothing is done.
LOGIN_PAUSE_FILE=""
login_agent_dir() { printf '%s\n' "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; }

login_handover_begin() {
  local dir lock status rc=0 waited=0 max
  dir="$(login_agent_dir)"
  lock="$dir/auth.json.lock"
  status="$dir/loginrefresh.status.json"
  [ -e "$lock" ] || return 0
  if ! command -v flock >/dev/null 2>&1; then
    say "WARNING: flock is not installed - cannot tell whether a login refresher holds $lock"
    return 0
  fi
  flock -n -E 75 "$lock" true 2>/dev/null || rc=$?
  [ "$rc" -eq 75 ] || return 0
  LOGIN_PAUSE_FILE="$dir/auth.json.pause"
  trap 'rm -f "$LOGIN_PAUSE_FILE"' EXIT
  say "login: the bot's login refresher holds $lock - asking it to pause while you log in"
  (umask 007 && : >"$LOGIN_PAUSE_FILE") || die "login: cannot write $LOGIN_PAUSE_FILE"
  chgrp "$LOGIN_GID" "$LOGIN_PAUSE_FILE" 2>/dev/null || true
  max="${QCR_LOGIN_PAUSE_WAIT_S:-60}"
  # Half-second polls: the refresher looks at the pause file every 2 s.
  while ! grep -q '"paused": true' "$status" 2>/dev/null; do
    if [ "$waited" -ge $((max * 2)) ]; then
      die "login: the refresher did not pause within ${max}s ($status) - is the daemon running?"
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  say "login: the refresher is paused (it keeps the lock) - /login is yours"
}

login_handover_end() {
  [ -n "$LOGIN_PAUSE_FILE" ] || return 0
  rm -f "$LOGIN_PAUSE_FILE"
  LOGIN_PAUSE_FILE=""
  say "login: released - the refresher re-reads the login and resumes"
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

# ssh will not run for a uid the image has no passwd entry for, and the tui and
# companion modes run as the caller's own uid. When the entry is missing,
# nss_wrapper answers the lookup with one (its HOME is this HOME, where
# ~/.ssh/config and known_hosts are mounted). Needed by the TUI's ssh runner
# (src/tui/remote.ts) and by the companion's ssh to the VM (rule 8); a missing
# library is said, never fatal.
tui_identity() {
  local entry lib dir="$HOME/.qcr-nss"
  # ssh reads ~/.ssh from the passwd entry's home, never from $HOME. An entry
  # whose home IS this HOME needs nothing; a missing one, or the base image's
  # own user at this uid (uid 1000 is node, home /home/node), is answered with
  # one whose home is this HOME.
  entry="$(getent passwd "$(id -u)" 2>/dev/null || true)"
  [ -n "$entry" ] && [ "$(printf '%s' "$entry" | cut -d: -f6)" = "$HOME" ] && return 0
  lib="${QCR_NSS_WRAPPER_LIB:-$(find /usr/lib /lib -name 'libnss_wrapper.so*' 2>/dev/null | head -n 1)}"
  if [ ! -f "$lib" ] || ! mkdir -p "$dir" 2>/dev/null; then
    say "WARNING: uid $(id -u) has no passwd entry at $HOME and nss_wrapper is not usable - ssh will not read the mounted ssh config"
    return 0
  fi
  { awk -F: -v u="$(id -u)" '$3 != u' /etc/passwd; printf 'qcr:x:%s:%s:qcr:%s:/bin/sh\n' "$(id -u)" "$(id -g)" "$HOME"; } >"$dir/passwd"
  { cat /etc/group; printf 'qcr:x:%s:\n' "$(id -g)"; } >"$dir/group"
  export LD_PRELOAD="$lib" NSS_WRAPPER_PASSWD="$dir/passwd" NSS_WRAPPER_GROUP="$dir/group"
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
    tui_identity
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
