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
benchmark run its authors hold except those listed under "What is not here,
and why". It comes in three parts, all in this repository:

- **The tables** (the configs below, `data/*.parquet`). A verified defect key
  for 185 pull requests of AACR-Bench v1.0. Every review from every shipped
  AACR-Bench run, and every judge verdict that scored it. AACR-Bench's own
  metric. The reviews and verdicts on Martian's offline code-review benchmark
  and on Qodo's PR-Review-Bench. The pairwise Elo judgments and ratings. The
  answer key's build data (which reviewer raised each candidate, each PR's
  size). A run index.
- **The run archive** ({{ARCHIVE_MD}}). The run directories as the
  runs wrote them, without their raw model session logs: reviews and
  findings, judge and scorer outputs with their reasoning, run configurations,
  per-PR summaries, driver logs, and a numbers-only extract of every JSONL
  session log (timestamps, token usage, cost, lens outcomes); the other session
  logs, the process logs and the prompt files are left out with no extract.
  There is one `.tar.zst` volume per run family, {{RUN_UNITS}} run index
  units (run and scoring directories, driver files, support trees) in
  {{RUN_FAMILIES}} families. Its README lists every volume, every rewrite and every kind of
  file left out.
- **The slim re-score bundle** ({{SLIM_MD}}). The part of the archive
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

