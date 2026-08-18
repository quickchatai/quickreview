// Pure view-model logic for qcr tui — everything here is deterministic and
// unit-tested: state→glyph mapping, board sort order, event-line formatting,
// selection movement. The mockups are the contract.
import type { PrLifecycleState, StatusSnapshot } from "../state.js";

export type SnapshotPr = StatusSnapshot["prs"][number];

export const STATE_GLYPHS: Record<PrLifecycleState, string> = {
  queued: "●",
  reviewing: "▶",
  awaiting_author: "✎",
  awaiting_human: "⚑",
  tracked: "·",
  closed: " ", // closed PRs never render — they drop off the list
};

/** `↻` prefixes the state glyph when a stale recheck is pending. */
export function glyphFor(pr: Pick<SnapshotPr, "state" | "stale_recheck">): string {
  const base = STATE_GLYPHS[pr.state as PrLifecycleState] ?? "?";
  return pr.stale_recheck ? `↻${base}` : base;
}

const SORT_ORDER: PrLifecycleState[] = ["reviewing", "queued", "awaiting_human", "awaiting_author", "tracked"];

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
export function formatEvent(e: { ts: string; kind: string; pr: number | null; payload: string | null }): EventLine {
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

/** Awaiting-you rows: parked PRs oldest-first with age in whole days. */
export function awaitingRows(prs: SnapshotPr[], now: Date): Array<{ pr: SnapshotPr; ageDays: number }> {
  return prs
    .filter((p) => p.state === "awaiting_human")
    .map((pr) => {
      const since = pr.trigger_ts ?? pr.updated_at;
      const ageDays = since ? Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000)) : 0;
      return { pr, ageDays };
    })
    .sort((a, b) => b.ageDays - a.ageDays || a.pr.number - b.pr.number);
}

export function moveSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(current + delta, 0), length - 1);
}

/** Keep the selection on the same PR across snapshot refreshes. */
export function reselect(sorted: SnapshotPr[], selectedPr: number | undefined, fallbackIndex: number): number {
  if (selectedPr !== undefined) {
    const i = sorted.findIndex((p) => p.number === selectedPr);
    if (i !== -1) return i;
  }
  return moveSelection(fallbackIndex, 0, sorted.length);
}
