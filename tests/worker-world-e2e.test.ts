// [P8.15w] The whole bot, end to end, with workers as its only host.
//
// `createProductionDaemon` (src/wire.ts) runs for real: its worker world (the IPC server, the
// WorkerSupervisor and its spec builder, the host), its dispatch, its verdict watcher, its post
// ops and its gate. A signed webhook arrives over HTTP; the supervisor spawns the BUILT
// `dist/src/botworker.js` as a process; the worker's model is a loopback endpoint that plays a
// script (nothing leaves the machine, the offline guard fails the file on any other connection);
// the model's own bash commits the verdict and posts the review, which reaches GitHub's side
// only as a record under state/dryrun/; the verdict applies, and the round's cost is the figure
// the worker reported. A worker killed mid-round has its round requeued and a fresh worker
// started by the host's `launchPending` timer, which resumes the same JSONL.
//
// Skipped without a build (`npx tsc -p tsconfig.json`): it runs dist/.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import type { DaemonAdapter } from "../src/daemon.js";
import { MutationGate, type MutationIntent } from "../src/gate.js";
import { GitHubAdapter, type PrRef } from "../src/github.js";
import type { TokenMinter } from "../src/githubAuth.js";
import { runDirOf } from "../src/ipc/capability.js";
import { WorkerLeases, leaseDirOf } from "../src/workerlease.js";
import { PiSessionManager } from "../src/sessions.js";
import { signBody } from "../src/webhook.js";
import { createProductionDaemon } from "../src/wire.js";
import type { Daemon } from "../src/daemon.js";
import type { ExecFn } from "../src/tmux.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import { FakeGitHub, HEAD, PR, REPO as GH_REPO } from "./helpers/post-ops-rig.js";

useOfflineGuard({ loopback: true });

const REPO_DIR = resolve(import.meta.dirname, "..");
const hasDist =
  existsSync(join(REPO_DIR, "dist", "src", "botworker.js")) &&
  existsSync(join(REPO_DIR, "dist", "src", "ipc", "postshim.js"));

let fake: FakeOpenAI;
beforeAll(async () => {
  fake = await startFakeOpenAI();
});
afterAll(async () => {
  await fake.close();
});

const bashCall = (id: string, command: string) => ({
  toolCalls: [{ id, name: "bash", args: { command } }],
});

/** The round the model plays: commit the staged verdict, post the staged review, say done. */
const PLAYED_ROUND = [
  bashCall("call_1", "scripts/commit-verdict.sh pr-7-round-1.json"),
  bashCall(
    "call_2",
    `scripts/post-review.sh ${PR} REQUEST_CHANGES state/pr-${PR}-round-1-review.md`,
  ),
  { text: "round done" },
];

interface World {
  dir: string;
  root: string;
  daemon: Daemon;
  gh: FakeGitHub;
  port: number;
  tmuxCalls: string[][];
  store: () => import("../src/state.js").StateStore;
}

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = net.createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => ok(port));
    });
  });

/** A production-shaped root of its own: the repo's tree by symlink but for the directories the
 * daemon and its workers write. */
function buildRoot(): { dir: string; root: string; agentDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "worker-world-"));
  const root = join(dir, "root");
  mkdirSync(root);
  const own = new Set([".git", "state", "wt", "node_modules", "verdict", "scripts", "inject"]);
  for (const e of readdirSync(REPO_DIR))
    if (!own.has(e)) symlinkSync(join(REPO_DIR, e), join(root, e));
  symlinkSync(join(REPO_DIR, "node_modules"), join(root, "node_modules"));
  for (const d of ["state", "verdict", "scripts", "inject"]) mkdirSync(join(root, d));
  for (const f of ["commit-verdict.sh", "post-review.sh", "approve-pr.sh", "reply-thread.sh"]) {
    copyFileSync(join(REPO_DIR, "scripts", f), join(root, "scripts", f));
    chmodSync(join(root, "scripts", f), 0o755);
  }
  const agentDir = join(dir, "agent");
  writeFakeProvider(agentDir, fake.baseUrl);
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "A-TOKEN",
        refresh: "REAL-REFRESH",
        expires: Date.now() + 24 * 3_600_000,
      },
    }),
  );
  return { dir, root, agentDir };
}

const worlds: World[] = [];

