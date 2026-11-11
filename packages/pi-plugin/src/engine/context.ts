// The review context both one-shot routes build before a prompt is rendered:
// the loaded config with a profile (and `--config` levers) applied, and the
// ecosystem that profile names. Shared by `qcr review`, the benchmark and the
// engine. The model specs are the config's own, as written: which provider a
// spec runs on is the run's route's to say (../modelroute.ts), never this
// module's. Where the config and the profiles live is the caller's: it hands
// the loaded config in (src/homes.ts for the CLI, src/reviewcontext.ts for the
// app).

import { ecosystemFor, type Ecosystem } from "../ecosystem.js";
import { applyProfileOverlays, loadProfileEcosystem, type ProfileLookup } from "../profiles.js";
import {
  applyReviewEffort,
  isModelSpec,
  modelSpecError,
  parseCoreConfig,
  parseEffort,
  parsePreset,
  validateLensKnobs,
  withSecurityFamily,
  type CoreConfig,
  type ReviewPreset,
} from "../reviewconfig.js";
import { foldTier } from "../types.js";

/** A loaded config.toml: the parsed config and the text it was parsed from
 * (a `review.preset` lever re-parses the text). */
export interface LoadedConfig<C extends CoreConfig = CoreConfig> {
  cfg: C;
  toml: string;
}

/** The loaded config with only the profile swapped. Escalation stays
 * whatever it ships as (off), so no escalation note renders. */
export function withProfile<C extends CoreConfig>(cfg: C, profile: string): C {
  const out = structuredClone(cfg);
  out.review.profile = profile;
  return out;
}

/**
 * `--config a.b=v,c.d=w`: one bench run's config levers, set on the loaded
 * production config — so two arms of one experiment share ONE image and differ
 * only in the knobs named on the command line (recorded in the fingerprint).
 * A key must already exist in the config (a typo fails loudly instead of
 * measuring nothing) — except inside an OPEN map (`OPEN_MAP_KEYS`, e.g.
 * `models.pass_tiers.pass-sweep=deep`), whose keys are data. `true`/`false`
 * and numbers are coerced to the type the key already holds; an array-valued
 * key takes `|`-separated items (`,` separates pairs), empty = `[]`.
 * `models.effort` is re-applied to every model spec, and the per-lens knobs
 * are re-validated exactly as config parsing validates them.
 */
/** Config maps whose keys are data rather than schema — `--config` may add a
 * key to them. Every other path must already exist. */
export const OPEN_MAP_KEYS: ReadonlySet<string> = new Set([
  "models.pass_tiers",
  "models.pass_models",
]);
/** The config text with `[review] preset` set to `preset` — replaced when the
 * section already names one, inserted under the section header otherwise. */
