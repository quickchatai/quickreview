---
id: snappy-select-certain-defects
scope: pass-validate
---
## Which survivors to SELECT under the budget (snappy profile)
When the posting budget makes you choose, rank the survivors by how certain and how plain the defect is, not by how alarming its worst case sounds:
1. A defect you confirmed by reading the changed lines themselves — the code does the wrong thing on an ordinary input (a wrong condition, a wrong variable, an inverted check, a missing null/empty case, a value computed and then ignored, a race on shared state) — beats one that needs a long chain of assumptions about callers, configuration or deployment to go wrong.
2. A defect two or more lenses raised independently beats one raised by a single lens.
3. Then impact: data loss, security, crashes, wrong results, then everything else.
A shorter causal chain wins a tie. A "missing test", a documentation note or a maintainability point is never selected over a defect in the code. This ranks what POSTS; it moves no severity, no confidence and no kill.
