// [P8.3] The built worker as a real process, the way the WorkerSupervisor (P8.5)
// will start it: `node dist/src/botworker.js --command <id> --mode round`, the
// command's capability on an inherited fd (stdio[3]), the socket and command in
// env, nothing else. The model is a loopback endpoint that plays a script (no
// model, nothing leaves the machine); the daemon is a fake with the REAL post ops
// over the real MutationGate in dry-run.
//
// What only a process can show:
//   - the capability fd reaches the model's bash and the post shim under it, so
//     a review posted from the model's own command lands in the daemon's dry-run
//     record, and no GitHub token exists anywhere in the worker;
//   - a worker that is SIGKILLed mid-round is continued by a fresh one, which
//     resumes the same JSONL, does not send the order again and does not post twice.
//
// Skipped without a build (`npx tsc -p tsconfig.json`): it runs dist/.
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityFd, ipcEnv } from "../src/ipc/capability.js";
import { operatorMessagePayload } from "../src/operatormessage.js";
import { jsonlHasMarker } from "../src/botworker.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { newestSessionFile } from "../src/sessionjsonl.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import {
  FakeDaemon,
  PR,
  buildWorld,
  postingEnv,
  registerDryRunPosting,
  type World,
} from "./helpers/worker-rig.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist", "src", "botworker.js");
const hasDist = existsSync(DIST) && existsSync(join(ROOT, "dist", "src", "ipc", "postshim.js"));

let fake: FakeOpenAI;
beforeAll(async () => {
  fake = await startFakeOpenAI();
});
afterAll(async () => {
  await fake.close();
});

let world: World;
let daemon: FakeDaemon;
let posting: ReturnType<typeof registerDryRunPosting>;
let runDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  world = buildWorld("botworker-proc-");
  // The REAL post client the scripts hand over to, from the build.
  rmSync(join(world.root, "dist"), { recursive: true, force: true });
  mkdirSync(join(world.root, "dist", "src"), { recursive: true });
  symlinkSync(join(ROOT, "dist", "src", "ipc"), join(world.root, "dist", "src", "ipc"));
  writeFakeProvider(world.agentDir, fake.baseUrl);
  daemon = new FakeDaemon();
  await daemon.start();
  posting = registerDryRunPosting(daemon, world);
  runDir = mkdtempSync(join(tmpdir(), "bw-run-"));
  fake.requests.length = 0;
  // The review body and the verdict, as the model's write tool would have left them.
  writeFileSync(join(world.root, "state", `pr-${PR}-round-1-review.md`), "Looks fine.\n");
  world.stageVerdict(1);
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await daemon.stop();
  rmSync(world.dir, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
});

function register(id: string, order: string) {
  const spec = world.spec(id, order, { model: FAKE_MODEL, compact: false });
  // The model has no memory server here; and the post shim's round identity is the rig's.
  for (const k of Object.keys(spec.env)) if (k.startsWith("OPENVIKING_")) delete spec.env[k];
  Object.assign(spec.env, postingEnv);
  daemon.command(spec);
  return spec;
}

/** Start the worker as the supervisor will: the capability on stdio[3]. */
function start(
  id: string,
  mode: "round" | "answer" = "round",
): {
  child: ChildProcess;
  exit: Promise<number | null>;
  stderr: () => string;
} {
  const fd = createCapabilityFd(runDir, daemon.caps.get(id)!);
  const child = spawn(process.execPath, [DIST, "--command", id, "--mode", mode], {
    stdio: ["ignore", "ignore", "pipe", fd],
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      ...ipcEnv({ socketPath: daemon.sock, commandId: id, generation: 1 }),
    },
  });
  closeSync(fd); // the child holds its own copy
  children.push(child);
  let err = "";
  child.stderr!.on("data", (b: Buffer) => (err += b.toString()));
  const exit = new Promise<number | null>((resolveExit) =>
    child.on("exit", (code) => resolveExit(code)),
  );
  return { child, exit, stderr: () => err };
}