export function withPresetInToml(toml: string, preset: ReviewPreset): string {
  const lines = toml.split("\n");
  const head = lines.findIndex((l) => /^\s*\[review\]\s*(#.*)?$/.test(l));
  if (head < 0) return `${toml}\n[review]\npreset = "${preset}"\n`;
  let end = lines.findIndex((l, i) => i > head && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  for (let i = head + 1; i < end; i++)
    if (/^\s*preset\s*=/.test(lines[i] as string)) {
      lines[i] = `preset = "${preset}"`;
      return lines.join("\n");
    }
  lines.splice(head + 1, 0, `preset = "${preset}"`);
  return lines.join("\n");
}

/** `--config` keys whose value is a tier name; a key ending in `.` is a
 * table whose every value is one. */
const TIER_VALUED_KEYS: readonly string[] = [
  "models.validate_tier",
  "models.pass_tiers.",
  "review.sweep_light_tier",
  "scan.tier",
];

/** `--config` keys that name the review's model, strongest first. The two
 * older keys fold to `models.model` as config.toml's do: in one lever set
 * the strongest key given is the model, and a weaker one beside it is
 * accepted and read by nothing. */
const MODEL_LEVER_KEYS: readonly string[] = [
  "models.model",
  "models.conversation",
  "models.default",
];

/** A lever's key as the path it sets. `models.tiers.<name>` names a tier,
 * in either spelling: the path is the ladder's name, the key the config
 * holds. A key that names the review's model, in any of its spellings, sets
 * `models.model`. */
function leverPath(key: string): string[] {
  if (MODEL_LEVER_KEYS.includes(key)) return ["models", "model"];
  const path = key.split(".");
  if (path.length === 3 && path[0] === "models" && path[1] === "tiers")
    path[2] = foldTier(path[2] as string) ?? (path[2] as string);
  return path;
}

/** `--config` keys that went with the overseer session. */
const RETIRED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "models.overseer",
  "daemon.overseer_rotation_days",
]);

/**
 * `--config a.b=v,c.d=w`: one bench run's levers (see above). `review.preset=X`
 * means "as if config.toml said `preset = X`": the config TEXT is re-parsed
 * with that preset, so the preset resolves exactly as in production — its
 * reasoning level replaces whatever level the file's own preset baked into the
 * specs, and a key the file sets explicitly still beats it. It therefore needs
 * the config text (`toml`); every other pair then overrides on top.
 */
export function applyConfigOverrides<C extends CoreConfig>(
  cfg: C,
  spec: string,
  toml?: string,
  /** Where a retired key's notice goes, one line: the host's (the bench CLI's
   * stderr). Omitted: nowhere. */
  warn: (line: string) => void = () => {},
): C {
  const pairs = spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (pairs.length === 0) return cfg;
  const keyOf = (p: string): string => p.slice(0, Math.max(p.indexOf("="), 0)).trim();
  const presetPairs = pairs.filter((p) => keyOf(p) === "review.preset");
  if (presetPairs.length > 1) throw new Error("--config: review.preset given more than once");
  const presetPair = presetPairs[0];
  let base = cfg;
  if (presetPair) {
    const preset = parsePreset(presetPair.slice(presetPair.indexOf("=") + 1));
    if (toml === undefined)
      throw new Error("--config: review.preset needs the config text to re-parse");
    base = withPresetReparsed(cfg, withPresetInToml(toml, preset));
  }
  const rest = pairs.filter((p) => p !== presetPair);
  if (rest.length === 0) return base;
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  /** The spelling of the review's model this lever set is read by. */
  const modelKey = MODEL_LEVER_KEYS.find((k) => rest.some((p) => keyOf(p) === k));
  for (const pair of rest) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--config: "${pair}" is not key=value`);
    const named = pair.slice(0, eq).trim();
    // The overseer session is deleted: bench plans still pin its model, so
    // the key is accepted, named once and ignored (like the config file's).
    if (RETIRED_CONFIG_KEYS.has(named)) {
      warn(`--config: ${named} is deprecated and ignored (the overseer session was deleted)`);
      continue;
    }
    // An older spelling of the model beside a stronger one: read by nothing.
    if (MODEL_LEVER_KEYS.includes(named) && named !== modelKey) continue;
    const path = leverPath(named);
    const key = path.join(".");
    const written = pair.slice(eq + 1).trim();
    // A model the lever writes is checked as the file's is: `model` itself
    // and a tier's spec. An older spelling is taken as written, as the
    // file's older keys are.
    const misspelt =
      named === "models.model"
        ? !isModelSpec(written, "whole")
        : key.startsWith("models.tiers.") && !isModelSpec(written, "any");
    if (misspelt) {
      const where =
        named === "models.model"
          ? "[models] model"
          : `[models.tiers] ${key.slice("models.tiers.".length)}`;
      throw new Error(`--config: ${modelSpecError(where, written).message}`);
    }
    // A lever that names a tier names it in either spelling, as the file may.
    const raw = TIER_VALUED_KEYS.some((k) => (k.endsWith(".") ? key.startsWith(k) : key === k))
      ? (foldTier(written) ?? written)
      : written;
    let node = out;
    for (const k of path.slice(0, -1)) {
      const next = node[k];
      if (typeof next !== "object" || next === null)
        throw new Error(`--config: no section "${path.join(".")}" in config.toml`);
      node = next as Record<string, unknown>;
    }
    const leaf = path[path.length - 1] as string;
    const open = OPEN_MAP_KEYS.has(path.slice(0, -1).join("."));
    if (!open && !Object.hasOwn(node, leaf))
      throw new Error(`--config: no key "${path.join(".")}" in config.toml`);
    const cur = node[leaf];
    const num = (v: string): number => {
      const n = Number(v);
      if (v === "" || !Number.isFinite(n))
        throw new Error(`--config: ${path.join(".")} takes a number (got "${v}")`);
      return n;
    };
    if (Array.isArray(cur)) {
      const items = raw === "" ? [] : raw.split("|").map((x) => x.trim());
      if (items.some((x) => x === ""))
        throw new Error(`--config: ${path.join(".")} has an empty item in "${raw}"`);
      node[leaf] = cur.length > 0 && typeof cur[0] === "number" ? items.map(num) : items;
      continue;
    }
    if (typeof cur === "object" && cur !== null)
      throw new Error(
        `--config: ${path.join(".")} is a table — set one of its keys (${path.join(".")}.<key>=…)`,
      );
    node[leaf] =
      typeof cur === "boolean"
        ? raw === "true"
          ? true
          : raw === "false"
            ? false
            : (() => {
                throw new Error(`--config: ${path.join(".")} takes true|false`);
              })()
        : typeof cur === "number"
          ? num(raw)
          : raw;
  }
  const next = out as unknown as C;
  if (rest.some((p) => p.startsWith("models.effort"))) {
    // Re-parse through the same validation the config file gets.
    let effort: ReturnType<typeof parseEffort>;
    try {
      effort = parseEffort(next.models.effort);
    } catch (err) {
      throw new Error(`--config: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    next.models = applyReviewEffort({ ...next.models, effort });
  }
  // A lever that lists the risk passes lists them as config.toml would: the
  // security family joins them, as it does at parse.
  if (rest.some((p) => keyOf(p) === "models.risk_passes"))
    next.models = { ...next.models, risk_passes: withSecurityFamily(next.models.risk_passes) };
  validateLensKnobs(next);
  return next;
}

