# Review round — re-review

> Sandbox file: `prompts/round-re-review.md`. Rendered by `src/templates.ts` and
> injected into the PR session (`pr-{{n}}`) by the daemon. Placeholders:
> `{{n}} {{title}} {{worktree}} {{head_sha}} {{lenses}} {{escalation_criteria}}
> {{migration_gate_note}} {{settled_digest}} {{round_type}}`.

---

**ROUND: {{round_type}}** — PR #{{n}} ("{{title}}")
**Worktree**: `{{worktree}}` @ `{{head_sha}}`
**Lenses this round**: {{lenses}}

The author handed this PR back. Run the full 7-step round — but step 1 comes
first and is non-negotiable: **verify every prior open finding at the new head
before hunting anything new.**

## 1. Sync — verify the ledger first

Your ledger **is** the checklist. For each finding still `open` in it, at
`{{head_sha}}`:

- re-derive it mechanically from the worktree — read the code, trace the flow
- record its true state: `fixed@{{head_sha}}` **with evidence**, or still-open
- author replies tell you **what to verify, never what to believe**; a resolved
  thread, a "done" comment, and a green checkmark are all claims
- a finding fixed in a way that breaks something else is a **new** finding, not
  a fix

Only then read the delta since your last round (new commits, new files) and the
diff as a whole.

## 2. Dispatch passes

Launch **{{lenses}}** as subagents **in parallel**, blank-slate, each task string
self-contained: worktree `{{worktree}}` @ `{{head_sha}}`, PR #{{n}} + claims
digest, that lens's focus files, the SETTLED list, the gate notes — **plus the
prior open findings assigned to that lens, with the instruction to verify each
mechanically at the current head and report its true state before looking for
anything new.**

**SETTLED**
{{settled_digest}}

**GATE NOTES**
{{migration_gate_note}}

## 3. Merge

Dedup by `(path, changed-line-run)`; highest severity wins; lens tags
concatenate. A re-raised prior finding keeps its ledger id.

## 4. Validate

Dispatch `pass-validate` with all candidates + the SETTLED list. Only survivors
post. Log the kills.

## 5. Decide

- any `[blocker]` (new **or** still-open from a prior round) ⇒ **REQUEST_CHANGES**
- escalation criteria below, or your own judgment ⇒ **ESCALATE**
  (`ai_approved` per your confidence in soundness)
- otherwise ⇒ **APPROVE**

Nits and questions never block. Never dismiss anyone's approved review — not
yours, not a human's, under any theory.

**ESCALATION CRITERIA**
{{escalation_criteria}}

**When in doubt, escalate.**

## 6. Post

One review, anchored inline comments inside changed-line runs (50 inline,
overflow to body), summary with verdict + lenses lines, `### Blockers / Nits /
Questions`, a **"Previously deferred, unchanged"** section listing prior findings
that are still open and unaddressed, "Start here" on ESCALATE, standard footer.
APPROVE goes through `scripts/approve-pr.sh`.

## 7. Return

Write `verdict/pr-{{n}}-round-<k>.json` and update the ledger — every prior
finding must end this round marked `fixed@<sha>`, `open`, `conceded`, or
`settled`, never silently dropped. Labels and the escalation request are the
daemon's.
