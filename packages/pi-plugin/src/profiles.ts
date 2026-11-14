// Repo-profile addenda packs.
//
// A profile is a directory `profiles/<name>/` whose `addenda/*.md` files
// carry house-rule pass addenda — the same `PassAddendum` shape the compiled-in
// registry (`PASS_ADDENDA`, packages/pi-plugin/src/include.ts) declares, authored as files so an
// operator can match the reviewer's house-rule knowledge to their repo without
// editing this codebase. The addendum registry remains the ONE composition
// mechanism: a pack does not bypass it, it extends it — wire.ts appends the
// loaded pack to `PASS_ADDENDA` before calling `buildAgents`, so profile
// entries compose onto built pass bodies AFTER every built-in generic entry
// and BEFORE the dynamic same-day feedback addendum (which wire.ts appends
// last). Seeds stay frozen; nothing here touches `agents/` or `prompts/`.
//
// File format — YAML-shaped frontmatter, three keys only, then the body:
//
//   ---
//   id: migration-discipline
//   scope: pass-data-safety
//   mode: review
//   ---
//   ## Migration discipline — … (sandbox rule)
//   …
//
//   * `id`    — stable kebab-case id (what tests and commit messages cite).
//   * `scope` — `all` | `lenses` | a comma-separated list of pass names and
//     lens families (`family:security`, `family:state`: every lens of that
//     entry of packages/pi-plugin/src/passes.ts `LENS_FAMILIES`).
//   * `mode`  — optional: `review` (a PR round's build only), `scan` (a
//     whole-repo scan's build only) or `both`, the default.
//
// The composed text is `"\n" + body` (body = every byte after the closing
// fence, verbatim): built-in addenda all start with a newline separator, and
// prepending it here keeps the files editor-friendly (no significant leading
// blank line) while byte-preserving the composed output.
//
// Ordering is deterministic and documented: files compose in ascending
// filename order (JS default sort — byte-wise by UTF-16 code unit), so packs
// use numeric prefixes (`10-…`, `20-…`) to state intent. Non-`.md` entries
// (README, .gitkeep) are ignored by contract; everything else that fails to
// parse — missing frontmatter, unknown keys, a bad scope, an empty body, a
// duplicate or reserved id — throws with the offending path. A malformed pack
// is a loud build failure, never a silent skip.
//
// Where a profile lives is the profile search's call (packages/pi-plugin/src/profilelookup.ts
// `findProfile`): the homes the caller names (`ProfileLookup.homes`, the
// install's, resolved by src/homes.ts `homeProfileLookup`) first, then the
// checkout's generic examples — every loader below resolves the name through
// it, so a name that could escape `profiles/` is refused before any read.
//
// A repo profile (`.qcr/` on the base branch, packages/pi-plugin/src/profileoverrides.ts) rides
// the same loaders as the lowest layer of the chain: `ProfileLookup.repoProfile`
// names its extracted directory, and everything the named profile and its bases
// set wins over it. The extraction has already dropped what a repo may not say.
//
// Inheritance: `profile.toml` may say `extends = "<profile>"`, and
// the base may extend another, in chains. Every loader below resolves the
// WHOLE chain (`profileChain` — base first, the selected profile last; a
// cycle is refused, a missing base is a loud failure) and merges per kind:
//   * addenda — the base's pack first; a child entry with an inherited id
//     REPLACES it in place, a new id appends, and `[addenda] drop = [ids]`
//     removes inherited ids (a drop naming nothing inherited is refused —
//     a typo must not read as a removal);
//   * heuristics — unioned per lens, base predicates first;
//   * scalars (`ecosystem`) — the nearest profile that sets one wins;
//   * per-lens tuning (`[lenses.<pass>]`) — per lens, per key, the
//     nearest profile that sets it wins;
//   * the scan table (`[scan]`) — per key, the nearest profile that
//     sets it wins (a list, `exclude`, is replaced whole, never appended);
//   * the posting policy (`[posting]`) — per key, the nearest
//     profile that sets it wins;
//   * the security table (`[security]`) and the state-machine table
//     (`[state_machines]`) — per key, the nearest profile that sets it wins,
//     over config.toml's;
//   * the threat model (`threat-model.md`) — the nearest profile that
//     carries one wins whole; the repository's own (`.qcr/threat-model.md`,
//     packages/pi-plugin/src/profileoverrides.ts) wins over every profile's.
// The shipped `default` profile encodes the shipped behaviour (an empty pack,
// no heuristics, `ecosystem = "none"`, and `[posting] repeat_sites = false`:
// one comment per root cause) and is the base a generated profile extends. An
// empty child of it reviews as no profile does, but posts each root cause
// once where no profile keeps the code default (`repeat_sites = true`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  DEFAULT_PASS_TIERS,
  parseScanTable,
  parseSecurityTable,
  parseStateMachinesTable,
  SCAN_PROFILE_KEYS,
  SECURITY_DEFAULTS,
  SECURITY_PROFILE_KEYS,
  STATE_MACHINES_DEFAULTS,
  STATE_MACHINES_PROFILE_KEYS,
  type ModelsConfig,
  type ScanConfig,
  type SecurityConfig,
  type StateMachinesConfig,
} from "./reviewconfig.js";
import type { EcosystemName } from "./ecosystem.js";
import { ALL_PASSES, LENS_FAMILIES, SECURITY_FAMILY, STATE_FAMILY } from "./passes.js";
import { PROFILE_THREAT_MODEL_FILE } from "./threatmodel.js";
import { RISK_TIER } from "./types.js";
import { EMPTY_HEURISTICS, PROFILE_EXTENDABLE_LENSES } from "./heuristics.js";
import type { HeuristicsExtension } from "./heuristics.js";
import {
  FEEDBACK_DAY_ADDENDUM_ID,
  LESSON_VALIDATE_ADDENDUM_ID,
  PASS_ADDENDA,
  SCAN_PASS,
  splitFrontmatter,
  VALIDATE_PASS,
} from "./include.js";
import type { PassAddendum, PassAddendumScope } from "./include.js";
import {
  findProfile,
  profileSearchPlaces,
  strandedProfile,
  type ProfilePlace,
} from "./profilelookup.js";
import {
  applyProfilePosting,
  parsePostingTable,
  POSTING_ADDENDUM_IDS,
  type PostingPolicy,
  type PostingScope,
} from "./postingpolicy.js";
import {
  applyProfileTuning,
  LENS_TUNING_ID_PREFIXES,
  mergeLensTuning,
  parseLensTable,
  profileRiskLenses,
  type LensTuning,
} from "./lenstuning.js";

