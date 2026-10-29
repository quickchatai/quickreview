# Recompute the published numbers

Each script here rebuilds a set of published numbers from data the release
ships, with no model call. Every script takes its data directories as
arguments and prints the numbers. With `--json OUT` it also writes them as JSON.
Scripts that read the Hugging Face tables need pyarrow:
`uv run --no-project --with pyarrow python <script> ...`. A table may also be
given as `<name>.jsonl`, which is how the tests feed small fixtures.

| Published numbers | Where | Script | Data |
|---|---|---|---|
| Bootstrap intervals and paired differences; $ per defect found | `tab:ci` in both papers, benchmark.tex "Uncertainty" and §"The frozen build", README "+8.3 points [+1.9, +14.6]" | `aacr_bootstrap.py --data <hf-dataset>` | HF `prs`, `defects`, `defect_verdicts`, `reviews` |
| Held-out PRs: AACR holdout10 + fresh10, Martian test30, Qodo's 31 never-mined PRs | README "Tuning and held-out PRs", `tab:finalbuild`, the Martian audit paragraph, the Qodo caveats, "Development sets (disclosure)" | `heldout.py --data <hf-dataset>` | HF `prs`, `defects`, `defect_verdicts`, `martian_goldens`, `martian_verdicts`, `qodo_issues`, `qodo_verdicts`, `qodo_reviews`; `sets/` |
| Pairwise Elo, judge agreement, head-to-head record; $ per PR of each configuration | README "Judged side by side" and its chart | `elo_ratings.py <archive>/elo/martian-hard20-all-gpt [--check-ratings] [--runs-dir <archive runs> ...]` | the Elo run's `plan.json`, `units.jsonl`, `judgments/` |
| "Other models" rows, DeepSeek's effort mix, GLM's missing passes | README "Other models" | `open_models.py --runs-dir <open-model runs>` | the open-model runs; `final/arms-open-models.txt` |
| Speed table, smoke figures, slowest reviews | `docs/DIGITALOCEAN.md` | `do_speed.py --runs-dir <open-model runs> --gpt-runs-dir <runs>` | the open-model smoke and full runs; `final1-*` |

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
