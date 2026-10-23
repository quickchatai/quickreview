// Profile baselines: the repo profile as it stood before each write
// setup made, so the PR replay can review with the old profile beside the new.
//
// A write edits the install's own profile in place (tuning.ts
// `profileApply`), and the config home is a git repo only if the operator
// made it one — so the "old" profile would be gone the moment the new one
// lands. Before every write that changes a file, `profileApply` records here
// what those files held (null = absent) and what the live config named then,
// under the write's commit id. Only the files setup writes are recorded
// (`profile.toml`, the drafted `style-guide.md`): with them put back over the
// profiles as they are now, the profile reads exactly as it did before that
// write — a direct edit made since to a profile it extends is part of both
// sides; one made to a recorded file itself reaches only the new side, since
// restoring the baseline overwrites it on the old one.
//
// `<state home>/setup/profile-baselines.json`, newest last, the last
// `BASELINES_KEPT` kept. An unreadable file is reported and never
// overwritten: it is history the operator may want.
import type { StateFs } from "./engine.js";

export const PROFILE_BASELINES_FILE = "setup/profile-baselines.json";
export const BASELINES_VERSION = 1;
/** Writes remembered (newest kept) — the same depth as the commit record. */
export const BASELINES_KEPT = 10;

export interface ProfileBaseline {
  /** The write's commit id (configcommit.ts `commitId`) — how a replay names it. */
  id: string;
  taken_at: string;
  /** The profile the write changed. */
  profile: string;
  /** Whether that profile existed before the write (false: the write created it). */
  existed: boolean;
  /** Each file the write changed, as it was before it: text, or null when absent. */
  files: Record<string, string | null>;
  /** The profile the live config named at the time ("" = none; null = unreadable). */
  config_named: string | null;
}

export type BaselinesRead =
  { state: "ok"; baselines: ProfileBaseline[] } | { state: "unreadable"; error: string };

function isBaseline(b: unknown): b is ProfileBaseline {
  if (typeof b !== "object" || b === null) return false;
  const r = b as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.taken_at === "string" &&
    typeof r.profile === "string" &&
    typeof r.existed === "boolean" &&
    typeof r.files === "object" &&
    r.files !== null &&
    Object.values(r.files as Record<string, unknown>).every(
      (v) => v === null || typeof v === "string",
    ) &&
    (r.config_named === null || typeof r.config_named === "string")
  );
}

/** The recorded baselines, oldest first ([] when none was ever recorded). */
export function readBaselines(state: StateFs): BaselinesRead {
  let text: string | null;
  try {
    text = state.read(PROFILE_BASELINES_FILE);
  } catch (err) {
    return {
      state: "unreadable",
      error: `${PROFILE_BASELINES_FILE} cannot be read: ${String(err)}`,
    };
  }
  if (text === null) return { state: "ok", baselines: [] };
  try {
    const raw = JSON.parse(text) as { version?: unknown; baselines?: unknown };
    if (
      raw.version !== BASELINES_VERSION ||
      !Array.isArray(raw.baselines) ||
      !raw.baselines.every(isBaseline)
    ) {
      throw new Error("not a version-1 baselines record");
    }
    return { state: "ok", baselines: raw.baselines };
  } catch (err) {
    return {
      state: "unreadable",
      error: `${PROFILE_BASELINES_FILE} in ${state.location} is not a baselines record (${String(err)}) — nothing will overwrite it`,
    };
  }
}

/** Record one baseline (a re-recorded id replaces its row). Throws when the
 * file cannot be read or written — the caller reports it. */
export function recordBaseline(state: StateFs, b: ProfileBaseline): void {
  const read = readBaselines(state);
  if (read.state !== "ok") throw new Error(read.error);
  const kept = [...read.baselines.filter((x) => x.id !== b.id), b].slice(-BASELINES_KEPT);
  state.write(
    PROFILE_BASELINES_FILE,
    `${JSON.stringify({ version: BASELINES_VERSION, baselines: kept }, null, 2)}\n`,
  );
}

/** The newest baseline of `profile`, or null. */
export function latestBaseline(
  baselines: readonly ProfileBaseline[],
  profile: string,
): ProfileBaseline | null {
  for (let i = baselines.length - 1; i >= 0; i--)
    if (baselines[i]!.profile === profile) return baselines[i]!;
  return null;
}
