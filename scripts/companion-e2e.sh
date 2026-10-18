#!/usr/bin/env bash
# companion-e2e.sh — the scripted end-to-end for the local companion.
#
# What it proves, with a REAL container and REAL files (no vitest mocks):
#   1. docker/companion builds (from the app root);
#   2. the container comes up with feed/alerts bind mounts and a tmux server;
#   3. a "model turn" inside the container can write a schema-valid alert file
#      into /alerts, and the host sees it;
#   4. the TUI-side consumer routes that alert: status line + notify + overseer
#      inject (both side effects captured into log files, nothing is sent
#      anywhere — the real notify-send and the real ssh inject are replaced by
#      fakes, so this script can never message the VM);
#   5. a canned feed change is classified meaningful, an unchanged board is
#      not, and the ambient feed never mints a `wake` marker (the ambient
#      feed never wakes pi);
#   6. the daily rollover, driven by QCR_FAKE_TODAY, archives + queues the
#      day-open message inside that container.
#
# Requires docker. Does NOT require pi auth: the one step that needs a real
# `/login` (spawning pi in the container) is reported SKIPPED when
# <pihome volume>/agent/auth.json is absent.
#
# Nothing here touches the VM, GitHub, or the persistent companion state: a
# throwaway container, a temp image tag and temp dirs, all removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
IMAGE="qcr-companion-e2e"
CONTAINER="qcr-companion-e2e-$$"
PIHOME_VOLUME="${QCR_PIHOME_VOLUME:-companion-pihome}"
WORK="$(mktemp -d -t qcr-companion-e2e-XXXXXX)"
FEED="$WORK/feed"
ALERTS="$WORK/alerts"
STATE="$WORK/state"
INJECT="$WORK/inject/companion"
mkdir -p "$FEED" "$ALERTS" "$STATE" "$INJECT"

PASS=0
FAIL=0
SKIP=0

