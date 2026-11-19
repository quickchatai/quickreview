// Which pull requests the reviewer picks up by itself: the labelled ones
// (`label`), or every open one that is not a draft and not its own (`all`).
//
// Two sources say it:
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
// The later of the two wins. The store keeps, with the choice, what the
// config's `[github] trigger` line said when it was made (`triggerLineOf`:
// its word, or no line at all, which is not the same as a line that says
// `label`); a daemon that starts on a config whose line says something else
// drops the choice (`settleTriggerChoice`), since the config was set after
// it. So a `host setup --trigger` that writes another line overrides an
// earlier `set-trigger`, and the board export's `trigger` then says what
// setup wrote. A setup that restates the very line the choice was made over
// changes nothing on disk, and the choice stands.
//
// The choice is never written into config.toml. The config is on the round
// fingerprint's policy surface (src/execboundary.ts, layer 4 of the exec
// boundary): a rewrite while a round runs is reported as the boundary's own
// controls changed under it. A host changes the trigger as routine, with
// rounds in flight, so its change goes where that check does not look.
//
// `effectiveTrigger` is the one reading of the two. The reconcile pass
// (src/reconcile.ts), the board export's `trigger` (src/boardexport.ts) and
// the home's line about what auto-review picks up (src/home/autoreview.ts)
// all ask it, so the three cannot disagree. Where the choice could apply and
// cannot be read (the daemon is off, or its store did not answer), the
// trigger is unknown, never the config's word in its place.
//
// A leaf: it loads no store, so the export and the home can import it where
// the SQLite driver cannot load.
import { parse } from "smol-toml";
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
 * The trigger the reviewer runs on: on a host-managed install the host's
 * choice where it made one, else the config's word. Undefined is unknown.
 */
export function effectiveTrigger(f: TriggerFacts): GithubTrigger | undefined {
  if (!f.hostManaged) return f.configured;
  if (f.chosen === undefined) return undefined;
  return f.chosen ?? f.configured;
}

/** A stored or reported choice, re-read: a word, null for none, undefined
 * for anything else (an older daemon's file, a value this release does not
 * know). */
export function triggerChoiceOf(v: unknown): GithubTrigger | null | undefined {
  if (v === null) return null;
  return GITHUB_TRIGGERS.find((t) => t === v);
}

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What a config.toml's text writes on its `[github] trigger` line: the word,
 * null when there is no such line, undefined when the text cannot say (not
 * TOML, or a value that is neither word). It is not the trigger the reviewer
 * runs on (that is `effectiveTrigger`, over the parsed config, where no line
 * reads as `label`): it is what a host's choice is kept beside, so a later
 * rewrite of the line can be told from the line the choice was made over.
 */
export function triggerLineOf(toml: string): GithubTrigger | null | undefined {
  let doc: unknown;
  try {
    doc = parse(toml);
  } catch {
    return undefined;
  }
  if (!isTable(doc)) return undefined;
  const github = doc["github"];
  if (github === undefined) return null;
  if (!isTable(github)) return undefined;
  if (github["trigger"] === undefined) return null;
  return GITHUB_TRIGGERS.find((t) => t === github["trigger"]);
}

/** The event a host's choice is logged under. */
export const TRIGGER_CHOSEN_EVENT = "trigger_chosen";

/** The event a choice the config was set over is dropped under. */
export const TRIGGER_CHOICE_DROPPED_EVENT = "trigger_choice_dropped";

export interface ChooseTriggerDeps {
  store: Pick<StateStore, "setTriggerChoice" | "logEvent">;
  /** The daemon's config names a host as its manager. */
  hostManaged: boolean;
  /** The config's `[github] trigger` line as the daemon's start read it
   * (`triggerLineOf`); null where it has none. Kept with the choice. */
  configured: GithubTrigger | null;
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
  const was = deps.store.setTriggerChoice(trigger, file, deps.configured);
  deps.store.logEvent(TRIGGER_CHOSEN_EVENT, null, { trigger, was, file });
  if (was !== trigger)
    deps.log?.(
      `trigger: a host chose "${trigger}" (was ${was === null ? "the config's" : `"${was}"`})`,
    );
  return { ok: true, trigger };
}

export interface SettleTriggerChoiceDeps {
  store: Pick<StateStore, "dropTriggerChoiceSetOver" | "logEvent">;
  hostManaged: boolean;
  /** The config's `[github] trigger` line as this start read it
   * (`triggerLineOf`); null where it has none. */
  configured: GithubTrigger | null;
  log?: (line: string) => void;
}

/**
 * The daemon's start: drop the host's choice when the config's `[github]
 * trigger` says something else than it did when the choice was made, so the
 * later of the two is the one followed. Never throws: a store that cannot
 * say leaves the choice as it is, and the reconcile pass reads it as ever.
 * What was dropped, or null.
 */
export function settleTriggerChoice(deps: SettleTriggerChoiceDeps): GithubTrigger | null {
  if (!deps.hostManaged) return null;
  let dropped: ReturnType<StateStore["dropTriggerChoiceSetOver"]>;
  try {
    dropped = deps.store.dropTriggerChoiceSetOver(deps.configured);
  } catch (err) {
    deps.log?.(
      `trigger: whether the config was set after the host's choice could not be read (${err instanceof Error ? err.message : String(err)}); the choice stands`,
    );
    return null;
  }
  if (dropped === null) return null;
  const said = (t: GithubTrigger | null): string => (t === null ? "no trigger" : `"${t}"`);
  try {
    deps.store.logEvent(TRIGGER_CHOICE_DROPPED_EVENT, null, {
      trigger: dropped.trigger,
      config_was: dropped.was_configured,
      config_is: deps.configured,
    });
  } catch {
    // the event is a record of the drop, not the drop
  }
  deps.log?.(
    `trigger: the host's choice "${dropped.trigger}" is dropped: the config's [github] trigger says ${said(deps.configured)} where it said ${said(dropped.was_configured)} when the choice was made, so it was set after it`,
  );
  return dropped.trigger;
}
