// inject-bridge consume/defer semantics. Three live losses (#5317
// round 2, #5257 round 8, #5362 round 2) shared one mechanism: a round prompt
// handed to a session that was still streaming was silently dropped, and the
// round then sat "running" until its deadline.
//
// The contract under test, in three layers — each covering a different half:
//   1. a file is consumed (archived) only after the injection was attempted,
//      never on pickup;
//   2. while the agent RUN is believed in flight the delivery is deferred, and
//      only `agent_settled` drains it (#5362: `turn_end` is an INNER-loop
//      event and clearing on it re-opens the window between every tool call);
//   3. every send carries `deliverAs: "followUp"`, so a delivery that reaches
//      a streaming agent anyway is queued rather than refused — the bridge
//      cannot detect a refusal, because pi's extension-facing sendUserMessage
//      is fire-and-forget.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pi } from "@earendil-works/pi-coding-agent";
import activate, { BUSY_MAX_HOLD_MS } from "../extensions/inject-bridge.js";

let dir: string;
let handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
let sends: Array<{ content: string; options?: { deliverAs?: string } }>;
let sendImpl: (content: string) => Promise<void>;
let savedEnv: { inject?: string; session?: string };

function fakePi(): Pi {
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      sends.push({ content, ...(options ? { options } : {}) });
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

    fire("agent_settled"); // the run settled — drain retries the pending file
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

  it("a wake arriving mid-turn is HELD on its own window — never measured from turn start", async () => {
    // Regression (P1, 2026-08-20 adversarial review): the override used to
    // count from busySince, so a wake landing >15 min into a long turn was
    // delivered INSTANTLY into the live turn — the documented drop mechanism
    // — archived, and lost.
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    activate(fakePi());
    fire("session_start");
    fire("turn_start");
    now.mockReturnValue(t0 + BUSY_MAX_HOLD_MS + 5 * 60_000); // wake arrives 20 min into the turn

    writeFileSync(join(dir, "2026-08-20T13-20-00-0000.md"), "round prompt");
    await sleep(150);
    expect(sends).toHaveLength(0); // held, NOT delivered into the live turn
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    fire("agent_settled"); // delivered on settle/drain
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends[0]!.content).toBe("round prompt");
  });

  it("overrides only after THIS delivery held a full BUSY_MAX_HOLD_MS — and re-arms busy for the next wake", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    activate(fakePi());
    fire("session_start");
    fire("turn_start");

    writeFileSync(join(dir, "2026-08-20T13-00-00-0000.md"), "wake A");
    await sleep(150);
    expect(sends).toHaveLength(0); // deferred; A's own hold window armed at t0

    now.mockReturnValue(t0 + BUSY_MAX_HOLD_MS + 1); // A held its full window
    writeFileSync(join(dir, "2026-08-20T13-00-01-0000.md"), "wake B"); // watch → drain
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.content).toBe("wake A"); // oldest-first, delivered by override
    await vi.waitFor(() => expect(done()).toHaveLength(1));

    // Regression (P1): the override used to CLEAR busy permanently, so every
    // later wake in the turn was dropped. It must re-arm instead: B defers on
    // its own fresh window.
    await sleep(150);
    expect(sends).toHaveLength(1);
    expect(pending()).toHaveLength(1);

    fire("agent_settled"); // a real settle still drains
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]!.content).toBe("wake B");
  });

  it("watch events funnel through ONE serialized drain — back-to-back files deliver strictly sequentially, oldest-first", async () => {
    const releases: Array<() => void> = [];
    let inFlightSends = 0;
    let maxInFlight = 0;
    sendImpl = () => {
      inFlightSends++;
      maxInFlight = Math.max(maxInFlight, inFlightSends);
      return new Promise<void>((ok) =>
        releases.push(() => {
          inFlightSends--;
          ok();
        }),
      );
    };
    activate(fakePi());
    fire("session_start");

    writeFileSync(join(dir, "2026-08-20T14-00-00-0000.md"), "first");
    writeFileSync(join(dir, "2026-08-20T14-00-01-0000.md"), "second");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.content).toBe("first");
    await sleep(100);
    expect(sends).toHaveLength(1); // "second" waits for "first" to resolve

    releases[0]!();
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]!.content).toBe("second");
    releases[1]!();
    await vi.waitFor(() => expect(done()).toHaveLength(2));
    expect(maxInFlight).toBe(1); // never interleaved
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

describe("inject-bridge — the busy span is the agent RUN, not one turn (#5362)", () => {
  it("turn_end does NOT clear busy — a wake landing between tool calls stays held", async () => {
    // THE #5362 REGRESSION. pi fires turn_start/turn_end once per assistant
    // turn INSIDE a run (turnIndex++ per turn, reset at agent_start), so
    // clearing `busy` on turn_end declared the session idle in the gap between
    // every tool call while the run was still streaming. #5362's round-2 order
    // landed in one of those gaps, 6.5s before the session finished, and pi
    // threw it away ("Agent is already processing") without the bridge ever
    // learning. Only agent_settled may clear the flag.
    activate(fakePi());
    fire("session_start");
    fire("agent_start"); // the run begins
    fire("turn_start");
    fire("turn_end"); // one tool-call turn ended — the RUN has not

    writeFileSync(join(dir, "2026-08-21T14-20-59-0031.md"), "ROUND 2 prompt");
    await sleep(150);
    expect(sends).toHaveLength(0); // held, not fired into the streaming run
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    fire("agent_settled"); // NOW the run is fully settled
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends[0]!.content).toBe("ROUND 2 prompt");
  });

  it("agent_start alone arms the hold — a run with no inner turn still defers", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");

    writeFileSync(join(dir, "2026-08-21T14-21-00-0000.md"), "wake");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);
  });

  it("agent_end is not a settle — pi still runs retries/compaction after it", async () => {
    // agent_settled is documented as "after an agent run has FULLY SETTLED and
    // no automatic retry, compaction, or queued continuation will run". Taking
    // agent_end as the clear would re-open a narrower version of the same
    // window, so it must not be wired as one.
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    fire("agent_end");

    writeFileSync(join(dir, "2026-08-21T14-21-01-0000.md"), "wake");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);
  });
});

describe("inject-bridge — a delivery is QUEUED, never refused (#5362)", () => {
  it("every send passes deliverAs:followUp so a streaming agent queues it instead of throwing", async () => {
    // The bridge cannot detect a refusal: pi's extension-facing
    // sendUserMessage is declared `: void` and its runtime binding swallows
    // every rejection into an error banner, so `await` here always resolves
    // and the file is archived regardless. The only way a refusal cannot cost
    // us the order is for pi not to refuse — which is what deliverAs buys.
    writeFileSync(join(dir, "2026-08-21T15-00-00-0000.md"), "round prompt");
    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.options?.deliverAs).toBe("followUp");
  });

  it("still passes deliverAs on an override delivery into a live run", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    activate(fakePi());
    fire("session_start");
    fire("agent_start");

    writeFileSync(join(dir, "2026-08-21T15-01-00-0000.md"), "wake");
    await sleep(150);
    expect(sends).toHaveLength(0);

    now.mockReturnValue(t0 + BUSY_MAX_HOLD_MS + 1);
    writeFileSync(join(dir, "2026-08-21T15-01-01-0000.md"), "nudge"); // watch → drain
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    // This is the one delivery that knowingly lands inside a live run — it is
    // exactly where a refusal would cost the most.
    expect(sends[0]!.options?.deliverAs).toBe("followUp");
  });
});
