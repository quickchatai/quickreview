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
| A PR session's identity, credential file and raw-notes tier | `src/memory/ovsession.ts` |
| The one-time import from the retired file engine | `src/memory/import.ts`, `src/memory/legacy-file.ts`, `scripts/import-pi-memory.mjs` |
| The engine process: spawn, restart ladder, heartbeat block | `src/openviking/supervisor.ts`, `proc.ts`, `types.ts` |
| The health gate (`/health`, `/ready`) | `src/openviking/health.ts` |
| HTTP: the single write route, determinism pins, auth | `src/openviking/client.ts` |
| `MemoryStore` over the engine (entries as files, pin/retire) | `src/openviking/store.ts` |
| `ContextAssembler` over the engine (head + block) | `src/openviking/context.ts` |
| Embedder knob, re-embed migration | `src/openviking/reembed.ts`, `scripts/openviking-reembed.mjs` |
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
archived file of the retired engine, kept so the one-time import can still see
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

### Round seeding — `src/memory/context.ts`

`ContextAssembler` is the round path's whole relationship with memory:

```ts
pinnedHead(): Promise<MemoryRead>
contextBlock(query, { maxTokens }): Promise<MemoryRead>
```

`MemoryRead` is `{ status: "read", text }` or `{ status: "unreadable", reason }`.
That split is the point of the type: **empty is not degraded.** A store with
nothing pinned yet has *answered*; a store that could not be reached has not.
Collapsing both into `""` made every fresh install look broken and alarmed the
operator hourly about a healthy system.

`assembleRoundMemory(assembler, query, opts)` is total by construction. It:

1. calls each method **exactly once**, both in flight together, so the seed
   costs one round trip of latency rather than two;
2. wraps each in `guarded(...)`, which turns a timeout, an `unreadable`
   answer, a rejection, a synchronous throw, or a settled value that is not a
   `MemoryRead` at all into `""` plus a `MemoryGap`;
3. clamps an over-budget block at `maxTokens × charsPerToken` and says so;
4. returns a `RoundMemory` whose `degraded` is exactly `gaps.length > 0`.

Defaults (`ROUND_CONTEXT_DEFAULTS`): 2000 tokens, a 3000 ms deadline for the
whole seed, 6 chars/token for the defensive clamp, 600 chars of query. The configured knobs are `[memory] context_tokens`, `context_timeout_ms`,
`alert_cooldown_min`, `context_quotas`.

`roundContextQuery({ title, files })` builds the one query: the PR title plus
its diff shape (top directory areas at two segments deep, top file
extensions), counted and sorted so the result is a function of the file *set*,
never of the order the files API returned them. Pure — the same PR at the same
head always produces the same query, which is what keeps the round prompt
reproducible from the round order.

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

### The HTTP client — `src/openviking/client.ts`

The one place in the daemon that knows memory speaks HTTP. Its job is to turn a
surface that can be down, slow or wrong into a total function: every call
returns `OvOutcome<T>`, never a rejection. `conflict` is broken out of the
failure arm because a 409 is not a gap — it means the optimistic-concurrency
precondition did its job.

Four facts about the pinned server version shape this module:

1. **Writes go through `content/batch-write`, exclusively.** For
   memory-context targets the bare `content/write` endpoint appends a
   server-side metadata footer that `content/read` strips again, and no API
   returns the stored hash — so a read → hash → write cycle conflicts forever
   on any file that endpoint created. Files written by batch-write carry no
   footer and round-trip exactly. **There is no `content/write` wrapper in this
   client**: the footgun is removed by absence, not by a comment.
2. **`replace_if_hash` with a stale `base_hash` returns 409 and leaves the file
   unchanged** — an ordinary answer, surfaced as `conflict: true`.
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

`read()` returns every entry oldest-first with `#retired` filtered out — which
is what makes retire behave like retire — and yields `[]` for both an empty
store and an unreadable one, the right answer for a timeline. `sweep()` is the
same pass with the parts it could **not** read kept beside the entries
(`MemorySweep.unread`); a directory the server 404s is recorded as absent, not
unread, because a namespace nobody has written to yet is known-empty. The two
share one cached, single-flight sweep (`read_cache_ttl_ms`), so the round path
and the TUI poll never double the server's load.

`search()` is **free-text and tag matching over the entries, not a vector
search**. That is deliberate: `search()` returns *addressable* entries, each
carrying the hash a management verb writes back with, while the engine's
context search returns budgeted, tier-degraded prose whose bytes are not the
stored bytes. Handing those back would mint hashes that conflict on first use.
The semantic surface is `searchContext`, consumed by the round's context block,
where nothing is addressed.

Pin and retire are **a tag plus placement**, not a separate mechanism:
`#pinned`, `#manual`, `#retired` are prepended to the entry text, the same
spelling the import and the feedback writer use, so an entry means the same
thing whichever surface holds it. Event tags are additionally mirrored onto the
engine's native retrieval tag list, best-effort — the tags are already inside
the committed bytes and every reader re-parses them from there, so a failure
narrows retrieval and never loses the memory.

Entry ids are validated (`validEntryId`) before being turned into a URI: one or
two safe path segments ending in `.md`/`.txt`, no `..`. An id ultimately comes
back from a caller that got it from us, and path traversal in an interpolated
URI is exactly the mistake worth making structurally impossible.

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

