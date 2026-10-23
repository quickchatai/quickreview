// Canary 2 : disposing 20 sessions at once, in flight, is clean.
//
// A review round ends (or is aborted) with many lens sessions alive. Disposing
// them in one tick must not throw, must settle every pending prompt, must run
// the session-resource cleanup exactly once per id and must leave no event
// listener behind.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FakeTransport, type Rig, createRig, useOfflineGuard, waitFor } from "./harness.js";

useOfflineGuard();

const N = 20;

let rig: Rig;
let transport: FakeTransport;

beforeEach(async () => {
  rig = await createRig();
  transport = new FakeTransport();
  transport.attach();
});

afterEach(() => {
  transport.detach();
  rig.close();
});

describe("[canary 2] concurrent dispose of 20 sessions", () => {
  it("settles every in-flight prompt and cleans each id exactly once", async () => {
    const ids = Array.from({ length: N }, (_, i) => `lens-${i}`);
    const sessions = await Promise.all(
      ids.map((id) => rig.open({ sessionManager: SessionManager.inMemory(rig.dir, { id }) })),
    );
    let inFlight = 0;
    // Each request opens its socket, then waits until pi aborts it. Nothing in
    // the script ever finishes a turn: only dispose can end these prompts.
    rig.faux.setResponses(
      ids.map(() => async (_ctx, options) => {
        transport.open(options?.sessionId);
        inFlight++;
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("never delivered");
      }),
    );
    const events: string[] = [];
    for (const s of sessions) s.subscribe((e) => events.push(e.type));

    const prompts = sessions.map((s) =>
      s.prompt("work").then(
        () => "settled",
        () => "rejected",
      ),
    );
    await waitFor(() => inFlight === N, 4000, "all 20 requests in flight");

    const t0 = Date.now();
    for (const s of sessions) s.dispose(); // one tick, no awaits between
    const disposeMs = Date.now() - t0;

    const outcomes = await Promise.race([
      Promise.all(prompts),
      new Promise<string[]>((_, rej) =>
        setTimeout(() => rej(new Error("prompts did not settle")), 4000),
      ),
    ]);
    expect(outcomes).toHaveLength(N);
    expect(disposeMs).toBeLessThan(2000);

    expect([...transport.cleanups].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(transport.isOpen(id), id).toBe(false);

    // Nothing is delivered to a disposed session's listeners afterwards.
    const settledCount = events.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(settledCount);
  });

  it("a second dispose of every session is harmless", async () => {
    const sessions = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        rig.open({ sessionManager: SessionManager.inMemory(rig.dir, { id: `again-${i}` }) }),
      ),
    );
    for (const s of sessions) s.dispose();
    expect(() => {
      for (const s of sessions) s.dispose();
    }).not.toThrow();
  });
});
