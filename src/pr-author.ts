import type { StateStore } from "./state.js";

/** PR authorship uses live metadata first, then a historical backfill. */
export function prAuthorOf(store: StateStore, pr: number): string | null {
  return store.getPr(pr)?.author || store.backfillPrMeta(pr)?.author || null;
}
