// The install locator — the ONE module that decides where an
// install's own data lives. Every reader of the live config goes through it:
// the config loader, the onboarding wizard (via its adapters), the bench, the
// TUI, the daemon's session env, and — through `scripts/install-locator.sh`,
// its shell mirror, pinned by a differential test — the posting scripts,
// mint-token and deploy.sh's pin/drift preflight. Every reader of the secrets
// goes through it the same way (the section at the end).
//
// Two homes, split by kind:
//   config home  $XDG_CONFIG_HOME/qcr/<install>/  config.toml, profiles/, secrets/,
//                                                  portrait/ (the portrait narrative)
//   state home   $XDG_STATE_HOME/qcr/<install>/   scan ledger, findings, portrait facts
//
// `<install>` is `$QCR_INSTALL`, default `default` — one name per install, so
// one PC can hold more than one. `$QCR_CONFIG` overrides the config FILE
// outright (not the home). The checkout's own `config.toml` is NOT read
// (contracted the expand step's fallback away): a checkout that still
// holds one is STRANDED — `strandedCheckoutConfig` names it so a not-found can
// point at `qcr install migrate`, which is the only thing that ever opens it.
//
// A session must never move any of this: `QCR_CONFIG=` and `QCR_INSTALL=` are
// both in the bash guard's POLICY_RELOCATING_ENV, and `HOME=` /
// `XDG_CONFIG_HOME=` were already refused there. The daemon hands each session
// the path IT resolved as `QCR_CONFIG` (sessions.ts), so the posting scripts
// read exactly the daemon's config rather than re-deriving one.
//
// Repo profiles live in the config home too: `<home>/profiles/<name>/`
// first, then — when `$QCR_CONFIG` names a file — `profiles/` beside that file
// (what makes the compose route work: it mounts the located config's directory,
// profiles and all, and names the config inside the mount), then the checkout's
// `profiles/` — for the generic EXAMPLES (`EXAMPLE_PROFILES`) only. Any other
// profile left there is stranded, never read, and `qcr install
// migrate` moves it.
//
// Pure where it can be: `locateConfig` takes the env and an `exists` probe, so
// the tests drive it with temp XDG homes and never touch the operator's own.
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The slice of the environment the locator reads — nothing else. */
export interface InstallEnv {
  QCR_CONFIG?: string;
  /** A whole-home override (absolute paths only): the companion
   * container sets these to its `/qcr-config` and `/qcr-state` mounts, so the
   * locator in there resolves the SAME homes the host mounted, not the
   * container user's own `~/.config` / `~/.local/state`. Unset on a normal
   * host, where the XDG derivation below is the answer. */
  QCR_CONFIG_HOME?: string;
  QCR_STATE_HOME?: string;
  QCR_INSTALL?: string;
  XDG_CONFIG_HOME?: string;
  XDG_STATE_HOME?: string;
  HOME?: string;
}

export const DEFAULT_INSTALL = "default";
export const CONFIG_FILE = "config.toml";

/** A single path segment an install (or, later, a profile) may be named by.
 * No separators, no leading dot, so `..` and `a/../../b` are unspellable. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Refuse a name that could escape its parent directory. `kind` names what the
 * segment is for, so the error says which knob is wrong. */
export function assertPathSegment(kind: string, name: string): string {
  if (!SEGMENT_RE.test(name) || name.includes("..")) {
    throw new Error(
      `${kind} ${JSON.stringify(name)} is not a plain name — letters, digits, '.', '_' and '-' only, no path separators or '..'`,
    );
  }
  return name;
}

export function installName(env: InstallEnv = process.env): string {
  const raw = (env.QCR_INSTALL ?? "").trim();
  return raw === "" ? DEFAULT_INSTALL : assertPathSegment("QCR_INSTALL", raw);
}

/** An XDG base dir: the variable when it is set AND absolute (the spec says a
 * relative value is invalid and must be ignored), else `$HOME/<fallback>`. */
function xdgBase(value: string | undefined, env: InstallEnv, fallback: string): string {
  const v = (value ?? "").trim();
  if (v !== "" && isAbsolute(v)) return v;
  const home = (env.HOME ?? "").trim() || homedir();
  return join(home, fallback);
}

/** A home override is taken only when it is set AND absolute — a relative
 * value would resolve against whatever the cwd happens to be. Trailing
 * slashes are dropped; nothing else is rewritten (the shell mirror,
 * `scripts/install-locator.sh`, applies the same rule). */
