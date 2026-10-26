# LiveEvent v1

One event log feeds every viewer of a running review, whatever hosts the
session. A host appends one JSON line per event to

```
state/live/<key>/r<round>/main.jsonl          the round's main session
state/live/<key>/r<round>/lens-<id>.jsonl     one lens session
```

`<key>` is `pr-<n>` on the bot and the review's name on a one-shot; a one-shot
keeps the tree inside its run directory (`<run>/state/live/...`). The format is
`packages/pi-plugin/src/live/events.ts`, the writer `packages/pi-plugin/src/live/writer.ts`, the reader and the
round-progress projection `packages/pi-plugin/src/live/read.ts` and `packages/pi-plugin/src/live/projection.ts`.

## Lines

Every line is `{v:1, seq, at, type, ...}`. `seq` counts from 1 in its own file
and never repeats, so a reader that has seen seq N asks only for what follows
and a gap is visible. `at` is the instant the event happened.

The lines are slim on purpose. pi restates a whole transcript on every
`message_update` and `tool_execution_update`, so the log keeps:

- one `message_delta` per ~250 ms window (the text and thinking streamed in it),
  stamped with the window's first update;
- one `tool_update` per call per window, carrying only the children whose slim
  form changed since that call's previous line (`n` is the whole count, `slot`
  places a child);
- for a lens tool, the arguments and the tasks the host resolved at call start
  (`executions`); for any other tool a one-line `preview`.

Anything else flushes what is held first, so the file keeps the order events
happened in. A write that fails is reported once and ignored: the log never
costs the session it watches.

## Reading

`readLiveEvents(path, fromOffset)` consumes complete (newline-ended) lines only
and returns the byte offset past the last one, so a tail poll resumes there and
never sees half a line. A torn last line is left for the next read; a writer
that finds one closes it off before its first line, and the reader skips that
one line.

## The round-progress projection

`projectRoundProgress(events)` reproduces what the retired tmux
round-progress extension published: the `state/round-progress/pr-<n>.json` snapshot (v2, the contract in
`packages/pi-plugin/src/round-progress.ts` unchanged) and the append-only transition log. The
extension was the reference: `tests/live-projection-golden.test.ts` holds the
projection byte-equal to golden files recorded from it
(`tests/fixtures/live-events/golden/`).

The log is coarser than pi's stream in one respect: time. A held update is
stamped at its window, so a heartbeat's `updated_at`, or a `started_at` taken
from an update, can differ from the extension's by up to one window. Milestone
order, statuses and command identity do not depend on it.

## Live lens activity

A lens reports what it is doing while it runs, not only when it ends. The
runner (`packages/pi-plugin/src/engine/lens/runlens.ts`) hears each tool call
of a pass's session start and end (`activity.ts`) and tells the request's
`onActivity`; the `lens` and `lens_wave` tools lay that on the pass's running
slot as the native subagent tool's `progress` record (status, duration, tool
count, the current tool in `recentTools`, and `currentTarget`, the path it
works on) and send an update, at most one per `ACTIVITY_UPDATE_MS` while a pass
works and at once when one lands. The update reaches the main log like any
other, so each running lens projects with a growing `tool_count`, its
`current_tool` and its `current_target`; a finished one keeps its final count
and duration, and a failed one reads `failed`. `current_target` is the one
field past the extension, and a native round never carries it.

`packages/pi-plugin/src/live/lensline.ts` turns one projected lens into the line
a person reads (`security · read src/x.ts · 7 tools · 0:41`); `qcr review
status` carries both, and the plugin reads the same projection through
`latestLiveRound` and `viewRound`.

## Who writes and reads

- `runRound` (`packages/pi-plugin/src/engine/round.ts`) writes the main log when its spec carries
  `live: {root, key, round}`; `qcr review` passes its run directory. The runtime
  port's `subscribe(listener, {updates: true})` is how the writer hears the
  update events the ordinary stream leaves out.
- `createLensRunner` takes `live: (id, agent) => LiveSink` and logs each pass to
  `lens-<id>.jsonl`.
- `qcr review status` projects the latest round to show which lenses run, what
  each is doing and what the parent is doing, before the stage record exists.
- `qcr live [RUN_ID|DIR] [--lens ID] [--round N] [--follow] [--json]` prints the
  transcript.
