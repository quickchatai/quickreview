// The rig behind the post-op tests: a real IpcServer on a real unix
// socket, the real post ops, the real GitHubAdapter (App minter stubbed) over a
// scripted GitHub `fetch`, the real MutationGate with the real posting guards,
// and the real receipt/outbox journal, all over a throwaway sandbox root.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import { MutationGate, type MutationIntent } from "@quickchatai/pi-quickreview/src/gate.js";
import { GitHubAdapter } from "../../src/github.js";
import { makePostingGuard } from "@quickchatai/pi-quickreview/src/guards.js";
import type { TokenMinter } from "@quickchatai/pi-quickreview/src/githubAuth.js";
import { CapabilityStore, socketPathOf } from "../../src/ipc/capability.js";
import { IpcClient } from "../../src/ipc/client.js";
import type { CommandState } from "../../src/ipc/protocol.js";
import { IpcServer } from "../../src/ipc/server.js";
import { PostingJournal } from "../../src/posting-journal.js";
import { roundPostingKey } from "../../src/posting-receipt.js";
import { registerPostOps, type PostRound } from "../../src/postops.js";
import { StateStore } from "../../src/state.js";

export const SANDBOX = resolve(import.meta.dirname, "..", "..");
export const HEAD = "68b8040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const MOVED = "99999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const PR = 7;
export const OTHER_PR = 8;
export const KEY = roundPostingKey(PR, 1, HEAD);
export const REPO = "example-org/example-app";
export const BOT = "example-review[bot]";

