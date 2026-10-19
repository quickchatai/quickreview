#!/usr/bin/env bash
# Memory sidecar entrypoint (docker/memory/Dockerfile).
#
# The memory half of docker/daemon/entrypoint.sh, for a container whose only
# job is OpenViking: render ov.conf, run the embedder migration's `prepare`,
# provision the users, then exec the process supervisor. The knobs and their
# defaults are the daemon entrypoint's (QCR_OPENVIKING_*, the same names), so
# one environment drives both images. tests/memory-image.test.ts holds the
# render to the daemon entrypoint's and the invariants below.
#
# Invariants (the daemon entrypoint's, restated because they matter more here):
#   * never an interactive wizard (no `openviking-server init`), never a vlm;
#   * the root key comes from the read-only secrets mount, never a literal;
#   * degrade, never block: a step that fails says so and the sidecar still
#     comes up (memory then degrades, exactly as in the daemon's container);
#   * NEVER WIPE A STORE. `prepare` moves a mismatched vector collection
#     ASIDE; the re-embed driver rebuilds it once the server is ready.
set -euo pipefail

APP="${QCR_APP_ROOT:-/opt/qcr}"
SECRETS="${QCR_SECRETS:-/opt/quickreview/secrets}"

# The same config.toml the daemon reads; mounted read-only at the config home.
export QCR_CONFIG="${QCR_CONFIG:-/opt/quickreview/config-home/${QCR_CONFIG_NAME:-config.toml}}"

OV_HOME="${QCR_OPENVIKING_HOME:-/opt/quickreview/state/openviking}"
OV_PORT="${QCR_OPENVIKING_PORT:-1933}"
# The server binds the container network's interfaces; the port is never
# published, and api_key mode confines every key.
OV_BIND_HOST="${QCR_OPENVIKING_BIND_HOST:-0.0.0.0}"
OV_WORKERS="${QCR_OPENVIKING_WORKERS:-1}"
OV_QUEUE_CONCURRENCY="${QCR_OPENVIKING_QUEUE_CONCURRENCY:-2}"
OV_AUTH_MODE="${QCR_OPENVIKING_AUTH_MODE:-api_key}"
OV_EMBEDDING_PROVIDER="${QCR_OPENVIKING_EMBEDDING_PROVIDER:-local}"
OV_EMBEDDING_MODEL="${QCR_OPENVIKING_EMBEDDING_MODEL:-bge-small-en-v1.5-f16}"
OV_EMBEDDING_DIMENSION="${QCR_OPENVIKING_EMBEDDING_DIMENSION:-384}"
OV_EMBEDDING_KEY_FILE="${QCR_OPENVIKING_EMBEDDING_KEY_FILE:-openai_embeddings_api_key}"
# The local embedder's pin: the image's own (Dockerfile ENV); the literals only
# cover an image that does not export them.
OV_LOCAL_EMBEDDER_MODEL="${QCR_OPENVIKING_LOCAL_EMBEDDER_MODEL:-bge-small-en-v1.5-f16}"
OV_LOCAL_EMBEDDER_DIMENSION="${QCR_OPENVIKING_LOCAL_EMBEDDER_DIMENSION:-384}"
OV_LOCAL_EMBEDDER_DIR="${QCR_OPENVIKING_LOCAL_EMBEDDER_DIR:-/opt/openviking/models}"
OV_LOCAL_EMBEDDER_SHA256="${QCR_OPENVIKING_LOCAL_EMBEDDER_SHA256:-f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999}"
OV_LOCAL_EMBEDDER_PORT="${QCR_OPENVIKING_LOCAL_EMBEDDER_PORT:-1934}"
OV_LOCAL_EMBEDDER_THREADS="${QCR_OPENVIKING_LOCAL_EMBEDDER_THREADS:-1}"
OV_ROOT_KEY_FILE="${QCR_OPENVIKING_ROOT_KEY_FILE:-openviking_root_key}"
OV_REVIEWER_KEY_FILE="${QCR_OPENVIKING_REVIEWER_KEY_FILE:-openviking_reviewer_key}"
OV_PROVISION_USERS="${QCR_OPENVIKING_PROVISION_USERS:-reviewer,companion}"
OV_VENV="${QCR_OPENVIKING_VENV:-/opt/openviking/venv}"

# ~/.openviking is a SYMLINK onto the state volume, so memories, the vector db
# and ov.conf survive an image rebuild. Same migration idiom as the daemon's.
mkdir -p "$OV_HOME/workspace" || echo "openviking: could not create $OV_HOME/workspace" >&2
BOOT_OK=1
if [[ -e "$HOME/.openviking" && ! -L "$HOME/.openviking" ]]; then
  if cp -a "$HOME/.openviking/." "$OV_HOME/" && rm -rf "$HOME/.openviking"; then
    :
  else
    BOOT_OK=0
    echo "openviking: migration failed; original memory retained, boot steps skipped" >&2
  fi