`bench/aacr/claims.json` in the repository lists every benchmark number of
both papers, the README, `bench/aacr/docs/` and this card, with the data and
the script behind it, and one command recomputes them all from this data with
no model call ("How to verify"). {{CLAIMS_LEAD}} Published numbers that
differed from the data were corrected to it before this release ("Versions").
Third-party figures the pages quote (AACR-Bench's own metadata, Qodo's and
Martian's published scores and leaderboards) are attributed to their source
and listed in the manifest as quotes, not as claims.

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

The claim ids in the second column are claim groups of the repository's
`bench/aacr/claims.json`, which describes each one (`groups`). The `runs`
config lists a group on each run directory its claims' recompute keys read
(`runs.claims`): a key that names the run, its arm or its scoring directory,
and for a script that reads the run archive the keys its `reads` ties to each
unit (the keys whose numbers moved when that unit's files were changed and the
script rerun). A group none of whose keys reads a run is on no run:
{{GROUPS_ON_NO_RUN}}.
Volume names drop the `quickreview-runs-` prefix and the `.tar.zst` suffix.
The scripts are in the QuickReview repository under `bench/aacr/`.

| Published claim | Claim id | Tables | Archive volumes | Recomputed by |
|---|---|---|---|---|
| README "AACR-Bench, verified defects" chart and full table; benchmark paper `tab:final`, `tab:grades`, `tab:lang`, `tab:costfinal`, `tab:selection`; QuickReview paper `tab:final` | `readme:aacr`, `bench:final-tables`, `qr:tab:final` | `prs`, `defects`, `arms`, `reviews`, `defect_verdicts`, `comment_verdicts` | `aacr-frozen-build`, `aacr-final-comparison-g61`, `aacr-claude-code-opus55`, `answer-key` | `final/score.sh` on the slim bundle; `validation.json` |
| The frozen build on 185 PRs (benchmark paper `tab:finalbuild`; QuickReview paper `tab:frozen`) | `bench:tab:finalbuild`, `qr:tab:frozen` | as above, arm `quickreview-frozen` | `aacr-frozen-build` | `validation.json`; `recompute/aacr_bootstrap.py` |
| Bootstrap intervals and paired differences (README "+8.3 points [+1.9, +14.6]"; `tab:ci` in both papers) | `readme:aacr-ci` | `prs`, `defects`, `defect_verdicts`, `reviews` | as above, `analysis` | `recompute/aacr_bootstrap.py` |
| README "Same model, two reviewers" chart | `readme:same-model` | `arms`, `defect_verdicts` | `aacr-opus55-basemodel`, `aacr-gpt6sol-study`, `aacr-claude-code-opus55`, `aacr-frozen-build`, `aacr-final-comparison-g61` | `validation.json`; `final/score.sh` |
| README "Other models" table | `readme:other-models` | `arms` (`quickreview-glm-53-flash`, `quickreview-deepseek-v41-flash`, `quickreview-luna`, `quickreview-opus55`), `reviews`, `defect_verdicts` | `openmodels-glm53-full`, `openmodels-dsv41f-full`, `openmodels-dsv41f-low`, `openmodels-dsv41f-mix`, `openmodels-driver`, `aacr-luna-basemodel`, `aacr-opus55-basemodel` | `recompute/open_models.py`; `validation.json` |
| README "Tuning and held-out PRs" | `readme:heldout-aacr`, `readme:heldout-martian`, `readme:heldout-qodo` | `prs`, `defect_verdicts`, `martian_goldens`, `martian_verdicts`, `qodo_issues`, `qodo_reviews`, `qodo_verdicts`; the repository's `bench/aacr/sets/` (Qodo's held-out PRs: `sets/qodo-heldout31.json`) | `aacr-frozen-build`, `martian-final`, `qodo-final`, `analysis` | `recompute/heldout.py` |
| The earlier gpt-6-sol study, two judges (benchmark paper `tab:sol-summary`, `tab:second-sol` and the rest of that section) | `bench:sol-study` | `arms` (`*-sol`, `claude-code-opus55`), `defect_verdicts`, `comment_verdicts` | `aacr-gpt6sol-study`, `aacr-claude-code-opus55`, `aacr-v2-default-rerun` | `validation.json`; `final/score.sh` |
| Base models (QuickReview paper `tab:bm185`, `tab:bm40`, `tab:bmsplit`) | `qr:basemodel` | `arms`, `defect_verdicts` | `aacr-final-comparison-g61`, `aacr-gpt6sol-study`, `aacr-v2-default-rerun`, `aacr-opus55-basemodel`, `aacr-luna-basemodel` | `validation.json` |
| Stability (`tab:stab-sol`, `tab:stab`) | `bench:tab:stab-sol`, `qr:tab:stab` | `arms` (`quickreview-stab-r1` to `-r4`) | `aacr-stability-repeats`, `aacr-v2-default-rerun` | `validation.json` |
| Best-shot configuration search (`tab:bestshot`, `tab:transfer`) | `bench:bestshot` | `arms` (`*-s40`) | `aacr-bestshot-search`, `aacr-final-comparison-g61` | `final/score.sh` |
| AACR-Bench's own metric and the reference-label study (`tab:aacr`, `tab:labels-sol`) | `bench:final-tables`, `bench:sol-study` | `aacr_matches`, `aacr_references`, `aacr_reference_labels` | `aacr-final-comparison-g61`, `answer-key` | `validation.json` |
| Harvested Copilot 2025 reviews (`tab:copilot2025`) | `bench:tab:copilot2025` | `arms` (`copilot-2025-upstream`, links only, and the arms below the table), `reviews`, `defect_verdicts`, `comment_verdicts`, `aacr_matches` | `aacr-upstream-copilot`, `aacr-gpt6sol-study`, `aacr-v2-default-rerun`, `aacr-final-comparison-g61`, `aacr-claude-code-opus55` | `final/score.sh` (its `tab:copilot2025` call) on the slim bundle; `verify_claims.py` from the tables |
| README Martian chart and table; benchmark paper `tab:martianfinal` and the golden-comment audit | `readme:martian`, `bench:tab:martianfinal` | `martian_prs`, `martian_goldens`, `martian_reviews`, `martian_verdicts`, `martian_scores` | `martian-final`, `analysis` | Martian's scorer on the slim bundle (`verify_slim.py`); `validation.json` |
| Martian development rounds, posting policies, judge noise (`tab:martianraw`, `fig:martianpolicy`) | `bench:tab:martianraw`, `bench:tab:martianfinal` (the judge-noise numbers) | `martian_scores`, `martian_verdicts` | `martian-tuning-rounds`, `martian-posting-variants`, `martian-judge-calibration` | Martian's scorer on the slim bundle |
| README Qodo chart and table; benchmark paper `tab:qodo` | `readme:qodo`, `bench:tab:qodo` | `qodo_prs`, `qodo_issues`, `qodo_reviews`, `qodo_verdicts` (QuickReview's two builds: `work_dir` and `tool` `final1-qodo-pr100` and `quickreview-frozen`, `ext-r6-qodo-pr100` and `quickreview-2026-10-02`) | `qodo-final`, `qodo-r6-and-vendors` | our scorer, `ext/qodo_judge.py`, on the slim bundle (`verify_slim.py --qodo-gt`; Qodo publishes none); `validation.json` |
| README "Judged side by side" (pairwise Elo) and its chart | `readme:elo` | `elo_judgments`, `elo_ratings` | `elo-pairwise`; the reviews: `ccvq-hard20-claude-max-sonnet`, `ccvq-claude-code-high`, `ccvq-quickreview-on-claude`, `martian-final`, `openmodels-glm53-full`, `openmodels-dsv41f-mix` | `recompute/elo_ratings.py --check-ratings` |
| `docs/DIGITALOCEAN.md`: speed and cost table, the smokes, the review time limit | `do:speed`, `do:glm-smoke`, `do:gemma-smoke`, `do:timeouts` | none (archive only) | `openmodels-smokes`, `openmodels-gpt61-baselines`, `openmodels-glm53-full`, `openmodels-driver`, `aacr-frozen-build` | `recompute/do_speed.py` |
| QuickReview paper: cost mechanism (pass counts, lens shares, validator dispositions) | `qr:mechanism` | `reviews` | `aacr-gpt6sol-study` (the transcripts' numbers-only extracts) | `recompute/passes.py`, `recompute/lens_credit.py`, `recompute/tokens.py` |
| Benchmark paper `tab:martiantiers` (QuickReview on Martian by its own severity) | `bench:tab:martiantiers`, `bench:tab:martianfinal` | `martian_goldens` | `analysis` (`analysis/relabel/martian_tiers.labels.jsonl`, its prompt, `LABELS.json`; the blind `tune20` classification), `martian-posting-variants`, `martian-tuning-rounds` | `relabel/martian_tiers.py --compute` |
| QuickReview paper: the validator's kills and the lost-credit attribution | `qr:mechanism`, `qr:tab:final` | `defects`, `reviews`, `defect_verdicts` | `analysis` (`analysis/relabel/lost_credit.labels.jsonl`, its prompt, `LABELS.json`), `aacr-gpt6sol-study` | `relabel/lost_credit.py --compute` |
| QuickReview paper: tuning appendix (prompt iterations, levers, lenses) | `qr:app:tuning` | `arms`, `defect_verdicts` | `aacr-dev-iterations`, `aacr-dev-levers-presets` | `verify_claims.py` (its table checks, `recompute/claim_metrics.py`); `recompute/missed_defects.py` |
| QuickReview paper: the max preset example | `qr:basemodel` | `arms` (`quickreview-max-g61`) | `aacr-g61-smokes` | `compare.py` |

`tab:copilot2025`'s rows are these arms, on the 19 PRs that have a
`copilot-2025-upstream` review (`final/copilot19.txt`):

| Row | Arm |
|---|---|
| QuickReview default | `quickreview-default-sol` (the `tab:final` row of that name is `quickreview-default-g61`) |
| QuickReview default, current build | `quickreview-default-sol-rerun` |
| QuickReview default, gpt-6.1-sol | `quickreview-default-g61` |
| QuickReview low | `quickreview-low-sol` |
| Claude Code (Opus 5.5) | `claude-code-opus55` |
| open-code-review | `ocr-medium-sol` |
| pi-review | `pireview-medium-sol` |
| OpenCode | `opencode-bridge-sol` |
| Codex CLI | `codex-medium-sol` |
| Copilot 2025 (upstream) | `copilot-2025-upstream` |

The claim ids come from `bench/aacr/claims.json` alone: a run or an arm
carries exactly the claim groups whose recompute keys read it (`runs.claims`,
`arms.paper_tables`, `arms.in_paper`), and `validation.json` lists the run
families and archive volumes of each group whose keys name a run (a group
whose keys read only the key, a set or a published number lists none). A
claim's `q` key names its exact rows.

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

Run it with `uv run --no-project --with datasets python` when the `datasets`
package is not installed.

| Config | Rows |
|---|---|
{{CONFIG_ROWS}}

**The run index**

- `runs` — one row per shipped run index unit, {{RUN_UNITS}} rows. Most are
  run directories and their scoring directories; the open-model driver's
  files (scripts, logs, gate reports) and a few top-level trees (the answer
  key, the analysis, the re-run logs, the Elo runs, the what-if study) are
  units of their own, and `path` shows which. Each row gives its path in
  the archive and its volume (`archive_volumes`), its family and the family's
  title, the benchmark and PR set, the number of cases, start and end times,
  the reviewer configuration (`arm_config`), the model it billed
  (`model_billed`), its judges, what it was for (`purpose`), the claim
  groups whose recompute keys read it (`claims`, the ids above) and the
  tables that hold its rows (`hf_tables`). `qcr_commit` is the QuickReview
  commit the run's image was
  built from (for a third-party tool's run, the harness around that tool). The
  repository's history was rewritten before publication, so the ids the runs
  recorded are not in the public history: `qcr_commit` names the public main
  commit the recorded one became, with `qcr_commit_on_public_main` true and
  `qcr_commit_match` saying how it was matched: `same`, the rewrite's commit
  maps carry the recorded commit to it; `ancestor`, the rewrite dropped the
  recorded commit because it changed only files that were never published, so
  it maps to the nearest ancestor the rewrite kept, whose published files are
  the same. A build with no public equivalent (from a side branch that was
  never merged, or from another clone whose commits no rewrite map holds)
  keeps its recorded id, with `qcr_commit_on_public_main` false and
  `qcr_commit_match` null. The dirty flag is separate: a dirty build
  (built from a checkout with uncommitted or untracked files; the recorded id
  ends in `-dirty`) maps to the commit it was built on, keeps the `-dirty`
  suffix and is flagged `qcr_commit_dirty` true (false for every other build):
  it is that commit plus whatever was not committed, which was not saved, so
  not necessarily the commit itself. A row that recorded no build has
  `qcr_commit`, `qcr_commit_on_public_main`, `qcr_commit_match` and
  `qcr_commit_dirty` all null. The archive's `run.json` and
  `case-summary.json` files carry the same remap, and its `RUNS-INDEX.json`
  holds the same rows, plus the families that were withheld and a
  description of each claim group the rows carry.

**The answer key (AACR-Bench, 185 PRs)**

- `prs` — the 185 runnable PRs: repo, PR URL, title, base and head commit,
  merge base, language, set, S40 membership, counts, and the repo's licence
  (SPDX). `merge_base` is the merge base of the PR's base and head on GitHub.
  The reviewers and the judge saw the diff `merge_base..head_commit`, not
  `base_commit..head_commit`: on most PRs the two differ.
- `defects` — 520 defects (90 high, 145 medium, 285 low): title, mechanism
  and consequence (`statement`), sites, kind, severity, evidence (file:line
  and short code quotes), what a finding must say to count (`counts_if`),
  provenance, and two never-scored annotations (`benchmark_limitation`,
  `bot_derived_reference`). The provenance is the key files': on the T40 sets
  it records the older runs those keys were built from, and the answer-key
  volume's `orig40-code/<id>/truth-ext.json` adds the extension reviewers'
  matches; each paper number says which reading it uses. `key_version` is the key version the judge used
  (fresh10 is on version 1, the other sets on version 2).
- `exclusions` — 3,093 candidates checked and rejected, each with its reason.
- `aacr_references` — AACR-Bench's own 1,418 reference comments on these PRs
  (Apache-2.0), with their category and context labels, `ref_key` (the key
  `aacr_matches` uses), and whether a review bot wrote the original comment.
- `aacr_reference_labels` — our check of the 253 references on 30 PRs:
  real defect, real maintainability point, trivial, dubious or duplicate.
- `aacr_candidates` — how the key was built: one row per candidate the
  agents checked, with the earlier run or the reviewer that raised it
  (`raised_by`), its file, lines and text. `round` is `candidates` for the
  first key of the rest145 PRs (each candidate mapped to the run that raised
  it) and `new-candidates` for the extended key (each mapped to the comparison
  reviewer). These back the papers' provenance table, the defects only
  QuickReview's earlier runs raised, and the leave-one-reviewer-out key.
- `pr_diffstats` — each PR's size as the papers bucket it: files changed,
  insertions, deletions and their sum (`changed_lines`), from the PR's
  `git diff --stat`. It backs recall by PR size. AACR-Bench's own
  `prs.change_line_count` counts differently.

**The reviews and verdicts (AACR)**

- `arms` — one row per reviewer configuration: display name, the run
  directories it is scored from, the study and the paper tables it feeds,
  its run family, the model it billed, its primary judge (`judge`) and every
  judge with verdicts for it (`judges`). `in_paper` marks the configurations
  a published number reads (a claim's key in `claims.json`), and
  `paper_tables` names the claim groups that read them. The final comparison is eight
  configurations: `quickreview-default-g61`, `quickreview-low-g61`,
  `pireview-panel-high-g61`, `ocr-high-g61`, `codex-high-g61`,
  `opencode-native-pr-g61`, `pragent-g61` and `claude-code-opus55` (the other
  `*-g61` arms, `quickreview-max-g61`, `best-pragent-g61` and
  `pi099-smoke-g61`, are not in it). The frozen build is `quickreview-frozen`;
  the earlier gpt-6-sol study is `quickreview-default-sol`,
  `quickreview-low-sol`, `ocr-medium-sol`, `codex-medium-sol`,
  `opencode-bridge-sol`, `pireview-medium-sol` and `claude-code-opus55`
  (`pi099-smoke-sol` is a smoke, not in it); `*-s40` arms are the best-shot
  selection runs on S40; the open-model rows are
  `quickreview-glm-53-flash` and `quickreview-deepseek-v41-flash`. Every other
  shipped AACR run is an arm named after its run.
- `reviews` — one row per arm and PR: the review body, its comments exactly
  as the judge numbered them (`C1`, `C2`, …), list-price cost and wall-clock
  minutes, and the number of comments AACR-Bench's harness scored. A comment's
  `text` is what the judge read: QuickReview's tag (`[blocker]`, `[question]`,
  `[nit]`) moved to `tag`, and its footer (priority, confidence and lens, in
  italics) removed when it starts with the priority (`_P1 · …_`). A footer of
  another form (`_nit · confidence … · lens …_`, a bare `_confidence …_`, or
  one not in italics) was not removed: the judge read it, and it stays in
  `text`. `raw_text` is the comment as the run's result file holds it, after
  the release's name rewrite ("Names rewritten"): QuickReview's comment as it
  posted it, a third-party harness's finding text, and Claude Code's summary
  and failure scenario, which it never posted. `priority` (`P0` to `P4`, or
  `nit`) and `confidence` are read from QuickReview's footer in every form;
  both are null for a comment with no footer, as for every other reviewer. A
  link-only arm's `raw_text` is null. The archive has the review as it was
  written: `results/all/<id>.json` (`content`), `cases/<id>/comments.json`,
  `review.md` and `findings-record.json`.
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
final comparison has a judged review for all 185 PRs. Some reviews list a
comment twice: once on the deleted line it was written on, and once
re-anchored to the new side with the same text. The judge read and graded
both copies, and both count: 12, 15 and 24 comments in the frozen build and
the two open-model arms (51 in all), and a few in arms no paper reports.

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
- A QuickReview row's `comments` are what Martian's step 1 reads from
  GitHub: the first 30 inline comments (one API page) and the review body.
  `n_posted_inline` counts every inline comment posted, and
  `comments_beyond_first_page` holds the ones past the page, which Martian's
  judge never saw. The text is as posted, after the name rewrite (which also
  touches a few sandbox paths the comments quote).
- `fast1-martian50` scored the fast option beside the re-judged vendors, and
  its QuickReview reviews were ingested under the tool name `claude-code`.
  They are relabelled `quickreview` here. That dir's `claude-code` rows in
  `martian_scores` are Martian's published scores for Claude Code.
- The posting-policy runs (`mv-*`, `mt-test30-frozen`, `qr-all50-*`) are
  filters of stored reviews. 5 of the 56 also shorten each comment, to its
  title or its title and first line. Each run's `VARIANT.json` in the archive
  states its policy.

**Qodo PR-Review-Bench (100 PRs)**

- `qodo_prs`, `qodo_issues` — the 580 injected issues (MIT; 309 functional,
  271 rule violations). `qodo_prs.base_commit` and `head_commit` are the real
  GitHub commits: the PR's merge-base and its head, whose trees are the trees
  our runs reviewed. The runs reviewed them as replay commits, the same trees
  under a synthetic author, date and message so the reviewer could not read
  the PR's history; those ids never existed on GitHub. The run files carry
  them, and the case directories are named by the short replay head, so
  `replay_base_commit` and `replay_head_commit` keep them for the join.
  `repo_license` is per PR: the redis fork's licence changed between its PRs
  (read from `LICENSE.txt` at each PR's head).
- `qodo_reviews`, `qodo_verdicts` — the Qodo scorings of our runs
  (the frozen build, an earlier build of 2026-10-02, the same three harnesses,
  the fast option, the open-model runs) and Qodo's nine published vendor
  runs, each issue matched or not, with the location rule applied at ±5 lines
  and at "same file". Every verdict row has its review. QuickReview's two
  published builds are the rows with `work_dir` and `tool`
  `final1-qodo-pr100` and `quickreview-frozen` (the frozen build), and
  `ext-r6-qodo-pr100` and `quickreview-2026-10-02`, 100 reviews each.
  `qodo_reviews.comments` holds what our judge was sent: `ask()` in
  `bench/aacr/ext/qodo_judge.py` builds the message from it and cuts a long
  comment's text and a long issue's code (its limits are there). The two builds
  were sent their deleted-line comments differently: the frozen build's 12
  were re-anchored to the new side and judged, and the 2026-10-02 build's 18
  were left out (2 of them on held-out PRs). So the rise in rule violations
  found, 14.8% to 37.6%, compares builds under slightly different inputs.
  The held-out PRs are `sets/qodo-heldout31.json` in the repository.

**Pairwise Elo (Martian, 20 PRs)**

- `elo_judgments` — one row per pairwise judgment: the plan, the PR, the two
  configurations (`a`, `b`) as the judge saw them, the judge and its effort,
  the winner overall and in four categories (recall, precision, finding
  quality, writing) with the judge's reasoning, and the sha256 of the prompt.
  `used_in_ratings` marks, per plan, the judgments that plan's ratings use:
  the 596 of the README's plan (`martian-hard20-all-gpt`) and the smoke
  plan's own. The rest are attempts at a superseded prompt, live Opus probes
  and an exploratory DeepSeek judge, kept for completeness.
- `elo_ratings` — per plan, judge table (`gpt`, `opus`, `combined`) and
  category: each configuration's Elo, its 95% bootstrap interval, its wins,
  ties and losses, and its games. The pairing plans themselves are in the
  `elo-pairwise` volume.

**Every comment, by reviewer**

What you can read before you download: the comment rows of `reviews`
(AACR-Bench), `martian_reviews` (the comments past Martian's first page
included) and `qodo_reviews`, counted per reviewer from the tables when this
card was built. Every shipped run counts, so a PR that several runs reviewed
counts once per run. A count is of comments whose text the table holds; a
"location or link only" comment carries its file and line, or its link, and
its text is third-party ("What is not here"). A Martian vendor row carries no
comment rows: Martian's own file holds them. An AACR arm counts under the tool
its id names (`claude-code-opus55`, `best-pragent-g61`, `ccvq-cc303-*` for
Claude Code); the development, ablation, smoke and open-model arms are
QuickReview's.

{{COMMENT_INVENTORY}}

The verdicts that read them: `comment_verdicts` (AACR-Bench, a grade per
comment) and `defect_verdicts` (the comments that found each defect);
`martian_verdicts` (per golden, matched or not) with
`martian_reviews.unmatched_candidates`, the candidates extracted from a review
that matched no golden; `qodo_verdicts` (per issue, the comment that matched
it, `comment_index`).

**Other files.** `figures/` holds the papers' charts and their data, and
`keys/` the answer key rendered as Markdown. `validation.json` holds the
checks below (see "How to verify" for how they relate to the claims
verifier's release checks). `LICENSES/` holds the MIT licence texts of Martian's and
Qodo's data (see "Licence"). The working report the papers grew from is not
included: the papers supersede it.

## Judges

Which judge scored what, exactly. The `judge` column of each table uses the
labels in the first column.

| Judge | Model | What it scored |
|---|---|---|
| `gpt-6-sol-high` | GPT-6 Sol, high effort | the primary judge of the papers: the frozen build, the final comparison, the earlier study, and every other AACR arm except the open-model ones below (base models, stability, selection, development runs, the re-baseline, the refactor smoke). |
| `claude-opus-5-5` | Claude Opus 5.5 | the second judge. **Only the earlier gpt-6-sol study:** its seven arms (listed under `arms` above), 3,640 reviewer-defect pairs. Claude Code's run is shared by both comparisons, so the final comparison's Claude Code row carries both judges; no other final-comparison arm does. |
| `gpt-6-sol-high-repeat` | GPT-6 Sol, high effort | the primary judge run again, on the same seven arms and 30 PRs, for self-consistency. |
| `gpt-6.1-sol-high` | GPT-6.1 Sol, high effort | the open-model runs (GLM-5.3 Flash, DeepSeek V4.1 Flash, the DigitalOcean smokes) and the GPT-6.1 Sol baselines copied beside them. |
| AACR-Bench's harness | GPT-6 Sol, low effort, three rounds | `aacr_matches` for every arm the papers report. Early development arms (prompt iterations, smokes, end-to-end checks; none in the papers) ran it with GPT-5.6 Terra at low effort, or with a single round. `arms.aacr_judge` names the model and rounds per arm. |
| `gpt-6.1-sol` | GPT-6.1 Sol, low effort, medium verbosity (`ext_judge.py`'s default) | every row of `martian_verdicts` and `qodo_verdicts`. One judge, served by the ChatGPT Codex backend through `bench/aacr/ext/ext_judge.py`. The backend rejects a sampling temperature, so the bridge drops the harnesses' temperature 0 (and, on one Martian smoke, some requests' `max_completion_tokens`). On Martian the same model also extracts and merges the candidates (steps 2 and 2.5). Each Martian scoring dir's `runs.judges` row states the model, effort, backend and dropped request keys from its request log (one dir has none, and says so), and the verbosity as `ext_judge.py`'s default, which no log records. |
| Elo: `gpt-6.1-sol` and `claude-opus-5-5` | GPT-6.1 Sol and Claude Opus 5.5, both at xhigh | the pairwise judgments, 298 each in the ratings, pooled into 596. The two pick the same overall winner in 56% of the comparisons both judged. |

The primary AACR judge's prompt is `judgePrompt()` in `src/bench/defects.ts`.
The repository's public main builds exactly the prompts behind the published
verdicts from commit `34164fe0e` to `839e26454`; later commits render a few
reviews differently. `bench/aacr/recompute/judge_prompt.py` prints that prompt
for any arm and PR from these tables. `review_hash` in the archive's judge
files is not a public check: it was taken before the name rewrite. The Qodo
judge was asked twice on the 10 PRs of `ext-r6-qodo-smoke10`, every tool's
review: 222 of the 223 matches of the first pass recur in the second (the
run's `scores.md`). The final comparison, the frozen build, the open-model rows, Martian and
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
  and SWE-PRBench PRs) is withheld by the authors. It is a regression check of
  a development build and backs no published number.
- **Raw model session logs** of every kind are not published: the reviewers'
  pi event streams and session files, lens, Codex, Claude Code and OpenCode
  transcripts, the judges' event streams, the review and judge processes' own
  output logs, the sandbox command logs, and the prompt files each session was
  given. They hold the prompt text QuickReview's sessions were built from during
  development, not benchmark data. Each JSONL session log ships instead as a
  numbers-only extract (`*.pruned.jsonl`: timestamps, token usage, cost, stop
  reasons and lens outcomes, no prompt or model text), so the speed, cost,
  token and lens claims stay verifiable: `compare.py` prices a case from its
  extract exactly as from the full stream. Session text inside the files that
  are kept is rewritten field by field: a harness result's `stdout` (the
  Codex event stream) and `stderr` become numbers-only extracts, a prompt in
  a driver's recorded argv or a tool's prompt template becomes a hash, and
  Claude Code's denied commands become a count. The set is defined by file
  kind and fails closed, and a kept data file that still holds session text
  is left out whole; the archive's README lists every kind and its count.
- **Aborted and interrupted attempts** (`aborted-*`, the open-model
  driver's `interrupted*`) are left out. Most were re-run under their normal
  name, and the re-run ships. The attempts at a full Martian run of
  QuickReview on Opus 5.5 (`aborted-c4-opus55-martian50`,
  `aborted-ratelimit-opus55-martian50`) were stopped and never completed:
  only that configuration's smoke, `opus55-martian-smoke10`, ships. The
  partial base-model probe (`aacr-astra-probe`) ships as the partial run it
  is; `runs.purpose` says where it stopped.
- **The Elo `packs/`** are left out. They are whole files of the reviewed
  repositories, cut to each PR, and some are under AGPL or source-available
  licences. `bench/aacr/elo/elo.py pack` rebuilds them from the public
  repositories at the commits of the plan's set (`expect_merge_base` and
  `head_commit`), read from bare clones the archive does not ship
  (`bench/aacr/elo/README.md` says how to make them), and `packs.jsonl` lists
  the files each pack held. `recompute/elo_ratings.py` refits the ratings from the
  judgments alone, with no pack.
- **Third-party text** is linked, not copied: the vendor review comments
  Martian publishes (and its `published-benchmark_data.json`), the reviews of
  Qodo's nine vendors, the upstream Copilot reviews, SWE-PRBench's human
  review comments, and PR authors' descriptions wherever a file copied one
  (the answer key's `meta.json`, PR-Agent's describe output, the open-model
  case sets). A Qodo or Copilot row carries the source URL and the comment
  locations; a Martian vendor row carries none (Martian's own file lists
  them). An archived file carries
  `[third-party text omitted, sha256:<prefix>; see <link>]`, so equal texts
  stay equal and every score recomputes unchanged. To restore the text, fetch
  it and match the prefix (the sha256 of the comment's text): Martian's
  vendor comments are in Martian's repository at `e616e84`
  (`offline/results/benchmark_data.json`); Qodo's are on the vendors' public
  fork PRs (`qodo_reviews.source_url`), and the archive's
  `<run>.qodo/judgements.jsonl` holds each comment's prefix; Copilot's are on
  the upstream PRs: fetch `pulls/{n}/reviews` and `pulls/{n}/comments` from
  GitHub's API into `<id>.reviews.json` and `<id>.comments.json`, and
  `bench/aacr/harvest_upstream.py --api DIR --out RUNS --prefix
  upstream-copilot2025 --fetch` rebuilds the run dirs. Third-party text that does
  ship, under its own licence: Martian's golden comments and published
  tool-level judgements and Qodo's issues (MIT, see "Licence"), AACR-Bench's
  reference comments (Apache-2.0), and code quoted by reviewers and judges
  (each project's licence). Two copies of vendor text also ship verbatim:
  the Martian judge's extractions of the re-judged vendors' comments (the
  vendor candidates in the archived and slim `candidates.json` and
  `evaluations.json`) and the vendor candidates of the blind annotation's
  candidate list (the archive's `analysis/…/fair/secret.json`). That text
  belongs to its authors, the vendors' review bots that posted it on public
  pull requests, and is not covered by this dataset's licence. The tables
  keep it out: `martian_reviews` rows of a vendor carry no comment or
  candidate text.
- **Encrypted reasoning blobs** are blanked: the value of every OpenAI
  `encrypted_content` and every Anthropic `thinkingSignature` and `signature`
  is the empty string, and the record around it is kept. They are ciphertext
  under the providers' keys. The usage records still carry the reasoning-token
  counts.
- **Data anyone can regenerate:** the reviewed repositories' code (`repo.git`,
  `base/`, `head/`, `pr.diff`; refetch from the repo and commits in each case's
  `meta.json` for AACR-Bench, the `martian_prs` table for Martian; for Qodo and
  SWE-PRBench the run files carry the harness's replay commit ids, made so the
  reviewer could not read the PR's history and never on GitHub: the real
  commits are in each case set's `leakproof` block, `source_head` and
  `source_merge_base` in `bench/aacr/sets/<set>.json` of the repository, and
  in `qodo_prs`, and the replayed trees equal those commits' trees), the
  external benchmarks' cached data and harnesses (pinned:
  withmartian/code-review-benchmark@e616e84, Qodo/PR-Review-Bench@a73957c,
  foundry-ai/swe-prbench@b87f579), scratch directories, scheduler state and
  release build outputs.
- **The authors' private working notes.**
- **SWE-PRBench runs** are in the archive only, with no table. They back no
  published number. The eval100 run's judged comments
  (`quickreview-answers.json`) differ from the posted ones on 8 of its 100
  PRs: 5 add a finding the review posted in its body, and 3 leave out a
  deleted-line comment. Both sets ship.

## Names rewritten

Before export, every string in every table passed through one rewrite, the
same one the run archive applies. Apart from it, the only changes to the
text are the third-party omissions above and the `qcr_commit` remap (see
`runs`).

| What | Replaced with | Occurrences in the tables |
|---|---|---|
{{SCRUB_TABLE}}

- `<owner>` is the operator the reviewer's production prompt addresses.
- `<review-bot>` is the reviewer's GitHub App persona.
- `quickreview` is the public name of the product. Its earlier internal name
  appears in prompts and footers, in any case.
- `<private-repo>` is the authors' private product repository. A few model
  texts name it.
- `<redacted-secret>` replaces every value of the bench's credential files,
  wherever one occurs. A provider API key that a reviewer could read from its
  container environment appeared in a few open-model transcripts; those
  transcripts are not published.
- `<ticket>` replaces the ids of the authors' tracker, which is not public,
  in any spelling (with or without the hyphen, in any case, as in an image tag
  `qcr-bench:<ticket>`), and any path into it. No ticket number is kept: the
  runs of the Claude Code vs QuickReview study, whose directory names began
  with one, are named `ccvq-*` throughout (with the Elo plan
  `martian-hard20-ccvq`), as the public repository's Elo plans name them.
- `<private>` and `<private-host>` replace a personal handle, a private
  commit id, an account id and private host names.
- `<runs>`, `<repo>`, `<home>` and `<pi-login-volume>` replace host paths
  and a docker volume name; they occur almost only in the archive's logs (the
  table above counts the few in the tables).
- The public repository's stand-ins: where QuickReview's prompts, as built
  at run time, carried examples from private work, the same stand-ins the
  public repository's history carries replace them, by the same rules.
- Paths under `profiles/quickchat` are left as they are: the public
  repository holds that profile.

The archive's README gives the count of every rewrite over the whole archive.

## How to verify

Needs: git, Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), zstd (for
`tar --zstd`) and a Hugging Face login (`uvx hf auth login`). Run `hf` as
`uvx hf` when Hugging Face's CLI is not installed, and `load_dataset` (see
"Configs") with `uv run --no-project --with datasets python`. Nothing in this
section needs docker, a key or a model call. Disk: about 3 GB covers the
download, the clone, the unpacked slim bundle, the archive volumes the two
relabel scripts unpack and uv's caches.

Download the dataset and the QuickReview repository at the ref this release
was verified against, then recompute:

```sh
hf download {{REPO_ID}} --repo-type dataset --local-dir quickreview-bench
git clone --branch {{REPO_REF}} https://github.com/quickchatai/quickreview
cd quickreview
D=../quickreview-bench

# the tables: bootstrap intervals, paired differences, held-out results
uv run --no-project --with pyarrow python bench/aacr/recompute/aacr_bootstrap.py --data $D
uv run --no-project --with pyarrow python bench/aacr/recompute/heldout.py --data $D

# the slim bundle: every final table and chart, the open-model rows,
# the DigitalOcean table, the Elo refit
mkdir slim && tar --zstd -xf $D/slim/quickreview-bench-slim.tar.zst -C slim
(cd slim && awk '{print $1"  "$3}' FILES.sha256 | sha256sum -c --quiet)   # every file's sha256 (hash, size, path)
QCR_BENCH_RUNS_DIR=$PWD/slim/runs QCR_CHARTS_OUT=$PWD/charts-out bench/aacr/final/score.sh
python3 bench/aacr/recompute/open_models.py --runs-dir slim/open-models/runs
python3 bench/aacr/recompute/do_speed.py --runs-dir slim/open-models/runs --gpt-runs-dir slim/runs
python3 bench/aacr/recompute/elo_ratings.py slim/elo/martian-hard20-all-gpt --check-ratings \
    --runs-dir slim/runs --runs-dir slim/open-models/runs
```

`{{REPO_REF}}` is the release's tag. It is made on the repository's main
branch when the release's code is merged, and its `bench/aacr/` is the code
this release was built and verified with, file for file.

Two tables in the papers rest on a labelling pass as well as the runs: the
benchmark paper's `tab:martiantiers` and the QuickReview paper's lost-credit
figures. The label files ship in the archive's `analysis` volume and the slim
bundle under `analysis/relabel/`, each row with the model that wrote it
(gpt-6.1-sol) and the sha256 of the prompt shipped beside it; `LABELS.json`
names the script, model, effort, prompt hash and row count of each pass. The
two scripts turn the labels and the archive into the published numbers with no
model call (each unpacks the archive volumes it reads into `work/`), and refuse
a row whose prompt hash is not the shipped prompt's:

```sh
uv run --no-project --with pyarrow python3 bench/aacr/relabel/martian_tiers.py \
    --archive $D/archive --data $D --work work --compute
uv run --no-project --with pyarrow python3 bench/aacr/relabel/lost_credit.py \
    --archive $D/archive --data $D --work work --compute
```

`QCR_CHARTS_OUT` keeps the re-drawn charts out of the clone (a re-rendered
JPEG differs byte for byte from the committed one).
`bench/aacr/recompute/README.md` maps each published number to its script.
The claims verifier checks every published number listed in
`bench/aacr/claims.json` against this data in one command. Two of its
inputs are third-party and never in this dataset: a checkout of Martian's
benchmark at the pinned commit (its scorer and published judgements) and
Qodo's ground-truth file (the dataset's
`git_code_review_bench_100_w_open_prs.jsonl`):

```sh
git clone https://github.com/withmartian/code-review-benchmark martian
git -C martian checkout e616e849755441da38f18bf3adba2c9583b03803
hf download Qodo/PR-Review-Bench --repo-type dataset --revision a73957c450a70693a743260e5637fffc44625f16 --local-dir qodo
uv run --no-project --with pyarrow python bench/aacr/verify_claims.py --data $D \
    --martian martian --qodo-gt qodo/git_code_review_bench_100_w_open_prs.jsonl
```

It fails on a mismatch, an error, a missing source, a claim with no
recompute script and a claim whose data the release does not hold; left
without an input above, it fails on the claims that need it.
On this release: {{VERIFY_RESULT}}

Its release checks are the checks of `validation.json` (below) that need only
the tables, re-run on your download, and the slim bundle's own (every file's
hash, no transcript text, every Martian and Qodo scoring dir re-scored, the
Elo refit). `validation.json` also holds the checks the export ran against its
own inputs (the source run directories, the commit remap, the archive's index,
the figures): that every run family has rows in the tables it should, the
`runs` table's build ids, each Elo plan's refit against its run's
`ratings.json`. A download cannot re-run those, so its count is the larger.

`--partial` checks what you have. `verify_claims.py --data $D --partial`
skips, and does not fail, a claim whose source is not under `--data` or whose
only missing input is Martian's checkout or Qodo's file (with the slim
bundle's Martian and Qodo re-scores), and exits 0 when every other claim
passes. Its result line counts the skipped claims and names the flag that
would include them (`--martian`, `--qodo-gt`). With the tables alone (no slim
bundle, no archive) it recomputes every claim they hold. Without `--partial`
a missing input fails.

`validation.json` recomputes, from these tables alone, the row counts (520
defects, 3,093 exclusions, 185 PRs per full arm, 1,418 references, 173
Martian goldens, 580 Qodo issues), the papers' headline numbers (every arm's
defects found by severity, comments correct, cost and time; the second judge;
judge agreement; the AACR metric; Martian and Qodo scores), the open-model
rows, the Elo ratings (refit from `elo_judgments` and compared with the
run's own `ratings.json`), the judge coverage above, and that every shipped
run family has rows in the tables it should. This release passes {{CHECKS}}
checks.

## Re-judge with your own judge

Every QuickReview review behind a published number is in the tables, so you
can judge it with your own judge and score that judge's answers the way we
scored ours, with no model call of ours. Write your answers as tables shaped
like ours (`.parquet` or `.jsonl`, in a directory `DIR`, no `judge` column),
pick a label no published row carries (`LABEL`), and run the scorer. It
prints your judge's numbers beside our judge's on the same reviews: when your
judge judged only some of a run's PRs, both columns are counted over those
PRs, and the header says how many (`--whole-run` counts every PR instead, a PR
your judge did not judge counting as missed, so the two columns are then not
comparable). Each
script's docstring gives the columns and what it refuses. `D` is this
dataset, and the scripts are in the repository's `bench/aacr/recompute/`;
run them as `uv run --no-project --with pyarrow python <script>`.

**AACR-Bench.** Input: the `reviews` rows of an arm (`arms.arm_id`, or the arm
a claim's `q` key names): the review's `verdict`, `body` and `comments` (`C1`,
`C2`, …) as the judge read them. Answer key: the PR's `defects`, and its `exclusions` (the rejected
claims our judge was also shown). The code: `prs.repo`, diff
`prs.merge_base..prs.head_commit`, and the PR's `title`. Our judge's prompt
is `judgePrompt()` in `src/bench/defects.ts`; `judge_prompt.py --data $D
--arm ARM --pr ID` prints the one our judge received, and `--all --out-dir
OUT` every one of an arm that our judge received. Output: `defect_verdicts` (arm_id, instance_id,
defect_id, verdict: found, partial or missed) and, optionally,
`comment_verdicts` (arm_id, instance_id, comment_id, grade, defect_id,
new_defect). Score:

```sh
score_verdicts.py --data $D --verdicts DIR --judge LABEL [--arms a,b]   # recall, comments correct, agreement
aacr_bootstrap.py --data $D --verdicts DIR --judge LABEL --arms a,b     # the intervals
heldout.py --data $D --fixed-set --verdicts DIR --judge LABEL           # the held-out PRs
```

If you re-ran our own judge instead (`bench.sh judge` over the archive's run
directories, as "Reproduce" in `bench/aacr/README.md` says), score its files
directly: `score_verdicts.py --data $D --judge LABEL --from-judgements ARM
--runs-dir <archive>/runs --judge-dir NAME` reads each run's
`judge/v<key version>-NAME/` in the arm's `runs` (`NAME` is the label the
judge wrote under, such as `openai-gpt-6-sol-high` on your own key), and
`--save DIR` writes the two tables for `aacr_bootstrap.py` and `heldout.py`.
Run on our judge's own files in the archive (`--judge-dir gpt-6-sol-high`),
it prints the published numbers.

**Martian.** Input: the `martian_reviews` rows of QuickReview, by `work_dir`
and `tool` as a claim's key names them (the frozen build: `final1-martian50`,
`quickreview-frozen`), or the archive's `runs/<work_dir>.martian/results/benchmark_data.json`,
which Martian's pipeline reads. Answer key: `martian_goldens`. Our judge is
Martian's own steps 2, 2.5 and 3 at `e616e84`, on GPT-6.1 Sol; their prompts
are in Martian's repository, and `bench/aacr/ext/ext_judge.py`'s docstring
gives the commands to run them with no docker (through its bridge for a
Responses API model, or with `MARTIAN_BASE_URL` set straight to a Chat
Completions endpoint). Output: `martian_verdicts` (work_dir, tool, pr_url,
golden_index, matched) and `martian_reviews` (work_dir, tool, pr_url, fp: the
PR's unmatched candidates). Score:

```sh
martian_scores.py --data $D --verdicts DIR --judge LABEL [--runs WORK|TOOL] [--half martian-test30]
martian_scores.py --data $D --judge LABEL --work final1-martian50 \
    --from-evaluations <dir>/results/<model>/evaluations.json --tool 'final1-martian50|quickreview=quickreview-frozen'
```

The second form reads Martian's pipeline output (`results/<model>/evaluations.json`)
as the export does: a golden is matched when a true positive's `golden_comment`
is its `comment`, `fp` is the PR's, and `--tool` gives the tool the table's
name. Run on our judge's own file in the archive, it prints the published
scores.

Without `--verdicts` it recomputes our judge's stored scores and fails on
any difference. The stored column holds whole-run scores only: on a sample of
a run's PRs, or with `--half`, it reads `unknown`, and the column to compare
yours with is our judge's recomputed one. To judge one PR, cut the archive's
`benchmark_data.json` to that PR and to QuickReview's review
(`ext_judge.py`'s docstring has the command; `ext/martian_ingest.py --only`
writes such a file from a run directory): step 3 judges every tool the file
holds.

**Qodo.** Input: `qodo_reviews` with `work_dir` and `tool`
`final1-qodo-pr100` and `quickreview-frozen` (the frozen build), or
`ext-r6-qodo-pr100` and `quickreview-2026-10-02`; `comments` holds what our
judge was sent. Answer key: `qodo_issues`. Our judge's prompt is `SYSTEM` in
`bench/aacr/ext/qodo_judge.py`, and `ask()` there builds the user message
(it cuts long comment text and issue code); the code, not the judge, applies
the location rule (`located()`). Output: `qodo_verdicts` (work_dir, tool,
pr_url, issue_index, matched, comment_index). Score:

```sh
qodo_scores.py --data $D --verdicts DIR --judge LABEL [--runs WORK|TOOL,...]
qodo_scores.py --data $D --judge LABEL --work final1-qodo-pr100 \
    --from-judgements <dir>/judgements.jsonl --tool 'final1-qodo-pr100|quickreview=quickreview-frozen'
```

The second form reads `qodo_judge.py`'s `judgements.jsonl` as the export
does (per PR and tool the first-pass row its own scoring reads, one verdict per
issue) and refuses a judgement of comments other than the published review's;
give `--from-judgements` and `--work` once per work dir to score both builds.
Run on our judge's own files in the archive, it prints the published scores.

To run our judge's prompt on your model, with no docker: start
`ext_judge.py` on your provider (its docstring), then judge the published rows
(`--only ID[,ID]` judges those cases of the set only, as an instance id,
`Ghost#6` or a PR URL; leave it out for all of them):

```sh
uv run --no-project --with pyarrow python bench/aacr/ext/qodo_judge.py \
    --set bench/aacr/sets/qodo-pr100.json --gt qodo/git_code_review_bench_100_w_open_prs.jsonl \
    --reviews $D/data/qodo_reviews.parquet --review-key 'final1-qodo-pr100|quickreview-frozen' \
    --endpoint http://127.0.0.1:8765/v1/chat/completions --model MODEL --judge-label LABEL \
    --out qodo-judge --only Ghost#6
```

and score `qodo-judge/judgements.jsonl` with the second form above.

It also scores the held-out PRs (`sets/qodo-heldout31.json`) and the
frozen build's held-out gain over the 2026-10-02 build.

**Copilot 2025 (`tab:copilot2025`).** Input: the arms in the table under
"What is in here", on the PRs of `copilot-2025-upstream`. Judge and output
as for AACR-Bench. Score:

```sh
score_verdicts.py --data $D --verdicts DIR --judge LABEL --select arm=copilot-2025-upstream \
    --arms quickreview-default-sol,quickreview-default-sol-rerun,quickreview-default-g61,quickreview-low-sol
```

Copilot's own text is link-only, and `judge_prompt.py` refuses a link-only
review: re-judging Copilot's own reviews needs them restored ("What is not
here") and our pipeline run on the restored run directories (Tier 2 in
`bench/aacr/README.md`).

**Elo.** Input: the plan's run directory in the archive (`elo/martian-hard20-all-gpt/`:
`plan.json`, `units.jsonl`, `judgments/`) and the reviews it pairs, which are
also in `martian_reviews`. Our two judges' prompt is built by
`bench/aacr/elo/elo.py pack` from bare clones of the reviewed repositories,
which the archive does not ship (`bench/aacr/elo/README.md` says how to make
them), and each `elo_judgments` row carries its `prompt_sha256`. Give your
judge the same prompts: its `prompt_sha256` must equal the row's, or the
latest judgment sets the unit's prompt and the others' judgments of it go
stale (`elo_ratings.py` warns). Point the plan's `run_dirs`
at the unpacked archive and add your judge under the plan's `judges`
(`bench/aacr/elo/README.md` says how). Output: the judgments `elo.py run`
writes. Score:

```sh
python3 bench/aacr/elo/elo.py pack D   # D: the plan's run directory, then: run D --judge NAME, report D
elo_ratings.py D --runs-dir <archive>/runs --runs-dir <archive>/open-models/runs
```

Both rate every judge the plan names, and give each pair's agreement.
`--runs-dir` prices a configuration only when its run directory is whole:
run `bench/aacr/ext/restore_copies.py` over the unpacked volumes first,
the open-model volumes included.

To re-run our own judge instead, see `bench/aacr/README.md` ("Reproduce",
Tier 2) and `bench/aacr/ext/ext.sh`; set `EXT_JUDGE_MODEL` to judge Martian
and Qodo with another model. Those runs build and start docker containers:
they need a host where `docker info` succeeds, with Docker 25 or newer.
Which provider each judge can be pointed at, and how, is in one place:
`bench/aacr/README.md`, "Judges on any provider".

## Versions

This is one release. The tables of the papers' first data build (2026-10-05,
never published) were rebuilt inside it from the same run directories, and
every run held since was added. Building the claims manifest against this
data found published numbers that differ from it; each was corrected to the
data in the papers (both rebuilt), the README and `bench/aacr/docs/` before
this release. The pages as previously published on the repository's main
branch printed the old values:

