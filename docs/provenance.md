# Provenance — what the FT-#### citations mean

Throughout this codebase — comments, test names, docs, commit messages —
you'll find citations like,, often with a date and
"ratified" or "decided". These are ticket ids from the project's **internal
design-history tracker**, where every substantial design decision was argued,
decided, and recorded before it was built.

The tracker itself is not published, so the ids are not links you can follow.
They remain in the code deliberately, as **provenance**: a citation marks a
line of code or a rule as the outcome of a recorded decision — usually with a
rejected alternative behind it — rather than an accident of implementation.
When a comment says something like *"uphold by default; the only transition
is APPROVE → REQUEST_CHANGES"*, the id tells you this exact shape
was chosen on purpose, on a specific day, over named alternatives.

Practical guidance:

- **You never need a ticket to work on the code.** Everything load-bearing
  from a cited decision is restated where it matters: in the comment carrying
  the citation, in the test that pins the behaviour, or in
  [docs/ownership.md](docs/ownership.md).
- **Treat a citation as a "here be a decision" marker.** If your change
  contradicts a comment carrying an FT id, the disagreement is worth raising
  in your PR rather than silently "fixing" — the odds are good the current
  shape survived an argument.
- **Dates and role wording.** Decision attributions are written in the owner
  role ("the owner, 2026-08-19"): the accountable human's identity is
  installation config, not a name in code. Older artifacts (ratification
  fence markers, divergence-registry notes) may carry the original owner's
  name; the verifying grammars accept both spellings, and history is never
  rewritten.

New decisions in the public project need no FT ids — use GitHub issues and
PR discussions; the convention to keep is the *practice* (decide, record,
cite), not the id format.
