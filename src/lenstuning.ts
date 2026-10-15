// Per-lens tuning from the repo profile.
//
// `profile.toml` may carry one `[lenses.<pass>]` table per lens, five keys
// (and a sixth for the style lens alone):
//
//   [lenses.pass-security]
//   min_tier = "sol-high"      # the lowest tier the plan may run it at
//   effort = "high"            # low | medium | high — that lens's thinking only
//   max_severity = "P0"        # the lens's severity ceiling (raise or lower)
//   emphasis = "Auth is the product here; …"   # words for that lens
//
//   [lenses.pass-ui]
//   enabled = false            # remove the lens from the plan and the add list
//
//   [lenses.pass-style]
//   guide = "style-guide.md"   # a guide file in this profile's dir
//
// The resolved map (the whole `extends` chain merged, child-wins per key —
// src/profiles.ts `loadProfileLensTuning`) rides the `Config` as `cfg.lenses`,
// overlaid by `applyProfileTuning` AFTER config.toml and its preset are
// parsed: **the profile wins** over config.toml, the preset and the code
// defaults. Every consumer then reads one place:
//
//   * `min_tier` — plan time (src/dispatch.ts `buildPassPlan`): a FLOOR under
//     whatever tier the plan would otherwise choose, so plan rows, `raisable_to`,
//     the sweep rows and the add rule's variant all move with it. A floor never
//     lowers: a risk pass stays at `sol-high`, the validator stays at or above
//     its configured tier. A lens's floor never moves the validator (it is
//     not raised to match any lens).
//   * `effort` — build time, through the per-variant model hook
//     (`BuildAgentsOptions.models`): only that lens's `<pass>--<tier>` specs get
//     the new thinking suffix. `high` means the model's ceiling
//     (`[models] effort_max`), exactly as the global `[models] effort` does.
//   * `enabled` — `false` removes the lens from selection and from the addable
//     list, whatever selected it (the path core, a heuristic, a sub-lens
//     trigger, a `[review]` lever). A separate, profile-level subtraction:
//     heuristics stay ADD-only. `true` is the default and only matters for a
//     lens a `[review]` lever gates (sub-lenses, the sweep, the tests, quality
//     and style lenses) — there it switches that one lens on whatever the lever
//     says. It never plans an addable-only lens or anything else the
//     selector did not choose. `false` on `pass-validate` switches the
//     validator off: the round then posts the merged candidates
//     with no adversary in front of them, and nothing is doubted.
//   * `emphasis` and `max_severity` — compiled into addenda
//     (`lensTuningAddenda`) that wire.ts and the bench compose after the
//     profile's own pack, so the addendum registry stays the ONLY route into a
//     pass body (rule 6). The ceiling binds at the validator, which enforces
//     every other cap, and is also told to the lens itself.
//   * `guide` (`pass-style` only) — a style guide drafted into the
//     profile for a repo that writes none: a file path RELATIVE to the
//     profile's own directory (so it lives in the config home), read and
//     checked at load. Plan time: the style lens is planned on it only when
//     the repo's own guide (src/styleguide.ts) finds nothing — **a guide the
//     repo writes wins**. Build time: the text is compiled into an addendum
//     for `pass-style` and the validator, like `emphasis`, so it reaches the
//     session wherever the session runs. Style findings stay `nit` against
//     either guide unless `max_severity` raises the lens's ceiling.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ModelsConfig, ReviewEffort, ThinkingLevel } from "./config.js";
import { normalizeEffort, withThinking } from "./config.js";
import {
  passTierModels,
  sweepLightVariants,
  VALIDATE_PASS as VALIDATE,
  type PassAddendum,
} from "./include.js";
import type { Severity } from "./severity.js";
import { higherTier, PASS_TIER_ORDER, type PassTier } from "./types.js";

/** A style guide a profile points `pass-style` at. */
export interface ProfileStyleGuide {
  /** As `profile.toml` spells it — relative to the profile's directory. */
  file: string;
  /** Where it was read from. */
  path: string;
  text: string;
}

/** The keys of one `[lenses.<pass>]` table, after validation. */
export interface LensTuning {
  min_tier?: PassTier;
  effort?: Exclude<ReviewEffort, "">;
  enabled?: boolean;
  emphasis?: string;
  max_severity?: Severity;
  /** `pass-style` only. */
  guide?: ProfileStyleGuide;
}

