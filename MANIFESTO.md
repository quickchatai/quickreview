# The QuickReview Manifesto

## Let's not fool ourselves

Nobody on your team is actually reviewing the volume of code your team now
produces. Your teammates ship with AI implementers; the diff volume went up
an order of magnitude; the review capacity did not. What actually happens is
a charade we have all performed: the author asks their agent to write the
code, the reviewer asks *their* agent — "claude, review this" — and pastes
the result, the author replies "claude, address the comments," and two
humans spend a day as slow message brokers between two AIs that could have
had the whole conversation in minutes. The review *was already AI on both
sides*. The dead time was ours.

QuickReview stops pretending. It is an autonomous reviewer that owns the
review conversation end to end: it reads every triggered PR with nine
specialized lenses, argues with itself before it posts, replies to the
author, re-audits after every push, and renders a verdict — typically
within fifteen minutes of being asked. That turnaround is not a vanity
metric; it is the difference between review as a daily bottleneck and
review as ambient infrastructure.

## Human judgment moves up a level

Freeing humans from line-level review does not remove human judgment — it
relocates it to where it was always supposed to be. The question a human
should answer is **"is this something we need and want?"** — the product
call, the direction call, the final judgment on what goes in. The questions
a machine should answer are the ones that are checkable with clear rules
and endless patience: does this conform to how we do things here, is it
reasonably secure, is this migration safe, would this break production the
way that similar change did two months ago, is the change complete, does it
match its stated intent. Every one of those is checkable — by an AI on the
review side, against an AI on the implementation side — so that the human
makes the final judgment call on a PR that has already survived scrutiny,
instead of performing the scrutiny themselves.

When the reviewer genuinely cannot settle something, it does not hand the
review back. It decides anyway — on the merits — and posts its residual
doubts *beside* the verdict, as concrete, minutes-verifiable items a human
can check. A decision with named doubts gives the human a smaller job. An
"I don't know, you decide" gives them the whole job back, silently, and
calls it automation.

## The reviewer is a context engine

A single implementing agent, however good, sees one branch. A reviewer
worth having must be the **context engine of the whole repository**: it
looks at the sibling PR that is quietly solving the same problem, at the
shared retry adapter your new retry is about to stack onto, at what similar
changes did to production, at whether this migration number collides with
one that merged an hour ago. It holds the tribal knowledge — what this team
cares about, what it has explicitly decided not to care about, what its
security posture actually is — and it applies that knowledge on every
round, because unlike a human reviewer it never gets tired, never skims,
and never forgets what it agreed to last month.

## You own the entire loop

Sovereignty is not a feature here; it is the design. QuickReview is
self-hosted from the harness to the memory: the daemon runs on your
infrastructure, reviews post as *your* GitHub App, the reviewer's memory
and accumulated learnings live in a store on your machine under your keys,
and every rule the reviewer follows is a file in a repository you control.
The only thing that ever leaves your infrastructure is the model call, to
the provider *you* configured. No review SaaS reads your code. No vendor
owns the record of what your reviewer learned about your codebase — which,
after a few months of operation, is one of the most valuable artifacts your
team has.

And the learning flows both ways, inside your walls: the reviewer learns
your repo's patterns, your team's real preferences, your tribal knowledge —
and what it learns is periodically mined *back into the instructions of the
implementing agents*, so recurring finding classes stop being found because
they stop being written. Review stops being a gate at the end of the line
and becomes the feedback organ of the whole development loop.

## Eight beliefs, earned the hard way

This system replaced a predecessor that ran 647 reviews across 278 PRs. The
retrospective's headline: the *reviewing* was excellent and cheap; the
machinery around it consumed 67% of the spend and produced every incident.
Every principle below is a recorded decision with a rejected alternative
and, usually, a scar. None of them is a vibe.

**1. Determinism cages the LLM.** A deterministic daemon owns all state,
queueing, dispatch, and every GitHub mutation — there is no LLM anywhere in
the hot path, and judgment lives only where judgment is needed. One
mutation gate with a closed set of kinds; dismissing a review or nominating
a human reviewer is not a refused action, it is a *nonexistent code path*.
A delivered prompt is a receipt the agent echoed back, never an inference
from a resolved await — that rule cost a wedged 75-minute round and four
killed conversations to learn.

**2. Always a verdict; doubts ride beside it.** There is no third verdict
and no "awaiting human" state. Ten PRs once wedged in a park that read as
"awaiting the owner" — while 80% of the predecessor's escalations already
carried the bot's own approval. The park is retired; uncertainty became
`[check this]` threads the bot structurally cannot resolve, so the repo's
own merge rules force human eyes exactly where they are needed.

**3. Prompts are a constitution.** The review's instructions are
byte-frozen, hash-pinned, and changeable only by the owner's recorded
ratification. An LLM allowed to edit its own instructions optimizes for its
own comfort — the predecessor's one self-authored policy destroyed three
days of approvals. The system may *propose* (it drafts rubric changes with
evidence); only a human amends, and the amendment mechanism itself is
tested. Every behavior change has a name and a date on it.

