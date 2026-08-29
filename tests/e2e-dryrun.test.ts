// End-to-end dry-run fixture round (step 6, offline half).
//
// A fixture PR + fixture findings are driven through the real modules — agent
// build → anchor validation → payload assembly → the real GitHubAdapter with a
// dry-run MutationGate — and the assertions are the two that matter before
// cutover: the would-be review payload lands in state/dryrun/, and **not one
// HTTP request is made**.
//
// The live half of the acceptance criterion (a designated test PR with
// dry_run = false) is a GitHub mutation and is deferred to the VM cutover
// — it cannot and must not run here.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { MutationGate } from "../src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import { TokenMinter } from "../src/githubAuth.js";
import { StateStore } from "../src/state.js";
import { buildAgents } from "../src/include.js";
import { assembleReview, approvalActions, submitReview, type Finding } from "../src/posting.js";
import { selectLenses } from "../src/heuristics.js";

const SANDBOX = join(import.meta.dirname, "..");

// ---- the fixture PR ------------------------------------------------------

const PR = {
  number: 4242,
  title: "fix(webhooks): stop dropping retries on 5xx",
  head_sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f000112233",
  files: [
    { filename: "backend/flowdesk/flowdesk/api/webhooks.py", additions: 18, deletions: 4 },
    { filename: "backend/flowdesk/flowdesk/api/test/test_webhooks.py", additions: 40, deletions: 0 },
  ],
};

const PATCHES: Record<string, string> = {
  "backend/flowdesk/flowdesk/api/webhooks.py": `@@ -30,7 +30,11 @@ async def deliver(payload):
     client = get_client()
-    resp = client.post(url, json=payload)
-    if resp.status_code >= 500:
-        return
+    resp = await client.post(url, json=payload)
+    if resp.status_code >= 500:
+        await schedule_retry(payload, attempt + 1)
+        return
+    log.info("delivered", extra={"payload": payload})
     return resp`,
};

const FINDINGS: Finding[] = [
  {
    severity: "P1",
    confidence: 0.92,
    path: "backend/flowdesk/flowdesk/api/webhooks.py",
    line: 33,
    side: "RIGHT",
    title: "retry attempt counter is unbounded",
    body: "`schedule_retry(payload, attempt + 1)` has no ceiling — a permanently 5xx endpoint retries forever.",
    lens: "pass-baseline",
  },
  {
    severity: "P2",
    confidence: 0.85,
    path: "backend/flowdesk/flowdesk/api/webhooks.py",
    line: 35,
    side: "RIGHT",
    title: "full payload logged",
    body: "`extra={\"payload\": payload}` puts the raw webhook body (auth headers included) into Datadog.",
    lens: "pass-security",
  },
  {
    severity: "P3",
    confidence: 0.4,
    path: "backend/flowdesk/flowdesk/api/webhooks.py",
    line: 999, // deliberately unanchorable — must be stripped into the body
    side: "RIGHT",
    title: "consider a jittered backoff",
    body: "Retries land in lockstep without jitter.",
    lens: "pass-delivery",
  },
];

// ---- harness -------------------------------------------------------------

let dir: string;
let fetchSpy: ReturnType<typeof vi.fn>;
let store: StateStore;

function harness(dryRun = true) {
  fetchSpy = vi.fn(async () => {
    throw new Error("no HTTP request may be made in a dry-run round");
  });
  const cfg = loadConfig(join(SANDBOX, "tests/fixtures/config.toml"));
  const minter = new TokenMinter(join(dir, "secrets"), fetchSpy as never);
  const gate = new MutationGate(dryRun, join(dir, "dryrun"), async () => {
    throw new Error("the executor must not run in dry-run");
  });
  const adapter = new GitHubAdapter(cfg, minter, gate, fetchSpy as never);
  return { cfg, adapter, gate };
}

