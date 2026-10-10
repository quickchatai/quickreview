#!/usr/bin/env bash
# commit-verdict.sh — publish this round's verdict file (or a recheck's
# outcome file) atomically.
#
# The session writes the COMPLETE JSON to verdict/<name>.tmp with its write
# tool, then runs this. It checks the staged bytes are one whole JSON object
# and renames them onto verdict/<name>. rename(2) inside one directory is
# atomic, so the daemon's watcher sees either no file or the whole file —
# never the empty or half-written one an in-place write shows it between its
# open and its bytes.
#
# It writes nothing but verdict/<name>.tmp and verdict/<name>: it reads no
# config, no credential and no GitHub, and posts nothing. On a refusal the
# staged file stays where it is — fix it and run this again.
#
# --from-record (a round verdict only): the session does not retype
# the verdict. Its findings record, state/findings/<name> — written earlier in
# the same round, under `[review] render_outputs` already carrying `verdict`,
# `head_sha` and `summary` at its top level — also carries `passes` (and
# `approval_withheld`, `sweep`, `sweep_reason`, `extent`, `extent_reason`,
# `escalations` when the verdict has them — the reasons and extent of the
# follow-up decisions, which the daemon logs), and
# this builds the verdict file from exactly those fields plus `pr`, `round_no`
# (both checked against the name) and `finished_at` (now, UTC), writes it to
# verdict/<name>.tmp and publishes it the same way. The verdict's shape is the
# one the templates state — nothing is added, nothing is decided here: a field
# the record lacks is a refusal naming it, and nothing is published. The record
# is only read. It never builds a `head_moved` outcome or a recheck's.
#
# Usage: commit-verdict.sh <pr-N-round-K.json | pr-N-recheck-<head12>.json>
#        commit-verdict.sh --from-record <pr-N-round-K.json>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/verdict"

die() { echo "commit-verdict: $*" >&2; exit 1; }

USAGE="usage: commit-verdict.sh <pr-N-round-K.json | pr-N-recheck-<head12>.json> | --from-record <pr-N-round-K.json>"
FROM_RECORD=0
if [[ "${1:-}" == "--from-record" ]]; then
  FROM_RECORD=1
  shift
fi
NAME="${1:-}"
# The two names the daemon's watchers consume (VERDICT_FILE_RE in
# src/verdicts.ts, RECHECK_FILE_RE in src/recheck.ts) and nothing else: no
# path, no traversal, no other file in verdict/.
[[ "$NAME" =~ ^pr-[0-9]+-(round-[0-9]+|recheck-[0-9a-fA-F]{7,40})\.json$ ]] || die "$USAGE"
[[ $# -eq 1 ]] || die "$USAGE"

STAGED="$DIR/$NAME.tmp"
[[ -d "$DIR" && ! -L "$DIR" ]] || die "verdict/ is missing or not a plain directory"

if [[ "$FROM_RECORD" == 1 ]]; then
  [[ "$NAME" =~ ^pr-([0-9]+)-round-([0-9]+)\.json$ ]] ||
    die "--from-record builds a round verdict only (pr-N-round-K.json) — stage a recheck outcome by hand"
  RECORD="$ROOT/state/findings/$NAME"
  [[ ! -L "$RECORD" ]] || die "state/findings/$NAME is a symlink — nothing was published"
  [[ -f "$RECORD" ]] ||
    die "no findings record at state/findings/$NAME — write it first (step 7), or stage the verdict by hand (nothing was published)"
  [[ ! -L "$STAGED" ]] || die "verdict/$NAME.tmp is a symlink — nothing was published"
  # Exactly the verdict's fields, copied — never derived. Required: verdict,
  # head_sha, passes (the round templates' shape). Optional, copied only when
  # present: summary, approval_withheld (only `true`), sweep, sweep_reason,
  # extent, extent_reason, escalations.
  python3 - "$RECORD" "$STAGED" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" <<'PY' ||
import json, sys
from datetime import datetime, timezone

record_path, staged_path, pr, round_no = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

def refuse(why):
    print(f"commit-verdict: --from-record: {why}", file=sys.stderr)
    raise SystemExit(1)

def no_constant(token):
    raise ValueError(f"{token} is not JSON")

try:
    with open(record_path, encoding="utf-8") as fh:
        rec = json.load(fh, parse_constant=no_constant)
except (OSError, ValueError) as err:
    refuse(f"the findings record is not readable JSON ({err})")
if not isinstance(rec, dict):
    refuse("the findings record is not a JSON object")

def whole(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.strip().isdigit():
        return int(v)
    return None

if whole(rec.get("pr")) != pr or whole(rec.get("round_no")) != round_no:
    refuse(f"the record's pr/round_no ({rec.get('pr')!r}/{rec.get('round_no')!r}) are not {pr}/{round_no}")
missing = []
verdict = rec.get("verdict")
if verdict not in ("APPROVE", "REQUEST_CHANGES"):
    missing.append('"verdict" (APPROVE or REQUEST_CHANGES)')
head = rec.get("head_sha")
if not isinstance(head, str) or not head.strip():
    missing.append('"head_sha"')
passes = rec.get("passes")
if not isinstance(passes, list):
    missing.append('"passes" (step 7\'s array — [] for a solo round)')
if missing:
    refuse("the record lacks " + ", ".join(missing) + " at its top level — add it, or stage the verdict by hand")

out = {"pr": pr, "round_no": round_no, "verdict": verdict, "head_sha": head}
summary = rec.get("summary")
if isinstance(summary, str) and summary.strip():
    out["summary"] = summary
if rec.get("approval_withheld") is True:
    out["approval_withheld"] = True
out["passes"] = passes
for key in ("sweep", "sweep_reason", "extent", "extent_reason", "escalations"):
    if key in rec and rec[key] is not None:
        out[key] = rec[key]
out["finished_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
with open(staged_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY
    die "nothing was published"
fi
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
