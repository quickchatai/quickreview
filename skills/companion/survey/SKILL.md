---
name: survey
description: Sweep the standing candidate list for reviews that departed from the good path, and report them grouped by family, worst first — repeat blocks, dead rounds, repeat approvals, dismissals, disagreements, explicit [feedback]. Use when asked whether there is anything worth looking at, what is on the backlog, or where to start today, and when an honest "nothing found, here is what I checked" is the likely answer. It only surveys — it settles nothing.
---

# Surveying for candidates

This file **is** the doctrine. It was decided with the owner on
(what counts as a candidate) and (why this is its own skill); those
tickets are provenance, not the live rule. If the doctrine changes, it changes
here. The instrument is `src/tui/candidates.ts`, and where this file and that
module disagree, **the module wins** — its code runs, this prose does not.

## What this is, and what it is not

You are answering *"anything worth looking at?"* — and answering it honestly
when the answer is no.

**You survey; you do not judge.** Nothing here decides whether a review was
right, attributes a fault, or writes a verdict. The moment the question turns
into *"was the reviewer wrong on that one?"*, you are done here: hand the item
to **`adjudicate`**, which will pull the evidence and reach a verdict under its
own doctrine. Presenting a candidate as a defect is the one way this skill can
do damage, because a candidate is a **shape**, not a fault: 27 of 29 live
reviews departed from the good path, and most of those departures are fine.

## The one good path, and what counts as leaving it

Perfect is: **triggered → APPROVE in one round → merged.** Everything else is a
departure, and departures are the *space* the survey works in, not a filter that
narrows it — measured on the live corpus, exactly 2 of 29 PRs took the perfect
path.

**One carve-out, and it is the owner's, stated in his own terms: a block the
author accepted and fixed is the review WORKING.** Block → fix → approve is not
a candidate and must never be offered as one. It becomes one only if the block
turned out to be wrong, or was withdrawn. `REPEAT_BLOCK_ROUNDS = 3` in the
module is that carve-out in code: one fix cycle is the review doing its job,
three blocks in a row is a treadmill.

## The seven families

Groups come out in this order — **highest-signal and rarest first** — and
worst-first inside each group. The ordering is the whole usability of the list:
with ~93% of reviews departing, a flat worst-first list buries a rare
disagreement under a pile of long re-blocks, and the rare ones are the
informative ones.

1. **Explicit `[feedback]`** — a human said so, in words, on the PR. The
   highest-confidence family and still the emptiest: zero comments in 1,125
   deliveries at last count.
2. **Human/bot disagreement, in BOTH directions** — a human approving where the
   bot blocked, *and* a human requesting changes where the bot approved. The
   second is the false-negative direction nothing else in the system measures.
3. **The review was dismissed** — the author threw it away rather than
   answering it.
4. **Rounds that produced no verdict** — overdue, malformed, orphaned,
   cancelled. Silent failures; nothing consumed these before.
5. **Blocked round after round** — PR 1234 is the shape: ten rounds, all
   REQUEST_CHANGES, nine of them `staleness` re-runs.
6. **Repeat approvals** — approved, then approved again. Already diagnosed:
   the recheck forbids re-approval, so this family should shrink to
   nothing once it deploys. Detected precisely so we can watch it die — if it
   is still growing after a deploy, that is the finding.
7. **Sheer length** — ten rounds or more, whatever the pattern.

## Where the list lives

**`/evidence/candidates.json`** — read-only, written by the TUI on its poll.
Read it; do not recompute it, and do not build your own list beside it.

- `candidates[]` — every candidate ever seen, with `family`, `severity`,
  `headline`, `detail`, `first_seen`, `last_seen`, `signature`, and `judged`.
- `families[]` — **every family, on every sweep**, with what it scanned, what it
  found, and a named `gap` when its source is not reachable. This is what you
  read out when there is nothing to report.
- `coverage` — PRs scanned, and how many rounds have a local record against how
  many the daemon says exist.

**The list does not expire, and that is deliberate.** The event feed's horizon
is about a day; the reviews worth adjudicating are usually older. A candidate
not worked today is still there next week, with its original `first_seen`. Do
not treat an old `first_seen` as staleness — an item that has sat for three
weeks is an item nobody has answered, which is a reason to raise it, not to drop
it.

If the file is absent, say so: the TUI has not swept yet, or the mount is
missing. Never substitute `/feed/events.jsonl` for it — that is the horizon this
list exists to outlive.

## Judged items return only if the PR moved

An item leaves the open list when an `#adjudication` memory entry for its PR is
observed — the entry `adjudicate` Step 7 already writes. Nothing else marks
anything judged, and **you never edit the list**: `/evidence` is `:ro`, and the
one-directional flow (adjudicate writes memory → the sweep observes it → the row
goes quiet) is the design, not an inconvenience.

A row comes back marked **`returned: true`** when the PR's signature has changed
since it was judged — new rounds, a new head, a new verdict. Say so when you
offer it: *"#1234 is back — you judged it on the 22nd and it has taken four
rounds since"* is a different offer from a fresh candidate, and the owner should
be able to tell them apart.

## Reporting

Short, grouped, worst-first. One line per candidate; the detail lines only for
the ones you are actually recommending.

- Lead with the count and the shape: *"Nine open, mostly long re-blocks — but
  there is one disagreement, and it is the interesting one."*
- **Name the rare family out loud** even when its severity is low. That is what
  the grouping is for.
- **Recommend one**, and say why it is the one. A list of nine with no
  recommendation makes the owner do the sorting the survey was supposed to do.
- Never editorialise on whether the review was wrong. *"Ten blocking rounds"* is
  a fact; *"the reviewer was too harsh here"* is a verdict you have not earned.

## The empty answer

**Report what you checked. Never silence, never a consolation candidate.**

> Nothing worth adjudicating. Checked all seven families across 14 PRs: no
> `[feedback]` comments, no dismissals, no rounds without a verdict, longest
> blocking run 2 (one fix cycle — the review working), no repeat approvals,
> nothing at ten rounds. Two families are dark: disagreement and dismissal both
> need the `feedback_signals` ledger, which has no local copy.

The owner's reasoning, recorded: they have to be able to tell it actually looked. An
empty survey that says "nothing" is indistinguishable from a survey that failed,
and inventing a marginal candidate to have something to say is worse than both.

**Read the `gap` fields and pass them on.** A family with a gap was not checked
clean — it could not be checked at all, and saying "no explicit feedback" when
the comment transport does not exist is a false negative you authored.

## Handing off

- The item needs judging → **`adjudicate`**.
- You need the record of what actually happened first → **`evidence`**.
- Something has already been decided and has to move → **`land`**.
- The question is whether a proposed change would have behaved better →
  **`replay`**.

You have **no `Skill` tool** — invoke one by name, or read
`/workspace/skills/companion/<name>/SKILL.md` directly. You have **no
subagents**: survey one family at a time, yourself, and never pretend a
fan-out ran.

## Never

- Never judge here. A candidate is a shape; the verdict is `adjudicate`'s.
- Never offer a block the author accepted and fixed as a candidate.
- Never answer an empty survey with silence, and never invent a candidate so
  there is something to say.
- Never drop an old candidate for being old, and never add a TTL, a rolling
  window or a top-N cut to the list — the durability is the feature.
- Never report a family as clean when its `gap` says it has no source.
- Never write to `/evidence` — it is `:ro`, and judged-ness flows back through
  memory, never through a second write path.
- Never call GitHub, the mutation gate, `deploy.sh`, or the VM. The list, the
  manifests and the feed are all local files.
