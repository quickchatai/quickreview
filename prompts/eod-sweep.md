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

Memory discipline (the owner manages memory from the TUI):

- **`#pinned` entries are untouchable**: never consolidate, rewrite, retire,
  or move them — the owner pinned them at the top of MEMORY.md deliberately
  (that region survives injection truncation). Never `memory_write` with
  `mode:"overwrite"`; append only.
- **`#manual` entries are the owner's own words**: treat them as standing
  instructions; consolidate or retire them only when one is superseded by a
  newer #manual entry, and say so in the digest.
- **Operational defects of the review system itself get `#bug`** (with
  `#operations`), one entry per distinct defect, evidence-linked. The TUI
  auto-files each as an issue-tracker ticket keyed on the entry — so keep one
  defect to one entry and amend the existing entry rather than re-describing
  the same defect in a new one.

## 2. Rubric proposals (when justified)

If ≥3 related learnings have accumulated for one lens — or one severe miss
justifies it alone — draft a rubric change as a proposal directory (the
sandbox here is an rsync target with no git; `state/` is the surface that
survives deploys):

- Create `state/rubric/<lens>-<topic>-{{date}}/` containing `PROPOSAL.md`
  (rationale, evidence PRs, expected effect on false-positive/miss rates)
  and `changes.patch` — a unified diff against the shipped `agents/` /
  `prompts/` files (`diff -u` old vs proposed; paths relative to the
  sandbox root, `a/` `b/` prefixes). Touch nothing outside `agents/` and
  `prompts/` — the TUI refuses such patches.
- Never apply it yourself. List it in the digest under "Pending proposals"
  until the owner accepts or rejects it in the TUI (accept applies + ratifies
  + removes the directory; reject removes it and records a
  `#rejected-proposal` memory entry with the reason — never re-propose one
  of those).

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
