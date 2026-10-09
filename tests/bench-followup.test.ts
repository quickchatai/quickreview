// slice F: the bench's follow-up replay case kind (src/bench/
// followup.ts). A recorded round k of a PR is replayed offline: the store
// holds base, the previous round's head and the head (from a local mirror,
// mirror-only), the replay tree gets refs/bench/prev-head, the delta is
// production's `WorktreeManager.prOwnedDelta`, and the order is built from the
// same pieces dispatch builds a follow-up round from. Git is the thing under
// test here (scratch repos, local transport only).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");

const ROOT = resolve(import.meta.dirname, "..");
const LIVE = join(ROOT, "tests", "fixtures", "config.toml");
vi.stubEnv("QCR_CONFIG", LIVE);

const {
  benchAppendix,
  DATASET_PINS,
  parseCaseSet,
  PRIVATE_PIN_ID,
  stagesFromEvents,
  parsePrefetchMeta,
} = await import("../src/bench/aacr.js");
type BenchCase = import("../src/bench/aacr.js").BenchCase;
type PrefetchMeta = import("../src/bench/aacr.js").PrefetchMeta;
const { prefetchCase, storeDir } = await import("../src/bench/prefetch.js");
const { benchConfig, followUpOutcomeOf, prepareTree, renderCasePrompts } =
  await import("../src/bench/runner.js");
const { benchDelta, benchPriorList } = await import("../src/bench/followup.js");
const { ecosystemFor } = await import("../src/ecosystem.js");
const { buildAgents, identityVars, PASS_ADDENDA } = await import("../src/include.js");

const exec = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), "bench-followup-"));
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

// Upstream: main B0 ← B1. The PR forks at B0: P1 (reviewed in round 1) adds
// b.py; the author then merges main (M) and fixes one line (P3). A rewritten
// first attempt P1x (force-pushed away) is reachable from no branch tip.
const upstream = join(tmp, "upstream");
const NOT_THERE = join(tmp, "no-such-remote");
let B0 = "";
let B1 = "";
let P1 = "";
let P1x = "";
let P3 = "";
const B_PY = Array.from({ length: 10 }, (_, i) => `y${i} = ${i}`).join("\n") + "\n";

beforeAll(() => {
  mkdirSync(upstream);
  git(upstream, "init", "--quiet", "-b", "main");
  git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true");
  const commit = (file: string, text: string, msg: string): string => {
    writeFileSync(join(upstream, file), text);
    git(upstream, "add", file);
    git(upstream, "commit", "--quiet", "-m", msg);
    return git(upstream, "rev-parse", "HEAD");
  };
  B0 = commit("a.py", "x = 1\n", "base zero");
  B1 = commit("a.py", "x = 2\n", "base one");
  git(upstream, "checkout", "--quiet", "-b", "attempt", B0);
  P1x = commit("b.py", "z = 0\n", "a first attempt, later force-pushed away");
  git(upstream, "checkout", "--quiet", "-b", "pr", B0);
  P1 = commit("b.py", B_PY, "first try");
  git(upstream, "merge", "--quiet", "--no-edit", "main");
  P3 = commit("b.py", B_PY.replace("y3 = 3", "y3 = 33"), "address review");
  git(upstream, "checkout", "--quiet", "main");
  git(upstream, "branch", "--quiet", "-D", "attempt");
});

function followCase(over: Partial<NonNullable<BenchCase["followup"]>> = {}): BenchCase {
  return {
    instance_id: `acme__app-7-r2@${P3.slice(0, 7)}`,
    repo: "acme/app",
    pr: 7,
    pr_url: "local://acme/app/7",
    base_commit: B1,
    head_commit: P3,
    language: "Python",
    pr_category: "follow-up",
    change_line_count: 10,
    references: 0,
    title: "Add b",
    body: "Adds b.py with ten settings.",
    base_ref: "main",
    followup: {
      prev_head: P1,
      round_no: 2,
      review_no: 2,
      sweep_owed: true,
      prior_findings: [
        {
          ref: "1:k-b3",
          round_no: 1,
          finding_key: "k-b3",
          path: "b.py",
          line: 4,
          severity: "P1",
          posted_as: "[blocker]",
          lens_ids: ["pass-baseline"],
          title: "y3 is wrong",
          reason: "y3 must be 33",
          evidence: "b.py:4",
        },
        {
          ref: "1:k-nit",
          round_no: 1,
          finding_key: "k-nit",
          path: "b.py",
          line: 1,
          severity: "P3",
          posted_as: "[nit]",
          lens_ids: [],
          title: "naming",
          reason: null,
          evidence: null,
        },
      ],
      ledger: "LEDGER PR #7 round 1\nOPEN: b.py:4 y3\nSETTLED: naming is fine\n",
      ...over,
    },
  };
}

