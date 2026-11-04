// Required passes: a round whose pass-baseline or risk lens failed and never
// completed posts NOTHING and is requeued within max_self_requeues.
//
// What is pinned:
//  - the plan builder marks the required rows (pass-baseline, every split
//    baseline row, the risk passes) and nothing else — the one source;
//  - the rule (src/requiredpasses.ts): a failure with fewer completions than
//    rows is a gap; a relaunch that completed closes it; a snapshot that is
//    missing or of another round is UNKNOWN, never a gap;
//  - a strategy row (the exploit chain's required `delta`) is answered only by
//    executions launched for its strategy, so a completed `forward` never
//    covers a failed `delta`; a row with no strategy counts as before;
//  - failedSecurityRows names the security-family rows that did not complete
//    (failed, still running, never launched; a post-discovery compose only
//    once launched), required or not, and is UNKNOWN — never an empty list —
//    without this round's snapshot;
//  - the shell copy (scripts/required-passes.py) answers as the TypeScript
//    one does over the same plan row and snapshot;
//  - the posting route refuses before it queues or records anything;
//  - the verdict path requeues instead of applying, and past the cap ends on
//    the anomaly path — never with the verdict applied over the gap.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_SELF_REQUEUES, parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import {
  lensForAgent,
  type LiveAgentProgress,
  type RoundProgressSnapshot,
} from "@quickchatai/pi-quickreview/src/round-progress.js";
import {
  describeGap,
  failedSecurityRows,
  requiredPassGap,
  requiredRows,
} from "../src/requiredpasses.js";
import { StateStore } from "../src/state.js";
import {
  CHAIN_PASS,
  SECURITY_FAMILY,
  type ChainStrategy,
} from "@quickchatai/pi-quickreview/src/passes.js";
import type { PassPlanEntry, SessionHooks } from "@quickchatai/pi-quickreview/src/types.js";
import { PASS_TIER_ORDER, roundPromptMarker } from "@quickchatai/pi-quickreview/src/types.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";

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

const HEAD = "68b8040c0ffee1234567890abcdef0123456789a";

