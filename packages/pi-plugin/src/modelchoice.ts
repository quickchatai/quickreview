// The remembered model choice: one JSON file beside pi's logins,
// `<pi agent dir>/qcr-model.json`.
//
// It sits in pi's agent dir, not in a config home, because the answer is
// about that pi's credentials: every surface that reads a login from the
// directory (the CLI, the plugin inside a running pi, a bot worker) reads the
// choice from the same place, and the plugin alone, with no app around it,
// still has a directory to keep it in.
//
// The file holds two things: which provider (and, when the person named one,
// which model) a review runs on, and the models the person agreed to run
// with no price estimate. Either may be there without the other.
//
// It is written by this module only, never by a session. A read never
// throws: a file that cannot be read or does not hold a choice is "nothing
// remembered", with a notice the caller may show. A write that fails says so
// in a sentence and leaves the run to go on with the choice for that run.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelChoice } from "./modelroute.js";

/** The file's name in a pi agent dir. */
export const MODEL_CHOICE_FILE = "qcr-model.json";

/** The file's format version. */
const VERSION = 1;

export interface ModelChoiceRead {
  /** The remembered choice; undefined when none is stored. */
  choice?: ModelChoice;
  /** The models the person agreed to run with no estimate (also on `choice`). */
  noEstimateOk: readonly string[];
  /** Why a file that exists was not used. */
  notice?: string;
}

export type ModelChoiceWrite = { ok: true } | { ok: false; error: string };

/** What a caller writes: the provider, the model (null: by the rule) and how
 * it was said. `no_estimate_ok` omitted keeps the answers already stored. */
export type ModelChoiceInput = Pick<ModelChoice, "provider" | "model" | "via"> & {
  no_estimate_ok?: readonly string[];
};

const fileOf = (agentDir: string): string => join(agentDir, MODEL_CHOICE_FILE);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && v !== ""))]
    : [];
}

/** The choice a parsed file holds, or why it holds none. A file with no
 * provider is not an error: it holds the no-estimate answers alone. */
function choiceOf(
  raw: Record<string, unknown>,
  noEstimateOk: readonly string[],
): { choice?: ModelChoice; reason?: string } {
  const { provider, model, via } = raw;
  if (provider === undefined || provider === null) return {};
  if (typeof provider !== "string" || provider.trim() === "")
    return { reason: "its provider is not a name" };
  if (via !== "ask" && via !== "use") return { reason: 'its "via" is neither "ask" nor "use"' };
  if (model !== undefined && model !== null && (typeof model !== "string" || model.trim() === ""))
    return { reason: "its model is not a name" };
  return {
    choice: {
      provider,
      // The answer to a question names a provider only: the model stays the rule's.
      model: via === "use" && typeof model === "string" ? model : null,
      via,
      no_estimate_ok: noEstimateOk,
    },
  };
}

/** What `agentDir` remembers. Never throws. */
export function readModelChoice(agentDir: string): ModelChoiceRead {
  const file = fileOf(agentDir);
  const nothing = (why: string): ModelChoiceRead => ({
    noEstimateOk: [],
    notice: `the remembered model choice in ${file} was not used: ${why}`,
  });
  if (!existsSync(file)) return { noEstimateOk: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return nothing(errorText(e));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return nothing("it is not a JSON object");
  const data = raw as Record<string, unknown>;
  if (data["version"] !== VERSION)
    return nothing(`its version is ${JSON.stringify(data["version"])}, not ${VERSION}`);
  const noEstimateOk = strings(data["no_estimate_ok"]);
  const { choice, reason } = choiceOf(data, noEstimateOk);
  return {
    ...(choice ? { choice } : {}),
    noEstimateOk,
    ...(reason !== undefined
      ? { notice: `the remembered model choice in ${file} was not used: ${reason}` }
      : {}),
  };
}

/** Write the file: aside, then renamed into place, 0600. An agent dir that
 * does not exist yet (a provider key in the environment, pi never run) is
 * made first, for its owner alone as pi makes it. */
function store(
  agentDir: string,
  data: { choice?: ModelChoiceInput; noEstimateOk: readonly string[] },
): ModelChoiceWrite {
  const file = fileOf(agentDir);
  const tmp = `${file}.tmp`;
  const body = {
    version: VERSION,
    ...(data.choice
      ? {
          provider: data.choice.provider,
          model: data.choice.via === "use" ? data.choice.model : null,
          via: data.choice.via,
        }
      : {}),
    no_estimate_ok: [...data.noEstimateOk],
  };
  try {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the directory refused the write; there is nothing to clean up
    }
    return {
      ok: false,
      error: `cannot remember the choice in ${agentDir}: ${errorText(e)}. Pin it instead: [models] model in config.toml`,
    };
  }
}

/** Remember `choice`. The no-estimate answers already stored are kept unless
 * the choice brings its own. */
export function writeModelChoice(agentDir: string, choice: ModelChoiceInput): ModelChoiceWrite {
  return store(agentDir, {
    choice,
    noEstimateOk: choice.no_estimate_ok ?? readModelChoice(agentDir).noEstimateOk,
  });
}

/** Forget everything the file holds: the choice and the no-estimate answers. */
export function clearModelChoice(agentDir: string): ModelChoiceWrite {
  try {
    rmSync(fileOf(agentDir), { force: true });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `cannot forget the choice in ${agentDir}: ${errorText(e)}`,
    };
  }
}

/** Remember that the person agreed to run `spec` (`provider/id`) with no
 * price estimate. The stored choice, if any, is kept as it is. */
export function allowNoEstimate(agentDir: string, spec: string): ModelChoiceWrite {
  const held = readModelChoice(agentDir);
  if (held.noEstimateOk.includes(spec)) return { ok: true };
  return store(agentDir, {
    ...(held.choice ? { choice: held.choice } : {}),
    noEstimateOk: [...held.noEstimateOk, spec],
  });
}
