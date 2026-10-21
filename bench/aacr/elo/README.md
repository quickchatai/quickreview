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
- **Checked, not assumed.** Both request builders (`chat_body`,
  `opus_params` in `elo_judge.py`) refuse a body carrying any tool key
  (`tools`, `tool_choice`, `functions`, …), more than the one prompt, or no
  json_schema format. An answer counts only when it is one plain final
  message:
  - GPT: exactly one choice, no tool call, `finish_reason` `stop`. A
    `length` finish is an error ("output cut off"); anything else is invalid,
    with the reason.
  - Opus: `stop_reason` `end_turn`, exactly one text block (thinking blocks
    aside) and no tool block. `max_tokens` and
    `model_context_window_exceeded` are errors, `refusal` is refused, and
    `tool_use`, `pause_turn` or `stop_sequence` are invalid.

  Every answer records `turns: 1` and its finish or stop reason; a GPT row
  also records `http_attempts` (the judge client retries 429 and 5xx with
  backoff, resending the same single turn). The bridge still adds its default
  `tool_choice: "auto"` and `parallel_tool_calls: true` upstream. With no
  tools they are inert, and pi's own Codex client sends them the same way, so
  the bridge is left as it is.
- **Two judges, rated separately, with an identical prompt:** gpt-6.1-sol at
  xhigh and Claude Opus 5.5 at xhigh. Every judgment records the prompt's
  sha256 (the instructions, the packed context and the two rendered reviews,
  as sent).
- **A judgment counts only at its unit's current prompt.** If its
  `prompt_sha256` is not the unit's current hash, the judgment is stale. It
  is left out of the ratings, the report and the attempt count, and the unit
  is judged again, by every judge. So re-packing a PR (new packing code), or
  rendering a review differently, keeps "the same prompt for both judges"
  true rather than mixing prompts. `report` says how many judgments per judge
  were set aside as stale.
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
  Intervals come from a 95% bootstrap over PRs. The report gives every pair
  of configurations, not only rank neighbours, a gap with the interval of the
  difference (from the same replicates), the expected win rate and the
  direct head-to-head record; `ratings.json` carries them as `pairs`.
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
python3 $E/elo.py repack $D [--pr <iid> ...] [--dry-run]   # re-pack from the current packing code
python3 $E/elo.py audit $D [--bridge-log <judge-log dir>/judge.jsonl]
$E/judge-gpt.sh stop
```

- **Resuming.** `run` picks up where it stopped. It first collects any Opus
  batch still in flight, then retries failed judgments (at most 3 attempts
  each), then schedules the next round. Use `--judge gpt|opus` to run one
  judge, and `--no-wait` to submit the Opus batch and return.
- **Re-packing.** `pack` writes a PR's context once and never rewrites it.
  `repack` rewrites `packs/<pr>.txt` from the current packing code (and
  appends to `packs.jsonl`). It prints which PRs changed and how many
  judgments per judge stop counting; the next `run` judges those units again.
  `--dry-run` only reports.
- **Audit.** `audit` checks one call per judgment from the records. Per
  judge, it prints rows against units, statuses, judgments at the current
  prompt and stale ones, and answered rows by `turns` (rows from before turns
  were stored show as missing) with their finish or stop reasons. Given the
  GPT bridge's `judge.jsonl`, it also counts the upstream requests between
  the GPT judge's first and last judgment (± 5 min). It reports how many of
  those carried tools or answered with a call, and the difference against
  the GPT judgment rows in that window: extra requests are retries or aborted
  calls.
- **Cost.** `report` prices every attempt, per call. An Opus batch call is
  priced at Batch API prices ($2 input, $10 output, $4 one-hour cache write,
  $0.10 cache read per million tokens), a live call (`service_tier`
  `standard`) at twice that. GPT gets an API-equivalent estimate at gpt-6.1-sol API
  prices: $2 input, $10 output and $0.10 cached input per million, or $4, $15
  and $0.20 for a call past 272k input tokens. The ChatGPT login route bills
  quota, not dollars.
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
