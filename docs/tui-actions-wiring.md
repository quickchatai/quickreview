# Wiring the companion → TUI action channel

**STATUS: APPLIED 2026-08-20** (branch worktree-uplift-wiring, +13 tests in
`tests/actions-wiring.test.ts`). Kept as the record of the wiring; each
section carries a one-line *Applied delta* where the post-merge code differed
from this recipe.

> **Historical, 2026-08-20.** This recipe places the action sweep
> "right after the memedit sweep" and copies its busy-flag style. That
> neighbour is **gone**: the companion memory-edit request channel retired
> when the companion got direct OpenViking access (rule 8's superseding
> amendment). The action sweep itself is unchanged and still the last
> `chainOnPoll` inside `if (companionUp)`; only the landmark moved.

> **Historical, 2026-09-02 (→).** The recipe below predates
> the seven-surface layout. Three things it names no longer exist as written:
> App's `[2]` tab id is now `memory` (the `"memory" ? "digest"` translation in
> `switchTab` is gone — the verb's tab name IS the `Tab`, see
> `src/tui/tabs.ts`, and `switch_tab` accepts all seven); `memState.view` and
> `memState.memFilter` are gone with the `v` toggle — `digest_day` drives the
> `[3] digest` tab and `memory_view` / `memory_filter` the `[2] memory` tab's
> `filter`, through the `LearningTabs` handle `buildTuiDriver(app, learning,
> …)` takes instead of `memState`; and the `changes` tab is the CHANGED pane of
> `[7] feedback`. `docs/tui.md` is the current vocabulary.

