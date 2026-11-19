// The config a host's setup verb writes (src/host/setup.ts): the repository
// its operator bound, on the shipped template or on the install's own config,
// through the config fill's writer (configfill.ts) and never touching
// `dry_run`.
//
// A host's setup acts on installs a host manages. A config that is not there
// yet is written as one: the shipped template with the marker
// (`[github] token_source = "host"`) and the auth mode the host named. A
// config that is there is never given the marker here: its own decides, and
// the verb refuses one without it before this writer is asked.
//
// Four things happen to the text, in order:
//
//   1. A config that leaves the root `dry_run` key out is completed from the
//      shipped template. A host may have written a config holding nothing
//      but its own marker, and the go-live step changes the flag only in a
//      file that states it (it never invents the key). The template is taken
//      whole and every key the file sets is carried onto it; a key the
//      shipped defaults never fill under such a file (`heldBack`,
//      packages/pi-plugin/src/shippedconfig.ts) is commented out of it. The
//      result then reads exactly as the file did over the shipped defaults:
//      that is checked, and a file it would not hold for is refused. The
//      flag the result states is the template's own line, which ships
//      `true`.
//   2. The repository and its default branch are written, as the home's
//      repository pick writes them (repoconfig.ts), with the machine's
//      timezone where the config names none of its own.
//   3. On a host-managed install (`[github] token_source = "host"`: the
//      marker the text carries, or the one a new config is written with) the
//      improvement-PR filer and the bot's own issues are turned off: their
//      caps go to zero, and a cap of zero is reached before the first one is
//      filed (src/improvements.ts). The token such a host supplies then never
//      needs to write contents or issues. The auth mode the host named is
//      stated beside the marker, which does not load without one
//      (packages/pi-plugin/src/reviewconfig.ts `parseGithubSection`): the
//      home's own review reads this config before the walk's account step
//      has written the rest of the identity. Under `auth = "installation"`
//      the App's slug and the login it implies (`<slug>[bot]`) are stated
//      with it: that mode does not load without the slug, the session
//      helpers read the login off the file as written, and there is no App
//      key on the machine to ask either from.
//
//   4. On such an install the trigger the host named (`[github] trigger`:
//      labelled pull requests, or every pull request) is stated too. A host
//      that named none leaves the config's own. Changing it later is no
//      config edit: a host's `set-trigger` goes to the running daemon, which
//      keeps the choice in its own store (src/triggerchoice.ts).
//
// The last check is the rule itself: the text that comes out states the same
// `dry_run` as the text that went in, read as the daemon reads it. Anything
// else is refused and nothing is written (invariant 6).
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import type { GithubTrigger } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { heldBack, readConfigToml } from "@quickchatai/pi-quickreview/src/shippedconfig.js";
import {
  assertNoDryRunEdit,
  changedEdits,
  patchToml,
  tomlString,
  type TomlEdit,
} from "./configfill.js";
import { botLoginFor } from "../choices.js";
import { renderRepoConfig } from "./repoconfig.js";

/** An error in one line: a TOML parser's message goes on to quote the
 * document, and these words end up in a one-line refusal. */
const message = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** What a host's setup writes. */
export interface HostConfigChoice {
  /** `owner/name`, as GitHub spells it. */
  repo: string;
  /** The repository's default branch; null leaves the config's as it is. */
  baseBranch: string | null;
  /** The machine's IANA timezone; fills an empty `[ops] timezone` only. */
  timezone: string | null;
  /** Which pull requests the reviewer picks up by itself (`[github]
   * trigger`), when the host said. Left out, the config's own stays: `label`
   * on a new one. Written on a host-managed config only. */
  trigger?: GithubTrigger;
  /** The auth mode the host named. Written beside the marker: with it on a
   * new config, and on a config that already carries it. A config without
   * the marker is left its own (the verb refuses such a config; this writer
   * never marks one). */
  auth: "user" | "installation";
  /** The slug of the App an installation token belongs to: with
   * `installation`, always. Written with the login it implies. */
  appSlug?: string;
}

/** The caps that switch the improvement-PR filer and the bot's own issues
 * off: zero of each per day and per week. */
export const HOST_MANAGED_CAPS: readonly TomlEdit[] = [
  { section: "caps", key: "improvement_pr_per_day", value: "0" },
  { section: "caps", key: "improvement_pr_per_week", value: "0" },
  { section: "caps", key: "issues_per_day", value: "0" },
];

/** A TOML value as text, for the values a carried key can hold; null for one
 * this writer does not render (a table inside an array, a date). */
function renderValue(v: unknown): string | null {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) {
    const items = v.map((x) => (Array.isArray(x) ? null : renderValue(x)));
    return items.every((x): x is string => x !== null) ? `[${items.join(", ")}]` : null;
  }
  return null;
}

/** Every key `doc` sets, as an edit; a string naming the first it cannot say. */
function editsOf(doc: Table, section = ""): TomlEdit[] | string {
  const out: TomlEdit[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (isTable(value)) {
      const inner = editsOf(value, section === "" ? key : `${section}.${key}`);
      if (typeof inner === "string") return inner;
      out.push(...inner);
      continue;
    }
    const rendered = /^[A-Za-z0-9_-]+$/.test(key) ? renderValue(value) : null;
    if (rendered === null) return section === "" ? key : `[${section}] ${key}`;
    out.push({ section, key, value: rendered });
  }
  return out;
}

const TABLE_HEADER = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with the one-line assignment at the dotted `path` commented out;
 * `text` itself when there is none. */
