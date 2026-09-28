# Threats to validity

This page is written as a skeptical outside reviewer would write it. It
assumes that reviewer knows everything we did. It lists every way the
benchmark and its results could be wrong, biased or overstated, most severe
first. For each threat it gives five things:

- **Threat:** what could be wrong.
- **Evidence:** the concrete evidence from this work.
- **Size:** how far it could move the numbers, and for whom.
- **Mitigation:** what we did about it.
- **To resolve:** what would settle it.

The companion documents are [METHODOLOGY.md](METHODOLOGY.md), which covers what
we did step by step, and [PROMPTS.md](PROMPTS.md), which gives every prompt
verbatim. The headline results are in `../FULL-BENCHMARK.md` and the chronological
log is in `../RESULTS.md`.

Short version: **the ranking of quickreviewd default above every other
reviewer is robust. The exact size of its lead is not.** Several threats
below favour our reviewer. Two have now been measured:

- Seeding the answer key with its comments (threat 1) did not create its
  lead.
- A second judge from another model family (threat 4) agrees with the first
  on 98.7% of verdicts, which largely retires judge bias as a threat. It
  does not validate the answer key, which both judges share.

The rest have not been measured away.

---

## 1. The ground truth was built from our reviewer's own output (severe)

**Threat.** Recall here is not recall against all real defects in a PR. It
is recall against the union of defects that somebody in the candidate pool
raised and a verifier then confirmed. Our reviewer was in that pool from the
start, and was its biggest contributor.

**Evidence.** Take the 145 new PRs (`defects/rest145.json`; provenance
statistics in the analysis folder). The first build of the ground truth had
379 defects, drawn from the candidate sources below. One defect can have
several sources.

| Source | Defects it raised | Defects no other source raised |
|---|---|---|
| quickreviewd default's comments | 334 (88%) | 29 |
| quickreviewd low's comments | 269 | 3 |
| Expert hunt (Claude agents, reading the code) | 241 | 12 |
| open-code-review's comments | 230 | 4 |
| AACR reference comments | 115 | — |

- **Default dominates the pool.** 29 defects exist in the truth only because
  default said them.
- **Default also wins on the 29.** Default itself is scored on those 29, and
  wins them almost by construction: an in-pool reviewer gets credit for
  everything it said that turned out to be true.
- **Low has the same advantage.** It is a sibling configuration of the same
  reviewer.
- **The later tools arrived after the pool was mostly built.** Codex CLI,
  OpenCode, pi-review and Claude Code were only added in a second pass (the
  extension). That pass checked 1,527 of their comments:
  - 931 matched an existing defect;
  - 691 were excluded;
  - 16 new defects were added, of which the critics removed 1. Net +15, taking
    the total to 394.

  A late tool can therefore only score on defects someone earlier also found,
  plus its share of those 15.

**Size (measured).** An earlier version of this page gave an estimated
worst case here. It has been replaced by a measurement.

We scored every reviewer on the **369 of 520 defects (82 of 90 high)** that
the expert code hunt or an AACR reference raised. These defects would be in
the key if no reviewer's comment had ever been a candidate. (330 of them
were also raised by some reviewer; 39 by no reviewer at all.)

Recall on those 369, with the Opus judge in brackets where it differs:

| Reviewer | Recall on the 369 | High, of 82 | Recall on all 520 |
|---|---|---|---|
| quickreviewd default | 86% | 80 | 84% |
| quickreviewd low | 71% | 71 [71.5] | 66% |
| open-code-review | 59% | 62 | 56% |
| Codex CLI | 53% | 67.5 | 48% |
| OpenCode | 53% | 62.5 | 48% |
| pi-review | 61% [60%] | 69.5 [70] | 56% |
| Claude Code (Opus 5.5) | 70% | 69.5 | 62% |

What this shows:

- **Default's lead is not an artefact of the seeding.** Its recall on the
  independent subset is not lower than on the whole key (86% vs 84%).
- **The lead over the next reviewer stays about 15 points** under both
  judges.
- **Every tool scores higher on this subset,** so the subset is easier, not
  neutral.

What it does not show:

