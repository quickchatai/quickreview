// The scan agent build and the settings a scan runs with.
//
// A scan's leaves are the production lenses — `pass-scan` for stage 1, the
// validator when `[scan] validator` is on (the default: the scan validator is
// the skeptic, composed with the `mode: "scan"` `scan-skeptic-validate`
// addendum and run at the tier of the lens it judges, so every tier's variant
// is built), and stage 2's deep lenses (every suggestible lens the profile
// leaves on, at the tier its row names) — built by the one agent build
// (`packages/pi-plugin/src/include.ts buildAgents`) in `"scan"` mode:
//
//   * the scan-mode anchor addendum composes (`mode: "scan"` in PASS_ADDENDA)
//     — in this build and in no other: the daemon's, the bench's and the
//     replay's builds are `"pr"` builds and never carry it;
//   * `agents/scan/` joins `agents/` as a source, so `pass-scan` exists here
//     and nowhere else;
//   * every variant's tools are `SCAN_LEAF_TOOLS` — a scan leaf runs with no
//     extensions, so there is no bash guard to stand between it and a shell;
//   * a DEEP scan (`[scan] depth = "deep"`, or a stage-2 proposal made deep)
//     also composes the `depth: "deep"` addenda: `scan-deep-suggest` on
//     `pass-scan` (a deep lens named for every focus file) and `scan-deep-dig`
//     on every lens a scan may run (follow callers and siblings, the state ×
//     obligation table, what each early exit drops). A standard scan build is
//     byte-identical without them.
//
// Everything a PR build composes from the repo's profile composes here too
// (the pack, the per-lens emphasis/ceiling/guide, a lens's `effort`), so a
// scan reviews the way this repo's PR rounds do. `pass-scan` itself is tuned
// by `[scan] tier`/`effort`, config.toml's defaults under the profile's
// `[scan]` table — the profile wins.
//
// `agents/scan/` also holds `pass-sec-threat-model`, stage 0's lens: a
// read-only leaf like `pass-scan`, built at the `[scan] tier` alone, which
// drafts the threat model a security scan reads when nobody wrote one.
//
// The build lands in `<state home>/scan/agents/`, which the scan's case
// runner reads; it is rebuilt at every start, so a profile edit reaches the
// next run without anything else to remember.
import { join } from "node:path";
import {
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
  identityVars,
  type BuiltAgent,
} from "../include.js";
import {
  applyProfileTuning,
  effortSpec,
  lensModelOverrides,
  lensTuningAddenda,
} from "../lenstuning.js";
import { ALL_PASSES } from "../passes.js";
import type { CoreConfig } from "../reviewconfig.js";
import { BASE_TIER } from "../types.js";
import {
  applyProfileScan,
  applyProfileSecurity,
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileLensTuning,
  loadProfileScan,
  loadProfileSecurity,
  type ProfileLookup,
} from "../profiles.js";
import { SCAN_PASS } from "./scan.js";
import { THREAT_MODEL_PASS, type ScanSettings } from "./scanrun.js";

/** Where the scan build lands, relative to the state home. */
export const SCAN_AGENTS_DIR = "scan/agents";

/** The scan-only lens sources, relative to the app's root. */
export const SCAN_AGENTS_SRC = "agents/scan";

/** The config a scan runs with: `parsed` (a config.toml, or the shipped
 * defaults) with the profile's per-lens tuning, `[security]` (a
 * security-only profile switches every lens outside the family off; `fold`
 * reaches the skeptic) and `[scan]` overrides applied (the profile wins).
 * Throws on a bad profile — the caller reports it. */
export function scanConfigOf<C extends CoreConfig>(
  parsed: C,
  root: string,
  lookup: ProfileLookup,
): C {
  const profile = parsed.review.profile;
  const tuned = applyProfileTuning(parsed, loadProfileLensTuning(root, profile, lookup));
  // A security-only scan keeps what the named chain says, never what a
  // repository's .qcr/profile.toml switched back on (profiles.ts
  // `securityOnlyLenses`).
  const secured = applyProfileSecurity(
    tuned,
    loadProfileSecurity(root, profile, lookup),
    ALL_PASSES,
    loadProfileLensTuning(root, profile, { ...lookup, repoProfile: undefined }),
  );
  return applyProfileScan(secured, loadProfileScan(root, profile, lookup));
}

/** The settings a scan run takes from a resolved config, and the install
 * profile's threat model (profiles.ts `loadProfileThreatModel`; null =
 * none). */
export function scanSettings(
  cfg: CoreConfig,
  profileThreatModel: string | null = null,
): ScanSettings {
  return {
    scan: cfg.scan,
    // Stage 2: which deep lenses run, at which tiers and effort —
    // the same per-lens tuning the build composes.
    lenses: cfg.lenses,
    riskPasses: cfg.models.risk_passes,
    // The skeptic's security fold: what it could not settle is for a person.
    fold: cfg.security.fold,
    profileThreatModel,
  };
}

/** `pass-scan`'s model spec: the `[scan] tier`'s spec at `[scan] effort`
 * (`high` = the model's ceiling), through the same per-variant hook a
 * lens's `effort` uses. One variant — stage 1 runs at that tier alone. */
export function scanPassModels(cfg: Pick<CoreConfig, "models" | "scan">): Record<string, string> {
  return {
    [`${SCAN_PASS}--${cfg.scan.tier}`]: effortSpec(cfg.models, cfg.scan.tier, cfg.scan.effort),
  };
}

/** Build the scan agents into `outDir` — `buildAgents` in `"scan"` mode at
 * `cfg.scan.depth`, the profile's pack and tuning composed exactly as a PR
 * build composes them. */
export function buildScanAgents(
  root: string,
  outDir: string,
  cfg: CoreConfig,
  lookup: ProfileLookup,
): BuiltAgent[] {
  return buildAgents(join(root, "agents"), outDir, {
    root,
    mode: "scan",
    scanDepth: cfg.scan.depth,
    extraSrcDirs: [join(root, SCAN_AGENTS_SRC)],
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    // The skeptic runs at the tier of the lens it judges — stage 1's
    // `[scan] tier`, a stage-2 row's own — so every tier keeps a variant
    // (never `validate_tier`, never floored upward).
    validateTier: BASE_TIER,
    vars: identityVars(cfg),
    ecosystem: loadProfileEcosystem(root, cfg.review.profile, lookup),
    models: { ...lensModelOverrides(cfg.models, cfg.lenses), ...scanPassModels(cfg) },
    // Stage 1 runs `pass-scan--<[scan] tier>` and stage 0
    // `pass-sec-threat-model--<[scan] tier>`, and nothing else names either
    // (stage 2 rows refuse them), so no other tier's variant is built.
    onlyTiers: { [SCAN_PASS]: [cfg.scan.tier], [THREAT_MODEL_PASS]: [cfg.scan.tier] },
    addenda: [
      ...PASS_ADDENDA,
      ...configAddenda(cfg.review, cfg.security),
      ...loadProfileAddenda(root, cfg.review.profile, lookup),
      ...lensTuningAddenda(cfg.lenses),
    ],
  });
}
