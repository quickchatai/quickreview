// `qcr review` re-reviews (src/reviewcli.ts + src/reviewstate.ts): local state
// per target gives a delta review with no repeated findings. A real throwaway
// git repo is the branch fixture; pi is a fake shell script (no network, no
// model, no docker, no GitHub).

import { afterAll, describe, expect, it, vi } from "vitest";
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

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { runReviewCli } = await import("../src/reviewcli.js");
const { contextFor } = await import("../src/bench/runner.js");
const state = await import("../src/reviewstate.js");
const { openReviewStore } = await import("../src/reviewstore.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-delta-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const body = (n: number): string =>
  Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";

/** main with one file; `feature` adds a 40-line file and a 2-line change. */
function mkRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(
    join(repo, "src", "a.ts"),
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  writeFileSync(join(repo, "src", "big.ts"), body(40));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature");
  return repo;
}

/** A small push: one more line in big.ts. */
function smallPush(repo: string, n = 1): void {
  writeFileSync(join(repo, "src", "big.ts"), body(40 + n));
  git(repo, "commit", "-q", "-am", `push ${n}`);
}

function mkRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

const f = (id: string, path: string, line: number, severity: string, title: string) => ({
  id,
  lens: "pass-baseline",
  path,
  line,
  severity,
  title,
  posted_as: severity === "P0" ? "blocker" : "question",
  disposition: "posted",
});

/** pi that writes the Nth record on its Nth call and keeps each call's stdin. */
function scriptedPi(name: string, runs: Array<{ findings: unknown[]; prior?: unknown[] }>) {
  const dir = join(tmp, `${name}-pi`);
  mkdirSync(dir);
  runs.forEach((r, i) =>
    writeFileSync(
      join(dir, `record-${i + 1}.json`),
      JSON.stringify({ findings: r.findings, ...(r.prior ? { prior: r.prior } : {}) }),
    ),
  );
  writeFileSync(
    join(dir, "outcome.json"),
    JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] }),
  );
  const bin = join(dir, "pi");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `D=${JSON.stringify(dir)}`,
      'n=$(cat "$D/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/count"',
      'cat > "$D/stdin-$n"',
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":0.25}}}}'`,
      'cp "$D/record-$n.json" "$cd/findings-record.json"',
      'cp "$D/outcome.json" "$cd/outcome.json"',
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: (): number =>
      existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8")) : 0,
    order: (n: number): string => readFileSync(join(dir, `stdin-${n}`), "utf8"),
  };
}

const root = mkRoot("root");
const ctx = contextFor(root, "");

function harness(repo: string, piBin: string) {
  const lines: string[] = [];
  const deps = {
    cwd: repo,
    out: (l: string) => lines.push(l),
    confirm: null,
    root,
    agentDir: join(tmp, "agent"),
    cfg: ctx.cfg,
    ecosystem: ctx.ecosystem,
    piBin,
    runsDir: join(tmp, `runs-${Math.random().toString(36).slice(2)}`),
    timeoutMs: 10 * 60_000,
  };
  return { deps, lines, text: () => lines.join("\n") };
}

function setLimit(repo: string): void {
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));
}

const first = [
  f("f1", "src/a.ts", 3, "P0", "c breaks the build"),
  f("f2", "src/a.ts", 2, "P2", "b is a magic number"),
];

