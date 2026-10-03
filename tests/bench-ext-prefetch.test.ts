// External-benchmark prefetch (bench/aacr/EXTERNAL-BENCHMARKS.md), against
// scratch repos — git is the thing under test, local transport only:
//
//   1. a LEAK-PROOF case (SWE-PRBench) gets a store holding exactly two
//      synthetic commits over the real merge-base and head trees: no PR
//      commit, no commit message, nothing a later review round left behind —
//      and the synthetic ids are the ones the set builder computes by hand;
//   2. a FORK case (Martian) fetches from `fetch_repo` — from the local mirror
//      first — asks the API about the fork's PR, and refuses a store whose
//      merge-base differs from the set's.
//
// https is disabled for these tests, so anything that tried the network fails.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");

const { leakproofCommitText, parseCaseSet } = await import("../src/bench/aacr.js");
type BenchCase = import("../src/bench/aacr.js").BenchCase;
const { prefetchCase, storeDir, mirrorsFromEnv, fetchRepoOf } = await import(
  "../src/bench/prefetch.js"
);

const tmp = mkdtempSync(join(tmpdir(), "bench-ext-prefetch-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trim();
const has = (dir: string, sha: string): boolean => {
  try {
    git(dir, "cat-file", "-e", sha);
    return true;
  } catch {
    return false;
  }
};

/** A git commit id computed by hand — what bench/aacr/ext/sweprbench_set.py does. */
const commitId = (text: string): string =>
  createHash("sha1")
    .update(`commit ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");

// Upstream: B0 ← B1 on main; the PR forks at B0: P1 ("address review: …") ← P2.
const upstream = join(tmp, "upstream");
let B0 = "";
let B1 = "";
let P1 = "";
let P2 = "";
const NOT_THERE = join(tmp, "no-such-remote");

beforeAll(() => {
  mkdirSync(upstream);
  git(upstream, "init", "--quiet", "-b", "main");
  // GitHub serves any reachable sha; a plain local repo needs telling.
  git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true");
  const commit = (file: string, text: string, msg: string): string => {
    writeFileSync(join(upstream, file), text);
    git(upstream, "add", file);
    git(upstream, "commit", "--quiet", "-m", msg);
    return git(upstream, "rev-parse", "HEAD");
  };
  B0 = commit("a.py", "x = 1\n", "base zero");
  B1 = commit("a.py", "x = 2\n", "base one");
  git(upstream, "checkout", "--quiet", "-b", "pr", B0);
  P1 = commit("b.py", "y = 1\n", "first try");
  P2 = commit("b.py", "y = 2\n", "address review: the reviewer said y must be 2");
  git(upstream, "checkout", "--quiet", "main");
});

function leakproofCase(): BenchCase {
  const baseTree = git(upstream, "rev-parse", `${B0}^{tree}`);
  const headTree = git(upstream, "rev-parse", `${P2}^{tree}`);
  const base = commitId(leakproofCommitText(baseTree, null));
  const head = commitId(leakproofCommitText(headTree, base));
  return {
    instance_id: `acme__lib@${head.slice(0, 7)}`,
    repo: "acme/lib",
    pr: 9,
    pr_url: "https://github.com/acme/lib/pull/9",
    base_commit: base,
    head_commit: head,
    language: "Python",
    pr_category: "Type1_Direct",
    change_line_count: 1,
    references: 2,
    title: "Make y two",
    body: "Sets y.",
    leakproof: { source_head: P2, source_merge_base: B0, base_tree: baseTree, head_tree: headTree },
  };
}

describe("leak-proof prefetch (SWE-PRBench)", () => {
  const store = join(tmp, "store-lp");

  it("stores exactly the two synthetic commits over the real trees", async () => {
    const c = leakproofCase();
    const meta = await prefetchCase(c, {
      store,
      remoteFor: () => `file://${upstream}`,
      mirrors: new Map(),
      fetchImpl: (() => {
        throw new Error("a set that carries the PR text must not call the API");
      }) as unknown as typeof fetch,
    });
    const dir = storeDir(store, c);
    expect(git(dir, "rev-list", "--all").split("\n").sort()).toEqual(
      [c.base_commit, c.head_commit].sort(),
    );
    // No real commit — and so no message — of the PR or its base survived.
    for (const real of [B0, B1, P1, P2]) expect(has(dir, real), real).toBe(false);
    expect(git(dir, "log", "--format=%B", "--all")).not.toMatch(/review|first try|base zero/);
    expect(git(dir, "rev-parse", `${c.head_commit}^{tree}`)).toBe(c.leakproof!.head_tree);
    expect(git(dir, "rev-parse", `${c.head_commit}^`)).toBe(c.base_commit);
    expect(existsSync(join(dir, "shallow"))).toBe(false);
    expect(meta.merge_base).toBe(c.base_commit);
    expect(meta.title).toBe("Make y two");
    expect(meta.body).toBe("Sets y.");
    // The PR's whole change (b.py added) — not the last commit's.
    expect(meta.diff).toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("reuses the store on a second run", async () => {
    const c = leakproofCase();
    const lines: string[] = [];
    await prefetchCase(c, { store, remoteFor: () => NOT_THERE, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/cached/);
  });

  it("refuses a set whose tree disagrees with the fetched commit", async () => {
    const c = leakproofCase();
    const bad = { ...c, leakproof: { ...c.leakproof!, head_tree: c.leakproof!.base_tree } };
    await expect(
      prefetchCase(bad, { store: join(tmp, "store-bad"), remoteFor: () => `file://${upstream}` }),
    ).rejects.toThrow(/tree of/);
    expect(existsSync(storeDir(join(tmp, "store-bad"), bad))).toBe(false);
  });

  it("refuses synthetic ids the set builder did not compute", async () => {
    const c = leakproofCase();
    const forged = { ...c, base_commit: "f".repeat(40) };
    await expect(
      prefetchCase(forged, { store: join(tmp, "store-forged"), remoteFor: () => `file://${upstream}` }),
    ).rejects.toThrow(/synthetic commit/);
  });
});