/** A scripted GitHub: the reads the adapter and guards make, and the writes. */
export class FakeGitHub {
  pr = { state: "open", merged: false, head: HEAD, author: "alice" };
  reviews: Array<Record<string, unknown>> = [];
  checks: Array<{ name: string; status: string; conclusion: string | null }> = [
    { name: "ci", status: "completed", conclusion: "success" },
  ];
  /** When set, the review POST answers with this status. */
  failReviewPost: number | "network" | null = null;
  calls: Array<{ method: string; path: string; body?: any }> = [];
  posts(): Array<{ method: string; path: string; body?: any }> {
    return this.calls.filter((c) => c.method !== "GET");
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const path = u.pathname.replace(`/repos/${REPO}`, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(path)))
      return json({
        number: Number(m[1]),
        title: "t",
        user: { login: this.pr.author },
        head: { sha: this.pr.head },
        state: this.pr.state,
        merged: this.pr.merged,
        labels: [],
      });
    if (method === "GET" && /^\/pulls\/\d+\/reviews$/.test(path))
      return json(this.reviews.slice((Number(u.searchParams.get("page")) - 1) * 100));
    if (method === "GET" && /\/check-runs$/.test(path))
      return json({ total_count: this.checks.length, check_runs: this.checks });
    if (method === "GET" && /\/status$/.test(path)) return json({ total_count: 0, statuses: [] });
    if (method === "GET" && /\/requested_reviewers$/.test(path)) return json({ teams: [] });
    if (method === "POST" && /^\/pulls\/\d+\/reviews$/.test(path)) {
      if (this.failReviewPost === "network") throw new TypeError("fetch failed");
      if (this.failReviewPost !== null)
        return new Response("upstream trouble", { status: this.failReviewPost });
      const state =
        body.event === "APPROVE"
          ? "APPROVED"
          : body.event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED";
      return json({
        id: 501,
        html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-501`,
        commit_id: body.commit_id,
        state,
        comments: (body.comments ?? []).map((_: unknown, i: number) => ({ id: 7000 + i })),
      });
    }
    if (method === "POST" && /\/replies$/.test(path))
      return json({ id: 9100, html_url: `https://github.com/${REPO}/pull/${PR}#r9100` });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({ message: `unscripted ${method} ${path}` }, 404);
  };
}

export interface Rig {
  root: string;
  state: string;
  cfg: Config;
  store: StateStore;
  gh: FakeGitHub;
  caps: CapabilityStore;
  server: IpcServer;
  journal: PostingJournal;
  rows: Map<string, CommandState>;
  rounds: Map<string, PostRound>;
  dryrun: string;
  /** What the post ops logged daemon-side. */
  logs: string[];
  /** The daemon socket the shims dial. */
  sock: string;
  /** Write a result file the host would write, returning its path. */
  write(name: string, text: string, dir?: string): string;
  connect(
    id: string,
    over?: { generation?: number; role?: "worker" | "shim"; capability?: string },
  ): Promise<IpcClient>;
}

export async function buildRig(dryRun: boolean, clients: IpcClient[]): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "po-"));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "verdict"), { recursive: true });
  const state = join(root, "state");
  const cfg = { ...loadConfig(join(SANDBOX, "tests/fixtures/config.toml")), dry_run: dryRun };
  cfg.github.repo = REPO;
  const store = new StateStore(":memory:");
  const gh = new FakeGitHub();
  const minter = {
    installationToken: async () => "t",
    appJwt: () => "j",
    invalidate: () => {},
  } as unknown as TokenMinter;
  const dryrun = join(state, "dryrun");
  const gate: MutationGate = new MutationGate(
    dryRun,
    dryrun,
    (intent: MutationIntent): Promise<unknown> => adapter.executeMutation(intent),
  );
  const adapter: GitHubAdapter = new GitHubAdapter(cfg, minter, gate, gh.fetch as never);
  gate.setGuard(
    makePostingGuard({ store, adapter, botLogin: cfg.github.bot_login, guards: cfg.guards }),
  );
  const logs: string[] = [];
  const caps = new CapabilityStore();
  const rows = new Map<string, CommandState>();
  const rounds = new Map<string, PostRound>();
  const sockDir = mkdtempSync(join(tmpdir(), "po-s-"));
  const server = new IpcServer({
    socketPath: socketPathOf(sockDir),
    capabilities: caps,
    commands: (id) => rows.get(id) ?? null,
    helloTimeoutMs: 500,
  });
  const journal = new PostingJournal({ dir: join(state, "posting-receipts"), repo: REPO });
  registerPostOps(server, {
    root,
    adapter,
    store,
    journal,
    cfg,
    botLogins: [BOT],
    log: (m) => logs.push(m),
    roundOf: (id) => rounds.get(id) ?? null,
  });
  await server.start();
  const r: Rig = {
    root,
    state,
    cfg,
    store,
    gh,
    caps,
    server,
    journal,
    rows,
    rounds,
    dryrun,
    logs,
    sock: socketPathOf(sockDir),
    write(name, text, dir = state) {
      mkdirSync(dir, { recursive: true });
      const p = join(dir, name);
      writeFileSync(p, text);
      return p;
    },
    async connect(id, over = {}) {
      const c = await IpcClient.connect({
        socketPath: socketPathOf(sockDir),
        role: over.role ?? "shim",
        commandId: id,
        capability: over.capability ?? caps.get(id) ?? caps.mint(id),
        generation: over.generation ?? 1,
        timeoutMs: 5000,
      });
      clients.push(c);
      return c;
    },
  };
  return r;
}

/** A round command on PR 7 (round 1 at HEAD), and the capability it holds. */
export function roundCommand(rig: Rig, id = "c-round", over: Partial<CommandState> = {}): void {
  rig.rows.set(id, {
    pr: PR,
    generation: 1,
    active: true,
    may_post: false,
    lease: "none",
    ...over,
  });
  rig.caps.mint(id);
  rig.rounds.set(id, { round_no: 1, head_sha: HEAD });
}

/** An unkeyed command (no round): an answer worker, say. */
export function plainCommand(rig: Rig, id: string, over: Partial<CommandState> = {}): void {
  rig.rows.set(id, {
    pr: PR,
    generation: 1,
    active: true,
    may_post: false,
    lease: "none",
    ...over,
  });
  rig.caps.mint(id);
}

export const COMMENTS = JSON.stringify([
  { path: "a.py", line: 3, side: "RIGHT", body: "[blocker] x", extra: "dropped" },
]);

export function dryrunRecords(rig: Rig): Array<Record<string, any>> {
  if (!existsSync(rig.dryrun)) return [];
  return readdirSync(rig.dryrun)
    .sort()
    .map((f) => JSON.parse(readFileSync(join(rig.dryrun, f), "utf8")));
}
