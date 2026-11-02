// The security family's round prompt and task files
// (packages/pi-plugin/src/templates.ts, packages/pi-plugin/src/passtasks.ts):
// `{{chain_note}}` tells the session to compose this round's security leads
// after the wave, `{{security_fold_note}}` to post an unproven security
// candidate as a question, the validator note to validate security
// candidates at the risk tier; a chain row's task file carries its strategy
// in its name and its `Strategy:` line, a family row's task the threat model
// and the facts, and the chain's `compose` row is never written beside the
// discovery rows. Every note is "" on an order without its field, so a
// round that plans no security row renders as before.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { DJANGO_ECOSYSTEM } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";
import { CHAIN_PASS } from "@quickchatai/pi-quickreview/src/passes.js";
import {
  PRIOR_CHAIN_LEADS_HEADING,
  passTaskFileName,
  renderPassTask,
  renderPassTaskNote,
  renderPassTasks,
  writePassTasks,
} from "@quickchatai/pi-quickreview/src/passtasks.js";
import { buildRoundOrder, postOrderOf } from "@quickchatai/pi-quickreview/src/planner.js";
import {
  SECURITY_FACTS_HEADING,
  type SecurityFact,
} from "@quickchatai/pi-quickreview/src/secfacts.js";
import {
  renderChainNote,
  renderGateNotes,
  renderRoundPrompt,
  renderSecurityFoldNote,
  renderValidatorShardNote,
  securityPassIncompleteLine,
} from "@quickchatai/pi-quickreview/src/templates.js";
import {
  parseThreatModel,
  renderThreatModelExcerpt,
} from "@quickchatai/pi-quickreview/src/threatmodel.js";
import type { PassPlanEntry, RoundOrder } from "@quickchatai/pi-quickreview/src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = resolve(process.cwd());
const TEMPLATES = [
  "round-first.md",
  "round-follow-up.md",
  "round-re-review.md",
  "round-staleness.md",
];
const template = (t: string): string => readFileSync(join(ROOT, "prompts", t), "utf8");

const chainRow = (
  strategy: PassPlanEntry["strategy"],
  extra: Partial<PassPlanEntry> = {},
): PassPlanEntry => ({
  lens: CHAIN_PASS,
  agent: `${CHAIN_PASS}--sol-high`,
  tier: "sol-high",
  raisable_to: [],
  why: `${strategy}: a guard was removed`,
  strategy,
  ...extra,
});
const ACCESS: PassPlanEntry = {
  lens: "pass-sec-access",
  agent: "pass-sec-access--sol-high",
  tier: "sol-high",
  raisable_to: [],
  why: "an object is fetched by an id from the request",
};
const BASELINE: PassPlanEntry = {
  lens: "pass-baseline",
  agent: "pass-baseline--sol-med",
  tier: "sol-med",
  raisable_to: [],
  required: true,
};
const VALIDATE: PassPlanEntry = {
  lens: "pass-validate",
  agent: "pass-validate--sol-med",
  tier: "sol-med",
  raisable_to: [],
};

const threatModel = parseThreatModel("## Entry points\n- `app/api/**`\n", "repo");
const FACT: SecurityFact = {
  check: "route-inventory",
  status: "unknown",
  lens: "pass-sec-authn-coverage",
  detail: "the repository could not be listed",
};
const PARTIAL = "L1 app/views.py:3 → L2 app/repo.py:9 (two hops unproven)";

/** A hand-built order: the fields a task and the notes read. */
function order(over: Partial<RoundOrder> = {}): RoundOrder {
  return {
    pr: 42,
    title: "Unguard the export view",
    round_id: 1,
    round_no: 1,
    round_type: "first",
    lenses: [],
    pass_plan: [
      BASELINE,
      ACCESS,
      chainRow("delta", { required: true }),
      chainRow("forward"),
      VALIDATE,
    ],
    addable_lenses: [],
    migration_gate: false,
    head_sha: "abc123",
    base_ref: "main",
    base_sha: "def456",
    merge_base: "0f0f0f",
    worktree: "/srv/wt/pr-42",
    pr_body: "Opens the export to every user.",
    settled_digest: "",
    issued_at: "2026-11-01T00:00:00Z",
    ...over,
  } as RoundOrder;
}

