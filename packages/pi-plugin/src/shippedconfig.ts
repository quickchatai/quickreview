// A config.toml over the shipped defaults. The file at the asset root,
// `config.example.toml`, is the whole config a review runs on when an install
// has none; a config.toml that sets only some keys is that file with those
// keys changed: every table and key it leaves out takes the shipped value.
// Both parsers (`parseCoreConfig`, packages/pi-plugin/src/reviewconfig.ts, and
// `parseConfig`, src/config.ts) read a config's text through `readConfigToml`
// here, so the CLI, the plugin, the daemon and `qcr config check` cannot
// disagree about what a partial file means. A key the file sets is parsed and
// checked exactly as before.
//
// Two kinds of key are not filled, because their absence is itself an answer
// the parsers read:
//   - keys written together (`FILLED_TOGETHER`): once the file writes one key
//     of a group, the shipped values of the rest stay out. An older spelling
//     the file still uses is never shadowed by the shipped current spelling
//     (legacy input folds are accepted for good), and a hosted embedder that
//     names no model gets the hosted model, never the shipped local one.
//   - keys never filled (`NEVER_FILLED`): `[scan] sandbox` unset means "host"
//     inside the companion container, so the shipped "docker" does not fill it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { assetRoot } from "./assetroot.js";
import { LEGACY_TIER_NAMES, PASS_TIER_ORDER } from "./types.js";

/** The file that carries the shipped defaults, at the asset root: the values
 * a review runs on when the install has no config of its own, and under every
 * key a config.toml leaves out. */
export const SHIPPED_CONFIG_FILE = "config.example.toml";

/** Groups of keys (dotted paths) whose meaning depends on each other: when
 * the file writes any key of a group, the shipped values of the others are
 * not filled, and the parsers decide them as they always have. */
export const FILLED_TOGETHER: readonly (readonly string[])[] = [
  // `[models] model`, and the older keys that fold to it.
  ["models.model", "models.conversation", "models.default"],
  // Each rung of `[models.tiers]`, in either spelling.
  ...PASS_TIER_ORDER.map((tier) => [
    `models.tiers.${tier}`,
    ...Object.keys(LEGACY_TIER_NAMES)
      .filter((name) => LEGACY_TIER_NAMES[name] === tier)
      .map((name) => `models.tiers.${name}`),
  ]),
  // `[owner] slack_id`, and its older alias in `[slack]`.
  ["owner.slack_id", "slack.legacy_owner_slack_id"],
  // The embedder: a hosted provider with no model named runs the hosted
  // model, and a named model with no dimension is refused, never the
  // shipped local model's 384.
  ["openviking.embedding_provider", "openviking.embedding_model", "openviking.embedding_dimension"],
];

/** Keys the shipped file never fills: the parsers read their absence. */
export const NEVER_FILLED: readonly string[] = ["scan.sandbox"];

type Table = Record<string, unknown>;

/** A TOML table (or inline table): a plain object, never an array or a date. */
function isTable(v: unknown): v is Table {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Does `table` hold the dotted `path`? */
function holds(table: Table, path: string): boolean {
  let at: unknown = table;
  for (const key of path.split(".")) {
    if (!isTable(at) || !Object.hasOwn(at, key)) return false;
    at = at[key];
  }
  return true;
}

/** The dotted paths the shipped file does not fill under `written`. */
export function heldBack(written: Table): Set<string> {
  const held = new Set(NEVER_FILLED);
  for (const group of FILLED_TOGETHER)
    if (group.some((path) => holds(written, path)))
      for (const path of group) if (!holds(written, path)) held.add(path);
  return held;
}

/**
 * `written` over `shipped`: every key `written` sets as written (a table it
 * sets merges key by key; an array, a value, or a table where the shipped
 * file has a value is taken whole), and every key it leaves out from
 * `shipped`, except those `heldBack` names. Neither argument is changed.
 */
export function overShipped(written: Table, shipped: Table): Table {
  const held = heldBack(written);
  const merge = (w: Table, s: Table, at: string): Table => {
    const out: Table = { ...w };
    for (const [key, value] of Object.entries(s)) {
      const path = at === "" ? key : `${at}.${key}`;
      if (!Object.hasOwn(w, key)) {
        // A table the file leaves out is filled key by key too, so a key
        // held back inside it stays out.
        if (!held.has(path)) out[key] = isTable(value) ? merge({}, value, path) : value;
      } else if (isTable(w[key]) && isTable(value)) {
        out[key] = merge(w[key], value, path);
      }
    }
    return out;
  };
  return merge(written, shipped, "");
}

const shippedText = new Map<string, string>();

/** The shipped defaults' text at `root` (the asset root by default), read
 * once per root. */
export function shippedConfigText(root: string = assetRoot()): string {
  let text = shippedText.get(root);
  if (text === undefined) {
    text = readFileSync(join(root, SHIPPED_CONFIG_FILE), "utf8");
    shippedText.set(root, text);
  }
  return text;
}

/** A config.toml's text as the parsers read it: its own tables over the
 * shipped defaults (`overShipped`). A file that is no TOML throws the TOML
 * parser's error, as before. `shipped` is the defaults' text; by default the
 * asset root's. */
export function readConfigToml(toml: string, shipped: string = shippedConfigText()): Table {
  const written = parse(toml) as Table;
  // Parsed afresh each time: the parsers may keep what they are handed.
  return overShipped(written, parse(shipped));
}