/** Pass name → its resolved tuning. Empty ⇒ untuned (the shipped behaviour). */
export type LensTuningMap = Readonly<Record<string, LensTuning>>;

export const LENS_TUNING_KEYS = [
  "min_tier",
  "effort",
  "enabled",
  "emphasis",
  "max_severity",
  "guide",
] as const;

/** The one lens a profile may point at a guide. */
export const STYLE_LENS = "pass-style";

/** A drafted guide is a guide, not a manual: it is compiled into two built
 * bodies (the style lens and the validator). */
export const PROFILE_GUIDE_MAX_CHARS = 32_000;

const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2", "P3", "nit"];

/** An emphasis is a few sentences for one lens, not a second rulebook. */
export const EMPHASIS_MAX_CHARS = 2000;

/** The downgrade word the validator records when a profile ceiling caps a
 * candidate (src/findingsrecord.ts DOWNGRADE_WORDS). */
export const PROFILE_CAP_WORD = "profile-over-cap";

const EMPHASIS_ID_PREFIX = "lens-emphasis-";
const CEILING_ID_PREFIX = "lens-ceiling-";
const GUIDE_ID_PREFIX = "lens-guide-";

/** Ids the compiled tuning addenda take — a profile pack may not claim them. */
export const LENS_TUNING_ID_PREFIXES = [
  EMPHASIS_ID_PREFIX,
  CEILING_ID_PREFIX,
  GUIDE_ID_PREFIX,
] as const;

/** Read the guide a profile's `[lenses.pass-style] guide` names: a relative
 * path that stays inside the profile's directory (symlinks resolved), a
 * readable, non-empty file within the size cap. Anything else throws. */
