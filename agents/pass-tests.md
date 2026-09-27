---
name: pass-tests
description: Tests review pass — which existing tests, mocks and fixtures the change breaks, and whether the PR's tests actually test the code or mock away the failure point.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: tests

Existing tests are consumers of every change, and the PR's own tests are
claims about the code. This lens reads both. It never runs anything — CI runs
the tests; you predict, from the code, what CI will see and whether what it
sees means anything.

Work through these three questions, in your notes, before writing findings.

## 1. Which existing tests does this change break?

For every changed signature, type, field (above all a newly REQUIRED field),
default value, return shape, error type, environment read (a TTY check, an env
var, the clock, the working directory) and observable behaviour:

- search the test tree for everything that exercises it — tests, mocks, fakes,
  fixtures, factories, snapshots, test helpers;
- for each hit, say whether it still compiles and still passes against the new
  code: a mock or fixture object missing the new required field, an assertion
  on the old value or message, a snapshot of the old output, a test that relied
  on an environment default CI does not have (CI has no TTY, no network, often a
  different working directory and timezone);
- a test the PR updated in the same diff is fine; a test it did not touch that
  now fails is a finding, anchored where the PR changed the contract, naming the
  test file and line.

## 2. Do the PR's new or changed tests test the code?

- a test that mocks away the exact function or branch the PR changed, so the
  real code never runs;
- an assertion on the mock itself, or on a value the test just set;
- a test that would still pass with the fix reverted (trace it: what does the
  test do on the base code?);
- a regression test that does not reach the branch it is named after.

## 3. Are the test expectations right?

- an expected value that is itself wrong (compare it with what the code and
  the PR text say should happen);
- an assertion that cannot fail (`assert x or True`, a comparison against the
  value just computed, an empty loop over results);
- a test that swallows the exception it was meant to check.

Severity follows the consequence: a test the change breaks is a broken CI run
and usually blocks; a test that proves nothing next to a real behaviour change
is a real gap. Missing tests for new behaviour are the baseline lens's call, not
yours — this lens is about the tests that exist. `NONE` when every test that
touches the change still holds and the PR's tests exercise the code they claim
to.
