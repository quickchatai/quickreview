// (docs/follow-up-rounds.md): the follow-up round template and its
// three daemon-rendered blocks. Round 1 and the full re-review must render
// exactly as before whatever follow-up fields an order carries; the follow-up
// template must render completely, with or without them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_TEMPLATE_FILE,
  placeholdersIn,
  renderDeltaNote,
  renderRoundPrompt,
  renderSweepNote,
  roundTemplateFile,
  roundVars,
  templateFileForOrder,
} from "../src/templates.js";
import type { PassPlanEntry, RoundDelta, RoundOrder, RoundType } from "../src/types.js";

const read = (file: string): string =>
  readFileSync(resolve(process.cwd(), "prompts", file), "utf8");

const PLAN: PassPlanEntry[] = [
  {
    lens: "pass-baseline",
    agent: "pass-baseline--sol-med",
    tier: "sol-med",
    raisable_to: ["pass-baseline--sol-high"],
  },
  {
    lens: "pass-validate",
    agent: "pass-validate--sol-med",
    tier: "sol-med",
    raisable_to: [],
  },
];

const SWEEP_PLAN: PassPlanEntry[] = [
  {
    lens: "pass-security",
    agent: "pass-security--sol-high",
    tier: "sol-high",
    raisable_to: [],
  },
  {
    lens: "pass-sweep",
    agent: "pass-sweep--sol-med",
    tier: "sol-med",
    raisable_to: [],
    focus: ["src/api/orders.py"],
  },
  { lens: "pass-validate", agent: "pass-validate--sol-med", tier: "sol-med", raisable_to: [] },
];

const base: RoundOrder = {
  pr: 412,
  title: "Add rate limiting",
  round_id: 9,
  round_no: 2,
  review_no: 2,
  round_type: "re-review",
  lenses: PLAN.map((p) => p.lens),
  pass_plan: PLAN,
  addable_lenses: ["pass-ui"],
  migration_gate: false,
  head_sha: "1111111111111111111111111111111111111111",
  base_ref: "master",
  base_sha: "basetip",
  merge_base: "forkpoint",
  worktree: "/sandbox/wt/pr-412",
  settled_digest: "",
  issued_at: "2026-10-08T10:00:00Z",
};

const DELTA: RoundDelta = {
  from_sha: "2222222222222222222222222222222222222222",
  tree: "3333333333333333333333333333333333333333",
  lines: 23,
  patch_file: "/sandbox/state/pr-412-round-2-delta.patch",
  files: [
    {
      path: "src/api/orders.py",
      status: "modified",
      ranges: [
        [12, 7],
        [40, 1],
        [77, 0],
      ],
    },
    { path: "src/api/new_name.py", old_path: "src/api/old_name.py", status: "renamed", ranges: [] },
    {
      path: "src/models.py",
      status: "modified",
      ranges: [[5, 2]],
      conflict: true,
      whole_file: true,
    },
  ],
};

const PRIOR_NOTE =
  "PRIOR FINDINGS TO VERIFY — 1 finding(s) posted in earlier rounds are still open (1 blocking).";

const followUp: RoundOrder = {
  ...base,
  scope: "delta",
  delta: DELTA,
  prior_findings_note: PRIOR_NOTE,
  sweep_plan: SWEEP_PLAN,
};

describe("templateFileForOrder — the one production template choice", () => {
  it("a delta-scope order renders from the follow-up template", () => {
    expect(templateFileForOrder({ round_type: "re-review", scope: "delta" })).toBe(
      FOLLOW_UP_TEMPLATE_FILE,
    );
    expect(FOLLOW_UP_TEMPLATE_FILE).toBe("round-follow-up.md");
  });

  it("every other order renders from its round type's template, as before", () => {
    for (const rt of ["first", "re-review", "staleness"] as RoundType[]) {
      expect(templateFileForOrder({ round_type: rt })).toBe(roundTemplateFile(rt));
      expect(templateFileForOrder({ round_type: rt, scope: "full" })).toBe(roundTemplateFile(rt));
    }
  });

  // Mutation: wire.ts back on roundTemplateFile(order.round_type) → this fails.
  it("wire.ts renders production orders through it", () => {
    const wire = readFileSync(resolve(process.cwd(), "src/wire.ts"), "utf8");
    expect(wire).toContain('join(root, "prompts", templateFileForOrder(order))');
    expect(wire).not.toContain("roundTemplateFile(order.round_type)");
  });
});