/** How a loader finds the profile. */
export interface ProfileLookup {
  /** The profile directories outside the checkout, searched first and in
   * order: the install's, as src/homes.ts `homeProfileLookup` resolves them.
   * Absent: the checkout's generic examples alone. */
  homes?: readonly ProfilePlace[];
  /** The repo profile's extracted directory (`extractRepoProfile`): a layer
   * under the whole named chain, present even when no profile is named. */
  repoProfile?: { dir: string };
}

/** The name the repo profile's layer carries in errors. */
export const REPO_LAYER_NAME = ".qcr";

/** Where a not-found looked — and, when the checkout still strands a profile
 * of that name (which is never read), the way out. */
function notFoundWhere(root: string, profile: string, lookup: ProfileLookup): string {
  const homes = lookup.homes ?? [];
  const looked = `looked in ${profileSearchPlaces(root, homes)
    .map((p) => p.dir)
    .join(", ")} (the checkout's: generic examples only)`;
  const stranded = strandedProfile({ root, profile, homes });
  return stranded === null
    ? looked
    : `${looked}; ${stranded} is no longer read — move it into the config home with \`qcr install migrate\``;
}

/** The named profile's directory, wherever the locator finds it — or a loud
 * not-found naming every place it looked. */
function profileDirOrThrow(root: string, profile: string, lookup: ProfileLookup): string {
  const located = findProfile({ root, profile, homes: lookup.homes ?? [] });
  if (located) return located.dir;
  throw new Error(
    `[review] profile "${profile}" not found — ${notFoundWhere(root, profile, lookup)}`,
  );
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PASS_NAME_RE = /^pass-[a-z0-9][a-z0-9-]*$/;

// ---- the extends chain -----------------------------------------------------

/** One profile of a resolved chain: where it lives and what its
 * `profile.toml` says about inheritance and the scalars it sets. */
interface ProfileLayer {
  name: string;
  dir: string;
  /** `profile.toml`'s path — named in every error about this layer. */
  toml: string;
  /** The profile this one extends, when it says so. */
  extends?: string;
  /** `[addenda] drop` — inherited addendum ids this profile removes. */
  drop: string[];
  /** The raw `ecosystem` value, when this profile sets one. */
  ecosystem?: unknown;
  /** The raw `[lenses]` table, when this profile has one. */
  lenses?: unknown;
  /** The raw `[scan]` table, when this profile has one. */
  scan?: unknown;
  /** The raw `[posting]` table, when this profile has one. */
  posting?: unknown;
  /** The raw `[security]` table, when this profile has one. */
  security?: unknown;
  /** The raw `[state_machines]` table, when this profile has one. */
  state_machines?: unknown;
  /** The layer may omit `addenda/` without extending anything (the repo
   * profile: a `.qcr/` that only tunes). */
  optionalPack?: boolean;
}

/** Read one profile's `profile.toml` — an absent file is an empty one. Owns
 * the `extends` key and the `[addenda]` table; other keys belong to other
 * loaders and are not an error here. */
function readLayer(name: string, dir: string): ProfileLayer {
  const toml = join(dir, "profile.toml");
  let raw: string;
  try {
    raw = readFileSync(toml, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { name, dir, toml, drop: [] };
    throw new Error(`[review] profile "${name}": cannot read ${toml}: ${String(err)}`, {
      cause: err,
    });
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(raw);
  } catch (err) {
    throw new Error(`[review] profile "${name}": ${toml} is not valid TOML: ${String(err)}`, {
      cause: err,
    });
  }
  const layer: ProfileLayer = { name, dir, toml, drop: [] };
  const ext = doc["extends"];
  if (ext !== undefined) {
    if (typeof ext !== "string" || ext === "") {
      throw new Error(
        `[review] profile "${name}": ${toml} extends must be a profile name, got ${JSON.stringify(ext)}`,
      );
    }
    layer.extends = ext;
  }
  if ("ecosystem" in doc) layer.ecosystem = doc["ecosystem"];
  if ("lenses" in doc) layer.lenses = doc["lenses"];
  if ("scan" in doc) layer.scan = doc["scan"];
  if ("posting" in doc) layer.posting = doc["posting"];
  if ("security" in doc) layer.security = doc["security"];
  if ("state_machines" in doc) layer.state_machines = doc["state_machines"];
  const addenda = doc["addenda"];
  if (addenda !== undefined) {
    if (typeof addenda !== "object" || addenda === null || Array.isArray(addenda)) {
      throw new Error(`[review] profile "${name}": ${toml} [addenda] must be a table`);
    }
    for (const [key, value] of Object.entries(addenda as Record<string, unknown>)) {
      if (key !== "drop") {
        throw new Error(
          `[review] profile "${name}": ${toml} [addenda] unknown key "${key}" — only "drop" is allowed`,
        );
      }
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !ID_RE.test(v))) {
        throw new Error(
          `[review] profile "${name}": ${toml} [addenda] drop must be an array of addendum ids (kebab-case)`,
        );
      }
      layer.drop = value as string[];
    }
  }
  return layer;
}

/**
 * The selected profile and everything it extends, BASE FIRST (the selected
 * profile is the last element). Each name resolves through the install
 * locator, so a base is found where any profile is. Refused, loudly: a
 * profile not found, a base not found (naming who extends it), and a cycle
 * (naming the whole loop, a self-extend included).
 */
function profileChain(root: string, profile: string, lookup: ProfileLookup): ProfileLayer[] {
  const chain: ProfileLayer[] = [];
  let name = profile;
  let dir = profileDirOrThrow(root, profile, lookup);
  for (;;) {
    const layer = readLayer(name, dir);
    chain.push(layer);
    const base = layer.extends;
    if (base === undefined) break;
    const seen = chain.map((l) => l.name);
    if (seen.includes(base)) {
      throw new Error(
        `[review] profile "${profile}": extends cycle ${[...seen, base].join(" → ")} — a profile chain must end in a profile that extends nothing`,
      );
    }
    const located = findProfile({ root, profile: base, homes: lookup.homes ?? [] });
    if (!located) {
      throw new Error(
        `[review] profile "${name}" extends "${base}", which was not found — ${notFoundWhere(root, base, lookup)}`,
      );
    }
    name = base;
    dir = located.dir;
  }
  return chain.reverse();
}

