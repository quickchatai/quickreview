// Which runtime a route hosts its pi sessions on: `[engine] runtime` (or a
// route's own override). `sdk` is the only kind: the process runtime is
// retired. It needs a host the route builds itself (PiHost, auth, extension
// factories), so a route passes `sdk` only once it has one; a route that does
// not refuses the key rather than quietly running something else.

import type { EngineRuntimeKind, LensRuntimeKind } from "../reviewconfig.js";
import { ENGINE_RUNTIME_KINDS } from "../reviewconfig.js";
import type { Runtime } from "./port.js";

/** Read a runtime kind. Throws on anything but `sdk`. */
export function parseRuntimeKind(v: string): EngineRuntimeKind {
  if (!(ENGINE_RUNTIME_KINDS as readonly string[]).includes(v))
    throw new Error(
      `runtime must be ${ENGINE_RUNTIME_KINDS.join(" | ")} (got ${JSON.stringify(v)})`,
    );
  return v as EngineRuntimeKind;
}

/** `[pi] lens_runtime = engine` (the only kind) needs the engine's lens tool and
 * discovery wave, which a route passes in as `engine` once it has them; a route
 * without them refuses the key, not ignores it. */
export function checkLensRuntime(kind: LensRuntimeKind, route: string, engine = false): void {
  if (kind === "engine" && !engine)
    throw new Error(`[pi] lens_runtime = engine is not available on the ${route} route yet`);
}

/**
 * The runtime to inject into a route.
 *
 * @param route  names the route in the refusal ("review", "bench", "scan")
 * @param sdk    builds the route's SDK runtime; absent while the route has none
 */
export function selectRuntime(
  kind: EngineRuntimeKind,
  route: string,
  sdk?: () => Runtime,
): Runtime {
  void kind;
  if (sdk === undefined)
    throw new Error(`[engine] runtime = sdk is not available on the ${route} route yet`);
  return sdk();
}
