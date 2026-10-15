# Memory embeddings — local by default, and how a store changes embedder

The memory engine (OpenViking) turns every memory entry, and every search
query, into a vector. **Where that happens is a sovereignty question**, and
the shipped answer is: **locally**, inside the daemon container. No key, no
account, and no memory text ever leaves the machine — nothing but the model
call does.

"Locally" means **the local English embedder**: a small English embedding
model (`bge-small-en-v1.5`, 384 dimensions) served on loopback by
`scripts/openviking-embedder.py`, instead of the engine's own built-in local
model, which is Chinese-first and runs on the server's only event loop.

This page is the operator's reference for the embedder. It covers the knob,
the local embedder and its pin, the hosted opt-in and its separate
credential, and the migration that runs when an existing store's embedder
changes. It also lists what to run on an install that predates the change.

## The knob

`config.toml [openviking]`:

```toml
embedding_provider  = "local"                  # the shipped default
embedding_model     = "bge-small-en-v1.5-f16"  # the local English embedder (384 dims)
embedding_dimension = 384
embedding_key_file  = "openai_embeddings_api_key"   # read only under a hosted provider
# the local embedder's model file (a rule-7 pin) and its service
local_embedder_file    = "/opt/openviking/models/bge-small-en-v1.5-f16.gguf"
local_embedder_url     = "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c04…/bge-small-en-v1.5-f16.gguf"
local_embedder_sha256  = "f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999"
local_embedder_port    = 1934
local_embedder_threads = 1
```

`config.toml` is the declaration. **The boot renders the embedder from
somewhere else**, so the two are kept in step and checked, never assumed to
agree:

| route | what the boot renders | who writes it | what checks it |
|---|---|---|---|
| laptop (compose) | `QCR_OPENVIKING_EMBEDDING_*` and the local embedder's `QCR_OPENVIKING_LOCAL_EMBEDDER_PORT` / `_THREADS` in the project `.env` (`docker-compose.yml` passes them in; the defaults are local, port 1934, one thread), plus the model, file and sha256 the image exports from its `LOCAL_EMBEDDER_*` build ARGs | the onboarding bring-up step mirrors `config.toml` on every bring-up | the daemon logs `EMBEDDER DRIFT` and reports `config_drift` in the heartbeat when ov.conf disagrees with `config.toml`; a port they disagree on leaves the embedder `off` with a reason that names the port, and memory health reads it as not serving |
| server (ansible) | `openviking_embedding_*` and `openviking_local_embedder_*`: the tracked `group_vars` (local), overridden by host vars on your inventory line | the onboarding inventory step writes a hosted opt-in as host vars; by hand, the same `key=value` tokens on the host line | `scripts/deploy.sh` **refuses to deploy** when `config.toml` and the effective ansible value disagree |

The refusal matters. If `config.toml` says `openai` and the boot renders
`local`, the boot's migration check (below) resets the vector store for the
wrong embedder on the next start.

Under `local`, the model and the dimension belong to the local embedder. The
config loader refuses any other values, with one exception: a config that
still spells the engine's built-in model (`bge-small-zh-v1.5-f16` / `512`,
which earlier releases required) loads as the local English embedder rather
than stopping the daemon (`RETIRED_LOCAL_EMBEDDING` in `src/config.ts`).
Under `local` the boot renders the pinned model whatever the generic knobs
say, and logs a line when they disagree. Under `openai`, name the hosted model
and its dimension (`text-embedding-3-small` / `1536` are the defaults the
wizard writes).

## The local English embedder

### What runs

`scripts/openviking-embedder.py` is an OpenAI-compatible
`POST /v1/embeddings` on `127.0.0.1:1934`. It runs under the OpenViking venv's
python, over the `llama-cpp-python` already pinned there, from one GGUF file
baked into the image. The script:

- **binds loopback only.** A non-loopback `--host` is refused, and neither the
  playbook nor the compose file publishes the port.
