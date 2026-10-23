// `npm run smoke:worker` — the scripted smoke for the daemon↔worker boundary.
// It replaces smoke-session.ts, which birthed a REAL tmux + pi session and needed the
// VM container and a model. This one needs neither: the worker (src/botworker.ts) runs
// on pi's real SDK over pi-ai's faux provider, a fake daemon (a real IpcServer on a real
// unix socket) hands it its spec and records what it reports, and the offline guard
// fails the file on any connection attempt.
//
// What it shows, as the old smoke did for tmux: an order reaches the session and the
// reply lands in the session JSONL under the agreed marker. And what only a worker has:
//   - BIRTH: no JSONL yet; the worker opens one, and reports ready with a new id;
//   - ROUND: the order goes in with the command's marker, the worker reports accepted,
//     usage, compacted and done, and exits 0;
//   - RESUME: the next round is another worker over the SAME file, the same id.
// Kept to one file and a few seconds so a build can run it under `timeout`.
import { closeSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { EXIT, jsonlHasMarker, runBotWorker, type WorkerDeps } from "../src/botworker.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { createCapabilityFd, ipcEnv, runDirOf } from "../src/ipc/capability.js";
import { sessionCommandMarker } from "@quickchatai/pi-quickreview/src/session-command.js";
import { newestSessionFile } from "../src/sessionjsonl.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import { FakeDaemon, buildWorld, type World } from "./helpers/worker-rig.js";

useOfflineGuard();

const MARKER = "QCR-SMOKE-OK";

let world: World;
let daemon: FakeDaemon;
let faux: FauxProviderHandle;
let hosts: PiHost[];
let capFds: number[];

beforeEach(async () => {
  world = buildWorld("smoke-worker-");
  daemon = new FakeDaemon();
  await daemon.start();
  faux = fauxProvider();
  hosts = [];
  capFds = [];
});
afterEach(async () => {
  for (const fd of capFds) closeSync(fd);
  for (const h of hosts) h.dispose();
  await daemon.stop();
  rmSync(world.dir, { recursive: true, force: true });
});

/** One worker for one command: the order is the user turn, the faux model answers the marker. */
async function smokeRound(id: string, order: string): Promise<{ code: number; marker: string }> {
  faux.setResponses([fauxAssistantMessage(MARKER)]);
  const spec = world.spec(id, order);
  daemon.command(spec);
  const fd = createCapabilityFd(runDirOf(world.dir), daemon.caps.get(id)!);
  capFds.push(fd);
  const deps: WorkerDeps = {
    env: {
      PATH: process.env["PATH"],
      ...ipcEnv({ socketPath: daemon.sock, commandId: id, generation: 1, capFdIndex: fd }),
    },
    connect: () => daemon.connect(id),
    makeHost: async (o) => {
      const host = await PiHost.create({
        agentDir: o.agentDir,
        settings: { compaction: { enabled: false }, retry: { enabled: false } },
        configureModels: (r) => {
          r.registerNativeProvider(faux.provider);
        },
      });
      hosts.push(host);
      return host;
    },
    openViking: (c) => ({ ...c, config: { ...c.config, enabled: false } }),
  };
  const code = await runBotWorker({ command: id, mode: "round" }, deps);
  // The worker's last events are on the wire when it returns; the fake daemon reads them a tick later.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { code, marker: sessionCommandMarker(id, spec.payload_sha256) };
}

/** True when an assistant message of the JSONL says exactly the marker, as the old smoke checked. */
function assistantSaid(file: string, text: string): boolean {
  return readFileSync(file, "utf8")
    .split("\n")
    .some((line) => {
      try {
        const entry = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
        const m = entry.message;
        if (m?.role !== "assistant" || !Array.isArray(m.content)) return false;
        return (
          m.content
            .filter((p: { type?: string }) => p?.type === "text")
            .map((p: { text?: string }) => p.text ?? "")
            .join("")
            .trim() === text
        );
      } catch {
        return false;
      }
    });
}

describe("a worker's birth and round on the faux provider", () => {
  it("is born, runs the order, answers the marker into the JSONL and exits 0; the next worker resumes the same file", async () => {
    // BIRTH + ROUND
    const first = await smokeRound(
      "smoke-1",
      "Hello from the smoke test. Reply with the marker.\n",
    );
    expect(first.code).toBe(EXIT.ok);
    const kinds = daemon.kinds();
    for (const [a, b] of [
      ["ready", "accepted"],
      ["accepted", "compacted"],
      ["compacted", "done"],
    ] as const)
      expect(kinds.indexOf(a), `${a} before ${b}`).toBeLessThan(kinds.indexOf(b));
    expect(kinds).not.toContain("failed");
    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: false, continued: false });
    expect(daemon.of("usage").length).toBeGreaterThan(0);

    const files = readdirSync(world.sessionDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const file = join(world.sessionDir, files[0]!);
    const id = (JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as { id: string }).id;
    expect(daemon.of("ready")[0]!.body["session_id"]).toBe(id);
    expect(jsonlHasMarker(file, first.marker)).toBe(true);
    expect(assistantSaid(file, MARKER)).toBe(true);

    // RESUME: a fresh worker over the same JSONL.
    daemon.events.length = 0;
    const second = await smokeRound("smoke-2", "Again. Reply with the marker.\n");
    expect(second.code).toBe(EXIT.ok);
    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: true, session_id: id });
    expect(readdirSync(world.sessionDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    expect(newestSessionFile(world.sessionDir)).toBe(file);
    expect(jsonlHasMarker(file, second.marker)).toBe(true);
    expect(readFileSync(file, "utf8").split(MARKER).length - 1).toBeGreaterThanOrEqual(2);
  });
});
