// [P8.17] The idle-PR answer worker (src/botworker.ts `--mode answer`), on pi's REAL
// SDK over pi-ai's faux provider: no model, no network. A real round worker first
// births the PR's JSONL; the answer worker then resumes it under the same id, takes
// the operator's message as one turn, replies in its `done` event and exits.
//
// What is pinned, against the ticket's verify:
//   - an idle message resumes the SAME id, the reply is in `done` (the daemon writes
//     it to the result file), the worker exits 0, and the model's request carries no
//     lens tool, no verdict tool and no write tool;
//   - without may_post the session has no bash at all and no way to reach the daemon;
//     with it the session also gets bash, the IPC names and the post scripts, and
//     carries no round identity, and commit-verdict.sh is blocked;
//   - the worker takes no wakes and no permits, runs the compaction check, reports
//     usage, and streams to the PR's live log without republishing round progress;
//   - a worker that died mid-answer is continued, not sent the message again, and
//     posts nothing twice;
//   - no session to resume is a refusal, and a spec the payload does not back is
//     read-only.
import { closeSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  answerContinuationText,
  jsonlHasMarker,
  runBotWorker,
  type WorkerDeps,
} from "../src/botworker.js";
import { ANSWER_MEMORY_TOOLS, ANSWER_READ_TOOLS } from "../src/engine/botsdk.js";
import { PiHost, type PiHostOptions } from "../src/engine/pisdk.js";
import { createCapabilityFd, ipcEnv, runDirOf } from "../src/ipc/capability.js";
import { WAKES_TAKE_OP, type WorkerSpec } from "../src/ipc/workerspec.js";
import { LIVE_MAIN_FILE, liveRoundDir } from "../src/live/events.js";
import { operatorMessagePayload } from "../src/operatormessage.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { newestSessionFile } from "../src/sessionjsonl.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import { FakeDaemon, buildWorld, type World } from "./helpers/worker-rig.js";

useOfflineGuard();

type Step = FauxResponseStep;
const say = (text: string): Step => fauxAssistantMessage(text);
const bash = (command: string): Step =>
  fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });

let world: World;
let daemon: FakeDaemon;
let faux: FauxProviderHandle;
let hosts: PiHost[];
let hostOptions: PiHostOptions[];
let capFds: number[];
let ctr = 0;
/** The tool names each model request offered, by request. */
let offered: string[][];

beforeEach(async () => {
  world = buildWorld("answerworker-");
  daemon = new FakeDaemon();
  await daemon.start();
  faux = fauxProvider();
  hosts = [];
  hostOptions = [];
  capFds = [];
  offered = [];
  ctr = 0;
});
afterEach(async () => {
  for (const fd of capFds) closeSync(fd);
  for (const h of hosts) h.dispose();
  await daemon.stop();
  rmSync(world.dir, { recursive: true, force: true });
});

function deps(id: string, over: Partial<WorkerDeps> = {}): WorkerDeps {
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
    openViking: (c) => ({ ...c, config: { ...c.config, enabled: false } }),
    ...over,
  };
}

/** The tools a request offers, as pi 1.3 records them in the transcript: the first system
 * message adds the session's tools, and a later one adds and removes (a resume with a
 * different tool set is a delta, which is what a request's tool schema is built from). */
function effectiveTools(messages: readonly unknown[]): string[] {
  const live = new Set<string>();
  for (const m of messages as Array<{
    role?: string;
    toolsAdded?: Array<{ name: string }>;
    toolsRemoved?: Array<{ name: string }>;
  }>) {
    if (m.role !== "system") continue;
    for (const t of m.toolsAdded ?? []) live.add(t.name);
    for (const t of m.toolsRemoved ?? []) live.delete(t.name);
  }
  return [...live].sort();
}

