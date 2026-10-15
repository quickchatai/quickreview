// The per-pass bundle writer (docs/archiving.md §6, §7.3), on its own: every
// record's bytes come back exactly as read, and the bundle can be the first
// thing a PR's archive dir holds.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundleRecords, writeBundle, type BundleSource } from "../src/archive/bundle.js";
import { identityOf } from "../src/archive/fsutil.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const opts = { level: 6, bytesPerS: 1e12 };

async function source(root: string, rel: string, bytes: Buffer): Promise<BundleSource> {
  const path = join(root, rel);
  writeFileSync(path, bytes);
  return { path, cls: "round_prompts", identity: (await identityOf(path))! };
}

describe("writeBundle", () => {
  it("a UTF-8 file with a byte-order mark round-trips byte for byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-bundle-"));
    roots.push(root);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# notes\n", "utf8")]);
    const plain = Buffer.from("plain\n", "utf8");
    const sources = [await source(root, "bom.md", bom), await source(root, "plain.md", plain)];
    const dest = join(root, "archive", "pr-1", "state-x.jsonl.gz");
    const r = await writeBundle(dest, root, sources, opts);
    expect(r).toMatchObject({ kind: "ok", records: 2, bytes: bom.length + plain.length });
    const back = await readBundleRecords(dest, null, opts);
    expect(back.get("bom.md")!.data.equals(bom)).toBe(true);
    expect(back.get("bom.md")!.record.enc).toBe("utf8");
    expect(back.get("plain.md")!.data.equals(plain)).toBe(true);
  });

  it("creates the PR's archive dir when the bundle is the first thing in it", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-bundle-"));
    roots.push(root);
    const sources = [await source(root, "a.md", Buffer.from("a\n"))];
    const dest = join(root, "archive", "pr-77", "state-p.jsonl.gz");
    const r = await writeBundle(dest, root, sources, opts);
    expect(r.kind).toBe("ok");
    expect(statSync(dest).isFile()).toBe(true);
  });

  it("a stop during the verify read propagates — it is never a verify failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-bundle-"));
    roots.push(root);
    const sources = [await source(root, "a.md", Buffer.from("a\n"))];
    const dest = join(root, "archive", "pr-78", "state-p.jsonl.gz");
    const ctrl = new AbortController();
    await expect(
      writeBundle(dest, root, sources, {
        ...opts,
        signal: ctrl.signal,
        step: (name) => {
          if (name === "partial_written") ctrl.abort();
        },
      }),
    ).rejects.toThrow();
  });
});