const SECURITY = {
  threat_model: { source: "repo" as const, hash: threatModel.hash },
  threat_model_excerpt: renderThreatModelExcerpt(threatModel),
  security_facts: [FACT],
  prior_partial_chains: [PARTIAL],
};

// ---- the round templates ---------------------------------------------------------

describe("the round templates", () => {
  /**
   * MUTATION: remove `{{chain_note}}` from prompts/round-staleness.md — this
   * fails.
   */
  it("carry {{chain_note}} after the coverage note, at the end of step 2, in all four", () => {
    for (const t of TEMPLATES)
      expect(template(t), t).toContain("{{intent_note}}{{coverage_note}}{{chain_note}}\n");
  });

  it("carry {{security_fold_note}} directly after the DOUBTED paragraph, in all four", () => {
    for (const t of TEMPLATES)
      expect(template(t), t).toContain(
        "a doubt is kept, never dropped.\n{{security_fold_note}}{{validator_note}}",
      );
  });

  it("ask for posted_as on a downgraded entry that went out, and show a security entry DOUBTED, never the fold's question", () => {
    for (const t of TEMPLATES) {
      const text = template(t);
      expect(text, t).toContain(
        "- `posted_as` on a `posted` entry **and on a `downgraded` entry that went out**",
      );
      expect(text, t).toContain("`security_outcome` and `hop_labels` are optional");
      // The record example stays valid JSON. Its security entry shows the
      // default shape — an unproven candidate DOUBTED `unverifiable` — never
      // the fold's `security-demoted` question, which only
      // {{security_fold_note}} shows, so a round with the fold off is never
      // taught to post one.
      // MUTATION: restore the `security-demoted`/`posted_as: "question"` f3
      // entry in prompts/round-first.md's record example — this fails.
      // The findings record is the example that carries comments_posted;
      // the verdict example before it is not JSON (`"APPROVE" | ...`).
      const example =
        /```json\n(\{\n {2}"pr": \{\{n\}\},\n {2}"round_no": \{\{round_no\}\},\n {2}"head_sha": "\{\{head_sha\}\}",\n {2}"comments_posted"[\s\S]*?\n\})\n```/.exec(
          text,
        )?.[1];
      expect(example, t).toBeDefined();
      const parsed = JSON.parse(
        example!.replace("{{n}}", "1").replace("{{round_no}}", "1").replace("{{head_sha}}", "x"),
      ) as { findings: Array<Record<string, unknown>> };
      expect(parsed.findings.find((f) => f.word === "security-demoted"), t).toBeUndefined();
      expect(parsed.findings.find((f) => f.lens === "pass-sec-access"), t).toMatchObject({
        disposition: "doubted",
        word: "unverifiable",
      });
      expect(text, t).not.toMatch(/"word": "security-demoted"/);
    }
  });
});

// ---- the notes -------------------------------------------------------------------

