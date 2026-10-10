#!/usr/bin/env bash
# Review-sandbox container entrypoint — plain Docker path.
#
# Non-templated equivalent of deploy/ansible/templates/entrypoint.sh.j2: every
# Jinja variable becomes an env knob with the SAME default the group_vars
# carry, so `docker compose up` with no environment reproduces the VM boot.
# tests/docker-daemon.test.ts pins the invariants shared with the templated
# boot (no interactive wizard, no vlm section, root key from the secrets
# mount, degrade-never-block, trust layers).
set -euo pipefail

SANDBOX=/opt/quickreview/sandbox
SECRETS=/opt/quickreview/secrets

# The live config: the host's install locator found it, and compose mounts
# its directory read-only at /opt/quickreview/config-home. Always named for the
# daemon (which hands the same path to every session): there is no checkout
# config to fall back to, so an empty mount — a stack
# started by hand before the wizard wrote QCR_CONFIG_HOME — fails the boot
# naming this file, rather than reading one the operator never chose.
export QCR_CONFIG="${QCR_CONFIG:-/opt/quickreview/config-home/${QCR_CONFIG_NAME:-config.toml}}"

# Runtime knobs — defaults mirror deploy/ansible/group_vars/all.yml and
# config.toml [openviking]; override via the container environment.
OV_HOME="${QCR_OPENVIKING_HOME:-/opt/quickreview/state/openviking}"
OV_PORT="${QCR_OPENVIKING_PORT:-1933}"
OV_WORKERS="${QCR_OPENVIKING_WORKERS:-1}"
OV_QUEUE_CONCURRENCY="${QCR_OPENVIKING_QUEUE_CONCURRENCY:-2}"
OV_AUTH_MODE="${QCR_OPENVIKING_AUTH_MODE:-api_key}"
# The embedder: LOCAL by default — the local ENGLISH
# embedder, served on loopback in this container by
# scripts/openviking-embedder.py from the GGUF the image pins, so no memory
# text leaves the machine. A hosted opt-in is provider/model/dimension in the
# project .env (docker-compose.yml passes them through) plus
# <secrets>/$OV_EMBEDDING_KEY_FILE — its OWN file, never pi's openai_api_key.
OV_EMBEDDING_PROVIDER="${QCR_OPENVIKING_EMBEDDING_PROVIDER:-local}"
OV_EMBEDDING_MODEL="${QCR_OPENVIKING_EMBEDDING_MODEL:-bge-small-en-v1.5-f16}"
OV_EMBEDDING_DIMENSION="${QCR_OPENVIKING_EMBEDDING_DIMENSION:-384}"
OV_EMBEDDING_KEY_FILE="${QCR_OPENVIKING_EMBEDDING_KEY_FILE:-openai_embeddings_api_key}"
# The local embedder's pin: model, file and sha256 are the image's —
# docker/daemon/Dockerfile exports its LOCAL_EMBEDDER_* ARGs as these
# QCR_OPENVIKING_LOCAL_EMBEDDER_* (== config.toml [openviking] local_embedder_*
# == group_vars openviking_local_embedder_*); the literals below only cover an
# image that does not export them. Port and threads are runtime knobs the
# daemon reads from config.toml — docker-compose.yml passes the .env's mirror
# of them, which the onboarding bring-up step writes.
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

# The code roots all state at <sandbox>/state; point that at the dedicated
# state volume.
#
# The compose file mounts that ONE volume at BOTH paths — /opt/quickreview/state
# (the absolute path the docs, the TUI and the ingress checks use) and
# <sandbox>/state (where the code looks). That is deliberate and it is why the
# first branch exists: the sandbox is a bind mount of the operator's checkout,
# so anything this script does to <sandbox>/state happens on their machine.
# Replacing that directory with a symlink would delete the onboarding
# checklist, the companion's rollover/alert state and the first-run marker, all
# of which are host-side files the TUI and the wizard read directly
# (src/tui/index.ts, src/onboard/engine.ts). Same-inode means the volume is
# already mounted here: there is nothing to migrate and nothing to link, and
# the destructive branch must not run — `rm -rf` on a mountpoint deletes the
# volume's CONTENTS before failing to remove it.
STATE_ID="$(stat -c %d:%i "$SANDBOX/state" 2>/dev/null || echo sandbox)"
VOLUME_ID="$(stat -c %d:%i /opt/quickreview/state 2>/dev/null || echo volume)"
if [[ "$STATE_ID" == "$VOLUME_ID" ]]; then
  : # the state volume is mounted straight onto <sandbox>/state — nothing to do
