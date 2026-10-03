#!/usr/bin/env node
// Is the daemon's heartbeat from the container that is running NOW?
//
// deploy.sh's post-deploy check used to `cat status.json` and pass on any
// file at all. On 2026-10-03 a sync reported "deploy ok" over a daemon
// crash-looping at startup: the file it read was the OLD daemon's last write
// (made while ansible was still rsyncing, so even "written after the deploy
// started" would have passed it). The only reference that cannot be fooled
// that way is the container's own start: a heartbeat written after it came
// from this boot, and one that is also recent says the daemon is still alive.
//
// stdin, all from ONE ssh call so every timestamp is the VM's own clock:
//   line 1  the container's .State.StartedAt (docker inspect)
//   line 2  the VM's current time (date -u +%Y-%m-%dT%H:%M:%SZ)
//   rest    status.json
// Exit 0 fresh, 1 stale (one line on stdout says why), 2 unreadable.

const MAX_AGE_S = Number(process.env.QC_HEARTBEAT_MAX_AGE_S ?? 90);

let input = "";
for await (const chunk of process.stdin) input += chunk;
const [startedLine = "", nowLine = "", ...rest] = input.split("\n");

const started = Date.parse(startedLine.trim());
const now = Date.parse(nowLine.trim());
let written = NaN;
try {
  written = Date.parse(JSON.parse(rest.join("\n")).written_at);
} catch {
  // falls through as unreadable
}

if (Number.isNaN(started) || Number.isNaN(now)) {
  console.log("unreadable: no container start time or VM clock reading");
  process.exit(2);
}
if (Number.isNaN(written)) {
  console.log("unreadable: status.json is missing, not JSON, or has no written_at");
  process.exit(2);
}
if (written < started) {
  console.log(
    `stale: last heartbeat ${new Date(written).toISOString()} predates the container start ` +
      `${new Date(started).toISOString()} — the daemon has not written one since this boot`,
  );
  process.exit(1);
}
const age = Math.round((now - written) / 1000);
if (age > MAX_AGE_S) {
  console.log(`stale: last heartbeat is ${age}s old (limit ${MAX_AGE_S}s) — the daemon stopped writing it`);
  process.exit(1);
}
console.log(`fresh: written ${age}s ago, after the container started`);
process.exit(0);
