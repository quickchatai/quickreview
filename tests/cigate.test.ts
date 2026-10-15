// Red CI hard-gates APPROVE. The rule has three halves and each one
// is driven here through the real machinery it lives in: the pure classifier,
// the guard on the real MutationGate, and the `ci_completed` → re-queue path
// that keeps a withheld approval from becoming a stuck PR.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkOutcome,
  ciBlocksApproval,
  classifyCi,
  latestRunPerName,
  retryWithheldApproval,
  withheldApprovalNote,
  withholdApproval,
  type CheckSummary,
} from "../src/cigate.js";
import { parseConfig, GUARDS_DEFAULTS, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import { MutationGate, type GateResult, type MutationIntent } from "../src/gate.js";
import { makePostingGuard, type GuardAdapter } from "../src/guards.js";
import { GitHubAdapter, type PrFileEntry } from "../src/github.js";
import type { FetchFn, TokenMinter } from "../src/githubAuth.js";
import { reconcileOrphanedRounds } from "../src/reconcile.js";
import { StateStore } from "../src/state.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { applyInterpretation, interpretEvent } from "../src/webhook.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const BOT = cfg.github.bot_login;
const HEAD = "68b8040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "1111111111111111111111111111111111111111";

let store: StateStore;
let dryrunDir: string;

beforeEach(() => {
  store = new StateStore(":memory:");
  dryrunDir = mkdtempSync(join(tmpdir(), "qcr-cigate-"));
});
afterEach(() => {
  rmSync(dryrunDir, { recursive: true, force: true });
});

const run = (status: string, conclusion: string | null, name = "test"): CheckSummary => ({
  name,
  source: "check_run",
  status,
  conclusion,
});
const done = (conclusion: string, name = "test"): CheckSummary =>
  run("completed", conclusion, name);

// ---- the classifier --------------------------------------------------------

describe("checkOutcome — the one reading of a single check", () => {
  it("reads status and conclusion case-insensitively, as classifyCi does", () => {
    expect(checkOutcome(run("queued", null))).toBe("pending");
    expect(checkOutcome(run("COMPLETED", "SUCCESS"))).toBe("success");
    expect(checkOutcome(run("completed", "Neutral"))).toBe("inert");
    expect(checkOutcome(run("completed", "FAILURE"))).toBe("failed");
    expect(checkOutcome(run("completed", "cancelled"))).toBe("failed");
    // A commit status reports no check-run status: its conclusion decides.
    expect(
      checkOutcome({ name: "ci/legacy", source: "status", status: "", conclusion: "failure" }),
    ).toBe("failed");
    expect(classifyCi([run("completed", "FAILURE")])).toBe("red");
  });
});

describe("classifyCi", () => {
  it("is green only when everything finished and something really succeeded", () => {
    expect(classifyCi([done("success"), done("success", "lint")])).toBe("green");
    expect(classifyCi([done("success"), done("skipped", "docs")])).toBe("green");
  });

  it("is red on a failure", () => {
    expect(classifyCi([done("success"), done("failure", "unit")])).toBe("red");
  });

  it("treats infra shapes exactly like a failing test — no special-casing", () => {
    // None of these is an exception, however arguable each looks.
    for (const conclusion of [
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ])
      expect(classifyCi([done("success"), done(conclusion, "ci")])).toBe("red");
  });

  it("is red when every job was cancelled or skipped — nothing passed", () => {
    expect(classifyCi([done("skipped", "unit"), done("skipped", "lint")])).toBe("red");
    expect(classifyCi([done("cancelled", "unit"), done("skipped", "lint")])).toBe("red");
  });

  it("is pending while a check is still queued or running", () => {
    expect(classifyCi([done("success"), run("in_progress", null, "e2e")])).toBe("pending");
    expect(classifyCi([run("queued", null)])).toBe("pending");
  });

  it("reports `none` when no check exists at the head", () => {
    expect(classifyCi([])).toBe("none");
  });

  it("blocks approval on red and pending, never on green or an absent suite", () => {
    expect(ciBlocksApproval("red")).toBe(true);
    expect(ciBlocksApproval("pending")).toBe(true);
    expect(ciBlocksApproval("green")).toBe(false);
    // Nothing would ever turn green — blocking here would park the PR forever.
    expect(ciBlocksApproval("none")).toBe(false);
  });
});

// Only the MOST RECENT run of each check name counts — GitHub auto-cancels
// superseded runs, and their permanent cancelled husks would otherwise
// withhold every approval forever.
describe("latest-run-per-name", () => {
  const at = (c: CheckSummary, started_at: string): CheckSummary => ({ ...c, started_at });
  it("a cancelled husk beside a newer successful run of the same name is green", () => {
    expect(
      classifyCi([
        at(done("cancelled", "sync"), "2026-08-19T08:00:00Z"),
        at(done("cancelled", "sync"), "2026-08-19T08:05:00Z"),
        at(done("success", "sync"), "2026-08-19T08:10:00Z"),
        done("success", "unit"),
      ]),
    ).toBe("green");
  });
  it("a LATEST run that failed or was cancelled still blocks", () => {
    expect(
      classifyCi([
        at(done("success", "sync"), "2026-08-19T08:00:00Z"),
        at(done("cancelled", "sync"), "2026-08-19T08:10:00Z"),
      ]),
    ).toBe("red");
    expect(
      classifyCi([
        at(done("success", "unit"), "2026-08-19T08:00:00Z"),
        at(done("failure", "unit"), "2026-08-19T08:10:00Z"),
      ]),
    ).toBe("red");
  });
  it("a latest run still in progress is pending, not green off the older success", () => {
    expect(
      classifyCi([
        at(done("success", "sync"), "2026-08-19T08:00:00Z"),
        at(run("in_progress", null, "sync"), "2026-08-19T08:10:00Z"),
      ]),
    ).toBe("pending");
  });
  it("check-runs without started_at resolve by list position — later wins", () => {
    expect(classifyCi([done("cancelled", "sync"), done("success", "sync")])).toBe("green");
    expect(classifyCi([done("success", "sync"), done("cancelled", "sync")])).toBe("red");
  });
});

// The latest-run rule keys on the KIND the adapter stamps: only check-runs
// collapse, a status never does. Keying on the timestamp fails both ways. The
// adapter sets `started_at` on every check-run and on no commit status, so if
// an entry without a timestamp loses the name collision, a failing status
// under the same context as a passing check-run is masked; and if an
// untimestamped check-run collapses with a same-named status by list position,
// the status (listed last) wins, so a queued or failed null-start run plus a
// passing status reads green.
// Every row below is an input the real adapter produces, driven through the
// real adapter's own payload shapes.
describe("a same-named commit status is a second check, never a superseded run", () => {
  const TS = "2026-09-01T10:00:00Z";
  const minter = {
    appJwt: () => "jwt",
    installationToken: async () => "tok",
    invalidate: () => {},
  } as unknown as TokenMinter;

  /** The real `listChecks` over the two endpoints it reads, with GitHub's own
   * response shapes: check-runs carry `name`/`status`/`conclusion`/`started_at`,
   * the combined status carries `statuses[].context`/`state`. */
  async function adapterChecks(checkRuns: unknown[], statuses: unknown[]): Promise<CheckSummary[]> {
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      const payload = u.includes("/check-runs")
        ? { check_runs: checkRuns }
        : u.includes("/status")
          ? { state: "x", statuses }
          : null;
      if (payload === null) throw new Error(`unexpected ${u}`);
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    }) as unknown as FetchFn;
    const gate = new MutationGate(true, dryrunDir, async () => ({}));
    return new GitHubAdapter(cfg, minter, gate, fetchFn, "https://api.github.com").listChecks(HEAD);
  }
  const passingRun = { name: "ci", status: "completed", conclusion: "success", started_at: TS };
  const statusOf = (state: string, context = "ci") => ({ context, state });

  it.each([
    ["failure", "red"],
    ["error", "red"],
    ["pending", "pending"],
  ] as const)(
    "a %s commit status under a passing check-run's name reads %s, in both orders",
    async (state, expected) => {
      // The collision table, through the adapter: the two of them, the status
      // alone, and distinct names as the control that nothing else changed.
      const mixed = await adapterChecks([passingRun], [statusOf(state)]);
      expect(mixed).toHaveLength(2);
      expect(classifyCi(mixed)).toBe(expected);
      // The adapter always lists check-runs first; the classifier must not
      // depend on that, so the same summaries reversed must agree.
      expect(classifyCi([...mixed].reverse())).toBe(expected);
      expect(classifyCi(await adapterChecks([], [statusOf(state)]))).toBe(expected);
      expect(classifyCi(await adapterChecks([passingRun], [statusOf(state, "other")]))).toBe(
        expected,
      );
    },
  );

  it("a passing status beside a passing run of its name is still green — the fix admits only what is really there", async () => {
    expect(classifyCi(await adapterChecks([passingRun], [statusOf("success")]))).toBe("green");
  });

  it("the adapter stamps the kind — it is the only writer of `source`", async () => {
    const [runRow, statusRow] = await adapterChecks([passingRun], [statusOf("success")]);
    expect(runRow).toMatchObject({ name: "ci", source: "check_run", started_at: TS });
    expect(statusRow).toMatchObject({ name: "ci", source: "status" });
    expect("started_at" in statusRow!).toBe(false);
  });

  it("a check-run with a null started_at is never read as superseded by an older timestamped run", () => {
    // GitHub's schema makes started_at nullable on check-runs; the adapter
    // passes null through. "Unknown when" is not "older than everything".
    const queued: CheckSummary = {
      name: "ci",
      source: "check_run",
      status: "queued",
      conclusion: null,
      started_at: null,
    };
    const failed: CheckSummary = {
      name: "ci",
      source: "check_run",
      status: "completed",
      conclusion: "failure",
      started_at: null,
    };
    const passed: CheckSummary = { source: "check_run", ...passingRun };
    expect(classifyCi([passed, queued])).toBe("pending");
    expect(classifyCi([queued, passed])).toBe("pending");
    expect(classifyCi([passed, failed])).toBe("red");
    expect(classifyCi([failed, passed])).toBe("red");
  });

  it.each([
    ["queued", null, "pending"],
    ["completed", "failure", "red"],
  ] as const)(
    "a %s/%s check-run with a null started_at is never masked by a passing status of its name, in either order",
    async (status, conclusion, expected) => {
      // A timestamp-keyed rule would collapse an untimestamped check-run with a
      // same-named status by list position, and the adapter always lists
      // statuses after check-runs — so the status would win and the head read
      // green on the gate route while guards.sh said red.
      const nullStart = { name: "ci", status, conclusion, started_at: null };
      const mixed = await adapterChecks([nullStart], [statusOf("success")]);
      expect(mixed).toHaveLength(2);
      expect(classifyCi(mixed)).toBe(expected);
      expect(classifyCi([...mixed].reverse())).toBe(expected);
      // Control: distinct names answer the same, so nothing but the collapse changed.
      expect(classifyCi(await adapterChecks([nullStart], [statusOf("success", "other")]))).toBe(
        expected,
      );
    },
  );

  it("states the rule: only check-runs collapse (timed: latest start, equal → later; untimed: last per name); a status never does", () => {
    const a: CheckSummary = {
      name: "ci",
      source: "check_run",
      status: "completed",
      conclusion: "success",
      started_at: TS,
    };
    const b: CheckSummary = {
      name: "ci",
      source: "check_run",
      status: "completed",
      conclusion: "failure",
      started_at: TS,
    };
    const older: CheckSummary = {
      name: "ci",
      source: "check_run",
      status: "completed",
      conclusion: "cancelled",
      started_at: "2026-09-01T09:00:00Z",
    };
    const u1: CheckSummary = {
      name: "ci",
      source: "check_run",
      status: "completed",
      conclusion: "failure",
    };
    const u2: CheckSummary = {
      name: "ci",
      source: "check_run",
      status: "completed",
      conclusion: "success",
      started_at: "",
    }; // "" carries no time
    const s1: CheckSummary = {
      name: "ci",
      source: "status",
      status: "completed",
      conclusion: "failure",
    };
    const s2: CheckSummary = {
      name: "ci",
      source: "status",
      status: "completed",
      conclusion: "success",
    };
    // Equal start: the later list position wins, in either order.
    expect(latestRunPerName([a, b])).toEqual([b]);
    expect(latestRunPerName([b, a])).toEqual([a]);
    // A later start beats an earlier one wherever it sits in the list.
    expect(latestRunPerName([a, older])).toEqual([a]);
    expect(latestRunPerName([older, a])).toEqual([a]);
    // One timestamped survivor AND one untimestamped survivor per name, list order kept.
    expect(latestRunPerName([older, u1, a, u2])).toEqual([a, u2]);
    expect(latestRunPerName([u1, a])).toEqual([u1, a]);
    // Among untimestamped check-runs the last one wins.
    expect(latestRunPerName([u1, u2])).toEqual([u2]);
    expect(latestRunPerName([u2, u1])).toEqual([u1]);
    // A status is never collapsed: not with a timestamped run of its name, not
    // with an untimestamped one, not with another status — in either order.
    expect(latestRunPerName([a, s1])).toEqual([a, s1]);
    expect(latestRunPerName([s1, a])).toEqual([s1, a]);
    expect(latestRunPerName([u1, s2])).toEqual([u1, s2]);
    expect(latestRunPerName([s2, u1])).toEqual([s2, u1]);
    expect(latestRunPerName([s1, s2])).toEqual([s1, s2]);
    // The whole zoo at once: one timed survivor, one untimed survivor, every status.
    expect(latestRunPerName([older, s1, u1, a, u2, s2])).toEqual([s1, a, u2, s2]);
  });
});

