# The operator TUI — `qcr tui`

One layout, always: **the tab on the left, the companion column on the
right**, on every frame and in every configuration. Nothing takes the whole
terminal and nothing folds the column away. Eight surfaces sit on the left;
the digit keys `1`…`8` reach them, and the bar at the foot of the screen shows
what the *current frame* answers to — a button that is not there is a key that
would do nothing.

This file is the contract the `?` overlay (`HELP_LINES`) and the command bar's
vocabulary (`TAB_VOCABULARY`, `TAB_INLINE_KEYS` in `src/tui/cmdbar.ts`) are
pinned against — `tests/tui-surfaces.test.ts` fails when they disagree.

## Where the daemon is

`[tui] target` picks the route: `ssh` to the VM, or `local` — the compose
stack on this machine, where every read is a plain `docker exec` and no ssh
process is ever spawned. Before the first frame the TUI resolves the route
once (`src/tui/route.ts`) from `[tui]` plus three local facts that cost no
docker call: the project `.env`, the onboarding checklist, and whether this
user can open the Docker socket.

- `target = "ssh"` with an empty `ssh_host` is never `ssh ""`. On a compose
  project (the checklist recorded the local topology, or the `.env` pins
  `QCR_VERSION`) the TUI reads the local stack and says so once; otherwise the
  board says "ssh_host is empty — set it to the VM's ssh alias, or set [tui]
  target = "local"" and the memory forward stays off with the same words.
- On the local route the VM-shaped defaults are read for one box: the state
  dir is the release image's `/opt/qcr/state`, a compose `-daemon-N`
  container implies its `-memory-N` sidecar for the memory forward, and sudo
  is dropped when the socket answers without it. A value the file sets
  differently from the shipped default always wins.
- The connection step and the board name the local causes in local terms —
  the daemon container absent or stopped (with the `docker compose … up -d`
  that starts it), or Docker itself not answering — never an ssh fix.
- While onboarding's checklist exists and is not complete, the first frame
  says so: the top bar carries "setup not finished", and where
  the PR list would be, the full line names the wizard's next step instead of
  any daemon or ssh troubleshooting. The data stays unknown (`PRS (?)`).
- The companion runs the release image the compose stack already pulled
  (`ghcr.io/quickchatai/quickreview:<QCR_VERSION>`) on a first start, unless
  `[companion] image` names another or a local build of the default exists.

## The surfaces

| # | surface | what it is for |
| --- | --- | --- |
| 1 | **board** | what the reviewer is doing right now, PR by PR — the live list, the selected PR's detail, and below them its live transcript (or, during a debug round or a takeover, its pi terminal) |
| 2 | **memory** | the reviewer's durable store: the timeline newest first, grouped by day, with the defect flags and the memory forward's state |
| 3 | **digest** | what the EOD sweep wrote, `digest/<date>.md` — a document, read top to bottom, one day at a time |
| 4 | **tickets** | the tracker tickets adjudication filed, actionable first, each readable in full |
| 5 | **deploy** | the release the VM runs versus the one chosen, and the button that ships it |
| 6 | **metrics** | whether the reviewer is working well over time |
| 7 | **feedback** | the tuning loop on one surface — signal → adjudication → proposal → change → revert |
| 8 | **scan** | the whole-repo scan's report — findings by unit, triage, the stage 2 plan for approval, the run and its stop |

`digest` and `tickets` are the least-used surfaces; if eight reads too wide in
practice, the planned collapse is to fold them back into `memory` as named
sections.

## Keys

Three rules hold everywhere:

- **A registered key is a key that answers.** The set a tab claims is derived
  from what it is painting *now*; every other printable is a message to the
  companion column and focuses it, seeded with that character. A tab never
  swallows a key it will not act on.
- **An embedded pi surface is a terminal.** While the board's pi pane or the
  companion column holds the keyboard, every byte goes to pi — `/` commands,
  Esc, ⏎, Ctrl-C included. `Ctrl-q` is the one reserved chord and releases
  focus, the same on both.
