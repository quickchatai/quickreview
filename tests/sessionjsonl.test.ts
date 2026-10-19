// [P8.3] Which JSONL is a PR session's transcript: the one the daemon's
// lifecycle archives and the bot worker resumes, from one function.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newestSessionFile } from "../src/sessionjsonl.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessionjsonl-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (path: string, seconds: number): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{}\n");
  utimesSync(path, seconds, seconds);
};

describe("[P8.3] newestSessionFile", () => {
  it("is undefined for no directory and for one with no JSONL", () => {
    expect(newestSessionFile(join(dir, "missing"))).toBeUndefined();
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(newestSessionFile(dir)).toBeUndefined();
  });

  it("is the newest by mtime, wherever under the dir it sits", () => {
    touch(join(dir, "2026-10-01_a.jsonl"), 1000);
    touch(join(dir, "sub", "2026-10-02_b.jsonl"), 3000);
    touch(join(dir, "2026-10-03_c.jsonl"), 2000);
    expect(newestSessionFile(dir)).toBe(join(dir, "sub", "2026-10-02_b.jsonl"));
  });

  it("breaks a tie on the file name, pi's <timestamp>_<uuid> order", () => {
    touch(join(dir, "2026-10-01T10_a.jsonl"), 1000);
    touch(join(dir, "2026-10-01T11_b.jsonl"), 1000);
    expect(newestSessionFile(dir)).toBe(join(dir, "2026-10-01T11_b.jsonl"));
  });
});