/** The repo profile's layer, when the lookup carries one. */
function repoLayer(lookup: ProfileLookup): ProfileLayer[] {
  if (!lookup.repoProfile) return [];
  return [{ ...readLayer(REPO_LAYER_NAME, lookup.repoProfile.dir), optionalPack: true }];
}

/** The chain every loader walks: the repo layer first (lowest), then the
 * named profile's, base first. `soft` is the tuning loaders' contract: no
 * profile, or one found nowhere, means no named chain rather than a throw. */
function chainOf(
  root: string,
  profile: string,
  lookup: ProfileLookup,
  soft: boolean,
): ProfileLayer[] {
  return [...repoLayer(lookup), ...namedChain(root, profile, lookup, soft)];
}

/** The named profile's chain alone, base first, without the repo layer. */
function namedChain(
  root: string,
  profile: string,
  lookup: ProfileLookup,
  soft: boolean,
): ProfileLayer[] {
  return profile === "" || (soft && !findProfile({ root, profile, homes: lookup.homes ?? [] }))
    ? []
    : profileChain(root, profile, lookup);
}

/** The selected profile's resolved `extends` chain, base first — name and
 * directory of each layer (the setup's profile validate names what it
 * checked). Same refusals as every loader: not found, base not found,
 * cycle. `""` is no profile: an empty chain. */
export function resolveProfileChain(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): Array<{ name: string; dir: string }> {
  if (profile === "") return [];
  return profileChain(root, profile, lookup).map((l) => ({ name: l.name, dir: l.dir }));
}

/** Ids a pack may not claim: every compiled-in entry, plus the dynamic
 * same-day feedback addendum wire.ts composes last (src/feedback.ts). */
export function reservedAddendumIds(): Set<string> {
  return new Set([
    ...PASS_ADDENDA.map((a) => a.id),
    FEEDBACK_DAY_ADDENDUM_ID,
    // The lesson addendum wire.ts composes beside it under `[memory]
    // delivery = "on"` (packages/pi-plugin/src/include.ts lessonAddenda).
    LESSON_VALIDATE_ADDENDUM_ID,
    // The addendum `[posting]` compiles into (packages/pi-plugin/src/postingpolicy.ts).
    ...POSTING_ADDENDUM_IDS,
  ]);
}

/** The `family:<name>` spelling of a lens family in an addendum scope. */
const FAMILY_PREFIX = "family:";

function parseScope(raw: string, file: string): PassAddendumScope {
  if (raw === "all" || raw === "lenses") return raw;
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) throw new Error(`profile addendum ${file}: empty scope`);
  const names: string[] = [];
  for (const t of tokens) {
    if (!t.startsWith(FAMILY_PREFIX)) {
      names.push(t);
      continue;
    }
    // A family expands to its members as they are today, so a lens that
    // joins the family later is bound without editing the pack.
    const family = t.slice(FAMILY_PREFIX.length);
    if (!Object.hasOwn(LENS_FAMILIES, family))
      throw new Error(
        `profile addendum ${file}: unknown lens family "${family}" in scope "${raw}" — one of: ${Object.keys(
          LENS_FAMILIES,
        )
          .map((f) => FAMILY_PREFIX + f)
          .join(", ")}`,
      );
    names.push(...LENS_FAMILIES[family as keyof typeof LENS_FAMILIES]);
  }
  for (const n of names) {
    if (!PASS_NAME_RE.test(n)) {
      throw new Error(
        `profile addendum ${file}: unknown scope "${raw}" — use "all", "lenses", or a comma-separated list of pass names (pass-…) and lens families (family:security, family:state)`,
      );
    }
    // A well-shaped name no pass carries matches nothing at composition
    // (addendumApplies is an exact match), so the rule would bind silently
    // nowhere — refuse it, as [lenses] tables are refused.
    if (!ALL_PASSES.includes(n) && n !== SCAN_PASS) {
      throw new Error(
        `profile addendum ${file}: unknown pass "${n}" in scope "${raw}" — no pass carries that name`,
      );
    }
  }
  return [...new Set(names)];
}

/** An addendum's `mode:` → the build it binds (`PassAddendum.mode`); `both`
 * is no field, binding either build. */
const ADDENDUM_MODES: Readonly<Record<string, PassAddendum["mode"] | null>> = {
  review: "pr",
  scan: "scan",
  both: null,
};

/** Parse ONE addendum file's raw bytes. Throws (naming `file`) on anything
 * malformed — the loud-failure contract. */
export function parseProfileAddendum(file: string, raw: string): PassAddendum {
  const doc = splitFrontmatter(raw);
  if (!doc.hasFrontmatter) {
    throw new Error(`profile addendum ${file}: missing frontmatter (--- id/scope/mode fences)`);
  }
  const fields = new Map<string, string>();
  for (const line of doc.frontmatter.split("\n")) {
    if (line.trim() === "") continue;
    const m = /^(id|scope|mode):[ \t]*(.+?)[ \t]*$/.exec(line);
    if (!m)
      throw new Error(
        `profile addendum ${file}: unrecognized frontmatter line "${line}" — only "id:", "scope:" and "mode:" are allowed`,
      );
    const key = m[1] as string;
    const value = m[2] as string;
    if (fields.has(key))
      throw new Error(`profile addendum ${file}: duplicate frontmatter key "${key}"`);
    fields.set(key, value);
  }
  const id = fields.get("id");
  if (id === undefined) throw new Error(`profile addendum ${file}: missing "id:" in frontmatter`);
  if (!ID_RE.test(id))
    throw new Error(`profile addendum ${file}: id "${id}" must be kebab-case ([a-z0-9-])`);
  const rawScope = fields.get("scope");
  if (rawScope === undefined)
    throw new Error(`profile addendum ${file}: missing "scope:" in frontmatter`);
  const scope = parseScope(rawScope, file);
  const rawMode = fields.get("mode") ?? "both";
  if (!Object.hasOwn(ADDENDUM_MODES, rawMode))
    throw new Error(`profile addendum ${file}: mode "${rawMode}" — use "review", "scan" or "both"`);
  const mode = ADDENDUM_MODES[rawMode];
  if (doc.body.trim() === "") throw new Error(`profile addendum ${file}: empty body`);
  // "\n" + verbatim body: byte-compatible with the compiled-in constants,
  // which each begin with a newline separator.
  return { id, scope, ...(mode ? { mode } : {}), text: `\n${doc.body}` };
}

