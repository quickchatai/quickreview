// [P8.3] The bot's per-round worker (src/botworker.ts), on pi's REAL SDK over
// pi-ai's faux provider: no model, no network. A fake daemon (a real IpcServer on a
// real unix socket) answers the worker's spec and wakes requests and records every
// event; the model's bash runs the real commit-verdict.sh and the post scripts
// (which hand over to a stub post client that records what the shim would carry).
//
// What is pinned, against the ticket's verify:
//   - a scripted round commits its verdict and posts, and the daemon is told
//     (verdict_written, posted) in the order a round emits its events;
//   - the resumed id is the JSONL's id, and a second round appends to the SAME file;
//   - lens JSONLs are written beside the round's lens ledger (D10);
//   - held wakes are delivered before exit, in order, and acked one by one;
//   - ledger-pin's session_before_compact fires at the end of the round;
//   - a worker that died mid-round is continued, not given the order again;
//   - the borrowed login carries the disabled refresh token and is never written
//     back, and a token that would expire inside the worker's cap is refused;
//   - nothing runs on a payload that is not what the daemon dispatched.
import { closeSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  EXIT,
  continuationText,
  jsonlHasMarker,
  parseWorkerArgs,
  runBotWorker,
  wakeMarker,
  type WorkerDeps,
} from "../src/botworker.js";
import { createCapabilityFd, ipcEnv, runDirOf } from "../src/ipc/capability.js";
import { DISABLED_REFRESH } from "../src/engine/auth.js";
import { PiHost, type PiHostOptions } from "../src/engine/pisdk.js";
import { parseWorkerSpec, type WorkerSpec } from "../src/ipc/workerspec.js";
import { TranscriptIndex } from "../src/transcriptindex.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { newestSessionFile } from "../src/sessionjsonl.js";
import { pricedFaux } from "./helpers/priced-faux.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import {
  FakeDaemon,
  buildWorld,
  writeTasks,
  type WorkerEvent,
  type World,
} from "./helpers/worker-rig.js";

useOfflineGuard();

type Step = FauxResponseStep;
/** What the faux model answers, by who asks: the main session, each lens pass (by
 * the agent's name in its system prompt), and pi's compaction summariser. */
interface Script {
  main: Step[];
  lens: Record<string, Step[]>;
  summary: Step[];
}

/** The faux provider's one queue serves every session of the host, in the order
 * their requests arrive; this puts one dispatcher on each slot of it, so each asker
 * reads its own script. */
function dispatching(faux: FauxProviderHandle, script: Script): void {
  const step =
    (): Exclude<Step, ReturnType<typeof fauxAssistantMessage>> => (ctx, options, state, model) => {
      // pi 1.3 puts the system prompt in the first message's sections.
      const system = JSON.stringify(ctx.messages[0] ?? "");
      const pass = /You are (pass-[a-z]+)\./.exec(system)?.[1];
      const queue = pass
        ? (script.lens[pass] ??= [])
        : system.includes("reviewer of PR")
          ? script.main
          : script.summary;
      const next = queue.shift() ?? fauxAssistantMessage("(the script has nothing more to say)");
      return typeof next === "function" ? next(ctx, options, state, model) : next;
    };
  faux.setResponses(Array.from({ length: 60 }, step));
}

const stageOf = (e: WorkerEvent): string =>
  typeof e.body["stage"] === "string" ? e.body["stage"] : "";

const say = (text: string): Step => fauxAssistantMessage(text);
const bash = (command: string): Step =>
  fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1] = {}): Step =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

let world: World;
let daemon: FakeDaemon;
let faux: FauxProviderHandle;
let hosts: PiHost[];
let hostOptions: PiHostOptions[];
let ctr = 0;
/** The capability fds the daemon would have handed workers, closed after each test. */
let capFds: number[];

beforeEach(async () => {
  world = buildWorld();
  daemon = new FakeDaemon();
  await daemon.start();
  faux = fauxProvider();
  hosts = [];
  hostOptions = [];
  ctr = 0;
  capFds = [];
});
afterEach(async () => {
  for (const fd of capFds) closeSync(fd);
  for (const h of hosts) h.dispose();
  await daemon.stop();
  rmSync(world.dir, { recursive: true, force: true });
});

