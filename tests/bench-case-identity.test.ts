// A bench case's inputs belong to THIS case and THIS attempt:
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

import { piCliRuntime } from "./helpers/pi-cli-runtime.js";
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

const captureFault = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const { Writable } = await import("node:stream");
  return {
    ...real,
    createWriteStream: (...args: Parameters<typeof real.createWriteStream>) => {
      if (!captureFault.enabled || !String(args[0]).endsWith("pi-events.jsonl"))
        return real.createWriteStream(...args);
      real.appendFileSync(args[0], "");
      return new Writable({
        write(_chunk, _encoding, done) {
          done(new Error("capture quota exhausted"));
        },
      });
    },
  };
});

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
const { benchConfig, changedFiles, reviewCase } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("@quickchatai/pi-quickreview/src/ecosystem.js");

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
    // Reusing the cached meta here would give base_commit B1 for a case that
    // names B2, and the tree would cite the wrong origin/<base_ref>.
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
    // Attempt 2's pi dies before its first assistant message. It reads its
    // prompt first, as a real pi does before calling the model: a fake that
    // exits without reading races runPi's stdin write, and on a loaded machine
    // loses it — an EPIPE the runner rightly reports as a failed prompt
    // delivery, which is a different case from the one this test is about.
    const calls = join(tmp, "pi-calls.log");
    const piBin = join(tmp, "fake-pi");
    writeFileSync(
      piBin,
      `#!/bin/sh\ncat >/dev/null\necho "$*" >> ${JSON.stringify(calls)}\necho "429 rate limit" >&2\nexit 1\n`,
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
        timeoutMs: 10 * 60_000,
        runtime: piCliRuntime({ bin: piBin }),
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

describe("a completed benchmark process with invalid output guarantees", () => {
  const finished = async (record: boolean, fault = false) => {
    const dir = mkdtempSync(join(tmp, "finished-"));
    const c = mkCase(B1);
    const cstore = join(dir, "store");
    execFileSync("git", ["clone", "--quiet", "--bare", join(tmp, "work"), storeDir(cstore, c)]);
    const root = join(dir, "root");
    mkdirSync(root);
    for (const entry of readdirSync(ROOT))
      if (!["wt", ".git", "state"].includes(entry))
        symlinkSync(join(ROOT, entry), join(root, entry));
    const outDir = join(dir, "out");
    const caseDir = join(outDir, "cases", safeId(c.instance_id));
    const files: Record<string, string> = {
      "outcome.json": JSON.stringify({ verdict: "APPROVE", passes: [] }),
      "comments.json": "[]",
      "review.md": "Approved",
      ...(record ? { "findings-record.json": JSON.stringify({ findings: [] }) } : {}),
    };
    const piBin = join(dir, "fake-pi");
    writeFileSync(
      piBin,
      `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { const fs = require('node:fs'); for (const [name, text] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync(require('node:path').join(${JSON.stringify(caseDir)}, name), text); console.log('{}'); });\n`,
    );
    chmodSync(piBin, 0o755);
    const cfg = benchConfig("");
    cfg.review.render_outputs = true;
    captureFault.enabled = fault;
    try {
      return await reviewCase(
        c,
        metaFor(c),
        {
          root,
          store: cstore,
          outDir,
          agentDir: join(dir, "agent"),
          timeoutMs: 10 * 60_000,
          runtime: piCliRuntime({ bin: piBin }),
        },
        { cfg, ecosystem: ecosystemFor("none"), fingerprint: {} as never },
      );
    } finally {
      captureFault.enabled = false;
    }
  };
  it("requires the record even when handwritten output and a valid verdict exist", async () => {
    const summary = await finished(false);
    expect(summary.status).toBe("no-output");
    expect(summary.error).toContain("findings-record.json");
  });
  it("reports capture failure even after usable output files have been written", async () => {
    const summary = await finished(true, true);
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("capture quota exhausted");
  });
});

describe("a round whose output files do not parse", () => {
  // The fake pi reads its prompt, persists a session (so `--continue` has one
  // to resume), and writes the BENCHMARK MODE files: the first turn's
  // findings record with escaped quotes around a key — the shape Gemma 4 wrote
  // — and the continuation's as `fixed` says.
  const run = async (fixed: string) => {
    const c = mkCase(B1);
    const cstore = join(tmp, `store-json-${fixed.length}`);
    execFileSync("git", ["clone", "--quiet", "--bare", join(tmp, "work"), storeDir(cstore, c)]);
    const root = join(tmp, `root-json-${fixed.length}`);
    mkdirSync(root);
    for (const e of readdirSync(ROOT))
      if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
    const outDir = join(tmp, `out-json-${fixed.length}`);
    const calls = join(tmp, `pi-calls-json-${fixed.length}.log`);
    const piBin = join(tmp, `fake-pi-json-${fixed.length}`);
    writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        `echo "$*" >> ${JSON.stringify(calls)}`,
        'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
        'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
        'case "$*" in',
        `  *--continue*) printf '%s' ${JSON.stringify(fixed)} > "$cd/findings-record.json" ;;`,
        `  *) printf '%s' '{"findings": [], \\"verdict\\": \\"REQUEST_CHANGES\\"}' > "$cd/findings-record.json"`,
        `     printf '%s' '{"verdict": "REQUEST_CHANGES", "passes": []}' > "$cd/outcome.json" ;;`,
        "esac",
        "",
      ].join("\n"),
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
        timeoutMs: 10 * 60_000,
        runtime: piCliRuntime({ bin: piBin }),
      },
      { cfg: benchConfig(""), ecosystem: ecosystemFor("none"), fingerprint: {} as never },
    );
    return { s, invocations: readFileSync(calls, "utf8").trim().split("\n") };
  };

  it("gets the one continuation, told which file and why, and is read once rewritten", async () => {
    const { s, invocations } = await run('{"findings": []}');
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toMatch(/--continue/);
    expect(invocations[1]).toMatch(/findings-record\.json is not valid JSON/);
    expect(s.continued).toBe(true);
    expect(s.status).not.toBe("no-output");
  });

  it("still unreadable after it: no-output that names the file, never a second continuation", async () => {
    const { s, invocations } = await run('{"findings": [], \\"x\\": 1}');
    expect(invocations).toHaveLength(2);
    expect(s.continued).toBe(true);
    expect(s.status).toBe("no-output");
    expect(s.error).toMatch(/findings-record\.json is not valid JSON/);
  });
});

