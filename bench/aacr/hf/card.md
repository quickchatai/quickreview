---
license: apache-2.0
language:
- en
pretty_name: Real defects in code review (QuickReview benchmark data)
size_categories:
- {{SIZE_CATEGORY}}
task_categories:
- text-generation
tags:
- code-review
- benchmark
- software-engineering
- llm-as-a-judge
configs:
{{CONFIGS_YAML}}
---

# Real defects in code review

The data behind every benchmark number QuickReview publishes, and every other
benchmark run its authors hold. It comes in three parts, all in this
repository:

- **The tables** (the configs below, `data/*.parquet`). A verified defect key
  for 185 pull requests of AACR-Bench v1.0. Every review from every shipped
  AACR-Bench run, and every judge verdict that scored it. AACR-Bench's own
  metric. The reviews and verdicts on Martian's offline code-review benchmark
  and on Qodo's PR-Review-Bench. The pairwise Elo judgments and ratings. A run
  index.
- **The run archive** ([`archive/`]({{ARCHIVE}})). The run directories as the
  runs wrote them: transcripts, reviews, judge and scorer outputs, logs. There
  is one `.tar.zst` volume per run family, {{RUN_UNITS}} run directories in
  {{RUN_FAMILIES}} families. Its README lists every volume, every rewrite and
  every file left out.
- **The slim re-score bundle** ([`slim/`]({{SLIM}})). The part of the archive
  that the scoring and recompute scripts read, with no transcript text.

DOI: {{DOI_MD}}. The code, the benchmark definition and both papers are in the
QuickReview repository, https://github.com/quickchatai/quickreview, under
`bench/aacr/`.

The two papers:

- *Measuring whether a code review finds the real defects: a verified defect
  benchmark on AACR-Bench, applied to eight reviewers at their best-shot
  configurations* (the benchmark paper, arXiv {{ARXIV_BENCHMARK_MD}}).
- *QuickReview: a multi-pass automated code reviewer, its design, its cost,
  and how it performs on a verified defect benchmark* (the technical report,
  arXiv {{ARXIV_QUICKREVIEW_MD}}).

Every number in their tables, and every benchmark number in the repository's
README and `bench/aacr/docs/`, can be recomputed from this data with no model
call; "How to verify" below shows how. The few published figures the data does
not reproduce are listed in their own section.

## Read this first

- **No human has checked the key or the judge yet.** LLM agents verified the
  520 defects and the 3,093 exclusions against the code, and an LLM judge
  graded every review. A human audit of a sample is planned and will be
  published with its agreement numbers. Until then, treat the key as an
  LLM-built answer key, with the error rate that implies.
- **The key was partly built from QuickReview's own earlier output.** The
  candidates checked for each PR included the comments that reviewers posted
  in our runs, QuickReview's among them. They were anonymised, and every
  candidate was checked against the code. A reviewer whose earlier comments
  seeded the key can still be favoured by it. `defects.provenance_*` records
  where each defect came from: 369 of the 520 were raised by the blind hunt or
  by an AACR reference, and the papers report recall on those separately.
- **The authors build one of the reviewers (QuickReview), and it was tuned on
  these benchmarks.** The last tuning round was mined from misses on part of
  each benchmark, including 145 of the 185 AACR-Bench PRs. The tuning sets are
  named per PR (`prs.set`, `prs.in_s40`, `martian_goldens.audit_split`), and
  the papers and the README report the held-out results beside the tuned ones.
- **Most results rest on one judge from one model family.** A second judge
  from another family scored only the earlier gpt-6-sol study. The final
  comparison, the frozen build, the open-model runs, Martian and Qodo each
  have one GPT judge. See "Judges" below.
- **AACR-Bench's reference labels are agent-produced**, not human labels
  (`aacr_references.is_ai_comment`, `source_model`). At least 80 of the
  references marked human are rewritten review-bot comments
  (`aacr_references.bot_derived`).
