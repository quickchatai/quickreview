// The trigger label's definition in the reviewed repository, made sure of by
// the running daemon.
//
// Under `[github] trigger = "label"` the reviewer picks up the pull requests
// that carry the trigger label, so the repository needs the label to exist
// before anyone can put it on one. The daemon makes sure of it once when it
// starts and once after each change of the trigger it follows, never at every
// poll: it reads whether the label is there (a read, direct), and when it is
// not it asks the mutation gate to create it (`create_label`, an ordinary
// kind: in dry-run the gate records the request instead, and nothing reaches
// GitHub). GitHub's 422 for a name that is already there is the outcome
// wanted. Under `trigger = "all"` nothing is asked: no label is needed. The
// trigger is the one the reconcile pass follows (`effectiveTrigger`,
// src/triggerchoice.ts); while it cannot be read nothing is asked either.
//
// One attempt per start or change, whatever it gave: a token that may not
// create labels is told so once, in the log and the event table, and not
// again at every pass. The reviewer works without the label either way; a
// review is still asked for with a review request or at the home.
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import type { GithubTrigger } from "@quickchatai/pi-quickreview/src/reviewconfig.js";

/** What a trigger label is created with, beside its configured name. The
 * same look the wizard's own label step gives it. */
export const TRIGGER_LABEL_LOOK = {
  color: "1d76db",
  description: "Ask the automated reviewer for a review of this PR",
} as const;

export interface TriggerLabelSpec {
  name: string;
  color: string;
  description: string;
}

/** The two GitHub calls the ensurer makes (src/github.ts). */
export interface TriggerLabelAdapter {
  /** Is a label of this name defined in the repository? Throws on a read
   * that says neither. */
  hasLabel(name: string): Promise<boolean>;
  /** Create the label's definition, through the gate. */
  createLabel(label: TriggerLabelSpec): Promise<GateResult>;
}

/** How one attempt went. */
export type TriggerLabelOutcome =
  | "not_needed"
  | "present"
  | "created"
  | "recorded"
  | "already_exists"
  | "blocked"
  | "failed"
  /** The adapter has no label calls (a stub-wired daemon): nothing asked. */
  | "unsupported";

export interface TriggerLabelOptions {
  adapter: Partial<TriggerLabelAdapter>;
  /** The trigger the daemon follows now (src/triggerchoice.ts
   * `effectiveTrigger`); undefined while it is unknown. */
  trigger: () => GithubTrigger | undefined;
  /** The configured trigger label's name. */
  name: string;
  log: (msg: string) => void;
  logEvent?: (kind: string, data: Record<string, unknown>) => void;
}

/**
 * The daemon's ensurer: call it after every reconcile pass, and it acts only
 * on the first call and on the first call after the trigger changed. It never
 * throws. Answers what it did, or null when it did nothing this call.
 */
export function triggerLabelEnsurer(
  o: TriggerLabelOptions,
): () => Promise<TriggerLabelOutcome | null> {
  let followed: GithubTrigger | undefined;
  return async () => {
    let trigger: GithubTrigger | undefined;
    try {
      trigger = o.trigger();
    } catch {
      trigger = undefined;
    }
    // an unknown trigger asks nothing, and is not a change: the next pass
    // that can read it decides
    if (trigger === undefined || trigger === followed) return null;
    followed = trigger;
    const outcome = await attempt(o, trigger);
    if (outcome === "failed" || outcome === "blocked")
      o.logEvent?.("trigger_label_failed", { label: o.name, outcome });
    return outcome;
  };
}

async function attempt(
  o: TriggerLabelOptions,
  trigger: GithubTrigger,
): Promise<TriggerLabelOutcome> {
  if (trigger !== "label") return "not_needed";
  const say = (what: string): void => o.log(`trigger label "${o.name}": ${what}`);
  const gh = o.adapter;
  if (!gh.hasLabel || !gh.createLabel) return "unsupported";
  try {
    if (await gh.hasLabel(o.name)) return "present";
    const result = await gh.createLabel({ name: o.name, ...TRIGGER_LABEL_LOOK });
    if (result.blocked !== undefined) {
      say(`refused by the posting guard (${result.blocked})`);
      return "blocked";
    }
    if (result.executed) {
      say("created in the repository");
      return "created";
    }
    const response = result.response as { already_exists?: unknown } | undefined;
    if (response?.already_exists !== undefined) return "already_exists";
    say("missing from the repository; in dry-run its creation is recorded, not sent");
    return "recorded";
  } catch (err) {
    say(
      `could not be made sure of (${err instanceof Error ? err.message : String(err)}); ` +
        "the reviewer works without it, and it is tried again at the next start or trigger change",
    );
    return "failed";
  }
}
