// The live-session registry (src/engine/livesessions.ts): what a stop signal
// aborts and disposes on the SDK runtime, in that order, and never past its grace.
import { afterEach, describe, expect, it } from "vitest";
import {
  liveSessionCount,
  markSdkRoute,
  onSdkRoute,
  resetLiveSessions,
  stopLiveSessions,
  trackSession,
} from "../src/engine/livesessions.js";

afterEach(() => resetLiveSessions());

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function session(log: string[], name: string, abort: () => Promise<void> = async () => {}) {
  return {
    abort: async () => {
      log.push(`abort ${name}`);
      await abort();
    },
    dispose: async () => {
      log.push(`dispose ${name}`);
    },
  };
}

describe("livesessions", () => {
  it("tracks a session until its release", () => {
    const release = trackSession(session([], "a"));
    expect(liveSessionCount()).toBe(1);
    release();
    expect(liveSessionCount()).toBe(0);
  });

  it("aborts every session, then disposes every one", async () => {
    const log: string[] = [];
    trackSession(session(log, "a", () => sleep(10)));
    trackSession(session(log, "b"));
    await stopLiveSessions();
    expect(log).toEqual(["abort a", "abort b", "dispose a", "dispose b"]);
  });

  it("does not wait on a wedged abort past its grace, and still disposes", async () => {
    const log: string[] = [];
    trackSession(session(log, "a", () => new Promise<void>(() => {})));
    const t0 = Date.now();
    await stopLiveSessions(50);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(log).toEqual(["abort a", "dispose a"]);
  });

  it("never rejects, whatever a session throws", async () => {
    trackSession({
      abort: () => Promise.reject(new Error("a")),
      dispose: () => Promise.reject(new Error("d")),
    });
    await expect(stopLiveSessions()).resolves.toBeUndefined();
  });

  it("is a no-op with nothing running", async () => {
    await expect(stopLiveSessions()).resolves.toBeUndefined();
  });

  it("remembers that the route is on the SDK", () => {
    expect(onSdkRoute()).toBe(false);
    markSdkRoute();
    expect(onSdkRoute()).toBe(true);
  });
});
