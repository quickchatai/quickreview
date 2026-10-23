---
license: apache-2.0
language:
- en
pretty_name: Real defects in code review (AACR-derived key, reviews and verdicts)
size_categories:
- 10K<n<100K
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

A verified defect key for 185 pull requests of AACR-Bench v1.0, every review
that eight reviewers (and several earlier and variant configurations) wrote
on them, and every judge verdict that scored those reviews. Beside it, the
reviews and verdicts behind the two external benchmarks the papers report:
Martian's offline code-review benchmark and Qodo's PR-Review-Bench.

This is the data behind two papers:

- *Measuring whether a code review finds the real defects: a verified defect
  benchmark on AACR-Bench, applied to eight reviewers at their best-shot
  configurations* (the benchmark paper).
- *QuickReview: a multi-pass automated code reviewer* (the technical report).

Every number in their tables can be recomputed from these files with no model
call (see "Validation" below). The raw runs (transcripts, logs, the harness
files) are in a separate archive: {{ARCHIVE}}.

## Read this first

- **No human has checked the key or the judge yet.** The 520 defects and the
  3,093 exclusions were verified against the code by LLM agents, and every
  review was graded by an LLM judge. A human audit of a sample is planned and
  will be published with its agreement numbers; until then, treat the key as
  an LLM-built answer key with the error rate that implies.
- **The key was partly built from QuickReview's own earlier output.** Among
  the candidates checked for each PR were the comments that reviewers posted
  in our runs, QuickReview's included (anonymised, and every candidate was
  checked against the code). A reviewer whose earlier comments seeded the key
  can be favoured by it. `defects.provenance_*` records where each defect
  came from: 369 of the 520 were raised by the blind hunt or an AACR
  reference, and the papers report recall on those separately.
- **The authors build one of the reviewers (QuickReview), and it was tuned on
  these benchmarks.** The tuning sets are named per PR (`prs.set`,
  `prs.in_s40`, `martian_goldens.audit_split`) and the papers report the
  held-out results beside the tuned ones.
- **AACR-Bench's reference labels are agent-produced**, not human labels
  (`aacr_references.is_ai_comment`, `source_model`), and at least 80 of the
  references marked human are rewritten review-bot comments
  (`aacr_references.bot_derived`).
- Each reviewer ran once and each review was judged once, except where a
  config says otherwise (the stability runs, the second judge, the judge
  re-run).

## Configs

One split, `test`, in every config. Which PR set a row belongs to is the `set`
column (AACR: `smoke10`, `dev10`, `holdout10`, `fresh10`, `rest145`); the
papers' 40-PR selection set S40 is `prs.in_s40`.

```python
from datasets import load_dataset
defects = load_dataset("{{REPO_ID}}", "defects", split="test")
verdicts = load_dataset("{{REPO_ID}}", "defect_verdicts", split="test")
```

| Config | Rows |
|---|---|
{{CONFIG_ROWS}}

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
  directories it is scored from, the study and the paper tables it feeds.
  The final comparison is the eight `*-g61` arms plus `claude-code-opus55`;
  the frozen build is `quickreview-frozen`; the earlier gpt-6-sol study is the
  `*-sol` arms; `*-s40` arms are the best-shot selection runs on S40.
- `reviews` — one row per arm and PR: the review body, its comments exactly
  as the judge numbered them (`C1`, `C2`, …), list-price cost and wall-clock
  minutes, and the number of comments AACR-Bench's harness scored.
- `defect_verdicts` — per arm, PR, defect and judge: found, partial or
  missed (`credit` 1, 0.5, 0), the comments that found it, and the judge's
  reason. Judges: `gpt-6-sol-high` (primary), `claude-opus-5-5` (second
  judge, earlier study only) and `gpt-6-sol-high-repeat` (the primary judge
  re-run on 30 PRs, for self-consistency).
- `comment_verdicts` — per arm, PR, comment and judge: correct-valuable,
  correct-minor, partly-correct or incorrect, the defect it maps to, and
  whether the judge flagged a possible new defect.
- `aacr_matches` — AACR-Bench's own metric: per arm, PR and reference, the
  share of the harness's three judge rounds that matched it.

A defect with no row for an arm and PR counts as missed; every arm of the
final comparison has a judged review for all 185 PRs.

**Martian offline benchmark (50 PRs)**

