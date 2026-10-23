// The homes the CLI resolves for an install: the review core's locator
// (packages/pi-plugin/src/homes.ts), over this process's environment and the
// OS's idea of the user's home when `HOME` is unset. The install locator
// (src/install.ts) re-exports all of it and keeps the migrate and
// operator-only parts.
//
// Two homes, split by kind:
//   config home  $XDG_CONFIG_HOME/qcr/<install>/  config.toml, profiles/, secrets/,
//                                                  portrait/ (the portrait narrative)
//   state home   $XDG_STATE_HOME/qcr/<install>/   scan ledger, findings, portrait
//                                                  facts, one-shot review runs
//
// `<install>` is `$QCR_INSTALL`, default `default`. `$QCR_CONFIG` overrides
// the config FILE outright (not the home). Every locator takes the env as a
// parameter (default `process.env`), so tests drive it with temp XDG homes.
import { homedir } from "node:os";
import { join } from "node:path";
import * as core from "@quickchatai/pi-quickreview/src/homes.js";
import type {
  InstallEnv,
  LocatedConfig,
  LocatedSecrets,
  LocateSecretsOptions,
  OneShotConfig,
} from "@quickchatai/pi-quickreview/src/homes.js";
import { detectInstall } from "./installkind.js";
import type {
  LocatedProfile,
  ProfilePlace,
} from "@quickchatai/pi-quickreview/src/profilelookup.js";

export {
  assertPathSegment,
  CONFIG_FILE,
  DEFAULT_INSTALL,
  EXAMPLE_PROFILES,
  LEGACY_SECRETS_SPELLING,
  missingConfigMessage,
  PORTRAIT_DIR,
  PROFILES_DIR,
  SECRETS_SUBDIR,
  SHIPPED_CONFIG_FILE,
  type ConfigSource,
  type InstallEnv,
  type LocatedConfig,
  type LocatedProfile,
  type LocatedSecrets,
  type OneShotConfig,
  type ProfilePlace,
  type ProfileSource,
  type SecretsSource,
} from "@quickchatai/pi-quickreview/src/homes.js";

/** An option bag whose env defaults to `process.env`. */
type EnvOpt<T extends { env: InstallEnv }> = Omit<T, "env"> & { env?: InstallEnv };

export type LocateOptions = { env?: InstallEnv };

/** `env` with `HOME` filled in from the OS when it is unset or blank. */
function withHome(env: InstallEnv): InstallEnv {
  return (env.HOME ?? "").trim() !== "" ? env : { ...env, HOME: homedir() };
}

const optEnv = <T extends { env?: InstallEnv }>(o: T): T & { env: InstallEnv } => ({
  ...o,
  env: withHome(o.env ?? process.env),
});

export function installName(env: InstallEnv = process.env): string {
  return core.installName(withHome(env));
}

/** An XDG base dir: the variable when it is set AND absolute, else `$HOME/<fallback>`. */
export function xdgBase(value: string | undefined, env: InstallEnv, fallback: string): string {
  return core.xdgBase(value, withHome(env), fallback);
}

/** `$HOME`, else the OS's idea of it — the one fallback every derived path uses. */
export function homeOf(env: InstallEnv): string {
  return core.homeOf(withHome(env));
}

export function configHome(env: InstallEnv = process.env): string {
  return core.configHome(withHome(env));
}

export function stateHome(env: InstallEnv = process.env): string {
  return core.stateHome(withHome(env));
}

/**
 * The state directory the operator verbs open: `state.db`, `status.json`, the
 * record-only gate's `dryrun/`. A checkout and the release image keep it at
 * `<root>/state`, where their daemon writes it. An app installed by a package
 * manager keeps it in the state home instead, never inside the package: a
 * root-owned global prefix refuses the write, and an update replaces the
 * package directory with everything in it.
 */
export function operatorStateDir(
  root: string,
  env: InstallEnv & { readonly QCR_IMAGE_TOOL_UID?: string } = process.env,
): string {
  const kind = detectInstall(root, env as Readonly<Record<string, string | undefined>>).kind;
  return kind === "global" || kind === "local" ? stateHome(env) : join(root, "state");
}

export function locateConfig(opts: LocateOptions = {}): LocatedConfig {
  return core.locateConfig(optEnv(opts));
}

export function strandedCheckoutConfig(
  opts: EnvOpt<Parameters<typeof core.strandedCheckoutConfig>[0]>,
): string | null {
  return core.strandedCheckoutConfig(optEnv(opts));
}

export function homeProfilePlaces(env: InstallEnv = process.env): ProfilePlace[] {
  return core.homeProfilePlaces(withHome(env));
}

export function homeProfileLookup(env: InstallEnv = process.env): { homes: ProfilePlace[] } {
  return core.homeProfileLookup(withHome(env));
}

export function homeProfileDirs(env: InstallEnv = process.env): string[] {
  return core.homeProfileDirs(withHome(env));
}

export function profileSearchDirs(opts: { root: string; env?: InstallEnv }): string[] {
  return core.profileSearchDirs(optEnv(opts));
}

export function locateProfile(
  opts: EnvOpt<Parameters<typeof core.locateProfile>[0]>,
): LocatedProfile | null {
  return core.locateProfile(optEnv(opts));
}

export function strandedCheckoutProfile(opts: {
  root: string;
  profile: string;
  env?: InstallEnv;
}): string | null {
  return core.strandedCheckoutProfile(optEnv(opts));
}

export function strandedCheckoutProfiles(opts: { root: string; env?: InstallEnv }): string[] {
  return core.strandedCheckoutProfiles(optEnv(opts));
}

export function expandHomeIn(path: string, env: InstallEnv): string {
  return core.expandHomeIn(path, withHome(env));
}

export function secretsHome(env: InstallEnv = process.env): string {
  return core.secretsHome(withHome(env));
}

export function legacySecretsDir(env: InstallEnv = process.env): string {
  return core.legacySecretsDir(withHome(env));
}

export function isLegacySecretsSpelling(value: string, env: InstallEnv = process.env): boolean {
  return core.isLegacySecretsSpelling(value, withHome(env));
}

export function locateSecrets(opts: EnvOpt<LocateSecretsOptions> = {}): LocatedSecrets {
  return core.locateSecrets(optEnv(opts));
}

export function loadOneShotConfig(
  opts: EnvOpt<Parameters<typeof core.loadOneShotConfig>[0]>,
): OneShotConfig {
  return core.loadOneShotConfig(optEnv(opts));
}
