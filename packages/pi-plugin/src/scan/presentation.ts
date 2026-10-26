/** Setup-family price rendering; a missing measurement stays unknown. */
export const usd = (n: number | null): string => (n === null ? "unknown" : `$${n.toFixed(2)}`);

/** A source location with an inclusive line range. */
export const findingLocation = (f: { path: string; start: number; end: number }): string =>
  `${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`}`;

/** Shared human receipt; callers keep their own structured JSON fields. */
export const dismissedLine = (r: {
  finding: { fingerprint: string };
  again: boolean;
  memory: "written" | { problem: string };
}): string =>
  `${r.finding.fingerprint.slice(0, 12)} ${r.again ? "re-dismissed" : "dismissed"}: ${
    r.memory === "written"
      ? "the memory note is written"
      : `the memory note was NOT written (${r.memory.problem}) — dismiss it again later to retry`
  }.`;
