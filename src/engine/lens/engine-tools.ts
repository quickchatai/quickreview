// The lens tools of an engine route's main session: `lens` and `lens_wave` over
// one LensRunner and one LensWave, handed to the session as `customTools`
// (roundsdk.ts RoundLensTools). A route builds this once per round's main
// session. The planned wave is started by the engine through `launchWave` on the
// same `wave` and `runner`; the session's `lens_wave` joins it.
import { lensTools } from "../../../extensions/lens.js";
import type { RoundLensTools } from "../roundsdk.js";
import { createLensRunner, type LensRunConfig, type LensRunner } from "./runlens.js";
import { LENS_TOOL, LENS_WAVE_TOOL } from "./tool.js";
import { LensWave } from "./wave.js";

export interface EngineLensTools extends RoundLensTools {
  /** Starts a pass; the engine's wave and the session's `lens` run on it. */
  runner: LensRunner;
  /** The round's rows in flight. */
  wave: LensWave;
}

export function engineLensTools(config: LensRunConfig, wave = new LensWave()): EngineLensTools {
  const runner = createLensRunner(config);
  return {
    factories: [],
    customTools: lensTools({ runner, wave, env: config.env }),
    toolNames: [LENS_TOOL, LENS_WAVE_TOOL],
    runner,
    wave,
  };
}
