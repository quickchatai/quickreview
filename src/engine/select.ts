// Which runtime a route hosts its pi sessions on: `[engine] runtime` (or a
// route's own override, `qcr-bench --runtime`). `sdk` is the default (P7.12), and
// `[pi] lens_runtime` / `engine_wave` follow it: engine lenses with the planned
// wave on `sdk`, native lenses and no wave on `proc` (src/config.ts
// lensDefaultsFor).
//
// `proc` selects nothing: every route already falls back to procRuntime over
// its own pi binary, so a proc run stays byte-identical to what it was before
// the key existed (procRuntime is the fallback until it is retired). `sdk` needs
// a host the route builds itself (PiHost, auth, extension factories), so a
// route passes `sdk` only once it has one; a route that does not refuses the
// key rather than quietly running on proc.

import type { EngineRuntimeKind, LensRuntimeKind } from "../config.js";
import { ENGINE_RUNTIME_KINDS } from "../config.js";
import type { Runtime } from "./port.js";

/** Read a `--runtime` value. Throws on anything but `proc` or `sdk`. */
export function parseRuntimeKind(v: string): EngineRuntimeKind {
  if (!(ENGINE_RUNTIME_KINDS as readonly string[]).includes(v))
    throw new Error(
      `--runtime must be ${ENGINE_RUNTIME_KINDS.join(" | ")} (got ${JSON.stringify(v)})`,
    );
  return v as EngineRuntimeKind;
}

/** `[pi] lens_runtime`: `engine` (the default on the SDK runtime) needs the
 * engine's lens tool and discovery wave, which a route passes in as `engine`
 * once it has them; a route without them refuses the key, not ignores it. */
export function checkLensRuntime(kind: LensRuntimeKind, route: string, engine = false): void {
  if (kind === "engine" && !engine)
    throw new Error(
      `[pi] lens_runtime = engine is not available on the ${route} route yet: set it to native`,
    );
}

/** `lens_runtime = engine` is the SDK runtime's: on proc the lens tool is pi's own
 * subagent and the key is ignored, so an arm that sets only it would run (and be
 * fingerprinted) as the proc baseline. Refused rather than ignored. */
export function checkLensNeedsSdk(lens: LensRuntimeKind, runtime: EngineRuntimeKind): void {
  if (lens === "engine" && runtime !== "sdk")
    throw new Error(
      "[pi] lens_runtime = engine needs [engine] runtime = sdk (the runtime is proc): a proc run also sets pi.lens_runtime = native",
    );
}

/**
 * The runtime to inject into a route, or undefined for "the route's own
 * process runtime".
 *
 * @param route  names the route in the refusal ("review", "bench", "scan")
 * @param sdk    builds the route's SDK runtime; absent while the route has none
 */
export function selectRuntime(
  kind: EngineRuntimeKind,
  route: string,
  sdk?: () => Runtime,
): Runtime | undefined {
  if (kind === "proc") return undefined;
  if (sdk === undefined)
    throw new Error(
      `[engine] runtime = sdk is not available on the ${route} route yet: set it to proc`,
    );
  return sdk();
}
