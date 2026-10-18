// `qcr review` on the current branch, in the terminal (src/reviewcli.ts).
// A real throwaway git repo is the branch fixture; pi is a fake shell script
// (no network, no model, no docker, no GitHub).

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

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { runReviewCli, parseReviewArgs, REVIEW_USAGE, reviewHelp } =
  await import("../src/reviewcli.js");
const { contextFor } = await import("../src/bench/runner.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-cli-"));
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

/** main with one file, `feature` adding two lines to it. */
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
  git(repo, "commit", "-q", "-am", "add b and c");
  return repo;
}

function mkRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

const findings = [
  {
    path: "src/a.ts",
    line: 2,
    severity: "P2",
    title: "b is a magic number",
    disposition: "posted",
  },
  { path: "src/a.ts", line: 3, severity: "P0", title: "c breaks the build", disposition: "posted" },
  { path: "src/a.ts", line: 3, severity: "P1", title: "killed one", disposition: "killed" },
];
const record = JSON.stringify({ findings, verdict: "REQUEST_CHANGES" });
const outcome = JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] });

function fakePi(name: string, script: string[]): { bin: string; calls: string } {
  const calls = join(tmp, `${name}.calls`);
  const bin = join(tmp, `${name}-pi`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      ...script,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, calls };
}

const happyPi = (name: string, cost = 0.25) =>
  fakePi(name, [
    `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":${cost}}}}}'`,
    `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
    `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
  ]);

let root: string;
let ctx: ReturnType<typeof contextFor>;
beforeAll(() => {
  root = mkRoot("root");
  ctx = contextFor(root, "");
});

function harness(o: {
  repo: string;
  piBin: string;
  confirm?: ((q: string) => Promise<boolean>) | null;
}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const deps = {
    cwd: o.repo,
    out: (l: string) => lines.push(l),
    confirm:
      o.confirm === null
        ? null
        : async (q: string) => {
            asked.push(q);
            return o.confirm ? o.confirm(q) : false;
          },
    root,
    agentDir: join(tmp, "agent"),
    cfg: ctx.cfg,
    ecosystem: ctx.ecosystem,
    piBin: o.piBin,
    runsDir: join(tmp, `runs-${Math.random().toString(36).slice(2)}`),
    timeoutMs: 10 * 60_000,
  };
  return { deps, lines, asked, text: () => lines.join("\n") };
}

/** The repo's settings: the limit the review runs under without asking. */
function setLimit(repo: string, limit: number, extra: Record<string, number> = {}): void {
  writeFileSync(
    join(repo, ".git", "qcr-review.json"),
    JSON.stringify({ auto_limit_usd: limit, ...extra }),
  );
}