fi
if [[ "$BOOT_OK" == 1 ]] && ! { [[ -L "$HOME/.openviking" ]] || ln -sfn "$OV_HOME" "$HOME/.openviking"; }; then
  BOOT_OK=0
  echo "openviking: state link failed; boot steps skipped" >&2
fi

if [[ "$BOOT_OK" == 1 ]]; then

# ov.conf is RENDERED on every boot (scripts/openviking-ov-conf.mjs - the same
# document the daemon entrypoints render), so a knob change ships with a
# restart. The `||` is deliberate: a memory engine that cannot be configured
# must not stop the container from coming up.
OPENVIKING_CONF="$OV_HOME/ov.conf" QCR_SECRETS="$SECRETS" QCR_OV_HOST="$OV_BIND_HOST" \
QCR_OV_PORT="$OV_PORT" QCR_OV_WORKERS="$OV_WORKERS" \
QCR_OV_QUEUE_CONCURRENCY="$OV_QUEUE_CONCURRENCY" \
QCR_OV_AUTH_MODE="$OV_AUTH_MODE" \
QCR_OV_EMBEDDING_PROVIDER="$OV_EMBEDDING_PROVIDER" \
QCR_OV_EMBEDDING_MODEL="$OV_EMBEDDING_MODEL" \
QCR_OV_EMBEDDING_DIMENSION="$OV_EMBEDDING_DIMENSION" \
QCR_OV_EMBEDDING_KEY_FILE="$OV_EMBEDDING_KEY_FILE" \
QCR_OV_LOCAL_EMBEDDER_MODEL="$OV_LOCAL_EMBEDDER_MODEL" \
QCR_OV_LOCAL_EMBEDDER_DIMENSION="$OV_LOCAL_EMBEDDER_DIMENSION" \
QCR_OV_LOCAL_EMBEDDER_PORT="$OV_LOCAL_EMBEDDER_PORT" \
QCR_OV_ROOT_KEY_FILE="$OV_ROOT_KEY_FILE" \
node "$APP/scripts/openviking-ov-conf.mjs" \
  || echo "openviking: ov.conf render FAILED - the sidecar starts, memory degrades" >&2

# Embedder migration check - BEFORE any server starts. A store whose vector
# collection was built under a different embedder than ov.conf now names holds
# vectors the new embedder cannot read, and the server refuses to start on it.
# `prepare` moves that collection ASIDE (never deletes - the old vectors are
# the rollback) and journals every provisioned namespace as pending in
# reembed.json; the re-embed driver in sidecar-main rebuilds reviewer memory
# through the server's reindex API once /ready passes, and any other namespace
# is its key holder's (docs/memory-embeddings.md). On a matching store this is
# a no-op in milliseconds, every boot. Exit 0 by contract, `||` as belt.
node "$APP/scripts/openviking-reembed.mjs" prepare \
  --home "$OV_HOME" --config "$OV_HOME/ov.conf" \
  --users "$OV_PROVISION_USERS" --user reviewer \
  || echo "openviking: embedder migration check did not complete - the server may refuse to start on a mismatched store until an operator looks (docs/memory-embeddings.md)" >&2

# Boot provisioning - idempotent: it CREATES a missing user, LEAVES an existing
# one exactly as it is, never rotates a key. It starts the server (and, under
# the local embedder, the loopback service) in the foreground, briefly, and
# stops them again - the long-lived pair is sidecar-main's.
OV_EMBEDDER_ARGS=()
if [[ "$OV_EMBEDDING_PROVIDER" == "local" ]]; then
  OV_EMBEDDER_ARGS=(
    --embedder-python "$OV_VENV/bin/python"
    --embedder-script "$APP/scripts/openviking-embedder.py"
    --embedder-model "$OV_LOCAL_EMBEDDER_MODEL"
    --embedder-file "$OV_LOCAL_EMBEDDER_DIR/$OV_LOCAL_EMBEDDER_MODEL.gguf"
    --embedder-sha256 "$OV_LOCAL_EMBEDDER_SHA256"
    --embedder-port "$OV_LOCAL_EMBEDDER_PORT"
    --embedder-threads "$OV_LOCAL_EMBEDDER_THREADS"
  )
fi
node "$APP/scripts/openviking-provision.mjs" \
  --base "http://127.0.0.1:$OV_PORT" \
  --users "$OV_PROVISION_USERS" \
  --root-key-file "$SECRETS/$OV_ROOT_KEY_FILE" \
  --reviewer-key-file "$SECRETS/$OV_REVIEWER_KEY_FILE" \
  --start-server \
  --bin "$OV_VENV/bin/openviking-server" \
  --config "$OV_HOME/ov.conf" \
  --host 127.0.0.1 --port "$OV_PORT" \
  "${OV_EMBEDDER_ARGS[@]}" \
  || echo "openviking: boot provisioning did not complete - the sidecar starts and memory degrades until it does" >&2

fi

# PID 1 is the supervisor: it owns the server, the embedder and the re-embed
# driver, and stops them on SIGTERM.
export QCR_OPENVIKING_BIND_HOST="$OV_BIND_HOST"
exec node "$APP/dist/src/openviking/sidecar-main.js"
