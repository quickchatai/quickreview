// `[github] trigger`, as the install's config says it now.
//
// Every other knob is read once, when the daemon loads its config, and a
// change reaches the daemon with its next start. This one the daemon reads
// again at every reconcile pass (`ReconcileDeps.trigger`, src/reconcile.ts),
// so changing which pull requests the reviewer picks up by itself costs no
// restart, and with it no round in flight: a person edits the key, or a
// host's `set-trigger` writes it (src/host/trigger.ts), and the next pass
// follows. The config home is mounted into the daemon's container as a
// directory, so a file replaced there (tmp + rename) is the file read next.
//
// The file is read as text and only this key is taken from it, never the
// loader's whole answer: nothing else the daemon runs on moves between
// starts. A file that cannot be read, is not TOML, or states a value that is
// neither of the two says nothing, and the reader keeps the last word it
// read (first: the one the config was loaded with). So a broken file never
// moves the trigger, in either direction.
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import {
  githubTriggerOf,
  type GithubTrigger,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";

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

export interface LiveTriggerOptions {
  /** The live config.toml. */
  path: string;
  /** The trigger the daemon's config was loaded with. */
  initial: GithubTrigger;
  /** A file's text; throws as `readFileSync` does. */
  read?: (path: string) => string;
  /** Told once per change the reader follows, and once per run of reads
   * that say nothing. */
  log?: (msg: string) => void;
}

/**
 * The trigger as the config at `path` says it, asked again at every call.
 * Never throws and never answers unknown: a read that says nothing answers
 * the last word read.
 */
export function liveTrigger(o: LiveTriggerOptions): () => GithubTrigger {
  const read = o.read ?? ((path: string) => readFileSync(path, "utf8"));
  const log = o.log ?? (() => {});
  let last = o.initial;
  let silent = false;
  return () => {
    let now: GithubTrigger | undefined;
    try {
      now = triggerOfToml(read(o.path));
    } catch {
      now = undefined;
    }
    if (now === undefined) {
      if (!silent)
        log(
          `trigger: ${o.path} cannot be read for [github] trigger; it stays "${last}" until the file says otherwise`,
        );
      silent = true;
      return last;
    }
    silent = false;
    if (now !== last) {
      log(`trigger: [github] trigger is now "${now}" (was "${last}"), followed without a restart`);
      last = now;
    }
    return last;
  };
}
