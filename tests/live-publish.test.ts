// The round-progress publisher (src/live/publish.ts): the files the tmux bot's
// extension writes, written from the LiveEvent log of an SDK session. The golden
// test (live-projection-golden.test.ts) holds the projection byte-equal to the
// extension; this holds the publisher, which tails a growing log, to the same bytes.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoundProgressPublisher, roundProgressPath } from "../src/live/publish.js";
import { progressLogPath } from "../src/round-progress.js";
import { eventsFromSession, mkReplayRoot, replay, type Replayed } from "./helpers/live-replay.js";

const PR = 5409;
const SESSION = readFileSync(
  join(import.meta.dirname, "fixtures", "live-events", "pr-session.jsonl"),
  "utf8",
);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function recorded(): Replayed {
  const root = mkReplayRoot(PR);
  const r = replay({ root, pr: PR, events: eventsFromSession(SESSION, root) });
  cleanups.push(r.cleanup);
  return r;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "live-publish-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("RoundProgressPublisher", () => {
  it("leaves the extension's snapshot and transition log, from a log that grows in pieces", () => {
    const r = recorded();
    const lines = readFileSync(r.logPath, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);
    const dir = scratch();
    const log = join(dir, "main.jsonl");
    const snapshotPath = roundProgressPath(dir, PR);
    const publisher = new RoundProgressPublisher({
      logPath: log,
      snapshotPath,
      who: { pr: PR, session: `pr-${PR}` },
    });
    // Nothing written yet: a missing log publishes nothing.
    publisher.catchUp();
    expect(() => readFileSync(snapshotPath)).toThrow();
    writeFileSync(log, "");
    const cut = Math.floor(lines.length / 3);
    for (const piece of [lines.slice(0, cut), lines.slice(cut, 2 * cut), lines.slice(2 * cut)]) {
      for (const line of piece) appendFileSync(log, `${line}\n`);
      publisher.catchUp();
    }
    expect(readFileSync(snapshotPath, "utf8")).toBe(r.extensionSnapshot);
    expect(readFileSync(progressLogPath(snapshotPath), "utf8")).toBe(r.extensionTransitions);
  });

  it("publishes a round's transitions once, however often it catches up", () => {
    const r = recorded();
    const dir = scratch();
    const snapshotPath = roundProgressPath(dir, PR);
    const publisher = new RoundProgressPublisher({
      logPath: r.logPath,
      snapshotPath,
      who: { pr: PR, session: `pr-${PR}` },
    });
    for (let i = 0; i < 3; i++) publisher.catchUp();
    expect(readFileSync(progressLogPath(snapshotPath), "utf8")).toBe(r.extensionTransitions);
  });

  it("leaves a torn last line for the next catch-up", () => {
    const r = recorded();
    const text = readFileSync(r.logPath, "utf8");
    const dir = scratch();
    const log = join(dir, "main.jsonl");
    const snapshotPath = roundProgressPath(dir, PR);
    const publisher = new RoundProgressPublisher({
      logPath: log,
      snapshotPath,
      who: { pr: PR, session: `pr-${PR}` },
    });
    writeFileSync(log, text.slice(0, text.length - 7));
    publisher.catchUp();
    appendFileSync(log, text.slice(text.length - 7));
    publisher.catchUp();
    expect(readFileSync(snapshotPath, "utf8")).toBe(r.extensionSnapshot);
  });

  it("warns, and never throws, when it cannot write", () => {
    const r = recorded();
    const dir = scratch();
    // The snapshot's directory is a file.
    const blocked = join(dir, "state");
    writeFileSync(blocked, "x");
    const warnings: string[] = [];
    const publisher = new RoundProgressPublisher({
      logPath: r.logPath,
      snapshotPath: join(blocked, "round-progress", `pr-${PR}.json`),
      who: { pr: PR, session: `pr-${PR}` },
      warn: (m) => warnings.push(m),
    });
    expect(() => publisher.catchUp()).not.toThrow();
    expect(warnings.some((w) => /snapshot write failed/.test(w))).toBe(true);
    expect(warnings.some((w) => /transition log append failed/.test(w))).toBe(true);
  });
});
