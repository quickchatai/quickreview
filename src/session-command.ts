/** Stable receipt carried in the Pi user message for one durable command.
 * It binds the database id to the immutable payload hash, so restart recovery
 * can reconcile SQLite ownership against session JSONL without trusting a
 * mutable inject filename. */
export function sessionCommandMarker(id: string, payloadSha256: string): string {
  return `<!-- qcr-command:${id}:${payloadSha256} -->`;
}

export function parseSessionCommandMarker(
  text: string,
): { id: string; payloadSha256: string } | undefined {
  const match = [...text.matchAll(/<!-- qcr-command:([^:\s>]+):([a-f0-9]{64}) -->/g)].at(-1);
  return match ? { id: match[1]!, payloadSha256: match[2]! } : undefined;
}

/** The exact reservation whose consumer recovery is allowed to fence. */
export interface SessionCommandOwnership {
  id: string;
  status: string;
  owner_token: string | null;
  attempt: number;
  started_at: string | null;
}

export function sameSessionCommandOwner(
  current: SessionCommandOwnership | undefined,
  expected: SessionCommandOwnership,
): boolean {
  return (
    current !== undefined &&
    current.id === expected.id &&
    current.status === expected.status &&
    current.owner_token === expected.owner_token &&
    current.attempt === expected.attempt &&
    current.started_at === expected.started_at
  );
}