function readProfileGuide(at: string, value: unknown, dir: string | undefined): ProfileStyleGuide {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${at} guide must be a file name in the profile's directory`);
  if (dir === undefined) throw new Error(`${at} guide needs the profile's directory to resolve`);
  const file = value.trim();
  if (isAbsolute(file) || file.split(/[\\/]/).includes(".."))
    throw new Error(
      `${at} guide ${JSON.stringify(file)} must be relative to the profile's directory, without '..'`,
    );
  const path = join(dir, file);
  let text: string;
  try {
    const real = realpathSync(path);
    const inside = relative(realpathSync(dir), real);
    if (inside === "" || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new Error("resolves outside the profile's directory");
    if (!statSync(real).isFile()) throw new Error("is not a file");
    text = readFileSync(real, "utf8");
  } catch (err) {
    throw new Error(
      `${at} guide ${JSON.stringify(file)}: cannot use ${path}: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }
  if (text.trim() === "") throw new Error(`${at} guide ${path} is empty`);
  if (text.length > PROFILE_GUIDE_MAX_CHARS)
    throw new Error(`${at} guide ${path} is over ${PROFILE_GUIDE_MAX_CHARS} characters`);
  return { file, path, text };
}

/**
 * Parse one profile's `[lenses]` table. `where` names the file in every
 * error; `known` is every pass the system knows (dispatch.ts ALL_PASSES);
 * `dir` is the profile's directory, which a `guide` resolves against.
 * Anything malformed throws — an unknown lens, an unknown key, a bad value,
 * giving the validator a ceiling, a guide on any lens but `pass-style` or one
 * that cannot be read: a profile that asked for something this cannot honour
 * must fail the boot, never review as if it had. Switching the validator off
 * IS honoured.
 */
export function parseLensTable(
  where: string,
  raw: unknown,
  known: readonly string[],
  dir?: string,
): Record<string, LensTuning> {
  const table = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!table(raw)) throw new Error(`${where} [lenses] must be a table of [lenses.<pass>] tables`);
  const out: Record<string, LensTuning> = {};
  for (const [lens, body] of Object.entries(raw)) {
    const at = `${where} [lenses.${lens}]`;
    if (!known.includes(lens)) {
      throw new Error(`${at} is not a known lens — one of: ${known.join(", ")}`);
    }
    if (!table(body)) throw new Error(`${at} must be a table`);
    const t: LensTuning = {};
    for (const [key, value] of Object.entries(body)) {
      switch (key) {
        case "min_tier":
          if (!(PASS_TIER_ORDER as readonly unknown[]).includes(value))
            throw new Error(`${at} min_tier must be one of ${PASS_TIER_ORDER.join(", ")}`);
          t.min_tier = value as PassTier;
          break;
        case "effort": {
          const effort = normalizeEffort(value);
          if (effort === null) throw new Error(`${at} effort must be "low", "medium" or "high"`);
          t.effort = effort;
          break;
        }
        case "enabled":
          if (typeof value !== "boolean") throw new Error(`${at} enabled must be true or false`);
          t.enabled = value;
          break;
        case "emphasis":
          if (typeof value !== "string" || value.trim() === "")
            throw new Error(`${at} emphasis must be a non-empty string`);
          if (value.length > EMPHASIS_MAX_CHARS)
            throw new Error(`${at} emphasis is over ${EMPHASIS_MAX_CHARS} characters`);
          t.emphasis = value.trim();
          break;
        case "max_severity":
          if (lens === VALIDATE)
            throw new Error(`${at} max_severity — the validator raises no findings to cap`);
          if (!(SEVERITIES as readonly unknown[]).includes(value))
            throw new Error(`${at} max_severity must be one of ${SEVERITIES.join(", ")}`);
          t.max_severity = value as Severity;
          break;
        case "guide":
          if (lens !== STYLE_LENS)
            throw new Error(`${at} guide — only [lenses.${STYLE_LENS}] judges against a guide`);
          t.guide = readProfileGuide(at, value, dir);
          break;
        default:
          throw new Error(`${at} unknown key "${key}" — allowed: ${LENS_TUNING_KEYS.join(", ")}`);
      }
    }
    out[lens] = t;
  }
  return out;
}

/** Merge a child profile's lens tables over its base's: per lens, per key,
 * the child wins (the profile chain's scalar rule). */
export function mergeLensTuning(
  base: Record<string, LensTuning>,
  child: Record<string, LensTuning>,
): Record<string, LensTuning> {
  const out: Record<string, LensTuning> = { ...base };
  for (const [lens, t] of Object.entries(child)) out[lens] = { ...out[lens], ...t };
  return out;
}

/** Is `lens` on? An explicit `enabled` wins; otherwise `lever` — the
 * `[review]` switch that gates this lens, or `true` for an ungated one. */
export function lensEnabled(
  lenses: LensTuningMap | undefined,
  lens: string,
  lever = true,
): boolean {
  return lenses?.[lens]?.enabled ?? lever;
}

/** `tier`, raised to the lens's `min_tier` when the profile sets one. */
export function flooredTier(
  lenses: LensTuningMap | undefined,
  lens: string,
  tier: PassTier,
): PassTier {
  const floor = lenses?.[lens]?.min_tier;
  return floor ? higherTier(tier, floor) : tier;
}

/**
 * The per-VARIANT model specs a lens's `effort` asks for, keyed
 * `<pass>--<tier>` — the `BuildAgentsOptions.models` hook. Every tier gets a
 * key (the build reads only the variants it writes); the spec is the tier's
 * own, already through the global `[models] effort`, with only its thinking
 * suffix replaced. Untuned lenses get no key, so their built bytes are
 * unchanged.
 */
export function lensModelOverrides(
  models: Pick<ModelsConfig, "tiers" | "effort_max">,
  lenses: LensTuningMap | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lens, t] of Object.entries(lenses ?? {})) {
    if (!t.effort) continue;
    const level: ThinkingLevel = t.effort === "high" ? models.effort_max : t.effort;
    for (const tier of PASS_TIER_ORDER)
      out[`${lens}--${tier}`] = withThinking(models.tiers[tier], level);
  }
  return out;
}

/**
 * The per-variant model map a PR round's agent build takes: the profile's
 * per-lens `effort` (`lensModelOverrides`), with `[models.pass_tiers]` pins
 * and `[models.pass_models]` overrides on top (`passTierModels`). The daemon,
 * the bench and the setup replay all build through this one recipe, so each
 * runs a lens at the same model.
 */
export function roundAgentModels(cfg: {
  models: Pick<ModelsConfig, "tiers" | "effort_max" | "pass_tiers" | "pass_models">;
  lenses?: LensTuningMap | undefined;
  review: { sweep_light_tier?: "" | PassTier };
}): Record<string, string> {
  return passTierModels(
    cfg.models.pass_tiers,
    cfg.models.tiers,
    lensModelOverrides(cfg.models, cfg.lenses),
    cfg.models.pass_models,
    sweepLightVariants(cfg.review, cfg.lenses),
    cfg.lenses,
  );
}

function ceilingText(lens: string, sev: Severity): string {
  const rule =
    sev === "P0"
      ? `\`${lens}\` findings may carry any severity: judge each at its own severity like any other lens's.`
      : `A \`${lens}\` finding may carry any severity up to \`${sev}\`; one arriving above \`${sev}\` is capped down to \`${sev}\` with the one-word downgrade reason \`${PROFILE_CAP_WORD}\` (axis: severity), then follows the ordinary posting map unchanged.`;
  return (
    `\n## Severity ceiling for \`${lens}\`: \`${sev}\` (this repo's profile)\n` +
    `This repo's profile sets the severity ceiling of the \`${lens}\` lens at \`${sev}\`. ` +
    `It REPLACES every other cap these instructions put on \`${lens}\`, higher or lower. ${rule}\n`
  );
}

function guideText(g: ProfileStyleGuide): string {
  return (
    `\n## This repo's profile style guide (\`${g.file}\`)\n` +
    `This repo's profile carries a style guide for \`${STYLE_LENS}\`, below, for when the repo writes none of its own. ` +
    `It is the standard ONLY in a round whose \`${STYLE_LENS}\` plan row names "this repo's profile style guide"; ` +
    `when that row names a guide the repo itself writes, the repo's guide is the only standard and this section does not apply. ` +
    `It is not a file in the repo: do not look for it at head — the guide is the text below, so "guide missing or unreadable at head, answer NONE" never applies to it. ` +
    `A \`${STYLE_LENS}\` finding against it quotes the rule verbatim and cites it as \`profile style guide ${g.file}\` in place of a repo file and line, ` +
    `and cites the CHANGED line that breaks it, exactly as for a repo guide. ` +
    `Validator: audit such a finding against this text as you would a repo guide — a rule it does not state is \`refuted\`, and so is a finding citing it in a round whose style row named the repo's own guide.\n\n` +
    `----- begin profile style guide -----\n${g.text.replace(/\n*$/, "\n")}----- end profile style guide -----\n`
  );
}

/**
 * The addenda a profile's `emphasis`, `max_severity` and `guide` compile
 * into, in a deterministic order (lens name; emphasis, ceiling, guide). An
 * emphasis binds its lens alone; a ceiling binds its lens (so it knows how
 * high it may go) and the validator (which enforces it); a guide binds the
 * style lens (its standard) and the validator (which audits against it).
 * Composed after the profile's own pack, so a ceiling is the last word on a
 * lens's cap.
 */
export function lensTuningAddenda(lenses: LensTuningMap | undefined): PassAddendum[] {
  const out: PassAddendum[] = [];
  for (const lens of Object.keys(lenses ?? {}).sort()) {
    const t = (lenses as LensTuningMap)[lens] as LensTuning;
    if (t.emphasis !== undefined) {
      out.push({
        id: `${EMPHASIS_ID_PREFIX}${lens}`,
        scope: [lens],
        text: `\n## What this repo asks of this lens (this repo's profile)\n${t.emphasis}\n`,
      });
    }
    if (t.max_severity !== undefined) {
      out.push({
        id: `${CEILING_ID_PREFIX}${lens}`,
        scope: [lens, VALIDATE],
        text: ceilingText(lens, t.max_severity),
      });
    }
    if (t.guide !== undefined) {
      out.push({
        id: `${GUIDE_ID_PREFIX}${lens}`,
        scope: [lens, VALIDATE],
        text: guideText(t.guide),
      });
    }
  }
  return out;
}

/** The config with the profile's resolved lens tuning overlaid — the profile
 * wins over config.toml, the preset and the defaults. */
export function applyProfileTuning<C extends { lenses?: LensTuningMap }>(
  cfg: C,
  lenses: LensTuningMap,
): C {
  return { ...cfg, lenses };
}
