// the proof round: the operator watches a real PR of theirs get
// reviewed, and reads the review out of the dry-run record before anything
// could ever post.
//
// Everything faked: one routed fake ProcessRunner stands in for every
// `docker compose` call (ps, `qcr why --json` in the container, listing and
// reading the dry-run directory), and sleep is instant — no test waits on
// wall-clock time and no test starts a container.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
  type ProcessRunner,
  type StepContext,
} from "../src/onboard/engine.js";
import { CHOICE_KEYS } from "../src/onboard/steps/configfill.js";
import { setTomlKey } from "../src/onboard/steps/ingress.js";
import { stackTransportFor, type StackTransport } from "../src/onboard/steps/transport.js";
import {
  PROOF_CHOICE_KEY,
  PROOF_STEP_ID,
  classifyRounds,
  parseProofRecord,
  parseWhy,
  proofRoundStep,
  readContainerDryrun,
  renderReview,
} from "../src/onboard/steps/proof.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-proof-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "config.toml"),
    setTomlKey(exampleConfig, "github", "repo", "acme/web")!,
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A transport built the way the steps build one: through THE decision point,
 * which reads the recorded topology. `{}` ⇒ the compose transport. */
function transportFor(runner: ProcessRunner, choices: Record<string, unknown>): StackTransport {
  const ctx = {
    adapters: {
      fetch: (() => {
        throw new Error("no network in tests");
      }) as unknown as typeof fetch,
      runner,
      clock: () => new Date("2026-08-30T12:00:00Z"),
      host: { nodeVersion: "v22.5.1", uid: 1000 },
      paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    },
    input: {},
    choices,
    data: {},
    recordChoice: () => undefined,
  } satisfies StepContext;
  return stackTransportFor(ctx);
}

function seedChoices(choices: Record<string, unknown>): void {
  mkdirSync(join(root, "state", "onboarding"), { recursive: true });
  writeFileSync(
    join(root, "state", "onboarding", "checklist.json"),
    JSON.stringify({
      version: 1,
      created_at: "2026-08-30T10:00:00Z",
      updated_at: "2026-08-30T10:00:00Z",
      completed_at: null,
      choices,
      steps: {},
    }),
  );
}

interface Round {
  round_no: number;
  status: string;
  verdict: string | null;
  summary?: string | null;
  started_at?: string;
}

const REVIEW_RECORD = {
  recorded_at: "2026-08-30T11:58:00.000Z",
  kind: "create_review",
  method: "POST",
  path: "/repos/acme/web/pulls/17/reviews",
  pr: 17,
  note: "review for #17",
  body: {
    event: "REQUEST_CHANGES",
    body: "Two blockers.\n\n### For a human to double-check\n- the migration ordering",
    commit_id: "abc123",
    comments: [{ path: "src/api.ts", line: 42, body: "[blocker] this drops the tenant filter" }],
  },
};
const LABEL_RECORD = {
  recorded_at: "2026-08-30T11:50:00.000Z",
  kind: "add_label",
  method: "POST",
  path: "/repos/acme/web/issues/17/labels",
  pr: 17,
  note: "in-progress label",
};

interface Harness {
  engine: OnboardingEngine;
  calls: string[][];
  logs: string[];
}

