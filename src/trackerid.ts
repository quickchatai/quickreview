// The issue tracker's id allocation — one claim of `.ids/<NNNN>` for every
// writer on this side (the scan's tracker sink, the TUI's auto-filer and its
// memory-incident tickets), so they never disagree about which id is next.
import { closeSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How many successive ids one claim tries past the highest taken. */
const CLAIM_TRIES = 50;

/**
 * Claim the next free FT id by exclusive create of `.ids/<NNNN>` — the
 * tracker's one allocation mechanism (claim-is-the-lock). Ids are at least
 * four digits, so the highest taken one is read across every width. Only a
 * collision (another claimer took the number) moves to the next; any other
 * failure is the tracker's answer and is thrown as it is. Returns the
 * zero-padded number.
 */
export function claimTrackerId(root: string, relPath: (n: string) => string): string {
  const idsDir = join(root, ".ids");
  const taken = readdirSync(idsDir)
    .filter((f) => /^\d{4,}$/.test(f))
    .map(Number);
  let candidate = (taken.length > 0 ? Math.max(...taken) : 0) + 1;
  for (let tries = 0; tries < CLAIM_TRIES; tries++, candidate++) {
    const n = String(candidate).padStart(4, "0");
    let fd: number;
    try {
      fd = openSync(join(idsDir, n), "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      writeFileSync(fd, `${relPath(n)}\n`);
    } finally {
      closeSync(fd);
    }
    return n;
  }
  throw new Error(`could not claim a tracker id (${CLAIM_TRIES} collisions)`);
}
