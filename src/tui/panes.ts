// The list-and-pane layout three of the learning surfaces share (memory,
// tickets, feedback): a selectable list on the left at 38% of the width, a
// reading pane on the right built from rows whose clickable chunks carry an
// action. Pure geometry + zone bookkeeping; the surfaces decide what the rows
// say. Lifted out of the old memtab so the three cannot drift apart.
import { MUTED, RESET } from "./design.js";
import { type Frame, displayWidth, stripAnsi } from "./paint.js";

export interface RowChunk<A> {
  text: string;
  action?: A;
  dim?: boolean;
}

export interface ZonedRow<A> {
  text: string;
  zones: Array<{ x1: number; x2: number; action: A }>;
}

/** Assemble one row from chunks, tracking each clickable chunk's x-range
 * relative to the row start (styling excluded from the measure). */
export function zonedRow<A>(chunks: ReadonlyArray<RowChunk<A>>, gap = "  "): ZonedRow<A> {
  let text = "";
  let plainW = 0;
  const zones: ZonedRow<A>["zones"] = [];
  for (const c of chunks) {
    if (text.length > 0) {
      text += gap;
      plainW += gap.length;
    }
    const w = displayWidth(stripAnsi(c.text));
    if (c.action !== undefined) zones.push({ x1: plainW, x2: plainW + w - 1, action: c.action });
    text += c.dim ? `${MUTED}${c.text}${RESET}` : c.text;
    plainW += w;
  }
  return { text, zones };
}

/** List left (38%), reading pane right: `│ left │ right │` = cols. */
export function splitWidths(cols: number): { leftW: number; rightW: number } {
  const leftW = Math.floor((cols - 3) * 0.38);
  return { leftW, rightW: cols - 4 - leftW };
}

export interface SplitPane<A> {
  /** Left column lines, already styled and cut to `leftW - 3`. */
  left: string[];
  /** Per left line, the action a click on that row fires (undefined = none). */
  leftActions: Array<A | undefined>;
  right: Array<ZonedRow<A>>;
  leftW: number;
  rightW: number;
  /** First frame row of the body (1 = right under the title bar). */
  top: number;
  bodyRows: number;
}

/** Paint the two columns from `top` for `bodyRows` rows and register every
 * click zone at its terminal coordinates (frame row r ↔ terminal y r+1). */
export function paintSplit<A>(frame: Frame, pane: SplitPane<A>): void {
  // 1-based: │ (1) + left cell (leftW+1) + │ + leading space ⇒ text at leftW+5.
  const rightX0 = pane.leftW + 5;
  for (let r = 0; r < pane.bodyRows; r++) {
    const row = pane.top + r;
    const rr = pane.right[r];
    frame.boxRow(row, [
      { text: ` ${pane.left[r] ?? ""}`, width: pane.leftW + 1 },
      { text: ` ${rr?.text ?? ""}`, width: pane.rightW },
    ]);
    const la = pane.leftActions[r];
    if (la !== undefined)
      frame.zones.push({ x1: 2, y1: row + 1, x2: pane.leftW + 1, y2: row + 1, action: la });
    if (rr)
      for (const z of rr.zones)
        frame.zones.push({
          x1: rightX0 + z.x1,
          y1: row + 1,
          x2: rightX0 + z.x2,
          y2: row + 1,
          action: z.action,
        });
  }
}

/** The window of `rows` that keeps row `selected` visible in `height` lines:
 * verbs act on the selected row, so it must never sit off-screen. */
export function windowStart(selected: number, total: number, height: number): number {
  const visible = Math.max(1, height);
  return Math.max(0, Math.min(selected - (visible - 1), total - visible));
}
