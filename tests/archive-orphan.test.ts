// Orphan gzip recovery (docs/archiving.md §7.6): only a gzip zlib refuses is
// corrupt and removed; one that cannot be read proves nothing and is kept.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { identityOf } from "../src/archive/fsutil.js";
import { adoptOrphan } from "../src/archive/gzfile.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function rig(): Promise<{
  root: string;
  src: string;
  opts: Parameters<typeof adoptOrphan>[2];
}> {
  const root = mkdtempSync(join(tmpdir(), "qcr-orphan-"));
  roots.push(root);
  const src = join(root, "a.jsonl");
  writeFileSync(src, "line\n".repeat(50));
  return { root, src, opts: { identity: (await identityOf(src))!, bytesPerS: 1e12 } };
}

describe("adoptOrphan", () => {
  it("bytes zlib refuses (a bad header, a truncated stream) are corrupt: removed", async () => {
    const { root, src, opts } = await rig();
    for (const bytes of [
      Buffer.from("not a gzip"),
      gzipSync(Buffer.from("line\n".repeat(50))).subarray(0, 12),
    ]) {
      const gz = join(root, "a.jsonl.gz");
      writeFileSync(gz, bytes);
      expect(await adoptOrphan(src, gz, opts)).toMatchObject({ kind: "corrupt" });
      expect(existsSync(gz)).toBe(false);
    }
  });

  // root reads a mode-000 file, so the refusal needs an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    "one that cannot be read is not proven corrupt: kept, and the error thrown",
    async () => {
      const { root, src, opts } = await rig();
      const gz = join(root, "a.jsonl.gz");
      writeFileSync(gz, gzipSync(Buffer.from("an earlier version\n")));
      chmodSync(gz, 0o000);
      try {
        await expect(adoptOrphan(src, gz, opts)).rejects.toMatchObject({ code: "EACCES" });
        expect(existsSync(gz)).toBe(true);
      } finally {
        chmodSync(gz, 0o644);
      }
    },
  );

  it("the source's own bytes are adopted", async () => {
    const { root, src, opts } = await rig();
    const gz = join(root, "a.jsonl.gz");
    writeFileSync(gz, gzipSync(Buffer.from("line\n".repeat(50))));
    expect(await adoptOrphan(src, gz, opts)).toMatchObject({ kind: "ok" });
    expect(existsSync(gz)).toBe(true);
  });
});
