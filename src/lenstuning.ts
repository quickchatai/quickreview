// Per-lens tuning from the repo profile.
//
// `profile.toml` may carry one `[lenses.<pass>]` table per lens, five keys:
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
//     its configured tier. A lens's floor never moves the validator (:
//     it is not raised to match any lens).
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
//     says. It never plans an addable-only lens or anything
//     else the selector did not choose. `false` on `pass-validate` switches
//     the validator off: the round then posts the merged candidates
//     with no adversary in front of them, and nothing is doubted.
//   * `emphasis` and `max_severity` — compiled into addenda
//     (`lensTuningAddenda`) that wire.ts and the bench compose after the
//     profile's own pack, so the addendum registry stays the ONLY route into a
//     pass body (rule 6). The ceiling binds at the validator, which enforces
//     every other cap, and is also told to the lens itself.
import type { ModelsConfig, ReviewEffort, ThinkingLevel } from "./config.js";
import { withThinking } from "./config.js";
import { VALIDATE_PASS as VALIDATE, type PassAddendum } from "./include.js";
import type { Severity } from "./severity.js";
import { higherTier, PASS_TIER_ORDER, type PassTier } from "./types.js";

/** The five keys of one `[lenses.<pass>]` table, after validation. */
export interface LensTuning {
  min_tier?: PassTier;
  effort?: Exclude<ReviewEffort, "">;
  enabled?: boolean;
  emphasis?: string;
  max_severity?: Severity;
}

/** Pass name → its resolved tuning. Empty ⇒ untuned (the shipped behaviour). */
export type LensTuningMap = Readonly<Record<string, LensTuning>>;

export const LENS_TUNING_KEYS = [
  "min_tier",
  "effort",
  "enabled",
  "emphasis",
  "max_severity",
] as const;

const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2", "P3", "nit"];

/** An emphasis is a few sentences for one lens, not a second rulebook. */
export const EMPHASIS_MAX_CHARS = 2000;

/** The downgrade word the validator records when a profile ceiling caps a
 * candidate (src/findingsrecord.ts DOWNGRADE_WORDS). */
export const PROFILE_CAP_WORD = "profile-over-cap";

/** Ids the compiled tuning addenda take — a profile pack may not claim them. */
export const LENS_TUNING_ID_PREFIXES = ["lens-emphasis-", "lens-ceiling-"] as const;

/**
 * Parse one profile's `[lenses]` table. `where` names the file in every
 * error; `known` is every pass the system knows (dispatch.ts ALL_PASSES).
 * Anything malformed throws — an unknown lens, an unknown key, a bad value,
 * giving the validator a ceiling: a profile that asked for something this
 * cannot honour must fail the boot, never review as if it had. Switching the
 * validator off IS honoured.
 */
export function parseLensTable(
  where: string,
  raw: unknown,
  known: readonly string[],
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
          const v = typeof value === "string" ? value.trim().toLowerCase() : value;
          if (v === "low" || v === "high" || v === "medium") t.effort = v;
          else if (v === "med") t.effort = "medium";
          else throw new Error(`${at} effort must be "low", "medium" or "high"`);
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
        default:
          throw new Error(`${at} unknown key "${key}" — allowed: ${LENS_TUNING_KEYS.join(", ")}`);
      }
    }
    out[lens] = t;
  }
  return out;
}

/** Merge a child profile's lens tables over its base's: per lens, per key,
 * the child wins (scalar rule). */
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

/**
 * The addenda a profile's `emphasis` and `max_severity` compile into, in a
 * deterministic order (lens name, emphasis before ceiling). An emphasis binds
 * its lens alone; a ceiling binds its lens (so it knows how high it may go)
 * and the validator (which enforces it). Composed after the profile's own
 * pack, so a ceiling is the last word on a lens's cap.
 */
export function lensTuningAddenda(lenses: LensTuningMap | undefined): PassAddendum[] {
  const out: PassAddendum[] = [];
  for (const lens of Object.keys(lenses ?? {}).sort()) {
    const t = (lenses as LensTuningMap)[lens] as LensTuning;
    if (t.emphasis !== undefined) {
      out.push({
        id: `lens-emphasis-${lens}`,
        scope: [lens],
        text: `\n## What this repo asks of this lens (this repo's profile)\n${t.emphasis}\n`,
      });
    }
    if (t.max_severity !== undefined) {
      out.push({
        id: `lens-ceiling-${lens}`,
        scope: [lens, VALIDATE],
        text: ceilingText(lens, t.max_severity),
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
