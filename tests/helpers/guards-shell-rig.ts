// The rig behind the tests/guards-shell-*.test.ts files: the guards on the
// other posting route. The sessions post through
// scripts/post-review.sh, approve-pr.sh and reply-thread.sh, which do not go
// through src/gate.ts — so scripts/guards.sh mirrors the guards there the same
// way the dry-run gate is mirrored, and those files are the bypass-attempt
// test: posting via the shell path still hits every guard the gate would
// apply (1 + 2 + 3 on post-review.sh, 3 on the other two).
//
// No real GitHub and no real credential: GITHUB_API points at a loopback stub,
// and the throwaway config's secrets_dir is an empty temp dir, so
// mint-token.sh finds no PEM and the scripts fall back to an unauthenticated
// read against the stub. Everything runs in dry-run, so nothing is ever sent.
//
// The cases are split by area so vitest runs the parts in parallel; every
// part calls useGuardsShellRig() once at module level, which gives it its OWN
// stub server (port 0 — the kernel picks, so parts never collide), its own
// temp home and its own state.db, fresh for every test.
import { afterEach, beforeEach, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// execFile, not execFileSync: the stub server shares this process's event
// loop, so a synchronous child would deadlock waiting for a reply that cannot
// be written until the child exits.
export const exec = promisify(execFile);

export interface GuardsShellRig {
  /** What GET /pulls/5180 answers; null makes the stub 404. */
  pr: PrStub | null;
  reviews: ReviewStub[];
  /** Check-runs at HEAD (guard 4, the CI gate). Green by default: every case that
   * is about another guard must not trip this one. */
  checkRuns: CheckRunStub[];
  /** Commit statuses at HEAD (the combined status endpoint). Empty by default
   * for the same reason. */
  statuses: Array<{ context: string; state: string }>;
  /** This test's temp home (config.toml, secrets/, dryrun/, receipts/). */
  dir: string;
  /** This test's state.db — never the repo's own. */
  dbPath: string;
  /** The stub's base URL. */
  apiBase: string;
  run(
    script: string,
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<{ ok: boolean; out: string; code: number }>;
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
export function useGuardsShellRig(): GuardsShellRig {
  let server: Server;

  const s: GuardsShellRig = {
    pr: null,
    reviews: [],
    checkRuns: [],
    statuses: [],
    dir: "",
    dbPath: "",
    apiBase: "",
    async run(script, args, extraEnv = {}) {
      const env = {
        ...process.env,
        GITHUB_API: s.apiBase,
        QCR_CONFIG: join(s.dir, "config.toml"),
        QCR_DRYRUN_DIR: join(s.dir, "dryrun"),
        // Never the repo's own state.db: the guards read and stamp this file.
        QCR_STATE_DB: s.dbPath,
        // Never the repo's own round-progress snapshots: the required-pass
        // check reads this directory.
        QCR_ROUND_PROGRESS_DIR: join(s.dir, "round-progress"),
        ...extraEnv,
      };
      // The guard reads QCR_EXPECTED_HEAD from the caller's environment: unless
      // a case sets it, it must be genuinely absent, not inherited from the
      // runner.
      if (!("QCR_EXPECTED_HEAD" in extraEnv))
        delete (env as Record<string, unknown>).QCR_EXPECTED_HEAD;
      try {
        const { stdout, stderr } = await exec("bash", [join(root, "scripts", script), ...args], {
          encoding: "utf8",
          env,
        });
        return { ok: true, out: `${stdout}${stderr}`, code: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          ok: false,
          out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
          code: typeof e.code === "number" ? e.code : -1,
        };
      }
    },
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
      res.writeHead(500, { "content-type": "application/json" });
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