const privateSet = (cases: unknown[]) => ({
  name: "private-followup",
  dataset: {
    source: "private: local mirror",
    commit: "0000000000000000000000000000000000000000",
    file: "-",
    sha256: "unpinned-private",
  },
  rule: "follow-up replay",
  cases,
  backups: [],
});

describe("the follow-up case shape", () => {
  it("parses under the explicitly unpinned private pin, never scored", () => {
    expect(DATASET_PINS.find((p) => p.id === PRIVATE_PIN_ID)!.denomination).toMatch(
      /unpinned.*never scored/,
    );
    const set = parseCaseSet(privateSet([followCase()]));
    expect(set.pin).toBe(PRIVATE_PIN_ID);
    expect(set.cases[0]!.followup!.prior_findings).toHaveLength(2);
    expect(() => parseCaseSet(privateSet([{ ...followCase(), references: 3 }]))).toThrow(
      /never scored/,
    );
  });

  it("names its round in the id, so its store never collides with a round-1 case's", () => {
    const c = followCase();
    expect(() =>
      parseCaseSet(privateSet([{ ...c, instance_id: `acme__app@${P3.slice(0, 7)}` }])),
    ).toThrow(/does not match/);
  });

  it("validates every value that reaches git, a path or the prompt", () => {
    const bad = (over: Record<string, unknown>, re: RegExp) =>
      expect(() =>
        parseCaseSet(
          privateSet([{ ...followCase(), followup: { ...followCase().followup, ...over } }]),
        ),
      ).toThrow(re);
    bad({ prev_head: "HEAD~1" }, /prev_head/);
    bad({ prev_head: P3 }, /head itself/);
    bad({ review_no: 3 }, /review_no exceeds/);
    bad({ sweep_owed: "yes" }, /sweep_owed/);
    const f0 = followCase().followup!.prior_findings[0]!;
    bad({ prior_findings: [{ ...f0, round_no: 2 }] }, /earlier round/);
    bad({ prior_findings: [{ ...f0, ref: "9:x" }] }, /ref must be/);
    bad({ prior_findings: [{ ...f0, path: "../etc/passwd" }] }, /bad path/);
    bad({ prior_findings: [{ ...f0, lens_ids: ["Pass Baseline"] }] }, /lens ids/);
    bad({ prior_findings: [f0, f0] }, /duplicate ref/);
  });
});

