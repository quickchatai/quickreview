// The repo profile, as setup reads, validates and writes it (setup &
// scan spec "Profile resolution" + "Interview mapping").
//
// VALIDATION IS THE DAEMON'S OWN. `checkProfile` resolves a profile through
// every loader the daemon runs at boot (src/profiles.ts — the addenda pack,
// the ecosystem, the per-lens tuning, the heuristics, the `[scan]` table —
// and the addenda the tuning compiles into), so "valid here" means "boots
// there". The same check serves a DIRECT edit (the operator's editor; the
// companion's `setup_profile_validate`, `qcr setup validate`) and every write
// this file makes.
//
// A WRITE IS STAGED FIRST. The candidate files go into a scratch copy of the
// config home's `profiles/`, the scratch copy is checked, and only a profile
// that passes reaches the real directory — tmp+rename, file by file. A
// refused write changes nothing.
//
// THE EDIT IS SURGICAL. `profile.toml` is the operator's file too (comments,
// `extends`, `ecosystem`, `[addenda]`, `[scan]`): only the `[lenses.<pass>]`
// tables a write actually changes are regenerated; every other byte is kept.
// The result is re-parsed and must say exactly what was intended — a file
// that spells its lenses some other way (an inline table, dotted keys) is
// refused with "edit it by hand" rather than half-edited.
//
// Where: the install's config home, `profiles/<name>/` (src/install.ts). The
// checkout's generic examples (`default` and kin) are never written — setup
// writes the install's OWN profile, which extends one of them.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ScanConfig } from "../config.js";
import {
  assertPathSegment,
  configHome,
  EXAMPLE_PROFILES,
  locateConfig,
  locateProfile,
  PROFILES_DIR,
  type InstallEnv,
} from "../install.js";
import { LENS_TUNING_KEYS, lensTuningAddenda, type LensTuning } from "../lenstuning.js";
import {
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  loadProfileLensTuning,
  loadProfileScan,
  resolveProfileChain,
} from "../profiles.js";

/** Where profiles are looked up and written: the app checkout (the generic
 * examples) and the install environment the locator reads. */
export interface ProfileHome {
  root: string;
  env: InstallEnv;
}

export const PROFILE_FILE = "profile.toml";
/** The style guide setup drafts into a profile for a repo that writes none. */
export const DRAFTED_GUIDE_FILE = "style-guide.md";
/** What a new profile extends (the shipped behaviour). */
export const DEFAULT_BASE = "default";

// ---- which profile ---------------------------------------------------------

export type ProfileTarget =
  | { state: "ok"; config: string; named: string }
  | { state: "absent" | "unreadable"; config: string; error: string };

/** The profile the live config names (`[review] profile`; `""` = none). Read
 * as plain TOML — never `loadConfig`, which also demands files the companion
 * does not mount. */
export function readProfileTarget(home: ProfileHome): ProfileTarget {
  let config: string;
  try {
    config = locateConfig({ env: home.env }).path;
  } catch (err) {
    return { state: "unreadable", config: "(unlocatable)", error: String(err) };
  }
  let text: string;
  try {
    text = readFileSync(config, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { state: "absent", config, error: `${config} does not exist` }
      : { state: "unreadable", config, error: `${config} cannot be read: ${String(err)}` };
  }
  try {
    const doc = parseToml(text) as { review?: { profile?: unknown } };
    const named = doc.review?.profile;
    return { state: "ok", config, named: typeof named === "string" ? named.trim() : "" };
  } catch (err) {
    return { state: "unreadable", config, error: `${config} is not valid TOML: ${String(err)}` };
  }
}

/** The directory setup writes profile `name` to. */
export function writableProfileDir(home: ProfileHome, name: string): string {
  return join(configHome(home.env), PROFILES_DIR, assertPathSegment("profile", name));
}

// ---- the check ---------------------------------------------------------------

/** What a valid profile resolves to — what the daemon would review with. */
export interface ProfileSummary {
  name: string;
  /** Base first; each with where it was found. */
  chain: Array<{ name: string; dir: string }>;
  ecosystem: string;
  addenda: string[];
  /** Per lens, the resolved keys (a guide by its file name). */
  lenses: Record<string, Record<string, string | boolean>>;
  /** Lenses the heuristics extension adds predicates to. */
  heuristics: string[];
  scan: Partial<ScanConfig>;
}

export type ProfileCheck = { ok: true; summary: ProfileSummary } | { ok: false; errors: string[] };

/** A lens tuning as plain values (a guide by the file name it was given). */
export function plainTuning(t: LensTuning): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const key of LENS_TUNING_KEYS) {
    const v = t[key];
    if (v === undefined) continue;
    out[key] = typeof v === "object" ? v.file : v;
  }
  return out;
}

