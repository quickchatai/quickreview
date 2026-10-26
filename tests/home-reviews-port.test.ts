// The home's real reviews port (src/home/reviews.ts) over a detached-run
// registry in a temp dir, a fake `qcr` for the preview, fake process seams
// for the registry (no child is started), and the review state and the
// daemon's status as files: what each method asks of the reviewer and what
// it answers. No model runs and nothing is posted.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastJson,
  parseRunStatus,
  reviewsPort,
  type QcrResult,
  type ReviewsPortDeps,
} from "../src/home/reviews.js";
import type { Known } from "../src/home/ports.js";

const tmp = mkdtempSync(join(tmpdir(), "home-reviews-"));
/** A known answer's value; an unknown one fails the case with its reason. */
const value = <T>(k: Known<T>): T => {
  if (k.kind !== "known") throw new Error(`unknown: ${k.why}`);
  return k.value;
};
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-26T12:00:00Z");
let n = 0;

interface Rig {
  deps: ReviewsPortDeps;
  qcrCalls: string[][];
  launched: Array<{ runId: string; argv: string[] }>;
  killed: number[];
  live: Set<number>;
  posted: string[];
}

function rig(o: { qcr?: (args: readonly string[]) => Partial<QcrResult> } = {}): Rig {
  const root = join(tmp, `r${n++}`);
  const qcrCalls: string[][] = [];
  const launched: Rig["launched"] = [];
  const killed: number[] = [];
  const live = new Set<number>();
  const posted: string[] = [];
  let pid = 7000;
  let ids = 0;
  const deps: ReviewsPortDeps = {
    registry: join(root, "review", "detached"),
    reportsDir: join(root, "home", "reviews"),
    reviewHome: join(root, "review"),
    statusPath: join(root, "state", "status.json"),
    qcr: async (args) => {
      qcrCalls.push([...args]);
      return { code: 0, stdout: "", stderr: "", ...o.qcr?.(args) };
    },
    detach: {
      now: () => NOW,
      sleep: async () => {},
      newId: () => `run${++ids}`,
      alive: (p) => live.has(p),
      kill: (p) => {
        killed.push(p);
        live.delete(p);
      },
      identify: (args) => {
        const repo = args[args.indexOf("--repo") + 1]!;
        return { ok: true, key: `pr:${repo}#${args[0]}`, label: `PR ${repo}#${args[0]}` };
      },
      launch: (l) => {
        launched.push({ runId: l.runId, argv: l.argv });
        live.add(++pid);
        return { ok: true, pid };
      },
    },
    post: async (file) => {
      posted.push(file);
      return { failed: false, line: "Dry run: recorded, not posted" };
    },
    dryRun: () => true,
    now: () => NOW,
  };
  return { deps, qcrCalls, launched, killed, live, posted };
}

/** A run the registry holds, as `start` and the child leave it. */
function seedRun(
  r: Rig,
  id: string,
  o: {
    repo?: string;
    pr?: number;
    startedAt?: number;
    exit?: { code: number; at?: number };
    result?: unknown;
    stoppedAt?: number;
    pid?: number | null;
  },
): string {
  const dir = join(r.deps.registry, "runs", id);
  mkdirSync(dir, { recursive: true });
  const repo = o.repo ?? "acme/widgets";
  const pr = o.pr ?? 3;
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      run_id: id,
      key: `pr:${repo}#${pr}`,
      label: `PR ${repo}#${pr}`,
      argv: [String(pr), "--repo", repo, "--to", "file", "--out", `/reports/pr-${pr}.md`],
      pid: o.pid === undefined ? null : o.pid,
      started_at: o.startedAt ?? NOW - 60_000,
    }),
  );
  if (o.result !== undefined)
    writeFileSync(join(dir, "output.jsonl"), `${JSON.stringify(o.result)}\n`);
  if (o.exit) writeFileSync(join(dir, "exit.json"), JSON.stringify(o.exit));
  if (o.stoppedAt !== undefined)
    writeFileSync(join(dir, "stopped.json"), JSON.stringify({ at: o.stoppedAt }));
  return dir;
}

