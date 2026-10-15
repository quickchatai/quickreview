// Required passes: a round whose pass-baseline or risk lens failed and never
// completed posts NOTHING and is requeued within max_self_requeues.
//
// What is pinned:
//  - the plan builder marks the required rows (pass-baseline, every split
//    baseline row, the risk passes) and nothing else — the one source;
//  - the rule (src/requiredpasses.ts): a failure with fewer completions than
//    rows is a gap; a relaunch that completed closes it; a snapshot that is
//    missing or of another round is UNKNOWN, never a gap;
//  - the shell copy (scripts/required-passes.py) answers as the TypeScript
//    one does over the same plan row and snapshot;
//  - the posting route refuses before it queues or records anything;
//  - the verdict path requeues instead of applying, and past the cap ends on
//    the anomaly path — never with the verdict applied over the gap.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_SELF_REQUEUES, parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import type { LiveAgentProgress, RoundProgressSnapshot } from "../src/round-progress.js";
import { requiredPassGap, requiredRows } from "../src/requiredpasses.js";
import { StateStore } from "../src/state.js";
import type { PassPlanEntry, SessionHooks } from "../src/types.js";
import { roundPromptMarker } from "../src/types.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import { HEAD, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const root = resolve(import.meta.dirname, "..");
const baseCfg: Config = parseConfig(
  readFileSync(resolve(root, "tests/fixtures/config.toml"), "utf8"),
);

function file(filename: string, additions: number): PrFileEntry {
  return {
    filename,
    status: "modified",
    additions,
    deletions: 0,
    changes: additions,
    patch: "@@ -1 +1 @@\n-a\n+b\n",
  } as unknown as PrFileEntry;
}

const row = (lens: string, required = false): PassPlanEntry => ({
  lens,
  agent: `${lens}--sol-high`,
  tier: "sol-high",
  raisable_to: [],
  ...(required ? { required: true as const } : {}),
});

const PLAN: PassPlanEntry[] = [
  row("pass-baseline", true),
  row("pass-security", true),
  row("pass-tests"),
  row("pass-validate"),
];

let seq = 0;
function agent(
  name: string,
  status: LiveAgentProgress["status"],
  error?: string,
): LiveAgentProgress {
  seq++;
  return {
    execution_id: `call:${name}#${seq}`,
    agent: `${name}--sol-high`,
    status,
    duration_ms: 1,
    tool_count: 0,
    started_at: "2026-10-15T10:00:01.000Z",
    ...(status === "running" ? {} : { finished_at: "2026-10-15T10:00:02.000Z" }),
    ...(error ? { error } : {}),
  };
}

function snapshot(
  roundNo: number | undefined,
  agents: LiveAgentProgress[],
  pr = 5180,
): RoundProgressSnapshot {
  return {
    version: 2,
    pr,
    session: `pr-${pr}`,
    run_started_at: "2026-10-15T10:00:00.000Z",
    updated_at: "2026-10-15T10:00:03.000Z",
    parent_status: "active",
    command_id: "cmd",
    command_sha256: "a".repeat(64),
    command_accepted_at: "2026-10-15T10:00:00.000Z",
    preparing_at: "2026-10-15T10:00:00.000Z",
    first_lens_started_at: "2026-10-15T10:00:01.000Z",
    fanout_started_at: "2026-10-15T10:00:01.000Z",
    ...(roundNo !== undefined ? { round_no: roundNo, head_sha: HEAD } : {}),
    last_activity_at: "2026-10-15T10:00:03.000Z",
    last_activity: "x",
    agents,
  };
}

const TIMEOUT = "pass pass-security--sol-high timed out after 8 min (retried once)";