describe("round-follow-up.md renders completely", () => {
  const tpl = read(FOLLOW_UP_TEMPLATE_FILE);

  it("every placeholder it uses is one roundVars supplies", () => {
    const vars = roundVars(followUp);
    for (const name of placeholdersIn(tpl)) {
      // identity variables ride in through the default identity map
      expect(vars[name], name).toBeDefined();
    }
    for (const name of ["prior_findings_note", "delta_note", "sweep_note"])
      expect(placeholdersIn(tpl)).toContain(name);
  });

  it("with every follow-up field, no {{ remains and each block lands", () => {
    const out = renderRoundPrompt(tpl, followUp);
    expect(out).not.toContain("{{");
    expect(out).toContain(PRIOR_NOTE);
    expect(out).toContain("THE CHANGE SINCE THE LAST REVIEW");
    expect(out).toContain("PRE-APPROVAL SWEEP — owed this round.");
    expect(out).toContain("`pass-security--sol-high`");
    // The doc header and the fence markers never reach the model.
    expect(out).not.toContain("Sandbox file:");
    expect(out).not.toContain("RATIFIED");
  });

  it("without them (a degraded order), it still renders, and the blocks are empty", () => {
    const out = renderRoundPrompt(tpl, { ...base, scope: "delta" });
    expect(out).not.toContain("{{");
    expect(out).not.toContain("THE CHANGE SINCE THE LAST REVIEW");
    expect(out).not.toContain("PRE-APPROVAL SWEEP — owed");
  });

  it("the sweep sits in step 4b, before Decide, outside every fence", () => {
    const four = tpl.indexOf("## 4. Validate");
    const fourB = tpl.indexOf("## 4b. Pre-approval sweep");
    const five = tpl.indexOf("## 5. Decide");
    expect(four).toBeGreaterThan(-1);
    expect(fourB).toBeGreaterThan(four);
    expect(five).toBeGreaterThan(fourB);
    expect(tpl.lastIndexOf("{{sweep_note}}")).toBeGreaterThan(fourB);
    expect(tpl.lastIndexOf("{{sweep_note}}")).toBeLessThan(five);
    // No fence opens between 4b and Decide.
    expect(tpl.slice(fourB, five)).not.toMatch(/<!--\s*RATIFIED/);
  });

  it("states the sweep's three outcomes and the per-pass phase in step 7", () => {
    const flat = tpl.replace(/\s+/g, " ");
    const ret = flat.slice(flat.indexOf("## 7. Return"));
    expect(ret).toContain('"sweep": "ran" | "not_owed" | "not_reached"');
    expect(ret).toContain('"phase": "delta"');
    expect(ret).toContain("`sweep`, and `phase` on a `passes` entry");
    expect(ret).toContain('"prior": [');
    for (const s of ["fixed", "open", "conceded", "settled", "obsolete", "unverifiable"])
      expect(ret).toContain(`\`${s}\``);
  });

  it("the sweep runs only on the way to an approval, withheld included", () => {
    const flat = tpl.replace(/\s+/g, " ");
    const step = flat.slice(flat.indexOf("## 4b."), flat.indexOf("## 5. Decide"));
    expect(step).toContain("The decision would be REQUEST_CHANGES");
    expect(step).toContain("The sweep is **not reached**");
    expect(step).toContain("approval that will be withheld because CI is not green");
    expect(step).toContain("Launch **every row** of the sweep plan table in ONE assistant turn");
    expect(step).toContain("**whole PR**");
    expect(step).toContain("**do not re-raise**");
    expect(step).toContain("ONE `pass-validate` over the sweep's candidates");
  });

  it("the validator sees new candidates only, and every prior finding has an owner", () => {
    const flat = tpl.replace(/\s+/g, " ");
    expect(flat).toContain("this round's NEW candidates + the SETTLED list");
    expect(flat).toContain("otherwise `pass-baseline`, which is always planned for exactly this");
    expect(flat).toContain("No prior finding goes unassigned.");
    // The change bounds where a lens starts, never its charter.
    expect(flat).toContain("never NARROWS the lens's charter");
  });

  // "Only deltas get posted" means a requested change to the code; the
  // inter-round change is never called a delta in the prose.
  it("never calls the inter-round change a 'delta' in its own prose", () => {
    const body = tpl.replace(/^> [^\n]*\n/gm, "");
    const own = body
      .replace(/<!-- RATIFIED[\s\S]*?<!-- \/RATIFIED[^\n]*/g, "")
      .replace(/\{\{delta_note\}\}/g, "")
      .replace(/`nit-out-of-delta`/g, "")
      .replace(/"phase": "delta"/g, "")
      .replace(/`"delta"`/g, "")
      .replace(/\*\*Only deltas get posted\.\*\* Every posted item must assert a delta/, "");
    expect(own).not.toMatch(/\bdelta\b/i);
  });
});

describe("round 1 and the full re-review are untouched by the follow-up fields", () => {
  for (const rt of ["first", "re-review", "staleness"] as RoundType[]) {
    it(`${roundTemplateFile(rt)} renders byte-identically with or without them`, () => {
      const tpl = read(roundTemplateFile(rt));
      const plain = renderRoundPrompt(tpl, { ...base, round_type: rt });
      const carrying = renderRoundPrompt(tpl, {
        ...base,
        round_type: rt,
        scope: "full",
        delta: DELTA,
        prior_findings_note: PRIOR_NOTE,
        sweep_plan: SWEEP_PLAN,
      });
      expect(carrying).toBe(plain);
      for (const name of ["prior_findings_note", "delta_note", "sweep_note"])
        expect(placeholdersIn(tpl)).not.toContain(name);
    });
  }
});