pass() { printf 'PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf 'SKIP  %s\n' "$1"; SKIP=$((SKIP + 1)); }
step() { printf '\n--- %s\n' "$1"; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "companion-e2e: docker is required" >&2; exit 2; }

# --- 0. the code under test must be built ------------------------------------
step "build (tsc)"
if (cd "$ROOT" && npm run --silent build); then pass "npm run build"; else fail "npm run build"; fi

# The app's build stamp (src/appstamp.ts) for the image's qcr.build-sha label —
# what the scan sandbox compares with the checkout before it runs a driver.
app_stamp() {
  node --input-type=module -e 'const m = await import(process.argv[1]); console.log(m.appStamp(process.argv[2]));' \
    "$1/dist/src/appstamp.js" "$1"
}

# --- 1. image ----------------------------------------------------------------
step "docker build docker/companion"
# From the app root: the image copies the build above.
if docker build -t "$IMAGE" -f "$ROOT/docker/companion/Dockerfile" \
  --build-arg COMPANION_UID="$(id -u)" --build-arg BUILD_SHA="$(app_stamp "$ROOT")" \
  "$ROOT" >"$WORK/build.log" 2>&1; then
  pass "image $IMAGE builds"
else
  fail "image $IMAGE builds (see $WORK/build.log)"
  tail -20 "$WORK/build.log" >&2 || true
  printf '\n%s\n' "aborting: nothing below can run without the image"
  exit 1
fi

# --- 2. throwaway container --------------------------------------------------
step "container up"
if docker run --detach --name "$CONTAINER" \
    --volume "$ROOT:/workspace:ro" \
    --volume "$FEED:/feed:rw" \
    --volume "$ALERTS:/alerts:rw" \
    "$IMAGE" >/dev/null 2>&1; then
  pass "container $CONTAINER started"
else
  fail "container $CONTAINER started"
  exit 1
fi
if docker exec "$CONTAINER" tmux -V >/dev/null 2>&1; then
  pass "tmux server reachable in the container"
else
  fail "tmux server reachable in the container"
fi

# --- 3. a model turn writes an alert -----------------------------------------
step "companion writes an alert file"
ALERT_NAME="2026-08-14T09-00-00Z-round-overdue.json"
# -i is load-bearing: without it the heredoc never reaches the container and the
# file lands empty (which the consumer then reports as a malformed alert).
docker exec -i "$CONTAINER" sh -c "cat > /alerts/.tmp.json && mv /alerts/.tmp.json '/alerts/$ALERT_NAME'" <<'ALERT'
{
  "tier": "alert",
  "cause": "round-overdue",
  "pr": "5012",
  "title": "PR #5012 round overdue by 41 min",
  "body": "reviewing since 08:10; round deadline 30 min.",
  "ts": "2026-08-14T09:00:00Z"
}
ALERT
if [[ -f "$ALERTS/$ALERT_NAME" ]]; then
  pass "alert file visible on the host through the bind mount"
else
  fail "alert file visible on the host through the bind mount"
fi

# --- 4/5/6. the TUI side, driven by the compiled modules ---------------------
cat > "$WORK/consume.mjs" <<'NODE'
// Drives the real consumer/feed/rollover code against the real files this
// script just created. Prints one `PASS|…` / `FAIL|…` line per assertion.
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [root, feed, alerts, state, inject, container] = process.argv.slice(2);
const out = [];
const check = (ok, what) => out.push(`${ok ? "PASS" : "FAIL"}|${what}`);

const { AlertConsumer, AlertPolicy, filePolicyStore } = await import(join(root, "dist/src/tui/alerts.js"));
const { FeedWriter } = await import(join(root, "dist/src/tui/feed.js"));
const { CompanionRollover } = await import(join(root, "dist/src/tui/rollover.js"));
const { COMPANION_DEFAULTS } = await import(join(root, "dist/src/config.js"));

// ---- 4. alert routing -------------------------------------------------------
const notifyLog = join(state, "notify.log");
const injectLog = join(state, "inject.log");
const notices = [];
const consumer = new AlertConsumer(alerts, new AlertPolicy(20, () => new Date(), filePolicyStore(join(state, "alert-policy.json"))), {
  notice: (t) => notices.push(t),
  badge: () => {},
  // Fakes on purpose: the real ones would light up KDE and message the VM.
  notify: (title, body) => writeFileSync(notifyLog, `${title}\n${body}\n`),
  inject: (text) => writeFileSync(injectLog, text),
});
consumer.scanOnce();
check(consumer.badge.count === 1, "alert routed (badge count 1)");
check(notices.some((n) => n.includes("#5012")), "status line names the PR");
check(existsSync(notifyLog) && readFileSync(notifyLog, "utf8").includes("overdue"), "tier alert → desktop notification");
check(existsSync(injectLog) && readFileSync(injectLog, "utf8").startsWith("[companion alert]"), "tier alert → overseer inject payload");
check(readdirSync(join(alerts, ".done")).length === 1, "consumed alert archived to .done/");

// ---- 5. a feed change is classified, and the ambient feed never wakes pi ----
const writer = new FeedWriter(feed);
const snap = (round) => ({
  written_at: new Date().toISOString(),
  dry_run: true,
  prs: [{ number: 5012, state: "reviewing", title: "add retries", head_sha: "a", stale_recheck: false, rounds: round }],
  running_rounds: round,
  total_spend_usd: 1,
  digest_headline: "e2e digest",
  heartbeat: new Date().toISOString(),
});
writer.write(snap(1), [], "ok");
const first = writer.write(snap(2), [{ ts: "2026-08-14T09:05:00Z", kind: "round_started", pr: 5012, payload: null }], "ok");
check(first.meaningful, "a real board change is meaningful");
// There is no `/feed/wake` → pi.sendUserMessage path (it would interrupt an
// active turn), and `FeedWriter.start` DELETES any stale marker. The live
// contract: the ambient feed never wakes pi.
check(!existsSync(join(feed, "wake")), "the ambient feed never mints a wake marker");
const quiet = writer.write(snap(2), [], "ok");
check(!quiet.meaningful, "an unchanged board wakes nobody");

// ---- 6. rollover on a faked day --------------------------------------------
const cfg = { ...COMPANION_DEFAULTS, container_name: container, repo_dir: root, feed_dir: feed, alerts_dir: alerts };
const docker = await import("node:child_process");
const runner = (argv) =>
  new Promise((res) => {
    const p = docker.spawn("docker", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => res({ ok: code === 0, stdout, stderr, code }));
    p.on("error", () => res({ ok: false, stdout, stderr, code: null }));
  });
mkdirSync(inject, { recursive: true });
// "Yesterday" must be the day the alert-policy state above was written, so the
// carried-over-cause path is real: today = that day + 1, faked.
const { todayDate } = await import(join(root, "dist/src/tui/rollover.js"));
const yesterday = todayDate(new Date(), {});
const tomorrow = todayDate(new Date(Date.now() + 86_400_000), {});
writeFileSync(join(state, "rollover.json"), JSON.stringify({ last_open_date: yesterday, updated_at: "" }));
// An unread alert file left in the dir is also "unresolved".
writeFileSync(
  join(alerts, "2026-08-14T09-30-00Z-daemon-stale.json"),
  JSON.stringify({ tier: "notice", cause: "daemon-stale", pr: null, title: "status.json is 9 min old", body: "" }),
);
const ro = new CompanionRollover(cfg, runner, {
  statePath: join(state, "rollover.json"),
  policyStatePath: join(state, "alert-policy.json"),
  templatePath: join(root, "prompts/companion-day-open.md"),
  injectDir: inject,
  env: { QCR_FAKE_TODAY: tomorrow },
});
const report = await ro.run();
check(report.verdict.kind === "rollover", "faked date triggers a rollover");
const dayOpen = report.dayOpenFile ? readFileSync(report.dayOpenFile, "utf8") : "";
check(dayOpen.includes(tomorrow), "day-open carries the date");
check(dayOpen.includes("e2e digest"), "day-open carries the digest headline");
check(dayOpen.includes("1 tracked PR"), "day-open carries the live snapshot");
check(dayOpen.includes("status.json is 9 min old"), "day-open carries the unread alert file");
check(dayOpen.includes("round-overdue"), "day-open carries the cause carried over from yesterday");
check(!/\{\{\w+\}\}/.test(dayOpen), "no placeholder left unfilled");
check((await ro.run()).verdict.kind === "same-day", "a second run the same day is a no-op");

console.log(out.join("\n"));
NODE

step "alert routing, wake gate, rollover (compiled modules over the real files)"
if node "$WORK/consume.mjs" "$ROOT" "$FEED" "$ALERTS" "$STATE" "$INJECT" "$CONTAINER" > "$WORK/consume.out" 2>"$WORK/consume.err"; then
  while IFS='|' read -r verdict what; do
    [[ -z "${what:-}" ]] && continue
    if [[ "$verdict" == "PASS" ]]; then pass "$what"; else fail "$what"; fi
  done < "$WORK/consume.out"
else
  fail "node consumer harness ran"
  tail -20 "$WORK/consume.err" >&2 || true
fi

# --- 7. pi spawn — only when /login has been done -----------------------------
step "pi session (needs a one-time /login)"
if docker volume inspect "$PIHOME_VOLUME" >/dev/null 2>&1 &&
   docker run --rm --volume "$PIHOME_VOLUME:/pi:ro" --entrypoint sh "$IMAGE" -c 'test -f /pi/agent/auth.json' >/dev/null 2>&1; then
  if docker exec "$CONTAINER" sh -c 'command -v pi' >/dev/null 2>&1; then
    pass "pi is on PATH in the image"
  else
    fail "pi is on PATH in the image"
  fi
  skip "pi turn (auth present, but a real turn spends money — run npm run smoke:companion)"
else
  skip "pi spawn — no $PIHOME_VOLUME/agent/auth.json (run /login once inside the companion)"
fi

printf '\n=== companion E2E: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[[ "$FAIL" -eq 0 ]]
