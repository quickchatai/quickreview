// inject-bridge consume/defer semantics. Two live losses (#5317
// round 2, #5257 round 8) shared one mechanism: the bridge moved an inject
// file to .done and only THEN handed the text to a session that was mid-turn
// on a recheck, so the round prompt was silently dropped and the round
// expired. The contract under test: a file is consumed (archived) only after
// the injection actually succeeded; while the session is believed busy the
// delivery is deferred, and turn-settle events drain what was deferred.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pi } from "@earendil-works/pi-coding-agent";
import activate, { BUSY_MAX_HOLD_MS } from "../extensions/inject-bridge.js";

let dir: string;
let handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
let sends: Array<{ content: string }>;
let sendImpl: (content: string) => Promise<void>;
let savedEnv: { inject?: string; session?: string };

function fakePi(): Pi {
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(content: string) {
      sends.push({ content });
      return sendImpl(content);
    },
  } as unknown as Pi;
}

function fire(event: string): void {
  for (const h of handlers.get(event) ?? []) h({});
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function pending(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
function done(): string[] {
  const d = join(dir, ".done");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-bridge-"));
  handlers = new Map();
  sends = [];
  sendImpl = async () => {};
  savedEnv = { inject: process.env.QCR_INJECT_DIR, session: process.env.QCR_SESSION_NAME };
  process.env.QCR_INJECT_DIR = dir;
  process.env.QCR_SESSION_NAME = "pr-1";
});

afterEach(() => {
  fire("session_shutdown"); // closes the watcher and cancels retry timers
  vi.restoreAllMocks();
  if (savedEnv.inject === undefined) delete process.env.QCR_INJECT_DIR;
  else process.env.QCR_INJECT_DIR = savedEnv.inject;
  if (savedEnv.session === undefined) delete process.env.QCR_SESSION_NAME;
  else process.env.QCR_SESSION_NAME = savedEnv.session;
  rmSync(dir, { recursive: true, force: true });
});

describe("inject-bridge — consume only on delivery", () => {
  it("archives a file only AFTER sendUserMessage resolves — never on pickup", async () => {
    let release!: () => void;
    sendImpl = () => new Promise<void>((ok) => (release = ok));
    writeFileSync(join(dir, "2026-08-20T11-23-20-0000.md"), "ROUND 2 prompt");

    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    // In flight: the file must still be pending — a crash here re-fires it.
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    release();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(pending()).toHaveLength(0);
    expect(sends[0]!.content).toBe("ROUND 2 prompt");
  });

  it("a failed send leaves the file pending and a settle retries it until it lands", async () => {
    let calls = 0;
    sendImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("agent is busy");
    };
    writeFileSync(join(dir, "2026-08-20T12-42-02-0000.md"), "round prompt");

    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends.length).toBeGreaterThanOrEqual(1));
    // The failed delivery consumed nothing.
    expect(done()).toHaveLength(0);
    expect(pending()).toHaveLength(1);

    fire("turn_end"); // the session settled — drain retries the pending file
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends).toHaveLength(2);
  });

  it("defers delivery while a turn is in flight and drains on agent_settled", async () => {
    activate(fakePi());
    fire("session_start");
    fire("turn_start"); // a recheck turn begins

    writeFileSync(join(dir, "2026-08-20T11-23-20-0001.md"), "held round prompt");
    await sleep(150); // give fs.watch time to fire the deferred attempt
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    fire("agent_settled"); // the recheck finished
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends[0]!.content).toBe("held round prompt");
  });

  it("overrides a busy hold older than BUSY_MAX_HOLD_MS instead of holding wakes forever", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    activate(fakePi());
    fire("session_start");
    fire("turn_start");
    now.mockReturnValue(t0 + BUSY_MAX_HOLD_MS + 1); // the matching settle never came

    writeFileSync(join(dir, "2026-08-20T13-00-00-0000.md"), "wake");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(done()).toHaveLength(1));
  });

  it("consumes an empty wake without a send", async () => {
    writeFileSync(join(dir, "2026-08-20T13-00-01-0000.md"), "  \n");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends).toHaveLength(0);
  });

  it("drains files oldest-first on start (names are ISO timestamps)", async () => {
    writeFileSync(join(dir, "2026-08-20T10-00-01-0000.md"), "second");
    writeFileSync(join(dir, "2026-08-20T10-00-00-0000.md"), "first");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends.map((s) => s.content)).toEqual(["first", "second"]);
  });
});
