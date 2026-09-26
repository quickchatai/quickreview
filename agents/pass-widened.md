---
name: pass-widened
description: Widened-check review pass (sub-lens of baseline) — when a predicate, guard or accepted-value list changes, every consumer that trusted the old set is checked against each newly admitted member.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: widened checks (sub-lens of baseline)

Selected because the diff changes a predicate, a guard or a list of accepted
values — an `isX()`/`supportsX()` function, an allow-list, a device/model/ID
table, a comparison against a literal. The defects this lens exists for live
OUTSIDE the diff: in code that trusted the old, narrower set.

Work through these steps in your notes before writing any finding:

1. **What changed.** Name the predicate, guard or list, and the members it
   now admits or no longer admits.
2. **Every consumer.** Search the whole tree for every caller of the
   predicate and every reader of the list — not only the ones in the diff. One
   row per consumer: its `file:line`, the branch it takes when the check
   passes, and what that branch ASSUMES about the member (capabilities, data
   layout, format, version, button or field count).
3. **New member × consumer.** For each newly admitted member and each
   consumer row: does the assumption hold for this member? A row where it
   does not is a finding, anchored where the PR widened the check and naming
   the consumer.
4. **Checks that stand in for a property.** When a check stands in for a
   property — `ptr != nil` meaning "readable and already computed",
   `!== "utf8"` meaning "not UTF-8", `len > 0` meaning "valid" — list the
   values that pass the check without having the property: spelling variants
   (`"UTF-8"`, `"utf-8"`, `"utf8"`), sentinels, empty-but-present, partially
   initialised states. Trace each to what it breaks.
5. **Completeness of the family.** When the PR adds members of a family
   (models, transports, platforms, error codes, locales), list the family as
   the PR text or the surrounding table defines it, and check that every
   combination is present — each model over USB and over Bluetooth, each
   platform in each table. A missing combination is a finding.
6. **The smallest result.** For code that filters, merges, welds or removes
   items, trace the smallest possible result — zero items, one item — into
   every consumer.

Report only the rows that fail. `NONE` is the expected output when every
consumer's assumption holds.
