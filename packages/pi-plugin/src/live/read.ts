// Finding and reading a round's LiveEvent logs: what `qcr review status`,
// `qcr live` and the plugin's status line do with a run directory. No writer
// and no engine here, so a daemon-side or TUI reader can import it.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIVE_MAIN_FILE, readLiveEvents, type LiveEvent } from "./events.js";
import { projectRoundProgress } from "./projection.js";
import type { RoundProgressSnapshot } from "../round-progress.js";

export interface LiveRoundRef {
  /** `state/live/<key>/r<round>` */
  dir: string;
  key: string;
  round: number;
}

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Every round log directory under `<root>/state/live/`, oldest round first. */
export function listLiveRounds(root: string): LiveRoundRef[] {
  const base = join(root, "state", "live");
  const found: LiveRoundRef[] = [];
  for (const key of names(base)) {
    for (const r of names(join(base, key))) {
      const m = /^r(\d+)$/.exec(r);
      if (m) found.push({ dir: join(base, key, r), key, round: Number(m[1]) });
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key) || a.round - b.round);
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The round that was written last. */
export function latestLiveRound(root: string): LiveRoundRef | undefined {
  return listLiveRounds(root).reduce<LiveRoundRef | undefined>(
    (best, r) =>
      best === undefined ||
      mtime(join(r.dir, LIVE_MAIN_FILE)) >= mtime(join(best.dir, LIVE_MAIN_FILE))
        ? r
        : best,
    undefined,
  );
}

/** The ids of the lens sessions a round logged, in file-name order. */
export function lensLogIds(dir: string): string[] {
  return names(dir)
    .flatMap((f) => /^lens-(.+)\.jsonl$/.exec(f)?.[1] ?? [])
    .sort();
}

export interface RoundView {
  ref: LiveRoundRef;
  events: readonly LiveEvent[];
  /** The round-progress v2 snapshot the main log projects to. */
  snapshot: RoundProgressSnapshot | undefined;
  lenses: string[];
}

/** Read one round's main log and project it. */
export function viewRound(ref: LiveRoundRef): RoundView {
  const { events } = readLiveEvents(join(ref.dir, LIVE_MAIN_FILE));
  return {
    ref,
    events,
    snapshot: projectRoundProgress(events)?.snapshot,
    lenses: lensLogIds(ref.dir),
  };
}
