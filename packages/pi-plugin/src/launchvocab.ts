// The names a round prompt uses for the tools that launch lenses (owner ruling
// D3). The tmux bot's session launches through pi's `subagent` and the glue's
// `launch_plan`; an engine route's main session has our `lens` and `lens_wave`
// (packages/pi-plugin/src/engine/lens/tool.ts), and so does a bot worker's (P8.14): the daemon's
// order builder writes the host's names (`SessionHooks.lensRuntime`), and the
// bot's renderer refuses an order written for the other host. A round order says
// which it was written for (`lens_runtime`), and every launch block of the round
// templates, the pass-plan table and the task-file note renders its names from
// here, so one order never names both pairs.
//
// Native is the absence of the field: an order a native route builds carries no
// `lens_runtime`, and renders byte-identically to before the engine tools
// existed (tests/golden-prompts.test.ts, tests/launch-vocab.test.ts).
import { LENS_TOOL, LENS_WAVE_TOOL } from "./lensresult.js";
import type { RoundOrder, SessionHooks } from "./types.js";

export interface LaunchVocab {
  /** The tool that launches one pass or several at once: `{agent, task}` or `tasks:[…]`. */
  lens: string;
  /** The tool that launches the planned rows from the task directory. */
  wave: string;
  /** The pass-plan table's column naming the agent a row launches as. */
  lensToCall: string;
}

export const NATIVE_VOCAB: LaunchVocab = {
  lens: "subagent",
  wave: "launch_plan",
  lensToCall: "subagent to call",
};

export const ENGINE_VOCAB: LaunchVocab = {
  lens: LENS_TOOL,
  wave: LENS_WAVE_TOOL,
  lensToCall: "lens to call",
};

/** The vocabulary an order's prompt is written in. */
export function launchVocab(order: Pick<RoundOrder, "lens_runtime">): LaunchVocab {
  return order.lens_runtime === "engine" ? ENGINE_VOCAB : NATIVE_VOCAB;
}

/**
 * The tmux bot's prompt renderer is bound to the native vocabulary: its
 * sessions carried `subagent` and `launch_plan` (the glue is retired, P9.4) and
 * not the engine tools, so an order written for the engine would tell the
 * session to call tools it does not have, and the round would end with no
 * verdict. Throws on such an order.
 */
export function assertNativeOrder(order: Pick<RoundOrder, "lens_runtime">): void {
  if (order.lens_runtime === "engine")
    throw new Error(
      "the tmux host renders native round prompts only: this order was built for [pi] lens_runtime = engine",
    );
}

/**
 * The bot's prompt renderer is bound to its host's vocabulary: an order written
 * for the other pair of tools would tell the session to call tools it does not
 * have, and the round would end with no verdict. The tmux host refuses an engine
 * order, the worker host a native one. Throws on a mismatch.
 */
export function assertOrderFitsHost(
  host: Pick<SessionHooks, "lensRuntime">,
  order: Pick<RoundOrder, "lens_runtime">,
): void {
  if (host.lensRuntime === "engine") {
    if (order.lens_runtime !== "engine")
      throw new Error(
        "the worker host renders engine round prompts only: this order names subagent and launch_plan, which a worker's session does not have",
      );
    return;
  }
  assertNativeOrder(order);
}

/** The order field an engine route sets from its config: `lens_runtime` is
 * written only for `engine`, so a native order carries no key at all. */
export function lensRuntimeOf(cfg: {
  pi: { lens_runtime: "native" | "engine" };
}): Pick<RoundOrder, "lens_runtime"> {
  return cfg.pi.lens_runtime === "engine" ? { lens_runtime: "engine" } : {};
}
