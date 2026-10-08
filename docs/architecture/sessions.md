# Sessions and pi — how the daemon drives the coding agent

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
| Wake-file delivery inside pi | `extensions/inject-bridge.ts` |
| Cross-process command ledger (bridge side) | `extensions/session-command-ledger.ts` |
| Bridge readiness receipt | `src/session-bridge.ts` |
| Durable command marker | `src/session-command.ts` |
| Daemon-side reconciler over that slot | `src/session-command-supervisor.ts` |
| Live lens progress (publisher / reader) | `extensions/round-progress.ts`, `src/round-progress.ts` |
| Ledger survival across compaction | `extensions/ledger-pin.ts` |
| Lens agent build + addendum registry | `src/include.ts` |
| Prompt rendering | `src/templates.ts` |
| Glue over pi's own subagent extension | `extensions/subagents.ts` |
| Model tiers, session dir, fan-out cap | `config.example.toml` `[models]`, `[pi]`; `src/config.ts` |

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
7. For a PR session only: waits for the bridge to publish `ready` for that
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
2. `extensions/ledger-pin.ts` — owns compaction.
3. `extensions/muted-theme.ts` — colours only.
4. `extensions/round-progress.ts` — read-only progress sidecar.
5. `extensions/subagents.ts` — the fan-out tool.
6. `extensions/vendor/openviking-pi/index.ts` — memory tools, deliberately
   last, and the only extension here that is vendored rather than written
   in-tree.

These ride **per-spawn argv**, not the global pi settings. That is what makes a
lens pass a leaf: a subagent child process loads only the globally-registered
extensions, so the `subagent` tool and the memory write surface do not exist
inside a child at all.

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

`src/session-bridge.ts` closes that gap. The daemon mints a generation UUID per
spawn and passes it as `QCR_SESSION_BRIDGE_GENERATION` with a state-file path in
`QCR_SESSION_BRIDGE_STATE_FILE`. The bridge writes `ready` to that file only
after it has registered its watcher and completed its first synchronous sweep of
the mailbox; `waitForSessionBridgeReady` polls for exactly that session and
generation. A `failed` or `closed` receipt throws immediately, a stale
generation is invisible, and a timeout kills the tmux session rather than
leaving a half-born one.

`currentBridgeReady(session)` re-reads the pair (birth file → generation →
bridge state) whenever the daemon needs to know whether a *pre-existing*
session is usable. `birthPrSession` uses it as a fence: a tmux session that is
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
- `injectOverseer` / `injectOverseerFile` wake the overseer; the latter returns
  the file path for callers that bind an origin record to it.

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
- **The durable ledger is fail-closed for managed PR sessions.**
  `QCR_SESSION_BRIDGE_LEDGER_REQUIRED` defaults on for a `pr-<n>` session; a
  missing generation, state file, or `QCR_STATE_DB` fails the bridge loudly
  instead of running unledgered. `extensions/session-command-ledger.ts` opens
  the daemon's SQLite file directly (WAL), and every transition is one guarded
  UPDATE carrying an `owner_token`, so an extension instance that survived a
  recovery cannot terminalize a newer attempt.

## Receipts: three markers, one question

The system carries three receipt tokens. All exist to answer *"did the
instruction actually reach the model?"* with a fact instead of an inference — a
transcript mtime cannot distinguish "the prompt arrived" from "the session was
busy doing something else", and a prompt is dropped precisely *because* the
agent is busy.

| Marker | Minted by | Shape | Read by |
| --- | --- | --- | --- |
| Round prompt | `stampRoundPrompt` (`src/types.ts`), appended to the rendered prompt at dispatch | `<!-- qcr-round: pr-<n> round-<k> -->` | `SessionHooks.roundPromptAccepted` |
| Recheck nudge | `recheckPromptMarker` (`src/types.ts`) | `<!-- qcr-recheck: pr-<n> <fingerprint> -->` | `SessionHooks.wakeReceiptPresent` |
| Durable command | `sessionCommandMarker` (`src/session-command.ts`), appended by the bridge at submit | `<!-- qcr-command:<id>:<sha256> -->` | the bridge's own `message_start` correlation, and the supervisor |

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

