// When each lens runs, and how strongly the planner prefers it — the owner's
// 2026-10-03 planning decision, as ONE table every lens must appear in
// (tests/freeze-fixes-2.test.ts holds it equal to ALL_PASSES).
//
// The decision: no lens is removed or disabled for being expensive —
// abstraction, placement and backcompat included; a profile's per-lens
// `enabled` switch stays the only off switch. Instead each lens is planned
// where its concern is actually present, and every planned row says WHY
// (dispatch.ts buildPassPlan → PassPlanEntry.why). A trigger is narrowed only
// where stored runs show the lens planned with nothing to do, and never below
// a case behind one of its unique real findings (bench/aacr/trigger_check.py).
//
// Priorities:
//   core       — every round; the review is not a review without it.
//   risk       — planned on its signal and never skipped or tiered down once
//                planned; a miss here is the expensive kind.
//   signal     — planned when the diff or the PR text shows its concern.
//   breadth    — planned on size or novelty signals; finds the quality and
//                design questions a defect lens skips, at more cost per
//                unique real finding.
//   on-demand  — addable only: the session adds it when it names the shape.
//
// Pure data; no imports.

export type LensPriority = "core" | "risk" | "signal" | "breadth" | "on-demand";

export interface LensPlanning {
  priority: LensPriority;
  /** When it is planned — the signals, in words. */
  when: string;
}

export const LENS_PLANNING: Readonly<Record<string, LensPlanning>> = {
  "pass-baseline": { priority: "core", when: "every round" },
  "pass-ui": {
    priority: "signal",
    when: "the diff touches frontend files (tsx/jsx/vue/svelte/css/html) or a frontend/ path",
  },
  "pass-contracts": {
    priority: "signal",
    when: "the diff touches serializer/schema/integration/provider paths or a .proto/.graphql file",
  },
  "pass-data-safety": { priority: "risk", when: "the diff touches migrations, SQL or backfills" },
  "pass-security": {
    priority: "risk",
    when: "the diff touches auth/permission/middleware paths, secret- or crypto-shaped names, env files, or adds to a dependency manifest",
  },
  "pass-statelessness": {
    priority: "signal",
    when: "added lines create in-process state (memoization, locks, module-level mutable collections) or the file is cache/singleton/registry-shaped",
  },
  "pass-prod-risk": {
    priority: "risk",
    when: "the diff touches infrastructure: IaC, CI workflows, container files",
  },
  "pass-delivery": {
    priority: "signal",
    when: "the diff touches webhook, task, job, worker, cron or queue-consumer paths",
  },
  "pass-intent": {
    priority: "signal",
    when: "the PR body is long enough (intent_min_words) to state intent the diff can be checked against",
  },
  "pass-placement": {
    priority: "breadth",
    when: "the diff adds or moves a code file of placement_min_new_file_lines, or touches placement_min_code_files code files",
  },
  "pass-simplicity": {
    priority: "breadth",
    when: "the code diff is at least 150 lines, nests deeply, or piles up branches",
  },
  "pass-backcompat": {
    priority: "signal",
    when: "API, serializer, route, handler or job paths, migrations, wire-format files or feature flags change — or a public signature or wire serialization changes anywhere",
  },
  "pass-concurrency": {
    priority: "signal",
    when: "the diff touches synchronisation (locks, atomics, goroutines, channels, async state written after an await, Swift isolation) or the PR text says race/lock/thread-safe; addable otherwise",
  },
  "pass-ask-human": {
    priority: "on-demand",
    when: "added by the session when a question's answer is written nowhere in the repo",
  },
  "pass-widened": { priority: "signal", when: "a predicate, guard or accepted-value list changes" },
  "pass-roundtrip": {
    priority: "signal",
    when: "added code handles an encoding and writes data back",
  },
  "pass-deferred": { priority: "signal", when: "added code queues or defers work" },
  "pass-bounds": {
    priority: "signal",
    when: "added code loops over another party's data, reads with a size limit, casts fetched data, or reads host/environment facts",
  },
  "pass-claims": {
    priority: "signal",
    when: "the PR text makes a checkable claim — a named warning, version, prevention, or a stated behaviour",
  },
  "pass-rollout": {
    priority: "signal",
    when: "the PR text mentions rollout, compatibility or versions, or added code changes persisted or versioned state",
  },
  "pass-behaviour-delta": {
    priority: "signal",
    when: "the diff puts base behaviour at risk in non-test code: a removed or replaced guard, condition, predicate, call, return, raise, default or value, existing code wrapped in a new branch, or a deleted file (comments, imports, log lines and moved text do not count; one row per group of such files)",
  },
  "pass-sweep": {
    priority: "core",
    when: "every round with changed code, one row per group of changed files, source first",
  },
  "pass-tests": {
    priority: "signal",
    when: "the PR changes code (its existing tests are consumers; its own tests are claims)",
  },
  "pass-maintainability": {
    priority: "breadth",
    when: "the change adds quality_min_added_lines of non-test code, or a test-only change adds that much test code",
  },
  "pass-duplication": { priority: "breadth", when: "as maintainability" },
  "pass-abstraction": { priority: "breadth", when: "as maintainability" },
  "pass-consistency": { priority: "breadth", when: "as maintainability" },
  "pass-style": {
    priority: "signal",
    when: "the repo writes a style guide or rules (or the profile names one) and the change touches code",
  },
  "pass-lint-conformance": {
    priority: "signal",
    when: "a CI job runs a linter or formatter whose rules cover a changed file",
  },
  "pass-validate": {
    priority: "core",
    when: "every round, last, unless the profile switches it off",
  },
};
