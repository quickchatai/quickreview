# What the two benchmark tables measure

Every comparison (`compare.py`) prints two tables over the same reviews. They
answer different questions, and on the same PRs they can disagree completely.
This page says what each one measures, how, and what the review is built to
be good at — so a number is never read as something it is not.

## The review's job

The review is built to **find defects in the code** — the change that breaks
a caller, loses data, fails in CI, opens a hole — and to say only true things
about it. Everything in its design serves that: lenses that hunt defect
classes, a validator that kills claims the code refutes, a blocker bar that
needs a concrete consequence, nits capped so volume never buries a finding.
Since 2026-09-27 it also has code-quality lenses — maintainability,
duplication, abstraction — because a reviewer's other job is whether the next
person can understand and safely change the code; those findings are capped
below blocking. It deliberately does **not** judge style by taste: every repo
has its own, so the style lens runs only where the repo writes its style
guide down, and applies only that guide.

So the headline number is **problems found**: how many of the real defects in
the change the review identified.

## Table 1 — the defect benchmark (our method)

**Ground truth** (`defects/<set>.json`; 185 PRs, 520 defects in the final
benchmark): for each PR, a blind expert
hunt for defects from the diff and the code; then every candidate — the
hunt's, the reviews' own comments, and every AACR-Bench reference comment —
checked against the code by a separate verifier, merged where it is one
defect, and graded **high / medium / low** by consequence. Every rejected
candidate is kept with the reason (`excluded`), so a reader can see why a
claim did not count.

**Judging**: a judge model reads the whole review — inline comments and body
— beside each defect and the code, and decides whether the review identified
it (found / partly / missed), wherever in the review it said so. It also
grades every comment the review made: correct and worth raising, correct but
minor, partly correct, wrong, unverifiable.

**Columns**: problems found (partly = ½) and recall; high / medium / low
found; weighted recall (high 3, medium 2, low 1); the share of comments that
are correct; cost and time per PR. Defects marked `benchmark_limitation`
(CI-gate defects a read-only review can find only by knowing the repo's CI)
are counted and also reported apart.

**Limits to keep in mind**: the ground truth was built with our reviewer's
comments among the candidates (the verifier is independent, but a real
defect only another reviewer found could be absent — so on this table a
different reviewer can be under-credited); the primary judge is the same model
family as the reviewer; differences under ~2 defects per 10 PRs are noise.
In the final benchmark, a second judge (Claude Opus 5.5) and a recall check
on the defects the key would hold without any reviewer's comment both leave
default first and the ordering nearly unchanged (under the second judge
pi-review and OCR, one defect apart, swap places) — `FULL-BENCHMARK.md`.

## Table 2 — AACR-Bench (the original benchmark)

**Ground truth**: the dataset's reference comments — 1,505 over 196 PRs,
median 6 a PR. 74% were written by AI reviewers (GPT-5.2 alone 25%) and kept
by annotators. Each has a **category** — code defect 47%, maintainability
and readability 42%, performance 8%, security 4% — and a **context** (diff,
file or repo level). No severity.

**Matching**, by the harness, unmodified: a review comment is compared with a
reference only when both are on the same file and their lines overlap within
±1 (the line gate); a judge model then decides whether the two say the same
thing (3 rounds, averaged). **Recall** = references matched / all
references. **Precision** = comments that matched a reference / all comments
— a comment that is not on the list is a false positive, even when it is a
real bug. The harness's numbers are sums over PRs, so an
eval split across several harness processes (`arm.sh --eval-shards`,
`eval_shards.py`) and merged with the harness's own summary functions gives
the same numbers as one process — only sooner.

**Columns**: references found and recall; precision and F1; recall by the
benchmark's own category and context (`references.json`).

**So it measures** how closely a review reproduces this particular list of
comments, at these exact lines. That is a useful cross-check and the only
number comparable with published leaderboard rows (under the same judge), but
it is not a defect count, for three reasons we measured:

1. **Most references are not defects.** Labelling all 253 references on
   30 PRs against the code (agents did the labelling; no human checked it): real defect 11%, real maintainability issue 8%,
   trivial 30%, dubious (unclear or likely wrong) 39%, duplicate 11%. A
   review that posts only what is true and consequential cannot match the
   other ~80%.
2. **Most real defects are not references.** On three fresh PRs the ground
   truth holds 11 defects (6 high); the references hold 7 comments, one of
   which is a real defect (every reviewer found it), one is wrong (an
   operator-precedence "bug" that is not one) and five are style or
   readability notes. The other ten defects — a timestamp truncation that
   breaks mobile sync, CI broken by stale mocks, a mode losing its tools —
   count against precision.
3. **The line gate.** The right problem, anchored two lines from the
   reference, never reaches the judge; a reviewer that comments on line
   RANGES gets more candidate pairs than one that anchors single lines.

A fourth problem is where the references came from. The dataset marks
26% of them human, rewritten by an LLM. On our 185 PRs at least 80 of those
362 "human" references (22%) are rewrites of comments an AI review bot
posted on the original PR: GitHub Copilot 23, CodeRabbit 20, cubic 20,
Sourcery 5, LlamaPReview 4, Gemini Code Assist 4, Ellipsis 3, Cursor Bugbot 1
(`bot_references.json`). On this metric such a bot is credited for
repeating its own earlier comment. Removing the 80 moves each reviewer's
F1 by at most 1.4 points and leaves the top of the ranking as it was: `compare.py --exclude-refs
bot_references.json`, and Table 3a in `FULL-BENCHMARK.md`. 19 of our 520
defects cite one of them; each was checked against the code (17 were also
found by the blind hunt), and they carry an unscored `bot_derived_reference`
note.

On three PRs every reviewer we ran scored 1 of 7 references (14%) while the
defect table separated them by 3–4 real defects. When the benchmark's
references carry reference labels (smoke10, dev10, holdout10), the per-run AACR
`report.md` adds a "real-defect recall" column scored only against the
genuine ones — the fairer way to quote this benchmark.

## Nits, and the benchmark

AACR-Bench rewards nits: most of its references are minor notes, and a
review that posts only what clears its bar cannot match them. Production
keeps `[review] nits = "strict"` (true-but-trivial candidates are dropped;
review volume comes out of nits). For a benchmark run, `--config
review.nits=open` lifts those limits — every true nit the passes raise is
posted — which shows how much of the AACR gap is nit volume rather than
missed problems. Style is excluded either way: it still needs the repo's
written guide. Report which policy an arm ran; the defect table is the check
that open nits did not cost accuracy.

## Reading a comparison

Lead with problems found and high-severity found (table 1). Use comments
correct and cost/time to judge what the finds cost. Read table 2 for
comparability with published numbers and for the categories the review
under-covers — a gain in maintainability recall there, with table 1 holding,
is the code-quality lenses doing their job; a gain in table 2 that costs
table 1 is the review drifting toward the list and away from defects.