describe("renderChainNote", () => {
  it('is "" on an order with neither compose nor security-only', () => {
    expect(renderChainNote({})).toBe("");
    expect(renderChainNote(order())).toBe("");
  });

  it("with compose: collect the leads after the wave, ONE launch, CHAIN-SKIPPED without leads", () => {
    const post = [chainRow("compose", { stage: "post-discovery" })];
    const note = renderChainNote({
      chain_compose: true,
      post_plan: post,
      post_task_files: [
        {
          row: 0,
          agent: post[0]!.agent,
          path: "/s/passes/tasks-post/01-pass-sec-exploit-chain--sol-high@compose.md",
        },
      ],
    });
    expect(note).toContain("BEFORE step 3");
    expect(note).toContain("`CHAIN LEADS`");
    expect(note).toContain("`L1 <path:line> — <claim>`");
    expect(note).toContain(
      "`Task file: /s/passes/tasks-post/01-pass-sec-exploit-chain--sol-high@compose.md. Read it first; it is your complete task.`",
    );
    expect(note).toContain("ONE `subagent` call");
    expect(note).toContain("`CHAIN-SKIPPED no leads`");
    expect(note).toContain("never merge a chain\ninto one of its leads");
    expect(note).toContain("the same validator group");
    expect(note).toContain(securityPassIncompleteLine("<lens>"));
    expect(note).not.toContain("security only");
  });

  it("without a compose task file, the session writes the compose task with its Strategy line", () => {
    const note = renderChainNote({
      chain_compose: true,
      post_plan: [chainRow("compose", { stage: "post-discovery" })],
    });
    expect(note).toContain("`Strategy: compose`");
    expect(note).not.toContain("Task file:");
  });

  it("pairs a chain with its leads in the security validator group when there is one", () => {
    const note = renderChainNote({
      chain_compose: true,
      post_plan: [chainRow("compose", { stage: "post-discovery" })],
      security_validator_agent: "pass-validate--sol-high",
    });
    expect(note).toContain("the security group, at `pass-validate--sol-high`");
  });

  it("in a security-only review kills a non-security candidate out-of-scope", () => {
    const note = renderChainNote({ security_only: true });
    expect(note).toContain(
      "**This install reviews security only: a non-security candidate is killed\n`out-of-scope`.**",
    );
    expect(note).toContain(securityPassIncompleteLine("<lens>"));
    expect(note).not.toContain("CHAIN-SKIPPED");
  });

  it("names a failed row by the one fixed line, a chain row with its strategy", () => {
    expect(securityPassIncompleteLine("pass-sec-access")).toBe(
      "Security pass `pass-sec-access` did not complete; its area is unreviewed this round.",
    );
    expect(securityPassIncompleteLine(CHAIN_PASS, "delta")).toBe(
      "Security pass `pass-sec-exploit-chain:delta` did not complete; its area is unreviewed this round.",
    );
  });
});

describe("renderSecurityFoldNote", () => {
  it('is "" without the fold', () => {
    expect(renderSecurityFoldNote({})).toBe("");
  });

  it("posts a security-demoted candidate as a question, recorded with its tag", () => {
    const note = renderSecurityFoldNote({ security_fold: true });
    expect(note).toContain("NOT doubted");
    expect(note).toContain("`### For a human to double-check`");
    expect(note).toContain("proof gap");
    expect(note).toContain('`"disposition": "downgraded"`, `"word": "security-demoted"`');
    expect(note).toContain('`"posted_as": "question"`');
  });
});

describe("the validator note's security group", () => {
  it("is absent without security_validator_agent: one shard renders nothing, as before", () => {
    expect(renderValidatorShardNote(order())).toBe("");
    const sharded = renderValidatorShardNote(order({ validator_shards: 3 }));
    expect(sharded.startsWith("\n**Validator in 3 parallel groups.**")).toBe(true);
    expect(sharded).not.toContain("risk tier");
  });

  it("validates the security candidates as their own group, in the same call", () => {
    const note = renderValidatorShardNote(
      order({ security_validator_agent: "pass-validate--sol-high" }),
    );
    expect(note.startsWith("\n**Security candidates are validated at the risk tier.**")).toBe(true);
    expect(note).toContain("`pass-validate--sol-high`");
    expect(note).toContain("SAME `subagent` call");
    expect(note).toContain("every exploit chain with\nevery lead it cites");
  });

  it("follows the shard note as its own paragraph when both apply", () => {
    const note = renderValidatorShardNote(
      order({ validator_shards: 2, security_validator_agent: "pass-validate--sol-high" }),
    );
    expect(note).toContain(
      "summed counts.\n\n**Security candidates are validated at the risk tier.**",
    );
    expect(note).toContain("planned `pass-validate` variant's groups");
  });

  it("is absent with no validator row", () => {
    const noValidator = order({
      pass_plan: [BASELINE, ACCESS],
      security_validator_agent: "pass-validate--sol-high",
    });
    expect(renderValidatorShardNote(noValidator)).toBe("");
  });
});

// ---- the task files ----------------------------------------------------------------

