import type { StateStore } from "./state.js";

/** Monotone local row identities, sampled before asynchronous capture. */
export const ACTIVITY_SQL = {
  comments: (pr: string): string =>
    `(SELECT COALESCE(MAX(id), 0) FROM pr_comments WHERE pr = ${pr})`,
  signals: (pr: string): string =>
    `(SELECT COALESCE(MAX(id), 0) FROM feedback_signals WHERE pr = ${pr})`,
};
export interface PrActivity {
  comments: number;
  signals: number;
}
export function prActivity(store: StateStore, pr: number): PrActivity {
  return store.db
    .prepare(
      `SELECT ${ACTIVITY_SQL.comments("@pr")} AS comments, ${ACTIVITY_SQL.signals("@pr")} AS signals`,
    )
    .get({ pr }) as PrActivity;
}
