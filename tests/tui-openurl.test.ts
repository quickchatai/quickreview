import { describe, expect, it } from "vitest";
import { openUrlDetached } from "../src/tui/openurl.js";

describe("openUrlDetached", () => {
  it("reports a launcher that cannot be spawned instead of crashing the TUI", async () => {
    // An unhandled ChildProcess 'error' (ENOENT: no xdg-open) becomes an
    // uncaughtException, and the TUI's handler exits — `g` on a PR, or a
    // URL from the memory/feedback tabs, would take the whole board down.
    const reported = await new Promise<string>((resolve) => {
      openUrlDetached("https://example.invalid/", resolve, "qcr-no-such-launcher-xyz");
    });
    expect(reported).toContain("qcr-no-such-launcher-xyz");
    expect(reported).toContain("ENOENT");
  });
});