function mustBeDir(path: string, what: string): void {
  let ok = false;
  try {
    ok = statSync(path).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${what}: ${path} is not a directory`);
}

/** Load ONE profile's own pack (no inheritance), in filename order. A
 * profile that extends another may omit `addenda/` (it inherits its pack);
 * one that extends nothing must have it. */
function loadOwnPack(layer: ProfileLayer): PassAddendum[] {
  const addendaDir = join(layer.dir, "addenda");
  if ((layer.extends !== undefined || layer.optionalPack) && !existsSync(addendaDir)) return [];
  mustBeDir(addendaDir, `[review] profile "${layer.name}" has no addenda/ directory`);
  const files = readdirSync(addendaDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const reserved = reservedAddendumIds();
  const seen = new Set<string>();
  const loaded: PassAddendum[] = [];
  for (const f of files) {
    const path = join(addendaDir, f);
    const entry = parseProfileAddendum(path, readFileSync(path, "utf8"));
    if (reserved.has(entry.id)) {
      throw new Error(
        `profile addendum ${path}: id "${entry.id}" collides with a built-in registry entry`,
      );
    }
    if (LENS_TUNING_ID_PREFIXES.some((p) => entry.id.startsWith(p))) {
      throw new Error(
        `profile addendum ${path}: id "${entry.id}" is reserved for the addenda [lenses] compiles (emphasis, max_severity, guide)`,
      );
    }
    if (seen.has(entry.id))
      throw new Error(`profile addendum ${path}: duplicate id "${entry.id}" within the pack`);
    seen.add(entry.id);
    loaded.push(entry);
  }
  return loaded;
}

/**
 * Load the named profile's addenda pack — its whole `extends` chain merged —
 * in composition order.
 *
 * Within one pack the order is ascending filename sort and nothing else;
 * across a chain the base's entries come first, a child's entry with an
 * inherited id takes that entry's PLACE (replace in place, so a child can
 * reword a base rule without reordering the pack), and a new id appends.
 * `[addenda] drop` removes inherited ids before the child's own pack merges,
 * so dropping an id and defining it again moves it to the tail. A drop that
 * names nothing inherited is refused — a built-in registry entry can never be
 * dropped by a profile, and a typo must not silently read as a removal.
 * Deterministic by construction, so a rebuild of an unchanged tree stays
 * byte-identical, same contract as the compiled-in registry's declaration
 * order. Every failure is a throw; the caller (wire.ts, at daemon assembly)
 * is expected to let it crash the boot rather than review with a partial
 * pack.
 */
export function loadProfileAddenda(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): PassAddendum[] {
  const reserved = reservedAddendumIds();
  let merged: PassAddendum[] = [];
  for (const layer of chainOf(root, profile, lookup, false)) {
    for (const id of layer.drop) {
      if (!merged.some((a) => a.id === id)) {
        const why = reserved.has(id)
          ? "a built-in registry entry, which no profile can drop"
          : "no profile it extends defines it";
        throw new Error(
          `[review] profile "${layer.name}": ${layer.toml} [addenda] drop names "${id}" — ${why}`,
        );
      }
      merged = merged.filter((a) => a.id !== id);
    }
    for (const entry of loadOwnPack(layer)) {
      const at = merged.findIndex((a) => a.id === entry.id);
      if (at >= 0) merged[at] = entry;
      else merged.push(entry);
    }
  }
  return merged;
}

/**
 * The profile's ecosystem selection: `profiles/<name>/profile.toml`,
 * key `ecosystem = "django" | "none"`.
 *
 * No profile (`""`), a profile found nowhere, or no `ecosystem` key anywhere
 * in its `extends` chain (the nearest profile that sets it wins) all mean
 * `"none"` — a generic install gets no framework-specific machinery (no
 * pre-check, no tier-forcing migration gate, no migration-gate prompt prose)
 * unless its profile asks for it. An unreadable file or an unknown value
 * throws with the path named — a loud boot failure, same contract as the
 * addenda loader above: a daemon must never review under a profile it could
 * not parse.
 *
 * Deliberately its own function rather than a fold into `loadProfileAddenda`:
 * `profile.toml` is the profile's settings file and other loaders may own
 * other keys in it (each reads only its own; unknown keys are not an error
 * here), while `addenda/` stays the addenda loader's alone.
 */
export function loadProfileEcosystem(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): EcosystemName {
  // Child wins — the nearest profile in the chain that sets the key.
  // Every layer's value is validated, an overridden one too: a base that
  // names an unknown ecosystem is broken for every other child of it.
  let chosen: EcosystemName = "none";
  for (const layer of chainOf(root, profile, lookup, true)) {
    const eco = layer.ecosystem;
    if (eco === undefined) continue;
    if (eco !== "django" && eco !== "none") {
      throw new Error(
        `[review] profile "${layer.name}": ${layer.toml} names unknown ecosystem ${JSON.stringify(eco)} — use "django" or "none"`,
      );
    }
    chosen = eco;
  }
  return chosen;
}

// ---- per-lens tuning -------------------------------------------------------

/**
 * The named profile's per-lens tuning — `[lenses.<pass>]` in `profile.toml`,
 * the whole `extends` chain merged (per lens, per key, the nearest profile
 * that sets it wins). The keys and what each one moves are packages/pi-plugin/src/lenstuning.ts's
 * header; the caller overlays the result on the config with
 * `applyProfileTuning`, which is what makes the profile win over config.toml,
 * the preset and the defaults.
 *
 * `""` (no profile), a profile found nowhere and a chain with no `[lenses]`
 * anywhere all mean `{}` — untuned. Everything malformed, in ANY layer (an
 * overridden base value too — a broken base is broken for every child of it),
 * throws with the file named: same loud-boot contract as the loaders above.
 */
export function loadProfileLensTuning(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): Record<string, LensTuning> {
  let merged: Record<string, LensTuning> = {};
  for (const layer of chainOf(root, profile, lookup, true)) {
    if (layer.lenses === undefined) continue;
    const where = `[review] profile "${layer.name}": ${layer.toml}`;
    merged = mergeLensTuning(merged, parseLensTable(where, layer.lenses, ALL_PASSES, layer.dir));
  }
  return merged;
}

// ---- the scan table ----------------------------------------------------------

/**
 * The named profile's overrides of `config.toml [scan]` — `[scan]` in
 * `profile.toml`, the whole `extends` chain merged (per key, the nearest
 * profile that sets it wins). Only `SCAN_PROFILE_KEYS` may appear: how hard
 * stage 1 looks at THIS repo (`effort`, `tier`), whether its candidates are
 * validated (`validator`), and what is not worth reading (`exclude`). The
 * install's operating limits (concurrency, case size, the calibration cap)
 * stay config.toml's.
 *
 * `""`, a profile found nowhere and a chain with no `[scan]` all mean `{}`;
 * anything malformed in any layer throws with the file named.
 */
export function loadProfileScan(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): Partial<ScanConfig> {
  let merged: Partial<ScanConfig> = {};
  for (const layer of chainOf(root, profile, lookup, true)) {
    if (layer.scan === undefined) continue;
    const where = `[review] profile "${layer.name}": ${layer.toml}`;
    merged = { ...merged, ...parseScanTable(where, layer.scan, SCAN_PROFILE_KEYS) };
  }
  return merged;
}

// ---- the posting policy -------------------------------------------------------

/**
 * The named profile's posting policy — `[posting]` in `profile.toml`, the
 * whole `extends` chain merged (per key, the nearest profile that sets it
 * wins). Returns only the keys the chain sets; `applyProfilePosting`
 * (packages/pi-plugin/src/postingpolicy.ts) resolves them over today's defaults.
 *
 * `""`, a profile found nowhere and a chain with no `[posting]` all mean `{}`
 * — today's behaviour. Anything malformed in any layer (an overridden base
 * value too) throws with the file named: the loud-boot contract.
 */
export function loadProfilePosting(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): Partial<PostingPolicy> {
  let merged: Partial<PostingPolicy> = {};
  for (const layer of chainOf(root, profile, lookup, true)) {
    if (layer.posting === undefined) continue;
    merged = {
      ...merged,
      ...parsePostingTable(`[review] profile "${layer.name}": ${layer.toml}`, layer.posting),
    };
  }
  return merged;
}

// ---- the security table -------------------------------------------------------

/**
 * The named profile's overrides of `config.toml [security]` — `[security]` in
 * `profile.toml`, the whole `extends` chain merged (per key, the nearest
 * profile that sets it wins). Only `SECURITY_PROFILE_KEYS` may appear:
 * `triggers`, `only` and `fold`. `label` and `command` are refused as
 * config.toml only. A repository's `.qcr/profile.toml` never carries the
 * table (packages/pi-plugin/src/profileoverrides.ts cuts it), so a repository
 * cannot make its own review security-only or switch its triggers off.
 *
 * `""`, a profile found nowhere and a chain with no `[security]` all mean
 * `{}`; anything malformed in any layer throws with the file named.
 */
export function loadProfileSecurity(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): Partial<SecurityConfig> {
  let merged: Partial<SecurityConfig> = {};
  for (const layer of chainOf(root, profile, lookup, true)) {
    if (layer.security === undefined) continue;
    const where = `[review] profile "${layer.name}": ${layer.toml}`;
    merged = { ...merged, ...parseSecurityTable(where, layer.security, SECURITY_PROFILE_KEYS) };
  }
  return merged;
}

/**
 * The tuning map a review of ONE family runs with: every lens of `passes`
 * outside `family` and the validator is `enabled = false`. What
 * `securityOnlyLenses` says of the security family holds for any family
 * passed here; `explicit` is read the same way.
 */
export function familyOnlyLenses(
  family: readonly string[],
  lenses: Readonly<Record<string, LensTuning>> | undefined,
  passes: readonly string[] = ALL_PASSES,
  explicit: Readonly<Record<string, LensTuning>> | undefined = lenses,
): Record<string, LensTuning> {
  const out: Record<string, LensTuning> = { ...(lenses ?? {}) };
  for (const lens of passes) {
    if (family.includes(lens) || lens === VALIDATE_PASS) continue;
    const written = explicit?.[lens]?.enabled;
    out[lens] = { ...out[lens], enabled: written ?? false };
  }
  return out;
}

/**
 * The tuning map a security-only review runs with: every lens of `passes`
 * outside the security family and the validator is `enabled = false`,
 * through the same switch a profile writes by hand, so every consumer that
 * honours `enabled` (the plan, the add list, the sweep, behaviour-delta)
 * drops it without knowing about `only`. A lens added to `ALL_PASSES` later
 * is covered with no edit. An explicit `enabled` the profile wrote is kept,
 * either way — and `explicit` says which values count as written by the
 * profile: the named chain's tuning alone, never the repository's
 * `.qcr/profile.toml` (a repository cannot switch a non-security lens back
 * on in a security-only review). It defaults to `lenses` itself, for a
 * caller whose map has no repo layer in it.
 */
export function securityOnlyLenses(
  lenses: Readonly<Record<string, LensTuning>> | undefined,
  passes: readonly string[] = ALL_PASSES,
  explicit: Readonly<Record<string, LensTuning>> | undefined = lenses,
): Record<string, LensTuning> {
  return familyOnlyLenses(SECURITY_FAMILY, lenses, passes, explicit);
}

/**
 * The config with the profile's `[security]` overlaid — the profile wins
 * over config.toml for `triggers`, `only` and `fold` — and what follows from
 * it resolved once, so every consumer reads one answer:
 *   * `only` switches every lens outside the family and the validator off in
 *     `cfg.lenses` (`securityOnlyLenses`; `passes` is `ALL_PASSES`);
 *   * each `[lenses.<pass>] risk = true` lens joins `models.risk_passes`. A
 *     `[models.pass_tiers]` pin or a `[models.pass_models]` override on such a
 *     lens is refused: a risk pass always runs at deep on its tier's
 *     model, and a profile that asked for both asked for something this
 *     cannot honour.
 * Run after the lens tuning is overlaid (it reads `cfg.lenses`). `explicit`
 * is the named chain's own tuning, when `cfg.lenses` carries a repo layer
 * (`securityOnlyLenses`).
 */
export function applyProfileSecurity<
  C extends {
    review: { profile: string };
    lenses?: Record<string, LensTuning>;
    security?: SecurityConfig;
    models: Pick<ModelsConfig, "risk_passes" | "pass_tiers" | "pass_models">;
  },
>(
  cfg: C,
  overrides: Partial<SecurityConfig>,
  passes: readonly string[] = ALL_PASSES,
  explicit: Readonly<Record<string, LensTuning>> | undefined = cfg.lenses,
): C {
  const security: SecurityConfig = { ...SECURITY_DEFAULTS, ...cfg.security, ...overrides };
  const risky = profileRiskLenses(cfg.lenses);
  for (const lens of risky) {
    const where = `[review] profile "${cfg.review.profile}": [lenses.${lens}] risk = true`;
    if (Object.hasOwn(cfg.models.pass_tiers, lens)) {
      // A shipped default pin cannot be removed, only replaced: say so.
      const shipped = DEFAULT_PASS_TIERS[lens];
      if (shipped !== undefined && cfg.models.pass_tiers[lens] === shipped)
        throw new Error(
          `${where}, but ${lens} is pinned to ${shipped} by the shipped default ([models.pass_tiers] in code) — it already runs pinned, so drop risk = true from the profile`,
        );
      throw new Error(
        `${where}, but [models.pass_tiers] pins ${lens} — a risk pass always runs at ${RISK_TIER}; remove one of the two`,
      );
    }
    if (Object.hasOwn(cfg.models.pass_models, lens))
      throw new Error(
        `${where}, but [models.pass_models] moves ${lens} — a risk pass always runs on the ${RISK_TIER} tier's model; remove one of the two`,
      );
  }
  return {
    ...cfg,
    security,
    ...(security.only ? { lenses: securityOnlyLenses(cfg.lenses, passes, explicit) } : {}),
    models: {
      ...cfg.models,
      risk_passes: [...new Set([...cfg.models.risk_passes, ...risky])],
    },
  };
}