describe("a security row's task", () => {
  it("names a chain row's strategy in its file name; every other row keeps its name", () => {
    const files = renderPassTasks(order(), "").map((t) => t.file);
    expect(files).toEqual([
      "01-pass-baseline--sol-med.md",
      "02-pass-sec-access--sol-high.md",
      "03-pass-sec-exploit-chain--sol-high@delta.md",
      "04-pass-sec-exploit-chain--sol-high@forward.md",
    ]);
    expect(passTaskFileName(9, { agent: "pass-x--sol-med" })).toBe("10-pass-x--sol-med.md");
  });

  it("carries the threat model and the facts on a family row, and nothing new on any other", () => {
    const o = order(SECURITY);
    const access = renderPassTask(o, ACCESS, "", undefined, 1);
    expect(access).toContain("## Threat model\n\n" + SECURITY.threat_model_excerpt);
    expect(access).toContain(`## ${SECURITY_FACTS_HEADING}`);
    expect(access).toContain("`route-inventory` (pass-sec-authn-coverage): unknown");
    expect(access.indexOf("## Threat model")).toBeLessThan(access.indexOf(SECURITY_FACTS_HEADING));
    expect(access).not.toContain(PRIOR_CHAIN_LEADS_HEADING);
    expect(access).not.toContain("Strategy:");

    const baseline = renderPassTask(o, BASELINE, "", undefined, 0);
    expect(baseline).toBe(renderPassTask(order(), BASELINE, "", undefined, 0));
    expect(baseline).not.toContain("## Threat model");
    expect(baseline).not.toContain(SECURITY_FACTS_HEADING);
  });

  it("renders no empty section when there is no threat model and no facts", () => {
    const access = renderPassTask(order(), ACCESS, "", undefined, 1);
    expect(access).not.toContain("## Threat model");
    expect(access).not.toContain(SECURITY_FACTS_HEADING);
  });

  it("gives the chain's delta row its Strategy line and the earlier partial chains as UNCONFIRMED leads", () => {
    const o = order(SECURITY);
    const delta = renderPassTask(o, o.pass_plan[2]!, "", undefined, 2);
    expect(delta).toContain("## Your row of the plan\n\nStrategy: delta\n");
    expect(delta).toContain(`## ${PRIOR_CHAIN_LEADS_HEADING}`);
    expect(delta).toContain(`- UNCONFIRMED: ${PARTIAL}`);
    expect(delta.indexOf(SECURITY_FACTS_HEADING)).toBeLessThan(
      delta.indexOf(PRIOR_CHAIN_LEADS_HEADING),
    );

    const forward = renderPassTask(o, o.pass_plan[3]!, "", undefined, 3);
    expect(forward).toContain("Strategy: forward");
    expect(forward).not.toContain(PRIOR_CHAIN_LEADS_HEADING);
  });

  it("gives the compose row its Strategy line and says its leads follow the pointer", () => {
    const compose = chainRow("compose", { stage: "post-discovery" });
    const text = renderPassTask(order(SECURITY), compose, "");
    expect(text).toContain("Strategy: compose");
    expect(text).toContain("Your `CHAIN LEADS` are this round's security candidates");
    expect(text).not.toContain(PRIOR_CHAIN_LEADS_HEADING);
  });

  /**
   * MUTATION: drop the post-discovery filter in renderPassTasks (write the
   * compose row into `tasks/`) — this fails.
   */
  it("never renders a post-discovery row beside discovery rows; its own order renders it alone", () => {
    const compose = chainRow("compose", { stage: "post-discovery" });
    const stray = order({ pass_plan: [ACCESS, compose, VALIDATE] });
    expect(renderPassTasks(stray, "").map((t) => t.file)).toEqual([
      "01-pass-sec-access--sol-high.md",
    ]);
    const post = order({ pass_plan: [compose] });
    expect(renderPassTasks(post, "").map((t) => t.file)).toEqual([
      "01-pass-sec-exploit-chain--sol-high@compose.md",
    ]);
  });
});