const RESULT = {
  schema_version: 1,
  ok: true,
  findings: {
    P1: [
      { path: "src/a.ts", line: 2, severity: "P1", title: "b is wrong", lens: "pass-x--sol-high" },
    ],
    nit: [{ path: null, line: null, severity: "nit", title: "naming", lens: null }],
  },
  cost_usd: 1.11,
  report: "/reports/pr-3.md",
  post_ready: "/runs/x/out/post.json",
};

describe("preview", () => {
  it("runs the app's own `qcr review <PR> --repo R --preview --json` and reads its quote", async () => {
    const r = rig({
      qcr: () => ({
        stdout: `note: a line first\n${JSON.stringify({
          schema_version: 1,
          ok: true,
          preview: {
            estimate_usd: 1.33,
            cap_usd: 2.66,
            key: "k-123",
            lenses: ["pass-security--sol-high", "pass-validate--sol-high"],
            files: 9,
            head_sha: "abc",
          },
        })}\n`,
      }),
    });
    const port = reviewsPort(r.deps);
    expect(await port.preview("acme/widgets", 3)).toEqual({
      ok: true,
      quote: {
        estimateUsd: 1.33,
        capUsd: 2.66,
        key: "k-123",
        lenses: ["pass-security--sol-high", "pass-validate--sol-high"],
        files: 9,
        headSha: "abc",
      },
    });
    expect(r.qcrCalls).toEqual([["review", "3", "--repo", "acme/widgets", "--preview", "--json"]]);
  });

  it("a refused preview says the reviewer's reason; no JSON at all says what the process said", async () => {
    const refused = rig({
      qcr: () => ({
        code: 1,
        stdout: JSON.stringify({ ok: false, errors: ["no GitHub credential found"] }),
      }),
    });
    expect(await reviewsPort(refused.deps).preview("a/b", 1)).toEqual({
      ok: false,
      why: "no GitHub credential found",
    });
    const crashed = rig({ qcr: () => ({ code: 1, stderr: "boom\nError: the module is missing" }) });
    expect(await reviewsPort(crashed.deps).preview("a/b", 1)).toEqual({
      ok: false,
      why: "Error: the module is missing",
    });
  });
});

