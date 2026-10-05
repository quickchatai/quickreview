#!/usr/bin/env bash
# Step 1 of the final comparison: the SELECTION runs (2026-09-30). Every candidate
# configuration of every third-party tool, on gpt-6-sol, on the 40-PR selection
# set (select40.txt), one run each; the pick per tool is the highest defect
# recall, ties to comments correct (charts.py pick_best). The benchmark paper
# (bench/aacr/paper/benchmark.pdf) says how the competitor configurations were chosen.
#
#   QCR_BENCH_RUNS_DIR=<runs dir> bench/aacr/final/run-selection.sh
#
# Image tags are the ones the published runs used; each was built with
# `bench/aacr/bench.sh build --arm <arm>` at the commit noted beside it (the
# run's run.json `qcr_commit`). The defect judge (gpt-6-sol, high) runs in
# QCR_BENCH_IMAGE; --eval 3 scores AACR's metric with 3 judge rounds.
# The published configurations (the first row of each tool) are the earlier
# 185-PR runs, cut to these 40 — no extra run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ARM="$HERE/../arm.sh"
: "${QCR_BENCH_RUNS_DIR:?set QCR_BENCH_RUNS_DIR}"
export QCR_BENCH_RUNS_DIR QCR_BENCH_IMAGE="${QCR_BENCH_IMAGE:-qcr-bench:tune}"   # judge image, build 9106a64
CASES="$(cat "$HERE/select40.txt")"
run() { # NAME ARM [--pr-text] [ENV=VALUE ...]
  local name=$1 arm=$2; shift 2; local pr=(); [[ "${1:-}" == --pr-text ]] && { pr=(--pr-text); shift; }
  env "$@" "$ARM" --prefix "$name" --arm "$arm" "${pr[@]}" --cases "$CASES" --eval 3 --parallel auto
}
# pi-review 0.18.0 on pi 0.87.1
run fair-pireview-high   pireview            QCR_BENCH_PIREVIEW_IMAGE=qcr-bench-pireview:six  QCR_BENCH_PIREVIEW_THINKING=high       # build 3bd89b3
run fair-pireview-prtext pireview --pr-text  QCR_BENCH_PIREVIEW_IMAGE=qcr-bench-pireview:fair QCR_BENCH_PIREVIEW_THINKING=high       # build 717f3db
run fair-pireview-panel  pireview            QCR_BENCH_PIREVIEW_IMAGE=qcr-bench-pireview:fair QCR_BENCH_PIREVIEW_THINKING=high QCR_BENCH_PIREVIEW_PANEL=code-experts
# Codex CLI 0.158.0
run fair-codex-high      codex               QCR_BENCH_CODEX_IMAGE=qcr-bench-codex:six QCR_BENCH_CODEX_EFFORT=high                 # build 641f373
run fair-codex-prtext    codex --pr-text     QCR_BENCH_CODEX_IMAGE=qcr-bench-codex:fair                                            # build 717f3db
# open-code-review 1.3.1 (effort is set at the loopback bridge)
run fair-ocr-high        ocr                 QCR_BENCH_OCR_IMAGE=qcr-bench-ocr:all QCR_BENCH_OCR_EFFORT=high                       # build 1ad710b
run fair-ocr-prtext      ocr --pr-text       QCR_BENCH_OCR_IMAGE=qcr-bench-ocr:fair                                                # build 717f3db
# OpenCode 1.18.33 on its own ChatGPT provider
run fair-opencode-native opencode            QCR_BENCH_OPENCODE_IMAGE=qcr-bench-opencode:native QCR_BENCH_OPENCODE_PROVIDER=native # build 717f3db
run fair-opencode-prtext opencode --pr-text  QCR_BENCH_OPENCODE_IMAGE=qcr-bench-opencode:native QCR_BENCH_OPENCODE_PROVIDER=native
# PR-Agent 0.46.0 (shipped defaults; reads the PR title and body as on GitHub); judge image build 4c2ccb5
run fair-pragent-sol     pragent             QCR_BENCH_IMAGE=qcr-bench:judge2 QCR_BENCH_PRAGENT_MODEL=gpt-6-sol                    # build c2ecafd
run fair-pragent-g61     pragent             QCR_BENCH_IMAGE=qcr-bench:judge2                                                      # default model gpt-6.1-sol
