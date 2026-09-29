// `[2] memory` — the reviewer's durable store, and nothing else.
//
// The timeline on the left is newest first, pinned entries floated, grouped
// by day so "what was learned when" reads at a glance; `[` / `]` jump between
// days. The reading pane on the right shows the selected entry in full, the
// verbs painted beside it — e edit · p pin/unpin · x retire (twice) — the
// defect flags the auto-filer works from, and the memory forward's state with
// the Studio link. Proposals, tickets and the feedback inbox that used to
// share this tab have their own surfaces now (`[4] tickets`, `[7] feedback`).
//
// Every memory mutation goes through the ONE MemoryStore seam
// (src/memory/store.ts — addressing and optimistic concurrency are its
// contract, and the engine behind it is none of this tab's business). A round
// carries the memory it assembled when it STARTED, so an edit made here
// reaches an in-flight round's context only at the next round.
//
// When the store does not answer, the timeline is replaced by an explicit
// failure banner: an empty list must never be mistaken for an empty store
//.
import { pinnedBudget } from "../memory/store.js";
import type { App } from "./app.js";
import { barHeight, paintCmdBar, type BarButton, type LiveKeys } from "./cmdbar.js";
import {
  ACCENT,
  HEADING,
  MUTED,
  RESET,
  STRONG,
  WARN,
  button,
  modeBadge,
  sectionTitle,
  selected as selectedLine,
} from "./design.js";
import { emptyLine } from "./emptystate.js";
import { applyMemoryFilter, memoryFilterLabel } from "./filters.js";
import type { BoardKey } from "./keys.js";
import type { LearningStore } from "./learning.js";
import type { ForwardStatus } from "./memforward.js";
import { defectEntries, refOf, timelineOrder, type MemoryEntry } from "./memory.js";
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

export interface MemoryTabState {
  /** Ordinal into `memoryOrder(...)` — the filtered, day-grouped timeline. */
  sel: number;
  /** The selected ENTRY's identity, so a reload that reorders the timeline
   * re-binds to the same entry and a verb never lands on a neighbour. */
  selKey?: string;
  /**: active timeline tag filter (companion `memory_filter` verb;
   * F clears). Render AND verbs derive ordering through it — one list. */
  filter?: string | null;
  /** Two-keystroke retire confirmation: the entry key armed by the first x. */
  confirmRetire?: string;
}

export function entryKey(e: MemoryEntry): string {
  return `${e.ts}|${e.id}#${e.block}`;
}

/** THE timeline ordering — render and every verb share it, so x/p/e can
 * never address an entry the filter hides. */
export function memoryOrder(
  entries: MemoryEntry[],
  filter: string | null | undefined,
): MemoryEntry[] {
  return applyMemoryFilter(timelineOrder(entries), filter);
}

/** The visible one-line form of a timeline entry. The text already leads
 * with its #tags — never re-print them as a prefix (they doubled before). */
export function entryLine(e: MemoryEntry, width: number, proposed = false): string {
  const text = sanitizeText(e.text).replace(/\s+/g, " ");
  // ● pinned; ☆ proposed for pinning by setup — the operator's call.
  const mark = e.pinned ? "● " : proposed ? "☆ " : "  ";
  const line = truncate(`${mark}${e.ts.slice(5, 16)} ${text}`, width);
  return e.pinned
    ? line.replace("● ", `${ACCENT}●${RESET} `)
    : proposed
      ? line.replace("☆ ", `${WARN}☆${RESET} `)
      : line;
}

export type MemoryRow =
  { kind: "group"; label: string } | { kind: "entry"; entry: MemoryEntry; index: number };

/**
 * The timeline with its group headers: the floated pinned block first, then
 * one group per day, newest first. `index` is the ordinal in the ordered list
 * the selection and the verbs use — headers are chrome and take no ordinal.
 */
export function memoryRows(ordered: MemoryEntry[]): MemoryRow[] {
  const rows: MemoryRow[] = [];
  let group: string | undefined;
  ordered.forEach((entry, index) => {
    const label = entry.pinned ? "pinned" : entry.day;
    if (label !== group) {
      rows.push({ kind: "group", label });
      group = label;
    }
    rows.push({ kind: "entry", entry, index });
  });
  return rows;
}

