// The guards on the OTHER posting route. The sessions post through
// scripts/post-review.sh, approve-pr.sh and reply-thread.sh, which do not go
// through src/gate.ts — so scripts/guards.sh mirrors the guards there the same
// way the dry-run gate is mirrored, and this is the bypass-attempt test:
// posting via the shell path still hits every guard the gate would apply
// (1 + 2 + 3 on post-review.sh, 3 on the other two).
//
// No real GitHub and no real credential: GITHUB_API points at a loopback stub,
// and the throwaway config's secrets_dir is an empty temp dir, so
// mint-token.sh finds no PEM and the scripts fall back to an unauthenticated
// read against the stub. Everything runs in dry-run, so nothing is ever sent.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../src/state.js";
import { hasNewEvidence } from "../src/guards.js";
import { parsePostingReceipt } from "../src/posting-receipt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HEAD = "68b8040c0ffee1234567890abcdef0123456789a";

interface PrStub {
  state: "open" | "closed";
  merged: boolean;
  head?: { sha: string };
  user?: { login: string };
}

interface ReviewStub {
  id: number;
  user: { login: string };
  state: string;
  commit_id: string;
}

let server: Server;
let apiBase: string;
let dir: string;
let pr: PrStub | null;
let reviews: ReviewStub[];
let dbPath: string;
/** Check-runs at HEAD (guard 4). Green by default: every pre-existing
 * case here is about another guard and must not trip this one. */
let checkRuns: Array<{
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
}>;
/** Commit statuses at HEAD (the combined status endpoint). Empty by default
 * for the same reason. */
let statuses: Array<{ context: string; state: string }>;

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qcr-guard3-"));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "config.toml"), CONFIG(join(dir, "secrets")));
  pr = { state: "open", merged: false, head: { sha: HEAD }, user: { login: "pr-author" } };
  reviews = [];
  checkRuns = [{ name: "unit", status: "completed", conclusion: "success" }];
  statuses = [];
  dbPath = join(dir, "state.db");
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.includes("/check-runs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ check_runs: checkRuns }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/commits/") && req.url.includes("/status")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "success", statuses }));
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
      res.end(JSON.stringify(reviews.slice((page - 1) * 100, page * 100)));
      return;
    }
    if (req.method === "GET" && req.url?.endsWith("/pulls/5180")) {
      res.writeHead(pr ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(pr ?? { message: "Not Found" }));
      return;
    }
    // Nothing else may be called: dry-run posts nothing, and a guard that
    // refuses must not have reached any other endpoint either.
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  apiBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});

// execFile, not execFileSync: the stub server shares this process's event
// loop, so a synchronous child would deadlock waiting for a reply that cannot
// be written until the child exits.
const exec = promisify(execFile);

async function run(
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ ok: boolean; out: string; code: number }> {
  const env = {
    ...process.env,
    GITHUB_API: apiBase,
    QCR_CONFIG: join(dir, "config.toml"),
    QCR_DRYRUN_DIR: join(dir, "dryrun"),
    // Never the repo's own state.db: the guards read and stamp this file.
    QCR_STATE_DB: dbPath,
    ...extraEnv,
  };
  // The guard reads QCR_EXPECTED_HEAD from the caller's environment: unless a
  // case sets it, it must be genuinely absent, not inherited from the runner.
  if (!("QCR_EXPECTED_HEAD" in extraEnv)) delete (env as Record<string, unknown>).QCR_EXPECTED_HEAD;
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
}

function dryrunRecords(): string[] {
  try {
    return readdirSync(join(dir, "dryrun"));
  } catch {
    return [];
  }
}

/** The single dry-run record the run produced, parsed. */
function record(): { note: string; body: { event?: string; body?: string; commit_id?: string } } {
  const files = dryrunRecords();
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, "dryrun", files[0]!), "utf8"));
}

function bodyFile(): string {
  const path = join(dir, "body.md");
  writeFileSync(path, "Automated review body.\n");
  return path;
}