/** Script the faux model: each request reads the next step, and records the tools offered. */
function model(main: Step[], summary: Step[] = [say("summary of the conversation so far")]): void {
  const step =
    (): Exclude<Step, ReturnType<typeof fauxAssistantMessage>> => (ctx, options, state, m) => {
      const system = JSON.stringify(ctx.messages[0] ?? "");
      const isMain = system.includes("reviewer of PR");
      if (isMain) offered.push(effectiveTools(ctx.messages));
      const next =
        (isMain ? main : summary).shift() ??
        fauxAssistantMessage("(the script has nothing more to say)");
      return typeof next === "function" ? next(ctx, options, state, m) : next;
    };
  faux.setResponses(Array.from({ length: 40 }, step));
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

/** A round worker births the PR's JSONL; its events are cleared for the answer's. */
async function birthed(): Promise<string> {
  model([say("round one done")]);
  const id = `round-${++ctr}`;
  daemon.command(world.spec(id, "ROUND ORDER one\n"));
  const code = await runBotWorker({ command: id, mode: "round" }, deps(id));
  expect(code).toBe(EXIT.ok);
  await settle();
  daemon.events.length = 0;
  daemon.requests.length = 0;
  offered.length = 0;
  return newestSessionFile(world.sessionDir)!;
}

interface Asked {
  id: string;
  spec: WorkerSpec;
  mayPost: boolean;
}

/** Register an answer command for `text` and run its worker. */
async function answer(
  text: string,
  main: Step[],
  o: {
    mayPost?: boolean;
    id?: string;
    spec?: Partial<WorkerSpec>;
    extra?: Partial<WorkerDeps>;
  } = {},
): Promise<{ code: number } & Asked> {
  const mayPost = o.mayPost === true;
  model(main);
  const id = o.id ?? `answer-${++ctr}`;
  const spec = world.spec(id, operatorMessagePayload(text, mayPost), {
    mode: "answer",
    round_no: null,
    live_round: 1,
    may_post: mayPost,
    wall_clock_ms: 60_000,
    planned_wave: false,
    ...o.spec,
  });
  daemon.command(spec, { answer: true, may_post: mayPost });
  const code = await runBotWorker({ command: id, mode: "answer" }, deps(id, o.extra));
  await settle();
  return { code, id, spec, mayPost };
}

const jsonl = (): string[] =>
  existsSync(world.sessionDir)
    ? readdirSync(world.sessionDir).filter((f) => f.endsWith(".jsonl"))
    : [];
const header = (file: string): { id: string } =>
  JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as never;

describe("[P8.17] an idle message resumes the PR's session and is answered", () => {
  it("resumes the same id, delivers the message as one operator-marked turn, replies in done and exits 0", async () => {
    const file = await birthed();
    const id0 = header(file).id;
    const { code, id, spec } = await answer("Is the null check on line 12 enough?", [
      say("Yes: it covers the empty list as well."),
    ]);
    expect(code).toBe(EXIT.ok);
    expect(jsonl()).toEqual([file.split("/").at(-1)]);
    expect(header(file).id).toBe(id0);
    const ready = daemon.of("ready")[0]!.body;
    expect(ready).toMatchObject({ resumed: true, continued: false, session_id: id0 });
    // One user turn, marked as the operator's, with the command's marker after it.
    const text = readFileSync(file, "utf8");
    expect(text).toContain("qcr-operator-message may_post=0");
    expect(text).toContain("Is the null check on line 12 enough?");
    expect(text).toContain("ROUND ORDER one");
    expect(jsonlHasMarker(file, sessionCommandMarker(id, spec.payload_sha256))).toBe(true);
    // The reply is the model's last words, in the closing report.
    const done = daemon.of("done")[0]!.body;
    expect(done).toMatchObject({
      mode: "answer",
      reply: "Yes: it covers the empty list as well.",
      may_post: false,
      resumed: true,
      continued: false,
      posted: 0,
      verdict_written: false,
      wakes_delivered: 0,
    });
    expect(daemon.kinds()).not.toContain("failed");
    expect(daemon.of("usage").length).toBeGreaterThan(0);
  });

  it("offers no lens tool, no verdict or write tool, and no bash without the mark", async () => {
    await birthed();
    const { code } = await answer("anything?", [say("no")]);
    expect(code).toBe(EXIT.ok);
    const tools = offered[0]!;
    for (const t of ANSWER_READ_TOOLS) expect(tools).toContain(t);
    for (const gone of [
      "lens",
      "lens_wave",
      "cluster_findings",
      "coverage_gaps",
      "bash",
      "edit",
      "write",
      "viking_write",
    ])
      expect(tools, gone).not.toContain(gone);
    // Memory is off in this world (no server); with it on the lookups are the whole set.
    expect(ANSWER_MEMORY_TOOLS).not.toContain("viking_write");
  });

  it("takes no wakes and no lens permits, and runs the compaction check before it exits", async () => {
    await birthed();
    daemon.wakes.push([{ id: "b1", message: "an author replied" }]);
    const { code } = await answer("hello", [say("hi")]);
    expect(code).toBe(EXIT.ok);
    // The daemon's own wakes stay held for the round: the exception is the operator's.
    expect(daemon.requests.map((r) => r.op)).not.toContain(WAKES_TAKE_OP);
    expect(daemon.wakes).toHaveLength(1);
    expect(daemon.permitAsks).toEqual([]);
    expect(daemon.of("compacted")).toHaveLength(1);
    expect(daemon.kinds().indexOf("compacted")).toBeLessThan(daemon.kinds().indexOf("done"));
  });

  it("streams to the newest round's live log without publishing round progress", async () => {
    await birthed();
    const log = join(liveRoundDir(world.root, "pr-7", 1), LIVE_MAIN_FILE);
    const before = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    const progress = join(world.root, "state", "round-progress", "pr-7.json");
    const had = existsSync(progress) ? readFileSync(progress, "utf8") : null;
    const { code } = await answer("a question", [say("an answer")]);
    expect(code).toBe(EXIT.ok);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(before);
    expect(readFileSync(log, "utf8")).toContain("an answer");
    expect(existsSync(progress) ? readFileSync(progress, "utf8") : null).toBe(had);
  });

  it("a PR with no session is refused: an answer never births one", async () => {
    const { code } = await answer("anyone there?", [say("never")]);
    expect(code).toBe(EXIT.session);
    expect(String(daemon.of("failed")[0]!.body["reason"])).toMatch(/no session to resume/);
    expect(jsonl()).toEqual([]);
  });

  it("a wall-clock cap that runs out is a failed answer", async () => {
    await birthed();
    const hangs: Step = async (_c, options) => {
      await new Promise<void>((resolve) => {
        const s = options?.signal;
        if (!s || s.aborted) return resolve();
        s.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("late");
    };
    const { code } = await answer("slow", [hangs], {
      spec: { wall_clock_ms: 5_000 },
      extra: {
        now: (() => {
          let calls = 0;
          return () => (calls++ < 2 ? Date.now() : Date.now() + 4_500);
        })(),
      },
    });
    expect(code).toBe(EXIT.failed);
    expect(String(daemon.of("failed")[0]!.body["reason"])).toMatch(/wall-clock/);
    expect(daemon.kinds()).not.toContain("done");
  });
});

describe("[P8.17] may_post gives the session the post scripts, and only those", () => {
  it("without the mark the session has no bash and no way to the daemon", async () => {
    await birthed();
    // Asked to run a command anyway: there is no such tool, so nothing runs or posts.
    const { code } = await answer("post it", [
      bash(`scripts/post-review.sh 7 COMMENT ${world.dir}/body.md`),
      say("I could not."),
    ]);
    expect(code).toBe(EXIT.ok);
    expect(world.posts()).toEqual([]);
    expect(daemon.kinds()).not.toContain("posted");
  });

  it("with the mark it gets bash and the IPC names, carries no round identity, and posts through the shim", async () => {
    await birthed();
    const { code, id, spec } = await answer(
      "reply and post a comment",
      [
        bash(`scripts/post-review.sh 7 COMMENT ${world.dir}/body.md`),
        bash("env"),
        say("posted a comment"),
      ],
      { mayPost: true },
    );
    expect(code).toBe(EXIT.ok);
    expect(offered[0]).toContain("bash");
    expect(offered[0]).not.toContain("lens");
    expect(offered[0]).not.toContain("write");
    const posts = world.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      argv: ["review", "7", "COMMENT", `${world.dir}/body.md`],
      ipc: ["QCR_IPC_CAP_FD", "QCR_IPC_COMMAND_ID", "QCR_IPC_GENERATION", "QCR_IPC_SOCKET"].sort(),
      // No round: the post is unkeyed, and the daemon's `roundOf` is null for it.
      round: null,
      cap: daemon.caps.get(id),
    });
    expect(daemon.of("posted")[0]!.body).toEqual({ script: "post-review.sh" });
    expect(daemon.of("done")[0]!.body).toMatchObject({ posted: 1, may_post: true });
    const events = readFileSync(spec.events_file, "utf8");
    expect(events).not.toMatch(/QCR_ROUND_NO|QCR_EXPECTED_HEAD|QCR_POSTING_KEY/);
    expect(events).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
  });

  it("a spec that says may-post over a payload that does not is read-only", async () => {
    await birthed();
    const id = `answer-${++ctr}`;
    model([say("nope")]);
    const spec = world.spec(id, operatorMessagePayload("hi", false), {
      mode: "answer",
      round_no: null,
      may_post: true,
      planned_wave: false,
    });
    daemon.command(spec, { answer: true, may_post: true });
    expect(await runBotWorker({ command: id, mode: "answer" }, deps(id))).toBe(EXIT.ok);
    expect(offered[0]).not.toContain("bash");
  });

  it("commit-verdict.sh is blocked: an answer is not a round", async () => {
    await birthed();
    world.stageVerdict(1);
    const { code } = await answer(
      "commit it",
      [bash("scripts/commit-verdict.sh pr-7-round-1.json"), say("blocked")],
      { mayPost: true },
    );
    expect(code).toBe(EXIT.ok);
    expect(existsSync(join(world.root, "verdict", "pr-7-round-1.json"))).toBe(false);
    expect(daemon.kinds()).not.toContain("verdict_written");
    expect(readFileSync(newestSessionFile(world.sessionDir)!, "utf8")).toContain(
      "commits no verdict",
    );
  });
});

describe("[P8.17] a worker that died mid-answer is continued, not sent the message again", () => {
  it("the marker keeps the message and the post from repeating", async () => {
    const file = await birthed();
    const dies: Step = async () => {
      await daemon.stop();
      await new Promise((r) => setTimeout(r, 200));
      return fauxAssistantMessage("never read");
    };
    const id = "answer-crash";
    const first = await answer(
      "post a comment",
      [bash(`scripts/post-review.sh 7 COMMENT ${world.dir}/body.md`), dies],
      { mayPost: true, id },
    );
    expect(first.code).toBe(EXIT.lost);
    expect(world.posts()).toHaveLength(1);
    const marker = sessionCommandMarker(id, first.spec.payload_sha256);
    expect(jsonlHasMarker(file, marker)).toBe(true);

    await daemon.start();
    daemon.events.length = 0;
    daemon.command(first.spec, { answer: true, may_post: true });
    model([say("carried on; the comment was already posted")]);
    const code = await runBotWorker({ command: id, mode: "answer" }, deps(id));
    await settle();
    expect(code).toBe(EXIT.ok);
    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: true, continued: true });
    const text = readFileSync(file, "utf8");
    expect(text.split("post a comment").length - 1).toBe(1);
    expect(text).toContain(answerContinuationText(marker).split("\n")[0]!.slice(0, 40));
    expect(world.posts()).toHaveLength(1);
    expect(daemon.of("done")[0]!.body).toMatchObject({ continued: true, posted: 0 });
  });
});