**4. The reviewer reads; CI executes.** The reviewer never runs code,
tests, or the app — the command allowlist is code, not a prompt. Red CI
hard-gates approval, infrastructure failures included. What looked like a
capability sacrifice turned out to be a discipline: test vacuity (~12% of
blockers) is caught by *reading* whether an assertion could ever fail, and
migration-number collisions (~15% of blockers) by a deterministic pre-check
— both places where nothing else in the pipeline, human or CI, catches the
defect.

**5. One mind per PR.** One sticky conversation owns each PR for its whole
life — through pushes, replies, rechecks — holding a ledger that survives
context compaction. The lens passes it fans out are blank-slate leaves that
cannot spawn, cannot post, and carry no memory. The daemon nudges; it never
schedules an agent. A round in flight is never interleaved with another
instruction. Review quality is a property of a coherent, accountable line
of reasoning — not of a swarm.

**6. The blocker bar never moves.** Across the predecessor's entire
history: zero disputed blockers out of 68, while nits, questions and prose
were 85% of output. So every volume-reduction mechanism — the reachability
axis (a contrived scenario never blocks), the nit-treadmill cap, the
no-delta rule — attacks noise and only noise. The bar is protected in both
directions: same-day human feedback can demote, but a kill on feedback
alone is forbidden. When a fix would be bigger than the PR, the reviewer
states the invariant a fix must restore and lets the author choose the
remedy — the recorded evidence says authors' remedies beat prescribed ones.

**7. Learning is a loop, and every leg of it is inspectable.** Every round
leaves a per-finding record of what was raised, what was killed, and why —
enforced by the daemon, because prompt mandates measurably do not stick (a
mandated file appeared in 3 of 105 rounds until the daemon checked; the
daemon-checked ledger was missing in 0 of 8). Human `[feedback]` comments
and behavioral signals (a set-aside review, a merge over a standing block)
bite the same day, deterministically, without ever touching the round in
flight. A nightly curator promotes durable learnings; a human accepts
rubric changes with one click that *is* the ratification; and the capped
self-improvement channel (≤50 lines, ≤3 files, 1 PR/day — enforced in
code) means the system can propose its own evolution without ever being
able to rush it.

**8. Economics are stated, not hidden.** The predecessor burned 2.56
million output tokens — 19% of everything it ever said — concluding
"byte-identical" on deltas it never needed to read, and 1.86M more on 138
repeat approvals. The recheck's trivial-delta classifier, the
unchanged-head no-op (zero API calls), and the validator-tier floor (the
gate between a finding and a teammate's inbox is never the weakest reasoner
in the round) all exist because someone counted. Expired rounds count in
every spend total; silence is not allowed to erase cost.

## Non-goals

Refusals, recorded so they cannot be silently unrefused:

- **We do not rebuild GitHub's PR workflow.** Staleness, dismissal,
  re-request, merge gating, branch protection — GitHub owns them. A feature
  re-implementing one is out of scope, not backlog.
- **The reviewer never executes anything.** No test runs, no app boots, no
  database probes. CI is the authority for execution; the reviewer is the
  authority for reading.
- **No hard round budget.** A cap that force-parks a PR at round N was
  consciously declined; the treadmill is cut by scoping rules, not by
  giving up.
- **The reviewer never reads the implementing conversation.** Intent is
  judged from what the author told other humans — the PR title and body —
  never from the implementer's chat log. That echo chamber was ruled out on
  principle, not cost.
- **The fixer and the reviewer are never the same system.** Full-loop
  automation (review triggers the fix) stays declined until it can be built
  with no shared session, credential, or ledger — the moment they share
  one, "did you fix it?" stops being a question and becomes a lookup.

## Acknowledgements

QuickReview stands on ideas it is glad to name:

- **[Matt Pocock's skills](https://github.com/mattpocock/skills)** — the
  discipline of *processes as versioned files an agent can follow*. This
  system was not just inspired by that idea; it was **built with it** — the
  wayfinding, spec-writing, ticketing and grilling skills in that
  collection drove the actual development loop that produced this codebase,
  and the same discipline shaped how the reviewer's own rules are carried
  as files.
- **[pi](https://github.com/earendil-works/pi)** — the small-sharp-agent
  philosophy: an agent session is a terminal you can attach to, extensions
  compose instead of frameworks accreting, and the machinery stays small
  enough to reason about. QuickReview's review sessions are pi sessions,
  and its architecture inherits pi's taste.
- **[OpenViking](https://github.com/volcengine/OpenViking)** — the memory
  engine behind the reviewer's learning, run entirely on your own
  infrastructure with server-side per-user confinement.
- **pr-agent** — studied honestly in a written comparison; several of its
  ideas were adopted-by-conviction and several were deliberately not
  imported, and knowing which is which made this system better.

## Provenance

This manifesto is not aspiration. Every principle above traces to a
recorded decision in the project's design registry — each with its rejected
alternative, its ratification, and usually the incident or the measured
cost that forced it. Where the codebase drifts from a principle, the drift
is the bug.