- **Each reviewer ran once and each review was judged once,** except where a
  config says otherwise: the stability runs, the second judge, the judge
  re-run.
- **Builds and judges differ between rows.** The open-model runs used a
  mid-October build and the `gpt-6.1-sol-high` judge; the frozen build and the
  papers' comparisons used `gpt-6-sol-high`. Compare rows within one judge.

## What is in here, and which claim each part backs

The claim ids in the second column are the ones the `runs` config lists per
run directory (`runs.claims`). Volume names drop the `quickreview-runs-`
prefix and the `.tar.zst` suffix. The scripts are in the QuickReview
repository under `bench/aacr/`.

| Published claim | Claim id | Tables | Archive volumes | Recomputed by |
|---|---|---|---|---|
| README "AACR-Bench, verified defects" chart and full table; benchmark paper `tab:final`, `tab:grades`, `tab:lang`, `tab:costfinal`, `tab:selection`; QuickReview paper `tab:final` | `readme:aacr`, `bench:final-tables`, `qr:tab:final` | `prs`, `defects`, `arms`, `reviews`, `defect_verdicts`, `comment_verdicts` | `aacr-frozen-build`, `aacr-final-comparison-g61`, `aacr-claude-code-opus55`, `answer-key` | `final/score.sh` on the slim bundle; `validation.json` |
| The frozen build on 185 PRs (benchmark paper `tab:finalbuild`; QuickReview paper `tab:frozen`) | `bench:tab:finalbuild`, `qr:tab:frozen` | as above, arm `quickreview-frozen` | `aacr-frozen-build` | `validation.json`; `recompute/aacr_bootstrap.py` |
| Bootstrap intervals and paired differences (README "+8.3 points [+1.9, +14.6]"; `tab:ci` in both papers) | `readme:aacr-ci` | `prs`, `defects`, `defect_verdicts`, `reviews` | as above, `analysis` | `recompute/aacr_bootstrap.py` |
| README "Same model, two reviewers" chart | `readme:same-model` | `arms`, `defect_verdicts` | `aacr-opus55-basemodel`, `aacr-gpt6sol-study`, `aacr-claude-code-opus55`, `aacr-frozen-build`, `aacr-final-comparison-g61` | `validation.json`; `final/score.sh` |
| README "Other models" table | `readme:other-models` | `arms` (`quickreview-glm-53-flash`, `quickreview-deepseek-v41-flash`, `quickreview-luna`, `quickreview-opus55`), `reviews`, `defect_verdicts` | `openmodels-glm53-full`, `openmodels-dsv41f-full`, `openmodels-dsv41f-low`, `openmodels-dsv41f-mix`, `openmodels-driver`, `aacr-luna-basemodel`, `aacr-opus55-basemodel` | `recompute/open_models.py`; `validation.json` |
| README "Tuning and held-out PRs" | `readme:heldout-aacr`, `readme:heldout-martian`, `readme:heldout-qodo` | `prs`, `defect_verdicts`, `martian_goldens`, `martian_verdicts`, `qodo_issues`, `qodo_reviews`, `qodo_verdicts` | `aacr-frozen-build`, `martian-final`, `qodo-final`, `analysis` | `recompute/heldout.py` |
| The earlier gpt-6-sol study, two judges (benchmark paper `tab:sol-summary`, `tab:second-sol` and the rest of that section) | `bench:sol-study` | `arms` (`*-sol`, `claude-code-opus55`), `defect_verdicts`, `comment_verdicts` | `aacr-gpt6sol-study`, `aacr-claude-code-opus55`, `aacr-v2-default-rerun` | `validation.json`; `final/score.sh` |
| Base models (QuickReview paper `tab:bm185`, `tab:bm40`, `tab:bmsplit`) | `qr:basemodel` | `arms`, `defect_verdicts` | `aacr-final-comparison-g61`, `aacr-gpt6sol-study`, `aacr-v2-default-rerun`, `aacr-opus55-basemodel`, `aacr-luna-basemodel` | `validation.json` |
| Stability (`tab:stab-sol`, `tab:stab`) | `bench:tab:stab-sol`, `qr:tab:stab` | `arms` (`quickreview-stab-r1` to `-r4`) | `aacr-stability-repeats`, `aacr-v2-default-rerun` | `validation.json` |
| Best-shot configuration search (`tab:bestshot`, `tab:transfer`) | `bench:bestshot` | `arms` (`*-s40`) | `aacr-bestshot-search`, `aacr-final-comparison-g61` | `final/score.sh` |
| AACR-Bench's own metric and the reference-label study (`tab:aacr`, `tab:labels-sol`) | `bench:final-tables`, `bench:sol-study` | `aacr_matches`, `aacr_references`, `aacr_reference_labels` | `aacr-final-comparison-g61`, `answer-key` | `validation.json` |
| Harvested Copilot 2025 reviews (`tab:copilot2025`) | `bench:tab:copilot2025` | `arms` (`copilot-2025-upstream`, links only) | `aacr-upstream-copilot` | `final/score.sh` |
| README Martian chart and table; benchmark paper `tab:martianfinal` and the golden-comment audit | `readme:martian`, `bench:tab:martianfinal` | `martian_prs`, `martian_goldens`, `martian_reviews`, `martian_verdicts`, `martian_scores` | `martian-final`, `analysis` | Martian's scorer on the slim bundle (`verify_slim.py`); `validation.json` |
| Martian development rounds, posting policies, judge noise (`tab:martianraw`, `fig:martianpolicy`) | `bench:tab:martianraw`, `bench:fig:martianpolicy`, `bench:martian-judge-noise` | `martian_scores`, `martian_verdicts` | `martian-tuning-rounds`, `martian-posting-variants`, `martian-judge-calibration` | Martian's scorer on the slim bundle |
| README Qodo chart and table; benchmark paper `tab:qodo` | `readme:qodo`, `bench:tab:qodo` | `qodo_prs`, `qodo_issues`, `qodo_reviews`, `qodo_verdicts` | `qodo-final`, `qodo-r6-and-vendors` | Qodo's scorer on the slim bundle; `validation.json` |
| README "Judged side by side" (pairwise Elo) and its chart | `readme:elo` | `elo_judgments`, `elo_ratings` | `elo-pairwise`; the reviews: `ft0622-hard20-claude-max-sonnet`, `ft0622-claude-code-high`, `ft0622-quickreview-on-claude`, `martian-final`, `openmodels-glm53-full`, `openmodels-dsv41f-mix` | `recompute/elo_ratings.py --check-ratings` |
| `docs/DIGITALOCEAN.md`: speed and cost table, the smokes, the review time limit | `do:speed`, `do:glm-smoke`, `do:gemma-smoke`, `do:timeouts` | none (archive only) | `openmodels-smokes`, `openmodels-gpt61-baselines`, `openmodels-glm53-full`, `openmodels-driver`, `aacr-frozen-build` | `recompute/do_speed.py` |
| QuickReview paper: cost mechanism (pass counts, lens shares, validator dispositions) | `qr:mechanism` | `reviews` | `aacr-gpt6sol-study` (transcripts) | the archive's `analysis/` |
| QuickReview paper: tuning appendix (prompt iterations, levers, lenses) | `qr:app:tuning` | `arms`, `defect_verdicts` | `aacr-dev-iterations`, `aacr-dev-levers-presets` | `compare.py` over those runs |
| QuickReview paper: the max preset example | `qr:max-anecdote` | `arms` (`quickreview-max-g61`) | `aacr-g61-smokes` | `compare.py` |

