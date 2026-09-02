// Board-mode key decoding. Only the board/digest/help/msg screens parse keys;
// a FOCUSED embedded terminal (the board's pi pane, the companion column) is
// a raw passthrough — nothing here runs for it except the Ctrl-q release.
//
// `o` (overseer) and `M` (main session) used to decode to full-screen attach
// verbs. Retired 2026-09-02 on the owner's order: the TUI never attaches to a
// VM session — both letters now fall through as plain text to the companion
// column, which is where an operator asks about the overseer.
export type BoardKey =
  | { kind: "up"; arrow?: boolean; wheel?: boolean }
  | { kind: "down"; arrow?: boolean; wheel?: boolean }
  | { kind: "enter" }
  | { kind: "attach" }
  | { kind: "alt-enter" }
  | { kind: "escape" }
  | { kind: "backspace" }
  | { kind: "tab-board" }
  | { kind: "tab-digest" }
  | { kind: "tab-deploy" }
  | { kind: "tab-metrics" }
  | { kind: "tab-changes" }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "detail" }
  | { kind: "message" }
  | { kind: "unwedge" }
  | { kind: "github" }
  | { kind: "events" }
  | { kind: "refresh" }
  | { kind: "reconnect" }
  | { kind: "digest-older" }
  | { kind: "digest-newer" }
  | { kind: "char"; ch: string }
  | { kind: "other"; raw: Buffer };

/** One stdin chunk → one key. Chunks are decoded whole: interactive typing
 * delivers one key per chunk; paste lands as a single `char` run. */
export function decodeKey(buf: Buffer): BoardKey {
  const s = buf.toString("utf8");
  if (s === "\x1b[A") return { kind: "up", arrow: true };
  if (s === "\x1b[B") return { kind: "down", arrow: true };
  if (s === "\r" || s === "\n") return { kind: "enter" };
  if (s === "\x1b\r" || s === "\x1b\n") return { kind: "alt-enter" };
  if (s === "\x1b") return { kind: "escape" };
  if (s === "\x7f" || s === "\b") return { kind: "backspace" };
  if (s === "a") return { kind: "attach" }; // ⏎'s twin: focus the board's embedded pi pane
  if (s === "j") return { kind: "down" };
  if (s === "k") return { kind: "up" };
  if (s === "1") return { kind: "tab-board" };
  if (s === "2") return { kind: "tab-digest" };
  if (s === "3") return { kind: "tab-deploy" };
  if (s === "4") return { kind: "tab-metrics" };
  if (s === "5") return { kind: "tab-changes" }; // — the change register
  if (s === "q" || s === "\x03") return { kind: "quit" };
  if (s === "?") return { kind: "help" };
  if (s === "w") return { kind: "detail" };
  if (s === "m") return { kind: "message" };
  if (s === "u") return { kind: "unwedge" };
  if (s === "g") return { kind: "github" };
  if (s === "e") return { kind: "events" };
  if (s === "r") return { kind: "refresh" };
  if (s === "s") return { kind: "reconnect" };
  if (s === "[") return { kind: "digest-older" };
  if (s === "]") return { kind: "digest-newer" };
  if (s.length > 0 && !s.includes("\x1b") && s >= " ") return { kind: "char", ch: s };
  return { kind: "other", raw: buf };
}

/** Msg-box decoding reuses decodeKey but must keep letters as text — the
 * caller routes on mode: in the input box only enter/alt-enter/escape/
 * backspace act; everything printable is text. */
export function decodeInputKey(buf: Buffer): BoardKey {
  const s = buf.toString("utf8");
  if (s === "\r" || s === "\n") return { kind: "enter" };
  if (s === "\x1b\r" || s === "\x1b\n") return { kind: "alt-enter" };
  if (s === "\x1b") return { kind: "escape" };
  if (s === "\x7f" || s === "\b") return { kind: "backspace" };
  if (s === "\x03") return { kind: "quit" };
  if (s.length > 0 && !s.includes("\x1b") && s >= " ") return { kind: "char", ch: s };
  return { kind: "other", raw: buf };
}
