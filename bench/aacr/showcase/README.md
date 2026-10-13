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

## v2: one chart, as few words as possible

```sh
uv run bench/aacr/showcase/make_charts_v2.py     # into out/v2/ — v1 (make_charts.py, out/) is left untouched
```

Each v2 image is ONE chart: a short title that is the message, the marks, the names and values,
and a one-line benchmark tag. No subtitle, legend or footnote — the method and the caveats below
stay in this README. QuickReview is blue, every other tool one grey. v2 reuses v1's data layer
(`Bench` in `make_charts.py`), so both always show the same numbers; its own look is `theme_v2.py`.

Two choices v2 makes that the images do not spell out:
- **Martian** (`martian-real-bugs`, `every-benchmark`): each competitor is drawn at its BEST real-bug
  count, our judge's or Martian's own published grading, whichever is higher — the reading most
  generous to them; QuickReview at our judge's count only.
- **`every-benchmark`** plots one measure per benchmark: all verified defects (AACR-Bench), the
  audited real bugs (Martian), the functional bugs (Qodo).

| | |
|---|---|
| ![](out/v2/headline.png) | ![](out/v2/headline-missed.png) |
| ![](out/v2/one-vs-six.png) | ![](out/v2/head-to-head.png) |
| ![](out/v2/clean-catch.png) | ![](out/v2/every-benchmark.png) |
| ![](out/v2/qodo-functional.png) | ![](out/v2/martian-real-bugs.png) |
| ![](out/v2/same-model.png) | ![](out/v2/by-kind.png) |
| ![](out/v2/by-size.png) | |

## v3: area charts, the honest set, each benchmark's own score, ten new angles

```sh
QCR_BENCH_RUNS_DIR=<runs dir> uv run bench/aacr/showcase/refresh_v3.py   # data/v3.json
uv run bench/aacr/showcase/make_charts_v3.py                             # into out/v3/, plus out/v3/NUMBERS.md
```

v3 keeps v2's one-chart look and its data layer, and adds `data/v3.json`. That file holds each
reviewer's cost and minutes per PR, the fast option's credits, each benchmark scored by its own
metric, and the extra data the `idea-*` figures need. v1 and v2 are untouched.
`out/v3/NUMBERS.md` is the table behind every v3 image.

**Area charts (FIFA-style attribute shapes)**
- `radar-kinds`: *"Bigger in every direction."* QuickReview's share of six kinds of defect,
  drawn as one shape, with the six other reviewers' outlines inside it.
- `radar-cards`: *"Player cards."* One card per reviewer: the overall rating (% of the 520 defects
  found) and six attributes (one per kind of defect).
- `radar-tradeoffs`: *"Finds the most, but slow and costly."* The honest card. Speed, low cost
  and fewer comments are scored against the best of the seven, which counts as 100.

