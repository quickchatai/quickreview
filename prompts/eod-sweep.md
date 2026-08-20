# EOD sweep — daily injected prompt

> Sandbox file: `prompts/eod-sweep.md`. Injected by the daemon into the
> `overseer` session at 18:00 Europe/Warsaw (daemon computes the wall clock;
> no pi scheduler involved).

---

Run today's end-of-day sweep. Four products, in order. Date: {{date}}.

## 1. Learnings → memory

For each PR with activity today (rounds, ping-pong, closes — `qcr
today` lists them), diff **what the bot claimed** against **what actually
happened**. Read today's own memory material alongside it: the entries the PR
sessions authored during their rounds, and the day's event entries
(`day={{date}}` — `kind=feedback`, `kind=bug`):

- Findings the author refuted with an argument the bot conceded to.
- Threads resolved as wontfix — extract the pattern if one exists.
- The validator's kill-log — repeated kill reasons are rubric smells.
- **Findings a human raised that the bot missed** (compare human review
  comments on today's PRs against the ledger's finding list) — highest signal;
  never skip this class.

Write each as one entry in the **experiences** area via `viking_write` — the
durable write tool; it batches, so write today's entries in one call: `type`
(missed-finding | false-positive | refuted | wontfix-pattern | repo-gotcha),
the one-sentence lesson, the lens it belongs to, evidence PR link(s), date. No
entry without evidence. Consolidate duplicates; retire entries >90 days old
that never recurred — nothing ages out on its own, so date-filter a search and
retire deliberately.

A learning that is really an **objective fact about the repo** — a convention,
a migration rule, how a subsystem actually behaves — belongs in
`viking://resources/` instead, where every identity can read it, not in your
own experiences area. Promote it there deliberately and only when it is a
fact rather than a judgment; a lesson about how to review stays a learning.

Memory discipline (the owner manages memory from the TUI):

- **The pinned area is untouchable**: never consolidate, rewrite, retire, or
  move an entry in it — those are the owner's standing instructions, and the
  daemon prepends them verbatim to every round prompt. Curation only ever adds
  new entries elsewhere; it never replaces one of his. (A watchdog compares the
  pinned area before and after this sweep and raises an anomaly on any change.)
- **`source=manual` entries are the owner's own words**: treat them as standing
  instructions; consolidate or retire them only when one is superseded by a
  newer manual entry, and say so in the digest.
- **Operational defects of the review system itself get `kind=bug`** (with
  `area=operations`), one entry per distinct defect, evidence-linked. The TUI
  auto-files each as an issue-tracker ticket keyed on the entry — so keep one
  defect to one entry and amend the existing entry rather than re-describing
  the same defect in a new one.
- **If memory is unreachable, say so in the digest and carry on** — an outage
  costs today's learnings, never the sweep's other three products.

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
  `rejected-proposal` memory entry with the reason — never re-propose one
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
