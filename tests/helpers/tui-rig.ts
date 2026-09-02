// Shared rig for the TUI surface tests: fake terminal streams, a fake memory
// store spelled in the archived file's shape (the shortest honest way to
// write entries with real tags, days and pin flags), a fake digest fetcher,
// a fake change register, and `learningRig`, which installs the four
// learning surfaces over one store exactly as index.ts does.
import { EventEmitter } from "node:events";
import { TUI_DEFAULTS } from "../../src/config.js";
import { parseLegacyMemory } from "../../src/memory/legacy-file.js";
import type { MemoryEntry, MemoryOp, MemoryStore } from "../../src/memory/store.js";
import { App } from "../../src/tui/app.js";
import type { ChangeEntry, ChangeRegister, RevertResult } from "../../src/tui/changelog-store.js";
import type { DigestFetcher } from "../../src/tui/digesttab.js";
import type { ChangeRegisterSource } from "../../src/tui/feedbacktab.js";
import { installLearningTabs, type LearningDeps, type LearningTabs } from "../../src/tui/learning.js";
import type { RemoteResult } from "../../src/tui/remote.js";

export interface FakeStreams {
  out: NodeJS.WriteStream;
  input: NodeJS.ReadStream;
  written: () => string;
  type: (s: string | Buffer) => void;
}

export function fakeStreams(cols = 110, rows = 30): FakeStreams {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  let buf = "";
  (out as unknown as { columns: number }).columns = cols;
  (out as unknown as { rows: number }).rows = rows;
  out.write = ((s: string) => ((buf += s), true)) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return { out, input, written: () => buf, type: (s) => void (input as unknown as EventEmitter).emit("data", Buffer.from(s)) };
}

export const okSsh = (_h: string, _argv: string[]): Promise<RemoteResult> => Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });

/** Three entries over two days: a pinned-free timeline with one `#bug`. */
export const SAMPLE = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive #eod-learning lesson about merge bases.

#refuted lesson about External Apps.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#bug #operations [[stale-recheck]] stale recheck flag lingers on #5180.
`;

export class FakeMemory implements MemoryStore {
  applied: MemoryOp[] = [];
  constructor(public md: string = SAMPLE) {}
  read(): Promise<MemoryEntry[]> {
    return Promise.resolve(parseLegacyMemory(this.md));
  }
  search(query: string): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    return Promise.resolve(parseLegacyMemory(this.md).filter((e) => e.text.toLowerCase().includes(q)));
  }
  apply(op: MemoryOp): Promise<{ ok: boolean; message: string }> {
    this.applied.push(op);
    return Promise.resolve({ ok: true, message: `ok: ${op.op}` });
  }
}

export const fakeDigest: DigestFetcher = {
  // ASCENDING, like production: parseDigestList sorts lexicographically and
  // DigestState.back counts back from the NEWEST (= last) file.
  list: () => Promise.resolve(["2026-08-19.md", "2026-08-20.md"]),
  read: (f) => Promise.resolve(`# digest ${f}\n## Reviews\n- #5308 APPROVE`),
};

export function changeEntry(sha: string, subject: string, reverted?: { by: string; at: string }): ChangeEntry {
  return {
    sha,
    short: sha.slice(0, 7),
    at: "2026-08-25T09:00:00Z",
    author: "QCR Companion",
    subject,
    feedback_pr: "5270",
    adjudication: "",
    ratified: 'he said "yes"',
    first_seen: "2026-08-25T09:30:00Z",
    ...(reverted ? { reverted } : {}),
  };
}

/** A change register that answers from memory and records reverts. */
export class FakeChanges implements ChangeRegisterSource {
  register: ChangeRegister | undefined;
  reverted: string[] = [];
  refreshes = 0;
  constructor(entries?: ChangeEntry[]) {
    this.register = entries ? { version: 1, updated_at: "2026-08-25T10:00:00Z", entries, scanned: 40 } : undefined;
  }
  refresh(): Promise<ChangeRegister | undefined> {
    this.refreshes += 1;
    return Promise.resolve(this.register);
  }
  revert(sha: string): Promise<RevertResult> {
    this.reverted.push(sha);
    return Promise.resolve({ ok: true, message: `reverted ${sha.slice(0, 7)}` });
  }
}

export interface Rig {
  app: App;
  streams: FakeStreams;
  mem: FakeMemory;
  changes: FakeChanges;
  learning: LearningTabs;
}

/** An App with the four learning surfaces installed over fakes. */
export function learningRig(over: Partial<LearningDeps> & { cols?: number; rows?: number; mem?: FakeMemory; changes?: FakeChanges } = {}): Rig {
  const streams = fakeStreams(over.cols ?? 110, over.rows ?? 30);
  const app = new App(TUI_DEFAULTS, okSsh, streams.out, streams.input);
  const mem = over.mem ?? new FakeMemory();
  const changes = over.changes ?? new FakeChanges([]);
  const { cols: _c, rows: _r, mem: _m, changes: _ch, ...deps } = over;
  const learning = installLearningTabs(app, {
    memory: mem,
    digestFetcher: fakeDigest,
    fetchProposals: () =>
      Promise.resolve({
        proposals: [{ slug: "baseline-mergebase-2026-08-20", head: ["## Rationale", "3 refuted blockers"] }],
        improvements: [{ kind: "pr" as const, number: 12, title: "docs fix", state: "open" }],
      }),
    readTickets: () => [],
    changes,
    ...deps,
  });
  return { app, streams, mem, changes, learning };
}

export function settle(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
