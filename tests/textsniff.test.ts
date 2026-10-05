// Text or binary (src/setup/textsniff.ts): one answer for every reader of the
// reviewed checkout. Selfscan round 6 found src/eodpinwatch.ts — a source
// file with ONE literal NUL inside a template literal — dropped from every
// lens's coverage by git's bare "any NUL is binary" probe.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { escapeControls, isBinaryContent, isBinaryPath } from "../src/setup/textsniff.js";

const PNG = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1,
    0, 0, 0, 1, 0, 8, 6, 0, 0, 0,
  ]),
  Buffer.from([
    0x5c, 0x72, 0xa8, 0x66, 0, 0, 0x20, 0, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0xed, 0xc1, 0x01,
    0x0d, 0, 0, 0, 0xc2, 0xa0,
  ]),
]);

describe("isBinaryContent", () => {
  it("a source file with one stray NUL is text — the eodpinwatch.ts shape: 20 KB, one NUL near byte 5850", () => {
    expect(isBinaryContent(Buffer.from("export const k = `${a}\0${b}`;\n"), "src/k.ts")).toBe(
      false,
    );
    expect(isBinaryContent(Buffer.from("a\0b"), "x")).toBe(false);
    const body = "// a comment — with ünïcode\nexport function f(): void {}\n".repeat(400);
    const own = Buffer.from(body.slice(0, 5848) + "`${k}\0${h}`" + body.slice(5848));
    expect(own.indexOf(0)).toBeLessThan(8000);
    expect(isBinaryContent(own, "src/eodpinwatch.ts")).toBe(false);
  });

  it("no NUL is text, as git says", () => {
    expect(isBinaryContent(Buffer.from("plain\n"), "a.py")).toBe(false);
    expect(isBinaryContent(Buffer.from("\u001b[31mred\u001b[0m\n"), "log.txt")).toBe(false);
  });

  it("real binaries are binary: PNG bytes under any name, random bytes, UTF-16", () => {
    expect(isBinaryContent(PNG, "assets/blob.dat")).toBe(true);
    expect(isBinaryContent(PNG, "")).toBe(true);
    for (let i = 0; i < 20; i++) {
      const r = randomBytes(4096);
      r[7] = 0;
      expect(isBinaryContent(r, "x.data")).toBe(true);
    }
    expect(isBinaryContent(Buffer.from("hello world\n", "utf16le"), "u.txt")).toBe(true);
  });

  it("a NUL-bearing sample cut mid multi-byte character is still text", () => {
    const text = Buffer.from("a\0" + "ż".repeat(5000));
    expect(text.length).toBeGreaterThan(8000);
    expect(isBinaryContent(text, "p.ts")).toBe(false);
  });

  it("a known-binary extension corroborates a NUL — and never overrules a NUL-free file (git's answer, unchanged)", () => {
    expect(isBinaryPath("img/logo.PNG")).toBe(true);
    expect(isBinaryContent(Buffer.from("a\0b"), "a.woff2")).toBe(true);
    expect(isBinaryContent(Buffer.from("a\0b"), "a.ts")).toBe(false);
    // A NUL-free file is text whatever its name: a text fixture named .bin,
    // a Wavefront .obj — read before this sniff existed, still read.
    expect(isBinaryContent(Buffer.from("not really\n"), "a.bin")).toBe(false);
    expect(isBinaryContent(Buffer.from("v 0 0 0\nf 1 2 3\n"), "mesh.obj")).toBe(false);
    expect(isBinaryPath("mesh.obj")).toBe(false);
    expect(isBinaryPath("src/a.ts")).toBe(false);
  });
});

describe("escapeControls", () => {
  it("renders NUL and other control bytes as visible escapes, keeping tab and newline", () => {
    expect(escapeControls("a\0b")).toBe("a\\u0000b");
    expect(escapeControls("x\ty\nz\u007f")).toBe("x\ty\nz\\u007f");
    expect(escapeControls("a\0b")).not.toContain("\0");
  });
});
