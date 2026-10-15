// The identity-checked unlink (docs/archiving.md §7.3): a source is removed
// only while it is still the file that was archived. Anything else at the
// path — another file, a directory, a link — is "changed" and stays; only a
// path that no longer exists is "gone".
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identityOf } from "../src/archive/fsutil.js";
import { unlinkIfIdentity } from "../src/archive/gzfile.js";
import { identityFields } from "../src/archive/archivewrite.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function rig(): Promise<{
  root: string;
  src: string;
  recorded: ReturnType<typeof identityFields>;
}> {
  const root = mkdtempSync(join(tmpdir(), "qcr-unlink-"));
  roots.push(root);
  const src = join(root, "a.jsonl");
  writeFileSync(src, "line\n");
  return { root, src, recorded: identityFields((await identityOf(src))!) };
}

describe("unlinkIfIdentity", () => {
  it("removes the recorded file; a missing path is gone", async () => {
    const { src, recorded } = await rig();
    expect(await unlinkIfIdentity(src, recorded)).toBe("removed");
    expect(existsSync(src)).toBe(false);
    expect(await unlinkIfIdentity(src, recorded)).toBe("gone");
  });

  it("a directory or a link put at the path is changed, never gone — and stays", async () => {
    const { root, src, recorded } = await rig();
    rmSync(src);
    mkdirSync(src);
    expect(await unlinkIfIdentity(src, recorded)).toBe("changed");
    expect(existsSync(src)).toBe(true);
    rmSync(src, { recursive: true });
    writeFileSync(join(root, "other"), "x");
    symlinkSync(join(root, "other"), src);
    expect(await unlinkIfIdentity(src, recorded)).toBe("changed");
    expect(existsSync(src)).toBe(true);
  });

  it("an unrecorded dev or ino never matches", async () => {
    const { src, recorded } = await rig();
    expect(await unlinkIfIdentity(src, { ...recorded, dev: null })).toBe("changed");
    expect(await unlinkIfIdentity(src, { ...recorded, ino: null })).toBe("changed");
    expect(existsSync(src)).toBe(true);
  });
});