// ---- the state-machine table --------------------------------------------------

/**
 * The named profile's overrides of `config.toml [state_machines]` —
 * `[state_machines]` in `profile.toml`, the whole `extends` chain merged (per
 * key, the nearest profile that sets it wins). Only
 * `STATE_MACHINES_PROFILE_KEYS` may appear: `triggers` and `only`. `label`
 * and `command` are refused as config.toml only. A repository's
 * `.qcr/profile.toml` never carries the table
 * (packages/pi-plugin/src/profileoverrides.ts cuts it), so a repository
 * cannot make its own review state-machine-only or switch its triggers off.
 *
 * `""`, a profile found nowhere and a chain with no `[state_machines]` all
 * mean `{}`; anything malformed in any layer throws with the file named.
 */
export function loadProfileStateMachines(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): Partial<StateMachinesConfig> {
  let merged: Partial<StateMachinesConfig> = {};
  for (const layer of chainOf(root, profile, lookup, true)) {
    if (layer.state_machines === undefined) continue;
    const where = `[review] profile "${layer.name}": ${layer.toml}`;
    merged = {
      ...merged,
      ...parseStateMachinesTable(where, layer.state_machines, STATE_MACHINES_PROFILE_KEYS),
    };
  }
  return merged;
}

/**
 * The config with the profile's `[state_machines]` overlaid — the profile
 * wins over config.toml for `triggers` and `only`. `only` switches every lens
 * outside the state-machine family and the validator off in `cfg.lenses`
 * (`familyOnlyLenses`), read as the security table's `only` is. Two families
 * cannot each be the only one: `[security] only` beside `[state_machines]
 * only` would leave the validator alone, with no lens to hand it anything,
 * so it is refused. Run after `applyProfileSecurity` (it reads
 * `cfg.security`).
 */