describe("prefetch: base, previous head and head from the mirror only", () => {
  const store = join(tmp, "store");
  const noApi = (() => {
    throw new Error("a mirror-only prefetch must not call the API");
  }) as unknown as typeof fetch;
  const opts = (s = store) => ({
    store: s,
    remoteFor: () => NOT_THERE,
    mirrors: new Map([["acme/app", upstream]]),
    mirrorOnly: true,
    fetchImpl: noApi,
  });

  it("stores the previous head and its verified merge-base, and refs/bench/prev-head", async () => {
    const c = followCase();
    const meta = await prefetchCase(c, opts());
    expect(meta.prev_head).toBe(P1);
    expect(meta.prev_merge_base).toBe(B0);
    expect(meta.merge_base).toBe(B1);
    expect(git(storeDir(store, c), "rev-parse", "refs/bench/prev-head")).toBe(P1);
    expect(parsePrefetchMeta(meta)).not.toBeNull();
    expect(parsePrefetchMeta({ ...meta, prev_merge_base: undefined })).toBeNull();
  });

  it("reuses the store only for the same previous head", async () => {
    const c = followCase();
    const lines: string[] = [];
    await prefetchCase(c, { ...opts(), log: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/cached/);
    // A force-pushed-away previous head is fetched explicitly by sha.
    const moved = followCase({ prev_head: P1x });
    lines.length = 0;
    const meta = await prefetchCase(moved, { ...opts(), log: (l) => lines.push(l) });
    expect(lines.join("\n")).not.toMatch(/cached/);
    expect(meta.prev_head).toBe(P1x);
    expect(meta.prev_merge_base).toBe(B0);
  });

  it("mirror-only never falls back to the network, and needs the set's base_ref", async () => {
    const c = followCase();
    const empty = join(tmp, "empty.git");
    execFileSync("git", ["init", "--quiet", "--bare", empty], { env: ENV });
    await expect(
      prefetchCase(c, {
        ...opts(join(tmp, "store-empty")),
        remoteFor: () => `file://${upstream}`,
        mirrors: new Map([["acme/app", empty]]),
      }),
    ).rejects.toThrow(/mirror-only/);
    await expect(
      prefetchCase(c, { ...opts(join(tmp, "store-nomirror")), mirrors: new Map() }),
    ).rejects.toThrow(/no mirror.*mirror-only/);
    const { base_ref: _b, ...noRef } = c;
    await expect(prefetchCase(noRef, opts(join(tmp, "store-noref")))).rejects.toThrow(
      /needs the set to carry base_ref/,
    );
  });
});

describe("the follow-up round the bench runs is production's", () => {
  const store = join(tmp, "store-run");
  const cfg = benchConfig("");
  const caseDir = "/bench-out/cases/x";
  let meta: PrefetchMeta;
  let tree: string;
  const files = [{ filename: "b.py", additions: 10, deletions: 0, status: "added" }];

  beforeAll(async () => {
    const c = followCase();
    meta = await prefetchCase(c, {
      store,
      remoteFor: () => NOT_THERE,
      mirrors: new Map([["acme/app", upstream]]),
      mirrorOnly: true,
    });
    tree = join(tmp, "wt", "x");
    await prepareTree(storeDir(store, c), tree, meta);
  });

  const render = async (c: BenchCase, over: Partial<typeof cfg.review> = {}) =>
    renderCasePrompts({
      root: ROOT,
      cfg: { ...cfg, review: { ...cfg.review, ...over } },
      ecosystem: ecosystemFor("none"),
      c,
      meta,
      tree,
      caseDir,
      files,
      issuedAt: "2026-10-08T00:00:00Z",
      followUpDelta: await benchDelta(tree, c, meta),
    });

  it("the tree carries the previous head; the delta is the author's change only (the base merge cancels out)", async () => {
    expect(git(tree, "rev-parse", "refs/bench/prev-head")).toBe(P1);
    const d = await benchDelta(tree, followCase(), meta);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.files.map((f) => f.path)).toEqual(["b.py"]);
    expect(d.lines).toBe(2);
    expect(d.files[0]!.ranges).toEqual([[4, 1]]);
  });

  it("renders round-follow-up.md with the delta, the prior findings, the sweep and the round's numbers", async () => {
    const p = await render(followCase());
    expect(p.followUp).toMatchObject({
      scope: "delta",
      round_no: 2,
      delta_files: 1,
      delta_lines: 2,
      sweep_owed: true,
      prior_findings: 2,
    });
    expect(p.order).toContain("## 4b. Pre-approval sweep");
    expect(p.order).toContain("THE CHANGE SINCE THE LAST REVIEW");
    expect(p.order).toContain("PRIOR FINDINGS TO VERIFY — 2 finding(s)");
    expect(p.order).toContain("ref 1:k-b3");
    expect(p.order).toContain(`${caseDir}/prior.json`);
    expect(p.order).toContain(`${caseDir}/delta.patch`);
    expect(p.order).toContain("PRE-APPROVAL SWEEP — owed this round");
    expect(p.order).toContain("naming is fine"); // the ledger's SETTLED digest
    expect(p.order).not.toMatch(/\{\{[a-z_]+\}\}/);
    // The appendix: the round's number, the neutral private sentence.
    expect(p.order).toContain('"round_no": 2, "verdict"');
    expect(p.order).toContain("a recorded pull-request round");
    expect(p.order).not.toContain("public open-source pull request");
    expect(p.order).toContain(`an earlier round reviewed \`${P1}\``);
    const extra = new Map((p.extraFiles ?? []).map((f) => [f.path, f.text]));
    expect(extra.get(`${caseDir}/delta.patch`)).toContain("+y3 = 33");
    expect(JSON.parse(extra.get(`${caseDir}/prior.json`)!).findings).toHaveLength(2);
    expect(extra.get(`${caseDir}/ledger.md`)).toContain("LEDGER PR #7");
    expect(p.sweepPlan!.length).toBeGreaterThan(0);
    expect([...extra.keys()].some((k) => k.startsWith(`${caseDir}/tasks-sweep/`))).toBe(true);
    expect(p.order).toContain(`${caseDir}/tasks-sweep/`);
  });

  it("the prior findings are production's list: blockers first", () => {
    const list = benchPriorList(followCase());
    expect(list.findings.map((f) => f.ref)).toEqual(["1:k-b3", "1:k-nit"]);
    expect(list.findings[0]!.blocking).toBe(true);
  });

  it("no sweep when it was not owed", async () => {
    const p = await render(followCase({ sweep_owed: false }));
    expect(p.followUp).toMatchObject({ scope: "delta", sweep_owed: false });
    expect(p.sweepPlan).toBeUndefined();
    expect(p.order).not.toContain("PRE-APPROVAL SWEEP — owed this round");
    const q = await render(followCase(), { follow_up_sweep: false });
    expect(q.sweepPlan).toBeUndefined();
  });

  it("a post-approval case follows production's size rule, not the recorded answer", async () => {
    // The delta here is one changed line: under the default floor nothing is
    // owed even though the recorded answer says so; at floor 1 it is.
    const small = await render(followCase({ sweep_owed: true, prev_approved: true }));
    expect(small.sweepPlan).toBeUndefined();
    const big = await render(followCase({ sweep_owed: false, prev_approved: true }), {
      follow_up_post_approval_sweep_lines: 1,
    });
    expect(big.sweepPlan!.length).toBeGreaterThan(0);
  });

  it("every doubt is today's full re-review, and says why", async () => {
    const full = await render(followCase(), { follow_up: "full" });
    expect(full.followUp).toMatchObject({ scope: "full", reason: "follow_up_full" });
    expect(full.order).not.toContain("## 4b. Pre-approval sweep");
    expect(full.order).not.toContain("THE CHANGE SINCE THE LAST REVIEW");
    expect(full.order).toContain('"round_no": 2, "verdict"');
    const tooBig = await render(followCase(), { follow_up_max_delta_ratio: 0.1 });
    expect(tooBig.followUp).toMatchObject({ scope: "full", reason: "delta-too-large" });
    const missing = renderCasePrompts({
      root: ROOT,
      cfg,
      ecosystem: ecosystemFor("none"),
      c: followCase(),
      meta,
      tree,
      caseDir,
      files,
      issuedAt: "2026-10-08T00:00:00Z",
      followUpDelta: { ok: false, reason: "old-head-missing" },
    });
    expect(missing.followUp).toMatchObject({ scope: "full", reason: "old-head-missing" });
    const none = renderCasePrompts({
      root: ROOT,
      cfg,
      ecosystem: ecosystemFor("none"),
      c: followCase(),
      meta,
      tree,
      caseDir,
      files,
      issuedAt: "2026-10-08T00:00:00Z",
    });
    expect(none.followUp).toMatchObject({ scope: "full", reason: "no-adapter" });
  });

  it("every planned lens AND every sweep lens is a built agent", async () => {
    const out = join(tmp, "agents");
    buildAgents(join(ROOT, "agents"), out, {
      root: ROOT,
      tiers: cfg.models.tiers,
      riskPasses: cfg.models.risk_passes,
      validateTier: cfg.models.validate_tier,
      vars: identityVars(cfg),
      addenda: [...PASS_ADDENDA],
    });
    const built = new Set(readdirSync(out).map((f) => f.replace(/\.md$/, "")));
    const p = await render(followCase());
    expect(p.plannedLenses).toContain(p.plannedLenses.find((a) => a.startsWith("pass-baseline--")));
    for (const agent of [...p.plannedLenses, ...p.sweepPlan!.map((r) => r.agent)])
      expect(built.has(agent), agent).toBe(true);
  });
});

