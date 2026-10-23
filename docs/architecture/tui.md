# The operator TUI and the companion

Two things ship on the operator's own machine and are documented together
because they share one frame, one poll cadence and one set of files:

- **the TUI** (`src/tui/`, started by `qcr tui`) — a full-screen terminal
  board over the daemon. It reads the daemon's state, shows each PR's live
  transcript (and mirrors the pi of a takeover or a debug round), and has exactly two paths that write anything back.
- **the companion** (`src/tui/companion.ts`, the release image in `companion` mode) — a local
  pi session in a docker container on the same machine, permanently visible as
  the right-hand column of the TUI. It holds no credential for the deployment
  host and no path to GitHub.

[`tui.md`](../tui.md) is the **surface contract**: what each tab is for and
which key does what, written for someone using the TUI. This file is the
**architecture**: which module owns which mechanism, and what is structural
rather than conventional. [`sidebar-contract.md`](../sidebar-contract.md) is
the geometry contract for the companion column, and
[`tui-actions-wiring.md`](../tui-actions-wiring.md) records how the
companion→TUI action channel is wired into `src/tui/index.ts`.

## Where to look

| you want | file |
| --- | --- |
| terminal setup, key routing, repaint, selection | `src/tui/app.ts` |
| the eight surfaces and their digit keys | `src/tui/tabs.ts` |
| stdin chunk → decoded key | `src/tui/keys.ts` |
| the command bar, and what "registered" means | `src/tui/cmdbar.ts` |
| board rendering and the board's own keys | `src/tui/board.ts` |
| per-tab surfaces | `memtab.ts`, `digesttab.ts`, `ticketstab.ts`, `deploytab.ts`, `metricstab.ts`, `feedbacktab.ts`, `scantab.ts` |
| every remote command the TUI can issue | `src/tui/remote.ts` |
| the status poll and its health classification | `src/tui/poll.ts` |
| the two write paths | `src/tui/msg.ts`, `src/tui/unwedge.ts` |
| mouse decode, hit zones | `src/tui/mouse.ts` |
| clipboard writers | `src/tui/clipboard.ts` |
| empty/unknown rendering grammar | `src/tui/emptystate.ts` |
| bring-up progress | `src/tui/startup.ts` |
| ssh diagnosis and the one interactive connect | `src/tui/sshtriage.ts`, `src/tui/connect.ts` |
| hot reload | `src/tui/reload.ts`, `scripts/dev-tui.sh` |
| companion container lifecycle and pi argv | `src/tui/companion.ts` |
| the containerised TUI's companion: the plan the wrapper runs, the tmux-socket runner | `src/tui/companionplan.ts`, `src/tui/tmuxsocket.ts` |
| the companion image | the release image: `docker/Dockerfile`, and its `companion` mode in `docker/entrypoint.sh` (the agent set and health watcher in `docker/companion/`) |
| TUI → companion ambient files | `src/tui/feed.ts` |
| companion → TUI alerts (and the status.json-sourced pi-auth / memory alerts) | `src/tui/alerts.ts` |
| the memory-incident tracker ticket | `src/tui/memincident.ts` |
| companion → TUI actions | `src/tui/actions.ts` |
| daily conversation rollover | `src/tui/rollover.ts` |
| the companion's tool-call vetoes | `extensions/companion-guard.ts` |
| the companion's read-only view tools | `extensions/tui-view.ts` |
| assembly of all of the above | `src/tui/index.ts` |

## One layout, always

The frame is a tab rendered at a reduced width with the companion column
appended to its right, on every frame and in every configuration. `App.repaint`
(`src/tui/app.ts`) computes `sidebarWidth(cols)` first, renders the tab at
`innerWidth(cols)`, and calls `withSidebar` to concatenate the two; the tab is
rendered one column wider than `cols - sidebarWidth` because the tab's right
border and the column's left border are the same wall (`composeColumn` in
`src/tui/paint.ts` joins the seam).

Consequences that are enforced rather than agreed:

- **Nothing takes the whole terminal.** There is no attach screen and no
  `attach` hook on `AppHooks`; `parseTarget` in `src/tui/index.ts` refuses
  `qcr tui overseer` and `qcr tui main` with the place to go instead. The
  board's PR pane while it holds a takeover's or a debug round's pi
  (`src/tui/pipane.ts`) and the companion column (`src/tui/sidebar.ts`) are
  the only terminals, both embedded. Every other PR pane is the read-only
  transcript viewer (`src/tui/viewer.ts`): the bot runs no `pr-<n>` tmux
  session, and `remote.ts` types a capture or send-keys target as
  `debug-pr-<n>` | `takeover-pr-<n>` only.