/**
 * The config the preset's sections re-parse from `toml` give, over `cfg`:
 * as if the file had said so. Only `[models]` and `[review]` read the
 * preset, so the rest is `cfg`'s as loaded; the profile is `cfg`'s, and the
 * profile overlays (`lenses`, `posting`) go, as a fresh parse has none.
 */
function withPresetReparsed<C extends CoreConfig>(cfg: C, toml: string): C {
  const reparsed = parseCoreConfig(toml);
  const { lenses: _lenses, posting: _posting, ...rest } = structuredClone(cfg);
  return {
    ...rest,
    models: reparsed.models,
    review: { ...reparsed.review, profile: cfg.review.profile },
  } as C;
}

/** The review context for `profile`: the loaded config with the profile, the
 * `--config` levers and then the profile's own overlays applied, and the
 * ecosystem it names. `lookup` says where the profiles live. */
export function contextFrom<C extends CoreConfig>(
  root: string,
  loaded: LoadedConfig<C>,
  profile: string,
  overrides = "",
  lookup: ProfileLookup = {},
  /** Where an override's notice goes (`applyConfigOverrides`). */
  warn?: (line: string) => void,
): { cfg: C; ecosystem: Ecosystem } {
  const levered = applyConfigOverrides(
    withProfile(loaded.cfg, profile),
    overrides,
    loaded.toml,
    warn,
  );
  // The profile the run reviews under: `--profile`, or `--config
  // review.profile=<name>` (arm.sh's spelling) — every loader reads the same
  // one, so a profile chosen either way is the whole profile.
  const chosen = levered.review.profile;
  // The profile's overlays (its lens tuning, its `[security]` and its
  // `[posting]` policy) are applied LAST — after the `--config` levers and
  // any preset re-parse — through the one function production overlays with
  // after config.toml: the profile wins.
  const cfg = applyProfileOverlays(root, levered, lookup);
  return { cfg, ecosystem: ecosystemFor(loadProfileEcosystem(root, chosen, lookup)) };
}