describe("scripts/approve-pr.sh — guard 3", () => {
  it("refuses to approve a merged PR and records no mutation at all", async () => {
    pr = { state: "closed", merged: true };
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("already merged");
    expect(dryrunRecords()).toEqual([]);
  });

  it("refuses to approve a closed PR", async () => {
    pr = { state: "closed", merged: false };
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("is closed");
    expect(dryrunRecords()).toEqual([]);
  });

  it("proceeds on an open PR — the three dry-run records still appear", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
    const kinds = dryrunRecords().map((f) => f.replace(/^.*-(?=[a-z])/, ""));
    expect(kinds.sort()).toEqual([
      "create_review.json",
      "delete_team_review_request.json",
      "remove_label.json",
    ]);
  });
});

describe("scripts/approve-pr.sh — guard 4 (red CI hard-gates APPROVE)", () => {
  it("refuses the approval over a failing check and sends nothing at all", async () => {
    checkRuns = [
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "e2e", status: "completed", conclusion: "failure" },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("APPROVE is unavailable");
    expect(res.out).toContain("post-review.sh"); // it says what to do instead
    expect(dryrunRecords()).toEqual([]);
  });

  it("refuses identically for an infra cancellation — no special-casing", async () => {
    checkRuns = [{ name: "unit", status: "completed", conclusion: "cancelled" }];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is red");
  });

  it("refuses while a check is still running", async () => {
    checkRuns = [{ name: "unit", status: "in_progress", conclusion: null }];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is pending");
  });

  it("lets a green suite through — the three approval records still appear", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(3);
  });

  // Parity with classifyCi's latest-run-per-name rule (the owner, 2026-08-19).
  it("ignores a cancelled husk when a newer run of the same name succeeded", async () => {
    checkRuns = [
      {
        name: "sync",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-19T08:00:00Z",
      },
      {
        name: "sync",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-19T08:05:00Z",
      },
      {
        name: "sync",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-19T08:10:00Z",
      },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
  });

  it("still refuses when the LATEST run of a name was cancelled", async () => {
    checkRuns = [
      {
        name: "sync",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-19T08:00:00Z",
      },
      {
        name: "sync",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-19T08:10:00Z",
      },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is red");
  });

  // Parity with: a commit status under a check-run's name is a second
  // check. The shell half never grouped statuses with runs, so it was already
  // red here while the gate half read green — the parity both files claim was
  // false until the classifier was fixed. These pin the shell side so it can
  // never regress to the gate's old answer.
  it.each([
    ["failure", "CI is red"],
    ["error", "CI is red"],
    ["pending", "CI is pending"],
  ])(
    "refuses over a %s commit status that shares a passing check-run's name",
    async (state, message) => {
      checkRuns = [
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          started_at: "2026-09-01T10:00:00Z",
        },
      ];
      statuses = [{ context: "ci", state }];
      const res = await run("approve-pr.sh", ["5180", bodyFile()]);
      expect(res.ok).toBe(false);
      expect(res.out).toContain(message);
      expect(dryrunRecords()).toEqual([]);
    },
  );

  it("a queued run with a null started_at is pending, not green off the older completed run of its name", async () => {
    checkRuns = [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-01T10:00:00Z",
      },
      { name: "ci", status: "queued", conclusion: null, started_at: null },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is pending");
  });

  it.each([
    ["queued", null, "CI is pending"],
    ["completed", "failure", "CI is red"],
  ] as const)(
    "a %s/%s check-run with a null started_at is never masked by a passing status of its name",
    async (status, conclusion, message) => {
      // Review round 1: the gate route collapsed this untimestamped
      // run with the same-named status and read green; the shell never grouped
      // them and was right. Pinned so the shell can never regress to match.
      checkRuns = [{ name: "ci", status, conclusion, started_at: null }];
      statuses = [{ context: "ci", state: "success" }];
      const res = await run("approve-pr.sh", ["5180", bodyFile()]);
      expect(res.ok).toBe(false);
      expect(res.out).toContain(message);
      expect(dryrunRecords()).toEqual([]);
    },
  );

  it("a passing status beside a passing run of its name still approves", async () => {
    checkRuns = [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-01T10:00:00Z",
      },
    ];
    statuses = [{ context: "ci", state: "success" }];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
  });

  // Parity with no_checks_is_red (the owner, 2026-08-19).
  it("refuses a zero-checks head when no_checks_is_red is on; allows it when off", async () => {
    checkRuns = [];
    const base = readFileSync(join(dir, "config.toml"), "utf8");
    writeFileSync(join(dir, "config.toml"), `${base}\n[guards]\nno_checks_is_red = true\n`);
    const refused = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(refused.ok).toBe(false);
    expect(refused.out).toContain("no CI has run");
    writeFileSync(join(dir, "config.toml"), base);
    const allowed = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(allowed.ok).toBe(true);
  });

  it("posting the withheld review as a COMMENT is never refused by this guard", async () => {
    checkRuns = [{ name: "unit", status: "completed", conclusion: "failure" }];
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });
});

