# Provenance — how decisions are recorded

Substantial design decisions in this project were argued and decided before
they were built. The code does not depend on that record: a comment states the
rule and, where it is not obvious, its reason, as a fact about the system. Git
history carries who decided what and when.

Practical guidance:

- **You never need the history to work on the code.** Everything load-bearing
  from a decision is stated where it matters: in the comment on the code, in
  the test that pins the behaviour, or in [ownership.md](ownership.md).
- **Treat a pinned rule as a decision.** If your change contradicts a rule a
  comment states or a test pins, raise the disagreement in your PR rather than
  silently "fixing" it — the odds are good the current shape was chosen over
  named alternatives.
- **Role wording.** Decisions belong to the owner role: the accountable
  human's identity is installation config, not a name in code.

New decisions go in GitHub issues and PR discussions; the convention to keep is
the *practice* (decide, record, then build).
