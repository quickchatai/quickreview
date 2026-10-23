// releasing(): the step beside a session runs once, however often the session is disposed.
import { describe, expect, it } from "vitest";
import type { RuntimeSession } from "../src/engine/port.js";
import { releasing } from "../src/engine/sessionwrap.js";

describe("releasing", () => {
  it("runs its step once when the session is disposed more than once", async () => {
    let disposed = 0;
    const inner = {
      id: "s",
      sessionFile: null,
      dispose: async () => {
        disposed++;
      },
    } as unknown as RuntimeSession;
    let after = 0;
    const wrapped = releasing(inner, () => {
      after++;
    });
    await wrapped.dispose();
    await wrapped.dispose();
    expect(after).toBe(1);
    expect(disposed).toBeGreaterThanOrEqual(1);
  });

  it("runs its step even when the session's own dispose throws", async () => {
    const inner = {
      id: "s",
      sessionFile: null,
      dispose: async () => {
        throw new Error("boom");
      },
    } as unknown as RuntimeSession;
    let after = 0;
    const wrapped = releasing(inner, () => {
      after++;
    });
    await expect(wrapped.dispose()).rejects.toThrow("boom");
    expect(after).toBe(1);
  });
});
