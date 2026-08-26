---
name: adjudicate
description: Judge one piece of "the review was wrong" feedback — does the complaint survive contact with the code? Use when asked to work the feedback on a PR, settle a disputed finding, or decide whether a complaint about the reviewer is fair, and to attribute it, record it, and land any change it justifies.
---

# Adjudicating feedback about the review

This file **is** the doctrine. It was decided with the owner on
(issue tracker, effort `review-feedback-loop`); that ticket is provenance, not
the live rule. If the doctrine changes, it changes here.

## The stance

`agents/pass-validate.md` tells the validator: *"You are the adversary: your
job is to kill what doesn't survive contact with the code. A
plausible-but-wrong finding posted to a teammate costs more than a missed
nit."*

**You are that adversary pointed the other way.** The question is not whether
the author was annoyed, whether the tone was bad, or whether a human said the
review was wrong. It is: **does this complaint survive contact with the code?**

Neither account is trusted on its own — not the complainant's, not the
review's. Accepting feedback at face value compromises the review's integrity;
refusing it throws away the only real signal there is.

## Step 1 — Pull totality. Three sources, always.

An adjudication is not started until you have reached for all three. This is a
**sourcing requirement, not a threshold** — there is no confidence cutoff and
no evidence score.

1. **The human side** — what the human actually said, in full: the thread, the
   inline replies, the review body, the reaction, whether they merged over the
   finding or dismissed the review. *For now this is only what is on the PR.*
   Asking the human what they meant is deferred to the Slack channel when it
   exists; do not substitute for it by profiling the person from old
   statements elsewhere in the repo.
2. **The review side** — what the reviewer actually posted and why: the round,
   the lens that raised it, the severity and its reachability, the delivery
   shape (blocker vs question vs nit), the round number, how long the PR had
   been in ping-pong.
3. **The fact from the code** — re-derive the finding yourself against the
   reviewed source. Not "is the finding plausible" but "is it *true* of this
   code". This is the source that settles most episodes, and the one most
   easily skipped.

If a source is genuinely unreachable, say which one and what that costs the
verdict. Never fill the gap by inference and never present two sources as
three.

## Step 2 — Ask the three questions. Every time.

Feedback almost always says *"too much"*, and the useful reading is usually
adjacent to the stated one. All three are asked on every episode, even when
the answer is a quick no:

a. **Was the finding RIGHT but the DELIVERY wrong?** The most common real
   pattern in the evidence. The migration-renumber class was a *correct*
   finding delivered as a blocker — ~15% of all blockers — and changed
   how it is delivered, never whether it runs.
b. **Did we MISS something worse?** A PR that drew a complaint is a PR someone
   read hard. This is the false-negative direction nothing else measures, and
   the retro's biggest blind spot. Look while you have the code open.
c. **Is the complaint about VOLUME rather than merit?** Blocker precision was
   at ceiling (0 disputed of 68) while nits and questions were 85% of output.
   A volume complaint answered by moving the blocker bar cuts the wrong thing.

## Step 3 — Attribute. The vocabulary is fully open.

*review-defect* (false positive, overzealous, wrong evidence), *author-fault*
(bad code, a wrong assumption from the start, a PR that degenerated into a nit
storm and ended in misattributed frustration), *process-defect* (delivery,
verdict shape, wall-clock cost), *noise* — these are a **starting point, not a
set**. Name the fault as the episode demands and **invent a class when none
fits**, with the reason recorded in the same entry.

Attribution may land on the review, on the author, on the code, on the
process, or on **nobody at all**. "Nobody was wrong; this is what a hard PR
looks like" is a real verdict.

**The accepted cost, recorded deliberately:** an open vocabulary means
verdicts are **not queryable by tag**. Finding cross-episode patterns means
re-reading prose, not running a query. Fidelity per item was preferred to
mineability across items — do not "fix" this by quietly collapsing back to a
fixed set.

## Step 4 — Every attribution carries a FALSIFIER. Never a confidence number.

Write the **specific observation that would flip this verdict**: the fact
someone could go and check, that would prove the attribution wrong.

> Falsifier: if the base branch had `flush_on_close = True` at the merge base,
> the finding was correct and this is not a review defect.

**Do not attach a confidence number, a percentage, a likelihood, or a hedging
adjective standing in for one.** `docs/review-merit-assessment.md` §6 found
self-reported confidence is *unaudited*, and the P2 blocking threshold already
keys off one — a generous lens silently lowers the merge bar. A second
self-reported number invites the same failure. A named falsifier is checkable,
and it tells the next session where to look. If you find yourself wanting to
write "probably" or "70%", you are describing evidence you have not gone and
got: go and get it, or state the falsifier instead.

## Step 5 — The counter-case is mandatory whenever the verdict CHANGES something.

Construct the **strongest case that the author was at fault**, and write it
down **even when it loses**. Not a token paragraph — the version that would
persuade someone who had not read your verdict.

A verdict of *"the review was right, no change"* needs no counter-case:
nothing is at risk. Ceremony falls where the blast radius is.

## Step 6 — Ambiguity resolves to the owner, never by rule.

When the three sources disagree and the code does not settle it, **present the
conflict and let him decide, in the column**. Do not force a verdict on
ambiguous evidence, and do not break ties by rule — least of all by
code-always-wins, which is deaf to complaints about delivery, tone and volume,
and that is most of what the humans actually said.

Say what each source says, say what would settle it, and stop.

## Step 7 — The record

There are three durable receipts, and they mean different things. The feedback
inbox derives its state from them; writing the wrong one makes work disappear
or look undone.

### Investigated, but no verdict: needs attention

When totality was attempted but a missing source or genuine ambiguity prevents
an adjudication, write exactly one reviewer-memory `note` for the exact episode:

