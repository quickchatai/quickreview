#!/usr/bin/env bash
# Compile the two papers to PDF in a TeX Live container (no local TeX needed;
# no network inside the container):
#   benchmark.tex   — the benchmark paper (the verified defect key, the judge,
#                     the best-shot protocol, eight reviewers)
#   quickreview.tex — the QuickReview technical report (its companion)
# Usage: bench/aacr/paper/build.sh [benchmark|quickreview]   (default: both)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for name in "${@:-benchmark quickreview}"; do for n in $name; do
  W="$(mktemp -d)"
  mkdir -p "$W/paper"; cp -r "$HERE/../charts" "$W/"; cp "$HERE/$n.tex" "$W/paper/"
  docker run --rm --network none -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$W:/w" -w /w/paper \
    texlive/texlive:latest-small \
    sh -c "for i in 1 2 3; do pdflatex -interaction=nonstopmode -halt-on-error $n.tex >/w/log.txt 2>&1 || { grep -A5 '^!' /w/log.txt; exit 1; }; done"
  cp "$W/paper/$n.pdf" "$HERE/$n.pdf"
  echo "$n.pdf: undefined references: $(grep -c undefined "$W/paper/$n.log" || true)"
  rm -rf "$W"
done; done
