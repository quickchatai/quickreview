# Memory embeddings — local by default, and how a store changes embedder

The memory engine (OpenViking) turns every memory entry, and every search
query, into a vector. **Where that happens is a sovereignty question**, and
since the shipped answer is: **locally**, with the server's own
llama-cpp embedder running inside the daemon container. No key, no account,
and no memory text ever leaves the machine — nothing but the model call does.

This page is the operator's reference for the embedder: the knob, the hosted
opt-in and its separate credential, and the migration that runs when an
existing store's embedder changes — including exactly what the operator of an
install that used the hosted embedder before this change runs.

## The knob

`config.toml [openviking]`:

```toml
embedding_provider  = "local"                  # the shipped default
embedding_model     = "bge-small-zh-v1.5-f16"  # the ONE local model 0.4.15 ships (512 dims)
embedding_dimension = 512
embedding_key_file  = "openai_embeddings_api_key"   # read only under a hosted provider
```

`config.toml` is the declaration; **the boot renders the embedder from
somewhere else**, and the two are kept in step rather than assumed to be:

| route | what the boot renders | who writes it | what checks it |
|---|---|---|---|
| laptop (compose) | `QCR_OPENVIKING_EMBEDDING_*` in the project `.env` (`docker-compose.yml` passes them in; defaults are local) | the onboarding bring-up step mirrors `config.toml` on every bring-up | the daemon logs `EMBEDDER DRIFT` and reports `config_drift` in the heartbeat when ov.conf disagrees with `config.toml` |
| server (ansible) | `openviking_embedding_*` — the tracked `group_vars` (local), overridden by host vars on your inventory line | the onboarding inventory step writes a hosted opt-in as host vars; by hand: the same `key=value` tokens on the host line | `scripts/deploy.sh` **refuses to deploy** when `config.toml` and the effective ansible value disagree |

The refusal is not pedantry: a `config.toml` that says `openai` over a boot
that renders `local` means the boot's migration check (below) would reset the
vector store for the wrong embedder on the next start.

Under `local`, the model and dimension are pinned to the one local spec the
server ships; the config loader refuses anything else because the server
would refuse to boot on it. Under `openai`, name the hosted model and its
dimension (`text-embedding-3-small` / `1536` are the defaults the wizard
writes).

## The hosted opt-in, and why its credential is a separate file

`embedding_provider = "openai"` sends every memory entry's text and every
search query to OpenAI's embeddings endpoint. It is an opt-in, never a
fallback: a hosted provider whose key file is missing is rendered **without**
a key, so the server refuses to start (memory degrades, loudly) rather than the
boot silently switching embedder — which would reset the store.

The credential is `<secrets dir>/openai_embeddings_api_key` (the
`embedding_key_file` knob), collected by `bash deploy/collect-secrets.sh` at
its own prompt, 0600, and copied to the VM by the playbook if present.
**`openai_api_key` is pi's model credential and is never read for
embeddings.** They used to be the same file, which meant the advice "leave the
embeddings key unset" also unset pi's credential on the API-key route; now
either can exist without the other.

The onboarding wizard's embeddings step (order 38) writes the opt-in and
stays red until that file exists — and never accepts the value through the
session.

## What runs when the embedder changes

Changing embedder changes the vector space: hosted `text-embedding-3-small`
is 1536 dimensions, the local default is 512. A collection built under one
cannot be read by the other, and OpenViking 0.4.15 refuses to start on such a
store:

```
EmbeddingRebuildRequiredError: Existing collection embedding dimension (1536)
does not match current configuration (512). Vectors are incompatible;
rebuild is required.
```

The owner ruled: **re-embed, never pin the old setting and never
wipe**. `scripts/openviking-reembed.mjs` is the whole migration, in two halves
that the code — not an operator — sequences:

