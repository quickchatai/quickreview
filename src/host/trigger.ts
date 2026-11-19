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
// The verb sends the change to the running daemon through the sealed operator
// command channel `review-now` uses: one `set-trigger` command file, written
// as root into the daemon's `<commands>/operator/` (src/commands.ts), and its
// receipt read for a moment. The daemon keeps the choice in its own store
// (src/triggerchoice.ts), where its next reconcile pass reads it; from then
// on it wins over the config's `[github] trigger`, across restarts. It starts
// nothing and restarts nothing, and a round in flight runs on.
//
// Nothing is written to config.toml. The config is on the round
// fingerprint's policy surface (src/execboundary.ts): a rewrite while a round
// runs is reported as the exec boundary's own controls changed under it, and
// a host changes the trigger as routine, with rounds in flight. Only `host
// setup --trigger` writes the config's key, before the daemon runs.
//
//   done     the daemon took the choice
//   sent     the command is written and the daemon has not answered yet; it
//            takes it when it reads its channel, and the board export's
//            `trigger` says the word once it has
//   busy     a setup or go-live walk, a practice review or the home holds
//            the checklist lock, and nothing was sent
//   refused  nothing was sent, or the daemon said no (`trigger_refused`)
//
// It acts on installs a host manages, and on no other (src/host/admit.ts):
// anywhere else the trigger is its owner's own line in their config. It
// needs a reviewer to tell: a repository set up and a daemon running (before
// setup, the choice goes with `host setup --trigger`).
//
// Asking for `all` queues, at the next poll of a reviewer that posts, every
// open pull request that has no review yet; in dry-run `all` takes nothing,
// so the first pass after go-live takes them. Going back to `label` takes
// nothing out of the queue: what was picked up is reviewed.
import { hostManagedToml } from "../hostmanaged.js";
import { acquireChecklistLock } from "../onboard/checklistlock.js";
import { CONTAINER_COMMANDS_DIR } from "../onboard/steps/compose.js";
import { operatorCommandWriteScriptAt } from "../operatorwrite.js";
import { admit, hostManagedRefusal, notHostManaged } from "./admit.js";
import { TRIGGER_WORDS, refused, type HostAnswer, type TriggerWord } from "./outcomes.js";
import { lockOptions, type HostPorts } from "./ports.js";
import { RECEIPT_TRIES, RECEIPT_WAIT_MS, isAnswer, receiptOf, standing } from "./proof.js";

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
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const NOT_A_HOSTS = "this install's trigger is its owner's own line, in its config";

/** A command file name the daemon's operator watcher serves (`*.json`),
 * unique per call. */
export function setTriggerFileName(now: Date, trigger: TriggerWord): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-host-settrigger-${trigger}.json`;
}

/** The argv that writes one `set-trigger` command into the root-sealed
 * operator directory, through the script every operator command is written
 * with. The payload is built here from one of the two words, so it can carry
 * no quote. */
export function setTriggerWriteArgv(name: string, trigger: TriggerWord): string[] {
  if (!isTriggerWord(trigger)) throw new Error(`not a trigger: ${JSON.stringify(trigger)}`);
  const payload = JSON.stringify({ command: "set-trigger", trigger });
  return [
    "sh",
    "-c",
    `printf '%s\\n' '${payload}' | ( ${operatorCommandWriteScriptAt(CONTAINER_COMMANDS_DIR, name)} )`,
  ];
}

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
  const unmanaged = hostManagedRefusal(ports, NOT_A_HOSTS);
  if (unmanaged !== null) return unmanaged;

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
    // the marker again, under the lock
    if (!hostManagedToml(existing)) return notHostManaged(NOT_A_HOSTS);
    const at = await standing(ports);
    if (isAnswer(at)) return at;
    const name = setTriggerFileName(ports.now(), asked);
    const write = await at.transport.execAsRoot(setTriggerWriteArgv(name, asked));
    if (write.code !== 0)
      return refused(
        "reviewer_unreachable",
        `the choice could not be handed to the reviewer (${
          oneLine(write.stderr || write.stdout).slice(0, 200) || `exit ${write.code}`
        }). Nothing changed`,
      );
    for (let attempt = 0; attempt < RECEIPT_TRIES; attempt += 1) {
      await ports.sleep(RECEIPT_WAIT_MS);
      const receipt = await receiptOf(at.transport, name);
      if (receipt.kind === "queued") return { state: "done", trigger: asked };
      if (receipt.kind === "refused")
        return refused(
          "trigger_refused",
          `the reviewer refused the trigger "${asked}": ${receipt.reason}`,
        );
    }
    return { state: "sent", trigger: asked };
  } finally {
    got.lock.release();
  }
}