The other run families back no published number and ship anyway: the fast
option of the frozen build, the v1.0.7 re-baseline, the review-efficiency
arms, the refactor smoke, configuration ablations, development and plumbing
runs, freeze validations, a duplicate-merge check, a partial base-model probe,
the Opus 5.5 Martian smoke, one-PR probes, and the SWE-PRBench runs (archive
only). Their AACR reviews and verdicts are in the tables under arms of their
own (`arms.in_paper` is false); `runs.purpose` says what each one was for.

## Configs

One split, `test`, in every config. Which PR set a row belongs to is the `set`
column (AACR: `smoke10`, `dev10`, `holdout10`, `fresh10`, `rest145`); the
papers' 40-PR selection set S40 is `prs.in_s40`. Every review, verdict and
match row carries `run_family`, the family of the run directory it was read
from (the archive volume of the same name).

```python
from datasets import load_dataset
defects = load_dataset("{{REPO_ID}}", "defects", split="test")
verdicts = load_dataset("{{REPO_ID}}", "defect_verdicts", split="test")
runs = load_dataset("{{REPO_ID}}", "runs", split="test")
```

| Config | Rows |
|---|---|
{{CONFIG_ROWS}}

**The run index**

- `runs` — one row per shipped run directory, {{RUN_UNITS}} rows: its path in
  the archive and its volume (`archive_volumes`), its family and the family's
  title, the benchmark and PR set, the number of cases, start and end times,
  the reviewer configuration (`arm_config`), the model it billed
  (`model_billed`), its judges, what it was for (`purpose`), the published
  claims it backs (`claims`, the ids above) and the tables that hold its rows
  (`hf_tables`). `qcr_commit` is the QuickReview build the run recorded. The
  repository's history was rewritten before publication, so these ids are not
  in the public history; `qcr_commit_public` names the public commit with the
  same tree where one exists, and is null where the build was a side branch
  that was never merged. The archive's `RUNS-INDEX.json` holds the same rows,
  plus the families that were withheld.