**The honest set: better, at a cost**
- `honest-cost`, `honest-time`: share of defects found against the average cost or minutes per
  PR. QuickReview is furthest right and highest. Its fast option (profile `fast`, preset `low`,
  every model at low effort, the frozen build's image; runs `fast1-*`) finds 72% at $0.77 and
  6.8 minutes, still above every other reviewer.
- `honest-cost-by-kind`, `honest-time-by-kind`: the same, one panel per kind of defect.
- `honest-comments`: *"More comments, and more of them minor."* Comments per PR by the judge's
  grade: useful, true but minor, wrong or partly wrong.

**Each benchmark, scored by its own rules**
- `official-aacr`, `official-martian`, `official-qodo`: precision against recall under each
  benchmark's OWN metric and reference list, not our verified-defect key, with curves of equal F1.
  QuickReview is top on AACR-Bench (recall and F1), top on recall but last on F1 on Martian, and
  2nd on recall and 4th on F1 on Qodo.
- `official-combined`: the three side by side.
- AACR-Bench's own scorer was never run on the frozen build or the fast option, so its chart uses
  the Oct 1 build (`b2ce03a`, the paper's design-study build) and says so. Martian's rows are the
  tools of `martian-sources.txt`, every one graded by the same gpt-6.1-sol judge. Qodo's are
  `data/qodo.json` under Qodo's rule (file + ±5 lines).

**Ten new angles (`idea-*`)**

Each one names the group it compares against. "The six" are the other AACR-Bench reviewers:
Claude Code, Codex CLI, open-code-review, OpenCode, pi-review panel and PR-Agent. Every number and
caveat behind an image is in `out/v3/NUMBERS.md`.
- `idea-rare-finds`: *"Finds 65% of what all six others missed."* The 520 defects are grouped by
  how many of the six found each one, and each column is QuickReview's share of its group. The hero
  column is the 72 defects none of the six found; 59 of those are low severity.
- `idea-best-of-six`: *"Vs each PR's best rival: 56 ahead, 16 behind."* One bubble per point:
  QuickReview's share of a PR's defects against the best of the six on that PR. 87 PRs tie (71 of
  them both at 100%). On high and medium defects alone it is 13 ahead, 9 behind and 100 tied.
- `idea-record`: *"A winning record against all six, PR by PR."* Against each reviewer, the PRs
  where QuickReview found more (80–120), the same (36–72) or fewer (1–11). This tells the same story
  as v2's `head-to-head`, so use one of the two.
- `idea-languages`: *"Most defects found in all 10 languages."* One tile per language: QuickReview
  against the best of the six in that language. Two tiles are thin: PHP's lead is half a defect, and
  C# has only 6 defects.
- `idea-commercial-misses`: *"Ahead of 12 of 14 on bugs most tools miss."* Martian's 30 PRs not used
  for tuning. Each row is one commercial tool: its recall on the audited real bugs that most of the
  other 13 missed, against QuickReview's on the same bugs. Copilot and cubic tie. The image says the
  judges differ: ours for QuickReview, Martian's for the tools.
- `idea-robust`: *"QuickReview leads on all 4 cuts, clearly on 3."* The lead over the best of the six,
  with 95% PR-bootstrap intervals, on four cuts:
  - the whole key;
  - the key without the defects that only reviewers' comments raised;
  - AACR's own references alone;
  - the 20 PRs left out of the final tuning, where the interval reaches zero.
- `idea-skip-nits`: *"Skip the nits, keep every serious find."* The serious defects QuickReview's review
  still finds depending on how much of it a reader reads:
  - blockers only: 75%, at 2.2 comments per PR;
  - blockers and questions: 94%, at 4.4;
  - everything: 94%, at 6.8.
  The six appear as points.
- `idea-funnel`: *"21 lens findings merge into 7 comments."* Per PR, on average:
  - 20.9 findings from the lenses;
  - 7.4 after merging duplicates;
  - 6.9 posted;
  - 6.4 judged correct, minor points included.
- `idea-price-per-bug` (honest): *"$4–14 of model spend per extra serious defect."* Against each of
  the six: what QuickReview's extra serious finds cost in model spend, and how many more comments
  come with them.
- `idea-uncredited` (honest): *"Uncredited comments: often minor, rarely wrong."* QuickReview's
  comments that no answer key credited, checked against the code:
  - Qodo: 30% are real defects the key lacks, and none of 40 are wrong.
  - Martian: 29% real, 3 of 139 wrong.
  These are earlier builds, on 10 Qodo and 20 Martian PRs.

| | |
|---|---|
| ![](out/v3/radar-kinds.png) | ![](out/v3/radar-cards.png) |
| ![](out/v3/radar-tradeoffs.png) | ![](out/v3/honest-comments.png) |
| ![](out/v3/honest-cost.png) | ![](out/v3/honest-time.png) |
| ![](out/v3/honest-cost-by-kind.png) | ![](out/v3/honest-time-by-kind.png) |
| ![](out/v3/official-aacr.png) | ![](out/v3/official-martian.png) |
| ![](out/v3/official-qodo.png) | ![](out/v3/official-combined.png) |
| ![](out/v3/idea-rare-finds.png) | ![](out/v3/idea-best-of-six.png) |
| ![](out/v3/idea-record.png) | ![](out/v3/idea-languages.png) |
| ![](out/v3/idea-commercial-misses.png) | ![](out/v3/idea-robust.png) |
| ![](out/v3/idea-skip-nits.png) | ![](out/v3/idea-funnel.png) |
| ![](out/v3/idea-price-per-bug.png) | ![](out/v3/idea-uncredited.png) |

The rest of this README describes v1 (the annotated versions in `out/`), the data and the gaps;
all of it applies to v2 and v3.

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
| `make_charts_v2.py`, `theme_v2.py` | v2: the same figures as one minimal chart each, into `out/v2/`. |
| `aacr-arms-v3.txt` | v3's extra AACR reviewer: the fast option's runs (`fast1-*`). |
| `martian-sources.txt` | which scored run and key is each tool in `official-martian` (Martian's own metric, one judge). |
| `refresh_v3.py` | builds `data/v3.json`: cost and minutes per PR for every AACR reviewer, the fast option's credits, each benchmark's own metric, and the `idea-*` figures' data. |
| `ideas_v3_data.py` | one builder per `idea-*` figure that needs more than `data/aacr.json`, called by `refresh_v3.py`. Standard library only, read-only over the runs. |
| `data/v3.json` | GENERATED by `refresh_v3.py`. |
| `make_charts_v3.py`, `ideas_v3.py` | v3: the `radar-*`, `honest-*`, `official-*` and `idea-*` figures, into `out/v3/` with `out/v3/NUMBERS.md`. |
| `MISSING-DATA.md` | the graphs we cannot draw yet: what each needs, what it takes, who must approve it, and the risks. |
| `out/` | the rendered figures and `NUMBERS.md`, the table view of every chart (v2 in `out/v2/`, v3 in `out/v3/`). |

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

`MISSING-DATA.md` lists the graphs we would like to draw but cannot yet, ranked by priority. For
each one it says what data is missing, what it takes, who must approve it, and the risks. The
largest gaps:
- no commercial product has been run on AACR-Bench;
- Claude Code, Codex CLI and pi-review have not run on Martian or Qodo;
- there is no production proof, human baseline or fresh held-out set yet.

## What these charts deliberately leave out

They lead with recall, as the papers do. Not shown, and worth knowing before a chart is published:
QuickReview costs $2.06 per PR (4–31× the third-party tools) and takes a median 17.5 minutes; it
posts the most comments (6.9 per PR, 42% of them true but minor); it has the lowest precision on
both Martian and Qodo, the lowest F1 on Martian and the fourth-highest on Qodo; and on Qodo's
all-issue recall it is second to Qodo's own product (45.3% against 46.4%). Each benchmark is one
run per reviewer, and the vendor rows are the vendors' own published runs (January 2026 on Qodo;
January to June 2026 on Martian). Qodo built the Qodo benchmark.
