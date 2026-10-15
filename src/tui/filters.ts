// Board/memory filter helpers — pure functions the tabs consume at
// wiring time. No tab-module imports: the board and the memory tab each call
// `applyBoardFilter` / `applyMemoryFilter` over their own rows and render
// `filterLabel` as the active-filter indicator. Filters are a VIEW concern —
// they never touch the poller's snapshot or the memory store.
import { normalizeTag } from "../memory/store.js";
import type { MemoryEntry } from "./memory.js";
import { sortPrs, type SnapshotPr } from "./model.js";

export interface BoardFilter {
  /** Case-insensitive substring match against the PR author login. */
  author?: string;
  /** Exact match against the daemon's lifecycle state strings. */
  state?: string;
}

/** True when the filter would pass everything — treated the same as null. */
export function isEmptyBoardFilter(f: BoardFilter | null | undefined): boolean {
  return (
    !f || ((f.author === undefined || f.author === "") && (f.state === undefined || f.state === ""))
  );
}

/**
 * Filter board rows. Author is a case-insensitive substring (a PR with no
 * author never matches an author filter); state is exact against the daemon's
 * state strings (`queued`, `reviewing`, `awaiting_author`, …). Both set = AND.
 * A null/empty filter returns the input array unchanged (same reference, so
 * an unfiltered board costs nothing).
 */
export function applyBoardFilter<T extends Pick<SnapshotPr, "state"> & { author?: string | null }>(
  prs: T[],
  f: BoardFilter | null | undefined,
): T[] {
  if (isEmptyBoardFilter(f)) return prs;
  const author = f!.author?.toLowerCase();
  const state = f!.state;
  return prs.filter((p) => {
    if (author !== undefined && author !== "" && !(p.author ?? "").toLowerCase().includes(author))
      return false;
    if (state !== undefined && state !== "" && p.state !== state) return false;
    return true;
  });
}

/** The active-filter indicator, e.g. `⛉ author:jbennett · state:reviewing — F clears`.
 * Empty string when nothing filters (paint nothing). */
export function filterLabel(f: BoardFilter | null | undefined): string {
  if (isEmptyBoardFilter(f)) return "";
  const bits: string[] = [];
  if (f!.author) bits.push(`author:${f!.author}`);
  if (f!.state) bits.push(`state:${f!.state}`);
  return `⛉ ${bits.join(" · ")} — F clears`;
}

/**
 * Filter memory timeline entries by tag: exact tag match, case-insensitive,
 * a leading '#' on the query is ignored (`#pinned` ≡ `pinned`). Null/empty
 * tag returns the input unchanged.
 */
export function applyMemoryFilter<T extends Pick<MemoryEntry, "tags">>(
  entries: T[],
  tag: string | null | undefined,
): T[] {
  if (tag === null || tag === undefined || normalizeTag(tag) === "") return entries;
  const want = normalizeTag(tag);
  return entries.filter((e) => e.tags.some((t) => normalizeTag(t) === want));
}

/** The board's one filtered ordering — render, selection movement and the
 * companion driver all derive rows from here, so a verb can never address a
 * row the filter hid. */
export function visiblePrs(view: {
  snapshot?: { prs: SnapshotPr[] };
  boardFilter?: BoardFilter | null;
}): SnapshotPr[] {
  return applyBoardFilter(sortPrs(view.snapshot?.prs ?? []), view.boardFilter);
}

/** The memory view's indicator, same shape as the board's. */
export function memoryFilterLabel(tag: string | null | undefined): string {
  if (tag === null || tag === undefined || normalizeTag(tag) === "") return "";
  return `⛉ #${normalizeTag(tag)} — F clears`;
}
