// The home's tool names: one source for the extension that registers them
// (extensions/home.ts) and the launch that activates them (launch.ts).
//
// pi's `--tools <list>` is an allowlist over every tool, extension tools
// included (pi 1.4.0), so the reviewer-only launch names each home tool. The
// read tools are pi's own; bash, edit and write are never on the list.

/** Every tool the home registers. */
export const HOME_TOOL_NAMES = [
  "home_status",
  "home_refresh",
  "home_move",
  "home_select",
  "home_open_pr",
  "home_review_pr",
  "home_show_review",
  "home_stop_review",
] as const;

/** pi's built-in tools the reviewer-only home keeps: reading only. */
export const HOME_READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/** The plugin's tools, by the prefix its tools are named with. */
export const PLUGIN_TOOL_PATTERN = "qcr_*";

/** The whole `--tools` allowlist of the reviewer-only home. */
export function reviewerToolAllowlist(): string[] {
  return [...HOME_READ_TOOLS, PLUGIN_TOOL_PATTERN, ...HOME_TOOL_NAMES];
}