describe("qcr review: a second run on an unchanged head", () => {
  it("spends nothing and says so", async () => {
    const repo = mkRepo("unchanged");
    setLimit(repo);
    const pi = scriptedPi("unchanged", [{ findings: first }]);
    expect(await runReviewCli([], false, harness(repo, pi.bin).deps)).toBe(0);
    expect(pi.calls()).toBe(1);

    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    expect(pi.calls()).toBe(1);
    expect(h.text()).toMatch(/nothing new/i);
    expect(h.text()).toMatch(/\$0\.00/);
    // the findings it already reported stay listed as open, not as new
    expect(h.text()).toMatch(/still open/i);
    expect(h.text()).toMatch(/c breaks the build/);
  });

  it("--json says unchanged, with zero cost", async () => {
    const repo = mkRepo("unchangedjson");
    setLimit(repo);
    const pi = scriptedPi("unchangedjson", [{ findings: first }]);
    await runReviewCli([], true, harness(repo, pi.bin).deps);
    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    const o = JSON.parse(h.lines[0]!);
    expect(o).toMatchObject({ ok: true, unchanged: true, cost_usd: 0 });
    expect(o.still_open).toHaveLength(2);
    expect(pi.calls()).toBe(1);
  });

  it("--preview on an unchanged head also starts nothing and says so", async () => {
    const repo = mkRepo("unchangedpreview");
    setLimit(repo);
    const pi = scriptedPi("unchangedpreview", [{ findings: first }]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    const h = harness(repo, pi.bin);
    expect(await runReviewCli(["--preview"], false, h.deps)).toBe(0);
    expect(h.text()).toMatch(/nothing new/i);
    expect(pi.calls()).toBe(1);
  });

  it("--full reviews again anyway", async () => {
    const repo = mkRepo("fullflag");
    setLimit(repo);
    const pi = scriptedPi("fullflag", [{ findings: first }, { findings: first }]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    const h = harness(repo, pi.bin);
    expect(await runReviewCli(["--full"], false, h.deps)).toBe(0);
    expect(pi.calls()).toBe(2);
    expect(pi.order(2)).not.toMatch(/PRIOR FINDINGS TO VERIFY/);
  });
});

describe("qcr review: a second run after a small push", () => {
  it("reviews only the delta, carries the open findings, and never repeats one", async () => {
    const repo = mkRepo("delta");
    setLimit(repo);
    const pi = scriptedPi("delta", [
      { findings: first },
      {
        findings: [
          // the model re-raises the still-open P0 under its own words, and finds one new thing
          f("g1", "src/a.ts", 3, "P0", "C breaks the build!"),
          f("g2", "src/big.ts", 41, "P1", "v40 is never used"),
        ],
        prior: [
          { ref: "1:f2", status: "fixed", evidence: "src/a.ts:2 now named" },
          { ref: "1:f1", status: "open", evidence: "still at src/a.ts:3" },
        ],
      },
    ]);
    expect(await runReviewCli([], false, harness(repo, pi.bin).deps)).toBe(0);
    const firstHead = git(repo, "rev-parse", "HEAD");
    smallPush(repo);

    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    expect(pi.calls()).toBe(2);
    const order = pi.order(2);
    // the production follow-up order: the delta and the prior findings to verify
    expect(order).toMatch(/PRIOR FINDINGS TO VERIFY/);
    expect(order).toContain("1:f1");
    expect(order).toContain(firstHead);
    expect(order).toMatch(/delta\.patch/);

    const o = JSON.parse(h.lines[0]!);
    expect(o.ok).toBe(true);
    expect(o.preview.scope).toBe("delta");
    expect(o.preview.since).toBe(firstHead);
    // only the delta's lines are priced
    expect(o.preview.lines).toBe(1);
    const newTitles = Object.values(o.findings as Record<string, Array<{ title: string }>>)
      .flat()
      .map((x) => x.title);
    expect(newTitles).toEqual(["v40 is never used"]);
    expect(o.still_open.map((x: { title: string }) => x.title)).toEqual(["c breaks the build"]);
    expect(o.repeats_suppressed).toBe(1);
  });

  it("a third run is a delta over the second, and a fixed finding is gone for good", async () => {
    const repo = mkRepo("delta3");
    setLimit(repo);
    const pi = scriptedPi("delta3", [
      { findings: first },
      { findings: [], prior: [{ ref: "1:f2", status: "fixed", evidence: "renamed" }] },
      { findings: [], prior: [] },
    ]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    smallPush(repo, 1);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    smallPush(repo, 2);
    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    expect(pi.calls()).toBe(3);
    const note = pi.order(3);
    expect(note).toContain("1:f1");
    expect(note).not.toContain("1:f2");
    const o = JSON.parse(h.lines[0]!);
    expect(o.still_open.map((x: { title: string }) => x.title)).toEqual(["c breaks the build"]);
  });

  it("an unfinished (capped or failed) review does not move the mark", async () => {
    const repo = mkRepo("nomark");
    setLimit(repo);
    const failing = join(tmp, "failing-pi");
    writeFileSync(failing, "#!/bin/sh\ncat >/dev/null\nexit 3\n");
    chmodSync(failing, 0o755);
    expect(await runReviewCli([], false, harness(repo, failing).deps)).toBe(1);
    const pi = scriptedPi("nomark", [{ findings: first }]);
    expect(await runReviewCli([], false, harness(repo, pi.bin).deps)).toBe(0);
    expect(pi.calls()).toBe(1);
  });
});

describe("qcr review: a push that changes none of the branch's own code", () => {
  it("a merge of the base alone spends nothing and says so", async () => {
    const repo = mkRepo("basemerge");
    setLimit(repo);
    const pi = scriptedPi("basemerge", [{ findings: first }, { findings: [] }]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moves");
    git(repo, "checkout", "-q", "feature");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    expect(pi.calls()).toBe(1);
    expect(h.text()).toMatch(/nothing new/i);
    // and the mark moved: the next run is unchanged
    const again = harness(repo, pi.bin);
    expect(await runReviewCli([], false, again.deps)).toBe(0);
    expect(again.text()).toMatch(/unchanged since/i);
  });
});

describe("qcr review: a doubtful delta is a full review", () => {
  async function secondRun(name: string, change: (repo: string) => void) {
    const repo = mkRepo(name);
    setLimit(repo);
    const pi = scriptedPi(name, [{ findings: first }, { findings: [] }]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    change(repo);
    const h = harness(repo, pi.bin);
    const code = await runReviewCli([], true, h.deps);
    return { code, pi, o: JSON.parse(h.lines[0]!) };
  }

  it("a history rewrite (amend) falls back to full, with the reason", async () => {
    const { code, pi, o } = await secondRun("amend", (repo) => {
      writeFileSync(join(repo, "src", "big.ts"), body(41));
      git(repo, "commit", "-q", "-a", "--amend", "-m", "feature, amended");
    });
    expect(code).toBe(0);
    expect(pi.calls()).toBe(2);
    expect(pi.order(2)).not.toMatch(/PRIOR FINDINGS TO VERIFY/);
    expect(o.preview.scope).toBe("full");
    expect(o.preview.fallback_reason).toBe("history-rewritten");
    expect(o.still_open).toEqual([]);
  });

  it("a rebase onto a moved base falls back to full", async () => {
    const { pi, o } = await secondRun("rebase", (repo) => {
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, "README.md"), "hi\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "main moves");
      git(repo, "checkout", "-q", "feature");
      git(repo, "rebase", "-q", "main");
    });
    expect(pi.calls()).toBe(2);
    expect(o.preview.scope).toBe("full");
    expect(o.preview.fallback_reason).toBe("history-rewritten");
  });

  it("a delta too large for a follow-up falls back to full", async () => {
    const { pi, o } = await secondRun("toolarge", (repo) => smallPush(repo, 100));
    expect(pi.calls()).toBe(2);
    expect(o.preview.scope).toBe("full");
    expect(o.preview.fallback_reason).toBe("delta-too-large");
  });

  it("a reviewed head that is gone from the repo falls back to full", async () => {
    const repo = mkRepo("gone");
    setLimit(repo);
    const pi = scriptedPi("gone", [{ findings: first }, { findings: [] }]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    const path = openReviewStore(repo)!.statePath(
      state.branchTargetKey(resolveRepo(repo), "feature"),
    );
    const s = JSON.parse(readFileSync(path!, "utf8"));
    s.rounds[s.rounds.length - 1].head_sha = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(path!, JSON.stringify(s));
    smallPush(repo);
    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    expect(pi.calls()).toBe(2);
    expect(JSON.parse(h.lines[0]!).preview.fallback_reason).toBe("history-rewritten");
  });

  it("unreadable state is no state: a full review, never a crash", async () => {
    const repo = mkRepo("corrupt");
    setLimit(repo);
    const pi = scriptedPi("corrupt", [{ findings: first }, { findings: first }]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    const path = openReviewStore(repo)!.statePath(
      state.branchTargetKey(resolveRepo(repo), "feature"),
    );
    writeFileSync(path!, "{ not json");
    smallPush(repo);
    expect(await runReviewCli([], false, harness(repo, pi.bin).deps)).toBe(0);
    expect(pi.calls()).toBe(2);
    expect(pi.order(2)).not.toMatch(/PRIOR FINDINGS TO VERIFY/);
  });
});

function resolveRepo(repo: string): string {
  return `local/${repo.split("/").pop()}`;
}

describe("review state", () => {
  it("is kept per target: another branch does not see it", async () => {
    const repo = mkRepo("pertarget");
    setLimit(repo);
    const pi = scriptedPi("pertarget", [{ findings: first }, { findings: first }]);
    await runReviewCli([], false, harness(repo, pi.bin).deps);
    git(repo, "checkout", "-q", "-b", "other");
    smallPush(repo);
    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    expect(pi.order(2)).not.toMatch(/PRIOR FINDINGS TO VERIFY/);
    expect(state.branchTargetKey("o/r", "a")).not.toBe(state.branchTargetKey("o/r", "b"));
    expect(state.branchTargetKey("o/r", "a")).not.toBe(state.branchTargetKey("p/r", "a"));
  });
});