describe("the plan builder marks the required rows", () => {
  it("pass-baseline, every risk pass outside the security family and the chain's delta are required; nothing else is", () => {
    const files = [
      file("src/orders/api.py", 300),
      file(".github/workflows/ci.yml", 20),
      file("Dockerfile", 10),
    ];
    const { pass_plan } = buildPassPlan(baseCfg, files, undefined, NONE_ECOSYSTEM);
    const risk = new Set(baseCfg.models.risk_passes);
    expect(pass_plan.some((p) => risk.has(p.lens))).toBe(true);
    for (const p of pass_plan)
      expect(p.required === true, `${p.lens}${p.strategy ? `:${p.strategy}` : ""}`).toBe(
        p.lens === "pass-baseline" ||
          (risk.has(p.lens) && !SECURITY_FAMILY.includes(p.lens)) ||
          (p.lens === CHAIN_PASS && p.strategy === "delta"),
      );
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
  sweepPlan?: PassPlanEntry[];
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

// A full sweep is a separate obligation even when it repeats a delta lens.
CASES.push(
  {
    name: "a completed delta cannot mask a failed required sweep",
    plan: [row("pass-security", true)],
    sweepPlan: [row("pass-security", true)],
    progress: snapshot(3, [
      Object.assign(agent("pass-security", "completed"), { phase: "plan" }),
      Object.assign(agent("pass-security", "failed", TIMEOUT), { phase: "sweep" }),
    ]),
    expected: "missing",
  },
  {
    name: "a completed sweep cannot mask a failed required delta",
    plan: [row("pass-security", true)],
    sweepPlan: [row("pass-security", true)],
    progress: snapshot(3, [
      Object.assign(agent("pass-security", "failed", TIMEOUT), { phase: "plan" }),
      Object.assign(agent("pass-security", "completed"), { phase: "sweep" }),
    ]),
    expected: "missing",
  },
  {
    name: "a sweep retry closes only its own required gap",
    plan: [row("pass-security", true)],
    sweepPlan: [row("pass-security", true)],
    progress: snapshot(3, [
      Object.assign(agent("pass-security", "completed"), { phase: "plan" }),
      Object.assign(agent("pass-security", "failed", TIMEOUT), { phase: "sweep" }),
      Object.assign(agent("pass-security", "completed"), { phase: "sweep" }),
    ]),
    expected: "complete",
  },
  {
    name: "optional completions cannot repair failed required plan rows",
    plan: [row("pass-security", true)],
    progress: snapshot(3, [
      Object.assign(agent("pass-security", "failed", TIMEOUT), { phase: "plan" }),
      Object.assign(agent("pass-security", "completed"), { phase: "optional" }),
    ]),
    expected: "missing",
  },
);

// The exploit chain: one agent, one row per strategy, only `delta` required.
const CHAIN = CHAIN_PASS;
const chainRow = (strategy: ChainStrategy, required = false): PassPlanEntry => ({
  ...row(CHAIN, required),
  strategy,
});
const chainRun = (
  strategy: string | undefined,
  status: LiveAgentProgress["status"],
  error?: string,
): LiveAgentProgress =>
  Object.assign(agent(CHAIN, status, error), {
    phase: "plan" as const,
    ...(strategy !== undefined ? { strategy } : {}),
  });
const CHAIN_PLAN: PassPlanEntry[] = [
  row("pass-baseline", true),
  chainRow("delta", true),
  chainRow("forward"),
  chainRow("backward"),
];
const CHAIN_TIMEOUT = "pass pass-sec-exploit-chain--sol-high timed out after 8 min (retried once)";

CASES.push(
  // MUTATION: ignore strategy in requiredPassGap (drop the `a.strategy ===
  // strategy` match in runsFor, or the strategy test in required-passes.py) —
  // the completed forward stands in for the failed delta and this fails.
  {
    name: "a completed chain forward cannot mask a failed chain delta",
    plan: CHAIN_PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      chainRun("delta", "failed", CHAIN_TIMEOUT),
      chainRun("forward", "completed"),
      chainRun("backward", "completed"),
    ]),
    expected: "missing",
  },
  {
    name: "only the chain forward failed: the required delta completed",
    plan: CHAIN_PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      chainRun("delta", "completed"),
      chainRun("forward", "failed", CHAIN_TIMEOUT),
      chainRun("backward", "completed"),
    ]),
    expected: "complete",
  },
  {
    name: "a relaunched chain delta closes its own gap",
    plan: CHAIN_PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      chainRun("delta", "failed", CHAIN_TIMEOUT),
      chainRun("delta", "completed"),
    ]),
    expected: "complete",
  },
  {
    name: "a delta relaunched without its task file never counts for it",
    plan: CHAIN_PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      chainRun("delta", "failed", CHAIN_TIMEOUT),
      chainRun(undefined, "completed"),
    ]),
    expected: "missing",
  },
  // MUTATION: drop the untaggedRuns branch from gapsOf (or the lens_runs
  // fallback in required-passes.py) — the failed delta whose strategy the
  // telemetry lost matches no `delta` run and this reads complete.
  {
    name: "a chain delta that failed with no recorded strategy still blocks",
    plan: CHAIN_PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      chainRun(undefined, "failed", CHAIN_TIMEOUT),
      chainRun(undefined, "completed"),
      chainRun(undefined, "completed"),
    ]),
    expected: "missing",
  },
  {
    name: "chain rows with no recorded strategy that all completed are whole",
    plan: CHAIN_PLAN,
    progress: snapshot(3, [
      agent("pass-baseline", "completed"),
      chainRun(undefined, "failed", CHAIN_TIMEOUT),
      chainRun(undefined, "completed"),
      chainRun(undefined, "completed"),
      chainRun(undefined, "completed"),
    ]),
    expected: "complete",
  },
  {
    name: "a legacy required row with no strategy counts every execution of its lens",
    plan: [row(CHAIN, true)],
    progress: snapshot(3, [
      chainRun("delta", "failed", CHAIN_TIMEOUT),
      chainRun("forward", "completed"),
    ]),
    expected: "complete",
  },
);

describe("requiredPassGap", () => {
  it.each(CASES)("$name", ({ plan, progress, sweepPlan, expected }) => {
    const gap = requiredPassGap(plan, progress, 3, sweepPlan);
    expect(gap.state).toBe(expected);
    if (gap.state === "missing" && plan === PLAN)
      expect(gap.missing[0]).toMatchObject({ lens: "pass-security", errors: [TIMEOUT] });
  });
});

