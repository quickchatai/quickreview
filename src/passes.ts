// The pass vocabulary — every pass the system knows, in plan order. Its own
// module (no imports) so config parsing can validate pass-name knobs
// (`[review] skip_lenses`, `[models.pass_tiers]`) against it without an import
// cycle through dispatch.ts, which re-exports it.

/** Every pass the system knows: the lenses selectLenses can emit plus the
 * always-appended validator. addable_lenses derives from this set (∪ the
 * configured risk passes, which today are a subset of it). */
export const ALL_PASSES: readonly string[] = [
  "pass-baseline",
  "pass-ui",
  "pass-contracts",
  "pass-data-safety",
  "pass-security",
  "pass-statelessness",
  "pass-prod-risk",
  "pass-delivery",
  "pass-intent",
  "pass-placement",
  "pass-simplicity",
  "pass-backcompat",
  // no PATH predicate, deliberately. `selectLenses` never emits
  // pass-concurrency — a read-modify-write race has no filename (the 29
  // corpus findings span eight unrelated modules), so no path predicate finds
  // the set. It reaches a round through the add protocol, when the session
  // names the read-then-write it suspects — or (owner ruling 2026-10-02) as a
  // content-triggered sub-lens, when the diff touches synchronisation or the
  // PR text says race/lock/thread-safe (heuristics.ts SUBLENS_TRIGGERS; it
  // sits here, ahead of the other sub-lenses, in registry order).
  "pass-concurrency",
  // ADDABLE-ONLY for the same reason and one more. No path predicate
  // finds "code whose intent is written down nowhere", and the deciding fact —
  // whether the answer is in the repo at all — is only visible after the diff
  // has been read, which is exactly when the session runs the add protocol.
  // (pass-intent's substance bar is the precedent for what daemon-side
  // selection must be: cheap AND honest. The one body-shaped signal here — "the
  // PR text never says why" — is true of most PRs, so planning on it would
  // dispatch the lens nearly always: the pure-spend case that bar exists to
  // prevent, on a lens whose failure mode is volume.)
  "pass-ask-human",
  // Content-triggered sub-lenses (heuristics.ts SUBLENS_TRIGGERS — this list
  // is held equal to SUBLENS_PASSES by tests/review-levers.test.ts): planned
  // when their trigger fires, addable otherwise — the max-effort benchmark
  // runs added a lens on 6 of 10 PRs, and the added lens found defects no
  // planned one did.
  "pass-widened",
  "pass-roundtrip",
  "pass-deferred",
  "pass-bounds",
  "pass-claims",
  "pass-rollout",
  // Freeze fixes 2 (2026-10-03): base versus head on every modifying change —
  // planned as one row per group of modifying files when `[review]
  // behaviour_delta` is on; addable otherwise.
  "pass-behaviour-delta",
  // The per-file sweep: planned as one row per file group when `[review]
  // sweep` is on; otherwise addable, so a session can sweep a file it
  // suspects.
  "pass-sweep",
  // the tests lens — planned on every PR that changes code when
  // `[review] tests_lens` is on; addable otherwise.
  "pass-tests",
  // The code-quality lenses — planned when `[review] quality_lenses` is on and
  // the change adds enough code; addable otherwise.
  "pass-maintainability",
  "pass-duplication",
  "pass-abstraction",
  "pass-consistency",
  // The style lens — planned only when the repo has a written style guide
  // (src/styleguide.ts) or the profile points it at one; addable
  // otherwise, but it judges only against a guide, so without one it answers
  // NONE.
  "pass-style",
  // Freeze fixes 2 (2026-10-03): lint and format conformance — planned only
  // when a CI job runs a linter whose rules cover a changed file
  // (src/lintconfig.ts); addable otherwise.
  "pass-lint-conformance",
  "pass-validate",
];
