// Publishing round-progress v2 from a LiveEvent log, while the round runs.
//
// The tmux bot's extension (extensions/round-progress.ts) writes
// `state/round-progress/pr-<n>.json` and the transition log beside it from
// inside the pi. An SDK session has no such extension: its events go to the
// LiveEvent writer (writer.ts), and this publisher tails that log, applies the
// new lines to a RoundProgressProjection (projection.ts) and writes the same
// two files the supervisor, the board and the TUI read. The golden test holds
// the projection byte-equal to the extension, so nothing downstream changes.
//
// It only reads the log and only writes under `<root>/state/round-progress/`.
// A write that fails is a warning, never the round's failure.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appendProgressLog,
  progressLogPath,
} from "@quickchatai/pi-quickreview/src/round-progress.js";
import { readLiveEvents } from "@quickchatai/pi-quickreview/src/live/events.js";
import {
  RoundProgressProjection,
  type ProjectionIdentity,
} from "@quickchatai/pi-quickreview/src/live/projection.js";

/** `<root>/state/round-progress/pr-<n>.json`, where the supervisor reads it. */
export function roundProgressPath(root: string, pr: number): string {
  return join(root, "state", "round-progress", `pr-${pr}.json`);
}

export interface RoundProgressPublisherOptions {
  /** The main log of the round (`state/live/<key>/r<k>/main.jsonl`). */
  logPath: string;
  /** The snapshot file; its transition log is the `.jsonl` beside it. */
  snapshotPath: string;
  who: ProjectionIdentity;
  warn?: (message: string) => void;
}

export class RoundProgressPublisher {
  private readonly projection: RoundProgressProjection;
  private offset = 0;
  private sequence = 0;
  private writtenSnapshot: string | undefined;
  private writtenTransitions = 0;
  private readonly warn: (message: string) => void;

  constructor(private readonly o: RoundProgressPublisherOptions) {
    this.projection = new RoundProgressProjection(o.who);
    this.warn = o.warn ?? ((m) => console.error(`[round-progress] ${m}`));
  }

  /** Read what the log gained since the last call and publish the result,
   * retrying any write an earlier call could not make. Never throws. */
  catchUp(): void {
    try {
      const read = readLiveEvents(this.o.logPath, this.offset);
      this.offset = read.nextOffset;
      for (const event of read.events) this.projection.apply(event);
    } catch (err) {
      this.warn(`live log not read: ${String(err)}`);
      return;
    }
    this.publishTransitions();
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    const json = this.projection.snapshotJson;
    if (json === undefined || json === this.writtenSnapshot) return;
    try {
      mkdirSync(dirname(this.o.snapshotPath), { recursive: true });
      const tmp = `${this.o.snapshotPath}.tmp-${process.pid}-${this.sequence++}`;
      writeFileSync(tmp, json);
      renameSync(tmp, this.o.snapshotPath);
      this.writtenSnapshot = json;
    } catch (err) {
      this.warn(`snapshot write failed: ${String(err)}`);
    }
  }

  private publishTransitions(): void {
    const lines = this.projection.transitions;
    if (lines.length === this.writtenTransitions) return;
    const path = progressLogPath(this.o.snapshotPath);
    try {
      mkdirSync(dirname(path), { recursive: true });
      for (const line of lines.slice(this.writtenTransitions)) {
        appendProgressLog(path, line);
        this.writtenTransitions += 1;
      }
    } catch (err) {
      this.warn(`transition log append failed: ${String(err)}`);
    }
  }
}
