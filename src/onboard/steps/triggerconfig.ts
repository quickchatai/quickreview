// `[github] trigger`, written into an install's config.toml: the one edit a
// host's `set-trigger` makes (src/host/trigger.ts), through the config fill's
// writer (configfill.ts) and never touching `dry_run`.
//
// The result is held to the rule before it is handed back: read as TOML, the
// text that comes out says exactly what the text that went in said, with that
// one key at the value asked for. Anything else is refused and nothing is to
// be written. That one check covers the owner's flag with every other key
// (invariant 6): a writer that changed `dry_run`, or anything beside the
// trigger, would not pass it.
//
// Comments, blank lines and key order survive, as with every edit the writer
// makes: an assignment that is there has its value replaced, the shipped
// template's commented-out line is uncommented in place, and a `[github]`
// table without the key gets it as its last line.
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import {
  githubTriggerOf,
  type GithubTrigger,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { assertNoDryRunEdit, changedEdits, patchToml, tomlString } from "./configfill.js";

/** An error in one line: a TOML parser's message goes on to quote the
 * document, and these words end up in a one-line refusal. */
const message = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type TriggerConfigRender =
  | {
      ok: true;
      text: string;
      /** False when the config already says that trigger (stated, or by
       * leaving the key out where the default is asked for): `text` is then
       * `existing` itself, and there is nothing to write. */
      changed: boolean;
    }
  | { ok: false; why: string };

/**
 * `existing` with `[github] trigger` at `trigger`. Pure: the caller writes
 * it. A refusal says why, and then nothing is to be written.
 */
export function renderTriggerConfig(existing: string, trigger: GithubTrigger): TriggerConfigRender {
  let before: Table;
  try {
    before = parse(existing);
  } catch (err) {
    return {
      ok: false,
      why: `the config is not valid TOML (${message(err)}); nothing was written`,
    };
  }
  const raw = before["github"];
  const github: Table | null = raw === undefined ? {} : isTable(raw) ? raw : null;
  if (github === null)
    return { ok: false, why: "the config's [github] is not a table; nothing was written" };
  if (githubTriggerOf(github["trigger"]) === trigger)
    return { ok: true, text: existing, changed: false };
  const wanted = [{ section: "github", key: "trigger", value: tomlString(trigger) }];
  let text: string;
  let after: Table;
  let expected: Table;
  try {
    assertNoDryRunEdit(wanted);
    const edits = changedEdits(existing, wanted);
    if (edits.length === 0) return { ok: true, text: existing, changed: false };
    text = patchToml(existing, edits);
    after = parse(text);
    // what the result must say: what the config said, and the trigger. Read
    // a second time so the two sides are the same parser's objects.
    expected = parse(existing);
    const table = expected["github"];
    if (isTable(table)) table["trigger"] = trigger;
    else expected["github"] = parse(`trigger = ${tomlString(trigger)}`);
  } catch (err) {
    return {
      ok: false,
      why: `the patched config would not parse (${message(err)}); nothing was written`,
    };
  }
  if (!isDeepStrictEqual(after, expected))
    return {
      ok: false,
      why: "the patched config would say something else than the config it was made from, beside the trigger; nothing was written",
    };
  return { ok: true, text, changed: true };
}
