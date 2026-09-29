// The PR replay's two SIDES: which profile each one reviews with,
// resolved the way the daemon resolves its own at boot, and each built into
// its own agent set.
//
//   * NEW — the profile setup works on (the interview's, else the one the
//     live config names), as it is on disk now; or one named outright.
//   * OLD — by default the same profile as it stood before setup's LAST write
//     to it (baselines.ts): the recorded files put back over a copy of the
//     config home's `profiles/` in the state home, and resolved from there.
//     Or an earlier write by its id, another profile (`profile:<name>`), or
//     `none` — the reviewer as shipped, with no profile at all.
//
// Each side's config is the live `config.toml` under that side's profile (the
// profile wins, as in the daemon), and its build is `buildAgents` in `"pr"`
// mode — the round build wire.ts makes, composed from the same addenda (the
// registry, the config's, the profile's pack and its per-lens tuning) — with
// read-only leaves (`readOnlyLeaves`): the companion's case runner runs them
// with no extensions, so no bash guard and no memory tool exists there. What
// the daemon's build adds and a replay leaves out is the same-day feedback
// addendum (it is not the profile's).
//
// Builds land in `<state home>/replay/agents/<side>/`, the old side's config
// home in `<state home>/replay/home/old/`; both are rebuilt on every preview
// and start, so a replay always reads the profiles as they are.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig, type Config } from "../config.js";
import { ecosystemFor, type Ecosystem } from "../ecosystem.js";
import type { HeuristicsExtension } from "../heuristics.js";
import { PASS_ADDENDA, buildAgents, configAddenda, identityVars } from "../include.js";
import { assertPathSegment, configHome, locateConfig, PROFILES_DIR, type InstallEnv } from "../install.js";
import { applyProfileTuning, lensModelOverrides, lensTuningAddenda } from "../lenstuning.js";
import {
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  loadProfileLensTuning,
  type ProfileLookup,
} from "../profiles.js";
import { latestBaseline, readBaselines, type ProfileBaseline } from "./baselines.js";
import type { Refusal, StateFs } from "./engine.js";
import { checkProfile } from "./profile.js";
import type { SideName } from "./replay.js";
import { profileStatus } from "./tuning.js";

/** Where each side's agents are built, relative to the state home. */
export const REPLAY_AGENTS_DIR = "replay/agents";
/** Where the old side's config home is put back together. */
export const REPLAY_HOME_DIR = "replay/home/old";

/** Which profiles to compare. `old`: a baseline id, `profile:<name>`, or
 * `none`; null = the profile before setup's last write to the new one. */
export interface SideRequest {
  old: string | null;
  new_profile: string | null;
}

/** One side, resolved and built. */
export interface ReplaySide {
  name: SideName;
  /** The profile it reviews with ("" = none: the reviewer as shipped). */
  profile: string;
  /** Where the profile comes from, for the operator. */
  basis: string;
  /** The baseline it was put back from, when it was. */
  baseline: string | null;
  cfg: Config;
  ecosystem: Ecosystem;
  heuristics: HeuristicsExtension;
  agentsDir: string;
  /** The built agent file, or null when this build has no such agent. */
  agentText(agent: string): string | null;
}

export interface SidesDeps {
  /** The app checkout (the lens sources and the generic example profiles). */
  root: string;
  /** The install environment: where the live config and its config home are. */
  env: InstallEnv;
  /** The state home: absolute, and as the setup port. */
  stateRoot: string;
  state: StateFs;
  clock: () => Date;
}

const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A side's profile before it is resolved: which one, from which config home. */
interface SideSource {
  profile: string;
  env: InstallEnv;
  basis: string;
  baseline: string | null;
}

/**
 * Resolve and build both sides of a replay — or say why not: no live config,
 * no profile to compare, no recorded write to compare against, a side that
 * would not load (the daemon's own check), a build that failed.
 */
export function replaySides(deps: SidesDeps, req: SideRequest): { ok: true; sides: Record<SideName, ReplaySide> } | Refusal {
  let toml: string;
  let parsed: Config;
  try {
    const path = locateConfig({ env: deps.env }).path;
    toml = readFileSync(path, "utf8");
    parsed = parseConfig(toml);
  } catch (err) {
    return { ok: false, errors: [`the live config cannot be read: ${clean(err)}`] };
  }

  const home = { root: deps.root, env: deps.env };
  let newProfile = (req.new_profile ?? "").trim();
  if (newProfile === "") {
    const status = profileStatus({ state: deps.state, profiles: home, memory: null, clock: deps.clock });
    newProfile = "ok" in status ? "" : (status.profile ?? "");
  }
  if (newProfile === "") {
    return {
      ok: false,
      errors: ["no profile to replay: setup has written none and the live config names none — finish the interview's write, or pass new_profile"],
    };
  }
  const newSource: SideSource = { profile: newProfile, env: deps.env, basis: `profile "${newProfile}" as it is now`, baseline: null };

  const old = oldSource(deps, req.old, newProfile);
  if (!old.ok) return old;

  const sides = {} as Record<SideName, ReplaySide>;
  for (const [name, src] of [["old", old.source], ["new", newSource]] as const) {
    if (src.profile !== "") {
      const check = checkProfile({ root: deps.root, env: src.env }, src.profile);
      if (!check.ok) return { ok: false, errors: [`the ${name} side (${src.basis}) would not load:`, ...check.errors] };
    }
    try {
      sides[name] = buildSide(deps, name, src, parsed);
    } catch (err) {
      return { ok: false, errors: [`the ${name} side (${src.basis}) could not be built: ${clean(err)}`] };
    }
  }
  return { ok: true, sides };
}

