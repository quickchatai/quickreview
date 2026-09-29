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

## The surfaces

| # | surface | what it is for |
| --- | --- | --- |
| 1 | **board** | what the reviewer is doing right now, PR by PR — the live list, the selected PR's detail, and its pi session mirrored below |
| 2 | **memory** | the reviewer's durable store: the timeline newest first, grouped by day, with the defect flags and the memory forward's state |
| 3 | **digest** | what the EOD sweep wrote, `digest/<date>.md` — a document, read top to bottom, one day at a time |
| 4 | **tickets** | the tracker tickets adjudication filed, actionable first, each readable in full |
| 5 | **deploy** | what the VM runs versus this checkout, and the button that ships the difference |
| 6 | **metrics** | whether the reviewer is working well over time |
| 7 | **feedback** | the tuning loop on one surface — signal → adjudication → proposal → change → revert |
| 8 | **scan** | the whole-repo scan's report — findings by unit, triage, the stage 2 plan for approval, the run and its stop |

`digest` and `tickets` are the two the owner reaches for least; if eight reads
too wide in practice, the recorded collapse is to fold them back into `memory`
as named sections.

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
| `s` | re-check the VM ssh connection — the one ssh key-passphrase prompt |
| `?` | this key map |
| `q` | quit (asks first); Ctrl-C twice also quits, Ctrl-C ×3 kills the TUI from anywhere |
| `/` | focus the companion column — and reach pi, so its command menu opens |
| `Ctrl-q` | release a focused pi pane or the companion column |

### board

The verbs act on the **selected PR**, so they exist only while one is
selected — and only on the board. `e` and `I` are the exceptions: the events
overlay and setup are about the whole repo.

| key | does |
| --- | --- |
| `⏎` / `a` | focus the selected PR's pi pane (embedded below the list; Ctrl-q back) |
| `m` | quick-message the selected PR's session |
| `g` | open the PR on GitHub (PR numbers are Ctrl+clickable links) |
| `e` | the events overlay — j/k scroll, e/Esc close, click an event to jump to its PR |
| `u` | unwedge: cancel the running round and re-queue it — nothing posted, no GitHub write |
| `F` | clear the board filter the PRS title is advertising |
| `I` | set up the repo: the companion runs its setup skill — survey, interview, the repo profile (same as `qcr setup`) |

### memory

| key | does |
| --- | --- |
| `[` / `]` | jump to the older / newer day |
| `e` | edit the selected entry |
| `p` | pin or unpin it (pinned entries float to the top and ride the injection head) |
| `x` | retire it — twice, the first press arms |
| `n` | a new `#manual` entry |
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
| `D` | deploy — twice inside the window, or click ▶ DEPLOY TO VM |
| `S` | power the VM app container — stop or start, twice; absent until its state has been read |
| `x` | abort the running deploy / power run, or close its finished log |

The CONFIG line compares the config home a sync would ship (config.toml and
its profiles/) with the one the VM was shipped, both fingerprinted by
`scripts/config-fingerprint.sh`: "profile changed, not deployed" until a
sync, "unknown" when either end could not be read. Under it, while
the profiles are behind, the post-scan re-tunes the companion wrote since the
last deploy (`<state home>/setup/retunes.json`), each change with its reason
— which re-tune a sync would ship; "unknown" when the VM end, the
deploy time or the log could not be read.

### metrics

| key | does |
| --- | --- |
| `w` / `m` / `a` | the 7-day (week) / 30-day (month) / all-time window — letters, because every digit is a surface |
| `#` | open the `# <pr>` box; digits type into it, `⏎` opens that PR's timeline, `Esc` cancels |
| `Esc` | back from a timeline to the dashboard |

### feedback

| key | does |
| --- | --- |
| `t` | focus the next pane: inbox → proposed → changed |
| `a` | show / hide archived (acted-on) signals |
| `A` | accept the focused rubric proposal — applies the patch, auto-ratifies, commits locally |
| `x` | reject it, with a reason |
| `R` | arm a revert of the focused change; `y` confirms — a local commit only, never pushed |

### scan

The run on top (sha, mode, state, cases done, spend against the hard stop,
finding and doubted counts), the units on the left (the count under the
filter, `▲` the hotspot, the run's mark per unit), and on the right the
selected unit's findings — most severe first, style findings grouped per
rule with a count (`?` = may not be valid) — over the selected one's detail.
The tab reads the state home; a run the record calls running while the
companion is down shows as interrupted, never as "no scan".

| key | does |
| --- | --- |
| `[` / `]` | the previous / next unit (`all` first) |
| `p` | promote the finding (or the style group): the companion files one ticket each, in the effort that fits |
| `d` | dismiss it — the reason is typed in the message box and becomes an unpinned reviewer-memory note |
| `f` | filter: `state=new\|promoted\|dismissed\|fixed` `lens=<name>` `sev=P0…P3\|nit` `doubted` / `valid` |
| `F` | clear the filter the FINDINGS title is advertising |
| `P` | swap the right pane to the stage 2 plan: rows, their cost, the kept total that is the hard stop, the budget |
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
filters the memory timeline by tag and jumps to a day, `memory_filter` sets or
clears the tag filter. The vocabulary there is this vocabulary.