- **Nothing folds the column away.** `--no-companion` and
  `[companion] enabled = false` decide what *runs* — no container, no ambient
  feed, no alert consumer — and what the column *says*
  (`app.sidebar.setOff(...)`), never whether it is there.
- **An unwired tab still paints inside the layout.** `TabHooks.screen` returns
  a `Frame`, never a bare string, and `placeholderFrame` builds one at the
  inner width, so a missing hook cannot produce a frame without the column.
- The only geometry state is the operator's dragged width
  (`CompanionSidebar.preferredWidth`), clamped to a minimum of 24 columns and
  to leaving 64 columns for the tab.
  [`sidebar-contract.md`](../sidebar-contract.md) has the exact row and border
  contract the column must satisfy.

`tests/tui-fixed-layout.test.ts` asserts this structurally — no pty, no attach
hook, no collapse state, and a column on the first frame of a `--no-companion`
run.

## The eight surfaces

`src/tui/tabs.ts` declares `TABS` — `board`, `memory`, `digest`, `tickets`,
`deploy`, `metrics`, `feedback`, `scan` — in the order their digit keys
`1`…`8` reach them. That module imports nothing, so `keys.ts`, `cmdbar.ts` and `actions.ts`
can all read the order without a cycle through `app.ts`. The identifier is
also the nav-bar label, the help-overlay word, and the tab name the
companion's `switch_tab` verb accepts.

The board is rendered by `App` itself (`renderBoard` in `src/tui/board.ts`).
The other seven install a `TabHooks` — `screen` / `key` / `click` / `keys` —
under `AppHooks.tabs[tab]` from their own module's `install…Hooks` function.
What each surface is *for* is [`tui.md`](../tui.md).

## Keys: painted ⇔ registered ⇔ answered

Three modules divide the work:

1. `src/tui/keys.ts` — `decodeKey` turns one stdin chunk into one `BoardKey`.
   Chunks are decoded whole, so interactive typing yields one key per chunk
   and a paste lands as a single `char` run. `keyChar` recovers the printable
   a decoded key was typed as, which is how the metrics tab's `# <pr>` box
   reads digits that would otherwise decode as tab switches.
2. `src/tui/cmdbar.ts` — the bar at the foot of every tab. Row A is the eight
   nav slots plus four globals (`r`, `s`, `?`, `q`), right-justified so their
   positions depend only on terminal width. The rows after it are the current
   tab's live commands. The bar **wraps** rather than dropping overflow, and
   `barHeight(tab, cols, commands)` tells each renderer how many rows it took
   so the body can give them up.
3. `App.registeredKeys()` — computed from the same `LiveKeys` the bar paints
   (`registeredKeys` in `cmdbar.ts`: globals + the tab's inline keys + its bar
   keys).

The rule that ties them together: **every printable the active tab does not
register is routed to the companion column and focuses it, seeded with that
character.** A registered key is therefore not inert if the tab will not act
on it — it steals a keystroke that would otherwise have reached the
companion. `TabHooks.keys` must be derived from the tab's current state, not
returned as a constant.

`TAB_VOCABULARY` and `TAB_INLINE_KEYS` in `cmdbar.ts` are the static universe
each tab may draw from; a live bar must be a subset.
`tests/tui-surfaces.test.ts` fails when [`tui.md`](../tui.md)'s per-tab key
tables and those vocabularies disagree, and `tests/fences-tui.test.ts` fails
when the `?` overlay's `HELP_LINES` (`src/tui/board.ts`) names a key the
vocabulary does not.

Two further rules:

- **A focused embedded pi surface is a terminal.** While `pipane.ts` or
  `sidebar.ts` holds the keyboard, every byte is forwarded to `tmux send-keys`
  — `/` menus, Esc, ⏎, Ctrl-C included. `PANE_ESCAPE` (Ctrl-q) is the one byte
  either keeps, and it releases focus. Neither module has a draft/input/text
  field, and adding one is the bug: pi's own input line is already on screen
  in the mirror. The quick-message box (`src/tui/msg.ts`) is a different
  thing — it addresses a session you are *not* focused on.
- **Board verbs are board-only.** `BOARD_ONLY_VERBS` in `app.ts` refuses
  `attach`/`enter`/`message`/`github`/`events`/`unwedge` off the board — the
  membership test is "is this advertised by the board's command bar", not
  "does it read the selection".

## The mouse: zones, and drag-to-copy

`src/tui/mouse.ts` turns SGR reports into `click` / `drag` / `release` /
`wheel-*` events and strips them from the buffer so key decoding never sees
them. `MOUSE_ON` includes `?1002h` (button-event tracking): without motion
reports there is no drag at all.

