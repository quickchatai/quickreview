#!/usr/bin/env bash
# smoke-companion.sh — the manual checklist for the local companion.
# `npm run smoke:companion`.
#
# Unlike scripts/companion-e2e.sh (throwaway container, fake sinks, proves the
# plumbing) this walks the REAL companion the way `qcr tui` does it:
#
#   1. the image builds / is present
#   2. qcr companion up → status running → adopt is idempotent
#   3. pi auth persisted on the pihome volume (SKIPPED until /login has run)
#   4. the container holds no VM credential (ssh to the VM fails) and
#      reaches OpenViking through the memory forward instead
#   5. an overseer inject lands in the daemon's inject dir — DRY BY DEFAULT:
#      prints the exact command; only --live actually writes to the VM
#   6. daily rollover on a faked date (QCR_FAKE_TODAY) against the real
#      container, into temp state — the persistent rollover state is untouched
#   7. qcr companion down leaves the volumes (and the conversation) alone
#
# Nothing here mutates GitHub. Step 5 is the only step that can touch the VM at
# all, and it is opt-in.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

PASS=0
FAIL=0
SKIP=0
pass() { printf 'PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf 'SKIP  %s\n' "$1"; SKIP=$((SKIP + 1)); }
step() { printf '\n--- %s\n' "$1"; }

command -v docker >/dev/null 2>&1 || { echo "smoke:companion: docker is required" >&2; exit 2; }

WORK="$(mktemp -d -t qcr-companion-smoke-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# dist must exist before any of the node one-liners below.
(cd "$ROOT" && npm run --silent build)

# Config values, read once through the same loader the TUI uses. The emitted
# lines are plain KEY="value" pairs; a value containing a double quote or a
# backslash is rejected rather than eval'd.
CONF="$(cd "$ROOT" && node --input-type=module -e '
const { loadConfig } = await import("./dist/src/config.js");
const c = loadConfig();
const emit = (k, v) => {
  if (/["\\$`]/.test(String(v))) throw new Error(`unsafe config value for ${k}: ${v}`);
  console.log(`${k}="${v}"`);
};
emit("CONTAINER", c.companion.container_name);
emit("IMAGE", c.companion.image);
emit("PIHOME", c.companion.pihome_volume);
emit("SESSION", c.companion.session);
emit("SSH_HOST", c.tui.ssh_host);
emit("VM_CONTAINER", c.tui.container);
emit("VM_ROOT", c.tui.remote_sandbox_root);
emit("SUDO", c.tui.sudo_docker ? 1 : 0);
')"
eval "$CONF"
DOCKER_ON_VM="docker"
[[ "$SUDO" == "1" ]] && DOCKER_ON_VM="sudo docker"

QCR="$ROOT/scripts/qcr"

# The app's build stamp (src/appstamp.ts) for the image's qcr.build-sha label.
app_stamp() {
  node --input-type=module -e 'const m = await import(process.argv[1]); console.log(m.appStamp(process.argv[2]));' \
    "$1/dist/src/appstamp.js" "$1"
}

# --- 1. image ----------------------------------------------------------------
step "image"
# The release image (docker/Dockerfile) compiles the app itself.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  pass "image $IMAGE present"
elif docker build -t "$IMAGE" -f "$ROOT/docker/Dockerfile" \
  --build-arg BUILD_SHA="$(app_stamp "$ROOT")" \
  "$ROOT" >"$WORK/build.log" 2>&1; then
  pass "image $IMAGE built"
else
  fail "image $IMAGE builds (see $WORK/build.log)"
fi

# --- 2. lifecycle ------------------------------------------------------------
step "qcr companion up / status"
if "$QCR" companion up >"$WORK/up.log" 2>&1; then pass "qcr companion up: $(tail -1 "$WORK/up.log")"; else fail "qcr companion up ($(tail -1 "$WORK/up.log"))"; fi
if "$QCR" companion up >"$WORK/up2.log" 2>&1 && grep -q "adopted" "$WORK/up2.log"; then
  pass "second up adopts, never spawns a twin"
else
  fail "second up adopts (got: $(tail -1 "$WORK/up2.log"))"
fi
if "$QCR" companion status 2>&1 | grep -q running; then pass "qcr companion status: running"; else fail "qcr companion status: running"; fi

# --- 3. pi auth --------------------------------------------------------------
step "pi auth (one-time /login)"
if docker exec "$CONTAINER" sh -c 'test -f "$HOME/.pi/agent/auth.json"' >/dev/null 2>&1; then
  pass "auth.json persisted on volume $PIHOME"
else
  skip "auth.json absent — run: docker exec -it $CONTAINER tmux attach -t $SESSION, then /login"
fi

# --- 4. no ssh from inside the container; memory reachable instead -----------
# The companion has no ~/.ssh mount and no agent socket: it holds no VM
# credential. So ssh working in here is a FAILURE, and the container's window
# onto the VM is the OpenViking forward.
step "companion holds no VM credential"
if docker exec "$CONTAINER" ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_HOST" true >"$WORK/ssh.log" 2>&1; then
  fail "ssh $SSH_HOST works inside the container — the credential boundary (rule 8) has regressed"
else
  pass "ssh $SSH_HOST refused inside the container (expected — no VM credential)"
fi

step "memory reachable from inside the container"
MEM_URL="${QCR_MEMORY_ENDPOINT:-http://198.51.100.1:1933}"
if docker exec "$CONTAINER" node -e "
  fetch('$MEM_URL/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))
" >"$WORK/memory.log" 2>&1; then
  pass "OpenViking /health reachable at $MEM_URL"
else
  skip "OpenViking unreachable at $MEM_URL — is the forward installed? (scripts/companion-memory-forward.mjs status)"
fi

# --- 5. overseer inject (dry by default) -------------------------------------
step "overseer inject (dry-run unless --live)"
INJECT_DIR="$VM_ROOT/inject/overseer"
NAME="$(date -u +%Y-%m-%dT%H-%M-%SZ)-smoke.md"
# Exactly the shape src/tui/msg.ts writes: atomic tmp+mv into the daemon's
# inject dir, content on stdin so it never rides a command line.
WRITE_CMD="$DOCKER_ON_VM exec -i $VM_CONTAINER sh -c \"mkdir -p '$INJECT_DIR' && cat > '$INJECT_DIR/.$NAME.tmp' && mv '$INJECT_DIR/.$NAME.tmp' '$INJECT_DIR/$NAME'\""
PROBE_CMD="$DOCKER_ON_VM exec $VM_CONTAINER sh -c \"test -f '$INJECT_DIR/.done/$NAME'\""
if [[ "$LIVE" == "1" ]]; then
  if printf '[companion smoke] ignore me — smoke:companion inject check.\n' |
     ssh "$SSH_HOST" "$WRITE_CMD" >"$WORK/inject.log" 2>&1; then
    sleep 5
    if ssh "$SSH_HOST" "$PROBE_CMD" >/dev/null 2>&1; then
      pass "overseer inject delivered (bridge archived it)"
    else
      fail "overseer inject delivered — file still pending in $INJECT_DIR"
    fi
  else
    fail "overseer inject write ($(tail -1 "$WORK/inject.log"))"
  fi
else
  printf '      would run: ssh %s %s\n' "$SSH_HOST" "$WRITE_CMD"
  skip "overseer inject — pass --live to actually write to the VM"
fi

# --- 6. rollover on a faked date ---------------------------------------------
step "daily rollover (QCR_FAKE_TODAY, temp state)"
mkdir -p "$WORK/state" "$WORK/inject"
printf '{"last_open_date":"1999-12-31","updated_at":""}\n' > "$WORK/state/rollover.json"
if (cd "$ROOT" && QCR_FAKE_TODAY=2099-01-01 node --input-type=module -e '
const { loadConfig } = await import("./dist/src/config.js");
const { CompanionRollover } = await import("./dist/src/tui/rollover.js");
const { realDockerRunner } = await import("./dist/src/tui/companion.js");
const work = process.argv[1];
const r = new CompanionRollover(loadConfig().companion, realDockerRunner, {
  statePath: `${work}/state/rollover.json`,
  policyStatePath: `${work}/state/alert-policy.json`,
  templatePath: "prompts/companion-day-open.md",
  injectDir: `${work}/inject`,
});
const report = await r.run();
for (const s of report.steps) console.log(`      · ${s}`);
if (report.verdict.kind !== "rollover") { console.error(`expected a rollover, got ${report.verdict.kind}`); process.exit(1); }
if (!report.dayOpen || /\{\{\w+\}\}/.test(report.dayOpen)) { console.error("day-open has unfilled placeholders"); process.exit(1); }
' "$WORK"); then
  pass "rollover archived + assembled the day-open message"
  # It went to the temp inject dir, never the live one.
  if [[ -f "$WORK/inject/2099-01-01-day-open.md" ]]; then
    pass "day-open queued ($(wc -c <"$WORK/inject/2099-01-01-day-open.md") bytes, temp dir only)"
  else
    fail "day-open queued"
  fi
else
  fail "rollover on a faked date"
fi
printf '      note: this killed the live companion pi session; qcr tui respawns it.\n'

# --- 7. down -----------------------------------------------------------------
step "qcr companion down"
if "$QCR" companion down >"$WORK/down.log" 2>&1; then pass "qcr companion down: $(tail -1 "$WORK/down.log")"; else fail "qcr companion down"; fi
if docker volume inspect "$PIHOME" >/dev/null 2>&1; then pass "pihome volume $PIHOME survived the stop"; else fail "pihome volume $PIHOME survived the stop"; fi

printf '\n=== companion smoke: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[[ "$FAIL" -eq 0 ]]
