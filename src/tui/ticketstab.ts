// `[4] tickets` — what adjudication filed on the issue tracker, read-only.
//
// The list on the left is actionable tickets first (`c` shows the closed ones too); the pane
// on the right is the selected ticket's whole body, `[` / `]` and the wheel
// scroll it. The reader never claims, locks or rewrites a ticket
// (src/tui/trackertickets.ts).
//
// The tracker is a directory on the operator's PC, so the list is one of FOUR
// facts, never conflated: not scanned yet (the walk runs
// behind the first frame), no tracker configured, the scan failed, or read.
import type { App } from "./app.js";
import { barHeight, paintCmdBar, type BarButton, type LiveKeys } from "./cmdbar.js";
import {
  HEADING,
  MUTED,
  RESET,
  STRONG,
  modeBadge,
  sectionTitle,
  selected as selectedLine,
} from "./design.js";
import { emptyLine } from "./emptystate.js";
import type { BoardKey } from "./keys.js";
import type { LearningStore, TicketsRead } from "./learning.js";
import { hitTest, type Zone } from "./mouse.js";
import { Frame, rule, sanitizeText, truncate, wrap } from "./paint.js";
import {
  paintSplit,
  splitWidths,
  windowStart,
  zonedRow,
  type RowChunk,
  type ZonedRow,
} from "./panes.js";
import { isActionableTicket, type TrackerTicket } from "./trackertickets.js";

export interface TicketsTabState {
  sel: number;
  /** Lines scrolled into the selected ticket's body. */
  scroll: number;
  /** The furthest `scroll` the LAST PAINT could use — body lines minus the
   * rows they had. Written by the render (it is a property of the painted
   * frame, like the click zones), read by the keys: a scroll key is offered
   * only in the direction the body can still move, and a press never runs
   * past the end into a `scroll` the frame silently clamps. */
  scrollMax: number;
  /** Show closed tickets too (`c`); the default list is the actionable ones. */
  showClosed: boolean;
}

export type TicketsAction = { t: "ticket"; i: number };

/** The rows the list shows under the current filter. */
export function visibleTickets(read: TicketsRead, showClosed: boolean): TrackerTicket[] {
  if (read.kind !== "read") return [];
  return showClosed ? read.tickets : read.tickets.filter(isActionableTicket);
}

/** What the tickets tab answers to: `c` once there is a list to filter; a
 * body scroll key only in a direction the open ticket can still move — a
 * `[` at the top would change no pixel, and a registered key that does
 * nothing steals a keystroke from the companion column. */
export function ticketsKeys(store: LearningStore, st: TicketsTabState): LiveKeys {
  const bar: BarButton[] = [];
  if (store.tickets.kind === "read" && store.tickets.tickets.length > 0) {
    bar.push({ key: "c", label: st.showClosed ? "c actionable" : "c show all" });
  }
  if (visibleTickets(store.tickets, st.showClosed)[st.sel] !== undefined) {
    if (st.scroll > 0) bar.push({ key: "[", label: "[ scroll up" });
    if (st.scroll < st.scrollMax) bar.push({ key: "]", label: "] scroll down" });
  }
  return { bar, inline: [] };
}