- **Defects that only an out-of-pool tool would have raised are still
  missing.** No source other than the hunt, the references and the seven
  reviewers exists to find them.
- **It says nothing about absolute recall.**

**Mitigation.**
- **Every tool was a candidate equally.** In both passes the verifiers saw
  every reviewer's comments anonymised and shuffled, and the reviewer key was
  never shown to them. A comment was never accepted because of who wrote it.
- **Every rejection is recorded** with its reason: 2,118 in the first pass and
  691 in the extension. So a reader can audit what was thrown away.
- **The extension produced few new defects.** Only 15 of the 1,527 new
  comments became new defects. That is evidence the pool was already close to
  saturated, not proof that it was.

**To resolve.**
- **Build the truth before any reviewer runs.** Use a blind hunt only, and
  score every tool against that.
- **Or build it from a pool of equal size per tool,** with a disjoint
  verifier.
- **Report recall on an independent subset** alongside the current number.
  Done: see Size above, the `independent-defects.jpg` chart and
  `../FULL-BENCHMARK.md`.

## 2. Benchmaxing: the reviewer was tuned on the benchmark (severe for the 40, moderate overall)

**Threat.** The reviewer was tuned on the same benchmark it is scored on.

**Evidence.** Every change to the review during this work came from reading
our own misses on the 30 dev PRs (smoke10, dev10, holdout10): the sub-lenses,
the per-file sweep, dependency sources, the tests lens, the "every problem on
the lines" rule, the code-quality lenses, `pass-consistency`, and the
validator's demote-not-kill rule. fresh10 was introduced as "out-of-sample",
but it was then used for at least five further decisions:

1. the tests lens;
2. the quality-lens A/B;
3. validator tuning;
4. open nits;
5. the three-PR comparisons.

It is no longer held out. `RESULTS.md` mentions fresh10 eight times as the
basis of a decision.

**Size.**
- **On the 40 original PRs the default's numbers are optimistic:** 81% of
  defects found, 32 of 34 high.
- **The 145 new PRs are the honest test.** No design decision looked at them.
  There default finds 85% (key v2) and 54 of 56 high-severity defects. That
  is higher than on the 40, not lower, which is the opposite of what
  overfitting predicts. But every reviewer except Codex CLI also scores
  higher on the 145, so this is weak evidence.
- **But see threat 1.** Those 145 PRs' ground truth was built after seeing
  default's reviews, which inflates exactly that number.

**Mitigation.**
- **Tuning never touched the new PRs.** The 145 were selected mechanically
  (`select_cases.py rest145`: every runnable PR not in the tuning sets). None
  was opened during tuning.
- **Default stays first out of sample.** Its lead over the next reviewer is
  21 points on the 40 and 16 on the 145. Over the mean of the other six it
  leads by 29.0 points on the 40 and 27.6 on the 145; the difference, +1.4,
  has a 95% CI of [−6.3, +8.9], so the margin does not measurably shrink.
  The rest of the ordering does not hold across the halves (OCR is last on
  the 40 and fourth on the 145; low and Claude Code swap). Every reviewer
  except Codex CLI scores higher on the 145, so the 145 look easier for
  everyone, which makes this weak evidence about overfitting.

**To resolve.**
- **Freeze the reviewer (commit `1ad710b`) now.**
- **Evaluate on PRs from outside AACR-Bench,** or on a new AACR release.
- **Tune on the 40 only, and report the 145 as the headline.** We already do
  the latter; FULL-BENCHMARK.md reports both halves.

## 3. There is no human-verified ground truth for the 145 new PRs (severe)

**Threat.** A human has checked none of the 394 defects in `rest145.json`.

**Evidence.**
- **Who built it.** Claude agents did every step: a hunt, then a verifier,
  then a critic that spot-checked about 15 PRs per group, then the extension
  verifier, then extension critics.
- **What the critics changed.** They corrected 6 things in the first pass and
  4 in the extension.
- **Human review so far.** None confirmed. The only other labelled data is
  the quality labels on AACR's reference comments for the 30 original PRs
  (`sets/*.labels.json`, 253 references). Their own `source` fields say
  agents produced them ("per-PR analysts", "two labelling agents"); whether
  a human checked them is not confirmed. They label AACR's comments, not our
  defects.

