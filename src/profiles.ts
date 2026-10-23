// Repo-profile addenda packs.
//
// A profile is a directory `profiles/<name>/` whose `addenda/*.md` files
// carry house-rule pass addenda — the same `PassAddendum` shape the compiled-in
// registry (`PASS_ADDENDA`, src/include.ts) declares, authored as files so an
// operator can match the reviewer's house-rule knowledge to their repo without
// editing this codebase. The addendum registry remains the ONE composition
// mechanism: a pack does not bypass it, it extends it — wire.ts appends the
// loaded pack to `PASS_ADDENDA` before calling `buildAgents`, so profile
// entries compose onto built pass bodies AFTER every built-in generic entry
// and BEFORE the dynamic same-day feedback addendum (which wire.ts appends
// last). Seeds stay frozen; nothing here touches `agents/` or `prompts/`.
//
// File format — YAML-shaped frontmatter, two keys only, then the body:
//
//   ---
//   id: migration-discipline
//   scope: pass-data-safety
//   ---
//   ## Migration discipline — … (sandbox rule)
//   …
//
//   * `id`    — stable kebab-case id (what tests and commit messages cite).
//   * `scope` — `all` | `lenses` | a comma-separated list of pass names.
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
// Where a profile lives is the profile search's call (src/profilelookup.ts
// `findProfile`): the homes the caller names (`ProfileLookup.homes`, the
// install's, resolved by src/homes.ts `homeProfileLookup`) first, then the
// checkout's generic examples — every loader below resolves the name through
// it, so a name that could escape `profiles/` is refused before any read.
//
// A repo profile (`.qcr/` on the base branch, src/profileoverrides.ts) rides
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
//     profile that sets it wins.
// The shipped `default` profile encodes the shipped behaviour (an empty pack,
// no heuristics, `ecosystem = "none"`, and `[posting] repeat_sites = false`:
// one comment per root cause) and is the base a generated profile extends. An
// empty child of it reviews as no profile does, but posts each root cause
// once where no profile keeps the code default (`repeat_sites = true`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseScanTable, SCAN_PROFILE_KEYS, type ScanConfig } from "./reviewconfig.js";
import type { EcosystemName } from "./ecosystem.js";
import { ALL_PASSES } from "./dispatch.js";
import { EMPTY_HEURISTICS, PROFILE_EXTENDABLE_LENSES } from "./heuristics.js";
import type { HeuristicsExtension } from "./heuristics.js";
import {
  FEEDBACK_DAY_ADDENDUM_ID,
  LESSON_VALIDATE_ADDENDUM_ID,
  PASS_ADDENDA,
  SCAN_PASS,
  splitFrontmatter,
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
} from "./postingpolicy.js";
import {
  applyProfileTuning,
  LENS_TUNING_ID_PREFIXES,
  mergeLensTuning,
  parseLensTable,
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
  const named =
    profile === "" || (soft && !findProfile({ root, profile, homes: lookup.homes ?? [] }))
      ? []
      : profileChain(root, profile, lookup);
  return [...repoLayer(lookup), ...named];
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
    // delivery = "on"` (src/include.ts lessonAddenda).
    LESSON_VALIDATE_ADDENDUM_ID,
    // The addendum `[posting]` compiles into (src/postingpolicy.ts).
    ...POSTING_ADDENDUM_IDS,
  ]);
}

function parseScope(raw: string, file: string): PassAddendumScope {
  if (raw === "all" || raw === "lenses") return raw;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) throw new Error(`profile addendum ${file}: empty scope`);
  for (const n of names) {
    if (!PASS_NAME_RE.test(n)) {
      throw new Error(
        `profile addendum ${file}: unknown scope "${raw}" — use "all", "lenses", or a comma-separated list of pass names (pass-…)`,
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
  return names;
}

/** Parse ONE addendum file's raw bytes. Throws (naming `file`) on anything
 * malformed — the loud-failure contract. */
export function parseProfileAddendum(file: string, raw: string): PassAddendum {
  const doc = splitFrontmatter(raw);
  if (!doc.hasFrontmatter) {
    throw new Error(`profile addendum ${file}: missing frontmatter (--- id/scope fences)`);
  }
  const fields = new Map<string, string>();
  for (const line of doc.frontmatter.split("\n")) {
    if (line.trim() === "") continue;
    const m = /^(id|scope):[ \t]*(.+?)[ \t]*$/.exec(line);
    if (!m)
      throw new Error(
        `profile addendum ${file}: unrecognized frontmatter line "${line}" — only "id:" and "scope:" are allowed`,
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
  if (doc.body.trim() === "") throw new Error(`profile addendum ${file}: empty body`);
  // "\n" + verbatim body: byte-compatible with the compiled-in constants,
  // which each begin with a newline separator.
  return { id, scope, text: `\n${doc.body}` };
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
 * that sets it wins). The keys and what each one moves are src/lenstuning.ts's
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
 * (src/postingpolicy.ts) resolves them over today's defaults.
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

/**
 * A parsed config with its profile's overlays applied — the per-lens tuning,
 * then the `[posting]` policy — so `cfg.lenses` and `cfg.posting` are the one
 * resolved answer (the profile wins over config.toml, the preset and the
 * defaults). The daemon's assembly and the regression replay resolve through
 * this one function, so a replay plans rounds exactly as the daemon does.
 */
export function applyProfileOverlays<
  C extends {
    review: { profile: string };
    lenses?: Record<string, LensTuning>;
    posting?: PostingPolicy;
  },
>(root: string, cfg: C, lookup: ProfileLookup = {}): C {
  const profile = cfg.review.profile;
  return applyProfilePosting(
    applyProfileTuning(cfg, loadProfileLensTuning(root, profile, lookup)),
    loadProfilePosting(root, profile, lookup),
  );
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
// `src/heuristics.ts selectLenses`; the extension can only ADD predicates to
// the lenses that module already selects by shape — never remove or weaken a
// compiled-in one, and never touch the addable-only lenses or the body-keyed
// `pass-intent`.
//
// File format — one table per extendable lens, two optional keys each:
//
//   [pass-security]
//   paths = ['(^|/)settings[^/]*\.py$']       # RegExp sources over filenames
//
//   [pass-delivery]
//   added_lines = ['@background_decorator']   # probes over ADDED patch lines
//
// `paths` entries are compiled verbatim (case-sensitive, like the compiled-in
// path predicates). `added_lines` entries are wrapped as `^\+.*(?:…)` with
// the `im` flags, so each one matches an ADDED unified-diff line containing
// the pattern, case-insensitively. Anything malformed — an unknown lens, an
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
        `profile heuristics ${file}: [${lens}] must be a table with "paths" and/or "added_lines" arrays`,
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
      } else {
        throw new Error(
          `profile heuristics ${file}: [${lens}] unknown key "${key}" — only "paths" and "added_lines" are allowed`,
        );
      }
    }
  }
  return { paths, addedLines };
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
  }
  return any ? { paths, addedLines } : EMPTY_HEURISTICS;
}
