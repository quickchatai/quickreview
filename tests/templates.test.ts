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
  migration_gate: true,
  head_sha: "deadbeef",
  base_ref: "master",
  base_sha: "basetip",
  merge_base: "forkpoint",
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
    expect(v.base_ref).toBe("master");
    expect(v.base_sha).toBe("basetip");
    expect(v.merge_base).toBe("forkpoint");
    expect(v.pass_plan).toContain("| lens | subagent to call | tier | may raise to |");
    expect(v.pass_plan).toContain("| pass-security | `pass-security--sol-high` | sol-high | — (pinned) |");
    expect(v.pass_plan).toContain("| pass-delivery | `pass-delivery--sol-med` | sol-med | `pass-delivery--sol-high` |");
    expect(v.addable_lenses).toBe("pass-ui, pass-contracts");
    expect(v.migration_gate_note).toMatch(/MIGRATION GATE/);
    expect(v.settled_digest).toBe("T1: author fixed at abc123");
    expect(v.round_type).toBe("re-review");
  });

  it("uses placeholders for an empty settled digest and no gate", () => {
    const v = roundVars({ ...order, settled_digest: "  ", migration_gate: false });
    expect(v.settled_digest).toBe("(nothing settled yet)");
    expect(v.migration_gate_note).toMatch(/no migration gate/);
  });

  it("marks unresolved base facts rather than rendering a bare empty string", () => {
    const v = roundVars({ ...order, base_ref: "", base_sha: "", merge_base: "" });
    expect(v.base_ref).toMatch(/unknown/);
    expect(v.base_sha).toMatch(/unknown/);
    expect(v.merge_base).toMatch(/unknown/);
  });

  it("keeps the migration gate but drops its escalation framing", () => {
    const note = roundVars(order).migration_gate_note;
    expect(note).toMatch(/MIGRATION GATE/);
    expect(note.toLowerCase()).not.toContain("escalate unless");
  });

  // the pre-check's result has to REACH the session, or the lens
  // re-derives the collision and blocks on it anyway. It rides on
  // migration_gate_note, which all three round templates already print.
  it("carries the daemon-handled migration collisions into the gate note", () => {
    const v = roundVars({
      ...order,
      migration_collisions: [
        {
          app: "backend/chat",
          app_label: "chat",
          pr_path: "backend/chat/migrations/0042_add_widget.py",
          number: 42,
          base_path: "backend/chat/migrations/0042_add_widget_flag.py",
          target_number: 43,
          target_path: "backend/chat/migrations/0043_add_widget.py",
          dependency_name: "0042_add_widget_flag",
          dependency: '("chat", "0042_add_widget_flag")',
        },
      ],
    });
    const note = v.migration_gate_note;
    expect(note).toMatch(/MIGRATION GATE/); // the gate itself is untouched
    expect(note).toContain("ALREADY HANDLED, DO NOT RAISE IT");
    expect(note).toContain("backend/chat/migrations/0043_add_widget.py");
    expect(note).toContain('("chat", "0042_add_widget_flag")');
    expect(note).toContain("not a finding");
    expect(note).toContain("[blocker]");
    // …and it survives into the actual prompt the session is injected with.
    const tpl = readFileSync(resolve(process.cwd(), "prompts/round-re-review.md"), "utf8");
    expect(
      renderRoundPrompt(tpl, {
        ...order,
        migration_collisions: [
          {
            app: "backend/chat",
            app_label: "chat",
            pr_path: "backend/chat/migrations/0042_add_widget.py",
            number: 42,
            base_path: "backend/chat/migrations/0042_add_widget_flag.py",
            target_number: 43,
            target_path: "backend/chat/migrations/0043_add_widget.py",
            dependency_name: "0042_add_widget_flag",
            dependency: '("chat", "0042_add_widget_flag")',
          },
        ],
      }),
    ).toContain("ALREADY HANDLED, DO NOT RAISE IT");
  });

  it("says nothing about collisions when the pre-check found none", () => {
    expect(roundVars({ ...order, migration_collisions: [] }).migration_gate_note).not.toContain("ALREADY HANDLED");
    expect(roundVars({ ...order, migration_collisions: undefined }).migration_gate_note).not.toContain("ALREADY HANDLED");
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
      "base: {{base_ref}} @ {{base_sha}} (merge-base {{merge_base}})",
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

    // the validator now holds its veto at the top tier; the kill log
    // that feeds the EOD critic must survive that raise unchanged.
    it(`${roundTemplateFile(rt)} still dispatches the planned validator variant and logs its kills`, () => {
      expect(text).toContain("pass-validate");
      expect(text).toMatch(/log\s+(its|the)\s+kills/i);
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

    // the halves of the shared pass contract that live in the round
    // templates: the Decide-step reachability gate and the Post-step delta rule.
    it(`${roundTemplateFile(rt)} states the reachability decision rule without moving the blocker bar`, () => {
      expect(text).toContain("Reachability gate");
      expect(text).toContain("`reachability: routine | plausible | contrived`");
      // contrived never blocks, at any severity.
      expect(text).toMatch(/`contrived`[^]*never blocks, at\s*\n?\s*any severity/);
      // plausible: P0/P1 still block, P2 becomes a question.
      expect(text).toMatch(/`plausible`[^]*P0\/P1 still block; P2\s*\n?\s*becomes a `\[question\]`/);
      // routine unchanged, and an absent field reads as routine.
      expect(text).toContain("the map above applies unchanged");
      expect(text).toContain("without the field is `routine`");
      // The bar itself: a routine P0/P1 still blocks.
      expect(text).toContain("**The blocker bar itself does not move.**");
      expect(text).toMatch(/Posting map: P0\/P1 → `\[blocker\]`/);
      // Remedy size and injection findings.
      expect(text).toContain("**Remedy size.**");
      expect(text).toContain("design objection, not a merge blocker");
      expect(text).toContain("`kind: injection`");
      expect(text).toContain("reaches the owner and the overseer");
    });

    it(`${roundTemplateFile(rt)} posts only deltas — verified-and-fine material never goes inline`, () => {
      expect(text).toContain("**Only deltas get posted.**");
      expect(text).toContain("collapsible `<details>` section at the bottom of the body");
      expect(text).toContain("**Never inline**");
      expect(text).toContain("verification\ninventory is not");
    });

    // a plain-language opener on every review body, and blocker
    // comments that lead with the consequence rather than the mechanism.
    it(`${roundTemplateFile(rt)} opens the review body in plain language, before the verdict line`, () => {
      expect(text).toContain("**Open in plain language.**");
      expect(text).toMatch(/body's FIRST paragraph is 2-4 plain\s*\n?sentences/);
      // It precedes the verdict line, and it is not a second register: it is the
      // verdict `summary` text.
      expect(text).toContain("It comes **before** the verdict line.");
      expect(text).toMatch(/Same register as the verdict `summary` of\s*\n?step 7/);
      expect(text).toContain("**same text, word for word**");
      // No markdown / no jargon, same constraints the summary carries.
      expect(text).toMatch(/No markdown, no lens names, no severity codes/);
      // The opener is written once and reused in the verdict JSON (step 7).
      expect(text).toMatch(/This is the \*\*same text\*\* as the body's\s+plain opening paragraph \(step 6\)/);
      // The plain opener lives in §6 Post and precedes the body recipe that
      // names the verdict/lenses lines.
      const post = text.slice(text.indexOf("## 6. Post"), text.indexOf("## 7. Return"));
      const opener = post.indexOf("**Open in plain language.**");
      expect(opener).toBeGreaterThanOrEqual(0);
      expect(post).toMatch(/summary (body opens|opening) with|After the plain opener/);
      expect(opener).toBeLessThan(post.search(/verdict \+ lenses lines|verdict\s+line\s+and\s+(the\s+)?lenses line/));
    });

    it(`${roundTemplateFile(rt)} preserves the framing judgment explicitly`, () => {
      expect(text).toContain("**Keep the framing judgment.**");
      expect(text).toMatch(/is not\s+dropped/);
      expect(text).toMatch(/one thing must change before merge/);
    });

    it(`${roundTemplateFile(rt)} makes blocker comments lead with the consequence`, () => {
      expect(text).toContain("**Blocker comments lead with the consequence.**");
      expect(text).toMatch(/one clause of plain words naming what actually goes wrong/);
      expect(text).toMatch(/silently overwrite each\s+other/);
      expect(text).toMatch(/mechanism is the second sentence, never the first\./);
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