**Size.** Unknown, which is the point.
- **If the verifier accepted plausible-but-wrong defects,** every reviewer's
  recall denominator is wrong. Recall numbers are then too low for tools that
  (correctly) ignored those defects, and too high for tools that raised them.
- **Severity grades are also unchecked.** The high/medium/low split drives
  the weighted-recall figure and the "high-severity caught" headline.

**Mitigation.**
- Every defect carries evidence (file, line, quoted code).
- Every exclusion carries a reason.
- Both are in the repo (`defects/rest145.md`), so a human audit is possible.

**To resolve.** A human audit of a stratified sample:
- about 50 defects, weighted towards high severity and towards defects with a
  single source;
- about 30 exclusions.

Report an agreement rate, and correct the truth.

## 4. The judge and the answer key share model families with the contestants (moderate)

**Threat.** The judge, and the builder of the answer key, share a model
family with some of the reviewers.

**Evidence.**
- **The defect judge** is `gpt-6-sol:high`. That is the same model family
  that runs:
  - quickreviewd default and low (lens passes on gpt-6-sol tiers);
  - open-code-review;
  - Codex CLI;
  - OpenCode;
  - pi-review.
- **The AACR judge** is `gpt-6-sol:low`.
- **Claude Code** ran on Anthropic's Opus 5.5, so it is the one reviewer the
  primary judge does not share a family with.
- **The second defect judge** is `claude-opus-5-5`. It shares a family with
  Claude Code and with the answer-key builder, but not with the six
  gpt-6-sol reviewers.
- **The ground truth** was built by Claude agents, the same family as the
  Claude Code reviewer.
- **The same assistant** designed our reviewer's levers, built the answer key,
  and wrote the judge prompt.

**Size.** The direction of each effect is plausible; the magnitude is
unmeasured.
- A judge may prefer phrasing in its own family's style, which would favour
  the gpt-6-sol reviewers.
- A Claude-built answer key may favour defects Claude-family models notice,
  which would favour Claude Code.
- The designer of the reviewer also built the key and wrote the judge prompt.
  That concentrates knowledge of what the review says and how the key counts
  it in one place.

**Mitigation.**
- **A second judge from the other family re-scored every review.** It
  covered all 1,295 reviews and ended with 0 errors.
  - It gave the same verdict (found, partly or missed) on 3,593 of 3,640
    reviewer-defect pairs (98.7%), and on 628 of 630 high-severity pairs.
  - Problems found moved by at most ±3 defects per reviewer, and recall is
    identical after rounding for all seven.
  - Comments correct moved by up to 5 points. The largest move was Claude
    Code, 81% under GPT and 86% under Opus: the Claude-family judge is
    kinder to the Claude-family reviewer on accuracy. Its recall did not
    move, though (62% under both).
  - So a same-family preference, if present, is small next to the gaps
    between reviewers.
  - **Status: the judge half of this threat is largely retired.** Two
    judges from different model families agree on almost every verdict, so
    the defect scores are not an artifact of a single-model judge or of one
    family favouring its own reviewers. The answer-key half is not retired
    by this: both judges score against the same Claude-built key, and
    agreement between them says nothing about whether that key is complete
    or right. That rests on the verification pipeline and on the
    independent-source check (threat 1).
- **The judge sees what it needs to judge fairly:** each defect's statement,
  evidence and "counts if / near-misses" notes. It must decide found, partly
  found or missed against those notes, not against style.
- **Comments are anonymised.** The ground-truth verifiers never saw the
  reviewer key.
- **One consistency check.** On the three-PR smoke test, all arms matched the
  same AACR reference under the AACR judge.

**To resolve.**
- **Re-judge** with a judge from a third family, one that matches neither
  gpt-6-sol nor Claude. The two judges we have each share a family with
  some contestants, and both used the same judge prompt.
- **Also re-judge** with a different judge prompt.
- Inter-judge agreement per defect is now reported (above and in
  `../FULL-BENCHMARK.md`).

## 5. Unequal inputs, effort and budget (moderate; the direction is known)