describe("a strategy row's gap", () => {
  it("names the lens and its strategy", () => {
    const gap = requiredPassGap(
      CHAIN_PLAN,
      snapshot(3, [chainRun("delta", "failed", CHAIN_TIMEOUT), chainRun("forward", "completed")]),
      3,
    );
    expect(gap).toMatchObject({
      state: "missing",
      missing: [{ lens: CHAIN, strategy: "delta", rows: 1, completed: 0, failed: 1 }],
    });
    if (gap.state === "missing")
      expect(describeGap(gap.missing)).toBe(
        `${CHAIN}:delta (0/1 completed, 1 failed: ${CHAIN_TIMEOUT})`,
      );
  });

  it("counts a strategy row under <lens>:<strategy>, a plain row under its lens", () => {
    const rows = requiredRows(CHAIN_PLAN);
    expect([...rows]).toEqual([
      ["pass-baseline", 1],
      [`${CHAIN}:delta`, 1],
    ]);
  });
});

describe("failedSecurityRows", () => {
  const SEC_PLAN: PassPlanEntry[] = [
    row("pass-baseline", true),
    row("pass-tests"),
    row("pass-sec-access"),
    row("pass-sec-injection"),
    chainRow("delta", true),
    chainRow("forward"),
  ];
  const POST_PLAN: PassPlanEntry[] = [{ ...chainRow("compose"), stage: "post-discovery" }];
  // Every family plan row of SEC_PLAN, completed — the background a test
  // overrides one row of.
  const done = (): LiveAgentProgress[] => [
    agent("pass-sec-access", "completed"),
    agent("pass-sec-injection", "completed"),
    chainRun("delta", "completed"),
    chainRun("forward", "completed"),
  ];

  it("names the family rows that failed and never completed, required or not", () => {
    const result = failedSecurityRows(
      SEC_PLAN,
      snapshot(3, [
        agent("pass-baseline", "completed"),
        agent("pass-tests", "failed", "boom"),
        agent("pass-sec-access", "completed"),
        agent("pass-sec-injection", "failed", "x"),
        chainRun("delta", "completed"),
        chainRun("forward", "failed", CHAIN_TIMEOUT),
      ]),
      3,
    );
    expect(result).toEqual({
      state: "known",
      failed: [
        { lens: "pass-sec-injection", why: "failed", errors: ["x"] },
        { lens: CHAIN, strategy: "forward", why: "failed", errors: [CHAIN_TIMEOUT] },
      ],
    });
  });

  // The line never holds the post back, so it names a row with no failed
  // execution too: one never launched, one still running at posting time.
  // MUTATION: restore `failedRuns.length > 0 &&` to incompleteSecurityRows'
  // test (the required-pass rule) — this fails.
  it("names a row never launched and a row still running", () => {
    const result = failedSecurityRows(
      SEC_PLAN,
      snapshot(3, [
        agent("pass-sec-access", "running"),
        chainRun("delta", "completed"),
        chainRun("forward", "completed"),
      ]),
      3,
    );
    expect(result).toEqual({
      state: "known",
      failed: [
        { lens: "pass-sec-access", why: "running", errors: [] },
        { lens: "pass-sec-injection", why: "not-run", errors: [] },
      ],
    });
    expect(failedSecurityRows(SEC_PLAN, snapshot(3, done()), 3)).toEqual({
      state: "known",
      failed: [],
    });
  });

  // MUTATION: ignore strategy in failedSecurityRows (count every chain
  // execution for every chain row) — the completed delta hides the failed
  // forward, or the failed forward is reported against delta, and this fails.
  it("tells the chain's strategies apart", () => {
    const result = failedSecurityRows(
      SEC_PLAN,
      snapshot(3, [
        agent("pass-sec-access", "completed"),
        agent("pass-sec-injection", "completed"),
        chainRun("delta", "failed", CHAIN_TIMEOUT),
        chainRun("forward", "completed"),
      ]),
      3,
    );
    expect(result).toEqual({
      state: "known",
      failed: [{ lens: CHAIN, strategy: "delta", why: "failed", errors: [CHAIN_TIMEOUT] }],
    });
  });

  // A chain execution with no recorded strategy could have run any chain row.
  // MUTATION: drop the untaggedRuns branch from incompleteSecurityRows — the
  // failed untagged run matches no strategy row, every row reads "not-run" or
  // complete, and the first expectation fails.
  it("is unknown when a strategy row's lens ran with no recorded strategy and fell short", () => {
    const untagged = (status: LiveAgentProgress["status"]) =>
      chainRun(undefined, status, status === "failed" ? CHAIN_TIMEOUT : undefined);
    const base = [agent("pass-sec-access", "completed"), agent("pass-sec-injection", "completed")];
    expect(
      failedSecurityRows(
        SEC_PLAN,
        snapshot(3, [...base, untagged("failed"), untagged("completed")]),
        3,
      ).state,
    ).toBe("unknown");
    expect(
      failedSecurityRows(
        SEC_PLAN,
        snapshot(3, [...base, untagged("failed"), untagged("completed"), untagged("completed")]),
        3,
      ),
    ).toEqual({ state: "known", failed: [] });
  });

  it("reads the post-discovery rows from the post phase alone", () => {
    const compose = (status: LiveAgentProgress["status"], phase: "plan" | "post") =>
      Object.assign(agent(CHAIN, status, status === "failed" ? "boom" : undefined), {
        phase,
        strategy: "compose",
      });
    expect(
      failedSecurityRows(
        SEC_PLAN,
        snapshot(3, [...done(), compose("failed", "post")]),
        3,
        POST_PLAN,
      ),
    ).toEqual({
      state: "known",
      failed: [{ lens: CHAIN, strategy: "compose", why: "failed", errors: ["boom"] }],
    });
    expect(
      failedSecurityRows(
        SEC_PLAN,
        snapshot(3, [...done(), compose("failed", "post"), compose("completed", "post")]),
        3,
        POST_PLAN,
      ),
    ).toEqual({ state: "known", failed: [] });
    expect(
      failedSecurityRows(
        SEC_PLAN,
        snapshot(3, [...done(), compose("running", "post")]),
        3,
        POST_PLAN,
      ),
    ).toEqual({
      state: "known",
      failed: [{ lens: CHAIN, strategy: "compose", why: "running", errors: [] }],
    });
  });

  // The round prompt skips `compose` when the round has no security leads
  // (`CHAIN-SKIPPED no leads`): a compose row never launched is no gap.
  // MUTATION: drop the `phase === "post" && runs.length === 0` skip from
  // incompleteSecurityRows — this fails.
  it("says nothing of a compose row never launched — a round with no leads skips it", () => {
    expect(failedSecurityRows(SEC_PLAN, snapshot(3, done()), 3, POST_PLAN)).toEqual({
      state: "known",
      failed: [],
    });
  });

  // A follow-up can carry its family rows in the owed whole-PR sweep alone
  // (`sweep_plan`, launched from tasks-sweep/): a delta plan with no family
  // row says nothing of them.
  // MUTATION: drop the `sweepRows` phase from failedSecurityRows' loop — this
  // fails.
  describe("a follow-up's owed sweep", () => {
    const DELTA_PLAN: PassPlanEntry[] = [row("pass-baseline", true), row("pass-validate")];
    const SWEEP_PLAN: PassPlanEntry[] = [
      row("pass-baseline", true),
      row("pass-sec-access"),
      row("pass-validate"),
    ];
    const swept = (lens: string, status: LiveAgentProgress["status"], error?: string) =>
      Object.assign(agent(lens, status, error), { phase: "sweep" as const });
    const deltaDone = [agent("pass-baseline", "completed")];

    it("names a sweep family row that failed, marked as the sweep's", () => {
      for (const approval of [false, true])
        expect(
          failedSecurityRows(
            DELTA_PLAN,
            snapshot(3, [...deltaDone, swept("pass-sec-access", "failed", "boom")]),
            3,
            undefined,
            { plan: SWEEP_PLAN, approval },
          ),
        ).toEqual({
          state: "known",
          failed: [{ lens: "pass-sec-access", phase: "sweep", why: "failed", errors: ["boom"] }],
        });
    });

    it("is never satisfied by the same lens completing in the plan phase", () => {
      expect(
        failedSecurityRows(
          [...DELTA_PLAN, row("pass-sec-access")],
          snapshot(3, [
            ...deltaDone,
            agent("pass-sec-access", "completed"),
            swept("pass-baseline", "completed"),
          ]),
          3,
          undefined,
          { plan: SWEEP_PLAN, approval: false },
        ),
      ).toEqual({
        state: "known",
        failed: [{ lens: "pass-sec-access", phase: "sweep", why: "not-run", errors: [] }],
      });
    });

    // The sweep runs before an approval only: a request for changes whose
    // sweep never launched is no gap, an approval whose sweep never ran is.
    it("an unlaunched sweep is named on an approval, not on another post", () => {
      const p = snapshot(3, deltaDone);
      expect(
        failedSecurityRows(DELTA_PLAN, p, 3, undefined, { plan: SWEEP_PLAN, approval: false }),
      ).toEqual({ state: "known", failed: [] });
      expect(
        failedSecurityRows(DELTA_PLAN, p, 3, undefined, { plan: SWEEP_PLAN, approval: true }),
      ).toEqual({
        state: "known",
        failed: [{ lens: "pass-sec-access", phase: "sweep", why: "not-run", errors: [] }],
      });
      expect(
        failedSecurityRows(DELTA_PLAN, undefined, 3, undefined, {
          plan: SWEEP_PLAN,
          approval: true,
        }).state,
      ).toBe("unknown");
      expect(
        failedSecurityRows(
          DELTA_PLAN,
          snapshot(3, [...deltaDone, swept("pass-sec-access", "completed")]),
          3,
          undefined,
          { plan: SWEEP_PLAN, approval: true },
        ),
      ).toEqual({ state: "known", failed: [] });
    });
  });

  it("is unknown, never an empty list, without this round's snapshot", () => {
    expect(failedSecurityRows(SEC_PLAN, undefined, 3).state).toBe("unknown");
    expect(
      failedSecurityRows(SEC_PLAN, snapshot(2, [agent("pass-sec-access", "failed")]), 3).state,
    ).toBe("unknown");
  });

  it("has nothing to say of a plan with no family row", () => {
    expect(failedSecurityRows(PLAN, undefined, 3)).toEqual({ state: "known", failed: [] });
    expect(failedSecurityRows(null, undefined, 3)).toEqual({ state: "known", failed: [] });
  });
});

