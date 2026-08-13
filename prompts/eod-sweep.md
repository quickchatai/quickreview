# EOD sweep — daily injected prompt

> Sandbox file: `prompts/eod-sweep.md`. Injected by the daemon into the
> `overseer` session at 18:00 Europe/Warsaw (daemon computes the wall clock;
> no pi scheduler involved).

---

Run today's end-of-day sweep. Four products, in order. Date: {{date}}.

## 1. Learnings → memory

For each PR with activity today (rounds, ping-pong, closes — `qcr
today` lists them), diff **what the bot claimed** against **what actually
happened**:

- Findings the author refuted with an argument the bot conceded to.
- Threads resolved as wontfix — extract the pattern if one exists.
- The validator's kill-log — repeated kill reasons are rubric smells.
- **Findings a human raised that the bot missed** (compare human review
  comments on today's PRs against the ledger's finding list) — highest signal;
  never skip this class.

Write each as one pi-memory entry: `type` (missed-finding | false-positive |
refuted | wontfix-pattern | repo-gotcha), the one-sentence lesson, the lens it
belongs to, evidence PR link(s), date. No entry without evidence. Consolidate
duplicates; retire entries >90 days old that never recurred.

## 2. Rubric proposals (when justified)

If ≥3 related learnings have accumulated for one lens — or one severe miss
justifies it alone — draft a rubric change in the sandbox's local git:

- Branch `rubric/<lens>-<topic>-{{date}}`; edit the pass agent file;
  add `PROPOSAL.md` (rationale, evidence PRs, expected effect on
  false-positive/miss rates).
- Never merge it yourself. List it in the digest under "Pending proposals"
  until the owner merges or deletes the branch. Record rejections as
  `rejected-proposal` memory entries with the reason — never re-propose.

## 3. Improvement PRs / issues (within caps)

If today's reviews surfaced repo improvements:

- **Small** (≤50 changed lines, ≤3 files; docs/comments/tests/lint/dead-code;
  no migrations, no infra, no behavior change without a test; max 1/day,
  3/week): prepare the change in a scratch worktree off latest master, write
  the `file-improvement-pr` command file (branch `bot/improve-<slug>`,
  rationale + origin-PR evidence in the body, label `Bot improvement`). The
  daemon diffstat-validates before pushing.
- **Bigger or deferred**: `file-issue` command (label `bot-filed`), after a
  title-similarity dedup against open bot-filed issues; max 3/day.

## 4. The digest

Write `digest/{{date}}.md`:

```
# Review sandbox — {{date}}
## Reviews      — per PR: verdict, rounds, blockers found/fixed
## Awaiting the owner — oldest-first, with age (from daemon's requested-reviewers scan)
## Stuck/stale  — PRs >5 days in awaiting_author; anomalies today
## Spend        — tokens/$ per PR and total; rounds count; validator kill rate
## Learnings    — entries written today (one line each)
## Filed        — improvement PRs, issues, pending rubric proposals
```

Keep it scannable — the status dashboard renders it; a human reads it in 60
seconds. If today was quiet, say so in three lines; never pad.
