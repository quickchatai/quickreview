# Reviewer memory

The reviewer keeps a durable, human-curatable memory: what past reviews
concluded, what turned out to be a false positive, what the operator wants
standing in front of every round. It is **authored, never extracted** — no
model summarises the conversation into memory behind your back — and it is a
**soft dependency**: a round whose memory could not be read still runs, still
posts, and still decides on the merits.

This page is the map of that subsystem: the seam every caller talks to, the
engine behind it, how a round is seeded, who writes into it, and how the keys
are confined. Read it before touching anything under `src/memory/`,
`src/openviking/`, or the memory surfaces of the TUI.

Siblings: [overview](./overview.md) · [lifecycle](./lifecycle.md) ·
[sessions](./sessions.md) · [data model](./data-model.md) ·
[boundaries](./boundaries.md). Embedder configuration and the re-embed
migration have their own page: [../memory-embeddings.md](../memory-embeddings.md).

## Where to look

| You want | Read |
|---|---|
| The vocabulary every caller speaks (entries, ops, refusals) | `src/memory/store.ts` |
| Round seeding — pinned head + one budgeted block | `src/memory/context.ts` |
| The `#tag` / `k=v` entry header, one parser only | `src/memory/eventtags.ts` |
| The layout: areas, the pinned area, the curator's layout note | `src/memory/layout.ts` |
| The one-off relayout of a flat store (`qcr memory relayout`) | `src/memory/relayout.ts` (the plan), `src/openviking/relayout.ts` (the run) |
| A PR session's identity, credential file and raw-notes tier | `src/memory/ovsession.ts` |
| The one-time import from the archived file engine | `src/memory/import.ts`, `src/memory/legacy-file.ts`, `scripts/import-pi-memory.mjs` |
| The engine process: spawn, restart ladder, heartbeat block | `src/openviking/supervisor.ts`, `proc.ts`, `types.ts` |
| The health gate (`/health`, `/ready`) — unauthenticated: is the server up | `src/openviking/health.ts` |
| Memory HEALTH — does memory work with the credentials in use, and who is told | `src/memory/health.ts`, `src/openviking/probe.ts`, `src/openviking/provisionreport.ts`, `src/tui/memincident.ts` |
| HTTP: the single write route, determinism pins, auth | `src/openviking/client.ts` |
| `MemoryStore` over the engine (entries as files, pin/unpin as moves, retire, the pinned-area read) | `src/openviking/store.ts` |
| `ContextAssembler` over the engine (head + block) | `src/openviking/context.ts` |
| The local embedder, embedder knob, re-embed migration | `src/openviking/embedder.ts`, `scripts/openviking-embedder.py`, `src/openviking/reembed.ts`, `scripts/openviking-reembed.mjs` |
| The daily curation sweep and its clock | `src/eod.ts` |
| The pinned-area watchdog around that sweep | `src/eodpinwatch.ts` |
| The `[feedback]` tuning loop | `src/feedback.ts` |
| The per-finding reasoning record (adjacent, not memory) | `src/findingsrecord.ts` |
| The daily digest file and its headline | `src/digest.ts` |
| The operator's memory tab and its two keys | `src/tui/memtab.ts`, `src/tui/memory.ts` |
| The forward that lets the PC reach the engine | `scripts/companion-memory-forward.mjs`, `src/tui/memforward.ts` |
| Where it is all wired together | `src/wire.ts` |

## Two layers, and the line between them

```
callers ── daemon round path · [feedback] sink · EOD curator · TUI verbs · auto-filer
              │
              │  the SEAM  — src/memory/*.ts   (entries, ops, MemoryRead; no HTTP anywhere)
              ▼
           MemoryStore / ContextAssembler
              │
              │  the ENGINE — src/openviking/*.ts  (the only code that knows HTTP)
              ▼
           OpenViking server, a supervised child process on loopback :1933
```

Nothing in `src/memory/` knows that memory is an HTTP server; nothing above
`src/openviking/client.ts` knows the wire format. The seam has exactly one
`MemoryStore` implementation (`src/openviking/store.ts`). The only other
implementation of anything in the seam is `MemorySource` — read-only, over the
archived file of the earlier file-based engine, kept so the one-time import can still see
what it is importing (`src/memory/legacy-file.ts`).

## The seam

### Vocabulary and write contract — `src/memory/store.ts`

A `MemoryEntry` is addressed by `(id, ts, block)` and carries a `hash` the
store computed. `refOf(entry)` turns a listed entry into a `MemoryRef` — the
address plus `expect`, the hash the caller last saw.

Four shape decisions are load-bearing:

- **Async everywhere.** The engine is an HTTP server; a synchronous signature
  would be a lie.
- **One `apply(op)`, not six verb methods.** `MemoryOp` is a discriminated
  union: `retire`, `pin`, `unpin`, `edit`, `add`, `note`. Every writer funnels
  through one serialized mutation path.
- **Writes resolve, they do not reject.** `apply` returns
  `{ ok, message }`. A stale hash, a dead server and a refused namespace are
  all ordinary answers a caller renders to the operator. Only a broken
  transport throws — and the implementation makes sure it does not.
- **Every addressed op carries `expect`.** Memory has other writers (a live
  session writes its own memories, the operator edits in the TUI), so a
  mutation aimed at content the store no longer holds is refused rather than
  applied to whatever moved into its place.

`add` and `note` are a real distinction: `add` is the operator typing an entry
(the store tags it `#manual`), `note` is a machine writer appending an entry
that already carries its own tags and must be stored verbatim. Collapsing them
would let the daemon's `#feedback` lines masquerade as the operator's words.

A `note` may carry a deterministic address: `name` plus
`category` (the area — `events` for signals). It is then created at exactly
that address or not at all: a replay of the same bytes is a plain success
(the engine answers "unchanged"), and an entry already there with other bytes
is kept and reported `existed` — never overwritten, never duplicated. That is
what makes a writer's retry idempotent when a write landed but its answer was
lost. A write result may name the entry's engine address (`uri`); the
optional `uriOf(id)` gives the same address for an entry found by reading.

