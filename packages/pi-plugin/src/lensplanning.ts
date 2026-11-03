// When each lens runs, and how strongly the planner prefers it — ONE table
// every lens must appear in (tests/freeze-fixes-2.test.ts holds it equal to
// ALL_PASSES).
//
// No lens is removed or disabled for being expensive — abstraction,
// placement and backcompat included; the only off switches are the
// operator's: a profile's per-lens `enabled` and config.toml's `[review]
// skip_lenses` (both applied in buildPassPlan). Instead each lens is planned
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
  // The security family (passes.ts SECURITY_FAMILY): each planned on its own
  // trigger family (securitytriggers.ts), run at the risk tier once planned.
  // A weak trigger plans only under `[security] triggers = "all"`.
  "pass-sec-authn-coverage": {
    priority: "risk",
    when: "a guard, decorator or middleware check is removed, config turns authentication off, or the threat model names a changed entry point or control; or a route is registered (weak)",
  },
  "pass-sec-access": {
    priority: "risk",
    when: "the threat model names a changed control, or a query keyed on a tenant or owner changes (weak)",
  },
  "pass-sec-privesc": {
    priority: "risk",
    when: "a role or permission field is written from request input, or auth, role, invite, SSO or SCIM code changes (weak)",
  },
  "pass-sec-iam": {
    priority: "risk",
    when: "the change grants platform authority: a wildcard IAM action, PassRole or an open AssumeRole trust, a cluster-admin binding, RBAC escalate/bind/impersonate, sudoers NOPASSWD, or a SQL GRANT in a migration",
  },
  "pass-sec-tokens": {
    priority: "risk",
    when: "signature or expiry verification is switched off; or JWT, OAuth, SAML, session or expiry code changes (weak)",
  },
  "pass-sec-toctou": {
    priority: "risk",
    when: "a read-then-write lands next to a balance, quota, token, invite or other security asset (weak); addable otherwise",
  },
  "pass-sec-injection": {
    priority: "risk",
    when: "added code interpolates into raw SQL, runs a shell or eval on a non-literal, deserializes unsafely, or bypasses output escaping; or the threat model names a changed entry point or sink",
  },
  "pass-sec-boundaries": {
    priority: "risk",
    when: "the threat model names a changed sink, or added code fetches a URL or opens a path built from a variable (weak)",
  },
  "pass-sec-secrets-data": {
    priority: "risk",
    when: "an added line carries a credential shape, wherever it sits",
  },
  "pass-sec-supply-chain": {
    priority: "risk",
    when: "a CI workflow uses pull_request_target or an event expression in a run step; or a manifest, lockfile, workflow or container file changes (weak)",
  },
  "pass-sec-llm": {
    priority: "risk",
    when: "added code calls a model, defines an agent tool or changes a prompt template (weak)",
  },
  "pass-sec-infra": {
    priority: "risk",
    when: "config opens ingress to any address, turns authentication off, makes a resource public, or runs a container privileged or on the host network; or IaC, cluster, compose, proxy or firewall files change (weak)",
  },
  "pass-sec-variant": {
    priority: "risk",
    when: "the PR title or diff is shaped like a security fix (weak); addable otherwise, to hunt the pattern's siblings",
  },
  "pass-sec-exploit-chain": {
    priority: "risk",
    when: "one row per strategy: delta when a guard is removed, two or more family lenses are planned, the threat model is hit or a security review is requested; forward and backward on a request or a large server change under a threat model; compose after discovery when any family row ran",
  },
  "pass-validate": {
    priority: "core",
    when: "every round, last, unless the profile switches it off",
  },
};
