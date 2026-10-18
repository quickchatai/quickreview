// `qcr review` on the current branch, in the terminal (src/reviewcli.ts).
// A real throwaway git repo is the branch fixture; pi is a fake shell script
// (no network, no model, no docker, no GitHub).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshStateHomePerTest } from "./helpers/fresh-state-home.js";
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

freshStateHomePerTest();

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
  route?: "laptop" | "action";
}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const deps = {
    cwd: o.repo,
    ...(o.route !== undefined ? { route: o.route } : {}),
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

  it("refuses an unknown flag and arguments that do not fit, with exit 2", async () => {
    for (const rest of [
      ["--bogus"],
      ["--uncommitted", "12"],
      ["--repo", "o/r"],
      ["12", "--base", "main"],
      ["12", "13"],
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
    const t = h.lines.filter((l) => !l.startsWith("{")).join("\n");
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
    expect(h.text()).toMatch(/stopped at the cap/i);
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

describe("qcr review: the estimate and the Action route", () => {
  const spendPi = (name: string) =>
    fakePi(name, [
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":9999}}}}'`,
      `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
    ]);

  it("the laptop's estimate is a few dollars at most for a small branch, and its hard stop is twice that", async () => {
    const h = harness({ repo: mkRepo("est-laptop"), piBin: "false" });
    expect(await runReviewCli(["--preview"], true, h.deps)).toBe(0);
    const p = JSON.parse(h.lines[0]!).preview;
    expect(p.estimate_usd).toBeGreaterThan(0.1);
    expect(p.estimate_usd).toBeLessThan(5);
    expect(p.cap_usd).toBeCloseTo(p.estimate_usd * 2, 1);
    expect(p.limit_usd).toBe(2);
  });

  it("the laptop still asks above its limit, quoting the refit estimate", async () => {
    const repo = mkRepo("est-ask");
    setLimit(repo, 0.01);
    const h = harness({ repo, piBin: happyPi("est-ask").bin, confirm: async () => true });
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    expect(h.asked).toHaveLength(1);
    // a fresh copy of the branch: the run above left state, so a preview of it is no plan
    const pre = harness({ repo: mkRepo("est-ask-fresh"), piBin: "false" });
    await runReviewCli(["--preview"], true, pre.deps);
    const est = (JSON.parse(pre.lines[0]!).preview.estimate_usd as number).toFixed(2);
    expect(h.asked[0]).toContain(`$${est}`);
  });

  it("the Action sets no cap and asks nothing without --limit", async () => {
    const repo = mkRepo("action-nocap");
    setLimit(repo, 0.0001); // the repo's own limit is a laptop thing: ignored here
    const pi = spendPi("action-nocap");
    const h = harness({ repo, piBin: pi.bin, confirm: null, route: "action" });
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    const o = JSON.parse(h.lines[0]!);
    expect(o.ok).toBe(true);
    expect(o.partial).toBe(false);
    expect(o.cost_usd).toBe(9999);

    const pre = harness({
      repo: mkRepo("action-nocap-fresh"),
      piBin: "false",
      confirm: null,
      route: "action",
    });
    await runReviewCli(["--preview"], true, pre.deps);
    const p = JSON.parse(pre.lines[0]!).preview;
    expect(p.cap_usd).toBeNull();
    expect(p.limit_usd).toBeNull();
    expect(p.auto).toBe(true);
    expect(p.estimate_usd).toBeGreaterThan(0);
  });

  it("the Action stops hard at a --limit, and only there", async () => {
    const repo = mkRepo("action-limit");
    const pi = spendPi("action-limit");
    const h = harness({ repo, piBin: pi.bin, confirm: null, route: "action" });
    expect(await runReviewCli(["--limit", "3"], true, h.deps)).toBe(1);
    const o = JSON.parse(h.lines[0]!);
    expect(o.partial).toBe(true);
    const pre = harness({ repo, piBin: "false", confirm: null, route: "action" });
    await runReviewCli(["--preview", "--limit", "3"], true, pre.deps);
    expect(JSON.parse(pre.lines[0]!).preview).toMatchObject({
      cap_usd: 3,
      limit_usd: 3,
      auto: true,
    });
  });

  it("the route comes from QCR_ROUTE or GITHUB_ACTIONS", async () => {
    const { routeFromEnv } = await import("../src/reviewcli.js");
    expect(routeFromEnv({})).toBe("laptop");
    expect(routeFromEnv({ QCR_ROUTE: "action" })).toBe("action");
    expect(routeFromEnv({ GITHUB_ACTIONS: "true" })).toBe("action");
    expect(routeFromEnv({ GITHUB_ACTIONS: "false" })).toBe("laptop");
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

describe("qcr review --uncommitted", () => {
  /** feature branch, then: a staged edit, an unstaged edit, a new file. */
  function dirtyRepo(name: string): string {
    const repo = mkRepo(name);
    writeFileSync(join(repo, "src", "b.ts"), "export const s = 1;\n");
    git(repo, "add", "src/b.ts");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const u = 9;\n");
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 0;\n");
    return repo;
  }

  it("reviews only the uncommitted edits: staged, unstaged and new, not the branch's commits", async () => {
    const repo = dirtyRepo("unc-set");
    const h = harness({ repo, piBin: "false" });
    expect(await runReviewCli(["--uncommitted", "--preview"], true, h.deps)).toBe(0);
    const o = JSON.parse(h.lines[0]!);
    expect(o.preview.target).toBe("uncommitted");
    expect(o.preview.base).toBe("HEAD");
    // a.ts (unstaged), b.ts (staged), new.ts (untracked); c.ts-style commits excluded
    expect(o.preview.files).toBe(3);
    // a.ts: -2 lines +1 vs HEAD's three-line file, b.ts +1, new.ts +1
    expect(o.preview.lines).toBe(2 + 1 + 1 + 1);
  });

  it("leaves the person's index and files exactly as they were", async () => {
    const repo = dirtyRepo("unc-untouched");
    const before = git(repo, "status", "--porcelain");
    const h = harness({ repo, piBin: "false" });
    await runReviewCli(["--uncommitted", "--preview"], false, h.deps);
    expect(git(repo, "status", "--porcelain")).toBe(before);
    expect(before).toMatch(/A {2}src\/b\.ts/);
    expect(before).toMatch(/\?\? src\/new\.ts/);
  });

  it("the review tree holds HEAD plus the edits, and is cleaned up", async () => {
    const repo = dirtyRepo("unc-tree");
    setLimit(repo, 1000);
    const seen = join(tmp, "unc-tree.seen");
    const pi = fakePi("unc-tree", [
      `cat "$QCR_WORKTREE/src/a.ts" "$QCR_WORKTREE/src/b.ts" "$QCR_WORKTREE/src/new.ts" > ${JSON.stringify(seen)}`,
      `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
    ]);
    const h = harness({ repo, piBin: pi.bin });
    expect(await runReviewCli(["--uncommitted"], false, h.deps)).toBe(0);
    const text = readFileSync(seen, "utf8");
    expect(text).toContain("export const u = 9;");
    expect(text).toContain("export const s = 1;");
    expect(text).toContain("export const n = 0;");
    expect(text).not.toContain("export const b = 2;");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("a clean tree exits with a clear message and spends nothing", async () => {
    const repo = mkRepo("unc-clean");
    const pi = happyPi("unc-clean");
    const h = harness({ repo, piBin: pi.bin });
    expect(await runReviewCli(["--uncommitted"], false, h.deps)).toBe(1);
    expect(h.text()).toMatch(/nothing to review.*no uncommitted changes/i);
    expect(existsSync(pi.calls)).toBe(false);
    expect(h.asked).toHaveLength(0);
  });

  it("posting is never offered: not postable, nothing asked about posting", async () => {
    const repo = dirtyRepo("unc-nopost");
    setLimit(repo, 1000);
    const h = harness({ repo, piBin: happyPi("unc-nopost").bin });
    expect(await runReviewCli(["--uncommitted"], true, h.deps)).toBe(0);
    const o = JSON.parse(h.lines[0]!);
    expect(o.preview.postable).toBe(false);
    expect(h.asked).toHaveLength(0);
    expect(h.lines.join("\n")).not.toMatch(/post (to|it)|--post/i);
    expect(reviewHelp()).not.toMatch(/--post\b/);
  });

  it("runs under the same price, key and hard stop; the key moves with the edits", async () => {
    const repo = dirtyRepo("unc-key");
    const a = harness({ repo, piBin: "false" });
    await runReviewCli(["--uncommitted", "--preview"], true, a.deps);
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
    const b = harness({ repo, piBin: "false" });
    await runReviewCli(["--uncommitted", "--preview"], true, b.deps);
    expect(JSON.parse(b.lines[0]!).preview.key).not.toBe(JSON.parse(a.lines[0]!).preview.key);

    const capRepo = dirtyRepo("unc-cap");
    setLimit(capRepo, 1000);
    const pi = fakePi("unc-cap", [
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":9999}}}}'`,
      "sleep 60",
    ]);
    const c = harness({ repo: capRepo, piBin: pi.bin });
    expect(await runReviewCli(["--uncommitted"], false, c.deps)).toBe(1);
    expect(c.text()).toMatch(/stopped at the cap/i);
  });

  it("refuses --uncommitted with --base or with branch, exit 2", async () => {
    expect(() => parseReviewArgs(["--uncommitted", "--base", "main"])).toThrow(/usage: qcr review/);
    expect(() => parseReviewArgs(["--uncommitted", "branch"])).toThrow(/usage: qcr review/);
  });
});

describe("qcr review <PR>", () => {
  // A "GitHub": a bare o/r.git holding main and pull/7/head, plus a stub API.
  const gh = join(tmp, "gh-host");
  const work = join(tmp, "gh-work");
  mkdirSync(join(gh, "o"), { recursive: true });
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.ts"), "export const a = 1;\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  const baseSha = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "feat");
  writeFileSync(join(work, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(work, "commit", "-q", "-am", "feat");
  const headSha = git(work, "rev-parse", "HEAD");
  git(gh, "init", "-q", "--bare", join(gh, "o", "r.git"));
  git(work, "push", "-q", join(gh, "o", "r.git"), "main:refs/heads/main", "feat:refs/pull/7/head");

  const seen: Array<string | null> = [];
  const api = (async (_u: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return new Response(
      JSON.stringify({
        title: "Add b",
        body: null,
        head: { sha: headSha },
        base: { ref: "main", sha: baseSha },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  /** A cwd repo whose origin is o/r. */
  function cwdRepo(name: string, origin = "https://github.com/o/r.git"): string {
    const repo = mkRepo(name);
    git(repo, "remote", "add", "origin", origin);
    return repo;
  }
  function prHarness(repo: string, piBin: string, pr: object) {
    const h = harness({ repo, piBin });
    return { ...h, deps: { ...h.deps, pr: { fetchFn: api, gitBase: gh, ...pr } } };
  }

  it("reviews a PR by number: fetched into a scratch tree, priced, run and cleaned up", async () => {
    const repo = cwdRepo("pr-number");
    setLimit(repo, 1000);
    const pi = happyPi("pr-number");
    const h = prHarness(repo, pi.bin, { env: { GITHUB_TOKEN: "tok" }, ghAuthToken: () => null });
    expect(await runReviewCli(["7"], false, h.deps)).toBe(0);
    expect(seen.at(-1)).toBe("Bearer tok");
    expect(h.text()).toMatch(/Review PR #7 against main \(o\/r\)/);
    expect(h.text()).toMatch(/GitHub credential: GITHUB_TOKEN/);
    expect(h.text()).toMatch(/c breaks the build/);
    expect(git(repo, "worktree", "list")).not.toMatch(/tree/);
    const left = readdirSync(h.deps.runsDir).flatMap((r) => readdirSync(join(h.deps.runsDir, r)));
    expect(left).not.toContain("repo");
  });

  /** The stub API, with the PR's review comments answered by `comments`. */
  const withComments = (comments: () => Response): typeof fetch =>
    (async (u: string | URL | Request, init?: RequestInit) =>
      String(u).includes("/pulls/7/comments") ? comments() : api(u, init)) as typeof fetch;
  const botComment = {
    path: "src/a.ts",
    line: 2,
    body: "**b is a magic number**\n\n<!-- qcr:f=1:f1 -->",
  };

  it("skips the findings the bot already posted on the PR, in every destination", async () => {
    const repo = cwdRepo("pr-skip");
    setLimit(repo, 1000);
    const h = prHarness(repo, happyPi("pr-skip").bin, {
      env: { GITHUB_TOKEN: "tok" },
      ghAuthToken: () => null,
      fetchFn: withComments(() => new Response(JSON.stringify([botComment]), { status: 200 })),
    });
    expect(await runReviewCli(["7"], true, h.deps)).toBe(0);
    const done = JSON.parse(h.lines.at(-1)!);
    const titles = Object.values(done.findings as Record<string, Array<{ title: string }>>)
      .flat()
      .map((f) => f.title);
    expect(titles).toEqual(["c breaks the build"]);
    expect(done.already_posted_skipped).toBe(1);
  });

  it("a PR with no bot comments is unaffected", async () => {
    const repo = cwdRepo("pr-noskip");
    setLimit(repo, 1000);
    const h = prHarness(repo, happyPi("pr-noskip").bin, {
      env: { GITHUB_TOKEN: "tok" },
      ghAuthToken: () => null,
      fetchFn: withComments(() => new Response("[]", { status: 200 })),
    });
    expect(await runReviewCli(["7"], true, h.deps)).toBe(0);
    const done = JSON.parse(h.lines.at(-1)!);
    expect(Object.values(done.findings).flat()).toHaveLength(2);
    expect(done.already_posted_skipped).toBe(0);
    expect(done.warnings.join("\n")).not.toMatch(/posted findings/);
  });

  it("a failure to read the comments warns and the review continues", async () => {
    const repo = cwdRepo("pr-skipfail");
    setLimit(repo, 1000);
    const h = prHarness(repo, happyPi("pr-skipfail").bin, {
      env: { GITHUB_TOKEN: "tok" },
      ghAuthToken: () => null,
      fetchFn: withComments(() => new Response("nope", { status: 500 })),
    });
    expect(await runReviewCli(["7"], true, h.deps)).toBe(0);
    const done = JSON.parse(h.lines.at(-1)!);
    expect(Object.values(done.findings).flat()).toHaveLength(2);
    expect(done.warnings.join("\n")).toMatch(/posted findings.*500/);
  });

  it("reviews a PR by URL, and --preview starts nothing", async () => {
    const repo = cwdRepo("pr-url");
    const pi = happyPi("pr-url");
    const h = prHarness(repo, pi.bin, { env: {}, ghAuthToken: () => "cli" });
    expect(await runReviewCli(["https://github.com/o/r/pull/7", "--preview"], true, h.deps)).toBe(
      0,
    );
    const o = JSON.parse(h.lines[0]!);
    expect(o.preview).toMatchObject({ pr: 7, head_sha: headSha, base: "main", credential: "gh" });
    expect(existsSync(pi.calls)).toBe(false);
  });

  it("refuses a PR on another repo unless --repo names it", async () => {
    const repo = cwdRepo("pr-other");
    const h = prHarness(repo, "false", { env: { GITHUB_TOKEN: "t" } });
    expect(await runReviewCli(["https://github.com/o/other/pull/7"], false, h.deps)).toBe(1);
    expect(h.text()).toMatch(/--repo o\/other/);
  });

  it("a missing credential is refused with the way to get one", async () => {
    const repo = cwdRepo("pr-nocred");
    const h = prHarness(repo, "false", { env: {}, ghAuthToken: () => null });
    expect(await runReviewCli(["7"], false, h.deps)).toBe(1);
    expect(h.text()).toMatch(/gh auth login/);
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