`ensureWritable()` is optional on the interface and implemented only by the
OpenViking store — see [Materializing a namespace](#materializing-a-namespace).

### Entry headers — `src/memory/eventtags.ts`

The seam carries **text**, not a tag map, so tags ride inside the entry as a
leading run: `#hash #tags k=v k=v prose…`.

- `parseHashTags` takes the leading run of `#tag` tokens and **stops at the
  first word that is not one**.
- `parseEventTags` reads the `k=v` run after it, same header-only rule.
- `formatEventTags` writes it back in declaration order.

Header-only is a security property, not tidiness. A feedback entry quotes an
untrusted PR comment verbatim; if the scan were full-text, a comment
containing `#pinned` would place attacker-chosen prose into the guaranteed
head of every round prompt — the highest-trust position in the system.

There is one parser and one writer for this vocabulary because the store, the
curator, the `[feedback]` sink and the TUI auto-filer all read it; a second
parser would be free to disagree about exactly the case above.

### The layout — `src/memory/layout.ts`

The memory areas, under `viking://user/<user>/memories/`:

| Area | Holds | Written by |
|---|---|---|
| `preferences/pinned/` | the guaranteed head — the owner's standing instructions, in every round | the pin verb (the TUI's `p`, the companion's `memory_pin` action) |
| `preferences/` | unpinned standing instructions — the owner's own words (`#manual`) | the TUI's `n`, an unpin |
| `experiences/` | curated lessons, conventions, setup/scan notes — the only area a round's context block searches | the EOD curator, setup, scans |
| `finding-cases/` | the daemon's finding cases (`src/cases.ts`); never searched by a round | the case writer |
| `events/` | feedback, bug and ops signals with `k=v` tags (`kind=feedback|bug|ops`) | the `[feedback]` sink, the curator (`kind=bug`) |

**Pinned is placement.** An entry is pinned because it sits in
`preferences/pinned/` — never because of a tag: an address is chosen by the
writer of the file, so no text quoted inside an entry can put it in the head.
A new entry written through the seam lands where its writer says (a `note`'s
`category`) or, naming none, where its own header-only tags say (`#pinned` →
the pinned area, `#manual` → `preferences/`, else the default area,
`areaForNewEntry`). The curator learns the layout from a section the daemon
renders after the frozen `eod-sweep.md` seed (`MEMORY_LAYOUT_NOTE`, via
`renderEodPrompt`'s `memoryLayout`). The seed names `events/`,
`experiences/` and `preferences/pinned/` itself; the note only adds where the rest lives, and
`tests/eod-seed-coherence.test.ts` fails if it says anything against the seed.

### Round seeding — `src/memory/context.ts`

`ContextAssembler` is the round path's whole relationship with memory:

```ts
pinnedHead(): Promise<MemoryRead>
contextBlock(query, { maxTokens, onSent?, timeoutMs? }): Promise<MemoryRead>
```

`MemoryRead` is `{ status: "read", text }` or `{ status: "unreadable", reason }`.
That split is the point of the type: **empty is not degraded.** A store with
nothing pinned yet has *answered*; a store that could not be reached has not.
Collapsing both into `""` would make every fresh install look broken and alarm
the operator about a healthy system.

`assembleRoundMemory(assembler, query, opts)` is total by construction. It:

1. calls each method **exactly once**, both in flight together, so the seed
   costs one round trip of latency rather than two;
2. wraps each in `guarded(...)`, which turns a timeout, an `unreadable`
   answer, a rejection, a synchronous throw, or a settled value that is not a
   `MemoryRead` at all into `""` plus a `MemoryGap`;
3. clamps an over-budget block at `maxTokens × charsPerToken` and says so;
4. returns a `RoundMemory` whose `degraded` is exactly `gaps.length > 0`.

Defaults (`ROUND_CONTEXT_DEFAULTS`): 2000 tokens, a 9000 ms deadline for the
whole seed (long enough to cover a document embedding on a loaded VM), 3000 ms
of it reserved for the search, 6 chars/token for the
defensive clamp, 600 chars of query. The configured knobs are `[memory]
context_tokens`, `context_timeout_ms` (clamped 100…15000), `context_quotas`
(and the memory-health knobs, below).

**The embedding tail.** OpenViking embeds a written document after
`content/batch-write` returns, on the one-thread local embedder, so a
finding-case batch sent a few seconds before a seed can still hold the embedder
when the seed's query arrives (seconds per case, far more under CPU
throttling). The case writer reports every batch it sends to the
round-activity tracker (`embeddingSent` → a `settled(tailMs)` at the write's
answer, `[memory] case_embed_tail_ms` a case); with a `quiet` option
(`RoundActivityWindow.whenEmbedderQuiet`, wired by dispatch from
`RoundMemorySeed.activity`) the context search waits for that tail before it is
sent — at most `timeoutMs − searchReserveMs`, so the seed's deadline is never
moved — and is then told the time it has left (`contextBlock`'s `timeoutMs`),
which the OpenViking assembler applies to its request when shorter than its
own `search_timeout_ms`. The pinned head is read at once (a listing, no
embedding). A budget at or under the reserve never waits. The tail is kept on
a monotonic clock (`performance.now`), so a wall-clock step can never stretch
it. `quiet_wait_ms` rides the `RoundMemory` and the `round_memory_seeded`
event.

`roundContextQuery({ title, files })` builds the one query: the PR title plus
its diff shape (top directory areas at two segments deep, top file
extensions), counted and sorted so the result is a function of the file *set*,
never of the order the files API returned them. Pure — the same PR at the same
head always produces the same query, which is what keeps the round prompt
reproducible from the round order. The same query is the PR session's recall
hint: dispatch hands it to `RoundMemorySeed.publishQuery`
before memory is asked, and the daemon writes it, with the round-search areas,
to the session's `QCR_OV_RECALL_HINT_FILE` (`writeRecallHint`), so the
vendored extension's per-prompt recall (patch 8) searches for this PR inside
`experiences/` instead of embedding the round order's fixed header across
every scope. The session's own shell may not write that file
(`MEMORY_SCOPE_SURFACE` in `extensions/bash-guard.ts`, beside the retired list
below) — its areas bound the session's recall and memory tools, so a session
that could rewrite it could widen its own reach.

`pinnedHeadState(mem)` names the three states so no caller reconstructs them:
`populated`, `empty` (answered, nothing pinned — not a gap), `unread`.

### The PR's raw tier and its credential — `src/memory/ovsession.ts`

Two tiers, expressed in the data model rather than by prompt discipline:

- **Durable memories** live under `viking://user/reviewer/memories/…`. They are
  authored, they outlive every PR, and they are what a search returns.
- **The raw tier** is an OpenViking *session* named `pr-<n>` — one review
  conversation's working notes. Sessions are absent from the search corpus, so
  nothing one PR scribbles can leak into another PR's context, and the tier
  ages out by `DELETE` when the PR closes. `commit` is never called: it exists
  to promote session content into memories, which is the extraction this
  deployment has switched off.

`ovSessionIdForPr(n)` is deliberately the same string as the tmux session name.
It is **not** a second session kind (see
[../single-shepherd-invariant.md](../single-shepherd-invariant.md)): it names a
store object the daemon creates over HTTP, not a process anyone schedules.

`openVikingSessionLifecycle(api)` is total in both directions: a 409 on create
means the session already exists, which is the state the caller wanted (a
respawned tmux session keeps its notes); a 404 on delete is the desired end
state. Both are bounded by a deadline and swallow every throw — a PR whose
session could not be created simply runs without a raw tier.

**Stale sessions are swept.** A close the daemon never saw, or a delete that
failed, leaves sessions of closed PRs on the server. Each reconcile pass, after its closed-sync, lists the sessions
(`lifecycle.list`, `GET /api/v1/sessions`) and deletes the `pr-<n>` ones whose
PR the registry says is closed (`planStaleOvSessions`): at most
`OV_SESSION_SWEEP_MAX` (10) a pass, lowest PR first; an open PR, one the
registry does not know, and any id that is not `pr-<n>` are left alone; a
closed PR whose pi is still alive keeps its raw tier until the session is
gone, and the registry is read again right before each delete, so a PR
reopened while the pass was running (or one whose session birth is in flight)
keeps its `pr-<n>`; memory switched off (`[openviking] enabled = false`) runs
no sweep at all; a failed delete ends the pass (the server is struggling) and that id
waits an hour; and a pass stops starting deletes after 10 s
(`OV_SESSION_SWEEP_BUDGET_MS`) — it rides the reconcile poll and must not hold
it. Every outcome is a log line and an
`openviking_session_deleted` / `openviking_session_delete_failed` event
(`source: "sweep"`), and the pass's `reconcile_pass` event carries the counts.
It is never an error of the pass — the boot's first healthy pass lifts a
deploy drain, and memory must not be able to hold that.

**The retired list reaches the sessions' recall.** Whenever the daemon's store
sweep sees the set of retired URIs change, `writeRetiredUris` rewrites
`<pi HOME>/.openviking/retired-uris.json` beside `ovcli.conf`, and every
session is launched with `QCR_OV_RETIRED_FILE` naming it; the extension's
recall excludes them (patch 7, below). A derived list of URIs, not a write
into memory, and not one a session may write: the bash guard refuses it at
both write boundaries. **Only a complete sweep may shrink it**: a sweep that could not
list the root or a category, or read a file, keeps every URI it knew (the
last list, the cached reads it could not re-check) and adds what it saw, and
the daemon's store starts from the file the last daemon wrote
(`readRetiredUrisFile`, the store's `initialRetired`) — so a restart while
the server is still warming up never wipes the sessions' exclusions. The
companion's recall gets the same list for its own tree from the TUI: the TUI's
store publishes the companion namespace's retired URIs into the state home
(`MEMORY.retiredFile`, `openviking/companion-retired-uris.json`), which the
companion mounts and names in `QCR_OV_RETIRED_FILE`.

`writeOvcliConf(path, identity)` drops the reviewer credential into the pi HOME
at 0600, and its **refusal is the point of the function**. The upstream
credential resolver ends its fallback chain at the server's own `root_api_key`,
which in the container sits one symlink away; a copied key would authenticate
every review session as root, silently, with access to every user's tree. If
the key handed in *is* that key it is dropped, and the extension then 401s
visibly (`keyed: false`, `reason: "root-key-refused"`).

`openVikingSessionEnv(...)` returns the non-secret half of the identity — URL,
user, peer id, config paths, `QCR_OV_SESSION_ID`. **No key is ever returned
here**: everything in that map is world-readable through `ps` inside the
container, so the credential rides the 0600 file instead.

## The engine

### The server as a supervised child — `src/openviking/supervisor.ts`

The daemon spawns and owns the OpenViking server rather than backgrounding it
in the entrypoint: the container has one PID 1, and a backgrounded server would
have nothing to notice a crash, nothing to fold its logs into the container
log, and nothing to report it in the heartbeat.

Three properties are structural:

- **No boot ordering.** `start()` never waits for readiness. The daemon comes
  up regardless and rounds run memory-less until `/ready` passes.
- **It never gives up.** A crash schedules a respawn on a capped backoff
  ladder (`restart_backoff_ms`, reset after `restart_reset_after_s` of
  uptime), forever.
- **`status()` never throws.** It is synchronous, reads only cached samples,
  and degrades to a minimal block on any internal error — the heartbeat writer
  must not be able to fail on the memory engine.

`onReady` fires each time `/ready` turns from not-ready to ready; `src/wire.ts`
uses it to materialize the reviewer's memory root (below) without awaiting
anything at boot.

RSS and CPU are sampled from `/proc/<pid>/stat` (`src/openviking/proc.ts`; CPU
is a rate, hence the small stateful sampler) and reported in
`state/status.json` under `openviking` — see `OpenVikingStatus` in
`src/openviking/types.ts` for every field. **Monitoring only**: there is no RSS
watchdog and no auto-restart on a memory budget.

### The health gate — `src/openviking/health.ts`

The gate is `/ready`, never the server's `doctor` command: `doctor` makes live
provider calls and exits non-zero whenever no vision/language model is
configured, which is this deployment's normal, deliberate state. `/health` is
unauthenticated and carries the server's own version string — that is what the
heartbeat's pin-drift check reads against `[openviking] version`.

`probeHealth` resolves an `OpenVikingHealth` for every outcome (refused,
timeout, 503, unparseable body) and never rejects. `/ready` is skipped when
`/health` did not answer: there is nothing to learn from a second connection
refusal.

**Up is not working.** Both of those endpoints are unauthenticated: they can
say "ready" while every authenticated read is refused with `Invalid API Key`
and nothing is written. That is what the next section is for.

### Memory health — `src/memory/health.ts`

The state a person sees: `unknown` (nothing measured yet; never painted
healthy), `healthy`, `degraded` (answers, but the latest probe or too many
recent requests failed — visible, not woken), `down` (no authenticated answer
for `[memory] down_after_min`, counted from boot when there never was one;
`boot_grace_min` keeps a warming server `unknown`) and `auth_failed` (a
credential in use is refused, or there is none to send).

Two inputs. An authenticated probe (`src/openviking/probe.ts`: `fs/ls` of
`viking://user/<user>/memories`, a `NOT_FOUND` root counting as authenticated)
of each credential in use every `probe_interval_s` — the daemon's key file and
the `ovcli.conf` the sessions are handed, judged and reported separately,
because they can fail on different days. And the daemon's own requests (the
client's `onRequest`) and round seeds (dispatch's `onSeeded`, the only place a
seed that timed out is seen). A `NOT_FOUND` answer to a real request is
`absent` — authenticated, counted on its own, and never a failure, exactly as
the probe and the store read it. A 409 that is not a busy give-up (a
precondition conflict, or a busy answer still being retried) is an
authenticated answer too: it proves the key as a success does and restores a
refused daemon credential.

Only memory switched off (`[openviking] enabled = false`, which declining memory
in onboarding writes) is "not monitored". Memory configured ON whose server
cannot run — a binary missing after a rebuild — is monitored and reads `down`:
an outage, not a choice.

Wakes, through the ordinary anomaly funnel (`src/anomalies.ts` lists all three
as WAKE): `memory_auth_failed` on the first refusal, on every transition and
every `rewake_h` while it lasts — never graced and never held by a drain;
`memory_down` on entering `down` and every `rewake_h` — a drain (a deploy
window) defers it until it lifts; `memory_provision_failed` once per boot
report that says a user could not be ensured, the reviewer key does not
authenticate, or a user had to be CREATED (its freshly minted key was
discarded on purpose, so every distributed copy of the old one is wrong) —
"once" keyed by the report file's fingerprint, so a report that cannot even be
parsed does not wake again on every restart. The wake policy dedups these three
kinds on what they SAY (kind and detail), not on the kind alone: the monitor
already raises them only on transitions, so a different transition inside the
generic 10-minute window still reaches the overseer, while an identical repeat
is still held back.

An incident (a continuous `auth_failed`/`down` run) closes only on a MEASURED
recovery — `healthy`, or `degraded` with an authenticated answer since the
incident began. A daemon restarted inside an outage passes through `degraded`
with no answer when its boot grace ends; that decides nothing, so the outage
keeps its start (and its one ticket).

The overseer is not the audience — a digest nobody reads tells nobody. The
`memory` block of `state/status.json` is: `qcr status` prints it, the
TUI board paints a banner in its top bar, the TUI raises one desktop
notification per transition into `auth_failed`/`down`, the TUI files ONE
issue-tracker ticket for an incident older than `incident_ticket_after_min`
(deduped by the incident's start, which survives a daemon restart in the
events table), and the companion's `view.json` carries the block (`null` when
unread). All of these read status.json — never OpenViking, the thing that may
be down.

`keyFromFile` re-stats the key file every TTL and the client drops its cache
on a 401, so a rotated key is re-read; when the daemon's key changes, the
sessions' `ovcli.conf` is rewritten at once. Every client gap is counted in the
block and written as a QUIET `openviking_gap` row at most once an hour per
`op:code` (`src/openviking/gapsink.ts`). A failed raw-tier `DELETE` is logged and recorded
(`openviking_session_delete_failed`).

### The HTTP client — `src/openviking/client.ts`

The one place in the daemon that knows memory speaks HTTP. Its job is to turn a
surface that can be down, slow or wrong into a total function: every call
returns `OvOutcome<T>`, never a rejection. `conflict` is broken out of the
failure arm because a 409 is not a gap — it means the optimistic-concurrency
precondition did its job.

A 409 is not always that, though. Batch-write takes a
**zero-timeout try-lock** on its root directory, and a second writer into the
same directory gets `409 CONFLICT` with `details.conflict_type = "path_busy"`
and `retryable: true` — nothing was checked and nothing was written. That one
is `busy`, never `conflict`: `request()` retries it for every operation
(jittered, `min(2 s, 250 ms·2ⁿ)` halved-to-full, at most 4 retries and never
past 10 s from the first attempt — `BUSY_RETRY_DEFAULTS`), observes each
retried answer as an answer, and returns `busy: true` with one gap only when
the lock is still held at the end. It is told apart by `details.conflict_type`
alone; a hash-precondition 409 has the same status and code and stays a
refusal. Reading every 409 as a refusal would drop writes that merely
collided on the lock.

Four facts about the pinned server version shape this module:

1. **Writes go through `content/batch-write`, exclusively.** For
   memory-context targets the bare `content/write` endpoint appends a
   server-side metadata footer that `content/read` strips again, and no API
   returns the stored hash — so a read → hash → write cycle conflicts forever
   on any file that endpoint created. Files written by batch-write carry no
   footer and round-trip exactly. **There is no `content/write` wrapper in this
   client**: the footgun is removed by absence, not by a comment.
2. **`replace_if_hash` with a stale `base_hash` returns 409 and leaves the file
   unchanged** — an ordinary answer, surfaced as `conflict: true`. The same
   check passes **identical** bytes on an existing target as `unchanged`
   whatever the precondition, which is what makes a named `create_if_absent`
   idempotent.
3. **Search is one route with the determinism knobs pinned off.**
   `buildContextSearchBody` sets `mode: "context"`, `rewrite: false` and
   `query_expansion: "off"` and does **not** expose them as parameters: both
   put a server-side model in the daemon's hot path, and the daemon has no LLM
   in its hot path. (`rewrite` is typed `bool | "auto"` server-side, so "off"
   is the boolean `false`; the string would be a 422, i.e. a silent memory
   outage.)
4. **Auth is a user key and nothing else** — `Authorization: Bearer <key>`.
   The key is supplied by the caller, read lazily (`keyFromFile` caches the
   answer, including "not there", for a TTL so a secret that lands after boot
   is picked up without a restart), and never logged: `redact()` scrubs it out
   of every failure message at construction, before any caller can render one.

`DISABLED_MEMORY_POLICY` is passed on every session create. Without it, a
session queues an extraction task on every commit and every one of them fails,
because no extraction model is configured.

### `MemoryStore` over the engine — `src/openviking/store.ts`

One **file per entry** under `viking://user/<user>/memories/<category>/`, so
the seam's address maps exactly:

| Seam field | Engine meaning |
|---|---|
| `id` | `<category>/<stamp>-<suffix>.md`, the path under the memories root |
| `ts` | parsed from the `<stamp>` half of the name (falls back to the server's mod time) |
| `block` | always `0` — one entry per file, nothing to index into |
| `hash` | `sha256:<hex>` of the stored bytes, the token `replace_if_hash` wants |

`read()` returns every entry oldest-first with `#retired` filtered out, and
the same sweep keeps those files' URIs (`retiredUris()`) so the round's context
search passes them as `exclude_uris` — the retired file stays in the indexed
root, so both halves are what makes retire behave like retire. The search reads
that list from the last completed sweep (plus this store's own retires since)
rather than waiting for a fresh one, so it never runs in series behind a sweep
inside the round's memory deadline. `read()` yields `[]` for both an empty
store and an unreadable one, the right answer for a timeline. `sweep()` is the
same pass with the parts it could **not** read kept beside the entries
(`MemorySweep.unread`); a directory the server 404s is recorded as absent, not
unread, because a namespace nobody has written to yet is known-empty. The two
share one cached, single-flight sweep (`read_cache_ttl_ms`), so the round path
and the TUI poll never double the server's load.

**The sweep is incremental.** Every category is still listed on
every sweep, but a file is read only when its listed size or modification time
differs from the read this store already holds — a periodic **full** refresh
(`fullRefreshMs`, an hour by default) reads everything again, a file whose
listing carries no modification time is read every time, and a write through
the store forgets the file it wrote — and so does a hash refusal, which
proves the cached bytes stale (a same-size rewrite inside one modification
second is invisible to the listing until the full refresh; the re-read the
refusal asks for must be a real one). A file that fails to read is `unread` as
before and forgotten, so the next sweep tries again; a category that fails to
list is `unread` and serves none of its files, but keeps their cached reads
for when it lists again. `invalidate()` therefore means "list again", not "read
everything again" — the listing is what says which files moved. The TUI's
candidate sweeper and memory tab, the companion's setup tools and the daemon
all hold `OpenVikingStore`s, so none of them re-reads the whole store on
every poll.
`lastSweepStats()` says what the last sweep listed, read and reused.

`search()` is **free-text and tag matching over the entries, not a vector
search**. That is deliberate: `search()` returns *addressable* entries, each
carrying the hash a management verb writes back with, while the engine's
context search returns budgeted, tier-degraded prose whose bytes are not the
stored bytes. Handing those back would mint hashes that conflict on first use.
The semantic surface is `searchContext`, consumed by the round's context block,
where nothing is addressed.

Pin is **a tag plus placement**:
`pin` MOVES an entry into `preferences/pinned/` with `#pinned` prepended and a
`from=<area>` event tag recording where it came from; `unpin` moves it back
there (or into `preferences/` when nothing was recorded), both tags removed. A
move is two batch-writes, each under its own area directory (the server
refuses a batch root that is not inside a memory area, so none covers two):
the new copy FIRST (`create_if_absent`, or `replace_if_hash` over a `#moved`
stub when the entry is moving back), then the old file replaced, under the
hash the caller read, by a `#retired #moved moved-to=<new id>` stub. A write
whose answer proves nothing (a timeout, a lost connection, a 5xx) may have
committed anyway, so it is READ BACK before anything is undone: a stub that is
there is a finished move. Only a stub that provably did not land (a refusal —
any 4xx — or a source still holding the bytes the caller hashed) undoes the
move, and the undo turns the new copy into a `#moved` pointer back at the
source: one live copy, and an address a retry may write over (a retired COPY
there would block every later move into it). An outcome that cannot be read
either way is left exactly as found and reported — two live copies are
recoverable by hand, retiring the only live one is not. Nothing is deleted. Retire stays a tag in place (`#retired`
prepended), so retired entries and stubs drop out of `read()` and join the
published retired list; `sweep().retired` hands them to the callers that must
know an entry once existed (the `[feedback]` backfill, the relayout). Event
tags are additionally mirrored onto the engine's native retrieval tag list,
best-effort — the tags are already inside the committed bytes and every reader
re-parses them from there, so a failure narrows retrieval and never loses the
memory.

The tree is listed THREE levels deep (`<area>/<file>` and
`preferences/pinned/<file>`), and entry ids are validated (`validEntryId`)
before being turned into a URI: one to three safe path segments ending in
`.md`/`.txt`, no `..`, no `.` segment. An id ultimately comes back from a
caller that got it from us, and path traversal in an interpolated URI is
exactly the mistake worth making structurally impossible.

`pinnedSweep()` reads the pinned area alone — one listing of
`preferences/pinned/` and a read of every file in it, never the incremental
cache — for the round's head and the EOD watchdog. `relocate(items)` is the
relayout's batched executor: every new copy, one batch-write per destination
directory, then every source (stub or in-place rewrite), one per source
directory, chunked at the server's 256 operations. A refused source batch
turns its moves' new copies back into pointers at their sources; a batch
whose answer proves nothing has each item read back, by the same rule as a
move.

### The relayout — `qcr memory relayout`

Run by the operator from the PC that holds the keys (over the memory forward,
like `qcr memory reembed`), never by the daemon. `--plan` (the default) does
one complete read and prints where every entry goes, or that it is retired or
stays; `--apply` carries the plan out through `relocate` and reads the store
again to show what is left. A read that is not complete is refused — nothing
is planned or written. The plan (`src/memory/relayout.ts`) is a pure function
of the read, so a second `--apply` plans nothing. Its rules, first match wins:
the pinned area is never touched; retired entries are skipped; the one-off
curation retires confinement probes, `needs-attention` feedback reviews a
later adjudication of the same episode answered, and the adjudications the
curation table names (the prompt-injection rule contradicts them); a header `#pinned` moves into
the pinned area and `#manual` into `preferences/`; the feedback family moves
to `events/`; the ops family (`#bug`, `#operations`, `#openviking`,
`#review-ops`, `kind=bug|ops`, `area=operations` — read from the header and
from tag lines, where many ops notes carry them) moves to `events/` with
`kind=bug|ops area=operations` added to its header; everything else stays. A
destination already holding other bytes blocks that one move, and a run whose
plan still holds a blocked move fails (exit 1) and says the store is not laid
out — `--plan` and `--apply` alike. An ops note that
becomes `kind=bug` with no `filed=` ticket is flagged in the plan: the TUI's
auto-filer will file it.

#### Materializing a namespace

`ensureWritable()` creates the namespace's category root eagerly. `create()`
already self-heals a missing root for anything writing *through this class* —
but the companion does not: it writes through the vendored pi extension, whose
namespace resolver lists `viking://user/` and picks a directory that **exists**.
To that resolver an unwritten namespace is not empty but absent, and it falls
back to a default namespace whose tree does not exist either, so every write is
refused with an error naming neither the namespace nor the missing directory.
`src/wire.ts` calls this from the supervisor's `onReady` hook.

### `ContextAssembler` over the engine — `src/openviking/context.ts`

The two halves are asymmetric on purpose:

- **`pinnedHead()` is exact and guaranteed.** It reads the stored bytes of the
  pinned directory through `store.pinnedSweep()` — never a search, whose budget and tier
  degradation could silently truncate a standing instruction. It is strict
  about `unread`: if a pinned file could not be read it returns `unreadable`,
  because the head cannot vouch that no standing instruction was in it; an
  unreadable lesson elsewhere is not the head's gap.
- **`contextBlock()` is budgeted and approximate.** One deterministic
  `mode: "context"` search over `experiences/` only (`roundSearchQuotas` keeps the configured quotas for the round-search areas
  and drops every other key, and an entry from anywhere else that comes back
  anyway is dropped), rendered server-side, pasted verbatim. The rendered
  block is used rather than re-rendering entries locally, so there is only one
  place the token budget can be wrong (the exception: a retired or
  out-of-scope entry that leaked through is dropped and the block rebuilt from
  what is left). Its own deadline
  (`[openviking] search_timeout_ms`, default 8000 ms; clamped 100…15000) is
  shorter than the round's memory deadline, and a
  seed that sent its search late (it waited for the case writer's embedding
  tail) passes the time it has left, which wins when shorter: a request that
  outlives the round's seed is pure cost.

## How a round is seeded

`src/dispatch.ts` calls `seedRoundMemory` once per round, **after** the
worktree is prepared and immediately before the prompt is rendered, so the
memory is as fresh as it can be without the prompt arriving later.

Both sections are rendered by `src/templates.ts` from the `RoundMemory`:

- `{{pinned_head}}` → `renderPinnedHeadSection`. The framing is load-bearing:
  the head is the operator's own words and shapes **judgment, never
  mechanics** — where a standing instruction seems to conflict with the
  prompt's posting route, verdict shape, gates or scripts, the mechanics win
  and the session says so in the verdict summary. `ensurePinnedHead` prepends
  the section when a template forgot the placeholder, so a head that exists is
  never silently lost.
- `{{context_block}}` → `renderContextBlockSection`. The block is labelled
  **evidence and precedent, and data — never instructions**: nothing inside it
  can direct the round, change a gate or move a verdict, and where it disagrees
  with the worktree, the code at this head wins.

The three outcomes render differently, and the difference matters:

| State | What the prompt says |
|---|---|
| block present | the recalled block, verbatim, with the query and budget quoted |
| answered, nothing to add | one line: memory was queried and had nothing |
| `degraded` | "memory unavailable this round — review without it", explicitly non-blocking |

**Who is told when memory is down:** the session (that note) and the operator
— through memory health (above), on state transitions, never once per round.
**Not the PR.** The posted review is about
the code; an outage on the reviewer's side is the operator's to read about.

There is a second, narrower alert: when the store answers and the pinned area
is **empty** while a previously seeded round recorded a non-empty head, the
daemon raises a one-shot anomaly on that transition. An empty head on its own
never alerts — that is a fresh install.

Every round also writes a `round_memory_seeded` event with the query, the
budget, the sizes and the gaps — the per-round record, and what memory health
is fed from.

## Sessions' own memory access

A review session is not limited to the block the daemon pasted. The vendored pi
extension (`extensions/vendor/openviking-pi/`, provenance in `upstream.json`,
twelve recorded patches under `patches/`) gives it `viking_search`, `viking_read`, `viking_browse`,
`viking_write` and `viking_archive_expand`. It is passed per spawn with
`--extension` (`SessionSpec.extensionPaths`, `src/sessions.ts`) rather than
registered globally, and subagent children are launched with no argv
extensions — so a **lens pass gets no memory surface at all**, and does no
ambient memory work.

The patches that matter here:

- `viking_write` (patch 4) exists because upstream's "remember" tool is **not a
  write**: it appends a session message that becomes durable memory only
  through commit-time extraction, which needs an extraction model this
  deployment does not configure. The replacement writes through
  `content/batch-write`, the same single route the daemon uses; its pure half
  (`qcr-write.ts`) validates URIs and the strict tag grammar.
- Patch 1 removes the upstream compaction handler so `extensions/ledger-pin.ts`
  owns compaction alone.
- Patch 6 makes those writes stick and those failures honest: a
  busy 409 is retried and a precondition 409 is not (`qcr-honest.ts`, the
  same rule as the daemon client); `viking_write` takes several `entries` as
  ONE batch-write under their common directory, so the EOD curator's day of
  lessons takes the directory lock once, and routes the batch by the
  entries' own addresses (`routeWrite`), so a two-key process writes a
  reviewer-only batch without naming the namespace; `find()` and the read/browse tools
  return the server's answer instead of collapsing every failure into "No
  results found." / "No content at …"; and a refused key is
  re-read once from the ovcli.conf the daemon rewrites on a rotation.
- Patch 7 bounds the session's ambient memory
  work. The `context` hook waits at most **500 ms** for recall
  (`RECALL_WAIT_MS`): every request of one recall runs on that one deadline,
  nothing is sent once it has passed (so no `/search/recall` or raw-find
  fallback outlives it), and a late answer is dropped rather than injected
  into a later turn. Query expansion is forced off in code. A retired entry is
  never recalled: the daemon's published list goes out as `exclude_uris` and
  any recalled entry whose own header says `#retired` is dropped. And nothing
  commits a session — not at a pending-token threshold, not at shutdown, not
  on `/viking commit`, not from a commit queued on disk. Per-turn
  sync into the PR's raw tier stays.
- Patch 8 makes a PR session's recall ask about its own PR. Upstream queries
  with the whole delivered prompt — a long round order, of which the local
  embedder reads only the first 128 tokens, i.e. the template's fixed header,
  the same for every PR. The extension instead reads the daemon's
  per-session hint (`QCR_OV_RECALL_HINT_FILE`: the round's `roundContextQuery`
  and the round-search areas) on every prompt and queues that query, and
  `scopeGuard` keeps the recall inside those areas (quotas naming them alone,
  out-of-area entries dropped, the raw-find fallback filtered). With no hint
  (the overseer, the companion) it queries with the prompt, unscoped. Patch
  7's budget wraps the same chain.
- Patches 9 and 11 keep a PR session's `viking_search`, `viking_read` and
  `viking_browse` inside the same areas (failing closed to them when the hint
  is missing), send the areas as the server's `target_uri` list, and refuse a
  PR session's writes into `experiences/`, `preferences/` and
  `finding-cases/`; no session may type a `#lesson` header by hand. Patch 10 gives
  `viking_write` a structured `lesson` that renders the typed lesson header.

## Writers into memory

### The daily sweep — `src/eod.ts`

A wall-clock timer in the configured `[eod]` timezone, DST-correct, using
`Intl` only. It is daemon-side because in-process schedulers fire only while a
session happens to be open, queue nothing, and expose no timezone — a
"local end of day" trigger would drift an hour across the DST boundary and
silently skip days. Semantics are documented and tested in the module header:
exactly one fire per local calendar day, including on transition days.

At each fire it renders the sweep prompt with the local date and injects it
into the overseer session. Two things ride alongside:

- `dayContext` — daemon-measured lines appended after the seeded template
  (the template itself is frozen and not ours to edit), currently the day's
  grouped cancellation summary from `src/digest.ts`. The sweep is told to carry
  them into the digest verbatim.
- `shouldHold` — a deploy-window drain probe. When it returns true the sweep is
  **deferred**, never skipped: the date joins
  a set persisted in `state.db` (`eod_deferred` events) and fires — oldest
  first, one at a time — on the first minute-poll after the drain lifts, also
  after a restart, which is what a deploy-window drain usually precedes. A
  deferred day leaves the set only when its fire has finished. A throwing
  probe counts as "not held": a broken check must not silently eat the sweep.
- `sweepInFlight` — one sweep at a time, not one inject: no day fires while
  another fire is in flight or the pinned-area watch window of the last sweep
  is still open (wire.ts: `pinWatch.isOpen()`), and a day whose hour comes up
  then is deferred behind it. Days deferred by a drain otherwise fire a minute
  apart, and the curator would still be on the first when the second arrived.
  The inject carries the day it sweeps, so the watch names each window after
  that day and closes it on that day's digest.
- A failed injection is retried three times (after 1, 5 and 15 minutes); when
  all four attempts fail, `eod_inject_failed` wakes — the day's curation did
  not happen.

The curator authors its learnings into memory through the extension's write
tool, never into a file. The sweep prompt starts its §1 from the day's outcomes packet — the "Outcomes to
curate" section the daemon renders after the seed (`EOD_SECTIONS`) and
`state/eod/<day>/outcomes.md` — writes each learning as a typed lesson in
`experiences/` through `viking_write`'s `lesson` fields, citing `cand:c<id>`
(an objective repo fact is a `repo-fact` or `convention` lesson there; nothing
goes to `viking://resources/`), and closes §1 with the
`eod-curation-receipt`. A sweep the packet did not reach still carries that
section: `renderNoPacketSection` says the learner is off (no packet, no
receipt) or that the packet failed or missed the wait (curate the file if it
exists, else there is nothing to decide), so the seed never points at a
section that is not there.

### The pinned-area watchdog — `src/eodpinwatch.ts`

Curation must never modify the operator's pinned standing instructions. In the
sweep prompt alone that rule would be an instruction to a model, with nothing
outside able to tell whether it was kept. The watchdog makes it
**detectable**: fingerprint the pinned area just before the sweep prompt goes
in, fingerprint it again once the sweep has had its window, raise an anomaly on
any difference.

- `fingerprintPinned` is pure and order-independent: a sha256 over the sorted
  `address hash` lines, where the address is the full `(ts, id, block)` triple —
  fingerprinting by `id` alone would collapse two pinned entries written in the
  same batch.
- `wrapInject` opens the window and returns the inner inject's promise **in the
  same tick**. The "before" read is never awaited ahead of the injection and a
  synchronous throw out of the reader is swallowed, so a store that is down,
  slow or hung costs the sweep exactly nothing.
- The watchdog **only observes**. Its entire output is `logAnomaly`; the wake,
  if the kind earns one, goes through the ordinary anomaly policy.
- A missing snapshot is **"could not check", never "changed"**
  (`eod_pinned_watchdog_degraded`, deliberately quiet). The loud kind
  (`eod_pinned_area_modified`) is reserved for a fingerprint that actually
  moved, and its message names **both** explanations — the curator, or the
  operator editing pins in the TUI inside the window, whose writes go straight
  to the store and are invisible to the daemon. That false positive is
  knowingly accepted; silent-but-wrong would be worse.
- A restart mid-sweep drops the window unjudged. A restart is not evidence.

Defaults: a 90-minute window (`[eod] pinned_watchdog_window_min`), a
60-second poll, a 5-second deadline on one pinned read. The window closes early
when the day's digest appears at `<root>/digest/<date>.md` (`digestWritten`,
wired in `src/wire.ts`).

### The `[feedback]` loop — `src/feedback.ts`

Humans mark a review comment they judge wrong or over-specific by starting a PR
comment with `[feedback]`. The system also learns from **actions**: a bot review
dismissed, a merge over a standing block, a deleted bot comment, a withdrawn
trigger.

Everything here is **meta-signal about the review process** and is kept out of
the running round. `src/webhook.ts` diverts a `[feedback]` comment *before*
author-reply handling, so it never reaches ping-pong, never wakes the PR's
session, and never stamps the new-evidence mark (which would unlock a
re-review at an unchanged head).

Two sinks, and one of them is authoritative:

1. **The ledger is the record.** `feedback_signals` in `src/state.ts`, deduped
   per kind. Ingest is: dedupe → ledger → memory → (explicit comments only)
   agents rebuild.
2. **Memory is a sink — and the ledger says what it owes.**
   One tagged event entry per signal — `#feedback` plus the `k=v` run `kind` /
   `pr` / `day` / `signal` — written through the seam as a `note` op (never
   `add`: it must not be dressed up as the operator's own words) at a
   deterministic address in the `events/` area:
   `<created_at stamp>-fb-<kind>-<pr>-<signal id>`, created-if-absent
   (`feedbackEntryName`). `events/`, not `experiences/`, because a batch-write
   locks its directory and the EOD curator writes `experiences/`. The row
   carries `memory_state` (`pending` → `written`, or `failed` / `skipped`),
   `memory_attempts`, `memory_last_error` and `memory_uri`. The ingest attempt
   runs under a deadline (`FEEDBACK_MEMORY_TIMEOUT_MS`, 10 s): a refusal, a
   throw and a hang all leave the row `pending`, with a
   `feedback_memory_write_failed` event naming the signal — a wedged store
   costs the webhook path seconds and nothing else. A signal that arrives
   before the engine exists (the boot gap) is ledgered `pending` by
   `ledgerFeedbackSignal`, never dropped. Memory switched off ledgers rows
   `skipped`.

   **The backfill pump** (`FeedbackMemoryPump`, every
   `[memory] backfill_interval_s`) writes up to 20 owed rows a tick, oldest
   first, through the same `note` op — a retry on the one route, not a second
   channel — and only while memory health reads `healthy`. The deterministic
   address makes the replay of a write that landed but timed out find its own
   entry. Rows that predate the memory columns are classified once at boot:
   those a `feedback_memory_write_failed` event followed are `pending`, the
   rest `written` with no recorded address;
   before writing such a row the pump looks for an entry that landed after all
   (same header `signal`/`pr`/`day` tags and id) in a COMPLETE sweep, and a
   partial sweep makes those rows wait rather than risk a duplicate. The
   classification gives each failure event its own row (the newest one at or
   before it that no earlier event claimed), so two comments from one review
   submission that both failed are both owed. A row memory refuses 12 times
   while healthy is given up on (`failed`) — loudly, and not for good: given-up
   rows go back in the queue on the pump's first healthy tick after a start
   and once a day, so a fixed cause is all it takes. A row owed for longer
   than `[memory] write_backlog_after_min` (2 h) wakes `memory_write_backlog`
   — on the crossing and every `rewake_h`, a cadence kept in `state.db` so a
   restart does not wake again at once — and a tick that gave rows up wakes
   it once. "Owed for" runs from `memory_owed_since` (the insert, the
   migration for a pre-existing row, the re-queue for a given-up one), never from
   the signal's own date, and the backlog is not judged while memory health
   reads `unknown` (its boot grace). status.json's `memory.feedback_writes`
   and `qcr status` show what is owed — `null`, rendered UNKNOWN, when the
   daemon could not read its ledger.

The store is **injected**, not constructed here. A sink that could conjure its
own engine would be a second opinion about where memory lives.

The third consumer is the **same-day validator addendum**
(`feedbackDayAddendum`): built from the *ledger*, not from memory, so it
survives a memory outage; scoped to the operations day; capped at 12 items with
the omission stated; and **demotion-only** — it introduces the
`feedback-shape` downgrade label, explicitly forbids killing a candidate on
feedback alone, and does not move the blocker bar. It reaches the validator
through the addendum registry in `src/include.ts`, never through a seed edit.

Comment bodies are sanitized before they are quoted anywhere
(`sanitizeFeedbackText`): the tag is stripped, whitespace flattened, backticks
and double quotes replaced, length capped — a quoted body must not be able to
close its own quote and continue as prose.

### The findings record — `src/findingsrecord.ts`

Adjacent to memory, and worth knowing about because it is often confused with
it: the per-finding reasoning record is **not** memory. Each round's session
writes `state/findings/pr-<n>-round-<k>.json`, one entry per candidate finding,
with its lens, severity, confidence, reachability, disposition (`posted`,
`killed`, `downgraded`, `merged`, `folded`, `withheld`, `conceded`), the
closed-vocabulary kill/downgrade word, and the reason in the reviewer's own
words. The daemon parses it after the round into queryable rows.

Two properties keep it from becoming a gate: **a round is never held open for
it** — the verdict is applied and the PR has transitioned before any of this
runs — and a missing record costs exactly one anomaly row plus **one**
re-nudge (`findingsRecordWake`), whose once-mark is persisted *before* the
inject so a crashed inject can never become a nudge loop.

### The digest — `src/digest.ts`

The sweep's session writes `digest/<date>.md` itself. The daemon only reads it:
`digestHeadline` takes the first non-empty, non-heading line (capped at 200
chars) and `latestDigestHeadline` lifts the newest one into the daemon's
heartbeat file, `state/status.json`.

The module also computes the day's measured shape from the rounds table —
`dailyUsage`/`usageSummaryLine` (rounds, tokens in/out, estimated spend;
expired rounds are **included**, because a round that blew its deadline still
burned its tokens) and `dailyCancellations`/`cancellationSummaryLine` (grouped
by cause, loud causes first, `cancelled: none` stated explicitly rather than
omitted). `eodDigestContext` is what rides the sweep prompt.

## Keys and confinement

The model is **user keys only, one namespace each, and never an admin or root
key anywhere**.

| Holder | Key(s) | Reach |
|---|---|---|
| The daemon and every review session | `reviewer` | `viking://user/reviewer/` only |
| The operator's TUI | `reviewer` + `companion` | both namespaces |
| The local companion container | `reviewer` + `companion` | both namespaces |
| The server itself | its own root key | everything — and it is given to no client |

Why no admin key: verified against the pinned server version, an admin key
grants no cross-user data access at all *and* can list every user key in
plaintext. It is an account-wide superuser with none of the benefit.

The confinement in the **reverse direction** is what makes the two-namespace
design meaningful: review sessions hold only the reviewer key, so they can
never read or write companion memory, and nothing a session recalls can carry
the operator's private notes into a posted review. That is a server-side
guarantee (403 across namespaces), not a convention.

Three code-level belts hold it up:

- `writeOvcliConf` refuses to write the server's root key as a session
  credential (above).
- `extensions/bash-guard.ts` refuses to read the files that carry the root key.
- `scripts/companion-memory-forward.mjs verify` re-runs the proof on demand:
  four `(key, namespace)` probes — companion→companion **reach**,
  reviewer→reviewer **reach**, reviewer→companion **refused**,
  companion→reviewer **refused**. Anything that is neither a clean reach nor a
  clean refusal is reported `INCONCLUSIVE`, never as a pass; a 200 whose
  envelope says "permission denied" counts as a refusal, and a 200 that says
  something else entirely does not count at all. The namespace must appear in
  the **URI** — the server confines by URI, and the user header alone does not
  select a namespace.

Keys are read from a 0600 env file (`openviking-keys.env`, path overridable
with `QCR_OPENVIKING_KEYS`) and passed by `--env-file`, so no key value ever
reaches an argv. `src/tui/memory.ts` maps each user to its env name and has
deliberately **no** admin/root entry.

## Embeddings

Every entry and every query is embedded. The shipped default is **local**: a
local English embedder (`scripts/openviking-embedder.py`, an OpenAI-compatible
service on `127.0.0.1:1934` over llama-cpp-python, supervised beside the
server by `src/openviking/embedder.ts`) runs inside the container, so no
memory text leaves the machine. A hosted provider is an explicit opt-in with its own
credential file, never a fallback — a hosted provider whose key is missing
renders without a key and the server refuses to start, loudly, rather than
silently switching embedder and resetting the store.

Changing embedder changes the vector space, so the boot detects it, moves the
old collection aside (kept, never deleted) and re-embeds; the daemon half is
`src/openviking/reembed.ts` and the migration itself is
`scripts/openviking-reembed.mjs`. The full reference — knob, mirrors, journal,
heartbeat block, rollback, rehearsal — is
[../memory-embeddings.md](../memory-embeddings.md).

## The memory forward

The operator's PC surfaces (the TUI's memory tab and the local companion
container) must reach an engine that is bound to the daemon container's
loopback and published nowhere. `scripts/companion-memory-forward.mjs` is the
one relay implementation:

```
companion container ──▶ <bridge gateway>:1933      (docker network `qcr-memory`)
                          │  the forward process, on the operator's PC
                          ▼
        ssh <host> ──▶ docker exec -i <daemon container>
                          ▼
                node stdio↔TCP bridge ──▶ 127.0.0.1:1933   (OpenViking)
```

Two properties earn the machinery: the companion container never sees an ssh
key, an agent socket or a known-hosts file — it sees one TCP endpoint on a
bridge; and **nothing on the server is published** — the last hop is a
`docker exec` inside the container's network namespace, so no port is opened on
the host, on its docker bridge, or anywhere reachable from the network. On a
single-machine topology `--local` (or `QCR_MEMORY_LOCAL=1`) replaces the ssh
hop with a plain local `docker exec`; everything else is identical. The script
is dependency-free ESM so a service manager can run it from a bare checkout at
boot. Subcommands: `run`, `install`, `uninstall`, `status`, `ensure-network`,
`verify`.

`src/tui/memforward.ts` lets the TUI run the same forward **without forking the
logic**: it imports `parseArgs`/`createForwarder` out of that script at runtime
(dynamically, by file URL — the script lives outside the TypeScript build on
purpose), so both entrypoints honour the same flags and environment variables.
Its contract is **adopt-or-bind**:

- if something is already listening — a user service, or another TUI — it is
  **adopted**: never bound over, never restarted, never stopped on exit;
- only when nothing answers does the TUI bind, and then it closes exactly what
  it opened.

So the standalone service is an optional upgrade (memory that outlives the TUI,
which is what the companion wants) rather than a prerequisite, and the two can
be installed in either order. `ForwardState` is `adopted | owned | failed |
off`; `adopted` and `owned` are both healthy and the tab must not paint them as
different degrees of health. Nothing in this path holds a credential for the
remote host: the ssh runs on the operator's PC, as the operator.

The TUI's own store (`src/tui/memory.ts`) then speaks plain HTTP to that
loopback listener, building one client per user key and merging the timelines.
`src/tui/memtab.ts` is the `[2] memory` tab: newest-first, pinned floated,
grouped by day, with `e` edit · `p` pin/unpin · `x` retire (twice). Every
mutation goes through the seam, so the tab never addresses an entry by offset
and never hashes anything itself. When the store does not answer, the timeline
is replaced by an explicit failure banner — an empty list must never be
mistaken for an empty store.

Two consumers ride on top. The **defect auto-filer** (`src/tui/autofile.ts`)
turns `#bug` entries into tickets; `[sink] kind` decides where — a local
filesystem tracker on the operator's PC, issues on the reviewed repo (written
as a command the daemon files through the one mutation gate), or off, which is
the default. Dedup is a tag: filing stamps `filed=<id>` into the entry's own
header, with a key line in the ticket as the backstop, because the stamp is a
store mutation and can be refused. The second is the rubric-proposal surface
(`src/tui/proposals.ts`).

## Invariants a change must not break

1. **Memory never blocks or delays a round.** Every call on the round path is
   bounded by a deadline and swallows every throw. The worst case is a
   memory-less prompt, on time. The one wait inside a seed — for the case
   writer's embedding tail — is inside that deadline. Inside the
   session the same holds per turn: the extension's recall waits at most
   500 ms (patch 7).
2. **Empty is not degraded.** A store that answered with nothing has answered.
   Only a read that did not happen is a gap, and only a gap alerts.
3. **The pinned head is exact.** It is read from stored bytes, never from a
   budgeted search, and a partial sweep reports `unreadable` rather than
   delivering a head that might be missing an instruction.
4. **One write route.** `content/batch-write` with a hash precondition. Do not
   add a `content/write` wrapper — its absence is the safeguard.
5. **No LLM in the daemon's hot path.** `rewrite` and `query_expansion` stay
   pinned off inside the client, not exposed as caller options.
6. **Header-only tag parsing, and pinned is placement.** Quoted untrusted
   text must never be able to mint itself a tag, and no text at all can put
   an entry in the head: only an entry IN `preferences/pinned/` is pinned.
7. **No admin or root key reaches any client.** User keys only, confined
   server-side, both directions.
8. **Curation never touches pinned entries**, and the watchdog exists so that
   rule is detectable rather than merely instructed.
9. **The ledger is the record, memory is a sink.** A signal that failed to
   reach memory is still recorded — as owed (`memory_state = pending`), so the
   backfill writes it — and every derived surface re-derives from the ledger.
10. **A busy 409 is not a refusal.** Only `details.conflict_type =
    "path_busy"` is retried; a precondition 409 never is.
11. **The round reads `experiences/` and the pinned area, nothing else.** The
    context block's quotas name `experiences` alone and an out-of-scope entry
    is dropped; a PR session's own recall and memory tools are scoped the
    same way (patches 8, 9 and 11).

## Tests

| Area | Suite |
|---|---|
| Seam vocabulary, ops, matching | `tests/memory-store.test.ts` |
| Round seeding, gaps, empty-vs-degraded, rendering | `tests/round-memory.test.ts` |
| Entry-header tag parsing, `[feedback]` ingest, day addendum | `tests/feedback.test.ts` |
| Writes that stick: busy vs precondition 409, named notes, the feedback ledger and backfill pump, EOD deferral and retries | `tests/memory-writes.test.ts` |
| PR session lifecycle, credential refusal, session env, the stale-session plan, the retired list | `tests/ovsession.test.ts` |
| The stale-session sweep in the session manager and the reconcile pass | `tests/sessions.test.ts`, `tests/reconcile.test.ts` |
| Supervisor, health gate, proc sampling, heartbeat block | `tests/openviking.test.ts` |
| Client routes, determinism pins, store (incl. the incremental sweep), assembler | `tests/openviking-store.test.ts` |
| Vendored extension pin and its patches | `tests/openviking-fork.test.ts` |
| Embedder migration (script and daemon halves) | `tests/openviking-reembed.test.ts`, `tests/openviking-reembed-driver.test.ts` |
| The one-time import from the file engine | `tests/memory-import.test.ts` |
| EOD clock and DST behaviour | `tests/eod.test.ts` |
| Pinned-area watchdog | `tests/eodpinwatch.test.ts` |
| Findings record parsing and the single re-nudge | `tests/findings-record.test.ts` |
| Digest headline, usage, cancellations | `tests/digest.test.ts` |
| Forward, adopt-or-bind, confinement verdicts | `tests/companion-memory.test.ts`, `tests/tui-memforward.test.ts` |
| The TUI's store, timeline ordering, the memory tab | `tests/tui-memory.test.ts`, `tests/memory.test.ts`, `tests/memtab.test.ts` |
| Daemon wiring of the store and assembler | `tests/wire-memory.test.ts` |

Run one with `timeout 900 npx vitest run <path>`; run everything with
`timeout 900 npm test`.