**The answer key (AACR-Bench, 185 PRs)**

- `prs` — the 185 runnable PRs: repo, PR URL, base and head commit, language,
  set, S40 membership, counts, and the repo's licence (SPDX).
- `defects` — 520 defects (90 high, 145 medium, 285 low): title, mechanism
  and consequence (`statement`), sites, kind, severity, evidence (file:line
  and short code quotes), what a finding must say to count (`counts_if`),
  provenance, and two never-scored annotations (`benchmark_limitation`,
  `bot_derived_reference`). `key_version` is the key version the judge used
  (fresh10 is on version 1, the other sets on version 2).
- `exclusions` — 3,093 candidates checked and rejected, each with its reason.
- `aacr_references` — AACR-Bench's own 1,418 reference comments on these PRs
  (Apache-2.0), with their category and context labels, `ref_key` (the key
  `aacr_matches` uses), and whether a review bot wrote the original comment.
- `aacr_reference_labels` — our check of the 253 references on 30 PRs:
  real defect, real maintainability point, trivial, dubious or duplicate.

**The reviews and verdicts (AACR)**

- `arms` — one row per reviewer configuration: display name, the run
  directories it is scored from, the study and the paper tables it feeds,
  its run family, the model it billed, its primary judge (`judge`) and every
  judge with verdicts for it (`judges`). `in_paper` marks the configurations
  the papers or the README report. The final comparison is eight
  configurations: the seven `*-g61` arms and `claude-code-opus55`. The frozen
  build is `quickreview-frozen`; the earlier gpt-6-sol study is the seven
  `*-sol` arms and `claude-code-opus55`; `*-s40` arms are the best-shot
  selection runs on S40; the open-model rows are
  `quickreview-glm-53-flash` and `quickreview-deepseek-v41-flash`. Every other
  shipped AACR run is an arm named after its run.
- `reviews` — one row per arm and PR: the review body, its comments exactly
  as the judge numbered them (`C1`, `C2`, …), list-price cost and wall-clock
  minutes, and the number of comments AACR-Bench's harness scored.
