// [P8.13b] The bot's debug round, end to end, with the REAL pi CLI in a pty.
//
// The chain is the one tmux runs: the manager (src/debuground.ts) delivers a PR's round
// order, and the pane is `node dist/src/ipc/launcher.js <launch-file> -- node
// dist/src/debugroundpi.js <spec>`. The pty is `script`; tmux and the process table are
// the fake host (tests/helpers/fake-pane-host.ts), and the manager's command line is what
// is run. pi talks to a loopback endpoint that plays a script (no model, nothing leaves
// the machine). The daemon is a real IpcServer with the REAL post ops over the real
// MutationGate in dry-run.
//
// What only the real chain shows:
//   - the capability the launcher claimed reaches the model's bash through the debug
//     extension's bash tool, so a review posted from the model's own command lands in
//     state/dryrun/ through the gate, and nothing reaches GitHub;
//   - the round order, with the command's marker, is the pi's first user message, and
//     the JSONL it leaves is the PR's own: the same id after the round, appended to;
//   - the manager sees the verdict, ends the pi, and a post after the release is refused.
//
// Skipped without a build (`npx tsc -p tsconfig.json`) or without `script`: it runs dist/.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jsonlHasMarker } from "../src/botworker.js";
import { DEBUG_STATUS_NAME, DebugRoundManager } from "../src/debuground.js";
import { LaunchFiles, capsDirOf, createCapabilityFd, ipcEnv } from "../src/ipc/capability.js";
import { runPostShim } from "../src/ipc/postshim.js";
import { newestSessionFile } from "../src/sessionjsonl.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { StateStore } from "../src/state.js";
import { composeLookups } from "../src/takeover.js";
import { Tmux } from "../src/tmux.js";
import { WorkerSupervisor } from "../src/workersupervisor.js";
import { FakePaneHost } from "./helpers/fake-pane-host.js";
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
import { trackPr } from "./helpers/session-hooks-host.js";
import { bornReference, rehearseFile, type RequestShape } from "./helpers/resume-rehearsal.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist", "src");
const hasDist =
  existsSync(join(DIST, "debugroundpi.js")) && existsSync(join(DIST, "ipc", "postshim.js"));
const hasScript = spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

let fake: FakeOpenAI;
let born: RequestShape;
beforeAll(async () => {
  fake = await startFakeOpenAI();
  if (hasDist && hasScript) born = await bornReference();
}, HEAVY_TIMEOUT_MS);
afterAll(async () => {
  await fake.close();
});

let world: World;
let daemon: FakeDaemon;
let posting: ReturnType<typeof registerDryRunPosting>;
const children: ChildProcess[] = [];

beforeEach(async () => {
  world = buildWorld("debug-round-smoke-");
  // The REAL post client the scripts hand over to, from the build.
  rmSync(join(world.root, "dist"), { recursive: true, force: true });
  mkdirSync(join(world.root, "dist", "src"), { recursive: true });
  symlinkSync(join(DIST, "ipc"), join(world.root, "dist", "src", "ipc"));
  writeFakeProvider(world.agentDir, fake.baseUrl);
  daemon = new FakeDaemon();
  await daemon.start();
  posting = registerDryRunPosting(daemon, world);
  fake.requests.length = 0;
  // The review body and the verdict, as the model's write tool would have left them.
  writeFileSync(join(world.root, "state", `pr-${PR}-round-1-review.md`), "Looks fine.\n");
  world.stageVerdict(1);
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await daemon.stop();
  rmSync(world.dir, { recursive: true, force: true });
});

const bashCall = (id: string, command: string) => ({
  toolCalls: [{ id, name: "bash", args: { command } }],
});