Renderers declare `Zone`s (1-based inclusive cells) and `hitTest` resolves a
point, last-declared winning, so a fine-grained zone (a PR number inside a
row) overrides the row zone under it. `barHitKey` in `cmdbar.ts` shares the
one `layout()` computation with `paintCmdBar`, so render and hit-test cannot
drift.

Turning mouse reporting on takes the terminal's own selection away, so the
TUI gives one back: **drag selects, release copies.** The selection is
**rectangular** — the screen is panes side by side, and a linear selection
would splice the list, the detail pane and the companion column together on
every row. `App.selectedText()` slices `this.lastFrame` **by display cell**
after `stripAnsi`, so what lands in the clipboard is exactly what was on
screen, as plain text and never an escape sequence. Writes go through
`ClipboardSink` (`src/tui/clipboard.ts`), which probes writers in order
because some terminal emulators ignore OSC 52 and the escape would silently
evaporate. The one drag that is not a selection is a drag starting on the
companion column's left border, which resizes it.

## Transport: ssh or local

`src/tui/remote.ts` is the single place that reaches the daemon. Command
construction is pure (`statusArgv`, `whyArgv`, `progressArgv`, `eventsArgv`,
`todayArgv`, `metricsArgv`, `captureArgv`, `sendKeysArgv`), and execution goes
through one injectable `SshRunner`, so tests assert exact argv and never
spawn.

`transportOf(cfg)` reads the explicit `[tui] target` knob — never inferred
from `ssh_host`'s value:

- `"ssh"` — `realSshRunner` runs `ssh <host> <argv…>`, all of it sharing one
  ControlMaster.
- `"local"` — `realLocalCommandRunner` runs the same argv on this machine and
  ignores `host`; no ssh process is ever spawned. `sudo_docker` still decides
  the sudo prefix.

`runnerFor(cfg)` picks, and callers keep the same `ssh(cfg.ssh_host, argv)`
shape either way.

Two commands are read-only cats against the host-mounted state directory
(`status.json`, `round-progress/pr-<n>.json`); the rest are `docker exec` into
the daemon container running `qcr` subcommands with `--json`. None of them
touch GitHub, so none go near the mutation gate.

**The poll.** `Poller` (`src/tui/poll.ts`) fetches `status.json` on
`[tui] poll_interval_s` with linear backoff (interval × consecutive failures,
capped at ×5). `classifyHealth` is pure and ranks, in order: no successful
fetch → `unreachable`; snapshot `written_at` older than `stale_after_s` →
`stale`; a `pipeline.healthy === false` snapshot → `pipeline_unhealthy`;
otherwise `ok` with the daemon's heartbeat age. Ages are judged against wall
clock, so a dead daemon behind a healthy ssh path still degrades to stale.

Observers hang off one cadence. `chainOnPoll` (`src/tui/poll-hooks.ts`)
composes onto `AppHooks.onPoll` rather than assigning it — the feed writer,
the evidence copier, the alert consumer, the action sweep and deploy
coordination all share it, and a feature that assigns would silently unhook
the others.

**Connection failures are triaged, not self-healed.** `src/tui/sshtriage.ts`
collects bounded, non-interactive probes and `classifyConnection` (pure)
names one of `ok` / `local` / `no-agent-key` / `wedged-master` /
`host-unreachable` / `unknown`, each with its own cause sentence and its own
exact remedy command. The TUI prints the command and never runs it; `s`
re-runs the triage. `src/tui/connect.ts` holds the one interactive path:
`ensureSshMaster` births the shared ControlMaster with a `ssh <host> true`
that may prompt for the key passphrase on the real terminal. It is called from
the `s` handler only, and only for the `no-agent-key` and `unknown` classes —
prompting against a wedged master or a dead host would just hang — and never
from startup, where an interactive prompt would sit between the operator and
the first frame.

## The two write paths

Everything else the TUI does against the deployment host is a read. Exactly
two paths write, both user-initiated:

**1. Quick message (`m`) — `src/tui/msg.ts`.** Writes
`inject/<session>/<iso-ts>-tui-NNNN.md` inside the container with an atomic
tmp+rename, matching the daemon's own writes, and then polls for the inject
bridge's `.done/<name>` archive as the delivery confirmation. The message
rides stdin, so nothing from the text ever reaches a shell command line.
`isValidSessionName` is a closed set — `overseer`, `main`, `pr-<digits>` — and
it is the only thing a remote path is ever built from. Delivery is never
silent: pending → `✓ delivered` / `✖ undelivered` on the notice line, with
`[tui] msg_timeout_s` as the bound.

