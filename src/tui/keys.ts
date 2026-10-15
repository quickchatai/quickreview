// Board-mode key decoding. Only the tab / help / msg screens parse keys; a
// focused embedded terminal (the board's pi pane, the companion column) is a
// raw passthrough — nothing here runs for it except the Ctrl-q release.
//
// `o`, `M` and `w` are deliberately not decoded: the TUI never attaches to a
// VM session and has no full-screen detail page (it would duplicate the side
// pane). All three letters are plain text to the companion column.
import { tabDigit, tabForDigit, type Tab } from "./tabs.js";

export type BoardKey =
  | { kind: "up"; arrow?: boolean; wheel?: boolean }
  | { kind: "down"; arrow?: boolean; wheel?: boolean }
  | { kind: "enter" }
  | { kind: "attach" }
  | { kind: "alt-enter" }
  | { kind: "escape" }
  | { kind: "backspace" }
  | { kind: "tab"; tab: Tab }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "message" }
  | { kind: "unwedge" }
  | { kind: "github" }
  | { kind: "events" }
  | { kind: "refresh" }
  | { kind: "reconnect" }
  | { kind: "older" }
  | { kind: "newer" }
  | { kind: "char"; ch: string }
  | { kind: "other"; raw: Buffer };

/** The board verbs typed as one printable — ONE table, read both ways:
 * `decodeKey` maps the letter to the verb, `keyChar` folds the verb back to
 * the letter. (`q` also answers to Ctrl-c; `j`/`k` move and are not here.) */
const PRINTABLE_VERBS = [
  ["a", "attach"], // ⏎'s twin: focus the board's embedded pi pane
  ["q", "quit"],
  ["?", "help"],
  ["m", "message"],
  ["u", "unwedge"],
  ["g", "github"],
  ["e", "events"],
  ["r", "refresh"],
  ["s", "reconnect"],
  ["[", "older"],
  ["]", "newer"],
] as const;

type PrintableVerb = (typeof PRINTABLE_VERBS)[number][1];

const VERB_OF = new Map<string, PrintableVerb>(PRINTABLE_VERBS.map(([ch, kind]) => [ch, kind]));
const CHAR_OF = new Map<string, string>(PRINTABLE_VERBS.map(([ch, kind]) => [kind, ch]));

/** The control keys both decoders share: ⏎, Alt-⏎, Esc, Backspace. */
function decodeControl(s: string): BoardKey | undefined {
  if (s === "\r" || s === "\n") return { kind: "enter" };
  if (s === "\x1b\r" || s === "\x1b\n") return { kind: "alt-enter" };
  if (s === "\x1b") return { kind: "escape" };
  if (s === "\x7f" || s === "\b") return { kind: "backspace" };
  return undefined;
}

/** Typed text: one or more printables, no escape. */
function isText(s: string): boolean {
  return s.length > 0 && !s.includes("\x1b") && s >= " ";
}

/** One stdin chunk → one key. Chunks are decoded whole: interactive typing
 * delivers one key per chunk; paste lands as a single `char` run. */
export function decodeKey(buf: Buffer): BoardKey {
  const s = buf.toString("utf8");
  if (s === "\x1b[A") return { kind: "up", arrow: true };
  if (s === "\x1b[B") return { kind: "down", arrow: true };
  const control = decodeControl(s);
  if (control) return control;
  if (s === "j") return { kind: "down" };
  if (s === "k") return { kind: "up" };
  const tab = tabForDigit(s);
  if (tab !== undefined) return { kind: "tab", tab };
  if (s === "\x03") return { kind: "quit" };
  const verb = VERB_OF.get(s);
  if (verb !== undefined) return { kind: verb };
  if (isText(s)) return { kind: "char", ch: s };
  return { kind: "other", raw: buf };
}

/**
 * The printable a decoded key was typed as, or undefined for keys that were
 * never a single printable (arrows, ⏎, Esc, chords). The metrics tab's `# <pr>`
 * box reads digits through this — `1`…`8` decode as tab switches before any
 * tab handler sees them — and the feedback tab's armed revert reads its `y`.
 */
export function keyChar(key: BoardKey): string | undefined {
  if (key.kind === "char") return key.ch;
  if (key.kind === "tab") return tabDigit(key.tab);
  return CHAR_OF.get(key.kind);
}

/** Msg-box decoding reuses decodeKey but must keep letters as text — the
 * caller routes on mode: in the input box only enter/alt-enter/escape/
 * backspace act; everything printable is text. */
export function decodeInputKey(buf: Buffer): BoardKey {
  const s = buf.toString("utf8");
  const control = decodeControl(s);
  if (control) return control;
  if (s === "\x03") return { kind: "quit" };
  if (isText(s)) return { kind: "char", ch: s };
  return { kind: "other", raw: buf };
}
