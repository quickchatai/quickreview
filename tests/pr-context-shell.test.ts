// Actual read-only context script against a loopback GitHub stub and fake token cache.
import { afterEach, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
let dir: string, api: string, server: Server;
let badCursor: boolean;
let incompleteChecks: boolean;
const head = "a".repeat(40);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qcr-context-"));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", "app_id"), "88442211");
  writeFileSync(join(dir, "secrets", "app.pem"), "fake key; cache avoids signing");
  writeFileSync(join(dir, "quickreview-token-88442211.json"), JSON.stringify({ token: "fixture-token", expires_at: "2099-01-01T00:00:00Z" }));
  writeFileSync(join(dir, "config.toml"), `[github]\nrepo = "exampleorg/example-app"\nsecrets_dir = "${dir}/secrets"\n`);
  badCursor = false;
  incompleteChecks = false;
  server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/graphql" && req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const { variables } = JSON.parse(text) as { variables: Record<string, unknown> };
      const page = Object.values(variables).includes("page-two") ? 2 : 1;
      const nodes = [{ path: page === 2 ? "late-file.ts" : "first-file.ts", additions: 1, deletions: 0 }];
      res.end(JSON.stringify({ data: { repository: { pullRequest: {
        title: "fixture", state: "OPEN", headRefOid: head, baseRefName: "main", author: { login: "author" },
        files: { nodes, pageInfo: { hasNextPage: page === 1, endCursor: badCursor ? null : "page-two" } },
        reviews: { nodes: [] },
        reviewThreads: { nodes: [{ id: `thread-${page}`, isResolved: false, isOutdated: false, path: nodes[0]!.path, line: 1, comments: { nodes: [{ author: { login: "reader" }, body: page === 2 ? "late unresolved concern" : "first concern" }] } }], pageInfo: { hasNextPage: page === 1, endCursor: badCursor ? null : "page-two" } },
      } } } }));
    } else if (req.method === "GET" && req.url?.includes("/check-runs")) {
      res.end(JSON.stringify({ total_count: incompleteChecks ? 101 : 0, check_runs: [] }));
    } else if (req.method === "GET" && req.url?.includes("/status")) {
      res.end(JSON.stringify({ statuses: [{ context: "legacy-ci", state: "failure", description: "required status failed" }] }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  api = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});
async function run(script = "pr-context.sh", env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await exec("bash", [join(root, "scripts", script), "1", "1"], { env: { ...process.env, GITHUB_API: api, QCR_CONFIG: join(dir, "config.toml"), XDG_RUNTIME_DIR: dir, ...env }, encoding: "utf8" });
    return { ok: true, out: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return { ok: false, out: (result.stdout ?? "") + (result.stderr ?? "") };
  }
}
it("includes later file/thread pages and failing legacy commit statuses", async () => {
  const result = await run();
  expect(result.ok).toBe(true);
  expect(result.out).toContain("late-file.ts");
  expect(result.out).toContain("late unresolved concern");
  expect(result.out).toContain("legacy-ci: failure");
});
it("refuses a continuation page without its cursor rather than showing incomplete context", async () => {
  badCursor = true;
  const result = await run();
  expect(result.ok).toBe(false);
  expect(result.out).toMatch(/cursor|incomplete/i);
});
it("refuses a short checks page that contradicts the advertised complete count", async () => {
  incompleteChecks = true;
  const result = await run();
  expect(result.ok).toBe(false);
  expect(result.out).toMatch(/incomplete|count/i);
  expect(result.out).not.toContain("== META");
});
it("lets render CLI apply its bot fallback when optional config cannot be read", async () => {
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "render-cli-reached bot=<%s>\\n" "$5"\n');
  chmodSync(join(bin, "node"), 0o755);
  const result = await run("render-review.sh", { QCR_CONFIG: join(dir, "missing.toml"), PATH: `${bin}:${process.env["PATH"]}` });
  expect(result.ok).toBe(true);
  expect(result.out).toContain("render-cli-reached bot=<>");
});

it("bounds both connection and total time for token-mint HTTP requests", async () => {
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "openssl"), '#!/bin/sh\nprintf fixture\n');
  chmodSync(join(bin, "openssl"), 0o755);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
with open(os.environ['CURL_CALLS'],'a') as f: f.write(json.dumps(args)+'\\n')
output=args[args.index('-o')+1]
is_token=args[-1].endswith('/access_tokens')
json.dump({'token':'fixture','expires_at':'2099-01-01T00:00:00Z'} if is_token else [{'id':1}],open(output,'w'))
print('201' if is_token else '200',end='')
`);
  chmodSync(join(bin, "curl"), 0o755);
  const calls = join(dir, "calls.jsonl");
  await exec("bash", [join(root, "scripts", "mint-token.sh"), "--refresh"], { env: { ...process.env, QCR_CONFIG: join(dir, "config.toml"), XDG_RUNTIME_DIR: dir, PATH: `${bin}:${process.env["PATH"]}`, CURL_CALLS: calls } });
  const requests = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  expect(requests).toHaveLength(2);
  for (const args of requests) {
    expect(args).toContain("--connect-timeout");
    expect(args).toContain("--max-time");
    expect(Number(args[args.indexOf("--max-time") + 1])).toBeLessThanOrEqual(60);
  }
});

it("stops the actual compiler watcher after the development TUI exits", async () => {
  const dev = join(dir, "dev"), bin = join(dir, "bin");
  mkdirSync(join(dev, "scripts"), { recursive: true }); mkdirSync(bin);
  copyFileSync(join(root, "scripts", "dev-tui.sh"), join(dev, "scripts", "dev-tui.sh"));
  const marker = join(dir, "watcher.pid");
  writeFileSync(join(bin, "npx"), '#!/bin/sh\ncase "$*" in *--watch*) node fake-tsc --watch & wait ;; *) exit 0 ;; esac\n');
  writeFileSync(join(bin, "node"), '#!/bin/sh\ncase "$*" in *--watch*) echo $$ > "$WATCH_MARKER"; exec sleep 60 ;; *cli.js*) while [ ! -s "$WATCH_MARKER" ]; do sleep 0.01; done ;; *) exit 0 ;; esac\n');
  for (const name of ["node", "npx"]) chmodSync(join(bin, name), 0o755);
  let watcher: number | undefined;
  try {
    await exec("bash", [join(dev, "scripts", "dev-tui.sh")], { env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, WATCH_MARKER: marker }, timeout: 10_000 });
    expect(existsSync(marker)).toBe(true);
    watcher = Number(readFileSync(marker, "utf8").trim());
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(watcher, 0); } catch { alive = false; break; }
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(alive).toBe(false);
  } finally {
    if (watcher !== undefined) { try { process.kill(watcher, "SIGKILL"); } catch {} }
  }
});
