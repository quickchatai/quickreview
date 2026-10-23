# Sessions and pi — how the daemon drives the coding agent

> **Workers are the only PR host.** The tmux PR host described below (birth,
> wake files, the inject bridge's PR half, kill and fence, round-end
> compaction requests) was deleted in P9.2: `src/sessions.ts` keeps only the
> overseer's tmux session and the replay harness's, and a PR's session is the
> per-round worker of `src/worker-session-host.ts`, where a worker's ack is the
> receipt. The sections on PR sessions below describe the retired host.

The daemon never talks to a model. It runs **pi** (the pinned coding-agent CLI,
`@earendil-works/pi-coding-agent`) inside detached **tmux** sessions and steers
those sessions by writing files. Everything in this document is about that
boundary: how a session is born, how an instruction reaches it, how the daemon
learns whether the instruction actually landed, and where the lens agents a
session fans out to come from.

Sibling reading: [the single-shepherd invariant](../single-shepherd-invariant.md)
(the topology this boundary is required to have), [ownership](../ownership.md)
(who may change the seeds these sessions run on), and
[the exec boundary](../exec-boundary.md) (what a session and its children are
allowed to execute).

## Where to look

| Concern | Module |
| --- | --- |
| Session birth, adoption, wakes, archival | `src/sessions.ts` |
| `exec` primitive + the tmux surface | `src/tmux.ts` |
| One base clone + one worktree per PR | `src/worktrees.ts` |
| Wake-file delivery inside pi (the overseer's and the companion's mailbox) | `extensions/inject-bridge.ts` |
| Bridge readiness receipt (any tmux-hosted session) | `src/session-bridge.ts` |
| Durable command marker | `packages/pi-plugin/src/session-command.ts` |
| Daemon-side reconciler over that slot | `src/session-command-supervisor.ts` |
| Live lens progress (publisher / reader) | `src/live/publish.ts`, `packages/pi-plugin/src/round-progress.ts` |
| Ledger survival across compaction | `packages/pi-plugin/extensions/ledger-pin.ts` |
| Lens agent build + addendum registry | `packages/pi-plugin/src/include.ts` |
| Prompt rendering | `packages/pi-plugin/src/templates.ts` |
| The lens tool (`lens`, `lens_wave`) | `packages/pi-plugin/src/engine/lens/`, `packages/pi-plugin/extensions/lens.ts` |
| Model tiers, session dir, fan-out cap | `config.example.toml` `[models]`, `[pi]`, `[engine]`; `src/config.ts` |

## Two session kinds, and only two

`src/sessions.ts` names sessions with `prSessionName` (`pr-<n>`) and the
constant `OVERSEER_SESSION` (`overseer`); `isSandboxSession` accepts exactly
those two shapes, and `prOfSession` recovers the PR number. `ensurePrSession`
and `ensureOverseerSession` are the only callers of `spawnSession` outside the
smoke script. Everything else the system runs — every lens pass — is a
subagent launched *by* a PR session, never by the daemon.

That topology, and the reasoning behind it, is stated in
[docs/single-shepherd-invariant.md](../single-shepherd-invariant.md). This
document describes the mechanism; that one describes the rule.

## Session birth

`spawnSession(session, systemPromptBody, model, extraEnv)` does the following,
in order:

1. Writes the substituted system prompt to `state/session-prompts/<session>.md`
   (`writeSystemPrompt`, tmp + rename).
2. Writes the memory credential file into the pi HOME at mode 0600
   (`provisionOvCredentials`) — before pi starts, because the memory extension
   resolves it at load time.
3. Creates `inject/<session>/` and `inject/<session>/.done/`, and the pi
   session dir under `config.pi.session_dir` (`state/pi-sessions/<session>`).
4. Builds the argv with `buildPiCommand`.
5. Mints a random **bridge generation** UUID, writes a `starting` receipt to
   `state/sessions/<session>.bridge-<generation>.json`, and launches the tmux
   session.
6. Records the birth in `state/sessions/<session>.json` (session name, birth
   timestamp, bridge generation).
7. Waits for either session kind's bridge to publish `ready` for that
   exact generation, and kills the session if it does not.

### The pi argv

`buildPiCommand` (`src/sessions.ts`) produces:

```
pi --approve --model <spec> --session-dir <dir> --system-prompt <path>
   [--theme <path>] (--extension <path>)... --name <session>
```

