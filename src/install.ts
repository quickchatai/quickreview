// The install locator — the ONE module that decides where an
// install's own data lives. Every reader of the live config goes through it:
// the config loader, the onboarding wizard (via its adapters), the bench, the
// TUI, the daemon's session env, and — through `scripts/install-locator.sh`,
// its shell mirror, pinned by a differential test — the posting scripts,
// mint-token and deploy.sh's pin/drift preflight. Every reader of the secrets
// goes through it the same way (the section at the end).
//
// Two homes, split by kind:
//   config home  $XDG_CONFIG_HOME/qcr/<install>/  config.toml, profiles/, secrets/
//   state home   $XDG_STATE_HOME/qcr/<install>/   scan ledger, findings, portrait facts
//
// `<install>` is `$QCR_INSTALL`, default `default` — one name per install, so
// one PC can hold more than one. `$QCR_CONFIG` overrides the config FILE
// outright (not the home). The checkout's own `config.toml` is the EXPAND
// step's fallback: still read, never silently — every process that falls back
// to it says so once, naming `qcr install migrate`. contracts it away.
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
// `profiles/`, which keeps the generic EXAMPLES (`EXAMPLE_PROFILES`) and, until
// contracts it, the legacy home of every other profile — read, and
// said so once, like the legacy config.
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
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The slice of the environment the locator reads — nothing else. */
export interface InstallEnv {
  QCR_CONFIG?: string;
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

/** `$XDG_CONFIG_HOME/qcr/<install>` — config.toml, profiles/, secrets/. */
export function configHome(env: InstallEnv = process.env): string {
  return join(xdgBase(env.XDG_CONFIG_HOME, env, ".config"), "qcr", installName(env));
}

/** `$XDG_STATE_HOME/qcr/<install>` — PC-only scan state, never shipped. */
export function stateHome(env: InstallEnv = process.env): string {
  return join(xdgBase(env.XDG_STATE_HOME, env, join(".local", "state")), "qcr", installName(env));
}

/**
 * Where the live config came from:
 *   override — `$QCR_CONFIG`, taken as given (a missing file is the READER's
 *              error, never a reason to look elsewhere)
 *   home     — the install's config home (also the answer when nothing exists
 *              yet: that is where a new config is written)
 *   checkout — the legacy `<root>/config.toml`, the expand step's fallback
 */
export type ConfigSource = "override" | "home" | "checkout";

export interface LocatedConfig {
  path: string;
  source: ConfigSource;
  /** The install's config home, whichever source won — where migrate moves to. */
  home: string;
}

export interface LocateOptions {
  /** The app checkout (the sandbox root) — only for the legacy fallback. */
  root: string;
  env?: InstallEnv;
  exists?: (path: string) => boolean;
}

export function locateConfig(opts: LocateOptions): LocatedConfig {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const home = configHome(env);
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") return { path: resolve(override), source: "override", home };
  const inHome = join(home, CONFIG_FILE);
  if (exists(inHome)) return { path: inHome, source: "home", home };
  const legacy = join(opts.root, CONFIG_FILE);
  if (exists(legacy)) return { path: legacy, source: "checkout", home };
  return { path: inHome, source: "home", home };
}

/** The legacy-fallback notice, one wording for every surface. */
export function checkoutFallbackNotice(located: LocatedConfig): string {
  return (
    `qcr: reading the LEGACY checkout config ${located.path} — the install's config home is ` +
    `${located.home}; move it there with \`qcr install migrate\``
  );
}

const announced = new Set<string>();

/**
 * `locateConfig` for a real process: the same answer, plus the checkout
 * fallback LOGGED — once per path per process, so a loader called on every
 * tick does not repeat itself, and never silently.
 */
export function resolveConfigPath(
  opts: LocateOptions & { log?: (line: string) => void },
): LocatedConfig {
  const located = locateConfig(opts);
  if (located.source === "checkout" && !announced.has(located.path)) {
    announced.add(located.path);
    (opts.log ?? ((line: string) => console.error(line)))(checkoutFallbackNotice(located));
  }
  return located;
}

// ---- qcr install migrate ----------------------------------------------------

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
          "A machine that deploys with scripts/deploy.sh sync|rebuild must keep its config in the checkout until ships the config home — that route refuses a config found anywhere else; move it back to deploy.",
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

/**
 * The checkout's GENERIC profiles — the ones that belong to the app, not to
 * any install: the examples, and `default`, the shipped behaviour
 * every generated profile extends. Every other directory under the checkout's `profiles/`
 * is an install's own profile still sitting in its legacy place: the lookup
 * reads it (announced), and `qcr install migrate` moves it into the config
 * home. A new example is registered here (a test holds the checkout to it).
 */
export const EXAMPLE_PROFILES: readonly string[] = ["default", "example-django", "minimal"];

/**
 * Where a profile is looked up, in order, deduplicated:
 *   1. the install's config home — `<home>/profiles/`
 *   2. `profiles/` beside `$QCR_CONFIG`, when it is set (the compose route's
 *      mounted config home; the bench image's baked checkout)
 *   3. the checkout's `profiles/` — the generic examples, and the legacy place
 */
export function profileSearchDirs(opts: { root: string; env?: InstallEnv }): string[] {
  const env = opts.env ?? process.env;
  const dirs = [join(configHome(env), PROFILES_DIR)];
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") dirs.push(join(dirname(resolve(override)), PROFILES_DIR));
  dirs.push(join(opts.root, PROFILES_DIR));
  return [...new Set(dirs)];
}

/** Which of `profileSearchDirs` a profile was found in. */
export type ProfileSource = "home" | "override" | "checkout";

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
 * Find the named profile: the first search dir that holds it as a directory,
 * or `null` when none does (each loader words its own not-found). The name is
 * a plain path segment or a throw — `../x`, `a/b` and kin never reach a join.
 */
export function locateProfile(opts: {
  root: string;
  profile: string;
  env?: InstallEnv;
  isDir?: (path: string) => boolean;
}): LocatedProfile | null {
  const name = assertPathSegment("profile", opts.profile);
  const env = opts.env ?? process.env;
  const isDir = opts.isDir ?? isDirectory;
  const homeDir = join(configHome(env), PROFILES_DIR);
  const checkoutDir = join(opts.root, PROFILES_DIR);
  for (const base of profileSearchDirs({ root: opts.root, env })) {
    const dir = join(base, name);
    if (!isDir(dir)) continue;
    const source: ProfileSource =
      base === homeDir ? "home" : base === checkoutDir ? "checkout" : "override";
    return { name, dir, source };
  }
  return null;
}

/** An install's own profile read from the checkout: the expand step's
 * fallback. The generic examples live there by design and are not this. */
export function isLegacyCheckoutProfile(located: LocatedProfile): boolean {
  return located.source === "checkout" && !EXAMPLE_PROFILES.includes(located.name);
}

const announcedProfiles = new Set<string>();

/**
 * `locateProfile` for a real process: the same answer, plus a legacy
 * checkout profile LOGGED — once per path per process, never silently.
 */
export function resolveProfile(opts: {
  root: string;
  profile: string;
  env?: InstallEnv;
  log?: (line: string) => void;
}): LocatedProfile | null {
  const located = locateProfile(opts);
  if (located && isLegacyCheckoutProfile(located) && !announcedProfiles.has(located.dir)) {
    announcedProfiles.add(located.dir);
    const home = join(configHome(opts.env ?? process.env), PROFILES_DIR);
    (opts.log ?? ((line: string) => console.error(line)))(
      `qcr: reading the LEGACY checkout profile ${located.dir} — an install's profile belongs in ` +
        `${home}; move it there with \`qcr install migrate\``,
    );
  }
  return located;
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
      "A moved profile tracked in git shows as a deletion. A machine that deploys with scripts/deploy.sh sync|rebuild " +
        "must keep the profile its config names in the checkout until ships the config home — that route refuses otherwise.",
    );
  }
  return { code, lines };
}

