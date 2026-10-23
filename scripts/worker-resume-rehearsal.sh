#!/usr/bin/env bash
# worker-resume-rehearsal.sh — the offline resume rehearsal, the run that
# writes docs/worker-resume-rehearsal.md.
#
#   scripts/worker-resume-rehearsal.sh [--out FILE] <label>=<dir> [<label>=<dir> ...]
#
# Each <dir> is searched for *.jsonl (read-only: every file is COPIED into a
# scratch world and the copy is resumed). The labels the report knows:
#
#   live      a read-only snapshot of the VM's state/pi-sessions
#   mirror    the transcript mirror pulled from the daemon
#   archive   the transcripts/ of a `qcr archive extract <pr> --to <dir>`
#
# What it does: runs the canary-10 files (the interactive build's request against
# the SDK build's, over loopback), then resumes every JSONL with the real bot
# worker on pi-ai's faux provider, and writes the report. No model, no network:
# the offline guard fails the run on any connection attempt.
#
# The JSONLs are the live bot's private transcripts. Never commit them or copy
# them into the repo; name them here by path only.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
OUT="$ROOT/docs/worker-resume-rehearsal.md"
SOURCES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *=*) SOURCES+=("$1"); shift ;;
    *) echo "usage: $0 [--out FILE] <label>=<dir> ..." >&2; exit 2 ;;
  esac
done
[[ ${#SOURCES[@]} -gt 0 ]] || { echo "usage: $0 [--out FILE] <label>=<dir> ..." >&2; exit 2; }

what() {
  case "$1" in
    live) echo "A read-only snapshot of a running daemon's \`state/pi-sessions\` (every PR JSONL modified in the last seven days): the files the cutover resumes." ;;
    mirror) echo "A transcript mirror pulled from the daemon: older interactive-pi JSONLs, from PRs that have since closed (the archiver's transcripts are these same bytes)." ;;
    archive) echo "Transcripts extracted by \`qcr archive extract\` from the closed-PR archive." ;;
    *) echo "JSONL files from the \`$1\` source." ;;
  esac
}

json="["
sep=""
for s in "${SOURCES[@]}"; do
  label="${s%%=*}"
  dir="${s#*=}"
  [[ -d "$dir" ]] || { echo "not a directory: $dir" >&2; exit 2; }
  json+="$sep$(node -e 'process.stdout.write(JSON.stringify({label: process.argv[1], what: process.argv[2], dir: process.argv[3]}))' "$label" "$(what "$label")" "$(readlink -f "$dir")")"
  sep=","
done
json+="]"

cd "$ROOT"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# Canary 10: bare, one-shot and bot shape. Their pass/fail goes in the report;
# a red canary stops the run.
timeout 900 npx vitest run tests/pi-canary/canary-10-bare-request.test.ts \
  tests/pi-canary/canary-10-oneshot-request.test.ts tests/pi-canary/canary-10-bot-request.test.ts \
  --reporter=json --outputFile="$scratch/canary.json" >"$scratch/canary.log" 2>&1 \
  || { tail -30 "$scratch/canary.log" >&2; echo "canary 10 is red; the rehearsal does not run" >&2; exit 1; }

QCR_RESUME_REHEARSAL="$json" \
QCR_RESUME_REHEARSAL_OUT="$OUT" \
QCR_RESUME_REHEARSAL_CANARY_JSON="$scratch/canary.json" \
QCR_RESUME_REHEARSAL_COMMIT="$(git rev-parse --short HEAD)" \
  npx vitest run tests/worker-resume-rehearsal.test.ts
echo "wrote $OUT"