function dryrunFiles(): Array<Record<string, any>> {
  const d = join(dir, "dryrun");
  return readdirSync(d)
    .sort()
    .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-e2e-"));
  store = new StateStore(":memory:");
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dry-run fixture round", () => {
  // Live-only tripwire: the assembled public snapshot has no
  // config.toml (adopters start from config.example.toml, dry_run = true),
  // so the pin self-skips there — same discipline as tests/config.test.ts.
  it.skipIf(!existsSync(join(SANDBOX, "config.toml")))(
    "has dry_run false in the committed config — LIVE since the 2026-08-14 cutover",
    () => {
      // Deliberately reads the LIVE config.toml (rule 1): the production flag is
      // the owner's alone, and this pin is the tripwire against an accidental
      // flip. Every other test in this file runs on tests/fixtures/config.toml
      // so operator identity edits never redden the suite.
      expect(loadConfig(join(SANDBOX, "config.toml")).dry_run).toBe(false);
    },
  );

  it("builds the round's agent variant definitions with includes expanded", () => {
    const { cfg } = harness();
    const out = join(dir, "agents");
    const built = buildAgents(join(SANDBOX, "agents"), out, {
      root: SANDBOX,
      tiers: cfg.models.tiers,
      riskPasses: cfg.models.risk_passes,
      validateTier: cfg.models.validate_tier,
    });
    const lenses = [...selectLenses(PR.files), "pass-validate"];

    for (const lens of lenses) {
      const variants = built.filter((b) => b.name.startsWith(`${lens}--`));
      expect(variants.length, `${lens} must have at least one tier variant`).toBeGreaterThan(0);
      for (const agent of variants) {
        const text = readFileSync(agent.output, "utf8");
        expect(text).not.toContain("{{include:");
        expect(text).toContain("FINDINGS <lens> PR#<n>"); // the shared output contract
        expect(text).toMatch(/^model: openai-codex\/gpt-5\.6-(sol|terra)$/m); // spec split into model+thinking
        expect(text).toMatch(/^thinking: (medium|high)$/m);
        expect(text).toContain("## Execution policy"); // no-exec addendum on every variant
      }
    }
  });

  it("writes the would-be REQUEST_CHANGES review to the dry-run dir and makes zero fetches", async () => {
    const { adapter } = harness();
    const review = assembleReview({
      pr: PR.number,
      head_sha: PR.head_sha,
      verdict: "REQUEST_CHANGES",
      lenses: [...selectLenses(PR.files), "pass-validate"],
      patches: PATCHES,
      findings: FINDINGS,
    });

    const out = await submitReview({ adapter, store }, review);

    expect(out.result.executed).toBe(false);
    expect(out.needs_backfill).toBe(true);

    const [recorded, ...rest] = dryrunFiles();
    expect(rest).toHaveLength(0);
    expect(recorded).toMatchObject({
      kind: "create_review",
      method: "POST",
      path: `/repos/example-org/example-app/pulls/${PR.number}/reviews`,
      pr: PR.number,
    });
    expect(recorded!.body.event).toBe("REQUEST_CHANGES");
    expect(recorded!.body.commit_id).toBe(PR.head_sha);
    // two anchored findings inline, the unanchorable one stripped to the body
    expect(recorded!.body.comments).toHaveLength(2);
    expect(recorded!.body.comments[0].body).toContain("[blocker] retry attempt counter is unbounded");
    expect(recorded!.body.comments[1].body).toContain("[blocker] full payload logged"); // P2 @ 0.85 ≥ 0.8
    expect(recorded!.body.body).toContain("consider a jittered backoff");
    expect(recorded!.body.body).toContain("### Additional findings (not posted inline)");

    expect(fetchSpy).not.toHaveBeenCalled();
    // nothing was registered in the bot registry: there are no real ids yet
    expect(store.isBotComment(1)).toBe(false);
  });

  it("records the whole APPROVE path — review + both trigger clears — as intents only", async () => {
    const { adapter, cfg } = harness();
    const review = assembleReview({
      pr: PR.number,
      head_sha: PR.head_sha,
      verdict: "APPROVE",
      lenses: ["pass-baseline", "pass-validate"],
      patches: PATCHES,
      findings: [],
    });

    for (const action of approvalActions({ pr: PR.number, payload: review.payload, trigger_label: cfg.github.trigger_label })) {
      await action.run(adapter);
    }

    const kinds = dryrunFiles().map((f) => f.kind);
    expect(kinds).toEqual(["create_review", "remove_label", "delete_team_review_request"]);
    expect(dryrunFiles()[0]!.body.event).toBe("APPROVE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("only ever records intents from the allowed mutation set", async () => {
    const { adapter } = harness();
    const review = assembleReview({
      pr: PR.number,
      head_sha: PR.head_sha,
      verdict: "NEEDS_HUMAN",
      lenses: ["pass-baseline"],
      patches: PATCHES,
      findings: FINDINGS.slice(0, 1),
      needs_human_reasons: ["cannot confirm the backfill is bounded"],
      ai_approved: true,
    });
    await submitReview({ adapter, store }, review);

    const recorded = dryrunFiles();
    expect(recorded[0]!.body.event).toBe("COMMENT");
    expect(recorded[0]!.body.body).toContain("### Start here");
    // The gate's kind union has no review-retraction member; assert the
    // recorded intents stay inside the set the posting path may emit.
    const allowed = new Set(["create_review", "remove_label", "delete_team_review_request", "create_review_comment_reply"]);
    for (const intent of recorded) expect(allowed.has(intent.kind)).toBe(true);
  });
});
