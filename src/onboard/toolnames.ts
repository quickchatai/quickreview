// The onboarding session's tool names: one source for the extension that
// registers them (extensions/onboarding.ts) and the argv that activates them
// (launch.ts `onboardingPiArgv`).
//
// pi's `--tools <list>` is an allowlist over EVERY tool, extension tools
// included (pi 1.4.0: createAgentSession({ tools }) leaves an extension tool
// that is not on the list inactive). So the argv must name each wizard tool,
// or the guide runs with no tools at all. The built-in belt stays read-only:
// bash, write and edit are never on the list.

/** pi's built-in tools the wizard may use: reading only. */
export const ONBOARD_BUILTIN_TOOLS: readonly string[] = ["read", "ls", "grep"];

/** The checklist tool. */
export const ONBOARD_STATUS_TOOL = "onboard_status";
/** The verify-everything-and-exit tool. */
export const ONBOARD_FINISH_TOOL = "finish_and_exit";

/** A step's tool name. */
export function onboardStepToolName(stepId: string): string {
  return `onboard_${stepId}`;
}

/** Every tool the onboarding extension registers over these step ids, in
 * registration order. */
export function onboardingExtensionToolNames(stepIds: readonly string[]): string[] {
  return [...stepIds.map(onboardStepToolName), ONBOARD_STATUS_TOOL, ONBOARD_FINISH_TOOL];
}

/** The whole `--tools` allowlist for the onboarding pi: the read-only belt,
 * then every wizard tool. */
export function onboardingToolAllowlist(stepIds: readonly string[]): string[] {
  return [...ONBOARD_BUILTIN_TOOLS, ...onboardingExtensionToolNames(stepIds)];
}