- `defect_verdicts` — per arm, PR, defect and judge: found, partial or
  missed (`credit` 1, 0.5, 0), the comments that found it, and the judge's
  reason.
- `comment_verdicts` — per arm, PR, comment and judge: correct-valuable,
  correct-minor, partly-correct or incorrect, the defect it maps to, and
  whether the judge flagged a possible new defect.
- `aacr_matches` — AACR-Bench's own metric: per arm, PR and reference, the
  share of the harness's three judge rounds that matched it. Only runs the
  AACR harness scored have rows.

A defect with no row for an arm and PR counts as missed. Every arm of the
final comparison has a judged review for all 185 PRs.

**Martian offline benchmark (50 PRs)**

- `martian_prs`, `martian_goldens` — the 173 golden comments (MIT), with our
  adversarial audit's bucket for each (86 real, 77 not real, 10 disputed) and
  its evidence.
- `martian_reviews`, `martian_verdicts`, `martian_scores` — the Martian
  scorings of our runs (the frozen build, the three third-party
  harnesses we ran, the development rounds, the posting-policy variants, the
  open-model and Claude runs), and the published vendor reviews re-judged by
  our judge (`rejudged-*`), each golden matched or not. `work_dir` names the
  scoring directory. `martian_scores` also carries Martian's own published
  tool-level judgements (`judge` = `published: …`).

**Qodo PR-Review-Bench (100 PRs)**

- `qodo_prs`, `qodo_issues` — the 580 injected issues (MIT; 309 functional,
  271 rule violations).
- `qodo_reviews`, `qodo_verdicts` — the Qodo scorings of our runs
  (the frozen build, an earlier build of 2026-10-02, the same three harnesses,
  the fast option, the open-model runs) and Qodo's nine published vendor
  runs, each issue matched or not, with the location rule applied at ±5 lines
  and at "same file".

**Pairwise Elo (Martian, 20 PRs)**

- `elo_judgments` — one row per pairwise judgment: the plan, the PR, the two
  configurations (`a`, `b`) as the judge saw them, the judge and its effort,
  the winner overall and in four categories (recall, precision, finding
  quality, writing) with the judge's reasoning, and the sha256 of the prompt.
  `used_in_ratings` marks the 596 judgments the README's ratings use. The rest
  are attempts at a superseded prompt, live Opus probes and an exploratory
  DeepSeek judge, kept for completeness.
- `elo_ratings` — per plan, judge table (`gpt`, `opus`, `combined`) and
  category: each configuration's Elo, its 95% bootstrap interval, its wins,
  ties and losses, and its games. The pairing plans themselves are in the
  `elo-pairwise` volume.

**Other files.** `figures/` holds the papers' charts and their data,
`keys/` the answer key rendered as Markdown, `reports/` the full benchmark
report. `validation.json` holds the checks below.

## Judges

Which judge scored what, exactly. The `judge` column of each table uses the
labels in the first column.

| Judge | Model | What it scored |
|---|---|---|
| `gpt-6-sol-high` | GPT-6 Sol, high effort | the primary judge of the papers: the frozen build, the final comparison, the earlier study, and every other AACR arm except the open-model ones below (base models, stability, selection, development runs, the re-baseline, the refactor smoke). |
| `claude-opus-5-5` | Claude Opus 5.5 | the second judge. **Only the earlier gpt-6-sol study:** its seven arms (`*-sol` and `claude-code-opus55`), 3,640 reviewer-defect pairs. Claude Code's run is shared by both comparisons, so the final comparison's Claude Code row carries both judges; no other final-comparison arm does. |
| `gpt-6-sol-high-repeat` | GPT-6 Sol, high effort | the primary judge run again, on the same seven arms and 30 PRs, for self-consistency. |
| `gpt-6.1-sol-high` | GPT-6.1 Sol, high effort | the open-model runs (GLM-5.3 Flash, DeepSeek V4.1 Flash, the DigitalOcean smokes) and the GPT-6.1 Sol baselines copied beside them. |
| AACR-Bench's harness | GPT-6 Sol, low effort, three rounds | `aacr_matches`; `arms.aacr_judge` names it per arm. |
| `gpt-6.1-sol` | GPT-6.1 Sol | every row of `martian_verdicts` and `qodo_verdicts`. One judge. |
| Elo: `gpt-6.1-sol` and `claude-opus-5-5` | GPT-6.1 Sol and Claude Opus 5.5, both at xhigh | the pairwise judgments, 298 each in the ratings, pooled into 596. The two pick the same overall winner in 56% of the comparisons both judged. |

