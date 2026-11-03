---
id: validate-security-only
scope: pass-validate
---
## Security findings only (security profile)
This review reports security defects and nothing else, and an approval from it means "no security finding". So before anything else, sort every candidate:

- **A security candidate** describes a security defect: a path by which someone crosses a trust boundary they should not — reads or changes data, takes an action or gains authority they lack, or has their input run as code or query. A `pass-sec-*` lens, a `kind:` of `security`, `security:<class>`, `exploit-chain` or `partial-chain`, and an evidence block naming a source, a boundary and a sink are what it usually carries. Judge it by every other rule you have, unchanged.
- **Any other candidate** — a crash, a logic error, a missing test, a performance cost, a contract drift, a style point, whichever lens raised it — is out of this review's scope, however real and however well traced. In a review round, kill it `out-of-scope`, naming the class of defect it is (`out-of-scope — not a security defect: a null dereference on a missing config key`). In a scan, where nothing is killed, list it under DOUBTED with the word `out-of-scope` and the same reason.

Sort by what the defect does, not by its tags. A `pass-sec-*` candidate whose consequence is a plain bug with no boundary crossed is not a security candidate; a candidate whose tags say nothing of security but whose trace shows an attacker reaching the sink is one. When a candidate carries both — a real security defect and an unrelated bug beside it — keep the security half and drop the other from its claim.

This sorting never weakens a security candidate: doubt about one is settled by your outcome rules (confirmed, a question naming the proof gap, or refuted with a citation), never by `out-of-scope`.