`redeliverSessionCommand(commandId, observed)` (H1b) is the same cheap
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
reserving the command delivered nothing. Since H1b it runs on a missing
start only when the session is provably dead or its `max_prompt_redeliveries`
redeliveries are spent: on 2026-10-08 it killed seven live, idle sessions whose
wake had merely waited behind the post-verdict compaction. The replay lands in a
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
- the session's bridge reports a compaction running (H1b) ⇒ late, not
  lost: the start lease is held open, re-checked every
  `session_command_unknown_grace_s`, bounded by the compaction's own start +
  `session_compaction_max_s` (600 s); event `session_command_start_deferred`.
  This comes before the receipt is read, and only for a session not provably
  dead — liveness is read first, and `sessionCompaction` reports nothing once
  tmux holds no session (a pi killed mid-compaction never rewrites its
  "running" receipt);
- receipt definitively absent, or session definitively dead ⇒ recover —
  **redelivery first** into a live, bridge-ready session (above), at most
  `max_prompt_redeliveries` times (`session_command_redelivered`,
  `…_redelivery_exhausted`); the kill-and-replay only after that, or at once
  for a dead session;
- otherwise **unknown**, deferred a bounded number of times
  (`session_command_unknown_grace_s`, `session_command_unknown_max_checks`)
  before recovery.

`src/daemon.ts` runs `roundStages.scan()` once at startup (off the critical
path) and on the deadline tick.

Relevant `[daemon]` knobs in `config.example.toml`:
`session_bridge_ready_timeout_s`, `session_command_start_lease_s`,
`session_command_running_max_min`, `session_command_unknown_grace_s`,
`session_command_unknown_max_checks`, `session_command_max_start_retries`,
`session_compaction_max_s`, `max_prompt_redeliveries`,
`round_stage_supervisor_stale_s`, `overseer_rotation_days`.

## Live round progress

SQLite is authoritative for the round plan, its timing and its verdict. It
cannot see what the parent session and its subagents are doing *right now*.

`extensions/round-progress.ts` publishes that ephemeral state and nothing else.
It observes pi's tool-execution events, keys each subagent by **invocation**
rather than by agent name (a parent may launch the same lens twice, and the
second run must not inherit the first run's terminal timestamp), and atomically
writes `state/round-progress/pr-<n>.json`. It returns immediately when `QCR_PR`
is absent, so the overseer publishes nothing. It never drives a session and
never writes daemon state.

`src/round-progress.ts` is the reader. `parseRoundProgress` validates an
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

`extensions/ledger-pin.ts` prevents that. On `turn_end` it extracts the newest
ledger block and mirrors it to `state/ledgers/<session>.md` (only on change).
On `session_before_compact` it returns a real `compaction`: pi's own
default summary, made by calling the package's exported `compact()` with the
session model's auth, with the pinned ledger block appended verbatim. pi 1.0.0
reads only `cancel` and `compaction` from that hook; the earlier carriers
(`instructions`, `summary`, `retainedTail`, `details`) were all ignored. Any
failure on that path returns nothing, so pi runs its default compaction rather
than a cancelled one. The hook also appends a `qcr-review-ledger` custom entry
(`appendEntry(customType, data)`) to the session file, so archival never
depends on the summariser.

The daemon hands the ledger back too, without any pi API (MC-18):
every round order carries the mirrored block from `state/ledgers/pr-<n>.md`
(`src/ledgercarry.ts`, bounded, the path named, rendered as
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

Compaction itself is REQUESTED by the daemon (H1b): `compactSession(pr)`
writes `.compact-request.json` into the session's inject dir after a round's
verdict lands, and the inject bridge — the session's one mailbox consumer —
runs it through pi's own `ctx.compact()` once nothing is in flight (no run, no
submitted or active wake), before the wakes queued behind it. While pi
compacts, the bridge submits nothing: pi 1.0.0 refuses every prompt then
("Cannot submit a prompt while compaction is in progress"), the refusal is
swallowed, and manual compaction emits no `agent_settled`. The bridge watches
`session_before_compact` / `session_compact` / `session_compact_failed` (and pi's
own `ctx.isIdle()`, which counts compaction), drains when it ends, and
publishes the state in its ready receipt (`compaction: {state, seq, started_at,
ended_at, outcome, source}`, read by `sessionCompaction(pr)`). Before H1b the
daemon typed `/compact` into the pane: that aborted whatever turn was running,
and a wake flushed right after it was submitted into the compaction, refused
and never retried — seven healthy sessions were then killed as wedged in one
morning. Best-effort still: a bridge from before H1b ignores the request.

## Prompts and rendering

`src/templates.ts` renders every piece of prompt text the daemon hands pi. Its
one contract: `render` substitutes `{{name}}` placeholders and **throws** on a
placeholder it was given no value for (`UnknownPlaceholderError`). A supplied
value the template does not use is fine — templates are edited independently of
the renderer — but a `{{…}}` reaching a model is treated as a bug.

- **System prompts**, substituted at session birth:
  `renderConversationSystemPrompt` (`prompts/conversation-system.md`, given the
  PR number, title and worktree) and `renderOverseerSystemPrompt`
  (`prompts/overseer-system.md`). Both also receive the identity variables
  (`owner_name`, `repo`, `bot_login`) from `identityVars` in `src/include.ts`,
  which degrade to neutral role wording when the config leaves them empty. The
  overseer prompt is a frozen seed, so the Slack contract is appended by
  `slackAppendix()` at spawn time rather than written into the file; with Slack
  off the prompt is byte-identical to the seed.
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
`src/include.ts` compiles them into `state/agents/`, and the container
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
   `subagents`, `task`, `agent`, `agents`, `dispatch`) and normalizes the memory
   tools to exactly `LEAF_MEMORY_TOOLS` (`viking_search`, `viking_read` — read,
   never write). A pass with no `tools:` line is left alone, because an absent
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
`PASS_ADDENDA` (`src/include.ts`) appended to the BUILT body, never written into
a seed. An entry declares `id`, `scope` and `text`; `scope` is `"all"`,
`"lenses"` (every pass that produces findings, i.e. all but `pass-validate`), or
an explicit list of pass names. **Declaration order is composition order**, so a
rebuild of an unchanged tree produces byte-identical bodies.

