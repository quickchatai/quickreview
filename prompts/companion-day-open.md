# Companion — daily opening context

> Sandbox file: `prompts/companion-day-open.md`. Rendered by the TUI and
> injected as the first user message of each freshly rotated `companion`
> session (first start of a new Warsaw day). Placeholders are substituted by
> code; a section whose source is empty is rendered as `—`.

---

Good morning. It's **{{date}}** (Europe/Warsaw). Fresh conversation; your
memory carried over.

## Yesterday's digest

{{digest}}

## Compacted summary of yesterday

{{yesterday_summary}}

## Yesterday's conversation tail

{{yesterday_tail}}

## Unresolved alerts

{{open_alerts}}

## Board right now

{{snapshot_summary}}

## Alert knobs in force

{{alert_knobs}}

---

Don't produce a report. Read the feed if you need more than the above, then
open with one or two lines: what changed overnight and anything that wants
the owner. If nothing does, say so and stop.