`--approve` pre-trusts project-local `.pi/` resources, so a session never
stalls on pi's interactive "trust this folder?" prompt. `--session-dir` is
per-session rather than pi's shared store, because every session shares one
working directory and archival needs to identify "the newest transcript for
*this* session" unambiguously.

The extensions are listed by `extensionPaths()` and their order is load-bearing
(pi registers handlers in load order):

1. `extensions/inject-bridge.ts` — the wake channel.
2. `packages/pi-plugin/extensions/ledger-pin.ts` — owns compaction.
3. `extensions/muted-theme.ts` — colours only.
4. `extensions/vendor/openviking-pi/index.ts` — memory tools, deliberately
   last, and the only extension here that is vendored rather than written
   in-tree.

These ride **per-spawn argv**, not the global pi settings. That is what makes a
lens pass a leaf: a lens session is given the bash guard and nothing else, so
the lens tool and the memory write surface do not exist inside it at all.

### The environment

`buildEnv(session, extra)` constructs the environment from scratch — never a
spread of `process.env`. It sets `HOME` to the pi home, `PATH`, `TERM`, `LANG`,
the `QCR_*` routing variables (`QCR_SANDBOX_ROOT`, `QCR_SESSION_NAME`,
`QCR_INJECT_DIR`, `QCR_LEDGER_FILE`, `QCR_SECRETS_DIR`, `QCR_PI_VERSION`,
`QCR_SUBAGENT_MAX_CONCURRENCY`), the `OPENVIKING_*` memory identity, and the
git config-scope pins from `sessionGitConfigPins`. When a durable command store
is bound it also passes `QCR_STATE_DB` and the two lease durations the bridge
needs. Callers add the rest through `extra`: `birthPrSession` supplies `QCR_PR`,
`QCR_PR_META` and `QCR_WORKTREE`, and `spawnSession` supplies the bridge
generation triple.

Two constraints hold here and are worth knowing before editing:

- **tmux panes inherit the tmux *server* environment, not the client's.** So
  per-session variables must ride the command line. `spawnSession` filters
  `buildEnv`'s result by `ARGV_ENV_PREFIXES` (`QCR_`, `OPENVIKING_`,
  `GIT_CONFIG_`) and prepends them as `env K=V … pi …`. A variable that only
  rides the client env silently does nothing.
- **argv is world-readable inside the container**, so nothing prefixed may be a
  secret. The memory API key therefore rides a 0600 credential file, not an
  environment variable; `secret()` reads credentials out of the secrets
  directory, never from `process.env`.

### The bridge readiness receipt

A live tmux process proves only that a container started. It does not prove
that the inject bridge opened its mailbox — and a wake written into a mailbox
nobody is watching is a silently lost instruction.

`src/session-bridge.ts` closes that gap (for the tmux-hosted sessions that remain: the replay harness). The daemon mints a generation UUID per
spawn and passes it as `QCR_SESSION_BRIDGE_GENERATION` with a state-file path in
`QCR_SESSION_BRIDGE_STATE_FILE`. The bridge writes `ready` to that file only
after it has registered its watcher and completed its first synchronous sweep of
the mailbox; `waitForSessionBridgeReady` polls for exactly that session and
generation. A `failed` or `closed` receipt throws immediately, a stale
generation is invisible, and a timeout kills the tmux session rather than
leaving a half-born one.

`currentBridgeReady(session)` re-reads the pair (birth file → generation →
bridge state) whenever the daemon needs to know whether a *pre-existing*
session is usable. Both PR and overseer births use it as a fence: a tmux session that is
alive but has no matching `ready` generation is killed and reborn, and the kill
is verified.

## Worktrees

`src/worktrees.ts` keeps one base clone plus one worktree per PR:

- base clone: `<root>/<clone_dir>` (`[github] clone_dir`, else the repo
  basename), cloned once by `ensureBaseClone`. `scripts/deploy.sh` derives
  the same name and passes it to the playbook as `-e base_clone_dir=…` — the
  rsync `--delete` keeps the VM's clone only because it is excluded by that
  name — and writes it into the checkout's local `.git/info/exclude`, never
  the tracked `.gitignore`. `ensureBaseClone` writes the same line
  itself (`ensureLocallyIgnored`, pure filesystem, best-effort) whenever the
  sandbox root is a checkout — `npm run daemon` and the plain-docker bind
  mount, which never run deploy.sh; on the VM there is no `.git` and it is a
  no-op;
