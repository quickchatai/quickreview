This change reuses the label widget's cached text dimensions in the generic drawing path and removes repeated measurements there. One optional rendering backend still follows its own copy of the old path, so the intended performance improvement is incomplete. The code is otherwise sound and can be approved with that remaining gap called out.

**Verdict: Approved** — 1 question.

_Lenses applied: pass-baseline (terra-med), pass-placement (terra-med), pass-intent (terra-med), pass-validate (sol-high)._

### Questions
- `src/draw/lv_draw_label.c:221` — Nema GFX still repeats the size calculation _(P3/0.99, pass-baseline + pass-intent)_

---
*Automated review by review-bot[bot].*