function commentOut(text: string, path: string): string {
  const dot = path.lastIndexOf(".");
  const section = dot < 0 ? "" : path.slice(0, dot);
  const assignment = new RegExp(`^\\s*${escapeRe(dot < 0 ? path : path.slice(dot + 1))}\\s*=`);
  let current = "";
  return text
    .split("\n")
    .map((line) => {
      const header = TABLE_HEADER.exec(line.replace(/\r$/, ""));
      if (header) {
        current = header[1]!.trim();
        return line;
      }
      return current === section && assignment.test(line) ? `# ${line}` : line;
    })
    .join("\n");
}

/** The root `dry_run` a config text states over the shipped defaults. */
function dryRunOf(toml: string, template: string): unknown {
  return readConfigToml(toml, template)["dry_run"];
}

/**
 * `existing` completed from `template`: the template's text with every key
 * `existing` sets carried onto it. Refused unless the result reads, over the
 * shipped defaults, exactly as `existing` does.
 */
export function completeFromTemplate(
  existing: string,
  template: string,
): { ok: true; text: string } | { ok: false; why: string } {
  let doc: Table;
  try {
    doc = parse(existing);
  } catch (err) {
    return { ok: false, why: `the config is not valid TOML (${message(err)})` };
  }
  const edits = editsOf(doc);
  if (typeof edits === "string")
    return {
      ok: false,
      why: `the config leaves out dry_run, and its ${edits} cannot be carried onto the shipped template`,
    };
  try {
    assertNoDryRunEdit(edits);
    let text = patchToml(template, changedEdits(template, edits));
    // what the shipped defaults do not fill under this file is not stated either
    for (const path of heldBack(doc)) text = commentOut(text, path);
    if (!isDeepStrictEqual(readConfigToml(text, template), readConfigToml(existing, template)))
      return {
        ok: false,
        why: "the config leaves out dry_run, and completing it from the shipped template would change what it says",
      };
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      why: `the config leaves out dry_run, and it could not be completed from the shipped template (${message(err)})`,
    };
  }
}

export type HostConfigRender =
  | {
      ok: true;
      text: string;
      /** Is the result a host-managed install's config? */
      hostManaged: boolean;
      /** The config was completed from the shipped template. */
      completed: boolean;
    }
  | { ok: false; why: string };

/**
 * The config text a host's setup writes, from `existing` (null: none yet, so
 * the template). Pure: the caller writes it. A refusal says why, and then
 * nothing is to be written.
 */
export function renderHostConfig(
  existing: string | null,
  template: string,
  choice: HostConfigChoice,
): HostConfigRender {
  let before: unknown;
  let source = existing;
  let completed = false;
  // A completed config takes the machine's timezone as a new one does, unless
  // the file it was completed from named its own.
  let timezoneOpen = false;
  try {
    before = dryRunOf(existing ?? template, template);
    const written = existing === null ? null : (parse(existing) as Table);
    if (existing !== null && written !== null && !Object.hasOwn(written, "dry_run")) {
      const whole = completeFromTemplate(existing, template);
      if (!whole.ok) return { ok: false, why: `${whole.why}; nothing was written` };
      source = whole.text;
      completed = true;
      const ops = written["ops"];
      timezoneOpen = !(isTable(ops) && Object.hasOwn(ops, "timezone"));
    }
  } catch (err) {
    return {
      ok: false,
      why: `the config is not valid TOML (${message(err)}); nothing was written`,
    };
  }
  const withRepo = renderRepoConfig(source, template, {
    repo: choice.repo,
    baseBranch: choice.baseBranch,
    timezone: choice.timezone,
    ownerName: null,
    ownerLogin: null,
  });
  if (!withRepo.ok) return withRepo;
  let text = withRepo.text;
  let hostManaged: boolean;
  try {
    const github = (parse(text) as Table)["github"];
    // A new config is its host's from its first line; one that is there
    // says for itself whether a host manages it.
    const marks = existing === null;
    hostManaged = marks || (isTable(github) && github["token_source"] === "host");
    const more: TomlEdit[] = [
      ...(marks ? [{ section: "github", key: "token_source", value: tomlString("host") }] : []),
      ...(timezoneOpen && choice.timezone
        ? [{ section: "ops", key: "timezone", value: tomlString(choice.timezone) }]
        : []),
      ...(hostManaged ? [{ section: "github", key: "auth", value: tomlString(choice.auth) }] : []),
      ...(hostManaged && choice.auth === "installation" && choice.appSlug !== undefined
        ? [
            { section: "github", key: "app_slug", value: tomlString(choice.appSlug) },
            { section: "github", key: "bot_login", value: tomlString(botLoginFor(choice.appSlug)) },
          ]
        : []),
      ...(hostManaged && choice.trigger !== undefined
        ? [{ section: "github", key: "trigger", value: tomlString(choice.trigger) }]
        : []),
      ...(hostManaged ? HOST_MANAGED_CAPS : []),
    ];
    assertNoDryRunEdit(more);
    const edits = changedEdits(text, more);
    if (edits.length > 0) text = patchToml(text, edits);
    if (!Object.is(dryRunOf(text, template), before))
      return {
        ok: false,
        why: "the written config would state another dry_run than the one it had; nothing was written (invariant 6)",
      };
  } catch (err) {
    return {
      ok: false,
      why: `the patched config would not parse (${message(err)}); nothing was written`,
    };
  }
  return { ok: true, text, hostManaged, completed };
}
