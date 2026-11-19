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
  githubTriggerOf,
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
 * What a config.toml's text says of the trigger: the value it states, `label`
 * when it states none (the key's default), undefined when the text is not
 * TOML or the value is neither `label` nor `all`.
 */
export function triggerOfToml(toml: string): GithubTrigger | undefined {
  let doc: unknown;
  try {
    doc = parse(toml);
  } catch {
    return undefined;
  }
  if (!isTable(doc)) return undefined;
  const raw = doc["github"];
  // no `[github]` table states no trigger; one that is no table says nothing
  const github: Record<string, unknown> | null = raw === undefined ? {} : isTable(raw) ? raw : null;
  return github === null ? undefined : githubTriggerOf(github["trigger"]);
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
