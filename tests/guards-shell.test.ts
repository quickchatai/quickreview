// Guard 3 on the OTHER posting route. The sessions post through
// scripts/post-review.sh and scripts/approve-pr.sh, which do not go through
// src/gate.ts — so the merged/closed re-check is mirrored there the same way
// the dry-run gate is, and this is the bypass-attempt test: posting via the
// shell path still hits the guard.
//
// No real GitHub and no real credential: GITHUB_API points at a loopback stub,
// and the throwaway config's secrets_dir is an empty temp dir, so
// mint-token.sh finds no PEM and the scripts fall back to an unauthenticated
// read against the stub. Everything runs in dry-run, so nothing is ever sent.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PrStub {
  state: "open" | "closed";
  merged: boolean;
}

let server: Server;
let apiBase: string;
let dir: string;
let pr: PrStub | null;

const CONFIG = (secretsDir: string) =>
  [
    "dry_run = true",
    "",
    "[github]",
    'repo = "example-org/example-app"',
    'trigger_label = "AI review requested"',
    'review_team = "example-org/review"',
    `secrets_dir = "${secretsDir}"`,
    "",
  ].join("\n");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "qcr-guard3-"));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "config.toml"), CONFIG(join(dir, "secrets")));
  pr = { state: "open", merged: false };
  server = createServer((req, res) => {
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

async function run(script: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec("bash", [join(root, "scripts", script), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_API: apiBase,
        QCR_CONFIG: join(dir, "config.toml"),
        QCR_DRYRUN_DIR: join(dir, "dryrun"),
      },
    });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function dryrunRecords(): string[] {
  try {
    return readdirSync(join(dir, "dryrun"));
  } catch {
    return [];
  }
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
    expect(kinds.sort()).toEqual(["create_review.json", "delete_team_review_request.json", "remove_label.json"]);
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