describe("local case: a leak-proof store from a mirror, no network at all", () => {
  // A self-review of this repository's own commits (bench/aacr/sets/
  // self-review-*.json): the only source is a local mirror, the set carries
  // the base branch's name, and nothing may reach a network remote — not the
  // fetch, not the API, not the default-branch ls-remote.
  it("fetches from the mirror and takes base_ref from the set", async () => {
    const c: BenchCase = { ...leakproofCase(), repo: "local/lib", base_ref: "master" };
    c.instance_id = `local__lib@${c.head_commit.slice(0, 7)}`;
    const store = join(tmp, "store-local");
    const meta = await prefetchCase(c, {
      store,
      remoteFor: () => NOT_THERE,
      mirrors: new Map([["local/lib", upstream]]),
      fetchImpl: (() => {
        throw new Error("a local case must not call the API");
      }) as unknown as typeof fetch,
    });
    expect(meta.base_ref).toBe("master");
    expect(meta.base_ref_source).toBe("set");
    expect(git(storeDir(store, c), "rev-list", "--all").split("\n").sort()).toEqual(
      [c.base_commit, c.head_commit].sort(),
    );
  });

  it("the shipped self-review set parses under its own pin", () => {
    const set = parseCaseSet(
      JSON.parse(readFileSync(join(import.meta.dirname, "..", "bench/aacr/sets/self-review-pc1.json"), "utf8")),
    );
    expect(set.pin).toBe("self-review-local");
    expect(set.references).toBe(0);
    expect(set.cases[0]!.base_ref).toBe("master");
    expect(set.cases[0]!.leakproof).toBeDefined();
    expect(() => parseCaseSet({ ...set, cases: [{ ...set.cases[0], base_ref: "a b" }] })).toThrow(/bad base_ref/);
  });
});

