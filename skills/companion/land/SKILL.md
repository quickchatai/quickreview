---
name: land
description: Get an already-decided change into the repo on the right surface — which of the three routes it takes, and the ratifying turn it needs first. Use when a change has been agreed and has to become a commit here, a tracker ticket, or a proposal to the owner, or when the question is which surface it belongs on and what the commit must carry. It decides nothing about whether the change is correct — that argument belongs earlier, not here.
---

# Landing a change

This file **is** the doctrine: the routes and the authority they run under
were decided with the owner. If the doctrine changes, it changes here.

## The gate before any route: the ratifying turn

Nothing below fires until this passes. It is not a formality — **the entire
authority to commit rests on it**, because the boundary that used to stop you is
now prose plus this turn and nothing else.

- **Commit only after the owner approves THAT change, in this session, in words.**
  Not inferred from them reading your verdict. Not from "they asked me to look at
  the feedback". Not from a standing instruction to improve the reviewer. Not
  from their silence.
- **The approval is per batch.** One "yes, all three" covers the three changes
  just discussed and nothing else. A fourth change you noticed while committing
  the third is not covered — ask.
- **It is void at session end.** After a compaction, a day rollover, or a
  restart, a previous yes is history, not permission. Ask again. If you cannot
  point at their approving words *in the conversation you are currently in*, you
  do not have one.
- **Ambiguous is not approved.** "Sounds right" about an argument is not
  approval of a diff. If you are constructing an argument for why it counts, it
  does not.

**The load-bearing sentence, and the first thing to check if this ever goes
wrong:** *if a change ever lands without a ratifying turn — implicitly, by
inference, or from a prior session — the widening is void, not merely
violated.*

## Which route: three surfaces, three answers

Decide the surface first. It is almost always obvious, and picking wrong is the
one way to turn a good change into a bad one.

### 1. Review-side — how the reviewer judges (`prompts/`, `agents/`)

Round templates, lens bodies, the addendum registry's effect on what a pass
says. **This is yours now**, through the conversation, under the ratifying turn.
The old producer — the EOD curator writing `state/rubric/<slug>/` on the VM —
is **retired**: the curator flags candidates in the digest and
authors nothing, and never ask the overseer to draft one. The proposal
*surface* lives on, and **you are its producer now**: when a review-side
change needs the owner's ratification rather than a ratifying turn, you author
a proposal directory and their accept click in the TUI ratifies it.

#### Authoring a rubric proposal (the TUI-accept route)

- **Where**: `state/rubric/<lens>-<topic>-<YYYY-MM-DD>/` under `/workspace` —
  the LOCAL repo's state dir, the same tree the TUI's `[7] feedback` tab
  reads (`src/tui/proposals.ts` lists it from the repo root; there is no VM
  path in this loop). Slug charset `[A-Za-z0-9._-]`, no leading dot, or the
  TUI never lists it.
- **What it contains**, exactly two files:
  - `PROPOSAL.md` — the pitch: rationale, evidence PRs, expected effect on
    false-positive/miss rates. First three non-blank lines are the card the
    TUI shows; make them carry the argument.
  - `changes.patch` — ONE unified diff against the current `agents/` /
    `prompts/` files, paths repo-relative with `a/` `b/` prefixes
    (`git diff` output is the right shape).
- **Targets: `agents/` and `prompts/` only.** The TUI refuses anything else —
  both diff sides plus rename/copy headers are checked, so a deletion or
  rename cannot smuggle a path in. It equally refuses a patch that touches
  lines inside a `<!-- RATIFIED … -->` fence or adds a fence marker of its
  own: a proposal can argue against a ratified passage, never carry one in.
- **You NEVER apply the patch yourself.** the owner's accept click in the TUI
  IS the ratification (accept = apply + auto-ratify + local commit; the
  divergence fixture and seed manifest are re-pinned by that path, not by
  you). Reject removes the dir and records a `#rejected-proposal` memory
  entry — never re-propose one of those. Until they click, the directory is
  inert prose; writing it needs no ratifying turn, precisely because it
  changes nothing.

Two things travel with a review-side commit:

- **`prompts/CLAUDE.md` is the map of what is frozen.** Seeded content
  (`pass-common.md`, `conversation-system.md`, `eod-sweep.md`,
  the seeded `agents/pass-*.md`) is frozen under root rule 6 —
  a reseed is the owner's ratification, not yours. Ours to edit: the round
  templates, `companion.md`, `companion-day-open.md`, the Slack appendix. The
  test's own `NON_SEEDED` list is the authority; check it, do not remember it.
- **Pass behaviour changes go through `PASS_ADDENDA` in `src/include.ts`**,
  composed onto BUILT bodies — never through a seed edit. That is a system-side
  commit that happens to change review behaviour, and it is the sanctioned path.
- If a ratified reseed *is* what the owner asked for, the ratification is recorded
  the way the machinery already does it: `recordRatification()` in
  `src/tui/proposals.ts` appends to `tests/fixtures/ratified-divergence.json`
  and re-pins `tests/fixtures/seed-manifest.json`. Same commit as the edit, or
  the suite is red. Do not hand-edit either fixture around it.

### 2. System-side — daemon behaviour (`src/`, `tests/`, `scripts/`, `docs/`)