- worktrees: `<root>/wt/pr-<n>`, detached, created or reset by `checkoutAt`.

`ensureWorktree(pr, { baseRef })` fetches the PR head into the local ref
`refs/qcr/pr-<n>` **and** the target branch into `refs/remotes/origin/<branch>`
in one `git fetch`, then materialises the worktree at the resolved head sha and
returns `WorktreeFacts` (`path`, `head_sha`, `base_ref`, `base_sha`,
`merge_base`). Fetching the base in the same call matters: passes are told to
check things "against the base branch's current head", and a base clone that is
only ever fetched at creation time answers that question from a stale snapshot.

`checkoutAt(pr, sha)` materialises an **already-fetched** sha without touching
the network. This is what keeps a round prompt honest: dispatch resolves the sha
once and every later step checks out that exact sha, so a push landing
mid-round cannot leave the tree ahead of the prompt.
`SessionHooks.dispatchRound` uses `hasCommit(order.head_sha)` to choose between
`checkoutAt` (normal) and a full `ensureWorktree` (only when no prepare step
ran).

The manager is read-only with respect to the reviewed repo: it clones, fetches,
resets, lists and removes. Nothing here commits, pushes, or writes a branch.
Other read-only helpers on it serve specific daemon checks —
`listMigrationFiles` (migration-numbering pre-check), `resolvedFilesInMerges`
(hand-resolved conflicts, `degraded: true` when the answer is unknown rather
than guessed), `lastHumanAuthor`, `headSha`.

`remove(pr)` drops the worktree, prunes, and deletes the PR's local ref;
`sweepStale(activePrs)` removes every `wt/pr-*` whose PR is no longer active and
is called from `PiSessionManager.preflight` at daemon start.

## The wake channel

The daemon never types into a pi TUI. It drops a Markdown file into
`inject/<session>/` and `extensions/inject-bridge.ts` — running *inside* that pi
process — picks it up and calls `pi.sendUserMessage`.

### Daemon side

- `injectFile(session, message)` writes one timestamped `.md` file atomically
  (tmp + rename, so a watch event never sees a partial file). Filenames sort
  oldest-first.
- `queuePrCommand(pr, kind, message, roundNo)` is the durable form used for PR
  sessions. It refuses if a blocking command already owns the session
  (`blockingSessionCommand`), writes the immutable payload to
  `state/session-commands/<id>.md`, creates the `session_commands` row, then
  writes the inject file. **At most one unsettled command per PR session** — the
  serialized lane that keeps "one instruction at a time" structural.
- `dispatchRound(order, renderedPrompt)` prepares the worktree, ensures the
  session, stamps the round receipt, saves the exact dispatched bytes to
  `state/round-prompts/pr-<n>-round-<k>.md`, and queues a `round` command.
- `inject(pr, message)` is the out-of-round wake. It respawns a dead session
  first (`ensureSessionForWake`, using the late-bound `setTitleResolver`), so a
  recheck or author-reply nudge after a restart is not lost.
- There is no overseer inject. What woke the overseer (anomalies, the daily
  heartbeat, authwatch's and the login refresher's alerts, the 18:00 EOD sweep,
  the self-requeue notice) is one item each in the companion inbox,
  `<root>/inject/companion-inbox/` (`src/companioninbox.ts`: durable, bounded,
  deduped). The companion's TUI pulls and acks the items.

### Bridge side

The bridge watches its directory and funnels **every** trigger through one
synchronous `drain()`, which walks `pendingFiles(dir)` in sorted order. Its
rules:

- **Consumption means accepted delivery.** A file moves to `.done/` only after
  pi emits a user `message_start` carrying the file's own marker. Pickup and
  submission are not consumption.
- **The busy flag brackets the agent RUN, not one turn.** `agent_start` and
  `turn_start` set it; only `agent_settled` clears it. `turn_end` and even
  `agent_end` must not — pi still runs retries and compaction afterwards.
- **A delivery that reaches a streaming agent is queued, not refused.** Every
  send passes `deliverAs: "followUp"` (`DELIVER_AS`). `steer` is deliberately
  never used: it interrupts the turn in progress, and a round's tail is exactly
  the part that must not be cut off.
