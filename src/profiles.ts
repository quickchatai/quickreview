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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { EcosystemName } from "./ecosystem.js";
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