function homeOverride(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (v === "" || !isAbsolute(v)) return undefined;
  return v.replace(/\/+$/, "") || "/";
}

/** `$XDG_CONFIG_HOME/qcr/<install>` — config.toml, profiles/, secrets/
 * (or `$QCR_CONFIG_HOME` as given, see `InstallEnv`). */
export function configHome(env: InstallEnv = process.env): string {
  const override = homeOverride(env.QCR_CONFIG_HOME);
  if (override !== undefined) return override;
  return join(xdgBase(env.XDG_CONFIG_HOME, env, ".config"), "qcr", installName(env));
}

/** `$XDG_STATE_HOME/qcr/<install>` — PC-only scan state, never shipped. */
export function stateHome(env: InstallEnv = process.env): string {
  const override = homeOverride(env.QCR_STATE_HOME);
  if (override !== undefined) return override;
  return join(xdgBase(env.XDG_STATE_HOME, env, join(".local", "state")), "qcr", installName(env));
}

/**
 * Where the live config came from:
 *   override — `$QCR_CONFIG`, taken as given (a missing file is the READER's
 *              error, never a reason to look elsewhere)
 *   home     — the install's config home, whether or not the file exists yet
 *              (that is where a new config is written, and a missing one is
 *              the reader's error — never a reason to read the checkout's)
 */
export type ConfigSource = "override" | "home";

export interface LocatedConfig {
  path: string;
  source: ConfigSource;
  /** The install's config home, whichever source won — where migrate moves to. */
  home: string;
}

export interface LocateOptions {
  env?: InstallEnv;
}

export function locateConfig(opts: LocateOptions = {}): LocatedConfig {
  const env = opts.env ?? process.env;
  const home = configHome(env);
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") return { path: resolve(override), source: "override", home };
  return { path: join(home, CONFIG_FILE), source: "home", home };
}

/**
 * The checkout's own `config.toml` when it is still there and is NOT the
 * located config — i.e. an install that has not run `qcr install migrate`.
 * Nothing reads it; this only lets a not-found name the way out.
 * Null when `$QCR_CONFIG` names that very file (the operator's choice).
 */
export function strandedCheckoutConfig(opts: {
  root: string;
  env?: InstallEnv;
  exists?: (path: string) => boolean;
}): string | null {
  const exists = opts.exists ?? existsSync;
  const stranded = join(opts.root, CONFIG_FILE);
  if (!exists(stranded)) return null;
  return locateConfig(opts).path === resolve(stranded) ? null : stranded;
}

/** What a reader says when the located config is missing — one wording for
 * every surface, naming `qcr install migrate` when the checkout strands one. */
export function missingConfigMessage(located: LocatedConfig, stranded: string | null): string {
  const base =
    located.source === "override"
      ? `no config at ${located.path} (named by QCR_CONFIG)`
      : `no config at ${located.path} — the install's config home holds none (\`qcr onboard\` writes one)`;
  return stranded === null
    ? base
    : `${base}; ${stranded} is no longer read — move it into the config home with \`qcr install migrate\``;
}

// ---- qcr install migrate ----------------------------------------------------

/** Whether two existing paths are the SAME file or directory (dev + inode, so
 * a symlink or a config home that IS the checkout both count). A migrate whose
 * source is its destination has nothing to move — and must never "deduplicate"
 * the only copy by deleting it. */
function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

export type MigrateOutcome =
  /** The checkout's config.toml is now in the config home. */
  | { kind: "moved"; from: string; to: string }
  /** Nothing in the checkout, the home already holds the config: done before. */
  | { kind: "already"; to: string }
  /** Both hold one and they are byte-identical: the checkout copy is removed. */
  | { kind: "deduplicated"; from: string; to: string }
  /** Both hold one and they DIFFER: nothing is touched, the operator decides. */
  | { kind: "conflict"; from: string; to: string }
  /** Neither exists: there is nothing to move (run the onboarding wizard). */
  | { kind: "nothing"; to: string }
  /** `$QCR_CONFIG` is set: the operator named the file; migrate would be a guess. */
  | { kind: "override"; path: string };

/**
 * Move `<root>/config.toml` into the install's config home. Idempotent: a
 * second run finds the home populated and the checkout empty and says so. It
 * never overwrites a config it did not move — a differing pair is a conflict
 * the operator resolves by hand.
 */