async function buildWorld(): Promise<World> {
  const { dir, root, agentDir } = buildRoot();
  const port = await freePort();
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "webhook_secret"), "test\n");
  const base = loadConfig(join(REPO_DIR, "tests/fixtures/config.toml"));
  const cfg: Config = {
    ...base,
    dry_run: true,
    github: { ...base.github, repo: GH_REPO, secrets_dir: secrets },
    server: { ...base.server, port },
    openviking: { ...base.openviking, enabled: false },
    models: { ...base.models, conversation: FAKE_MODEL },
    pi: { ...base.pi, engine_wave: false },
    login_refresh: { ...base.login_refresh, enabled: false },
  };
  // The worker finds its login where the daemon says: this world's agent dir.
  process.env["PI_CODING_AGENT_DIR"] = agentDir;

  const gh = new FakeGitHub();
  const minter = {
    installationToken: async () => "t",
    appJwt: () => "j",
    invalidate: () => {},
  } as unknown as TokenMinter;
  const gate: MutationGate = new MutationGate(
    true,
    join(root, "state", "dryrun"),
    (intent: MutationIntent): Promise<unknown> => adapter.executeMutation(intent),
  );
  const real: GitHubAdapter = new GitHubAdapter(cfg, minter, gate, gh.fetch as never);
  const pr: PrRef = {
    number: PR,
    title: "Add rate limiting",
    author: "alice",
    head_sha: HEAD,
    base_ref: "master",
    updated_at: "2026-10-20T00:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [cfg.github.trigger_label],
  };
  // The real adapter for everything it can do over the scripted GitHub (the post ops, the
  // gate); the PR-list reads the scripted GitHub does not model are answered here.
  const adapter = Object.assign(Object.create(real), {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    searchAwaitingEscalationReviewer: async () => [],
    listOpenPrs: async () => [pr],
    getPr: async () => pr,
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [
      { filename: "src/app.ts", additions: 5, deletions: 1, status: "modified" },
    ],
  }) as GitHubAdapter & DaemonAdapter;

  // No git: the worktree is a directory. tmux is a recording fake that refuses everything, so
  // any pr-<n> session born through it would show.
  const worktrees = new Proxy(
    {
      worktreePath: (n: number) => join(root, "wt", `pr-${n}`),
      hasCommit: async () => false,
      ensureWorktree: async (n: number, o: { baseRef?: string } = {}) => {
        mkdirSync(join(root, "wt", `pr-${n}`), { recursive: true });
        return {
          path: join(root, "wt", `pr-${n}`),
          head_sha: HEAD,
          base_ref: o.baseRef ?? "",
          base_sha: "",
          merge_base: "",
        };
      },
      checkoutAt: async (n: number) => join(root, "wt", `pr-${n}`),
      sweepStale: async () => [],
      remove: async () => {},
      listMigrationFiles: async () => [],
      pinReviewedHead: async () => {},
    } as Record<string, unknown>,
    {
      get: (target, name: string) =>
        target[name] ??
        (async () => {
          throw new Error(`worktrees.${name} is not stubbed in this test`);
        }),
    },
  );
  const tmuxCalls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    tmuxCalls.push([cmd, ...args.map(String)]);
    return { code: 1, stdout: "", stderr: "no tmux in this test" };
  };
  const sessions = new PiSessionManager({
    cfg,
    root,
    exec,
    worktrees: worktrees as never,
    configPath: join(dir, "config.toml"),
  });
  const daemon = createProductionDaemon({ cfg, root, minter, gate, adapter, sessions });
  const w: World = { dir, root, daemon, gh, port, tmuxCalls, store: () => daemon.store };
  worlds.push(w);
  await daemon.start();
  return w;
}

/** The files the model's own commands pick up: the verdict as its write tool would leave it, and
 * the review body. */
function stageRound(w: World): void {
  writeFileSync(join(w.root, "state", `pr-${PR}-round-1-review.md`), "Please bound the retries.\n");
  writeFileSync(
    join(w.root, "verdict", `pr-${PR}-round-1.json.tmp`),
    JSON.stringify({
      pr: PR,
      round_no: 1,
      verdict: "REQUEST_CHANGES",
      head_sha: HEAD,
      passes: [],
      finished_at: new Date().toISOString(),
    }),
  );
}

