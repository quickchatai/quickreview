// The pass vocabulary — every pass the system knows, in plan order, and which
// of them a whole-repo scan may run. Its own module (no imports) so config
// parsing can validate pass-name knobs (`[review] skip_lenses`,
// `[models.pass_tiers]`, `[scan] deep_lenses`) against it without an import
// cycle through dispatch.ts, which re-exports it.

/** The security family: the `pass-sec-*` lenses, in plan order. Declared
 * once, here: `ALL_PASSES` places the family by spreading this list, so a
 * member is added or renamed in one place (tests/security-family.test.ts
 * holds it equal to every `pass-sec-*` name in `ALL_PASSES`). A lens is a
 * member only when its sole concern is security, so `pass-security` (the
 * general lens the default profile keeps) and `pass-bounds` are not. */
export const SECURITY_FAMILY: readonly string[] = [
  "pass-sec-authn-coverage",
  "pass-sec-access",
  "pass-sec-privesc",
  "pass-sec-iam",
  "pass-sec-tokens",
  "pass-sec-toctou",
  "pass-sec-injection",
  "pass-sec-boundaries",
  "pass-sec-secrets-data",
  "pass-sec-supply-chain",
  "pass-sec-llm",
  "pass-sec-infra",
  "pass-sec-variant",
  "pass-sec-exploit-chain",
];

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
  // No PATH predicate, deliberately. `selectLenses` never emits
  // pass-concurrency — a read-modify-write race has no filename (the corpus
  // findings span unrelated modules), so no path predicate finds the set. It
  // reaches a round through the add protocol, when the session names the
  // read-then-write it suspects — or as a content-triggered sub-lens, when the diff touches synchronisation or the
  // PR text says race/lock/thread-safe (heuristics.ts SUBLENS_TRIGGERS; it
  // sits here, ahead of the other sub-lenses, in registry order).
  "pass-concurrency",
  // Addable-only for the same reason and one more. No path predicate
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
  // Base versus head on every modifying change —
  // planned as one row per group of modifying files when `[review]
  // behaviour_delta` is on; addable otherwise.
  "pass-behaviour-delta",
  // The per-file sweep: planned as one row per file group when `[review]
  // sweep` is on; otherwise addable, so a session can sweep a file it
  // suspects.
  "pass-sweep",
  // The tests lens — planned on every PR that changes code when
  // `[review] tests_lens` is on; addable otherwise.
  "pass-tests",
  // The code-quality lenses — planned when `[review] quality_lenses` is on and
  // the change adds enough code; addable otherwise.
  "pass-maintainability",
  "pass-duplication",
  "pass-abstraction",
  "pass-consistency",
  // The style lens — planned only when the repo has a written style guide
  // (packages/pi-plugin/src/styleguide.ts) or the profile points it at one; addable
  // otherwise, but it judges only against a guide, so without one it answers
  // NONE.
  "pass-style",
  // Lint and format conformance — planned only
  // when a CI job runs a linter whose rules cover a changed file
  // (packages/pi-plugin/src/lintconfig.ts); addable otherwise.
  "pass-lint-conformance",
  // The security family (SECURITY_FAMILY above): single-concern security
  // lenses, planned on their own triggers (securitytriggers.ts), never in
  // SUBLENS_TRIGGERS, and always at the risk tier. pass-security and
  // pass-bounds stay where they are and are not members.
  ...SECURITY_FAMILY,
  "pass-validate",
];

/** Named lens families — what a profile's `only`, an addendum scope or a
 * request names in place of a list of lenses that would go stale. */
export const LENS_FAMILIES: Readonly<Record<"security", readonly string[]>> = {
  security: SECURITY_FAMILY,
};

/** The exploit-chain lens: one row per strategy, never one row for all. */
export const CHAIN_PASS = "pass-sec-exploit-chain";

/** How a chain row searches: `delta` from the hop this change adds,
 * `forward` from a persona at an entry point, `backward` from the assets
 * worth reaching, and `compose` over this round's security leads, after the
 * discovery wave. */
export const CHAIN_STRATEGIES = ["delta", "forward", "backward", "compose"] as const;

export type ChainStrategy = (typeof CHAIN_STRATEGIES)[number];

/** The lens one part of a recorded lens field names: its first word, with a
 * `:strategy`, `#n` or `@ site` after it dropped, and the built agent's
 * `--<tier>` suffix (`pass-sec-access--deep`, round-progress.ts
 * `lensForAgent`) dropped too — a session may write the agent it launched
 * rather than the lens. No lens name contains `--`. */
export function lensToken(part: string): string {
  return (part.trim().split(/[\s:#@]+/)[0] ?? "").replace(/--.*$/, "");
}

/** Whether a recorded lens field names a security-family lens. The field is
 * what a session wrote: one lens, or several joined
 * (`pass-sec-access + pass-baseline`, `pass-sec-tokens,pass-sec-access`),
 * a chain row carries its strategy (`pass-sec-exploit-chain:delta`), and
 * either may carry the agent's tier suffix (`lensToken`).
 * `pass-security` is not a member; a caller that counts it as security
 * says so itself. */
export function isSecurityLens(lensField: string): boolean {
  for (const part of lensField.toLowerCase().split(/[+,/&;|]/)) {
    if (SECURITY_FAMILY.includes(lensToken(part))) return true;
  }
  return false;
}

/** Lenses the whole-repo scan never runs: each needs a diff, a PR body or a
 * mid-round session to mean anything — plus the validator, which is not a
 * lens. Everything else in `ALL_PASSES` is a deep lens a scan may run. */
export const DIFF_ONLY_LENSES: readonly string[] = [
  "pass-intent",
  "pass-claims",
  "pass-backcompat",
  "pass-rollout",
  "pass-widened",
  "pass-sweep",
  "pass-ask-human",
  "pass-validate",
];

/** The deep lenses a scan may run: stage 1 may name them in a suggestion,
 * stage 2 may run them on a row. */
export const SCAN_DEEP_LENSES: readonly string[] = ALL_PASSES.filter(
  (p) => !DIFF_ONLY_LENSES.includes(p),
);

/** The deep scan's floor lenses by default (`[scan] deep_lenses`): the ones
 * that compare code with its siblings and follow a delivery through its
 * exits — what a first look over one unit never reaches. */
export const SCAN_DEEP_FLOOR_LENSES: readonly string[] = [
  "pass-consistency",
  "pass-delivery",
  "pass-duplication",
  "pass-maintainability",
];
