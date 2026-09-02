// The TUI's seven surfaces (built), in the order their digit
// keys reach them. One vocabulary, applied everywhere: the identifier here IS
// the label on the nav bar, the word in the help overlay, the tab name the
// companion's `switch_tab` verb accepts, and the heading in docs/tui.md. The
// old `[2]` tab was called `digest` in code, "memory & learning" on screen and
// `memory` on the action channel; that drift is what this module ends.
//
//   board     what the reviewer is doing right now, PR by PR
//   memory    the reviewer's durable store — the timeline, day by day
//   digest    what the EOD sweep wrote — a document, read top to bottom
//   tickets   the tracker tickets adjudication filed
//   deploy    what the VM runs versus this checkout, and the button that ships
//   metrics   whether the reviewer is working well over time
//   feedback  the loop: signal → adjudication → proposal → change → revert
//
// This module imports nothing, so keys.ts, cmdbar.ts and actions.ts can all
// read the order without a cycle through app.ts.

export const TABS = ["board", "memory", "digest", "tickets", "deploy", "metrics", "feedback"] as const;

export type Tab = (typeof TABS)[number];

export function isTab(value: unknown): value is Tab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

/** The digit key that opens each tab: `1`…`7` in TABS order. */
export function tabDigit(tab: Tab): string {
  return String(TABS.indexOf(tab) + 1);
}

/** The tab a digit key opens, or undefined for a digit no tab owns. */
export function tabForDigit(ch: string): Tab | undefined {
  if (!/^[1-9]$/.test(ch)) return undefined;
  return TABS[Number(ch) - 1];
}
