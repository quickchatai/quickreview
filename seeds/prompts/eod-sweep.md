# EOD sweep — daily injected prompt

Run today's end-of-day sweep. Four products, in order. Date: {{date}}.

## 1. Learnings → memory

**Start from the outcomes packet.** The daemon has already mined today's
evidence into candidates — the section "Outcomes to curate" below this prompt
(also `state/eod/{{date}}/outcomes.md`). Every candidate there names its
class, the lenses it touches, whose words its evidence is (a person's, or the
review system's own), and the lessons already covering its class. Decide every
offered candidate; an undecided one comes back tomorrow.

Then, for each PR with activity today (rounds, ping-pong, closes — `qcr
today` lists them), diff **what the bot claimed** against **what actually
happened**, for anything the packet does not already carry. Read today's own
memory material alongside it: the entries the PR sessions authored during
their rounds, and the day's event entries in the **events** area
(`viking://user/reviewer/memories/events/`, `day={{date}}` — `kind=feedback`,
`kind=bug`):

- Findings the author refuted with an argument the bot conceded to.
- Threads resolved as wontfix — extract the pattern if one exists.
- The validator's kill-log — repeated kill reasons are rubric smells.
- **Findings a human raised that the bot missed** (compare human review
  comments on today's PRs against the ledger's finding list) — highest signal;
  never skip this class.

Write each learning as a **typed lesson** in the **experiences** area
(`viking://user/reviewer/memories/experiences/`) via `viking_write` — the
durable write tool; it batches, so write today's lessons in one call. Pass the
lesson's fields as the tool's `lesson` parameter — `kind` (repo-fact |
look-for | dont-raise | convention), `lens` (the built lens ids it is for),
`class` (reuse the candidate's class), `paths` and `evidence` — and the
tool writes the header line; `content` is the one-sentence lesson and its
evidence PR link(s), nothing more. Cite every candidate a lesson adopts as
`cand:c<id>` in its evidence. No lesson without evidence. Consolidate
duplicates; retire lessons >90 days old that never recurred — nothing ages out
on its own, so date-filter a search and retire deliberately.

A learning that is really an **objective fact about the repo** — a convention,
a migration rule, how a subsystem actually behaves — is a lesson of kind
`repo-fact` (or `convention`), in the same experiences area. Write it that way
deliberately and only when it is a fact rather than a judgment; a lesson about
how to review stays a `look-for` or `dont-raise`.

**Close §1 with the curation receipt.** Write ONE command file into
`commands/` — `eod-curation-receipt`, with `day: "{{date}}"` and one decision
per group of candidates: `adopted` (with the `lesson` URI you wrote),
`declined` (with the reason it is not a lesson) or `refused` (with the write's
error). A missing receipt wakes the operator the next day.

<!-- RATIFIED memory-discipline (reseeded 2026-10-07) — do not edit; owner only -->
Memory discipline (the owner manages memory from the TUI):

- **The pinned area is untouchable**: `viking://user/reviewer/memories/
  preferences/pinned/` — an entry is pinned by being placed there. Never
  consolidate, rewrite, retire, or move an entry in it — those are the owner's
  standing instructions, and the daemon prepends them verbatim to every round
  prompt. Curation only ever adds new entries elsewhere; it never replaces one
  of theirs. (A watchdog compares the pinned area before and after this sweep
  and raises an anomaly on any change.)
- **`#manual` entries in `preferences/` are the owner's own words**: treat
  them as standing instructions; consolidate or retire them only when one is
  superseded by a newer manual entry, and say so in the digest.
- **Operational defects of the review system itself are `kind=bug` entries in
  the events area**, with `kind=bug area=operations` in the entry's header
  (never only in its body), one entry per distinct defect, evidence-linked.
  The TUI auto-files each as an issue-tracker ticket keyed on the entry — so
  keep one defect to one entry and amend the existing entry rather than
  re-describing the same defect in a new one.
- **If memory is unreachable, say so in the digest and carry on** — an outage
  costs today's learnings, never the sweep's other three products. Still write
  the receipt, deciding every candidate you could not write as `refused` with
  the error.
<!-- /RATIFIED memory-discipline -->

## 2. Rubric candidates (when justified)

If ≥3 related learnings have accumulated for one lens — or one severe miss
justifies it alone — **flag it as a rubric candidate and author nothing
else**. You do not draft rubric changes: no proposal directory, no patch, no
edit to any file under `agents/` or `prompts/`.

- Name the candidate in the digest under "Rubric candidates": the lens, the
  one-line problem, the evidence PRs, and the memory entries it rests on.
- That is the whole product. Changing a rubric is the owner's call, made
  elsewhere; your job is to surface the signal, never to prepare the change.

## 3. Improvement PRs / issues (within caps)

If today's reviews surfaced repo improvements:

<!-- RATIFIED improvement-caps — do not edit; owner only -->
- **Small** (≤50 changed lines, ≤3 files; docs/comments/tests/lint/dead-code;
  no migrations, no infra, no behavior change without a test; max 1/day,
  3/week): prepare the change in a scratch worktree off latest master, write
  the `file-improvement-pr` command file (branch `bot/improve-<slug>`,
  rationale + origin-PR evidence in the body, label `Bot improvement`). The
  daemon diffstat-validates before pushing.
- **Bigger or deferred**: `file-issue` command (label `bot-filed`), after a
  title-similarity dedup against open bot-filed issues; max 3/day.
<!-- /RATIFIED improvement-caps -->

## 4. The digest

Write `digest/{{date}}.md`:

```
# Review sandbox — {{date}}
## Reviews      — per PR: verdict, rounds, blockers found/fixed
## Awaiting the owner — oldest-first, with age (from daemon's requested-reviewers scan)
## Stuck/stale  — PRs >5 days in awaiting_author; anomalies today
## Spend        — tokens/$ per PR and total; rounds count; validator kill rate
## Learnings    — candidates decided (adopted / declined / refused) and lessons written today (one line each)
## Filed        — improvement PRs, issues, flagged rubric candidates
```

Keep it scannable — the status dashboard renders it; a human reads it in 60
seconds. If today was quiet, say so in three lines; never pad.
