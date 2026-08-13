# Review round — staleness check

> Sandbox file: `prompts/round-staleness.md`. Rendered by `src/templates.ts` and
> injected into the PR session (`pr-{{n}}`) by the daemon. Placeholders:
> `{{n}} {{title}} {{worktree}} {{head_sha}} {{lenses}} {{escalation_criteria}}
> {{migration_gate_note}} {{settled_digest}} {{round_type}}`.

---

**ROUND: {{round_type}}** — PR #{{n}} ("{{title}}")
**Worktree**: `{{worktree}}` @ `{{head_sha}}`
**Lenses this round**: {{lenses}}

This round was triggered because **the head moved after your approval**. Your
approving review still stands on the record; the question is whether it is still
*sound* at `{{head_sha}}`. Focus the delta — do not re-review the whole PR from
scratch.

## 1. Sync — scope the delta

Diff your approved sha against `{{head_sha}}` and establish exactly what changed
since the approval: files, hunks, and whether the PR's claimed invariant still
holds. Then ask the only question that matters: **does anything in this delta
invalidate the approval?**

## 2. Dispatch passes

Launch **{{lenses}}** as subagents **in parallel**, blank-slate, each task string
self-contained: worktree `{{worktree}}` @ `{{head_sha}}`, PR #{{n}} + claims
digest, the lens's focus files **restricted to the post-approval delta**, the
SETTLED list, the gate notes, and an explicit **staleness note**: "this PR was
already approved at an earlier head; review the delta since that approval, and
flag anything in it that would have blocked the approval."

**SETTLED**
{{settled_digest}}

**GATE NOTES**
{{migration_gate_note}}

## 3. Merge

Dedup by `(path, changed-line-run)`; highest severity wins; lens tags
concatenate.

## 4. Validate

Dispatch `pass-validate` with all candidates + the SETTLED list. Only survivors
post; log the kills. A finding that only restates a point settled before the
approval is a kill, not a finding.

## 5. Decide

- any `[blocker]` in the delta ⇒ **REQUEST_CHANGES** (your prior approval is
  superseded by the new review — **never dismissed**; dismissal does not exist)
- escalation criteria below, or doubt about the delta's blast radius ⇒
  **ESCALATE**
- the delta is clean and the approval still holds ⇒ **APPROVE** at the new head

Nits and questions never block.

**ESCALATION CRITERIA**
{{escalation_criteria}}

**When in doubt, escalate.**

## 6. Post

One review over the delta: anchored inline comments (50 inline, overflow to
body), summary opening with the verdict line and lenses line, an explicit
sentence naming this a **staleness re-check of an earlier approval** and the
range checked, `### Blockers / Nits / Questions`, "Start here" on ESCALATE,
standard footer. A re-APPROVE goes through `scripts/approve-pr.sh`.

## 7. Return

Write `verdict/pr-{{n}}-round-{{round_no}}.json` with EXACTLY this JSON shape —
the daemon rejects anything else (extra fields are fine, missing/renamed ones
are not):

```json
{
  "pr": {{n}},
  "round_no": {{round_no}},
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "ESCALATE",
  "ai_approved": true,
  "head_sha": "{{head_sha}}",
  "spend_usd": 1.25,
  "finished_at": "<ISO-8601 UTC now>"
}
```

`pr` and `round_no` are numbers. `ai_approved` (soundness marker, ESCALATE
only) and `spend_usd` are optional. Update the ledger header to
`{{head_sha}}`. Labels and the escalation review request belong to the daemon.
