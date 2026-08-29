// Repo-profile addenda packs.
//
// A profile is a directory under `profiles/<name>/` whose `addenda/*.md` files
// carry house-rule pass addenda — the same `PassAddendum` shape the compiled-in
// registry (`PASS_ADDENDA`, src/include.ts) declares, authored as files so an
// operator can match the reviewer's house-rule knowledge to their repo without
// editing this codebase. The addendum registry remains the ONE composition
// mechanism: a pack does not bypass it, it EXTENDS it — wire.ts appends the
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
// is a LOUD build failure, never a silent skip.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { EcosystemName } from "./ecosystem.js";
import { EMPTY_HEURISTICS, PROFILE_EXTENDABLE_LENSES } from "./heuristics.js";
import type { HeuristicsExtension } from "./heuristics.js";
import { PASS_ADDENDA, splitFrontmatter } from "./include.js";
import type { PassAddendum, PassAddendumScope } from "./include.js";

/** Where a named profile lives, relative to the sandbox root. */
export function profileDir(root: string, profile: string): string {
  return join(root, "profiles", profile);
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PASS_NAME_RE = /^pass-[a-z0-9][a-z0-9-]*$/;

/** Ids a pack may not claim: every compiled-in entry, plus the dynamic
 * same-day feedback addendum wire.ts composes last (src/feedback.ts). */
export function reservedAddendumIds(): Set<string> {
  return new Set([...PASS_ADDENDA.map((a) => a.id), "feedback-day-validate"]);
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
      throw new Error(`profile addendum ${file}: unknown scope "${raw}" — use "all", "lenses", or a comma-separated list of pass names (pass-…)`);
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
    if (!m) throw new Error(`profile addendum ${file}: unrecognized frontmatter line "${line}" — only "id:" and "scope:" are allowed`);
    const key = m[1] as string;
    const value = m[2] as string;
    if (fields.has(key)) throw new Error(`profile addendum ${file}: duplicate frontmatter key "${key}"`);
    fields.set(key, value);
  }
  const id = fields.get("id");
  if (id === undefined) throw new Error(`profile addendum ${file}: missing "id:" in frontmatter`);
  if (!ID_RE.test(id)) throw new Error(`profile addendum ${file}: id "${id}" must be kebab-case ([a-z0-9-])`);
  const rawScope = fields.get("scope");
  if (rawScope === undefined) throw new Error(`profile addendum ${file}: missing "scope:" in frontmatter`);
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

/**
 * Load the named profile's addenda pack, in composition order.
 *
 * Order is ascending filename sort and nothing else — deterministic by
 * construction, so a rebuild of an unchanged tree stays byte-identical, same
 * contract as the compiled-in registry's declaration order. Every failure is
 * a throw; the caller (wire.ts, at daemon assembly) is expected to let it
 * crash the boot rather than review with a partial pack.
 */
export function loadProfileAddenda(root: string, profile: string): PassAddendum[] {
  if (profile === "") return [];
  const dir = profileDir(root, profile);
  mustBeDir(dir, `[review] profile "${profile}" not found`);
  const addendaDir = join(dir, "addenda");
  mustBeDir(addendaDir, `[review] profile "${profile}" has no addenda/ directory`);
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
      throw new Error(`profile addendum ${path}: id "${entry.id}" collides with a built-in registry entry`);
    }
    if (seen.has(entry.id)) throw new Error(`profile addendum ${path}: duplicate id "${entry.id}" within the pack`);
    seen.add(entry.id);
    loaded.push(entry);
  }
  return loaded;
}

/**
 * The profile's ecosystem selection: `profiles/<name>/profile.toml`,
 * key `ecosystem = "django" | "none"`.
 *
 * No profile (`""`), no `profile.toml`, or no `ecosystem` key all mean
 * `"none"` — a generic install gets NO framework-specific machinery (no
 * pre-check, no tier-forcing migration gate, no migration-gate prompt prose)
 * unless its profile asks for it. An unreadable file or an unknown value
 * throws with the path named — a loud boot failure, same contract as the
 * addenda loader above: a daemon must never review under a profile it could
 * not parse.
 *
 * Deliberately its OWN function rather than a fold into `loadProfileAddenda`:
 * `profile.toml` is the profile's settings file and other loaders may own
 * other keys in it (each reads only its own; unknown keys are not an error
 * here), while `addenda/` stays the addenda loader's alone.
 */