- **`pinnedHead()` is exact and guaranteed.** It reads the stored bytes through
  `store.sweep()` — never a search, whose budget and tier degradation could
  silently truncate a standing instruction. It is strict about `unread`: if the
  sweep skipped even one entry it returns `unreadable`, because a partial sweep
  cannot vouch that no standing instruction was in the part it missed.
- **`contextBlock()` is budgeted and approximate.** One deterministic
  `mode: "context"` search, rendered server-side, pasted verbatim. The rendered
  block is used rather than re-rendering entries locally, so there is only one
  place the token budget can be wrong. Its own deadline
  (`[openviking] search_timeout_ms`, default 2500 ms) is shorter than the
  round's memory deadline: a request that outlives the round's seed is pure
  cost.

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
(a `round_memory_degraded` overseer anomaly from `src/dispatch.ts`, on an
`alert_cooldown_min` cooldown so a store that stays down cannot bury the
overseer). **Not the PR.** The posted review is about the code; an outage on
the reviewer's side is the operator's to read about.

There is a second, narrower alert: when the store answers and the pinned area
is **empty** while a previously seeded round recorded a non-empty head, the
daemon raises a one-shot anomaly on that transition. An empty head on its own
never alerts — that is a fresh install.

Every round also writes a `round_memory_seeded` event with the query, the
budget, the sizes and the gaps, so the per-round record survives the cooldown.

## Sessions' own memory access

A review session is not limited to the block the daemon pasted. The vendored pi
extension (`extensions/vendor/openviking-pi/`, provenance in `upstream.json`,
six recorded patches) gives it `viking_search`, `viking_read`, `viking_browse`,
`viking_write` and `viking_archive_expand`. It is passed per spawn with
`--extension` (`SessionSpec.extensionPaths`, `src/sessions.ts`) rather than
registered globally, and subagent children are launched with no argv
extensions — so a **lens pass gets no memory surface at all**, and does no
ambient memory work.

Two of those patches matter here:

- `viking_write` (patch 4) exists because upstream's "remember" tool is **not a
  write**: it appends a session message that becomes durable memory only
  through commit-time extraction, which needs an extraction model this
  deployment does not configure. The replacement writes through
  `content/batch-write`, the same single route the daemon uses; its pure half
  (`qcr-write.ts`) validates URIs and the strict tag grammar.
- Patch 1 removes the upstream compaction handler so `extensions/ledger-pin.ts`
  owns compaction alone.

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
  **skipped for that day**, never queued, and the skip is logged. A throwing
  probe counts as "not held": a broken check must not silently eat the sweep.

The curator authors its learnings into memory through the extension's write
tool, never into a file.

### The pinned-area watchdog — `src/eodpinwatch.ts`

Curation must never modify the operator's pinned standing instructions. That
rule used to live only in the sweep prompt — an instruction to a model, with
nothing outside able to tell whether it was kept. The watchdog makes it
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
when the day's digest appears — note that `src/wire.ts` wires that probe at
`<root>/state/digest/<date>.md` while the digest reader
(`latestDigestHeadline`) and the sweep prompt use `<root>/digest/<date>.md`, so
in practice the window runs its full length.

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
2. **Memory is a sink.** One tagged event entry per signal — `#feedback` plus
   the `k=v` run `kind` / `pr` / `day` / `signal` — appended through the seam
   as a `note` op (never `add`: it must not be dressed up as the operator's own
   words). The write is best-effort under a deadline
   (`FEEDBACK_MEMORY_TIMEOUT_MS`, 10 s): a refusal, a throw and a hang all end
   the same way — logged, ledgered as an anomaly, never raised. A wedged store
   costs the webhook path seconds and nothing else.

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

Every entry and every query is embedded. The shipped default is **local**: the
server's own llama-cpp embedder runs inside the container, so no memory text
leaves the machine. A hosted provider is an explicit opt-in with its own
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
   memory-less prompt, on time.
2. **Empty is not degraded.** A store that answered with nothing has answered.
   Only a read that did not happen is a gap, and only a gap alerts.
3. **The pinned head is exact.** It is read from stored bytes, never from a
   budgeted search, and a partial sweep reports `unreadable` rather than
   delivering a head that might be missing an instruction.
4. **One write route.** `content/batch-write` with a hash precondition. Do not
   add a `content/write` wrapper — its absence is the safeguard.
5. **No LLM in the daemon's hot path.** `rewrite` and `query_expansion` stay
   pinned off inside the client, not exposed as caller options.
6. **Header-only tag parsing.** Quoted untrusted text must never be able to
   mint itself a tag, least of all `#pinned`.
7. **No admin or root key reaches any client.** User keys only, confined
   server-side, both directions.
8. **Curation never touches pinned entries**, and the watchdog exists so that
   rule is detectable rather than merely instructed.
9. **The ledger is the record, memory is a sink.** A signal that failed to
   reach memory is still recorded, and every derived surface re-derives from
   the ledger.

## Tests

| Area | Suite |
|---|---|
| Seam vocabulary, ops, matching | `tests/memory-store.test.ts` |
| Round seeding, gaps, empty-vs-degraded, rendering | `tests/round-memory.test.ts` |
| Entry-header tag parsing, `[feedback]` ingest, day addendum | `tests/feedback.test.ts` |
| PR session lifecycle, credential refusal, session env | `tests/ovsession.test.ts` |
| Supervisor, health gate, proc sampling, heartbeat block | `tests/openviking.test.ts` |
| Client routes, determinism pins, store, assembler | `tests/openviking-store.test.ts` |
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
