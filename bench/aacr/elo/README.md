# Pairwise Elo judge

When two configurations score within a benchmark's noise floor, the headline
number cannot say which one reviews better. This judge reads two reviews of
the same PR side by side, with the benchmark's golden comments in context, and
picks a winner overall and in four categories. A Bradley-Terry fit over many
such judgments rates every configuration on the Elo scale. Decisions and
their reasons: tracker ticket.

## What one judgment is

- **One model call, no tools, no agent loop.** The prompt holds the
  instructions, the PR's title and description, the diff, the touched files at
  the head commit (line-numbered), the golden comments, and Review A and
  Review B (findings and summary body). The ceiling is 400k tokens. Past it,
  the largest files fall back to their diff with 60 lines of context, then
  drop out (the diff always stays).
- **Lockfiles and generated files are never packed.** Dependency lockfiles
  and checksum files (`go.sum`, `package-lock.json`, `yarn.lock`, `*.lock`,
  …) and minified bundles and source maps (`*.min.js`, `*.min.css`, `*.map`)
  are left out whole and out of the diff too: each is one line under the
  diff with its added and removed line counts.
- **The token estimate is an upper bound for both judges.** Hash-like runs
  (16+ base64 or hex characters with a digit) count one token per
  character; everything else one per 3 characters. On real prompts
  gpt-6.1-sol's count ran 0.70–0.76x of it for code, and 0.86x for a prompt
  carrying `go.sum` whole.
- **Two judges, rated separately, with an identical prompt:** gpt-6.1-sol at
  xhigh and Claude Opus 5.5 at xhigh. Every judgment records the prompt's
  sha256, so this can be checked.
- **Blinded.** Reviews are rewritten into one neutral shape. QuickReview's
  lens footers, lens list and bot signature are stripped, and its `[tag]` and
  P-level become a stated severity. The Claude arm's JSON dump of its own
  inline findings is removed from its body. A/B order is random, once per
  pair.
- **Golden set as a reference, not as truth.** The judge may overrule a
  golden comment, or credit a real finding outside the set, but only by citing
  code in the prompt.
- **Verdict:** `recall`, `precision`, `finding_quality` and `writing`, each
  with reasoning and a winner (A, B or tie), plus an overall winner with a
  self-contained explanation.

## Rating and sampling

- **Fit:** Bradley-Terry by MM iteration, ties counted as half a win, with a
  weak prior so a clean sweep stays finite. Shown as
  1500 + 400·log10(strength); a 100-point gap is about a 64% win rate.
  Intervals come from a 95% bootstrap over PRs.
- **Round 0:** every configuration pair, judged on the same `round0_prs` PRs.
- **Later rounds:** `per_pair_step` fresh PRs go to each rank-adjacent pair
  whose gap interval still crosses zero in either judge's table. Sampling
  stops when every gap is separated, when the PRs run out, or at `cap`
  judgments per judge.
- **Missing reviews:** a PR on which a configuration produced nothing drops
  out of that configuration's pairs.

## Running it

No run starts without the owner's explicit go (see the CLAUDE.md
"Direction" section).

```sh
export QCR_BENCH_RUNS_DIR=/path/to/qcr-bench-runs/runs   # outside any worktree
E=bench/aacr/elo
python3 $E/elo.py init $E/plans/martian-hard20-ft0622.json        # → $QCR_BENCH_RUNS_DIR/../elo/<name>/
D=$QCR_BENCH_RUNS_DIR/../elo/martian-hard20-ft0622
python3 $E/elo.py pack $D            # pack every PR; prints prompt sizes; no model call

$E/judge-gpt.sh start                # gpt-6.1-sol at xhigh on 127.0.0.1:8790 (ChatGPT login copy)
# Opus: bench/aacr/claude.env must hold ANTHROPIC_API_KEY=… (an API key: the Batches API)
uv run --no-project --with anthropic==1.15.0 python3 $E/elo.py run $D --rounds 1   # round 0 only
uv run --no-project --with anthropic==1.15.0 python3 $E/elo.py run $D              # adaptive to the stop
python3 $E/elo.py report $D          # → $D/REPORT.md, $D/ratings.json
python3 $E/elo.py show $D --x <run> --y <run> [--judge gpt|opus] [--pr <iid>] [--reasoning]
$E/judge-gpt.sh stop
```

- **Resuming.** `run` picks up where it stopped. It first collects any Opus
  batch still in flight, then retries failed judgments (at most 3 attempts
  each), then schedules the next round. Use `--judge gpt|opus` to run one
  judge, and `--no-wait` to submit the Opus batch and return.
- **The GPT judge's login copy** must have two hours left when the container
  starts. Restart `judge-gpt.sh` before a long run.

## Files

- **`elo_data.py`** loads cases and reviews (one loader per benchmark; Martian
  only so far), canonicalizes the reviews and packs the shared context.
- **`elo_judge.py`** holds the prompt, the JSON schema and the two clients.
- **`elo_rating.py`** holds the Bradley-Terry fit, the bootstrap, the
  scheduler and the agreement count.
- **`elo.py`** is the CLI and the run directory's state. The run directory
  holds:
  - `plan.json`;
  - `packs/` and `packs.jsonl`;
  - `units.jsonl` (PR, Review A's run, Review B's run);
  - `judgments/<judge>.jsonl` (every attempt, explanations included);
  - `batches.jsonl`;
  - `REPORT.md` and `ratings.json`.
- **`judge-gpt.sh`** runs the GPT judge container, using the same hardening
  as `ext/ext.sh`.
- **`plans/`** holds one plan per pool: benchmark, set, runs, judges, caps
  and seed.
- **`python3 elo.py --self-test`** runs offline. `tests/bench-elo.test.ts`
  runs it in the suite.