export function migrateConfig(opts: { root: string; env?: InstallEnv }): MigrateOutcome {
  const env = opts.env ?? process.env;
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") return { kind: "override", path: resolve(override) };
  const from = join(opts.root, CONFIG_FILE);
  const to = join(configHome(env), CONFIG_FILE);
  const inCheckout = existsSync(from);
  const inHome = existsSync(to);
  if (!inCheckout) return inHome ? { kind: "already", to } : { kind: "nothing", to };
  if (samePath(from, to)) return { kind: "already", to };
  if (inHome) {
    if (!readFileSync(from).equals(readFileSync(to))) return { kind: "conflict", from, to };
    unlinkSync(from);
    return { kind: "deduplicated", from, to };
  }
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (err) {
    // A checkout and ~/.config on different filesystems: copy, then remove.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
  return { kind: "moved", from, to };
}

/** What `qcr install migrate` prints, and its exit code. Only a conflict fails:
 * every other outcome leaves the install in a state the locator reads. */
export function migrateReport(outcome: MigrateOutcome): { code: number; lines: string[] } {
  switch (outcome.kind) {
    case "moved":
      return {
        code: 0,
        lines: [
          `moved ${outcome.from} → ${outcome.to}`,
          "every reader now finds it there (restart a running daemon or TUI to pick it up).",
          "If this checkout tracked config.toml in git, the move shows as a deletion — the snapshot manifests already exclude the path.",
          "scripts/deploy.sh sync|rebuild ships the config home to the VM from there — and refuses a config left in the checkout.",
        ],
      };
    case "already":
      return {
        code: 0,
        lines: [`already migrated: the config is ${outcome.to}; nothing in the checkout`],
      };
    case "deduplicated":
      return {
        code: 0,
        lines: [
          `${outcome.to} already held the same bytes — removed the checkout copy ${outcome.from}`,
        ],
      };
    case "conflict":
      return {
        code: 1,
        lines: [
          `refused: ${outcome.from} and ${outcome.to} both exist and differ — nothing was touched.`,
          `Keep the one you want at ${outcome.to}, delete the checkout copy, and re-run.`,
        ],
      };
    case "nothing":
      return {
        code: 0,
        lines: [
          `no config.toml in the checkout or at ${outcome.to} — nothing to move (\`qcr onboard\` writes a new one there)`,
        ],
      };
    case "override":
      return {
        code: 0,
        lines: [
          `QCR_CONFIG names ${outcome.path} — that file is the config; migrate moves nothing while it is set`,
        ],
      };
  }
}

// ---- repo profiles -------------------------------------------------

/** The directory, in every home, that holds one subdirectory per profile. */
export const PROFILES_DIR = "profiles";

/** The directory in the config home that holds the repo portrait's NARRATIVE
 * — the companion's reading of the portrait facts, and the one it replaced
 * (`src/setup/portrait.ts`). Config, not state: it is the operator's
 * to read and keep (a config home that is a git repo versions it). Never
 * shipped: deploy's filter admits the config file and `profiles/` only. */
export const PORTRAIT_DIR = "portrait";

/**
 * The checkout's GENERIC profiles — the ones that belong to the app, not to
 * any install: the examples, and `default`, the shipped behaviour
 * every generated profile extends. They are the ONLY profiles the lookup reads
 * from the checkout. Any other directory under the checkout's `profiles/` is
 * an install's own profile stranded in its old place: never read,
 * and `qcr install migrate` moves it into the config home. A new example is
 * registered here (a test holds the checkout to it, and the shell mirror's
 * `QCR_EXAMPLE_PROFILES` to this list).
 */
export const EXAMPLE_PROFILES: readonly string[] = ["default", "example-django", "minimal"];

/** Which of `profileSearchDirs` a profile was found in. */
export type ProfileSource = "home" | "override" | "checkout";

/**
 * Where a profile is looked up, in order, deduplicated (the FIRST place a
 * directory is reached by names its source):
 *   1. the install's config home — `<home>/profiles/`
 *   2. `profiles/` beside `$QCR_CONFIG`, when it is set (the compose route's
 *      mounted config home; the VM's shipped one; the bench image's)
 *   3. the checkout's `profiles/` — the generic examples ONLY
 */
function profileSearchPlaces(opts: {
  root: string;
  env?: InstallEnv;
}): { dir: string; source: ProfileSource }[] {
  const env = opts.env ?? process.env;
  const places: { dir: string; source: ProfileSource }[] = [
    { dir: join(configHome(env), PROFILES_DIR), source: "home" },
  ];
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "")
    places.push({ dir: join(dirname(resolve(override)), PROFILES_DIR), source: "override" });
  places.push({ dir: join(opts.root, PROFILES_DIR), source: "checkout" });
  return places.filter((p, i) => places.findIndex((q) => q.dir === p.dir) === i);
}