describe("posting receipts", () => {
  const receipt = (round: number) =>
    JSON.parse(readFileSync(join(dir, "receipts", `pr-5180-round-${round}.json`), "utf8"));

  it("post-review embeds the deterministic marker and atomically records dry-run intent", async () => {
    const key = `v1:5180:7:${HEAD}`;
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "7",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(dir, "receipts"),
    });
    expect(res.ok).toBe(true);
    expect(record().body.body).toContain(`<!-- qcr-post:${key} -->`);
    expect(receipt(7)).toMatchObject({
      status: "dryrun",
      posting_key: key,
      pr: 5180,
      round_no: 7,
      head_sha: HEAD,
      actual_event: "COMMENT",
    });

    const repeated = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "7",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(dir, "receipts"),
    });
    expect(repeated.ok).toBe(true);
    expect(repeated.out).toContain("skipping duplicate review");
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("treats a confirmed retry as idempotent before body and posting guards", async () => {
    const key = `v1:5180:11:${HEAD}`;
    const path = join(dir, "receipts", "pr-5180-round-11.json");
    const args = [path, key, "5180", "11", HEAD, "COMMENT", "COMMENT", '{"event":"COMMENT"}'];
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "prepare", ...args]);
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
      env: {
        ...process.env,
        QCR_POST_RESPONSE: JSON.stringify({ id: 446, commit_id: HEAD, state: "COMMENTED" }),
      },
    });
    pr = {
      state: "closed",
      merged: false,
      head: { sha: "different" },
      user: { login: "pr-author" },
    };
    const res = await run("post-review.sh", ["5180", "COMMENT", join(dir, "missing-body.md")], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "11",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(dir, "receipts"),
    });
    expect(res.ok).toBe(true);
    expect(res.out).toContain("skipping duplicate review");
    expect(dryrunRecords()).toEqual([]);
  });

  it("refuses a prepared/unknown receipt rather than risking a second POST", async () => {
    const key = `v1:5180:9:${HEAD}`;
    mkdirSync(join(dir, "receipts"), { recursive: true });
    writeFileSync(
      join(dir, "receipts", "pr-5180-round-9.json"),
      JSON.stringify({ posting_key: key, status: "prepared" }),
    );
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "9",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(dir, "receipts"),
    });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("refusing a duplicate POST");
    expect(dryrunRecords()).toEqual([]);
  });

  it("requires GitHub's returned id, commit and state before confirming", async () => {
    const key = `v1:5180:10:${HEAD}`;
    const path = join(dir, "receipts", "pr-5180-round-10.json");
    const args = [path, key, "5180", "10", HEAD, "COMMENT", "COMMENT", '{"event":"COMMENT"}'];
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "prepare", ...args]);
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
      env: {
        ...process.env,
        QCR_POST_RESPONSE: JSON.stringify({ id: 444, commit_id: HEAD, state: "COMMENTED" }),
      },
    });
    expect(receipt(10)).toMatchObject({
      status: "confirmed",
      gh_review_id: 444,
      gh_commit_id: HEAD,
      gh_state: "COMMENTED",
    });
    await expect(
      exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
        env: {
          ...process.env,
          QCR_POST_RESPONSE: JSON.stringify({ id: 445, commit_id: "wrong", state: "COMMENTED" }),
        },
      }),
    ).rejects.toThrow();
  });

  it("confirmed approval retry bypasses changed posting guards and resumes cleanup only", async () => {
    const key = `v1:5180:12:${HEAD}`;
    const path = join(dir, "receipts", "pr-5180-round-12.json");
    const args = [path, key, "5180", "12", HEAD, "APPROVE", "APPROVE", '{"event":"APPROVE"}'];
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "prepare", ...args]);
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
      env: {
        ...process.env,
        QCR_POST_RESPONSE: JSON.stringify({ id: 447, commit_id: HEAD, state: "APPROVED" }),
      },
    });
    pr = {
      state: "closed",
      merged: false,
      head: { sha: "different" },
      user: { login: "pr-author" },
    };
    checkRuns = [{ name: "unit", status: "completed", conclusion: "failure" }];
    const res = await run("approve-pr.sh", ["5180", join(dir, "missing-body.md")], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "12",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(dir, "receipts"),
    });
    expect(res.ok).toBe(true);
    expect(res.out).toContain("skipping duplicate approval");
    expect(dryrunRecords().some((name) => name.includes("create_review"))).toBe(false);
    expect(dryrunRecords().some((name) => name.includes("remove_label"))).toBe(true);
  });

  it("approval records the same keyed dry-run receipt before trigger cleanup", async () => {
    const key = `v1:5180:8:${HEAD}`;
    const res = await run("approve-pr.sh", ["5180", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "8",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(dir, "receipts"),
    });
    expect(res.ok).toBe(true);
    expect(receipt(8)).toMatchObject({
      status: "dryrun",
      posting_key: key,
      pr: 5180,
      round_no: 8,
      head_sha: HEAD,
      actual_event: "APPROVE",
    });
    const create = dryrunRecords().find((name) => name.includes("create_review"));
    expect(create).toBeDefined();
    expect(JSON.parse(readFileSync(join(dir, "dryrun", create!), "utf8")).body.commit_id).toBe(
      HEAD,
    );
  });
});

