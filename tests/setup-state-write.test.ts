// The state port's write is atomic per writer: each write stages its bytes in
// a temporary file of its own, so two writers of one state file never share a
// staging path.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateHomeFs } from "../src/setup/adapters.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-state-write-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("stateHomeFs write", () => {
  it("stages in a file of its own, never at a path another writer of the file would share", () => {
    const fs = stateHomeFs(dir);
    fs.write("scan/findings.json", "{}");
    // Where the old shared staging name sat: another writer is mid-write there.
    mkdirSync(join(dir, "scan", ".findings.json.tmp"));
    fs.write("scan/findings.json", '{"a":1}');
    expect(readFileSync(join(dir, "scan", "findings.json"), "utf8")).toBe('{"a":1}');
  });
});
