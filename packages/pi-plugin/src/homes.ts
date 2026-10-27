// The homes of a qcr install: where its config, profiles, secrets and state
// live. Pure over the environment a host hands in: nothing here reads the
// process's own env or home, so the CLI (src/homes.ts, which fills in
// `process.env` and the OS's home) and the pi plugin (its host entry) resolve
// the same homes the same way.
//
// Two homes, split by kind:
//   config home  $XDG_CONFIG_HOME/qcr/<install>/  config.toml, profiles/, secrets/,
//                                                  portrait/ (the portrait narrative)
//   state home   $XDG_STATE_HOME/qcr/<install>/   scan ledger, findings, portrait
//                                                  facts, one-shot review runs
//
// `<install>` is `$QCR_INSTALL`, default `default`. `$QCR_CONFIG` overrides
// the config FILE outright (not the home). `HOME` must be in the env given:
// the host resolves it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertPathSegment,
  findProfile,
  isPathSegment,
  PROFILES_DIR,
  profileSearchPlaces,
  strandedProfile,
  type LocatedProfile,
  type ProfilePlace,
} from "./profilelookup.js";
import { parseCoreConfig, type CoreConfig } from "./reviewconfig.js";

export {
  assertPathSegment,
  EXAMPLE_PROFILES,
  PROFILES_DIR,
  type LocatedProfile,
  type ProfilePlace,
  type ProfileSource,
} from "./profilelookup.js";

/** The slice of the environment the locator reads — nothing else. */
export interface InstallEnv {
  QCR_CONFIG?: string;
  /** A whole-home override (absolute paths only): the companion
   * container sets these to its `/qcr-config` and `/qcr-state` mounts, so the
   * locator in there resolves the same homes the host mounted, not the
   * container user's own `~/.config` / `~/.local/state`. Unset on a normal
   * host, where the XDG derivation below is the answer. */
  QCR_CONFIG_HOME?: string;
  QCR_STATE_HOME?: string;
  /** A daemon container's secrets mount (absolute paths only): both
   * entrypoints export their read-only `/opt/quickreview/secrets`. config.toml
   * is shared with the host, so a set `[github] secrets_dir` names a HOST
   * path the container cannot see; inside one, the mount is the answer.
   * Unset on a host. */
  QCR_SECRETS_MOUNT?: string;
  QCR_INSTALL?: string;
  XDG_CONFIG_HOME?: string;
  XDG_STATE_HOME?: string;
  HOME?: string;
}

export const DEFAULT_INSTALL = "default";
export const CONFIG_FILE = "config.toml";

export function installName(env: InstallEnv): string {
  const raw = (env.QCR_INSTALL ?? "").trim();
  return raw === "" ? DEFAULT_INSTALL : assertPathSegment("QCR_INSTALL", raw);
}

/** An XDG base dir: the variable when it is set AND absolute (the spec says a
 * relative value is invalid and must be ignored), else `$HOME/<fallback>`. */
export function xdgBase(value: string | undefined, env: InstallEnv, fallback: string): string {
  const v = (value ?? "").trim();
  if (v !== "" && isAbsolute(v)) return v;
  return join(homeOf(env), fallback);
}