1. **`prepare` — disk, server down.** The container entrypoint runs it right
   after rendering `ov.conf` and *before* boot provisioning starts a server.
   It reads the collection's own embedding record
   (`workspace/vectordb/context/collection_meta.json`, the same record the
   server checks) and compares it with `ov.conf`. On a match, or on a fresh
   install with no collection yet, it is a no-op in milliseconds — every boot.
   On a mismatch it **moves the collection aside** to
   `context.pre-reembed-<timestamp>` (kept — that directory is the rollback)
   and writes the journal `reembed.json` beside `ov.conf`: the reviewer's
   namespace as `pending`, every other provisioned namespace (the companion's)
   as `operator`. It refuses — never guesses — when the metadata is unreadable,
   when a server is answering on the port, when the journal is unreadable, or
   when a reset for this same embedder already happened and the collection
   still disagrees (a loop guard).
2. **`resume` — HTTP, server up.** The daemon (`src/openviking/reembed.ts`)
   runs it once `/ready` passes, with the **reviewer user key** — the same key
   every review session holds, which the server confines to
   `viking://user/reviewer` (a 403 for anything else, verified live). It calls
   `POST /api/v1/content/reindex` (`mode: vectors_only`, an idempotent upsert)
   and follows the task to completion. The namespace is `completed` only when
   the task finished with **zero failed records**; a partial rebuild, a busy
   server or a deadline leave it `failed`/`pending` with the counts on record,
   and the daemon retries every five minutes, forever, each attempt logged and
   in the heartbeat. A daemon restart mid-run simply runs it again.

The memory **text** (`workspace/viking/…`) is never touched by either half;
only vectors are rebuilt. Rounds keep running throughout — memory context
assembly degrades to a thinner block while vectors rebuild and never blocks a
round.

### The heartbeat

`state/status.json` → `openviking.reembed`:

```json
{
  "state": "completed",
  "embedder": { "provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512 },
  "previous": { "provider": "openai", "model": "text-embedding-3-small", "dimension": 1536 },
  "reset_at": "2026-09-02T15:37:11.418Z",
  "moved_to": ".../vectordb/context.pre-reembed-20260902T153711Z",
  "awaiting_operator": ["companion"],
  "namespaces": { "reviewer": { "state": "completed", "rebuilt_records": 14, "failed_records": 0 }, "companion": { "state": "operator" } },
  "attempts": 1
}
```

`state` is about what the daemon itself can do: `none` (no migration on
record), `pending`, `failed`, `completed`, `unreadable` (a journal exists and
cannot be parsed — an operator looks), or `unknown` (the script could not be
loaded or read — never folded into `none`). `awaiting_operator` lists the
namespaces the daemon holds no key for; a `completed` state never hides them.
`config_drift` appears when `config.toml` and `ov.conf` disagree.

### The companion's namespace — the operator's half

The daemon never holds the companion key (root `CLAUDE.md` rule 8), so it
cannot rebuild `viking://user/companion`. You do, from the PC that holds both
user keys, over the memory forward:

```sh
scripts/qcr memory reembed                 # every provisioned user except the reviewer
scripts/qcr memory reembed --user companion,reviewer   # explicit; the reviewer is safe to repeat (upsert)
```

It prints the counts per namespace and, on success, the `settle` command that
receipts the journal on the VM so the heartbeat stops naming the namespace:

```sh
ssh my-vm sudo docker exec quickreview-sandbox \
  node /opt/quickreview/sandbox/scripts/openviking-reembed.mjs settle \
  --home /opt/quickreview/state/openviking --user companion
```

Until you do, companion memory is browsable (the TUI lists entries from the
files) but not searchable by similarity — nothing is lost, and nothing is
silently wrong: the heartbeat says so.

## An existing install that used the hosted embedder — what to run

This is the owner's own live install, and any adopter who deployed before
. Nothing needs to be run on the store by hand; the migration is the
boot. What the operator does, in order:

1. **Decide.** Local (the default; nothing to write) or keep hosted (write the
   opt-in: `embedding_provider = "openai"`, `embedding_model =
   "text-embedding-3-small"`, `embedding_dimension = 1536` in `config.toml`,
   the same three as host vars on the inventory line, and move the key into
   its own file: `bash deploy/collect-secrets.sh` → the
   `openai_embeddings_api_key` prompt. Keeping hosted means no re-embed at
   all — the collection already matches).
2. **Rehearse on a copy first** (below) if the store matters to you. It does
   here.
3. **Deploy** (`scripts/deploy.sh sync` — the entrypoint template and the
   script ride the sync; no image rebuild is needed for the embedder itself).
   The preflight refuses if `config.toml` and the inventory disagree.
4. **Watch the boot log**: `openviking: ov.conf rendered … embedder
   local/bge-small-zh-v1.5-f16 512 dims`, then `openviking: reembed prepare —
   RESET: … The old collection is kept at …`, then — once the daemon is up and
   `/ready` passes — `openviking: reembed of reviewer memory completed: N
   vector records rebuilt from M sources`. The heartbeat's
   `openviking.reembed.state` goes `pending` → `completed`.
5. **Rebuild the companion namespace from the PC** and receipt it (the
   section above).
6. **Rollback**, if ever needed: stop the container, restore the previous
   embedder in config/inventory, move `context.pre-reembed-<ts>` back to
   `context` (after moving the new `context` aside), delete `reembed.json`,
   start. Nothing was deleted, so this is a rename.

## Rehearsing on a copy

`rehearse` runs the whole migration — reset, a temporary server of its own,
the reindex, stop — against a copy of a store, and exits non-zero unless the
namespace completed. It needs an `openviking-server` binary with the local
embedder available (the VM image has one at
`/opt/openviking/venv/bin/openviking-server`; on a PC, the official image plus
`llama-cpp-python`, wrapped in a script that `exec`s `docker run … --network
host`, is the shape that was used to prove this path on 2026-09-02).

```sh
# 1. a COPY of the OpenViking home (ov.conf, workspace/, reembed.json if any)
rsync -a my-vm:/opt/quickreview/state/openviking/ /tmp/ov-rehearsal/
# 2. an ov.conf for the copy: the NEW embedder, a scratch port, the copy's workspace
#    (edit /tmp/ov-rehearsal/ov.conf: embedding.dense → local/bge-small-zh-v1.5-f16/512,
#     server.port → 19333, storage.workspace → /tmp/ov-rehearsal/workspace)
# 3. run it — strict: exit 0 means the reviewer namespace re-embedded with zero failures
node scripts/openviking-reembed.mjs rehearse \
  --home /tmp/ov-rehearsal --config /tmp/ov-rehearsal/ov.conf \
  --bin /path/to/openviking-server --port 19333 \
  --users reviewer,companion --user reviewer \
  --key-file ~/.config/quickreview-bot/openviking_reviewer_key
node scripts/openviking-reembed.mjs status --home /tmp/ov-rehearsal
```

What was proven this way against a real 0.4.15 with the local embedder
(2026-09-02, on a throwaway store seeded through a fake hosted endpoint): the
server refuses to start on the 1536-dim store under the local embedder;
`prepare` moves the collection aside and journals; the server starts clean on
the new collection; `resume` with the reviewer key rebuilds every reviewer
record (11 sources → 14 vector records, 0 failed) and is refused for the
companion namespace (403); the search that returned nothing on the reset store
returns the seeded entries again; a second `resume` is an idempotent no-op;
and `prepare` on the next boot is a no-op.

## Tests

- `tests/openviking-reembed.test.ts` — the script: the embedder records, the
  pure `planPrepare` decision, `prepare` on disk (aside, never deleted; the
  text untouched; refusals), the HTTP half over a fake fetch (Bearer user key,
  no actor-peer header, accepted → polled, 401/403/409/dead server/error
  envelope/deadline), `resume` journal in → journal out, `settle`, the CLI.
- `tests/openviking-reembed-driver.test.ts` — the daemon half: waits for
  `/ready`, one run at a time, the reviewer key from the secrets file, retry
  forever with attempts on record, honest `unknown`/`unreadable`, drift
  reporting, the heartbeat block, the real script through the driver, and
  `qcr memory reembed`'s helper.
- `tests/openviking.test.ts` and `tests/docker-daemon.test.ts` — the shipped
  default is local in every mirror, and the render heredoc is **executed**
  with the same group_vars/env the boot uses: the default `ov.conf` names no
  hosted provider and no key even with pi's key in the mount; the opt-in
  reads its own file; the migration check runs before provisioning.
- `tests/deploy.test.ts` — the preflight refuses config.toml ↔ ansible
  embedder drift, host vars included.
- `tests/onboard-embeddings.test.ts`, `tests/onboard-vmroute.test.ts`,
  `tests/collect-secrets.test.ts` — the wizard step, the inventory host vars,
  the `.env` mirror, the separate secret.
