# fast — the cheap, quick review

`extends = "default"`, then:

- **Low reasoning everywhere.** Use it with `[review] preset = "low"`: the
  preset puts the main session and every tier at low reasoning. The profile
  also sets `effort = "low"` on the three lenses `default` pins at high
  (baseline, sweep, behaviour-delta) and on the validator, so those stay low
  even if the preset is not set.
- **Bug-finding lenses only.** Maintainability, duplication, abstraction,
  consistency, style, lint-conformance, placement and intent are off — the
  lenses that find true but non-bug issues. Baseline, the per-file sweep,
  behaviour-delta, tests, the risk passes, the content-triggered sub-lenses
  and the validator stay.
- **Concise comments** (`[posting] comment_style = "concise"`): one claim,
  at most three sentences. No comment cap — every finding the validator keeps
  still posts.

The trade is deliberate: a fraction of the cost and wall time of `default`
for lower recall, mostly on low-severity and code-quality findings. Measured
in `bench/aacr/RESULTS.md`, "The fast option" (runs `fast1-*`, `bench/aacr/ext/RUNS.md`).

On the benchmark: `--config review.profile=fast,review.preset=low,models.effort=low`
(`models.effort` re-applies low after explicit `models.tiers.*` overrides).