describe("fork + mirror prefetch (Martian)", () => {
  // The "fork" is the mirror's only source here; the network remote does not exist.
  const mirror = join(tmp, "mirror.git");

  beforeAll(() => {
    execFileSync("git", ["clone", "--quiet", "--bare", upstream, mirror], { env: ENV });
  });

  function forkCase(): BenchCase {
    return {
      instance_id: `upstream__proj-1234@${P2.slice(0, 7)}`,
      repo: "upstream/proj",
      pr: 1234,
      pr_url: "https://github.com/upstream/proj/pull/1234",
      base_commit: B1,
      head_commit: P2,
      language: "Python",
      pr_category: "",
      change_line_count: 2,
      references: 1,
      fetch_repo: "bench-org/proj__PR1234",
      fetch_pr: 1,
      expect_merge_base: B0,
    };
  }

  it("fetches from the mirror and asks the API about the FORK's PR", async () => {
    const c = forkCase();
    const asked: string[] = [];
    const store = join(tmp, "store-fork");
    const meta = await prefetchCase(c, {
      store,
      remoteFor: () => NOT_THERE,
      mirrors: new Map([["bench-org/proj__PR1234", mirror]]),
      fetchImpl: (async (url: string) => {
        asked.push(String(url));
        return new Response(JSON.stringify({ title: "T", body: "B", base: { ref: "main" } }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    expect(asked).toEqual(["https://api.github.com/repos/bench-org/proj__PR1234/pulls/1"]);
    // The PR's base is ahead of the merge-base (base moved after the fork).
    expect(meta.merge_base).toBe(B0);
    expect(meta.base_commit).toBe(B1);
    expect(meta.title).toBe("T");
    expect(meta.base_ref).toBe("main");
    expect(has(storeDir(store, c), P2)).toBe(true);
  });

  it("refuses a merge-base other than the set's", async () => {
    const c = { ...forkCase(), expect_merge_base: B1 };
    await expect(
      prefetchCase(c, {
        store: join(tmp, "store-fork-mb"),
        remoteFor: () => NOT_THERE,
        mirrors: new Map([["bench-org/proj__PR1234", mirror]]),
        fetchImpl: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/differs from the set/);
  });

  it("falls back to the network remote when the mirror lacks the commits", async () => {
    const c = forkCase();
    const empty = join(tmp, "empty.git");
    execFileSync("git", ["init", "--quiet", "--bare", empty], { env: ENV });
    const lines: string[] = [];
    const meta = await prefetchCase(c, {
      store: join(tmp, "store-fallback"),
      remoteFor: () => `file://${upstream}`,
      mirrors: new Map([["bench-org/proj__PR1234", empty]]),
      fetchImpl: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
      log: (l) => lines.push(l),
    });
    expect(meta.merge_base).toBe(B0);
    expect(lines.join("\n")).toMatch(/mirror fetch failed/);
    expect(lines.join("\n")).toMatch(/ok \(network/);
  });
});

describe("mirror configuration", () => {
  it("reads QCR_BENCH_MIRRORS and refuses a path that climbs out of the root", () => {
    const m = mirrorsFromEnv({
      QCR_BENCH_MIRRORS: JSON.stringify({ root: "/mirrors", repos: { "a/b": "martian/a.git" } }),
    });
    expect(m.get("a/b")).toBe("/mirrors/martian/a.git");
    expect(mirrorsFromEnv({}).size).toBe(0);
    expect(() =>
      mirrorsFromEnv({
        QCR_BENCH_MIRRORS: JSON.stringify({ root: "/mirrors", repos: { "a/b": "../etc" } }),
      }),
    ).toThrow(/bad path/);
    expect(() =>
      mirrorsFromEnv({ QCR_BENCH_MIRRORS: JSON.stringify({ root: "rel", repos: {} }) }),
    ).toThrow(/absolute root/);
  });

  it("a case without fetch_repo fetches from its own repo and PR", () => {
    const c = { repo: "o/r", pr: 5 } as BenchCase;
    expect(fetchRepoOf(c)).toEqual({ repo: "o/r", pr: 5 });
    expect(fetchRepoOf({ ...c, fetch_repo: "f/k" })).toEqual({ repo: "f/k", pr: 1 });
  });
});