// Zero checks at a head withholds approval too when the
// repo normally runs CI (conflicted PR / CI not started = no execution
// evidence). Off by default — a no-CI repo must never be wedged.
describe("no_checks_is_red", () => {
  it("none blocks approval only when the flag is on", () => {
    expect(ciBlocksApproval("none")).toBe(false);
    expect(ciBlocksApproval("none", { noChecksIsRed: false })).toBe(false);
    expect(ciBlocksApproval("none", { noChecksIsRed: true })).toBe(true);
    expect(ciBlocksApproval("green", { noChecksIsRed: true })).toBe(false);
    expect(ciBlocksApproval("red", { noChecksIsRed: false })).toBe(true);
  });
});

describe("the withheld note", () => {
  it("says both things the author needs: no blockers, and what it waits on", () => {
    const note = withheldApprovalNote("red", HEAD);
    expect(note).toContain("No blockers were found");
    expect(note).toContain("withheld");
    expect(note).toContain("green CI");
    expect(note).toContain(HEAD.slice(0, 7));
  });

  it("softens to COMMENT and never to REQUEST_CHANGES, keeping the findings", () => {
    const body = withholdApproval(
      { event: "APPROVE", body: "Looks good.", comments: [1] },
      "red",
      HEAD,
    );
    expect(body.event).toBe("COMMENT");
    expect(body.event).not.toBe("REQUEST_CHANGES");
    expect(body.body).toContain("Looks good.");
    expect(body.comments).toEqual([1]);
  });
});

