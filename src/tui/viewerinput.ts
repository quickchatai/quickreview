// The transcript viewer's input line: what the operator types under a
// worker-hosted PR's transcript (the PR-pane rule in CLAUDE.md). The viewer is
// not a pi surface, so it has an input line of its own — the one exception to
// "never add a TUI-side input box", and only on the worker, answer and idle
// panes (`paneSurface`); a debug or takeover pane is a pi terminal and never
// gets one.
//
// Pure on purpose: `viewerInputKey` takes the state and one stdin chunk and
// answers with the next state and what to do (send a control, ask to confirm an
// abort, say something), so every key is testable without a screen. Painting is
// `viewerInputRow`, and the App wires both to the operator control route
// (`livecontrol.ts`).
//
//   ⏎        steers the running session while a round runs; on an idle PR it
//            sends a `message` (which carries `may_post` when the toggle is on)
//   Alt-⏎    queues a follow-up behind the running turn (a round must be running)
//   Alt-p    toggles `may_post` for the next message; shown, and reset on send
//   Ctrl-c   asks to abort the round; `y` confirms, any other key cancels
//   Ctrl-u   clears the draft; Esc clears it too, or leaves an empty line alone
//
// `[ ] < >` step the viewer's streams and rounds only while the draft is empty:
// once there is text they are text, so a message can contain brackets.
import { CONTROL_TEXT_MAX } from "../commands.js";
import { displayWidth, sanitizeText, truncate } from "./paint.js";
import { FG, RESET } from "./theme.js";

export interface ViewerInput {
  text: string;
  /** The next message may post (the Alt-p toggle). */
  mayPost: boolean;
  /** The abort prompt is up: the next key answers it. */
  confirmAbort: boolean;
}

export const newViewerInput = (): ViewerInput => ({
  text: "",
  mayPost: false,
  confirmAbort: false,
});

/** What the line asks the App to do. */
export type ViewerInputEffect =
  | { t: "none" }
  | { t: "send"; kind: "steer" | "follow-up"; text: string }
  | { t: "send"; kind: "message"; text: string; may_post: boolean }
  | { t: "abort" }
  | { t: "notice"; text: string };

export interface ViewerInputResult {
  state: ViewerInput;
  effect: ViewerInputEffect;
  /** The key was the line's. False leaves it to the viewer's own keys. */
  handled: boolean;
}

/** The viewer's navigation keys: text once there is a draft. */
const NAV_KEYS = new Set(["[", "]", "<", ">"]);

/**
 * One stdin chunk against the line. `running` is whether a round (or an answer)
 * is running for the PR, which decides what ⏎ is: a steer, or a message.
 */
export function viewerInputKey(
  state: ViewerInput,
  raw: string,
  running: boolean,
): ViewerInputResult {
  const done = (
    next: Partial<ViewerInput>,
    effect: ViewerInputEffect = { t: "none" },
  ): ViewerInputResult => ({ state: { ...state, ...next }, effect, handled: true });

  // The abort prompt owns the next key: `y` confirms, anything else is "no".
  if (state.confirmAbort)
    return raw === "y" || raw === "Y"
      ? done({ confirmAbort: false }, { t: "abort" })
      : done({ confirmAbort: false });

  if (raw === "\x03") {
    if (!running)
      return done({}, { t: "notice", text: "no round is running — there is nothing to abort" });
    return done({ confirmAbort: true });
  }
  if (raw === "\x1bp") return done({ mayPost: !state.mayPost });
  if (raw === "\x15" || (raw === "\x1b" && state.text !== "")) return done({ text: "" });
  if (raw === "\r" || raw === "\n") {
    const text = state.text.trim();
    if (text === "") return done({});
    // The toggle is for a message; it resets on every send, so it never rides
    // along to the next one.
    return done(
      { text: "", mayPost: false },
      running
        ? { t: "send", kind: "steer", text }
        : { t: "send", kind: "message", text, may_post: state.mayPost },
    );
  }
  if (raw === "\x1b\r" || raw === "\x1b\n") {
    const text = state.text.trim();
    if (!running)
      return done(
        {},
        { t: "notice", text: "no round is running — ⏎ sends a message to the PR instead" },
      );
    if (text === "") return done({});
    return done({ text: "", mayPost: false }, { t: "send", kind: "follow-up", text });
  }
  if (raw === "\x7f" || raw === "\b") return done({ text: [...state.text].slice(0, -1).join("") });
  if (state.text === "" && NAV_KEYS.has(raw))
    return { state, effect: { t: "none" }, handled: false };
  // Text: one key or a paste. Newlines become spaces (the line is one line);
  // every other control byte, and any escape sequence, is not text.
  if (raw !== "" && !raw.includes("\x1b") && raw >= " ") {
    const add = sanitizeText(raw).replace(/\n/g, " ");
    return done({ text: (state.text + add).slice(0, CONTROL_TEXT_MAX) });
  }
  return { state, effect: { t: "none" }, handled: false };
}

/** What the board paints for the line. */
export interface ViewerInputView extends ViewerInput {
  /** A round is running: ⏎ steers (else it sends a message). */
  running: boolean;
  /** The pane holds the keyboard. */
  focused: boolean;
  pr: number;
}

/** The toggle as the line shows it: always visible, so a posting message is
 * never a surprise. */
export const mayPostLabel = (on: boolean): string => (on ? "post: ON" : "post: off");

/** `text` cut from the left to fit `width` cells, keeping its end (the cursor). */
function tail(text: string, width: number): string {
  let out = "";
  let w = 0;
  for (const ch of [...text].reverse()) {
    const cw = displayWidth(ch);
    if (w + cw > width) break;
    out = ch + out;
    w += cw;
  }
  return out;
}

/**
 * The line as one painted row of `width` cells. Focused it is the draft with a
 * cursor and, on the right, the may-post toggle; unfocused it says how to reach
 * it. While the abort prompt is up it is the prompt.
 */
export function viewerInputRow(view: ViewerInputView, width: number): string {
  const w = Math.max(1, width);
  if (view.confirmAbort)
    return `${FG.anomaly}${truncate(`abort the running round of #${view.pr}? y = abort · any other key cancels`, w)}${RESET}`;
  const verb = view.running ? "steer" : "message";
  if (!view.focused)
    return `${FG.dim}${truncate(`⏎ focus this pane, then type to ${verb} #${view.pr}`, w)}${RESET}`;
  const toggle = `[Alt-p ${mayPostLabel(view.mayPost)}]`;
  const right = view.mayPost ? `${FG.anomaly}${toggle}${RESET}` : `${FG.dim}${toggle}${RESET}`;
  const rightW = displayWidth(toggle);
  const prompt = `${view.running ? "steer" : "msg"} › `;
  const room = w - displayWidth(prompt) - rightW - 2;
  // Too narrow for the toggle: the end of the line, cursor included, and no more.
  if (room < 4) return tail(`${prompt}${view.text}▌`, w);
  const hint = (view.running ? "⏎ steer · Alt-⏎ queue · Ctrl-c abort" : "⏎ send a message").slice(
    0,
    room,
  );
  const shown = view.text === "" ? hint : `${tail(view.text, room - 1)}▌`;
  const draft = view.text === "" ? `${FG.dim}${hint}${RESET}` : shown;
  const gap = " ".repeat(Math.max(1, room - displayWidth(shown) + 1));
  return `${FG.accent}${prompt}${RESET}${draft}${gap}${right}`;
}
