# Review round — first review

> Sandbox file: `prompts/round-first.md`. Rendered by `src/templates.ts` and
> injected into the PR session (`pr-{{n}}`) by the daemon. Placeholders:
> `{{n}} {{title}} {{worktree}} {{head_sha}} {{lenses}} {{escalation_criteria}}
> {{migration_gate_note}} {{settled_digest}} {{round_type}}`.

---

**ROUND: {{round_type}}** — PR #{{n}} ("{{title}}")
**Worktree**: `{{worktree}}` @ `{{head_sha}}`
**Lenses this round**: {{lenses}}

Run the full 7-step round from your system prompt. This is the **first** review
of this PR: there is no prior ledger to verify, so step 1 is pure fact-gathering
and every finding is new.

## 1. Sync

Establish the facts from the worktree at `{{head_sha}}`: changed files, the diff,
the PR's claimed invariant (title + body). The diff tells you where to look; the
worktree tells you what is true.

## 2. Dispatch passes

Launch **{{lenses}}** as subagents **in parallel** (one assistant turn, one
`subagent` call each — pi-subagents runs them concurrently). Every task string
must be self-contained; the passes are blank slates with zero inherited context:

- worktree path `{{worktree}}` @ `{{head_sha}}`, and that `cwd` is the worktree
- PR #{{n}}, title, and the claims digest (what the PR asserts about itself)
- the focus files for that lens
- the SETTLED list below — "do not re-raise; reference the thread instead"
- the gate notes below, when set

**SETTLED**
{{settled_digest}}

**GATE NOTES**
{{migration_gate_note}}

## 3. Merge

Dedup candidates by `(path, changed-line-run)`: highest severity wins, lens tags
concatenate.

## 4. Validate

Dispatch `pass-validate` with **all** candidates plus the SETTLED list. Only its
survivors may be posted. Log its kills (they feed the EOD critic).

## 5. Decide

Ported verdict logic:

- any `[blocker]` ⇒ **REQUEST_CHANGES**
- the escalation criteria below, or your own judgment that you cannot decide
  confidently ⇒ **ESCALATE** (set `ai_approved` per your confidence that the PR
  is otherwise sound)
- otherwise ⇒ **APPROVE**

Nits and questions never block. Posting map: P0/P1 → `[blocker]`; P2 →
`[blocker]` if confidence ≥ 0.8 else `[question]`; P3 → `[question]`/`[nit]`.

**ESCALATION CRITERIA**
{{escalation_criteria}}

**When in doubt, escalate.** Escalation is the safe default: it is a full review
plus a human second opinion, never a shallow handoff or a shortened review.

## 6. Post

One GitHub review: severity-tagged inline comments anchored **inside changed-line
runs** on the exact path and side (first 50 inline, overflow to the body,
unanchorable → body). The summary body opens with the verdict line and the
lenses line, then `### Blockers / Nits / Questions`, the "Start here" guide on
ESCALATE, and the standard footer. **APPROVE always goes through
`scripts/approve-pr.sh`** (posts and clears both triggers).

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
only) and `spend_usd` are optional. Update the ledger to the state at
`{{head_sha}}`. The daemon owns labels and the escalation review request —
never touch those yourself.