So the final comparison, the frozen build, the open-model rows, Martian and
Qodo each rest on one judge from the GPT family. The two judges agree closely
on defect verdicts where both ran (3,593 of 3,640 pairs) and much less on
pairwise preference. `validation.json` checks this coverage against the
tables: the second judge and the re-run hold rows for the seven arms only,
`arms.judges` names exactly the judges with rows for each arm, and the
Martian, Qodo and Elo judges are the ones named here.

## What is not here, and why

- **QuickReview reviewing the authors' own repositories.** A self-review run
  and the follow-up-round experiments on the authors' private product
  repository are withheld whole. They are not benchmark runs, and they quote
  private code.
- **A post-cleanup check of the default build** (`pc2-*`, public AACR-Bench
  and SWE-PRBench PRs) is withheld until the authors confirm it is not an
  own-repository run. It backs no published number.
- **Aborted and interrupted attempts** are left out. Each one was re-run
  under its normal name, and the re-run ships.
- **The Elo `packs/`** are left out. They are whole files of the reviewed
  repositories, cut to each PR, and some are under AGPL or source-available
  licences. `bench/aacr/elo/elo.py pack` rebuilds them from the public
  repositories at the commits in `units.jsonl`, and `packs.jsonl` lists the
  files each pack held. `recompute/elo_ratings.py` refits the ratings from the
  judgments alone, with no pack.
- **Third-party text** is linked, never copied: the vendor review comments
  Martian publishes (and its `published-benchmark_data.json`), the reviews of
  Qodo's nine vendors, the upstream Copilot reviews, SWE-PRBench's human review
  comments, and the PR descriptions in the answer key's `meta.json`. A row
  carries the source URL and the comment locations; an archived file carries
  `[third-party text omitted, sha256:<prefix>; see <link>]`, so equal texts
  stay equal and every score recomputes unchanged.
- **Encrypted reasoning blobs** are blanked: the value of every OpenAI
  `encrypted_content` and every Anthropic `thinkingSignature` and `signature`
  is the empty string, and the record around it is kept. They are ciphertext
  under the providers' keys. The usage records still carry the reasoning-token
  counts.
- **Data anyone can regenerate:** the reviewed repositories' code (`repo.git`,
  `base/`, `head/`, `pr.diff`; refetch from the repo and commits in each case's
  `meta.json`), the external benchmarks' cached data and harnesses (pinned:
  withmartian/code-review-benchmark@e616e84, Qodo/PR-Review-Bench@a73957c,
  foundry-ai/swe-prbench@b87f579), scratch directories, scheduler state and
  release build outputs.
- **The authors' private working notes.**
- **SWE-PRBench runs** are in the archive only, with no table. They back no
  published number.

## Names rewritten

Before export, every string in every table passed through one rewrite, the
same one the run archive applies. Nothing else in the text was changed.

| What | Replaced with | Occurrences in the tables |
|---|---|---|
{{SCRUB_TABLE}}

- `<owner>` is the operator the reviewer's production prompt addresses.
- `<review-bot>` is the reviewer's GitHub App persona.
- `quickreview` is the public name of the product. Its earlier internal name
  appears in prompts and footers, in any case.
- `<private-repo>` is the authors' private product repository. A few model
  texts, and one reviewer's listing of the bench's private case sets, name it.
