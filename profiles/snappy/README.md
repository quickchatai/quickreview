# snappy — a handful of comments per PR, bugs first

`extends = "default"`, then:

- **`[posting]`** — at most 4 posted findings per round (every `[blocker]`
  posts regardless), no nits, only blocking (P0–P2) questions, one site per
  finding, a verdict-only review body, concise single-claim comments. The
  validator SELECTS what posts; the rest is recorded `withheld` in the
  findings record and shown in the TUI — never posted, never deleted. The
  policy is also applied mechanically after the session
  (`selectPosted` in src/postingpolicy.ts, run by the render step on the live
  route and in the benchmark).
- **Lenses off** — maintainability, duplication, abstraction, consistency,
  style, ui, placement, intent: the lenses that find true but non-bug issues.
  Baseline, the per-file sweep, tests, bounds, widened, security,
  data-safety and the other risk passes stay.
- **Addendum** `snappy-race-as-question` (pass-validate): a confirmed but
  unprovable race is kept as a `plausible` finding — a `[question]` by the
  unchanged reachability gate — rather than killed as speculative.

Why it exists and how it is measured: the benchmark paper
([`bench/aacr/paper/benchmark.pdf`](../../bench/aacr/paper/benchmark.pdf), the external
benchmarks). Select it with `[review] profile =
"snappy"`, or on the benchmark with `--config review.profile=snappy`.
