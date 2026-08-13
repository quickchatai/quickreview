import { describe, expect, it } from "vitest";
import {
  UnknownPlaceholderError,
  placeholdersIn,
  render,
  renderConversationSystemPrompt,
  renderOverseerSystemPrompt,
  renderRoundPrompt,
  roundTemplateFile,
  roundVars,
} from "../src/templates.js";
import type { RoundOrder } from "../src/types.js";

const order: RoundOrder = {
  pr: 412,
  title: "Add rate limiting",
  round_id: 7,
  round_no: 2,
  round_type: "re-review",
  lenses: ["pass-security", "pass-delivery"],
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
    expect(v.lenses).toBe("pass-security, pass-delivery");
    expect(v.escalation_criteria).toBe("touches auth; prod-risk");
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