- `martian_prs`, `martian_goldens` — the 173 golden comments (MIT), with our
  adversarial audit's bucket for each (86 real, 77 not real, 10 disputed) and
  its evidence.
- `martian_reviews`, `martian_verdicts`, `martian_scores` — the frozen build
  and three third-party harnesses (open-code-review, PR-Agent, OpenCode) run
  by us, and three published vendor reviews re-judged by our judge
  (`rejudged-*`), each golden matched or not; `martian_scores` also carries
  Martian's published judgements at tool level.

**Qodo PR-Review-Bench (100 PRs)**

- `qodo_prs`, `qodo_issues` — the 580 injected issues (MIT; 309 functional,
  271 rule violations).
- `qodo_reviews`, `qodo_verdicts` — the frozen build, an earlier build
  (2026-10-02), the same three harnesses, and Qodo's nine published vendor
  runs, each issue matched or not, with the location rule applied at ±5
  lines and at "same file".

**Other files.** `figures/` holds the papers' charts and their data,
`keys/` the answer key rendered as Markdown, `reports/` the full benchmark
report. `validation.json` holds the checks below.

## Third-party text and links

Copied, under their licences (see NOTICE): AACR-Bench's reference comments
(Apache-2.0), Martian's golden comments (MIT), Qodo's issues (MIT), and short
code quotes from the reviewed repositories, which stay under each project's
licence (`prs.repo_license`; four are source-available).

**Not copied:** comments written by third-party review bots. The Copilot 2025
reviews harvested from the original PRs (`copilot-2025-upstream`), the vendor
reviews Martian publishes (`martian_reviews` rows with `vendor_link_only`) and
the vendor reviews on Qodo's benchmark forks (`qodo_reviews` rows with
`vendor_link_only`) carry the URL of the original review and the comment
locations, never their text; their verdicts are ours and are included.
SWE-PRBench runs are in the run archive only, not here.

## Names rewritten

Before export, every string in every table passed through one rewrite, the
same one the run archive applies. Nothing else in the text was changed.

| What | Replaced with | Occurrences |
|---|---|---|
{{SCRUB_TABLE}}

`<owner>` is the operator the reviewer's production prompt addresses;
`<review-bot>` is its GitHub App persona; `quickreview` is the public name of
the product, whose old internal name appears in prompts and footers. The
host paths occur only in logs.

## Datasheet (summary)

- **Motivation.** AACR-Bench scores a review by how closely it reproduces the
  original PR's comments; on 145 PRs checked in full, only 12.8% of those
  comments belong to a real defect. This key asks instead whether a review
  found the real defects the PR introduces.
- **Composition.** 185 PRs from 50 open-source repositories in ten
  languages (every AACR-Bench v1.0 PR whose head GitHub still serves),
  520 defects, 3,093 rejected candidates, and the reviews and verdicts above.
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
  final comparison; one run per reviewer; 90 high-severity defects limit how
  small a difference can be resolved; reviewed-repo code is not included
  (`repo` and commits identify it).
- **Maintenance.** Changes to the key bump `key_version`; verdicts are stored
  per key version, so old and new truths never mix.

## Validation

`validation.json` recomputes, from these tables alone, the row counts (520
defects, 3,093 exclusions, 185 PRs per full arm, 1,418 references, 173
Martian goldens, 580 Qodo issues) and the papers' headline numbers (every
arm's defects found by severity, comments correct, cost and time; the second
judge; judge agreement; the AACR metric; Martian and Qodo scores). This
release passes {{CHECKS}} checks.

## Licence

Apache-2.0 (LICENSE), with NOTICE carrying AACR-Bench's attribution and the
modified-work statement, and the Martian and Qodo attributions.

## Citation

```bibtex
@misc{jakubczak2026realdefects,
  title  = {Measuring whether a code review finds the real defects: a verified defect benchmark on AACR-Bench, applied to eight reviewers at their best-shot configurations},
  author = {Mateusz Jakubczak},
  year   = {2026},
  note   = {Quickchat AI. arXiv id TBD}
}
@misc{jakubczak2026quickreview,
  title  = {QuickReview: a multi-pass automated code reviewer},
  author = {Mateusz Jakubczak},
  year   = {2026},
  note   = {Quickchat AI. arXiv id TBD}
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
