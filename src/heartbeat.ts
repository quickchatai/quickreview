// The status snapshot's heartbeat. A pure read of status.json's fields, kept
// out of the state store (src/state.ts) so a reader of the snapshot alone,
// such as the home's auto-review label, never loads the store's SQLite driver.

/** The snapshot's heartbeat, with its legacy written_at field as fallback. */
export function snapshotHeartbeat(snapshot: {
  heartbeat?: unknown;
  written_at?: unknown;
}): string | null {
  return typeof snapshot.heartbeat === "string"
    ? snapshot.heartbeat
    : typeof snapshot.written_at === "string"
      ? snapshot.written_at
      : null;
}
