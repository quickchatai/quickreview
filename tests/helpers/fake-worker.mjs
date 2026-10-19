// A stand-in for dist/src/botworker.js (P8.5): the same invocation, the same
// handshake, no pi and no model. It speaks the worker side of the IPC with plain
// node (so no build is needed), and what it does after the handshake is chosen by
// FAKE_WORKER_MODE in its env:
//
//   ok        ready, accepted, one heartbeat, done; exit 0
//   busy      ready, accepted, then a blocking loop that ignores SIGTERM
//   term-ok   ready, accepted, heartbeats until SIGTERM, then exit 143
//   silent    ready, then nothing at all, alive for a minute
//   crash     ready, accepted, then SIGKILL on itself
//   exit2     ready, accepted, then exit 2 with no `failed` event (a non-zero exit)
//   posted-crash  ready, accepted, a `posted` event, then SIGKILL on itself
//   fail      ready, a `failed` event, exit 1
//   env       writes its env and the capability it read to FAKE_WORKER_OUT, then ok
//   stale     sends a request and an event for generation - 1, records the codes, then ok
//   mute      never connects: alive for a minute
//   group     spawns a sleeping child in its own group, records its pid, then busy
//   permit-crash  ready, accepted, takes two lens permits from the broker (P8.10),
//             records the answers, then SIGKILL on itself
//
//   controls  ready, accepted, then heartbeats until the daemon pushes a control (P8.12):
//             steer and follow_up are recorded and acked `queued`; abort is recorded,
//             acked `handled`, followed by a `failed` event and exit 6
//   refuse    as controls, but acks every steer and follow_up `refused`
//   deaf      ready, accepted, heartbeats, and ignores controls and SIGTERM: only
//             the SIGKILL of the group ends it
//
// FAKE_WORKER_OUT is a directory it may write to; FAKE_WORKER_BEAT_MS the beat.
import { spawn } from "node:child_process";
import { readSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const env = process.env;
const mode = env.FAKE_WORKER_MODE ?? "ok";
const out = env.FAKE_WORKER_OUT ?? "";
const beatMs = Number(env.FAKE_WORKER_BEAT_MS ?? "50");
const argv = process.argv.slice(2);
const commandId = argv[argv.indexOf("--command") + 1];
const record = (name, value) => {
  if (out) writeFileSync(join(out, `${commandId}.${name}`), typeof value === "string" ? value : JSON.stringify(value));
};

const buf = Buffer.alloc(64);
const n = readSync(Number(env.QCR_IPC_CAP_FD), buf, 0, 64, 0);
const capability = buf.subarray(0, n).toString("utf8").trim();
let generation = Number(env.QCR_IPC_GENERATION);

if (mode === "term-ok") process.on("SIGTERM", () => process.exit(143));
if (mode === "busy" || mode === "group" || mode === "deaf") process.on("SIGTERM", () => {});
if (mode === "env") {
  record("env.json", { env, argv, cwd: process.cwd() });
  record("cap.txt", capability);
}

if (mode === "mute") setTimeout(() => {}, 60_000);
const sock = mode === "mute" ? new net.Socket() : net.connect(env.QCR_IPC_SOCKET);
let pending = "";
const waiting = new Map();
let nextId = 1;
const send = (m) => sock.write(JSON.stringify({ v: "1.0", ...m }) + "\n");
const request = (op, gen = generation, body = undefined) =>
  new Promise((resolve) => {
    const id = String(nextId++);
    waiting.set(id, resolve);
    send({ type: "request", id, op, generation: gen, ...(body === undefined ? {} : { body }) });
  });
const event = (kind, body = {}, gen = generation) => send({ type: "event", kind, generation: gen, body });
const errors = [];

sock.on("data", (chunk) => {
  pending += chunk.toString();
  let nl;
  while ((nl = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    const m = JSON.parse(line);
    if (m.type === "hello_ok") onHello(m);
    else if (m.type === "response") waiting.get(m.id)?.(m);
    else if (m.type === "error") errors.push(m.error.code);
    else if (m.type === "control") onControl(m);
  }
});
sock.on("close", () => process.exit(75));
if (mode !== "mute")
  sock.on("connect", () =>
    send({ type: "hello", role: "worker", command_id: commandId, capability }),
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = [];
async function onControl(m) {
  if (mode !== "controls" && mode !== "refuse") return;
  seen.push({ kind: m.kind, body: m.body });
  record("controls.json", seen);
  const id = m.body.id;
  if (m.kind === "abort") {
    await request("control.ack", generation, { id, ack: "handled" });
    event("failed", { code: 6, reason: "the round was aborted by the operator" });
    await new Promise((r) => sock.write("", r));
    process.exit(6);
  }
  if (mode === "refuse")
    await request("control.ack", generation, { id, ack: "refused", reason: "the round is ending" });
  else await request("control.ack", generation, { id, ack: "queued" });
}

async function onHello(m) {
  generation = m.generation;
  const spec = await request("worker.spec");
  if (!spec.ok) {
    record("spec-error.txt", spec.error.code);
    process.exit(3);
  }
  record("spec.json", spec.body);
  event("ready", { session_id: "fake-session" });
  if (mode === "silent") {
    await sleep(60_000);
    process.exit(0);
  }
  if (mode === "fail") {
    event("failed", { code: 1, reason: "the fake turn failed" });
    await sleep(50);
    process.exit(1);
  }
  event("accepted", { command_id: commandId });
  if (mode === "stale") {
    const r = await request("worker.spec", generation - 1);
    record("stale-request.txt", r.ok ? "accepted" : r.error.code);
    event("progress", { stage: "stale" }, generation - 1);
    await sleep(100);
    record("stale-event.txt", errors.join(","));
  }
  if (mode === "crash") process.kill(process.pid, "SIGKILL");
  if (mode === "exit2") process.exit(2);
  if (mode === "posted-crash") {
    event("posted", { script: "post-review.sh" });
    await sleep(50);
    process.kill(process.pid, "SIGKILL");
  }
  if (mode === "permit-crash") {
    const a = await request("permits.acquire", generation, { lens_id: "L1", weight: 1 });
    const b = await request("permits.acquire", generation, { lens_id: "L2", weight: 1 });
    record("permits.json", [a.ok, b.ok]);
    process.kill(process.pid, "SIGKILL");
  }
  if (mode === "group") {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    record("grandchild.txt", String(child.pid));
  }
  if (mode === "busy" || mode === "group") {
    event("progress", { stage: "heartbeat" });
    await sleep(100);
    for (;;);
  }
  if (mode === "term-ok" || mode === "controls" || mode === "refuse" || mode === "deaf") {
    setInterval(() => event("progress", { stage: "heartbeat" }), beatMs);
    await sleep(60_000);
  }
  event("progress", { stage: "heartbeat" });
  event("verdict_written", {});
  event("done", { session_id: "fake-session" });
  await new Promise((r) => sock.write("", r));
  process.exit(0);
}
