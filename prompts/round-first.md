# Review round — first review

> Sandbox file: `prompts/round-first.md`. Rendered by `src/templates.ts` and
> injected into the PR session (`pr-{{n}}`) by the daemon. Placeholders:
> `{{n}} {{title}} {{worktree}} {{head_sha}} {{base_ref}} {{base_sha}}
> {{merge_base}} {{lenses}} {{pass_plan}} {{addable_lenses}}
> {{migration_gate_note}} {{settled_digest}} {{round_type}} {{round_no}}`.

---

**ROUND: {{round_type}}** — PR #{{n}} ("{{title}}")
**Worktree**: `{{worktree}}` @ `{{head_sha}}`
**Base branch**: `{{base_ref}}` @ `{{base_sha}}` (merge-base `{{merge_base}}`)
**Lenses this round**: {{lenses}}

Run the full 7-step round from your system prompt. This is the **first** review
of this PR: there is no prior ledger to verify, so step 1 is pure fact-gathering
and every finding is new.

> **You are this PR's only shepherd.** Author replies that arrive while this
> round runs are held by the daemon and delivered after your verdict lands —
> nothing else will be asked of you until you finish. Every agent you need
> comes from the `subagent` tool; you never launch one any other way.

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

## 1. Sync

Establish the facts from the worktree at `{{head_sha}}`: changed files, the diff,
the PR's claimed invariant (title + body). The diff tells you where to look; the
worktree tells you what is true.

**The base branch is fresh this round.** The daemon fetched `{{base_ref}}` at
the same moment it fetched this PR's head, so `origin/{{base_ref}}` in the
worktree is the branch's real tip (`{{base_sha}}`), not a stale clone. Use it
whenever a check is defined against the base — migration numbering and
`dependencies`, "does master already have this fix", sibling divergence. The
PR's own changes are `{{merge_base}}..{{head_sha}}`; commits on
`origin/{{base_ref}}` after the merge-base are NOT part of this PR and must not
be reviewed as if they were.

## 2. Dispatch passes

**Pass plan for this round** (chosen by the daemon from the diff shape):

{{pass_plan}}

Launch every planned pass via the **`subagent` tool** — one `subagent` call per
row, using that row's *subagent to call* name, **all in ONE assistant turn** so
pi-subagents runs them in parallel. Never fan passes out via bash — no
`pi --no-session` subprocesses, ever; the `subagent` tool is the only pass
launcher. Every task string must be self-contained; the passes are blank slates
with zero inherited context:

- worktree path `{{worktree}}` @ `{{head_sha}}`, and that `cwd` is the worktree
- PR #{{n}}, title, and the claims digest (what the PR asserts about itself)
- the focus files for that lens
- the SETTLED list below — "do not re-raise; reference the thread instead"
- the gate notes below, when set

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

Dedup candidates by `(path, changed-line-run)`: highest severity wins, lens tags
concatenate.

## 4. Validate

Dispatch the planned `pass-validate` variant (its row in the plan table) with
**all** candidates plus the SETTLED list. Only its survivors may be posted. Log
its kills (they feed the EOD critic).

## 5. Decide

> **This section is authoritative over steps 5 and 7 of your system prompt.**
> There are no escalation criteria — only the three verdicts below.

- any `[blocker]` ⇒ **REQUEST_CHANGES**
- you cannot decide confidently ⇒ **NEEDS_HUMAN** (set `ai_approved` per your
  confidence that the PR is otherwise sound)
- otherwise ⇒ **APPROVE**

Nits and questions never block. Posting map: P0/P1 → `[blocker]`; P2 →
`[blocker]` if confidence ≥ 0.8 else `[question]`; P3 → `[question]`/`[nit]`.

**NEEDS_HUMAN is a park, not a handoff.** The daemon no longer nominates a
reviewer on GitHub; it stops the PR and shows it to the owner. So the bar is your
own judgment alone — no criteria list decides it for you, and there is no cost
to the reader beyond your review sitting there until a person reads it. Post the
complete review either way: NEEDS_HUMAN means "here is everything I found, and I
am not the one who should call the merge", never a shortened review.

**When in doubt, park.** Never approve a PR you have not convinced yourself of.

## 6. Post

One GitHub review: severity-tagged inline comments anchored **inside changed-line
runs** on the exact path and side (first 50 inline, overflow to the body,
unanchorable → body). The summary body opens with the verdict line and the
lenses line (including any raises/adds with their one-line reasons), then
`### Blockers / Nits / Questions`, the "Start here" guide on NEEDS_HUMAN (say
plainly what you could not decide and what a person should look at first), and
the standard footer. NEEDS_HUMAN posts as a COMMENT — the merge call is not
yours. REQUEST_CHANGES/COMMENT posts **only** through
`scripts/post-review.sh`; **APPROVE always goes through
`scripts/approve-pr.sh`** (posts and clears both triggers).

## 7. Return

Write `verdict/pr-{{n}}-round-{{round_no}}.json` with EXACTLY this JSON shape —
the daemon rejects anything else (extra fields are fine, missing/renamed ones
are not):

```json
{
  "pr": {{n}},
  "round_no": {{round_no}},
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "NEEDS_HUMAN",
  "ai_approved": true,
  "head_sha": "{{head_sha}}",
  "summary": "<3-4 plain sentences for the owner>",
  "finished_at": "<ISO-8601 UTC now>"
}
```

`pr` and `round_no` are numbers. `ai_approved` (soundness marker, NEEDS_HUMAN
only) and `summary` are optional — but always write `summary`: 3-4 plain
sentences telling the owner what is going on with this PR right now (what the
change does, what this round found, where it stands), plus any tier raises or
added lenses with their reasons. No markdown, no lens jargon; it renders
verbatim in his TUI detail pane. Never report spend or cost figures — the
daemon measures usage itself. Update the ledger to the state at
`{{head_sha}}`. The daemon owns labels and the PR's lifecycle state — never
touch those yourself, and never request a reviewer on GitHub.
