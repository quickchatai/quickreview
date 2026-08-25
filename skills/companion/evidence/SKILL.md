---
name: evidence
description: Reconstruct what actually happened on a past review round — the prompt it was given, the session transcript, the ledger, the verdict, and the code it was reading. Use when asked what happened on a PR, why a round said what it said, which lens raised something, or to assemble the record before anything is judged. Reconstruction only — it reaches no verdict, proposes nothing, and changes no file.
---

# Reconstructing a review episode

This file **is** the doctrine. It was decided with the owner on (the
skill set) and (how evidence reaches you); those tickets are
provenance, not the live rule. If the doctrine changes, it changes here.

## What this is, and what it is not

You are rebuilding an episode so that someone — usually the owner, sometimes you
in a later step — can see what happened. **You are not judging it.** No
attribution, no falsifier, no verdict on whether the review was right. If the
question turns out to be "was the reviewer wrong here?", finish the
reconstruction and then invoke **`adjudicate`**; the doctrine there needs
exactly what you are assembling, and it will not re-do this work.

The output is an account with citations. Every claim in it points at a file you
actually read.

## The read surfaces, in the order you reach for them

**Reach for `/evidence` FIRST for anything in the past.** The VM's live session
is recycled within days; the local copy is indefinite. Everything else is either
about *now* or is a supplement.

1. **`/evidence/pr-<n>/round-<k>/`** (read-only) — what the round actually
   produced. Five legs:
   - `manifest.json` — written **last and atomically**, so its presence means
     the round copied completely. Read it first: it names what landed, what was
     `missing`, whether any file was `truncated`, and carries the round row
     (`status`, `verdict`, `finished_at`) the daemon had. It also scopes every
     file: `scope: "round"` means the file belongs to this round;
     `scope: "pr-current"` means it is **the PR's file as it stood at copy
     time** — see the caution below.
   - `prompt.md` — the order the session was given. What it was asked is half
     of why it answered as it did. **PR-current at copy time**, not
     round-scoped.
   - `session.jsonl` — the transcript. **The lens passes are in here**: they run
     as pi-subagents inside the PR's one session (root rule 9 — passes are
     leaves), so there is no separate per-pass artefact and never was. This is
     where "which lens raised it, and what did the validator do with it" is
     answered. Also **PR-current at copy time** (the newest session JSONL).
   - `ledger.md` — the session's own running account of the PR across rounds.
     It is per-PR, not per-round: the copy in `round-<k>/` is the ledger *as it
     stood at copy time*.
   - `verdict.json` — what it decided, in the daemon's own vocabulary. The one
     genuinely **round-scoped** artefact, always copied.

   **The pr-current caution.** Transcript, ledger and prompt are honest records
   of a round only when the copy happened while that round was fresh — for a
   round that finished before the copier first saw the PR, today's files would
   have been someone else's evidence, so the copier **does not copy them at
   all**: the manifest lists those roles under `skipped_stale` and copies only
   `verdict.json`. Never read a backfilled round's transcript as that round's
   transcript — if a role is in `skipped_stale`, that round's session record
   simply does not exist locally, and the account must say so.
2. **`/example-app`** (read-only) — the reviewed source. Reach for it the
   moment a question turns on what the code *does* rather than on what a finding
   *says* about it. Two standing cautions: the working tree is whatever the owner
   has checked out locally, usually **not** the PR's head — so treat it as the
   repo's shape and history and take the PR's own diff from daemon state; and it
   is mounted `:ro`, so you cannot check anything out, ever.
3. **`/feed/snapshot.json` and `/feed/events.jsonl`** — the board as it is now,
   and the event tail. Ground truth about *the daemon's current view*, and the
   only honest source for "what state is it in right now". Never a source for
   what a past round did.
4. **`qcr why <pr> --json`, `qcr status --json`, `qcr events --json`** — the
   daemon's structured account: round rows, heads, marks, corrections.
5. **Reviewer memory** — `#feedback`, `#bug` and `#adjudication` entries about
   this PR or this class of finding. Memory is a *record of past reasoning*, not
   an observation: cite it as "we concluded X on <date>", never as a fact about
   the code.

## When a leg is missing

Missing legs are normal, and each one means something specific. **Say which leg
is missing and what it costs the account** — that sentence is not optional, and
it is the difference between a reconstruction and a guess.

- **No `round-<k>/` dir at all** — that round was never copied down. The TUI was
  not running when it finished, or the copy is still pending on a later poll.
  It does **not** mean the round did not happen: the daemon's round row in
  `qcr why --json` is the authority on that. Say "no local record of round k".
- **A `manifest.json` with a non-empty `missing`** — the artefact did not exist
  on the VM when the copier looked. A round that died before writing a verdict
  has no `verdict.json`, and that absence is itself the finding.
- **A `manifest.json` with a non-empty `skipped_stale`** — a backfilled round:
  it finished before the copier first saw the PR, so the pr-current roles were
  deliberately not copied (they would have been TODAY's files wearing an old
  round's name). Only the verdict is on record; say "no session record of
  round k (backfilled)".
- **No `manifest.json` but files present** — a half-copy. Trust nothing in that
  dir; it will be redone on a later sweep.
- **`truncated: true`** — you are reading the first 32 MiB of that artefact. For
  a transcript that means the *beginning* of the session, and the tail — where
  the verdict is decided — is what you are missing. Say so before quoting.
- **The `/example-app` mount is absent** — no local checkout. Then you cannot
  read the code, and any question that turns on the code is unanswerable rather
  than answerable-with-caution. Say that instead of reasoning from the diff.
- **The feed is stale** — the TUI is down. Everything you say about "now" is as
  of the snapshot's timestamp; quote it.

Never fill a gap by inference, and never present the daemon's round row as if it
were the session's own account. A missing leg is a fact about the record, and
recording it is part of the job.

## Working through it

You have **no subagents** — every reach is yours, one after another. That is
fine here, because the order above is a funnel and most episodes are settled by
the first two surfaces. Do not read a 0.6 MB transcript end to end: find the
round's verdict decision and the passages around the finding in question, and
work outward.

You have **no `Skill` tool** — when this file says to hand off to `adjudicate`
or `land`, invoke it by name the way you invoke any skill, or read
`/workspace/skills/companion/<name>/SKILL.md` directly.

## The account

Short, and citation-first. The shape that works:

- **What happened** — one or two lines. Rounds, verdicts, how it ended.
- **The timeline** — round by round, each line naming the artefact it rests on
  (`round-2/verdict.json`, `round-3/session.jsonl:…`).
- **What is not in the record** — the missing legs, plainly.
- **What would settle the open question**, if one is left — which artefact,
  which file in `/example-app`, which memory entry.

No verdict, no attribution, no recommendation to change anything. If the
reconstruction makes a change look obvious, say what you saw and stop — deciding
is `adjudicate`, landing is `land`.

## Never

- Never judge the review here. Reconstruct, then hand off.
- Never infer what a session must have done from a round row, a verdict, or the
  shape of the PR. If the transcript is not there, the session's reasoning is
  not known.
- Never claim a surface you did not read, and never present four sources as
  five.
- Never write to `/evidence` or `/example-app` — both are `:ro`, and that is
  the guarantee, not an inconvenience.
- Never call GitHub, the mutation gate, `deploy.sh`, or the VM. Everything
  above is a local file or a daemon-produced read.
- Never write a memory entry for a reconstruction. Reconstruction is not a
  conclusion; only an adjudication is recorded.