- `<redacted-secret>` replaces every value of the bench's credential files. A
  provider API key that a reviewer could read from its container environment
  appeared in a few open-model transcripts.
- `<private>` and `<private-host>` replace a personal handle, a private
  commit id, an account id and private host names.
- `<runs>`, `<repo>`, `<home>` and `<pi-login-volume>` replace host paths
  and a docker volume name; they occur only in logs.
- The public repository's stand-ins: where QuickReview's prompts, as built
  at run time, carried examples from private work, the same stand-ins the
  public repository's history carries replace them, by the same rules.
- Paths under `profiles/quickchat` are left as they are: the public
  repository holds that profile.

The archive's README gives the count of every rewrite over the whole archive.

## How to verify

Download the dataset and the QuickReview repository, then recompute:

```sh
hf download {{REPO_ID}} --repo-type dataset --local-dir quickreview-bench
git clone https://github.com/quickchatai/quickreview
cd quickreview
D=../quickreview-bench

# the tables: bootstrap intervals, paired differences, held-out results
uv run --no-project --with pyarrow python bench/aacr/recompute/aacr_bootstrap.py --data $D
uv run --no-project --with pyarrow python bench/aacr/recompute/heldout.py --data $D

# the slim bundle: every final table and chart, the open-model rows,
# the DigitalOcean table, the Elo refit
mkdir slim && tar --zstd -xf $D/slim/quickreview-bench-slim.tar.zst -C slim
QCR_BENCH_RUNS_DIR=$PWD/slim/runs bench/aacr/final/score.sh
python3 bench/aacr/recompute/open_models.py --runs-dir slim/open-models/runs
python3 bench/aacr/recompute/do_speed.py --runs-dir slim/open-models/runs --gpt-runs-dir slim/runs
python3 bench/aacr/recompute/elo_ratings.py slim/elo/martian-hard20-all-gpt --check-ratings \
    --runs-dir slim/runs --runs-dir slim/open-models/runs
```

`bench/aacr/recompute/README.md` maps each published number to its script.
The claims verifier checks every published number listed in
`bench/aacr/claims.json` against this data in one command, and fails on a
mismatch, a missing source or a missing script:

```sh
uv run --no-project --with pyarrow python bench/aacr/verify_claims.py --data $D
```

`validation.json` recomputes, from these tables alone, the row counts (520
defects, 3,093 exclusions, 185 PRs per full arm, 1,418 references, 173
Martian goldens, 580 Qodo issues), the papers' headline numbers (every arm's
defects found by severity, comments correct, cost and time; the second judge;
judge agreement; the AACR metric; Martian and Qodo scores), the open-model
rows, the Elo ratings (refit from `elo_judgments` and compared with the
run's own `ratings.json`), the judge coverage above, and that every shipped
run family has rows in the tables it should. This release passes {{CHECKS}}
checks.

## Versions

This is one release. The tables of the papers' first data build (2026-10-05,
never published) were rebuilt inside it from the same run directories, and
every run held since was added. No number in either paper changed: all 391
table cells of the papers re-score to the published values.

## Published numbers this data does not reproduce

These figures in `bench/aacr/docs/DIGITALOCEAN.md` and the README do not
follow from the run files:

- The GPT-6.1 Sol row of the DigitalOcean speed table: the data gives
  16 min, 37k output tokens, 78 replies and $2.27 per PR (published 8 min,
  21k, 71, $2.30).
- The DeepSeek V4.1 Flash row: the data gives 42 min, 230 replies, 13 s and
  $0.69 (published 41 min, 223, 14 s, about $0.57).
- The GLM smoke's "median about 28 minutes" is the mean; the median is 26.5.
- "54–66 minutes on the largest AACR PRs": the full run's slowest review took
  72.2 minutes.
- "5 of the first 10 PRs timed out": no run file records it.
- README, "GLM's review was missing a lens pass on 7": 7 is the PRs whose lens
  ran but whose session did not record it; one more PR lost a lens and two
  lost the validator.