**Threat.** The reviewers did not get the same inputs, the same effort or the
same budget.

**Evidence and direction:**

- **PR title and body:** quickreviewd gets them, as in production, and its
  `pass-intent` lens uses them. No other tool gets them: the AACR harness
  passes none to OCR, Codex, OpenCode or Claude Code, and pi-review gets only
  the diff. *Favours ours.*
- **Budget:** quickreviewd default runs about 10–15 lens passes plus a
  validator. Per PR, on average:

  | Reviewer | Uncached input | Cached input | Output | Cost per PR |
  |---|---|---|---|---|
  | quickreviewd default | 488k | 1.86M | 36.2k | $1.71 |
  | quickreviewd low | 249k | 713k | 15.9k | $0.80 |
  | open-code-review | 264k | 96k | 5.1k | $0.60 |
  | Codex CLI | 34k | 266k | 2.9k | $0.15 |
  | OpenCode | 385k | 169k | 2.7k | $0.83 |
  | pi-review | 27k | 127k | 1.7k | $0.11 |
  | Claude Code (Opus 5.5) | 19k (incl. cache writes) | 149k | 3.5k | $0.20 |

  We compare tools as shipped, not at equal compute. *Favours ours* on
  "defects found"; the cost column states it.
- **Reasoning effort:**
  - Codex CLI, OpenCode and OCR ran at medium.
  - pi-review ships `--thinking high`, which we lowered to medium for parity.
    *Disfavours pi-review.*
  - Claude Code ran at its default effort on Opus 5.5, a different and more
    expensive model family. *Direction unclear.*
- **Single run per arm:** the headline is one run per reviewer. In earlier
  repeat runs of our own reviewer (`RESULTS.md`), two runs of the
  same arm differed by about 1–2 defects per 10 PRs, with run-to-run
  agreement of 78–89%. We have no variance estimate for the other tools.
  - Default's lead over the next reviewer (18 points, 84% vs 66%) and over
    the third-party tools (22–36 points) is far larger than that noise.
  - Gaps under about 5 points are not. That covers most comparisons among
    the single-pass tools: OCR vs pi-review, and Codex CLI vs OpenCode.
  - Bootstrap intervals over PRs (`FULL-BENCHMARK.md`, Uncertainty) agree:
    every gap between default and another reviewer excludes zero, while low
    vs Claude Code, pi-review vs OCR and OpenCode vs Codex CLI do not. Those
    intervals cover PR sampling only, not run-to-run or judge variance.
- **Parallelism:**
  - Our arms ran 10 PRs at a time on the machine-wide scheduler.
  - Third-party arms ran one PR at a time per container (the harness default),
    later split into four parallel chunks.
  - Minutes per PR are wall-clock under that shared scheduler, so they
    include contention and are not directly comparable between our arms and
    the single-pass tools (as `FULL-BENCHMARK.md` and `METHODOLOGY.md` say).

**To resolve.**
- **An equal-inputs arm:** give every tool the PR description.
- **Equal-budget arms:** for example Codex at high effort, pi-review at its
  default high.
- **Three runs per arm,** with bootstrap confidence intervals over PRs.

## 6. Each third-party tool runs slightly differently from the harness (moderate, per tool)

**Threat.** Each third-party arm deviates in some way from how the AACR
harness, or the tool's own defaults, would run it. Every deviation is
documented in `../README.md`.

- **Codex CLI.**
  - A config prelude fixes: effort medium, credentials in files, no update
    check, no analytics, web search disabled.
  - It runs with `seccomp=unconfined` so that Codex's own bubblewrap sandbox
    works.
  - It uses a ChatGPT login instead of the harness's API key.
  - *Direction:* web search disabled could disfavour it, but no arm could
    search, and the references are public PR comments. Otherwise neutral.
- **OpenCode.**
  - Built-in `review` with `subtask: false`. As a subtask it reviewed the PR
    twice and reported duplicates. The deviation removes a precision penalty,
    so it favours OpenCode.
  - The bridge replays aggregated answers as a stream: neutral.
  - It uses the harness's Codex findings tool, because the harness has no
    OpenCode runner. So OpenCode's reporting format is ours.
