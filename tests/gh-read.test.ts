// The session helpers' GitHub reads, served by the daemon. Under the
// D32 split the model's bash runs as a uid that cannot read secrets/, so the
// helpers (pr-context.sh, pr-checks.sh, pr-threads.sh, pr-self.sh) can no longer
// mint a token: on a daemon's host they ask the daemon over the worker socket
// (src/ghread.ts, src/ipc/ghreadshim.ts). What is served is a read of the
// reviewed repo and nothing else.
//
// The scripts run for real against the BUILT shim (dist/), a real IpcServer and
// the real GitHubAdapter over a scripted fetch: no network, no credential.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MutationGate } from "../src/gate.js";
import {
  GH_READ_LOG_TAIL_BYTES,
  GH_READ_MAX_IN_FLIGHT,
  GH_READ_PER_MINUTE,
  GH_READ_OP,
  GH_READ_QUERIES,
  ghReadOps,
  parseGhRead,
  readablePath,
} from "../src/ghread.js";
import { GitHubAdapter, cappedText } from "../src/github.js";
import type { TokenMinter } from "../src/githubAuth.js";
import { CapabilityStore, createCapabilityFd, socketPathOf } from "../src/ipc/capability.js";
import { IpcError, type CommandState } from "../src/ipc/protocol.js";
import { IpcServer, type RequestContext } from "../src/ipc/server.js";
import { loadConfig } from "../src/config.js";

const SANDBOX = resolve(import.meta.dirname, "..");
const OWNER = "example-org";
const REPO = "example-app";
const HEAD = "68b8040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("what the daemon reads", () => {
  it("a REST read is a plain path under the reviewed repo", () => {
    for (const p of [
      `/repos/${OWNER}/${REPO}/pulls/7`,
      `/repos/${OWNER}/${REPO}/pulls/7/reviews?per_page=100&page=2`,
      `/repos/Example-Org/Example-App/commits/${HEAD}/check-runs?per_page=100&page=1`,
      `/repos/${OWNER}/${REPO}/actions/jobs/123/logs`,
    ])
      expect(readablePath(p, OWNER, REPO), p).toBe(p);
  });

  it("refuses another repo, a traversal, an encoded separator, a URL, an empty segment", () => {
    // MUTATION: drop the owner/repo comparison in readablePath — the first two pass
    for (const p of [
      `/repos/other-org/${REPO}/pulls/7`,
      `/repos/${OWNER}/other/pulls/7`,
      `/repos/${OWNER}/${REPO}`,
      `/repos/${OWNER}/${REPO}/../other/pulls/7`,
      `/repos/${OWNER}/${REPO}/pulls/%2e%2e/x`,
      `/repos/${OWNER}/${REPO}/pulls%2f7`,
      `https://api.github.com/repos/${OWNER}/${REPO}/pulls/7`,
      `//evil.example/repos/${OWNER}/${REPO}/pulls/7`,
      `/repos/${OWNER}/${REPO}//pulls`,
      `/user`,
      `/graphql`,
      `/repos/${OWNER}/${REPO}/pulls/7?x=<y>`,
      "",
      42,
    ])
      expect(() => readablePath(p, OWNER, REPO), String(p)).toThrow(/github\.read/);
  });

  it("a GraphQL read is one of the daemon's own queries, by name, the repo filled in", () => {
    expect(
      parseGhRead({ kind: "graphql", name: "pr-threads", variables: { number: 7 } }, OWNER, REPO),
    ).toEqual({
      kind: "graphql",
      name: "pr-threads",
      variables: { owner: OWNER, name: REPO, number: 7, after: null },
    });
    const bad = [
      { kind: "graphql", name: "mutation", variables: { number: 7 } },
      { kind: "graphql", query: "mutation { x }", variables: { number: 7 } },
      { kind: "graphql", name: "pr-threads", variables: { number: 7, owner: "other-org" } },
      { kind: "graphql", name: "pr-threads", variables: { number: 0 } },
      { kind: "graphql", name: "pr-threads", variables: { number: 7, after: "x y" } },
      { kind: "graphql", name: "pr-context", variables: { number: 7, after: "c" } },
      { kind: "post", path: `/repos/${OWNER}/${REPO}/pulls/7/reviews` },
      { kind: "rest", path: `/repos/${OWNER}/${REPO}/pulls/7`, method: "POST" },
    ];
    for (const b of bad.slice(0, 6))
      expect(() => parseGhRead(b, OWNER, REPO), JSON.stringify(b)).toThrow(/github\.read/);
    expect(() => parseGhRead(bad[6], OWNER, REPO)).toThrow(/`kind` must be rest or graphql/);
    // a method is not a field: the read is a GET whatever the body says
    expect(parseGhRead(bad[7], OWNER, REPO)).toEqual({
      kind: "rest",
      path: `/repos/${OWNER}/${REPO}/pulls/7`,
      tail: false,
    });
  });

  it("the queries are reads, and the scripts carry the same text for a host without the daemon", () => {
    const norm = (s: string): string => s.replace(/\s+/g, "");
    for (const q of Object.values(GH_READ_QUERIES)) {
      expect(q.text.trimStart().startsWith("query(")).toBe(true);
      expect(q.text).not.toMatch(/\b(mutation|subscription)\b/);
      expect(q.text).toContain("repository(owner:$owner,name:$name)");
    }
    const threads = readFileSync(join(SANDBOX, "scripts", "pr-threads.sh"), "utf8");
    const t = /GQL='([^']*)'/.exec(threads)?.[1];
    expect(t && norm(t)).toBe(norm(GH_READ_QUERIES["pr-threads"].text));
    const context = readFileSync(join(SANDBOX, "scripts", "pr-context.py"), "utf8");
    const c = /query = '''([\s\S]*?)'''/.exec(context)?.[1];
    expect(c && norm(c)).toBe(norm(GH_READ_QUERIES["pr-context"].text));
  });

  it("a job log keeps its tail; everything else its head", async () => {
    const body = "a".repeat(10) + "b".repeat(10);
    const head = await cappedText(new Response(body), 12, false);
    expect(head).toEqual({ text: "a".repeat(10) + "bb", truncated: true });
    const tail = await cappedText(new Response(body), 12, true);
    expect(tail).toEqual({ text: "aa" + "b".repeat(10), truncated: true });
    expect(await cappedText(new Response(body), 100, true)).toEqual({
      text: body,
      truncated: false,
    });
    const logs = parseGhRead(
      { kind: "rest", path: `/repos/${OWNER}/${REPO}/actions/jobs/9/logs` },
      OWNER,
      REPO,
    );
    expect(logs).toMatchObject({ tail: true });
    expect(GH_READ_LOG_TAIL_BYTES).toBeLessThan(1024 * 1024);
  });
});