describe("round 1 stays byte-identical", () => {
  it("the default appendix is the public round-1 one", () => {
    const a = {
      repo: "o/r",
      pr: 1,
      headSha: "a".repeat(40),
      mergeBase: "b".repeat(40),
      caseDir: "/c",
      title: "t",
      body: "b",
      renderOutputs: true,
    };
    const dflt = benchAppendix(a);
    expect(dflt).toBe(benchAppendix({ ...a, roundNo: 1 }));
    expect(dflt).toContain("public open-source pull request");
    expect(dflt).toContain('"round_no": 1, "verdict"');
    expect(dflt).not.toContain("earlier round reviewed");
    expect(benchAppendix({ ...a, renderOutputs: false })).toContain('"round_no": 1, "verdict"');
  });
});

describe("stagesFromEvents", () => {
  const msg = (ts: number) =>
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", timestamp: ts, usage: {} },
    });
  const start = (id: string, args: unknown) =>
    JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName: "subagent", args });
  const end = (
    id: string,
    kids: Array<{ agent: string; ts: number[]; usage: Record<string, unknown> }>,
  ) =>
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "subagent",
      result: {
        details: {
          results: kids.map((k) => ({
            agent: k.agent,
            usage: k.usage,
            messages: k.ts.map((t) => ({ role: "assistant", timestamp: t })),
          })),
        },
      },
    });

  it("splits the delta fan-out and validator from the sweep by launch order", () => {
    const lines = [
      msg(1000),
      start("a", { tasks: [{ agent: "pass-baseline--x" }, { agent: "pass-tests--x" }] }),
      end("a", [
        {
          agent: "pass-baseline--x",
          ts: [1100, 1500],
          usage: { input: 10, output: 2, cacheRead: 5, cost: 0.5 },
        },
        {
          agent: "pass-tests--x",
          ts: [1100, 1700],
          usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0.25 } },
        },
      ]),
      msg(1800),
      start("v", { agent: "pass-validate--y" }),
      end("v", [
        {
          agent: "pass-validate--y",
          ts: [1900, 2400],
          usage: { input: 3, output: 3, cacheRead: 3, cost: 0.1 },
        },
      ]),
      msg(2500),
      "not json",
      start("s", { tasks: [{ agent: "pass-security--x" }] }),
      end("s", [
        {
          agent: "pass-security--x",
          ts: [2600, 3000],
          usage: { input: 7, output: 7, cacheRead: 7, cost: 1 },
        },
      ]),
      start("v2", { agent: "pass-validate--y" }),
      end("v2", []),
      msg(3500),
    ];
    const s = stagesFromEvents(lines);
    expect(s.calls.map((c) => [c.kind, c.phase, c.start_ms, c.end_ms])).toEqual([
      ["lens", "delta", 1000, 1700],
      ["validate", "delta", 1800, 2400],
      ["lens", "sweep", 2500, 3000],
      ["validate", "sweep", 2500, 3500],
    ]);
    expect(s.phases.delta).toMatchObject({
      calls: 2,
      agents: 3,
      usage: { input: 14, output: 6, cacheRead: 8 },
      start_ms: 1000,
      end_ms: 2400,
      wall_ms: 1400,
    });
    expect(s.phases.delta.cost).toBeCloseTo(0.85);
    expect(s.phases.sweep).toMatchObject({ calls: 2, agents: 2, cost: 1, wall_ms: 1000 });
    expect(stagesFromEvents([]).phases.sweep).toMatchObject({ calls: 0, wall_ms: null });
  });
});