- **serves the pinned file only.** It hashes the file at every start and
  refuses (exit 3) unless the hash is the pin. A model its own table does not
  know is refused too (exit 2), and so is a request naming another model
  (`404 model_not_found`), so a misconfigured ov.conf is loud.
- **tells queries from documents.** ov.conf sets `query_param: "query"` and
  `document_param: "passage"`, so the engine sends `input_type` in the body.
  A query gets BAAI's retrieval instruction ("Represent this sentence for
  searching relevant passages: ") and is cut to **128 tokens**, the
  one-thread latency budget. A document gets no prefix and the model's whole
  512-token context. A cut never splits a token and keeps the special tokens.
- **answers in float or base64.** The OpenAI SDK the engine uses asks for
  base64 by default (little-endian float32); vectors are L2-normalised.

ov.conf reaches it through the engine's **OpenAI-compatible** provider:

```json
"dense": {
  "provider": "openai", "model": "bge-small-en-v1.5-f16", "dimension": 384,
  "api_base": "http://127.0.0.1:1934/v1",
  "query_param": "query", "document_param": "passage", "input": "text"
}
```

`provider: "openai"` is the wire format, not a destination. There is no key,
and the only URL in ov.conf is loopback. That provider is the engine's
**asynchronous** embedder, so a search waits on a socket instead of running a
model on the server's event loop. 0.4.15's own `local` provider had three
faults: one model only (`bge-small-zh-v1.5`, Chinese-first), a Chinese query
instruction hard-wired onto every English query, and a synchronous embed on
the one event loop. Through that last fault a single search stalls every
other request (measured on the live store: search p50 22 s, max 155 s).

### Who runs it

- **The daemon**, as a second supervised child (`src/openviking/embedder.ts`),
  started before the server. The server's **first** start waits for the
  embedder to answer `/health`, for at most 120 s, then starts anyway and says
  so: the server's `/ready` probes the embedder, so an early server would only
  sit not-ready. A crash respawns on the server's backoff ladder, forever.
  The daemon starts the embedder **only when it is the embedder in use**:
  `config.toml` says `local` AND the rendered ov.conf's `api_base` is this
  config's loopback URL. Otherwise nothing is spawned, and the heartbeat says
  why: a hosted opt-in, or an ov.conf from an image that predates the local
  embedder (that case asks for `scripts/deploy.sh rebuild`). A missing interpreter, script or
  model file is reported once and never retried, like the server's binary on
  a dev PC.
- **Boot provisioning** (`scripts/openviking-provision.mjs`, `--embedder-*`
  flags the entrypoint passes under `local`). Its temporary server needs
  `/ready` too, so the step starts the embedder first and stops it after the
  server, inside the same foreground step.
  - An embedder that refuses to start (a sha256 mismatch exits in under a
    second) ends the wait at once.
  - Users and keys are still provisioned when `/ready` fails on nothing but
    its embedding check, because the admin API embeds nothing. The report
    records the embedder's failure.
  - With its embedder unreachable, a real 0.4.15 answers `/ready` only after
    ~9.5 s, so that call is given 15 s.
- **`rehearse`** (`scripts/openviking-reembed.mjs`, the same `--embedder-*`
  flags), for a copy of a store.

### The heartbeat block

`state/status.json` → `openviking.embedder`:

```json
{ "state": "supervised", "model": "bge-small-en-v1.5-f16", "port": 1934, "threads": 1,
  "running": true, "ready": true, "restarts": 0, "pid": 412,
  "started_at": "…", "checked_at": "…", "rss_bytes": 98123776, "cpu_pct": 0.4 }
```

`state` is `supervised`, `off` (with `reason`) or `unavailable` (with
`reason`). While the server waits for it, `openviking.waiting_for` names the
wait. A dead embedder fails searches and new vectors, not the server. The
server's own `/ready` then goes false (it probes the embedder), so
`openviking.ready` says so.