/** The signed `labeled` webhook that triggers a review of PR 7. */
async function trigger(w: World): Promise<void> {
  const raw = Buffer.from(
    JSON.stringify({
      action: "labeled",
      label: { name: "AI review requested" },
      pull_request: {
        number: PR,
        title: "Add rate limiting",
        head: { sha: HEAD },
        user: { login: "alice" },
      },
      sender: { login: "alice", type: "User" },
    }),
  );
  const res = await fetch(`http://127.0.0.1:${w.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signBody(raw, "test"),
    },
    body: raw,
  });
  expect(res.status).toBeLessThan(300);
}

const dryrunRecords = (w: World): Array<Record<string, any>> => {
  const d = join(w.root, "state", "dryrun");
  return existsSync(d)
    ? readdirSync(d)
        .sort()
        .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as Record<string, any>)
    : [];
};

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.daemon.stop().catch(() => {});
    rmSync(w.dir, { recursive: true, force: true });
  }
  delete process.env["PI_CODING_AGENT_DIR"];
});

describe.skipIf(!hasDist)("[P8.15w] the production daemon, with workers as its only host", () => {
  beforeEach(() => {
    fake.requests.length = 0;
  });

  it(
    "a signed webhook runs a round in a worker: it posts into state/dryrun, the verdict applies and the cost is the worker's",
    { timeout: 120_000 },
    async () => {
      const w = await buildWorld();
      fake.script(PLAYED_ROUND);
      stageRound(w);
      await trigger(w);

      await vi.waitFor(
        () => expect(w.store().roundsFor(PR)[0]?.status, "the round settles").toBe("done"),
        { timeout: 90_000, interval: 100 },
      );
      // The round-end measurement lands a moment after the round is marked done.
      await vi.waitFor(
        () => expect(w.store().roundsFor(PR)[0]?.est_usd, "the round's cost").not.toBeNull(),
        { timeout: 30_000, interval: 100 },
      );

      // The supervisor spawned the worker for the round's command, which a worker acked.
      const command = w.store().sessionCommandForRound(PR, 1)!;
      expect(command.kind).toBe("round");
      expect(command.status).toBe("acked");
      expect(command.attempt).toBe(1);

      // The review reached GitHub's side only as the gate's record, and nothing was sent.
      const posted = dryrunRecords(w).filter((r) => r["kind"] === "create_review");
      expect(posted).toHaveLength(1);
      expect(posted[0]!["body"]["event"]).toBe("REQUEST_CHANGES");
      expect(JSON.stringify(posted[0])).toContain("Please bound the retries.");
      expect(w.gh.posts()).toEqual([]);

      // The verdict applied, and the round's spend is the worker's report, not a transcript's.
      const round = w.store().roundsFor(PR)[0]!;
      expect(round.verdict).toBe("REQUEST_CHANGES");
      expect(command.usage_final).toBe(1);
      expect(command.est_usd).toBeGreaterThan(0);
      expect(round.est_usd).toBeCloseTo(command.est_usd!, 6);

      // No pr-<n> tmux session was ever asked for; the only tmux the daemon spoke to was the overseer's.
      expect(w.tmuxCalls.filter((c) => c.some((a) => /^=?pr-\d+$/.test(a)))).toEqual([]);
      // And no inject file was ever written for the PR.
      expect(existsSync(join(w.root, "inject", `pr-${PR}`))).toBe(false);
    },
  );

  it(
    "a worker killed mid-round: the round's command requeues and the launchPending timer starts a fresh worker over the same JSONL",
    { timeout: 120_000 },
    async () => {
      const w = await buildWorld();
      // The first request is the round order; the model takes its time over it.
      fake.script([{ text: "slow", delayMs: 60_000 }]);
      stageRound(w);
      await trigger(w);

      await vi.waitFor(() => expect(fake.requests.length).toBeGreaterThanOrEqual(1), {
        timeout: 60_000,
        interval: 50,
      });
      const command = w.store().sessionCommandForRound(PR, 1)!;
      expect(command.status).toBe("running");
      // The worker's lease names its process group; the group is what dies.
      const lease = new WorkerLeases(leaseDirOf(runDirOf(join(w.root, "state"))))
        .list()
        .find((l) => l.session === `pr-${PR}`)?.lease;
      const pid = lease?.pgid ?? 0;
      expect(pid).toBeGreaterThan(1);

      fake.script(PLAYED_ROUND);
      fake.requests.length = 0;
      process.kill(-pid, "SIGKILL");

      await vi.waitFor(
        () => expect(w.store().roundsFor(PR)[0]?.status, "the round settles").toBe("done"),
        { timeout: 90_000, interval: 100 },
      );
      const after = w.store().sessionCommandForRound(PR, 1)!;
      expect(after.id).toBe(command.id);
      expect(after.status).toBe("acked");
      expect(after.attempt).toBeGreaterThan(1);
      expect(dryrunRecords(w).filter((r) => r["kind"] === "create_review")).toHaveLength(1);
      // One JSONL: the fresh worker resumed it.
      const sessionDir = join(w.root, "state", "pi-sessions", `pr-${PR}`);
      expect(readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    },
  );
});
