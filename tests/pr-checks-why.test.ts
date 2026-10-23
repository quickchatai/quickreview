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
import { classifyCi } from "../src/cigate.js";

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
/** The combined-status endpoint's `statuses` rows at the head. */
let statusRows: unknown[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qcr-prchecks-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(root, "scripts", "pr-checks.sh"), join(dir, "scripts", "pr-checks.sh"));
  // The script finds its config through the install locator.
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
  statusRows = [];
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
    if (url.startsWith(`/repos/o/r/commits/${HEAD}/status`)) {
      const q = new URL(url, "http://stub").searchParams;
      const per = Number(q.get("per_page") ?? 30);
      const page = Number(q.get("page") ?? 1);
      return json({ state: "pending", statuses: statusRows.slice((page - 1) * per, page * per) });
    }
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
    // first-page read of a big matrix can show only its green runs.
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

  // Commit statuses are read beside check-runs: reading check-runs alone
  // prints CLASSIFIED: green for a failing status beside green runs, while
  // guard 4 — src/cigate.ts and guards.sh alike — says red. A status is its
  // own check, never collapsed with a run of its context.
  // MUTATION: drop the status read (or `or any(... statuses)`) — these fail.
  it("reads the commit statuses too: a failing status beside green runs is red", async () => {
    pagedRuns = [
      {
        id: 1,
        name: "deploy",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-27T10:00:00Z",
        html_url: "h1",
      },
    ];
    statusRows = [
      { context: "deploy", state: "failure", target_url: "t1", description: "preview failed" },
    ];
    const red = await checks();
    expect(red.stdout).toContain("status deploy: failure  t1  (preview failed)");
    expect(red.stdout).toContain("SUMMARY: 1 passed / 1 failed / 0 pending");
    expect(red.stdout.trim().split("\n").pop()).toBe("CLASSIFIED: red");

    statusRows = [{ context: "ext-ci", state: "pending" }];
    expect((await checks()).stdout.trim().split("\n").pop()).toBe("CLASSIFIED: pending");

    // A head whose only check is a passing status is green, not "none".
    pagedRuns = [];
    statusRows = [{ context: "ext-ci", state: "success" }];
    expect((await checks()).stdout.trim().split("\n").pop()).toBe("CLASSIFIED: green");
    statusRows = [];
    expect((await checks()).stdout.trim().split("\n").pop()).toBe("CLASSIFIED: none");
  });

  // One table on every route: a failed check beside one still running is
  // red for the daemon gate and guards.sh, so it is red here too — and the
  // session's red-only `--why` step runs on it.
  it("a failure beside a check still running classifies red, as the gate does", async () => {
    pagedRuns = [
      {
        id: 1,
        name: "unit",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-27T10:00:00Z",
        html_url: "h1",
      },
      {
        id: 2,
        name: "integration",
        status: "in_progress",
        conclusion: null,
        started_at: "2026-09-27T10:00:00Z",
        html_url: "h2",
      },
    ];
    const { stdout } = await checks();
    expect(stdout).toContain("SUMMARY: 0 passed / 1 failed / 1 pending");
    expect(stdout.trim().split("\n").pop()).toBe("CLASSIFIED: red");
    expect(
      classifyCi([
        { name: "unit", source: "check_run", status: "completed", conclusion: "failure" },
        { name: "integration", source: "check_run", status: "in_progress", conclusion: null },
      ]),
    ).toBe("red");
  });

  it("an unreadable log is said, not fatal", async () => {
    logStatus = 403;
    const { stdout } = await checks("--why");
    expect(stdout).toContain("log: not readable (HTTP 403)");
    expect(stdout).toContain("annotation rag/prompts/rewrite.py:49");
  });

  it("dies instead of classifying when the check-run page limit is exhausted", async () => {
    pagedRuns = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      name: `c${i}`,
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-27T10:00:00Z",
      html_url: "h",
    }));
    const err = await checks().catch((e) => e);
    expect(err.code).not.toBe(0);
    expect(err.stderr).toContain("incomplete check-runs");
    expect(err.stdout ?? "").not.toContain("CLASSIFIED");
  });

  it("dies on a check-run page that carries no check_runs list", async () => {
    const orig = server.listeners("request")[0] as (...a: unknown[]) => void;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if ((req.url ?? "").includes("/check-runs")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      orig(req, res);
    });
    const err = await checks().catch((e) => e);
    expect(err.code).not.toBe(0);
    expect(err.stderr).toContain("check-runs page");
    expect(err.stdout ?? "").not.toContain("CLASSIFIED");
  });
});