describe("renderDeltaNote", () => {
  it("is empty without a delta", () => {
    expect(renderDeltaNote(undefined)).toBe("");
  });

  it("lists every file with its new-side ranges, the patch and the per-file command", () => {
    const note = renderDeltaNote(DELTA, "/sandbox/wt/pr-412");
    expect(note).toContain("3 file(s), 23 changed line(s)");
    expect(note).toContain("`src/api/orders.py` — modified, lines 12-18, 40, after 77");
    expect(note).toContain("`src/api/new_name.py` (from `src/api/old_name.py`) — renamed");
    expect(note).toContain("`src/models.py` — modified, whole file — **CONFLICT**");
    expect(note).toContain("against BOTH parents");
    expect(note).toContain("`/sandbox/state/pr-412-round-2-delta.patch`");
    expect(note).toContain(`\`git -C /sandbox/wt/pr-412 diff ${DELTA.tree} HEAD -- <path>\``);
    expect(note).toContain("base-branch merges and rebases are already taken out");
    expect(note).not.toMatch(/\bdelta\b(?!\.patch)/i);
  });

  it("an empty change says so rather than listing nothing", () => {
    const note = renderDeltaNote({ ...DELTA, files: [], lines: 0 });
    expect(note).toContain("no PR-owned file changed since the last review");
  });

  it("a path is contained as code, never markdown", () => {
    const note = renderDeltaNote({
      ...DELTA,
      files: [{ path: "a`b**c.py", status: "added", ranges: [[1, 3]] }],
    });
    expect(note).not.toContain("- a`b**c.py");
  });
});

describe("renderSweepNote", () => {
  it("is empty when no sweep is owed", () => {
    expect(renderSweepNote({})).toBe("");
    expect(renderSweepNote({ sweep_plan: [] })).toBe("");
  });

  it("renders the sweep plan as a plan table, focus column included", () => {
    const note = renderSweepNote({ sweep_plan: SWEEP_PLAN });
    expect(note).toContain("PRE-APPROVAL SWEEP — owed this round.");
    expect(note).toContain("| lens | subagent to call | tier | may raise to | focus / why |");
    expect(note).toContain("`pass-sweep--sol-med`");
    expect(note).toContain("files: `src/api/orders.py`");
    expect(note).not.toContain("task file");
  });

  it("names the full plan's unswept files, as round 1 does", () => {
    const note = renderSweepNote({ sweep_plan: SWEEP_PLAN, sweep_plan_unswept: ["src/far.py"] });
    expect(note).toContain("Not swept (over the per-round sweep cap): `src/far.py`.");
    expect(renderSweepNote({ sweep_plan: SWEEP_PLAN })).not.toContain("Not swept");
  });

  it("says START EARLY only for an early sweep; late and unset read as before", () => {
    const early = renderSweepNote({ sweep_plan: SWEEP_PLAN, sweep_start: "early" });
    expect(early).toContain("PRE-APPROVAL SWEEP — owed this round, START EARLY.");
    expect(early).toContain("SAME turn as step 2's discovery rows");
    expect(early).toContain("| lens | subagent to call | tier | may raise to | focus / why |");
    const late = renderSweepNote({ sweep_plan: SWEEP_PLAN, sweep_start: "late" });
    expect(late).toBe(renderSweepNote({ sweep_plan: SWEEP_PLAN }));
    expect(late).not.toContain("START EARLY");
  });

  it("the template carries the early path and the empty-candidate validator skip", () => {
    const t = read("round-follow-up.md");
    expect(t).toContain("**An early sweep launches here too.**");
    expect(t).toContain("**An early sweep is already done.**");
    expect(t).toContain("**Nothing to validate ⇒ no validator.**");
    expect(t).toContain("an early sweep shares\nstep 4's validator.");
  });

  it("names the sweep's task files when the daemon wrote them", () => {
    const note = renderSweepNote({
      sweep_plan: SWEEP_PLAN,
      sweep_task_files: [
        { row: 0, agent: "pass-security--sol-high", path: "/s/tasks/sweep/00-a.md" },
      ],
    });
    expect(note).toContain("| 1 | `pass-security--sol-high` | `/s/tasks/sweep/00-a.md` |");
  });

  it("launches the sweep through launch_plan: in step 2's call when early, alone when late", () => {
    const files = [{ row: 0, agent: "pass-security--sol-high", path: "/s/p/tasks-sweep/01-a.md" }];
    const early = renderSweepNote({
      sweep_plan: SWEEP_PLAN,
      sweep_task_files: files,
      sweep_start: "early",
    });
    expect(early).toContain("in `/s/p/tasks-sweep`");
    expect(early).toContain("rides step 2's ONE call");
    expect(early).toContain("`extra` keyed `sweep:*`");
    const late = renderSweepNote({ sweep_plan: SWEEP_PLAN, sweep_task_files: files });
    expect(late).toContain(
      '`launch_plan({ dirs: ["/s/p/tasks-sweep"], extra: { "sweep:*": … } })`',
    );
    expect(late).not.toContain("rides step 2's ONE call");
  });
});