// ---- the rule as the session reads it -------------------------------------

describe("the round templates carry the gate in their Decide step", () => {
  const templates = [
    "round-first.md",
    "round-re-review.md",
    "round-staleness.md",
    "round-follow-up.md",
  ];
  // Line wrapping differs between the three files; the rule does not.
  const read = (name: string): string =>
    readFileSync(resolve(process.cwd(), "prompts", name), "utf8").replace(/\s+/g, " ");

  it.each(templates)("%s states the rule above the findings mapping", (name) => {
    const text = read(name);
    const decide = text.slice(text.indexOf("## 5. Decide"));
    const gate = decide.indexOf("No green CI at this head makes APPROVE unavailable");
    expect(gate).toBeGreaterThan(-1);
    // "Above the findings mapping": before the severity map and before the
    // first `[blocker]` ⇒ REQUEST_CHANGES line.
    expect(gate).toBeLessThan(decide.indexOf("Posting map"));
    expect(gate).toBeLessThan(decide.indexOf("`[blocker]`"));
  });

  it.each(templates)(
    "%s prescribes a COMMENT with the approval withheld, and forbids blocking on red CI alone",
    (name) => {
      const decide = read(name);
      expect(decide).toContain("post the full review as a COMMENT with the approval withheld");
      expect(decide).toContain("no blockers were found");
      expect(decide).toContain("approval is withheld pending green CI");
      expect(decide).toContain("never **REQUEST_CHANGES** on red CI alone");
      // NEEDS_HUMAN is not a verdict: there is no third verdict to forbid.
      expect(decide).toContain("there is no third verdict");
    },
  );

  it.each(templates)(
    "%s defers to the pr-checks.sh CLASSIFIED verdict and the latest-run rule",
    (name) => {
      // A session re-deriving CI from the raw run list loops on cancelled
      // husks — the CLASSIFIED line (same table as classifyCi/guards.sh) is
      // the single verdict source.
      const text = read(name);
      expect(text).toContain("`CLASSIFIED:` line IS the CI verdict");
      expect(text).toContain("LATEST run of each check name");
      expect(text).toContain("[superseded — does not count]");
    },
  );

  it.each(templates)(
    "%s withholds on a zero-checks head, matching this repo's no_checks_is_red = true",
    (name) => {
      // A conflicted / CI-less head carries no execution
      // evidence. The code default stays exempt (a no-CI repo must never wedge);
      // the original deployment's config and templates both gate it.
      const text = read(name);
      expect(text).toContain("`CLASSIFIED: none`");
      expect(text).toContain("also withholds approval in this repo");
      expect(ciBlocksApproval("none")).toBe(false); // code default unchanged
      expect(ciBlocksApproval("none", { noChecksIsRed: true })).toBe(true);
    },
  );

  it.each(templates)(
    "%s treats infra, cancelled and skipped identically, and only ever READS CI",
    (name) => {
      const text = read(name);
      expect(text).toContain("blocks exactly like a failing test");
      expect(text).toContain("you never trigger, re-run or cancel");
      // Nothing in the templates asks for CI to be started or re-run.
      expect(text).not.toMatch(/gh (run|workflow) (rerun|run)/);
    },
  );
});

