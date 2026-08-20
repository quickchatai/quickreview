// scripts/memedit.mjs — the one external mutation path into MEMORY.md
//. Real subprocess against a temp file (same justification as
// guards-shell.test.ts: the artifact under test IS the script).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockHash, parseMemory } from "../src/tui/memory.js";

const SCRIPT = join(process.cwd(), "scripts", "memedit.mjs");

const SAMPLE = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive lesson one about merge bases.

#refuted lesson two about External Apps.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#bug #operations stale recheck flag lingers.
`;

let dir: string;
let file: string;

function run(args: string[], stdin?: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], {
      env: { ...process.env, QCR_MEMORY_PATH: file },
      input: stdin,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, out: e.stdout ?? "" };
  }
}

function entryHash(id: string, ts: string, block: number): string {
  const e = parseMemory(readFileSync(file, "utf8")).find((x) => x.id === id && x.ts === ts && x.block === block);
  if (!e) throw new Error(`no entry ${id}@${ts}#${block}`);
  return blockHash(e.text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memedit-"));
  file = join(dir, "MEMORY.md");
  writeFileSync(file, SAMPLE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("memedit.mjs", () => {
  it("retire removes exactly the addressed block", () => {
    const r = run(["retire", "--id", "01a01ab3", "--ts", "2026-08-19 18:13:54", "--block", "0", "--expect", entryHash("01a01ab3", "2026-08-19 18:13:54", 0)]);
    expect(r.code).toBe(0);
    const entries = parseMemory(readFileSync(file, "utf8"));
    expect(entries.map((e) => `${e.id}#${e.block}`)).toEqual(["01a01ab3#0", "01a01b03#0"]);
    expect(entries[0]!.text).toContain("External Apps");
  });

  it("retiring the last block of a batch drops its header", () => {
    run(["retire", "--id", "01a01b03", "--ts", "2026-08-20 09:01:42", "--block", "0", "--expect", entryHash("01a01b03", "2026-08-20 09:01:42", 0)]);
    const md = readFileSync(file, "utf8");
    expect(md).not.toContain("01a01b03");
  });

  it("refuses on a stale expect hash and changes nothing", () => {
    const before = readFileSync(file, "utf8");
    const r = run(["retire", "--id", "01a01ab3", "--ts", "2026-08-19 18:13:54", "--block", "0", "--expect", "deadbeef0000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("stale view");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("pin moves the block to the top of the file with a #pinned tag and unique id", () => {
    const r = run(["pin", "--id", "01a01ab3", "--ts", "2026-08-19 18:13:54", "--block", "1", "--expect", entryHash("01a01ab3", "2026-08-19 18:13:54", 1)]);
    expect(r.code).toBe(0);
    const entries = parseMemory(readFileSync(file, "utf8"));
    expect(entries[0]!.pinned).toBe(true);
    expect(entries[0]!.id).toBe("01a01ab3.p1");
    expect(entries[0]!.text).toContain("External Apps");
    expect(entries[0]!.ts).toBe("2026-08-19 18:13:54"); // original stamp kept
    // The source batch lost the block; nothing else moved.
    expect(entries.filter((e) => e.id === "01a01ab3")).toHaveLength(1);
  });

  it("unpin drops the tag in place", () => {
    run(["pin", "--id", "01a01ab3", "--ts", "2026-08-19 18:13:54", "--block", "1", "--expect", entryHash("01a01ab3", "2026-08-19 18:13:54", 1)]);
    run(["unpin", "--id", "01a01ab3.p1", "--ts", "2026-08-19 18:13:54", "--block", "0", "--expect", entryHash("01a01ab3.p1", "2026-08-19 18:13:54", 0)]);
    const entries = parseMemory(readFileSync(file, "utf8"));
    expect(entries.every((e) => !e.pinned)).toBe(true);
    expect(entries[0]!.text).not.toContain("#pinned");
  });

  it("edit replaces the block text from stdin", () => {
    const r = run(["edit", "--id", "01a01b03", "--ts", "2026-08-20 09:01:42", "--block", "0", "--expect", entryHash("01a01b03", "2026-08-20 09:01:42", 0)], "#bug #operations corrected lesson text.");
    expect(r.code).toBe(0);
    const entries = parseMemory(readFileSync(file, "utf8"));
    expect(entries.find((e) => e.id === "01a01b03")!.text).toBe("#bug #operations corrected lesson text.");
  });

  it("add appends a new batch and forces the #manual tag", () => {
    const r = run(["add"], "always check the merge base first");
    expect(r.code).toBe(0);
    const entries = parseMemory(readFileSync(file, "utf8"));
    const added = entries[entries.length - 1]!;
    expect(added.tags).toContain("manual");
    expect(added.id.startsWith("qcr-")).toBe(true);
    expect(added.text).toContain("always check the merge base first");
  });

  it("add works on a missing file", () => {
    rmSync(file);
    const r = run(["add"], "first ever manual entry");
    expect(r.code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("first ever manual entry");
  });

  it("refuses unknown ops and oversized payloads", () => {
    expect(run(["obliterate"]).code).toBe(1);
    expect(run(["add"], "x".repeat(5000)).code).toBe(1);
  });

  it("round-trips: parse(render(parse(x))) is stable", () => {
    run(["edit", "--id", "01a01ab3", "--ts", "2026-08-19 18:13:54", "--block", "0", "--expect", entryHash("01a01ab3", "2026-08-19 18:13:54", 0)], "#false-positive lesson one about merge bases.");
    const after = readFileSync(file, "utf8");
    expect(parseMemory(after).map((e) => e.text)).toEqual(parseMemory(SAMPLE).map((e) => e.text));
  });
});