// ---- secrets ------------------------------------------------------
//
// The install's secrets live in `<config home>/secrets/` — one install, one
// directory. The legacy `~/.config/quickreview-bot/` is the expand step's
// fallback, exactly as the checkout config is for config.toml: still read,
// never silently, and `qcr install migrate` moves it. contracts it.
//
// `[github] secrets_dir` still names the dir outright when the operator set
// one. Empty — or the legacy default spelling every config shipped with until
// now — means "the locator decides", so an install that never touched the key
// follows its secrets into the home the moment they are moved there, with no
// config edit.
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
 * it was always spelled `~/.config/…`). */
export function legacySecretsDir(env: InstallEnv = process.env): string {
  return join(homeOf(env), ".config", "quickreview-bot");
}

/** Is a configured `secrets_dir` just the old shipped default? Then it names
 * no choice the operator made, and the locator decides. */
export function isLegacySecretsSpelling(value: string, env: InstallEnv = process.env): boolean {
  const v = value.trim().replace(/\/+$/, "");
  return v === LEGACY_SECRETS_SPELLING || expandHomeIn(v, env) === legacySecretsDir(env);
}

/**
 * Where the secrets came from:
 *   configured — `[github] secrets_dir`, set to something other than the old
 *                default: the operator named it, it is taken as given
 *   override   — the caller's env override (`$QC_SECRETS_DIR`, the wizards')
 *   home       — `<config home>/secrets` (also the answer when nothing exists
 *                yet: that is where new secrets are written)
 *   legacy     — `~/.config/quickreview-bot`, the expand step's fallback
 */
