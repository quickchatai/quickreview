/** Stable receipt carried in the Pi user message for one durable command.
 * It binds the database id to the immutable payload hash, so restart recovery
 * can reconcile SQLite ownership against session JSONL without trusting a
 * mutable inject filename. */
export function sessionCommandMarker(id: string, payloadSha256: string): string {
  return `<!-- qcr-command:${id}:${payloadSha256} -->`;
}