// ---- guard 4 on the real gate ---------------------------------------------

class FakeGuardAdapter implements GuardAdapter {
  pr = { state: "open" as "open" | "closed", merged: false, head_sha: HEAD, author: "alice" };
  checks: CheckSummary[] = [done("success")];
  failChecks = false;
  checkCalls = 0;

  async getPr(): Promise<{
    state: "open" | "closed";
    merged: boolean;
    head_sha: string;
    author: string;
  }> {
    return this.pr;
  }
  async listReviews(): Promise<
    Array<{ id: number; user: string; state: string; commit_id: string }>
  > {
    return [];
  }
  async listChecks(): Promise<CheckSummary[]> {
    this.checkCalls++;
    if (this.failChecks) throw new Error("GET /check-runs → 502");
    return this.checks;
  }
}

function harness(over: Partial<Config["guards"]> = {}): {
  gate: MutationGate;
  adapter: FakeGuardAdapter;
  executor: ReturnType<typeof vi.fn>;
} {
  const adapter = new FakeGuardAdapter();
  const executor = vi.fn(async () => ({ id: 900 }));
  const gate = new MutationGate(
    false,
    dryrunDir,
    executor as unknown as (i: MutationIntent) => Promise<unknown>,
  );
  gate.setGuard(
    makePostingGuard({ store, adapter, botLogin: BOT, guards: { ...GUARDS_DEFAULTS, ...over } }),
  );
  return { gate, adapter, executor };
}

