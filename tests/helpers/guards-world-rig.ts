// The world behind the posting-guard parity block in tests/guards.test.ts: a
// loopback GitHub stub, a temp home with state.db and config.toml. The Node
// route (the real MutationGate with src/guards.ts and the real GitHubAdapter)
// reads it; the shell route that once read it too is gone (P9.3).
//
// No real GitHub and no real credential: the adapter's base URL points at the
// stub. Everything runs in dry-run, so nothing is ever sent.
//
// Every user calls useGuardsWorld() once at module level, which gives it its
// OWN stub server (port 0), its own temp home and its own state.db, fresh for
// every test.
import { afterEach, beforeEach, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HEAD = "68b8040c0ffee1234567890abcdef0123456789a";

export interface PrStub {
  state: "open" | "closed";
  merged: boolean;
  head?: { sha: string };
  user?: { login: string };
}

export interface ReviewStub {
  id: number;
  user: { login: string };
  state: string;
  commit_id: string;
}

export interface CheckRunStub {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
}

export interface GuardsWorld {
  mutationStatus: number;
  /** What GET /pulls/5180 answers; null makes the stub 404. */
  pr: PrStub | null;
  reviews: ReviewStub[];
  /** Check-runs at HEAD (guard 4, the CI gate). Green by default: every case that
   * is about another guard must not trip this one. */
  checkRuns: CheckRunStub[];
  /** Commit statuses at HEAD (the combined status endpoint). Empty by default
   * for the same reason. */
  statuses: Array<{ context: string; state: string }>;
  /** This test's temp home (config.toml, secrets/, dryrun/). */
  dir: string;
  /** This test's state.db — never the repo's own. */
  dbPath: string;
  /** The stub's base URL. */
  apiBase: string;
  dryrunRecords(): string[];
  /** The single dry-run record the run produced, parsed. */
  record(): { note: string; body: { event?: string; body?: string; commit_id?: string } };
  bodyFile(): string;
}

const CONFIG = (secretsDir: string) =>
  [
    "dry_run = true",
    "",
    "[github]",
    'repo = "exampleorg/example-app"',
    'bot_login = "example-review[bot]"',
    'trigger_label = "AI review requested"',
    'review_team = "exampleorg/review"',
    `secrets_dir = "${secretsDir}"`,
    "",
  ].join("\n");

/** Registers the per-test stub + temp home on the calling file and returns the
 * live state object the file's tests read and mutate. Call once, at module
 * level. */
export function useGuardsWorld(): GuardsWorld {
  let server: Server;

  const s: GuardsWorld = {
    mutationStatus: 500,
    pr: null,
    reviews: [],
    checkRuns: [],
    statuses: [],
    dir: "",
    dbPath: "",
    apiBase: "",
    dryrunRecords() {
      try {
        return readdirSync(join(s.dir, "dryrun"));
      } catch {
        return [];
      }
    },
    record() {
      const files = s.dryrunRecords();
      expect(files).toHaveLength(1);
      return JSON.parse(readFileSync(join(s.dir, "dryrun", files[0]!), "utf8"));
    },
    bodyFile() {
      const path = join(s.dir, "body.md");
      writeFileSync(path, "Automated review body.\n");
      return path;
    },
  };

  beforeEach(async () => {
    s.dir = mkdtempSync(join(tmpdir(), "qcr-guard3-"));
    mkdirSync(join(s.dir, "secrets"));
    writeFileSync(join(s.dir, "config.toml"), CONFIG(join(s.dir, "secrets")));
    s.pr = { state: "open", merged: false, head: { sha: HEAD }, user: { login: "pr-author" } };
    s.reviews = [];
    s.mutationStatus = 500;
    s.checkRuns = [{ name: "unit", status: "completed", conclusion: "success" }];
    s.statuses = [];
    s.dbPath = join(s.dir, "state.db");
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url?.includes("/check-runs")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ check_runs: s.checkRuns }));
        return;
      }
      if (req.method === "GET" && req.url?.includes("/commits/") && req.url.includes("/status")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: "success", statuses: s.statuses }));
        return;
      }
      if (
        req.method === "GET" &&
        req.url?.startsWith("/repos/") &&
        req.url.includes("/pulls/5180/reviews")
      ) {
        // Paged like GitHub: 100 a page, `page` defaulting to 1.
        const page = Number(new URL(req.url, "http://stub").searchParams.get("page") ?? "1");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(s.reviews.slice((page - 1) * 100, page * 100)));
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/pulls/5180")) {
        res.writeHead(s.pr ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(s.pr ?? { message: "Not Found" }));
        return;
      }
      // Nothing else may be called: dry-run posts nothing, and a guard that
      // refuses must not have reached any other endpoint either.
      res.writeHead(s.mutationStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const addr = server.address();
    s.apiBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    rmSync(s.dir, { recursive: true, force: true });
  });

  return s;
}