function harness(
  o: {
    /** One entry per poll; the last repeats. */
    whyRounds?: Round[][];
    whyKnown?: boolean;
    whyCode?: number;
    whyStdout?: string;
    dryrun?: Record<string, unknown>[];
    dryrunListCode?: number;
    daemonRunning?: boolean;
    pollAttempts?: number;
  } = {},
): Harness {
  const calls: string[][] = [];
  const logs: string[] = [];
  let poll = 0;
  const runner = {
    run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
      calls.push([cmd, ...args]);
      if (args.includes("ps")) {
        const rows = (o.daemonRunning ?? true) ? [{ Service: "daemon", State: "running" }] : [];
        return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (args.includes("why")) {
        if (o.whyCode) return { code: o.whyCode, stdout: "", stderr: "Error: no such container" };
        if (o.whyStdout !== undefined) return { code: 0, stdout: o.whyStdout, stderr: "" };
        const sequence = o.whyRounds ?? [
          [{ round_no: 1, status: "done", verdict: "REQUEST_CHANGES", summary: "two blockers" }],
        ];
        const rounds = sequence[Math.min(poll, sequence.length - 1)] ?? [];
        poll += 1;
        return {
          code: 0,
          stdout: JSON.stringify({ pr: 17, known: o.whyKnown ?? true, state: "reviewing", rounds }),
          stderr: "",
        };
      }
      if (args.includes("ls")) {
        if (o.dryrunListCode)
          return { code: o.dryrunListCode, stdout: "", stderr: "ls: no such directory" };
        const names = (o.dryrun ?? [LABEL_RECORD, REVIEW_RECORD]).map(
          (_, i) => `2026-08-30T11-5${i}-00-000Z-000${i}-rec.json`,
        );
        return { code: 0, stdout: `${names.join("\n")}\n`, stderr: "" };
      }
      if (args.includes("cat")) {
        const path = args[args.length - 1]!;
        const index = Number(/-000(\d)-rec\.json$/.exec(path)?.[1] ?? -1);
        const records = o.dryrun ?? [LABEL_RECORD, REVIEW_RECORD];
        const rec = records[index];
        return rec
          ? { code: 0, stdout: JSON.stringify(rec), stderr: "" }
          : { code: 1, stdout: "", stderr: "no such file" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    },
  };
  const adapters: OnboardAdapters = {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    log: (line) => logs.push(line),
  };
  const step = proofRoundStep({
    pollAttempts: o.pollAttempts ?? 3,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  return { engine: new OnboardingEngine([step], adapters), calls, logs };
}

describe("reading the daemon's own state", () => {
  it("parseWhy is total and orders rounds", () => {
    expect(parseWhy("not json")).toBeNull();
    expect(parseWhy("null")).toBeNull();
    const obs = parseWhy(
      JSON.stringify({
        known: true,
        state: "reviewing",
        rounds: [
          { round_no: 2, status: "running" },
          { round_no: 1, status: "done", verdict: "APPROVE" },
          "junk",
        ],
      }),
    )!;
    expect(obs.rounds.map((r) => r.round_no)).toEqual([1, 2]);
  });

  it("classifyRounds follows the LAST round", () => {
    expect(classifyRounds({ known: false, state: null, rounds: [] }).kind).toBe("waiting");
    expect(classifyRounds({ known: true, state: "queued", rounds: [] })).toMatchObject({
      kind: "waiting",
      detail: expect.stringContaining("not started a round"),
    });
    expect(
      classifyRounds({
        known: true,
        state: "reviewing",
        rounds: [{ round_no: 1, status: "running", verdict: null, summary: null, started_at: "" }],
      }).kind,
    ).toBe("running");
    expect(
      classifyRounds({
        known: true,
        state: "x",
        rounds: [
          { round_no: 1, status: "done", verdict: "APPROVE", summary: null, started_at: "" },
        ],
      }).kind,
    ).toBe("done");
    expect(
      classifyRounds({
        known: true,
        state: "x",
        rounds: [
          { round_no: 1, status: "cancelled", verdict: null, summary: null, started_at: "" },
        ],
      }).kind,
    ).toBe("failed");
  });

  it("readContainerDryrun lists then reads, through docker compose exec, ignoring non-JSON files", async () => {
    const seen: string[][] = [];
    const runner = {
      run: async (_cmd: string, args: string[]): Promise<ProcessResult> => {
        seen.push(args);
        if (args.includes("ls"))
          return {
            code: 0,
            stdout: "a-0000-rec.json\nb-0001-rec.json\nnot-json.txt\n",
            stderr: "",
          };
        const path = args[args.length - 1]!;
        return {
          code: 0,
          stdout: JSON.stringify(path.includes("0000") ? LABEL_RECORD : REVIEW_RECORD),
          stderr: "",
        };
      },
    };
    const read = await readContainerDryrun(transportFor(runner, {}));
    expect(read.problem).toBe("");
    expect(read.records.map((r) => r.kind)).toEqual(["add_label", "create_review"]);
    expect(seen[0]).toEqual([
      "compose",
      "--project-directory",
      root,
      "exec",
      "-T",
      "daemon",
      "ls",
      "-1",
      "/opt/quickreview/state/dryrun",
    ]);
    // not-json.txt was never read.
    expect(seen).toHaveLength(3);
  });
});

describe("asking for the PR", () => {
  it("with no PR number it says exactly what to do, and that nothing can post", async () => {
    const h = harness();
    const result = await h.engine.runStep(PROOF_STEP_ID);
    expect(result.ok).toBe(false);
    const ask = result.checks[0]!.detail;
    expect(ask).toMatch(/acme\/web/);
    expect(ask).toMatch(/"AI review requested"/);
    expect(ask).toMatch(/Nothing will be posted to GitHub/);
    // Nothing was watched, because nothing was labelled yet.
    expect(h.calls.some((c) => c.includes("why"))).toBe(false);
  });

  it("refuses to watch when the daemon is not running, and names the bring-up step", async () => {
    const h = harness({ daemonRunning: false });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/run the bring-up step/);
  });
});

describe("following the round to completion", () => {
  it("polls until the verdict lands, then SHOWS the review from the dry-run record", async () => {
    const h = harness({
      whyRounds: [
        [],
        [{ round_no: 1, status: "running", verdict: null, started_at: "2026-08-30T11:55:00Z" }],
        [{ round_no: 1, status: "done", verdict: "REQUEST_CHANGES", summary: "two blockers" }],
      ],
    });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(true);
    const review = result.checks.find((c) => c.name === "review")!.detail;
    expect(review).toMatch(/Verdict it would have submitted: REQUEST_CHANGES/);
    expect(review).toMatch(/It was NOT posted/);
    expect(review).toMatch(/Two blockers\./);
    expect(review).toMatch(/src\/api\.ts:42/);
    expect(review).toMatch(/drops the tenant filter/);
    // The progress is visible while it waits, not a silent spinner.
    expect(h.logs.some((l) => l.includes("has not started a round yet"))).toBe(true);
    expect(h.logs.some((l) => l.includes("round 1 is running"))).toBe(true);
  });

  it("records the proof — the evidence the go-live step later demands", async () => {
    const h = harness();
    await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    const record = parseProofRecord(h.engine.choices()[PROOF_CHOICE_KEY])!;
    expect(record).toMatchObject({
      pr: 17,
      round_no: 1,
      verdict: "REQUEST_CHANGES",
      review_shown: true,
    });
  });

  it("says out loud that every intent was recorded and none executed", async () => {
    const h = harness();
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    const detail = result.checks.find((c) => c.name === "nothing-posted")!.detail;
    expect(detail).toMatch(/2 would-be GitHub calls were recorded/);
    expect(detail).toMatch(/none was executed/);
  });
});

describe("the two paths that actually happen", () => {
  it("TIMEOUT: it stops waiting and lists what to check, starting with the label spelling", async () => {
    const h = harness({ whyRounds: [[]], pollAttempts: 2 });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(false);
    const detail = result.failures.join(" ");
    expect(detail).toMatch(/no finished round for #17/);
    expect(detail).toMatch(/must be exactly "AI review requested"/);
    expect(detail).toMatch(/poll_interval_s/);
    expect(detail).toMatch(/verify_stack step/);
    expect(detail).toMatch(/running this step again picks the watch back up/);
  });

  it("ROUND FAILURE: a cancelled round is explained with the daemon's own diagnostics", async () => {
    const h = harness({
      whyRounds: [
        [{ round_no: 1, status: "cancelled", verdict: null, summary: "orphaned by a restart" }],
      ],
    });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(false);
    const detail = result.failures.join(" ");
    expect(detail).toMatch(/ended as "cancelled": orphaned by a restart/);
    expect(detail).toMatch(/events --tail 40/);
    expect(detail).toMatch(/boot-time orphan sweep/);
    expect(detail).toMatch(/tmux attach -t pr-17/);
  });

  it("an unreadable state store is red, and blames the right thing", async () => {
    const h = harness({ whyCode: 1 });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/could not read the daemon's state/);
    expect(result.failures.join(" ")).toMatch(/builds itself on first boot/);
  });

  it("a finished round with no recorded review points at dry_run first", async () => {
    const h = harness({ dryrun: [LABEL_RECORD] });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no recorded review for #17/);
    expect(result.failures.join(" ")).toMatch(/grep dry_run config\.toml/);
    expect(h.engine.choices()[PROOF_CHOICE_KEY]).toBeUndefined();
  });

  it("a review recorded BEFORE the finished round started is not shown as that round's output", async () => {
    // Round 1 posted a dry-run review at 11:58; the operator re-ran the step and
    // round 2 (started 12:10) finished without recording one. The 11:58 review
    // belongs to round 1 and must not certify round 2.
    const h = harness({
      whyRounds: [
        [
          {
            round_no: 1,
            status: "done",
            verdict: "REQUEST_CHANGES",
            started_at: "2026-08-30T11:55:00.000Z",
          },
          {
            round_no: 2,
            status: "done",
            verdict: "APPROVE",
            started_at: "2026-08-30T12:10:00.000Z",
          },
        ],
      ],
    });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no recorded review for #17/);
    expect(h.engine.choices()[PROOF_CHOICE_KEY]).toBeUndefined();
  });

  it("a review recorded during the finished round is shown and certifies it", async () => {
    const h = harness({
      whyRounds: [
        [
          {
            round_no: 1,
            status: "done",
            verdict: "REQUEST_CHANGES",
            started_at: "2026-08-30T11:55:00.000Z",
          },
        ],
      ],
    });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(true);
    // Only the round's own intents are counted (the 11:50 label predates it).
    expect(result.checks.find((c) => c.name === "nothing-posted")!.detail).toMatch(
      /^1 would-be GitHub call were recorded/,
    );
  });

  it("a missing dry-run directory is explained rather than crashed on", async () => {
    const h = harness({ dryrunListCode: 1 });
    const result = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/only exists once the gate has recorded/);
  });
});

describe("verify and resumability", () => {
  it("with no proof recorded, verify is red and says the wizard is not finished", async () => {
    const h = harness();
    const all = await h.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]!.failures.join(" ")).toMatch(/not finished until you have watched/);
  });

  it("re-verifies the recorded proof against the state store rather than trusting the file", async () => {
    seedChoices({
      [PROOF_CHOICE_KEY]: {
        pr: 17,
        round_no: 1,
        verdict: "APPROVE",
        completed_at: "2026-08-30T11:59:00Z",
        review_shown: true,
      },
    });
    const good = harness({ whyRounds: [[{ round_no: 1, status: "done", verdict: "APPROVE" }]] });
    expect((await good.engine.verifyAll()).ok).toBe(true);

    seedChoices({
      [PROOF_CHOICE_KEY]: {
        pr: 17,
        round_no: 9,
        verdict: "APPROVE",
        completed_at: "2026-08-30T11:59:00Z",
        review_shown: true,
      },
    });
    const stale = harness({ whyRounds: [[{ round_no: 1, status: "done", verdict: "APPROVE" }]] });
    const all = await stale.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]!.failures.join(" ")).toMatch(/no longer shows #17 round 9/);
  });

  it("does not ask twice: a re-run follows the PR it already recorded", async () => {
    seedChoices({
      [PROOF_CHOICE_KEY]: {
        pr: 17,
        round_no: 1,
        verdict: "APPROVE",
        completed_at: "2026-08-30T11:59:00Z",
        review_shown: true,
      },
    });
    const h = harness();
    const result = await h.engine.runStep(PROOF_STEP_ID);
    expect(result.ok).toBe(true);
    expect(h.calls.some((c) => c.includes("why") && c.includes("17"))).toBe(true);
  });

  it("parseProofRecord refuses anything that is not a complete proof", () => {
    expect(parseProofRecord(null)).toBeNull();
    expect(parseProofRecord({ pr: 17 })).toBeNull();
    expect(
      parseProofRecord({ pr: 0, round_no: 1, verdict: "APPROVE", completed_at: "x" }),
    ).toBeNull();
    expect(parseProofRecord({ pr: 17, round_no: 1, verdict: "", completed_at: "x" })).toBeNull();
    expect(
      parseProofRecord({ pr: 17, round_no: 1, verdict: "APPROVE", completed_at: "x" }),
    ).toMatchObject({ review_shown: false });
  });

  // the proof round is NOT a laptop-only step any more. It is one
  // implementation that runs over whichever transport the topology picked —
  // the dry-run record is read out of the daemon container either way.
  it("on the VM topology it reads the same dry-run record over ssh", async () => {
    const seen: string[][] = [];
    const runner = {
      run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
        seen.push([cmd, ...args]);
        if (args.join(" ").includes("ls -1"))
          return { code: 0, stdout: "a-0000-rec.json\n", stderr: "" };
        return { code: 0, stdout: JSON.stringify(LABEL_RECORD), stderr: "" };
      },
    };
    const read = await readContainerDryrun(
      transportFor(runner, { [CHOICE_KEYS.topology]: "vm", vm_ssh_alias: "review-box" }),
    );
    expect(read.problem).toBe("");
    expect(read.records.map((r) => r.kind)).toEqual(["add_label"]);
    expect(seen[0]![0]).toBe("ssh");
    // BatchMode on every hop: a prompt can never hang the wizard.
    expect(seen[0]!.join(" ")).toMatch(/-o BatchMode=yes/);
    expect(seen[0]!.join(" ")).toMatch(/review-box sudo docker exec quickreview-sandbox ls -1/);
  });
});

describe("rendering the review", () => {
  it("leads with the fact that it was not posted, then the verdict, body and every comment", () => {
    const text = renderReview(
      {
        source: "sandbox",
        state: "APPROVE",
        body: "Looks good.",
        comments: [{ path: "a.ts", line: 1, body: "[nit] spacing" }],
      },
      17,
    );
    expect(text.split("\n")[0]).toMatch(/review your reviewer produced for #17/);
    expect(text).toMatch(/dry_run is on/);
    expect(text).toMatch(/Verdict it would have submitted: APPROVE/);
    expect(text).toMatch(/--- inline comment 1: a\.ts:1 ---/);
  });

  it("an empty body says so rather than rendering blank", () => {
    expect(
      renderReview({ source: "sandbox", state: "COMMENT", body: "  ", comments: [] }, 3),
    ).toMatch(/\(empty body\)/);
  });
});