function approveIntent(commitId = HEAD): MutationIntent {
  return {
    kind: "create_review",
    method: "POST",
    path: "/repos/o/r/pulls/5180/reviews",
    body: {
      commit_id: commitId,
      event: "APPROVE",
      body: "**Verdict: Approve** — nothing blocking.",
      comments: [],
    },
    note: "post APPROVE review on #5180",
    pr: 5180,
  };
}

function sentBody(executor: ReturnType<typeof vi.fn>): { event: string; body: string } {
  return (executor.mock.calls[0]![0] as MutationIntent).body as { event: string; body: string };
}

describe("guard 4 — no green CI at this head, no approval", () => {
  it("rewrites APPROVE to COMMENT and says why, keeping the review intact", async () => {
    const { gate, adapter, executor } = harness();
    adapter.checks = [done("failure", "unit")];

    const result = await gate.execute(approveIntent());

    expect(result.executed).toBe(true); // the review still reaches the author
    const body = sentBody(executor);
    expect(body.event).toBe("COMMENT");
    expect(body.body).toContain("**Verdict: Approve**");
    expect(body.body).toContain("No blockers were found");
    expect(body.body).toContain("green CI");
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_withheld_red_ci'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it("never produces REQUEST_CHANGES and never parks the PR", async () => {
    const { gate, adapter, executor } = harness();
    adapter.checks = [done("cancelled", "unit")];

    await gate.execute(approveIntent());

    expect(sentBody(executor).event).toBe("COMMENT");
    expect(store.getPr(5180)).toBeUndefined(); // no lifecycle event of any kind
  });

  it("withholds identically for an infra cancellation, a skipped suite and a pending run", async () => {
    for (const checks of [
      [done("cancelled")],
      [done("skipped"), done("skipped", "lint")],
      [run("in_progress", null)],
    ]) {
      // guard 2 is off here only so the three cases can share one store: each
      // posts at the same head, which is guard 2's own no-op case.
      const { gate, adapter, executor } = harness({ skip_unchanged_head: false });
      adapter.checks = checks;
      await gate.execute(approveIntent());
      expect(sentBody(executor).event).toBe("COMMENT");
    }
  });

  it("records the mark that the retry reads, at the head under review", async () => {
    const { gate, adapter } = harness();
    adapter.checks = [done("failure")];

    await gate.execute(approveIntent());

    expect(store.approvalWithheld(5180)).toMatchObject({
      head_sha: HEAD,
      ci_state: "red",
      reason: "red-ci",
    });
  });

  it("lets a green suite approve, and clears any older withholding", async () => {
    store.recordApprovalWithheld(5180, { head_sha: OLD, ci_state: "red" });
    const { gate, adapter, executor } = harness();
    adapter.checks = [done("success"), done("skipped", "docs")];

    await gate.execute(approveIntent());

    expect(sentBody(executor).event).toBe("APPROVE");
    expect(store.approvalWithheld(5180)).toBeUndefined();
  });

  it("blocks only what it can see: an unreadable checks API does not withhold", async () => {
    const { gate, adapter, executor } = harness();
    adapter.failChecks = true;

    await gate.execute(approveIntent());

    expect(sentBody(executor).event).toBe("APPROVE");
    expect(store.approvalWithheld(5180)).toBeUndefined();
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_ci_unreadable'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it("does not read CI for a REQUEST_CHANGES or COMMENT review", async () => {
    const { gate, adapter } = harness();
    await gate.execute({
      ...approveIntent(),
      body: { commit_id: HEAD, event: "REQUEST_CHANGES", body: "x" },
    });
    expect(adapter.checkCalls).toBe(0);
  });

  it("is a knob: block_approve_on_red_ci = false takes it out of the path", async () => {
    const { gate, adapter, executor } = harness({ block_approve_on_red_ci: false });
    adapter.checks = [done("failure")];

    await gate.execute(approveIntent());

    expect(sentBody(executor).event).toBe("APPROVE");
    expect(adapter.checkCalls).toBe(0);
  });
});

