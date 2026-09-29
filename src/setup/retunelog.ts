// The re-tune log: every post-scan re-tune the companion WROTE,
// with what changed and why — `<state home>/setup/retunes.json`, PC-only.
// The companion reports from the record retune.ts writes; the TUI's deploy
// tab reads it to say WHICH re-tune a "profile changed, not deployed" is
// (src/tui/confighome.ts `pendingRetunes`), because a re-tune reaches PR
// reviews only on the operator's deploy.
//
// A LEAF of src/setup/ (the S2 fence in tests/single-shepherd.test.ts): the
// TUI imports it, so it reaches its siblings by type only and carries no
// port, no clock and no disk — the caller reads the file.

export const RETUNES_FILE = "setup/retunes.json";
export const RETUNES_VERSION = 1;
/** Re-tunes the log keeps (newest kept). */
export const RETUNES_KEPT = 20;

/** One thing the companion changed, and what it moved in the resolved profile. */
export interface RetuneChange {
  /** What was asked: `priority security`, `emphasis pass-security`, `style guide`. */
  input: string;
  from: string;
  to: string;
  /** The companion's reason, from what the scan found. */
  why: string;
  /** The resolved lens settings it moved: `pass-security: min_tier sol-med → sol-high`.
   * Empty when the change moved none (a lens a higher-priority concern holds). */
  effects: string[];
}

export interface RetuneRecord {
  id: string;
  at: string;
  profile: string;
  /** The finished scan run the re-tune follows. */
  scan: { run: string; sha: string; mode: string };
  changes: RetuneChange[];
  /** Profile files written (relative to the profile's directory); empty when
   * the answers moved nothing on disk — then there is nothing to deploy. */
  files: string[];
  /** The config-home commit asked for, when files were written. */
  commit: string | null;
  /** The portrait facts key after the refresh the re-tune ran, or why none. */
  portrait: { key: string } | { error: string };
}

export interface RetunesFile {
  version: number;
  retunes: RetuneRecord[];
}

export type RetunesRead =
  | { state: "absent" }
  | { state: "ok"; retunes: RetuneRecord[] }
  | { state: "unreadable"; error: string };

/** The log's text (null = no file) → its records, oldest first. A file this
 * version cannot read is reported, never read as "no re-tunes". */
export function parseRetunes(text: string | null): RetunesRead {
  if (text === null) return { state: "absent" };
  try {
    const raw = JSON.parse(text) as Partial<RetunesFile> | null;
    if (typeof raw !== "object" || raw === null || raw.version !== RETUNES_VERSION || !Array.isArray(raw.retunes)) {
      throw new Error("not a version-1 re-tune log");
    }
    for (const r of raw.retunes) {
      if (typeof r?.id !== "string" || typeof r.at !== "string" || !Array.isArray(r.changes) || !Array.isArray(r.files)) {
        throw new Error("a re-tune has no id, time, changes or files");
      }
    }
    return { state: "ok", retunes: raw.retunes };
  } catch (err) {
    return { state: "unreadable", error: `${RETUNES_FILE} is not a re-tune log this version reads (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** One line for a re-tune: when, after which scan, and what it changed. */
export function retuneLine(r: RetuneRecord): string {
  const what = r.changes.map((c) => `${c.input} ${c.from} → ${c.to}`).join("; ");
  return `re-tune ${r.at} after scan ${r.scan.run} (${r.profile}): ${what || "no change"}`;
}
