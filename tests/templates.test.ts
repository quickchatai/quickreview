import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnknownPlaceholderError,
  placeholdersIn,
  render,
  renderAddableLenses,
  renderConversationSystemPrompt,
  renderDirectiveEscalationNote,
  renderIntentNote,
  renderNitScopeNote,
  renderOverseerSystemPrompt,
  renderPassPlan,
  renderRecheckPrompt,
  renderRoundPrompt,
  recheckVars,
  roundTemplateFile,
  roundVars,
  RECHECK_TEMPLATE_FILE,
  FOLLOW_UP_TEMPLATE_FILE,
} from "../src/templates.js";
import { DJANGO_ECOSYSTEM, NONE_ECOSYSTEM } from "../src/ecosystem.js";
import { RECHECK_FILE_RE, recheckDecisionFile, type RecheckOrder } from "../src/recheck.js";
import { VERDICT_FILE_RE } from "../src/verdicts.js";
import { checkBashCommand } from "../extensions/bash-guard.js";
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
    {
      lens: "pass-validate",
      agent: "pass-validate--terra-med",
      tier: "terra-med",
      raisable_to: [],
    },
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
    expect(v.pass_plan).toContain(
      "| pass-security | `pass-security--sol-high` | sol-high | — (pinned) |",
    );
    expect(v.pass_plan).toContain(
      "| pass-delivery | `pass-delivery--sol-med` | sol-med | `pass-delivery--sol-high` |",
    );
    expect(v.addable_lenses).toBe("pass-ui, pass-contracts");
    expect(v.migration_gate_note).toMatch(/MIGRATION GATE/);
    expect(v.migration_gate_note).toContain("Ordinary Django ORM operations are acceptable");
    expect(v.migration_gate_note).toContain("Only a concrete migration hazard blocks");
    expect(v.migration_gate_note).not.toContain("cannot prove safe is a blocker");
    expect(v.settled_digest).toBe("T1: author fixed at abc123");
    expect(v.round_type).toBe("re-review");
    expect(v.recovery_note).toBe("");
  });

  it("renders an identity-bound fanout-first note only on a recovery round", () => {
    const recovering = {
      ...order,
      recovery: {
        stage: "first_pass_start" as const,
        source_round_no: 9,
        source_command_id: "764fefa0-d01e-43c5-b787-d4ed5b51d08e",
        target_head_sha: "deadbeef",
        immediate_attempt: 2,
        retry_epoch: 1,
      },
    };
    const note = roundVars(recovering).recovery_note;
    expect(note).toContain("RECOVERY — PRE-FANOUT STALL");
    expect(note).toContain("round 9");
    expect(note).toContain("764fefa0-d01e-43c5-b787-d4ed5b51d08e");
    expect(note).toContain("deadbeef");
    expect(note).toContain("launch every planned discovery pass");

    for (const name of ["round-first.md", "round-re-review.md", "round-staleness.md"]) {
      const tpl = readFileSync(resolve(process.cwd(), "prompts", name), "utf8");
      const rendered = renderRoundPrompt(tpl, recovering);
      expect(rendered.match(/RECOVERY — PRE-FANOUT STALL/g), name).toHaveLength(1);
      expect(rendered.indexOf("RECOVERY — PRE-FANOUT STALL"), name).toBeLessThan(
        rendered.indexOf("## GitHub routine"),
      );
    }
    const reReview = renderRoundPrompt(
      readFileSync(resolve(process.cwd(), "prompts/round-re-review.md"), "utf8"),
      recovering,
    );
    expect(reReview).toContain(
      "Broad parent source/diff inspection happens only after that fanout is running",
    );
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
    const note = roundVars(order).migration_gate_note!;
    expect(note).toMatch(/MIGRATION GATE/);
    expect(note.toLowerCase()).not.toContain("escalate unless");
  });

  // The pre-check's result has to REACH the session, or the lens
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
    expect(roundVars({ ...order, migration_collisions: [] }).migration_gate_note).not.toContain(
      "ALREADY HANDLED",
    );
    expect(
      roundVars({ ...order, migration_collisions: undefined }).migration_gate_note,
    ).not.toContain("ALREADY HANDLED");
  });

  it("falls back when every known lens is already planned", () => {
    expect(roundVars({ ...order, addable_lenses: [] }).addable_lenses).toMatch(
      /none — every known lens/,
    );
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

// The nit treadmill's stopping rule: from round 3 onward a new nit
// is only raisable inside the current delta, and the round number reaches the
// blank-slate passes only through the task string, so the note carries a
// verbatim block the session copies into every pass task string.
describe("renderNitScopeNote", () => {
  it("renders nothing before round 3 — the treadmill needs a prior round", () => {
    expect(renderNitScopeNote(1)).toBe("");
    expect(renderNitScopeNote(2)).toBe("");
    expect(roundVars(order).nit_scope_note).toBe(""); // order.round_no = 2
  });

  it("arms the stopping rule from round 3, round number stated", () => {
    const note = renderNitScopeNote(3);
    // The verbatim task-string block, round number included.
    expect(note).toContain("fenced block below VERBATIM into every lens pass's task string");
    expect(note).toContain("NIT SCOPE: this is review 3 of this PR");
    // The rule: new nits only inside the delta; P0–P2 exempt everywhere.
    expect(note).toContain("only raisable on lines");
    expect(note).toContain("inside the current delta");
    expect(note).toContain("did not change since the last round");
    expect(note).toContain("P0–P2 findings are exempt");
    // Session-side enforcement and the one running non-blocking thread.
    expect(note).toContain("`nit-out-of-delta`");
    expect(note).toContain("running non-blocking thread");
    expect(note).toContain("this thread does not");
    expect(note).toContain("**Never open a new inline thread for a nit**");
    // The round number is live, not a constant.
    expect(renderNitScopeNote(7)).toContain("NIT SCOPE: this is review 7 of this PR");
    expect(roundVars({ ...order, round_no: 3 }).nit_scope_note).toBe(note);
  });

  it("reaches the rendered re-review and staleness prompts at round 3, not at round 2", () => {
    for (const file of ["round-re-review.md", "round-staleness.md"]) {
      const tpl = readFileSync(resolve(process.cwd(), "prompts", file), "utf8");
      expect(renderRoundPrompt(tpl, { ...order, round_no: 2 })).not.toContain(
        "NIT SCOPE: this is review",
      );
      const r3 = renderRoundPrompt(tpl, { ...order, round_no: 3 });
      expect(r3).toContain("NIT SCOPE: this is review 3 of this PR");
      expect(r3).toContain("P0–P2 findings are exempt");
    }
  });

  // `[review] nits = "open"` lifts the volume limits, never the fenced
  // treadmill rule: from review 3 the two notes must not give opposite
  // posting orders (own inline `[nit]` vs never a new inline nit thread).
  it("an open nit policy defers to an armed NIT SCOPE instead of contradicting it", () => {
    for (const file of ["round-re-review.md", "round-staleness.md"]) {
      const tpl = readFileSync(resolve(process.cwd(), "prompts", file), "utf8");
      const r2 = renderRoundPrompt(tpl, { ...order, round_no: 2, nit_policy: "open" });
      expect(r2).toContain("as its own inline `[nit]`");
      const r3 = renderRoundPrompt(tpl, { ...order, round_no: 3, nit_policy: "open" });
      expect(r3).toContain("NIT POLICY — open");
      expect(r3).not.toContain("as its own inline `[nit]`");
      expect(r3).toContain("the NIT SCOPE rule below still binds");
      expect(r3).toContain("**Never open a new inline thread for a nit**");
    }
  });
});

describe("renderDirectiveEscalationNote", () => {
  const fpd = { files: [".claude/skills/a/SKILL.md", "CLAUDE.md"], mention: "alex" };

  it("renders empty when the order carries no first-party directive files", () => {
    expect(renderDirectiveEscalationNote(order)).toBe("");
    expect(
      renderDirectiveEscalationNote({
        ...order,
        first_party_directives: { files: [], mention: "x" },
      }),
    ).toBe("");
  });

  it("names the files, evidence burden, ordinary blocker routing and one @-mention", () => {
    const note = renderDirectiveEscalationNote({ ...order, first_party_directives: fpd });
    expect(note).toContain("FIRST-PARTY DIRECTIVES");
    expect(note).toContain("`.claude/skills/a/SKILL.md`");
    expect(note).toContain("`CLAUDE.md`");
    expect(note).toContain("@alex");
    expect(note).toContain("EXACTLY ONE short security-attention comment");
    expect(note).toContain("Routine directive text");
    expect(note).toContain("produces NO injection");
    expect(note).toContain("first-party location does not soften it");
    expect(note).toContain("ordinary severity/reachability tag and merits verdict");
    expect(note).toContain("never request a reviewer on");
  });

  it("degrades to a descriptive addressee when no login was resolvable", () => {
    const note = renderDirectiveEscalationNote({
      ...order,
      first_party_directives: { ...fpd, mention: "" },
    });
    expect(note).not.toContain("@alex");
    expect(note).toContain("no login was resolvable");
  });

  it("lands in every round prompt via {{directive_note}} — and only when armed", () => {
    for (const rt of ["first", "re-review", "staleness"] as RoundType[]) {
      const tpl = readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile(rt)), "utf8");
      expect(tpl).toContain("{{directive_note}}");
      const armed = renderRoundPrompt(tpl, {
        ...order,
        round_type: rt,
        first_party_directives: fpd,
      });
      expect(armed).toContain("FIRST-PARTY DIRECTIVES — concrete evidence decides.");
      expect(armed).toContain("@alex");
      const unarmed = renderRoundPrompt(tpl, { ...order, round_type: rt });
      expect(unarmed).not.toContain("FIRST-PARTY DIRECTIVES — concrete evidence decides");
      // The carve-out itself is stated in the template regardless.
      expect(unarmed).toContain("first-party carve-out");
    }
  });
});