/** Resolve `name` through every loader the daemon boots with. Any throw is
 * the answer — the daemon would refuse to start on the same profile. */
export function checkProfile(home: ProfileHome, name: string): ProfileCheck {
  const lookup = { env: home.env };
  try {
    assertPathSegment("profile", name);
    if (!locateProfile({ root: home.root, profile: name, env: home.env })) {
      return { ok: false, errors: [`profile "${name}" not found — not in ${join(configHome(home.env), PROFILES_DIR)}, and not a generic example`] };
    }
    const chain = resolveProfileChain(home.root, name, lookup);
    const addenda = loadProfileAddenda(home.root, name, lookup);
    const ecosystem = loadProfileEcosystem(home.root, name, lookup);
    const lenses = loadProfileLensTuning(home.root, name, lookup);
    const heuristics = loadProfileHeuristics(home.root, name, lookup);
    const scan = loadProfileScan(home.root, name, lookup);
    lensTuningAddenda(lenses); // compiles at build; a throw here is a boot failure too
    return {
      ok: true,
      summary: {
        name,
        chain,
        ecosystem,
        addenda: addenda.map((a) => a.id),
        lenses: Object.fromEntries(Object.entries(lenses).map(([lens, t]) => [lens, plainTuning(t)])),
        heuristics: [...new Set([...Object.keys(heuristics.paths), ...Object.keys(heuristics.addedLines)])].sort(),
        scan,
      },
    };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/** A check, for reading: whether the daemon would boot with the profile, and
 * what it resolves to. The companion's tools and `qcr setup validate` share it. */
export function describeCheck(profile: string, c: ProfileCheck): string {
  if (!c.ok) {
    return `Profile "${profile}" would NOT load — the daemon refuses to boot on it:\n${c.errors.map((e) => `  ✗ ${e}`).join("\n")}`;
  }
  return `Profile "${profile}" loads — the daemon would boot with it:\n${describeSummary(c.summary)}`;
}

/** The resolved profile, one fact per line. */
export function describeSummary(s: ProfileSummary): string {
  const lenses = Object.entries(s.lenses).map(
    ([lens, t]) =>
      `    - ${lens}: ${Object.entries(t)
        .filter(([k]) => k !== "emphasis")
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join(", ")}${t.emphasis !== undefined ? `${Object.keys(t).length > 1 ? " " : ""}(+ emphasis)` : ""}`,
  );
  return [
    `  chain: ${s.chain.map((l) => l.name).join(" → ")}`,
    `  ecosystem: ${s.ecosystem}; addenda: ${s.addenda.length === 0 ? "none" : s.addenda.join(", ")}`,
    `  lenses tuned:${lenses.length === 0 ? " none" : `\n${lenses.join("\n")}`}`,
    ...(s.heuristics.length > 0 ? [`  heuristics extend: ${s.heuristics.join(", ")}`] : []),
    ...(Object.keys(s.scan).length > 0 ? [`  [scan]: ${JSON.stringify(s.scan)}`] : []),
  ].join("\n");
}

// ---- the surgical edit ---------------------------------------------------------

/** A lens table's raw values, as TOML holds them. */
export type RawLensTable = Record<string, string | boolean>;

/** Per lens, per key: the new value, or null to remove the key. */
export type LensChanges = Record<string, Record<string, string | boolean | null>>;

const HEADER_RE = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/;
const LENS_HEADER_RE = /^lenses\.([A-Za-z0-9_-]+)$/;

function renderValue(v: string | boolean): string {
  // A JSON string is a valid TOML basic string (same escapes, \uXXXX
  // included), so a multi-line emphasis stays one well-formed line.
  return typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

function renderTable(lens: string, table: RawLensTable): string[] {
  const keys = [...LENS_TUNING_KEYS.filter((k) => k in table), ...Object.keys(table).filter((k) => !(LENS_TUNING_KEYS as readonly string[]).includes(k)).sort()];
  return [`[lenses.${lens}]`, ...keys.map((k) => `${k} = ${renderValue(table[k] as string | boolean)}`)];
}

function rawLenses(doc: Record<string, unknown>): Record<string, RawLensTable> {
  const raw = doc["lenses"];
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("[lenses] is not a table");
  const out: Record<string, RawLensTable> = {};
  for (const [lens, body] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error(`[lenses.${lens}] is not a table`);
    const t: RawLensTable = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "boolean") throw new Error(`[lenses.${lens}] ${k} is neither a string nor a boolean`);
      t[k] = v;
    }
    out[lens] = t;
  }
  return out;
}

const sameTables = (a: Record<string, RawLensTable>, b: Record<string, RawLensTable>): boolean => {
  const norm = (x: Record<string, RawLensTable>): string =>
    JSON.stringify(
      Object.keys(x)
        .sort()
        .map((l) => [l, Object.keys(x[l]!).sort().map((k) => [k, x[l]![k]])]),
    );
  return norm(a) === norm(b);
};

/** A new profile.toml: extends a base, says why it exists. */
export function newProfileText(base: string): string {
  return (
    "# The repo profile setup writes. The [lenses.<pass>] tables are\n" +
    "# kept in step with the setup interview by `setup_profile_apply`; edit\n" +
    "# anything by hand too, then check it with `qcr setup validate`.\n" +
    `extends = ${JSON.stringify(base)}\n`
  );
}

/**
 * Apply `changes` to a profile.toml's `[lenses.*]` tables, keeping every
 * other byte. A changed lens's table is regenerated in place (its own
 * comments go with it); a lens whose keys are all removed loses its table; a
 * new lens is appended. Refused — never half-applied — when the file does
 * not parse, or when the result does not re-parse to exactly the intended
 * tables.
 */
export function editLensTables(
  text: string,
  changes: LensChanges,
): { ok: true; text: string; tables: Record<string, RawLensTable> } | { ok: false; error: string } {
  let current: Record<string, RawLensTable>;
  try {
    current = rawLenses(parseToml(text) as Record<string, unknown>);
  } catch (err) {
    return { ok: false, error: `profile.toml cannot be read as a profile: ${err instanceof Error ? err.message : String(err)}` };
  }
  const intended: Record<string, RawLensTable> = structuredClone(current);
  const touched = new Set<string>();
  for (const [lens, keys] of Object.entries(changes)) {
    const before = JSON.stringify(intended[lens] ?? {});
    const t: RawLensTable = { ...(intended[lens] ?? {}) };
    for (const [k, v] of Object.entries(keys)) {
      if (v === null) delete t[k];
      else t[k] = v;
    }
    if (JSON.stringify(t) === before) continue;
    touched.add(lens);
    if (Object.keys(t).length === 0) delete intended[lens];
    else intended[lens] = t;
  }
  if (touched.size === 0) return { ok: true, text, tables: current };

  const lines = text.split("\n");
  const out: string[] = [];
  const placed = new Set<string>();
  let skipping = false;
  let removing = false;
  for (const line of lines) {
    // Any header — a table or an array of tables — ends the table before it.
    if (/^\s*\[/.test(line)) {
      const lens = LENS_HEADER_RE.exec(HEADER_RE.exec(line)?.[1]?.trim() ?? "")?.[1];
      skipping = lens !== undefined && touched.has(lens);
      removing = skipping && lens !== undefined && intended[lens] === undefined;
      if (skipping && lens !== undefined) {
        placed.add(lens);
        const t = intended[lens];
        if (t) out.push(...renderTable(lens, t));
        // A removed table takes the blank line that separated it with it.
        else if (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
        continue;
      }
    }
    // A regenerated table's own lines go; the blank lines after it stay (a
    // removed table's go too).
    if (!skipping || (!removing && line.trim() === "")) out.push(line);
  }
  if (text.endsWith("\n") && out[out.length - 1] !== "") out.push("");
  const appended = [...touched].filter((l) => !placed.has(l) && intended[l]).sort();
  if (appended.length > 0) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    for (const lens of appended) out.push("", ...renderTable(lens, intended[lens]!));
    out.push("");
  }
  const next = out.join("\n");
  let reread: Record<string, RawLensTable>;
  try {
    reread = rawLenses(parseToml(next) as Record<string, unknown>);
  } catch (err) {
    return { ok: false, error: `the edited profile.toml would not parse (${String(err)}) — edit it by hand` };
  }
  if (!sameTables(reread, intended)) {
    return {
      ok: false,
      error:
        "profile.toml spells its [lenses] in a shape this tool does not edit (an inline table or dotted keys) — " +
        "move each lens into its own [lenses.<pass>] table by hand, or make the change by hand and validate it",
    };
  }
  return { ok: true, text: next, tables: intended };
}

// ---- staging -------------------------------------------------------------------

/** Files of one profile, relative to its directory: text to write. */
export type ProfileFiles = Record<string, string>;

/**
 * Check profile `name` as it WOULD be with `files` written into it: a scratch
 * copy of the config home's `profiles/` with the candidate applied, resolved
 * through the daemon's loaders. Error messages name the real config home,
 * never the scratch one.
 */
export function checkStaged(home: ProfileHome, name: string, files: ProfileFiles): ProfileCheck {
  const realHome = configHome(home.env);
  const scratch = mkdtempSync(join(tmpdir(), "qcr-profile-check-"));
  try {
    const src = join(realHome, PROFILES_DIR);
    // A plain copy (a dangling link or a loop elsewhere under profiles/ must
    // not break staging), from the resolved root so profiles/ itself is never
    // a link. A copied symlink still points into the LIVE tree (cpSync even
    // rewrites a relative target to an absolute one), so every link on the
    // path of a candidate write is cut first — see `unlinkWritePath`.
    if (existsSync(src)) cpSync(realpathSync(src), join(scratch, PROFILES_DIR), { recursive: true });
    const root = join(scratch, PROFILES_DIR);
    const dir = join(root, assertPathSegment("profile", name));
    for (const [rel, text] of Object.entries(files)) {
      unlinkWritePath(root, relative(root, join(dir, rel)));
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    const r = checkProfile({ root: home.root, env: { ...home.env, QCR_CONFIG_HOME: scratch } }, name);
    if (r.ok) {
      for (const layer of r.summary.chain) layer.dir = layer.dir.split(scratch).join(realHome);
      return r;
    }
    return { ok: false, errors: r.errors.map((e) => e.split(scratch).join(realHome)) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Make writing `rel` under the scratch `root` unable to reach the live tree:
 * a symlinked directory on the way is replaced by a plain copy of what it
 * points at (its other files still load), a symlinked file at the end is
 * removed (the write replaces it anyway). A dangling directory link is
 * removed and the write creates a real directory in its place.
 */
export function unlinkWritePath(root: string, rel: string): void {
  const parts = rel.split(sep).filter((p) => p !== "");
  let at = root;
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]!);
    let isLink: boolean;
    try {
      isLink = lstatSync(at).isSymbolicLink();
    } catch {
      return; // nothing here yet: the rest of the path is created fresh
    }
    if (!isLink) continue;
    let target: string | null = null;
    try {
      target = realpathSync(at);
    } catch {
      target = null;
    }
    rmSync(at, { force: true });
    if (i < parts.length - 1 && target !== null) cpSync(target, at, { recursive: true });
  }
}

/** Where a write to profile `name` may land, or why it may not. */
export function writeTarget(home: ProfileHome, name: string): { ok: true; dir: string; exists: boolean } | { ok: false; error: string } {
  try {
    assertPathSegment("profile", name);
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
  const dir = writableProfileDir(home, name);
  const found = locateProfile({ root: home.root, profile: name, env: home.env });
  if (found && found.dir !== dir) {
    return {
      ok: false,
      error: EXAMPLE_PROFILES.includes(name)
        ? `"${name}" is a generic example the app ships — setup writes the install's OWN profile; name one (the repo's name is a good choice) and it will extend "${name}"`
        : `profile "${name}" lives at ${found.dir}, outside the config home's ${PROFILES_DIR}/ — edit it there by hand and validate it`,
    };
  }
  return { ok: true, dir, exists: existsSync(join(dir, PROFILE_FILE)) };
}

/** Read a profile file's current text ("" when absent). */
export function readProfileFile(dir: string, rel: string): string {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Write each file tmp+rename; the directory is created. */
export function writeProfileFiles(dir: string, files: ProfileFiles): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = join(dirname(full), `.${rel.split("/").at(-1)}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, full);
  }
}
