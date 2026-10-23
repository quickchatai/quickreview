// The adapter's CI read, over a loopback stub.
//
// `classifyCi` in `packages/pi-plugin/src/cigate.ts` is the one CI rule (the shell mirror in
// scripts/guards.sh is deleted), and guard 4 is the only guard that gates
// an approval. This file pins the half `tests/cigate.test.ts` cannot see: that
// the adapter's `listChecks` reads EVERY page of check-runs and statuses, and
// that an unreadable later page is an error, never a green read.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCi, type CheckSummary } from "@quickchatai/pi-quickreview/src/cigate.js";
import { parseConfig } from "../src/config.js";
import { MutationGate } from "@quickchatai/pi-quickreview/src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import type { FetchFn, TokenMinter } from "@quickchatai/pi-quickreview/src/githubAuth.js";

const ROOT = join(import.meta.dirname, "..");
const cfg = parseConfig(readFileSync(join(ROOT, "tests", "fixtures", "config.toml"), "utf8"));

let server: Server;
let apiBase = "";
/** The check-runs payload. `source` is the adapter's stamp, not a GitHub
 * field; it is stripped here so the shell sees exactly what GitHub sends. */
let checkRuns: CheckSummary[] = [];
let statuses: Array<{ context: string; state: string }> = [];
/** When set, check-runs page N answers 403 with GitHub's error body. */
let failRunsPage: number | null = null;

/** GitHub's pagination, as both endpoints apply it: `per_page` (default 30)
 * rows of page `page` (default 1). A reader that asks for page 1 alone sees
 * only the first slice. */
function pageOf<T>(url: string, rows: T[]): T[] {
  const q = new URL(url, "http://stub").searchParams;
  const per = Number(q.get("per_page") ?? 30);
  const page = Number(q.get("page") ?? 1);
  return rows.slice((page - 1) * per, page * per);
}

beforeEach(async () => {
  statuses = [];
  failRunsPage = null;
  server = createServer((req, res) => {
    if (
      req.method === "GET" &&
      req.url?.includes("/check-runs") &&
      failRunsPage !== null &&
      new URL(req.url, "http://stub").searchParams.get("page") === String(failRunsPage)
    ) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "API rate limit exceeded" }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/check-runs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          check_runs: pageOf(
            req.url,
            checkRuns.map(({ source: _source, ...run }) => run),
          ),
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url?.includes("/status")) {
      // The combined-status endpoint — the corpus's statuses, so the two
      // classifiers see the same mixed input through their own real readers.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "success", statuses: pageOf(req.url, statuses) }));
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  apiBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

/** The REAL `GitHubAdapter.listChecks` over the same stub — the TypeScript
 * half reads its input through the same two endpoints the shell half does,
 * so the kind stamp (`source`) is the adapter's, never the corpus's. */
async function adapterClassifyInput(): Promise<CheckSummary[]> {
  const minter = {
    appJwt: () => "jwt",
    installationToken: async () => "tok",
    invalidate: () => {},
  } as unknown as TokenMinter;
  const gate = new MutationGate(true, join(tmpdir(), "qcr-fences-cigate-unused"), async () => ({}));
  return new GitHubAdapter(cfg, minter, gate, fetch as unknown as FetchFn, apiBase).listChecks(
    "deadbeefcafe",
  );
}

describe("the adapter reads every page of the head's checks", () => {
  /**
   * The reader must see EVERY check at the head, not the first page of each
   * endpoint. A head with more than 100 check-runs (matrix jobs plus reruns —
   * superseded runs still count toward the total) or 100 status contexts puts
   * the rest on page 2; a reader of page 1 alone would miss a failing or
   * pending one there, classify green, and allow APPROVE.
   *
   * MUTATION: drop the page loop from `listChecks` in src/github.ts, — the matching case reads green.
   */
  const greens = (n: number): CheckSummary[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `matrix-${i}`,
      source: "check_run" as const,
      status: "completed",
      conclusion: "success",
      started_at: "2026-08-19T10:00:00Z",
    }));
  for (const c of [
    {
      name: "a failing check-run on page 2",
      runs: [
        ...greens(100),
        { ...greens(1)[0]!, name: "late", conclusion: "failure" },
      ] as CheckSummary[],
      statuses: [] as Array<{ context: string; state: string }>,
      want: "red",
    },
    {
      name: "a still-running check-run on page 2",
      runs: [
        ...greens(150),
        { ...greens(1)[0]!, name: "late", status: "in_progress", conclusion: null },
      ] as CheckSummary[],
      statuses: [],
      want: "pending",
    },
    {
      name: "a failing commit status on page 2",
      runs: greens(1),
      statuses: [
        ...Array.from({ length: 100 }, (_, i) => ({ context: `ctx-${i}`, state: "success" })),
        { context: "late", state: "failure" },
      ],
      want: "red",
    },
  ]) {
    it(`reads past the first page: ${c.name}`, async () => {
      checkRuns = c.runs;
      statuses = c.statuses;
      expect(classifyCi(await adapterClassifyInput()), "src/github.ts listChecks").toBe(c.want);
    });
  }

  /**
   * An error body on a LATER page is not a short page. Read as one, the first
   * 100 green rows would pass for the whole list. The adapter must throw.
   */
  it("an error on page 2 is an unreadable read, never a green one", async () => {
    checkRuns = [...greens(100), { ...greens(1)[0]!, name: "late", conclusion: "failure" }];
    failRunsPage = 2;
    await expect(adapterClassifyInput()).rejects.toThrow();
  });
});