**2. Unwedge (`u`) — `src/tui/unwedge.ts`.** Writes ONE validated command file
into the daemon's existing `commands/` tree and reads back the result the
daemon writes. Two commands only, both already in the daemon's whitelist:
`rerun-round` (cancel the running round and re-queue) and `restart-session`
(the same, plus killing the tmux session first). `src/commands.ts`
re-validates against the same strict schema and the same tier gate every
other writer faces, so the TUI inherits the daemon's belts rather than
bypassing them.

The file lands in the **operator** command directory
(`operatorCommandDirFor`), which is what makes an operator-issued lever
structurally different from a session-issued one: the directory is created and
written as root, mode 0755, and the daemon — which runs as the same uid every
pi session runs as — can read it but not write into it.
`operatorCommandWriteScript` refuses when the daemon's `commands/` root does
not exist yet and when the operator directory is a symlink, and it `chown -h`s
so a link swapped in after the check is still not followed. The daemon's side
of the seal is `operatorSealVerdict` in `src/commands.ts`.

Neither path touches GitHub and neither goes near `packages/pi-plugin/src/gate.ts`.

The board's PR pane also sends keystrokes (`sendKeysArgv`), which is a write in
the trivial sense that the operator is typing into a session; it creates no
state the daemon reads.

## Honest unknown

The rule has two halves, and only fixing the first is the trap: **a value
rendered from no data, and an action or published fact derived from the same
no data.**

Rendering:

- `src/tui/emptystate.ts` is the shared grammar. `countLabel(n)` renders
  `(—)` for `undefined` — an unread count — and a number only for a count that
  was read. `emptyLine(e)` renders one of four facts: `none yet` (really
  empty), `none matching` (a filter hides them), `not read yet` (pending), or
  `could not read — <why>` in warning colour.
- The board paints `PRS (?)` with the connection diagnosis beneath it until
  the daemon answers, never `PRS (0)` (`src/tui/board.ts`).
- `BoardView.dryRun` is `boolean | undefined` and initialises to `undefined`
  (`src/tui/app.ts`); `modeBadge` (`src/tui/design.ts`) renders `MODE UNKNOWN`
  for that, and `LIVE` / `DRY-RUN` only once a heartbeat has proved one.
- Reviewer memory (`memorySegment` in `src/tui/board.ts`, read
  from status.json `memory` and never from OpenViking): `⛔ MEMORY AUTH
  FAILED` / `⛔ MEMORY DOWN` / `▲ MEMORY DEGRADED` sit right after the daemon
  health in the board's top bar; an unmeasured or unreported state is a dim
  `mem ?` (`mem off` when memory is switched off in config.toml) at the end — never nothing, which
  would read healthy. Only `healthy` paints nothing.