export function applyProfileStateMachines<
  C extends {
    review: { profile: string };
    lenses?: Record<string, LensTuning>;
    security?: SecurityConfig;
    state_machines?: StateMachinesConfig;
  },
>(
  cfg: C,
  overrides: Partial<StateMachinesConfig>,
  passes: readonly string[] = ALL_PASSES,
  explicit: Readonly<Record<string, LensTuning>> | undefined = cfg.lenses,
): C {
  const state_machines: StateMachinesConfig = {
    ...STATE_MACHINES_DEFAULTS,
    ...cfg.state_machines,
    ...overrides,
  };
  if (state_machines.only && cfg.security?.only === true)
    throw new Error(
      `[review] profile "${cfg.review.profile}": [security] only and [state_machines] only are both true — a review can keep one family alone, never two; set one of them false`,
    );
  return {
    ...cfg,
    state_machines,
    ...(state_machines.only
      ? { lenses: familyOnlyLenses(STATE_FAMILY, cfg.lenses, passes, explicit) }
      : {}),
  };
}

/**
 * A tuned config with the profile's two family tables overlaid — `[security]`
 * (`applyProfileSecurity`), then `[state_machines]`
 * (`applyProfileStateMachines`). `explicit` is the named chain's own tuning,
 * so a repository's `.qcr/profile.toml` cannot switch a lens back on in a
 * one-family review. Every route that resolves a config — the daemon's
 * overlays and the scan's — applies both through this one function.
 */
export function applyProfileFamilies<
  C extends {
    review: { profile: string };
    lenses?: Record<string, LensTuning>;
    security?: SecurityConfig;
    state_machines?: StateMachinesConfig;
    models: Pick<ModelsConfig, "risk_passes" | "pass_tiers" | "pass_models">;
  },
>(root: string, cfg: C, lookup: ProfileLookup = {}): C {
  const profile = cfg.review.profile;
  const explicit = loadProfileLensTuning(root, profile, { ...lookup, repoProfile: undefined });
  return applyProfileStateMachines(
    applyProfileSecurity(cfg, loadProfileSecurity(root, profile, lookup), ALL_PASSES, explicit),
    loadProfileStateMachines(root, profile, lookup),
    ALL_PASSES,
    explicit,
  );
}