/** The directories of `profileSearchPlaces`, for a not-found to name. */
export function profileSearchDirs(opts: { root: string; env?: InstallEnv }): string[] {
  return profileSearchPlaces(opts).map((p) => p.dir);
}

export interface LocatedProfile {
  name: string;
  dir: string;
  source: ProfileSource;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the named profile: the first search place that holds it as a
 * directory — the checkout only for a generic example — or `null` when none
 * does (each loader words its own not-found). The name is a plain path
 * segment or a throw — `../x`, `a/b` and kin never reach a join.
 */
export function locateProfile(opts: {
  root: string;
  profile: string;
  env?: InstallEnv;
  isDir?: (path: string) => boolean;
}): LocatedProfile | null {
  const name = assertPathSegment("profile", opts.profile);
  const isDir = opts.isDir ?? isDirectory;
  for (const place of profileSearchPlaces(opts)) {
    if (place.source === "checkout" && !EXAMPLE_PROFILES.includes(name)) continue;
    const dir = join(place.dir, name);
    if (isDir(dir)) return { name, dir, source: place.source };
  }
  return null;
}

/**
 * The checkout's `profiles/<name>` when it is an install's own profile left
 * there (not a generic example) — stranded, never read. Only for a
 * not-found to name `qcr install migrate`; null when there is none, or when
 * `profiles/` beside `$QCR_CONFIG` IS the checkout's (then it was read).
 */
export function strandedCheckoutProfile(opts: {
  root: string;
  profile: string;
  env?: InstallEnv;
}): string | null {
  const name = assertPathSegment("profile", opts.profile);
  if (EXAMPLE_PROFILES.includes(name)) return null;
  const checkout = join(opts.root, PROFILES_DIR);
  if (!profileSearchPlaces(opts).some((p) => p.dir === checkout && p.source === "checkout"))
    return null;
  const dir = join(checkout, name);
  return isDirectory(dir) ? dir : null;
}

/** Every stranded checkout profile (see `strandedCheckoutProfile`), sorted. */
export function strandedCheckoutProfiles(opts: { root: string; env?: InstallEnv }): string[] {
  let names: string[];
  try {
    names = readdirSync(join(opts.root, PROFILES_DIR)).sort();
  } catch {
    return [];
  }
  return names
    .filter((name) => SEGMENT_RE.test(name) && !name.includes(".."))
    .map((profile) => strandedCheckoutProfile({ ...opts, profile }))
    .filter((dir): dir is string => dir !== null);
}

// ---- qcr install migrate: profiles -------------------------------------------

export type ProfileMigrateOutcome =
  | { kind: "moved"; name: string; from: string; to: string }
  | { kind: "deduplicated"; name: string; from: string; to: string }
  | { kind: "conflict"; name: string; from: string; to: string }
  /** `$QCR_CONFIG` is set: nothing moves (see migrateProfiles). */
  | { kind: "override"; name: string; path: string };

/** Relative path → bytes, for every file under `dir` (sorted). */
function treeFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : join(rel, entry.name);
      // A symlinked directory is walked like a real one (never read as a file).
      if (entry.isDirectory() || isDirectory(join(dir, path))) walk(path);
      else out.set(path, readFileSync(join(dir, path)));
    }
  };
  walk("");
  return out;
}

function sameTree(a: string, b: string): boolean {
  const left = treeFiles(a);
  const right = treeFiles(b);
  if (left.size !== right.size) return false;
  for (const [path, bytes] of left) {
    const other = right.get(path);
    if (other === undefined || !bytes.equals(other)) return false;
  }
  return true;
}