describe("start, status and stop over the registry", () => {
  // MUTATION: start with `--to pr`, or without the key — this fails.
  it("starts a detached run with the key, its report a file in the state home, never --to pr", async () => {
    const r = rig();
    const port = reviewsPort(r.deps);
    const s = await port.start("acme/widgets", 3, "over-limit-key");
    expect(s).toMatchObject({ ok: true, runId: "run1" });
    const report = (s as { report: string }).report;
    expect(report.startsWith(join(r.deps.reportsDir, "acme-widgets", "pr-3-"))).toBe(true);
    expect(existsSync(join(r.deps.reportsDir, "acme-widgets"))).toBe(true);
    expect(r.launched).toEqual([
      {
        runId: "run1",
        argv: [
          "3",
          "--repo",
          "acme/widgets",
          "--key",
          "over-limit-key",
          "--to",
          "file",
          "--out",
          report,
        ],
      },
    ]);
    const argv = r.launched[0]!.argv;
    expect(argv[argv.indexOf("--to") + 1]).toBe("file");
    expect(argv.filter((a) => /(^|,)pr(,|$)/.test(a))).toEqual([]);
    // the registry holds it, running, and its status names its PR and report
    const st = await port.status("run1");
    expect(st).toMatchObject({
      kind: "known",
      value: {
        runId: "run1",
        state: "running",
        repo: "acme/widgets",
        pr: 3,
        report,
        startedAt: NOW,
      },
    });
  });

  it("refuses a second start of a PR under review, with the registry's reason", async () => {
    const r = rig();
    const port = reviewsPort(r.deps);
    await port.start("acme/widgets", 3, "k");
    const again = await port.start("acme/widgets", 3, "k");
    expect(again.ok).toBe(false);
    expect(!again.ok && again.why).toMatch(/already running \(run run1\)/);
  });

  it("a finished run reads done with its findings, real cost, end and the review kept to post", async () => {
    const r = rig();
    seedRun(r, "d1", {
      exit: { code: 0, at: NOW - 1_000 },
      result: RESULT,
      startedAt: NOW - 200_000,
    });
    const v = value(await reviewsPort(r.deps).status("d1"));
    expect(v).toMatchObject({
      state: "done",
      pr: 3,
      startedAt: NOW - 200_000,
      endedAt: NOW - 1_000,
      report: "/reports/pr-3.md",
      result: {
        costUsd: 1.11,
        postFile: "/runs/x/out/post.json",
        findings: [
          {
            severity: "P1",
            path: "src/a.ts",
            line: 2,
            title: "b is wrong",
            lens: "pass-x--sol-high",
          },
          { severity: "nit", path: null, line: null, title: "naming", lens: null },
        ],
      },
      errors: [],
    });
  });

  it("a failed run carries why; a stopped one reads stopped; an unknown id is unknown", async () => {
    const r = rig();
    seedRun(r, "f1", {
      exit: { code: 1, at: NOW },
      result: { ok: false, errors: ["the review crashed: boom"] },
    });
    seedRun(r, "s1", { pr: 4, stoppedAt: NOW, pid: 1 });
    const port = reviewsPort(r.deps);
    expect(await port.status("f1")).toMatchObject({
      value: { state: "failed", errors: ["the review crashed: boom"] },
    });
    expect(await port.status("s1")).toMatchObject({ value: { state: "stopped", endedAt: NOW } });
    expect((await port.status("nope")).kind).toBe("unknown");
  });

  it("stop marks the run stopped and signals its group", async () => {
    const r = rig();
    const port = reviewsPort(r.deps);
    await port.start("acme/widgets", 3, "k");
    expect(await port.stop("run1")).toEqual({ ok: true });
    expect(r.killed).toEqual([7001]);
    expect(existsSync(join(r.deps.registry, "runs", "run1", "stopped.json"))).toBe(true);
    expect(await port.stop("run1")).toMatchObject({ ok: false });
  });

  it("runs lists the repo's runs oldest first, for re-attaching", async () => {
    const r = rig();
    seedRun(r, "a", { startedAt: NOW - 3_000, exit: { code: 0 }, result: RESULT });
    seedRun(r, "b", { startedAt: NOW - 2_000, pr: 5, pid: 42 });
    r.live.add(42);
    seedRun(r, "c", { startedAt: NOW - 1_000, repo: "other/repo" });
    const list = value(await reviewsPort(r.deps).runs("acme/widgets"));
    expect(list.map((x) => [x.runId, x.state, x.pr])).toEqual([
      ["a", "done", 3],
      ["b", "running", 5],
    ]);
  });
});

describe("status's live lens activity", () => {
  it("reads each lens's tool, file, count, time and line", () => {
    const s = parseRunStatus(
      {
        run_id: "r1",
        state: "running",
        target: "PR acme/widgets#3",
        started_at: NOW,
        progress: {
          lenses_started: ["pass-security--sol-high"],
          live: {
            round: 1,
            parent_status: "active",
            last_activity: "lens wave running",
            updated_at: "x",
            agents: [
              {
                agent: "pass-security--sol-high",
                status: "running",
                duration_ms: 41_000,
                tool_count: 7,
                current_tool: "read",
                current_target: "src/x.ts",
                line: "security · read src/x.ts · 7 tools · 0:41",
              },
            ],
          },
        },
      },
      [],
    );
    expect(s?.live).toEqual({
      lastActivity: "lens wave running",
      lenses: [
        {
          agent: "pass-security--sol-high",
          status: "running",
          toolCount: 7,
          durationMs: 41_000,
          currentTool: "read",
          currentTarget: "src/x.ts",
          line: "security · read src/x.ts · 7 tools · 0:41",
        },
      ],
    });
  });

  it("finds the last JSON object a command printed", () => {
    expect(lastJson('{"a":1}\nnoise\n{"b":2}\n')).toEqual({ b: 2 });
    expect(lastJson("no json")).toBeUndefined();
  });
});

