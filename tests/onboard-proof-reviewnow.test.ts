// "Review this one PR now" — the proof round's own-trigger path
// (src/onboard/steps/proof.ts + the daemon's `review-now` operator command).
//
// One routed fake runner stands in for every `docker compose` call: `ps`, the
// ROOT exec that writes the command file into the sealed operator directory,
// the read of the daemon's receipt, `qcr why --json`, and the dry-run
// directory. A fake fetch serves the open-PR offer. Sleep is instant.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
} from "../src/onboard/engine.js";
import { setTomlKey } from "../src/onboard/steps/ingress.js";
import {
  PROOF_CHOICE_KEY,
  PROOF_STEP_ID,
  parsePrAnswer,
  proofRoundStep,
  renderReview,
  reviewNowWriteArgv,
} from "../src/onboard/steps/proof.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
const TOKEN = "gho_personTokenValue0123456789abcdef";

let root: string;
let secretsDir: string;

function seed(choices: Record<string, unknown>): void {
  mkdirSync(join(root, "state", "onboarding"), { recursive: true });
  writeFileSync(
    join(root, "state", "onboarding", "checklist.json"),
    JSON.stringify({
      version: 1,
      created_at: "2026-10-24T10:00:00Z",
      updated_at: "2026-10-24T10:00:00Z",
      completed_at: null,
      choices,
      steps: {},
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-reviewnow-"));
  secretsDir = join(root, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  let cfg = setTomlKey(exampleConfig, "github", "repo", "acme/web")!;
  cfg = setTomlKey(cfg, "github", "secrets_dir", secretsDir)!;
  writeFileSync(join(root, "config.toml"), cfg);
  writeFileSync(join(secretsDir, "github_token"), TOKEN, { mode: 0o600 });
  seed({ github_auth: "user", github_account_login: "dana-op", reviewed_repo: "acme/web" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Round {
  round_no: number;
  status: string;
  verdict: string | null;
  started_at?: string;
}

const REVIEW = {
  recorded_at: "2026-10-24T12:00:30.000Z",
  kind: "create_review",
  method: "POST",
  path: "/repos/acme/web/pulls/17/reviews",
  pr: 17,
  body: {
    event: "COMMENT",
    body: "**Verdict: REQUEST_CHANGES**\n\nOne blocker.",
    comments: [
      {
        path: "src/api.ts",
        line: 42,
        body: "[blocker] this drops the tenant filter\n\nmore detail",
      },
      { path: "src/db.ts", line: 7, body: "[nit] name" },
    ],
  },
};

interface Harness {
  engine: OnboardingEngine;
  calls: string[][];
  logs: string[];
  fetched: string[];
}

function harness(
  o: {
    whyRounds?: Round[][];
    whyState?: string[];
    receipt?: Record<string, unknown> | null;
    writeCode?: number;
    pollAttempts?: number;
  } = {},
): Harness {
  const calls: string[][] = [];
  const logs: string[] = [];
  const fetched: string[] = [];
  let poll = 0;
  const runner = {
    run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
      calls.push([cmd, ...args]);
      if (args.includes("ps"))
        return {
          code: 0,
          stdout: JSON.stringify([{ Service: "daemon", State: "running" }]),
          stderr: "",
        };
      const script = args.at(-1) ?? "";
      if (args.includes("-u") && args.includes("sh"))
        return {
          code: o.writeCode ?? 0,
          stdout: "",
          stderr: o.writeCode ? "permission denied" : "",
        };
      if (args.includes("sh") && script.includes("/results/")) {
        if (o.receipt === null) return { code: 0, stdout: "pending\n", stderr: "" };
        return {
          code: 0,
          stdout: JSON.stringify(o.receipt ?? { ok: true, pr: 17, state: "queued" }),
          stderr: "",
        };
      }
      if (args.includes("why")) {
        const seq = o.whyRounds ?? [[]];
        const i = Math.min(poll, seq.length - 1);
        const states = o.whyState ?? [];
        poll += 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            pr: 17,
            known: true,
            state: states[Math.min(i, states.length - 1)] ?? "tracked",
            rounds: seq[i],
          }),
          stderr: "",
        };
      }
      if (args.includes("ls"))
        return {
          code: 0,
          stdout: "2026-10-24T12-00-30-000Z-0001-create_review.json\n",
          stderr: "",
        };
      if (args.includes("cat")) return { code: 0, stdout: JSON.stringify(REVIEW), stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
    },
  };
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    fetched.push(`${url.pathname}${url.search}`);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`)
      return new Response("{}", { status: 401 });
    return new Response(
      JSON.stringify([
        {
          number: 21,
          title: "My change",
          user: { login: "dana-op" },
          updated_at: "2026-10-24T11:00:00Z",
        },
        {
          number: 17,
          title: "Add the tenant filter",
          user: { login: "teammate" },
          updated_at: "2026-10-24T10:00:00Z",
          draft: true,
        },
      ]),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const adapters: OnboardAdapters = {
    fetch: fetchFn,
    runner,
    clock: () => new Date("2026-10-24T12:00:00Z"),
    host: { nodeVersion: "v26.0.0", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    log: (line) => logs.push(line),
  };
  const step = proofRoundStep({
    pollAttempts: o.pollAttempts ?? 4,
    pollIntervalMs: 1,
    resultAttempts: 2,
    resultIntervalMs: 1,
    sleep: async () => undefined,
  });
  return { engine: new OnboardingEngine([step], adapters), calls, logs, fetched };
}

describe("picking the PR", () => {
  it("with no PR, offers the five most recently updated open PRs — the person's own marked", async () => {
    const h = harness();
    const r = await h.engine.runStep(PROOF_STEP_ID);
    expect(r.ok).toBe(false);
    const ask = r.failures.join("\n");
    expect(ask).toMatch(/#21 My change — by dana-op \(yours\)/);
    expect(ask).toMatch(/#17 Add the tenant filter \(draft\) — by teammate/);
    expect(ask).toMatch(/nothing to add to the PR/);
    expect(h.fetched).toEqual([
      "/repos/acme/web/pulls?state=open&sort=updated&direction=desc&per_page=5",
    ]);
    // Nothing was asked of the daemon yet.
    expect(h.calls.some((c) => c.includes("-u"))).toBe(false);
  });

  it("takes a number, #n, or the PR's URL — and refuses a URL into another repo", async () => {
    expect(parsePrAnswer(17)).toEqual({ pr: 17, repo: null });
    expect(parsePrAnswer("#17")).toEqual({ pr: 17, repo: null });
    expect(parsePrAnswer("https://github.com/acme/web/pull/17/files")).toEqual({
      pr: 17,
      repo: "acme/web",
    });
    expect(parsePrAnswer("seventeen")).toBeNull();
    const h = harness();
    const r = await h.engine.runStep(PROOF_STEP_ID, {
      url: "https://github.com/other/thing/pull/3",
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(
      /pull request in other\/thing, but this reviewer reviews acme\/web/,
    );
  });
});

describe("the review starts immediately", () => {
  it("writes ONE review-now command as root into the sealed operator directory", () => {
    const argv = reviewNowWriteArgv("2026-10-24T12-00-00-000Z-onboard-reviewnow-17.json", 17);
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv[2]).toContain(`'{"command":"review-now","pr":17}'`);
    expect(argv[2]).toContain("/opt/qcr/commands/operator");
    expect(argv[2]).toContain("chown -h 0:0 .");
    expect(() => reviewNowWriteArgv("x.json", 1.5)).toThrow();
  });

  it("follows only a round NEWER than the request, then shows the review at a glance", async () => {
    const h = harness({
      whyRounds: [
        // before the request: an old, finished round on an earlier head
        [{ round_no: 1, status: "done", verdict: "APPROVE", started_at: "2026-10-01T00:00:00Z" }],
        [{ round_no: 1, status: "done", verdict: "APPROVE", started_at: "2026-10-01T00:00:00Z" }],
        [
          { round_no: 1, status: "done", verdict: "APPROVE", started_at: "2026-10-01T00:00:00Z" },
          { round_no: 2, status: "running", verdict: null, started_at: "2026-10-24T12:00:10Z" },
        ],
        [
          { round_no: 1, status: "done", verdict: "APPROVE", started_at: "2026-10-01T00:00:00Z" },
          {
            round_no: 2,
            status: "done",
            verdict: "REQUEST_CHANGES",
            started_at: "2026-10-24T12:00:10Z",
          },
        ],
      ],
      whyState: ["tracked", "queued", "reviewing", "tracked"],
    });
    const r = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    // The command went in as uid 0, through docker compose exec.
    const write = h.calls.find((c) => c.includes("-u"))!;
    expect(write.slice(write.indexOf("exec"), write.indexOf("exec") + 5)).toEqual([
      "exec",
      "-T",
      "-u",
      "0",
      "daemon",
    ]);
    expect(
      h.logs.some((l) => /asked the daemon to review #17 now .* no label needed/.test(l)),
    ).toBe(true);
    const review = r.checks.find((c) => c.name === "review")!.detail;
    expect(review.split("\n")[0]).toMatch(/It was NOT posted/);
    expect(review).toMatch(/Verdict it would have submitted: COMMENT/);
    expect(review).toMatch(/Verdict on the merits: REQUEST_CHANGES/);
    expect(review).toMatch(/Inline comments: 2/);
    expect(review).toMatch(/1\. src\/api\.ts:42 — \[blocker\] this drops the tenant filter$/m);
    expect(review).toMatch(
      /Full text: state\/dryrun\/2026-10-24T12-00-30-000Z-0001-create_review\.json/,
    );
    expect(review).toMatch(/docker compose exec daemon cat \/opt\/qcr\/state\/dryrun\//);
    expect(h.engine.choices()[PROOF_CHOICE_KEY]).toMatchObject({
      pr: 17,
      round_no: 2,
      verdict: "REQUEST_CHANGES",
    });
  });

  it("a daemon that refuses the command is red with its reason, and the label named as the fallback", async () => {
    const h = harness({ receipt: { ok: false, reason: "PR #17 is closed" } });
    const r = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/refused to review #17 now: PR #17 is closed/);
    expect(r.failures.join(" ")).toMatch(/add the label "AI review requested"/);
  });

  it("the daemon settling the PR with no new round shows the standing review of that head", async () => {
    const done = [
      { round_no: 3, status: "done", verdict: "APPROVE", started_at: "2026-10-24T11:00:00Z" },
    ];
    const h = harness({ whyRounds: [done], whyState: ["tracked"] });
    const r = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(h.logs.some((l) => /reviewed nothing new/.test(l))).toBe(true);
    expect(r.checks.find((c) => c.name === "round")!.detail).toMatch(
      /round 3 finished with verdict APPROVE/,
    );
  });

  it("a request with no receipt follows anyway, and the timeout says it was asked for directly", async () => {
    const h = harness({ receipt: null, whyRounds: [[]], pollAttempts: 2 });
    const r = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(r.ok).toBe(false);
    expect(h.logs.some((l) => /could not ask the daemon directly/.test(l))).toBe(true);
    expect(r.failures.join(" ")).toMatch(/no finished round for #17/);
  });

  it("a PR already queued or reviewing is followed, not asked for twice", async () => {
    const h = harness({
      whyRounds: [
        [],
        [{ round_no: 1, status: "done", verdict: "APPROVE", started_at: "2026-10-24T12:00:10Z" }],
      ],
      whyState: ["queued", "tracked"],
    });
    const r = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(r.ok, r.failures.join("; ")).toBe(true);
    expect(h.calls.some((c) => c.includes("-u"))).toBe(false);
  });

  it("a LIVE installation asks first, and only an explicit yes sends the review", async () => {
    writeFileSync(
      join(root, "config.toml"),
      readFileSync(join(root, "config.toml"), "utf8").replace(
        /^dry_run = true/m,
        "dry_run = false",
      ),
    );
    const h = harness();
    const r = await h.engine.runStep(PROOF_STEP_ID, { pr: 17 });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/LIVE .* POSTS the review to GitHub/);
    expect(h.calls.some((c) => c.includes("-u"))).toBe(false);
    await h.engine.runStep(PROOF_STEP_ID, { pr: 17, confirm_live: "yes" });
    expect(h.calls.some((c) => c.includes("-u"))).toBe(true);
  });
});

describe("rendering", () => {
  it("lists the top five findings and says how many more follow", () => {
    const comments = Array.from({ length: 7 }, (_, i) => ({
      path: `f${i}.ts`,
      line: i + 1,
      body: `finding ${i}`,
    }));
    const text = renderReview({ source: "sandbox", state: "APPROVE", body: "ok", comments }, 5);
    expect(text).toMatch(/5\. f4\.ts:5 — finding 4/);
    expect(text).not.toMatch(/6\. f5\.ts/);
    expect(text).toMatch(/… and 2 more, below/);
  });
});