/**
 * Move every install profile out of the checkout's `profiles/` into the
 * config home's — every directory there except the generic `EXAMPLE_PROFILES`.
 * Same discipline as the config move: idempotent (a second run finds nothing
 * left to move), an identical copy already in the home just drops the
 * checkout's, and a DIFFERING one is a conflict that touches nothing.
 *
 * While `$QCR_CONFIG` is set NOTHING moves, exactly like the config half: the
 * compose route mounts the directory holding THAT file (bring-up's
 * `configMountOf`), not the config home, so a profile moved into the home
 * would vanish from the container and fail the daemon's boot. The operator
 * who named the config also decides where its profiles sit (beside it is on
 * the lookup path).
 */
export function migrateProfiles(opts: { root: string; env?: InstallEnv }): ProfileMigrateOutcome[] {
  const env = opts.env ?? process.env;
  const fromBase = join(opts.root, PROFILES_DIR);
  const toBase = join(configHome(env), PROFILES_DIR);
  if (!isDirectory(fromBase)) return [];
  // A config home that IS the checkout: its profiles are already home.
  if (samePath(fromBase, toBase)) return [];
  const outcomes: ProfileMigrateOutcome[] = [];
  const names = readdirSync(fromBase, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !EXAMPLE_PROFILES.includes(e.name))
    .map((e) => e.name)
    .sort();
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") {
    return names.map((name) => ({ kind: "override", name, path: resolve(override) }));
  }
  for (const name of names) {
    const from = join(fromBase, name);
    const to = join(toBase, name);
    if (existsSync(to)) {
      if (!isDirectory(to) || !sameTree(from, to)) {
        outcomes.push({ kind: "conflict", name, from, to });
        continue;
      }
      rmSync(from, { recursive: true });
      outcomes.push({ kind: "deduplicated", name, from, to });
      continue;
    }
    mkdirSync(toBase, { recursive: true, mode: 0o700 });
    try {
      renameSync(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true });
    }
    outcomes.push({ kind: "moved", name, from, to });
  }
  return outcomes;
}

/** What the profile half of `qcr install migrate` prints; a conflict fails. */
export function profileMigrateReport(outcomes: ProfileMigrateOutcome[]): {
  code: number;
  lines: string[];
} {
  if (outcomes.length === 0) {
    return { code: 0, lines: ["profiles: none in the checkout beyond the generic examples"] };
  }
  const lines: string[] = [];
  let code = 0;
  for (const o of outcomes) {
    switch (o.kind) {
      case "moved":
        lines.push(`moved profile ${o.name}: ${o.from} → ${o.to}`);
        break;
      case "deduplicated":
        lines.push(`profile ${o.name}: ${o.to} already held the same files — removed ${o.from}`);
        break;
      case "override":
        lines.push(
          `profile ${o.name}: QCR_CONFIG names ${o.path} — migrate moves no profile while it is set ` +
            `(put it in profiles/ beside that file, or unset QCR_CONFIG and re-run)`,
        );
        break;
      case "conflict":
        code = 1;
        lines.push(
          `refused profile ${o.name}: ${o.from} and ${o.to} both exist and differ — nothing was touched. ` +
            `Keep the one you want at ${o.to}, delete the checkout copy, and re-run.`,
        );
        break;
    }
  }
  if (outcomes.some((o) => o.kind === "moved" || o.kind === "deduplicated")) {
    lines.push(
      "A moved profile tracked in git shows as a deletion. scripts/deploy.sh sync|rebuild ships the config home's " +
        "profiles/ to the VM with the config.",
    );
  }
  return { code, lines };
}

// ---- secrets ------------------------------------------------------
//
// The install's secrets live in `<config home>/secrets/` — one install, one
// directory. The old `~/.config/quickreview-bot/` is never read (
// contracted the expand step's fallback away); only `qcr install migrate`
// opens it, to move what it still holds into the home.
//
// `[github] secrets_dir` still names the dir outright when the operator set
// one. Empty — or the old default spelling every config shipped with before
// the config home — means "the locator decides", so a config that never
// touched the key reads the home, never the old dir it happens to spell.
//
// The companion's OpenViking key file is the ONE credential deliberately kept
// OUT of the config home: that home is mounted into the reviewer container on
// the compose route and shipped to the VM, and the file
// holds the companion key review sessions must never read (rule 8). It lives
// in a sibling tree, `$XDG_CONFIG_HOME/qcr-operator/<install>/`, that nothing
// mounts or ships.