function deps(id: string, over: Partial<WorkerDeps> = {}): WorkerDeps {
  // The capability as the daemon hands it over: an open, unnamed 0600 file. This
  // process stands in for the worker, so the fd is its own.
  const fd = createCapabilityFd(runDirOf(world.dir), daemon.caps.get(id)!);
  capFds.push(fd);
  return {
    env: {
      PATH: process.env["PATH"],
      ...ipcEnv({ socketPath: daemon.sock, commandId: id, generation: 1, capFdIndex: fd }),
    },
    connect: () => daemon.connect(id),
    makeHost: async (o) => {
      hostOptions.push(o);
      const host = await PiHost.create({
        agentDir: o.agentDir,
        settings: {
          compaction: { enabled: false, keepRecentTokens: 300 },
          retry: { enabled: false },
        },
        configureModels: (r) => {
          r.registerNativeProvider(faux.provider);
        },
      });
      hosts.push(host);
      return host;
    },
    // Memory off: these cases are not about a server.
    openViking: (c) => ({ ...c, config: { ...c.config, enabled: false } }),
    ...over,
  };
}

/** Register a command and run the worker for it. */
async function round(
  order: string,
  script: Script,
  over: Partial<WorkerSpec> = {},
  id = `cmd-${++ctr}`,
  extra: Partial<WorkerDeps> = {},
): Promise<{ code: number; id: string; spec: WorkerSpec }> {
  dispatching(faux, script);
  const spec = world.spec(id, order, over);
  daemon.command(spec);
  const code = await work(id, extra);
  return { code, id, spec };
}

/** Run the worker for a registered command, then let the fake daemon read what it sent last. */
async function work(id: string, over: Partial<WorkerDeps> = {}): Promise<number> {
  const code = await runBotWorker({ command: id, mode: "round" }, deps(id, over));
  await settle();
  return code;
}

