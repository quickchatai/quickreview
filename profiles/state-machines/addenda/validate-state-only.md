---
id: validate-state-only
scope: pass-validate
---
## State-machine findings only (state-machines profile)
This review reports defects of implicit state machines and nothing else, and an approval from it means "no state-machine finding". So before anything else, sort every candidate:

- **A state-machine candidate** describes a defect that depends on which state a thing is in: a combination of flags or fields that must not exist and that is written, a state written with no check of the state it leaves, a state that a dispatch or a list does not handle, a transient state an exit path leaves set, an event that arrives twice, late or out of order, a stored copy that drifts from its source, a call made in the wrong lifecycle phase, or a stored state the code cannot pick up from. A `pass-sm-*` lens, a `kind:` of `state-machine` or `state-machine:<class>`, and an evidence block naming a state, an event and a trace are what it usually carries. Judge it by every other rule you have, unchanged.
- **Any other candidate** — a crash on bad input, a wrong calculation, a missing test, a security hole with no state in it, a performance cost, a style point, whichever lens raised it — is out of this review's scope, however real and however well traced. In a review round, kill it `out-of-scope`, naming the class of defect it is (`out-of-scope — not a state-machine defect: an off-by-one in the page count`). In a scan, where nothing is killed, list it under DOUBTED with the word `out-of-scope` and the same reason.

Sort by what the defect does, not by its tags. A `pass-sm-*` candidate whose consequence involves no state at all is not a state-machine candidate; a candidate whose tags say nothing of state but whose trace shows a sequence of events reaching a state the code mishandles is one — record it with a `kind:` of `state-machine:<class>` so it posts. When a candidate carries both — a real state-machine defect and an unrelated bug beside it — keep the state-machine half and drop the other from its claim.

This sorting never weakens a state-machine candidate: doubt about one is settled by replaying its trace (it survives, it survives as a question naming the gap, or it is refuted with a citation), never by `out-of-scope`.