> **Added 2026-10-07 (root CLAUDE.md rule 8's fourth amendment).** `memory_pin` — `{"entry": "<TUI id
> or viking:// URI>", "pin": true|false}` — pins or unpins one EXISTING memory
> entry, and is the channel's one memory verb and its one ASYNCHRONOUS verb:
> `TuiDriver.memoryPin` returns a promise (a fresh read through the TUI's
> `MemoryStore`, then the `pin`/`unpin` op, which MOVES the entry into or out
> of `preferences/pinned/` — the memory tab's `p`), `executeTuiAction` returns
> it, and `processTuiActions` awaits it, so the result file carries the
> store's answer and a refusal is a failed result. It is a memory write, not a
> keystroke: no tab switch, no `prep()`. Bounded to pin and unpin: the parser
> refuses any param but `entry` and `pin`, `TuiDriver` has no other memory
> method, and the only ops the driver hands the store are `pin` and `unpin`
> (`tests/actions.test.ts`, `tests/actions-wiring.test.ts`). Every other
> memory write stays the companion's own, with its own keys.

`src/tui/actions.ts` and `src/tui/filters.ts` are self-contained; nothing
imports them yet. This document is the exact insertion recipe. All edits are
in `src/tui/index.ts` plus one-line consumption changes in `board.ts` /
`app.ts` / `memtab.ts`. Instant execution (no confirm gate) is deliberate —
do not add one while wiring.

## 1. Where the watcher lives: `src/tui/index.ts`, the `if (companionUp)` block

> *Applied delta:* none — both captures landed exactly on the lines named
> (`deployState` / `metricsView`), inside the companionUp block after the
> memedit sweep.

Everything goes inside the existing `if (companionUp) { … }` block (the one
that already builds the feed writer, the alert consumer, and the memedit
sweep) — the action channel is companion machinery, so `--no-companion`
must disable it for free.

Two return values that index.ts currently discards must be captured first
(same statements, keep everything else):

```ts
// was: installDeployHooks(app, new RealDeployFetcher(cfg, realSshRunner, localRunner));
const deployState = installDeployHooks(app, new RealDeployFetcher(cfg, realSshRunner, localRunner));
// was: installMetricsHooks(app, undefined, localHeadProbe(localRunner));
const metricsView = installMetricsHooks(app, undefined, localHeadProbe(localRunner));
```

(`memState` — the `installMemoryLearningHooks` return — is already captured.)

## 2. The TuiDriver implementation (~30 lines)

> *Applied delta:* implemented as the exported `buildTuiDriver(app, memState,
> metricsView, deployState)` at module level in index.ts (so tests can drive a
> real App through `processTuiActions`), with two additions: a `prep()` that
> blurs a focused pi pane/companion strip before every action (one keyboard
> owner — same rule the mouse handlers follow), and `memState.sel = 0` when
> `memory_view`/`memory_filter` applies a tag (the old ordinal could exceed
> the narrowed list).

Place right after the memedit sweep wiring, still inside `if (companionUp)`:

```ts
const { processTuiActions } = await import("./actions.js");
const tuiActionsDir = join(full.companion.alerts_dir, "tui-actions");
const driver: import("./actions.js").TuiDriver = {
  switchTab: (tab) => {
    app.tab = tab === "memory" ? "digest" : tab;   // App's [2] tab id is "digest"
    app.repaint();
  },
  selectPr: (pr) => {
    app.tab = "board";
    app.selectPr(pr);                              // public App API — selects + refreshes detail
    app.repaint();
  },
  metricsWindow: (w) => {
    app.tab = "metrics";
    metricsView.drill = undefined;
    metricsView.window = w === "7d" ? "d7" : w === "30d" ? "d30" : "all";
    metricsView.scroll = 0;
    app.repaint();
  },
  metricsPr: (pr) => {
    app.tab = "metrics";
    app.repaint();
    // Drive the tab's own PR-entry state machine so the timeline FETCH runs
    // (drillTo is closure-private): # opens entry, digits accumulate, ⏎ drills.
    app.pressKey("#");
    for (const d of String(pr)) app.pressKey(d);
    app.pressKey("\r");
  },
  digestDay: (date) => {
    app.tab = "digest";
    memState.view = "digest";
    app.repaint();
    // Page to the day through the tab's own [ / ] keys so content loads
    // (pageDigest is closure-private). files are newest-first date-named.
    const i = memState.digest.files.findIndex((f) => f.startsWith(date));
    if (i < 0) { app.notice(`companion ▸ no digest for ${date}`); return; }
    const delta = i - memState.digest.back;
    for (let k = 0; k < Math.abs(delta); k++) app.pressKey(delta > 0 ? "[" : "]");
  },
  memoryView: (opts) => {
    app.tab = "digest";
    if (opts.day !== undefined) driver.digestDay(opts.day);   // day highlight = digest-selected day
    memState.view = "memory";
    memState.memFilter = opts.tag ?? memState.memFilter ?? null;  // see §4
    app.repaint();
  },
  setBoardFilter: (f) => {
    app.tab = "board";
    app.view.boardFilter = f;                      // see §4
    app.repaint();
  },
  setMemoryFilter: (tag) => {
    app.tab = "digest";
    memState.view = "memory";
    memState.memFilter = tag;                      // see §4
    app.repaint();
  },
  // Resolve on delivered, queued or unconfirmed; reject definite non-delivery.
  // The result trace preserves the label; queued/unconfirmed must not be re-sent.
  msgSession: (session, text) => deliverMessage(app, session, text),
  overseerInject: (text) => deliverMessage(app, "overseer", text),
  deployTab: (action) => {
    app.tab = "deploy";
    app.repaint();
    if (action === "abort") { app.pressKey("x"); return; }   // kills a running run (closes a finished log otherwise)
    if (action === "deploy") { app.pressKey("D"); app.pressKey("D"); return; }  // arm+confirm inside the window = instant (ratified)
    // stop/start: the tab's S button computes its own kind from the observed
    // container state (powerKind()); refuse a mismatched request rather than
    // silently doing the opposite.
    const kind = deployState.containerStatus !== undefined && !/^Up /.test(deployState.containerStatus) ? "start" : "stop";
    if (kind !== action) { app.notice(`companion ▸ deploy_tab ${action} refused — container is ${deployState.containerStatus ?? "unknown"}`); return; }
    app.pressKey("S");
    app.pressKey("S");
  },
};
```

Notes on the property names used above (all real, as of this branch):
- `app.tab` (`Tab = "board" | "digest" | "companion" | "deploy" | "metrics"`),
  `app.selectPr(pr)`, `app.pressKey(key)`, `app.notice(text)`,
  `app.hooks.sendMessage` (installed by `installMessageHooks`; validates the
  session name again and reports pending/✓/✖ on the notice line itself).
- `metricsView.window` is `"d7" | "d30" | "all"` (`MetricsWindowKey`) — hence
  the mapping from the verb's `"7d" | "30d" | "all"`.
- `memState.view` is `"digest" | "memory"`; `memState.digest.back`/`files`
  are the digest pager (`DigestState`).
- `deployState.containerStatus` is the docker-ps status string the power
  button reads (`/^Up /` = running).

## 3. The onPoll chaining (memedit's busy-flag style)

> *Applied delta:* verbatim (with `const driver = buildTuiDriver(…)` supplying
> the driver).

Immediately after the driver, chain onto `app.hooks.onPoll` exactly like the
memedit sweep does (prev-hook capture + in-flight flag so a slow sweep never
stacks):

```ts
let tuiActBusy = false;
const prevOnPoll3 = app.hooks.onPoll;
app.hooks.onPoll = (a) => {
  prevOnPoll3?.(a);
  if (tuiActBusy) return;
  tuiActBusy = true;
  void processTuiActions(tuiActionsDir, driver)
    .then((done) => {
      for (const r of done) a.notice(r.trace ?? `companion tui-action ${r.file}: ✖ ${r.message}`);
    })
    .catch(() => {
      /* best-effort — never break the poll loop */
    })
    .finally(() => {
      tuiActBusy = false;
    });
};
```

(`processTuiActions` already writes the `.result.json` files and archives
requests to `.done/` before executing; the notice line is the only extra
delivery.)

## 4. One-line filter consumption per tab

> *Applied delta:* the shared helper is `visiblePrs(view)` in **filters.ts**
> (not model.ts — model↔filters would otherwise cycle on the value import);
> ALL six app.ts `sortPrs` sites (incl. onPoll's reselect) plus renderBoard go
> through it. The board indicator paints as the `PRS (n)` section subtitle;
> board `F` is a new `case "char"` in App.handleInput (clears only when a
> filter is active). memtab shares one `orderedNow()` closure (render computes
> the same expression from `st`), the selection-rebind in `loadMemory` uses it
> too, the label sits beside `MEMORY (n)` with the FILTERED count, and `F` is
> handled at the top of `digestKey` so it clears from both the digest and
> memory views. `"F"` was added to cmdbar's `TAB_EXTRA_KEYS` for board+digest
> so it is a registered key (never seeds the strip).

The filter STATE lives on existing view objects; the helpers are pure.

**board.ts** — two small changes:
1. `BoardView` gains a field: `boardFilter?: import("./filters.js").BoardFilter | null;`
2. In `renderBoard`, where the PR list is derived (`sortPrs(view.snapshot.prs)`),
   wrap it: `applyBoardFilter(sortPrs(view.snapshot.prs), view.boardFilter)`
   — and paint `filterLabel(view.boardFilter)` (empty string when inactive)
   on the header/notice row. NOTE: `app.ts` also calls `sortPrs(...)` for
   selection movement (`onPoll`, up/down, `selectPr`, `selectedSession`,
   `selectedPrNumber`); wrap those with the same
   `applyBoardFilter(..., this.view.boardFilter)` so the selection can never
   land on a hidden row. (Extracting a shared
   `visiblePrs(view) = applyBoardFilter(sortPrs(view.snapshot?.prs ?? []), view.boardFilter)`
   helper into model.ts keeps this to one expression per site.)
3. Clear key: in `App.handleInput`'s board `case "char"` handling (or a new
   decode), `F` sets `this.view.boardFilter = null` — the indicator promises
   "F clears".

**memtab.ts** — three small changes:
1. `MemTabState` gains: `memFilter?: string | null;`
2. In `renderMemoryView` AND `memoryViewKey`, the timeline derivation
   `timelineOrder(st.entries)` becomes
   `applyMemoryFilter(timelineOrder(st.entries), st.memFilter)` (both sites,
   or one shared local — the render and the verbs must agree on ordinals,
   otherwise `x`/`p`/`e` would address a hidden entry). Paint
   `memoryFilterLabel(st.memFilter)` beside the `MEMORY (n)` header.
3. In `memoryViewKey`'s `case "char"`: `case "F": st.memFilter = null; …`

## 5. Companion side

> *Applied delta:* none — nothing to wire, as stated.

`prompts/companion.md` already documents the request-file contract
(`## Driving the TUI`) — nothing to wire; the companion container
mounts `alerts_dir` at `/alerts`, so `/alerts/tui-actions/` appears as soon
as the first sweep (or the companion) creates it.