async function until(pred: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const bashCall = (id: string, command: string) => ({
  toolCalls: [{ id, name: "bash", args: { command } }],
});

describe.skipIf(!hasDist)("[P8.3] the built worker, as a process", () => {
  it("posts from the model's own command through the inherited capability, in dry-run", async () => {
    fake.script([
      bashCall("call_1", "scripts/commit-verdict.sh pr-7-round-1.json"),
      bashCall("call_2", `scripts/post-review.sh ${PR} COMMENT state/pr-${PR}-round-1-review.md`),
      { text: "round done" },
    ]);
    register("cmd-proc", "ROUND ORDER for PR 7\n");
    const w = start("cmd-proc");
    const code = await w.exit;
    await new Promise((r) => setTimeout(r, 100));
    expect(code, w.stderr()).toBe(0);

    // The daemon heard the round, and the review is the daemon's dry-run record.
    expect(daemon.kinds()).toEqual(
      expect.arrayContaining(["ready", "accepted", "verdict_written", "posted", "done"]),
    );
    expect(daemon.of("done")[0]!.body).toMatchObject({ verdict_written: true, posted: 1 });
    const records = posting.dryrun();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toContain("Looks fine.");
    expect(posting.gh.posts()).toEqual([]); // nothing reached GitHub
    expect(existsSync(join(world.root, "verdict", "pr-7-round-1.json"))).toBe(true);

    // The session is the PR's, under its own id.
    const file = newestSessionFile(world.sessionDir)!;
    const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as { id: string };
    expect(header.id).toBe(daemon.of("ready")[0]!.body["session_id"]);
    // No GitHub token anywhere in what the worker wrote down.
    expect(readFileSync(file, "utf8")).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
  });

  it("a worker killed mid-round is continued by a fresh one: same JSONL, order not resent, nothing posted twice", async () => {
    fake.script([
      bashCall("call_1", `scripts/post-review.sh ${PR} COMMENT state/pr-${PR}-round-1-review.md`),
      { text: "never read", delayMs: 20_000 },
    ]);
    const spec = register("cmd-kill", "ROUND ORDER for PR 7\n");
    const first = start("cmd-kill");
    // Posted, and the model is now waiting on its second answer.
    await until(
      () => daemon.of("posted").length === 1 && fake.requests.length >= 2,
      "the post and the second request",
    );
    first.child.kill("SIGKILL");
    expect(await first.exit).toBeNull();
    expect(posting.dryrun()).toHaveLength(1);
    const file = newestSessionFile(world.sessionDir)!;
    const marker = sessionCommandMarker("cmd-kill", spec.payload_sha256);
    expect(jsonlHasMarker(file, marker)).toBe(true);

    // The daemon requeues the same command; a fresh worker takes it.
    daemon.events.length = 0;
    fake.script([{ text: "carried on" }]);
    fake.requests.length = 0;
    const second = start("cmd-kill");
    const code = await second.exit;
    await new Promise((r) => setTimeout(r, 100));
    expect(code, second.stderr()).toBe(0);

    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: true, continued: true });
    expect(daemon.of("done")[0]!.body).toMatchObject({ continued: true, posted: 0 });
    // The model was shown its history and the continuation, with the order in it once.
    const body = fake.requests[0]!.body;
    expect(body.split("ROUND ORDER for PR 7").length - 1).toBe(1);
    expect(body).toContain("stopped before the round finished");
    expect(readdirSync(world.sessionDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    expect(posting.dryrun()).toHaveLength(1);
  });
});

// ---- [P8.17] the idle-PR answer worker, as a process ----------------------------

/** An answer command for PR 7, as the supervisor would register it. */
function registerAnswer(id: string, text: string, mayPost: boolean) {
  const spec = world.spec(id, operatorMessagePayload(text, mayPost), {
    mode: "answer",
    round_no: null,
    live_round: 1,
    may_post: mayPost,
    model: FAKE_MODEL,
    compact: false,
    planned_wave: false,
  });
  for (const k of Object.keys(spec.env)) if (k.startsWith("OPENVIKING_")) delete spec.env[k];
  daemon.command(spec, { answer: true, may_post: mayPost });
  return spec;
}

/** A round worker births the PR's JSONL, posting nothing. */
async function birthRound(): Promise<void> {
  fake.script([{ text: "round done" }]);
  register("cmd-birth", "ROUND ORDER for PR 7\n");
  const w = start("cmd-birth");
  expect(await w.exit, w.stderr()).toBe(0);
  daemon.events.length = 0;
  fake.requests.length = 0;
}

describe.skipIf(!hasDist)("[P8.17] the built answer worker, as a process", () => {
  it("with may_post a post from the model's own command lands in state/dryrun through the gate; the marker keeps it from repeating", async () => {
    await birthRound();
    fake.script([
      bashCall("call_1", `scripts/post-review.sh ${PR} COMMENT state/pr-${PR}-round-1-review.md`),
      { text: "posted the comment", delayMs: 20_000 },
    ]);
    const spec = registerAnswer("answer-proc", "post the review comment", true);
    const first = start("answer-proc", "answer");
    await until(
      () => daemon.of("posted").length === 1 && fake.requests.length >= 2,
      "the post and the second request",
    );
    // Posted through the daemon's one gate, in dry-run, unkeyed; nothing reached GitHub.
    expect(posting.dryrun()).toHaveLength(1);
    expect(JSON.stringify(posting.dryrun()[0])).toContain("Looks fine.");
    expect(posting.gh.posts()).toEqual([]);
    first.child.kill("SIGKILL");
    expect(await first.exit).toBeNull();

    // A fresh worker for the same command continues: the message is not sent again,
    // so nothing is posted twice.
    daemon.events.length = 0;
    fake.script([{ text: "the comment was already posted" }]);
    fake.requests.length = 0;
    const second = start("answer-proc", "answer");
    const code = await second.exit;
    await new Promise((r) => setTimeout(r, 100));
    expect(code, second.stderr()).toBe(0);
    expect(daemon.of("ready")[0]!.body).toMatchObject({ resumed: true, continued: true });
    expect(daemon.of("done")[0]!.body).toMatchObject({
      mode: "answer",
      continued: true,
      posted: 0,
      reply: "the comment was already posted",
    });
    expect(posting.dryrun()).toHaveLength(1);
    const file = newestSessionFile(world.sessionDir)!;
    expect(jsonlHasMarker(file, sessionCommandMarker("answer-proc", spec.payload_sha256))).toBe(
      true,
    );
    expect(fake.requests[0]!.body.split("post the review comment").length - 1).toBe(1);
  });

  it("without may_post the session has no bash: asking for a post posts nothing", async () => {
    await birthRound();
    fake.script([
      bashCall("call_1", `scripts/post-review.sh ${PR} COMMENT state/pr-${PR}-round-1-review.md`),
      { text: "I cannot post" },
    ]);
    registerAnswer("answer-ro", "post the review comment", false);
    const w = start("answer-ro", "answer");
    const code = await w.exit;
    await new Promise((r) => setTimeout(r, 100));
    expect(code, w.stderr()).toBe(0);
    expect(posting.dryrun()).toEqual([]);
    expect(daemon.kinds()).not.toContain("posted");
    expect(daemon.of("done")[0]!.body).toMatchObject({ reply: "I cannot post", posted: 0 });
    // The request that answered the operator offered no bash, no lens and no write.
    const tools = (
      JSON.parse(fake.requests[0]!.body) as { tools?: Array<{ function: { name: string } }> }
    ).tools?.map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    expect(tools).not.toEqual(expect.arrayContaining(["bash"]));
    expect(tools).not.toEqual(expect.arrayContaining(["lens"]));
    expect(tools).not.toEqual(expect.arrayContaining(["write"]));
  });
});