- **`pi.sendUserMessage` is fire-and-forget.** Only a synchronous throw is
  observable at this seam, so failure detection cannot live here alone — hence
  the receipts and the supervisor below.
- **A PR's order is not a mailbox file.** The bridge once carried a durable
  command ledger and a start-lease redelivery for `pr-<n>` sessions
  (`extensions/session-command-ledger.ts`); a worker takes its order as its
  first message, so both were deleted with the receipt scan (P9.1). The old
  `session_commands` rows stay in the state database for the daemon's own
  bookkeeping, and the bridge's JSONL entries are tolerated on resume.

## Receipts: three markers, one question

The system carries three receipt tokens. All exist to answer *"did the
instruction actually reach the model?"* with a fact instead of an inference — a
transcript mtime cannot distinguish "the prompt arrived" from "the session was
busy doing something else", and a prompt is dropped precisely *because* the
agent is busy.

| Marker | Minted by | Shape | Read by |
| --- | --- | --- | --- |
| Round prompt | `stampRoundPrompt` (`packages/pi-plugin/src/types.ts`), appended to the rendered prompt at dispatch | `<!-- qcr-round: pr-<n> round-<k> -->` | `SessionHooks.roundPromptAccepted` |
| Recheck nudge | `recheckPromptMarker` (`packages/pi-plugin/src/types.ts`) | `<!-- qcr-recheck: pr-<n> <fingerprint> -->` | `SessionHooks.wakeReceiptPresent` |
| Durable command | `sessionCommandMarker` (`packages/pi-plugin/src/session-command.ts`), appended by the bridge at submit | `<!-- qcr-command:<id>:<sha256> -->` | the bridge's own `message_start` correlation, and the supervisor |

`PiSessionManager.wakeReceiptPresent(pr, marker, sinceMs)` is the one reader.
It walks the session's transcript directory, skips files older than the window,
and substring-searches the raw `.jsonl` (the markers are plain ASCII, so they
survive JSON encoding byte-for-byte). Its answer is deliberately three-valued:

- **present** ⇒ delivered;
- **absent, with readable candidate files** ⇒ never delivered;
- **`null`** ⇒ unknown — no session dir, nothing written yet, or any read that
  failed. An I/O failure anywhere in the scan makes the whole answer unknown
  and logs a `receipt_scan_unreadable` event.

**Unknown is never read as loss.** Treating an unreadable transcript as "never
arrived" kills live conversations, which is why the unreadable flag is scan-
global and why it is logged rather than swallowed.

## Recovery: redeliver first, kill last

A missing prompt is a *delivery* fault, so the cheap fix comes first.

`redeliverRound(pr, roundNo)` re-writes the **exact dispatched bytes** — read
back from the command payload (hash-checked) or from
`state/round-prompts/` — into the same session, same round, same conversation.
It never re-renders: a fresh render would change the order (different head,
different memory block, different scope note), so the session would receive a
round the daemon never recorded. It returns `false` when the bytes are gone, and
the caller then falls through to the expensive path rather than inventing a
prompt.