/** `$HOME`: the one base every derived path uses. The host fills it in. */
export function homeOf(env: InstallEnv): string {
  const home = (env.HOME ?? "").trim();
  if (home === "") throw new Error("HOME is not set: the host names the user's home");
  return home;
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
export function configHome(env: InstallEnv): string {
  const override = homeOverride(env.QCR_CONFIG_HOME);
  if (override !== undefined) return override;
  return join(xdgBase(env.XDG_CONFIG_HOME, env, ".config"), "qcr", installName(env));
}

/** `$XDG_STATE_HOME/qcr/<install>` — PC-only scan state, never shipped. */
export function stateHome(env: InstallEnv): string {
  const override = homeOverride(env.QCR_STATE_HOME);
  if (override !== undefined) return override;
  return join(xdgBase(env.XDG_STATE_HOME, env, join(".local", "state")), "qcr", installName(env));
}

/**
 * Where the live config came from:
 *   override — `$QCR_CONFIG`, taken as given (a missing file is the reader's
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
  env: InstallEnv;
}

export function locateConfig(opts: LocateOptions): LocatedConfig {
  const env = opts.env;
  const home = configHome(env);
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "") return { path: resolve(override), source: "override", home };
  return { path: join(home, CONFIG_FILE), source: "home", home };
}

/**
 * The checkout's own `config.toml` when it is still there and is not the
 * located config — i.e. an install that has not run `qcr install migrate`.
 * Nothing reads it; this only lets a not-found name the way out.
 * Null when `$QCR_CONFIG` names that very file (the operator's choice).
 */
export function strandedCheckoutConfig(opts: {
  root: string;
  env: InstallEnv;
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
      : `no config at ${located.path} — the install's config home holds none (a bare \`qcr\` writes one when you choose a repository)`;
  return stranded === null
    ? base
    : `${base}; ${stranded} is no longer read — move it into the config home with \`qcr install migrate\``;
}

// ---- repo profiles -----------------------------------------------------------

/** The directory in the config home that holds the repo portrait's narrative
 * — the companion's reading of the portrait facts, and the one it replaced
 * (`src/setup/portrait.ts`). Config, not state: it is the operator's
 * to read and keep (a config home that is a git repo versions it). Never
 * shipped: deploy's filter admits the config file and `profiles/` only. */
export const PORTRAIT_DIR = "portrait";

/** The profile directories the install's homes provide, searched before the
 * checkout's generic examples (packages/pi-plugin/src/profilelookup.ts):
 *   1. the install's config home — `<home>/profiles/`
 *   2. `profiles/` beside `$QCR_CONFIG`, when it is set */
export function homeProfilePlaces(env: InstallEnv): ProfilePlace[] {
  const places: ProfilePlace[] = [{ dir: join(configHome(env), PROFILES_DIR), source: "home" }];
  const override = (env.QCR_CONFIG ?? "").trim();
  if (override !== "")
    places.push({ dir: join(dirname(resolve(override)), PROFILES_DIR), source: "override" });
  return places;
}

/** The profile loaders' lookup (packages/pi-plugin/src/profiles.ts `ProfileLookup`) for this
 * install's homes. */
export function homeProfileLookup(env: InstallEnv): { homes: ProfilePlace[] } {
  return { homes: homeProfilePlaces(env) };
}

/** The directories of search places 1 and 2 — every place a profile is read
 * from outside the checkout. The exec boundary's integrity check watches
 * exactly these (`locatedPolicyWatchPaths`). */
export function homeProfileDirs(env: InstallEnv): string[] {
  return homeProfilePlaces(env).map((p) => p.dir);
}

/** The directories of every search place, for a not-found to name. */
export function profileSearchDirs(opts: { root: string; env: InstallEnv }): string[] {
  return profileSearchPlaces(opts.root, homeProfilePlaces(opts.env)).map((p) => p.dir);
}

/** Find the named profile in this install's homes, then the checkout's
 * generic examples (packages/pi-plugin/src/profilelookup.ts `findProfile`). */
export function locateProfile(opts: {
  root: string;
  profile: string;
  env: InstallEnv;
  isDir?: (path: string) => boolean;
}): LocatedProfile | null {
  return findProfile({
    root: opts.root,
    profile: opts.profile,
    homes: homeProfilePlaces(opts.env),
    ...(opts.isDir ? { isDir: opts.isDir } : {}),
  });
}

/** The checkout's `profiles/<name>` when it is an install's own profile left
 * there — stranded, never read (packages/pi-plugin/src/profilelookup.ts `strandedProfile`). */
export function strandedCheckoutProfile(opts: {
  root: string;
  profile: string;
  env: InstallEnv;
}): string | null {
  return strandedProfile({
    root: opts.root,
    profile: opts.profile,
    homes: homeProfilePlaces(opts.env),
  });
}

/** Every stranded checkout profile (see `strandedCheckoutProfile`), sorted. */
export function strandedCheckoutProfiles(opts: { root: string; env: InstallEnv }): string[] {
  let names: string[];
  try {
    names = readdirSync(join(opts.root, PROFILES_DIR)).sort();
  } catch {
    return [];
  }
  return names
    .filter(isPathSegment)
    .map((profile) => strandedCheckoutProfile({ ...opts, profile }))
    .filter((dir): dir is string => dir !== null);
}

//
// The install's secrets live in `<config home>/secrets/` — one install, one
// directory. The legacy `~/.config/quickreview-bot/` is never read; only
// `qcr install migrate` opens it, to move what it still holds into the home.
//
// `[github] secrets_dir` names the dir outright when the operator set one.
// Empty — or the legacy default spelling — means "the locator decides", so a
// config that never touched the key reads the home, never the legacy dir it
// happens to spell.

export const SECRETS_SUBDIR = "secrets";
/** The legacy default spelling of `secrets_dir`. */
export const LEGACY_SECRETS_SPELLING = "~/.config/quickreview-bot";

export function expandHomeIn(path: string, env: InstallEnv): string {
  if (path === "~") return homeOf(env);
  return path.startsWith("~/") ? join(homeOf(env), path.slice(2)) : path;
}

/** `<config home>/secrets` — where an install's secrets belong. */
export function secretsHome(env: InstallEnv): string {
  return join(configHome(env), SECRETS_SUBDIR);
}

/** The legacy secrets dir, `$HOME/.config/quickreview-bot` (never XDG: it is
 * spelled `~/.config/…`). Nothing reads it but migrate. */
export function legacySecretsDir(env: InstallEnv): string {
  return join(homeOf(env), ".config", "quickreview-bot");
}

/** Is a configured `secrets_dir` just the legacy default? Then it names
 * no choice the operator made, and the locator decides — the home, never the
 * legacy dir itself. */
export function isLegacySecretsSpelling(value: string, env: InstallEnv): boolean {
  const v = value.trim().replace(/\/+$/, "");
  return v === LEGACY_SECRETS_SPELLING || expandHomeIn(v, env) === legacySecretsDir(env);
}

/**
 * Where the secrets came from:
 *   mount      — `$QCR_SECRETS_MOUNT`: inside a daemon container the mount is
 *                the only place the secrets are, whatever the shared config
 *                names (that is a host path)
 *   configured — `[github] secrets_dir`, set to something other than the legacy
 *                default: the operator named it, it is taken as given
 *   override   — the caller's env override (`$QC_SECRETS_DIR`, the wizards')
 *   home       — `<config home>/secrets`, whether or not it exists yet (that
 *                is where new secrets are written)
 */
export type SecretsSource = "mount" | "configured" | "override" | "home";

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
  env: InstallEnv;
}

export function locateSecrets(opts: LocateSecretsOptions): LocatedSecrets {
  const env = opts.env;
  const home = secretsHome(env);
  const mount = (env.QCR_SECRETS_MOUNT ?? "").trim();
  if (isAbsolute(mount)) return { path: mount, source: "mount", home };
  const configured = (opts.configured ?? "").trim();
  if (configured !== "" && !isLegacySecretsSpelling(configured, env))
    return { path: expandHomeIn(configured, env), source: "configured", home };
  const override = (opts.override ?? "").trim();
  if (override !== "") return { path: expandHomeIn(override, env), source: "override", home };
  return { path: home, source: "home", home };
}

// ---- the one-shot review's config -------------------------------------------

/** The file that carries the shipped defaults, at the asset root: the values
 * a review runs on when the install has no config of its own. */
export const SHIPPED_CONFIG_FILE = "config.example.toml";

/** The config a one-shot review runs on, and where it came from: `path` is
 * the install's file, or null when the shipped defaults stood in. */
export interface OneShotConfig {
  cfg: CoreConfig;
  toml: string;
  path: string | null;
}

/**
 * The config `qcr review` runs on: the located config.toml's review sections
 * (packages/pi-plugin/src/reviewconfig.ts `parseCoreConfig`), with `[github] secrets_dir`
 * located as the daemon locates it. Zero-config: when the install's config
 * home holds no config, the shipped defaults (`<root>/config.example.toml`)
 * stand in. A `$QCR_CONFIG` that names a missing file is still an error — it
 * named that file — and so is a config stranded in the checkout. The daemon's loader (src/config.ts `loadConfig`) has no
 * such fallback: it refuses to start without a config.
 */
export function loadOneShotConfig(opts: {
  /** The asset root, where the shipped defaults live. */
  root: string;
  env: InstallEnv;
  /** Hears each deprecated key the config still sets. */
  warn?: (line: string) => void;
}): OneShotConfig {
  const env = opts.env;
  const located = locateConfig({ env });
  const shipped = join(opts.root, SHIPPED_CONFIG_FILE);
  const own = existsSync(located.path);
  if (!own) {
    // A checkout that strands a config is an install that has not migrated:
    // say so rather than review on the defaults behind its back.
    const stranded = strandedCheckoutConfig({ root: opts.root, env });
    if (located.source === "override" || stranded !== null || !existsSync(shipped))
      throw new Error(missingConfigMessage(located, stranded));
  }
  const path = own ? located.path : null;
  const toml = readFileSync(path ?? shipped, "utf8");
  const cfg = parseCoreConfig(toml, opts.warn ? { warn: opts.warn } : {});
  cfg.github.secrets_dir = locateSecrets({ configured: cfg.github.secrets_dir, env }).path;
  return { cfg, toml, path };
}