- **Drag selects, release copies.** Mouse reporting takes the terminal's own
  selection away, so the TUI gives one back: a rectangular block of exactly
  what is on screen, as plain text, into the clipboard on release.

### everywhere

| key | does |
| --- | --- |
| `1` … `8` | open that surface |
| `j` / `k`, `↓` / `↑` | move the selection (or scroll a document) |
| `r` | refresh |
| `s` | re-check the connection — on the VM route ssh (the one ssh key-passphrase prompt), on the local route the daemon container |
| `?` | this key map |
| `q` | quit (asks first); Ctrl-C twice also quits, Ctrl-C ×3 kills the TUI from anywhere |
| `/` | focus the companion column — and reach pi, so its command menu opens |
| `Ctrl-q` | release a focused pi pane or the companion column |

### board

The verbs act on the **selected PR**, so they exist only while one is
selected — and only on the board. `e` and `I` are the exceptions: the events
overlay and setup are about the whole repo.

The list is the PRs the daemon tracks, then every other open PR of the
repository (status.json `open_prs`, from the reconcile poll), marked `○ not
reviewed`. An offered row has no session or round yet: `R` reviews it and `g`
opens it, and the detail pane says so. While nothing is tracked, a line under
the PRS header says what to do: select a pull request, then `R`.

| key | does |
| --- | --- |
| `R` | review the selected PR now — any open PR of the repo, tracked or not: the daemon queues one round (the `review-now` operator command, as `qcr review-now <n>`), and in dry-run nothing is posted |
| `⏎` / `a` | focus the selected PR's pane (embedded below the list; Ctrl-q back) |
| `[` / `]` | transcript viewer only: previous / next stream of the shown round — the main session, then each lens (a click on a lens row of the progress panel picks that lens) |
| `<` / `>` | transcript viewer only: an earlier / later round; the newest round is followed |
| `m` | quick-message the selected PR's session |
| `g` | open the PR on GitHub (PR numbers are Ctrl+clickable links) |
| `e` | the events overlay — j/k scroll, e/Esc close, click an event to jump to its PR |
| `u` | unwedge: cancel the running round and re-queue it — nothing posted, no GitHub write |
| `F` | clear the board filter the PRS title is advertising |
| `I` | set up the repo: the companion runs its setup skill — survey, interview, the repo profile (same as `qcr setup`) |

The pane below the list takes its surface from the PR's `runtime` in
status.json, with no toggle: `debug` or `takeover` is the pi terminal of
`debug-pr-<n>` / `takeover-pr-<n>` (a terminal, as above), with every byte but
`Ctrl-q` going to pi; every other runtime — `worker`, `answer`, `idle`, and one
that is absent or unknown — is the **transcript viewer**, a read-only rendering
of the PR's LiveEvent logs (`state/live/pr-<n>/r<round>/`, what `qcr live`
prints) that follows the tail until `PgUp` or the wheel parks it and `End`
follows it again. There is no `pr-<n>` tmux session to mirror: the bot's rounds
run in workers. To sit inside a PR's conversation, `qcr takeover <n>` or
`qcr debug-round <n>` opens its pi terminal here, and `qcr open pr <n>` forks a
finished session into pi on your own machine.

### memory

The timeline lists every area of the store but `finding-cases/`: the daemon's
finding cases are derived from state.db, number in the
hundreds, and are rewritten by the daemon alone, so the store's sweep never
lists them. Search them through the companion or OpenViking Studio (`W`).

| key | does |
| --- | --- |
| `[` / `]` | jump to the older / newer day |
| `e` | edit the selected entry |
| `p` | pin or unpin it: the entry MOVES into `preferences/pinned/` — the directory every round's head reads — and back out (pinned entries float to the top) |
| `x` | retire it — twice, the first press arms |
| `n` | a new `#manual` entry — the owner's own words, in `preferences/` (pin it to reach every round) |
| `W` | open OpenViking Studio through the memory forward |
| `F` | clear the tag filter |