- **Claude Code.**
  - In 2.1.283, `/code-review` is a built-in local command. It ignored the
    harness's findings tool and appended instructions, and answered in prose.
  - We wrote a prose parser (`src/bench/claudeprose.ts`, 12 golden fixtures)
    to turn that prose into comments for AACR scoring. It drops findings that
    have no line number.
  - The defect judge reads the prose review body as well as the parsed
    comments, so defect recall depends little on the parser.
  - "Comments correct" grades the parsed comments. There, the parser decides
    how the prose is split into comments.
  - *Direction:* parsing errors mainly lower Claude Code's AACR numbers, and
    may shift its comments-correct share either way.
- **pi-review.**
  - It is fed the diff as an `@file` attachment, because its reviewer has no
    shell.
  - It runs from a clean checkout outside our sandbox's context files.
  - Effort as in threat 5.
- **open-code-review** runs exactly as the harness's `ocr.py`.

**To resolve.**
- Ask each tool's maintainers for their recommended headless review
  invocation.
- Report sensitivity to the one deviation per tool that could matter:
  - OpenCode with the subtask duplicates kept;
  - pi-review at high effort;
  - Claude Code with a structured-output prompt.

## 7. Metric construction (moderate for AACR, low for ours)

**AACR-Bench's own metric.**
- **The reference comments are not a list of real defects.**
  - 74% of them are AI-written.
  - Of all 1,107 references on the new PRs, only 12.8% are part of a verified
    defect.
  - On the 30 PRs whose references were hand-labelled, about 11% are real
    defects and about 8% real maintainability issues.
- **Line gate.** A comment is scored only if it lands within ±1 line of a
  reference. That favours tools that comment on line ranges (OCR, Codex,
  pi-review) over tools that comment on single lines (ours).
- **Judge.** We use `gpt-6-sol:low` through a local shim, not the paper's
  Qwen3 judge. Our AACR numbers are comparable across our own rows, not with
  the public leaderboard.

**Our defect metric.**
- **Partial credit.** Partly found counts as ½.
- **Same judge for accuracy.** "Comments correct" is graded by the same judge
  that grades recall.
- **The judge sees the excluded list,** with reasons, so it will not credit a
  claim the truth already rejected. That makes the judge stricter, and it is
  stricter for every tool equally. But the exclusions were written from each
  tool's own comments. So a tool that repeats a rejected claim is marked
  wrong with the reason in hand, which helps consistency and cuts both ways.

**To resolve.**
- Report found-only recall (no partials) next to the headline.
- Have a second judge grade comment accuracy. Done: the Opus judge grades
  every comment too. It agrees within 5 points per reviewer, and default is
  86% under both.

## 8. Data handling (low)

- **Unfetchable PRs.** 11 of AACR's 196 PRs could not be fetched, because
  force-pushes removed their heads. They are excluded from every arm, so
  every arm sees the same 185.
- **OCR under-credited on fresh10.** fresh10's original truth had our
  reviewer's comments as candidates but not OCR's, so OCR may be
  under-credited on those 10 PRs. The extension later added four more tools
  to the candidate pool, but not OCR.
- **Different builds across arms.** Examples:
  - default ran on `2d2036f` for the 40 PRs and `1ad710b` for the 145;
  - OCR ran on `786278` and `1ad710b`;
  - the new arms ran on `641f373`/`3bd89b3`.

  The differences between builds are benchmark code and an on-by-default
  switch, not the reviewer's behaviour. But this is asserted, not
  re-verified by re-running.
- **Runs stopped and restarted midway.** Codex and OpenCode `rest145` were
  stopped mid-run and re-launched in four chunks. The cases already done were
  kept. The one case in progress at each stop was redone. The scheduler's
  retry logic also re-ran one `no-output` default case and one failed OCR
  case.
- **One accidental real Claude Code call.** During the prose-parser work, a
  driver self-test in the Claude container ran the real `claude` binary
  instead of the stub. The container had no network and no credential, so no
  model call was made. It stayed within rule 5's container-only exception.
