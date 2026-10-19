// The disk-logging SessionHooks stub keeps every request it is handed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubHookPaths, stubSessionHooks } from "../src/stubs.js";

describe("stubSessionHooks", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes one file per request, even for requests in the same millisecond", async () => {
    dir = mkdtempSync(join(tmpdir(), "qcr-stubs-"));
    vi.useFakeTimers({ now: new Date("2026-10-15T12:00:00.000Z"), toFake: ["Date"] });
    const hooks = stubSessionHooks(dir);
    await hooks.inject(7, "first");
    await hooks.inject(7, "second");
    await hooks.inject(8, "one");
    await hooks.inject(8, "two");
    await hooks.archiveAndClose(7);
    await hooks.archiveAndClose(7);
    const paths = stubHookPaths(dir);
    expect(readdirSync(paths.injections)).toHaveLength(4);
    expect(readdirSync(paths.archives)).toHaveLength(2);
  });
});
