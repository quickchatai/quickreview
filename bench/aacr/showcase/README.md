# Showcase graphics

Static, eye-catching graphics of QuickReview's benchmark results against open-source tools and
closed-source products, made from code: change the data, re-run, every chart, number, rank and
title claim updates. Prototypes for a landing page, a launch post or slides; the paper's own
figures stay in `../charts/`.

```sh
# 1. rebuild the generated data from the archived runs (AACR judge files, Qodo scores)
QCR_BENCH_RUNS_DIR=<runs dir> uv run bench/aacr/showcase/refresh.py
# 2. draw every figure, light + dark PNG (1920 px wide) and a light SVG, plus out/NUMBERS.md
uv run bench/aacr/showcase/make_charts.py            # or name figures: ... make_charts.py headline scorecard
```

`refresh.py` prints a one-screen check against the paper (QuickReview 461/520, high 87.5/90,
$2.06/PR — it matches `paper/quickreview.tex` Table `tab:frozen` and every third-party row of
`tab:final` exactly).

## What is where

| File | Role |
|---|---|
| `aacr-arms.txt` | which runs make each AACR reviewer (frozen build `final1-*`, the six third-party arms of `final/arms.txt`). One line per reviewer. |
| `qodo-sources.txt` | which `scores.json` row is each Qodo tool. |
| `data/aacr.json` | GENERATED. Per-defect credit for every reviewer (520 defects × 8), with severity, kind and PR size; comment grades, $/PR, minutes. Charts compute every split from it. |
| `data/qodo.json` | GENERATED. Each tool's Qodo scores under all three location rules. |
| `data/martian.json` | hand-kept, each row citing its source: real-golden counts per tool and judge. |
| `data/tools.json` | display names and the **kind** (`quickreview` / `closed` / `open`) that sets each tool's colour. Re-classing a tool is a one-word edit. |
| `data/manual.json` | hand-kept costs and intervals the runs do not hold in one place. |
| `theme.py` | the look: tokens for both themes, pixel layout, rounded bars, export. |
| `make_charts.py` | one function per figure; titles are computed (ranks, "more than", "every kind"). |
| `out/` | the rendered figures and `NUMBERS.md`, the table view of every chart. |

Colour does one job: **QuickReview is blue; every other tool is grey** — darker for closed-source
products, lighter for open-source tools, always with a legend. The blue/grey pair passes the dataviz
palette validator in both themes; grey never competes with the accent.

## The figures and the selling point of each

**Headline candidates** — pick one as the hero image.

1. **`headline`** — *"97% of high-severity bugs caught."* A hero number with the field behind it
   (high-severity recall of all seven reviewers) and three proof points from the other benchmarks:
   89% of all 520 defects, #1 in functional-bug recall among 13 reviewers on Qodo, 87% of Martian's
   real bugs (more than any of 17 other reviewers). Cost and time are in the small print. **My pick
   for the headline:** one number, instantly readable, every competitor visible, three independent
   benchmarks behind it.
   ![headline](out/headline.png)
2. **`headline-missed`** — *"QuickReview let 13 serious bugs through. The next best let 36."* A unit
   chart: one square per high- or medium-severity defect a reviewer missed. The same result as (1),
   framed as risk instead of recall; the visual gap (13 squares against 36–110) is the strongest
   on the page.
   ![headline-missed](out/headline-missed.png)

**Supporting graphics**

3. **`one-vs-six`** — *"One QuickReview finds more than six other reviewers combined."* Pool every
   defect any of the six third-party reviewers found: 446. QuickReview alone: 461, and 47 defects
   none of the six found. (On high + medium severity alone it is a tie, 222 each — in the footer.)
   ![one-vs-six](out/one-vs-six.png)
4. **`head-to-head`** — *"The gap runs one way."* Against each tool: what QuickReview found that
   the other missed (123–273) against the reverse (3–25).
   ![head-to-head](out/head-to-head.png)
5. **`clean-catch`** — *"Every serious bug caught on 89% of pull requests."* Not a benchmark metric:
   of the 122 PRs carrying a high- or medium-severity defect, on how many did the reviewer flag
   every one of them (QuickReview 109; others 52–90). This is the property a team actually feels.
   ![clean-catch](out/clean-catch.png)
6. **`qodo-functional`** — *"The most functional bugs found among 13 code reviewers."* The
   closed-source comparison: Qodo, Augment, Copilot, Cursor Bugbot, Greptile, OpenAI's Codex
   reviewer, CodeRabbit and Sentry, all graded by one judge.
   ![qodo-functional](out/qodo-functional.png)
