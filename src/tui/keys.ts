// Board-mode key decoding. Only the board/digest/help/msg screens parse keys;
// attach mode is a raw passthrough with a single chord scan (attach.ts) —
// nothing here runs while attached.
export type BoardKey =
  | { kind: "up"; arrow?: boolean }
  | { kind: "down"; arrow?: boolean }
  | { kind: "enter" }
  | { kind: "alt-enter" }
  | { kind: "escape" }
  | { kind: "backspace" }
  | { kind: "tab-board" }
  | { kind: "tab-digest" }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "detail" }
  | { kind: "message" }
  | { kind: "github" }
  | { kind: "overseer" }
  | { kind: "main-session" }
  | { kind: "events" }
  | { kind: "refresh" }
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
  if (s === "j") return { kind: "down" };
  if (s === "k") return { kind: "up" };
  if (s === "1") return { kind: "tab-board" };
  if (s === "2") return { kind: "tab-digest" };
  if (s === "q" || s === "\x03") return { kind: "quit" };
  if (s === "?") return { kind: "help" };
  if (s === "w") return { kind: "detail" };
  if (s === "m") return { kind: "message" };
  if (s === "g") return { kind: "github" };
  if (s === "o") return { kind: "overseer" };
  if (s === "M") return { kind: "main-session" };
  if (s === "e") return { kind: "events" };
  if (s === "r") return { kind: "refresh" };
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
