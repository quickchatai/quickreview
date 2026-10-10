# Provenance — what the FT-#### citations mean

In places across this codebase — commit messages, some test names and fixture
data, dated reports, and tokens the code itself matches on — you'll find
citations like or. These are ticket ids from the project's
**internal design-history tracker**, where substantial design decisions were
argued, decided, and recorded before they were built.

The tracker itself is not published, so the ids are not links you can follow.
Code comments and docs do not depend on them: a comment states the rule and,
where it is not obvious, its reason, as a fact about the system. Git history
carries who decided what and when.

Practical guidance:

- **You never need a ticket to work on the code.** Everything load-bearing
  from a decision is stated where it matters: in the comment on the code, in
  the test that pins the behaviour, or in [ownership.md](ownership.md).
- **Treat a pinned rule as a decision.** If your change contradicts a rule a
  comment states or a test pins, raise the disagreement in your PR rather than
  silently "fixing" it — the odds are good the current shape was chosen over
  named alternatives.
- **Role wording.** Decisions belong to the owner role: the accountable
  human's identity is installation config, not a name in code. Older artifacts
  (ratification fence markers, divergence-registry notes) may carry the
  original owner's name; the verifying grammars accept both spellings, and
  history is never rewritten.

New decisions in the public project need no FT ids — use GitHub issues and
PR discussions; the convention to keep is the *practice* (decide, record,
then build), not the id format.
