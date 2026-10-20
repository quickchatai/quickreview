#!/usr/bin/env bash
# Write a state.db at the PRE-CUTOVER schema: the one the live bot's own code creates.
#
#   scripts/worker-rehearsal/legacy-db.sh <out.db> [<legacy-commit>]
#
# The legacy commit (default: the one the live bot was last deployed from, 8169df6f) is
# built in a scratch dir and ITS StateStore creates the file, then a legacy-shaped PR
# history is written through that store: a closed earlier PR with a finished round and a
# posted review, so the migrations HEAD applies have rows to carry. Nothing from HEAD
# touches the file before the container does.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
OUT="${1:?usage: legacy-db.sh <out.db> [<legacy-commit>]}"
COMMIT="${2:-${QCR_REHEARSAL_LEGACY_COMMIT:-8169df6f}}"
CACHE="${QCR_REHEARSAL_CACHE:-/tmp/qcr-worker-rehearsal-cache}"
T="$CACHE/legacy-$COMMIT"
if [[ ! -f "$T/dist/src/state.js" ]]; then
  rm -rf "$T"; mkdir -p "$T"
  git -C "$ROOT" archive "$COMMIT" package.json package-lock.json tsconfig.json src extensions scripts/verify-dist.mjs | tar -x -C "$T"
  ln -s "$ROOT/node_modules" "$T/node_modules"
  # The legacy tree is typed against its own lockfile; a type error against HEAD's
  # node_modules does not change what the emitted state.js does.
  (cd "$T" && npx tsc -p tsconfig.json --noEmitOnError false --incremental false >"$T/tsc.log" 2>&1 || true)
  [[ -f "$T/dist/src/state.js" ]] || { echo "legacy build produced no state.js (see $T/tsc.log)" >&2; exit 1; }
fi
rm -f "$OUT" "$OUT-wal" "$OUT-shm"
node --input-type=module -e '
  const { StateStore } = await import(process.argv[1] + "/dist/src/state.js");
  const store = new StateStore(process.argv[2]);
  // An earlier PR the legacy bot finished, and the deploy window the cutover opens: the
  // operator drained before the runbook began.
  store.upsertPr({ number: 6, state: "closed", head_sha: "6".repeat(40), title: "Earlier change", author: "bob", trigger_ts: "2026-10-18T09:00:00.000Z", stale_recheck: 0, escalation_worthy: 0, migration_gate: 0 });
  store.logEvent("legacy_fixture", 6, { note: "written by the legacy build" });
  store.engageDrain({ issuer: "operator", expires_at: null });
  const d = store.drainState();
  console.log("legacy drain:", JSON.stringify(d));
  store.db.close();
' "$T" "$OUT"
echo "legacy schema from $COMMIT -> $OUT" >&2
