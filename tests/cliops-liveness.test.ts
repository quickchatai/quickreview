import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveWorkerSessions } from "../src/cliops.js";
import { leaseDirOf } from "../src/workerlease.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the checklist's worker inventory", () => {
  it("no lease directory is an empty inventory", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cliops-live-"));
    dirs.push(dir);
    expect(liveWorkerSessions(dir)).toEqual([]);
  });

  it("an unreadable lease directory throws instead of reading as an empty inventory", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-cliops-live-"));
    dirs.push(dir);
    writeFileSync(leaseDirOf(dir), ""); // a file where the directory should be
    expect(() => liveWorkerSessions(dir)).toThrow(/unknown/i);
  });
});