`addendaForPass` and `composeAddendum` are the whole API. `wire.ts` composes in
a fixed order: the built-in registry, then the repo profile's addenda pack, then
the same-day feedback addendum if there is one.

One addendum is *derived* rather than written: `ALLOWED_COMMANDS_CLAUSE` renders
the "Allowed commands" sentence from `ALLOWED_PROGRAMS` in
`extensions/bash-guard.ts`, so the prompt cannot advertise a command the guard
has stopped admitting. See [the exec boundary](../exec-boundary.md).

**This registry is the only sanctioned way to change pass behaviour.** Editing a
seed is a different act with a different owner — see
[ownership](../ownership.md) for the freeze, the divergence registry, and who
may ratify a reseed.

### Tiers

`PassTier` (`src/types.ts`) is `terra-med` | `sol-med` | `sol-high`, ascending,
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
`:thinking` suffix, and the native subagent extension reads only that one field.
`thinking:` is rewritten as well, so the built file stays accurate for a human
reader, but the extension ignores it. `splitModelSpec` is the parser.

## The subagent tool

`extensions/subagents.ts` is first-party glue over **pi's own** subagent
extension. It imports the native extension at runtime from the installed pi
package (`getExamplesPath()` + `extensions/subagent/index.ts`), so there is no
vendored copy that can drift from the version pin: bumping pi bumps the
extension with it. If either import fails the tool is simply never registered —
logged as fatal, never a crashed pi — and the round templates' "unknown agent ⇒
stop" rule takes over.

The glue exists to add three things the native extension does not provide:

1. **A process-wide fan-out cap.** The native tool caps concurrency only *within*
   one `tasks:[…]` call. Several single-mode calls in one assistant turn — the
   pattern the round templates mandate — run uncapped, because pi dispatches a
   turn's tool calls in parallel. `WeightedSemaphore` restores the process-wide
   cap from `QCR_SUBAGENT_MAX_CONCURRENCY` (`[pi] subagent_max_concurrency`;
   code default `DEFAULT_MAX_CONCURRENCY` = 4). `callWeight` charges a parallel
   call `min(tasks, NATIVE_IN_CALL_CONCURRENCY, permits)` and everything else 1.
2. **`cwd` stripping and scope pinning.** `sanitizeParams` deletes `cwd` at the
   top level and inside `tasks[]` and `chain[]`, so a child always runs in the
   parent's own working directory and can never be pointed into a reviewed-repo
   worktree whose `.pi/` resources always-on project trust would load. It also
   pins `agentScope` (`resolveScope`, default `"user"`) and forces
   `confirmProjectAgents: false`.
3. **Chunking.** The native tool rejects a `tasks` array longer than
   `NATIVE_MAX_PARALLEL_TASKS` (8) before starting any child, so `wrapExecute`
   feeds it stable contiguous chunks sequentially under one semaphore lease —
   selecting nine legitimate lenses cannot become a zero-pass round.

The wrapping is done through a `Proxy` that intercepts `registerTool` and wraps
only the `subagent` tool's `execute`; everything else passes through to the real
API.

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
  on disk is the continuity that survives a kill by design.
- **Rotation.** `rotateOverseerIfDue()` archives the overseer run under a dated
  directory and respawns it once it is older than `[daemon]
  overseer_rotation_days`.

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
