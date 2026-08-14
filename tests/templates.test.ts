import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnknownPlaceholderError,
  placeholdersIn,
  render,
  renderAddableLenses,
  renderConversationSystemPrompt,
  renderOverseerSystemPrompt,
  renderPassPlan,
  renderRoundPrompt,
  roundTemplateFile,
  roundVars,
} from "../src/templates.js";
import type { RoundOrder, RoundType } from "../src/types.js";

const order: RoundOrder = {
  pr: 412,
  title: "Add rate limiting",
  round_id: 7,
  round_no: 2,
  round_type: "re-review",
  lenses: ["pass-security", "pass-delivery", "pass-validate"],
  pass_plan: [
    { lens: "pass-security", agent: "pass-security--sol-high", tier: "sol-high", raisable_to: [] },
    {
      lens: "pass-delivery",
      agent: "pass-delivery--sol-med",
      tier: "sol-med",
      raisable_to: ["pass-delivery--sol-high"],
    },
    { lens: "pass-validate", agent: "pass-validate--terra-med", tier: "terra-med", raisable_to: [] },
  ],
  addable_lenses: ["pass-ui", "pass-contracts"],
  escalation_worthy: true,
  escalation_reasons: ["touches auth", "prod-risk"],
  migration_gate: true,
  head_sha: "deadbeef",
  worktree: "/sandbox/wt/pr-412",
  settled_digest: "T1: author fixed at abc123",
  issued_at: "2026-08-13T10:00:00Z",
};

describe("render", () => {
  it("substitutes known placeholders", () => {
    expect(render("PR #{{n}} — {{title}}", { n: "5", title: "x" })).toBe("PR #5 — x");
  });

  it("substitutes repeated and whitespace-padded placeholders", () => {
    expect(render("{{ n }}/{{n}}", { n: "9" })).toBe("9/9");
  });

  it("tolerates supplied values the template never uses", () => {
    expect(render("static", { n: "1", unused: "x" })).toBe("static");
  });

  it("throws on an unknown placeholder", () => {
    expect(() => render("{{n}} {{mystery}}", { n: "1" })).toThrow(UnknownPlaceholderError);
    expect(() => render("{{a}} {{b}}", {})).toThrow(/\{\{a\}\}, \{\{b\}\}/);
  });

  it("lists placeholders used by a template", () => {
    expect(placeholdersIn("{{n}} {{title}} {{n}}")).toEqual(["n", "title"]);
  });
});

describe("roundVars", () => {
  it("flattens a RoundOrder into template variables", () => {
    const v = roundVars(order);
    expect(v.n).toBe("412");
    expect(v.lenses).toBe("pass-security, pass-delivery, pass-validate");
    expect(v.escalation_criteria).toBe("touches auth; prod-risk");
    expect(v.pass_plan).toContain("| lens | subagent to call | tier | may raise to |");
    expect(v.pass_plan).toContain("| pass-security | `pass-security--sol-high` | sol-high | — (pinned) |");
    expect(v.pass_plan).toContain("| pass-delivery | `pass-delivery--sol-med` | sol-med | `pass-delivery--sol-high` |");
    expect(v.addable_lenses).toBe("pass-ui, pass-contracts");
    expect(v.migration_gate_note).toMatch(/MIGRATION GATE/);
    expect(v.settled_digest).toBe("T1: author fixed at abc123");
    expect(v.round_type).toBe("re-review");
  });

  it("uses placeholders for an empty settled digest and no gate", () => {
    const v = roundVars({ ...order, settled_digest: "  ", migration_gate: false, escalation_worthy: false, escalation_reasons: [] });
    expect(v.settled_digest).toBe("(nothing settled yet)");
    expect(v.migration_gate_note).toMatch(/no migration gate/);
    expect(v.escalation_criteria).toMatch(/none flagged/);
  });

  it("falls back when every known lens is already planned", () => {
    expect(roundVars({ ...order, addable_lenses: [] }).addable_lenses).toMatch(/none — every known lens/);
  });
});