### When it fails, a person hears it

Memory health's authenticated probe is an `fs/ls`, and that call needs no
embedding, so on its own the probe would read memory as healthy while a dead
embedder failed every search. Memory health therefore also reads
whether memory **serves**: `memoryServing` in `src/openviking/embedder.ts`,
from the two supervisors' cached statuses.

- **Not serving:**
  - under `local`, an embedder that is `unavailable`, or supervised but not
    answering (crash-looping, refused to start, still starting);
  - any server that answers `/health` but fails `/ready`, for example an
    ov.conf routed to a port nothing serves, or a hosted embedder that
    refuses.
- **Unknown:** a server that does not answer at all. The authenticated probe
  judges that case.
- **Serving:** anything else. An ov.conf from an older image, where the
  engine still embeds itself, serves as long as `/ready` passes.

Memory that answers but does not serve reads **degraded** at once. After
10 minutes (`[memory] down_after_min`) it reads **down** and wakes
`memory_down`, which names the embedder, exactly as an outage with no answer
would. A drain defers that wake the same way.

Where a person sees it:

- status.json `memory.serving` (`ok`, `since`, `reason`) and
  `memory.down_cause` (`not_serving` or `unanswered`);
- `qcr status`;
- the TUI board banner ("search not serving");
- the desktop alert;
- the 2-hour tracker ticket, which points at the `embedder` block;
- the companion's view.

A measured `ok: true` is the only thing that ends a not-serving run.

### The pin (rule 7)

The model file is a pin like the server version. There are three mirrors,
each checked:

| where | spelling |
|---|---|
| `config.toml [openviking]` | `local_embedder_file` / `_url` / `_sha256` (and `_port` / `_threads`) |
| `deploy/ansible/group_vars/all.yml` | `openviking_local_embedder_model` / `_dimension` / `_dir` / `_url` / `_sha256` / `_port` / `_threads` |
| the image | a layer in `Dockerfile.j2` (interpolating the group_vars) and in `docker/daemon/Dockerfile` (its `LOCAL_EMBEDDER_*` ARG defaults) |