export const SECRETS_SUBDIR = "secrets";
export const KEYS_FILE = "openviking-keys.env";
/** The spelling every config.toml shipped with before the config home. */
export const LEGACY_SECRETS_SPELLING = "~/.config/quickreview-bot";

function homeOf(env: InstallEnv): string {
  return (env.HOME ?? "").trim() || homedir();
}

function expandHomeIn(path: string, env: InstallEnv): string {
  if (path === "~") return homeOf(env);
  return path.startsWith("~/") ? join(homeOf(env), path.slice(2)) : path;
}

/** `<config home>/secrets` — where an install's secrets belong. */
export function secretsHome(env: InstallEnv = process.env): string {
  return join(configHome(env), SECRETS_SUBDIR);
}

/** The pre-config-home secrets dir, `$HOME/.config/quickreview-bot` (never XDG:
 * it was always spelled `~/.config/…`). Nothing reads it but migrate. */
export function legacySecretsDir(env: InstallEnv = process.env): string {
  return join(homeOf(env), ".config", "quickreview-bot");
}

/** Is a configured `secrets_dir` just the old shipped default? Then it names
 * no choice the operator made, and the locator decides — the home, never the
 * old dir itself. */
export function isLegacySecretsSpelling(value: string, env: InstallEnv = process.env): boolean {
  const v = value.trim().replace(/\/+$/, "");
  return v === LEGACY_SECRETS_SPELLING || expandHomeIn(v, env) === legacySecretsDir(env);
}

/**
 * Where the secrets came from:
 *   configured — `[github] secrets_dir`, set to something other than the old
 *                default: the operator named it, it is taken as given
 *   override   — the caller's env override (`$QC_SECRETS_DIR`, the wizards')
 *   home       — `<config home>/secrets`, whether or not it exists yet (that
 *                is where new secrets are written)
 */
export type SecretsSource = "configured" | "override" | "home";

export interface LocatedSecrets {
  path: string;
  source: SecretsSource;
  /** `<config home>/secrets`, whichever source won — where migrate moves to. */
  home: string;
}

export interface LocateSecretsOptions {
  /** `[github] secrets_dir` as written (unexpanded), or null/"" when unset. */
  configured?: string | null;
  /** A caller's env override (`$QC_SECRETS_DIR`), below a configured value. */
  override?: string | null;
  env?: InstallEnv;
}

export function locateSecrets(opts: LocateSecretsOptions = {}): LocatedSecrets {
  const env = opts.env ?? process.env;
  const home = secretsHome(env);
  const configured = (opts.configured ?? "").trim();
  if (configured !== "" && !isLegacySecretsSpelling(configured, env))
    return { path: expandHomeIn(configured, env), source: "configured", home };
  const override = (opts.override ?? "").trim();
  if (override !== "") return { path: expandHomeIn(override, env), source: "override", home };
  return { path: home, source: "home", home };
}

/** The old secrets dir when it still holds anything — an install that has
 * not run `qcr install migrate`. Never read; only named, so a missing
 * credential can point at the way out. Null when it is gone or empty. */
export function strandedLegacySecrets(env: InstallEnv = process.env): string | null {
  const dir = legacySecretsDir(env);
  try {
    return readdirSync(dir).length > 0 ? dir : null;
  } catch {
    return null;
  }
}

/** `$XDG_CONFIG_HOME/qcr-operator/<install>` — the operator-only credentials
 * that must never reach a container (see the header of this section). */
export function operatorHome(env: InstallEnv = process.env): string {
  return join(xdgBase(env.XDG_CONFIG_HOME, env, ".config"), "qcr-operator", installName(env));
}

/** `$XDG_STATE_HOME/qcr-operator/<install>` — operator-side runtime state
 * that belongs in neither home: not the state home (the companion mounts it
 * read-write) and not the config home (shipped to the VM). */
export function operatorStateHome(env: InstallEnv = process.env): string {
  return join(xdgBase(env.XDG_STATE_HOME, env, join(".local", "state")), "qcr-operator", installName(env));
}

/** Where the host writes the companion's down-scoped, READ-ONLY GitHub token
 * as an env file (`src/tui/ghread.ts`). Mounted read-only into the
 * companion, and only this directory — never the secrets it was minted from. */
export function companionGithubDir(env: InstallEnv = process.env): string {
  return join(operatorStateHome(env), "companion-github");
}

