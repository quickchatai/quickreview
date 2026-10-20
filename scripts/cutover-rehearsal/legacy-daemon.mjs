// The legacy bot, as far as the cutover can see it (P8.20). A STAND-IN, not the legacy daemon:
// it runs inside a container whose image carries no qcr.layout label (so every consumer reads
// "legacy"), over the legacy-shaped host directory, and speaks the contract the updater and the
// operator's tools hold the legacy bot to:
//
//   - the heartbeat <state>/status.json (written_at; `draining` only while draining; draining_by;
//     running_rounds; pending_wakes), refreshed every 2 s;
//   - the operator channel <sandbox>/commands/operator/*.json -> <sandbox>/commands/results/<base>.result.json,
//     with the legacy daemon's STRICT schema: a `drain` carrying a `hold` field is refused;
//   - the deploy-window behaviour the updater's RESCUE leans on: the boot's first healthy reconcile
//     LIFTS a standing drain (daemon.ts of the legacy build, "Deploy-window drain auto-lift").
//
// The state is the real thing: the db is opened and written by the LEGACY build's own StateStore
// (commit 8169df6f, mounted read-only at /opt/legacy/dist), so every drain it engages or lifts is the
// legacy code's row, in the legacy schema, and a failed cutover leaves the file legacy-shaped.
// Nothing here posts, reviews or reaches a network (the container runs --network none).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const { StateStore } = await import("/opt/legacy/dist/src/state.js");
const STATE = "/opt/quickreview/state";
const CMD = "/opt/quickreview/sandbox/commands";
const log = (m) => console.log(`[legacy-standin ${new Date().toISOString()}] ${m}`);

const store = new StateStore(`${STATE}/state.db`);
mkdirSync(`${CMD}/operator`, { recursive: true });
mkdirSync(`${CMD}/results`, { recursive: true });

const heartbeat = () => {
  const d = store.drainState();
  const wakes = store.db.prepare("SELECT COUNT(*) c FROM pending_wakes").get().c;
  const body = {
    written_at: new Date().toISOString(),
    running_rounds: 0,
    pending_wakes: wakes,
    build: "legacy-standin",
    ...(d.draining
      ? { draining: true, draining_by: d.issued_by, ...(d.expires_at ? { draining_until: d.expires_at } : {}) }
      : {}),
  };
  const tmp = `${STATE}/.status.json.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, `${STATE}/status.json`);
};

const answer = (base, obj) =>
  writeFileSync(`${CMD}/results/${base}.result.json`, `${JSON.stringify(obj, null, 2)}\n`);

const poll = () => {
  let names = [];
  try {
    names = readdirSync(`${CMD}/operator`).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const file = `${CMD}/operator/${name}`;
    const base = name.replace(/\.json$/, "");
    // The operator directory is root-owned and this daemon is not root (the sealed channel): it cannot
    // remove a command it has served. A command is served once, and its result file says so.
    if (existsSync(`${CMD}/results/${base}.result.json`)) continue;
    let cmd;
    try {
      cmd = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      answer(base, { ok: false, reason: `unreadable command: ${e.message}` });
      continue;
    }
    if (cmd.command !== "drain") {
      answer(base, { ok: false, reason: `the legacy stand-in only knows drain (got ${cmd.command})` });
    } else if (Object.keys(cmd).some((k) => !["command", "on", "for_min"].includes(k))) {
      // the legacy command schema is strict: `hold` (P8.21b) is a field it has never heard of
      answer(base, { ok: false, reason: `unknown field in drain command: ${Object.keys(cmd).filter((k) => !["command", "on", "for_min"].includes(k)).join(",")}` });
    } else if (cmd.on === true) {
      const r = store.engageDrain({ issuer: "operator", expires_at: null });
      log(`drain on by the operator (${r.outcome})`);
      answer(base, { ok: true, command: "drain", draining: true, running_rounds: 0, issuer: "operator", dropped_deliveries: 0 });
    } else {
      const r = store.liftDrain("operator");
      log(`drain off by the operator (changed=${r.changed})`);
      answer(base, { ok: true, command: "drain", draining: false, running_rounds: 0, dropped_deliveries: r.dropped });
    }
    heartbeat();
  }
};

// The boot: a first reconcile after a few seconds, healthy, which lifts a deploy drain.
log(`booted; drain at boot: ${JSON.stringify(store.drainState())}`);
heartbeat();
setTimeout(() => {
  const standing = store.drainState();
  log("reconcile: open=0 triggered=0 closed=0 captured=0 corrections=0 errors=0");
  if (standing.draining) {
    const r = store.liftDrain("operator");
    log(`drain_lifted — the boot's first healthy reconcile lifted the deploy drain (changed=${r.changed})`);
  }
  heartbeat();
}, 3000);
setInterval(heartbeat, 2000);
setInterval(poll, 500);

const stop = () => {
  try {
    store.db.close();
  } catch {}
  log("stopped");
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