/**
 * The posting scope a one-family review implies: `security` for a
 * security-only review, `state` for a state-machine-only one, none
 * otherwise. Applies only where the named chain sets no `[posting] scope`;
 * the daemon's overlays and the shell render route both read it.
 */
export function onlyPostingScope(families: {
  security?: Pick<SecurityConfig, "only">;
  state_machines?: Pick<StateMachinesConfig, "only">;
}): PostingScope | undefined {
  if (families.security?.only === true) return "security";
  if (families.state_machines?.only === true) return "state";
  return undefined;
}

/**
 * A parsed config with its profile's overlays applied — the per-lens tuning,
 * then the `[security]` table (`applyProfileSecurity`), then the `[posting]`
 * policy — so `cfg.lenses`, `cfg.security`, `cfg.models.risk_passes` and
 * `cfg.posting` are the one resolved answer (the profile wins over
 * config.toml, the preset and the defaults). The `[state_machines]` table
 * follows the security one (`applyProfileStateMachines`). A security-only
 * review posts only security findings: `[posting] scope` becomes `security`
 * unless the named profile chain sets it; a state-machine-only review's
 * becomes `state` the same way. What a security-only review keeps is the
 * named chain's to say, never the repo layer's: a repository's
 * `[lenses.<pass>] enabled = true` on a non-security lens, or its
 * `[posting] scope`, cannot widen it. The daemon's assembly, the one-shot review and the
 * regression replay resolve through this one function, so each plans rounds
 * exactly as the daemon does.
 */
export function applyProfileOverlays<
  C extends {
    review: { profile: string };
    lenses?: Record<string, LensTuning>;
    posting?: PostingPolicy;
    security?: SecurityConfig;
    state_machines?: StateMachinesConfig;
    models: Pick<ModelsConfig, "risk_passes" | "pass_tiers" | "pass_models">;
  },
>(root: string, cfg: C, lookup: ProfileLookup = {}): C {
  const profile = cfg.review.profile;
  const named: ProfileLookup = { ...lookup, repoProfile: undefined };
  const secured = applyProfileFamilies(
    root,
    applyProfileTuning(cfg, loadProfileLensTuning(root, profile, lookup)),
    lookup,
  );
  const posting = loadProfilePosting(root, profile, lookup);
  // A one-family review posts that family's findings alone, unless the named
  // chain says what posts.
  const only = onlyPostingScope(secured);
  return applyProfilePosting(
    secured,
    only !== undefined && loadProfilePosting(root, profile, named).scope === undefined
      ? { ...posting, scope: only }
      : posting,
  );
}

// ---- the threat model ---------------------------------------------------------

/**
 * The named profile's threat model — `threat-model.md` in a profile's
 * directory, the nearest profile in the `extends` chain that carries one
 * winning whole (a threat model is one document, never merged). Private to
 * the operator's install; the repository's own (`.qcr/threat-model.md` on the
 * base commit, `OverrideSet.repoThreatModel`) wins over it, which is why the
 * repo layer is not walked here. The text is returned as written:
 * packages/pi-plugin/src/threatmodel.ts `parseThreatModel` cuts it at
 * `THREAT_MODEL_MAX_CHARS` with a marker.
 *
 * `""`, a profile found nowhere, and a chain where no profile carries a
 * non-blank one all mean null — no threat model, so no section is rendered.
 * A file that exists and cannot be read throws, naming it: the loud-boot
 * contract.
 */