/** A scripted GitHub, and every request it saw. */
function fakeGitHub() {
  const calls: Array<{ method: string; path: string; auth: string | null; body?: any }> = [];
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, auth: headers.get("authorization"), body });
    const p = u.pathname.replace(`/repos/${OWNER}/${REPO}`, "");
    if (method === "POST" && u.pathname === "/graphql") {
      const pr = { number: body.variables.number };
      if (String(body.query).includes("files(first:100"))
        return json({
          data: {
            repository: {
              pullRequest: {
                title: "A PR",
                state: "OPEN",
                headRefOid: HEAD,
                baseRefName: "master",
                author: { login: "alice" },
                files: {
                  nodes: [{ path: "a.py", additions: 1, deletions: 0 }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviews: { nodes: [] },
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        });
      return json({
        data: {
          repository: {
            pullRequest: {
              ...pr,
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    isResolved: false,
                    isOutdated: false,
                    path: "a.py",
                    line: 3,
                    comments: {
                      totalCount: 1,
                      nodes: [{ databaseId: 11, author: { login: "bob" }, body: "why?" }],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (method !== "GET") return new Response("no", { status: 405 });
    if (/^\/pulls\/\d+$/.test(p)) return json({ number: 7, head: { sha: HEAD } });
    if (/\/check-runs$/.test(u.pathname))
      return json({
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: "ci",
            status: "completed",
            conclusion: "success",
            html_url: "u",
            started_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
    if (/\/status$/.test(u.pathname)) return json({ total_count: 0, statuses: [] });
    if (/\/pulls\/\d+\/reviews$/.test(p))
      return json([{ id: 5, user: { login: "bot[bot]" }, state: "COMMENTED", commit_id: HEAD }]);
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch };
}

describe("the helpers read through the daemon, holding no token", () => {
  let dir: string;
  let server: IpcServer;
  let caps: CapabilityStore;
  let rows: Map<string, CommandState>;
  let gh: ReturnType<typeof fakeGitHub>;
  let fd: number;
  let sock: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ghread-"));
    gh = fakeGitHub();
    const cfg = loadConfig(join(SANDBOX, "tests/fixtures/config.toml"));
    cfg.github.repo = `${OWNER}/${REPO}`;
    const minter = {
      installationToken: async () => "ghs_DAEMON_ONLY",
      appJwt: () => "j",
      invalidate: () => {},
    } as unknown as TokenMinter;
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => {
      throw new Error("no mutation in a read");
    });
    const adapter = new GitHubAdapter(cfg, minter, gate, gh.fetch as never);
    caps = new CapabilityStore();
    rows = new Map();
    sock = socketPathOf(join(dir, "state"));
    server = new IpcServer({
      socketPath: sock,
      capabilities: caps,
      commands: (id) => rows.get(id) ?? null,
      ops: ghReadOps({ reader: adapter }),
    });
    await server.start();
    rows.set("c-round", { pr: 7, generation: 1, active: true, may_post: false, lease: "none" });
    caps.mint("c-round");
    fd = createCapabilityFd(join(dir, "state"), caps.get("c-round")!);
    writeFileSync(
      join(dir, "config.toml"),
      `[github]\nrepo = "${OWNER}/${REPO}"\nbot_login = "bot[bot]"\n`,
    );
  });
  afterEach(async () => {
    closeSync(fd);
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One script, as the model's bash runs it: the IPC names in env, the
   * capability on fd 3, no token and no secrets anywhere. Async: the daemon's
   * socket answers in this process. */
  const run = (
    script: string,
    args: string[],
  ): Promise<{ code: number; out: string; err: string }> =>
    new Promise((done) => {
      const child = spawn("bash", [join(SANDBOX, "scripts", script), ...args], {
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: dir,
          QCR_CONFIG: join(dir, "config.toml"),
          // a mint attempt would find nothing to mint from
          QCR_SECRETS_MOUNT: join(dir, "no-secrets"),
          GITHUB_API: "http://127.0.0.1:9", // a direct read would fail to connect
          QCR_IPC_SOCKET: sock,
          QCR_IPC_COMMAND_ID: "c-round",
          QCR_IPC_GENERATION: "1",
          QCR_IPC_CAP_FD: "3",
        },
        stdio: ["ignore", "pipe", "pipe", fd],
      });
      let out = "";
      let err = "";
      child.stdout!.on("data", (d) => (out += String(d)));
      child.stderr!.on("data", (d) => (err += String(d)));
      child.on("close", (code) => done({ code: code ?? 1, out, err }));
    });

  it("pr-self.sh head and reviews, pr-checks.sh, pr-threads.sh and pr-context.sh", async () => {
    // MUTATION: drop the VIA_DAEMON branch of pr-self.sh — it mints, finds no
    // key and reads GitHub unauthenticated at an unreachable API: this fails.
    const head = await run("pr-self.sh", ["7", "head"]);
    expect(head, head.err).toMatchObject({ code: 0 });
    expect(head.out.trim()).toBe(HEAD);
    const reviews = await run("pr-self.sh", ["7", "reviews"]);
    expect(reviews.code, reviews.err).toBe(0);
    expect(reviews.out).toContain(`[5] COMMENTED @ ${HEAD}`);
    const checks = await run("pr-checks.sh", ["7"]);
    expect(checks.code, checks.err).toBe(0);
    expect(checks.out).toContain("SUMMARY: 1 passed / 0 failed / 0 pending");
    const threads = await run("pr-threads.sh", ["7"]);
    expect(threads.code, threads.err).toBe(0);
    expect(threads.out).toContain("[11] bob: why?");
    const context = await run("pr-context.sh", ["7"]);
    expect(context.code, context.err).toBe(0);
    expect(context.out).toContain("title: A PR");
    expect(context.out).toContain("ci: completed/success");
    // Every request was the daemon's, with the daemon's token; none was a write
    // but the GraphQL reads, each one of the daemon's own query texts.
    expect(gh.calls.length).toBeGreaterThan(5);
    for (const c of gh.calls) {
      expect(c.auth).toBe("Bearer ghs_DAEMON_ONLY");
      if (c.method === "POST") {
        expect(c.path).toBe("/graphql");
        expect(Object.values(GH_READ_QUERIES).map((q) => q.text)).toContain(c.body.query);
        expect(c.body.variables).toMatchObject({ owner: OWNER, name: REPO, number: 7 });
      } else expect(c.method).toBe("GET");
    }
  });

  it("a read outside the repo is refused by the daemon, and the script says so", async () => {
    const child = await new Promise<{ code: number; out: string; err: string }>((done) => {
      const c = spawn(
        "node",
        [
          join(SANDBOX, "dist", "src", "ipc", "ghreadshim.js"),
          "get",
          "/repos/other-org/secret-repo/contents/x",
          join(dir, "out"),
        ],
        {
          env: {
            PATH: process.env["PATH"] ?? "",
            QCR_IPC_SOCKET: sock,
            QCR_IPC_COMMAND_ID: "c-round",
            QCR_IPC_GENERATION: "1",
            QCR_IPC_CAP_FD: "3",
          },
          stdio: ["ignore", "pipe", "pipe", fd],
        },
      );
      let out = "";
      let err = "";
      c.stdout!.on("data", (d) => (out += String(d)));
      c.stderr!.on("data", (d) => (err += String(d)));
      c.on("close", (code) => done({ code: code ?? 1, out, err }));
    });
    expect(child.code).toBe(1);
    expect(child.out).toBe("");
    expect(child.err).toMatch(/bad_request: github\.read: only the reviewed repo is read/);
    expect(gh.calls).toEqual([]);
  });

  it("the op is served to a shim and a worker, and only to a live command", () => {
    const op = ghReadOps({ reader: {} as never })[GH_READ_OP]!;
    expect([...op.roles].sort()).toEqual(["shim", "worker"]);
  });
});

describe("a read is the command's PR's, and bounded", () => {
  const reader = (gate?: Promise<void>) => ({
    owner: "acme",
    repo: "webapp",
    calls: 0,
    async readText() {
      this.calls++;
      await gate;
      return { status: 200, body: "{}", truncated: false };
    },
    async graphqlText() {
      this.calls++;
      await gate;
      return { status: 200, body: "{}", truncated: false };
    },
  });
  const ctxFor = (pr: number) =>
    ({
      pr,
      requirePr(n: unknown) {
        if (n !== pr) throw new IpcError("wrong_pr", `not pr ${pr}`);
      },
    }) as unknown as RequestContext;

  it("refuses a read that names another PR, by REST path or GraphQL number", async () => {
    const r = reader();
    const op = ghReadOps({ reader: r })[GH_READ_OP]!;
    for (const body of [
      { kind: "rest", path: "/repos/acme/webapp/pulls/8/files" },
      { kind: "rest", path: "/repos/acme/webapp/issues/8/comments" },
      { kind: "rest", path: "/repos/acme/webapp/pulls/%38/files" },
      { kind: "graphql", name: "pr-threads", variables: { number: 8 } },
    ])
      await expect(op.handle(ctxFor(7), body)).rejects.toMatchObject({ code: "wrong_pr" });
    expect(r.calls).toBe(0);
    await expect(
      op.handle(ctxFor(7), { kind: "rest", path: "/repos/acme/webapp/pulls/7/files" }),
    ).resolves.toMatchObject({ status: 200 });
    // a repo-wide read names no PR
    await expect(
      op.handle(ctxFor(7), { kind: "rest", path: "/repos/acme/webapp/commits/abc/check-runs" }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("holds a PR to its in-flight and per-minute bounds, and lets another PR read", async () => {
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    const r = reader(gate);
    let t = 0;
    const op = ghReadOps({ reader: r, now: () => t })[GH_READ_OP]!;
    const body = { kind: "rest", path: "/repos/acme/webapp/pulls/7" };
    const held = Array.from({ length: GH_READ_MAX_IN_FLIGHT }, () => op.handle(ctxFor(7), body));
    await expect(op.handle(ctxFor(7), body)).rejects.toMatchObject({ code: "rate_limited" });
    // another PR is not held by PR 7's bound
    const other = op.handle(ctxFor(9), { kind: "rest", path: "/repos/acme/webapp/pulls/9" });
    open();
    await Promise.all(held);
    await expect(other).resolves.toMatchObject({ status: 200 });
    // the minute's budget
    let served = GH_READ_MAX_IN_FLIGHT;
    while (served < GH_READ_PER_MINUTE) {
      await op.handle(ctxFor(7), body);
      served++;
    }
    await expect(op.handle(ctxFor(7), body)).rejects.toMatchObject({ code: "rate_limited" });
    t += 60_000;
    await expect(op.handle(ctxFor(7), body)).resolves.toMatchObject({ status: 200 });
  });
});
