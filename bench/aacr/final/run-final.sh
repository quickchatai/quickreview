#!/usr/bin/env bash
# Step 2 of the final comparison (2026-09-29 .. 2026-10-01): every pick from
# run-selection.sh, unchanged, re-run on gpt-6.1-sol on all 185 PRs — first on
# the 40-PR selection set (prefix g61-fair-*), then on the other 145
# (other145.txt, prefix g61-145-*). QuickReview's default on gpt-6.1-sol is the
# earlier g61-* run; its low preset was run like the tools. Claude Code was not
# re-run: its row is the published all-claude-* run (Opus 5.5).
# FULL-BENCHMARK.md, "Exact commands".
#
#   QCR_BENCH_RUNS_DIR=<runs dir> bench/aacr/final/run-final.sh [quickreview|tools|claude]
#
# Images (bench.sh build --arm <arm> at the build commit noted; the run.json of
# each run records what ran):
#   qcr-bench:pi099            QuickReview, build b2ce03a, pi 0.99.1 (QCR_BENCH_PI_VERSION=0.99.1)
#   qcr-bench-pireview:g61     pi-review 0.18.0 on pi 0.99.1, pi's built-in extensions off, build 5e7d019
#   qcr-bench-opencode:g61b    OpenCode 1.18.33, gpt-6.1-sol as a custom model of its native provider, build b1a6f26
#   qcr-bench-codex:g61        Codex CLI 0.159.2, build 8bc514c:
#                                QCR_BENCH_CODEX_VERSION=0.159.2 \
#                                QCR_BENCH_CODEX_SHA256=1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e \
#                                bench.sh build --arm codex
#   qcr-bench-ocr:g61          open-code-review 1.3.1 through the loopback bridge, build 5e7d019
#   qcr-bench-pragent:latest   PR-Agent 0.46.0, build c2ecafd
#   judge images: qcr-bench:tune (9106a64) for the four tools, qcr-bench:judge2 (4c2ccb5)
#   for PR-Agent, qcr-bench:pi099 for QuickReview — the same defect judge, gpt-6-sol high.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ARM="$HERE/../arm.sh"
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR}"
export QCR_BENCH_RUNS_DIR
F40="$(cat "$HERE/select40.txt")"
O145="$(cat "$HERE/other145.txt")"
M=openai-codex/gpt-6.1-sol
DEFAULT="models.default=$M,models.conversation=$M,models.overseer=$M,models.tiers.terra-med=$M:medium,models.tiers.sol-med=$M:medium,models.tiers.sol-high=$M:high"
LOW="review.preset=low,models.default=$M:low,models.conversation=$M:low,models.overseer=$M:low,models.tiers.terra-med=$M:low,models.tiers.sol-med=$M:low,models.tiers.sol-high=$M:low"
what="${1:-all}"

if [[ "$what" == all || "$what" == quickreview ]]; then
  # QuickReview default (2026-09-29): every role on gpt-6.1-sol, each keeping its level.
  QCR_BENCH_IMAGE=qcr-bench:pi099 "$ARM" --prefix g61-smoke --config "$DEFAULT" --cases smoke10 --parallel auto --eval 3
  QCR_BENCH_IMAGE=qcr-bench:pi099 "$ARM" --prefix g61 --config "$DEFAULT" --cases dev10+holdout10+fresh10+rest145 --parallel auto --eval 3
  # QuickReview low (2026-09-30): the low preset, every role on gpt-6.1-sol:low.
  QCR_BENCH_IMAGE=qcr-bench:pi099 "$ARM" --prefix g61low-fair --config "$LOW" --cases "$F40" --parallel auto --eval 3 --fresh
  QCR_BENCH_IMAGE=qcr-bench:pi099 "$ARM" --prefix g61low-145 --config "$LOW" --cases "$O145" --parallel auto --eval 3 --fresh
fi

if [[ "$what" == all || "$what" == tools ]]; then
  tool() { # ARM PREFIX-STEM [--pr-text] ENV=VALUE ... — the 40, then the other 145
    local arm=$1 stem=$2; shift 2; local pr=(); [[ "${1:-}" == --pr-text ]] && { pr=(--pr-text); shift; }
    env QCR_BENCH_IMAGE=qcr-bench:tune "$@" "$ARM" --prefix "g61-fair-$stem" --arm "$arm" "${pr[@]}" --cases "$F40"  --eval 3 --parallel auto --fresh
    env QCR_BENCH_IMAGE=qcr-bench:tune "$@" "$ARM" --prefix "g61-145-$stem"  --arm "$arm" "${pr[@]}" --cases "$O145" --eval 3 --parallel auto --fresh
  }
  tool pireview pireview-panel QCR_BENCH_PIREVIEW_IMAGE=qcr-bench-pireview:g61 QCR_BENCH_PIREVIEW_PANEL=code-experts QCR_BENCH_PIREVIEW_THINKING=high QCR_BENCH_PIREVIEW_MODEL=gpt-6.1-sol
  tool ocr      ocr-high       QCR_BENCH_OCR_IMAGE=qcr-bench-ocr:g61 QCR_BENCH_OCR_EFFORT=high QCR_BENCH_OCR_MODEL=gpt-6.1-sol
  tool opencode opencode-native-pr --pr-text QCR_BENCH_OPENCODE_IMAGE=qcr-bench-opencode:g61b QCR_BENCH_OPENCODE_PROVIDER=native QCR_BENCH_OPENCODE_MODEL=gpt-6.1-sol
  tool codex    codex-high     QCR_BENCH_CODEX_IMAGE=qcr-bench-codex:g61 QCR_BENCH_CODEX_EFFORT=high QCR_BENCH_CODEX_MODEL=gpt-6.1-sol
  # PR-Agent: its gpt-6.1-sol pick already ran on the 40 in the selection step (fair-pragent-g61).
  QCR_BENCH_IMAGE=qcr-bench:judge2 "$ARM" --prefix g61-pragent-145 --arm pragent --cases "$O145" --parallel auto --eval 3 --fresh
fi

if [[ "$what" == claude ]]; then
  # Claude Code (published 2026-09-28; root CLAUDE.md rule 5's exception — inside its sandbox only).
  # Its rest145 ran in four chunks (all-claude-c1..c4-rest145); the 40 original PRs as all-claude-<set>.
  QCR_BENCH_CLAUDE_MODEL=claude-opus-5-5 \
    "$ARM" --prefix all-claude --arm claude --cases rest145+all30+fresh10 --no-judge
  echo "then, per run: bench/aacr/bench.sh claude-rebuild --arm claude --run <run> --set <set>  (prose → comments, judge, eval)"
fi
