#!/usr/bin/env bash
# Step 3: the tables and charts of the final comparison, from the archived judge
# and harness files — no model calls. FULL-BENCHMARK.md, "Exact commands".
#
#   QCR_BENCH_RUNS_DIR=<runs dir> bench/aacr/final/score.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AACR="$HERE/.."
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR}"
export QCR_BENCH_RUNS_DIR
mapfile -t FINAL < "$HERE/arms.txt"
mapfile -t SOL < "$HERE/arms-gpt6sol.txt"
# Table 1 + Table 2 (+ the bot-reference-free AACR table), 185 PRs
uv run "$AACR/compare.py" --cases all30+fresh10+rest145 --exclude-refs "$AACR/bot_references.json" "${FINAL[@]}"
# the same arms on the 40-PR selection set and on the other 145 (the selection advantage)
uv run "$AACR/compare.py" --cases "$(cat "$HERE/select40.txt")" "${FINAL[@]}"
uv run "$AACR/compare.py" --cases "$(cat "$HERE/other145.txt")" "${FINAL[@]}"
# the charts: final arms under the primary names, the gpt-6-sol study under -gpt6sol
uv run "$AACR/charts.py" --cases all30+fresh10+rest145 \
  --note "best-shot configurations, one run each · all on gpt-6.1-sol except Claude Code (Opus 5.5)" "${FINAL[@]}"
uv run "$AACR/charts.py" --cases all30+fresh10+rest145 --suffix=-gpt6sol \
  --note "earlier study: tools as shipped or as the AACR harness runs them · gpt-6-sol except Claude Code (Opus 5.5)" "${SOL[@]}"
# judge-agreement.jpg stays the gpt-6-sol study's: the second (Opus) judge did not grade the gpt-6.1 arms.
# To redraw it: charts.py --out <scratch dir> --cases all30+fresh10+rest145 --second-judge claude-opus-5-5 "${SOL[@]}",
# then copy only <scratch dir>/judge-agreement.jpg into charts/.