describe("the Reviewed list's sources", () => {
  it("the person's reviews: the registry's finished runs and the per-target review state", async () => {
    const r = rig();
    seedRun(r, "a", {
      pr: 3,
      startedAt: NOW - 300_000,
      exit: { code: 0, at: NOW - 100_000 },
      result: RESULT,
    });
    seedRun(r, "f", { pr: 9, exit: { code: 1 }, result: { ok: false, errors: ["x"] } });
    // a PR reviewed from a checkout: its state in the review home
    const state = join(r.deps.reviewHome, "acme--widgets--abc", "state");
    mkdirSync(state, { recursive: true });
    const round = (at: string) => ({
      round_no: 1,
      head_sha: "h",
      base_sha: "b",
      merge_base: "m",
      reviewed_at: at,
      verdict: null,
      scope: "full",
      cost_usd: 0.5,
    });
    writeFileSync(
      join(state, "s1.json"),
      JSON.stringify({
        version: 1,
        target: "pr:acme/widgets#5",
        rounds: [round("2026-10-25T10:00:00Z")],
        rows: [],
        checks: [],
      }),
    );
    writeFileSync(
      join(state, "s2.json"),
      JSON.stringify({
        version: 1,
        target: "pr:other/repo#5",
        rounds: [round("2026-10-25T10:00:00Z")],
        rows: [],
        checks: [],
      }),
    );
    writeFileSync(join(state, "junk.json"), "not json");
    const m = value(await reviewsPort(r.deps).latest("acme/widgets"));
    expect([...m.keys()].sort()).toEqual([3, 5]);
    expect(m.get(3)).toMatchObject({
      findings: 2,
      high: 1,
      by: "you",
      at: NOW - 100_000,
      tookMs: 200_000,
      costUsd: 1.11,
      report: "/reports/pr-3.md",
    });
    expect(m.get(5)).toMatchObject({
      findings: 0,
      by: "you",
      at: Date.parse("2026-10-25T10:00:00Z"),
      costUsd: 0.5,
    });
  });

  it("auto-review's half: the daemon's rounds per PR, Unknown when its status cannot be read", async () => {
    const r = rig();
    const port = reviewsPort(r.deps);
    // no status on this machine: unknown, never "no reviews"
    expect(await port.autoRounds("acme/widgets")).toEqual({
      kind: "unknown",
      why: "auto-review has written no status on this machine",
    });
    mkdirSync(join(r.deps.statusPath, ".."), { recursive: true });
    writeFileSync(r.deps.statusPath, "{ half");
    expect((await port.autoRounds("acme/widgets")).kind).toBe("unknown");
    writeFileSync(
      r.deps.statusPath,
      JSON.stringify({
        written_at: "2026-10-26T11:00:00Z",
        prs: [
          { number: 3, state: "REVIEWED", rounds: 2, updated_at: "2026-10-26T10:00:00Z" },
          { number: 4, state: "NEW", rounds: 0 },
        ],
      }),
    );
    const m = value(await port.autoRounds("acme/widgets"));
    expect([...m.keys()]).toEqual([3]);
    // the snapshot counts rounds, not findings: those read as not known
    expect(m.get(3)).toEqual({
      findings: null,
      high: null,
      by: "auto",
      at: Date.parse("2026-10-26T10:00:00Z"),
    });
  });
});

describe("post and dry_run", () => {
  it("post hands the saved review to the gate's poster; a failure is a refusal with its line", async () => {
    const r = rig();
    expect(await reviewsPort(r.deps).post("/p.json")).toEqual({
      ok: true,
      line: "Dry run: recorded, not posted",
    });
    expect(r.posted).toEqual(["/p.json"]);
    r.deps.post = async () => ({ failed: true, line: "Review not posted: GitHub answered 422" });
    expect(await reviewsPort(r.deps).post("/p.json")).toEqual({
      ok: false,
      why: "GitHub answered 422",
    });
  });

  it("dry_run is the install's; a config that cannot be read is unknown", async () => {
    const r = rig();
    expect(await reviewsPort(r.deps).dryRun()).toEqual({ kind: "known", value: true });
    r.deps.dryRun = () => {
      throw new Error("config.toml is not valid TOML");
    };
    expect(await reviewsPort(r.deps).dryRun()).toEqual({
      kind: "unknown",
      why: "config.toml is not valid TOML",
    });
  });
});
