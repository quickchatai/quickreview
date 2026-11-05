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
  /** The body a failed review POST answers with. */
  failReviewBody = "upstream trouble";
  /** The PR's files (the files API rows); null answers the read with a 404. */
  files: Array<Record<string, unknown>> | null = null;
  /** When set, a review POST carrying any inline comment answers 422 with
   * this validation message, as GitHub does for a line it cannot place. */
  rejectInlineComments: string | null = null;
  /** When set, the PR read answers with this status. */
  failPr: number | null = null;
  /** When set, every DELETE (the approval's trigger steps) answers with this status. */
  failDeletes: number | null = null;
  /** When set, the check-runs read answers with this status (or no answer,
   * or throws this error before any request is made). */
  failChecks: number | "network" | "hang" | Error | null = null;
  /** The PR's inline review comments, newest last; a posted reply joins them. */
  comments: Array<Record<string, unknown>> = [];
  /** When set, the review-comments read answers with this status. */
  failComments: number | null = null;
  /** When set, the reply POST answers with this status (or no answer). */
  failReplyPost: number | "network" | null = null;
  /** The reply POST lands on GitHub even though it fails (its answer lost). */
  replyLandsOnFailure = false;
  /** The failed reply POST's `Retry-After`, in seconds. */
  replyRetryAfterS: number | null = null;
  /** The reply POST is accepted, but its answer is cut short (invalid JSON),
   * and the reply is not yet visible to a read. */
  replyAnswerTruncated = false;
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
    if (method === "GET" && this.failPr !== null && /^\/pulls\/\d+$/.test(path))
      return new Response("pr unavailable", { status: this.failPr });
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
    if (method === "GET" && /\/check-runs$/.test(path)) {
      if (this.failChecks === "network") throw new TypeError("fetch failed");
      if (this.failChecks === "hang") return new Promise<Response>(() => {});
      if (this.failChecks instanceof Error) throw this.failChecks;
      if (this.failChecks !== null)
        return new Response("checks unavailable", { status: this.failChecks });
      return json({ total_count: this.checks.length, check_runs: this.checks });
    }
    if (method === "GET" && /^\/pulls\/\d+\/comments$/.test(path)) {
      if (this.failComments !== null)
        return new Response("comments unavailable", { status: this.failComments });
      return json([...this.comments].reverse());
    }
    if (method === "GET" && /^\/pulls\/\d+\/files$/.test(path))
      return this.files === null
        ? new Response("files unavailable", { status: 404 })
        : json(this.files.slice((Number(u.searchParams.get("page") ?? 1) - 1) * 100));
    if (method === "GET" && /\/status$/.test(path)) return json({ total_count: 0, statuses: [] });
    if (method === "GET" && /\/requested_reviewers$/.test(path)) return json({ teams: [] });
    if (method === "POST" && /^\/pulls\/\d+\/reviews$/.test(path)) {
      if (this.failReviewPost === "network") throw new TypeError("fetch failed");
      if (this.failReviewPost !== null)
        return new Response(this.failReviewBody, { status: this.failReviewPost });
      if (this.rejectInlineComments !== null && (body.comments ?? []).length > 0)
        return json({ message: "Unprocessable Entity", errors: [this.rejectInlineComments] }, 422);
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
    if (method === "POST" && /\/replies$/.test(path)) {
      const reply = {
        id: 9100 + this.comments.length,
        user: { login: BOT },
        body: body.body,
        in_reply_to_id: Number(/comments\/(\d+)\/replies$/.exec(path)?.[1]),
      };
      if (this.replyAnswerTruncated) return new Response(`{"id": ${reply.id}, "bo`);
      if (this.failReplyPost !== null) {
        if (this.replyLandsOnFailure) this.comments.push(reply);
        if (this.failReplyPost === "network") throw new TypeError("fetch failed");
        return new Response("upstream trouble", {
          status: this.failReplyPost,
          ...(this.replyRetryAfterS !== null
            ? { headers: { "retry-after": String(this.replyRetryAfterS) } }
            : {}),
        });
      }
      this.comments.push(reply);
      return json({ ...reply, html_url: `https://github.com/${REPO}/pull/${PR}#r${reply.id}` });
    }
    if (method === "DELETE")
      return this.failDeletes !== null
        ? new Response("delete refused", { status: this.failDeletes })
        : new Response(null, { status: 204 });
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

export async function buildRig(
  dryRun: boolean,
  clients: IpcClient[],
  opts: { readDeadlineMs?: number; now?: () => Date } = {},
): Promise<Rig> {
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
  // The adapter's read retry sleeps on nothing: a failing read is retried at once.
  const adapter: GitHubAdapter = new GitHubAdapter(
    cfg,
    minter,
    gate,
    gh.fetch as never,
    undefined,
    {
      sleep: async () => {},
      checkRestartMs: 0,
    },
  );
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
  const journal = new PostingJournal({
    dir: join(state, "posting-receipts"),
    repo: REPO,
    ...(opts.now ? { now: opts.now } : {}),
  });
  registerPostOps(server, {
    root,
    adapter,
    store,
    journal,
    cfg,
    botLogins: [BOT],
    log: (m) => logs.push(m),
    roundOf: (id) => rounds.get(id) ?? null,
    ...(opts.readDeadlineMs !== undefined ? { readDeadlineMs: opts.readDeadlineMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
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
