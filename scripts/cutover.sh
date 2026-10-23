#!/usr/bin/env bash
#
# cutover.sh — the owner's single cutover window,
# one idempotent, resumable wizard. Built with the /wizard skill.
#
#   scripts/cutover.sh X.Y.Z
#
# Moves the legacy tmux VM to the release image with per-round SDK workers.
# It runs only what the owner can sanction, in order, and stops at every go:
#
#   1  preconditions   origin, the tag and its manifest, the registry login
#                      and its expiry, the VM's updater (legacy layout, a
#                      provisioned run spec), the config home (no retired
#                      keys, lens_permits = 20)
#   2  drain           `qcr drain on` (an OPERATOR drain, checked), wait for
#                      running_rounds 0, record the pending_wakes and outbox
#                      counts
#   3  plan            `QCR_CUTOVER_ACK=<v> deploy.sh --dry-run release <v>`
#   4  release         the point of no return; typed go; deploy.sh release
#   5  verify          deploy.sh verify
#   6  first reconcile watched; the drain must still stand as the operator's
#                      HOLD after the new daemon's first healthy
#                      reconcile, or the wizard stops loudly
#   7  backstop        every open PR's head matches the daemon's, or a round
#                      is queued for it
#   8  surfaces        the TUI pull and the companion rebuild (the owner's)
#   9  first round     pause every tracked PR but the one the owner picks
#                      (`qcr pause-pr`, the operator's), `qcr drain off` on
#                      the owner's go, the owner watches that PR's first
#                      worker round, then `qcr resume-pr` on exactly the PRs
#                      it paused
#   10 idle PR         the answer worker
#   11 4 h check
#
# Owner ruling: at the cutover the drain HOLDS through the release and the
# first reconcile. Nothing runs under any drain, so the first worker round is
# watched after the lift: stage 9 pauses every tracked PR but one, runs
# `qcr drain off` only on the owner's explicit go, and resumes the PRs it
# paused only once the owner says that one round is good.
#
# The hold is the operator's no-auto-lift
# drain: no boot lifts it, only `qcr drain off`. The legacy daemon cannot
# spell one — its strict command schema refuses a `hold` field — so stage 2
# sets the operator's drain, and the release's first boot (the boot that adds
# the hold to state.db) carries a standing operator drain over as the hold
# (`drain_hold_carried`). Its first healthy reconcile then keeps it
# (`drain_hold_kept`) instead of lifting it, so no round starts in between.
#
# Resume: finished stages are recorded in a state file (per version) and
# skipped on the next run. The drain and its emptiness are re-checked before
# the release regardless, so a resumed run never deploys an undrained board.
# A stage that fails stops the wizard and is not recorded. Nothing is run
# without the owner's go, and no step ever passes a force flag.
#
# Env (seams; the defaults are the real thing):
#   QC_VM_HOST             ssh target (default: the ansible inventory's first host)
#   CUTOVER_VM_CMD         replaces the ssh to the VM; run as `bash -c "$CMD" _ "<remote command>"`
#   CUTOVER_DEPLOY         scripts/deploy.sh      CUTOVER_QCR   scripts/qcr
#   CUTOVER_PRS_CMD        prints `<number> <head sha>` per open PR (default: gh pr list)
#   CUTOVER_REPO           the reviewed repo (default example-org/example-app)
#   CUTOVER_GIT_DIR        the checkout whose origin and tags are checked
#   CUTOVER_STATE          the state file (default: <state home>/cutover-<version>.state)
#   CUTOVER_MAX_POLLS / CUTOVER_POLL_S   wait loops (default 180 x 10 s)
#   QC_RELEASE_DOWNLOAD_CMD, QCR_GHCR_EXPIRY_FILE, QC_NOW_EPOCH   as for deploy.sh
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. The stages are below.
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — delightful, consistent UX. Identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear — wipe the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" — opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later — it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" — clear the screen, then announce a stage and show progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." — a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." — a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL — open in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

# pause "msg" — wait for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" — y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY — current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" — read a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" — like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE — upsert KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE — set a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name — gh not ready; set it later"
}

# set_var NAME VALUE — set a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name — gh not ready; set it later"
}

# finish — clear, then a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES — one stage() per step the human takes.
# ──────────────────────────────────────────────────────────────────────────

ENV_FILE="${ENV_FILE:-/dev/null}"   # the wizard persists nothing in a .env

SELF="$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/install-locator.sh"