// ---- the retry: CI goes green, the PR is re-attempted ----------------------

class CiFake {
  checks: CheckSummary[] = [done("success")];
  fail = false;
  async listChecks(): Promise<CheckSummary[]> {
    if (this.fail) throw new Error("GET /check-runs → 502");
    return this.checks;
  }
}

function tracked(pr: number, head: string, state: "tracked" | "closed" = "tracked"): void {
  store.upsertPr({
    number: pr,
    state,
    head_sha: head,
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

describe("retryWithheldApproval — the promise the withheld note makes", () => {
  it("re-queues the PR when CI turns green at the withheld head", async () => {
    tracked(5180, HEAD);
    store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red", reason: "red-ci" });
    const adapter = new CiFake();

    const outcome = await retryWithheldApproval(
      { cfg, store, adapter },
      { pr: 5180, head_sha: HEAD, conclusion: "success" },
    );

    expect(outcome).toMatchObject({ action: "requeued", ci: "green" });
    expect(store.getPr(5180)?.state).toBe("queued");
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_retry_queued'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it("does nothing while CI is still red — the mark stands for the next completion", async () => {
    tracked(5180, HEAD);
    store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
    const adapter = new CiFake();
    adapter.checks = [done("failure")];

    const outcome = await retryWithheldApproval(
      { cfg, store, adapter },
      { pr: 5180, head_sha: HEAD, conclusion: "failure" },
    );

    expect(outcome).toMatchObject({ action: "noop", reason: "ci-not-green" });
    expect(store.getPr(5180)?.state).toBe("tracked");
    expect(store.approvalWithheld(5180)).toBeDefined();
  });

  it("ignores a PR with no withheld approval, and a completion at another head", async () => {
    tracked(5180, HEAD);
    expect(
      await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      ),
    ).toMatchObject({
      reason: "no-withheld-approval",
    });
    store.recordApprovalWithheld(5180, { head_sha: OLD, ci_state: "red" });
    expect(
      await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      ),
    ).toMatchObject({
      reason: "head-moved",
    });
  });

  // Reconcile asks with the mark's own head; the PR may have moved past it.
  // Green CI at the withheld head is no evidence for the head under review
  // now — the recheck carries the mark there when it upholds.
  it("does nothing when the PR's current head is not the withheld head", async () => {
    tracked(5180, HEAD);
    store.recordApprovalWithheld(5180, { head_sha: OLD, ci_state: "red" });
    const outcome = await retryWithheldApproval(
      { cfg, store, adapter: new CiFake() },
      { pr: 5180, head_sha: OLD },
    );
    expect(outcome).toMatchObject({ action: "noop", reason: "head-moved" });
    expect(store.getPr(5180)?.state).toBe("tracked");
  });

  it("re-checks the PR after the checks read — a push landing meanwhile requeues nothing", async () => {
    tracked(5180, HEAD);
    store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
    const adapter = {
      listChecks: async (): Promise<CheckSummary[]> => {
        tracked(5180, OLD);
        return [done("success")];
      },
    };
    const outcome = await retryWithheldApproval(
      { cfg, store, adapter },
      { pr: 5180, head_sha: HEAD },
    );
    expect(outcome).toMatchObject({ action: "noop", reason: "head-moved" });
    expect(store.getPr(5180)?.state).toBe("tracked");
  });

  // A round already queued or running decides the PR: no second requeue, and
  // no requeue reported (reconcile counts each report as a correction).
  it("reports no requeue for a PR whose round is already queued or running", async () => {
    for (const state of ["queued", "reviewing"] as const) {
      store.upsertPr({
        number: 5180,
        state,
        head_sha: HEAD,
        title: "PR 5180",
        author: "alice",
        trigger_ts: "2026-10-01T10:00:00.000Z",
        stale_recheck: 0,
        migration_gate: 0,
      });
      store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
      const outcome = await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      );
      expect(outcome).toMatchObject({ action: "noop", reason: "review-pending" });
      expect(store.getPr(5180)?.state).toBe(state);
    }
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_retry_queued'")
        .get(),
    ).toEqual({ c: 0 });
  });

  it("never touches a closed PR", async () => {
    tracked(5180, HEAD, "closed");
    store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
    expect(
      await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      ),
    ).toMatchObject({
      reason: "pr-not-open",
    });
  });

  it("upholds the withholding when the checks API cannot be read", async () => {
    tracked(5180, HEAD);
    store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
    const adapter = new CiFake();
    adapter.fail = true;

    expect(
      await retryWithheldApproval({ cfg, store, adapter }, { pr: 5180, head_sha: HEAD }),
    ).toMatchObject({
      reason: "ci-unreadable",
    });
    expect(store.getPr(5180)?.state).toBe("tracked");
  });

  it("falls back to the webhook's conclusion when the daemon has no checks read", async () => {
    tracked(5180, HEAD);
    store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });

    expect(
      await retryWithheldApproval(
        { cfg, store, adapter: {} },
        { pr: 5180, head_sha: HEAD, conclusion: "success" },
      ),
    ).toMatchObject({
      action: "requeued",
    });
  });
});

