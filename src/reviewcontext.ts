// The review context the app's one-shot routes build (the bench, `qcr open`):
// the install's live config.toml, as the install locator finds it, and the
// profiles in the install's homes, handed to the core's `contextFrom`
// (src/engine/context.ts). Inside the bench image the located config is the
// copy bench.sh baked from the operator's own.
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config.js";
import type { Ecosystem } from "./ecosystem.js";
import { contextFrom, withProfile } from "./engine/context.js";
import { homeProfileLookup, locateConfig } from "./install.js";

/** The bench config: production config.toml with only the profile swapped. */
export function benchConfig(profile: string): Config {
  return withProfile(loadConfig(locateConfig().path), profile);
}

/** The review context for `profile` over production config.toml, with the
 * `--config` levers in `overrides` (src/engine/context.ts `contextFrom`). */
export function contextFor(
  root: string,
  profile: string,
  overrides = "",
  /** Where an override's notice goes (`applyConfigOverrides`). */
  warn?: (line: string) => void,
): { cfg: Config; ecosystem: Ecosystem } {
  const path = locateConfig().path;
  return contextFrom(
    root,
    { cfg: loadConfig(path), toml: readFileSync(path, "utf8") },
    profile,
    overrides,
    homeProfileLookup(),
    warn,
  );
}
