// `host set-trigger label|all`: a host changes which pull requests the
// reviewer picks up by itself, for its operator.
//
//   label   the ones somebody asked for: the trigger label, or a review
//           request to the review team (the default)
//   all     every open pull request that is not a draft and not the
//           reviewer's own, each once. This spends model usage on every pull
//           request, which is why it is the person's choice and never a
//           default
//
// The verb is short and does one thing: it states `[github] trigger` in the
// install's config (src/onboard/steps/triggerconfig.ts renders the text, and
// holds it to "the config as it was, and that one key") and answers `done`
// with the trigger the config now says. It starts nothing and restarts
// nothing. The running daemon reads that key again at every poll
// (src/livetrigger.ts), so it follows by its next pass with every round in
// flight, its queue and its state untouched; a daemon that is not running
// reads it when it starts. The board export's `trigger` says the same word,
// read off the same file.
//
// It acts on installs a host manages, and on no other (src/host/admit.ts):
// anywhere else the trigger is its owner's own line in their config. And it
// takes the checklist lock for the moment the edit takes, because the walks
// that hold that lock write the same file (the setup's config steps, the
// go-live step): while one of them runs the verb answers `busy` and changes
// nothing.
//
// Asking for `all` queues, at the next poll, every open pull request that has
// no review yet. Going back to `label` takes nothing out of the queue: what
// was picked up is reviewed.
import { hostManagedToml } from "../hostmanaged.js";
import { acquireChecklistLock } from "../onboard/checklistlock.js";
import { renderTriggerConfig } from "../onboard/steps/triggerconfig.js";
import { admit, hostManaged, notHostManaged } from "./admit.js";
import { TRIGGER_WORDS, refused, type HostAnswer, type TriggerWord } from "./outcomes.js";
import { lockOptions, type HostPorts } from "./ports.js";

export const SET_TRIGGER_USAGE = "usage: qcr --schema 3 host set-trigger label|all";

const isTriggerWord = (v: string): v is TriggerWord =>
  (TRIGGER_WORDS as readonly string[]).includes(v);

/** The verb's one argument, or a string saying what is wrong with it. (The
 * word is handed back in an object: a bare word could not be told from the
 * words of a refusal.) */
export function parseTriggerArg(args: readonly string[]): { trigger: TriggerWord } | string {
  if (args.length !== 1) return "set-trigger takes one word, label or all";
  const word = args[0]!;
  return isTriggerWord(word)
    ? { trigger: word }
    : `${JSON.stringify(word)} is neither label nor all`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const NOT_A_HOSTS = "this install's trigger is its owner's own line, in its config";

/** The `set-trigger` verb. */
export async function hostSetTrigger(
  ports: HostPorts,
  args: readonly string[],
): Promise<HostAnswer> {
  const no = admit(ports);
  if (no !== null) return no;
  const parsed = parseTriggerArg(args);
  if (typeof parsed === "string") return refused("usage", `${parsed}. ${SET_TRIGGER_USAGE}`);
  const asked = parsed.trigger;
  // before the lock: a refusal leaves no file behind on an install that is
  // not a host's
  if (!hostManaged(ports)) return notHostManaged(NOT_A_HOSTS);

  const got = acquireChecklistLock(ports.stateDir, "trigger", lockOptions(ports));
  if (!got.ok) return { state: "busy", holder: got.held.holder };
  try {
    let existing: string;
    try {
      existing = ports.read(ports.configPath);
    } catch (err) {
      return refused(
        "config_unreadable",
        `can't read ${ports.configPath} (${message(err)}). Nothing changed`,
      );
    }
    // the marker again, on the very text the edit is made from
    if (!hostManagedToml(existing)) return notHostManaged(NOT_A_HOSTS);
    const rendered = renderTriggerConfig(existing, asked);
    if (!rendered.ok) return refused("config_invalid", rendered.why);
    try {
      if (rendered.changed) ports.write(ports.configPath, rendered.text);
    } catch (err) {
      return refused(
        "config_unreadable",
        `can't write ${ports.configPath} (${message(err)}). Nothing changed`,
      );
    }
    return { state: "done", trigger: asked };
  } finally {
    got.lock.release();
  }
}
