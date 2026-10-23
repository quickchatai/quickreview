// The review context both one-shot routes build before a prompt is rendered:
// the loaded config with a profile (and `--config` levers) applied, and the
// ecosystem that profile names. Shared by `qcr review`, the benchmark and the
// engine; the bench's credential route decides only the model specs. Where
// the config and the profiles live is the caller's: it hands the loaded
// config in (src/homes.ts for the CLI, src/reviewcontext.ts for the app).

import { ecosystemFor, type Ecosystem } from "../ecosystem.js";
import { applyProfileTuning } from "../lenstuning.js";
import {
  loadProfileEcosystem,
  loadProfileLensTuning,
  loadProfilePosting,
  type ProfileLookup,
} from "../profiles.js";
import { applyProfilePosting } from "../postingpolicy.js";
import {
  applyReviewEffort,
  parseCoreConfig,
  parseEffort,
  parsePreset,
  validateLensKnobs,
  type CoreConfig,
  type ReviewPreset,
} from "../reviewconfig.js";
import { benchAuthMode, modelForAuth, type BenchAuthMode } from "./keyroute.js";

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
 * `models.pass_tiers.pass-sweep=sol-high`), whose keys are data. `true`/`false`
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
  for (const pair of rest) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--config: "${pair}" is not key=value`);
    // The overseer session is deleted: bench plans still pin its model, so
    // the key is accepted, named once and ignored (like the config file's).
    if (RETIRED_CONFIG_KEYS.has(pair.slice(0, eq).trim())) {
      warn(
        `--config: ${pair.slice(0, eq).trim()} is deprecated and ignored (the overseer session was deleted)`,
      );
      continue;
    }
    const path = pair.slice(0, eq).trim().split(".");
    const raw = pair.slice(eq + 1).trim();
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
  // The profile's lens tuning (and its `[posting]` policy) is
  // overlaid LAST — after the `--config` levers and any preset re-parse —
  // exactly as production overlays it after config.toml: the profile wins.
  const cfg = withAuthModels(
    applyProfilePosting(
      applyProfileTuning(levered, loadProfileLensTuning(root, chosen, lookup)),
      loadProfilePosting(root, chosen, lookup),
    ),
  );
  return { cfg, ecosystem: ecosystemFor(loadProfileEcosystem(root, chosen, lookup)) };
}

/** Every model spec of the config as it runs on the bench's credential route
 * (src/engine/keyroute.ts): on the API-key route `openai-codex/` → `openai/`, the
 * same model on the public API; on the login route the config unchanged. */
export function withAuthModels<C extends CoreConfig>(
  cfg: C,
  mode: BenchAuthMode = benchAuthMode(),
): C {
  if (mode !== "api-key") return cfg;
  const out = structuredClone(cfg);
  const m = out.models;
  m.default = modelForAuth(m.default, mode);
  m.conversation = modelForAuth(m.conversation, mode);
  for (const k of Object.keys(m.tiers) as (keyof typeof m.tiers)[])
    m.tiers[k] = modelForAuth(m.tiers[k], mode);
  for (const pass of Object.keys(m.pass_models))
    m.pass_models[pass] = modelForAuth(m.pass_models[pass]!, mode);
  return out;
}
