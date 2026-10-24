// Pure view-model logic for qcr tui — everything here is deterministic and
// unit-tested: state→glyph mapping, board sort order, event-line formatting,
// selection movement.
import type { PrLifecycleState, StatusSnapshot } from "../state.js";

export type SnapshotPr = StatusSnapshot["prs"][number] & {
  /** A board-only row: an open PR of the repo the daemon does not track yet
   * (status.json `open_prs`). It is offered for review (`R`); nothing about it
   * is known beyond what the PR list says, so no PR verb but `R` and `g`
   * acts on it. */
  offered?: true;
};

/** The glyph of an offered row: open on GitHub, not reviewed yet. */
export const OFFERED_GLYPH = "○";

export const STATE_GLYPHS: Record<PrLifecycleState, string> = {
  queued: "●",
  reviewing: "▶",
  awaiting_author: "✎",
  tracked: "·",
  closed: " ", // closed PRs never render — they drop off the list
};

/** `↻` prefixes the state glyph when a stale recheck is pending. */
export function glyphFor(pr: Pick<SnapshotPr, "state" | "stale_recheck" | "offered">): string {
  if (pr.offered) return OFFERED_GLYPH;
  const base = STATE_GLYPHS[pr.state] ?? "?";
  return pr.stale_recheck ? `↻${base}` : base;
}

/**
 * States the event log can still carry but the daemon no longer writes, each
 * with the date it stopped.
 *
 * A key here is not a `PrLifecycleState`: nothing can produce it and no live
 * surface renders it. It exists for one reader — the metrics tab's
 * `TIME IN STATE` card, which is derived from the `pr_transition` event log
 * and so keeps reporting real dwell for retired states (true history, never
 * deleted).
 *
 * Without this, a retired state renders in that card as a bare label
 * indistinguishable from a current one. `tests/park-retired.test.ts` pins
 * both halves: a key here must be absent from the union and from
 * `STATE_GLYPHS`, and must render marked.
 */
export const RETIRED_STATES: Record<string, string> = {
  awaiting_human: "retired 2026-08-19",
};

/**
 * The mark a retired state carries in a historical series.
 *
 * A prefix, deliberately: the metrics bar fits its label into ~16 cells, so a
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

/** Whether a PR belongs on the board: closed ones do not. */
export function onBoard(p: SnapshotPr): boolean {
  return p.state !== "closed";
}

/** Board order: lifecycle groups, stable by PR number within
 * a group; closed PRs are dropped entirely. */
export function sortPrs(prs: SnapshotPr[]): SnapshotPr[] {
  const rank = (s: string): number => {
    const i = SORT_ORDER.indexOf(s as PrLifecycleState);
    return i === -1 ? SORT_ORDER.length : i;
  };
  return prs
    .filter(onBoard)
    .slice()
    .sort((a, b) => rank(a.state) - rank(b.state) || a.number - b.number);
}

/** The repo's open PRs the daemon does not track (status.json `open_prs`),
 * newest activity first, as offered board rows. A tracked PR is never offered
 * twice: its own row is the one the verbs act on. */
export function offeredPrs(
  snapshot: Pick<StatusSnapshot, "prs" | "open_prs"> | undefined,
): SnapshotPr[] {
  const open = snapshot?.open_prs?.prs ?? [];
  const tracked = new Set((snapshot?.prs ?? []).filter(onBoard).map((p) => p.number));
  return open
    .filter((p) => !tracked.has(p.number))
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number)
    .map((p) => ({
      number: p.number,
      state: "tracked" as const,
      title: p.draft ? `[draft] ${p.title}` : p.title,
      head_sha: "",
      stale_recheck: 0,
      author: p.author,
      updated_at: p.updated_at,
      offered: true as const,
    }));
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