USAGE="usage: $SELF X.Y.Z"
[[ $# -eq 1 ]] || { echo "$USAGE" >&2; exit 2; }
VERSION="$1"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "$SELF: '$VERSION' is not a release version (X.Y.Z)" >&2; exit 2; }

DEPLOY="${CUTOVER_DEPLOY:-$ROOT/scripts/deploy.sh}"
QCR="${CUTOVER_QCR:-$ROOT/scripts/qcr}"
GIT_DIR="${CUTOVER_GIT_DIR:-$ROOT}"
REPO="${CUTOVER_REPO:-example-org/example-app}"
POLL_S="${CUTOVER_POLL_S:-10}"
MAX_POLLS="${CUTOVER_MAX_POLLS:-180}"
CONTAINER="quickreview-sandbox"
SANDBOX_ROOT="/opt/quickreview"

STATE_FILE="${CUTOVER_STATE:-$(qcr_state_home)/cutover-$VERSION.state}"
mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"

is_done()    { grep -qxF "done:$1" "$STATE_FILE"; }
mark_done()  { printf 'done:%s\n' "$1" >> "$STATE_FILE"; }
state_set()  { printf 'kv:%s=%s\n' "$1" "$2" >> "$STATE_FILE"; }
state_get()  { grep -E "^kv:$1=" "$STATE_FILE" | tail -n1 | cut -d= -f2- || true; }
now_epoch()  { printf '%s' "${QC_NOW_EPOCH:-$(date -u +%s)}"; }
bad()        { printf '  %s✖ %s%s\n' "$RED" "$1" "$RESET"; }
good()       { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }

first_inventory_host() {
  local inv="${QC_INVENTORY:-$ROOT/deploy/ansible/inventory.ini}"
  [[ -f "$inv" ]] || return 0
  awk '/^[[:space:]]*[#;]/ { next }
       /^[[:space:]]*\[/   { next }
       NF { print $1; exit }' "$inv"
}
VM_HOST="${QC_VM_HOST:-$(first_inventory_host)}"

# vm "<remote command>" — one command string on the VM.
vm() {
  if [[ -n "${CUTOVER_VM_CMD:-}" ]]; then
    bash -c "$CUTOVER_VM_CMD" _ "$1"
  else
    [[ -n "$VM_HOST" ]] || { echo "no VM host: set QC_VM_HOST" >&2; return 1; }
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$VM_HOST" "$1"
  fi
}

VM_JSON=""
read_vm_status() { VM_JSON="$(vm 'sudo qcr-update status --json' 2>/dev/null)" && grep -q '"layout"' <<<"$VM_JSON"; }
jfield() { grep -o "\"$1\":\"\?[^,}\"]*" <<<"$VM_JSON" | head -1 | sed -E 's/^"[^"]*":"?//' || true; }

# status_field KEY — the first `"KEY": value` of the daemon's status.json on
# the VM, or "" (unreadable, or absent — an older daemon's snapshot).
status_field() {
  vm "sudo grep -m1 -o '\"$1\"[[:space:]]*:[[:space:]]*\"\\?[^,}\" ]*' $SANDBOX_ROOT/state/status.json" 2>/dev/null |
    head -1 | sed -E 's/^[^:]*:[[:space:]]*"?//' || true
}

# ensure_drained — the board is draining with nothing running, or this fails.
# Re-run before the release on every run, done or not.
ensure_drained() {
  read_vm_status || { bad "the VM's \`qcr-update status\` cannot be read (ssh, or the updater is not provisioned)"; return 1; }
  local draining rounds
  draining="$(jfield draining)"; rounds="$(jfield running_rounds)"
  if [[ "$draining" != true ]]; then bad "the bot is not drained (draining=${draining:-unknown})"; return 1; fi
  if [[ "$rounds" != 0 ]]; then bad "rounds are still running (running_rounds=${rounds:-unknown})"; return 1; fi
  good "drained, running_rounds 0"
}

# ── 1. preconditions ─────────────────────────────────────────────────────
s_preconditions() {
  local url ok=0 dl exp_file exp exp_epoch now left home cfg out

  url="$(git -C "$GIT_DIR" remote get-url origin 2>/dev/null || true)"
  if [[ "$url" =~ quickchatai/quickreview(\.git)?/?$ ]]; then good "origin is quickchatai/quickreview"
  else bad "origin is '${url:-unset}', not quickchatai/quickreview"; ok=1; fi

  if [[ -n "$(git -C "$GIT_DIR" ls-remote --tags origin "refs/tags/v$VERSION" 2>/dev/null)" ]]; then good "tag v$VERSION is on origin"
  else bad "tag v$VERSION is not on origin (build once in CI first: runbook B)"; ok=1; fi

  dl="$(mktemp -d)"
  if [[ -n "${QC_RELEASE_DOWNLOAD_CMD:-}" ]]; then
    bash -c "$QC_RELEASE_DOWNLOAD_CMD" _ "$VERSION" "$dl" >/dev/null 2>&1 || true
  else
    gh release download "v$VERSION" --repo "${QC_RELEASE_REPO:-quickchatai/quickreview}" \
      --pattern "deploy-manifest-$VERSION.json" --dir "$dl" >/dev/null 2>&1 || true
  fi
  if [[ -s "$dl/deploy-manifest-$VERSION.json" ]]; then good "deploy-manifest-$VERSION.json is attached to the release"
  else bad "no deploy-manifest-$VERSION.json on release v$VERSION"; ok=1; fi
  rm -rf "$dl"

  exp_file="$(qcr_ghcr_expiry_file)"
  if [[ -s "$exp_file" ]]; then
    exp="$(head -1 "$exp_file")"
    exp_epoch="$(date -u -d "$exp" +%s 2>/dev/null || true)"
    now="$(now_epoch)"
    if [[ -z "$exp_epoch" ]]; then bad "the recorded registry login expiry '$exp' is not a date ($exp_file)"; ok=1
    elif (( exp_epoch <= now )); then bad "the VM's registry login expired $exp: run scripts/vm-ghcr-login.sh --version $VERSION"; ok=1
    else
      left=$(( (exp_epoch - now) / 86400 ))
      good "the VM's registry login runs to $exp ($left days)"
      (( left < 14 )) && warn "under 14 days left: renew with scripts/vm-ghcr-login.sh soon"
    fi
  else
    bad "no registry login recorded ($exp_file): run scripts/vm-ghcr-login.sh --version $VERSION"; ok=1
  fi

  if read_vm_status; then
    if [[ "$(jfield layout)" == legacy ]]; then good "the VM is on the legacy layout (this is the cutover)"
    else bad "the VM's layout is '$(jfield layout)', not legacy: this wizard is for the one cutover"; ok=1; fi
    if [[ -n "$(jfield fingerprint)" ]]; then good "the VM holds a provisioned run spec ($(jfield fingerprint))"
    else bad "the VM holds no run spec: run \`scripts/deploy.sh provision\`"; ok=1; fi
  else
    bad "the VM's \`sudo qcr-update status --json\` does not answer (ssh, or provision never installed the updater)"; ok=1
  fi

  home="$(qcr_config_home)"
  cfg="$(qcr_locate_config "$ROOT")"
  if [[ ! -f "$cfg" ]]; then bad "no config at $cfg"; ok=1
  else
    if grep -Eq '^[[:space:]]*lens_permits[[:space:]]*=[[:space:]]*20[[:space:]]*(#.*)?$' "$cfg"; then good "[daemon] lens_permits = 20"
    else bad "$cfg needs [daemon] lens_permits = 20"; ok=1; fi
    if out="$("$QCR" config check --config-home "$home" 2>&1)"; then good "\`qcr config check\` passes (no retired keys)"
    else bad "\`qcr config check\` refuses the config home:"; printf '%s\n' "$out" | sed 's/^/      /'; ok=1; fi
  fi

  (( ok == 0 )) || { say "Fix the above, then re-run: $SELF $VERSION"; return 1; }
}

# ── 2. drain ─────────────────────────────────────────────────────────────
count_wakes() {
  local js='const D=require("better-sqlite3");console.log(new D("'"$SANDBOX_ROOT"'/state/state.db",{readonly:true}).prepare("SELECT COUNT(*) c FROM pending_wakes").get().c)'
  vm "sudo docker exec $CONTAINER node -e $(printf %q "$js")" 2>/dev/null | tail -1
}
count_outbox() {
  vm "sudo sh -c 'ls $SANDBOX_ROOT/state/posting-receipts/*.outbox.json 2>/dev/null | wc -l'" 2>/dev/null | tail -1
}
s_drain() {
  local n=0 wakes outbox by
  say "Turning the drain on. From here webhook deliveries are dropped, not queued;"
  say "stage 7 checks the reconcile backstop caught up."
  say "The legacy daemon refuses a \`hold\` field, so this is the operator's plain drain; the release's"
  say "first boot keeps it as the operator's HOLD, which no boot lifts (stage 6 checks that)."
  "$QCR" drain on || { bad "\`qcr drain on\` failed"; return 1; }
  until read_vm_status && [[ "$(jfield draining)" == true && "$(jfield running_rounds)" == 0 ]]; do
    n=$((n + 1))
    if (( n > MAX_POLLS )); then bad "still not drained after $MAX_POLLS polls (running_rounds=$(jfield running_rounds)): wait, then re-run"; return 1; fi
    note "waiting for running_rounds 0 (now ${VM_JSON:+$(jfield running_rounds)})…"
    sleep "$POLL_S"
  done
  good "drained, running_rounds 0"
  # Only an OPERATOR drain is carried over as the hold: a drain the daemon
  # bounded like a session's (an unsealed commands/operator/) lapses and is
  # lifted by the boot. Read from the same heartbeat that showed the drain.
  by="$(status_field draining_by)"
  if [[ "$by" != operator ]]; then
    bad "the drain is not the operator's (draining_by=${by:-unknown}): the release's boot would not keep it"
    say "Fix commands/operator/ in the container (root-owned, 0755, not a symlink), \`qcr drain off\`, then re-run."
    return 1
  fi
  good "the drain is the operator's"
  wakes="$(count_wakes || true)"; outbox="$(count_outbox || true)"
  [[ "$wakes" =~ ^[0-9]+$ ]] || { wakes=unknown; warn "pending_wakes could not be read"; }
  [[ "$outbox" =~ ^[0-9]+$ ]] || { outbox=unknown; warn "the outbox count could not be read"; }
  state_set pending_wakes "$wakes"; state_set outbox "$outbox"
  say "Write these down (both survive in sqlite): pending_wakes=$wakes  outbox=$outbox"
}

# ── 3. the plan ──────────────────────────────────────────────────────────
s_plan() {
  local out
  ensure_drained || return 1
  out="$(QCR_CUTOVER_ACK="$VERSION" "$DEPLOY" --dry-run release "$VERSION" 2>&1)" || { printf '%s\n' "$out"; bad "the dry-run refused: nothing was changed"; return 1; }
  printf '%s\n' "$out"
  printf '\n'
  say "Read the plan. It must show:"
  step "legacy layout, so this is the cutover"
  step "the manifest digests and a pull by digest"
  step "the config check of config-home.next by the new image"
  step "stop, snapshot, then \`daemon --preflight\` on a scratch copy"
  step "the sidecar seed (copy plus checksum, once)"
  step "the config swap, then sidecar /ready"
  step "the recreate of $CONTAINER, named as the point of no return"
  confirm "Does the plan show all of that?" || { say "Stopped. Nothing was changed."; return 1; }
}

# ── 4. the release ───────────────────────────────────────────────────────
s_release() {
  local typed="" rc log
  ensure_drained || return 1
  warn "POINT OF NO RETURN. After the recreate there is no way back to tmux or processes."
  say "The legacy bot is stopped and snapshotted first; any failure before the recreate is rescued"
  say "by the updater (old config back, old bot started, drain re-sent)."
  printf '  %sType the version (%s) to run the release, anything else stops:%s ' "$YELLOW" "$VERSION" "$RESET"
  read -r typed || true
  [[ "$typed" == "$VERSION" ]] || { say "No go given. Nothing was changed."; return 1; }
  log="$(dirname "$STATE_FILE")/cutover-$VERSION.release.log"
  QCR_CUTOVER_ACK="$VERSION" "$DEPLOY" release "$VERSION" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  if (( rc != 0 )); then
    bad "the release failed (exit $rc); output above, saved to $log"
    # Where it failed decides what it means: the updater's RESCUE covers a failure up to the recreate,
    # and a failure in deploy.sh's post-deploy checks comes AFTER it. The VM's own layout says which.
    if read_vm_status && [[ "$(jfield layout)" == release ]]; then
      bad "the VM's layout is now RELEASE: the recreate happened, so this failure came AFTER the point of no return"
      say "Nothing was rescued and nothing can be: fix forward under the drain (runbook E.3). Read"
      say "\`ssh ${VM_HOST:-<vm>} sudo docker logs --tail 100 $CONTAINER\` and the post-deploy output above, keep the"
      say "drain, and re-run $SELF $VERSION to resume at this stage once it is fixed."
    else
      say "A failure before the recreate was RESCUED by the updater: the legacy bot is back on its old"
      say "config and drained. Confirm with \`ssh ${VM_HOST:-<vm>} sudo qcr-update status --json\`, wait for"
      say "running_rounds 0, fix, re-tag if needed, and re-run $SELF <version>."
      say "A failure AFTER the recreate is fixed forward under the drain (runbook E.3)."
    fi
    return 1
  fi
  good "release $VERSION deployed"
}

# ── 5. verify ────────────────────────────────────────────────────────────
s_verify() {
  "$DEPLOY" verify || { bad "verify failed: keep the drain on and read the output above"; return 1; }
  say "It must have shown: both containers up on the manifest digests, the sidecar ready, the"
  say "heartbeat fresh with permits 0/20, the IPC socket, the login refresher holding auth.json.lock,"
  say "and no pi, overseer or tmux PR session in the process tree."
  confirm "Does verify show all of that?" || return 1
}

# ── 6. first reconcile; the hold stands ──────────────────────────────────
# hold_kept — the new daemon logged that its first healthy reconcile kept the hold.
hold_kept() {
  local c; c="$(vm "sudo docker logs --since 30m $CONTAINER 2>&1 | grep -c drain_hold_kept" 2>/dev/null | tail -1 || true)"
  [[ "$c" =~ ^[0-9]+$ ]] && (( c > 0 ))
}
s_reconcile() {
  local n=0 kept=0 hold
  say "Watching the new daemon's first reconcile. The drain is the operator's HOLD now: the first"
  say "healthy pass keeps it (drain_hold_kept) instead of lifting it. Only \`qcr drain off\` lifts it."
  while (( n <= MAX_POLLS )); do
    if ! read_vm_status; then
      bad "the VM's \`qcr-update status\` cannot be read"; return 1
    fi
    if [[ "$(jfield draining)" != true ]]; then
      bad "THE DRAIN IS OFF after the new daemon's boot (draining=$(jfield draining)): rounds may be starting"
      say "Drain by hand NOW (\`qcr drain on --hold\`), then read \`ssh ${VM_HOST:-<vm>} sudo docker logs --since 15m $CONTAINER\`"
      say "for drain_hold_carried / drain_lifted, and check \`qcr status\` for rounds that started."
      return 1
    fi
    hold="$(status_field draining_hold)"
    if [[ "$hold" == false ]]; then
      bad "the drain stands but is NOT a hold (draining_hold=false): the daemon's first healthy reconcile lifts it"
      say "Make it a hold NOW (\`qcr drain on --hold\`), then re-run $SELF $VERSION."
      return 1
    fi
    if [[ "$hold" == true ]] && hold_kept; then kept=1; break; fi
    n=$((n + 1)); note "waiting for the first reconcile (draining_hold=${hold:-not reported yet})…"; sleep "$POLL_S"
  done
  if (( kept )); then
    good "the first reconcile was healthy and kept the hold"
  else
    if [[ "$hold" != true ]]; then
      bad "the new daemon never reported the hold (draining_hold=${hold:-unknown}): do not go on"
      say "Read \`ssh ${VM_HOST:-<vm>} sudo docker logs --since 15m $CONTAINER\` before anything else."
      return 1
    fi
    warn "the hold stands, but no healthy first reconcile was logged: it reported errors, or has not finished"
    say "Read \`ssh ${VM_HOST:-<vm>} sudo docker logs --since 15m $CONTAINER\` and \`qcr why <pr>\` before any drain off."
    confirm "Is the reconcile healthy enough to go on (the hold stays on)?" || return 1
  fi
  good "the drain is held (no boot lifts it; stage 9 lifts it on your go, all but one PR paused)"
}

# ── 7. the reconcile backstop ────────────────────────────────────────────
prs_on_github() {
  if [[ -n "${CUTOVER_PRS_CMD:-}" ]]; then bash -c "$CUTOVER_PRS_CMD"
  else gh pr list --repo "$REPO" --state open --limit 200 --json number,headRefOid --jq '.[] | "\(.number) \(.headRefOid)"'; fi
}
# daemon_status — `qcr status` as the DAEMON sees it, read in its container: `qcr status` on the owner's
# machine reads that machine's own state dir (no status.json there), which would make the backstop
# below compare GitHub with nothing and pass. The release image keeps the CLI at /opt/qcr (the cutover
# is past the recreate by now).
daemon_status() { vm "sudo docker exec $CONTAINER node /opt/qcr/dist/src/cli.js status"; }
s_backstop() {
  local n=0 gh_prs daemon_prs lag num sha dline dstate dhead
  say "Webhooks were dropped during the drain. Every tracked open PR's head on GitHub must match"
  say "the daemon's last-seen head, or a round must be queued for it."
  while :; do
    gh_prs="$(prs_on_github)" || { bad "could not list the open PRs"; return 1; }
    daemon_prs="$(daemon_status 2>/dev/null)" || { bad "the daemon's \`qcr status\` could not be read in its container"; return 1; }
    grep -q "^quickreview — " <<<"$daemon_prs" || { bad "the daemon's \`qcr status\` printed no snapshot (is the daemon up?)"; return 1; }
    lag=""
    while read -r num sha; do
      [[ -n "$num" ]] || continue
      dline="$(grep -E "^[[:space:]]*#?$num[[:space:]]" <<<"$daemon_prs" | head -1 || true)"
      [[ -n "$dline" ]] || { note "#$num is not tracked by the daemon (not triggered)"; continue; }
      dstate="$(awk '{print $2}' <<<"$dline")"
      dhead="$(awk '{print $4}' <<<"$dline")"
      if [[ "$sha" == "$dhead"* ]]; then continue; fi
      case "$dstate" in queued|reviewing) note "#$num head moved; a round is $dstate" ;; *) lag="$lag #$num" ;; esac
    done <<<"$gh_prs"
    [[ -z "$lag" ]] && break
    n=$((n + 1))
    if (( n > MAX_POLLS )); then bad "the backstop has not caught up for:$lag"; say "Wait for a reconcile pass, then re-run."; return 1; fi
    note "waiting for the backstop to catch:$lag"; sleep "$POLL_S"
  done
  good "every tracked PR is current or has a round queued"
}

