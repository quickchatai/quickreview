// Ambient feed writer (build slice C2) — the TUI is the only writer
// of `/feed`, the companion reads it on demand.
//
// Two local short-term files, both owned by the poll loop:
//   snapshot.json  the current StatusSnapshot, verbatim, rewritten atomically
//                  (tmp + rename) on every successful poll;
//   events.jsonl   a bounded, append-only-in-normal-operation event tail; only
//                  events not already written, keyed by ts+kind+pr.
//
// IMPORTANT (the owner, 2026-08-21): feed changes NEVER inject a companion chat
// turn. The old `/feed/wake` → pi.sendUserMessage path interrupted active
// conversations with synthetic "feed updated" messages. The files are ambient
// short-term state only; a real operator message or alert is a separate path.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusSnapshot } from "../state.js";

/** A daemon event row as `qcr events --json` emits it. */
export interface FeedEvent {
  ts: string;
  kind: string;
  pr: number | null;
  payload: string | null;
}

export interface FeedWriteResult {
  /** Events appended to events.jsonl by this call. */
  appended: number;
}

/** Health remains part of the feed writer call contract even though the
 * snapshot is now the only place it is observed. */
export type FeedHealth = "ok" | "stale" | "unreachable";

/** Bound both dedupe memory and the disk journal. On overflow the oldest half
 * is discarded in one atomic compaction, avoiding a rewrite on every poll. */
export const EVENT_TAIL_CAP = 4000;
const EVENT_TAIL_KEEP = EVENT_TAIL_CAP / 2;

export function eventKey(e: FeedEvent): string {
  return `${e.ts}|${e.kind}|${e.pr ?? "-"}`;
}

/**
 * Writes the ambient short-term feed. One instance per TUI run; `write()` is
 * called on every successful poll and is cheap when nothing changed.
 */
export class FeedWriter {
  private seen = new Set<string>();
  private eventLines = 0;
  private started = false;

  constructor(readonly dir: string) {}

  get snapshotPath(): string {
    return join(this.dir, "snapshot.json");
  }

  get eventsPath(): string {
    return join(this.dir, "events.jsonl");
  }

  /** Idempotent: creates the dir, removes the retired wake marker, seeds the
   * seen-set from the retained tail, and bounds an old unbounded journal. */
  start(): void {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.dir, { recursive: true });
    // A currently-running copy of the retired extension treats removal as a
    // no-op (the file no longer exists), while no future companion loads it.
    rmSync(join(this.dir, "wake"), { force: true });
    if (!existsSync(this.eventsPath)) return;

    let lines = readFileSync(this.eventsPath, "utf8").split("\n").filter((line) => line.trim() !== "");
    if (lines.length > EVENT_TAIL_CAP) {
      lines = lines.slice(-EVENT_TAIL_KEEP);
      this.writeAtomic(this.eventsPath, lines.join("\n") + "\n");
    }
    this.eventLines = lines.length;
    for (const line of lines) {
      try {
        this.seen.add(eventKey(JSON.parse(line) as FeedEvent));
      } catch {
        /* a torn tail line is not worth failing the feed over */
      }
    }
  }

  write(snapshot: StatusSnapshot, events: FeedEvent[], _health: FeedHealth): FeedWriteResult {
    this.start();
    this.writeAtomic(this.snapshotPath, JSON.stringify(snapshot, null, 2));

    // Events: oldest first on disk (the TUI holds them newest-first).
    const fresh = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).filter((e) => !this.seen.has(eventKey(e)));
    if (fresh.length > 0) {
      appendFileSync(this.eventsPath, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
      this.eventLines += fresh.length;
      for (const e of fresh) this.seen.add(eventKey(e));
      if (this.eventLines > EVENT_TAIL_CAP) this.compactEvents();
    }
    return { appended: fresh.length };
  }

  private compactEvents(): void {
    const lines = readFileSync(this.eventsPath, "utf8").split("\n").filter((line) => line.trim() !== "").slice(-EVENT_TAIL_KEEP);
    this.writeAtomic(this.eventsPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    this.eventLines = lines.length;
    this.seen.clear();
    for (const line of lines) {
      try {
        this.seen.add(eventKey(JSON.parse(line) as FeedEvent));
      } catch {
        /* retain the line but do not let it poison dedupe */
      }
    }
  }

  private writeAtomic(target: string, body: string): void {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, target);
  }
}
