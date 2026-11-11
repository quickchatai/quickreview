// The model environment an install keeps in its secrets dir: what a model
// provider's own environment variables are, when they live in files.
//
//   <secrets>/model-env/<NAME>   one file per variable: the file's name is the
//                                variable, its content the value
//   <secrets>/openai_api_key     the older single key file, read as
//                                OPENAI_API_KEY for as long as it exists
//
// It carries any provider's key, and the further variables a provider that
// needs several is configured with, under the names pi itself reads. There is
// no table of providers here: a name is whatever the provider documents.
//
// One loader, and nothing exports these to a shell. Its readers hand the map
// to the one place that asks pi for a credential (a route host's environment),
// so a value never lands in the process's own environment, in a session's, or
// in a log: the loader reports names and reasons, never a value.
//
// A leaf (node:fs and node:path only), so the daemon can read it without
// reaching anything else.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The directory under the secrets dir that holds one file per variable. */
export const MODEL_ENV_DIR = "model-env";

/** The older single key file, and the variable it is read as. */
export const LEGACY_MODEL_KEY_FILE = "openai_api_key";
export const LEGACY_MODEL_KEY_ENV = "OPENAI_API_KEY";

/** What a variable's name looks like. */
export const MODEL_ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Name prefixes the loader refuses. Each is a family this system or its
 * tools read for their own purposes, so a file under such a name would not
 * configure a model provider: it would hand a session a GitHub token, move
 * one of this system's own homes, repoint pi, the memory engine or git.
 */
export const MODEL_ENV_REFUSED_PREFIXES = [
  "GH_",
  "GITHUB_",
  "QCR_",
  "PI_",
  "OPENVIKING_",
  "GIT_",
] as const;

/** A value file larger than this is not a key or a setting. */
const MAX_VALUE_BYTES = 64 * 1024;

/** Why `name` cannot be a model variable, or null when it can. */
export function modelEnvNameProblem(name: string): string | null {
  if (!MODEL_ENV_NAME_RE.test(name))
    return "not an environment variable's name (capital letters, digits and _)";
  const prefix = MODEL_ENV_REFUSED_PREFIXES.find((p) => name.startsWith(p));
  return prefix !== undefined ? `names starting with ${prefix} are not model variables` : null;
}

export interface ModelEnvOptions {
  /** Hears each file that was left out: its name and why, never its content. */
  warn?: (line: string) => void;
}

/** A file's content as a value: surrounding whitespace dropped, or null when
 * it is not a regular file of a sane size, cannot be read, or is empty. */
function valueOf(file: string, say: (why: string) => void): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile()) {
      say("it is not a file");
      return null;
    }
    if (st.size > MAX_VALUE_BYTES) {
      say("it is too large to be a key or a setting");
      return null;
    }
    const value = readFileSync(file, "utf8").trim();
    if (value === "") {
      say("it is empty");
      return null;
    }
    return value;
  } catch (e) {
    // A filesystem error names the path and the reason, never the content.
    say(`it cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    return null;
  }
}

/**
 * The model environment of `secretsDir`: every `model-env/<NAME>` whose name
 * passes the rule, and the older `openai_api_key` as `OPENAI_API_KEY` when no
 * file under the newer spelling names that variable. A secrets dir that is
 * missing, or holds neither, is an empty map. Never throws, and never puts a
 * value in a message.
 */
export function modelEnvFrom(
  secretsDir: string,
  options: ModelEnvOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = join(secretsDir, MODEL_ENV_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // no model-env directory: only the older key file may be there
  }
  for (const name of names) {
    // A dotfile is housekeeping (a placeholder, an editor's leftover), not a variable.
    if (name.startsWith(".")) continue;
    const left = (why: string): void =>
      options.warn?.(`model env: ${join(dir, name)} was left out: ${why}`);
    const problem = modelEnvNameProblem(name);
    if (problem !== null) {
      left(problem);
      continue;
    }
    const value = valueOf(join(dir, name), left);
    if (value !== null) out[name] = value;
  }
  if (out[LEGACY_MODEL_KEY_ENV] === undefined) {
    const legacy = join(secretsDir, LEGACY_MODEL_KEY_FILE);
    // The older file is optional: its absence is said to nobody.
    const value = valueOf(legacy, () => {});
    if (value !== null) out[LEGACY_MODEL_KEY_ENV] = value;
  }
  return out;
}

/**
 * The model environment a one-shot verb (`qcr model`, `qcr review`,
 * `qcr scan`) hands pi beside the process's own: the secrets dir its config
 * located (`[github] secrets_dir`, else `$QC_SECRETS_DIR`, else the install's
 * own), read by the one loader. The three verbs call this, so they name one
 * route on an install whose only model key is a file. A relative directory is
 * under `root` (the app's root), as the setup wizard's steps resolve it,
 * never under wherever the verb was typed. No directory: an empty map.
 */
export function oneShotModelEnv(
  secretsDir: string | null | undefined,
  root: string,
  options: ModelEnvOptions = {},
): Record<string, string> {
  const dir = oneShotSecretsDir(secretsDir, root);
  return dir !== null ? modelEnvFrom(dir, options) : {};
}

/** The directory `oneShotModelEnv` reads, or null when the config names none. */
export function oneShotSecretsDir(
  secretsDir: string | null | undefined,
  root: string,
): string | null {
  const dir = (secretsDir ?? "").trim();
  if (dir === "") return null;
  return isAbsolute(dir) ? dir : join(root, dir);
}
