// The scan's config, as the app reads it: the live config.toml (the install
// locator's answer), parsed whole, then the scan's own build and settings
// (scanagents.ts) over it.
import { readFileSync } from "node:fs";
import { parseConfig, type Config } from "../config.js";
import { homeProfileLookup, locateConfig } from "../install.js";
import type { BuiltAgent } from "@quickchatai/pi-quickreview/src/include.js";
import type { ProfileLookup } from "@quickchatai/pi-quickreview/src/profiles.js";
import type { Refusal } from "./engine.js";
import {
  buildScanAgents as buildAgentsOver,
  scanConfigOf,
} from "@quickchatai/pi-quickreview/src/scan/scanagents.js";

export {
  SCAN_AGENTS_DIR,
  SCAN_AGENTS_SRC,
  scanConfigOf,
  scanPassModels,
  scanSettings,
} from "@quickchatai/pi-quickreview/src/scan/scanagents.js";

/** The config a scan runs with: config.toml parsed, the profile's per-lens
 * tuning and `[scan]` overrides applied (the profile wins). Throws on a bad
 * config or profile — the caller reports it. */
export function scanConfig(
  root: string,
  toml: string,
  lookup: ProfileLookup = homeProfileLookup(),
): Config {
  return scanConfigOf(parseConfig(toml), root, lookup);
}

/** The live config (the install locator's answer), as `scanConfig` reads
 * it — or why it cannot be read. Never `loadConfig`: that also demands the
 * Slack token files, which the companion does not mount. */
export function loadScanConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; cfg: Config } | Refusal {
  let path: string;
  try {
    path = locateConfig({ env }).path;
  } catch (err) {
    return { ok: false, errors: [`no live config: ${String(err)}`] };
  }
  let toml: string;
  try {
    toml = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, errors: [`the live config ${path} cannot be read: ${String(err)}`] };
  }
  try {
    return { ok: true, cfg: scanConfig(root, toml, homeProfileLookup(env)) };
  } catch (err) {
    return {
      ok: false,
      errors: [
        `the live config or its profile is invalid: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

/** Build the scan agents into `outDir` (scanagents.ts `buildScanAgents`),
 * the profile looked up in this install's homes unless told otherwise. */
export function buildScanAgents(
  root: string,
  outDir: string,
  cfg: Config,
  lookup: ProfileLookup = homeProfileLookup(),
): BuiltAgent[] {
  return buildAgentsOver(root, outDir, cfg, lookup);
}
