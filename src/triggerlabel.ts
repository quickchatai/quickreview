// The trigger label's definition in the reviewed repository, made sure of by
// the running daemon.
//
// Under `[github] trigger = "label"` the reviewer picks up the pull requests
// that carry the trigger label, so the repository needs the label to exist
// before anyone can put it on one. The daemon makes sure of it after its
// reconcile passes, never at every poll: it reads whether the label is there
// (a read, direct), and when it is not it asks the mutation gate to create it
// (`create_label`, an ordinary kind: in dry-run the gate records the request
// instead, and nothing reaches GitHub). GitHub's 422 for a name that is
// already there is the outcome wanted. Under `trigger = "all"` nothing is
// asked: no label is needed. The trigger is the one the reconcile pass
// follows (`effectiveTrigger`, src/triggerchoice.ts); while it cannot be read
// nothing is asked either.
//
// It asks only after a pass that reached GitHub: a pass that threw, or whose
// list of open pull requests failed, says GitHub is not answering, and the
// label is not asked of it then. An answer ends the asking until the next
// start or the next change of the trigger: the label there, created, its
// creation recorded in dry-run, or GitHub's "already exists". Anything else
// (a 5xx, a network not up yet, a token that may not create labels yet, a
// guard's refusal) is tried again, later each time: a minute after the first
// failure, then twice as long after each one, never more than an hour apart.
// The first failure is logged in the event table, not every retry. The
// reviewer works without the label meanwhile; a review is still asked for
// with a review request or at the home.
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

/** The wait before the first retry, and the longest between two. */
export const TRIGGER_LABEL_RETRY = { firstMs: 60_000, maxMs: 3_600_000 } as const;

/** The wait after the `failures`-th failure in a row: doubling from the
 * first, capped. */
export function triggerLabelBackoffMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(TRIGGER_LABEL_RETRY.maxMs, TRIGGER_LABEL_RETRY.firstMs * 2 ** (n - 1));
}

/** The outcomes that end the asking until the next start or trigger change. */
const SETTLED: ReadonlySet<TriggerLabelOutcome> = new Set<TriggerLabelOutcome>([
  "not_needed",
  "present",
  "created",
  "recorded",
  "already_exists",
  "unsupported",
]);

export interface TriggerLabelOptions {
  adapter: Partial<TriggerLabelAdapter>;
  /** Now, in ms since the epoch: when a retry is due. */
  now?: () => number;
  /** The trigger the daemon follows now (src/triggerchoice.ts
   * `effectiveTrigger`); undefined while it is unknown. */
  trigger: () => GithubTrigger | undefined;
  /** The configured trigger label's name. */
  name: string;
  log: (msg: string) => void;
  logEvent?: (kind: string, data: Record<string, unknown>) => void;
}

/**
 * The daemon's ensurer: call it after every reconcile pass with whether that
 * pass reached GitHub. It acts after the first such pass, after the first
 * one once the trigger changed, and at each retry that is due until an
 * answer settles it. It never throws. Answers what it did, or null when it
 * did nothing this call.
 */
export function triggerLabelEnsurer(
  o: TriggerLabelOptions,
): (passReachedGitHub: boolean) => Promise<TriggerLabelOutcome | null> {
  const now = o.now ?? (() => Date.now());
  /** The trigger an answer settled; asked nothing again while it holds. */
  let settled: GithubTrigger | undefined;
  /** The trigger being tried, its failures in a row, and the next try. */
  let trying: GithubTrigger | undefined;
  let failures = 0;
  let dueAt = 0;
  return async (passReachedGitHub) => {
    // a pass that did not reach GitHub says GitHub is not answering
    if (!passReachedGitHub) return null;
    let trigger: GithubTrigger | undefined;
    try {
      trigger = o.trigger();
    } catch {
      trigger = undefined;
    }
    // an unknown trigger asks nothing, and is not a change: the next pass
    // that can read it decides
    if (trigger === undefined || trigger === settled) return null;
    if (trigger !== trying) {
      trying = trigger;
      failures = 0;
      dueAt = 0;
    }
    if (now() < dueAt) return null;
    const outcome = await attempt(o, trigger);
    if (SETTLED.has(outcome)) {
      settled = trigger;
      trying = undefined;
      failures = 0;
      dueAt = 0;
      return outcome;
    }
    failures += 1;
    const wait = triggerLabelBackoffMs(failures);
    dueAt = now() + wait;
    o.log(`trigger label "${o.name}": tried again in ${Math.round(wait / 60_000)} min`);
    if (failures === 1) o.logEvent?.("trigger_label_failed", { label: o.name, outcome });
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
        "the reviewer works without it meanwhile",
    );
    return "failed";
  }
}
