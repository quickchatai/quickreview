/** Stable receipt carried in the Pi user message for one durable command.
 * It binds the database id to the immutable payload hash, so restart recovery
 * can reconcile SQLite ownership against session JSONL without trusting a
 * mutable inject filename. */
export function sessionCommandMarker(id: string, payloadSha256: string): string {
  return `<!-- qcr-command:${id}:${payloadSha256} -->`;
}

export function parseSessionCommandMarker(text: string): { id: string; payloadSha256: string } | undefined {
  const match = /<!-- qcr-command:([^:\s>]+):([a-f0-9]{64}) -->/.exec(text);
  return match ? { id: match[1]!, payloadSha256: match[2]! } : undefined;
}
