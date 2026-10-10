// What a fake OpenViking's `fs/ls` should say about a file.
//
// The store's sweep is incremental: it re-reads a file only when the listing's
// size or modification time moved. A real server bumps a file's mtime on every
// write, so a fake that lists every file with one fixed size and mtime would
// make an edited file look unchanged — and a test that edits `files` directly
// (an out-of-band write, as the curator or the companion makes) would read the
// old bytes. This derives both from the bytes: any change to the content moves
// the signature, exactly as a write does on the real server.
import { createHash } from "node:crypto";

const BASE_MS = Date.parse("2026-08-20T15:30:00.000Z");

export function listedFileStat(content: string): { size: number; modTime: string } {
  const digest = createHash("sha256").update(content, "utf8").digest();
  // Up to ~11.5 days of distinct milliseconds after the base: a stable,
  // content-addressed "last written" time.
  const offset = digest.readUInt32BE(0) % 1_000_000_000;
  return {
    size: Buffer.byteLength(content, "utf8"),
    modTime: new Date(BASE_MS + offset).toISOString(),
  };
}