describe("scripts/post-review.sh — guard 3", () => {
  it("refuses to post onto a merged PR", async () => {
    pr = { state: "closed", merged: true };
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("already merged");
    expect(dryrunRecords()).toEqual([]);
  });

  it("posts on an open PR", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("continues in dry-run when the state cannot be read (nothing is sent anyway)", async () => {
    pr = null; // the stub 404s
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain("unreadable");
    expect(dryrunRecords()).toHaveLength(1);
  });
});

describe("scripts/post-review.sh — guard 1 (human approval at this head)", () => {
  it("downgrades REQUEST_CHANGES to COMMENT and keeps the findings", async () => {
    reviews = [{ id: 1, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD }];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    const rec = record();
    expect(rec.body.event).toBe("COMMENT");
    expect(rec.body.body).toContain("Automated review body."); // findings intact
    expect(rec.body.body).toContain("@mhale");
    expect(rec.body.commit_id).toBe(HEAD);
    expect(rec.note).toContain("downgraded");
  });

  it("leaves REQUEST_CHANGES alone when the approval is on an older head", async () => {
    reviews = [{ id: 1, user: { login: "mhale" }, state: "APPROVED", commit_id: "0ldhead" }];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("REQUEST_CHANGES");
  });

  it("ignores the bot's own approval and the PR author's", async () => {
    reviews = [
      { id: 1, user: { login: "example-review[bot]" }, state: "APPROVED", commit_id: HEAD },
      { id: 2, user: { login: "pr-author" }, state: "APPROVED", commit_id: HEAD },
    ];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("REQUEST_CHANGES");
  });

  it("sees a human approval past the first 100 reviews (selfscan 91382fae)", async () => {
    // Reviews are oldest-first and every bot thread reply is one, so on a long
    // PR the approval at the current head lives on page 2 or later.
    reviews = [
      ...Array.from({ length: 120 }, (_, i) => ({
        id: i + 1,
        user: { login: "example-review[bot]" },
        state: "COMMENTED",
        commit_id: "0ldhead",
      })),
      { id: 500, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD },
    ];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("COMMENT");
    expect(record().body.body).toContain("@mhale");
  });

  it("ignores an approval the same human has since retired", async () => {
    reviews = [
      { id: 1, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD },
      { id: 2, user: { login: "mhale" }, state: "CHANGES_REQUESTED", commit_id: HEAD },
    ];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("REQUEST_CHANGES");
  });
});

describe("scripts/post-review.sh — guard 2 (no new evidence)", () => {
  it("refuses a second review of the same head with no author reply since", async () => {
    const store = new StateStore(dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });
    store.close();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("guard 2");
    expect(dryrunRecords()).toEqual([]);
  });

  it("allows it again once the author has replied", async () => {
    const store = new StateStore(dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });
    store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
    store.close();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("allows it on a new head", async () => {
    const store = new StateStore(dbPath);
    store.recordReviewedHead(5180, { head_sha: "an0therhead", verdict: "REQUEST_CHANGES" });
    store.close();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("posts when there is no mark at all (and dry-run stamps none)", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    const store = new StateStore(dbPath);
    expect(store.reviewedHead(5180)).toBeUndefined();
    store.close();
  });
});

/**
 * / MC-02 — guard 2 on BOTH routes, pinned by the same table.
 *
 * The two implementations had silently diverged: `src/guards.ts hasNewEvidence`
 * carries the undecided carve-out (a NEEDS_HUMAN/ESCALATE mark is an
 * UNDECIDED review and must never suppress a re-run or a posting), while
 * `scripts/guards.sh` — the route the sessions ACTUALLY post through — never
 * even selected the `verdict` column, so it suppressed exactly the postings the
 * carve-out exists to let through. Neither guards suite covered it.
 *
 * Drift between the twins IS the bug class, so this asserts them TOGETHER: one
 * case list, each case run through the TypeScript predicate and through the
 * real `post-review.sh`, with the two answers required to agree. Asserting each
 * side separately is what let them drift in the first place.
 */
describe("guard 2 parity — src/guards.ts and scripts/guards.sh answer identically", () => {
  interface Case {
    what: string;
    /** The stored mark, or null for "no mark at all". */
    mark: { head_sha: string; verdict: string | null; reply_at?: string } | null;
    /** Is there new evidence at HEAD — i.e. may the review post? */
    newEvidence: boolean;
  }

  const cases: Case[] = [
    {
      what: "same head, decided, no author reply",
      mark: { head_sha: HEAD, verdict: "REQUEST_CHANGES" },
      newEvidence: false,
    },
    {
      what: "same head, APPROVE, no author reply",
      mark: { head_sha: HEAD, verdict: "APPROVE" },
      newEvidence: false,
    },
    // The carve-out. Undecided is not reviewed-and-decided.
    {
      what: "same head, NEEDS_HUMAN — undecided is not reviewed",
      mark: { head_sha: HEAD, verdict: "NEEDS_HUMAN" },
      newEvidence: true,
    },
    // The retired spelling still on disk in older rows; normalizeVerdict folds
    // it, so the shell must fold it too.
    {
      what: "same head, legacy ESCALATE spelling",
      mark: { head_sha: HEAD, verdict: "ESCALATE" },
      newEvidence: true,
    },
    {
      what: "same head, undecided in lower case",
      mark: { head_sha: HEAD, verdict: "needs_human" },
      newEvidence: true,
    },
    {
      what: "a different head",
      mark: { head_sha: "an0therhead", verdict: "REQUEST_CHANGES" },
      newEvidence: true,
    },
    {
      what: "same head with an author reply since",
      mark: { head_sha: HEAD, verdict: "REQUEST_CHANGES", reply_at: "2099-01-01T00:00:00.000Z" },
      newEvidence: true,
    },
    {
      what: "same head, verdict column null (a legacy row)",
      mark: { head_sha: HEAD, verdict: null },
      newEvidence: false,
    },
    { what: "no mark at all", mark: null, newEvidence: true },
  ];

  for (const c of cases) {
    it(`${c.what} → ${c.newEvidence ? "posts" : "refused"} on both routes`, async () => {
      const store = new StateStore(dbPath);
      if (c.mark) {
        store.recordReviewedHead(5180, { head_sha: c.mark.head_sha, verdict: c.mark.verdict });
        if (c.mark.reply_at) store.noteAuthorReply(5180, c.mark.reply_at);
      }
      // --- the TypeScript route ---
      const ts = hasNewEvidence(store.reviewedHead(5180), HEAD);
      store.close();
      expect(ts, "src/guards.ts hasNewEvidence").toBe(c.newEvidence);

      // --- the shell route the sessions actually post through ---
      const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
      expect(res.ok, `scripts/guards.sh guard 2 (${res.out})`).toBe(c.newEvidence);
      if (!c.newEvidence) {
        expect(res.out).toContain("guard 2");
        expect(dryrunRecords()).toEqual([]);
      } else {
        expect(dryrunRecords()).toHaveLength(1);
      }

      // --- and the two agree, which is the property that was missing ---
      expect(res.ok, "the shell twin must answer exactly what hasNewEvidence answers").toBe(ts);
    });
  }
});

describe("scripts/guards.sh — the reviewed-head stamp", () => {
  // The live route stamps the mark itself (the gate's after-step covers only
  // the daemon's route), so the stamp is exercised directly: the shell writes
  // a row src/state.ts reads back, with recordReviewedHead's semantics.
  async function stamp(head: string, event: string): Promise<void> {
    const script = [
      `ROOT=${JSON.stringify(root)}`,
      "API=http://127.0.0.1:1 CONFIG=/dev/null REPO=o/r PR=5180 LIVE=1",
      'die() { echo "$*" >&2; exit 1; }',
      "cfg() { :; }",
      `. ${JSON.stringify(join(root, "scripts", "guards.sh"))}`,
      `guard_stamp_reviewed_head ${JSON.stringify(head)} ${JSON.stringify(event)}`,
    ].join("\n");
    await exec("bash", ["-c", script], { env: { ...process.env, QCR_STATE_DB: dbPath } });
  }

  it("records the head that was really posted, keeping the verdict on a re-stamp", async () => {
    const store = new StateStore(dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES", round_no: 2 });
    store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
    store.close();

    await stamp(HEAD, "COMMENT");
    const after = new StateStore(dbPath);
    expect(after.reviewedHead(5180)).toMatchObject({
      head_sha: HEAD,
      verdict: "REQUEST_CHANGES", // same head ⇒ kept
      round_no: 2,
      posted_event: "COMMENT",
      last_author_reply_at: null, // the reply has now been answered
    });
    after.close();
  });

  it("replaces the row wholesale on a new head", async () => {
    const store = new StateStore(dbPath);
    store.recordReviewedHead(5180, {
      head_sha: "0ldhead",
      verdict: "REQUEST_CHANGES",
      round_no: 1,
    });
    store.close();

    await stamp(HEAD, "REQUEST_CHANGES");
    const after = new StateStore(dbPath);
    expect(after.reviewedHead(5180)).toMatchObject({
      head_sha: HEAD,
      verdict: null,
      round_no: null,
    });
    after.close();
  });
});

describe("scripts/reply-thread.sh — guard 3", () => {
  it("refuses to reply on a merged PR", async () => {
    pr = { state: "closed", merged: true };
    const res = await run("reply-thread.sh", ["5180", "12345", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("already merged");
    expect(dryrunRecords()).toEqual([]);
  });

  it("replies on an open PR", async () => {
    const res = await run("reply-thread.sh", ["5180", "12345", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });
});

describe("guard 5 — QCR_EXPECTED_HEAD (posting-head drift)", () => {
  const MOVED = "5b71a80ffee0987654321fedcba09876543210ab";

  it("post-review.sh posts when the expectation matches the live head", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
    });
    expect(res.ok).toBe(true);
    expect(record().body.commit_id).toBe(HEAD);
  });

  it("post-review.sh refuses when the PR advanced past the reviewed head, exit 1, nothing recorded", async () => {
    pr = { state: "open", merged: false, head: { sha: MOVED }, user: { login: "pr-author" } };
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.out).toContain("head moved");
    expect(res.out).toContain("guard 5");
    // The message tells the session what to do: post nothing further and land
    // the round through the head_moved verdict-file outcome (follow-up).
    expect(res.out).toContain("Post nothing further");
    expect(res.out).toContain("head_moved");
    expect(res.out).toContain("daemon");
    expect(dryrunRecords()).toEqual([]);
  });

  it("post-review.sh warns loudly but proceeds when no expectation is set (older prompts)", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain("WARNING");
    expect(res.out).toContain("QCR_EXPECTED_HEAD");
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("approve-pr.sh refuses on a moved head before anything is recorded", async () => {
    pr = { state: "open", merged: false, head: { sha: MOVED }, user: { login: "pr-author" } };
    const res = await run("approve-pr.sh", ["5180", bodyFile()], { QCR_EXPECTED_HEAD: HEAD });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.out).toContain("head moved");
    expect(dryrunRecords()).toEqual([]);
  });

  it("approve-pr.sh approves when the expectation matches", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()], { QCR_EXPECTED_HEAD: HEAD });
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(3);
  });

  it("approve-pr.sh warns but proceeds when no expectation is set", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain("WARNING");
  });

  it("a case-only sha difference is not drift", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD.toUpperCase(),
    });
    expect(res.ok).toBe(true);
  });

  it("is off when [guards] refuse_on_head_drift = false", async () => {
    pr = { state: "open", merged: false, head: { sha: MOVED }, user: { login: "pr-author" } };
    const base = readFileSync(join(dir, "config.toml"), "utf8");
    writeFileSync(join(dir, "config.toml"), `${base}\n[guards]\nrefuse_on_head_drift = false\n`);
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
    });
    expect(res.ok).toBe(true);
  });
});

