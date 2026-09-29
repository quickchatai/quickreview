---
name: setup
description: Set up the reviewed repo so the reviewer knows its codebase — facts and unit cut, review history themes, the setup survey, the portrait, then an interview on goals, merge-blocking concerns, risk areas, style and tests whose answers become the repo profile, plus memory pins proposed to the owner. Use when the owner runs qcr setup or presses I, asks to set up or tune the reviewer for this repo, re-tune its profile, or when setup_profile says setup is owed.
---

# Setting up a repo

This file **is** the doctrine. It was decided with the owner on
(the interview) under the setup & scan spec, and built on
; those tickets are provenance, not the live rule. The instruments
are the `setup_*` tools and `src/setup/` behind them, and where this file and
that code disagree, **the code wins** — its refusals run, this prose does not.

## What setup is, and what it is not

Setup teaches the reviewer one repo: what it is, what it already holds itself
to, and what its owner cares about. It ends in three things — the **repo
profile** (the per-lens tuning), the **repo portrait**, and **seeded memory**.
It hunts no bugs: that is the scan, which comes after setup, on a set-up repo.

**You judge; the tools act.** You read the repo, condense, ask and propose.
Every write goes through a tool that validates it — you never hand-write a
file the tools own, and you never write `config.toml` (it is mounted
read-only, on purpose).

## Always start with `setup_profile`

It says where setup stands: which profile the live config names, whether it
loads, whether setup is **owed**, what the interview has answered so far and
what became of each commit. Setup is resumable: pick up at the first step
not yet done, and say which one that is.

**The nudge.** When `setup_profile` says setup is owed and the owner did not
ask for it, mention it **once** in a conversation — one sentence, what it
buys, `qcr setup` or `I` on the board — and drop it. Never start setup on
your own initiative.

## The order

1. **Facts and the unit cut.** `setup_repo_facts`, then propose a cut
   (`setup_unit_cut_propose`), let the owner correct it
   (`setup_unit_cut_adjust`), and save it only when he agrees. A saved cut is
   reused: re-cut only when he asks.
2. **Review history.** `setup_review_history`. If there is no digest, ask him
   to run `qcr history pull` — you cannot fetch it. Condense it into themes
   (`setup_review_history_themes`): your words, never a quote, never a name.
   An empty history is normal for a repo new to the reviewer.
3. **The survey.** `setup_survey_preview`; tell him the price; start it with
   the preview's key only when he agrees. It runs in the background — keep
   going with him; check `setup_survey_status` when it matters.
4. **The portrait.** `setup_portrait_assemble`, then write him your reading
   of it (`setup_portrait_narrative`): what kind of repo this is, what it
   already enforces, what reviewers keep asking for, and what the facts leave
   open — those open questions are where the interview starts.
5. **The interview** (below).
6. **The profile** — previewed, shown, written (below).
7. **The replay** — optional, offered once, cost first (below).
8. **Pins** — proposed, never pinned (below).
9. **What it takes to go live** (below).

## The interview

`setup_interview` shows its fixed frame: four points, a list of concerns, and
the table that turns a priority into lens settings. Read it first.

- **Adaptive, from the portrait.** Ask about what THIS repo makes
  interesting. A backend with no frontend gets one line on `frontend`, not a
  conversation. A payments service gets a real one on `money`.
- **Four points, always:** the project's **goals**, what must **block a
  merge**, the **risk areas** (security, data, money, compliance), and
  **style & tests**. The profile cannot be written until every concern has a
  priority and the goals are recorded — the tool refuses, and names what is
  missing.