describe("renderPassPlan / renderAddableLenses", () => {
  it("renders one table row per pass_plan entry, ladder ascending", () => {
    const table = renderPassPlan(order.pass_plan);
    const lines = table.split("\n");
    expect(lines).toHaveLength(2 + order.pass_plan.length);
    expect(lines[2]).toBe("| pass-security | `pass-security--sol-high` | sol-high | — (pinned) |");
    const terra = renderPassPlan([
      {
        lens: "pass-baseline",
        agent: "pass-baseline--terra-med",
        tier: "terra-med",
        raisable_to: ["pass-baseline--sol-med", "pass-baseline--sol-high"],
      },
    ]);
    expect(terra).toContain("`pass-baseline--sol-med`, `pass-baseline--sol-high`");
  });

  it("joins addable lenses and placeholders the empty case", () => {
    expect(renderAddableLenses(["pass-ui"])).toBe("pass-ui");
    expect(renderAddableLenses([])).toMatch(/none/);
  });
});

describe("renderRoundPrompt", () => {
  it("renders every documented round placeholder", () => {
    const tpl = [
      "round: {{round_type}} #{{round_no}}",
      "PR #{{n}} {{title}} @ {{head_sha}}",
      "worktree: {{worktree}}",
      "lenses: {{lenses}}",
      "escalation: {{escalation_criteria}}",
      "{{migration_gate_note}}",
      "SETTLED: {{settled_digest}}",
    ].join("\n");
    const out = renderRoundPrompt(tpl, order);
    expect(out).toContain("round: re-review #2");
    expect(out).toContain("PR #412 Add rate limiting @ deadbeef");
    expect(out).toContain("worktree: /sandbox/wt/pr-412");
    expect(out).not.toContain("{{");
  });

  it("throws when a round template invents a placeholder", () => {
    expect(() => renderRoundPrompt("{{n}} {{budget}}", order)).toThrow(UnknownPlaceholderError);
  });

  it("maps round types to template files", () => {
    expect(roundTemplateFile("first")).toBe("round-first.md");
    expect(roundTemplateFile("re-review")).toBe("round-re-review.md");
    expect(roundTemplateFile("staleness")).toBe("round-staleness.md");
  });
});

describe("shipped round templates", () => {
  const roundTypes: RoundType[] = ["first", "re-review", "staleness"];

  for (const rt of roundTypes) {
    const text = readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile(rt)), "utf8");

    it(`${roundTemplateFile(rt)} renders fully against a RoundOrder`, () => {
      const out = renderRoundPrompt(text, { ...order, round_type: rt });
      expect(out).not.toContain("{{");
      // The plan table and the addable list land in the prompt.
      expect(out).toContain("| lens | subagent to call | tier | may raise to |");
      expect(out).toContain("`pass-delivery--sol-med`");
      expect(out).toContain("pass-ui, pass-contracts");
    });

    it(`${roundTemplateFile(rt)} dispatches via the subagent tool, no bash fan-out, no spend_usd`, () => {
      // spend_usd is gone from the verdict contract — the daemon measures usage.
      expect(text).not.toContain("spend_usd");
      // Launch mechanism: the subagent tool, one turn; the bash fan-out is only
      // ever mentioned as forbidden.
      expect(text).toContain("`subagent` tool");
      expect(text).toMatch(/ONE assistant turn/);
      expect(text).toMatch(/no\n?`pi --no-session`/);
      // Raise/add protocols and the no-exec policy are stated.
      expect(text).toContain("Never lower a tier");
      expect(text).toContain("Never drop a planned lens");
      expect(text).toContain("No-exec policy");
      expect(text).toContain("{{addable_lenses}}");
      // Contained-scripts routine for GitHub work.
      expect(text).toContain("scripts/pr-context.sh {{n}}");
      expect(text).toContain("scripts/post-review.sh {{n}} <REQUEST_CHANGES|COMMENT> <body-file>");
      expect(text).toContain("scripts/reply-thread.sh {{n}} <comment-id> <body-file>");
      expect(text).toContain("scripts/approve-pr.sh");
    });
  }
});

describe("system prompts", () => {
  it("substitutes n/title/worktree in the conversation prompt", () => {
    const out = renderConversationSystemPrompt("shepherd for PR #{{n}} ({{title}}) at {{worktree}}", {
      pr: 3,
      title: "T",
      worktree: "/wt/pr-3",
    });
    expect(out).toBe("shepherd for PR #3 (T) at /wt/pr-3");
  });

  it("passes the overseer prompt through untouched", () => {
    expect(renderOverseerSystemPrompt("You are the overseer.")).toBe("You are the overseer.");
  });
});
