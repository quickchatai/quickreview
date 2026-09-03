// Pure view-model logic for qcr tui — everything here is deterministic and
// unit-tested: state→glyph mapping, board sort order, event-line formatting,
// selection movement. The mockups are the contract.
import type { PrLifecycleState, StatusSnapshot } from "../state.js";

export type SnapshotPr = StatusSnapshot["prs"][number];

export const STATE_GLYPHS: Record<PrLifecycleState, string> = {
  queued: "●",
  reviewing: "▶",
  awaiting_author: "✎",
  tracked: "·",
  closed: " ", // closed PRs never render — they drop off the list
};

/** `↻` prefixes the state glyph when a stale recheck is pending. */
export function glyphFor(pr: Pick<SnapshotPr, "state" | "stale_recheck">): string {
  const base = STATE_GLYPHS[pr.state] ?? "?";
  return pr.stale_recheck ? `↻${base}` : base;
}

/**
 * States the daemon USED to write, and the date it stopped.
 *
 * A key here is NOT a `PrLifecycleState`: nothing can produce it and no LIVE
 * surface renders it. It exists for exactly one reader — the metrics tab's
 * `TIME IN STATE` card, which is derived from the `pr_transition` event log
 * and therefore keeps reporting real dwell for states the machine has since
 * retired (75 such rows on the live install, and they are true history:
 * deleting them would be falsifying the record, not retiring a state).
 *
 * Without this, a retired state renders in that card as a bare label
 * indistinguishable from a current one — which is how could otherwise
 * claim "no surface renders a retired state" while one still did.
 * `tests/park-retired.test.ts` pins both halves: a key here must be absent
 * from the union and from `STATE_GLYPHS`, and must render marked.
 */
export const RETIRED_STATES: Record<string, string> = {
  awaiting_human: "retired 2026-08-19",
};

/**
 * The mark a retired state carries in a historical series.
 *
 * A PREFIX, deliberately: the metrics bar fits its label into ~16 cells, so a
 * `(retired …)` suffix is the first thing truncation eats — a marker that
 * disappears at the widths people actually run is not a marker. The date rides
 * the bar's value column, where there is room, and the card's subtitle
 * explains the glyph.
 */
export const RETIRED_STATE_MARK = "†";

/**
 * How a state reads in a HISTORICAL series, where the event log can still
 * carry something the machine can no longer produce. Live surfaces (the board
 * list, its legend, the detail pane) must never call this — they render
 * `STATE_GLYPHS`, which has no retired members at all.
 */
export function historicalStateLabel(state: string): string {
  return state in RETIRED_STATES ? `${RETIRED_STATE_MARK} ${state}` : state;
}

const SORT_ORDER: PrLifecycleState[] = ["reviewing", "queued", "awaiting_author", "tracked"];

/** Board order: lifecycle groups per the mockup, stable by PR number within
 * a group; closed PRs are dropped entirely. */
export function sortPrs(prs: SnapshotPr[]): SnapshotPr[] {
  const rank = (s: string): number => {
    const i = SORT_ORDER.indexOf(s as PrLifecycleState);
    return i === -1 ? SORT_ORDER.length : i;
  };
  return prs
    .filter((p) => p.state !== "closed")
    .slice()
    .sort((a, b) => rank(a.state) - rank(b.state) || a.number - b.number);
}

export interface EventLine {
  ts: string; // HH:MM:SS
  text: string;
  anomaly: boolean;
}

/** One events-strip line from a daemon event row — newest first is the
 * caller's job; this renders a single row. */
export function formatEvent(e: {
  ts: string;
  kind: string;
  pr: number | null;
  payload: string | null;
}): EventLine {
  const hhmmss = e.ts.slice(11, 19);
  let detail = "";
  if (e.payload) {
    try {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      const bits = ["verdict", "round_type", "round_no", "reason", "message"]
        .map((k) => p[k])
        .filter((v) => v !== undefined && v !== null)
        .map(String);
      if (bits.length > 0) detail = ` (${bits.join(" ")})`;
    } catch {
      /* non-JSON payloads render bare */
    }
  }
  const anomaly = /anomal|reject|error|fail|overdue/i.test(e.kind);
  const kind = anomaly ? e.kind.toUpperCase() : e.kind;
  return { ts: hhmmss, text: `${hhmmss} ${kind}${e.pr ? ` #${e.pr}` : ""}${detail}`, anomaly };
}

export function moveSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(current + delta, 0), length - 1);
}

/** Keep the selection on the same PR across snapshot refreshes. */
export function reselect(
  sorted: SnapshotPr[],
  selectedPr: number | undefined,
  fallbackIndex: number,
): number {
  if (selectedPr !== undefined) {
    const i = sorted.findIndex((p) => p.number === selectedPr);
    if (i !== -1) return i;
  }
  return moveSelection(fallbackIndex, 0, sorted.length);
}