- README, "about $4 per PR" for QuickReview on Opus 5.5 in the Elo pool: the
  data gives $4.61 mean, $4.42 median.

## Datasheet (summary)

- **Motivation.** AACR-Bench scores a review by how closely it reproduces the
  original PR's comments; on 145 PRs checked in full, only 12.8% of those
  comments belong to a real defect. This key asks instead whether a review
  found the real defects the PR introduces.
- **Composition.** 185 PRs from 50 open-source repositories in ten
  languages (every AACR-Bench v1.0 PR whose head GitHub still serves),
  520 defects, 3,093 rejected candidates, the reviews and verdicts above, and
  the run directories behind them.
- **Collection.** Per PR: a blind expert hunt from the diff and code; then
  every candidate (the hunt, AACR's references, every comment any reviewer
  posted in our runs) checked against the code by agents that could not see
  who raised it, merged where it is one defect, graded high / medium / low,
  and every rejection recorded with its reason; then an adversarial critic per
  set. Reviews were produced in a locked-down local sandbox (no GitHub
  writes); the judge reads the whole review and grades every defect.
- **Severity.** high: would block a merge; medium: should be fixed before
  merge; low: real, fine as a follow-up. Weighted recall: 3 / 2 / 1.
- **Uses.** Scoring code reviewers on recall of real defects, with comment
  accuracy, cost and time beside it; studying judge agreement; studying
  reference-comment benchmarks. **Not** for training a reviewer you then
  evaluate on these PRs.
- **Known limits.** No human check yet (above); one judge family for the
  final comparison, the frozen build, Martian and Qodo; one run per reviewer;
  90 high-severity defects limit how small a difference can be resolved;
  reviewed-repo code is not included (`repo` and commits identify it).
- **Maintenance.** Changes to the key bump `key_version`; verdicts are stored
  per key version, so old and new truths never mix.

## Licence

Apache-2.0 (LICENSE), with NOTICE carrying AACR-Bench's attribution and the
modified-work statement, and the Martian and Qodo attributions. The run
archive and the slim bundle are under the same licence; the archive's README
carries the SWE-PRBench attribution as well.

## Citation

```bibtex
@misc{jakubczak2026realdefects,
  title  = {Measuring whether a code review finds the real defects: a verified defect benchmark on AACR-Bench, applied to eight reviewers at their best-shot configurations},
  author = {Mateusz Jakubczak},
  year   = {2026},
  note   = {Quickchat AI. arXiv {{ARXIV_BENCHMARK}}}
}
@misc{jakubczak2026quickreview,
  title  = {QuickReview: a multi-pass automated code reviewer, its design, its cost, and how it performs on a verified defect benchmark},
  author = {Mateusz Jakubczak},
  year   = {2026},
  note   = {Quickchat AI. arXiv {{ARXIV_QUICKREVIEW}}}
}
@misc{jakubczak2026quickreviewbench,
  title        = {Real defects in code review: QuickReview benchmark data},
  author       = {Mateusz Jakubczak},
  year         = {2026},
  howpublished = {\url{{{DATASET_URL}}}},
  note         = {Quickchat AI. DOI {{DOI}}}
}
@misc{zhang2026aacrbenchevaluatingautomaticcode,
  title         = {AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context},
  author        = {Lei Zhang and Yongda Yu and Minghui Yu and Xinxin Guo and Zhengqi Zhuang and Guoping Rong and Dong Shao and Haifeng Shen and Hongyu Kuang and Zhengfeng Li and Boge Wang and Guoan Zhang and Bangyu Xiang and Xiaobin Xu},
  year          = {2026},
  eprint        = {2601.19494},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SE}
}
```

Martian's benchmark: https://github.com/withmartian/code-review-benchmark.
Qodo PR-Review-Bench: https://huggingface.co/datasets/Qodo/PR-Review-Bench.