export type SecretsSource = "configured" | "override" | "home" | "legacy";

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
  exists?: (path: string) => boolean;
}

export function locateSecrets(opts: LocateSecretsOptions = {}): LocatedSecrets {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const home = secretsHome(env);
  const configured = (opts.configured ?? "").trim();
  if (configured !== "" && !isLegacySecretsSpelling(configured, env))
    return { path: expandHomeIn(configured, env), source: "configured", home };
  const override = (opts.override ?? "").trim();
  if (override !== "") return { path: expandHomeIn(override, env), source: "override", home };
  if (exists(home)) return { path: home, source: "home", home };
  const legacy = legacySecretsDir(env);
  if (exists(legacy)) return { path: legacy, source: "legacy", home };
  return { path: home, source: "home", home };
}

/** The legacy-secrets notice, one wording for every surface. */
export function legacySecretsNotice(located: { path: string; home: string }): string {
  return (
    `qcr: reading secrets from the LEGACY dir ${located.path} — the install's secrets home is ` +
    `${located.home}; move them there with \`qcr install migrate\``
  );
}

/** `locateSecrets` for a real process: the legacy fallback LOGGED, once per
 * path per process (the config loader runs on every tick). */
export function resolveSecretsDir(
  opts: LocateSecretsOptions & { log?: (line: string) => void } = {},
): LocatedSecrets {
  const located = locateSecrets(opts);
  if (located.source === "legacy") announce(located.path, legacySecretsNotice(located), opts.log);
  return located;
}

function announce(path: string, line: string, log?: (line: string) => void): void {
  if (announced.has(path)) return;
  announced.add(path);
  (log ?? ((l: string) => console.error(l)))(line);
}

/** `$XDG_CONFIG_HOME/qcr-operator/<install>` — the operator-only credentials
 * that must never reach a container (see the header of this section). */
export function operatorHome(env: InstallEnv = process.env): string {
  return join(xdgBase(env.XDG_CONFIG_HOME, env, ".config"), "qcr-operator", installName(env));
}

export type KeysFileSource = "override" | "home" | "legacy";

export interface LocatedKeysFile {
  path: string;
  source: KeysFileSource;
  /** `<operator home>/openviking-keys.env` — where migrate moves the file. */
  home: string;
}

/**
 * The companion's OpenViking key file (two USER keys, handed to the companion
 * container by `--env-file`, so no value ever reaches an argv):
 * `$QCR_OPENVIKING_KEYS` as given, else the operator home's file, else the
 * legacy `~/.config/quickreview-bot/openviking-keys.env`, else the operator home.
 */
export function locateKeysFile(
  opts: { env?: InstallEnv & { QCR_OPENVIKING_KEYS?: string }; exists?: (path: string) => boolean } = {},
): LocatedKeysFile {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const home = join(operatorHome(env), KEYS_FILE);
  const override = (env.QCR_OPENVIKING_KEYS ?? "").trim();
  if (override !== "") return { path: override, source: "override", home };
  if (exists(home)) return { path: home, source: "home", home };
  const legacy = join(legacySecretsDir(env), KEYS_FILE);
  if (exists(legacy)) return { path: legacy, source: "legacy", home };
  return { path: home, source: "home", home };
}

/** `locateKeysFile` with the legacy fallback logged once per process. */
export function resolveKeysFile(
  opts: Parameters<typeof locateKeysFile>[0] & { log?: (line: string) => void } = {},
): LocatedKeysFile {
  const located = locateKeysFile(opts);
  if (located.source === "legacy") {
    announce(
      located.path,
      `qcr: reading the OpenViking key file from the LEGACY path ${located.path} — its home is ` +
        `${located.home}; move it there with \`qcr install migrate\``,
      opts.log,
    );
  }
  return located;
}

// ---- qcr install migrate: the secrets half ----------------------------------

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
      : `secrets: ${m.from} still holds ${m.remaining.join(", ")} — resolve those by hand; every reader already prefers ${m.to}`,
  );
  return { code, lines };
}