### digest

| key | does |
| --- | --- |
| `[` / `]` | older / newer day |

### tickets

| key | does |
| --- | --- |
| `c` | actionable tickets only ⇄ all of them |
| `[` / `]` | scroll the open ticket's body (the wheel does too) |

### deploy

| key | does |
| --- | --- |
| `D` | deploy the chosen version — twice inside the window, or click ▶ DEPLOY TO VM. Refused on a legacy-layout VM (its first release is `scripts/cutover.sh`) and while the VM's layout is unread |
| `V` | choose the version (a prompt: type `X.Y.Z`; the newest published one is the default) |
| `S` | power the VM app container — stop or start, twice; absent until its state has been read |
| `x` | abort the running deploy / power run, or close its finished log |

Every deploy is a release: the tag and the two-arch build with its smoke
already happened in CI. The DEPLOYED line is the VM's running
version and revision (`ssh <vm> sudo qcr-update status --json`), VERSION the
chosen one (published versions come from a read-only `gh api` packages listing;
`V` types one), PENDING the commits between the two revisions in the local
checkout, PLAN `deploy.sh --dry-run release <version>` verbatim. The ceremony
is drain, wait for zero rounds, `deploy.sh release <version>`, then watch the
new boot's first reconcile lift the drain.

Every remote path (inject files, the digest, evidence, the operator command
channel) is built from the container's app root, which the TUI reads from the
container's `qcr.layout` label and re-reads when the container id changes
(`src/tui/layout.ts`); `[tui] remote_sandbox_root`, when set, wins.

The CONFIG line compares the config home a release would ship (config.toml and
its profiles/) with the one the VM was shipped, both fingerprinted by
`scripts/config-fingerprint.sh`: "profile changed, not deployed" until a
sync, "unknown" when either end could not be read. Under it, while
the profiles are behind, the post-scan re-tunes the companion wrote since the
last deploy (`<state home>/setup/retunes.json`), each change with its reason
— which re-tune a release would ship; "unknown" when the VM end, the
deploy time or the log could not be read.

### metrics

| key | does |
| --- | --- |
| `w` / `m` / `a` | the 7-day (week) / 30-day (month) / all-time window — letters, because every digit is a surface |
| `#` | open the `# <pr>` box; digits type into it, `⏎` opens that PR's timeline, `Esc` cancels |
| `Esc` | back from a timeline to the dashboard |

### feedback

Under the loop, a LESSONS line: the lesson shadow ledger's 7-day headline
from status.json `memory.lessons` — the `[memory] delivery`
switch, the operator's kill switch, and the posted findings a selected
dont-raise lesson marked, split into what humans then fixed (harm), refuted
or set aside (help) and still unknown — and, on a second line, the same
split by match tier: `class` (the lesson's class matched the
finding's too — the would-demote tier, what the validator's license
reaches) and `lens` (lens and path alone — evidence only), each finding on
its strongest. It is the evidence to read before switching
delivery on; `qcr lessons shadow-report` has it per lesson, per lens and per
tier. Honest-unknown: no status yet, a daemon that reports no memory or no
lesson block, and a ledger the daemon could not read each say so — never a
zero; a daemon that reports no tiers gets a second line that says
"by tier: UNKNOWN".

| key | does |
| --- | --- |
| `t` | focus the next pane: inbox → proposed → changed |
| `a` | show / hide archived (acted-on) signals |
| `A` | accept the focused rubric proposal — applies the patch, auto-ratifies, commits locally |
| `x` | reject it, with a reason |
| `R` | arm a revert of the focused change; `y` confirms — a local commit only, never pushed |

### scan