describe("qcr review: usage", () => {
  it("is in the CLI usage and --help describes the targets", async () => {
    expect(REVIEW_USAGE).toMatch(/^usage: qcr review/);
    const cliSrc = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
    expect(cliSrc).toMatch(/\|review \[/);
    const h = harness({ repo: mkRepo("help"), piBin: "false" });
    const code = await runReviewCli(["--help"], false, h.deps);
    expect(code).toBe(0);
    expect(h.text()).toBe(reviewHelp());
    expect(h.text()).toMatch(/current branch/i);
    expect(h.text()).toMatch(/pull request|PR/);
    expect(h.text()).toMatch(/uncommitted|working tree/i);
  });

  it("refuses an unknown flag and targets this build cannot review, with exit 2", async () => {
    for (const rest of [
      ["--bogus"],
      ["123"],
      ["https://github.com/o/r/pull/3"],
      ["--uncommitted"],
    ]) {
      expect(() => parseReviewArgs(rest), rest.join(" ")).toThrow(/usage: qcr review/);
    }
    const h = harness({ repo: mkRepo("badarg"), piBin: "false" });
    expect(await runReviewCli(["--bogus"], false, h.deps)).toBe(2);
  });
});

describe("qcr review: the preview and the price", () => {
  it("--preview shows the plan, the price and the key, and starts nothing", async () => {
    const repo = mkRepo("preview");
    const pi = happyPi("preview");
    const h = harness({ repo, piBin: pi.bin });
    const code = await runReviewCli(["--preview"], false, h.deps);
    expect(code).toBe(0);
    expect(h.text()).toMatch(/feature/);
    expect(h.text()).toMatch(/against main/);
    expect(h.text()).toMatch(/1 file/);
    expect(h.text()).toMatch(/lenses?:/i);
    expect(h.text()).toMatch(/price: \$\d+\.\d{2}/);
    expect(h.text()).toMatch(/key: [0-9a-f]{16}/);
    expect(existsSync(pi.calls)).toBe(false);
  });

  it("--json --preview is one object with the plan, price and key", async () => {
    const h = harness({ repo: mkRepo("previewjson"), piBin: "false" });
    expect(await runReviewCli(["--preview"], true, h.deps)).toBe(0);
    expect(h.lines).toHaveLength(1);
    const o = JSON.parse(h.lines[0]!);
    expect(o.ok).toBe(true);
    expect(o.preview.lenses.length).toBeGreaterThan(0);
    expect(o.preview.estimate_usd).toBeGreaterThan(0);
    expect(o.preview.key).toMatch(/^[0-9a-f]{16}$/);
    expect(o.preview.base).toBe("main");
  });

  it("a branch with nothing against its base is refused, exit 1", async () => {
    const repo = mkRepo("empty");
    git(repo, "checkout", "-q", "main");
    const h = harness({ repo, piBin: "false" });
    expect(await runReviewCli([], false, h.deps)).toBe(1);
    expect(h.text()).toMatch(/nothing to review/i);
  });

  it("a directory that is not a git repo is refused, exit 1", async () => {
    const dir = join(tmp, "notgit");
    mkdirSync(dir);
    const h = harness({ repo: dir, piBin: "false" });
    expect(await runReviewCli([], false, h.deps)).toBe(1);
    expect(h.text()).toMatch(/not a git repository/i);
  });
});

describe("qcr review: under and over the limit", () => {
  it("under the repo's limit it starts without asking and prints findings grouped by severity", async () => {
    const repo = mkRepo("under");
    setLimit(repo, 1000);
    const pi = happyPi("under");
    const h = harness({ repo, piBin: pi.bin });
    const code = await runReviewCli([], false, h.deps);
    expect(code).toBe(0);
    expect(h.asked).toHaveLength(0);
    expect(readFileSync(pi.calls, "utf8").trim().split("\n")).toHaveLength(1);
    const t = h.text();
    expect(t.indexOf("P0")).toBeGreaterThan(-1);
    expect(t.indexOf("P0")).toBeLessThan(t.indexOf("P2"));
    expect(t).toMatch(/c breaks the build/);
    expect(t).toMatch(/src\/a\.ts:3/);
    expect(t).toMatch(/b is a magic number/);
    expect(t).not.toMatch(/killed one/);
    expect(t).not.toMatch(/partial/i);
  });

  it("--json prints findings grouped by severity in one object", async () => {
    const repo = mkRepo("underjson");
    setLimit(repo, 1000);
    const h = harness({ repo, piBin: happyPi("underjson").bin });
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    expect(h.lines).toHaveLength(1);
    const o = JSON.parse(h.lines[0]!);
    expect(o.ok).toBe(true);
    expect(o.partial).toBe(false);
    expect(Object.keys(o.findings)).toEqual(["P0", "P2"]);
    expect(o.findings.P0[0]).toMatchObject({ path: "src/a.ts", line: 3 });
    expect(o.cost_usd).toBeCloseTo(0.25);
  });

  it("over the limit it asks, and refuses on no without running pi", async () => {
    const repo = mkRepo("over-no");
    setLimit(repo, 0.0001);
    const pi = happyPi("over-no");
    const h = harness({ repo, piBin: pi.bin, confirm: async () => false });
    const code = await runReviewCli([], false, h.deps);
    expect(code).toBe(1);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatch(/\$\d+\.\d{2}/);
    expect(h.text()).toMatch(/declined/i);
    expect(existsSync(pi.calls)).toBe(false);
  });

  it("over the limit, a yes runs the review", async () => {
    const repo = mkRepo("over-yes");
    setLimit(repo, 0.0001);
    const pi = happyPi("over-yes");
    const h = harness({ repo, piBin: pi.bin, confirm: async () => true });
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    expect(h.asked).toHaveLength(1);
    expect(existsSync(pi.calls)).toBe(true);
    expect(h.text()).toMatch(/c breaks the build/);
  });

  it("over the limit with no terminal, it refuses and names the key to quote", async () => {
    const repo = mkRepo("over-tty");
    setLimit(repo, 0.0001);
    const pi = happyPi("over-tty");
    const h = harness({ repo, piBin: pi.bin, confirm: null });
    expect(await runReviewCli([], false, h.deps)).toBe(1);
    expect(h.text()).toMatch(/--key [0-9a-f]{16}/);
    expect(existsSync(pi.calls)).toBe(false);
  });

  it("over the limit, quoting the previewed key runs; a stale key is refused", async () => {
    const repo = mkRepo("over-key");
    setLimit(repo, 0.0001);
    const pre = harness({ repo, piBin: "false", confirm: null });
    await runReviewCli(["--preview"], true, pre.deps);
    const key = JSON.parse(pre.lines[0]!).preview.key as string;

    const stale = harness({ repo, piBin: happyPi("stale").bin, confirm: null });
    expect(await runReviewCli(["--key", "0".repeat(16)], false, stale.deps)).toBe(1);
    expect(stale.text()).toMatch(/changed|stale|does not match/i);

    const pi = happyPi("over-key");
    const ok = harness({ repo, piBin: pi.bin, confirm: null });
    expect(await runReviewCli(["--key", key], false, ok.deps)).toBe(0);
    expect(existsSync(pi.calls)).toBe(true);
  });

  it("the key moves when the branch moves", async () => {
    const repo = mkRepo("keymove");
    const a = harness({ repo, piBin: "false" });
    await runReviewCli(["--preview"], true, a.deps);
    writeFileSync(join(repo, "src", "a.ts"), "export const z = 9;\n".repeat(40));
    git(repo, "commit", "-q", "-am", "more");
    const b = harness({ repo, piBin: "false" });
    await runReviewCli(["--preview"], true, b.deps);
    expect(JSON.parse(b.lines[0]!).preview.key).not.toBe(JSON.parse(a.lines[0]!).preview.key);
  });
});

describe("qcr review: the hard stop", () => {
  it("a run that reaches the price shown stops and reports partial coverage", async () => {
    const repo = mkRepo("capped");
    setLimit(repo, 1000);
    const pi = fakePi("capped", [
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":9999}}}}'`,
      "sleep 60",
    ]);
    const h = harness({ repo, piBin: pi.bin });
    const t0 = Date.now();
    const code = await runReviewCli([], false, h.deps);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(code).toBe(1);
    expect(h.text()).toMatch(/stopped at the price/i);
    expect(h.text()).toMatch(/partial coverage/i);
    expect(readFileSync(pi.calls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("--json says partial and lists the lenses not reached", async () => {
    const repo = mkRepo("cappedjson");
    setLimit(repo, 1000);
    const pi = fakePi("cappedjson", [
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":9999}}}}'`,
      "sleep 60",
    ]);
    const h = harness({ repo, piBin: pi.bin });
    expect(await runReviewCli([], true, h.deps)).toBe(1);
    const o = JSON.parse(h.lines[0]!);
    expect(o.ok).toBe(false);
    expect(o.partial).toBe(true);
    expect(o.coverage.planned.length).toBeGreaterThan(0);
    expect(o.coverage.not_reached.length).toBeGreaterThan(0);
  });
});

describe("qcr review: the throwaway tree", () => {
  it("never leaves a worktree behind in the reviewed repo", async () => {
    const repo = mkRepo("tidy");
    setLimit(repo, 1000);
    const h = harness({ repo, piBin: happyPi("tidy").bin });
    await runReviewCli([], false, h.deps);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

describe("qcr review: memory when set up", () => {
  const memStub = (text: string) => ({
    assembler: {
      pinnedHead: async () => ({ status: "read" as const, text: "PINNED-HEAD-MARK" }),
      contextBlock: async () => ({ status: "read" as const, text }),
    },
  });

  it("seeds the review prompt from a configured memory, with no notice", async () => {
    const repo = mkRepo("memseed");
    setLimit(repo, 1000);
    const h = harness({ repo, piBin: happyPi("memseed").bin });
    expect(await runReviewCli([], true, { ...h.deps, memory: memStub("CONTEXT-BLOCK-MARK") })).toBe(
      0,
    );
    const o = JSON.parse(h.lines[0]!);
    const order = readFileSync(join(o.out_dir, "round-order.md"), "utf8");
    expect(order).toContain("PINNED-HEAD-MARK");
    expect(order).toContain("CONTEXT-BLOCK-MARK");
    expect(o.memory).toEqual({ used: true, notice: null });
  });

  it("without memory the review runs clean and says so once", async () => {
    const repo = mkRepo("memnone");
    setLimit(repo, 1000);
    const h = harness({ repo, piBin: happyPi("memnone").bin });
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    expect(h.lines.filter((l) => /^memory:/.test(l))).toHaveLength(1);
    expect(h.text()).not.toMatch(/✗|error/i);
  });

  it("an unreachable memory never fails the review and is told once", async () => {
    const repo = mkRepo("memdown");
    setLimit(repo, 1000);
    const hang = new Promise<never>(() => {});
    const h = harness({ repo, piBin: happyPi("memdown").bin });
    const t0 = Date.now();
    const code = await runReviewCli([], false, {
      ...h.deps,
      memory: { assembler: { pinnedHead: () => hang, contextBlock: () => hang }, timeoutMs: 100 },
    });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(h.lines.filter((l) => /^memory:/.test(l))).toHaveLength(1);
    expect(h.text()).toMatch(/c breaks the build/);
  });
});