describe("the task-file note", () => {
  it("keeps tasks-post out of the wave only when the order has post-discovery rows", () => {
    const files = [
      { row: 0, agent: BASELINE.agent, path: "/s/tasks/01-pass-baseline--sol-med.md" },
    ];
    const plain = renderPassTaskNote(order({ pass_task_files: files }));
    expect(plain).not.toContain("tasks-post");
    const withPost = renderPassTaskNote(
      order({
        pass_task_files: files,
        post_plan: [chainRow("compose", { stage: "post-discovery" })],
      }),
    );
    expect(withPost).toContain("Never pass `tasks-post/` to `launch_plan`");
    expect(withPost.replace(/\nNever pass `tasks-post\/`[^]*?has returned\./, "")).toBe(plain);
  });
});

// ---- through the planner: a real order -----------------------------------------------

const fixture: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

/** A guard taken away: authn-coverage and the chain's delta, with compose. */
const UNGUARDED: PrFileEntry = {
  filename: "app/views.py",
  additions: 0,
  deletions: 1,
  status: "modified",
  patch: "@@ -1,2 +1,1 @@\n context\n-@login_required",
};
const PLAIN: PrFileEntry = {
  filename: "app/totals.py",
  additions: 1,
  deletions: 0,
  status: "modified",
  patch: "@@ -1,1 +1,2 @@\n context\n+total = sum(row.amount for row in rows)",
};

function planned(cfg: Config, files: PrFileEntry[]): RoundOrder {
  return buildRoundOrder({
    cfg,
    row: { number: 7, head_sha: "c".repeat(40), title: "Unguard the export view" },
    files,
    roundId: 1,
    roundNo: 1,
    roundType: "first",
    worktree: "/wt",
    settledDigest: "",
    issuedAt: "2026-11-01T00:00:00Z",
  });
}

describe("a planned round", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * MUTATION: plan the compose row into the discovery plan (in planner.ts,
   * `post_plan.push({` → `pass_plan.push({` for compose) — this fails.
   * (Appending `order.post_plan` to renderPassTasks' rows alone does not:
   * the post-discovery filter, fenced above, still drops compose.)
   */
  it(
    "writes the chain's strategy rows into tasks/ and its compose row only into tasks-post/",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const o = planned(fixture, [UNGUARDED]);
      expect(o.post_plan?.map((r) => r.strategy)).toEqual(["compose"]);
      const dir = mkdtempSync(join(tmpdir(), "qcr-chain-note-"));
      dirs.push(dir);
      writePassTasks(join(dir, "tasks"), o, renderGateNotes(o, DJANGO_ECOSYSTEM));
      const tasks = readdirSync(join(dir, "tasks"));
      expect(tasks.some((f) => f.endsWith(`${CHAIN_PASS}--sol-high@delta.md`))).toBe(true);
      expect(tasks.some((f) => f.includes("@compose"))).toBe(false);
      const postOrder = postOrderOf(o, o.post_plan!);
      writePassTasks(
        join(dir, "tasks-post"),
        postOrder,
        renderGateNotes(postOrder, DJANGO_ECOSYSTEM),
      );
      expect(readdirSync(join(dir, "tasks-post"))).toEqual([
        `01-${CHAIN_PASS}--sol-high@compose.md`,
      ]);
    },
  );

  it(
    "renders both notes in every template only when the order carries their fields",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const plain = planned(fixture, [PLAIN]);
      const cfg: Config = { ...fixture, security: { ...fixture.security, fold: true } };
      const sec = planned(cfg, [UNGUARDED]);
      expect(sec.chain_compose).toBe(true);
      expect(sec.security_fold).toBe(true);
      for (const t of TEMPLATES) {
        const text = template(t);
        const off = renderRoundPrompt(text, plain);
        expect(off, t).not.toContain("CHAIN-SKIPPED");
        expect(off, t).not.toContain("The security fold");
        const on = renderRoundPrompt(text, sec);
        expect(on, t).toContain("`CHAIN-SKIPPED no leads`");
        expect(on, t).toContain("**The security fold — an unproven security candidate is asked");
      }
    },
  );
});