The run on top (sha, mode, state, cases done, spend against the hard stop,
finding counts per validity tier and not-reproduced), the units on the left (the count under the
filter, `▲` the hotspot, the run's mark per unit), and on the right the
selected unit's findings GROUPED BY THE SKEPTIC'S VALIDITY TIER — confirmed
first (a traced scenario), then likely (a real mechanism, reachability not
fully traced), doubtful (refuted or class-matched — kept, never dropped) and
unknown (no skeptic judged it) — each under its heading, most severe first
inside a tier, style findings grouped per rule with a count (`?` = may not be
valid, `↺` = not reproduced: a re-read
of its unchanged code did not report it again, so it stays open for triage
— only changed code is ever settled `fixed`) — over the selected one's detail,
which the mouse wheel scrolls when it is longer than the pane (j/k and the
arrows choose the finding). The tab reads the state home; a run the record calls running while the
companion is down shows as interrupted, never as "no scan".

| key | does |
| --- | --- |
| `[` / `]` | the previous / next unit (`all` first) |
| `p` | promote the finding (or the style group): the companion files one ticket each, in the effort that fits. Confirmed findings only by default; a likely, doubtful or unknown one asks for an explicit `yes` first |
| `d` | dismiss it — the reason is typed in the message box and becomes an unpinned reviewer-memory note |
| `f` | filter: `state=new\|promoted\|dismissed\|fixed` `lens=<name>` `sev=P0…P3\|nit` `tier=confirmed\|likely\|doubtful\|unknown` `doubted` / `valid` |
| `t` | step the tier filter: all → confirmed → likely → doubtful → unknown → all |
| `F` | clear the filter the FINDINGS title is advertising |
| `P` | swap the right pane to the stage 2 plan: rows, their cost, the kept total that is the hard stop, the budget — a deep proposal's title splits the companion's rows from the floor's (`floor-<n>`, each with its `deep floor: <lens> over <unit>` reason) |
| `⏎` | in the plan: approve — the companion starts exactly the kept rows, stopped hard at their total |
| ` ` | in the plan (space): toggle the selected row off / on |
| `Esc` | in the plan: back to the findings |
| `x` | stop the running scan — in-flight cases abort, the ledger resumes the rest |
| `D` | ask the companion for a delta re-scan — it shows what changed and the price, and starts it on your word |

`p`, `d` and `D` go to the companion as your words (its inject channel, like
`I`); `⏎` and `x` are request files its scan belt answers within seconds, each
naming what you were shown — the proposal's key, the run's id — so nothing
starts or stops that was not on screen.

## The mouse

Click a PR row to select it, again to focus its pi pane; click a `[button]`
to press its key; click a list row on any surface to select it. Wheel over
the companion column or the pi pane scrolls that surface's scrollback;
elsewhere it moves the selection. Drag the companion column's left border to
resize it — the only drag that is chrome rather than selection.

## Empty is one of three things

Every list shows a count and, when empty, exactly one of:

```
▍SECTION (0)     none yet — <what would fill it>
▍SECTION (0)     none matching — <what clearing the filter shows>
▍SECTION (—)     not read yet — <what would read it>   ·   could not read — <why>
```

`(—)` is the unknown count; a number is a claim. The first frame paints the
real layout with every unfetched value marked unknown, and no action is ever
derived from a value that was not read (the deploy tab offers no `S` until the
container's state is known; the board offers no `u` until a PR is selected).

## What the companion can drive

`prompts/companion.md` documents the action channel: `switch_tab` takes the
eight names above, `digest_day` pages the digest tab to a day, `memory_view`
filters the memory timeline by tag and jumps to a day, `memory_filter` sets
or clears the tag filter, and `memory_pin` pins or unpins one EXISTING entry
through the TUI's memory store — the same move as `p`, answered in the result
file (a refusal is a failed result). It is the channel's only memory verb and
does nothing but pin and unpin (the companion boundary): pinning is a move the
TUI's store makes, and the companion's own keys have no such verb. Every
other memory write is the companion's own. The vocabulary there is this
vocabulary.