/**
 * guard 2 leaves EVIDENCE. #5409 round 18: the refusal was correct
 * and the review work was healthy, but the refusal left no receipt, so the
 * daemon read the missing receipt as a lost POST and opened a FAILED_LOUD
 * incident. The shell now writes an identity-bound `skipped` record before it
 * exits, and only under the same conditions the daemon later checks.
 */
describe("scripts/post-review.sh — guard 2 records a guarded no-op", () => {
  const receiptPath = (round: number) => join(dir, "receipts", `pr-5180-round-${round}.json`);
  const keyed = (round: number, key: string) => ({
    QCR_EXPECTED_HEAD: HEAD,
    QCR_ROUND_NO: String(round),
    QCR_POSTING_KEY: key,
    QCR_POSTING_RECEIPT_DIR: join(dir, "receipts"),
  });
  const seedPartialMark = (): { reviewed_at: string } => {
    const store = new StateStore(dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
    const mark = store.reviewedHead(5180)!;
    store.close();
    return { reviewed_at: mark.reviewed_at };
  };

  it("the #5409 shape: a shell-only REQUEST_CHANGES mark at the same head refuses AND records the refusal — no POST, no dry-run intent, no re-stamp", async () => {
    const mark = seedPartialMark();
    const key = `v1:5180:18:${HEAD}`;

    const res = await run(
      "post-review.sh",
      ["5180", "REQUEST_CHANGES", bodyFile()],
      keyed(18, key),
    );

    expect(res.ok).toBe(false);
    expect(res.out).toContain("guard 2");
    expect(res.out).toContain("recorded guarded no-op");
    expect(dryrunRecords()).toEqual([]);
    const raw = readFileSync(receiptPath(18), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      posting_key: key,
      marker: `<!-- qcr-post:${key} -->`,
      pr: 5180,
      round_no: 18,
      head_sha: HEAD,
      status: "skipped",
      skip_reason: "no-new-evidence",
      intended_event: "REQUEST_CHANGES",
      mode: "dryrun",
      standing_mark: {
        head_sha: HEAD,
        reviewed_at: mark.reviewed_at,
        verdict: null,
        posted_event: "REQUEST_CHANGES",
        round_no: null,
        last_author_reply_at: null,
      },
    });
    expect(JSON.parse(raw)).not.toHaveProperty("actual_event");
    // The daemon-side parser accepts exactly what the shell wrote.
    expect(parsePostingReceipt(raw)?.status).toBe("skipped");
    // The mark was read, not re-stamped, and the receipt lock was released.
    const after = new StateStore(dbPath);
    expect(after.reviewedHead(5180)).toMatchObject({
      reviewed_at: mark.reviewed_at,
      verdict: null,
      posted_event: "REQUEST_CHANGES",
    });
    after.close();
    expect(existsSync(`${receiptPath(18)}.lock`)).toBe(false);
  });

  it("a replay against the recorded refusal is terminal: refuses again, posts nothing, leaves the record byte-identical", async () => {
    seedPartialMark();
    const key = `v1:5180:19:${HEAD}`;
    expect((await run("post-review.sh", ["5180", "COMMENT", bodyFile()], keyed(19, key))).ok).toBe(
      false,
    );
    const first = readFileSync(receiptPath(19), "utf8");

    const again = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], keyed(19, key));

    expect(again.ok).toBe(false);
    expect(again.out).toContain("already refused");
    expect(readFileSync(receiptPath(19), "utf8")).toBe(first);
    expect(dryrunRecords()).toEqual([]);
  });

  it("a legacy round with no posting identity refuses exactly as before and records nothing", async () => {
    seedPartialMark();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("guard 2");
    expect(res.out).not.toContain("recorded guarded no-op");
    expect(existsSync(join(dir, "receipts"))).toBe(false);
    expect(dryrunRecords()).toEqual([]);
  });

  it("an author reply since the mark still posts, and writes an ordinary receipt rather than a skip", async () => {
    const store = new StateStore(dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
    store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
    store.close();
    const key = `v1:5180:20:${HEAD}`;

    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], keyed(20, key));

    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
    expect(JSON.parse(readFileSync(receiptPath(20), "utf8"))).toMatchObject({
      status: "dryrun",
      posting_key: key,
    });
  });

  it("posting-receipt.py: a skip never lands over an attempted post, an attempt never lands over a skip, and a same-identity skip replays inertly", async () => {
    const script = join(root, "scripts", "posting-receipt.py");
    const mark = JSON.stringify({
      head_sha: HEAD,
      reviewed_at: "2026-09-01T10:41:34.773Z",
      last_author_reply_at: null,
      verdict: null,
      posted_event: "REQUEST_CHANGES",
      round_no: null,
    });
    mkdirSync(join(dir, "receipts"), { recursive: true });

    // prepared ⇒ skip refused (the ambiguous window outranks a later "never sent").
    const k21 = `v1:5180:21:${HEAD}`;
    await exec("python3", [
      script,
      "prepare",
      receiptPath(21),
      k21,
      "5180",
      "21",
      HEAD,
      "COMMENT",
      "COMMENT",
      '{"event":"COMMENT"}',
    ]);
    await expect(
      exec("python3", [
        script,
        "skip",
        receiptPath(21),
        k21,
        "5180",
        "21",
        HEAD,
        "COMMENT",
        "dryrun",
        mark,
      ]),
    ).rejects.toThrow(/attempted post/);
    expect(JSON.parse(readFileSync(receiptPath(21), "utf8")).status).toBe("prepared");

    // skipped ⇒ prepare refused (the refusal is terminal for the key).
    const k22 = `v1:5180:22:${HEAD}`;
    await exec("python3", [
      script,
      "skip",
      receiptPath(22),
      k22,
      "5180",
      "22",
      HEAD,
      "COMMENT",
      "dryrun",
      mark,
    ]);
    await expect(
      exec("python3", [
        script,
        "prepare",
        receiptPath(22),
        k22,
        "5180",
        "22",
        HEAD,
        "COMMENT",
        "COMMENT",
        '{"event":"COMMENT"}',
      ]),
    ).rejects.toThrow(/refused/);
    const before = readFileSync(receiptPath(22), "utf8");
    await exec("python3", [
      script,
      "skip",
      receiptPath(22),
      k22,
      "5180",
      "22",
      HEAD,
      "COMMENT",
      "dryrun",
      mark,
    ]);
    expect(readFileSync(receiptPath(22), "utf8")).toBe(before);

    // A mark that would NOT satisfy guard 2 cannot be written as a skip at all.
    const k23 = `v1:5180:23:${HEAD}`;
    const replied = JSON.stringify({
      ...JSON.parse(mark),
      last_author_reply_at: "2026-09-01T11:00:00.000Z",
    });
    await expect(
      exec("python3", [
        script,
        "skip",
        receiptPath(23),
        k23,
        "5180",
        "23",
        HEAD,
        "COMMENT",
        "dryrun",
        replied,
      ]),
    ).rejects.toThrow(/author reply/);
    const otherHead = JSON.stringify({ ...JSON.parse(mark), head_sha: "0000000" });
    await expect(
      exec("python3", [
        script,
        "skip",
        receiptPath(23),
        k23,
        "5180",
        "23",
        HEAD,
        "COMMENT",
        "dryrun",
        otherHead,
      ]),
    ).rejects.toThrow(/head/);
    expect(existsSync(receiptPath(23))).toBe(false);
  });
});
