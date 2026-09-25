This change moves batch positions and output selectors into tensors and passes them directly through the model stack. The interface cleanup is mostly coherent, but Llama 4 model fitting now reads position values from storage deliberately left unallocated, so model initialization can crash; I also found two nonblocking regressions around tensor dumping and invalid input handling. Changes are required before merge to keep fitting safe.

**Verdict: Changes requested** — 1 blocker, 2 questions.

_Lenses applied: pass-baseline (sol-med), pass-placement (sol-med), pass-simplicity (sol-med), pass-validate (sol-high)._

### Blockers
- `model/models/llama4/model_text.go:222` — Keep position values readable during the fit pass _(P1/0.97, pass-validate)_

### Questions
- `ml/backend/ggml/ggml.go:1007` — Preserve the distinction between allocated and computed tensors _(P2/0.99, pass-baseline)_
- `model/model.go:285` — Preserve the invalid-batch error for missing positions _(P3/0.98, pass-simplicity)_

---
_Reviewed by review-bot[bot]._
