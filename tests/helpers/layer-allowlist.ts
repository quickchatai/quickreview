// The layer fence's ratchet. Every entry is a known violation the
// refactor has not cut yet. tests/layers.test.ts fails on a violation missing
// from these lists AND on an entry that no longer occurs, so the lists only
// ever shrink. Both are empty when the refactor is done.

/** Runtime edges pointing up the layers, as `from -> to`. */
export const UPWARD_EDGES_ALLOWED: readonly string[] = [
  "extensions/ledger-pin.ts -> src/pr-identity.ts",
  "src/cigate.ts -> src/statemachine.ts",
  "src/ecosystem.ts -> src/migrations.ts",
  "src/engine/context.ts -> src/config.ts",
  "src/engine/context.ts -> src/install.ts",
  "src/engine/lens/registry.ts -> src/config.ts",
  "src/engine/lens/runlens.ts -> src/config.ts",
  "src/engine/prompts.ts -> src/dispatch.ts",
  "src/engine/sdkruntime.ts -> src/config.ts",
  "src/engine/select.ts -> src/config.ts",
  "src/findingsrecord.ts -> src/round-work.ts",
  "src/findingsrecord.ts -> src/wakes.ts",
  "src/followup-mode.ts -> src/config.ts",
  "src/gate.ts -> src/posting-receipt.ts",
  "src/guards.ts -> src/standing-review.ts",
  "src/guards.ts -> src/statemachine.ts",
  "src/include.ts -> src/config.ts",
  "src/lenstuning.ts -> src/config.ts",
  "src/priorfindings.ts -> src/outcomes.ts",
  "src/profileoverrides.ts -> src/install.ts",
  "src/profiles.ts -> src/config.ts",
  "src/profiles.ts -> src/dispatch.ts",
  "src/profiles.ts -> src/install.ts",
  "src/reviewcli.ts -> src/config.ts",
  "src/reviewcli.ts -> src/install.ts",
  "src/reviewdelta.ts -> src/dispatch.ts",
  "src/reviewdelta.ts -> src/tmux.ts",
  "src/reviewdelta.ts -> src/worktrees.ts",
  "src/reviewstore.ts -> src/install.ts",
  "src/templates.ts -> src/escalation.ts",
];

/** Forbidden process calls in core, as `file: name`. */
export const CORE_FORBIDDEN_ALLOWED: readonly string[] = [];