describe("the CI-completed trigger reaches the retry", () => {
  it("carries a green check suite from the webhook through to a queued PR", async () => {
    tracked(5180, HEAD);
    store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
    const i = interpretEvent(
      "check_suite",
      "completed",
      { check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [{ number: 5180 }] } },
      {
        botLogin: BOT,
        triggerLabel: cfg.github.trigger_label,
        reviewTeam: cfg.github.review_team,
        botCommentPr: () => undefined,
      },
    );
    expect(i.kind).toBe("ci_completed");

    await applyInterpretation(
      {
        cfg,
        store,
        // A stand-in for the daemon's onCiCompleted (src/daemon.ts), which
        // makes the same call per PR beside the recheck and pumps on a
        // requeue. This test pins the webhook → retry half only; the
        // daemon's own forwarding is not exercised here.
        onCiCompleted: async (ci) => {
          for (const pr of ci.prs)
            await retryWithheldApproval(
              { cfg, store, adapter: new CiFake() },
              {
                pr,
                head_sha: ci.head_sha,
                conclusion: ci.conclusion,
              },
            );
        },
      },
      i,
    );

    expect(store.getPr(5180)?.state).toBe("queued");
  });
});

// ---- and the re-queued PR really gets a round ------------------------------

class DispatchFake implements DispatchAdapter {
  async getPr(): Promise<{ base_ref: string }> {
    return { base_ref: "master" };
  }
  async listPrFiles(): Promise<PrFileEntry[]> {
    return [{ filename: "app/x.py", additions: 1, deletions: 0, status: "modified" }];
  }
  async addLabel(): Promise<GateResult> {
    return { executed: true };
  }
  async removeLabel(): Promise<GateResult> {
    return { executed: true };
  }
  async deleteTeamReviewRequest(): Promise<GateResult> {
    return { executed: true };
  }
  async createReview(): Promise<GateResult> {
    return { executed: true };
  }
}

function hooks(): { hooks: SessionHooks; orders: RoundOrder[] } {
  const orders: RoundOrder[] = [];
  return {
    orders,
    hooks: {
      async dispatchRound(order) {
        orders.push(order);
      },
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    },
  };
}

/** Back-date the reviewed-head stamp: it was written by a round before the
 * one under test, not in the same millisecond as its start. */
function stampedEarlier(pr: number): void {
  store.db
    .prepare("UPDATE reviewed_heads SET reviewed_at = ? WHERE pr = ?")
    .run("2026-01-01T00:00:00.000Z", pr);
}