- **Paper tables.** The stability run `stab-r4`: comments correct
  77% → 73% (`tab:stab-sol`, `tab:stab`). The Martian development table
  (`tab:martianraw`) and the posting-policy table: the default's `test30` F2
  38.8 → 38.7, round 4's issues per PR 10.6 → 10.5, and issues per PR as
  posted 9.0 → 8.9 and under the frozen posting policy 2.0 → 1.9 (179 and 39
  comments on 20 PRs, printed the way every other table prints a
  half-way value).
- **Paper prose.** The share of Martian's real goldens the three
  third-party harnesses find, 54--78% → 53--78%; the frozen build's cost
  against the third-party tools, 4 to 29 → 4 to 31 times; the pi-review
  panel's cost, 2.7 → 2.8 times one high reviewer; Codex at high effort,
  $0.05 → $0.06 more per PR; the frozen build against the default,
  20% → 21% less; the default's lead on T40, 18.2 → 18.3 points; PR-Agent's
  comments mapping to a defect, 77% → 76%; AACR-Bench's "human" references,
  362 → 361; their AI-written share, 74% → 75%; the key's reviewer comments,
  2,216 → 2,221, and its excluded candidates, 691 → 692; the Opus-shifted
  Martian projection, 43.5 → 43.6; the seven smaller sub-lenses' cost share,
  2.8% → 2.7%; defects raised by six or more lenses, 127 → 126, and by five,
  53 → 54. Ratios and differences of costs use the unrounded costs, so a few
  read one unit off a ratio of the rounded figures printed beside them.