/** Every shipped round template, as [round type it renders for, file]: the
 * three RoundType templates plus the follow-up one, which renders
 * re-review orders whose scope is "delta". */
const SHIPPED_ROUND_TEMPLATES: Array<[RoundType, string]> = [
  ["first", roundTemplateFile("first")],
  ["re-review", roundTemplateFile("re-review")],
  ["staleness", roundTemplateFile("staleness")],
  ["re-review", FOLLOW_UP_TEMPLATE_FILE],
];

describe("shipped round templates", () => {
  for (const [rt, tplFile] of SHIPPED_ROUND_TEMPLATES) {
    const text = readFileSync(resolve(process.cwd(), "prompts", tplFile), "utf8");

    it(`${tplFile} renders fully against a RoundOrder`, () => {
      const out = renderRoundPrompt(text, { ...order, round_type: rt });
      expect(out).not.toContain("{{");
      // The plan table and the addable list land in the prompt.
      expect(out).toContain("| lens | subagent to call | tier | may raise to |");
      expect(out).toContain("`pass-delivery--sol-med`");
      expect(out).toContain("pass-ui, pass-contracts");
    });

    // The kill log that feeds the EOD critic is stated whatever tier the
    // validator runs at.
    it(`${tplFile} still dispatches the planned validator variant and logs its kills`, () => {
      expect(text).toContain("pass-validate");
      expect(text).toMatch(/log\s+(its|the)\s+kills/i);
    });

    // Merge-not-drop: a "highest severity wins" dedup would silently destroy
    // distinct findings sharing an anchor, invisibly to telemetry. Same defect
    // merges; different defects both survive (fold, or post separately when
    // P1/P2); every disposition logged.
    it(`${tplFile} merge step carries both defects and logs every disposition`, () => {
      // Same defect merges.
      expect(text).toContain("SAME defect");
      expect(text).toMatch(/highest severity\s*\n?\s*wins[,;] lens tags\s*\n?\s*concatenate/);
      // Different defects on one run both survive — never dropped.
      expect(text).toContain("DIFFERENT defects");
      expect(text).toMatch(/both survive/);
      // The fold: lesser finding as its own paragraph, opener pinned.
      expect(text).toContain('"Also on these lines: "');
      // A P1/P2 never folds under another finding — posts on its own.
      expect(text).toMatch(/P1\/P2 never folds under another\s*\n?\s*finding/);
      // Disposition log lines, exact spellings, into the validate task string.
      expect(text).toContain("MERGED <src> into <dst>");
      expect(text).toContain("FOLDED <src> under <dst>");
      expect(text).toContain("validate task string");
      // Dedup is never unconditional.
      expect(text).not.toMatch(
        /Dedup (candidates )?by `\(path, changed-line-run\)`[;:] highest severity wins/,
      );
      // Telemetry: merged/folded ride the pass-validate entry of the verdict.
      expect(text).toContain('"merged": 1, "folded": 1');
      expect(text).toContain("step-3 merge-stage counts `merged`");
      expect(text).toMatch(/`folded`\s*\n?\s*\(different-defect `FOLDED` lines\)/);
    });

    it(`${tplFile} dispatches via the subagent tool, no bash fan-out, no spend_usd`, () => {
      // spend_usd is gone from the verdict contract — the daemon measures usage.
      expect(text).not.toContain("spend_usd");
      // Launch mechanism: the subagent tool, one turn; the bash fan-out is only
      // ever mentioned as forbidden.
      expect(text).toContain("`subagent` tool");
      expect(text).toMatch(/ONE assistant turn/);
      expect(text).toMatch(/no\n?`pi --no-session`/);
      // An unregistered pass agent must never be improvised around — generic
      // workers "acting as" lenses run at the wrong model tier.
      // STOP-and-anomaly instead.
      expect(text).toContain("Unknown agent = STOP, never improvise");
      expect(text).toMatch(/do NOT substitute another agent/);
      expect(text).toContain("produce no\nverdict at all");
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
      // The posting calls carry the head and round as an env prefix
      // on the same command — the exec policy refuses `export`.
      expect(text).toContain(
        "QCR_EXPECTED_HEAD={{head_sha}} QCR_ROUND_NO={{round_no}} scripts/approve-pr.sh {{n}} state/pr-{{n}}-round-{{round_no}}-review.md state/pr-{{n}}-round-{{round_no}}-comments.json",
      );
      expect(text).toContain(
        "QCR_EXPECTED_HEAD={{head_sha}} QCR_ROUND_NO={{round_no}} scripts/post-review.sh {{n}} REQUEST_CHANGES state/pr-{{n}}-round-{{round_no}}-review.md state/pr-{{n}}-round-{{round_no}}-comments.json",
      );
      expect(text).not.toMatch(/^export QCR_/m);
      expect(text).toContain("deterministic posting key");
    });

    // The one corpus rule that is about WHICH LENS RUNS rather than
    // how a lens judges, so it lives here and not in PASS_ADDENDA. The daemon's
    // plan is path-shaped (`migrationGate` and pass-data-safety selection both
    // key on `migrations/`-ish paths), so a models change with no migration
    // file reaches no lens at all unless the session adds one.
    // The rule names Django model fields, so the ecosystem renders it
    // (`{{missing_migration_note}}`) — present for Django, absent for `none`.
    it(`${tplFile} tells the session to add pass-data-safety on a missing migration`, () => {
      expect(text).toContain("\n{{missing_migration_note}}\n<!-- RATIFIED no-exec");
      const out = renderRoundPrompt(
        text,
        { ...order, round_type: rt },
        undefined,
        undefined,
        DJANGO_ECOSYSTEM,
      );
      expect(out).toContain("**Add on a missing migration.**");
      expect(out).toContain("no migration file at all");
      expect(out).toContain("add\n`pass-data-safety`");
      // The reason is stated, so the rule survives a reader who wants to drop it.
      expect(out).toContain("the **absence** of a\nfile is the defect");
      // It rides the existing add protocol — it is not a second dispatch path.
      expect(out).toContain("one-line reason");
      // The paragraph keeps its place and spacing: one blank line either side.
      expect(out).toContain("the lens is not added.\n\n**Add on a missing migration.**");
      // Fence markers stay in the source and never reach the model.
      expect(out).toContain("needs to run.\n\n**No-exec policy (absolute).**");
      expect(out).not.toContain("<!-- RATIFIED");
    });

    it(`${tplFile} carries no Django migration rule for ecosystem none`, () => {
      const out = renderRoundPrompt(
        text,
        { ...order, round_type: rt },
        undefined,
        undefined,
        NONE_ECOSYSTEM,
      );
      expect(out).not.toContain("Add on a missing migration");
      expect(out).not.toContain("Django");
      // No stray blank line where the rule was.
      expect(out).toContain("the lens is not added.\n\n**No-exec policy (absolute).**");
    });

    // The halves of the shared pass contract that live in the round
    // templates: the Decide-step reachability gate and the Post-step delta rule.
    it(`${tplFile} states the reachability decision rule without moving the blocker bar`, () => {
      expect(text).toContain("Reachability gate");
      expect(text).toContain("`reachability: routine | plausible | contrived`");
      // contrived never blocks, at any severity.
      expect(text).toMatch(/`contrived`[^]*never blocks, at\s*\n?\s*any severity/);
      // plausible: P0/P1 still block, P2 becomes a question.
      expect(text).toMatch(
        /`plausible`[^]*P0\/P1 still block; P2\s*\n?\s*becomes a `\[question\]`/,
      );
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

    // Executed-pass telemetry: the "Lenses applied" line derives
    // from what actually ran, and the verdict carries the `passes` record.
    it(`${tplFile} derives the lenses line from executed passes and orders the telemetry`, () => {
      // The lenses line: real returns only, never the plan.
      expect(text).toContain("**The lenses line reports what actually ran — never the plan.**");
      expect(text).toContain("actually launched via the");
      expect(text).toMatch(/never returned is not "applied"/);
      // A solo/degraded round says so plainly — exact wording pinned.
      expect(text).toContain("`Lenses applied: none — reviewed solo (degraded round)`");
      // The verdict schema carries the passes array, validator outcomes included.
      expect(text).toContain('"passes": [');
      expect(text).toMatch(/"survived": 2, "killed": 1, "downgraded": 0/);
      // Fill discipline: from real returns, never the plan table; [] is honest.
      expect(text).toContain(
        "filled from the real returns only, never copied from\nthe plan table",
      );
      expect(text).toContain("A pass\nthat never returned gets NO entry");
      expect(text).toContain('"passes": []');
    });

    // The three shapes that carry no reasoning at all. The governing
    // constraint is stated in the template itself and pinned here: this is
    // never a length rule, and success is never counted in characters.
    it(`${tplFile} requires a nit to ask for something`, () => {
      expect(text).toContain("**A nit asks for something, or it is not posted.**");
      expect(text).toContain("That is a remark, not a finding");
      expect(text).toContain("the concrete change it asks for");
      // The WHY is explicitly protected — no reasoning is traded for the ask.
      expect(text).toContain("**This cuts nothing from the WHY**");
      expect(text).toMatch(/at whatever length it takes/);
    });

    it(`${tplFile} forbids findings about the review's own earlier findings`, () => {
      expect(text).toContain("**Never post a finding about your own earlier findings.**");
      expect(text).toContain("The ledger already");
      // Verification is a status, not a finding — and the one real exception
      // (a fix that broke something else) stays a finding on its own merits.
      expect(text).toContain("it is a status you record, not a\nfinding you raise");
      expect(text).toContain("A prior finding whose fix broke something else is a **new\ndefect**");
    });

    it(`${tplFile} closes the tag grammar and says why it is not a style point`, () => {
      expect(text).toContain("**The tag grammar is closed.**");
      // All three marker prefixes are in the grammar sentence, `[deferred]`
      // included, since the template's own deferral section mandates it.
      expect(text).toContain(
        "optionally prefixed by `[check this]`,\n`[ask your human]` or `[deferred]` where those apply",
      );
      expect(text).toContain("never invent a\ntag");
      expect(text).toContain("[start here 3/5]");
      expect(text).toContain("silently escapes its own machinery");
      // The reason the grammar binds: the consumers key on it.
      expect(text).toContain("thread-resolution refusals");
    });

    it(`${tplFile} ledger vocab matches the code's closed sets`, () => {
      // posted_as includes `deferred` — SANCTIONED_TAGS accepts it, so the
      // template's closed list must too.
      expect(text).toContain(
        "`blocker`, `question`, `nit`, `check this`,\n  `ask your human` or `deferred`",
      );
      // ask-human-unnamed-defect (include.ts addendum) is recordable: a
      // downgrade word the addendum mints must be in the template's list.
      expect(text).toContain("`ask-human-unnamed-defect`, `tag-outside-grammar`)");
    });

    it(`${tplFile} states the bars for the two addable-only lenses`, () => {
      expect(text).toContain("**Two lenses exist only to be added — no plan ever selects them.**");
      expect(text).toContain("NAME the suspected\nread-then-write shape");
      expect(text).toContain("why the answer is not in the repository");
    });

    it(`${tplFile} refuses to measure any of this in characters`, () => {
      expect(text).toContain(
        "**None of this is a length rule, and success is never counted in characters.**",
      );
      expect(text).toContain("not one word of\njustification is cut");
    });

    // A deferral costs a ticket. The decision to defer belongs to the
    // session (it happens after validation), so the rule lives here and not in
    // PASS_ADDENDA. The SESSION files the issue itself in the same round — no
    // author-confirmation step exists.
    it(`${tplFile} makes a deferral cost a ticket the session files itself`, () => {
      expect(text).toContain("**Deferrals cost a ticket.**");
      expect(text).toContain("**No ticket, no deferral.**");
      // A judgment, not a keyword list.
      expect(text).toContain("a judgment, not a keyword");
      expect(text).toContain('a reason that is not "later"');
      // The session files, in the same round — never "invite the author to confirm".
      expect(text).toContain("you file the issue\n  YOURSELF, in this same round");
      expect(text).toContain("there is no confirmation step");
      expect(text).not.toContain("ask the author to confirm");
      expect(text).not.toContain("On confirmation");
      // The ONE route: a command file into the daemon's existing capped path.
      expect(text).toContain('"command": "file-issue"');
      expect(text).toContain("never a\n  `gh issue create`");
      expect(text).toContain("commands/results/deferral-pr-{{n}}");
      // The issue carries full provenance and links back to PR and thread.
      expect(text).toContain("**The issue body carries full provenance**");
      expect(text).toContain("Deferred from:");
      expect(text).toContain("Raised by:");
      expect(text).toContain("Deferred because:");
      expect(text).toContain("lead a reader back to the PR\n  and to the finding's thread");
      // A cap refusal is loud, and never routed around.
      expect(text).toContain("**A refusal is said out loud, in the thread.**");
      expect(text).toContain("Never retry it, never route around it");
      // Nothing is forced and nothing blocks.
      expect(text).toContain("**Nothing here blocks a merge or forces a fix.**");
    });

    it(`${tplFile} keeps the three markers apart and refuses to resolve a deferral`, () => {
      // Each of the three is named with its own single meaning, in one place.
      expect(text).toContain("The finding's comment leads with `[deferred]`");
      expect(text).toContain("[deferred] [question] <title>");
      expect(text).toContain("**not** `[check this]`");
      expect(text).toContain("**not**\n  `[ask your human]`");
      expect(text).toContain("never put two markers on one comment");
      // The structural refusal that keeps an ignored deferral from being free.
      expect(text).toContain("**You never resolve a `[deferred]` thread**");
      expect(text).toContain("the daemon refuses it\n  structurally");
    });

    it(`${tplFile} posts only deltas — verified-and-fine material never goes inline`, () => {
      expect(text).toContain("**Only deltas get posted.**");
      expect(text).toContain("collapsible `<details>` section at the bottom of the body");
      expect(text).toContain("**Never inline**");
      expect(text).toContain("verification\ninventory is not");
    });

    // A plain-language opener on every review body, and blocker
    // comments that lead with the consequence rather than the mechanism.
    it(`${tplFile} opens the review body in plain language, before the verdict line`, () => {
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
      expect(text).toMatch(
        /This is the \*\*same text\*\* as the body's\s+plain opening paragraph \(step 6\)/,
      );
      // The plain opener lives in §6 Post and precedes the body recipe that
      // names the verdict/lenses lines.
      const post = text.slice(text.indexOf("## 6. Post"), text.indexOf("## 7. Return"));
      const opener = post.indexOf("**Open in plain language.**");
      expect(opener).toBeGreaterThanOrEqual(0);
      expect(post).toMatch(/summary (body opens|opening) with|After the plain opener/);
      expect(opener).toBeLessThan(
        post.search(/verdict \+ lenses lines|verdict\s+line\s+and\s+(the\s+)?lenses line/),
      );
    });

    it(`${tplFile} preserves the framing judgment explicitly`, () => {
      expect(text).toContain("**Keep the framing judgment.**");
      expect(text).toMatch(/is not\s+dropped/);
      expect(text).toMatch(/one thing must change before merge/);
    });

    // Self-sufficient blocker bodies: a one-sentence blocker is often too thin
    // to act on, but one sentence stays correct when it is genuinely enough.
    it(`${tplFile} requires self-sufficient blocker bodies`, () => {
      expect(text).toContain("**Blocker bodies are self-sufficient.**");
      expect(text).toMatch(/the invariant a fix must restore/);
      expect(text).toMatch(
        /a single\s*\n?sentence is CORRECT when it genuinely carries all of that/,
      );
      expect(text).toMatch(/Sufficiency is the\s*\n?test, padding is noise/);
      expect(text).toContain("lead with the general defect or violated invariant");
      expect(text).toContain("concrete reproducer is proof beneath it");
      expect(text).toContain("not the scope of the requested fix");
      // It extends, never replaces, the consequence-first rule.
      expect(text.indexOf("**Blocker comments lead with the consequence.**")).toBeLessThan(
        text.indexOf("**Blocker bodies are self-sufficient.**"),
      );
    });

    // The posted-body format is specified by the template itself (an
    // under-specified format sends sessions reading sibling PRs' posted
    // reviews for examples).
    it(`${tplFile} specifies the posted body format explicitly`, () => {
      expect(text).toContain("**Body format — this template is the format authority.**");
      // The skeleton, in order: plain opener → verdict line → lenses line →
      // sections → Start here → details/footer.
      expect(text).toContain("the plain opening paragraph (above) — always first");
      expect(text).toContain("`**Verdict: Approved** — no findings.`");
      expect(text).toContain("`**Verdict: Changes requested** — 2 blockers, 1 nit.`");
      expect(text).toContain("`_Lenses applied: <lens, lens, …>._`");
      expect(text).toContain("`### Blockers`, then `### Nits`, then `### Questions`");
      expect(text).toContain("- `path:line` — <title> _(<severity>/<confidence>, <lens>)_");
      expect(text).toContain("`### For a human to double-check` section");
      // Every double-check item is also an inline
      // resolvable thread a human must touch, never resolved by the reviewer.
      expect(text).toContain("inline `[check this]` comment");
      expect(text).toContain("you never resolve a `[check this]` thread");
      expect(text).toMatch(/optional collapsible `<details>`[^]*standard\s+footer/);
      // The inline-comment grammar: tag-first, consequence-first blockers,
      // severity/confidence/lens tail, changed-line-run anchoring.
      expect(text).toContain("first line `[blocker] <title>`");
      expect(text).toContain("(or `[question]` / `[nit]`)");
      expect(text).toContain("`_<severity> · confidence <c> · lens <lens>_`");
      expect(text).toMatch(/anchored inside a changed-line run on the exact path and side/);
    });

    it(`${tplFile} forbids reading sibling PRs' posted reviews`, () => {
      expect(text).toContain(
        "**Never read another PR's posted reviews — for format or anything else.**",
      );
      expect(text).toContain("complete format authority");
      expect(text).toContain("contamination");
      expect(text).toMatch(/re-read this section — never a\s+sibling PR/);
    });

    // With the native extension the agent list IS the built pass set (no
    // stock agents ship), and
    // any foreign agent name stays banned as the degraded path — never a
    // stand-in for a lens.
    it(`${tplFile} declares foreign agent names off-limits (only built passes exist)`, () => {
      expect(text).toContain(
        "**Only the built pass agents exist — any foreign agent name is off-limits.**",
      );
      expect(text).toContain("stock\n`researcher`/`scout`/`worker` agents no longer exist");
      expect(text).toContain("never treat it as a fallback for a lens");
    });

    // Children run at the sandbox root: the glue strips task `cwd`
    // (a child in the reviewed worktree would load that repo's .pi/ config
    // under always-on trust), so the template must demand absolute paths and
    // forbid passing a cwd.
    it(`${tplFile} tells the session passes run at the sandbox root with absolute paths`, () => {
      expect(text).toContain("never pass a `cwd`");
      expect(text).toMatch(/absolute/);
    });

    it(`${tplFile} makes blocker comments lead with the consequence`, () => {
      expect(text).toContain("**Blocker comments lead with the consequence.**");
      expect(text).toMatch(/one clause of plain words naming what actually goes wrong/);
      expect(text).toMatch(/silently overwrite each\s+other/);
      expect(text).toMatch(/mechanism is the second sentence, never the first\./);
    });
  }
});

describe("system prompts", () => {
  it("substitutes n/title/worktree in the conversation prompt", () => {
    const out = renderConversationSystemPrompt(
      "shepherd for PR #{{n}} ({{title}}) at {{worktree}}",
      {
        pr: 3,
        title: "T",
        worktree: "/wt/pr-3",
      },
    );
    expect(out).toBe("shepherd for PR #3 (T) at /wt/pr-3");
  });

  it("passes the overseer prompt through untouched", () => {
    expect(renderOverseerSystemPrompt("You are the overseer.")).toBe("You are the overseer.");
  });

  it("resolves the identity variables on both system prompts (neutral by default, config wins)", () => {
    expect(
      renderConversationSystemPrompt("in {{repo}} as {{bot_login}}", {
        pr: 3,
        title: "T",
        worktree: "/wt",
      }),
    ).toBe("in the reviewed repository as the review bot");
    expect(
      renderConversationSystemPrompt(
        "in {{repo}} as {{bot_login}}",
        { pr: 3, title: "T", worktree: "/wt" },
        { owner_name: "Ada", repo: "org/app", bot_login: "bot[bot]" },
      ),
    ).toBe("in org/app as bot[bot]");
    expect(renderOverseerSystemPrompt("window of {{owner_name}}", { owner_name: "Ada" })).toBe(
      "window of Ada",
    );
    expect(renderOverseerSystemPrompt("window of {{owner_name}}")).toBe("window of the owner");
  });

  it("the real conversation-system.md renders with no unexpanded {{…}}", () => {
    const template = readFileSync(
      resolve(import.meta.dirname, "../prompts/conversation-system.md"),
      "utf8",
    );
    const out = renderConversationSystemPrompt(template, {
      pr: 7,
      title: "T",
      worktree: "/wt/pr-7",
    });
    expect(out).not.toContain("{{");
    expect(out).toContain("the reviewed repository");
    expect(out).toContain("(`the review bot`)");
  });

  it("the real overseer-system.md renders with no unexpanded {{…}}", () => {
    const template = readFileSync(
      resolve(import.meta.dirname, "../prompts/overseer-system.md"),
      "utf8",
    );
    expect(renderOverseerSystemPrompt(template)).not.toContain("{{");
  });
});

// ---- the fourth template: the delta recheck ---------------------------------

const recheckOrder: RecheckOrder = {
  pr: 5109,
  title: "Rewrite trimToLimit",
  trigger: "push",
  standing_verdict: "APPROVE",
  last_reviewed_sha: "aaaaaaa",
  head_sha: "bbbbbbb",
  worktree: "/sandbox/wt/pr-5109",
  evidence: "1 changed file(s) this review has not seen",
  files: [
    { filename: "src/trim.ts", class: "significant", reason: "content" },
    { filename: "yarn.lock", class: "trivial", reason: "version-bump" },
  ],
  resolved_files: [],
  decision_file: "pr-5109-recheck-bbbbbbb.json",
  issued_at: "2026-08-18T10:00:00Z",
};

// Hand-resolved merge files get an explicit audit block
// telling the session to diff against BOTH parents; clean deltas get nothing.
describe("conflict audit note", () => {
  it("renders the audit block only when resolved files exist", () => {
    const tpl = readFileSync(resolve(process.cwd(), "prompts", RECHECK_TEMPLATE_FILE), "utf8");
    const clean = renderRecheckPrompt(tpl, recheckOrder);
    expect(clean).not.toContain("CONFLICT RESOLUTION AUDIT");
    const conflicted = renderRecheckPrompt(tpl, {
      ...recheckOrder,
      resolved_files: ["src/handlers.py"],
    });
    expect(conflicted).toContain("CONFLICT RESOLUTION AUDIT");
    expect(conflicted).toContain("`src/handlers.py`");
    expect(conflicted).toContain("both");
    expect(conflicted).toMatch(/dropped base change is a\nregression/);
  });
});

describe("shipped recheck template", () => {
  const text = readFileSync(resolve(process.cwd(), "prompts", RECHECK_TEMPLATE_FILE), "utf8");

  it("renders fully against a RecheckOrder", () => {
    const out = renderRecheckPrompt(text, recheckOrder);
    expect(out).not.toContain("{{");
    expect(out).toContain("`src/trim.ts` — **review this**");
    expect(out).toContain("trivial (version-bump)");
  });

  it("carries the standing verdict, the last-reviewed sha and the delta", () => {
    const v = recheckVars(recheckOrder);
    expect(v.standing_verdict).toBe("APPROVE");
    expect(v.last_reviewed_sha).toBe("aaaaaaa");
    expect(v.head_sha).toBe("bbbbbbb");
    expect(v.delta_files).toContain("src/trim.ts");
  });

  it("uses no placeholder recheckVars does not supply", () => {
    const supplied = new Set(Object.keys(recheckVars(recheckOrder)));
    for (const name of placeholdersIn(text)) expect(supplied).toContain(name);
  });

  // The missing-migration add trigger is deliberately NOT here. A
  // recheck plans no passes and launches no subagent ("This is not a review
  // round"), so an instruction to add a lens would be an instruction it cannot
  // follow. A models-vs-migration mismatch introduced by a delta comes back
  // through the next round, not through this mode.
  it("carries no add-a-lens instruction — this mode dispatches nothing", () => {
    expect(text).toContain("no subagent is launched");
    expect(text).not.toContain("**Add on a missing migration.**");
    expect(text).not.toContain("Add protocol");
  });

  it("states the one-way transition and forbids a re-approve or a park", () => {
    expect(text).toContain("Uphold by default");
    expect(text).toMatch(/only move available to you is .* REQUEST_CHANGES/);
    expect(text).toMatch(/cannot re-approve/);
    expect(text).toMatch(/cannot park/);
  });

  it("keeps posting on the gated script route", () => {
    expect(text).toContain("scripts/post-review.sh");
    expect(text).not.toMatch(/gh api .*-X (POST|PATCH|PUT|DELETE)/);
  });

  it("keeps recheck findings at the invariant rather than one example", () => {
    expect(text).toContain("Lead with the general defect or violated invariant");
    expect(text).toContain("concrete\nreproducer is proof beneath it");
    expect(text).toContain("not the scope of the requested fix");
  });

  // The nit-scope rule holds on the recheck path too, and here it is
  // always armed: a recheck only ever follows a posted review.
  it("arms the nit-scope rule unconditionally in recheck mode", () => {
    expect(text).toContain("**Nit scope — always armed in this mode.**");
    expect(text).toContain("only raisable on lines inside this delta");
    expect(text).toContain("surfaces that did not change are suppressed outright");
    // P0–P2 exempt; the verdict-moving bar untouched.
    expect(text).toContain("`P0`–`P2` findings are exempt");
    expect(text).toContain("A nit never moves the verdict");
    // One running non-blocking thread, never a fresh inline one.
    expect(text).toContain("running non-blocking nits");
    expect(text).toContain("never a new inline thread");
    expect(text).toContain("this thread does not need another round to\n  close");
  });

  // A deferral costs a ticket on the recheck path too, and the
  // session files it itself, in the same recheck. No confirmation step.
  it("makes a recheck deferral cost a self-filed ticket through the capped path", () => {
    expect(text).toContain("**A `[deferred]` finding costs a ticket here too");
    expect(text).toContain("you file it\nyourself, in this same recheck");
    expect(text).toContain("There is no confirmation step");
    expect(text).toContain('"command": "file-issue"');
    expect(text).toContain("never a\n`gh issue create`");
    expect(text).toContain("commands/results/deferral-pr-{{n}}");
    // Loud refusal, never retried; the thread stays human-resolve-only.
    expect(text).toContain("Never retry, never route around it");
    expect(text).toContain("You never resolve a `[deferred]`\nthread");
    // The two senses of "deferred" are disambiguated outside the RATIFIED
    // fences: the ledger mark is free and private, only the TAG files a ticket.
    expect(text).toContain('Two spellings of "deferred" appear in this template');
    expect(text).toContain("only the tag files a ticket");
  });

  // The sibling-review ban holds on the recheck path too; the
  // format authority is the round template the session already holds.
  it("forbids reading sibling PRs' posted reviews in recheck mode too", () => {
    expect(text).toContain(
      "**Never read another PR's posted reviews — for format or anything else.**",
    );
    expect(text).toContain("format authority");
    expect(text).toContain("contamination surface");
  });
});

// ---- the INTENT note ---------------------------------------------------------

describe("renderIntentNote", () => {
  const intentEntry = {
    lens: "pass-intent",
    agent: "pass-intent--terra-med",
    tier: "terra-med" as const,
    raisable_to: ["pass-intent--sol-med", "pass-intent--sol-high"],
  };
  const intentOrder: RoundOrder = {
    ...order,
    lenses: [...order.lenses, "pass-intent"],
    pass_plan: [...order.pass_plan, intentEntry],
    pr_body:
      "This PR adds a token-bucket rate limiter for the public API. Requests " +
      "over the limit receive a 429 with a Retry-After header.",
  };

  it("renders nothing when pass-intent is not planned", () => {
    expect(renderIntentNote(order)).toBe("");
    expect(roundVars(order).intent_note).toBe("");
  });

  it("carries the PR title and body VERBATIM as the whole intent artifact", () => {
    const note = renderIntentNote(intentOrder);
    expect(note).toContain(`TITLE: ${intentOrder.title}`);
    expect(note).toContain(`BODY:\n${intentOrder.pr_body}`);
    expect(note).toContain("Copy the fenced block below VERBATIM");
    expect(note).toContain("ENTIRE intent artifact");
  });

  it("states the task string's sources: no tracker, no conversation, no prompt transcript", () => {
    const note = renderIntentNote(intentOrder);
    expect(note).toContain("do not fetch a tracker ticket, an implementing");
    expect(note).toContain("conversation, or any prompt transcript");
    expect(note).toContain("no tracker ticket, no");
    expect(note).toContain("implementing conversation, no prompt transcript");
    expect(note).toContain("judges the diff against the title");
    expect(note).toContain("and body below and against nothing else");
  });

  it("carries the thin-body NONE rule and the severity cap into the task string", () => {
    const note = renderIntentNote(intentOrder);
    expect(note).toContain("too thin to\njudge against, return NONE");
    expect(note).toContain(
      "Findings are [question] or [nit]\nonly — severity P3/nit, never a [blocker]",
    );
  });

  it("the task-string block may contain nothing PR-specific beyond title and body", () => {
    // Fixed scaffolding: swap title and body and the note changes ONLY where
    // they were substituted — no other PR data can leak into the task string.
    const a = renderIntentNote(intentOrder);
    const b = renderIntentNote({
      ...intentOrder,
      title: "Other title",
      pr_body: "Other body prose entirely.",
    });
    const scaffold = (note: string, title: string, bodyText: string) =>
      note.replace(`TITLE: ${title}`, "TITLE: <t>").replace(`BODY:\n${bodyText}`, "BODY:\n<b>");
    expect(scaffold(a, intentOrder.title, intentOrder.pr_body!)).toBe(
      scaffold(b, "Other title", "Other body prose entirely."),
    );
  });

  it("outruns backtick runs in an adversarial body so the fence never breaks", () => {
    const evil = { ...intentOrder, pr_body: "look:\n````\ncode\n````\nand ```more```" };
    const note = renderIntentNote(evil);
    // The chosen fence is strictly longer than the body's longest run (4).
    expect(note).toContain("\n`````\nINTENT ARTIFACT");
    expect(note.trimEnd().endsWith("`````")).toBe(true);
    expect(note).toContain(evil.pr_body);
  });

  it("reaches every rendered round prompt when planned, and renders empty otherwise", () => {
    const root = resolve(process.cwd(), "prompts");
    for (const rt of ["first", "re-review", "staleness"] as RoundType[]) {
      const template = readFileSync(resolve(root, roundTemplateFile(rt)), "utf8");
      const withIntent = renderRoundPrompt(template, {
        ...intentOrder,
        round_type: rt,
        round_no: 3,
      });
      expect(withIntent).toContain("INTENT ARTIFACT");
      expect(withIntent).toContain(`TITLE: ${intentOrder.title}`);
      const without = renderRoundPrompt(template, { ...order, round_type: rt, round_no: 3 });
      expect(without).not.toContain("INTENT ARTIFACT");
    }
  });
});

// Ledger discipline. Every round template mandates a ledger rewrite, and it
// must come BEFORE the verdict file: the verdict file is the daemon's
// round-over signal and consumption compacts the conversation, so a
// post-verdict ledger write is aborted mid-turn and the ledger left stale.
// Also pinned: scratch paths, the pr-self.sh read helper, verdict-schema
// discipline, validator batching, and the memory-noise rule. The wording is
// pinned here; edit template and pin together.
describe("template & script cleanups", () => {
  for (const [rt, tplFile] of SHIPPED_ROUND_TEMPLATES) {
    const text = readFileSync(resolve(process.cwd(), "prompts", tplFile), "utf8");

    it(`${tplFile} pins the scratch paths next to the verdict path`, () => {
      expect(text).toContain("**Scratch paths are pinned — same discipline as the verdict path.**");
      expect(text).toContain("`state/pr-{{n}}-round-{{round_no}}-review.md`");
      expect(text).toContain("`state/pr-{{n}}-round-{{round_no}}-comments.json`");
      expect(text).toContain("`state/pr-{{n}}-round-{{round_no}}-passes/`");
      expect(text).toContain("Never invent a\nnaming scheme");
      expect(text).toContain("The path is the contract.");
      // Both live in step 7, beside the verdict-path instruction.
      const ret = text.slice(text.indexOf("## 7. Return"));
      expect(ret).toContain("**Scratch paths are pinned");
      // …and the placeholders render into the concrete per-round paths.
      const out = renderRoundPrompt(text, { ...order, round_type: rt });
      expect(out).toContain("state/pr-412-round-2-review.md");
      expect(out).toContain("state/pr-412-round-2-comments.json");
      expect(out).toContain("state/pr-412-round-2-passes/");
    });

    it(`${tplFile} routes self-verification reads through pr-self.sh, raw gh as fallback only`, () => {
      expect(text).toContain("`scripts/pr-self.sh {{n}} <reviews|threads|head|checks>`");
      expect(text).toContain("Read-only by\n  construction — it has no mutation path.");
      // No blanket "additional READS" phrasing: raw gh is a fallback, not
      // routine.
      expect(text).toContain("Raw `gh` reads are a fallback only");
      expect(text).not.toContain("Raw `gh` is for additional READS only");
      expect(text).toContain("every mutation goes through a script");
    });

    it(`${tplFile} demands exactly the schema fields — no extras`, () => {
      expect(text).toContain("**Emit exactly the schema fields — no extras.**");
      expect(text).toContain("not licence to invent one");
      // The template names the failure: a rogue ai_approved on a plain approval.
      expect(text).toMatch(/rogue\s*\n?`ai_approved: true` on a plain approval/);
      expect(text).toContain(
        "appear only under their\nstated conditions below; nothing else, ever.",
      );
      // No tolerance phrasing that invites extra fields.
      expect(text).not.toContain("extra fields are fine");
    });

    it(`${tplFile} keeps pass-validate out of the discovery batch`, () => {
      expect(text).toContain("**`pass-validate` is never in this batch.**");
      expect(text).toContain("only after\nevery discovery pass has returned its results");
      expect(text).toContain("never in the same batch");
      // The why: an early validator vets nothing and is paid for twice.
      expect(text).toContain("empty candidate set");
      expect(text).toContain("pays for the validator twice");
      expect(text).toContain("the validator waits for step 4");
    });

    it(`${tplFile} declares other PRs' memory notes noise — never cited, never reused`, () => {
      // The paragraph is the renderer's `{{bleed_note}}`, rendered VERBATIM
      // whenever no lesson is delivered (here: no memory at all).
      expect(text).toContain("{{bleed_note}}{{lessons_note}}");
      const rendered = renderRoundPrompt(text, { ...order, round_type: rt });
      expect(rendered).toContain("**Notes from other PRs are noise.**");
      expect(rendered).toContain("read-side bleed");
      expect(rendered).toContain(
        "never cite them, never reuse them as evidence, precedent, or format",
      );
      expect(rendered).toContain("Only this PR's own ledger and history inform this\nround.");
    });
  }
});

describe("end-of-round ledger discipline", () => {
  const PIN =
    "Update the ledger, then write the verdict file — in that order; nothing comes after the verdict write.";
  for (const [, tplFile] of SHIPPED_ROUND_TEMPLATES) {
    it(`${tplFile} orders the ledger write BEFORE the verdict file, verbatim`, () => {
      const raw = readFileSync(resolve(process.cwd(), "prompts", tplFile), "utf8");
      const flat = raw.replace(/\s+/g, " ");
      expect(flat).toContain(`**${PIN}**`);
      // The step carries its own why — the compaction stake and the ordering.
      expect(flat).toContain("it must be written BEFORE the verdict file");
      expect(flat).toContain("only the ledger survives compaction");
      expect(flat).toContain("The round is not finished until the ledger is written");
    });
  }
});

// The session never writes a verdict or recheck-outcome
// file in place — it stages the COMPLETE JSON at `verdict/<name>.tmp` and
// publishes it with scripts/commit-verdict.sh (one rename). Pinned on the
// RENDERED text of all four templates, and against the script's own accepted
// names, so a typo in either (a missing `.json`, a staging name the script
// does not look for) fails here instead of in a session's finalize tail.
describe("atomic verdict publication", () => {
  const script = readFileSync(resolve(process.cwd(), "scripts", "commit-verdict.sh"), "utf8");
  const accepted = new RegExp(/\[\[ "\$NAME" =~ (\S+) \]\]/.exec(script)![1]!);

  it("the script stages at verdict/<name>.tmp — the name every template must use", () => {
    expect(script).toContain('DIR="$ROOT/verdict"');
    expect(script).toContain('STAGED="$DIR/$NAME.tmp"');
  });

  function publication(rendered: string, name: string): void {
    expect(rendered).toContain(`Never write \`verdict/${name}\` directly`);
    expect(rendered).toContain(`\`verdict/${name}.tmp\``);
    const commands = [...rendered.matchAll(/scripts\/commit-verdict\.sh (\S+?)`/g)].map(
      (m) => m[1]!,
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const arg of commands) {
      expect(arg).toBe(name);
      expect(accepted.test(arg), arg).toBe(true);
    }
    // Every staging name the text mentions is the script's `<name>.tmp`.
    for (const m of rendered.matchAll(/verdict\/(\S+?)\.tmp`/g)) expect(m[1]).toBe(name);
    // The rendered-posting note's `--from-record` publication names
    // the same file.
    for (const m of rendered.matchAll(/scripts\/commit-verdict\.sh --from-record (\S+?)`/g)) {
      expect(m[1]).toBe(name);
      expect(accepted.test(m[1]!), m[1]).toBe(true);
    }
  }

  for (const rt of ["first", "re-review", "staleness"] as RoundType[]) {
    it(`${roundTemplateFile(rt)} stages verdict/<name>.tmp and commits it by the exact name the watcher reads`, () => {
      const tpl = readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile(rt)), "utf8");
      const rendered = renderRoundPrompt(tpl, { ...order, round_type: rt });
      const name = `pr-${order.pr}-round-${order.round_no}.json`;
      expect(VERDICT_FILE_RE.test(name)).toBe(true);
      publication(rendered, name);
      expect(rendered).not.toContain("commit-verdict.sh --from-record");
      // Rendered posting: the note hands the decided verdict to
      // `--from-record`, by the same name.
      const withRender = renderRoundPrompt(tpl, {
        ...order,
        round_type: rt,
        render_outputs: true,
      });
      expect(withRender).toContain(`scripts/commit-verdict.sh --from-record ${name}\``);
      publication(withRender, name);
    });
  }

  it(`${RECHECK_TEMPLATE_FILE} publishes the outcome file the same way`, () => {
    const tpl = readFileSync(resolve(process.cwd(), "prompts", RECHECK_TEMPLATE_FILE), "utf8");
    const name = recheckDecisionFile(recheckOrder.pr, "bbbbbbbcccccddd");
    expect(RECHECK_FILE_RE.test(name)).toBe(true);
    publication(renderRecheckPrompt(tpl, { ...recheckOrder, decision_file: name }), name);
  });
});

// The main session's serial tail: the round templates give the
// exact posting calls in env-prefix form and list what the exec policy always
// refuses. Both are held to the REAL guard, so the prompt can never advertise
// a call the guard refuses or a refusal the guard no longer makes.
describe("posting calls and the refused-command list agree with the exec policy", () => {
  const rounds: Array<[string, RoundType]> = [
    ["round-first.md", "first"],
    ["round-re-review.md", "re-review"],
    ["round-follow-up.md", "re-review"],
    ["round-staleness.md", "staleness"],
  ];
  for (const [file, rt] of rounds) {
    const tpl = readFileSync(resolve(process.cwd(), "prompts", file), "utf8");
    const rendered = renderRoundPrompt(tpl, { ...order, round_type: rt });

    it(`${file}: every rendered posting call is one the guard admits, and none is an export`, () => {
      const calls = rendered
        .split("\n")
        .filter((l) => /^QCR_EXPECTED_HEAD=\S+ QCR_ROUND_NO=\d+ scripts\//.test(l));
      expect(calls.map((c) => c.split(" ")[2])).toEqual([
        "scripts/approve-pr.sh",
        "scripts/post-review.sh",
      ]);
      for (const c of calls) {
        expect(c).toContain(`QCR_EXPECTED_HEAD=${order.head_sha} QCR_ROUND_NO=${order.round_no} `);
        expect(c).toContain(`state/pr-${order.pr}-round-${order.round_no}-review.md`);
        const r = checkBashCommand(c);
        expect(r.allowed, `${c} — ${r.reason ?? ""}`).toBe(true);
      }
      expect(rendered).not.toMatch(/^export /m);
      expect(checkBashCommand(`export QCR_EXPECTED_HEAD=${order.head_sha}`).allowed).toBe(false);
    });

    it(`${file}: every command the refused list names is refused by the guard`, () => {
      const block = /\*\*What the exec policy always refuses[\s\S]*?\n\n((?:- [\s\S]*?\n)+)\n/.exec(
        tpl,
      );
      expect(block, "the refused-command list is missing").not.toBeNull();
      const bullets = block![1]!.split(/\n(?=- )/);
      expect(bullets).toHaveLength(4);
      const refused: string[] = [];
      for (const b of bullets.slice(0, 3)) {
        const head = b.split(" — ")[0]!;
        for (const m of head.matchAll(/`([^`]+)`/g)) refused.push(m[1]!);
      }
      expect(refused).toEqual(
        expect.arrayContaining(["export", "python3", "mv", "cp", "command -v", "cat <<EOF > file"]),
      );
      for (const cmd of refused) {
        const probe = cmd.startsWith("cat <<") ? "cat <<EOF > state/x.md\nEOF" : `${cmd} x`;
        const r = checkBashCommand(probe);
        expect(r.allowed, `${probe} should be refused`).toBe(false);
      }
      // The fourth: graphql is a POST unless it says GET.
      expect(bullets[3]).toContain("`gh api graphql` without `--method GET`");
      expect(checkBashCommand("gh api graphql -f query=q").allowed).toBe(false);
      expect(checkBashCommand("gh api --method GET graphql -f query=q").allowed).toBe(true);
      // The replacements it names are admitted.
      for (const ok of [
        "jq . x",
        "rg x",
        "sed -n 1,5p x",
        "scripts/commit-verdict.sh pr-1-round-1.json",
        "scripts/pr-threads.sh 1",
        "scripts/pr-self.sh 1 threads",
      ])
        expect(checkBashCommand(ok).allowed, ok).toBe(true);
    });
  }
});
