---
name: replay
description: Re-run a past episode offline against the committed regression case set — real human findings on closed PRs — to see how a proposed change to the reviewer would have behaved. Use when asked whether a tweak would still catch what humans caught, to calibrate against the pre-bot corpus, or to try a change before it lands. Strictly offline: it never labels a PR, never wakes a session, and never posts anything.
---

# Replaying a past episode

This file **is** the doctrine; the case set was decided with the owner. The
instrument itself is `src/regression.ts`, and where this file
and that module disagree, **the module wins** — its assertions run, this prose
does not.

## The safety point, first, because it is the one that can do damage

**A replay must never become a posting path.**

There is an obvious way to "re-run a review": put the trigger label on the PR
and let the live daemon dispatch a round. That is how the old cutover comparison
harness worked, and **it is forbidden here** — a live round posts a real review
to a real author on a real PR. The same applies to every disguised version of
it:

- Never label, re-label, or ask anyone to label a PR.
- Never write an overseer inject asking for a re-review, a rerun, or a fresh
  round on any PR. Your one lever is not a replay mechanism.
- Never touch `dry_run`. It is the owner's alone in both directions (root rule 1),
  and a replay that needs it flipped is a replay you must not run.
- Never replay an **open** PR at all, whatever the mechanism.

`src/regression.ts` enforces the same thing in code rather than in prose, and it
is worth knowing exactly what it checks, because those checks are your floor and
not your ceiling. `assertReplaySafe(cases, gate)` refuses to start unless:

1. the gate it was **handed** reports dry-run — read from the object, never from
   `config.toml`, never inherited, never a printed sentence (see
   `src/compare.ts`'s `attestDryRun` for what that mistake looked like);
2. no case is a still-open PR;
3. no case is at or after the contamination cutoff (`2026-03-01`) — rows from
   then on are the old `/auto-review` loop's own output or suspected
   AI-assisted, so scoring against them scores the reviewer against itself.

`runRegression` calls it regardless of whether you did. And the `replay` seam in
`RegressionDeps` carries the rule in its own doc comment: it **must build its
own round in a scratch root against `case.headSha`**, and it **must not** label
a PR and let the live daemon dispatch. Nothing in that module imports the
daemon, `wire.ts`, or a GitHub adapter — if you find yourself adding such an
import to make a replay work, stop: that is the boundary, and you have just
reached it.

## What the set is, and what it deliberately is not

The cases are real findings by human reviewers on **closed** PRs
(`tests/fixtures/regression-cases.json`, built by
`scripts/build-regression-set.mjs` from the corpus export — by hand,
never by a test and never by the daemon).

Three properties decide how you read a run:

1. **Selection is by SUBSTANCE, not by verdict.** `selectCases` never reads the
   GitHub verdict — blocking measures the reviewer, not the finding, and 82% of
   blocking findings carry no correctness vocabulary at all. A finding is
   admitted only if it states a reason or proposes a concrete alternative
   (rung ≥ L3), is in English, is not bot-authored, and does not rest on
   evidence off the PR. Do not "improve" a run by widening that bar.
2. **A failure is an INVESTIGATION, not a veto and not a bug.** Every finding
   carries an expectation label — `expected-catch` (the reviewer should reach
   it), `out-of-remit` (ratified design puts it outside the reviewer, so a miss
   is *correct*), `expected-divergence` (the human was argued down; either
   answer is defensible). Two of the three make a divergence the expected
   outcome. `runRegression` never returns a blocking verdict and its `exitCode`
   is always `0`.
3. **There is deliberately no score to maximize.** A set that could be optimized
   would ratchet the reviewer toward imitating one person's habits, and one
   reviewer is 43% of the corpus. If you catch yourself tuning a change until
   the numbers go up, you are doing the thing the set exists to prevent.

## Running one

1. **Name the change under test** — pass it as `changeUnderTest`. A run whose
   header cannot say what was tried is a run nobody can act on later.
2. **Load and parse the set** with `parseCaseSet`. It refuses an empty or
   half-parsed set on purpose: a clean score out of nothing is the one result
   this whole module exists to make impossible.
3. **Supply a `replay` implementation that satisfies the rule above**, plus the
   real gate object. If no offline replay implementation exists yet, **say so
   and stop.** "I could not run it offline" is a correct and complete answer;
   reaching for the live daemon to fill the gap is not. There is no
   almost-offline route.
4. **Run it serially.** You have no subagents — cases run one after another, and
   `runRegression` already loops that way. Do not fake parallelism and never
   claim a run you did not do.
5. **Read `renderInvestigation`'s output as written.** It opens by saying what
   it is not, because the one way this set can do harm is by being read as a
   pass/fail gate the reviewer is then tuned to satisfy.

## Reading the result honestly

- **`not-reached`** is the only column worth investigating, and the question it
  asks is not "is this a regression?" but "is this in the reviewer's remit at
  all — and if it is, was it ever reached before this change?" A finding
  unreached both before and after is not evidence about the change.
- **`vacuous` cases** — the replay produced nothing at all for a case that has
  findings. **Suspect the harness before the reviewer.** A vacuous PASS from an
  extractor that matched nothing was the old comparison harness's failure mode; when
  half the cases are vacuous, `runRegression` says `ask-owner` and it means
  it.
- **Reviewer skew above 40%** means the run is partly measuring one person's
  habits. Widen the set before acting on a pattern in it.
- **`sandbox-only` findings are not failures.** The reviewer reads things humans
  skipped, and that is what it is for.
- **A label may be wrong.** If the honest answer is that we do not want a
  finding raised, re-label the case `out-of-remit` with a note — but that is a
  change to the instrument, so it lands like any other change: through the
  ratifying turn, via `land`.

## After the run

Report the recommendation (`no-action`, `look-at-these`, `ask-owner`), the
headline, and the unreached findings — in the column, in the owner's own terms. A
run **never** decides whether the change lands. It is one input to the argument
that happens before `land` is ever loaded, and it does not replace it.

Do not write a memory entry for a run. The investigation markdown is the
artefact; a run is a measurement, not a conclusion.

## Never

- Never label a PR, ask for a round, or nudge a session to produce a replay.
- Never replay an open PR, or a case at or after the contamination cutoff.
- Never run against a gate that is not dry-run, and never change `dry_run`.
- Never treat a run as a gate, a score, or permission to land — it has no
  blocking verdict by design.
- Never widen the substance bar, drop the per-reviewer cap, or re-label a case
  to make a run come out better.
- Never report a run you did not complete, and never present a vacuous run as a
  clean one.
- Never call GitHub, the mutation gate, `deploy.sh`, or the VM. The corpus, the
  case set and the reviewed code are all local files.
