#!/usr/bin/env bash
# commit-verdict.sh — publish this round's verdict file (or a recheck's
# outcome file) ATOMICALLY (H1a, #5885).
#
# The session writes the COMPLETE JSON to verdict/<name>.tmp with its write
# tool, then runs this. It checks the staged bytes are one whole JSON object
# and renames them onto verdict/<name>. rename(2) inside one directory is
# atomic, so the daemon's watcher sees either no file or the whole file —
# never the empty or half-written one an in-place write shows it between its
# open and its bytes (the watcher once misread a valid APPROVE that way and
# held the PR for ten hours).
#
# It touches nothing but verdict/<name>.tmp and verdict/<name>: it reads no
# config, no credential and no GitHub, and posts nothing. On a refusal the
# staged file stays where it is — fix it and run this again.
#
# Usage: commit-verdict.sh <pr-N-round-K.json | pr-N-recheck-<head12>.json>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/verdict"

die() { echo "commit-verdict: $*" >&2; exit 1; }

NAME="${1:-}"
# The two names the daemon's watchers consume (VERDICT_FILE_RE in
# src/verdicts.ts, RECHECK_FILE_RE in src/recheck.ts) and nothing else: no
# path, no traversal, no other file in verdict/.
[[ "$NAME" =~ ^pr-[0-9]+-(round-[0-9]+|recheck-[0-9a-fA-F]{7,40})\.json$ ]] ||
  die "usage: commit-verdict.sh <pr-N-round-K.json | pr-N-recheck-<head12>.json>"
[[ $# -eq 1 ]] || die "usage: commit-verdict.sh <pr-N-round-K.json | pr-N-recheck-<head12>.json>"

STAGED="$DIR/$NAME.tmp"
[[ -d "$DIR" && ! -L "$DIR" ]] || die "verdict/ is missing or not a plain directory"
[[ ! -L "$STAGED" ]] || die "verdict/$NAME.tmp is a symlink — write the JSON there as a plain file"
[[ -f "$STAGED" ]] || die "nothing staged at verdict/$NAME.tmp — write the complete JSON there first, then run this"
[[ ! -d "$DIR/$NAME" ]] || die "verdict/$NAME is a directory — nothing was published"

# One complete JSON object, or nothing is published. python3 is what the
# posting scripts already run on; no third-party module. The check is the
# daemon's parser's, not Python's: `json.load` alone accepts NaN, Infinity and
# -Infinity, which JSON.parse refuses — a file this published would then be
# malformed to the watcher, so those constants are refused here too.
python3 - "$STAGED" <<'PY' || die "verdict/$NAME.tmp is not one complete JSON object — fix it and run this again (nothing was published)"
import json, sys

def refuse(token):
    raise ValueError(f"{token} is not JSON")

try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        value = json.load(fh, parse_constant=refuse)
except (OSError, ValueError) as err:
    print(f"commit-verdict: {err}", file=sys.stderr)
    raise SystemExit(1)
raise SystemExit(0 if isinstance(value, dict) else 1)
PY

# -T: never move INTO a directory of that name; -f: replace an older file.
mv -f -T -- "$STAGED" "$DIR/$NAME"
echo "commit-verdict: published verdict/$NAME"
