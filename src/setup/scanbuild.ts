// The scan's config, as the app reads it: the live config.toml (the install
// locator's answer), parsed whole, then the scan's own build and settings
// (scanagents.ts) over it.
//
// `qcr scan --model` names the whole scan's model for one run. The verb puts
// it in the env it assembles under (`SCAN_MODEL_ENV`), and the config read
// here then pins nothing below it: every tier and lens the file pins to a
// model of its own loses that model and keeps its level (`stripPins`), so
// each built agent names no model and runs on the scan's route.
import { readFileSync } from "node:fs";
import { parseConfig, type Config } from "../config.js";
import { oneShotConfigFile } from "../homes.js";
import { homeProfileLookup } from "../install.js";
import type { BuiltAgent } from "@quickchatai/pi-quickreview/src/include.js";
import type { ProfileLookup } from "@quickchatai/pi-quickreview/src/profiles.js";
import { stripPins } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
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

/** Set by `qcr scan` (src/scancli.ts) in the env it assembles a scan under,
 * to the `--model` of the run; never read from a person's shell, which the
 * verb overwrites. */
export const SCAN_MODEL_ENV = "QCR_SCAN_MODEL";

/** The live config (the install locator's answer), as `scanConfig` reads
 * it — or why it cannot be read. Under a `--model` (`SCAN_MODEL_ENV`) no tier
 * and no lens keeps a model of its own, and `replaced` counts the ones that
 * had one. Never `loadConfig`: that also demands the
 * Slack token files, which the companion does not mount. Zero-config, by
 * the one-shot review's rule (homes.ts `oneShotConfigFile`): when the
 * install's config home holds no config, the shipped defaults
 * (`<root>/config.example.toml`) stand in — a fresh npm install scans as it
 * reviews. A `$QCR_CONFIG` naming a missing file, a config stranded in the
 * checkout, and a config that does not parse still refuse. */
export function loadScanConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; cfg: Config; replaced?: number } | Refusal {
  let path: string;
  try {
    path = oneShotConfigFile({ root, env }).file;
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : `no live config: ${String(err)}`],
    };
  }
  let toml: string;
  try {
    toml = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, errors: [`the live config ${path} cannot be read: ${String(err)}`] };
  }
  try {
    const cfg = scanConfig(root, toml, homeProfileLookup(env));
    if ((env[SCAN_MODEL_ENV] ?? "").trim() === "") return { ok: true, cfg };
    const stripped = stripPins(cfg);
    return { ok: true, cfg: stripped.cfg, replaced: stripped.replaced };
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
