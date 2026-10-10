// scripts/pr-threads.sh — the sessions' read-only list of unresolved review
// threads. The real script runs against a loopback GraphQL stub from a scratch
// root that carries it, the install locator and a stub mint-token.sh (the
// script needs a token string; no real credential exists here).
//
// The invariant under test is completeness: every page of review threads is
// read, and a read the script had to cut short says so rather than reading as
// the whole discussion.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number;
  comments: {
    totalCount: number;
    nodes: { databaseId: number; author: { login: string }; body: string }[];
  };
}

let server: Server;
let apiBase: string;
let dir: string;
let threads: Thread[];
let pageSize: number;
let cursorsSeen: (string | null)[];

function thread(i: number, resolved: boolean, comments = 1, total = comments): Thread {
  return {
    id: `T${i}`,
    isResolved: resolved,
    isOutdated: false,
    path: "src/a.ts",
    line: i,
    comments: {
      totalCount: total,
      nodes: Array.from({ length: comments }, (_, k) => ({
        databaseId: i * 1000 + k,
        author: { login: "example-review[bot]" },
        body: `comment ${k} on ${i}`,
      })),
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qcr-prthreads-"));
  mkdirSync(join(dir, "scripts"));
  for (const f of ["pr-threads.sh", "install-locator.sh"]) {
    copyFileSync(join(repo, "scripts", f), join(dir, "scripts", f));
  }
  writeFileSync(join(dir, "scripts", "mint-token.sh"), "#!/usr/bin/env bash\necho stub-token\n");
  chmodSync(join(dir, "scripts", "mint-token.sh"), 0o755);
  writeFileSync(join(dir, "config.toml"), '[github]\nrepo = "exampleorg/example-app"\n');
  threads = [];
  pageSize = 100;
  cursorsSeen = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const vars = (JSON.parse(body) as { variables: { after: string | null } }).variables;
      cursorsSeen.push(vars.after);
      const start = vars.after ? Number(vars.after) : 0;
      const nodes = threads.slice(start, start + pageSize);
      const next = start + pageSize < threads.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage: next,
                    endCursor: next ? String(start + pageSize) : null,
                  },
                  nodes,
                },
              },
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  apiBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});

const exec = promisify(execFile);

async function run(): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(
      "bash",
      [join(dir, "scripts", "pr-threads.sh"), "5180"],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_API: apiBase, QCR_CONFIG: join(dir, "config.toml") },
      },
    );
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("scripts/pr-threads.sh — every page of threads", () => {
  it("finds an unresolved thread past the first page", async () => {
    pageSize = 2;
    threads = [thread(1, true), thread(2, true), thread(3, true), thread(4, false)];
    const res = await run();
    expect(res.ok, res.out).toBe(true);
    expect(cursorsSeen).toEqual([null, "2"]);
    expect(res.out).toContain("== T4");
    expect(res.out).not.toContain("no unresolved review threads");
    expect(res.out).not.toContain("INCOMPLETE");
  });

  it("says no unresolved threads only after reading them all", async () => {
    pageSize = 2;
    threads = [thread(1, true), thread(2, true), thread(3, true)];
    const res = await run();
    expect(res.ok, res.out).toBe(true);
    expect(cursorsSeen).toEqual([null, "2"]);
    expect(res.out.trim()).toBe("no unresolved review threads on #5180");
  });

  it("marks a read cut short at the page cap as incomplete", async () => {
    pageSize = 1;
    threads = Array.from({ length: 25 }, (_, i) => thread(i + 1, true));
    const res = await run();
    expect(res.ok, res.out).toBe(true);
    expect(cursorsSeen).toHaveLength(20);
    expect(res.out).toContain("INCOMPLETE: #5180 has more review threads than the 20 read");
    expect(res.out).not.toContain("no unresolved review threads on #5180");
  });

  it("says how many later comments of a long thread it left out", async () => {
    threads = [thread(1, false, 2, 130)];
    const res = await run();
    expect(res.ok, res.out).toBe(true);
    expect(res.out).toContain("[1001] example-review[bot]: comment 1 on 1");
    expect(res.out).toContain("... 128 later comment(s) on this thread not shown");
  });
});