- **Cost figures are list prices, not bills.**
  - The gpt-6-sol runs used a ChatGPT login. Their dollar figures are pi's
    list prices, with cached input correctly at a tenth of the uncached rate
    (verified by hand).
  - Claude Code's figures are Anthropic's reported `costUSD`.
- **Judge concurrency and the Opus rate limit.** Several judges ran at once.
  - **The rate limit.** The Opus judge hit the Anthropic organisation's
    limit for `claude-opus-5-5`: 50 requests per minute, with about 1.7 API
    calls per judgement. The first pass produced HTTP 429 error files.
  - **The resume.** The queue was stopped and resumed at `-P 3` ×
    concurrency 4. A final `--resume` pass at `-P 1` re-ran every remaining
    error.
  - **Final state:** 0 errors in 1,295 Opus judgements. The GPT judge's 2
    error files were retried to 0.
  - `compare.py` counts an error file as not judged, never as a miss, and
    flags any it finds.
  - Retried judgements are fresh model calls, so a retried case is one
    sample, like every other.

## 9. Things we could not verify

- The real billing price of gpt-6-sol behind the ChatGPT login.
- Whether Claude Code's `/code-review` behaves the same on a subscription
  token as on an API key. We used an API key.
- Whether the AACR harness at a newer commit would run Codex or Claude Code
  differently.

---

## What we claim, and what we do not

**We claim:**

- On AACR-Bench's 185 runnable PRs, under our defect judge and our verified
  ground truth, quickreviewd default finds more real defects than every other
  reviewer we ran. It also finds more high-severity ones, and under the
  primary judge more of its comments are correct (under the Opus judge
  Claude Code is level). The margin (84% against 48–66% of defects found) is
  far larger than run-to-run noise, and every paired bootstrap interval
  between default and another reviewer excludes zero. Default is first on
  the 145 PRs no tuning decision ever looked at, under a second judge from
  another model family, and on the 369 defects the key would hold without
  any reviewer's comment.
- On AACR-Bench's own metric the reviewers are close. That metric mostly
  rewards reproducing a reference list that is largely not real defects.
- On cost per defect found, pi-review is the most cost-efficient tool: $0.07
  per defect and $0.27 per high-severity defect at $0.11 per PR, against
  $0.11/$0.40 for Codex CLI, $0.11/$0.50 for Claude Code and $0.72/$3.68 for
  quickreviewd default.

**We do not claim:**

- Absolute recall. The truth is the union of what the candidate pool found,
  and our reviewer was the pool's largest contributor (threat 1).
- That the size of our lead is exact. Threats 1, 2, 4 and 5 all push it the
  same way. Threats 1 and 4 have been measured, and neither explains the
  lead; threats 2 and 5 have not been measured.
- A run-to-run variance estimate. Every reviewer ran once; the bootstrap
  intervals cover PR sampling only.
- A human-verified answer key for the 145 new PRs.
- A like-for-like comparison at equal inputs or equal compute. We compared
  tools as shipped; ours reads the PR description and spends about 10× the
  tokens.
- Comparability with the published AACR leaderboard.

## Hardening, in priority order

1. **Human audit** of about 50 defects and 30 exclusions from `rest145`,
   stratified by severity and by single-source provenance. Publish the
   agreement rate.
2. **Recall on the independent subset.** Done for the hunt-or-reference
   subset (threat 1). A stricter per-tool version is still open: recall on
   defects raised by at least one source other than that tool itself.
3. **A third-family judge** for both metrics. A second-family defect judge
   (Opus 5.5) is done, with inter-judge agreement. The AACR metric still has
   only the one judge.
4. **Freeze the reviewer** at a tagged commit, then build a new truth
   blind-first for new PRs from outside AACR, and only then run the tools.
5. **Three runs per arm,** with bootstrap confidence intervals over PRs.
6. **An equal-inputs arm:** every tool gets the PR title and body. Also
   equal-effort variants: pi-review at high, Codex at high.
7. **Maintainer-recommended invocation** per tool, plus a sensitivity run for
   each documented deviation.
8. **Add OCR to fresh10's candidate pool,** and the four new tools' comments
   to the 40 original sets' published truth, which are currently recorded
   only in the analysis folder.
