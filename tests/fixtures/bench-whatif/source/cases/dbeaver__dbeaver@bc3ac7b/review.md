This change enables copying remote workspace files into a TE filesystem by streaming their contents when no local path exists. The approach is sound, but the new copy path leaves each opened source stream unclosed, so repeated pastes can retain remote filesystem resources. That lifecycle issue must be fixed before merge.

**Verdict: Changes requested** — 1 blocker.

_Lenses applied: pass-baseline (terra-med), pass-simplicity (terra-med), pass-validate (sol-high)._

### Blockers

- `plugins/org.jkiss.dbeaver.model/src/org/jkiss/dbeaver/model/navigator/fs/DBNPathBase.java:293` — Close the source stream after copying _(P2/0.98, pass-baseline, pass-simplicity)_

---
_Reviewed by review-bot[bot]._