async function until(pred: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hasDist || !hasScript || process.platform !== "linux")(
  "[P8.13b] smoke: the real pane chain and the real pi CLI in a pty, on a local endpoint",
  () => {
    it(
      "posts from the model's own command through the gate, ends with the verdict, and a post after the release is refused",
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        const store = new StateStore(":memory:");
        const host = new FakePaneHost();
        const runDir = join(world.dir, "run");
        const supervisor = new WorkerSupervisor({
          store,
          capabilities: daemon.caps,
          runDir,
          socketPath: daemon.sock,
          workerMain: join(DIST, "botworker.js"),
          logDir: join(world.dir, "logs"),
          payloadDir: join(world.dir, "payloads"),
          buildSpec: () => {
            throw new Error("no worker is spawned in this test");
          },
        });
        const manager = new DebugRoundManager({
          store,
          commands: supervisor,
          capabilities: daemon.caps,
          launchFiles: new LaunchFiles({
            capsDir: capsDirOf(join(world.dir, "st")),
            store: daemon.caps,
          }),
          runDir,
          socketPath: daemon.sock,
          tmux: new Tmux({ exec: host.exec }),
          gate: () => ({ ok: true }),
          buildSpec: (row) => {
            const spec = world.spec(row.id, readFileSync(row.payload_path, "utf8"), {
              model: FAKE_MODEL,
              compact: false,
            });
            // The model has no memory server here; its pi finds `pi` in the repo's bin.
            for (const k of Object.keys(spec.env))
              if (k.startsWith("OPENVIKING_")) delete spec.env[k];
            Object.assign(spec.env, postingEnv);
            spec.env["PATH"] = `${join(ROOT, "node_modules", ".bin")}:${process.env["PATH"] ?? ""}`;
            return { ...spec, payload_path: row.payload_path, payload_sha256: row.payload_sha256 };
          },
          newestSessionFile,
          launcherMain: join(DIST, "ipc", "launcher.js"),
          debugMain: join(DIST, "debugroundpi.js"),
          killGraceMs: 100,
          proc: host.proc,
          signal: host.signal,
          now: () => host.clock,
          sleep: async (ms) => {
            host.clock += ms;
          },
        });
        // the daemon's server asks the debug manager for its commands
        const original = daemon.rows.get.bind(daemon.rows);
        daemon.rows.get = (id) =>
          composeLookups(manager.lookup, (x) => original(x) ?? null)(id) ?? undefined;

        trackPr(store, PR);
        store.startRound(PR, "first", ["pass-baseline"], 75);
        const order = "ROUND ORDER for PR 7\n";
        const payload = join(world.dir, "commands", "cmd-debug.md");
        mkdirSync(join(world.dir, "commands"), { recursive: true });
        writeFileSync(payload, order);
        const { createHash } = await import("node:crypto");
        const sha = createHash("sha256").update(order).digest("hex");
        const row = store.createSessionCommand({
          id: "cmd-debug",
          pr: PR,
          session: `pr-${PR}`,
          kind: "round",
          round_no: 1,
          payload_sha256: sha,
          payload_path: payload,
          inject_path: "worker:cmd-debug",
          next_check_at: new Date().toISOString(),
        });

        // `debug-round 7`: the lease is armed and the waiting order goes to the pi
        expect((await manager.arm(PR, "owner")).ok).toBe(true);
        expect(store.getSessionCommand(row.id)).toMatchObject({ status: "running" });
        const capability = daemon.caps.get(row.id)!;
        const { cmd, cwd } = host.sessions.get(`debug-pr-${PR}`)!;
        expect(cwd).toBe(world.root);

        fake.script([
          bashCall("call_1", "scripts/commit-verdict.sh pr-7-round-1.json"),
          bashCall(
            "call_2",
            `scripts/post-review.sh ${PR} COMMENT state/pr-${PR}-round-1-review.md`,
          ),
          { text: "round done" },
        ]);

        // The pane, as tmux runs it: the launcher claims the capability, then the entry.
        const line = `stty cols 140 rows 50; exec ${[process.execPath, ...cmd.slice(1)].map(q).join(" ")}`;
        const child = spawn("script", ["-qefc", line, "/dev/null"], {
          cwd,
          env: {
            PATH: `${join(ROOT, "node_modules", ".bin")}:${process.env["PATH"] ?? ""}`,
            HOME: join(world.dir, "home"),
            TERM: "xterm-256color",
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            GITHUB_TOKEN: "ghp_smoke_token",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        let screen = "";
        child.stdout!.on("data", (b: Buffer) => (screen += b.toString()));
        child.stderr!.on("data", (b: Buffer) => (screen += b.toString()));
        const exited = new Promise<number | null>((r) => child.on("close", (c) => r(c)));

        const statusFile = join(runDir, "debug", `debug-pr-${PR}.agent`, DEBUG_STATUS_NAME);
        const done = (): boolean =>
          posting.dryrun().length === 1 &&
          existsSync(join(world.root, "verdict", "pr-7-round-1.json")) &&
          fake.requests.length >= 3;
        try {
          await until(done, "the post, the verdict and the model's closing answer");
        } catch (e) {
          throw new Error(`${String(e)}\n--- pane ---\n${screen.slice(-3000)}`, { cause: e });
        }
        // the extension recorded that the order went out: the manager's receipt
        await until(() => existsSync(statusFile), "the progress record");
        const status = JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>;
        expect(status).toMatchObject({ state: "started" });
        expect(status["order_sent_at"]).toEqual(expect.any(String));

        // the manager marks the round started, sees the verdict, and ends the pi
        expect(await manager.sweep()).toMatchObject({ released: [] });
        expect(store.getSessionCommand(row.id)!.started_at).not.toBeNull();
        host.clock += 60_000;
        expect(await manager.sweep()).toMatchObject({ released: [] }); // verdict seen
        // the daemon's watcher applies the verdict and archives the file at once
        mkdirSync(join(world.root, "verdict", "processed"), { recursive: true });
        renameSync(
          join(world.root, "verdict", "pr-7-round-1.json"),
          join(world.root, "verdict", "processed", "2026-10-19T09-00-00-000Z-pr-7-round-1.json"),
        );
        host.clock += 60_000;
        // the person leaves pi (^D on an empty editor), the pane ends
        child.stdin!.write("\x04");
        setTimeout(() => child.kill("SIGKILL"), 10_000);
        await exited;
        // the tmux session ends with the pane's process
        host.die(host.sessions.get(`debug-pr-${PR}`)!.pid);
        expect(await manager.sweep()).toMatchObject({ released: [PR] });
        expect(store.getSessionCommand(row.id)).toMatchObject({ status: "acked" });
        expect(store.hostLease(PR)).toBeUndefined();

        // Posted through the daemon's one gate, in dry-run; nothing reached GitHub.
        const records = posting.dryrun();
        expect(records).toHaveLength(1);
        expect(JSON.stringify(records[0])).toContain("Looks fine.");
        expect(posting.gh.posts()).toEqual([]);
        expect(readdirSync(join(world.root, "verdict", "processed"))).toEqual([
          "2026-10-19T09-00-00-000Z-pr-7-round-1.json",
        ]);

        // The order, behind the command's marker, was the pi's first user message, and
        // no GitHub token reached the endpoint.
        const marker = sessionCommandMarker(row.id, sha);
        const bodies = fake.requests.map((r) => r.body).join("");
        expect(bodies).toContain("ROUND ORDER for PR 7");
        expect(bodies).toContain("ENGINE LENS ROUTE");
        expect(bodies).toContain(marker);
        expect(bodies).not.toContain("ghp_smoke_token");
        expect(bodies).not.toContain('"content":"/qcr-round"');

        // The JSONL is the PR's own, under its own id, and holds the marker: a worker that
        // takes the PR next resumes it and continues.
        const files = readdirSync(world.sessionDir).filter((f) => f.endsWith(".jsonl"));
        expect(files).toHaveLength(1);
        const file = newestSessionFile(world.sessionDir)!;
        expect(jsonlHasMarker(file, marker)).toBe(true);
        const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as { id: string };
        const rehearsal = await rehearseFile(file, "debug-round-smoke", born);
        expect(rehearsal.problems).toEqual([]);
        expect(rehearsal.resumed).toBe(true);
        expect(rehearsal.idKept).toBe(true);
        expect(rehearsal.historyKept).toBe(true);
        expect(readFileSync(file, "utf8").split("\n", 1)[0]).toContain(header.id);

        // A post after the release is refused, and writes nothing.
        // (the old capability, as the dead pi's shims held it)
        const fd = createCapabilityFd(join(world.dir, "fds"), capability);
        const late: string[] = [];
        const code = await runPostShim(
          "review",
          [String(PR), "COMMENT", join(world.root, "state", `pr-${PR}-round-1-review.md`)],
          {
            ...ipcEnv({
              socketPath: daemon.sock,
              commandId: row.id,
              generation: 1,
              capFdIndex: fd,
            }),
            QCR_ROUND_NO: "1",
          },
          { stdout: () => {}, stderr: (t) => void late.push(t) },
        );
        expect(code).toBe(1);
        expect(late.join("")).toMatch(/unauthorized|command_inactive|stale_generation/);
        expect(posting.dryrun()).toHaveLength(1);
      },
    );
  },
);