/** First ordinal of each group, in timeline order — what `[` / `]` step over. */
export function groupStarts(ordered: MemoryEntry[]): number[] {
  return memoryRows(ordered).flatMap((r, i, all) => {
    const next = all[i + 1];
    return r.kind === "group" && next?.kind === "entry" ? [next.index] : [];
  });
}

/** The ordinal `[` (older, +1) or `]` (newer, −1) would move to, if any. */
export function dayJump(ordered: MemoryEntry[], sel: number, dir: 1 | -1): number | undefined {
  const starts = groupStarts(ordered);
  const here = starts.filter((s) => s <= sel).length - 1;
  return starts[here + dir];
}

/** Pinned-region budget — the seam's, since setup's pin proposals
 * price against the same one. */
export { pinnedBudget };

/** Every click target on the memory tab. */
export type MemAction =
  { t: "key"; key: string } | { t: "mem"; i: number } | { t: "url"; url: string };

/**
 * The two forward rows: state, then the Studio link (clickable) or the reason
 * there is nothing to click.
 *
 * The link is only offered when the forward is UP. Handing the operator a URL
 * that cannot connect — and a browser tab that fails — is worse than saying
 * plainly that the forward is down and how to bring it back.
 */
export function forwardRows(
  fwd: ForwardStatus | undefined,
  width: number,
): Array<Array<RowChunk<MemAction>>> {
  if (!fwd)
    return [
      [{ text: `${sectionTitle("MEMORY STORE")} ${MUTED}forward: starting…${RESET}` }],
      [{ text: "" }],
    ];
  const dot =
    fwd.state === "failed"
      ? `${WARN}✖${RESET}`
      : fwd.state === "off"
        ? `${MUTED}○${RESET}`
        : `${ACCENT}●${RESET}`;
  const head: Array<RowChunk<MemAction>> = [
    { text: `${sectionTitle("MEMORY STORE")} ${dot} ${fwd.state}` },
    { text: truncate(fwd.detail, Math.max(10, width - 26)), dim: true },
  ];
  const link: Array<RowChunk<MemAction>> =
    fwd.state === "adopted" || fwd.state === "owned"
      ? [
          { text: button("W studio"), action: { t: "url", url: fwd.studioUrl } },
          {
            text: truncate(fwd.studioUrl, Math.max(10, width - 16)),
            action: { t: "url", url: fwd.studioUrl },
            dim: true,
          },
        ]
      : [
          {
            text: truncate(
              "no web UI while the forward is down — r retries, or install the systemd unit",
              width - 2,
            ),
            dim: true,
          },
        ];
  return [head, link];
}

/** What the memory tab answers to on this frame. */
export function memoryKeys(store: LearningStore, st: MemoryTabState): LiveKeys {
  const ordered = memoryOrder(store.entries, st.filter);
  const bar: BarButton[] = [];
  if (dayJump(ordered, st.sel, 1) !== undefined) bar.push({ key: "[", label: "[ older day" });
  if (dayJump(ordered, st.sel, -1) !== undefined) bar.push({ key: "]", label: "] newer day" });
  // `n` opens a prompt whatever the store's state (a dead store refuses the
  // write and says so); `W` opens Studio or explains why it cannot.
  bar.push({ key: "n", label: "n new" }, { key: "W", label: "W studio" });
  const inline: string[] = [];
  if (ordered[st.sel] !== undefined) inline.push("e", "p", "x");
  if (st.filter != null && st.filter !== "") inline.push("F");
  return { bar, inline };
}

