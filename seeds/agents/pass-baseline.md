---
name: pass-baseline
description: Always-on review pass — claimed invariants, correctness, tests, conventions, sibling PRs, duplicate fixes.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: baseline (every PR)

**Claimed invariant — review the claim, not just the diff.** The PR's
title/body claim defines the review scope. If it claims a property
("retry-safe", "no message is dropped", "silences X", "fixes Y"), verify the
property holds across the *whole mechanism*, not just the changed lines:
enumerate the cases the claim covers and check each against the code. Two hard
rules: (a) **"pre-existing" is not a valid demotion** for a failure inside the
claimed failure class — a known drop path in a "nothing is dropped" PR is
in-scope by definition and is P1; (b) verify **efficacy**, not just safety —
confirm the mechanism can actually produce the claimed effect (trace the
arithmetic, the log levels, the control flow to the promised outcome). For
heuristic/fallback fixes, ask the root-cause question: *what upstream bug
creates this state, and where is it fixed?* — P3 question if the PR only
papers over it.

**Correctness** — Does the code do what it claims? Trace the logic. Edge cases
(empty/None/missing keys, concurrency)? `async`/`await` correct (no missing
awaits, no blocking calls in async paths)? ORM queries free of N+1
(`select_related`/`prefetch_related`)? When the diff assembles text from
fragments (LLM prompts, templates, user-facing messages), **materialize a
sample of the final string** and inspect the seams — whitespace, newlines,
separators. No literal placeholder token may be reachable in an outbound
message without a guaranteed fallback (remember `if x:` is falsy on `""`).

**Tests** — New features must have tests (`@pytest.mark.health`,
`@pytest.mark.django_db(transaction=True)`, function-based, typed). Missing
tests for a real feature is **P1**. Verify the headline regression test
actually **exercises the guarded branch** — a test that passes with the fix
reverted proves nothing. If the PR edits a prompt, fallback template, or other
string with a matching `EXPECTED_*` constant in a health test, the constant
must be updated in the same PR.

**Conventions** (from the repo's AGENTS.md) — flag violations as **nit**
unless they cause a bug: Django Ninja (not DRF) for new endpoints; new
endpoints `async`; raise exceptions instead of returning error responses;
Pydantic for dict↔Schema; full typing; absolute imports; constants/imports at
top of file.

**Sibling / template PRs** — If the PR is part of a series ("Phase 2/3",
"Follow-up to …", or the same template applied to a different integration),
read the sibling PR's diff and compare. Any divergence in the security or
correctness contract is suspicious: either the sibling has a bug this PR fixes
(call it out so the sibling gets patched too), or this PR is regressing a
check the sibling intentionally got right.

**Duplicate-fix check** — if the PR fixes a specific line/function, search
open PRs touching the same file (`gh pr list --state open --search
'<filename>'`, token-prefixed, read-only); if another open PR ships the same
fix, flag both numbers (P3) so a human closes one.

**Re-review duty** — when the task string lists prior findings to verify,
check each **mechanically at the current head** first and report its true
state (`fixed@sha` with evidence, or still-open) before hunting new findings.