describe("the plan builder marks the required rows", () => {
  it("pass-baseline and every risk pass are required; nothing else is", () => {
    const files = [
      file("src/orders/api.py", 300),
      file(".github/workflows/ci.yml", 20),
      file("Dockerfile", 10),
    ];
    const { pass_plan } = buildPassPlan(baseCfg, files, undefined, NONE_ECOSYSTEM);
    const risk = new Set(baseCfg.models.risk_passes);
    expect(pass_plan.some((p) => risk.has(p.lens))).toBe(true);
    for (const p of pass_plan)
      expect(p.required === true, p.lens).toBe(p.lens === "pass-baseline" || risk.has(p.lens));
  });

  it("every row of a split baseline is required, and counts as a row", () => {
    const cfg = structuredClone(baseCfg);
    cfg.review.baseline_split_lines = 500;
    const files = [file("backend/a.py", 600), file("frontend/b.tsx", 600)];
    const { pass_plan } = buildPassPlan(cfg, files, undefined, NONE_ECOSYSTEM);
    const baseline = pass_plan.filter((p) => p.lens === "pass-baseline");
    expect(baseline.length).toBeGreaterThan(1);
    expect(baseline.every((p) => p.required === true)).toBe(true);
    expect(requiredRows(pass_plan).get("pass-baseline")).toBe(baseline.length);
  });
});

/** The cases both copies of the rule must answer alike. */
const CASES: Array<{
  name: string;
  plan: PassPlanEntry[] | null;
  progress: RoundProgressSnapshot | undefined;
  expected: "complete" | "missing" | "unknown";
}> = [
  {
    name: "every required pass completed",
    plan: PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      agent("pass-security", "completed"),
    ]),
    expected: "complete",
  },
  {
    name: "a risk pass timed out twice",
    plan: PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      agent("pass-security", "failed", TIMEOUT),
      agent("pass-tests", "completed"),
    ]),
    expected: "missing",
  },
  {
    name: "a non-required pass failed",
    plan: PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      agent("pass-security", "completed"),
      agent("pass-tests", "failed", "boom"),
    ]),
    expected: "complete",
  },
  {
    name: "the session relaunched the failed required pass and it completed",
    plan: PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      agent("pass-security", "failed", TIMEOUT),
      agent("pass-security", "completed"),
    ]),
    expected: "complete",
  },
  {
    name: "one of two split baseline rows failed",
    plan: [row("pass-baseline", true), row("pass-baseline", true), row("pass-validate")],
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      agent("pass-baseline", "failed", "x"),
    ]),
    expected: "missing",
  },
  {
    name: "a required pass still running is not a gap",
    plan: PLAN,
    progress: snapshot(3, [agent("pass-baseline", "running"), agent("pass-security", "completed")]),
    expected: "complete",
  },
  {
    name: "a snapshot of another round is unknown",
    plan: PLAN,
    progress: snapshot(2, [agent("pass-security", "failed", TIMEOUT)]),
    expected: "unknown",
  },
  {
    name: "no snapshot is unknown",
    plan: PLAN,
    progress: undefined,
    expected: "unknown",
  },
  {
    name: "a plan recorded before required rows existed requires nothing",
    plan: [row("pass-baseline"), row("pass-security")],
    progress: snapshot(3, [agent("pass-security", "failed", TIMEOUT)]),
    expected: "complete",
  },
];

describe("requiredPassGap", () => {
  it.each(CASES)("$name", ({ plan, progress, expected }) => {
    const gap = requiredPassGap(plan, progress, 3);
    expect(gap.state).toBe(expected);
    if (gap.state === "missing" && plan === PLAN)
      expect(gap.missing[0]).toMatchObject({ lens: "pass-security", errors: [TIMEOUT] });
  });
});

describe("scripts/required-passes.py answers as the TypeScript rule does", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-required-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(CASES)("$name", ({ plan, progress, expected }) => {
    const db = new Database(join(dir, "state.db"));
    db.exec(
      "CREATE TABLE rounds (id INTEGER PRIMARY KEY, pr INTEGER, round_no INTEGER, pass_plan TEXT)",
    );
    // An older attempt of the same round number is never the one read.
    db.prepare("INSERT INTO rounds (pr, round_no, pass_plan) VALUES (5180, 3, ?)").run("[]");
    db.prepare("INSERT INTO rounds (pr, round_no, pass_plan) VALUES (5180, 3, ?)").run(
      plan ? JSON.stringify(plan) : null,
    );
    db.close();
    mkdirSync(join(dir, "rp"));
    if (progress) writeFileSync(join(dir, "rp", "pr-5180.json"), JSON.stringify(progress));
    let code = 0;
    let out = "";
    try {
      out = execFileSync(
        "python3",
        [
          join(root, "scripts", "required-passes.py"),
          join(dir, "state.db"),
          join(dir, "rp"),
          "5180",
          "3",
        ],
        { encoding: "utf8" },
      );
    } catch (err) {
      const e = err as { status: number; stdout: string };
      code = e.status;
      out = e.stdout;
    }
    expect(out.split(":")[0]!.trim()).toBe(expected);
    expect(code).toBe(expected === "missing" ? 3 : 0);
    if (expected === "missing" && plan === PLAN) expect(out).toContain(TIMEOUT);
  });
});