export function renderTicketsTab(
  store: LearningStore,
  st: TicketsTabState,
  dryRun: boolean | undefined,
  cols: number,
  rows: number,
  effort?: string,
): Frame {
  const frame = new Frame(cols, rows);
  const read = store.tickets;
  const tickets = visibleTickets(read, st.showClosed);
  const sel = Math.min(st.sel, Math.max(0, tickets.length - 1));
  const selected = tickets[sel];
  frame.set(
    0,
    rule(cols, "┌", "┐", [
      `${HEADING}quickreview${RESET}`,
      modeBadge(dryRun),
      `tickets${effort ? ` · ${effort}` : ""}`,
    ]),
  );
  const { leftW, rightW } = splitWidths(cols);
  // The bar depends on how far the body can scroll, which depends on the rows
  // the bar leaves: lay the body out, recompute the bar from the scroll it
  // allows, and lay out again while the bar's height moves — so the bar
  // painted is the bar the keys and the hit-test register.
  let live = ticketsKeys(store, st);
  let height: number;
  let body: ReturnType<typeof ticketsBody>;
  let pass = 0;
  do {
    height = barHeight("tickets", cols, live.bar);
    body = ticketsBody(read, tickets, sel, selected, st, leftW, rightW, rows - 2 - height);
    st.scrollMax = body.scrollMax;
    // Stored and painted offsets agree: a body that now fits (a resize) is
    // scrolled back to where it is painted, never left above it.
    st.scroll = Math.min(st.scroll, st.scrollMax);
    live = ticketsKeys(store, st);
  } while (barHeight("tickets", cols, live.bar) !== height && ++pass < 3);
  const { left, leftActions, right, bodyRows } = body;

  paintSplit(frame, { left, leftActions, right, leftW, rightW, top: 1, bodyRows });
  paintCmdBar(frame, "tickets", cols, rows, live.bar);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

/** The two panes at `bodyRows`, and how far the selected body can scroll. */
function ticketsBody(
  read: TicketsRead,
  tickets: TrackerTicket[],
  sel: number,
  selected: TrackerTicket | undefined,
  st: TicketsTabState,
  leftW: number,
  rightW: number,
  bodyRows: number,
): {
  left: string[];
  leftActions: Array<TicketsAction | undefined>;
  right: Array<ZonedRow<TicketsAction>>;
  bodyRows: number;
  scrollMax: number;
} {
  const left: string[] = [];
  const leftActions: Array<TicketsAction | undefined> = [];
  const total = read.kind === "read" ? read.tickets : undefined;
  const actionable = total?.filter(isActionableTicket).length;
  left.push(
    sectionTitle(
      total === undefined
        ? "TICKETS (—)"
        : `TICKETS (${actionable} actionable / ${total.length} total)`,
    ),
  );
  leftActions.push(undefined);
  switch (read.kind) {
    case "unread":
      left.push(
        emptyLine({
          kind: "unread",
          how: "the tracker is scanned behind the first frame · r retries",
        }),
      );
      break;
    case "unconfigured":
      left.push(
        emptyLine({ kind: "unreadable", why: "no tracker configured — [sink] in config.toml" }),
      );
      break;
    case "unreadable":
      left.push(emptyLine({ kind: "unreadable", why: `${read.reason} · r retries` }));
      break;
    case "read":
      if (read.tickets.length === 0)
        left.push(
          emptyLine({
            kind: "none",
            what: "adjudication files a ticket only when something changes",
          }),
        );
      else if (tickets.length === 0)
        left.push(emptyLine({ kind: "filtered", what: `c shows all ${read.tickets.length}` }));
      break;
  }
  // One action per drawn line: the switch draws a placeholder in every state
  // but "read with visible tickets" — an unconditional push there shifted
  // every ticket's click target one row down.
  while (leftActions.length < left.length) leftActions.push(undefined);
  const visible = Math.max(1, bodyRows - left.length);
  const start = windowStart(sel, tickets.length, visible);
  tickets.slice(start, start + visible).forEach((ticket, offset) => {
    const i = start + offset;
    // Tracker text is foreign to the frame: no control byte reaches the terminal.
    const label = truncate(
      sanitizeText(`${ticket.id} [${ticket.status}] ${ticket.title}`),
      leftW - 3,
    );
    left.push(i === sel ? selectedLine(label) : label);
    leftActions.push({ t: "ticket", i });
  });

  const right: Array<ZonedRow<TicketsAction>> = [];
  const row = (chunks: Array<RowChunk<TicketsAction>>): void => {
    right.push(zonedRow(chunks));
  };
  let scrollMax = 0;
  if (selected) {
    row([
      {
        text: `${sectionTitle(sanitizeText(selected.id))} ${STRONG}${truncate(sanitizeText(selected.title), rightW - selected.id.length - 7)}${RESET}`,
      },
    ]);
    row([
      {
        text: sanitizeText(
          `${selected.status} · role ${selected.role} · updated ${selected.updated}`,
        ),
        dim: true,
      },
    ]);
    row([{ text: "" }]);
    const lines = wrap(sanitizeText(selected.body), rightW - 3);
    // The cap is the rows the pane actually paints, less one for the "more
    // lines" notice when the body overflows: a cap past the painted rows
    // stops the scroll before the body's last lines come into view.
    const room = Math.max(0, bodyRows - right.length);
    const cap = lines.length > room && room > 1 ? room - 1 : room;
    scrollMax = Math.max(0, lines.length - cap);
    const from = Math.min(st.scroll, scrollMax);
    for (const line of lines.slice(from, from + cap)) row([{ text: line }]);
    if (from + cap < lines.length)
      row([{ text: `… ${lines.length - from - cap} more lines`, dim: true }]);
  } else if (read.kind === "read" && read.tickets.length > 0) {
    row([{ text: `${MUTED}no ticket selected${RESET}` }]);
  }
  return { left, leftActions, right, bodyRows, scrollMax };
}

/** Install the tickets surface over the shared learning store. */
export function installTicketsTab(
  app: App,
  store: LearningStore,
  effort?: string,
): TicketsTabState {
  const st: TicketsTabState = { sel: 0, scroll: 0, scrollMax: 0, showClosed: false };
  const visible = (): TrackerTicket[] => visibleTickets(store.tickets, st.showClosed);
  const select = (i: number): void => {
    const list = visible();
    st.sel = Math.max(0, Math.min(i, Math.max(0, list.length - 1)));
    st.scroll = 0;
    const ticket = list[st.sel];
    if (ticket) app.notice(sanitizeText(`ticket open → ${ticket.id} ${ticket.title}`));
  };
  store.onLoaded((part) => {
    if (part === "tickets") st.sel = Math.min(st.sel, Math.max(0, visible().length - 1));
  });
  let lastZones: Zone<TicketsAction>[] = [];

  app.hooks.tabs.tickets = {
    keys: () => ticketsKeys(store, st),
    screen: (theApp, cols, rows) => {
      const frame = renderTicketsTab(store, st, theApp.view.dryRun, cols, rows, effort);
      lastZones = frame.zones as Zone<TicketsAction>[];
      return frame;
    },
    click: (theApp, x, y): boolean => {
      const action = hitTest(lastZones, x, y);
      if (!action) return false;
      select(action.i);
      theApp.repaint();
      return true;
    },
    key: (theApp, key: BoardKey): boolean => {
      switch (key.kind) {
        case "down":
        case "up": {
          const delta = key.kind === "down" ? 1 : -1;
          // The mouse wheel means "read this ticket"; j/k and the arrows mean
          // "choose another ticket". App preserves that origin bit when it
          // translates the SGR mouse event into this key-shaped tab API.
          if (key.wheel) st.scroll = Math.max(0, Math.min(st.scroll + delta * 3, st.scrollMax));
          else select(st.sel + delta);
          theApp.repaint();
          return true;
        }
        case "older":
        case "newer": {
          if (visible()[st.sel] === undefined) return false;
          const next = Math.max(
            0,
            Math.min(st.scroll + (key.kind === "older" ? -5 : 5), st.scrollMax),
          );
          if (next === st.scroll) return false; // at the edge the key is not this tab's
          st.scroll = next;
          theApp.repaint();
          return true;
        }
        case "refresh":
          store.reloadTickets();
          return true;
        case "char":
          if (key.ch !== "c" || store.tickets.kind !== "read" || store.tickets.tickets.length === 0)
            return false;
          st.showClosed = !st.showClosed;
          select(0);
          theApp.repaint();
          return true;
        default:
          return false;
      }
    },
  };

  return st;
}
