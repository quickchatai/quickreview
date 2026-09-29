// scripts/pr-checks.sh --why: the review READS what CI reported for
// each failing check — its output, annotations and the job log tail — and never
// runs, re-runs or cancels anything. The real script against a loopback HTTP
// stub, from a temp copy whose mint-token.sh is a stub (no credential needed).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "68b8040c0ffee1234567890abcdef0123456789a";

let server: Server;
let dir: string;
let apiBase: string;
let methods: string[];
let logStatus: number;
/** When set, the check-runs route serves these rows the way GitHub does —
 * `per_page` of page `page` — instead of the two-run fixture. */
let pagedRuns: unknown[] | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qcr-prchecks-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(root, "scripts", "pr-checks.sh"), join(dir, "scripts", "pr-checks.sh"));
  // the script finds its config through the install locator.
  copyFileSync(
    join(root, "scripts", "install-locator.sh"),
    join(dir, "scripts", "install-locator.sh"),
  );
  writeFileSync(join(dir, "scripts", "mint-token.sh"), "#!/usr/bin/env bash\necho test-token\n");
  chmodSync(join(dir, "scripts", "mint-token.sh"), 0o755);
  writeFileSync(join(dir, "config.toml"), '[github]\nrepo = "o/r"\n');
  methods = [];
  logStatus = 200;
  pagedRuns = null;
  server = createServer((req, res) => {
    methods.push(req.method ?? "?");
    const url = req.url ?? "";
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") {
      res.writeHead(500);
      return res.end("write attempted");
    }
    if (url === "/repos/o/r/pulls/7") return json({ head: { sha: HEAD } });
    if (url.startsWith(`/repos/o/r/commits/${HEAD}/check-runs`) && pagedRuns) {
      const q = new URL(url, "http://stub").searchParams;
      const per = Number(q.get("per_page") ?? 30);
      const page = Number(q.get("page") ?? 1);
      return json({ check_runs: pagedRuns.slice((page - 1) * per, page * per) });
    }
    if (url.startsWith(`/repos/o/r/commits/${HEAD}/check-runs`))
      return json({
        check_runs: [
          {
            id: 1,
            name: "tests",
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-27T10:00:00Z",
            html_url: "h1",
          },
          {
            id: 2,
            name: "Static check with Ruff",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-09-27T10:00:00Z",
            html_url: "h2",
            details_url: "https://github.com/o/r/actions/runs/5/job/99",
            output: { title: "ruff found 1 error", summary: "Process completed with exit code 1." },
          },
        ],
      });
    if (url.startsWith("/repos/o/r/check-runs/2/annotations"))
      return json([
        {
          path: "rag/prompts/rewrite.py",
          start_line: 49,
          annotation_level: "failure",
          title: "F541",
          message: "f-string without any placeholders",
        },
      ]);
    if (url === "/repos/o/r/actions/jobs/99/logs") {
      res.writeHead(logStatus, { "content-type": "text/plain" });
      return res.end(
        "2026-09-27T10:00:01.000Z ruff check .\n2026-09-27T10:00:02.000Z rewrite.py:49:5: F541 f-string without any placeholders\n",
      );
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  apiBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const checks = (...args: string[]) =>
  run("bash", [join(dir, "scripts", "pr-checks.sh"), "7", ...args], {
    env: { ...process.env, GITHUB_API: apiBase, QCR_CONFIG: join(dir, "config.toml") },
  });

describe("pr-checks.sh --why", () => {
  it("without --why the output is the status table alone, ending in CLASSIFIED", async () => {
    const { stdout } = await checks();
    expect(stdout).not.toContain("WHY");
    expect(stdout.trim().split("\n").pop()).toBe("CLASSIFIED: red");
  });

  it("with --why it prints what CI reported for each failing check: output, annotations, log tail", async () => {
    const { stdout } = await checks("--why");
    expect(stdout).toContain("CLASSIFIED: red");
    expect(stdout).toContain("=== Static check with Ruff (check-run 2)");
    expect(stdout).toContain("title: ruff found 1 error");
    expect(stdout).toContain(
      "annotation rag/prompts/rewrite.py:49 [failure] F541 f-string without any placeholders",
    );
    expect(stdout).toContain("rewrite.py:49:5: F541");
    expect(stdout).not.toContain("=== tests");
    // read-only by construction
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  it("reads every page of check-runs: a failure past row 100 still classifies red", async () => {
    // The same table as the daemon gate and guards.sh, which both page — a
    // first-page read of a big matrix showed only its green runs.
    pagedRuns = [
      ...Array.from({ length: 100 }, (_, i) => ({
        id: 100 + i,
        name: `matrix-${i}`,
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-27T10:00:00Z",
        html_url: `m${i}`,
      })),
      {
        id: 999,
        name: "late",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-27T10:00:00Z",
        html_url: "late",
      },
    ];
    const { stdout } = await checks();
    expect(stdout).toContain("late: completed/failure");
    expect(stdout).toContain("SUMMARY: 100 passed / 1 failed / 0 pending");
    expect(stdout.trim().split("\n").pop()).toBe("CLASSIFIED: red");
  });

  it("an unreadable log is said, not fatal", async () => {
    logStatus = 403;
    const { stdout } = await checks("--why");
    expect(stdout).toContain("log: not readable (HTTP 403)");
    expect(stdout).toContain("annotation rag/prompts/rewrite.py:49");
  });
});