/** Where the host keeps the companion's read-only MIRROR of the live config
 * (`CompanionLifecycle.syncConfigMirror`): a copy refreshed while the
 * TUI runs, mounted as a directory so a rename-replaced config.toml is seen.
 * config.toml holds no secret values (secrets are files under `secrets/`). */
export function companionConfigMirrorDir(env: InstallEnv = process.env): string {
  return join(operatorStateHome(env), "companion-config");
}

export type KeysFileSource = "override" | "home";

export interface LocatedKeysFile {
  path: string;
  source: KeysFileSource;
  /** `<operator home>/openviking-keys.env` — where migrate moves the file. */
  home: string;
}

/**
 * The companion's OpenViking key file (two USER keys, handed to the companion
 * container by `--env-file`, so no value ever reaches an argv):
 * `$QCR_OPENVIKING_KEYS` as given, else the operator home's file — whether or
 * not it exists yet. The old `~/.config/quickreview-bot/` copy is never read.
 */
export function locateKeysFile(
  opts: { env?: InstallEnv & { QCR_OPENVIKING_KEYS?: string } } = {},
): LocatedKeysFile {
  const env = opts.env ?? process.env;
  const home = join(operatorHome(env), KEYS_FILE);
  const override = (env.QCR_OPENVIKING_KEYS ?? "").trim();
  if (override !== "") return { path: override, source: "override", home };
  return { path: home, source: "home", home };
}

// ---- qcr install migrate: the secrets half ----------------------------------
//
// The one place the old dir is opened — to empty it into the homes.

export type SecretFileOutcome =
  /** Moved, mode bits intact (0600 stays 0600). */
  | "moved"
  /** The destination already held the same bytes: the legacy copy is removed. */
  | "deduplicated"
  /** The destination holds DIFFERENT bytes: both are left for the operator. */
  | "conflict"
  /** Not moved on purpose (`why` says which rule). */
  | "skipped";

export interface SecretFileResult {
  name: string;
  to: string;
  outcome: SecretFileOutcome;
  why?: string;
}

export type SecretsMigration =
  /** No legacy dir: nothing to move. */
  | { kind: "nothing"; from: string; to: string }
  /** The legacy path is a symlink (the container layout, or an operator's own
   * redirect) — never followed and emptied. */
  | { kind: "symlink"; from: string; to: string }
  | {
      kind: "done";
      from: string;
      to: string;
      files: SecretFileResult[];
      /** What is still in the legacy dir afterwards; empty ⇒ it was removed. */
      remaining: string[];
    };

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    // ~/.config and XDG_CONFIG_HOME on different filesystems: copy, keep the
    // mode (copyFileSync does not promise it), then remove.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    const mode = statSync(from).mode & 0o7777;
    copyFileSync(from, to);
    chmodSync(to, mode);
    unlinkSync(from);
  }
}

function ensurePrivateDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Move every file in `~/.config/quickreview-bot/` into `<config home>/secrets/`
 * — except the companion key file, which goes to the operator home (it must
 * never sit where a container can read it). A rename, so mode bits travel
 * with the file; the destination dirs are created 0700. Idempotent, and it
 * never overwrites a secret it did not move: a differing pair is a conflict.
 */
export function migrateSecrets(opts: { env?: InstallEnv & { QCR_OPENVIKING_KEYS?: string } } = {}): SecretsMigration {
  const env = opts.env ?? process.env;
  const from = legacySecretsDir(env);
  const to = secretsHome(env);
  let st;
  try {
    st = lstatSync(from);
  } catch {
    return { kind: "nothing", from, to };
  }
  if (st.isSymbolicLink()) return { kind: "symlink", from, to };
  if (!st.isDirectory()) return { kind: "nothing", from, to };
  const keysPinned = (env.QCR_OPENVIKING_KEYS ?? "").trim() !== "";
  const files: SecretFileResult[] = [];
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name);
    const isKeys = name === KEYS_FILE;
    const dest = isKeys ? join(operatorHome(env), KEYS_FILE) : join(to, name);
    if (!lstatSync(src).isFile()) {
      files.push({ name, to: dest, outcome: "skipped", why: "not a regular file" });
      continue;
    }
    if (isKeys && keysPinned) {
      files.push({
        name,
        to: dest,
        outcome: "skipped",
        why: "QCR_OPENVIKING_KEYS is set — that variable names the key file",
      });
      continue;
    }
    if (existsSync(dest)) {
      if (!readFileSync(src).equals(readFileSync(dest))) {
        files.push({ name, to: dest, outcome: "conflict" });
        continue;
      }
      unlinkSync(src);
      files.push({ name, to: dest, outcome: "deduplicated" });
      continue;
    }
    ensurePrivateDir(dirname(dest));
    moveFile(src, dest);
    files.push({ name, to: dest, outcome: "moved" });
  }
  const remaining = readdirSync(from).sort();
  if (remaining.length === 0) rmdirSync(from);
  return { kind: "done", from, to, files, remaining };
}