else
  # Volume mounted only at /opt/quickreview/state: link, migrating a real
  # directory's contents once.
  if [[ -d "$SANDBOX/state" && ! -L "$SANDBOX/state" ]]; then
    cp -a "$SANDBOX/state/." /opt/quickreview/state/ 2>/dev/null || true
    rm -rf "$SANDBOX/state"
  fi
  [[ -L "$SANDBOX/state" ]] || ln -sfn /opt/quickreview/state "$SANDBOX/state"
fi

# The code resolves secrets through the install locator: an empty (or
# old-default) config.toml [github].secrets_dir means <config home>/secrets,
# i.e. ${XDG_CONFIG_HOME:-~/.config}/qcr/<install>/secrets — point that at the
# read-only secrets mount.
XDG_BASE="${XDG_CONFIG_HOME:-}"
[[ "$XDG_BASE" == /* ]] || XDG_BASE="$HOME/.config"
SECRETS_HOME="$XDG_BASE/qcr/${QCR_INSTALL:-default}/secrets"
mkdir -p "$(dirname "$SECRETS_HOME")"
[[ -L "$SECRETS_HOME" ]] || ln -sfn "$SECRETS" "$SECRETS_HOME"
# …and a SET [github] secrets_dir names a host path this container cannot
# see: the locator answers the mount instead, for the daemon, every session
# it spawns and mint-token.sh alike (they all inherit this).
export QCR_SECRETS_MOUNT="$SECRETS"

# OpenAI auth for pi — native, two routes:
#   1. API key: exported here so the tmux server and every pi process inherit it.
#   2. ChatGPT-subscription OAuth: run `/login` once in any pi session; tokens
#      persist in /home/review/.pi/agent/auth.json (a mounted volume) and take
#      precedence over the env var (pi resolution: flag -> auth.json -> env).
if [[ -r "$SECRETS/openai_api_key" ]]; then
  OPENAI_API_KEY="$(< "$SECRETS/openai_api_key")"
  export OPENAI_API_KEY
fi

# OpenViking — the context store the daemon supervises as a child process on
# loopback $OV_PORT. This block prepares its state and configuration and
# provisions its users; it never leaves a server running (the provisioning
# step below starts one in the foreground and stops it again, so the container
# still ends up with a single supervised process tree — the long-lived server
# is the daemon's child) and it never runs the server's own setup wizard (the
# `init` subcommand): that wizard is interactive, and the reviewer must never
# block on an interactive prompt. ov.conf is rendered below instead.
#
# ~/.openviking is a SYMLINK onto the state volume, so memories, the vector db
# and ov.conf all survive an image rebuild.
mkdir -p "$OV_HOME/workspace" || echo "openviking: could not create $OV_HOME/workspace" >&2
# Same migration idiom as the state symlink above: a real directory that
# accumulated content is folded onto the volume once, then replaced by the link.
if [[ -e "$HOME/.openviking" && ! -L "$HOME/.openviking" ]]; then
  cp -a "$HOME/.openviking/." "$OV_HOME/" 2>/dev/null || true
  rm -rf "$HOME/.openviking"
fi
[[ -L "$HOME/.openviking" ]] || ln -sfn "$OV_HOME" "$HOME/.openviking"

# ov.conf is RENDERED on every boot, so a knob change ships with a restart
# rather than a hand-edit in the container. Rendered by node because ov.conf is
# JSON and its credentials (the server's root key; under the hosted-embedder
# opt-in, the embeddings key) must be injected from the read-only secrets
# mount at runtime (never baked into the image, never committed).
#
# Shape notes, verified against a running 0.4.15 — unknown fields are REJECTED
# by the server, so nothing speculative goes in here:
#   * NO `vlm` SECTION AT ALL. Extraction, summaries and digest stay off:
#     memories are authored by sessions and the EOD curator, never extracted.
#     (This is also why `doctor` is not the health gate — it exits 1 with no
#     vlm configured. The daemon polls /ready.)
#   * auth_mode comes from $QCR_OPENVIKING_AUTH_MODE (mirrored with config.toml
#     [openviking] auth_mode), default "api_key". Loopback-only is not enough:
#     every review session runs inside this container,
#     so "nobody can reach the port" does not stop a review session from
#     reading companion memory. Only the server's per-USER-key confinement
#     does, and that confinement exists only in api_key mode — which is why
#     the root key is read from the read-only secrets mount here and never
#     written as a literal.
#   * workers/queue_workers — and embedding.max_concurrent, on the same knob
#     — are cut for a 2-CPU cap: CPU is the measured cost
#     (~1.63 core-seconds per ~500 B write), not RAM.
#   * retrieval.enable_intent = false: no model-based query
#     planning on a session search — there is no model for it.
#   * The embedder is a knob, never a literal — $QCR_OPENVIKING_EMBEDDING_*.
#     The shipped default is the local English embedder (a loopback service
#     over llama-cpp-python), so no memory text leaves this machine; a hosted
#     provider is an explicit opt-in and reads ITS OWN credential file —
#     never pi's `openai_api_key`, so the two are set independently.
#
# The `||` is deliberate (the boot runs under `set -e`): a memory engine that
# cannot be configured must never stop the reviewer from coming up. The daemon
# supervises the server regardless — /ready simply stays false and rounds run
# memory-less, which is the standing rule for every OpenViking call site.
OPENVIKING_CONF="$OV_HOME/ov.conf" QCR_SECRETS="$SECRETS" \
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
node <<'OV_CONF_RENDER' || echo "openviking: ov.conf render FAILED — the daemon starts memory-less" >&2
const fs = require("fs");
const path = require("path");
const home = path.dirname(process.env.OPENVIKING_CONF);
const conf = {
  server: {
    host: "127.0.0.1",
    port: Number(process.env.QCR_OV_PORT),
    workers: Number(process.env.QCR_OV_WORKERS),
    auth_mode: process.env.QCR_OV_AUTH_MODE,
  },
  storage: { workspace: path.join(home, "workspace") },
  queue_workers: {
    external_parse: { max_concurrent: Number(process.env.QCR_OV_QUEUE_CONCURRENCY) },
    add_resource: {
      max_concurrent: Number(process.env.QCR_OV_QUEUE_CONCURRENCY),
      file_vectorization_concurrency: Number(process.env.QCR_OV_QUEUE_CONCURRENCY),
    },
    session_commit: { max_concurrent: Number(process.env.QCR_OV_QUEUE_CONCURRENCY) },
  },
  memory: {
    extraction_enabled: false,
    session_skill_extraction_enabled: false,
    link_enabled: false,
  },
  // No model-based intent analysis / query planning on a search
  // that carries a session id: this deployment configures no model for it,
  // every attempt failed on a missing key, and in list mode an error there
  // fails the whole search (retrieval_config.py `enable_intent`). The raw
  // query is searched, exactly as for a search without a session.
  retrieval: { enable_intent: false },
  log: { level: "INFO", output: "stdout" },
};
// The read-only secrets mount — one constant, taken from $SECRETS above so a
// moved mount cannot leave this half behind.
const secrets = process.env.QCR_SECRETS || "/opt/quickreview/secrets";
// api_key mode needs the SERVER's own root key, and it must come from the
// read-only secrets mount — never a literal in this script, never a value
// baked into the image. ov.conf is written 0600 and is the only place in the
// container that holds it; `writeOvcliConf` (src/memory/ovsession.ts) refuses
// to hand it to a pi session and extensions/bash-guard.ts refuses to read it.
// A missing root key DEGRADES (the server falls back to "dev", loudly) rather
// than leaving a server nobody can authenticate to: memory never blocks.
if (conf.server.auth_mode === "api_key") {
  const rootFile = path.join(secrets, process.env.QCR_OV_ROOT_KEY_FILE);
  if (fs.existsSync(rootFile)) {
    conf.server.root_api_key = fs.readFileSync(rootFile, "utf8").trim();
  } else {
    conf.server.auth_mode = "dev";
    console.warn("openviking: NO " + process.env.QCR_OV_ROOT_KEY_FILE + " in the secrets mount — falling back to auth_mode=dev. Per-user confinement is NOT enforced in that mode: provision the root key and restart.");
  }
}
// The embedder is ALWAYS written explicitly, so ov.conf states which vector
// space the store is in and the migration check below can compare it against
// the collection on disk. "local" is the local English embedder
// and needs no key. Any other provider is a hosted opt-in and reads ITS OWN
// credential file. A hosted provider whose key file is missing is rendered
// WITHOUT a key on purpose: the server then refuses to start (loud, memory
// degrades) rather than this render silently switching to another embedder —
// which would reset a hosted store's vectors on boot.
conf.embedding = {
  // Concurrent embedding calls bounded by the same 2-CPU knob as
  // the queue workers (the server's default is 10).
  max_concurrent: Number(process.env.QCR_OV_QUEUE_CONCURRENCY),
  dense: {
    provider: process.env.QCR_OV_EMBEDDING_PROVIDER,
    model: process.env.QCR_OV_EMBEDDING_MODEL,
    dimension: Number(process.env.QCR_OV_EMBEDDING_DIMENSION),
    input: "text",
  },
};
if (conf.embedding.dense.provider === "local") {
  // "local" is ONE embedder — the pinned model the service runs.
  // Its name and dimension come from the pin, whatever the generic knobs say
  // (a project .env written by an older release carries the retired built-in
  // model); a disagreement is said aloud.
  const pinned = {
    model: process.env.QCR_OV_LOCAL_EMBEDDER_MODEL,
    dimension: Number(process.env.QCR_OV_LOCAL_EMBEDDER_DIMENSION),
  };
  if (conf.embedding.dense.model !== pinned.model || conf.embedding.dense.dimension !== pinned.dimension)
    console.warn("openviking: QCR_OPENVIKING_EMBEDDING_MODEL/DIMENSION (" + conf.embedding.dense.model + ", " + conf.embedding.dense.dimension + ") ignored under provider local — the local embedder runs " + pinned.model + " at " + pinned.dimension + " dims");
  conf.embedding.dense = {
    // The engine's OpenAI-COMPATIBLE client — its async embedder — pointed at
    // the loopback service. The wire format, not a destination: api_base is
    // 127.0.0.1, there is no key, and nothing leaves the container.
    provider: "openai",
    model: pinned.model,
    dimension: pinned.dimension,
    api_base: "http://127.0.0.1:" + Number(process.env.QCR_OV_LOCAL_EMBEDDER_PORT) + "/v1",
    // Tells the service a query from a document (input_type in the body), so
    // a query gets the model's retrieval instruction and a document does not.
    query_param: "query",
    document_param: "passage",
    input: "text",
  };
} else {
  const embedKeyFile = path.join(secrets, process.env.QCR_OV_EMBEDDING_KEY_FILE);
  if (fs.existsSync(embedKeyFile)) {
    conf.embedding.dense.api_key = fs.readFileSync(embedKeyFile, "utf8").trim();
  } else {
    console.warn("openviking: embedding provider '" + conf.embedding.dense.provider + "' is configured but " + process.env.QCR_OV_EMBEDDING_KEY_FILE + " is NOT in the secrets mount — the server will refuse to start until it is (memory degrades; the embedder is never switched silently)");
  }
}
fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
const target = process.env.OPENVIKING_CONF;
fs.writeFileSync(target, JSON.stringify(conf, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(target, 0o600);
console.log("openviking: ov.conf rendered at " + target + " (no vlm section; auth_mode=" + conf.server.auth_mode + " on loopback; embedder " + conf.embedding.dense.provider + "/" + conf.embedding.dense.model + " " + conf.embedding.dense.dimension + " dims" + (conf.embedding.dense.api_base ? " at " + conf.embedding.dense.api_base : "") + ")");
OV_CONF_RENDER

# Embedder migration check — BEFORE any server starts. A store whose
# vector collection was built under a different embedder than ov.conf now
# names (the hosted→local switch, or an opt-in later) holds vectors the new
# embedder cannot read, and 0.4.15 refuses to start on it. `prepare` compares
# the collection's own embedding record with ov.conf; on a mismatch it moves
# the collection ASIDE (never deletes — the old vectors are the rollback) and
# journals every provisioned namespace as pending in reembed.json. The daemon
# then re-embeds reviewer memory through the server's reindex API once /ready
# passes (src/openviking/reembed.ts); any other namespace is its key holder's
# — docs/memory-embeddings.md. On a matching store this is a no-op in
# milliseconds, every boot. Never blocks the boot: exit 0 by contract, `||`
# as belt.
if [[ -f "$SANDBOX/scripts/openviking-reembed.mjs" ]]; then
  node "$SANDBOX/scripts/openviking-reembed.mjs" prepare \
    --home "$OV_HOME" --config "$OV_HOME/ov.conf" \
    --users "$OV_PROVISION_USERS" --user reviewer \
    || echo "openviking: embedder migration check did not complete — the server may refuse to start on a mismatched store until an operator looks (docs/memory-embeddings.md)" >&2
else
  echo "openviking: scripts/openviking-reembed.mjs not mounted — embedder migration not checked" >&2
fi

# Boot provisioning — the users that make api_key mode mean
# something. Idempotent by construction: it CREATES a missing user, LEAVES an
# existing one exactly as it is, and never rotates or mints a key for a user
# that has one (a rotation orphans the key already distributed elsewhere). It
# also verifies that the reviewer key in the secrets mount actually
# authenticates, so a mismatch is a boot log line rather than a silent memory
# outage.
#
# It starts the server itself, briefly, and stops it again: the daemon is not
# running yet, and nothing here may background a process. `|| true` plus the
# script's own exit-0 discipline are belt and braces — an unprovisioned memory
# engine degrades, it never stops the reviewer coming up.
#
# Under the LOCAL embedder the server's /ready probes the
# loopback embedding service, so provisioning runs that too — first, for the
# same foreground step, stopped with the server. The daemon supervises the
# long-lived pair from config.toml's mirror of these values.
OV_EMBEDDER_ARGS=()
if [[ "$OV_EMBEDDING_PROVIDER" == "local" ]]; then
  OV_EMBEDDER_ARGS=(
    --embedder-python "$OV_VENV/bin/python"
    --embedder-script "$SANDBOX/scripts/openviking-embedder.py"
    --embedder-model "$OV_LOCAL_EMBEDDER_MODEL"
    --embedder-file "$OV_LOCAL_EMBEDDER_DIR/$OV_LOCAL_EMBEDDER_MODEL.gguf"
    --embedder-sha256 "$OV_LOCAL_EMBEDDER_SHA256"
    --embedder-port "$OV_LOCAL_EMBEDDER_PORT"
    --embedder-threads "$OV_LOCAL_EMBEDDER_THREADS"
  )
fi
if [[ -f "$SANDBOX/scripts/openviking-provision.mjs" ]]; then
  node "$SANDBOX/scripts/openviking-provision.mjs" \
    --base "http://127.0.0.1:$OV_PORT" \
    --users "$OV_PROVISION_USERS" \
    --root-key-file "$SECRETS/$OV_ROOT_KEY_FILE" \
    --reviewer-key-file "$SECRETS/$OV_REVIEWER_KEY_FILE" \
    --start-server \
    --bin "$OV_VENV/bin/openviking-server" \
    --config "$OV_HOME/ov.conf" \
    --host 127.0.0.1 --port "$OV_PORT" \
    "${OV_EMBEDDER_ARGS[@]}" \
    || echo "openviking: boot provisioning did not complete — the daemon starts and memory degrades until it does" >&2
else
  echo "openviking: scripts/openviking-provision.mjs not mounted — users not provisioned" >&2
fi

# pi extensions — register in $HOME/.pi/agent/settings.json (on the pihome
# volume). Every pi process shares HOME=/home/review — main sessions AND the
# isolated child processes the subagent tool spawns — so this one file covers
# all. Idempotent MERGE, safe on every boot: the file predates the
# "extensions" key and carries user keys (auth/defaults) that must never be
# clobbered. Each path is appended only if absent; missing extension files
# hard-fail the boot (a silently unregistered bash-guard would mean unguarded
# sessions). ONLY bash-guard belongs here: subagent children load exactly this
# list, so a globally-registered subagents glue would hand every LEAF the
# subagent tool (nested fan-out — rule 9 broken). It rides per-spawn argv in
# src/sessions.ts instead.
node <<'PI_EXT_MERGE'
const fs = require("fs");
const path = require("path");

const file = path.join(process.env.HOME, ".pi", "agent", "settings.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
let settings = {};
if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(settings.extensions)) settings.extensions = [];

// pi-memory is NOT registered here — the hand-rolled memory engine is
// retired. Memory is OpenViking, and its (vendored, patched) pi
// extension is passed per spawn by src/sessions.ts, deliberately NOT registered
// globally: a globally-registered memory extension would also load in the
// isolated children the subagent tool spawns, and lens passes must do no
// ambient memory work.
// The third-party pi-subagents entry is gone the same way pi-memory
// went — the native subagent extension rides per-spawn argv via
// extensions/subagents.ts (a global entry would arm leaves with fan-out; the
// prune below retires the stale /opt/pi-extensions path on older volumes).
const wanted = [
  // Repo-shipped guard, rides the sandbox mount. Subagent children load this
  // (they spawn without --no-extensions at the 0.84.4 pin), which puts the
  // exec-policy guard inside leaves too.
  "/opt/quickreview/sandbox/extensions/bash-guard.ts",
];
for (const p of wanted) {
  if (!fs.existsSync(p)) {
    console.error("FATAL: pi extension missing: " + p);
    process.exit(1);
  }
  if (!settings.extensions.includes(p)) settings.extensions.push(p);
}
// settings.json lives on the PERSISTENT pihome volume, so entries written by
// an older image survive a rebuild. Adding the wanted list is not enough —
// after pi-memory was retired the volume still registered
// /usr/lib/node_modules/pi-memory/index.ts, which the image no longer has. pi
// tolerates a missing extension, so it never surfaced as a failure; it just
// sat there misreporting what the reviewer loads. Prune anything that is not
// on disk.
// A `builtin:` override (below) names no file, so it is never "stale".
const isBuiltinEntry = (p) => /^[-+!]?builtin:/.test(p);
const stale = settings.extensions.filter((p) => !isBuiltinEntry(p) && !fs.existsSync(p));
if (stale.length) {
  settings.extensions = settings.extensions.filter((p) => isBuiltinEntry(p) || fs.existsSync(p));
  console.log("pi extensions pruned (not on disk): " + stale.join(", "));
}
// The reviewer never blocks on interactive input (pr-5334 stalled on pi's
// "Trust project folder?" modal after .pi/settings.json shipped). Belt: trust
// every project by default. Braces: pre-seed the trust store for
// /opt/quickreview so even a settings regression cannot re-surface the prompt.
// Third layer: sessions.ts passes --approve on every spawn.
settings.defaultProjectTrust = "always";
// pi 1.0 made the interactive TUI fullscreen by default. Sessions run under
// tmux and the operator TUI mirrors and scrolls their panes, so keep the
// terminal's normal scrollback (pi 0.99's default) — src/pibuiltins.ts PI_TUI_MODE.
settings.tuiMode = "regular";
// pi 0.99's built-in extensions (mcp, codemode, tool-search, llama.cpp) are
// switched OFF: MCP launches server processes from any trusted mcp.json, the
// other three change the tool/provider set, and no session uses any of them
// (reasons per built-in: src/pibuiltins.ts, the list this mirrors). The
// documented switch is a `-builtin:<name>` entry in the global `extensions`.
// Any other global `builtin:` entry — a `+builtin:mcp` a hand edit or an older
// write left on the pihome volume — is dropped first, so this list is the
// only word the user settings say about built-ins.
const DISABLED_BUILTINS = ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"];
settings.extensions = settings.extensions.filter((p) => !isBuiltinEntry(p)).concat(DISABLED_BUILTINS);

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log("pi extensions registered: " + settings.extensions.join(", "));

const trustFile = path.join(process.env.HOME, ".pi", "agent", "trust.json");
let trust = {};
if (fs.existsSync(trustFile)) trust = JSON.parse(fs.readFileSync(trustFile, "utf8"));
if (trust["/opt/quickreview"] !== true) {
  trust["/opt/quickreview"] = true;
  fs.writeFileSync(trustFile, JSON.stringify(trust, null, 2) + "\n");
}
console.log("pi project trust: defaultProjectTrust=always, /opt/quickreview pre-trusted");

// Agent discovery for the native subagent extension. Its default
// "user" scope reads $HOME/.pi/agent/agents; link that at the daemon-built
// lens passes (state/agents, written by buildAgents at wire start — a
// dangling link until the first build is fine, discovery just sees none).
// Symlink-or-absent only: a REAL directory here is someone's own agents and
// is never clobbered — loud log instead, because lens passes will then not
// resolve ("Unknown agent" = STOP in the round templates, never a stand-in).
const agentsLink = path.join(process.env.HOME, ".pi", "agent", "agents");
const builtAgents = "/opt/quickreview/sandbox/state/agents";
try {
  const st = fs.lstatSync(agentsLink, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    console.error("WARNING: " + agentsLink + " exists and is not a symlink — NOT touching it; lens agents will not resolve");
  } else {
    if (st) fs.unlinkSync(agentsLink);
    fs.symlinkSync(builtAgents, agentsLink);
    console.log("pi user agents dir -> " + builtAgents);
  }
} catch (e) {
  console.error("WARNING: could not link " + agentsLink + ": " + e.message);
}
PI_EXT_MERGE

# Private-repo git auth (reviewed-repo clone + per-PR fetches): the app
# installation token over HTTPS — never a personal credential (CLAUDE.md rule 3).
git config --global credential.helper \
  "!f() { echo username=x-access-token; echo \"password=\$(\"$SANDBOX/scripts/mint-token.sh\")\"; }; f"

# Build on boot when needed (fresh volume or bumped dependencies). The lockfile
# hash marker keeps steady-state restarts instant.
cd "$SANDBOX"
marker=/opt/quickreview/state/.build-lock-hash
current="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -d dist || ! -f "$marker" || "$(cat "$marker")" != "$current" ]]; then
  npm ci
  npm run build
  echo "$current" > "$marker"
fi

# NO reviewer context stub on this path (deploy/reviewer/AGENTS.override.md is
# installed by the VM entrypoint only): here /opt/quickreview/sandbox IS the
# operator's own repo checkout, bind-mounted, and an AGENTS.override.md in its
# root would shadow the real guide for every pi run in that checkout — the
# companion's included. Sessions here load the full AGENTS.md.

# tmux server = the jump-in surface (qcr attach / docker exec ... tmux attach
# / the qcr tui embedded pane). The csi-u lines must exist before the server
# starts or modified keys (Shift-Enter etc.) collapse before reaching pi.
# Prefer the repo config (rides the sandbox mount, no image rebuild needed);
# the inline heredoc below is only the no-sandbox fallback.
if [[ -f "$SANDBOX/docker/vm/tmux.conf" ]]; then
  cp "$SANDBOX/docker/vm/tmux.conf" "$HOME/.tmux.conf"
else
  cat > "$HOME/.tmux.conf" <<'TMUXCONF'
# csi-u extended keys end-to-end — do not remove.
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features 'xterm*:extkeys'
# Mouse wheel scrolls the pane HISTORY (tmux copy-mode), not pi's prompt list;
# pi /copy propagates via OSC 52 through set-clipboard. Keep in sync with the
# companion entrypoint.
set -g mouse on
set -g set-clipboard on
set -as terminal-features 'xterm*:clipboard'
set -g history-limit 50000
# Muted look — no bright greens anywhere.
set -g status-style 'bg=colour235,fg=colour247'
set -g status-left-style 'fg=colour250'
set -g status-right-style 'fg=colour244'
set -g window-status-current-style 'fg=colour252,bold'
set -g message-style 'bg=colour235,fg=colour250'
set -g mode-style 'bg=colour238,fg=colour252'
set -g pane-border-style 'fg=colour238'
set -g pane-active-border-style 'fg=colour245'
TMUXCONF
fi
tmux start-server
tmux has-session -t main 2>/dev/null || tmux new-session -d -s main

exec node "$SANDBOX/dist/src/wire.js"