7. **`martian-real-bugs`** — *"87% of Martian's real bugs, more than any other reviewer."* 18
   reviewers, 14 of them commercial. Where a tool has both, our judge and Martian's published judge
   are drawn as a dumbbell: the published judge is the more generous one, so QuickReview beating
   every published number is a conservative claim.
   ![martian-real-bugs](out/martian-real-bugs.png)
8. **`same-model`** — *"Same model, better reviewer."* Six tools that all ran on gpt-6.1-sol,
   across three benchmarks: 89/87/45% against at most 67/78/29%. The design is the moat, not
   the model. "Not run" cells are drawn as gaps.
   ![same-model](out/same-model.png)
9. **`by-kind`** — *"Ahead on every kind of defect."* Eight kinds of defect, QuickReview's lead
   over the next best from +5 (compatibility) to +35 points (maintainability).
   ![by-kind](out/by-kind.png)
10. **`by-size`** — *"No drop-off on big pull requests."* 87 / 87 / 90% from small to large PRs.
    The title switches to "the bigger the PR, the bigger the lead" only if the lead grows by
    5 points or more; today it grows by 3 (+20 → +23), so it does not claim that.
    ![by-size](out/by-size.png)
11. **`scorecard`** — *"First in recall on 4 of 5 measures across three benchmarks."* Every
    reviewer we have a number for, every benchmark, gaps drawn as dashes: the honest overview, and
    a map of the data gaps below.
    ![scorecard](out/scorecard.png)

Dark-theme versions sit beside each as `<name>-dark.png`.

## Flagged: ideas that need data we do not have

- **Commercial reviewers on AACR-Bench (the biggest gap).** Our strongest benchmark (520 verified
  defects, the 97% headline) has only one closed-source reviewer, Claude Code. CodeRabbit, Copilot,
  Greptile, Cursor Bugbot, Qodo and Augment were never run on it — that would make the headline
  directly "vs the companies". They are SaaS products, so it needs their apps installed on forks of
  the 185 PRs (accounts and, likely, paid plans).
- **Claude Code, Codex CLI and pi-review on Martian and Qodo.** They ran on AACR only, so
  `same-model` and `scorecard` show "not run" for them there.
- **Martian under one judge.** Only three vendors (Qodo extended, cubic, Claude Code) are graded by
  our judge; the other eleven use Martian's published Opus 4.5 grading. The re-judge of all
  published tools on the 50 PRs (`ext-calibration-martian50-g1…g11`) was started and stopped,
  never scored. Finishing it makes `martian-real-bugs` single-judge.
- **SWE-PRBench.** The eval100 run stopped at 77/100 reviews and was never scored, and its
  published table is bare models rather than review tools — no chart until both exist.
- **Real-world proof, not benchmark.** "N% of QuickReview's blocking findings in production were
  fixed by the author" — the live daemon already records this per finding (`finding_outcomes`,
  `qcr outcomes`), but the data is on the VM and was not pulled.
- **Speed against people.** QuickReview's 17.5 median minutes against how long a human review takes
  on the same repos needs human review-latency data (GitHub PR timelines); not collected.
- **Cost against the cost of an escaped bug.** QuickReview is 4–29× the third-party tools per PR, so
  cost is only a selling point against engineer time or an escaped-defect cost, which needs a
  sourced external figure.
- **QuickReview on an open model.** The GLM-5.3 Flash smoke (10 PRs, about $0.32/PR) passed; the
  full run waits for approval. That would allow a "same quality on open models" chart.
- **Classifications to verify.** `pi-review` and `open-code-review` are marked open source in
  `data/tools.json` with `verify: true`; check their licences before publishing.

## What these charts deliberately leave out

They lead with recall, as the papers do. Not shown, and worth knowing before a chart is published:
QuickReview costs $2.06 per PR (4–29× the third-party tools) and takes a median 17.5 minutes; it
posts the most comments (6.9 per PR, 42% of them true but minor); it has the lowest precision on
both Martian and Qodo, the lowest F1 on Martian and the fourth-highest on Qodo; and on Qodo's
all-issue recall it is second to Qodo's own product (45.3% against 46.4%). Each benchmark is one run per reviewer, and the vendor rows on Qodo and
Martian are the vendors' January 2026 runs. Qodo built the Qodo benchmark.
