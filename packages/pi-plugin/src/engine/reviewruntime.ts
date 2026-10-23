// The runtime a local review hosts its sessions on, as `[engine] runtime` and
// `[pi] lens_runtime` select it: the SDK runtime (reviewsdk.ts), with the
// engine's lens tools and, with `[pi] engine_wave`, the board the round starts
// the planned wave on. Each host route builds it with its own process facts:
// `qcr review` owns its process (a wedged turn exits it, diagnostics go to
// stderr); the pi plugin's /review runs inside the user's pi, owns nothing,
// and leaves a wedged turn to its own sessions' abort.
//
// The SDK host loads on the first session, not here: a preview, a refusal and
// an unchanged head never load the pi SDK.
import type { CoreConfig } from "../reviewconfig.js";
import { selectRuntime } from "./select.js";
import { LensWave, type EngineRoute, type EngineRouteRuntime } from "./lens/wave.js";
import type { ReviewSdkOptions, ReviewSdkRuntime } from "./reviewsdk.js";

/** What a route decides about the SDK host: everything but the lens route,
 * which the config decides. */
export type ReviewRuntimeOptions = Omit<ReviewSdkOptions, "engine" | "lens" | "extras">;

/** The review runtime, built lazily; `dispose` releases the host once one was
 * built. One runtime hosts one review at a time. */
export type LazyReviewRuntime = EngineRouteRuntime & { dispose(): Promise<void> };

export function lazyReviewRuntime(
  cfg: Pick<CoreConfig, "engine" | "pi">,
  options: ReviewRuntimeOptions = {},
): LazyReviewRuntime {
  const engine = cfg.pi.lens_runtime === "engine";
  let built: Promise<ReviewSdkRuntime> | undefined;
  const runtime = selectRuntime(cfg.engine.runtime, "review", () => {
    const wave = new LensWave();
    const load = (): Promise<ReviewSdkRuntime> =>
      (built ??= import("./reviewsdk.js").then((m) =>
        m.reviewSdkRuntime({
          ...options,
          ...(engine ? { engine: { wave, plannedWave: cfg.pi.engine_wave } } : {}),
        }),
      ));
    const engineLens: EngineRoute = {
      wave,
      runner: { run: async (request) => (await load()).engineLens!.runner.run(request) },
      plannedWave: cfg.pi.engine_wave,
    };
    return {
      create: async (spec) => (await load()).create(spec),
      resume: async (file, spec) => (await load()).resume(file, spec),
      // The round reads this before any session exists, so it is named here and
      // reaches the runner the host builds.
      ...(engine ? { engineLens } : {}),
    };
  }) as EngineRouteRuntime;
  return {
    ...runtime,
    dispose: async () => {
      const b = built;
      built = undefined;
      if (b !== undefined) await (await b).dispose();
    },
  };
}