export function renderMemoryTab(
  store: LearningStore,
  st: MemoryTabState,
  dryRun: boolean | undefined,
  cols: number,
  rows: number,
): Frame {
  const frame = new Frame(cols, rows);
  const ordered = memoryOrder(store.entries, st.filter);
  const selected = ordered[st.sel];
  frame.set(
    0,
    rule(cols, "┌", "┐", [
      `${HEADING}quickreview${RESET}`,
      modeBadge(dryRun),
      `memory${selected ? ` · ${selected.day}` : ""}`,
      // The banner lives in the list, but the title bar must carry it too:
      // the tab is often read at a glance from another pane.
      ...(store.memError
        ? [`${WARN}${STRONG}✖ MEMORY UNREACHABLE${RESET}`]
        : store.memWarn
          ? [`${WARN}⚠ memory degraded${RESET}`]
          : []),
    ]),
  );
  const live = memoryKeys(store, st);
  const bodyRows = rows - 2 - barHeight("memory", cols, live.bar);
  const { leftW, rightW } = splitWidths(cols);

  const left: string[] = [];
  const leftActions: Array<MemAction | undefined> = [];
  const filterOn = st.filter != null && st.filter !== "";
  if (!store.memLoaded) left.push(emptyLine({ kind: "unread", how: "reading the store" }));
  else if (store.memError) {
    // THE point of this branch: a store we cannot reach must not render as a
    // store with nothing in it. Banner, reason, and the retry key — never a
    // bare "none yet".
    left.push(`${WARN}${STRONG}✖ MEMORY UNREACHABLE${RESET}`);
    left.push("");
    for (const l of wrap(sanitizeText(store.memError), leftW - 3)) left.push(`${WARN}${l}${RESET}`);
    left.push("");
    left.push(`${MUTED}nothing below is memory — the store did not answer.${RESET}`);
    left.push(`${MUTED}r retries; verbs will refuse until it is back.${RESET}`);
  } else {
    const budget = pinnedBudget(ordered);
    const budgetNote = budget.over ? ` ${WARN}⚠ pinned ${budget.chars}ch${RESET}` : "";
    const fl = memoryFilterLabel(st.filter);
    const proposals = store.pinProposals.size;
    const proposalNote =
      proposals > 0 ? ` ${WARN}☆ ${proposals} proposed pin${proposals === 1 ? "" : "s"}${RESET}` : "";
    left.push(
      `${sectionTitle(`MEMORY (${ordered.length})`)}${budgetNote}${proposalNote}${fl !== "" ? ` ${fl}` : ""}`,
    );
    leftActions.push(undefined);
    if (store.pinProposalsError) {
      left.push(`${WARN}⚠ ${truncate(sanitizeText(`pin proposals: ${store.pinProposalsError}`), leftW - 5)}${RESET}`);
      leftActions.push(undefined);
    }
    if (store.memWarn) {
      left.push(`${WARN}⚠ ${truncate(sanitizeText(store.memWarn), leftW - 5)}${RESET}`);
      leftActions.push(undefined);
    }
    if (ordered.length === 0) {
      left.push(
        filterOn
          ? emptyLine({ kind: "filtered", what: `F clears #${st.filter}` })
          : emptyLine({ kind: "none", what: "memory holds no entries" }),
      );
      leftActions.push(undefined);
    } else {
      const all = memoryRows(ordered);
      const selRow = all.findIndex((r) => r.kind === "entry" && r.index === st.sel);
      const visible = Math.max(1, bodyRows - left.length);
      const start = windowStart(Math.max(0, selRow), all.length, visible);
      for (const row of all.slice(start, start + visible)) {
        if (row.kind === "group") {
          const label = ` ${row.label} `;
          left.push(
            `${MUTED}──${label}${"─".repeat(Math.max(0, leftW - 5 - label.length))}${RESET}`,
          );
          leftActions.push(undefined);
          continue;
        }
        const line = entryLine(row.entry, leftW - 3, store.pinProposals.has(entryKey(row.entry)));
        left.push(row.index === st.sel ? selectedLine(line) : line);
        leftActions.push({ t: "mem", i: row.index });
      }
    }
  }

  const right: Array<ZonedRow<MemAction>> = [];
  const row = (chunks: Array<RowChunk<MemAction>>, gap?: string): void => {
    right.push(zonedRow(chunks, gap));
  };
  if (selected) {
    row([
      {
        text: `${sectionTitle("ENTRY")} ${selected.ts} ${MUTED}[${selected.id}]${RESET}${selected.pinned ? ` ${ACCENT}●${RESET}pinned` : ""}`,
      },
    ]);
    row([
      { text: button("e edit"), action: { t: "key", key: "e" } },
      { text: button(selected.pinned ? "p unpin" : "p pin"), action: { t: "key", key: "p" } },
      {
        text:
          st.confirmRetire === entryKey(selected)
            ? `${WARN}${STRONG}[x CONFIRM retire]${RESET}`
            : button("x retire"),
        action: { t: "key", key: "x" },
      },
    ]);
    const why = store.pinProposals.get(entryKey(selected));
    if (why !== undefined) {
      for (const l of wrap(sanitizeText(`☆ setup proposes pinning this: ${why} — p pins it`), rightW - 3))
        row([{ text: `${WARN}${l}${RESET}` }]);
    }
    // Leave room for the defect flags and the store rows below; a long entry
    // must not bury the panel that says whether memory is reachable.
    const detailCap = Math.max(5, bodyRows - 14);
    const wrapped = wrap(sanitizeText(selected.text), rightW - 3);
    for (const l of wrapped.slice(0, detailCap)) row([{ text: l }]);
    if (wrapped.length > detailCap)
      row([{ text: `… ${wrapped.length - detailCap} more lines`, dim: true }]);
    row([{ text: "" }]);
  }
  const defects = store.memLoaded && !store.memError ? defectEntries(store.entries) : undefined;
  row([
    {
      text: `${sectionTitle(`DEFECT FLAGS ${defects === undefined ? "(—)" : `(${defects.length})`}`)}${store.filedTotal > 0 ? ` ${MUTED}${store.filedTotal} auto-filed${RESET}` : ""}`,
    },
  ]);
  if (defects === undefined)
    row([{ text: emptyLine({ kind: "unread", how: "the store has not answered" }) }]);
  else if (defects.length === 0)
    row([
      { text: emptyLine({ kind: "none", what: "#bug entries are auto-filed to the tracker" }) },
    ]);
  for (const d of (defects ?? []).slice(0, 5)) {
    const i = ordered.findIndex((e) => entryKey(e) === entryKey(d));
    row([
      {
        text: truncate(`⚑ ${d.ts.slice(5, 10)} ${d.links[0] ?? d.text.slice(0, 30)}`, rightW - 2),
        action: i >= 0 ? { t: "mem", i } : undefined,
      },
    ]);
  }
  row([{ text: "" }]);
  for (const chunks of forwardRows(store.forward, rightW)) row(chunks);
  if (store.status) {
    row([{ text: "" }]);
    row([{ text: truncate(store.status, rightW - 2) }]);
  }

  paintSplit(frame, { left, leftActions, right, leftW, rightW, top: 1, bodyRows });
  paintCmdBar(frame, "memory", cols, rows, live.bar);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

/** Install the memory surface over the shared learning store. */
export function installMemoryTab(app: App, store: LearningStore): MemoryTabState {
  const st: MemoryTabState = { sel: 0 };
  const ordered = (): MemoryEntry[] => memoryOrder(store.entries, st.filter);
  const select = (i: number): void => {
    const list = ordered();
    st.sel = Math.max(0, Math.min(i, Math.max(0, list.length - 1)));
    st.selKey = list[st.sel] ? entryKey(list[st.sel]!) : undefined;
  };
  // Re-bind the selection to the same ENTRY, not the same ordinal — a
  // refresh that reorders the timeline must not silently redirect the next
  // verb keystroke to a different entry.
  store.onLoaded((part) => {
    if (part !== "memory") return;
    const list = ordered();
    const rebound = st.selKey ? list.findIndex((e) => entryKey(e) === st.selKey) : -1;
    select(rebound >= 0 ? rebound : st.sel);
  });

  /** The last painted frame's click zones — hitTest target for clicks. */
  let lastZones: Zone<MemAction>[] = [];

  app.hooks.tabs.memory = {
    keys: () => memoryKeys(store, st),
    screen: (theApp, cols, rows) => {
      store.ensureMemory();
      const frame = renderMemoryTab(store, st, theApp.view.dryRun, cols, rows);
      lastZones = frame.zones as Zone<MemAction>[];
      return frame;
    },
    // Mouse: every row and [button] on the tab is a zone; a click either
    // selects (rows) or synthesizes the verb's keystroke (buttons), so the
    // keyboard and the mouse share one state machine (retire keeps its
    // two-step confirm either way).
    click: (theApp, x, y): boolean => {
      const action = hitTest(lastZones, x, y);
      if (!action) return false;
      switch (action.t) {
        case "key":
          theApp.pressKey(action.key);
          return true;
        case "mem":
          select(action.i);
          theApp.repaint();
          return true;
        case "url":
          theApp.hooks.openUrl?.(action.url);
          theApp.notice(`opened ${action.url}`);
          return true;
      }
    },
    key: (theApp, key: BoardKey): boolean => {
      const list = ordered();
      const selected = list[st.sel];
      if (!(key.kind === "char" && key.ch === "x")) st.confirmRetire = undefined;
      switch (key.kind) {
        case "down":
        case "up":
          select(st.sel + (key.kind === "down" ? 1 : -1));
          theApp.repaint();
          return true;
        case "older":
        case "newer": {
          const to = dayJump(list, st.sel, key.kind === "older" ? 1 : -1);
          if (to === undefined) return false;
          select(to);
          theApp.repaint();
          return true;
        }
        case "refresh":
          store.reloadMemory();
          return true;
        case "events": {
          // `e` = edit here; the board's events overlay has no meaning on this
          // tab, and with no entry selected the key is not this tab's at all.
          if (!selected) return false;
          theApp.promptInput(
            `edit memory ${selected.id}@${selected.ts.slice(11)}`,
            selected.text,
            (text) => {
              store.verb(store.memory.apply({ op: "edit", ...refOf(selected), text }));
            },
          );
          return true;
        }
        case "char":
          switch (key.ch) {
            case "F":
              // The indicator promises it — and only while there is one.
              if (st.filter == null || st.filter === "") return false;
              st.filter = null;
              select(0);
              theApp.repaint();
              return true;
            case "W": {
              // W opens OpenViking's Studio web UI. Same target the
              // [W studio] zone clicks, so mouse and key cannot drift.
              const fwd = store.forward;
              if (!fwd || (fwd.state !== "adopted" && fwd.state !== "owned")) {
                store.status =
                  `no web UI — memory forward is ${fwd?.state ?? "starting"}: ${fwd?.detail ?? ""}`.trim();
                theApp.notice(store.status);
                theApp.repaint();
                return true;
              }
              theApp.hooks.openUrl?.(fwd.studioUrl);
              theApp.notice(`opened ${fwd.studioUrl}`);
              return true;
            }
            case "n":
              theApp.promptInput("new memory entry (#manual)", "", (text) => {
                store.verb(store.memory.apply({ op: "add", text }));
              });
              return true;
            case "x": {
              if (!selected) return false;
              const k = entryKey(selected);
              if (st.confirmRetire === k) {
                st.confirmRetire = undefined;
                store.verb(store.memory.apply({ op: "retire", ...refOf(selected) }));
              } else {
                st.confirmRetire = k;
                store.status = `x again to retire: ${selected.text.slice(0, 40)}…`;
                theApp.repaint();
              }
              return true;
            }
            case "p":
              if (!selected) return false;
              store.verb(
                store.memory.apply({ op: selected.pinned ? "unpin" : "pin", ...refOf(selected) }),
              );
              return true;
            default:
              // A letter this tab does not claim is the operator talking to the
              // companion column — the same rule as every other tab.
              return false;
          }
        default:
          // tabs/quit/help/reconnect — and ⏎/a/m/g/u, which are the board's
          // and are refused app-side off it (BOARD_ONLY_VERBS).
          return false;
      }
    },
  };

  return st;
}
