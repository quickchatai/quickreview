import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const rig = vi.hoisted(() => ({ prefix: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      let read = false;
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (rig.prefix && !read) {
            read = true;
            return handle.read(buffer, offset, Math.min(length, 512), position);
          }
          return { bytesRead: 0 };
        },
        close: () => handle.close(),
      };
    },
  };
});
const { ReceiptIndex } = await import("../src/receiptscan.js");
const roots: string[] = [];
afterEach(() => {
  rig.prefix = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(["<!-- qcr-round:fixture -->", "plain receipt"])(
  "does not infer receipt absence after premature EOF (%s)",
  async (marker) => {
    const root = mkdtempSync(join(tmpdir(), "qcr-receipt-short-"));
    roots.push(root);
    writeFileSync(join(root, "a.jsonl"), "bytes that disappear after stat\n");
    expect(await new ReceiptIndex().present(root, marker, Date.now() - 1000)).toEqual({
      answer: null,
      unreadable: true,
    });
  },
);

it("retains a positively read receipt even when EOF prevents proving absence of other tokens", async () => {
  rig.prefix = true;
  const root = mkdtempSync(join(tmpdir(), "qcr-receipt-prefix-"));
  roots.push(root);
  const marker = "<!-- qcr-round:already-read -->";
  writeFileSync(join(root, "a.jsonl"), marker + "x".repeat(1024));
  expect((await new ReceiptIndex().present(root, marker, Date.now() - 1000)).answer).toBe(true);
});