Severity mapping, dispatch, webhook routing, the TUI, yourself. **One rule for
all of it**: after a ratifying turn, you edit it and commit it. There is
deliberately **no carve-out** — not for the mutation gate, not for the posting
guards, not for "anything structural". The owner rejected both carve-outs
explicitly, and the recorded consequence is that the safety story for a gate
edit is the ratifying turn plus a one-key revert, with no second structural
barrier. Weigh that when you ask.

What does *not* move: rule 1's shape. Every GitHub mutation still goes through
the one `MutationGate`; you may edit the gate, you may never add a path around
it, and `dry_run` is the owner's alone in either direction.

### 3. Author-side — how the code gets written in the first place

The highest-yield surface in the corpus, and the one you touch least directly.
**It becomes a tracker ticket, and the owner acts on it.** Nothing reaches
the reviewed repo until they move.

- Write the ticket on the issue tracker at `/tracker`, as actor `companion`,
  under the concurrency protocol (`/tracker-docs/issue-tracker.md`).
- Carry the argument: the episode, the verdict, the counter-case, and what a
  change to the team's practice would be.
- The daemon's improvement-PR machinery (caps ≤50 lines / ≤3 files, 1/day,
  3/week, enforced in daemon code) remains the **only** path to a bot-filed PR
  and is untouched — you do not feed it, and you never file one yourself. This
  is a deliberate narrowing: changes from feedback are never automatic, and a
  human step is the accepted price.

## Ratified invariants: propose only, never edit

Some passages are the owner's, wherever they live. In the files we own they are
**fenced**:

```
<!-- RATIFIED FT-NNNN ci-gate — do not edit; owner only -->
…the ratified text, byte for byte…
<!-- /RATIFIED ci-gate -->
```

Edit freely *around* a fence; never *inside* one. `tests/invariant-fences.test.ts`
hashes each fence's contents and fails just as loudly when a marker goes missing
— deleting the fence is not a way around the pin. The same holds for the
invariants living in `src/` that have no fence yet (the CI gate in
`cigate.ts`, reachability in `severity.ts`, the one-way transition in
`recheck.ts`, `validatorTier` in `dispatch.ts`, the migration COMMENT rule):
**their being unfenced is a gap, not permission.**

Arguing for a change to one is allowed and welcome. Making it is not. A verdict
that requires changing a ratified invariant lands as an argument in the column
and, where the invariant lives in a prompt or lens, as a rubric proposal
directory (route 1 above — PROPOSAL.md making the case, and a patch the TUI
will accept only for the *unfenced* text around it; the fence itself stays
theirs) — never as a commit you write first and mention after.

## The commit

- **One purpose per commit.** Touch only what this change justified. If you
  notice something else while you are in the file, note it and leave it.
- **`master` in the real checkout, never a worktree** (root rule 11). That is
  yours alone and it is deliberate: the owner is watching the TUI you are editing,
  and the hot reload watches the main checkout's `dist/`. The tree is shared
  with worktree agents who are under orders never to stash your work — so commit
  coherent work promptly rather than sitting on a wide diff.
- **Green before committing, always**: `timeout 900 npm test` with zero
  failures, then `npm run build` clean. Never commit with a red suite. The build
  is also how the change reaches the running TUI — say what you are about to
  rebuild before you do it, so a screen blink is never a surprise.
- **Message**: `[companion]` prefix (plus `FT-NNNN` where relevant), and the
  trailers that make the loop auditable and reversible:

  ```
  Feedback-PR: <n>
  Adjudication: FT-NNNN
  Ratified-in-session: <the session id, and their approving words>
  ```

  `Feedback-PR:` and `Adjudication:` are omitted when the change did not come
  from an episode. `Ratified-in-session:` is never omitted.
- **Tell them what you changed, in one line**, naming the surface.

## Did it actually reach the reviewer?

A committed review-side or system-side change is not live until the VM has it,
and **you may never deploy** — `deploy.sh` in any mode is outside the boundary,
in every direction, permanently.

The answer is already on the owner's screen: the deploy tab shows the VM's
`BUILD_SHA`, local `HEAD`, the pending commit list with diffstat, and
`deploy.sh --dry-run`'s plan verbatim. So the honest report is: *"committed; it
shows as pending on the deploy tab; it reaches the reviewer when you deploy."*
Never say a change is live because you committed it, and never press the deploy
tab's button on your own judgment — that verb is their finger, not yours.

## Never

- Never commit without a ratifying turn in the current session, for that
  specific change.
- Never treat a prior session's approval, a general instruction, or your own
  confidence as one.
- Never edit inside a `RATIFIED` fence, or delete a fence marker.
- Never touch a frozen seed without a ratification recorded in the same commit.
- Never batch two purposes into one commit, and never commit with a red suite.
- Never call GitHub — no `gh`, no API, no token, no branch, no PR, no issue.
  Author-side is a tracker ticket, and that is the whole of it.
- Never run `deploy.sh`, never write to the VM, never hold a VM credential.
- Never push anything anywhere: the sandbox has no remote, and the reviewed repo
  is mounted `:ro`.
- Never land a change you have not argued for. Deciding is `adjudicate`;
  understanding is `evidence`; trying it against the past is `replay`.
