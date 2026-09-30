// A bench case's inputs belong to THIS case and THIS attempt (selfscan2
// bench-harness):
//
//   1. a cached prefetch store is reused only when it was fetched for the
//      exact base the case names — not merely one with the same merge-base
//      (prepareTree installs meta.base_commit as origin/<base_ref>);
//   2. a retried case never `--continue`s an earlier attempt's pi session: a
//      pi that dies before its first message leaves nothing to continue, even
//      when a previous attempt left a session JSONL in the case dir.
//
// Local git only: https transport is disabled for these tests, so a cache
// MISS fails fast instead of reaching GitHub.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
// The bench reads the install locator's config; name a production-shaped one.
vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { safeId } = await import("../src/bench/aacr.js");
type BenchCase = import("../src/bench/aacr.js").BenchCase;
type PrefetchMeta = import("../src/bench/aacr.js").PrefetchMeta;
const { prefetchCase, storeDir } = await import("../src/bench/prefetch.js");
const { benchConfig, reviewCase } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

const tmp = mkdtempSync(join(tmpdir(), "bench-identity-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

// History: B0 ← B2 ← B1 on the base branch; H forks from B0. merge-base(B1, H)
// and merge-base(B2, H) are both B0.
let B0 = "";
let B1 = "";
let B2 = "";
let H = "";
const store = join(tmp, "store");

function mkCase(base: string): BenchCase {
  return {
    instance_id: `acme__widget@${H.slice(0, 7)}`,
    repo: "acme/widget",
    pr: 7,
    pr_url: "https://github.com/acme/widget/pull/7",
    base_commit: base,
    head_commit: H,
    language: "TypeScript",
    pr_category: "bug",
    change_line_count: 1,
    references: 1,
  };
}

function metaFor(c: BenchCase): PrefetchMeta {
  return {
    instance_id: c.instance_id,
    repo: c.repo,
    pr: c.pr,
    base_commit: c.base_commit,
    head_commit: c.head_commit,
    merge_base: B0,
    base_ref: "main",
    base_ref_source: "github-api",
    title: "t",
    body: "b",
    depth: 50,
    diff: { files: 1, additions: 1, deletions: 0 },
    fetched_at: "2026-09-30T00:00:00Z",
  };
}

beforeAll(() => {
  const work = join(tmp, "work");
  mkdirSync(work);
  git(work, "init", "--quiet", "-b", "main");
  const commit = (file: string, text: string): string => {
    writeFileSync(join(work, file), text);
    git(work, "add", file);
    git(work, "commit", "--quiet", "-m", file);
    return git(work, "rev-parse", "HEAD");
  };
  B0 = commit("a.txt", "zero\n");
  B2 = commit("a.txt", "two\n");
  B1 = commit("a.txt", "one\n");
  git(work, "checkout", "--quiet", "-b", "pr", B0);
  H = commit("b.ts", "export const x = 1;\n");
  mkdirSync(store, { recursive: true });
  const dir = storeDir(store, mkCase(B1));
  execFileSync("git", ["clone", "--quiet", "--bare", work, dir]);
  writeFileSync(join(dir, "bench-meta.json"), JSON.stringify(metaFor(mkCase(B1)), null, 2));
});

describe("prefetch cache admission", () => {
  it("reuses a store fetched for the exact base", async () => {
    const meta = await prefetchCase(mkCase(B1), { store });
    expect(meta.base_commit).toBe(B1);
  });

  it("does NOT reuse a store fetched for another base with the same merge-base", async () => {
    // Before the fix this returned the cached meta — base_commit B1 for a case
    // that names B2 — and the tree cited the wrong origin/<base_ref>.
    const c = mkCase(B2);
    let got: PrefetchMeta | undefined;
    try {
      got = await prefetchCase(c, {
        store,
        fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
      });
    } catch {
      got = undefined; // the refetch cannot reach GitHub here — the miss is the point
    }
    if (got) expect(got.base_commit).toBe(B2);
    expect(existsSync(join(storeDir(store, c), "bench-meta.json"))).toBe(false);
  });
});

describe("a retried case's continuation", () => {
  it("never continues a session left by an earlier attempt", async () => {
    const c = mkCase(B1);
    const cstore = join(tmp, "store2");
    execFileSync("git", ["clone", "--quiet", "--bare", join(tmp, "work"), storeDir(cstore, c)]);
    // A production-shaped root without touching the checkout's own wt/.
    const root = join(tmp, "root");
    mkdirSync(root);
    for (const e of readdirSync(ROOT))
      if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
    const outDir = join(tmp, "out");
    const caseDir = join(outDir, "cases", safeId(c.instance_id));
    // Attempt 1 persisted a session and failed.
    mkdirSync(join(caseDir, "session"), { recursive: true });
    writeFileSync(join(caseDir, "session", "attempt-1.jsonl"), '{"type":"session"}\n');
    // Attempt 2's pi dies before its first assistant message.
    const calls = join(tmp, "pi-calls.log");
    const piBin = join(tmp, "fake-pi");
    writeFileSync(
      piBin,
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\necho "429 rate limit" >&2\nexit 1\n`,
    );
    chmodSync(piBin, 0o755);
    const s = await reviewCase(
      c,
      metaFor(c),
      {
        root,
        store: cstore,
        outDir,
        agentDir: join(tmp, "agent"),
        profile: "",
        timeoutMs: 10 * 60_000,
        piBin,
      },
      {
        cfg: benchConfig(""),
        ecosystem: ecosystemFor("none"),
        fingerprint: {} as never,
      },
    );
    const invocations = readFileSync(calls, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).not.toMatch(/--continue/);
    expect(s.continued).toBe(false);
    expect(s.error).toMatch(/nothing to continue/);
  });
});
