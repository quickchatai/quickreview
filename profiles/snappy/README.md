# snappy — a handful of comments per PR, bugs first

`extends = "default"`, then:

- **`[posting]`** — at most 4 posted findings per round (every `[blocker]`
  posts regardless), no nits, questions inside the budget, one site per
  finding, a verdict-only review body, concise single-claim comments. The
  validator SELECTS what posts; the rest is recorded `withheld` in the
  findings record and shown in the TUI — never posted, never deleted. The
  policy is also applied mechanically after the session (src/posting.ts and
  the benchmark export, src/bench/benchposting.ts).
- **Lenses off** — maintainability, duplication, abstraction, consistency,
  style, ui, placement, intent: the lenses that find true but non-bug issues.
  Baseline, the per-file sweep, tests, bounds, widened, security,
  data-safety and the other risk passes stay.
- **Addenda** (pass-validate): `snappy-race-as-question` — a confirmed but
  unprovable race is kept as a `plausible` finding, a `[question]` by the
  unchanged reachability gate, rather than killed as speculative;
  `snappy-select-certain-defects` — under the budget, select by certainty
  (confirmed in the changed lines, short causal chain), then lens agreement,
  then impact.

Why it exists and how it is measured: `bench/aacr/ext/SNAPPY-PLAN.md` and
`bench/aacr/EXTERNAL-BENCHMARKS.md`. Select it with `[review] profile =
"snappy"`, or on the benchmark with `--config review.profile=snappy`.
