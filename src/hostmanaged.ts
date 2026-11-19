// The host-managed marker, read off the config file as written.
//
// `[github] token_source = "host"` says a host manages this install's GitHub
// credential: it writes `<secrets dir>/github_token` and keeps it fresh
// (packages/pi-plugin/src/hosttoken.ts has the contract), and it owns the
// identity and the repository. The surfaces that must behave differently on
// such an install ask here, before a whole config would load: the home (no
// GitHub sign-in, no repository pick, no switch-on or go-live of its own) and
// `qcr github-token sync` (refused).
//
// The key is read from the file's own TOML, never through the config loader:
// the home opens on a config the daemon's loader would still refuse (no
// repository yet), and the marker is written before the home first opens.
// A config that is absent, unreadable or not TOML carries no marker. That is
// the unmarked behaviour, which is every install's before this key existed.
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { locateConfig, locateSecrets, type InstallEnv } from "./homes.js";

type ReadText = (path: string) => string;
const readUtf8: ReadText = (path) => readFileSync(path, "utf8");

/** The `[github]` table of `toml` as written; null when there is none. */
function githubTable(toml: string): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = parse(toml);
  } catch {
    return null;
  }
  const github = (doc as Record<string, unknown> | null)?.["github"];
  return typeof github === "object" && github !== null && !Array.isArray(github)
    ? (github as Record<string, unknown>)
    : null;
}

/** Does this config text carry the host-managed marker? */
export function hostManagedToml(toml: string): boolean {
  return githubTable(toml)?.["token_source"] === "host";
}

function tableAt(configPath: () => string, read: ReadText): Record<string, unknown> | null {
  try {
    return githubTable(read(configPath()));
  } catch {
    return null;
  }
}

/** Is the install whose config is at `configPath()` host-managed? Read again
 * on every call: a host may write the marker while the home is open. */
export function hostManagedAt(configPath: () => string, read: ReadText = readUtf8): () => boolean {
  return () => tableAt(configPath, read)?.["token_source"] === "host";
}

/** The same, for the install a process's environment names. */
export function hostManagedInstall(env: InstallEnv = process.env): boolean {
  return hostManagedAt(() => locateConfig({ env }).path)();
}

/** Where the install at `configPath()` keeps its secrets, as the daemon's
 * loader locates them: `[github] secrets_dir` when the config names one,
 * else the install's own secrets home. */
export function secretsDirAt(
  configPath: () => string,
  env: InstallEnv = process.env,
  read: ReadText = readUtf8,
): () => string {
  return () => {
    const configured = tableAt(configPath, read)?.["secrets_dir"];
    return locateSecrets({ configured: typeof configured === "string" ? configured : null, env })
      .path;
  };
}