The model layer downloads the file **at build time** and fails the build
unless `sha256sum -c` passes, so a running container never fetches a model
(the engine's built-in local provider downloads its model at first start).
The URL names a Hugging Face commit, never a branch. `tests/openviking.test.ts`
and `tests/docker-daemon.test.ts` refuse drift between the mirrors, and so
does the `scripts/deploy.sh` preflight, which also names the pin in its plan.
**Changing the pin needs `scripts/deploy.sh rebuild`**: the playbook's
stale-image guard refuses a `sync` whose Dockerfile or entrypoint changed. The model's name and dimension also live in
code (`LOCAL_EMBEDDING` in `src/config.ts`, the service's model table, the
re-embed script's `LOCAL_EMBEDDER`), and `tests/openviking-embedder.test.ts`
holds them together.

### Why this model — the evaluation

The model was chosen by a small offline retrieval evaluation on 2026-10-07.

- **Setup.** The pinned `llama-cpp-python 0.3.35`. The corpus was the 176
  scrubbed reviewer-memory entries. There were 30 hand-written queries in the
  shape a round's context search sends (`<PR title> — <areas> <exts>`), each
  labelled with the entries a reviewer would want surfaced. Every model saw
  the same corpus and queries, with whole entries embedded as documents.
- **Who labelled.** The queries and their labels were written by the
  implementing agent, not by a reviewer. Treat the differences as large,
  never as precise.

| model (GGUF) | dims | size | MRR@10 | R@1 | R@5 | nDCG@10 | AUC¹ | round query, 1 thread² |
|---|---|---|---|---|---|---|---|---|
| bge-small-zh-v1.5-f16 (the engine's built-in) | 512 | 48 MB | 0.34 | 0.23 | 0.39 | 0.35 | 0.84 | 21 ms |
| **bge-small-en-v1.5-f16 (chosen)** | 384 | 67 MB | **0.56** | 0.40 | **0.77** | 0.61 | **0.93** | **24 ms** |
| bge-small-en-v1.5-f16, no query instruction | 384 | 67 MB | 0.48 | 0.37 | 0.67 | 0.52 | 0.89 | 20 ms |
| bge-small-en-v1.5-q8_0 | 384 | 37 MB | 0.57 | 0.40 | 0.76 | 0.62 | 0.93 | 32 ms |
| bge-base-en-v1.5-q8_0 | 768 | 118 MB | 0.64 | 0.57 | 0.71 | 0.66 | 0.93 | 116 ms |
| nomic-embed-text-v1.5-Q8_0 (task prefixes) | 768 | 146 MB | 0.57 | 0.47 | 0.72 | 0.60 | 0.92 | 137 ms |

¹ The probability that a labelled entry outscores an unlabelled one: the
separation the old model lacked (its scores sat in a flat 0.48–0.66 band).
² p50 over the 30 round queries, three times each, warm, on ONE thread with
the 512-token context the service runs (a round query is 26–54 tokens with
its prefix). Every model in this column was measured in one run of one
harness. Single runs on this shared machine vary by about a third, so read the
column as tiers: the small models take 20–30 ms, and bge-base and nomic take
about five times that. For the chosen model, a query cut to 128 tokens (the
cap) took about 90 ms in that run, and a 512-token one took 520–750 ms across
runs. That is why queries are capped at 128 tokens.

**Why bge-small-en-v1.5-f16:**

- It is the only candidate inside the ~100 ms one-thread budget that also
  roughly doubles recall over the old model (R@5 0.39 → 0.77).
- bge-base ranks a little better at the top (R@1 0.57). But it takes about
  five times as long per query (116 ms against 24 ms, p95 139 ms), which is
  over the budget, and it is no better at R@5.
- nomic is slower still, and no better.
- f16 over q8_0: the quality is the same, f16 was the faster of the two on
  this CPU, and it is the reference precision.
- The query instruction is worth keeping (MRR 0.48 → 0.56).
- Licence: MIT.

**Proven against a real 0.4.15.** The test ran from a scratch venv with
`openviking==0.4.15` and the pinned `llama-cpp-python`:

- A store was seeded under the built-in model (19 entries). On the new
  ov.conf, `prepare` moved it aside (512 → 384) and the server became ready
  on the new collection, with its `/ready` probing the service.
- `resume` with the reviewer key rebuilt 27 vector records from 24 sources,
  0 failed, in 7 s.
- A migration query that had ranked a cache lesson first under the
  old model now returned the two migration lessons first (scores 0.72 and
  0.70).
- A fresh write was vectorized and found at the top (0.78).
- `fs/ls` answered in 4–14 ms while six searches ran.
- The next boot's `prepare` was a no-op.

## The hosted opt-in, and why its credential is a separate file

`embedding_provider = "openai"` sends every memory entry's text and every
search query to OpenAI's embeddings endpoint. It is an opt-in, never a
fallback: a hosted provider whose key file is missing is rendered **without**
a key, so the server refuses to start (memory degrades, loudly) rather than the
boot silently switching embedder — which would reset the store. The daemon
does not start the local embedder under a hosted provider; the image still
carries its model, so coming back to local needs no rebuild.

The credential is `<secrets dir>/openai_embeddings_api_key` (the
`embedding_key_file` knob), collected by `bash deploy/collect-secrets.sh` at
its own prompt, 0600, and copied to the VM by the playbook if present.
**`openai_api_key` is pi's model credential and is never read for
embeddings.** Keeping them in separate files means either can exist without
the other: leaving the embeddings key unset never unsets pi's credential on
the API-key route.

The onboarding wizard's embeddings step (order 38) writes the opt-in and
stays red until that file exists — and never accepts the value through the
session.

## What runs when the embedder changes

A new embedder means a new vector space. The local English embedder is 384
dimensions, the engine's built-in model was 512 and hosted
`text-embedding-3-small` is 1536. A collection built under one cannot be read
by another, and OpenViking 0.4.15 refuses to start on such a store:

```
EmbeddingRebuildRequiredError: Existing collection embedding dimension (512)
does not match current configuration (384). Vectors are incompatible;
rebuild is required.
```

The rule: **re-embed, never pin the old setting and never wipe**. `scripts/openviking-reembed.mjs` is the whole migration, in two halves
that the code — not an operator — sequences:

1. **`prepare` — disk, server down.** The container entrypoint runs it right
   after rendering `ov.conf` and *before* boot provisioning starts a server.
   It reads the collection's own embedding record
   (`workspace/vectordb/context/collection_meta.json`, the same record the
   server checks) and compares it with `ov.conf`, both spelled as the engine
   spells them. The local English embedder's record is
   `openai/bge-small-en-v1.5-f16 (384)`: the engine stores its wire provider,
   and the loopback `api_base` is not part of the record (the daemon checks
   it separately, below). On a match, or on a fresh install with no
   collection yet, it is a no-op in milliseconds — every boot.
   On a mismatch it writes the journal `reembed.json` beside `ov.conf` — the
   reviewer's namespace as `pending`, every other provisioned namespace (the
   companion's) as `operator` — and only then **moves the collection aside**
   to `context.pre-reembed-<timestamp>` (kept — that directory is the
   rollback). The journal goes first so an interrupted prepare never leaves a
   moved collection with no rebuild on record; a move that fails puts the
   journal back as it was, and a journal whose `moved_to` does not exist is
   read as a reset interrupted before its move, which the next prepare
   finishes. It refuses — never guesses — when the metadata is unreadable,
   when a server is answering on the port, when the journal is unreadable or
   cannot be written, or when a reset for this same embedder already happened
   and the collection still disagrees (a loop guard; a journal from an earlier
   migration to a different embedder does not trip it).
2. **`resume` — HTTP, server up.** The daemon (`src/openviking/reembed.ts`)
   runs it once `/ready` passes, with the **reviewer user key** — the same key
   every review session holds, which the server confines to
   `viking://user/reviewer` (a 403 for anything else, verified live). It calls
   `POST /api/v1/content/reindex` (`mode: vectors_only`, an idempotent upsert)
   and follows the task to completion. Under the local embedder every rebuilt
   vector is a call to the loopback service, so the server's `/ready` (which
   probes it) is also the gate that the service is up. The namespace is
   `completed` only when the task finished with **zero failed records**; a
   partial rebuild, a busy server or a deadline leave it `failed`/`pending`
   with the counts on record, and the daemon retries every five minutes,
   forever, each attempt logged and in the heartbeat. A daemon restart
   mid-run simply runs it again.

The memory **text** (`workspace/viking/…`) is never touched by either half;
only vectors are rebuilt. Rounds keep running throughout — memory context
assembly degrades to a thinner block while vectors rebuild and never blocks a
round.

### The heartbeat

`state/status.json` → `openviking.reembed`:

```json
{
  "state": "completed",
  "embedder": { "provider": "openai", "model": "bge-small-en-v1.5-f16", "dimension": 384 },
  "previous": { "provider": "local", "model": "bge-small-zh-v1.5-f16", "dimension": 512 },
  "reset_at": "2026-10-07T09:00:11.418Z",
  "moved_to": ".../vectordb/context.pre-reembed-20261007T090011Z",
  "awaiting_operator": ["companion"],
  "namespaces": { "reviewer": { "state": "completed", "rebuilt_records": 214, "failed_records": 0 }, "companion": { "state": "operator" } },
  "attempts": 1
}
```

`state` is about what the daemon itself can do: `none` (no migration on
record), `pending`, `failed`, `completed`, `unreadable` (a journal exists and
cannot be parsed — an operator looks), or `unknown` (the script could not be
loaded or read — never folded into `none`). `awaiting_operator` lists the
namespaces the daemon holds no key for; a `completed` state never hides them.
`config_drift` appears when `config.toml` and `ov.conf` disagree. Both sides
are spelled as ov.conf spells them: under `local`, the wire provider plus the
local embedder's `api_base`, so the right model at the wrong port is drift
too.

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
ssh <host> sudo docker exec quickreview-sandbox \
  node /opt/quickreview/sandbox/scripts/openviking-reembed.mjs settle \
  --home /opt/quickreview/state/openviking --user companion
```

Until you do, companion memory is browsable (the TUI lists entries from the
files) but not searchable by similarity — nothing is lost, and nothing is
silently wrong: the heartbeat says so.

## Moving an install to the local English embedder — what to run

This covers every install that ran the engine's built-in local model, the
live one included. Nothing is run on the store by hand: the migration is the
boot. In order:

1. **Leave `config.toml`'s model as it is.** Under `local`, the previous
   release REQUIRED `embedding_model = "bge-small-zh-v1.5-f16"` /
   `embedding_dimension = 512`, and it refuses the new spelling at load. Both
   the daemon's parser and the deploy preflight read the old spelling as
   `bge-small-en-v1.5-f16` / 384 (the preflight says so in one note line), so
   the same file loads on both releases and a rollback of the code never
   strands the config. Optionally copy the five
   `local_embedder_*` keys from `config.example.toml` — the previous release
   ignores unknown keys — so the preflight verifies the model-file pin rather
   than noting that the code defaults apply. Spell the new model only once the
   previous release is gone for good; from then on, a rollback must revert
   `config.toml` together with the code.
2. **Rehearse on a copy first** (below) if the store matters to you. It does
   here.
3. **Deploy with `scripts/deploy.sh rebuild`, not `sync`.** The model file and
   the entrypoint that renders the new ov.conf ride the image, and the
   playbook's stale-image guard refuses a `sync` whose Dockerfile or
   entrypoint changed. On compose, `docker compose build` first.
4. **Watch the boot log.**
   - The render: `openviking: ov.conf rendered … embedder
     openai/bge-small-en-v1.5-f16 384 dims at http://127.0.0.1:1934/v1`.
   - `prepare`: `openviking: reembed prepare — RESET: the collection was built
     under local/bge-small-zh-v1.5-f16 (512 dims), ov.conf configures
     openai/bge-small-en-v1.5-f16 (384 dims) … The old collection is kept at …`.
   - Provisioning: `openviking-embedder: ready — bge-small-en-v1.5-f16 (384
     dims, sha256 verified, 1 thread)`.
   - The daemon: `openviking: local embedder started`, then `local embedder
     ready`, then `the local embedder is ready — starting the server`.
   - Once `/ready` passes: `openviking: reembed of reviewer memory completed`.

   In the heartbeat, `openviking.embedder.state` is `supervised` with
   `ready: true`, and `openviking.reembed.state` goes `pending` →
   `completed`.
5. **Rebuild the companion namespace from the PC** and receipt it (the
   section above).
6. **Rollback**, if ever needed — prefer the boring route:
   1. Check out the previous release, with `config.toml` reverted with it if
      it was edited (left as step 1 says, it needs nothing).
   2. `scripts/deploy.sh rebuild`. The previous release's boot `prepare`
      sees a collection built under `openai/bge-small-en-v1.5-f16` (384) and
      an ov.conf configuring the built-in local model (512): it RESETS the
      collection and journals the reviewer namespace pending, and its daemon
      re-embeds ALL of reviewer memory — everything written since the deploy
      included. Rebuild the companion namespace from the PC with `qcr memory
      reembed --user companion`, as in the section above.
   3. Before starting the previous code, take the memory tree back to a shape
      it reads: see "Rolling back the code" in
      `docs/memory-context-engine.md` ("Deploy and verify") — the finding
      cases and the pinned area need a step of their own.

   The manual rename route (stop; move the new `context` aside; move the
   NEWEST `context.pre-reembed-<ts>` back to `context` — the volume may also
   hold an older one from an earlier migration, which is not it; delete
   `reembed.json`;
   start) restores only the vectors of records that existed at the deploy's
   reset. Everything written since — curator lessons, `events/` entries, the
   relayout's moves, the finding cases — then has NO vectors under the
   restored embedder and nothing re-embeds it: invisible to search. If you
   take that route anyway, finish from the PC with `scripts/qcr memory reembed
   --user companion,reviewer` (an upsert: safe on records that kept their
   vectors).

If the daemon reports `openviking.embedder.state = "off"` with the reason
"ov.conf does not route embeddings to http://127.0.0.1:1934/v1 … rebuild",
the image predates the change: new code is running on the old entrypoint.
Memory keeps working on the old model, and the heartbeat carries
`EMBEDDER DRIFT`. Rebuild.

## An existing install that used the hosted embedder — what to run

This covers any install that still runs the hosted embedder (the default
before local was).
In order:

1. **Decide.** Local is the default and needs nothing written. To keep
   hosted, write the opt-in:
   - in `config.toml`: `embedding_provider = "openai"`,
     `embedding_model = "text-embedding-3-small"`,
     `embedding_dimension = 1536`;
   - the same three as host vars on the inventory line;
   - the key in its own file: `bash deploy/collect-secrets.sh` → the
     `openai_embeddings_api_key` prompt.

   Keeping hosted means no re-embed at all: the collection already matches.
2. **Rehearse on a copy first** (below) if the store matters to you.
3. **Deploy with `scripts/deploy.sh rebuild`.** On the server route the
   embedder knobs are rendered into the entrypoint that is baked into the
   image, so any change to them is a rebuild: the stale-image guard refuses a
   `sync` whose entrypoint changed. The preflight refuses if `config.toml`
   and the inventory disagree.
4. **Watch the boot log** as in the section above. The `prepare` line says
   `built under openai/text-embedding-3-small (1536 dims)`.
5. **Rebuild the companion namespace from the PC** and receipt it.
6. **Rollback**: the same rename as above.

## Rehearsing on a copy

`rehearse` runs the whole migration against a copy of a store: the reset, a
temporary server of its own (and, under the local embedder, the service
beside it), the reindex, then stop. It exits non-zero unless the namespace
completed. It needs an `openviking-server` binary and, for the local
embedder, the venv python with `llama-cpp-python` and the GGUF. The VM image
has all three under `/opt/openviking/`. On a PC, a scratch venv works:
`uv venv --python 3.12` + `uv pip install openviking==0.4.15
llama-cpp-python==0.3.35`, plus the GGUF from the pinned URL.

```sh
# 1. a COPY of the OpenViking home (ov.conf, workspace/, reembed.json if any)
rsync -a <host>:/opt/quickreview/state/openviking/ /tmp/ov-rehearsal/
# 2. an ov.conf for the copy: the NEW embedder, a scratch port, the copy's workspace
#    (edit /tmp/ov-rehearsal/ov.conf: embedding.dense → the dense block above with
#     api_base http://127.0.0.1:19334/v1, server.port → 19333,
#     storage.workspace → /tmp/ov-rehearsal/workspace)
# 3. run it — strict: exit 0 means the reviewer namespace re-embedded with zero failures
node scripts/openviking-reembed.mjs rehearse \
  --home /tmp/ov-rehearsal --config /tmp/ov-rehearsal/ov.conf \
  --bin /path/to/venv/bin/openviking-server --port 19333 \
  --users reviewer,companion --user reviewer \
  --key-file ~/.config/qcr/default/secrets/openviking_reviewer_key \
  --embedder-python /path/to/venv/bin/python \
  --embedder-script scripts/openviking-embedder.py \
  --embedder-model bge-small-en-v1.5-f16 \
  --embedder-file /path/to/bge-small-en-v1.5-f16.gguf \
  --embedder-sha256 f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999 \
  --embedder-port 19334 --embedder-threads 1
node scripts/openviking-reembed.mjs status --home /tmp/ov-rehearsal
```

The `--embedder-*` flags are all-or-none: a partial set is refused before
anything on disk moves.

This path was proven twice against a real 0.4.15:

- **2026-09-02, hosted → built-in local**, on a throwaway store seeded
  through a fake hosted endpoint.
  - The server refused to start on the 1536-dim store.
  - `prepare` moved the collection aside and journalled, and the server
    started clean on the new collection.
  - `resume` with the reviewer key rebuilt every reviewer record (11 sources
    → 14 vector records, 0 failed). It was refused for the companion
    namespace (403).
  - The search that returned nothing on the reset store returned the seeded
    entries again.
  - A second `resume` was a no-op, and so was `prepare` on the next boot.
- **2026-10-07, built-in local → the local English embedder** (above).

## Tests

- `tests/openviking-embedder.test.ts` — the service RUN as a real python
  process over a fake `llama_cpp`:
  - its model table against `LOCAL_EMBEDDING`;
  - the refusals: not loopback, an unknown model, a wrong dimension, a
    wrong sha256, a missing file;
  - the OpenAI contract: float and base64, a 404 for another model,
    query/document prefixes, the 128-token query cut and 512-token document
    cut, lists, bad requests;
  - one argv for the boot scripts and the daemon, and the boot's start
    helper.
- `tests/openviking-embedder-supervisor.test.ts` — the daemon's supervisor:
  - it runs only when ov.conf routes to the embedder, and always says why
    not;
  - a missing file is reported once;
  - readiness, the restart ladder and stop;
  - the server's bounded start gate, which never holds for an embedder that
    will not come;
  - the heartbeat block.
- `tests/openviking-reembed.test.ts` — the script:
  - the embedder records and the pure `planPrepare` decision;
  - `prepare` on disk: aside, never deleted, the text untouched, the
    refusals;
  - the HTTP half over a fake fetch: Bearer user key, no actor-peer header,
    accepted → polled, 401/403/409/dead server/error envelope/deadline;
  - `resume` journal in → journal out, `settle`, the CLI;
  - the move from 512 to 384 with an earlier migration's journal on record,
    and
    `rehearse`'s embedder flags.
- `tests/openviking-reembed-driver.test.ts` — the daemon half:
  - it waits for `/ready`, runs one at a time, and reads the reviewer key
    from the secrets file;
  - it retries forever with the attempts on record, and reports `unknown`
    and `unreadable` honestly;
  - drift reporting, including the loopback `api_base`, an ov.conf from an
    older image, and a trailing slash;
  - the heartbeat block, the real script through the driver, and
    `qcr memory reembed`'s helper.
- `tests/openviking.test.ts` and `tests/docker-daemon.test.ts`:
  - the shipped default is local in every mirror, and the local embedder's
    pin agrees across config.toml, group_vars and both Dockerfiles;
  - the render heredoc is **executed** with the same group_vars/env the boot
    uses. The default `ov.conf` names only loopback and no key, even with
    pi's key in the mount, and matches what the daemon's drift check
    expects. A stale model knob under `local` is ignored, said aloud.
  - the opt-in reads its own file;
  - the migration check runs before provisioning, and provisioning runs the
    embedder only under `local`.
- `tests/deploy.test.ts` — the preflight refuses config.toml ↔ ansible
  embedder drift, host vars included, and local-embedder pin drift (file,
  URL, sha256, port, threads).
- `tests/onboard-embeddings.test.ts`, `tests/onboard-vmroute.test.ts`,
  `tests/collect-secrets.test.ts` — the wizard step (and a config from
  before the change), the inventory host vars, the `.env` mirror, the
  separate secret.