export function loadProfileEcosystem(root: string, profile: string): EcosystemName {
  if (profile === "") return "none";
  const path = join(profileDir(root, profile), "profile.toml");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "none";
    throw new Error(`[review] profile "${profile}": cannot read ${path}: ${String(err)}`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`[review] profile "${profile}": ${path} is not valid TOML: ${String(err)}`);
  }
  const eco = doc["ecosystem"];
  if (eco === undefined) return "none";
  if (eco === "django" || eco === "none") return eco;
  throw new Error(
    `[review] profile "${profile}": ${path} names unknown ecosystem ${JSON.stringify(eco)} — use "django" or "none"`,
  );
}

// ---- lens-selection heuristics -----------------------------------
//
// A profile's `heuristics.toml` carries the repo-shaped lens-selection
// predicates (framework settings-file globs, management-command dirs, a
// product-local decorator name, …) as per-lens extra path regexes and
// added-line probes. The generic selection core stays compiled into
// `src/heuristics.ts selectLenses`; the extension can only ADD predicates to
// the lenses that module already selects by shape — never remove or weaken a
// compiled-in one, and never touch the ADDABLE-ONLY lenses or
// the body-keyed `pass-intent`.
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
// with the offending file and key named: a malformed extension is a LOUD
// assembly failure (wire.ts loads it once at boot), never a silent skip.
// An ABSENT heuristics.toml is not malformed: a profile that only carries
// addenda simply extends selection with nothing.

/** Parse ONE heuristics.toml's raw bytes. Throws (naming `file`) on anything
 * malformed — the same loud-failure contract as the addenda pack. */
export function parseProfileHeuristics(file: string, raw: string): HeuristicsExtension {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`profile heuristics ${file}: not valid TOML — ${String(err instanceof Error ? err.message : err)}`);
  }
  const paths: Record<string, RegExp[]> = {};
  const addedLines: Record<string, RegExp[]> = {};
  const compile = (lens: string, key: string, value: unknown, wrap: (src: string) => RegExp): RegExp[] => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new Error(`profile heuristics ${file}: [${lens}] ${key} must be an array of strings`);
    }
    return (value as string[]).map((src) => {
      if (src.trim() === "") throw new Error(`profile heuristics ${file}: [${lens}] ${key} contains an empty pattern`);
      try {
        return wrap(src);
      } catch (err) {
        throw new Error(
          `profile heuristics ${file}: [${lens}] ${key} pattern ${JSON.stringify(src)} is not a valid RegExp — ${String(err instanceof Error ? err.message : err)}`,
        );
      }
    });
  };
  for (const [lens, table] of Object.entries(doc)) {
    if (!PROFILE_EXTENDABLE_LENSES.includes(lens)) {
      throw new Error(
        `profile heuristics ${file}: [${lens}] is not an extendable lens — allowed: ${PROFILE_EXTENDABLE_LENSES.join(", ")} ` +
          `(pass-intent is body-keyed, pass-placement/pass-simplicity are status/size-computed, ` +
          `pass-concurrency/pass-ask-human are addable-only by ratified decision)`,
      );
    }
    if (typeof table !== "object" || table === null || Array.isArray(table)) {
      throw new Error(`profile heuristics ${file}: [${lens}] must be a table with "paths" and/or "added_lines" arrays`);
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
        throw new Error(`profile heuristics ${file}: [${lens}] unknown key "${key}" — only "paths" and "added_lines" are allowed`);
      }
    }
  }
  return { paths, addedLines };
}

/**
 * Load the named profile's lens-heuristics extension.
 *
 * `""` (no profile) and a profile without a `heuristics.toml` both yield the
 * empty extension — the generic compiled-in core alone. Everything else that
 * is wrong throws; the caller (wire.ts, at daemon assembly) lets it crash the
 * boot rather than review with partial selection knowledge.
 */
export function loadProfileHeuristics(root: string, profile: string): HeuristicsExtension {
  if (profile === "") return EMPTY_HEURISTICS;
  const dir = profileDir(root, profile);
  mustBeDir(dir, `[review] profile "${profile}" not found`);
  const file = join(dir, "heuristics.toml");
  if (!existsSync(file)) return EMPTY_HEURISTICS;
  return parseProfileHeuristics(file, readFileSync(file, "utf8"));
}
