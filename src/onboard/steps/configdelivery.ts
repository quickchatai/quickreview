import type { CheckResult, StepContext } from "../engine.js";
import { stackTransportFor, type TransportOptions } from "./transport.js";

/** Deliver a config edit through the existing topology transport; failures
 * keep the caller's persisted restart obligation outstanding. */
export async function deliverConfigChange(
  ctx: StepContext,
  options: TransportOptions | undefined,
  owed: boolean,
  stepId: string,
): Promise<{ restartOwed: boolean; checks: CheckResult[] }> {
  if (!owed) return { restartOwed: false, checks: [] };
  const retry = `run the ${stepId} step again`;
  try {
    const transport = stackTransportFor(ctx, options);
    const state = await transport.daemonState();
    if (state.state === "unknown")
      return {
        restartOwed: true,
        checks: [
          {
            name: "daemon-restart",
            ok: false,
            detail: `config is on disk but its delivery is unknown (${state.detail}); restore host access and ${retry}`,
          },
        ],
      };
    const restarted = await transport.restart(
      (line) => ctx.adapters.log?.(line),
      state.state === "running",
    );
    return { restartOwed: !restarted.ok, checks: [restarted] };
  } catch (err) {
    return {
      restartOwed: true,
      checks: [
        {
          name: "daemon-restart",
          ok: false,
          detail: `config reload failed (${err instanceof Error ? err.message : "unknown error"}); ${retry}`,
        },
      ],
    };
  }
}