```
#feedback-review #feedback pr=1234 episode=<stable-episode> status=needs-attention reviewed=2026-08-25
Reason: <what was examined, exactly what is missing or conflicted, and what the owner must decide or supply>
```

This is NOT an adjudication and never substitutes for one. It changes the inbox
from `UNPROCESSED` to `PROCESSED · NEEDS ATTENTION`; a later exact
`#adjudication` supersedes it.

### Reached verdict: settled

**Every adjudication gets a structured memory entry** in the **reviewer**
namespace, written as a `note` (a machine writer's entry, stored verbatim with
its own tags — never as `add`, which marks an entry as the owner's own words).
Fixed fields wrapped around free-form attribution and reasoning, in the
existing `#tag` + `k=v` header shape (`src/memory/eventtags.ts`):

```
#adjudication #feedback pr=1234 episode=f2-flush-on-close attribution=review-defect changed=yes adjudicated=2026-08-25
Complaint: <the human's own words, or the closest fair paraphrase, one line>
Attribution: <the class — invent one if none fits, and say why in a clause>
Falsifier: <the one observation that would flip this verdict>
Missed-worse: <what a look for the false-negative direction turned up, or `nothing found`>
Volume-or-merit: <which, in a clause>
Changed: <the exact surface and commit — or `nothing`>
Counter-case: <the strongest case the author was at fault; required whenever Changed is not `nothing`>
```

Header mechanics that matter, because the parser is header-only by design:

- The header is the **leading run** of `#tag` tokens followed by the `k=v`
  run; the scan stops at the first token that is neither. Anything after the
  first prose word cannot mint a tag — which is exactly why quoted human text
  in the body is safe to include verbatim. Keep the whole header on line one.
- `k=v` values carry **no whitespace** (`[a-z][a-z0-9_-]*=<no-spaces>`). That
  is why the falsifier is a prose line and not a tag value: it is a sentence,
  and a sentence does not fit in a value.
- **`#adjudication` is the one fixed handle.** Because attribution is open
  (Step 3), that tag is the only thing making the set of verdicts findable at
  all. Never drop it, never rename it, never let it drift to a synonym.
- Never `#pinned`. Pinned entries ride the guaranteed head of every review
  round; an adjudication is evidence, not a standing instruction.
- One fact per entry, evidence-linked. Never store anything derivable from
  current state — PR lists, queue contents, spend, verdicts on the board.

**An adjudication that changes something ALSO gets a tracker ticket**, on the
review-feedback-loop effort, carrying the counter-case and the diff. The
memory entry is the durable trace; the ticket is the argument.

Writing to reviewer memory is otherwise only done on the owner's explicit ask —
here, the ask to adjudicate is the ask to record. Say what you wrote. A write
refused on `expect_hash` means someone else edited that entry: re-read and
re-decide, never force.

### Actually landed and live: acted on

An adjudication with `Changed: …` stays in the active inbox while the change is
only proposed, ticketed, committed locally, or waiting to deploy. Archive it
ONLY after the exact improvement reached its target surface and was verified
there. Then write one additional reviewer-memory `note` for each exact episode:

```
#feedback-action #feedback pr=1234 episode=<stable-episode> action=landed acted=2026-08-25
Result: <commit/ticket outcome and the verification that proves it is live>
```

That receipt changes the card to `ACTED ON · ARCHIVED` and removes the original
signal from the active `#feedback` inbox without deleting any record. Never
mint it for a filed ticket, an unratified diff, a local-only commit, a failed or
unverified deploy, or an action on a different episode. If one change settles
several episodes, each episode gets its own exact receipt only after the shared
change is live.

## Step 8 — Landing follows the ratifying turn

A verdict that changes something becomes a commit only under:

- **Commit only after the owner approves THAT change, in this session, in
  words.** Not inferred from him reading the verdict, not from "he asked me to
  adjudicate", not from a general instruction to fix the review.
- **The approval is per batch and dies with the session.** One "yes, all
  three" covers the set just discussed and nothing else. It is **void at
  session end** — after a compaction, a day rollover, or a restart, a prior
  yes is not permission, it is history. Ask again.
- **One purpose per commit.** Touch only what this adjudication justified.
  Prefixed `[companion]` where the companion is the author, and trailered:

  ```
  Feedback-PR: 1234
  Adjudication: FT-NNNN
  Ratified-in-session: <the session id, and his approving words>
  ```

- **Ratified invariants: propose only, never edit.** The CI gate,
  reachability, NIT SCOPE, recheck's one-way transition and the blocker bar
  are the owner's. They are fenced in the files
  (`<!-- RATIFIED FT-NNNN … -->`, `tests/invariant-fences.test.ts`): edit
  freely around a fence, never inside one. Arguing for a change is allowed;
  making it is not.
- `npm test` green and `npm run build` clean before the commit, always.

**The load-bearing sentence, and the first thing to check if this ever goes
wrong:** *the widening rests entirely on the ratifying turn. If a
feedback-derived change ever lands without one — implicitly, by inference, or
from a prior session — the widening is void, not merely violated.*

## Never

- Never treat a complaint as established because a human made it, and never
  protect the review because it is the review.
- Never emit a confidence number, or a hedge that is one in prose.
- Never land a change without the falsifier written down first.
- Never land a change that alters a ratified invariant.
- Never resolve genuine ambiguity by rule instead of handing it to the owner.
- Never claim a source you did not reach, and never write an entry for an
  adjudication that did not happen.
- Never call GitHub, the mutation gate, `deploy.sh`, or the VM. The reviewed
  repo is read-only; feedback and review artifacts reach you through daemon
  state and memory.
