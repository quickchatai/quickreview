---
id: new-column-nullability
scope: pass-backcompat
---
## A new column is nullable for the window, then tightened (house rule)
One rule, two halves — and each half is easy to defend on its own until it meets the other.

**The first half is an anti-rule: `null=True, blank=True` on a NEWLY ADDED column is the required shape, not a modelling defect.** During the deploy window the old pods are still running and still writing rows that have no value for the new column; a column added `NOT NULL` breaks those writes. Never raise the nullability of a new column as a finding, never ask for the `NOT NULL` to land in this PR, and never treat `blank=True` beside it as sloppiness.

**The second half is the one that gets lost: the column is meant to be tightened once the window has passed and any backfill has run.** Where a PR adds a nullable column and neither its body nor its code shows that the tightening is planned, that is worth exactly one `[question]` — "is the follow-up that makes this NOT NULL planned, and what backfills it?" — attached to the model or migration. It is **never a blocker**, and it never asks THIS PR to do the tightening: the tightening belongs to a later deploy by construction, so demanding it here is demanding the bug back.

A column that was ALREADY nullable and stays nullable is not this rule; judge it on its own merits, if at all.
