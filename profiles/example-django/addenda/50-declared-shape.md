---
id: declared-shape
scope: pass-baseline
---
## The declared shape must be honest, and closed where the values are (house rule)
**A declared type that contradicts the body is a defect — one of the two is a lie.** `-> str` on a function with a `return None` path; `Optional[X]` on a value no path leaves unset; a parameter annotated `dict` that every caller passes a fixed set of keys to; a `check_*` that raises or a `validate_*` that returns a bool. **Say which side you believe is wrong and why** — sometimes the annotation is stale and sometimes the code is, the remedies are opposite, and a finding that does not name which is unactionable. Anchor it at the signature and quote the contradicting line in `evidence`.

**A value with a fixed set of possibilities is an enum, not a magic string.** `TextChoices` on a model field, an `Enum` or `Literal` in Python, a named constant where neither fits. A bare string literal that is compared or assigned in more than one place, or that a model column constrains, is a real finding — not a passing nit. A literal used exactly once, locally, is not.

Neither of these is "add the missing annotations": completing an otherwise honest signature is a house convention, not a defect. If it matters on this diff, keep it a `[nit]`, and look the convention up in memory rather than asserting it.