/** What the secrets half of `qcr install migrate` prints, and its exit code.
 * Names only — a secret's VALUE never reaches a line. */
export function secretsMigrateReport(m: SecretsMigration): { code: number; lines: string[] } {
  if (m.kind === "nothing")
    return { code: 0, lines: [`secrets: no legacy dir ${m.from} — nothing to move (the home is ${m.to})`] };
  if (m.kind === "symlink")
    return {
      code: 0,
      lines: [`secrets: ${m.from} is a symlink — left alone (point it, or [github] secrets_dir, at ${m.to} yourself)`],
    };
  const lines: string[] = [];
  let code = 0;
  for (const f of m.files) {
    switch (f.outcome) {
      case "moved":
        lines.push(`secrets: moved ${f.name} → ${f.to}`);
        break;
      case "deduplicated":
        lines.push(`secrets: ${f.to} already held the same bytes — removed the legacy ${f.name}`);
        break;
      case "conflict":
        code = 1;
        lines.push(
          `secrets: refused ${f.name}: ${join(m.from, f.name)} and ${f.to} both exist and differ — nothing was touched; keep one and re-run`,
        );
        break;
      case "skipped":
        lines.push(`secrets: left ${f.name} in ${m.from} (${f.why})`);
        break;
    }
  }
  if (m.files.length === 0) lines.push(`secrets: ${m.from} is empty`);
  lines.push(
    m.remaining.length === 0
      ? `secrets: removed the now-empty ${m.from}; every reader finds them in ${m.to} (restart a running daemon, TUI or companion)`
      : `secrets: ${m.from} still holds ${m.remaining.join(", ")} — resolve those by hand; nothing reads them there, every reader reads ${m.to}`,
  );
  return { code, lines };
}

// ---- qcr install migrate: the compose route's .env --------------------------
//
// The wizard's bring-up writes the secrets dir the compose stack mounts into
// `<root>/.env` as `QCR_SECRETS_DIR` — the locator's answer AT THAT TIME,
// which on an un-migrated machine is the legacy dir. Once migrate has moved
// the secrets, that line would mount a dir that is gone (Docker then creates
// it empty, as root) or half-emptied by a conflict: the daemon would boot with
// no credential. So migrate follows its own move into the one line that names
// the old dir — and touches nothing else in the file.

export type ComposeEnvRepoint =
  | { kind: "none" }
  | { kind: "repointed"; file: string; from: string; to: string };

export function repointComposeSecrets(opts: { root: string; env?: InstallEnv }): ComposeEnvRepoint {
  const env = opts.env ?? process.env;
  const file = join(opts.root, ".env");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { kind: "none" };
  }
  const line = /^QCR_SECRETS_DIR=(.*)$/m.exec(text);
  if (!line) return { kind: "none" };
  const value = (line[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  if (value === "" || !isLegacySecretsSpelling(value, env)) return { kind: "none" };
  const to = secretsHome(env);
  if (!existsSync(to)) return { kind: "none" };
  const next = text.replace(/^QCR_SECRETS_DIR=.*$/m, `QCR_SECRETS_DIR=${to}`);
  const mode = statSync(file).mode & 0o7777;
  const tmp = join(opts.root, ".env.qcr-migrate.tmp");
  writeFileSync(tmp, next, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return { kind: "repointed", file, from: value, to };
}

export function composeRepointReport(r: ComposeEnvRepoint): string[] {
  return r.kind === "none"
    ? []
    : [
        `secrets: ${r.file} mounted the legacy dir (QCR_SECRETS_DIR=${r.from}) — it now names ${r.to}; ` +
          "recreate the compose stack (`docker compose up -d`) so the container mounts it",
      ];
}