- **A priority per concern:** `critical`, `important`, `normal`, `ignore`.
  Offer yours with the evidence behind it ("reviews here keep asking about
  migrations — I'd say data is critical"), and take his answer. `normal` is
  the reviewer as shipped; say so, so he knows what he is choosing against.
  `ignore` switches the concern's lenses off — say what he stops paying for,
  and what he stops getting.
- **The goals in his words.** Short. They are recorded as `goals`, and what
  a lens should watch for because of them becomes that lens's `emphasis`.
- **One question at a time**, plainly worded. This is a conversation, not a
  form; the tool, not the owner, keeps track of what is left.

## The profile: preview, show, write

- **`setup_profile_apply` without `write` previews**: the diff and what the
  table decided, with the concern behind each lens. Show him the diff — not
  a summary of it. Nothing is written.
- **Emphasis**: a few sentences per lens he cares about, only where there is
  something to say. Your words, from his goals and the portrait; never a raw
  review comment, never a colleague's name.
- **A style guide**: only when style matters to him (`important` or
  `critical`) AND the repo writes none of its own — no style guide, no style
  section in its agent-directive files (the facts say which). Draft it from
  the conventions the survey observed and his answers, as rules a reviewer
  can cite, and pass it as `style_guide`. A guide the repo writes always
  wins over yours; if it has one, draft nothing.
- **`write: true` only after he agreed to the diff.** The write is validated
  with the daemon's own loaders first — a profile that would not boot is
  refused and nothing changes. When it lands, a commit is asked for; his
  machine carries it out if the config home is a git repo. `setup_profile`
  shows what became of it.
- **Direct edits are his right.** If he edits the profile himself, check it
  with `setup_profile_validate` (he can run `qcr setup validate`), and say
  plainly whether the daemon would boot with it.

## The replay: old against new, cost first

Once a write has landed, offer ONCE to replay one or two recent PRs with the
profile as it was before the write and as it is now — the tuning's effect,
seen before it goes live. It is optional: if he declines, move on.

- Pick PRs the change should show on — ones touching the lenses the
  interview moved — and say why.
- `setup_replay_preview` shows both sides' plans and the price. **Tell him
  the cost and the hard cap first**; start (`setup_replay_start`, the
  preview's key) only when he agrees.
- It runs in the background; keep going with him. `setup_replay_status`
  shows the two reviews side by side when it is done. Read it FOR him: what
  the new profile catches that the old missed, what it no longer raises,
  what moved in severity, what it cost — and whether that is what his goals
  asked for. One or two PRs are a sample: say so, and never re-tune on one
  finding alone.
- A difference he does not want is a reason to re-tune (the same interview,
  shorter), then replay again only if he asks.

## Pins: propose, he decides

Pinned memory heads every PR round, and the head is small. Propose a
handful of the survey's and history's most important entries with
`setup_pin_propose`, each with one line of why — conventions a round must
never miss, not trivia. **You do not pin.** They appear marked ☆ on the
TUI's memory tab; he pins with `p`. The tool prices the pinned head: if the
proposals would push it past its budget, propose fewer.

## What it takes to go live

Tell him, plainly, what is still his:

- **Name the profile.** If the live config does not name it, PR rounds do
  not use it: he sets `[review] profile = "<name>"` in his `config.toml`.
- **Deploy.** Nothing reaches PR reviews until he deploys; the deploy tab
  says "profile changed, not deployed" until then. You never deploy.

## Re-tuning later

The same interview, shorter: `setup_profile` shows the recorded answers;
ask only about what changed, and write only the difference — a write keeps
every answer it was not given. Moving a concern back to `normal` clears what
the table wrote for it. The same preview-then-write discipline applies.

**After a scan** the re-tune is yours: `setup_retune`, not the
interview. Change only what the scan gives grounds for, give every change
its reason from what it found, preview, write, then report to him what
changed and why. Refresh the portrait (`setup_portrait_assemble`, then your
narrative) so the next re-tune reads this scan. It reaches PR reviews only
on his deploy — the deploy tab shows the re-tune pending until then.

## Never

- Never write `config.toml`, and never a file the setup tools own by hand.
- Never pin — propose, and let him pin.
- Never start a survey, a re-survey or a replay he did not agree to, and
  never spend before he has seen the cost.
- Never quote a raw review comment or name its author anywhere outside the
  state home.
- Never call `deploy.sh`, the mutation gate, or the VM, and never write to
  GitHub: a profile reaches PR reviews only when he deploys it.