/** What `old` names, as a side source — putting a baseline back together
 * in the state home when it names one. */
function oldSource(
  deps: SidesDeps,
  raw: string | null,
  newProfile: string,
): { ok: true; source: SideSource } | Refusal {
  const asked = (raw ?? "").trim();
  if (asked === "none") return { ok: true, source: { profile: "", env: deps.env, basis: "no profile — the reviewer as shipped", baseline: null } };
  if (asked.startsWith("profile:")) {
    const name = asked.slice("profile:".length).trim();
    try {
      assertPathSegment("profile", name);
    } catch (err) {
      return { ok: false, errors: [clean(err)] };
    }
    return { ok: true, source: { profile: name, env: deps.env, basis: `profile "${name}" as it is now`, baseline: null } };
  }
  const read = readBaselines(deps.state);
  if (read.state !== "ok") return { ok: false, errors: [read.error] };
  const known = read.baselines.map((b) => `${b.id} (${b.profile}, ${b.taken_at})`);
  const b = asked === "" ? latestBaseline(read.baselines, newProfile) : (read.baselines.find((x) => x.id === asked) ?? null);
  if (b === null) {
    return {
      ok: false,
      errors: [
        asked === ""
          ? `no write to profile "${newProfile}" was recorded, so there is no "before" to replay against`
          : `no recorded write ${JSON.stringify(asked)}`,
        `pass old: a recorded write's id${known.length ? ` (${known.join("; ")})` : " (none recorded yet)"}, "profile:<name>" for another profile, or "none" for the reviewer as shipped`,
      ],
    };
  }
  return restoreBaseline(deps, b);
}

/** A copy of the config home's `profiles/` with baseline `b` put back, in
 * the state home — the profiles as they read before that write. */
function restoreBaseline(deps: SidesDeps, b: ProfileBaseline): { ok: true; source: SideSource } | Refusal {
  const out = join(deps.stateRoot, REPLAY_HOME_DIR);
  try {
    assertPathSegment("profile", b.profile);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const real = join(configHome(deps.env), PROFILES_DIR);
    if (existsSync(real)) cpSync(real, join(out, PROFILES_DIR), { recursive: true });
    const dir = join(out, PROFILES_DIR, b.profile);
    if (!b.existed) rmSync(dir, { recursive: true, force: true });
    else {
      for (const [rel, text] of Object.entries(b.files)) {
        const full = join(dir, assertPathSegment("profile file", rel));
        if (text === null) rmSync(full, { force: true });
        else {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, text);
        }
      }
    }
  } catch (err) {
    return { ok: false, errors: [`the profile before write ${b.id} could not be put back together: ${clean(err)}`] };
  }
  const env: InstallEnv = { ...deps.env, QCR_CONFIG_HOME: out };
  if (b.existed) {
    return { ok: true, source: { profile: b.profile, env, basis: `profile "${b.profile}" before write ${b.id}`, baseline: b.id } };
  }
  // The write CREATED the profile: before it, PR rounds used whatever the
  // live config named then.
  const then = b.config_named;
  if (then === null) {
    return { ok: false, errors: [`before write ${b.id} the live config could not be read, so what reviewed then is unknown — pass old explicitly`] };
  }
  if (then === b.profile) {
    return {
      ok: false,
      errors: [`before write ${b.id} the live config already named "${b.profile}", which did not exist yet — pass old explicitly ("none", or "profile:<name>")`],
    };
  }
  return {
    ok: true,
    source: {
      profile: then,
      env,
      basis: then === "" ? `no profile (before write ${b.id} created "${b.profile}")` : `profile "${then}" (the live config's, before write ${b.id} created "${b.profile}")`,
      baseline: b.id,
    },
  };
}

/** One side's config and build: the live config under the side's profile,
 * composed the way wire.ts composes a round's build. */
function buildSide(deps: SidesDeps, name: SideName, src: SideSource, parsed: Config): ReplaySide {
  const lookup: ProfileLookup = { env: src.env };
  const base = structuredClone(parsed);
  base.review = { ...base.review, profile: src.profile };
  const cfg = applyProfileTuning(base, loadProfileLensTuning(deps.root, src.profile, lookup));
  const ecosystemName = loadProfileEcosystem(deps.root, src.profile, lookup);
  const heuristics = loadProfileHeuristics(deps.root, src.profile, lookup);
  const outDir = join(deps.stateRoot, REPLAY_AGENTS_DIR, name);
  buildAgents(join(deps.root, "agents"), outDir, {
    root: deps.root,
    mode: "pr",
    readOnlyLeaves: true,
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    validateTier: cfg.models.validate_tier,
    vars: identityVars(cfg),
    ecosystem: ecosystemName,
    models: lensModelOverrides(cfg.models, cfg.lenses),
    addenda: [
      ...PASS_ADDENDA,
      ...configAddenda(cfg.review),
      ...loadProfileAddenda(deps.root, src.profile, lookup),
      ...lensTuningAddenda(cfg.lenses),
    ],
  });
  return {
    name,
    profile: src.profile,
    basis: src.basis,
    baseline: src.baseline,
    cfg,
    ecosystem: ecosystemFor(ecosystemName),
    heuristics,
    agentsDir: outDir,
    agentText: (agent) => {
      if (!/^[a-z][a-z0-9-]*$/.test(agent)) return null;
      try {
        return readFileSync(join(outDir, `${agent}.md`), "utf8");
      } catch {
        return null;
      }
    },
  };
}

