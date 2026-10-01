#!/usr/bin/env bash
# Compile whitepaper.tex to whitepaper.pdf in a TeX Live container (no local
# TeX needed; no network inside the container). Usage: bench/aacr/paper/build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/paper"; cp -r "$HERE/../charts" "$W/"; cp "$HERE/whitepaper.tex" "$W/paper/"
docker run --rm --network none -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$W:/w" -w /w/paper \
  texlive/texlive:latest-small \
  sh -c 'for i in 1 2 3; do pdflatex -interaction=nonstopmode -halt-on-error whitepaper.tex >/w/log.txt 2>&1 || { grep -A5 "^!" /w/log.txt; exit 1; }; done'
cp "$W/paper/whitepaper.pdf" "$HERE/whitepaper.pdf"
echo "undefined references: $(grep -c undefined "$W/paper/whitepaper.log" || true)"