export function loadProfileThreatModel(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): string | null {
  for (const layer of namedChain(root, profile, lookup, true).reverse()) {
    const file = join(layer.dir, PROFILE_THREAT_MODEL_FILE);
    if (!existsSync(file)) continue;
    let text: string;
    try {
      if (!statSync(file).isFile()) throw new Error("is not a file");
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(
        `[review] profile "${layer.name}": cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (text.trim() !== "") return text;
  }
  return null;
}

/** The config with the profile's `[scan]` overrides applied — the profile
 * wins over config.toml, as it does for per-lens tuning. */
export function applyProfileScan<C extends { scan: ScanConfig }>(
  cfg: C,
  overrides: Partial<ScanConfig>,
): C {
  return { ...cfg, scan: { ...cfg.scan, ...overrides } };
}

// ---- lens-selection heuristics ---------------------------------------------
//
// A profile's `heuristics.toml` carries the repo-shaped lens-selection
// predicates (framework settings-file globs, management-command dirs, a
// product-local decorator name, …) as per-lens extra path regexes and
// added-line probes. The generic selection core stays compiled into
// `packages/pi-plugin/src/heuristics.ts selectLenses`; the extension can only ADD predicates to
// the lenses that module already selects by shape — never remove or weaken a
// compiled-in one, and never touch the addable-only lenses or the body-keyed
// `pass-intent`.
//
// File format — one table per extendable lens, four optional keys each:
//
//   [pass-security]
//   paths = ['(^|/)settings[^/]*\.py$']       # RegExp sources over filenames
//
//   [pass-delivery]
//   added_lines = ['@background_task']   # probes over ADDED patch lines
//
//   [pass-sec-authn-coverage]
//   removed_lines = ['@login_required']  # probes over REMOVED patch lines
//   config_lines = ['AuthType:\s*NONE']  # probes over ADDED lines of config files
//
// `removed_lines` and `config_lines` are read by the security family's
// triggers alone (securitytriggers.ts): the compiled-in `selectLenses` reads
// `paths` and `added_lines` only. So they are accepted for a `pass-sec-*`
// lens and refused for any other — a probe the selection never reads would
// be configured and silently never fire.
//
// `paths` entries are compiled verbatim (case-sensitive, like the compiled-in
// path predicates). `added_lines` and `config_lines` entries are wrapped as
// `^\+.*(?:…)` with the `im` flags, so each one matches an ADDED unified-diff
// line containing the pattern, case-insensitively; a `config_lines` probe is
// tested against configuration files only (the security triggers'
// `CONFIG_FILE_RE`). `removed_lines` entries are wrapped as `^-(?!--).*(?:…)`,
// a REMOVED line and never the `--- a/<file>` header. Anything malformed — an unknown lens, an
// unknown key, a non-string entry, a regex that does not compile — throws
// with the offending file and key named: a malformed extension is a loud
// assembly failure (wire.ts loads it once at boot), never a silent skip.
// An ABSENT heuristics.toml is not malformed: a profile that only carries
// addenda simply extends selection with nothing.

/** Parse ONE heuristics.toml's raw bytes. Throws (naming `file`) on anything
 * malformed — the same loud-failure contract as the addenda pack. */
export function parseProfileHeuristics(file: string, raw: string): HeuristicsExtension {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(raw);
  } catch (err) {
    throw new Error(
      `profile heuristics ${file}: not valid TOML — ${String(err instanceof Error ? err.message : err)}`,
      { cause: err },
    );
  }
  const paths: Record<string, RegExp[]> = {};
  const addedLines: Record<string, RegExp[]> = {};
  const removedLines: Record<string, RegExp[]> = {};
  const configLines: Record<string, RegExp[]> = {};
  const compile = (
    lens: string,
    key: string,
    value: unknown,
    wrap: (src: string) => RegExp,
  ): RegExp[] => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new Error(`profile heuristics ${file}: [${lens}] ${key} must be an array of strings`);
    }
    return (value as string[]).map((src) => {
      if (src.trim() === "")
        throw new Error(`profile heuristics ${file}: [${lens}] ${key} contains an empty pattern`);
      try {
        return wrap(src);
      } catch (err) {
        throw new Error(
          `profile heuristics ${file}: [${lens}] ${key} pattern ${JSON.stringify(src)} is not a valid RegExp — ${String(err instanceof Error ? err.message : err)}`,
          { cause: err },
        );
      }
    });
  };
  for (const [lens, table] of Object.entries(doc)) {
    if (!PROFILE_EXTENDABLE_LENSES.includes(lens)) {
      throw new Error(
        `profile heuristics ${file}: [${lens}] is not an extendable lens — allowed: ${PROFILE_EXTENDABLE_LENSES.join(", ")} ` +
          `(pass-intent is body-keyed, pass-placement/pass-simplicity are status/size-computed, ` +
          `pass-concurrency is content-triggered only; pass-ask-human is addable-only by ratified decision)`,
      );
    }
    if (typeof table !== "object" || table === null || Array.isArray(table)) {
      throw new Error(
        `profile heuristics ${file}: [${lens}] must be a table of "paths", "added_lines", "removed_lines" and/or "config_lines" arrays`,
      );
    }
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (key === "paths") {
        paths[lens] = compile(lens, key, value, (src) => new RegExp(src));
      } else if (key === "added_lines") {
        // `^\+.*(?:…)` per probe: an ADDED unified-diff line containing the
        // pattern. Case-insensitive by contract (documented above) — the one
        // deliberate generalisation over the compiled-in probes, which mixed
        // `m` and `im`.
        addedLines[lens] = compile(lens, key, value, (src) => {
          new RegExp(src); // validate the source on its own for a clean error
          return new RegExp(`^\\+.*(?:${src})`, "im");
        });
      } else if (
        (key === "removed_lines" || key === "config_lines") &&
        !SECURITY_FAMILY.includes(lens)
      ) {
        throw new Error(
          `profile heuristics ${file}: [${lens}] ${key} is read only for a security-family lens (pass-sec-*) — ` +
            `${lens}'s selection reads "paths" and "added_lines"`,
        );
      } else if (key === "removed_lines") {
        // `^-(?!--)`: a REMOVED line, never the `--- a/<file>` header a
        // whole-file patch can carry.
        removedLines[lens] = compile(lens, key, value, (src) => {
          new RegExp(src);
          return new RegExp(`^-(?!--).*(?:${src})`, "im");
        });
      } else if (key === "config_lines") {
        configLines[lens] = compile(lens, key, value, (src) => {
          new RegExp(src);
          return new RegExp(`^\\+.*(?:${src})`, "im");
        });
      } else {
        throw new Error(
          `profile heuristics ${file}: [${lens}] unknown key "${key}" — only "paths", "added_lines", "removed_lines" and "config_lines" are allowed`,
        );
      }
    }
  }
  return withLineProbes({ paths, addedLines }, removedLines, configLines);
}

/** `ext` with the removed-line and config-line probes, each only when some
 * lens has one, so an extension without them keeps its two-key shape. */
function withLineProbes(
  ext: HeuristicsExtension,
  removedLines: Record<string, RegExp[]>,
  configLines: Record<string, RegExp[]>,
): HeuristicsExtension {
  return {
    ...ext,
    ...(Object.keys(removedLines).length > 0 ? { removedLines } : {}),
    ...(Object.keys(configLines).length > 0 ? { configLines } : {}),
  };
}

/**
 * Load the named profile's lens-heuristics extension.
 *
 * `""` (no profile) and a profile chain without a `heuristics.toml` anywhere
 * both yield the empty extension — the generic compiled-in core alone.
 * Everything else that is wrong throws; the caller (wire.ts, at daemon
 * assembly) lets it crash the boot rather than review with partial selection
 * knowledge.
 */
export function loadProfileHeuristics(
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): HeuristicsExtension {
  // Unioned across the chain, per lens, base predicates first —
  // heuristics only ever ADD, so a child can neither drop nor narrow a
  // base's predicate (the same ADD-only contract as against the core).
  const paths: Record<string, RegExp[]> = {};
  const addedLines: Record<string, RegExp[]> = {};
  const removedLines: Record<string, RegExp[]> = {};
  const configLines: Record<string, RegExp[]> = {};
  let any = false;
  for (const layer of chainOf(root, profile, lookup, false)) {
    const file = join(layer.dir, "heuristics.toml");
    if (!existsSync(file)) continue;
    any = true;
    const ext = parseProfileHeuristics(file, readFileSync(file, "utf8"));
    for (const [lens, res = []] of Object.entries(ext.paths))
      paths[lens] = [...(paths[lens] ?? []), ...res];
    for (const [lens, res = []] of Object.entries(ext.addedLines))
      addedLines[lens] = [...(addedLines[lens] ?? []), ...res];
    for (const [lens, res = []] of Object.entries(ext.removedLines ?? {}))
      removedLines[lens] = [...(removedLines[lens] ?? []), ...res];
    for (const [lens, res = []] of Object.entries(ext.configLines ?? {}))
      configLines[lens] = [...(configLines[lens] ?? []), ...res];
  }
  return any ? withLineProbes({ paths, addedLines }, removedLines, configLines) : EMPTY_HEURISTICS;
}