describe("a round that wrote its outcome without a file the scorer reads", () => {
  it("gets the one continuation, told to finish the files, and is read once written", async () => {
    const c = mkCase(B1);
    const cstore = join(tmp, "store-missing");
    execFileSync("git", ["clone", "--quiet", "--bare", join(tmp, "work"), storeDir(cstore, c)]);
    const root = join(tmp, "root-missing");
    mkdirSync(root);
    for (const e of readdirSync(ROOT))
      if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
    const outDir = join(tmp, "out-missing");
    const calls = join(tmp, "pi-calls-missing.log");
    const piBin = join(tmp, "fake-pi-missing");
    // The first turn writes outcome.json and no findings record; the
    // continuation writes the record.
    writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        `echo "$*" >> ${JSON.stringify(calls)}`,
        'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
        'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
        'case "$*" in',
        `  *--continue*) printf '%s' '{"findings": []}' > "$cd/findings-record.json" ;;`,
        `  *) printf '%s' '{"verdict": "REQUEST_CHANGES", "passes": []}' > "$cd/outcome.json" ;;`,
        "esac",
        "",
      ].join("\n"),
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
        timeoutMs: 10 * 60_000,
        runtime: piCliRuntime({ bin: piBin }),
      },
      { cfg: benchConfig(""), ecosystem: ecosystemFor("none"), fingerprint: {} as never },
    );
    const invocations = readFileSync(calls, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toMatch(/--continue/);
    expect(invocations[1]).toMatch(/You stopped before the BENCHMARK MODE files were complete/);
    expect(s.continued).toBe(true);
    expect(s.status).not.toBe("no-output");
  });
});

describe("a round that renders nothing: the session's own comments are a scorer input", () => {
  it("an unreadable comments.json gets the one continuation, and a no-output that names it", async () => {
    const c = mkCase(B1);
    const cstore = join(tmp, "store-comments");
    execFileSync("git", ["clone", "--quiet", "--bare", join(tmp, "work"), storeDir(cstore, c)]);
    const root = join(tmp, "root-comments");
    mkdirSync(root);
    for (const e of readdirSync(ROOT))
      if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
    const outDir = join(tmp, "out-comments");
    const calls = join(tmp, "pi-calls-comments.log");
    const piBin = join(tmp, "fake-pi-comments");
    writeFileSync(
      piBin,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        `echo "$*" >> ${JSON.stringify(calls)}`,
        'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
        'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
        `printf '%s' '[{\\"path\\": \\"b.ts\\"}]' > "$cd/comments.json"`,
        `printf '%s' '{"verdict": "REQUEST_CHANGES", "passes": []}' > "$cd/outcome.json"`,
        "",
      ].join("\n"),
    );
    chmodSync(piBin, 0o755);
    const cfg = benchConfig("");
    cfg.review.render_outputs = false;
    const s = await reviewCase(
      c,
      metaFor(c),
      {
        root,
        store: cstore,
        outDir,
        agentDir: join(tmp, "agent"),
        timeoutMs: 10 * 60_000,
        runtime: piCliRuntime({ bin: piBin }),
      },
      { cfg, ecosystem: ecosystemFor("none"), fingerprint: {} as never },
    );
    const invocations = readFileSync(calls, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toMatch(/comments\.json is not valid JSON/);
    expect(s.status).toBe("no-output");
    expect(s.error).toMatch(/comments\.json is not valid JSON/);
  });
});

describe("the changed files' hunks", () => {
  it("a renamed file with one edited line gets that hunk, not the whole file as added", async () => {
    const repo = join(tmp, "rename");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repo, "old.ts"), lines.join("\n") + "\n");
    git(repo, "add", "old.ts");
    git(repo, "commit", "--quiet", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "mv", "old.ts", "new.ts");
    lines[14] = "line 15 changed";
    writeFileSync(join(repo, "new.ts"), lines.join("\n") + "\n");
    git(repo, "add", "new.ts");
    git(repo, "commit", "--quiet", "-m", "rename");
    const head = git(repo, "rev-parse", "HEAD");
    const files = await changedFiles(repo, {
      merge_base: base,
      head_commit: head,
    } as PrefetchMeta);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: "new.ts", previous_filename: "old.ts" });
    const patch = files[0]!.patch!;
    expect(patch).toContain("-line 15\n+line 15 changed");
    expect(patch).not.toContain("+line 1\n");
  });
});
