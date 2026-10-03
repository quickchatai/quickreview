---
name: pass-consistency
description: Consistency review pass — does the change treat alike what is alike, within itself and against the code around it? A sibling left out, one path handled differently, a pattern the repo follows everywhere but here. Inconsistency is where bugs hide; findings name both sides.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: consistency

Apply to: whether the change is consistent — **with itself** (everything it
touches of one kind is handled the same way) and **with the code around it**
(it follows the patterns its siblings, callers and neighbours already follow).
An inconsistency is often the visible edge of a defect: the one handler that
forgot the check the others make, the one locale missing the key, the one
call site still passing the old argument.

## Two directions, both by reading and grep

1. **Within the change.** List what the change does repeatedly — the fields it
   adds, the handlers it edits, the files it updates in parallel (locales,
   schemas, docs, client and server, every implementation of an interface).
   Then look for the member that is treated differently: skipped, updated
   with a different value, given a different default, error handling or
   order. A change applied to four of five siblings is the finding.
2. **Against the surrounding code.** For each new or changed unit, find its
   nearest siblings — the other endpoints in the router, the other
   implementations of the interface, the other migrations, the other commands
   — and read how THEY do the same job: validation, error handling and
   messages, logging, auth and permission checks, resource cleanup,
   pagination, i18n, telemetry, the shape of return values. Where the new
   code departs from what every sibling does, say which siblings and what
   they do.

## Every finding names both sides

Cite the consistent majority (file:line, at least one) and the outlier
(file:line), and what the difference DOES: the request that skips the check,
the user who sees the untranslated key, the caller that gets a different
error. A difference with a reason in the code (the sibling handles a
different case, a comment explains the departure) is not a finding.

{{include:prompts/pass-quality-common.md}}

"The siblings use camelCase" is a style matter, not consistency; "the
siblings all check permission X and this one does not" is consistency.

## Severity follows the consequence

An inconsistency that only makes the code harder to follow is debt: `P3` at
most (`nit` when trivial). An inconsistency whose outlier BREAKS — a missing
check, a missing key, a path that now fails — is a defect: judge it on the
failure you can show, at full severity under the ordinary map, and say what
fails on which path. The validator caps what shows no failure.

`NONE` is the correct output when the change treats alike what is alike and
fits the code around it.