describe("scripts/required-passes.py answers as the TypeScript rule does", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-required-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(CASES)("$name", ({ plan, progress, sweepPlan, expected }) => {
    const db = new Database(join(dir, "state.db"));
    db.exec(
      "CREATE TABLE rounds (id INTEGER PRIMARY KEY, pr INTEGER, round_no INTEGER, pass_plan TEXT, sweep_plan TEXT)",
    );
    // An older attempt of the same round number is never the one read.
    db.prepare("INSERT INTO rounds (pr, round_no, pass_plan) VALUES (5180, 3, ?)").run("[]");
    db.prepare("INSERT INTO rounds (pr, round_no, pass_plan) VALUES (5180, 3, ?)").run(
      plan ? JSON.stringify(plan) : null,
    );
    if (sweepPlan)
      db.prepare("UPDATE rounds SET sweep_plan = ? WHERE id = (SELECT MAX(id) FROM rounds)").run(
        JSON.stringify(sweepPlan),
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

describe("scripts/required-passes.py strips the tier suffixes the TypeScript ladder names", () => {
  // The shell copy cannot import PASS_TIER_ORDER, so its TIER_SUFFIX is a
  // hand-kept list; this pins it against the ladder both ways, by running the
  // script's own lens_for_agent over every tier (and a name that is no tier).
  // MUTATION: add a tier to PASS_TIER_ORDER (or drop "sol-high" from the
  // script's TIER_SUFFIX) — this fails.
  const script = join(root, "scripts", "required-passes.py");
  const agents = [
    ...PASS_TIER_ORDER.flatMap((t) => [`pass-sec-access--${t}`, `pass-baseline--${t}`]),
    "pass-baseline--sol-max",
    "pass-baseline",
    "pass-sec-exploit-chain--sol-high--sol-med",
  ];

  it("lens_for_agent answers as lensForAgent on every tier of the ladder", () => {
    const out = execFileSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util, json, sys",
          "spec = importlib.util.spec_from_file_location('rp', sys.argv[1])",
          "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          "print(json.dumps([m.lens_for_agent(a) for a in json.loads(sys.argv[2])]))",
        ].join("\n"),
        script,
        JSON.stringify(agents),
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(out)).toEqual(agents.map(lensForAgent));
  });

  it("names exactly the ladder's tiers, no more", () => {
    const src = readFileSync(script, "utf8");
    const alt = /TIER_SUFFIX = re\.compile\(r"--\(\?:([^)]*)\)\$"\)/.exec(src)?.[1];
    expect(alt, "TIER_SUFFIX not found in the script").toBeDefined();
    expect(alt!.split("|").sort()).toEqual([...PASS_TIER_ORDER].sort());
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
      usage: {},
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

  it("requeues a failed required sweep independently of completed delta evidence", async () => {
    const id = round(
      705,
      withPr(705, (n) =>
        snapshot(
          n,
          [
            Object.assign(agent("pass-baseline", "completed"), { phase: "plan" }),
            Object.assign(agent("pass-security", "completed"), { phase: "plan" }),
            Object.assign(agent("pass-security", "failed", TIMEOUT), { phase: "sweep" }),
          ],
          0,
        ),
      ),
    );
    store.setRoundMeta(id, { sweep_plan: [row("pass-security", true)] });
    await watcher().sweep();
    expect(status(id)).toBe("cancelled");
    expect(store.getPr(705)!.state).toBe("queued");
    expect(events("round_required_pass_missing")[0].missing).toContain("sweep pass-security");
    expect(store.reviewedHead(705)).toBeUndefined();
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
      usage: {},
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

  /** Spend the cap at one PR on rounds missing a required pass that failed
   * with `error`, then end one more such round, keyed and owned by its own
   * round command (what the transient class is proven against). */
  async function exhaustOn(pr: number, error: string): Promise<void> {
    const failedWith = (n: number) =>
      snapshot(
        n,
        [agent("pass-baseline", "completed"), agent("pass-security", "failed", error)],
        0,
      );
    const w = watcher();
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      round(pr, withPr(pr, failedWith));
      await w.sweep();
    }
    const id = round(pr, withPr(pr, failedWith));
    const roundNo = store.roundsFor(pr).length;
    store.stampPostingKey(id, roundPostingKey(pr, roundNo, "abc123"));
    store.createSessionCommand({
      id: `cmd-${pr}-${roundNo}`,
      pr,
      session: `pr-${pr}`,
      kind: "round",
      round_no: roundNo,
      payload_sha256: "a".repeat(64),
      payload_path: `/payload/cmd-${pr}.md`,
      inject_path: `/inject/cmd-${pr}.md`,
      next_check_at: clock.toISOString(),
    });
    await w.sweep();
    expect(status(id)).not.toBe("done");
  }

  // MUTATION: drop `|| mode === "required_pass_missing"` from selfRequeue's
  // persistent spend — every replacement's fanout renews the budget and a
  // sustained outage redoes full reviews for ever; this fails.
  it("a replacement's fanout does not renew the required-pass requeue budget", async () => {
    const w = watcher();
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      round(708, withPr(708, missing));
      await w.sweep();
      // The replacement started its passes: the general budget's generation resets.
      store.logEvent("round_fanout_started", 708, { head_sha: "abc123" });
    }
    expect(store.selfRequeueCount(708, "abc123")).toBe(0);
    const last = round(708, withPr(708, missing));
    await w.sweep();
    expect(events("round_self_requeued")).toHaveLength(DEFAULT_MAX_SELF_REQUEUES);
    expect(events("self_requeue_cap_exhausted")).toHaveLength(1);
    expect(status(last)).not.toBe("done");
  });

  // MUTATION: pass `undefined` as the cause on the required-pass exhaustion
  // in verdicts.ts — a provider outage that cost a lens waits for `u`; this fails.
  it("past the cap, a required pass the provider failed (rate limit) waits on the automatic retry", async () => {
    await exhaustOn(706, "429 Too Many Requests: rate limit exceeded");
    expect(store.openReviewFailure(706)).toMatchObject({
      stage: "round_deadline",
      next_action: "retry_wait",
    });
    expect(store.openReviewFailure(706)?.next_retry_at).not.toBeNull();
    expect(events("review_failed_loud").at(-1)).toMatchObject({ cause: "provider_transient" });
  });

  // MUTATION: treat every recorded pass failure as provider-transient — a
  // timed-out lens retries itself for ever without an operator; this fails.
  it("past the cap, a required pass that timed out or failed otherwise stays the operator's", async () => {
    await exhaustOn(707, TIMEOUT);
    expect(store.openReviewFailure(707)).toMatchObject({
      stage: "round_deadline",
      next_action: "operator_unwedge",
      next_retry_at: null,
    });
  });
});

describe("parsePlan", () => {
  it("treats an array with non-object rows as unreadable", async () => {
    const { parsePlan } = await import("../src/requiredpasses.js");
    expect(parsePlan("[null]")).toBeNull();
    expect(parsePlan('[{"lens":"pass-baseline","required":true}]')).toHaveLength(1);
  });
});
