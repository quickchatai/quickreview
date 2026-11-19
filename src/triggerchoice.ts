// Which pull requests the reviewer picks up by itself: the labelled ones
// (`label`), or every open one that is not a draft and not its own (`all`).
//
// Two sources say it, and they are not equals:
//
//   the config   `[github] trigger`, read when the daemon starts. A person
//                states it there; on a host-managed install only `host
//                setup` writes it.
//   the choice   on a host-managed install, what the host's `set-trigger`
//                sent through the sealed operator channel (the `set-trigger`
//                operator command, src/commands.ts), kept in the daemon's
//                own store (`trigger_choice`, src/state.ts). It survives a
//                restart, and it wins over the config's word.
//
// The choice is the one source of truth, and the latest choice wins. The
// config's word is only the starting value: what the reviewer follows where
// no choice was ever stored. `host setup --trigger` writes that starting
// value and, once the reviewer is up, hands the same word through the same
// channel (src/host/walk.ts, the `trigger` step), so a setup run again with
// another word takes effect at once, with no restart, and a `set-trigger`
// after it wins over it in turn.
//
// The choice is never written into config.toml. The config is on the round
// fingerprint's policy surface (src/execboundary.ts, layer 4 of the exec
// boundary): a rewrite while a round runs is reported as the boundary's own
// controls changed under it. A host changes the trigger as routine, with
// rounds in flight, so its change goes where that check does not look.
//
// `effectiveTrigger` is the one reading of the two, and the daemon is the
// one that makes it: its reconcile pass (src/reconcile.ts) and its trigger
// label (src/triggerlabel.ts) follow it, and it writes the word it follows
// into its status snapshot and its board (`trigger`). The board export
// (src/boardexport.ts) and the home's line about what auto-review picks up
// (src/home/autoreview.ts) report that writing (`followedTriggerOf`), never
// the config file's word: the file can say something else than the running
// daemon follows. With the daemon off, or its store not answering, the
// trigger is unknown on a host-managed install, where a stored choice may
// stand over the file. On any other install no choice applies, and the home
// may name the config's word while the daemon is off as what it starts on.
//
// A leaf: it loads no store, so the export and the home can import it where
// the SQLite driver cannot load.
import {
  GITHUB_TRIGGERS,
  type GithubTrigger,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import type { FileOutcome } from "./improvements.js";
import type { StateStore } from "./state.js";

/** What the trigger is read from. */
export interface TriggerFacts {
  /** The install's config says a host manages it (`[github] token_source =
   * "host"`). Only there does a host's choice apply: anywhere else the
   * trigger is the config's own line. */
  hostManaged: boolean;
  /** The host's choice as the daemon's store holds it: a word, null when no
   * choice was made, undefined when it cannot be read. */
  chosen: GithubTrigger | null | undefined;
  /** The config's `[github] trigger`; undefined when it cannot be read. */
  configured: GithubTrigger | undefined;
}

/**
 * The trigger the reviewer runs on: on a host-managed install the latest
 * choice the store holds, else (no choice was ever stored) the config's word,
 * the starting value. Undefined is unknown.
 */
export function effectiveTrigger(f: TriggerFacts): GithubTrigger | undefined {
  if (!f.hostManaged) return f.configured;
  if (f.chosen === undefined) return undefined;
  return f.chosen ?? f.configured;
}

/** The trigger a daemon wrote that it follows (its status snapshot's or its
 * board's `trigger`), re-read: one of the two words, undefined for anything
 * else (no word, an older daemon's file, a value this release does not
 * know). */
export function followedTriggerOf(v: unknown): GithubTrigger | undefined {
  return GITHUB_TRIGGERS.find((t) => t === v);
}

/** The event a host's choice is logged under. */
export const TRIGGER_CHOSEN_EVENT = "trigger_chosen";

export interface ChooseTriggerDeps {
  store: Pick<StateStore, "setTriggerChoice" | "logEvent">;
  /** The daemon's config names a host as its manager. */
  hostManaged: boolean;
  log?: (line: string) => void;
}

/**
 * The daemon's handler of the `set-trigger` operator command: keep the
 * host's choice in the store, where the next reconcile pass reads it. It
 * starts nothing, restarts nothing and touches no file; a round in flight
 * runs on. Refused on an install no host manages: there the trigger is the
 * config's own line, and a choice kept beside it would be one nobody sees.
 */
export function chooseTrigger(
  deps: ChooseTriggerDeps,
  trigger: GithubTrigger,
  file: string,
): FileOutcome {
  if (!deps.hostManaged)
    return {
      ok: false,
      reason:
        "this install's config does not say a host manages it ([github] token_source = \"host\"): its trigger is the config's own [github] trigger",
    };
  const was = deps.store.setTriggerChoice(trigger, file);
  deps.store.logEvent(TRIGGER_CHOSEN_EVENT, null, { trigger, was, file });
  if (was !== trigger)
    deps.log?.(
      `trigger: a host chose "${trigger}" (was ${was === null ? "the config's" : `"${was}"`})`,
    );
  return { ok: true, trigger };
}