- **README.** QuickReview on Opus 5.5 in the Elo pool costs $4.61 per PR on
  average (was "about $4"); the open-model rows' lost lens and validator
  passes are given per kind (was "missing a lens pass on 7").
- **`docs/DIGITALOCEAN.md`.** The GPT-6.1 Sol row of the speed table,
  16 min, 37k output tokens, 78 replies, $2.27 (was 8, 21k, 71, $2.30); the
  DeepSeek row, 42 min, 230 replies, 13 s, $0.69 (was 41, 223, 14 s, about
  $0.57); 2.5–3× the steps and 7–9× the output (was about 3× and 12–15×);
  about 16 minutes a PR for GPT-6.1 Sol (was about 8); GLM's slowest AACR
  reviews 55–72 minutes (was 54–66); the GLM smoke's median 26.5 minutes
  (was "about 28", the mean) and its total $3.32 (was $3.31, a sum of
  per-set cents); the Qwen3.8-Max projection, about $6.29 a PR and ~$2,100 a
  full run at GLM's full-run token profile (was $3.09 and ~$1,030, a smoke's
  profile); the count of timed-out PRs in the first full attempt is dropped
  (no run file records it).
- **`docs/THREATS-TO-VALIDITY.md` and `METRICS.md`.** 361 "human" references
  (was 362).
