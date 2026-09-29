// The SCAN AGENT BUILD and the settings a scan runs with.
//
// A scan's leaves are the production lenses — `pass-scan` for stage 1, the
// validator when `[scan] validator` is on, and stage 2's deep lenses (:
// every suggestible lens the profile leaves on, at the tier its row names) —
// built by the ONE agent build (`src/include.ts buildAgents`) in
// `"scan"` mode:
//
//   * the scan-mode anchor addendum composes (`mode: "scan"` in PASS_ADDENDA)
//     — in this build and in no other: the daemon's, the bench's and the
//     replay's builds are `"pr"` builds and never carry it;
//   * `agents/scan/` joins `agents/` as a source, so `pass-scan` exists here
//     and nowhere else;
//   * every variant's tools are `SCAN_LEAF_TOOLS` — a scan leaf runs with no
//     extensions, so there is no bash guard to stand between it and a shell.
//
// Everything a PR build composes from the repo's profile composes here too
// (the pack, the per-lens emphasis/ceiling/guide, a lens's `effort`), so a
// scan reviews the way this repo's PR rounds do. `pass-scan` itself is tuned
// by `[scan] tier`/`effort`, config.toml's defaults under the profile's
// `[scan]` table — the profile wins.
//
// The build lands in `<state home>/scan/agents/`, which the scan's case
// runner reads; it is rebuilt at every start, so a profile edit reaches the
// next run without anything else to remember.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, withThinking, type Config } from "../config.js";
import { locateConfig } from "../install.js";
import { PASS_ADDENDA, buildAgents, configAddenda, identityVars, VALIDATE_PASS, type BuiltAgent } from "../include.js";
import { flooredTier, lensModelOverrides, lensTuningAddenda, applyProfileTuning } from "../lenstuning.js";
import {
  applyProfileScan,
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileLensTuning,
  loadProfileScan,
  type ProfileLookup,
} from "../profiles.js";
import type { Refusal } from "./engine.js";
import { SCAN_PASS } from "./scan.js";
import type { ScanSettings } from "./scanrun.js";

/** Where the scan build lands, relative to the state home. */
export const SCAN_AGENTS_DIR = "scan/agents";

/** The scan-only lens sources, relative to the app's root. */
export const SCAN_AGENTS_SRC = "agents/scan";

/** The config a scan runs with: config.toml parsed, the profile's per-lens
 * tuning and `[scan]` overrides applied (the profile wins). Throws on a bad
 * config or profile — the caller reports it. */
export function scanConfig(root: string, toml: string, lookup: ProfileLookup = {}): Config {
  const parsed = parseConfig(toml);
  const profile = parsed.review.profile;
  const tuned = applyProfileTuning(parsed, loadProfileLensTuning(root, profile, lookup));
  return applyProfileScan(tuned, loadProfileScan(root, profile, lookup));
}

/** The live config (the install locator's answer), as `scanConfig` reads
 * it — or why it cannot be read. Never `loadConfig`: that also demands the
 * Slack token files, which the companion does not mount. */
export function loadScanConfig(root: string, env: NodeJS.ProcessEnv = process.env): { ok: true; cfg: Config } | Refusal {
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
    return { ok: true, cfg: scanConfig(root, toml, { env }) };
  } catch (err) {
    return { ok: false, errors: [`the live config or its profile is invalid: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** The settings a scan run takes from a resolved config. */
export function scanSettings(cfg: Config): ScanSettings {
  return {
    scan: cfg.scan,
    validateTier: flooredTier(cfg.lenses, VALIDATE_PASS, cfg.models.validate_tier),
    // Stage 2: which deep lenses run, at which tiers and effort —
    // the same per-lens tuning the build composes.
    lenses: cfg.lenses,
    riskPasses: cfg.models.risk_passes,
  };
}

/** `pass-scan`'s model spec: the `[scan] tier`'s spec at `[scan] effort`
 * (`high` = the model's ceiling), through the same per-variant hook a
 * lens's `effort` uses. One variant — stage 1 runs at that tier alone. */
export function scanPassModels(cfg: Pick<Config, "models" | "scan">): Record<string, string> {
  const level = cfg.scan.effort === "high" ? cfg.models.effort_max : cfg.scan.effort;
  return { [`${SCAN_PASS}--${cfg.scan.tier}`]: withThinking(cfg.models.tiers[cfg.scan.tier], level) };
}

/** Build the scan agents into `outDir` — `buildAgents` in `"scan"` mode, the
 * profile's pack and tuning composed exactly as a PR build composes them. */
export function buildScanAgents(root: string, outDir: string, cfg: Config, lookup: ProfileLookup = {}): BuiltAgent[] {
  return buildAgents(join(root, "agents"), outDir, {
    root,
    mode: "scan",
    extraSrcDirs: [join(root, SCAN_AGENTS_SRC)],
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    validateTier: cfg.models.validate_tier,
    vars: identityVars(cfg),
    ecosystem: loadProfileEcosystem(root, cfg.review.profile, lookup),
    models: { ...lensModelOverrides(cfg.models, cfg.lenses), ...scanPassModels(cfg) },
    // Stage 1 runs `pass-scan--<[scan] tier>` and nothing else names it
    // (stage 2 rows refuse it), so no other tier's variant is built.
    onlyTiers: { [SCAN_PASS]: [cfg.scan.tier] },
    addenda: [
      ...PASS_ADDENDA,
      ...configAddenda(cfg.review),
      ...loadProfileAddenda(root, cfg.review.profile, lookup),
      ...lensTuningAddenda(cfg.lenses),
    ],
  });
}
