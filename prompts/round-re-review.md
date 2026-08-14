# Review round — re-review

> Sandbox file: `prompts/round-re-review.md`. Rendered by `src/templates.ts` and
> injected into the PR session (`pr-{{n}}`) by the daemon. Placeholders:
> `{{n}} {{title}} {{worktree}} {{head_sha}} {{lenses}} {{pass_plan}}
> {{addable_lenses}} {{escalation_criteria}} {{migration_gate_note}}
> {{settled_digest}} {{round_type}} {{round_no}}`.

---

**ROUND: {{round_type}}** — PR #{{n}} ("{{title}}")
**Worktree**: `{{worktree}}` @ `{{head_sha}}`
**Lenses this round**: {{lenses}}

The author handed this PR back. Run the full 7-step round — but step 1 comes
first and is non-negotiable: **verify every prior open finding at the new head
before hunting anything new.**

## GitHub routine — use the scripts

Routine GitHub work goes through the repo's contained scripts, never
hand-rolled multi-part `gh`/GraphQL spells:

- `scripts/pr-context.sh {{n}}` — one-shot read bundle: meta, diffstat, CI
  checks, latest reviews, unresolved threads. Start here.
- `scripts/pr-checks.sh {{n}}` — CI status.
- `scripts/pr-threads.sh {{n}}` — unresolved threads with ids.
- `scripts/post-review.sh {{n}} <REQUEST_CHANGES|COMMENT> <body-file>
  [comments-json]` — the ONLY way to post the review; never raw `gh` mutations.
- `scripts/reply-thread.sh {{n}} <comment-id> <body-file>` — author ping-pong
  replies.

Token hygiene (measured on live rounds, 2026-08-14):
- Tool output truncates at ~50 KB — a full-PR `git diff --unified=80` dump
  burns the budget and still arrives cut off. Diff per file with default
  context; open whole files with the `read` tool when you need more.
- Your conversation persists across rounds: do NOT re-fetch context you
  already hold (same head sha = same diff, same threads). Fetch only what
  changed since your last round.

- `scripts/approve-pr.sh` — APPROVE (posts and clears both triggers).

Raw `gh` is for additional READS only; every mutation goes through a script.

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

**Pass plan for this round** (chosen by the daemon from the diff shape):

{{pass_plan}}

Launch every planned pass via the **`subagent` tool** — one `subagent` call per
row, using that row's *subagent to call* name, **all in ONE assistant turn** so
pi-subagents runs them in parallel. Never fan passes out via bash — no
`pi --no-session` subprocesses, ever; the `subagent` tool is the only pass
launcher. Every task string is blank-slate and self-contained: worktree
`{{worktree}}` @ `{{head_sha}}`, PR #{{n}} + claims digest, that lens's focus
files, the SETTLED list, the gate notes — **plus the prior open findings
assigned to that lens, with the instruction to verify each mechanically at the
current head and report its true state before looking for anything new.**

**Raise protocol.** You MAY swap a pass to a higher-tier variant from its "may
raise to" column when the diff's semantic complexity demands it — each raise
needs a one-line stated reason, and those reasons go into the verdict
`summary`. **Never lower a tier.** A pass marked pinned has no raise option.

**Add protocol.** You MAY additionally run a lens from: {{addable_lenses}} —
with a one-line stated reason. Run it at the plan's default tier: call the
`<lens>--sol-med` variant, unless it is a risk pass (risk passes exist only as
`<lens>--sol-high`). **Never drop a planned lens.**

**No-exec policy (absolute).** You and every pass NEVER execute project code,
tests, builds, or package managers — no test runners, no app entrypoints, no
`npm`/`pip`/`make`/compilers, ever. CI results are read via `gh pr checks` /
`gh api` (read-only). Reading the tree is allowed: git, rg, cat, gh reads.

**SETTLED**
{{settled_digest}}

**GATE NOTES**
{{migration_gate_note}}

## 3. Merge

Dedup by `(path, changed-line-run)`; highest severity wins; lens tags
concatenate. A re-raised prior finding keeps its ledger id.

## 4. Validate

Dispatch the planned `pass-validate` variant (its row in the plan table) with
all candidates + the SETTLED list. Only survivors post. Log the kills.

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
overflow to body), summary with verdict + lenses lines (including any
raises/adds with their one-line reasons), `### Blockers / Nits / Questions`, a
**"Previously deferred, unchanged"** section listing prior findings that are
still open and unaddressed, "Start here" on ESCALATE, standard footer.
REQUEST_CHANGES/COMMENT posts **only** through `scripts/post-review.sh`;
APPROVE goes through `scripts/approve-pr.sh`.

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
  "summary": "<3-4 plain sentences for the owner>",
  "finished_at": "<ISO-8601 UTC now>"
}
```

`pr` and `round_no` are numbers. `ai_approved` (soundness marker, ESCALATE
only) and `summary` are optional — but always write `summary`: 3-4 plain
sentences telling the owner what is going on with this PR right now (what the
change does, what this round found, where it stands), plus any tier raises or
added lenses with their reasons. No markdown, no lens jargon; it renders
verbatim in his TUI detail pane. Never report spend or cost figures — the
daemon measures usage itself. Update the ledger — every prior finding must end
this round marked `fixed@<sha>`, `open`, `conceded`, or `settled`, never
silently dropped. Labels and the escalation request are the daemon's.
