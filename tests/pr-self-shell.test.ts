// scripts/pr-self.sh — the sessions' sanctioned READ-ONLY
// self-verification helper. Tested the way guards-shell-*.test.ts test its kin:
// the real script against a loopback HTTP stub, no real GitHub and no real
// credential (empty secrets dir → mint-token.sh fails → unauthenticated read).
//
// The invariant under test is structural read-only-ness: the script's own
// subcommands issue GETs only (the stub 500s and records anything else), and
// the script text carries no method override, no request body, and no gh
// invocation at all — there is no mutation path to guard.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "scripts", "pr-self.sh"), "utf8");

const HEAD = "68b8040c0ffee1234567890abcdef0123456789a";

interface ReviewStub {
  id: number;
  user: { login: string };
  state: string;
  commit_id: string;
  submitted_at?: string;
  body?: string;
}

let server: Server;
let apiBase: string;
let dir: string;
let reviews: ReviewStub[];
/** Every request method the stub saw — the read-only proof reads this. */
let methodsSeen: string[];

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
  dir = mkdtempSync(join(tmpdir(), "qcr-prself-"));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "config.toml"), CONFIG(join(dir, "secrets")));
  reviews = [];
  methodsSeen = [];
  server = createServer((req, res) => {
    methodsSeen.push(req.method ?? "?");
    if (req.method !== "GET") {
      // A non-GET from a "read-only" script is the bug this suite exists for.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `mutating ${req.method} ${req.url}` }));
      return;
    }
    if (req.url?.includes("/pulls/5180/reviews")) {
      // Paged as GitHub pages it: per_page rows of page N, oldest first.
      const q = new URL(req.url, "http://stub").searchParams;
      const per = Number(q.get("per_page") ?? 30);
      const page = Number(q.get("page") ?? 1);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reviews.slice((page - 1) * per, page * per)));
      return;
    }
    if (req.url?.endsWith("/pulls/5180")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          state: "open",
          merged: false,
          head: { sha: HEAD },
          user: { login: "pr-author" },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `Not Found ${req.url}` }));
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

async function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec("bash", [join(root, "scripts", "pr-self.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_API: apiBase, QCR_CONFIG: join(dir, "config.toml") },
    });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("scripts/pr-self.sh — argument contract", () => {
  it("rejects a non-numeric PR and an unknown subcommand, touching nothing", async () => {
    for (const args of [["abc", "head"], ["5180", "dismiss"], ["5180"], []]) {
      const res = await run(args);
      expect(res.ok).toBe(false);
      expect(res.out).toContain("usage: pr-self.sh <pr-number> <reviews|threads|head|checks>");
    }
    expect(methodsSeen).toEqual([]);
  });
});

describe("scripts/pr-self.sh — head", () => {
  it("prints the current head sha via a GET only", async () => {
    const res = await run(["5180", "head"]);
    expect(res.ok).toBe(true);
    expect(res.out.trim()).toBe(HEAD);
    expect(methodsSeen.length).toBeGreaterThan(0);
    expect(new Set(methodsSeen)).toEqual(new Set(["GET"]));
  });
});

describe("scripts/pr-self.sh — reviews", () => {
  it("lists only the bot's own reviews, humans filtered out", async () => {
    reviews = [
      { id: 1, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD },
      {
        id: 2,
        user: { login: "example-review[bot]" },
        state: "CHANGES_REQUESTED",
        commit_id: HEAD,
        submitted_at: "2026-08-19T10:00:00Z",
        body: "Two blockers found.",
      },
      { id: 3, user: { login: "pr-author" }, state: "COMMENTED", commit_id: HEAD },
    ];
    const res = await run(["5180", "reviews"]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain(
      `[2] CHANGES_REQUESTED @ ${HEAD} (2026-08-19T10:00:00Z) Two blockers found.`,
    );
    expect(res.out).not.toContain("mhale");
    expect(res.out).not.toContain("[1]");
    expect(res.out).not.toContain("[3]");
    expect(new Set(methodsSeen)).toEqual(new Set(["GET"]));
  });

  it("reads every page: the bot's latest review past row 100 is listed", async () => {
    reviews = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      user: { login: "mhale" },
      state: "COMMENTED",
      commit_id: HEAD,
    }));
    reviews.push({
      id: 151,
      user: { login: "example-review[bot]" },
      state: "APPROVED",
      commit_id: HEAD,
      submitted_at: "2026-08-20T10:00:00Z",
      body: "Looks good.",
    });
    const res = await run(["5180", "reviews"]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain(`[151] APPROVED @ ${HEAD} (2026-08-20T10:00:00Z) Looks good.`);
    expect(res.out).not.toContain("no reviews posted");
    expect(new Set(methodsSeen)).toEqual(new Set(["GET"]));
  });

  it("refuses a saturated review page limit instead of presenting a truncated history", async () => {
    reviews = Array.from({ length: 3000 }, (_, i) => ({
      id: i + 1, user: { login: "example-review[bot]" }, state: "COMMENTED", commit_id: HEAD,
    }));
    const res = await run(["5180", "reviews"]);
    expect(res.ok).toBe(false);
    expect(res.out).toMatch(/incomplete|page limit/i);
    expect(res.out).not.toContain("[1]");
  });

  it("says so plainly when the bot has posted nothing", async () => {
    const res = await run(["5180", "reviews"]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain("no reviews posted by example-review[bot] on #5180");
  });
});

describe("scripts/pr-self.sh — delegation and read-only construction", () => {
  it("delegates threads and checks to the sibling read-only scripts", () => {
    expect(script).toContain('threads) exec "$ROOT/scripts/pr-threads.sh" "$PR"');
    expect(script).toContain('checks)  exec "$ROOT/scripts/pr-checks.sh" "$PR"');
  });

  it("contains no mutating verbs, method overrides, request bodies, or gh calls", () => {
    // curl with no -X/--request is a GET; no body-carrying flags anywhere.
    expect(script).not.toMatch(/-X\s/);
    expect(script).not.toMatch(/--request/);
    expect(script).not.toMatch(/--data|\s-d\s|--form|\s-F\s/);
    expect(script).not.toMatch(/\bgh\s+(api|pr|issue)/);
    expect(script).not.toMatch(/POST|PATCH|PUT|DELETE/);
    // It never sources the guards (nothing to guard) nor writes dry-run intents.
    expect(script).not.toMatch(/(^|\n)\s*(\.|source)\s+\S*guards\.sh/);
    expect(script).not.toContain("dryrun");
    // The credential is the app token only.
    expect(script).toContain("mint-token.sh");
    expect(script).not.toContain("GH_TOKEN=");
  });
});
