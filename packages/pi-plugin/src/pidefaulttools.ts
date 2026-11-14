// pi's own default tool set, in a module with no imports and outside
// engine/: the agent build (include.ts), which the daemon reaches, writes it
// onto a line it creates without reaching the engine or the pi SDK, and the
// SDK host (engine/pisdk.ts) gives it to a session whose spec names no tools.

/** pi's own default tool set at the pin (DEFAULT_TOOL_NAMES). Canary 5 holds it. */
export const DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];