describe("shell: private sets and the offline prefetch are default-off", () => {
  it("in-container set_file looks in the private-sets mount second", () => {
    const sh = readFileSync(join(ROOT, "bench", "aacr", "in-container.sh"), "utf8");
    expect(sh).toContain("PRIVATE_SETS=/opt/quickreview/bench/private-sets");
    expect(sh).toMatch(/\[\[ -f "\$f" \]\] \|\| f="\$PRIVATE_SETS\/\$1\.json"/);
  });

  it("bench.sh mounts QCR_BENCH_PRIVATE_SETS read-only and runs an offline prefetch with no network", async () => {
    const t = mkdtempSync(join(tmpdir(), "bench-followup-sh-"));
    try {
      const bin = join(t, "bin");
      const priv = join(t, "private");
      const mirror = join(t, "mirror");
      mkdirSync(bin);
      mkdirSync(priv);
      mkdirSync(mirror);
      const argv = join(t, "argv.log");
      writeFileSync(
        join(bin, "docker"),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argv)}\nexit 0\n`,
      );
      chmodSync(join(bin, "docker"), 0o755);
      await exec(
        "bash",
        [join(ROOT, "bench", "aacr", "bench.sh"), "prefetch", "--set", "private-followup"],
        {
          env: {
            HOME: t,
            PATH: `${bin}:/usr/bin:/bin`,
            QCR_BENCH_RUNS_DIR: join(t, "runs"),
            QCR_BENCH_PRIVATE_SETS: priv,
            QCR_BENCH_PREFETCH_MIRROR: mirror,
            QCR_BENCH_MIRRORS: JSON.stringify({
              root: "/mirrors",
              repos: { "acme/app": "app.git" },
            }),
            QCR_BENCH_PREFETCH_OFFLINE: "1",
          },
        },
      );
      const run = readFileSync(argv, "utf8")
        .split("\n")
        .find((l) => l.startsWith("run "))!;
      expect(run).toContain("--network none -e QCR_BENCH_MIRROR_ONLY=1");
      expect(run).toContain(
        `--mount type=bind,src=${priv},dst=/opt/quickreview/bench/private-sets,readonly`,
      );
      // Unset: nothing of it.
      rmSync(argv);
      await exec(
        "bash",
        [join(ROOT, "bench", "aacr", "bench.sh"), "prefetch", "--set", "smoke10"],
        {
          env: { HOME: t, PATH: `${bin}:/usr/bin:/bin`, QCR_BENCH_RUNS_DIR: join(t, "runs") },
        },
      );
      const plain = readFileSync(argv, "utf8")
        .split("\n")
        .find((l) => l.startsWith("run "))!;
      expect(plain).not.toContain("private-sets");
      expect(plain).not.toContain("--network none");
      expect(plain).not.toContain("MIRROR_ONLY");
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("a follow-up case's outcome report", () => {
  const fu = {
    round_no: 2,
    review_no: 2,
    scope: "delta" as const,
    sweep_owed: true,
    prior_findings: 1,
  };
  it("keeps each pass's phase and reads the sweep the way production does", () => {
    const ran = followUpOutcomeOf(
      fu,
      {
        sweep: "ran",
        passes: [
          { name: "pass-baseline", tier: "sol-med", phase: "delta" },
          { name: "pass-security", tier: "sol-high", phase: "sweep" },
        ],
      },
      "APPROVE",
    );
    expect(ran.executed_phases).toEqual([
      { agent: "pass-baseline--sol-med", phase: "delta" },
      { agent: "pass-security--sol-high", phase: "sweep" },
    ]);
    expect(ran.sweep).toMatchObject({
      claim: "ran",
      status: "ran",
      sweep_passes: 1,
      skipped: false,
    });
  });

  it("an APPROVE with the owed sweep not run is flagged skipped", () => {
    const skipped = followUpOutcomeOf(
      fu,
      {
        sweep: "not_reached",
        passes: [{ name: "pass-baseline", tier: "sol-med", phase: "delta" }],
      },
      "APPROVE",
    );
    expect(skipped.sweep).toMatchObject({ status: "unknown", skipped: true });
    expect(followUpOutcomeOf({ ...fu, scope: "full" }, { sweep: "ran" }, "APPROVE")).toEqual({
      ...fu,
      scope: "full",
    });
  });
});
