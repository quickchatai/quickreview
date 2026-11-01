# Recompute the published numbers

Each script here rebuilds a set of published numbers from data the release
ships, with no model call. Every script takes its data directories as
arguments and prints the numbers. With `--json OUT` it also writes them as JSON.
Scripts that read the Hugging Face tables need pyarrow:
`uv run --no-project --with pyarrow python <script> ...`. A table may also be
given as `<name>.jsonl`, which is how the tests feed small fixtures.

| Published numbers | Where | Script | Data |
|---|---|---|---|
| Bootstrap intervals and paired differences; $ per defect found | `tab:ci` in both papers, benchmark.tex "Uncertainty" and §"The frozen build", README "+8.3 points [+1.9, +14.6]" | `aacr_bootstrap.py --data <hf-dataset>` (with `--seed 20260928 --halves smoke10+dev10+holdout10+fresh10:rest145`, the earlier study's halves test, benchmark.tex §"Tuned and unseen PRs") | HF `prs`, `defects`, `defect_verdicts`, `reviews` |
| Held-out PRs: AACR holdout10 + fresh10, Martian test30, Qodo's 31 never-mined PRs | README "Tuning and held-out PRs", `tab:finalbuild`, the Martian audit paragraph, the Qodo caveats, "Development sets (disclosure)" | `heldout.py --data <hf-dataset>` | HF `prs`, `defects`, `defect_verdicts`, `martian_goldens`, `martian_verdicts`, `qodo_issues`, `qodo_verdicts`, `qodo_reviews`; `sets/` |
| Pairwise Elo, judge agreement, head-to-head record; $ per PR of each configuration | README "Judged side by side" and its chart | `elo_ratings.py <archive>/elo/martian-hard20-all-gpt [--check-ratings] [--runs-dir <archive runs> ...]` | the Elo run's `plan.json`, `units.jsonl`, `judgments/` |
| "Other models" rows, DeepSeek's effort mix, GLM's missing passes | README "Other models" | `open_models.py --runs-dir <open-model runs>` | the open-model runs; `final/arms-open-models.txt` |
| Speed table, smoke figures, slowest reviews, the Qwen3.8-Max cost projection | `docs/DIGITALOCEAN.md` | `do_speed.py --runs-dir <open-model runs> --gpt-runs-dir <runs>` | the open-model smoke and full runs; `final1-*` |
| How the answer key was built: candidates by run and reviewer, hunt drafts, exclusions, tab:prov, the hunt's grade, the saturation curve, leave-one-reviewer-out, the key without QuickReview-only defects | benchmark.tex §"The answer key", THREATS-TO-VALIDITY.md §1, METHODOLOGY.md §5 | `key_build.py --archive <archive> --data <hf-dataset>` | archive `answer-key` (`rest145-code/`, `orig40-code/`); HF `prs`, `defects`, `defect_verdicts` |
| Tokens per PR (tab:costfinal, the gpt-6-sol study's budget table, the panel comparison, passes per PR and output per pass) | both papers, THREATS-TO-VALIDITY.md §5 | `tokens.py --archive <archive> --data <hf-dataset>` | archive `runs/<run>/cases/<id>/` (`pi-events.pruned.jsonl`, `case-summary.json`); HF `reviews`, `runs` |
| Judging cost and operations: calls, tokens, list cost, judgements in error, the self-consistency re-run, the AACR judge's logged calls and estimated cost | benchmark.tex "Judging cost and operations", THREATS-TO-VALIDITY.md, METHODOLOGY.md | `judge_ops.py --archive <archive> --data <hf-dataset>` | archive `runs/<run>/judge/`, `eval/`, `results/all/` |
| Lens passes per PR and each lens's share of PRs | quickreview.tex tab:lenses and §"One round" | `passes.py --archive <archive> --data <hf-dataset>` | archive `case-summary.json` |
| The Claude Code arm's harness facts (denied commands, the prose parser) | benchmark.tex "Claude Code's prose parser", PROMPTS.md | `claude_arm.py --archive <archive> --data <hf-dataset>` | archive `claude-stdout.json`, `results/all/`, `<run>.review.log` |
| Martian tune20 against the extended key, and its sensitivity | benchmark.tex tab:martianext, tab:martiansens | `martian_ext.py --archive <archive> --data <hf-dataset>` | archive `analysis/…/fair/`, `gm/rows.json`, `runs/mv-r1-asposted.martian/` |
| AACR-Bench's metric at line gates 1, 5 and 999 | benchmark.tex "The line-gate effect, measured" | `line_gate.py --archive <archive> --data <hf-dataset>` | archive `analysis/…/wp-data/linek-runs/`, `runs/<run>/results/all/`; `references.json` |
| Per-lens cost share, co-credit and unique finds; the validator's dispositions; the default's misses by what the review had at them | quickreview.tex tab:lenscost, §"Where the money goes", §"The validator removes little" | `lens_credit.py --archive <archive> --data <hf-dataset>` | archive `pi-events.pruned.jsonl`, `findings-record.json`, `results/all/`; HF `defect_verdicts` |
| QuickReview on Martian by its own severity: each candidate's tier, the blind tune20 classes per tier, the Core score per posted subset | benchmark.tex tab:martiantiers | `../relabel/martian_tiers.py --archive <archive> --data <hf-dataset> --compute` | archive `analysis/relabel/martian_tiers.labels.jsonl` (+ prompt), `runs/*.martian/`; HF `martian_goldens` |
| Where the low preset's lost credit went; the default's killed or withheld findings stating a defect it missed, and the recall bound | quickreview.tex §"The validator removes little", §"What the compute buys" | `../relabel/lost_credit.py --archive <archive> --data <hf-dataset> --compute` | archive `analysis/relabel/lost_credit.labels.jsonl` (+ prompt), `findings-record.json`; HF `defects`, `reviews`, `defect_verdicts` |
| pi-review's panel read with confirmed findings only | quickreview.tex §"What the vote does", tab:panel40 | `panel_confirmed.py --archive <archive> --data <hf-dataset>` | archive `pireview-meta.json`; HF `defect_verdicts`, `comment_verdicts` |
| The missed-defect analysis behind the levers | quickreview.tex appendix "Tuning" | `missed_defects.py --archive <archive> --data <hf-dataset>` | archive `analysis/2026-09-26-missed-defects/miss-G*.json` |
| Copilot's harvested 2025 reviews | benchmark.tex §"Copilot 2025, harvested" | `copilot_harvest.py --archive <archive> --data <hf-dataset>` | archive `runs/upstream-copilot2025-*/cases/` |
| The 2026-10-13 GLM smoke's lens timeouts | `docs/DIGITALOCEAN.md` | `smoke_lenses.py --archive <archive>` | archive `open-models/runs/glm53-smoke-7879ddc5-glm-*` |
| Martian's published Opus 4.5 judgements against the golden audit | benchmark.tex tab:martianaudit (right block) | `martian_published.py --martian <checkout> --data <hf-dataset>` | third-party: Martian's repository at e616e84 (`--martian`); HF `martian_goldens` |

The Martian scores of tuning passes, posting policies, calibration re-judges and either half are
`claim_metrics.py`'s `martian` keys over the HF tables (`WORK[+WORK]|TOOL[~HALF]:core_f2`), the
development runs' figures its `aacr` keys over their arms.

The archive-backed scripts take the release's `archive/` folder (they unpack
only the volumes they read, into `--work`) or an already unpacked archive.
`archive.py` is their shared reader. Every session log they count from is the
release's numbers-only extract (`*.pruned.jsonl`): usage, timestamps and
outcomes, no prompt or model text.

## The held-out Qodo set

`sets/qodo-heldout31.json` defines the 31 Qodo PRs that no step of the frozen
build's development used. Each script's docstring states the full rule.
`heldout.py` derives the set again from the published verdicts and fails if
the derivation and the committed file disagree. `--write-qodo-set` regenerates
the file.

## The open-model arms

`final/arms-open-models.txt` lists the runs behind each "Other models" row.
The DeepSeek row mixes two efforts:
- **Default tiers (high and medium):** the PRs its full run reviewed before
  DigitalOcean blocked the account. On AACR that is smoke10, dev10 and 22 of
  rest145, 42 PRs.
- **Low effort:** every other PR, 143 of the 185.

`openmodels`' `low-dsv41f.sh` merged the two runs into `dsv41f-mix-<set>`.
`open_models.py` reads each case's effort from its own fingerprint.

## The Elo chart

`showcase/readme_charts.py` draws the Elo chart from
`showcase/data/elo-martian-hard20.json`. To regenerate that file:

    elo_ratings.py <archive>/elo/martian-hard20-all-gpt --chart-json bench/aacr/showcase/data/elo-martian-hard20.json

The archive ships no `packs/`, so `elo.py report` cannot run on it.
`elo_ratings.py` refits the ratings from the judgments with the same
Bradley-Terry code and seed. `--check-ratings` shows that the refit equals the
run's own `ratings.json`.

## Every published number: the claims manifest

`bench/aacr/claims.json` lists every benchmark number the README, the bench
docs, the Elo README, the dataset card and both papers print: the line it is
on (an anchor), the value as printed, and the check that recomputes it, or,
where no check does yet, the reason and the data that holds it. Numbers on
those lines that are not benchmark claims (versions, dates, list prices,
method parameters, identifiers) are listed too, with the reason, so that every
number of every listed file is accounted for. The manifest's `scope` states
the rule.

    python3 bench/aacr/verify_claims.py --lint      # the manifest against the text; no data
    uv run --no-project --with pyarrow python bench/aacr/verify_claims.py \
        --data <downloaded release> [--martian <checkout>] [--qodo-gt <jsonl>] --report-md OUT.md

The verifier finds the Hugging Face tables, the slim bundle and the archive
under `--data`, recomputes every claim from whichever of them it holds
(`claim_metrics.py` over the tables; this directory's scripts and
`verify_slim.py` over the bundle), re-runs the release's own checks
(`hf_export.py`'s validation and `verify_slim.py`'s bundle checks), and exits
non-zero on any mismatch, error, missing source or missing script. `--partial`
checks only what the given data holds. A claim whose data the release does not
hold (its `no_script` reason starts "data not published") is reported as *not
published*, apart from the claims that only wait for a script, and a claim
that needs `--martian` or `--qodo-gt` when it was not given as *needs input*.
Those three are the documented gaps: they fail, and `--allow-gaps` lists them
with their reasons and passes them (a gap whose reason the manifest does not
record still fails). This release has none, and no other status exists: the
Martian severity table and the lost-credit attribution are checked by
`../relabel/martian_tiers.py` and `../relabel/lost_credit.py --compute`, which
read the label files the release ships (`analysis/relabel/`) with no model
call. Numbers are compared the way Python's
`format` prints the computed float (the manifest's `scope` states the
rounding rule).