describe("dispatch — a withheld approval is new evidence at the same head", () => {
  it(
    "runs the round the no-new-evidence guard would otherwise have skipped",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      tracked(5180, HEAD);
      store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
      // The last round decided APPROVE at this very head — guard 2's skip case.
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "APPROVE", round_no: 1 });
      await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      );
      const h = hooks();

      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new DispatchFake(),
        hooks: h.hooks,
      });

      expect(orders).toHaveLength(1);
      expect(orders[0]!.head_sha).toBe(HEAD);
      // Spent: the round about to run decides the verdict again from scratch.
      expect(store.approvalWithheld(5180)).toBeUndefined();
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_retry_dispatched'")
          .get(),
      ).toEqual({ c: 1 });
    },
  );

  // MUTATION: spend the mark before the handoff (right after the trigger
  // consumption) — the failed pump drops it and the next pump skips the head.
  it(
    "keeps the withholding when the dispatch fails before its handoff, so the next pump still retries",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      tracked(5180, HEAD);
      store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "APPROVE", round_no: 1 });
      await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      );
      const failing = new DispatchFake();
      failing.listPrFiles = async () => {
        throw new Error("files API 502");
      };
      const h = hooks();

      expect(await dispatchOnce({ cfg, store, adapter: failing, hooks: h.hooks })).toEqual([]);
      expect(store.approvalWithheld(5180)).toMatchObject({ head_sha: HEAD });
      expect(store.getPr(5180)?.state).toBe("queued");

      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new DispatchFake(),
        hooks: h.hooks,
      });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.head_sha).toBe(HEAD);
      expect(store.approvalWithheld(5180)).toBeUndefined();
    },
  );

  // MUTATION: drop restoreInterruptedApprovalRetry from dispatch — the
  // requeued round is skipped as no new evidence and the approval the
  // withheld note promised never posts.
  it(
    "a retry round a restart cancelled before it decided still owes the approval: the requeued round runs",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      tracked(5180, HEAD);
      store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "APPROVE", round_no: 1 });
      // The withheld COMMENT's stamp is from the earlier round.
      stampedEarlier(5180);
      await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      );
      const h = hooks();
      await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks });
      expect(store.approvalWithheld(5180)).toBeUndefined();

      // Restart before the session posted: the orphan sweep cancels the round
      // and requeues the PR at the same head.
      reconcileOrphanedRounds(store, [], {});
      expect(store.getPr(5180)?.state).toBe("queued");

      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new DispatchFake(),
        hooks: h.hooks,
      });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.head_sha).toBe(HEAD);
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_retry_restored'")
          .get(),
      ).toEqual({ c: 1 });
      // Spent again by the round that now owns it.
      expect(store.approvalWithheld(5180)).toBeUndefined();
    },
  );

  // MUTATION: drop the posted-nothing proof from restoreInterruptedApprovalRetry
  // — the retry round whose APPROVE went out is re-run past guard 2's daemon
  // half, and approve-pr.sh (no guard 2) approves a second time.
  it(
    "a retry round that may have posted is never restored: no second round, no second APPROVE",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const receipts = mkdtempSync(join(tmpdir(), "qcr-receipts-"));
      try {
        for (const posted of ["stamp", "receipt"] as const) {
          store.db.prepare("DELETE FROM approval_withheld").run();
          tracked(5180, HEAD);
          store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
          store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "APPROVE", round_no: 1 });
          stampedEarlier(5180);
          await retryWithheldApproval(
            { cfg, store, adapter: new CiFake() },
            { pr: 5180, head_sha: HEAD },
          );
          const h = hooks();
          await dispatchOnce({
            cfg,
            store,
            adapter: new DispatchFake(),
            hooks: h.hooks,
            postingReceiptDir: receipts,
          });
          expect(h.orders, posted).toHaveLength(1);
          const roundNo = h.orders[0]!.round_no;
          if (posted === "stamp")
            // approve-pr.sh confirmed its APPROVE and stamped the head.
            store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "APPROVE" });
          // A receipt still `prepared` (or unreadable) is unknown, never "not posted".
          else writeFileSync(join(receipts, `pr-5180-round-${roundNo}.json`), "{ not json");

          // Restart before the verdict file: the orphan sweep requeues the head.
          reconcileOrphanedRounds(store, [], {});
          const again = await dispatchOnce({
            cfg,
            store,
            adapter: new DispatchFake(),
            hooks: h.hooks,
            postingReceiptDir: receipts,
          });
          expect(again, posted).toEqual([]);
          expect(
            store.db
              .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_retry_restored'")
              .get(),
            posted,
          ).toEqual({ c: 0 });
        }
      } finally {
        rmSync(receipts, { recursive: true, force: true });
      }
    },
  );

  it(
    "a retry round that decided — or that guard 2 settled — owes nothing more",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      tracked(5180, HEAD);
      store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red" });
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "APPROVE", round_no: 1 });
      await retryWithheldApproval(
        { cfg, store, adapter: new CiFake() },
        { pr: 5180, head_sha: HEAD },
      );
      const h = hooks();
      await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks });
      const round = store.runningRounds()[0]!;
      store.markRoundCancelled(round.id, "guard 2", "no_new_evidence");
      store.upsertPr({
        ...store.getPr(5180)!,
        state: "queued",
        trigger_ts: "2026-08-18T11:00:00Z",
      });

      expect(
        await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks }),
      ).toEqual([]);
      expect(store.approvalWithheld(5180)).toBeUndefined();
    },
  );

  it(
    "still skips an unchanged head with no withholding standing",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      tracked(5180, HEAD);
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "APPROVE", round_no: 1 });
      store.upsertPr({
        number: 5180,
        state: "queued",
        head_sha: HEAD,
        title: "PR 5180",
        author: "alice",
        trigger_ts: "2026-08-18T10:00:00Z",
        stale_recheck: 0,
        migration_gate: 0,
      });
      const h = hooks();

      expect(
        await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks }),
      ).toEqual([]);
    },
  );
});