`redeliverSessionCommand(commandId, observed)` is the same cheap
fix for ANY durable command — round prompt or wake — whose start lease ran out
on a **live, bridge-ready** session: it hands the same row back to `pending`
and rewrites the same bytes at the same inject path. Nothing is killed. The
CAS is on `observed`, the row as the supervisor found it DUE (attempt,
`redeliveries` — its own column — and `next_check_at`), never on a fresh read:
a bridge that reserved the command after the due check holds a fresh
submission pi may still be preflighting, so that row answers `raced` and keeps
its own lease. The bridge that still holds the command as
submitted-but-unstarted drops that barrier and resubmits only when pi never
took it (pi's `input` event, emitted right after its compaction refusal and
before the rest of its preflight, never carried the wake's marker), the
submission is at least a start lease old, and pi itself says it holds nothing —
`ctx.isIdle()` (no run, no compaction) and no queued prompt
(`ctx.hasPendingMessages()`). Whenever one of those cannot be shown the
barrier stays, because unknown is never loss. If the original submission
starts after all, the bridge takes the handed-back row over and accepts it.
`not_live` (tmux gone, or no ready bridge generation) hands over to the replay
below.

`retrySessionCommand(commandId, reason)` is the harder recovery: it verifies the
payload hash, **kills the tmux session and proves it dead**, re-checks that the
round is still owed, atomically returns the same row to pending, rewrites the
same inject path, and rebirths. Rebirth without a delivery-attempt increment is
reported as a failed retry, not a success — a bridge that became ready without
reserving the command delivered nothing. It runs on a missing start only when
the session is provably dead or its `max_prompt_redeliveries` redeliveries are
spent, because a live, idle session's wake may merely have waited behind the
post-verdict compaction, and killing it would cost the conversation. The replay lands in a
new session generation, so it resets `redeliveries`: the reborn conversation
gets its own bounded redeliveries before any further kill (every replay still
spends a `recovery_attempts`).

`src/session-command-supervisor.ts` is the reconciler over that one durable slot
— explicitly *not* a second scheduler. Delivery stays bridge-owned and round
recovery stays with the verdict watcher; the supervisor only classifies finite
start/finish obligations from durable state plus receipts, and reports its own
freshness through a supervisor lease (`round-stage`, stale after
`round_stage_supervisor_stale_s`). Its evidence rules, in `missingStart`:

- receipt present **and** session dead ⇒ contradictory; fail the round/command;
- receipt present ⇒ reconcile the start stamp (using progress-sidecar identity
  when available, otherwise the already-expired lease as the conservative
  latest possible origin — never observation time, which would let an outage
  reset the hard cap);
- receipt definitively absent, or session definitively dead ⇒ recover —
  **redelivery first** into a live, bridge-ready session (above), at most
  `max_prompt_redeliveries` times (`session_command_redelivered`,
  `…_redelivery_exhausted`); the kill-and-replay only after that, or at once
  for a dead session;

A worker's ack is its receipt, so the supervisor never defers a command for
compaction or for unknown transcript evidence.

`src/daemon.ts` runs `roundStages.scan()` once at startup (off the critical
path) and on the deadline tick.

Relevant `[daemon]` knobs in `config.example.toml`:
`session_bridge_ready_timeout_s`,
`session_command_running_max_min`, `session_command_unknown_grace_s`,
`session_command_max_start_retries`, `max_prompt_redeliveries`,
`round_stage_supervisor_stale_s`, `overseer_rotation_days`.

## Live round progress

SQLite is authoritative for the round plan, its timing and its verdict. It
cannot see what the parent session and its subagents are doing *right now*.

The worker's LiveEvent log, projected by `src/live/`, publishes that ephemeral
state and nothing else (the tmux pi extension that once did is gone). It observes tool-execution events, keys each subagent by **invocation**
rather than by agent name (a parent may launch the same lens twice, and the
second run must not inherit the first run's terminal timestamp), and atomically
writes `state/round-progress/pr-<n>.json`. It returns immediately when `QCR_PR`
is absent, so the overseer publishes nothing. It never drives a session and
never writes daemon state.

`packages/pi-plugin/src/round-progress.ts` is the reader. `parseRoundProgress` validates an
untrusted sidecar hard — version, identity, monotonic milestones, per-agent
started/finished coherence, unique execution ids — and returns `undefined` for
anything malformed. `roundExecutionStage` classifies the parent as `unknown`,
`accepted`, `preparing`, `fanout-started`, `passes-complete` or `finalized`
from **immutable milestones plus the authoritative plan**; activity text and
heartbeat age are deliberately excluded, because they can describe a stage but
can never renew one. `lensForAgent` strips the `--<tier>` suffix, which is the
single normalization seam between the plan (lenses) and pi (built agent names).

## The ledger, and surviving compaction

A PR session maintains a fenced block beginning `LEDGER PR #<n> @ <sha>` — the
running record of what the review has established. pi's compaction is
token-driven and would summarise it away.

`packages/pi-plugin/extensions/ledger-pin.ts` prevents that. On `turn_end` it extracts the newest
ledger block and mirrors it to `state/ledgers/<session>.md` (only on change).
On `session_before_compact` it returns a real `compaction`: pi's own
default summary, made by calling the package's exported `compact()` with the
session model's auth, with the pinned ledger block appended verbatim. pi 1.0.0
reads only `cancel` and `compaction` from that hook (any other field, such as
`instructions`, `summary`, `retainedTail` or `details`, is ignored). Any
failure on that path returns nothing, so pi runs its default compaction rather
than a cancelled one. The hook also appends a `qcr-review-ledger` custom entry
(`appendEntry(customType, data)`) to the session file, so archival never
depends on the summariser.

The daemon hands the ledger back too, without any pi API:
every round order carries the mirrored block from `state/ledgers/pr-<n>.md`
(`packages/pi-plugin/src/ledgercarry.ts`, bounded, the path named, rendered as
`{{ledger_note}}`), and the ledger's `SETTLED:` items become the order's
`settled_digest`. No ledger file, or another PR's, means no section and an
empty digest.

Two details are load-bearing:

- **Only the session's own PR counts.** `parseOwnPr(process.env.QCR_PR)` gates
  extraction: sessions quote sibling PRs' ledger headers when reading other
  reviews for format reference, and without the filter a session will persist
  another PR's ledger over its own. No `QCR_PR` (the overseer) mirrors nothing.
- **This extension owns compaction alone.** The vendored memory extension's
  own `session_before_compact` handler is removed by
  `extensions/vendor/openviking-pi/patches/0001-remove-session-before-compact-handler.patch`
  for exactly this reason.

Round-end compaction is the worker's, before it exits. The inject bridge only
holds its mailbox while pi compacts: pi 1.0.0 refuses every prompt then
("Cannot submit a prompt while compaction is in progress"), the refusal is
swallowed, and manual compaction emits no `agent_settled`. The bridge watches
`session_before_compact` / `session_compact` / `session_compact_failed` (and pi's
own `ctx.isIdle()`, which counts compaction), drains when it ends, and
publishes the state in its ready receipt (`compaction: {state, seq, started_at,
ended_at, outcome, source}`), which the overseer's rotation reads. The daemon
never types `/compact` into the pane.

## Prompts and rendering

`packages/pi-plugin/src/templates.ts` renders every piece of prompt text the daemon hands pi. Its
one contract: `render` substitutes `{{name}}` placeholders and **throws** on a
placeholder it was given no value for (`UnknownPlaceholderError`). A supplied
value the template does not use is fine — templates are edited independently of
the renderer — but a `{{…}}` reaching a model is treated as a bug.

- **The system prompt**, substituted at session birth:
  `renderConversationSystemPrompt` (`prompts/conversation-system.md`, given the
  PR number, title and worktree). It also receives the identity variables
  (`owner_name`, `repo`, `bot_login`) from `identityVars` in `packages/pi-plugin/src/include.ts`,
  which degrade to neutral role wording when the config leaves them empty.
- **Round prompts**: `ROUND_TEMPLATE_FILES` maps each round type to
  `prompts/round-first.md`, `round-re-review.md` or `round-staleness.md`;
  `RECHECK_TEMPLATE_FILE` is the fourth (`round-recheck.md`), used by a recheck,
  which starts no round. `roundVars` assembles the full variable set from the
  `RoundOrder` — head and base shas, the pass plan table, addable lenses, the
  settled digest, the memory sections, and the various per-round notes — and
  `renderRoundPrompt` wraps `render` in `ensurePinnedHead`, which prepends the
  pinned memory head to any rendered prompt that does not already carry it, so
  no template edit can silently drop it.
- Memory is never allowed to block a round: `roundVars` defaults to
  `MEMORY_LESS`, so a caller that knows nothing about memory (or a memory
  engine that is down) renders exactly the prompt it would have rendered
  without it.

The rendered round prompt is then stamped with its receipt and saved verbatim
by `dispatchRound` — see [Receipts](#receipts-three-markers-one-question).

## Lens agents: built, never hand-edited

The pass definitions under `agents/` are markdown files with YAML frontmatter,
and they are not what pi reads. `buildAgents(srcDir, outDir, opts)` in
`packages/pi-plugin/src/include.ts` compiles them into `state/agents/`, and the container
entrypoints symlink `$HOME/.pi/agent/agents` at that directory so the subagent
tool's default "user" discovery scope finds exactly the built variants.
`src/wire.ts` runs the build once at daemon start, and rebuilds it when the
operations day rolls over and when new review feedback is ingested.

For each source `agents/pass-*.md`, the build:

1. expands `{{include:<path>}}` directives recursively (relative to the root; a
   cycle, a missing file, or excessive nesting throws — never a silently
   emitted literal directive). This is how the shared contract in
   `prompts/pass-common.md` reaches every pass;
2. expands `{{owner_name}}` / `{{repo}}` / `{{bot_login}}` identity variables
   over the **seed material only**, with an unknown variable failing the build.
   Addenda are code-authored and may quote untrusted text, so a `{{…}}` inside
   one stays data;
3. appends the composed addendum (below);
4. fans the result out into one file per tier, `<pass>--<tier>.md`, rewriting
   the `name:`, `model:` and `thinking:` frontmatter fields;
5. strips agent-spawning tools from `tools:` (`stripAgentSpawnTools`: `subagent`,
   `subagents`, `task`, `agent`, `agents`, `dispatch`), drops names pi has no
   tool for (`glob`, `dropNonPiTools`), and normalizes the memory tools: none,
   because no lens leaf loads the memory extension (`LENS_LEAVES_LOAD_MEMORY`),
   or exactly `LEAF_MEMORY_TOOLS` (`viking_search`, `viking_read` — read, never
   write) for a build whose caller says its leaves have them. A pass with no
   `tools:` line is left alone, because an absent
   list means "whatever the harness gives you" while a present one is an
   allowlist;
6. writes each file atomically (tmp + rename in the same directory), because a
   rebuild can happen while a session's subagent tool is discovering agents;
7. sweeps `state/agents/` of anything this build did not produce, so a stale
   definition can never bypass the tier scheme.

### The addendum registry

Most of `agents/pass-*.md`, and `prompts/pass-common.md`, are frozen seeds —
`tests/fixtures/seed-manifest.json` names exactly which files are pinned, and
`tests/seed-integrity.test.ts` enforces both the hashes and the rule that files
we *do* own never sneak into that manifest. Every rule that binds pass
behaviour is therefore delivered as an **addendum**: an entry in
`PASS_ADDENDA` (`packages/pi-plugin/src/include.ts`) appended to the BUILT body, never written into
a seed. An entry declares `id`, `scope` and `text`; `scope` is `"all"`,
`"lenses"` (every pass that produces findings, i.e. all but `pass-validate`), or
an explicit list of pass names. **Declaration order is composition order**, so a
rebuild of an unchanged tree produces byte-identical bodies.

`addendaForPass` and `composeAddendum` are the whole API. `wire.ts` composes in
a fixed order: the built-in registry, then the repo profile's addenda pack, then
the same-day feedback addendum if there is one.

One addendum is *derived* rather than written: `ALLOWED_COMMANDS_CLAUSE` renders
the "Allowed commands" sentence from `ALLOWED_PROGRAMS` in
`packages/pi-plugin/extensions/bash-guard.ts`, so the prompt cannot advertise a command the guard
has stopped admitting. See [the exec boundary](../exec-boundary.md).

**This registry is the only sanctioned way to change pass behaviour.** Editing a
seed is a different act with a different owner — see
[ownership](../ownership.md) for the freeze, the divergence registry, and who
may ratify a reseed.

### Tiers

`PassTier` (`packages/pi-plugin/src/types.ts`) is `terra-med` | `sol-med` | `sol-high`, ascending,
with `PASS_TIER_ORDER` as the single place the order is written down.
`tiersForPass(pass, riskPasses, validateTier)` decides the fan-out:

- a pass listed in `[models] risk_passes` builds **only** the `sol-high`
  variant;
- `pass-validate` builds every tier at or above `[models] validate_tier`,
  because that setting is a **floor**, not a pin — dispatch raises the validator
  to the round's highest lens tier (`validatorTier` in `src/dispatch.ts`), and
  every tier it could raise to must exist on disk;
- every other pass builds all three.

`[models.tiers]` maps each tier to a full model spec, `provider/model:thinking`.
The whole spec goes into the built `model:` field: pi's `--model` accepts the
`:thinking` suffix, and the lens runner reads only that one field.
`thinking:` is rewritten as well, so the built file stays accurate for a human
reader, but the runner ignores it. `splitModelSpec` is the parser.

## The lens tool

Lenses run through our own tool, `lens` (one or a parallel batch) and
`lens_wave` (join the round's planned discovery wave), from
`packages/pi-plugin/src/engine/lens/`; the companion loads the same code as `packages/pi-plugin/extensions/lens.ts`.
Each lens is an SDK session of the process that hosts the round. pi's own
subagent example and the glue that wrapped it (`extensions/subagents.ts`, with
its `cwd` stripping, chunking and spawn patch) are retired: an SDK lens has no
child process to confine.

1. **A process-wide fan-out cap.** The lens runner's weighted semaphore, sized
   from `QCR_SUBAGENT_MAX_CONCURRENCY` (`[engine] lens_max_concurrency`; code
   default 4) and, on the bot, the daemon's permit broker (`[daemon]
   lens_permits`).
2. **Scope pinning.** The agents come from the agent dir's `agents` (the
   `user` scope), or from the nearest `.pi/agents` for the bench's `project`
   scope (`lensAgentsDir`).
3. **A guard on every lens.** `bashGuard` is a required field of the runner's
   config, attached to every pass; `tests/lens-runner.test.ts` pins it.

## Adoption, archival, rotation

- **Adoption.** `adopt()` lists tmux sessions, filters by `isSandboxSession`,
  and reports what it found. It is purely observational: a daemon restart takes
  live sessions over and kills nothing. `preflight(activePrs)` combines that
  with the stale-worktree sweep.
- **Restart reconstruction.** `restorePendingSessionCommands()` recreates inject
  files for provably **pending** rows from their immutable payload, hash-checked;
  a mismatch fails the command loudly rather than delivering different bytes. A
  **running** row is never resubmitted by a restart — replaying it would create
  two shepherds; it belongs to its bridge owner until bounded recovery decides
  otherwise.
- **Archival.** `archiveSession(session, dest)` copies the newest transcript,
  the ledger snapshot and the PR's verdict files into `archive/<session>/` with
  a `meta.json`. `archiveAndClose(pr)` archives, removes the worktree, kills
  tmux, and only then deletes the PR's raw-notes memory session — after the kill,
  so nothing is still writing into it.
- **Killing.** `killSession(pr)` kills and **verifies the session is gone**,
  throwing otherwise; recovery must never dispatch beside a survivor. The ledger
  on disk is the continuity that survives a kill by design. Supervisor callers
  pass the exact command reservation; a changed owner returns false without a
  kill. The kill is serialized with session births so it cannot kill a successor.
- **Rotation.** `rotateOverseerIfDue()` archives the overseer run under a dated
  directory and respawns it once it is older than `[daemon]
  overseer_rotation_days`.

Automatic overseer rotation requires the current bridge generation to report
`run_status: idle` and idle compaction, with no pending wake files. Acceptance
moves a wake into `.done/` before the agent finishes, so an empty mailbox alone
is not proof of idle work. The bridge reports active at run start and returns
to idle only after `agent_settled` drains its acknowledgement. Older bridge
receipts without `run_status` remain accepted as input but hold automatic
rotation as unknown; an explicit operator restart remains available. Idle
telemetry only admits a generation-bound retirement request: it never authorizes
a kill. The owning bridge rechecks its generation, active work, compaction,
pending mailbox and Pi's own idle/queued-message state in one synchronous
callback before exiting itself. The manager archives and rebirths only after
tmux positively confirms disappearance. A timeout or unknown liveness does
neither, so a failed active-state receipt write cannot terminate active work.

## Invariants to preserve

If you are editing this area, these are the properties that are enforced
structurally rather than by convention:

1. **Two daemon-owned session kinds.** `ensurePrSession` and
   `ensureOverseerSession` are the only spawn callers; a third kind is a
   topology change, not a feature. See
   [docs/single-shepherd-invariant.md](../single-shepherd-invariant.md).
2. **One unsettled command per PR session.** `queuePrCommand` refuses while a
   blocking command exists. Any new "claim then send" path needs its own bound
   and its own release-on-provable-non-delivery sweep.
3. **Delivered means acknowledged.** A wake file leaves `inject/` only on a
   marker-correlated user `message_start`, and only `agent_settled` frees the
   mailbox. A compaction holds it too: nothing is submitted until it ends.
4. **Unreadable is not empty.** Receipt reads are three-valued; `null` must
   never be collapsed into "lost".
5. **Redelivery sends the exact dispatched bytes.** Never re-render a prompt to
   recover it.
6. **Passes are leaves.** Enforced in three independent places: the built
   frontmatter (`stripAgentSpawnTools`), the argv-only extension loading (a
   child never gains the tool), and the command guard.
7. **Seeds are frozen; behaviour changes go through `PASS_ADDENDA`.** See
   [docs/ownership.md](../ownership.md).
8. **Nothing prefixed onto the session argv may be a secret.**