describe("the posting route refuses while a required pass is missing", () => {
  const s = useGuardsShellRig();

  function seed(progress: RoundProgressSnapshot): void {
    const store = new StateStore(s.dbPath);
    store.upsertPr({
      number: 5180,
      state: "reviewing",
      head_sha: HEAD,
      title: "PR",
      author: "pr-author",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const id = store.startRound(5180, "first", ["pass-baseline", "pass-security"], 60);
    store.setRoundMeta(id, { pass_plan: PLAN });
    store.close();
    mkdirSync(join(s.dir, "round-progress"), { recursive: true });
    writeFileSync(join(s.dir, "round-progress", "pr-5180.json"), JSON.stringify(progress));
  }
  const env = () => ({
    QCR_EXPECTED_HEAD: HEAD,
    QCR_ROUND_NO: "1",
    QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
  });
  const receipts = () => {
    try {
      return readdirSync(join(s.dir, "receipts")).filter((n) => !n.endsWith(".lock"));
    } catch {
      return [];
    }
  };

  it.each([
    ["post-review.sh", ["5180", "COMMENT"]],
    ["approve-pr.sh", ["5180"]],
  ])("%s posts, queues and records nothing", async (script, args) => {
    seed(
      snapshot(1, [agent("pass-baseline", "completed"), agent("pass-security", "failed", TIMEOUT)]),
    );
    const res = await s.run(script, [...args, s.bodyFile()], env());
    expect(res.ok).toBe(false);
    expect(res.out).toContain("required pass missing");
    expect(res.out).toContain(TIMEOUT);
    expect(s.dryrunRecords()).toEqual([]);
    expect(receipts()).toEqual([]);
  });

  it("posts as usual once every required pass completed", async () => {
    seed(snapshot(1, [agent("pass-baseline", "completed"), agent("pass-security", "completed")]));
    const res = await s.run("post-review.sh", ["5180", "COMMENT", s.bodyFile()], env());
    expect(res.ok).toBe(true);
    expect(s.dryrunRecords()).toHaveLength(1);
  });
});

describe("the verdict path requeues instead of applying", () => {
  class FakeAdapter implements VerdictAdapter {
    calls: string[] = [];
    async addLabel(n: number, label: string): Promise<GateResult> {
      this.calls.push(`addLabel:${n}:${label}`);
      return { executed: false, dryRunFile: "d" };
    }
    async removeLabel(n: number, label: string): Promise<GateResult> {
      this.calls.push(`removeLabel:${n}:${label}`);
      return { executed: false, dryRunFile: "d" };
    }
  }
  let dir: string;
  let store: StateStore;
  let adapter: FakeAdapter;
  const clock = new Date("2026-10-15T10:30:00Z");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-required-verdict-"));
    store = new StateStore(":memory:", () => clock);
    adapter = new FakeAdapter();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const hooks: SessionHooks = {
    async dispatchRound() {},
    async inject() {},
    async injectOverseer() {},
    async archiveAndClose() {},
  };
  const watcher = () =>
    new VerdictWatcher({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      verdictDir: join(dir, "verdict"),
      root: dir,
      usage: { globalStoreDir: null },
      partialWrite: { windowMs: 0 },
      now: () => clock,
    });
  function round(pr: number, progress: (roundNo: number) => RoundProgressSnapshot): number {
    store.upsertPr({
      number: pr,
      state: "reviewing",
      head_sha: "abc123",
      title: "PR",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const id = store.startRound(pr, "first", ["pass-baseline", "pass-security"], 60);
    const roundNo = store.roundsFor(pr).length;
    store.stampPromptMarker(id, roundPromptMarker(pr, roundNo));
    store.setRoundMeta(id, { pass_plan: PLAN });
    mkdirSync(join(dir, "state", "round-progress"), { recursive: true });
    writeFileSync(
      join(dir, "state", "round-progress", `pr-${pr}.json`),
      JSON.stringify(progress(roundNo)),
    );
    mkdirSync(join(dir, "verdict"), { recursive: true });
    writeFileSync(
      join(dir, "verdict", `pr-${pr}-round-${roundNo}.json`),
      JSON.stringify({
        pr,
        round_no: roundNo,
        verdict: "REQUEST_CHANGES",
        head_sha: "abc123",
        finished_at: clock.toISOString(),
        passes: [{ name: "pass-baseline", tier: "sol-high", findings: 1 }],
      }),
    );
    return id;
  }
  const missing = (n: number) =>
    snapshot(
      n,
      [agent("pass-baseline", "completed"), agent("pass-security", "failed", TIMEOUT)],
      0,
    );
  const withPr = (pr: number, f: (n: number) => RoundProgressSnapshot) => (n: number) => ({
    ...f(n),
    pr,
    session: `pr-${pr}`,
  });
  const events = (kind: string) =>
    (
      store.db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Array<{
        payload: string;
      }>
    ).map((r) => JSON.parse(r.payload));
  const status = (id: number) =>
    (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(id) as { status: string })
      .status;

  it("a missing required pass: no verdict applied, round cancelled, PR requeued, gap recorded", async () => {
    const id = round(700, withPr(700, missing));
    await watcher().sweep();
    expect(status(id)).toBe("cancelled");
    expect(store.getPr(700)!.state).toBe("queued");
    expect(store.reviewedHead(700)).toBeUndefined();
    expect(events("round_required_pass_missing")[0].missing).toContain(TIMEOUT);
    expect(events("round_pass_failures")[0].failed).toEqual([
      { agent: "pass-security--sol-high", error: TIMEOUT },
    ]);
    expect(events("round_self_requeued")[0]).toMatchObject({ mode: "required_pass_missing" });
    expect(adapter.calls.some((c) => c.startsWith("addLabel:700"))).toBe(false);
  });

  it("every required pass completed: the verdict applies as usual", async () => {
    round(
      701,
      withPr(701, (n) =>
        snapshot(n, [agent("pass-baseline", "completed"), agent("pass-security", "completed")], 0),
      ),
    );
    await watcher().sweep();
    expect(events("round_required_pass_missing")).toHaveLength(0);
    expect(store.reviewedHead(701)).toBeDefined();
  });

  // MUTATION: ignore `proven` in apply's required-pass check — the review a
  // marker reconcile proved posted is cancelled and requeued, to post again.
  it("a review proven posted from GitHub is never redone over a required-pass gap", async () => {
    const id = round(704, withPr(704, missing));
    const key = roundPostingKey(704, 1, "abc123");
    store.stampPostingKey(id, key);
    // The verdict file is malformed: only the posting proof can settle it.
    writeFileSync(join(dir, "verdict", "pr-704-round-1.json"), "{broken");
    (adapter as FakeAdapter & VerdictAdapter).listReviewsFull = async () => [
      {
        id: 991,
        user: baseCfg.github.bot_login,
        user_type: "Bot",
        state: "CHANGES_REQUESTED",
        body: `review\n\n${postingMarker(key)}`,
        commit_id: "abc123",
        submitted_at: clock.toISOString(),
      },
    ];
    await new VerdictWatcher({
      cfg: { ...baseCfg, dry_run: false },
      store,
      adapter,
      hooks,
      verdictDir: join(dir, "verdict"),
      root: dir,
      usage: { globalStoreDir: null },
      partialWrite: { windowMs: 0 },
      postingReceiptGraceS: 0,
      now: () => clock,
    }).sweep();

    expect(status(id)).toBe("done");
    expect(events("round_self_requeued")).toHaveLength(0);
    expect(events("required_pass_missing_after_post")[0]).toMatchObject({ receipt: "proven" });
  });

  it("past max_self_requeues it ends on the anomaly path, never applying the verdict", async () => {
    const w = watcher();
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      round(702, withPr(702, missing));
      await w.sweep();
      expect(store.getPr(702)!.state).toBe("queued");
    }
    const last = round(702, withPr(702, missing));
    await w.sweep();
    expect(events("self_requeue_cap_exhausted")).toHaveLength(1);
    expect(status(last)).not.toBe("done");
    expect(store.reviewedHead(702)).toBeUndefined();
  });
});