- **Checked against the data in the final pass.** The halves bootstrap
  interval, −6.3 to +8.9 → −6.3 to +9.1 (benchmark paper, THREATS); the Opus
  judge's API calls per judgement, about 1.7 → 2.0 (benchmark paper, THREATS,
  METHODOLOGY); the code-quality lenses in the technical report's tuning log,
  about 3 more defects found → 2, AACR maintainability matches 1 → 4 of 30 →
  1 → 2 of 30, +29% → +28% cost; the re-judge's distance below Martian's
  published scores, 1.5–6.3 → 0.9–6.3 F1 points; the Martian posting-policy
  sweep, "F2 between 42 and 44 at best" → "42.0 as posted to 46.2 at best";
  smoke10's backup PRs in `bench/aacr/README.md`, 17 → 16. Loose ranges
  ("about 1–2 defects per 10 PRs", "about 10–15 lens passes", "about 10× the
  tokens", "$2–3 of review") now print the measured figure.
- **Removed, because no published file holds them.** The stopped blind
  hunt's 32 drafts; the line-gate sweep's run-time judge-call counts (3,227
  and 10,983), its 2 failed calls and its ~$18 cost; the GPT judge's 2
  retried error files; the critics' correction counts (6, 4 and 12; 16
  added, 1 removed: the critics fixed the key in place); T40's v2 check of
  the judge's new-defect candidates (44 / 12 / 1 / 2 / 41); the hand checks
  of 20 parsed Claude Code reviews (45 / 44) and of 40 unmatched Qodo
  comments (12 / 19 / 9); the lens instructions' 32% shortening; 45 of 219
  flagged comments; Copilot's 6.9% and the 0.4-point precision line; the 46
  bot-reviewed PRs; PR-Agent pruning 4 of 40 diffs; and the timings and
  smoke-test figures in `bench/aacr/README.md`'s development notes.
