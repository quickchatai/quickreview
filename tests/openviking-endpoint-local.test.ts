// `[openviking] endpoint = local` is today's behaviour, byte for byte.
//
// The memory sidecar (docker/memory/) lets the daemon talk to a server it does
// not supervise (`endpoint = "remote"`). Until the VM flips, every live daemon
// runs `local`: the server and the local embedder are children of the daemon,
// with the start gate, the restart ladder, the heartbeat blocks and the log
// lines they have always had. This file replays one scripted lifetime of each
// supervisor and holds the whole transcript (log lines, spawn calls, timer
// delays, every status() block) against a golden recorded from the supervisors
// BEFORE the endpoint switch existed (tests/fixtures/openviking-local-transcript.json).
// An absent `endpoint` and an explicit "local" must both reproduce it.
//
// Regenerate the golden only on purpose: QCR_REGEN_GOLDEN=1 npx vitest run
// tests/openviking-endpoint-local.test.ts — and only from a supervisor whose
// local behaviour you mean to change.
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPENVIKING_DEFAULTS,
  resolveOpenVikingPaths,
  type OpenVikingConfig,
} from "../src/config.js";
import {
  LocalEmbedderSupervisor,
  OpenVikingSupervisor,
  memoryServing,
  type FetchLike,
  type SupervisedChild,
} from "../src/openviking/index.js";

const GOLDEN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "openviking-local-transcript.json",
);

class FakeChild extends EventEmitter implements SupervisedChild {
  readonly pid: number | undefined;
  stdout = new EventEmitter() as unknown as SupervisedChild["stdout"];
  stderr = new EventEmitter() as unknown as SupervisedChild["stderr"];
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.emit("exit", 0, signal);
    return true;
  }
  say(text: string): void {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text));
  }
}

class FakeClock {
  pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { fn, ms, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  live(): Array<{ fn: () => void; ms: number; cancelled: boolean }> {
    return this.pending.filter((p) => !p.cancelled);
  }
  /** Fire the most recently scheduled live callback. */
  fireLast(): void {
    const entry = this.live().at(-1);
    if (!entry) throw new Error("nothing scheduled");
    entry.cancelled = true;
    entry.fn();
  }
  get delays(): number[] {
    return this.live().map((p) => p.ms);
  }
}

const cfgOf = (over: Partial<OpenVikingConfig>): OpenVikingConfig =>
  resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, ...over });

const RENDERED_LOCAL = JSON.stringify({
  embedding: { dense: { provider: "openai", api_base: "http://127.0.0.1:1934/v1" } },
});

/** One scripted lifetime of both supervisors, recorded step by step. */
async function transcript(over: Partial<OpenVikingConfig>): Promise<unknown> {
  const cfg = cfgOf(over);
  const log: string[] = [];
  const steps: Array<{ step: string; [k: string]: unknown }> = [];
  const clock = new FakeClock();
  const spawns: Array<{ cmd: string; args: string[]; cwd?: string; conf?: string }> = [];
  const children: FakeChild[] = [];
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 9, 19, 10, 0, tick++));
  let serverUp = false;
  let embedderUp = false;
  const fetchFn: FetchLike = async (url) => {
    const ok = url.includes("1934") ? embedderUp : serverUp;
    return {
      ok,
      status: ok ? 200 : 503,
      json: async () => ({ version: cfg.version }),
    };
  };
  const spawn = (
    cmd: string,
    args: string[],
    o: { cwd?: string; env: NodeJS.ProcessEnv },
  ): SupervisedChild => {
    spawns.push({
      cmd,
      args,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      ...(o.env.OPENVIKING_CONFIG_FILE ? { conf: o.env.OPENVIKING_CONFIG_FILE } : {}),
    });
    const child = new FakeChild(2000 + children.length);
    children.push(child);
    return child;
  };

  const embedder = new LocalEmbedderSupervisor({
    cfg,
    repoRoot: "/opt/quickreview/sandbox",
    log: (m) => log.push(m),
    spawn,
    fetchFn,
    now,
    exists: () => true,
    readOvConf: () => RENDERED_LOCAL,
    schedule: clock.schedule,
  });
  const server = new OpenVikingSupervisor({
    cfg,
    log: (m) => log.push(m),
    spawn,
    fetchFn,
    now,
    exists: () => true,
    schedule: clock.schedule,
    onReady: () => log.push("onReady"),
    startGate: { open: () => embedder.gateOpen(), maxWaitMs: 120_000, what: "the local embedder" },
  });
  const snap = (step: string): void => {
    const e = embedder.status();
    steps.push({
      step,
      embedder: e,
      server: server.status(),
      serving: memoryServing(cfg.embedding_provider, server.status(), e),
      delays: clock.delays,
      gateOpen: embedder.gateOpen(),
    });
  };

  embedder.start();
  server.start();
  snap("started: embedder spawned, server held by the gate");
  embedderUp = true;
  await embedder.probe();
  snap("embedder answers /health");
  clock.fireLast(); // the server's gate poll
  snap("gate poll: server spawned");
  children[1]!.say("INFO listening\npartial");
  children[1]!.say(" line\n");
  serverUp = true;
  await server.poll();
  snap("server /ready");
  children[1]!.emit("exit", 1, null);
  snap("server crash");
  clock.fireLast(); // the respawn
  snap("server respawned");
  children[0]!.emit("exit", null, "SIGKILL");
  snap("embedder crash");
  await server.stop();
  await embedder.stop();
  snap("stopped");
  return { log, spawns, steps };
}

describe("endpoint = local is today's supervisor behaviour", () => {
  const regen = process.env.QCR_REGEN_GOLDEN === "1";

  it("an absent endpoint reproduces the pre-switch transcript", async () => {
    const got = JSON.parse(JSON.stringify(await transcript({})));
    if (regen || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
    }
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  });

  it("an explicit endpoint = local is the same transcript", async () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    const got = JSON.parse(
      JSON.stringify(await transcript({ endpoint: "local" } as Partial<OpenVikingConfig>)),
    );
    expect(got).toEqual(golden);
  });

  it("the local status blocks carry no endpoint field", () => {
    const golden = readFileSync(GOLDEN, "utf8");
    expect(golden).not.toContain('"endpoint"');
  });
});