# ── 8. operator surfaces ─────────────────────────────────────────────────
s_surfaces() {
  say "Bring the operator surfaces to $VERSION now. You run these, not the wizard:"
  step "the TUI clone:   git fetch origin tag v$VERSION && git merge --ff-only v$VERSION   (hot reload)"
  step "the companion:   qcr companion rebuild   (or pull the $VERSION image)"
  confirm "Both done?" || return 1
}

# ── 9. the first worker round, one PR at a time ──────────────────────────
# Nothing runs under any drain (dispatch starts nothing, a webhook is dropped, `qcr debug-round` is
# refused), so the first worker round is watched AFTER the lift. The stage
# pauses every tracked PR but the one the owner picks (the operator's pause through the sealed operator
# channel: no expiry, no session lifts it), lifts the drain, has the owner watch that one PR's first worker
# round, and on a good round resumes exactly the PRs it paused. Each step is recorded in the state file
# (`first_pr`, `paused:<n>`, `lift=sent`, `lifted_at`, `resumed:<n>`), so a resumed run never pauses a PR
# twice, never lifts twice and resumes only what it paused.
paused_by_wizard()  { grep -E '^paused:[0-9]+$' "$STATE_FILE" | cut -d: -f2 | sort -un || true; }
resumed_by_wizard() { grep -qxF "resumed:$1" "$STATE_FILE"; }
# tracked_prs STATUS — `<number> <state>` per PR the daemon tracks and has not closed.
tracked_prs() {
  awk '$1 ~ /^#[0-9]+$/ && $2 ~ /^(tracked|queued|reviewing|awaiting_author)$/ { sub(/^#/, "", $1); print $1, $2 }' <<<"$1"
}
# operator_paused STATUS — the PR numbers whose pause is the OPERATOR's (until resumed).
operator_paused() {
  grep -E '^#[0-9]+ paused by the operator until resumed' <<<"$1" | sed -E 's/^#([0-9]+) .*/\1/' | sort -un || true
}
trigger_label() {
  local cfg l=""
  cfg="$(qcr_locate_config "$ROOT" 2>/dev/null || true)"
  [[ -f "$cfg" ]] && l="$(grep -E '^[[:space:]]*trigger_label[[:space:]]*=' "$cfg" | head -1 | sed -E 's/^[^=]*=[[:space:]]*"([^"]*)".*/\1/' || true)"
  printf '%s' "${l:-AI review requested}"
}
s_first_round() {
  local pr st status tracked op num state pstate n lifted
  lifted="$(state_get lifted_at)"
  if [[ -z "$lifted" ]]; then
    read_vm_status || { bad "the VM's \`qcr-update status\` cannot be read"; return 1; }
    if [[ "$(jfield draining)" != true ]]; then
      if [[ "$(state_get lift)" == sent ]]; then
        lifted="$(now_epoch)"; state_set lifted_at "$lifted"
        good "the drain was lifted by this stage's earlier run"
      else
        bad "THE DRAIN IS OFF before this stage lifted it (draining=$(jfield draining)): rounds may be starting"
        say "Drain by hand NOW (\`qcr drain on --hold\`), check \`qcr status\` for rounds that started, then re-run $SELF $VERSION."
        return 1
      fi
    fi
  fi
  say "Nothing runs under a drain, so the first worker round is watched AFTER the lift. This stage pauses every"
  say "tracked PR but the one you pick (the operator's pause: it stands until resumed), lifts the drain, waits"
  say "for your check of that PR's first worker round, and on a good round resumes exactly the PRs it paused."
  status="$(daemon_status 2>/dev/null)" || { bad "the daemon's \`qcr status\` could not be read in its container"; return 1; }
  grep -q "^quickreview — " <<<"$status" || { bad "the daemon's \`qcr status\` printed no snapshot (is the daemon up?)"; return 1; }
  tracked="$(tracked_prs "$status")"
  op="$(operator_paused "$status")"
  if [[ -n "$tracked" ]]; then
    say "Tracked open PRs (the daemon's \`qcr status\`):"
    while read -r num state; do
      if grep -qxF "$num" <<<"$op"; then note "    #$num  $state  (paused by the operator)"; else note "    #$num  $state"; fi
    done <<<"$tracked"
  else
    note "the daemon tracks no open PR"
  fi

  pr="$(state_get first_pr)"
  if [[ -n "$pr" ]]; then
    good "the first PR is #$pr (chosen on an earlier run of this stage)"
  else
    printf '  %sWhich PR runs the first worker round? PR number for the commands below:%s ' "$BOLD" "$RESET"
    read -r pr || true
    [[ "$pr" =~ ^[0-9]+$ ]] && (( pr > 0 )) || { say "No PR chosen. Nothing was paused and the drain still holds."; return 1; }
    state_set first_pr "$pr"
  fi
  pstate="$(awk -v n="$pr" '$1 == n { print $2 }' <<<"$tracked")"
  [[ -n "$pstate" ]] || warn "#$pr is not a tracked open PR: it reviews only once it is triggered after the lift"
  if grep -qxF "$pr" <<<"$op" && ! grep -qxF "$pr" <<<"$(paused_by_wizard)"; then
    warn "#$pr is paused by the operator from before this stage: it cannot run until \`qcr resume-pr $pr\`"
  fi

  if [[ -z "$lifted" ]]; then
    # Pause every other tracked PR that the operator does not already hold. Read fresh each run, so a PR the
    # reconcile started tracking since an earlier run is caught too.
    n=0
    while read -r num state; do
      [[ -n "$num" && "$num" != "$pr" ]] || continue
      if grep -qxF "paused:$num" "$STATE_FILE"; then note "#$num already paused by this stage"; continue; fi
      if grep -qxF "$num" <<<"$op"; then note "#$num is already paused by the operator: left as it is (and left paused after)"; continue; fi
      "$QCR" pause-pr "$num" --reason "cutover $VERSION: first worker round runs on #$pr alone" </dev/null ||
        { bad "\`qcr pause-pr $num\` failed: the drain still holds; fix it, then re-run $SELF $VERSION"; return 1; }
      printf 'paused:%s\n' "$num" >> "$STATE_FILE"; n=$((n + 1))
    done <<<"$tracked"
    good "paused $n PR(s) now; paused by this stage in all: $(paused_by_wizard | sed 's/^/#/' | tr '\n' ' ')"
    # Every PR this stage paused must stand as the OPERATOR's pause before the lift: a bounded one lapses.
    # The snapshot is the heartbeat's, rewritten about every 30 s, so a pause handled after the last
    # write is not in it yet: wait for it, bounded, rather than read one snapshot (the 1.0.3 cutover).
    local missing polls=0
    while :; do
      status="$(daemon_status 2>/dev/null)" || { bad "the daemon's \`qcr status\` could not be read in its container"; return 1; }
      op="$(operator_paused "$status")"
      missing=""
      for num in $(paused_by_wizard); do grep -qxF "$num" <<<"$op" || missing="$missing #$num"; done
      [[ -z "$missing" ]] && break
      polls=$((polls + 1))
      if (( polls > MAX_POLLS )); then bad "not shown as paused by the operator in the daemon's \`qcr status\`:$missing: not lifting"; return 1; fi
      note "waiting for the daemon's snapshot to show the pause of:$missing"; sleep "$POLL_S"
    done
    # A PR the reconcile started tracking while the pauses were sent is in this snapshot but was never paused.
    while read -r num state; do
      [[ -n "$num" && "$num" != "$pr" ]] || continue
      grep -qxF "$num" <<<"$op" && continue
      bad "#$num is tracked but not paused (it appeared after the pauses were sent): not lifting; re-run $SELF $VERSION to pause it"
      return 1
    done <<<"$(tracked_prs "$status")"
    warn "Lifting the drain lets #$pr start a worker round (and nothing else: every other tracked PR is paused)."
    confirm "Lift the drain now (qcr drain off)?" || { say "The drain stays on; the pauses stay recorded. Re-run $SELF $VERSION when ready."; return 1; }
    state_set lift sent
    "$QCR" drain off || { bad "\`qcr drain off\` failed"; return 1; }
    read_vm_status && [[ "$(jfield draining)" != true ]] || { bad "the drain is still on"; return 1; }
    lifted="$(now_epoch)"; state_set lifted_at "$lifted"
    good "drain lifted by the owner's go; only #$pr can start a round"
  fi

  say "Watch #$pr's first worker round:"
  if [[ "$pstate" == queued ]]; then
    step "#$pr has a pending trigger (queued): its round starts at the lift, nothing to trigger"
  else
    step "trigger it: re-request review from the review team on #$pr, or re-add the label \"$(trigger_label)\""
    note "    (not \`qcr debug-round\`: that round runs in interactive pi, not on a worker)"
  fi
  step "watch it in the TUI viewer, then check, over ssh ${VM_HOST:-<vm>}:"
  note "    status.json runtime=worker for the PR:   sudo grep -o '\"runtime\":\"[a-z]*\"' $SANDBOX_ROOT/state/status.json"
  note "    the IPC ready session_id equals the PR's JSONL id:   sudo ls $SANDBOX_ROOT/state/pi-sessions/pr-$pr"
  note "    the engine wave starts and permits stay at or under 20, grants staggered:   qcr status"
  note "    the lens JSONLs are written; no stage cancellations:   sudo docker logs --since 30m $CONTAINER"
  note "    the post went over IPC through the MutationGate to a review URL; verdict_written arrived;"
  note "      the worker exited 0:   sudo docker logs $CONTAINER 2>&1 | grep -E 'worker|verdict_written'"
  note "    est_usd is recorded:   qcr why $pr"
  if ! confirm "Was the worker round checked and is it good?"; then
    say "The other PRs STAY PAUSED (the operator's pauses: they do not lapse); only #$pr can run. The drain is off."
    say "Failure handling (runbook E.3): read the daemon log (worker exit code, the IPC 'failed' reason),"
    say "state/workers/<command>.log, state/live/<key>/ and \`qcr open pr $pr\`. To stop #$pr too: \`qcr pause-pr $pr\`"
    say "(or \`qcr drain on --hold\` for the whole board). A bad boot, env or socket fault: reproduce in a faux test,"
    say "fix on master, ship $VERSION+1. Re-run $SELF $VERSION to come back to this question."
    return 1
  fi
  for num in $(paused_by_wizard); do
    resumed_by_wizard "$num" && continue
    "$QCR" resume-pr "$num" </dev/null || { bad "\`qcr resume-pr $num\` failed: re-run $SELF $VERSION to resume the rest"; return 1; }
    printf 'resumed:%s\n' "$num" >> "$STATE_FILE"
  done
  good "resumed every PR this stage paused: $(paused_by_wizard | sed 's/^/#/' | tr '\n' ' ')"
  good "the board is open on workers"
}

# ── 10. the idle-PR answer worker ────────────────────────────────────────
s_idle_pr() {
  say "Send a \`message\` (without --may-post) to an idle PR and confirm the answer worker replies"
  say "and exits without posting:"
  step "qcr message <pr> <text...>"
  step "qcr open pr <n> on a finished worker round"
  step "optional: qcr debug-round <n>   (posts through the gate; its pane is the pi terminal)"
  confirm "Answer worker replied, exited, and posted nothing?" || return 1
}

# ── 11. the 4-hour check ─────────────────────────────────────────────────
s_four_hours() {
  local lifted at now due
  lifted="$(state_get lifted_at)"
  [[ "$lifted" =~ ^[0-9]+$ ]] || lifted="$(now_epoch)"
  now="$(now_epoch)"; due=$((lifted + 4 * 3600))
  if (( now < due )); then
    say "The 4-hour check is due at $(date -u -d "@$due" '+%Y-%m-%d %H:%M UTC'). Come back then:"
    say "  $SELF $VERSION      (everything before this is done and will be skipped)"
    exit 0
  fi
  say "The 4-hour check:"
  step "heartbeat and anomalies: no worker_crash_loop, no login_refresh_failed   (qcr status; qcr events)"
  step "docker stats: CPU throttling and memory against the 2 CPU / 8 GiB caps"
  step "round wall-clock against the tmux baseline (the 31-34 min serial-discovery rounds should shrink)"
  step "est_usd per round (qcr metrics)"
  step "the outbox is drained and pending_wakes were flushed by worker rounds"
  step "no SQLITE_BUSY in the daemon log:   sudo docker logs $CONTAINER 2>&1 | grep -c SQLITE_BUSY"
  step "the refresher's next refresh is scheduled (status.json)"
  confirm "All clean?" || { say "Not clean: classify it per runbook E.3 before anything else."; return 1; }
}

# run_stage <id> "Title" <fn> — skip a recorded stage; record on success;
# stop the wizard on failure.
run_stage() {
  local id="$1" title="$2" fn="$3"
  if is_done "$id"; then
    _STAGE_INDEX=$((_STAGE_INDEX + 1))
    printf '  %s✓ stage %s/%s · %s — already done, skipped%s\n' "$GREEN" "$_STAGE_INDEX" "$TOTAL_STAGES" "$title" "$RESET"
    return 0
  fi
  stage "$title"
  if "$fn"; then
    mark_done "$id"
  else
    printf '\n  %sStopped at stage %s. Not recorded as done; re-run %s %s to resume here.%s\n\n' "$RED" "$_STAGE_INDEX" "$SELF" "$VERSION" "$RESET"
    exit 1
  fi
}

TOTAL_STAGES=11
banner "Cutover to $VERSION"

run_stage preconditions "Preconditions"                  s_preconditions
run_stage drain         "Drain the board"                s_drain
run_stage plan          "The release plan (dry run)"     s_plan
run_stage release       "The release (point of no return)" s_release
run_stage verify        "Verify"                         s_verify
run_stage reconcile     "First reconcile; hold the drain" s_reconcile
run_stage backstop      "The reconcile backstop"         s_backstop
run_stage surfaces      "TUI and companion"              s_surfaces
run_stage first_round   "Pause all but one, lift, first worker round" s_first_round
run_stage idle_pr       "The idle-PR answer worker"      s_idle_pr
run_stage four_hours    "The 4-hour check"               s_four_hours
# ──────────────────────────────────────────────────────────────────────────

finish