/** The worker's last events are on the wire when it returns; the fake daemon reads them a tick later. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

const script = (main: Step[], rest: Partial<Script> = {}): Script => ({
  main,
  lens: {},
  summary: [say("summary of the conversation so far")],
  ...rest,
});

const jsonl = (): string[] => readdirSync(world.sessionDir).filter((f) => f.endsWith(".jsonl"));
const header = (file: string): { id: string; type: string } =>
  JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as never;

describe("[P8.3] the command line", () => {
  it("takes --command and --mode, and nothing else", () => {
    expect(parseWorkerArgs(["--command", "c1", "--mode", "round"])).toEqual({
      command: "c1",
      mode: "round",
    });
    expect(parseWorkerArgs(["--mode", "answer", "--command", "c2"])).toEqual({
      command: "c2",
      mode: "answer",
    });
    for (const bad of [
      [],
      ["--command", "c1"],
      ["--mode", "round"],
      ["--command", "c1", "--mode", "nope"],
      ["--command", "c1", "--mode", "round", "--extra"],
    ])
      expect(parseWorkerArgs(bad), JSON.stringify(bad)).toHaveProperty("error");
  });

  it("answer mode is P8.17's: refused before it connects, with the usage code", async () => {
    let connected = false;
    const code = await runBotWorker(
      { command: "c1", mode: "answer" },
      {
        env: { QCR_IPC_COMMAND_ID: "c1" },
        connect: async () => {
          connected = true;
          throw new Error("never");
        },
      },
    );
    expect(code).toBe(EXIT.usage);
    expect(connected).toBe(false);
  });

  it("refuses a command id that is not the one the daemon put in env", async () => {
    const code = await runBotWorker(
      { command: "c1", mode: "round" },
      { env: { QCR_IPC_COMMAND_ID: "other" } },
    );
    expect(code).toBe(EXIT.usage);
  });
});

describe("[P8.3] the spec the daemon answers with", () => {
  const good = (): WorkerSpec => world.spec("c-spec", "order\n");

  it("round-trips a good spec", () => {
    const spec = good();
    expect(parseWorkerSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });

  it("refuses what it cannot trust", () => {
    const broken: Array<[string, (s: Record<string, unknown>) => void]> = [
      ["a session that is not pr-<pr>", (s) => (s["session"] = "pr-8")],
      ["a payload sha that is not a sha256", (s) => (s["payload_sha256"] = "abc")],
      ["a relative path", (s) => (s["cwd"] = "wt/pr-7")],
      ["a non-string env value", (s) => (s["env"] = { A: 1 })],
      ["no wall-clock cap", (s) => (s["wall_clock_ms"] = 0)],
      ["an unknown mode", (s) => (s["mode"] = "debug")],
      ["a negative cap", (s) => (s["cap_usd"] = -1)],
    ];
    for (const [what, mutate] of broken) {
      const spec = JSON.parse(JSON.stringify(good())) as Record<string, unknown>;
      mutate(spec);
      expect(() => parseWorkerSpec(spec), what).toThrow(/worker spec/);
    }
    expect(() => parseWorkerSpec(null)).toThrow(/worker spec/);
  });
});

describe("[P8.3] a round at birth", () => {
  it("opens a session, runs the order, reports each step and exits 0", async () => {
    world.stageVerdict(1);
    const root = world.root;
    const { code, id, spec } = await round(
      "ROUND ORDER for PR 7\n",
      script([
        bash(`scripts/commit-verdict.sh pr-7-round-1.json`),
        bash(`scripts/post-review.sh 7 COMMENT ${world.dir}/body.md`),
        say("round done"),
      ]),
    );
    expect(code).toBe(EXIT.ok);
    // The daemon heard the round in order.
    const kinds = daemon.kinds();
    for (const [a, b] of [
      ["ready", "accepted"],
      ["accepted", "verdict_written"],
      ["verdict_written", "posted"],
      ["posted", "compacted"],
      ["compacted", "done"],
    ] as const)
      expect(kinds.indexOf(a), `${a} before ${b}`).toBeLessThan(kinds.indexOf(b));
    expect(kinds).not.toContain("failed");
    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: false, continued: false });
    expect(daemon.of("posted")[0]!.body).toEqual({ script: "post-review.sh" });
    expect(daemon.of("done")[0]!.body).toMatchObject({
      verdict_written: true,
      posted: 1,
      resumed: false,
      wakes_delivered: 0,
    });
    expect(daemon.of("usage").length).toBeGreaterThan(0);
    // The verdict is published, whole.
    expect(existsSync(join(root, "verdict", "pr-7-round-1.json"))).toBe(true);
    // The session is born under the PR's session dir, its id is the JSONL's.
    const files = jsonl();
    expect(files).toHaveLength(1);
    const file = join(world.sessionDir, files[0]!);
    expect(header(file).id).toBe(daemon.of("ready")[0]!.body["session_id"]);
    // The order went in whole, then the engine section, then the command's marker.
    const text = readFileSync(file, "utf8");
    const marker = sessionCommandMarker(id, spec.payload_sha256);
    expect(text).toContain("ROUND ORDER for PR 7");
    expect(text).toContain("ENGINE LENS ROUTE");
    expect(text.indexOf("ROUND ORDER")).toBeLessThan(text.indexOf("ENGINE LENS ROUTE"));
    expect(text.split(marker).length - 1).toBeGreaterThanOrEqual(1);
    expect(jsonlHasMarker(file, marker)).toBe(true);
  });

  it("hands the model's bash the post shims' IPC names, and nothing of a GitHub token", async () => {
    const { code } = await round(
      "ORDER\n",
      script([
        bash(`scripts/post-review.sh 7 COMMENT ${world.dir}/body.md`),
        bash("env"),
        say("ok"),
      ]),
    );
    expect(code).toBe(EXIT.ok);
    // The script handed over to the (stub) client. The client saw the IPC names
    // and the round's identity in env, and read the command's capability from the
    // inherited fd (pread, as the real client does): the secret is in no env.
    expect(world.posts()).toEqual([
      {
        argv: ["review", "7", "COMMENT", `${world.dir}/body.md`],
        ipc: [
          "QCR_IPC_CAP_FD",
          "QCR_IPC_COMMAND_ID",
          "QCR_IPC_GENERATION",
          "QCR_IPC_SOCKET",
        ].sort(),
        round: "1",
        cap: daemon.caps.get("cmd-1"),
      },
    ]);
    const events = readFileSync(world.spec("x", "x").events_file.replace("/x.", "/cmd-1."), "utf8");
    expect(events).toContain("QCR_IPC_SOCKET=");
    expect(events).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
  });

  it("sends the heartbeat while it works", async () => {
    const slow: Step = async () => {
      await new Promise((r) => setTimeout(r, 400));
      return fauxAssistantMessage("late");
    };
    const { code } = await round("ORDER\n", script([slow]), { heartbeat_ms: 60 });
    expect(code).toBe(EXIT.ok);
    expect(daemon.progress("heartbeat").length).toBeGreaterThanOrEqual(2);
  });
});

describe("[P8.3] resume under the same id", () => {
  it("a second round appends to the SAME JSONL, under the id in its header", async () => {
    const first = await round("ORDER ONE\n", script([say("one done")]));
    expect(first.code).toBe(EXIT.ok);
    const file = newestSessionFile(world.sessionDir)!;
    const id = header(file).id;
    const before = readFileSync(file, "utf8").split("\n").length;

    daemon.events.length = 0;
    const second = await round("ORDER TWO\n", script([say("two done")]));
    expect(second.code).toBe(EXIT.ok);

    expect(jsonl()).toHaveLength(1);
    expect(newestSessionFile(world.sessionDir)).toBe(file);
    expect(header(file).id).toBe(id);
    const ready = daemon.of("ready")[0]!.body;
    expect(ready).toMatchObject({ resumed: true, continued: false, session_id: id });
    expect(ready["session_file"]).toBe(file);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("ORDER ONE");
    expect(text).toContain("ORDER TWO");
    expect(text.split("\n").length).toBeGreaterThan(before);
  });
});

describe("[P8.3] the planned wave and the lens JSONLs", () => {
  it("starts the wave before the first prompt, joins it through lens_wave, and keeps each pass's JSONL (D10)", async () => {
    faux = pricedFaux(() => 0.25);
    const tasks = writeTasks(world, 1, ["pass-a", "pass-b"]);
    const { code } = await round(
      "ORDER\n",
      script([tool("lens_wave"), say("wave collected")], {
        lens: {
          // pass-a looks at its environment: a lens never gets the IPC names.
          "pass-a": [bash("env"), say("a: nothing found")],
          "pass-b": [say("b: nothing found")],
        },
      }),
      { planned_wave: true },
    );
    expect(code).toBe(EXIT.ok);
    expect(daemon.progress("wave_started")[0]!.body["rows"]).toBe(2);
    // The engine started it before the order went in.
    const kinds = daemon.events.map((e) => `${e.kind}:${stageOf(e)}`);
    expect(kinds.indexOf("progress:wave_started")).toBeLessThan(
      kinds.indexOf("progress:round_order_sent"),
    );
    // The order names the rows the engine started.
    const file = join(world.sessionDir, jsonl()[0]!);
    const text = readFileSync(file, "utf8");
    expect(text).toContain(`from the task files in ${tasks}`);
    expect(text).toContain("pass-a, pass-b");
    // Both passes ran once, their JSONLs beside the round's lens ledger.
    const kept = readdirSync(join(world.lensDir, "lens-sessions"));
    expect(kept).toHaveLength(2);
    for (const dir of kept) {
      const files = readdirSync(join(world.lensDir, "lens-sessions", dir));
      expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
    }
    expect(existsSync(join(world.lensDir, "lens-ledger.jsonl"))).toBe(true);
    const lensText = kept
      .flatMap((d) =>
        readdirSync(join(world.lensDir, "lens-sessions", d)).map((f) =>
          readFileSync(join(world.lensDir, "lens-sessions", d, f), "utf8"),
        ),
      )
      .join("\n");
    expect(lensText).toContain("QCR_SESSION_NAME=pr-7");
    expect(lensText).not.toContain("QCR_IPC_");
    // The round's spend is totalled for the daemon (P8.9), 0.25 a message: the main
    // session's two messages and the passes' three, each run counted once.
    expect(daemon.of("done")[0]!.body["lens_usd"]).toBeCloseTo(0.75);
    expect(daemon.of("done")[0]!.body["total_usd"]).toBeCloseTo(1.25);
    expect(daemon.of("usage").at(-1)!.body["total_usd"]).toBeCloseTo(1.25);
  });

  it("reports the very figure the daemon's transcript measurement reads off the same JSONL (P8.9)", async () => {
    faux = pricedFaux(() => 0.25);
    writeTasks(world, 1, ["pass-a", "pass-b"]);
    const { code } = await round(
      "ORDER\n",
      script([tool("lens_wave"), say("wave collected")], {
        lens: { "pass-a": [say("a")], "pass-b": [say("b")] },
      }),
      { planned_wave: true },
    );
    expect(code).toBe(EXIT.ok);
    const measured = await new TranscriptIndex().measure({
      sessionDir: world.sessionDir,
      startedAt: "2000-01-01T00:00:00.000Z",
      finishedAt: "2100-01-01T00:00:00.000Z",
    });
    expect(measured.usage?.cost_usd).toBeCloseTo(1.0, 9); // main: 2 messages, the passes: 1 each
    const reported = daemon.of("done")[0]!.body["total_usd"] as number;
    expect(reported).toBeCloseTo(measured.usage!.cost_usd!, 9);
  });

  it("without the planned wave the order tells the session to launch it itself", async () => {
    writeTasks(world, 1, ["pass-a"]);
    const { code } = await round("ORDER\n", script([say("ok")]), { planned_wave: false });
    expect(code).toBe(EXIT.ok);
    expect(daemon.progress("wave_started")).toEqual([]);
    const text = readFileSync(join(world.sessionDir, jsonl()[0]!), "utf8");
    expect(text).toContain("Launch the planned discovery rows with ONE");
    expect(readdirSync(world.root)).not.toContain("lens-sessions");
  });
});

describe("[P8.3] held wakes", () => {
  it("are delivered after the round and before the exit, in order, each acked", async () => {
    daemon.wakes.push(
      [
        { id: "w1", message: "AUTHOR REPLY one\n" },
        { id: "w2", message: "AUTHOR REPLY two\n" },
      ],
      [{ id: "w3", message: "CI RECHECK three\n" }],
    );
    const { code } = await round(
      "ORDER\n",
      script([say("round done"), say("answered one"), say("answered two"), say("answered three")]),
    );
    expect(code).toBe(EXIT.ok);
    expect(daemon.acked).toEqual(["w1", "w2", "w3"]);
    // take, ack, ack, take, ack, take (empty): the last answer ends the loop.
    expect(daemon.requests.map((r) => r.op)).toEqual([
      "worker.spec",
      "wakes.take",
      "wakes.ack",
      "wakes.ack",
      "wakes.take",
      "wakes.ack",
      "wakes.take",
    ]);
    const text = readFileSync(join(world.sessionDir, jsonl()[0]!), "utf8");
    const at = (s: string): number => text.indexOf(s);
    expect(at("ORDER")).toBeLessThan(at("AUTHOR REPLY one"));
    expect(at("AUTHOR REPLY one")).toBeLessThan(at("AUTHOR REPLY two"));
    expect(at("AUTHOR REPLY two")).toBeLessThan(at("CI RECHECK three"));
    expect(text).toContain(wakeMarker("w2"));
    expect(daemon.progress("wakes_delivered").at(-1)!.body["delivered"]).toBe(3);
    // Delivered before the compaction and the exit.
    const kinds = daemon.events.map((e) => `${e.kind}:${stageOf(e)}`);
    expect(kinds.lastIndexOf("progress:wakes_delivered")).toBeLessThan(kinds.indexOf("compacted:"));
    expect(daemon.of("done")[0]!.body["wakes_delivered"]).toBe(3);
  });

  it("a batch an earlier worker delivered and died before acking is acked, not sent twice", async () => {
    const first = await round("ORDER ONE\n", script([say("one"), say("seen")]), {}, "cmd-a");
    expect(first.code).toBe(EXIT.ok);
    // Round one delivered w1 (its marker is in the JSONL) and died before the ack.
    daemon.wakes.push([{ id: "w1", message: "AUTHOR REPLY one\n" }]);
    const firstRun = await round(
      "ORDER TWO\n",
      script([say("two"), say("seen the reply")]),
      {},
      "cmd-b",
    );
    expect(firstRun.code).toBe(EXIT.ok);
    expect(daemon.acked).toEqual(["w1"]);
    daemon.acked.length = 0;
    daemon.wakes.push([{ id: "w1", message: "AUTHOR REPLY one\n" }]);
    const taken = readFileSync(join(world.sessionDir, jsonl()[0]!), "utf8").split(
      wakeMarker("w1"),
    ).length;
    const again = await round("ORDER THREE\n", script([say("three")]), {}, "cmd-c");
    expect(again.code).toBe(EXIT.ok);
    expect(daemon.acked).toEqual(["w1"]);
    const after = readFileSync(join(world.sessionDir, jsonl()[0]!), "utf8").split(
      wakeMarker("w1"),
    ).length;
    expect(after).toBe(taken);
  });

  it("a daemon that drops while wakes.take is in flight is a lost daemon, not a failed turn", async () => {
    daemon.onTake = async () => {
      void daemon.stop();
      await new Promise((r) => setTimeout(r, 2_000));
    };
    const { code } = await round("ORDER\n", script([say("round done")]));
    expect(code).toBe(EXIT.lost);
  });

  it("a daemon that does not know wakes.take holds none", async () => {
    // The ops are the daemon's (P8.6); an older one answers unknown_op.
    daemon.forget("wakes.take");
    const { code } = await round("ORDER\n", script([say("ok")]));
    expect(code).toBe(EXIT.ok);
    expect(daemon.acked).toEqual([]);
  });
});

describe("[P8.3] compaction through ledger-pin", () => {
  it("pi's compact() fires session_before_compact: the ledger is pinned and persisted", async () => {
    const ledger = "LEDGER PR #7 @ aaaaaaa\n- [ ] src/a.ts:2 off-by-one\n";
    // History long enough for pi to have something to summarise and a tail to keep.
    const filler = "word ".repeat(400);
    const { code } = await round(
      `ORDER ${filler}\n`,
      script([bash("echo reading"), say(`ROUND DONE ${filler}\n\n${ledger}`)]),
    );
    expect(code).toBe(EXIT.ok);
    expect(daemon.of("compacted")).toHaveLength(1);
    expect(daemon.of("compacted")[0]!.body).toMatchObject({ status: "compacted" });
    const text = readFileSync(join(world.sessionDir, jsonl()[0]!), "utf8");
    // ledger-pin's own entry, written from session_before_compact...
    expect(text).toContain('"customType":"qcr-review-ledger"');
    // ...and the compaction it pinned the ledger into.
    const compaction = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; summary?: string })
      .find((e) => e.type === "compaction");
    expect(compaction?.summary).toContain("qcr:ledger-pin");
    expect(compaction?.summary).toContain("off-by-one");
    // The mirror ledger-pin keeps at QCR_LEDGER_FILE.
    expect(readFileSync(join(world.root, "state", "ledgers", "pr-7.md"), "utf8")).toContain(
      "off-by-one",
    );
  });

  it("is skipped when the spec says so", async () => {
    const { code } = await round("ORDER\n", script([say("ok")]), { compact: false });
    expect(code).toBe(EXIT.ok);
    expect(daemon.of("compacted")).toEqual([]);
    expect(daemon.of("done")[0]!.body["compacted"]).toBe("skipped");
  });
});

describe("[P8.3] a worker that died mid-round (D22)", () => {
  it("a fresh worker resumes the JSONL and continues: the order is not sent again, nothing is posted twice", async () => {
    // Worker one posts, then the daemon goes away while the model is still working.
    const dies: Step = async () => {
      await daemon.stop();
      await new Promise((r) => setTimeout(r, 200));
      return fauxAssistantMessage("never read");
    };
    const id = "cmd-crash";
    const first = await round(
      "ROUND ORDER\n",
      script([bash(`scripts/post-review.sh 7 COMMENT ${world.dir}/body.md`), dies]),
      {},
      id,
    );
    expect(first.code).toBe(EXIT.lost);
    expect(world.posts()).toHaveLength(1);
    const file = newestSessionFile(world.sessionDir)!;
    const marker = sessionCommandMarker(id, first.spec.payload_sha256);
    expect(jsonlHasMarker(file, marker)).toBe(true);

    // The daemon is back and requeues the same command.
    await daemon.start();
    daemon.events.length = 0;
    daemon.command(first.spec);
    dispatching(faux, script([say("carried on; the review was already posted")]));
    const second = await work(id);
    expect(second.valueOf()).toBe(EXIT.ok);

    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: true, continued: true });
    expect(daemon.of("done")[0]!.body).toMatchObject({ continued: true, posted: 0 });
    // The order is in the JSONL once; the continuation is the second worker's one message.
    const text = readFileSync(file, "utf8");
    expect(text.split("ROUND ORDER").length - 1).toBe(1);
    expect(text).toContain("stopped before the round finished");
    expect(text).toContain(continuationText(marker).split("\n")[0]!.slice(0, 40));
    // Nothing was posted by the continuation.
    expect(world.posts()).toHaveLength(1);
    expect(jsonl()).toHaveLength(1);
  });

  it("a JSONL cut off right after a tool call resumes (the orphaned call is closed, not fatal)", async () => {
    const id = "cmd-cut";
    const first = await round(
      "ROUND ORDER\n",
      script([bash("echo hello"), say("never")]),
      { compact: false },
      id,
    );
    expect(first.code).toBe(EXIT.ok);
    const file = newestSessionFile(world.sessionDir)!;
    // Keep the header, the order and the assistant message holding the tool call.
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const cut = lines.findIndex(
      (l) => l.includes('"toolResult"') || l.includes('"role":"toolResult"'),
    );
    expect(cut).toBeGreaterThan(1);
    writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`);
    daemon.events.length = 0;
    dispatching(faux, script([say("picked up")]));
    daemon.command(first.spec);
    const code = await work(id);
    expect(code).toBe(EXIT.ok);
    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: true, continued: true });
  });
});

describe("[P8.3] the borrowed login (D5)", () => {
  const writeLogin = (expires: number): string => {
    const file = join(world.agentDir, "auth.json");
    writeFileSync(
      file,
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "A-TOKEN", refresh: "REAL-REFRESH", expires },
      }),
    );
    return file;
  };

  it("carries the disabled refresh token, and the owner's file is never written", async () => {
    const file = writeLogin(Date.now() + 3 * 3_600_000);
    const before = readFileSync(file, "utf8");
    const { code } = await round("ORDER\n", script([say("ok")]));
    expect(code).toBe(EXIT.ok);
    expect(hostOptions).toHaveLength(1);
    const credentials = hostOptions[0]!.credentials!;
    const copy = (await credentials.read("openai-codex")) as unknown as Record<string, unknown>;
    expect(copy["refresh"]).toBe(DISABLED_REFRESH);
    expect(copy["access"]).toBe("A-TOKEN");
    // Read-only: a refresh, a login or a logout would have to write, and may not.
    await expect(credentials.modify("openai-codex", () => undefined as never)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(before).toContain("REAL-REFRESH");
  });

  it("refuses, before anything is opened, a token that would expire inside its wall-clock cap", async () => {
    writeLogin(Date.now() + 10 * 60_000);
    const { code } = await round("ORDER\n", script([say("never")]), { wall_clock_ms: 30 * 60_000 });
    expect(code).toBe(EXIT.auth);
    expect(hostOptions).toEqual([]);
    expect(existsSync(world.sessionDir)).toBe(false);
    expect(daemon.of("failed")[0]!.body).toMatchObject({ code: EXIT.auth });
    expect(String(daemon.of("failed")[0]!.body["reason"])).toMatch(/expires at/);
    expect(JSON.stringify(daemon.events)).not.toContain("A-TOKEN");
  });
});

describe("[P8.3] nothing runs on what the daemon did not dispatch", () => {
  it("a payload whose bytes are not the recorded sha256 starts no session", async () => {
    dispatching(faux, script([say("never")]));
    const spec = world.spec("cmd-bad", "THE ORDER\n");
    writeFileSync(spec.payload_path, "A DIFFERENT ORDER\n");
    daemon.command(spec);
    const code = await work("cmd-bad");
    expect(code).toBe(EXIT.handshake);
    expect(hostOptions).toEqual([]);
    expect(existsSync(world.sessionDir)).toBe(false);
    expect(String(daemon.of("failed")[0]!.body["reason"])).toMatch(/hash/);
  });

  it("a spec for another command, mode or PR is refused", async () => {
    dispatching(faux, script([say("never")]));
    for (const over of [{ mode: "answer" as const }, { pr: 8, session: "pr-8" }]) {
      const id = `cmd-${over.pr ?? "mode"}`;
      // The daemon's row says PR 7 whatever the spec claims.
      daemon.command(world.spec(id, "ORDER\n", over), { pr: 7 });
      daemon.events.length = 0;
      const code = await work(id);
      expect(code, JSON.stringify(over)).toBe(EXIT.handshake);
    }
    expect(hostOptions).toEqual([]);
  });

  it("a spec whose env names the IPC variables is refused", async () => {
    dispatching(faux, script([say("never")]));
    const spec = world.spec("cmd-env", "ORDER\n");
    spec.env["QCR_IPC_SOCKET"] = "/elsewhere";
    daemon.command(spec);
    const code = await work("cmd-env");
    expect(code).toBe(EXIT.handshake);
  });

  it("rule 3: a GitHub token in the worker's own env stops it before a session exists", async () => {
    dispatching(faux, script([say("never")]));
    daemon.command(world.spec("cmd-token", "ORDER\n"));
    const base = deps("cmd-token");
    const code = await work("cmd-token", {
      env: { ...base.env, GITHUB_TOKEN: "ghp_secret_value" },
    });
    expect(code).toBe(EXIT.session);
    const reason = String(daemon.of("failed")[0]!.body["reason"]);
    expect(reason).toContain("GITHUB_TOKEN");
    expect(JSON.stringify(daemon.events)).not.toContain("ghp_secret_value");
    expect(existsSync(join(world.sessionDir))).toBe(false);
  });
});

describe("[P8.3] a round that fails", () => {
  it("a failed turn is reported and exits 1, with no wakes taken, no compaction and no done", async () => {
    daemon.wakes.push([{ id: "w1", message: "AUTHOR REPLY\n" }]);
    const failing: Step = fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "provider exploded",
    });
    const { code } = await round("ORDER\n", script([failing]));
    expect(code).toBe(EXIT.failed);
    expect(daemon.of("failed")[0]!.body).toMatchObject({ code: EXIT.failed });
    expect(daemon.of("done")).toEqual([]);
    expect(daemon.of("compacted")).toEqual([]);
    expect(daemon.requests.map((r) => r.op)).toEqual(["worker.spec"]);
    expect(daemon.acked).toEqual([]);
  });

  it("a wall-clock cap that runs out is a failed round", async () => {
    const hangs: Step = async (_c, options) => {
      await new Promise<void>((resolve) => {
        const s = options?.signal;
        if (!s || s.aborted) return resolve();
        s.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("late");
    };
    const { code } = await round("ORDER\n", script([hangs]), { wall_clock_ms: 5_000 }, undefined, {
      now: (() => {
        // A clock that has nearly spent the cap by the time the turn starts.
        let calls = 0;
        return () => (calls++ < 4 ? Date.now() : Date.now() + 4_500);
      })(),
    });
    expect(code).toBe(EXIT.failed);
    expect(String(daemon.of("failed")[0]!.body["reason"])).toMatch(/wall-clock/);
  });
});