- **Recomputed.** Run-to-run agreement on fresh10, 78–89% → 81–93%, now
  over two named pairs of published runs (`fresh10-on` with `lean`,
  `new-r1` with `new-r2`).
- **Relabelled.** The Martian severity table and the technical report's
  lost-credit figures are recomputed from two labelling passes that ship in
  `analysis/relabel/` (gpt-6.1-sol; see "How to verify"). The table's
  candidate-to-comment mapping is rebuilt (word overlap, a label where overlap
  cannot settle it), which moves a few candidates between tiers and changes the
  per-subset Martian scores. The lost-credit attribution now counts a nearby
  comment or dropped finding only when the label says it is about the defect:
  lens generation's share rises, weaker comments' falls, and fewer of the
  default's misses had a dropped finding stating them. Every changed cell and
  sentence prints what the labels give. The labels are one model's
  (gpt-6.1-sol, effort xhigh), not checked by hand; the lost-credit labeller
  was not told which findings were posted.

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
modified-work statement. Two parts stay under their own MIT licences, whose
copyright and permission notices travel with them in `LICENSES/`: Martian's
golden comments and published tool-level judgements (`martian_*`,
`LICENSES/MIT-martian.txt`, Copyright (c) 2025 Martian) and Qodo
PR-Review-Bench's issues (`qodo_*`, `LICENSES/MIT-qodo.txt`, the Qodo team).
Code quoted anywhere in the release stays under its own project's licence,
copyleft and source-available ones included (`prs.repo_license`,
`martian_prs.repo_license`, `qodo_prs.repo_license`). The vendor text the
run archive and the slim bundle copy verbatim (the Martian judge's
extractions of the re-judged vendors' comments and the blind annotation's
vendor candidates) belongs to its authors, the vendors' review bots that
posted it on public pull requests, and is not covered by this licence. The
run archive and the slim bundle carry the same licence files and their own
NOTICE; the archive's also carries the SWE-PRBench attribution.

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