- The daemon's own event loop (`eventLoopSegment` in
  `src/tui/board.ts`, read from status.json `daemon` and nothing else): a
  stall is a loud `⛔ DAEMON LOOP STALLED <max> · <cause>` (`⛔ DAEMON LOOP
  SLOW p99 …` for a sustained one) right after the memory banner, its cause
  `CPU starved (<n>% throttled)`, `loop itself blocked (on CPU <n>%)` or
  `cause unknown`; an unmeasured state, a snapshot from a daemon that
  reports no `daemon` block, or a block this build cannot read whole (a newer
  daemon's state, a missing field), is a dim `loop ?` at the end. Only `ok` paints
  nothing. Neither moves the alert badge's click zone.

Derived actions and published facts:

- The deploy tab's power button paints `VM APP STATE UNKNOWN` in muted ink
  while the container's state is unread, claims **no click zone**, and
  `pressPower` refuses the `S` key with "state has not been read — refreshing
  instead of guessing" rather than arming a stop (`src/tui/deploytab.ts`). The
  companion's `deploy_tab` verb likewise refuses a stop/start whose requested
  direction does not match the observed state
  ([`tui-actions-wiring.md`](../tui-actions-wiring.md)).
- Every companion-facing field the TUI could not read is `null` in
  `view.json` — `dry_run`, `total`, `by_state`, `memory` and `daemon` are all
  `T | null` (`TuiView` in `src/tui/feed.ts`) — and `extensions/tui-view.ts` renders an
  explicit unknown rather than dropping the line, because a dropped line reads
  as "nothing to report".
- The memory desktop notification (`maybeWriteMemoryAlert`,
  `src/tui/alerts.ts`) and the memory-incident ticket
  (`src/tui/memincident.ts`) act only on a FRESH snapshot (poll health `ok`
  or `pipeline_unhealthy`): a stale one may describe an outage that has
  already ended. The ticket is one per incident start, filed as `qcr-tui`
  into a `[sink] kind = "wayfinder"` tracker once the incident is older than
  `[memory] incident_ticket_after_min`.

## The startup contract

Nothing external gates the first paint. The first frame is the real layout,
full chrome, with every unfetched value marked unknown; the companion column's
width comes from configuration, so the container merely fills a column that is
already the right size. `ensureSshMaster` is not on that path.

Bring-up then reports **inside the companion column**, not on the normal
screen where the alt screen's clear would erase it. `src/tui/startup.ts`
declares `STARTUP_STEPS` in the order they run — VM ssh, daemon status,
memory forward, memory namespaces, companion container, day rollover,
companion pi — so the column shows every step from the first frame; a step
nobody has reached is `pending`, which is a different fact from one that
failed. `StartupStepKey` is a union rather than bare strings because `set()`
must ignore an unknown key (a progress reporter may never break the bring-up
it reports on), which would otherwise make a typo invisible at runtime. Past
`STALL_AFTER_MS` (20 s) a running step is reported as overdue with its
elapsed time instead of continuing to look like a spinner — nothing here has a
timeout of its own; the steps own their deadlines.

`tests/tui-startup.test.ts` drives the real `runTui` and asserts the contract
structurally: no network, docker or filesystem-walk call precedes the first
paint. A wall-clock budget sits beside it as a warning only.

## Hot reload

`src/tui/reload.ts` watches `dist/` recursively and re-execs the process in
place when a new build lands, restoring tab, selected PR, events scroll and
the companion column's width from a small state file.

It is safe because a failed `tsc` emits nothing, so a broken edit produces no
mtime change and the running TUI is untouched. Two `tsconfig.json` settings
serve that guarantee and belong to it: `noEmitOnError`, and an incremental
buildinfo path **outside** `dist/` — tsc writes buildinfo even when a compile
fails, and `dist/` is watched recursively and unfiltered, so a buildinfo
inside it would re-exec the TUI from a failing build.

**`HotReloader` takes no busy predicate, and must never get one.** Every build
reloads, unconditionally. The constructor has no such option, so wiring one
back does not compile. `App.isBusy()` still exists for an unrelated job —
refusing a remote-driven action in `src/tui/index.ts` — and must not be wired
into the reloader. A reload at an awkward moment is visible and recoverable;
a reload that never fires is neither. Pinned by `tests/tui-reload.test.ts`.

**The process chain stays two deep.** Node cannot replace its own image, so
a re-exec runs the new build as a child with the terminal inherited and
waits. Doing that at every reload would leave each generation frozen in
`spawnSync` under the next, about 200 MB apiece. Instead the first TUI to
reload becomes the **supervisor** (`superviseReloads`): it runs every
later build as its own child, handing each `QCR_TUI_SUPERVISOR_PID`, and a
TUI whose parent is that supervisor reloads by **exiting** with
`RELOAD_EXIT_CODE` (75) after its teardown; the supervisor starts the next
build with the snapshot the exiting one wrote (`tui-resume-<its pid>.json`).
The exit handler skips the terminal restore on that one code, so the next
build inherits the alt screen and raw mode as they were — no flash of the
shell between builds. The supervisor exits with the last build's code. The
supervisor changes only how a reload runs, never *when* one fires.

`scripts/dev-tui.sh` (`npm run dev`) owns both halves in one terminal and one
process group:

1. a **blocking** `tsc` first — `tsc --watch` emits its initial build a second
   or two in, which the dist-watcher would otherwise see as a change and
   re-exec a TUI that had just finished starting;
2. `node scripts/verify-dist.mjs`, because "tsc exited 0" is not "`dist/` is
   complete" — an incremental build emits from the build info, so a file
   deleted since the last successful build is never re-emitted while the
   compiler still reports success;
3. `tsc --watch --preserveWatchOutput` in the background with **output to
   `state/tsc-watch.log`, never the terminal** — a stray compiler line painted
   into the alt screen overwrites the frame rather than scrolling, and without
   `--preserveWatchOutput` tsc's screen-clear escape reaches the tty even with
   stdout redirected;
4. the TUI in the foreground, with a trap that kills the watcher on exit so an
   orphan cannot keep rebuilding into a `dist/` nobody is watching.

`npm run watch` is the watcher alone, for a second terminal. `reload.ts`
itself never builds: without a compiler running, editing `src/` changes
nothing on screen.

## The companion container

`CompanionLifecycle` (`src/tui/companion.ts`) mirrors `remote.ts`'s shape:
pure argv construction, one injectable `DockerRunner`, and no kill path except
an explicit `qcr companion down`.

**Lifecycle.** `qcr tui` start → adopt a running container, else `docker
start`, else `docker run`. Quit → `docker stop`; the conversation, the OAuth
tokens and the pi home live on the `pihome` named volume, so the next start is
a resume. A TUI crash leaves the container running and the next start adopts
it. A second concurrent TUI attaches to the same container — `ensureUp()` and
`spawnPi()` are both idempotent. `src/cli.ts` `cmdCompanion` exposes
`up|down|status|rebuild|plan`; `rebuild` exists because the image is otherwise
built only when missing, so a Dockerfile, entrypoint, extension or prompt change
would never reach a machine that already has one (D20: the companion runs the
image's code, so there is no hot reload for it) (the pihome volume is untouched, so the
login and the conversation survive).

**Two ways to reach the container's tmux** (`CompanionMode`). `docker` is the
clone route above: `docker exec <container> tmux …`. `tmux-socket` is the
containerised TUI (D35): the companion's tmux server listens on a socket in a
named volume (`QCR_TMUX_SOCKET`, `/run/qcr-tmux/<session>.sock`), and the TUI
container, which has no `docker.sock`, mounts that volume and runs
`tmux -S <socket>` (`src/tui/tmuxsocket.ts`, a `DockerRunner` that turns the
same `exec` argv into local tmux calls). The host wrapper runs the container
from the argv `qcr companion plan` prints (`src/tui/companionplan.ts`, the same
`runArgv()` plus a plan hash as a label, so a drifted container is recreated),
and `ensureUp()` in that mode only waits for the server; `gracefulStop()` does
nothing, because the wrapper stops what it started. [`host-wrapper.md`](../host-wrapper.md)
has the whole picture. `tests/tui-tmux-socket.test.ts` pins the lifecycle, the
drift check over the volume, the runner (against a real tmux on a scratch
socket) and the plan; `tests/tui-socket-mode.test.ts` drives a real `runTui`
this way with a fake tmux and a fake remote.

**Mounts.** `CONTAINER` in `companion.ts` fixes the in-container paths; the
host side of each is configured under `[companion]`:

| in container | what | mode |
| --- | --- | --- |
| `/home/qcr/.pi` | its own pi home (OAuth, sessions) — a named volume, never the daemon's | rw |
| `/workspace` | this repository: the repo it works on and commits to, and its working directory (its code is the image's, `/opt/qcr`) | rw |
| `/tracker` | the issue tracker it files to | rw |
| `/tracker-docs` | the tracker's protocol docs | ro |
| *(the reviewed repo)* | the source a review is about | ro |
| `/evidence` | finished-round artefacts the TUI copied down | ro |
| `/feed` | TUI → companion ambient state | rw |
| `/alerts` | companion → TUI files | rw |

There is **no ssh mount and no agent socket**. Bind mounts freeze at container
creation, so a mount-set change only reaches a container that is recreated:
`ensureUp` compares the created mount set against `runArgv()` (`mountDrift`)
and recreates on drift, which is what makes the boundary structural on a
running container rather than only in the code. A missing reviewed-repo
checkout drops that one mount — under-equipped, never a companion that refuses
to start.

**Memory.** The companion reaches the memory engine over a docker bridge
(`MEMORY.network`, fixed subnet so the gateway is knowable before the network
exists) on which a **host-owned** forward listens; `resolveMemoryWiring()`
still asks docker for the real gateway and only falls back to the constant.
The relay itself is `scripts/companion-memory-forward.mjs`, run either as a
user service or inside the TUI process (`src/tui/memforward.ts`, which
*adopts* a forward that is already listening and stops only one it started, so
either install order works and the two never fight for the port). The two
memory user keys ride `--env-file`, so no key value ever appears in this
process's argv; `envFileProblems` pre-validates the file's syntax because a
file docker's parser rejects is a companion that does not start, and memory
must never be able to do that — memory-less is a legitimate degraded mode with
no network and no endpoint env. `KEY_NAMES` names the three variables; values
are never read into a log line.

**pi argv** (`piArgv()`). `--approve` pre-trusts project-local `.pi` resources
so no interactive trust modal can ever stall the session; the entrypoint also
sets `defaultProjectTrust` and pre-seeds `trust.json` for `/workspace`.
Extensions are passed **per spawn**, never registered globally, and all of them
are the image's (`/opt/qcr/extensions`): the vendored patched memory extension,
`extensions/muted-theme.ts`, `extensions/inject-bridge.ts` (the same bridge
the daemon uses, pointed at the companion's own inject directory),
`extensions/tui-view.ts`, `packages/pi-plugin/extensions/lens.ts` (our `lens` / `lens_wave`
tools at cap 8, in place of pi's example subagent),
`extensions/companion-guard.ts` and `extensions/inline-bash.ts`. Routing vars
ride the command line as an `env K=V …` prefix (`piEnvPrefix()`) rather than
the client environment, because tmux panes inherit the tmux *server*'s
environment.

**The image** is the release image (`docker/Dockerfile`), built on the
operator's machine from the app root (`qcr companion rebuild`, stamped with
`src/appstamp.ts`'s hash; the image compiles the app itself, so nothing needs
building on the host first) and run in its `companion` mode
(`docker/entrypoint.sh`): tmux built from source for the key protocol, the
pinned pi package, the app at `/opt/qcr`, and no baked user. The container runs
as the invoking host user (`--user <uid>:<gid>`, `hostUser()`) because every
interesting mount is a host bind mount it writes; `HOME` is the image's fixed
`/home/qcr`, writable by any uid, and the pi home volume mounts inside it. The
run sets the working directory to `/workspace`, so pi reads the repo's own
context files and not the image's reviewer stub. The mode provisions the git
identity (commits are prefixed `[companion]`), registers the skill directories
in pi's settings, links pi's agents dir at the image's companion agent set
(what the lens tool reads), and reports at boot whether the pi home really is a
mount point. The clone route's scan sandbox is a separate image
(`docker/companion/Dockerfile`, `[scan] image`, `qcr scan rebuild`): its
one-shot entrypoint runs the scan driver and `qcr scan login` / `doctor`.

## The file channels

Every channel between the TUI and the companion is a **file** on a bind mount.
Nothing injects a chat turn from state changes.

**TUI → companion: `/feed`** (`src/tui/feed.ts`, the only writer).

- `snapshot.json` — the current status snapshot verbatim, rewritten atomically
  on every successful poll;
- `events.jsonl` — a bounded event tail (`EVENT_TAIL_CAP` 4000, compacted by
  half on overflow in one atomic rewrite), deduped by `ts|kind|pr`;
- `screen.txt` — the last painted frame as plain text, ANSI stripped, capped
  at `SCREEN_MAX_CHARS`;
- `view.json` — a small projection of the derived state behind that frame,
  throttled to `VIEW_MIN_INTERVAL_MS` between repaint-driven writes (the 3 s
  poll writes unconditionally, so freshness never depends on the throttle).

The split is the point: writing these costs disk and nothing in the
companion's context. It pays only when it fires a `tui_*` tool to read one.
The projection is deliberately small.

**Companion → TUI: `/alerts`** (`src/tui/alerts.ts`, the consumer). The
companion writes `<iso-ts>-<slug>.json`; `parseAlert` is a strict schema check
with digit-string coercion for `pr`, and a malformed file is **surfaced** by
name on the notice line, never silently dropped. `AlertPolicy` then decides:
tier `notice` → the status line only; tier `alert` → status line plus a
desktop notification (no overseer inject: the overseer is retired). One notification per distinct
cause per `cooldown_min`; repeats inside the window fold into a counter; a
genuine escalation (notice → alert) of a folded cause may break the cooldown
once per day. Cooldown memory is persisted so it survives a TUI restart.

**Companion → TUI: `/alerts/tui-actions/`** (`src/tui/actions.ts`). Request
files validated against a strict schema and executed against a `TuiDriver`
supplied at wiring time. The verb set is closed and is exactly what the
operator's own keyboard can do — tab switches, PR selection, filters, digest
and memory paging, metrics window/PR, quick-messages, the
deploy-tab buttons, and (`memory_pin`, root CLAUDE.md rule 8) the memory
tab's `p`: pin or unpin one
existing entry through the TUI's `MemoryStore`, awaited so the result file
carries the store's answer, and nothing else about memory. Requests execute instantly; there is no confirmation step,
and the executed trace lands on the notice line. Idempotency comes from
**archive-before-execute**: a request is moved to `.done/` before it runs, so
a crash mid-execute cannot re-run it (a double-send or a double-arm is worse
than a lost request, which the companion notices from the missing result and
re-requests). Results are written as `<name>.result.json`; a malformed or
unknown request produces a refused result, never a crash.

**TUI → companion: `/evidence`** (`src/tui/evidence.ts`). The companion cannot
reach the deployment host, so the TUI — which already holds that access —
copies each finished round's artefacts down to a local store the companion
reads read-only. Nothing is granted to it by this: no ssh, no credential, no
network reach. Copying happens on completion rather than on demand, because a
round that has finished is a round whose evidence is complete.

The sweep that finds those rounds asks the daemon `qcr why <n> --json` only
for a PR whose snapshot signature moved, and it is built not to load the
container. Its per-PR progress — which signature each PR was
last cleanly reconciled at — is kept in `state/tui-evidence-sweep.json`
beside the TUI's other state files, written temp + rename and stamped with
the evidence store it describes, so a re-exec resumes instead of re-asking
about every PR. A record that cannot be read, or that describes another
store, counts as empty and says so on the notice line; an entry that says the
store held a PR's evidence is not believed once that evidence is gone from
disk (an entry for a PR whose rounds were all still running stored nothing,
and is believed). The `why` execs are paced — at most one per `[tui]
evidence_why_interval_s` (default 10 s, clamped 5–600 s), counted from the
end of the previous one, or from the copier's start for the first, whatever
the poll cadence and however often the TUI re-execs — and none at all runs
while the board's last status shows the daemon draining or its heartbeat
older than `stale_after_s`. A round that finished during such a hold is
copied as a backfill once it lifts, verdict only, because the PR's current
ledger, prompt and transcript may by then be a later round's. PRs needing a
`why` are taken in a rotation by number: a failed one moves the rotation past
itself, so it is retried after the others rather than first every time, and
one still draining a backlog of rounds keeps its turn until it is done.

**Day rollover** (`src/tui/rollover.ts`). On the first TUI start of a new ops
day — never mid-use — the companion's conversation is archived date-stamped,
the tmux session killed and respawned, and the opening context handed over as
the first message: the previous day's digest, a compacted summary of
yesterday's conversation, its tail, unresolved alerts, the live board
snapshot, and the alert knobs in force. The day-open text is delivered as an
**inject file**, not a CLI flag: the inject bridge drains its directory on
`session_start` before it starts watching, so writing the file before spawning
pi is race-free. `SessionFileLookup` and `ConversationRead` keep "there is no
previous conversation" and "we could not read it" as separate answers.

## What the companion may and may not do

The boundary is mostly structural already — no GitHub credential, no
credential for the deployment host, no `gh` binary in the image, no ssh mount,
no agent socket. `extensions/companion-guard.ts` turns three remaining
prompt-held lines into `tool_call` vetoes the model cannot talk itself past:

1. **Frozen seeds.** The frozen set *is* the seed manifest
   (`tests/fixtures/seed-manifest.json`), plus the two registry fixtures. Files
   the project owns are deliberately not in the manifest, so "in the manifest"
   is exactly "frozen". See [`ownership.md`](../ownership.md).
2. **Never GitHub, never the deploy script.** `git push`, `gh` and
   `scripts/deploy.sh` are refused **by name**, not merely by absent
   credentials.
3. **Never discard someone else's uncommitted work.** `git stash`,
   `git reset --hard`, `git checkout -- <path>` / `git checkout .`,
   `git restore` (worktree form) and `git clean` are refused; the companion
   commits, it never discards. Patterns are deliberately tight —
   `git checkout -b`, plain branch switches, `git restore --staged` and
   `git stash list/show` stay allowed, because a false veto on a legitimate
   command teaches an operator to want the guard gone.

A block is a **refusal with a reason the model sees**, so it can relay the
reason and argue for the change instead of making it. This is belt-and-braces,
not a sandbox: shell can in principle write a frozen file, and the extension
does not try to parse arbitrary shell. The bright lines above are the ones
worth a hard veto. It loads per spawn from `piArgv`, companion only — the
deployment-side sessions have the mutation gate and `scripts/guards.sh`
instead — and subagent children load only global-settings extensions, so
leaves never pay for the hook.

`extensions/tui-view.ts` is the read side and its rule is structural too:
**the `tui_*` tools read state the TUI has already fetched; they are never a
fetcher.** Its only imports are `node:fs` and `node:path` — no
`node:child_process`, no networking, no import of anything under `src/`, above
all not `remote.ts`. No tool takes a parameter: there is no host to name, no
command to pass, no path to traverse; the tools read three fixed filenames
under `$QCR_FEED_DIR`. A missing or stale file is answered as such ("the TUI
is closed"), never refreshed, because staleness is information and a refresh
would be reach. Without those constraints the companion could make the TUI act
on the deployment host on its behalf — laundering the operator's access
through a read verb.

What that leaves the companion able to do: read `/workspace` and edit it,
commit locally, read the tracker and write to it, read the reviewed repo and
the evidence store, read and write its own memory namespace, raise alerts, and
drive the TUI through the closed action verb set. It never pushes, never talks
to GitHub, never passes a mutation through `packages/pi-plugin/src/gate.ts`, never runs a deploy,
and holds no credential for the deployment host.

## Sibling docs

- [../tui.md](../tui.md) — the surface contract: surfaces, keys, mouse, empty
  grammar.
- [../sidebar-contract.md](../sidebar-contract.md) — the companion column's
  geometry, row and terminal contracts.
- [../tui-actions-wiring.md](../tui-actions-wiring.md) — how the action
  channel is wired into `src/tui/index.ts`.
- [../single-shepherd-invariant.md](../single-shepherd-invariant.md) — why the
  daemon nudges sessions and never schedules an agent.
- [../ownership.md](../ownership.md) — the owner-only surfaces the companion
  guard enforces.
