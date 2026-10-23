// The lens and validator agents a one-shot round's session resolves, built from
// the shipped agents with the production addenda: the bench builds them into
// its project scope, `qcr review` into its run's private agent dir
// (src/hostroute.ts).
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CoreConfig } from "../reviewconfig.js";
import { buildAgents, configAddenda, identityVars, PASS_ADDENDA } from "../include.js";
import { lensTuningAddenda, roundAgentModels } from "../lenstuning.js";
import { postingPolicyAddenda } from "../postingpolicy.js";
import { loadProfileAddenda, loadProfileEcosystem, type ProfileLookup } from "../profiles.js";

/** Build the lens + validator agents into `<root>/.pi/agents` — the PROJECT
 * scope the subagents glue reads when QCR_SUBAGENT_SCOPE=project. The VM uses
 * the user scope (a symlink in its own pihome); here the user scope is the
 * companion's shared agent dir, whose `agents` belongs to the companion.
 * `out` overrides the dir: the `qcr review` route builds into its private agent
 * dir's `agents` (src/hostroute.ts) and runs with the user scope. */
export function buildBenchAgents(
  root: string,
  cfg: CoreConfig,
  out: string = join(root, ".pi", "agents"),
  /** A profile's replacements (src/profileoverrides.ts): `readFile` serves a
   * replaced agent or prompt, `lookup` adds the repo profile's layer. Absent:
   * the shipped files and the named profile alone, as always. */
  profile: { readFile?: (path: string) => string; lookup?: ProfileLookup } = {},
): number {
  // Empty it rather than remove it: in the sandbox it is a tmpfs MOUNTPOINT
  // (the root filesystem is read-only), and a mountpoint cannot be rmdir'd.
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
  const built = buildAgents(join(root, "agents"), out, {
    // The bench round runs without the memory extension (header: memory off).
    memory: false,
    root,
    ...(profile.readFile ? { readFile: profile.readFile } : {}),
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    validateTier: cfg.models.validate_tier,
    vars: identityVars(cfg),
    ecosystem: loadProfileEcosystem(root, cfg.review.profile, profile.lookup),
    models: roundAgentModels(cfg),
    addenda: [
      ...PASS_ADDENDA,
      ...configAddenda(cfg.review),
      ...loadProfileAddenda(root, cfg.review.profile, profile.lookup),
      ...lensTuningAddenda(cfg.lenses),
      // The profile's `[posting]` policy, compiled for the validator.
      ...postingPolicyAddenda(cfg.posting),
    ],
  });
  return built.length;
}
